"use strict";

/**
 * RECONSTRUIRE LES 21 SORTIES ROUGE FONCÉ DE L'IMPORT EM2S.
 *
 *   node scripts/reconstruire-sorties-rouge-fonce.js --preview \
 *        --fichier="…/Copie de dernier actualisation bby me.xlsx"
 *
 *   node scripts/reconstruire-sorties-rouge-fonce.js --apply \
 *        --fichier="…" --confirmer=OUI-JE-RECONSTRUIS
 *
 * ── LE PROBLÈME ────────────────────────────────────────────────────────────
 *
 * L'ancien chemin d'import a écrit des mouvements CONSOLIDÉS : les sorties
 * anciennes et nouvelles d'un même produit se sont additionnées en une seule
 * ligne de `stock_movements`, et `stock_import_movement_events` est restée
 * vide. L'import n°3 porte ainsi 43 mouvements de sortie pour 12 193 unités,
 * là où le classeur ne décrit que 21 sorties nouvelles pour 739 unités.
 *
 * Un mouvement de 20 pour STADE 4 AOUT ne correspond à aucun bon signable :
 * personne n'a sorti 20 pièces en une fois. Il y a eu trois sorties — 7, 7 et
 * 6 — le 31 août. Ce sont ces trois événements qu'il faut reconstruire, et
 * trois bons qu'il faut imprimer.
 *
 * ── CE QUE FAIT CE SCRIPT ──────────────────────────────────────────────────
 *
 *   1. Il relit le classeur ORIGINAL, vérifie son SHA-256 contre celui
 *      enregistré à l'import, et n'accepte que les cellules rouge foncé
 *      C00000 de la colonne des sorties.
 *   2. Il refuse de continuer si le compte n'est pas EXACTEMENT 21 lignes et
 *      739 unités. Un fichier différent, une couleur mal lue, une ligne de
 *      total ramassée par erreur : tout écart arrête tout.
 *   3. Il écrit les 21 événements manquants dans
 *      `stock_import_movement_events`, avec leur cellule, leur date réelle et
 *      leur quantité exacte.
 *   4. Il rattache chaque événement au mouvement consolidé qui le contient,
 *      quand celui-ci existe. Plusieurs événements peuvent pointer vers le
 *      même mouvement — c'est le fait qu'on décrit, pas une anomalie.
 *   5. Il annule les documents qui portaient une quantité consolidée, et les
 *      doublons, en les remplaçant par un bon par événement.
 *
 * ── CE QU'IL NE FAIT JAMAIS ────────────────────────────────────────────────
 *
 * Toucher au stock. Ni `products.stock`, ni `stock_movements`, ni
 * `stock_location_balances`, ni les inventaires, ni les réceptions, ni les
 * utilisateurs, ni les permissions. Le contrôle final relit ces tables et fait
 * échouer la transaction entière si un seul chiffre a bougé.
 *
 * Supprimer un document. Un bon déjà imprimé a pu partir chez quelqu'un : il
 * est annulé, motivé, daté, et pointe vers son remplaçant.
 *
 * Inventer un mouvement. Un événement sans mouvement correspondant — c'est le
 * cas de MAMBRANE — est créé, signalé « non rattaché », et n'obtient un
 * document que si on le demande explicitement.
 */

const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const XLSX = require("xlsx");
const lecteur = require("../services/import-em2s");
const { nextShortDocumentNumber } = require("../services/numerotation-documents");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[1m", Z = "\x1b[0m";

/* ── Ce que le classeur DOIT contenir ─────────────────────────────────────
   Ces deux nombres viennent du relevé certifié du classeur. Ils ne sont pas
   un paramètre de confort : ils sont le garde-fou qui distingue « on relit le
   bon fichier » de « on reconstruit n'importe quoi ». */
const ATTENDU_LIGNES = 21;
const ATTENDU_UNITES = 739;

const FEUILLE = "LISTE DES STOCK";
const COULEUR_NOUVELLE_SORTIE = "C00000";
const PHRASE = "OUI-JE-RECONSTRUIS";

const args = process.argv.slice(2);
const opt = (nom) => {
  const t = args.find((a) => a.startsWith(`--${nom}=`));
  return t ? t.slice(nom.length + 3) : null;
};
const PREVIEW = args.includes("--preview");
const APPLY = args.includes("--apply");
const DOCUMENTER_NON_RATTACHES = args.includes("--documenter-non-rattaches");
const SANS_DOCUMENTS = args.includes("--sans-documents");

function stop(message) { console.error(`${R}${message}${Z}`); process.exit(1); }

if (PREVIEW === APPLY) stop("Indiquez exactement un mode : --preview ou --apply.");
if (APPLY && opt("confirmer") !== PHRASE) {
  stop(`--apply écrit des événements et des bons. Confirmez explicitement :\n`
     + `  --apply --confirmer=${PHRASE}`);
}
if (!process.env.DATABASE_URL) stop("DATABASE_URL manquant.");
const FICHIER = opt("fichier");
if (!FICHIER) stop("Indiquez le classeur original : --fichier=\"…/Copie de dernier actualisation bby me.xlsx\"");
if (!fs.existsSync(FICHIER)) stop(`Fichier introuvable : ${FICHIER}`);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Espaces multiples ramenés à un, majuscules : « TETE DE  JACK » = « TETE DE JACK ». */
const compacter = (v) => String(v ?? "").replace(/\s+/g, " ").trim().toUpperCase();

/* ═════════════════════════════════════════ LECTURE DU CLASSEUR ══ */

function lireSortiesRougeFonce() {
  const buffer = fs.readFileSync(FICHIER);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const classeur = XLSX.read(buffer, { cellStyles: true, cellDates: false });

  if (!classeur.Sheets[FEUILLE]) {
    stop(`La feuille « ${FEUILLE} » est absente de ce classeur.`);
  }

  const { lignes } = lecteur.lireFeuilleStock(classeur, FEUILLE);
  const evenements = [];

  for (const ligne of lignes) {
    for (const m of ligne.mouvements) {
      if (m.sens !== "Sortie") continue;
      if (m.couleur !== COULEUR_NOUVELLE_SORTIE) continue;
      if (!ligne.dateUnique) {
        stop(`Ligne ${ligne.provenance.ligne} (${ligne.description}) : aucune date exploitable. `
           + "Une sortie sans date ne peut pas porter de bon.");
      }
      evenements.push({
        excel_sheet: FEUILLE,
        excel_row: ligne.provenance.ligne,
        excel_cell: m.provenance.cellule,
        direction: "OUT",
        effective_date: ligne.dateUnique,
        quantity: m.quantite,
        produit: ligne.description,
        produitCompacte: compacter(ligne.description),
        /* Les dates multiples de la cellule d'origine sont conservées : elles
           expliquent pourquoi la date retenue est celle-là. */
        datesProposees: ligne.datesProposees || null,
        rayon: ligne.rayon, location: ligne.location, niveau: ligne.niveau,
        bins: ligne.bins,
      });
    }
  }

  /* Ordre stable : la séquence d'un événement ne doit pas dépendre de l'ordre
     dans lequel la bibliothèque a rendu les lignes. */
  evenements.sort((a, b) => a.excel_row - b.excel_row);

  const total = evenements.reduce((s, e) => s + e.quantity, 0);
  return { sha256, evenements, total, taille: buffer.length };
}

/* ═════════════════════════════════════════ RATTACHEMENT ══ */

/**
 * Retrouve, pour chaque produit, le mouvement consolidé qui contient ses
 * événements.
 *
 * La règle est celle du fichier : les sorties nouvelles d'un même produit ont
 * été additionnées en une ligne. On cherche donc un mouvement de sortie de cet
 * import dont la quantité vaut la SOMME des événements du produit. À défaut,
 * un mouvement par événement, quantité pour quantité.
 *
 * Aucun rapprochement approximatif : si rien ne correspond exactement,
 * l'événement reste non rattaché et c'est dit. Deviner ici reviendrait à
 * coller un bon sur un mouvement qui décrit autre chose.
 */
function rattacher(evenements, mouvements) {
  const parProduit = new Map();
  for (const e of evenements) {
    if (!parProduit.has(e.produitCompacte)) parProduit.set(e.produitCompacte, []);
    parProduit.get(e.produitCompacte).push(e);
  }

  const dejaPris = new Set();

  for (const [produit, groupe] of parProduit) {
    const somme = groupe.reduce((s, e) => s + e.quantity, 0);
    const candidats = mouvements.filter(
      (m) => compacter(m.product_name) === produit && !dejaPris.has(m.id));

    const consolide = candidats.find((m) => Number(m.quantity) === somme);
    if (consolide) {
      dejaPris.add(consolide.id);
      for (const e of groupe) {
        e.movement_id = consolide.id;
        e.rattachement = groupe.length > 1
          ? `mouvement consolidé #${consolide.id} (${somme} = ${groupe.map((x) => x.quantity).join(" + ")})`
          : `mouvement #${consolide.id}`;
      }
      continue;
    }

    /* Pas de consolidation : peut-être un mouvement par événement. */
    for (const e of groupe) {
      const seul = candidats.find(
        (m) => !dejaPris.has(m.id) && Number(m.quantity) === e.quantity);
      if (seul) {
        dejaPris.add(seul.id);
        e.movement_id = seul.id;
        e.rattachement = `mouvement #${seul.id}`;
      } else {
        e.movement_id = null;
        e.rattachement = candidats.length
          ? `AUCUN mouvement de ${e.quantity} — candidats : ${candidats.map((m) => `#${m.id}=${Number(m.quantity)}`).join(", ")}`
          : "AUCUN mouvement de ce produit dans cet import";
      }
    }
  }
}

/** Clé stable : rejouer le script ne recrée jamais un événement déjà écrit. */
function cleEvenement(sha256, e) {
  return `EM2S:${sha256.slice(0, 12)}:${e.excel_sheet}:R${e.excel_row}:${e.direction}:${e.effective_date}`;
}

/* ═════════════════════════════════════════ EMPREINTE DE STOCK ══ */

async function empreinteStock(client) {
  const { rows } = await client.query(`
    SELECT (SELECT coalesce(sum(stock), 0)     FROM products)                AS produits_total,
           (SELECT count(*)                    FROM products)                AS produits_nb,
           (SELECT coalesce(sum(quantity), 0)  FROM stock_movements)         AS mouvements_total,
           (SELECT count(*)                    FROM stock_movements)         AS mouvements_nb,
           (SELECT coalesce(sum(quantity), 0)  FROM stock_location_balances) AS balances_total,
           (SELECT count(*)                    FROM stock_location_balances) AS balances_nb,
           (SELECT count(*)                    FROM inventory_imports)       AS imports_nb,
           (SELECT count(*)                    FROM users)                   AS utilisateurs_nb`);
  return rows[0];
}

/* ═════════════════════════════════════════════════════ MAIN ══ */

async function main() {
  const lu = lireSortiesRougeFonce();

  console.log(`\n${G}RECONSTRUCTION DES SORTIES ROUGE FONCÉ (C00000)${Z}`);
  console.log(`Base     : ${String(process.env.DATABASE_URL).replace(/:\/\/[^@]*@/, "://***@")}`);
  console.log(`Fichier  : ${path.basename(FICHIER)} (${lu.taille} octets)`);
  console.log(`SHA-256  : ${lu.sha256}`);
  console.log(`Mode     : ${PREVIEW ? "PRÉVISUALISATION — aucune écriture" : "APPLICATION"}`);

  /* ── Le garde-fou du contenu ────────────────────────────────────────── */
  console.log(`\n${G}CONTRÔLE DU CLASSEUR${Z}`);
  const bonCompte = lu.evenements.length === ATTENDU_LIGNES;
  const bonTotal = lu.total === ATTENDU_UNITES;
  console.log(`  lignes rouge foncé : ${lu.evenements.length} (attendu ${ATTENDU_LIGNES}) ${bonCompte ? V + "✓" : R + "✗"}${Z}`);
  console.log(`  total des unités   : ${lu.total} (attendu ${ATTENDU_UNITES}) ${bonTotal ? V + "✓" : R + "✗"}${Z}`);
  if (!bonCompte || !bonTotal) {
    stop("\nLe classeur ne donne pas exactement 21 lignes et 739 unités. "
       + "Ce n'est pas le bon fichier, ou les couleurs ont changé. Arrêt.");
  }

  /* ── L'import visé ──────────────────────────────────────────────────── */
  const importDemande = opt("import") ? Number(opt("import")) : null;
  const { rows: imports } = await pool.query(
    importDemande
      ? `SELECT * FROM inventory_imports WHERE id = $1`
      : `SELECT * FROM inventory_imports WHERE file_hash = $1 ORDER BY id DESC LIMIT 1`,
    [importDemande || lu.sha256]
  );
  const imp = imports[0];
  if (!imp) {
    stop(importDemande
      ? `Aucun import n°${importDemande} dans cette base.`
      : `Aucun import ne porte l'empreinte ${lu.sha256.slice(0, 16)}… `
        + "Précisez-le avec --import=<id>.");
  }

  /* Le SHA-256 est la seule preuve que le fichier relu est bien celui qui a
     été importé. Un fichier « du même nom » ne suffit pas : c'est ainsi qu'on
     reconstruit des événements à partir d'une version corrigée à la main. */
  if (imp.file_hash && imp.file_hash !== lu.sha256) {
    stop(`\nL'import n°${imp.id} porte l'empreinte ${String(imp.file_hash).slice(0, 16)}…\n`
       + `Le fichier fourni porte    ${lu.sha256.slice(0, 16)}…\n`
       + "Ce n'est pas le classeur qui a été importé. Arrêt.");
  }

  const societe = opt("societe") ? Number(opt("societe")) : imp.company_id;
  console.log(`\n${G}IMPORT VISÉ${Z}`);
  console.log(`  n°${imp.id} — ${imp.file_name}`);
  console.log(`  société ${societe} · statut ${imp.status} · ${new Date(imp.created_at).toISOString().slice(0, 19).replace("T", " ")}`);
  console.log(`  empreinte ${imp.file_hash ? (imp.file_hash === lu.sha256 ? V + "conforme" + Z : R + "DIFFÉRENTE" + Z) : J + "non enregistrée" + Z}`);

  /* ── Le lot d'import, s'il existe ───────────────────────────────────── */
  const { rows: lots } = await pool.query(
    `SELECT id, status FROM stock_import_batches
      WHERE company_id = $1 AND file_sha256 = $2 ORDER BY id DESC LIMIT 1`,
    [societe, lu.sha256]);
  const batchId = lots[0]?.id || null;

  /* ── L'état actuel ──────────────────────────────────────────────────── */
  const { rows: mouvements } = await pool.query(
    `SELECT id, type, product_name, product_reference, quantity, warehouse_id, location_code
       FROM stock_movements
      WHERE company_id = $1 AND import_id = $2 AND type = 'Sortie'
      ORDER BY id`,
    [societe, imp.id]);
  const totalMouvements = mouvements.reduce((s, m) => s + Number(m.quantity), 0);

  const { rows: evExistants } = await pool.query(
    `SELECT count(*) FILTER (WHERE direction = 'OUT') AS sorties, count(*) AS total
       FROM stock_import_movement_events WHERE company_id = $1`, [societe]);

  console.log(`\n${G}ÉTAT ACTUEL${Z}`);
  console.log(`  mouvements de sortie de cet import : ${mouvements.length} pour ${totalMouvements} unités`);
  console.log(`  événements métier enregistrés      : ${evExistants[0].total} (dont ${evExistants[0].sorties} OUT)`);
  console.log(`  lot d'import correspondant         : ${batchId ? `#${batchId} (${lots[0].status})` : "aucun"}`);

  /* ── Rattachement ───────────────────────────────────────────────────── */
  rattacher(lu.evenements, mouvements);
  for (const e of lu.evenements) e.event_key = cleEvenement(lu.sha256, e);

  const { rows: dejaEcrits } = await pool.query(
    `SELECT event_key, id, movement_id FROM stock_import_movement_events
      WHERE company_id = $1 AND event_key = ANY($2::text[])`,
    [societe, lu.evenements.map((e) => e.event_key)]);
  const parCle = new Map(dejaEcrits.map((r) => [r.event_key, r]));

  console.log(`\n${G}LES ${lu.evenements.length} ÉVÉNEMENTS À RECONSTRUIRE${Z}`);
  for (const e of lu.evenements) {
    const etat = parCle.has(e.event_key) ? `${V}déjà écrit${Z}` : "à créer";
    const lien = e.movement_id ? e.rattachement : `${R}${e.rattachement}${Z}`;
    console.log(`  L${String(e.excel_row).padStart(4)} ${e.excel_cell.padEnd(6)}`
      + ` ${String(e.quantity).padStart(4)}  ${e.effective_date}  ${e.produit.slice(0, 34).padEnd(34)} ${etat}`);
    console.log(`        ${" ".repeat(6)}      → ${lien}`);
  }

  const nonRattaches = lu.evenements.filter((e) => !e.movement_id);
  if (nonRattaches.length) {
    console.log(`\n${J}${nonRattaches.length} événement(s) sans mouvement correspondant :${Z}`);
    for (const e of nonRattaches) {
      console.log(`  ${e.produit} — ${e.quantity} le ${e.effective_date} (ligne ${e.excel_row})`);
      console.log(`    ${e.rattachement}`);
    }
    console.log(`  Ils seront créés et signalés non rattachés. Aucun mouvement ne sera inventé.`);
    console.log(`  Un bon ne leur sera émis qu'avec --documenter-non-rattaches.`);
  }

  /* ── Documents existants sur ces mouvements ─────────────────────────── */
  const idsMouvements = [...new Set(lu.evenements.map((e) => e.movement_id).filter(Boolean))];
  const { rows: docsExistants } = idsMouvements.length ? await pool.query(
    `SELECT d.id, d.document_number, d.document_type, d.stock_movement_id,
            d.print_count, d.stock_import_movement_event_id,
            (SELECT coalesce(sum(quantity), 0) FROM document_items di
              WHERE di.document_id = d.id) AS quantite_imprimee
       FROM documents d
      WHERE d.company_id = $1 AND d.stock_movement_id = ANY($2::int[])
        AND d.cancelled_at IS NULL
        /* Seuls les bons NON rattachés à un événement sont candidats à
           l'annulation. Ceux que ce script a déjà émis portent leur événement
           et décrivent une sortie réelle : les relire ici ferait annuler, au
           second passage, les trois bons de 7, 7 et 6 comme s'ils étaient un
           bon consolidé de 20. Rejouer doit être sans effet. */
        AND d.stock_import_movement_event_id IS NULL
      ORDER BY d.stock_movement_id, d.id`,
    [societe, idsMouvements]) : { rows: [] };

  const parMouvement = new Map();
  for (const d of docsExistants) {
    if (!parMouvement.has(d.stock_movement_id)) parMouvement.set(d.stock_movement_id, []);
    parMouvement.get(d.stock_movement_id).push(d);
  }

  /* Le plan document par document, décidé ici pour que le preview annonce
     exactement ce que l'application fera. */
  const plan = { garder: [], annulerDoublon: [], annulerConsolide: [], creer: [] };

  /* Un événement déjà écrit lors d'un passage précédent peut déjà porter son
     bon. Le redemander buterait sur l'unicité par événement et ferait échouer
     tout le lot — alors que rejouer doit être sans effet. */
  const idsConnus = dejaEcrits.map((r) => r.id);
  const { rows: dejaDocumentes } = idsConnus.length ? await pool.query(
    `SELECT stock_import_movement_event_id AS ev FROM documents
      WHERE company_id = $1 AND stock_import_movement_event_id = ANY($2::bigint[])
        AND cancelled_at IS NULL`,
    [societe, idsConnus]) : { rows: [] };
  const evenementsDejaDocumentes = new Set(dejaDocumentes.map((r) => String(r.ev)));
  for (const e of lu.evenements) {
    const connu = parCle.get(e.event_key);
    if (connu) {
      e.id = connu.id;
      e.dejaDocumente = evenementsDejaDocumentes.has(String(connu.id));
    }
  }

  for (const [mouvementId, docs] of parMouvement) {
    const evts = lu.evenements.filter((e) => e.movement_id === mouvementId);
    if (evts.length === 1 && Number(docs[0].quantite_imprimee) === evts[0].quantity) {
      /* Le bon existant porte déjà la bonne quantité : on le garde et on lui
         attache son événement. Le réémettre ferait circuler un numéro de plus
         pour rien. */
      plan.garder.push({ doc: docs[0], evenement: evts[0] });
      for (const autre of docs.slice(1)) {
        plan.annulerDoublon.push({ doc: autre, garde: docs[0] });
      }
    } else {
      /* Quantité consolidée, ou plusieurs événements : ce bon ne décrit
         aucune sortie réelle. Il est annulé et remplacé par un bon par
         événement. */
      for (const d of docs) plan.annulerConsolide.push({ doc: d, evenements: evts });
    }
  }

  const gardes = new Set(plan.garder.map((g) => g.evenement.event_key));
  for (const e of lu.evenements) {
    if (gardes.has(e.event_key)) continue;
    if (e.dejaDocumente) continue;          // un passage précédent l'a déjà émis
    if (SANS_DOCUMENTS) continue;           // on ne veut que les événements
    if (!e.movement_id && !DOCUMENTER_NON_RATTACHES) continue;
    plan.creer.push(e);
  }

  console.log(`\n${G}PLAN DOCUMENTAIRE${Z}`);
  console.log(`  bons conservés (quantité déjà exacte)        : ${plan.garder.length}`);
  for (const g of plan.garder) {
    console.log(`    ${g.doc.document_number} — ${g.evenement.produit} ${g.evenement.quantity} → rattaché à son événement`);
  }
  console.log(`  bons annulés comme DOUBLON                   : ${plan.annulerDoublon.length}`);
  for (const a of plan.annulerDoublon) {
    console.log(`    ${a.doc.document_number} (doublon de ${a.garde.document_number}, mouvement #${a.doc.stock_movement_id})`);
  }
  console.log(`  bons annulés car quantité CONSOLIDÉE         : ${plan.annulerConsolide.length}`);
  for (const a of plan.annulerConsolide) {
    console.log(`    ${a.doc.document_number} — ${Number(a.doc.quantite_imprimee)} imprimées`
      + ` → remplacé par ${a.evenements.length} bon(s) de ${a.evenements.map((e) => e.quantity).join(", ")}`);
  }
  console.log(`  bons de sortie à créer                       : ${plan.creer.length}`);
  console.log(`  quantité totale des bons à créer             : ${plan.creer.reduce((s, e) => s + e.quantity, 0)}`);

  if (PREVIEW) {
    console.log(`\n${G}RÉSUMÉ${Z}`);
    console.log(`  événements à écrire      : ${lu.evenements.filter((e) => !parCle.has(e.event_key)).length} (sur ${lu.evenements.length})`);
    console.log(`  dont non rattachés       : ${nonRattaches.length}`);
    console.log(`  mouvements modifiés      : 0`);
    console.log(`  stock modifié            : 0`);
    console.log(`\n${V}Prévisualisation terminée. Rien n'a été écrit.${Z}`);
    console.log(`Pour appliquer : --apply --confirmer=${PHRASE}\n`);
    await pool.end();
    return;
  }

  /* ── APPLICATION ────────────────────────────────────────────────────── */
  const client = await pool.connect();
  const bilan = { evenements: 0, gardes: 0, doublons: 0, consolides: 0, bons: 0 };
  try {
    await client.query("BEGIN");

    /* UN SEUL PASSAGE À LA FOIS.
       Le plan ci-dessus a été calculé hors transaction : entre sa lecture et
       ces écritures, un autre passage peut avoir tout fait. Sans ce verrou,
       deux exécutions simultanées créent chacune leurs 18 bons — et la
       production n'a pas encore l'index d'unicité qui les aurait arrêtées,
       puisque c'est justement ce qu'on est en train de réparer.
       Le verrou est lié à la transaction : il se relâche au COMMIT comme au
       ROLLBACK, même si le script meurt. */
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      ["reconstruire-sorties-rouge-fonce", `${societe}:${lu.sha256}`]);

    const avant = await empreinteStock(client);

    /* Ce que le monde a fait pendant qu'on réfléchissait. */
    const { rows: documentesEntreTemps } = await client.query(
      `SELECT e.event_key FROM stock_import_movement_events e
         JOIN documents d ON d.stock_import_movement_event_id = e.id
                         AND d.cancelled_at IS NULL
        WHERE e.company_id = $1 AND e.event_key = ANY($2::text[])`,
      [societe, lu.evenements.map((e) => e.event_key)]);
    const dejaFaits = new Set(documentesEntreTemps.map((r) => r.event_key));

    /* 1. Les événements. `ON CONFLICT` sur la clé stable : rejouer ne
          recrée rien, et deux exécutions simultanées n'en écrivent qu'un. */
    for (const e of lu.evenements) {
      const { rows } = await client.query(
        `INSERT INTO stock_import_movement_events
           (company_id, batch_id, file_sha256, excel_sheet, excel_row, excel_cell,
            event_key, direction, effective_date, event_sequence, quantity,
            source_context, status, movement_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'OUT',$8,1,$9,$10,$11,$12)
         ON CONFLICT (company_id, event_key) DO UPDATE
           SET movement_id = COALESCE(stock_import_movement_events.movement_id,
                                      EXCLUDED.movement_id),
               updated_at = now()
         RETURNING id, (xmax = 0) AS cree`,
        [societe, batchId, lu.sha256, e.excel_sheet, e.excel_row, e.excel_cell,
         e.event_key, e.effective_date, e.quantity,
         JSON.stringify({
           produit: e.produit, couleur: COULEUR_NOUVELLE_SORTIE,
           import_id: imp.id, fichier: imp.file_name,
           rayon: e.rayon, location: e.location, niveau: e.niveau, bins: e.bins,
           dates_proposees: e.datesProposees,
           rattachement: e.rattachement,
           reconstruit_le: new Date().toISOString(),
         }),
         e.movement_id ? "IMPORTED" : "READY",
         e.movement_id]
      );
      e.id = rows[0].id;
      if (rows[0].cree) bilan.evenements += 1;
    }

    /* 2. Les bons conservés reçoivent leur événement — ET sa date métier.
          L'ancien chemin d'import n'en posait aucune : ces bons s'imprimaient
          à la date de leur création en base, pas à celle de la sortie. Les
          rattacher sans les dater les laisserait porter une date fausse.
          Une date déjà saisie n'est jamais écrasée : quelqu'un l'a voulue. */
    for (const g of plan.garder) {
      const provenance = `Sortie EM2S — ${imp.file_name} · feuille ${g.evenement.excel_sheet}`
        + ` · ligne ${g.evenement.excel_row} · cellule ${g.evenement.excel_cell}`
        + ` · rouge foncé ${COULEUR_NOUVELLE_SORTIE}`;
      await client.query(
        `UPDATE documents
            SET stock_import_movement_event_id = $1,
                document_datetime = COALESCE(document_datetime, $2::timestamptz),
                observation = CASE
                  WHEN observation IS NULL OR observation = '' THEN $3
                  WHEN position($3 in observation) > 0 THEN observation
                  ELSE observation || ' — ' || $3 END,
                updated_at = now()
          WHERE id = $4 AND cancelled_at IS NULL`,
        [g.evenement.id, `${g.evenement.effective_date}T12:00:00Z`, provenance, g.doc.id]);
      bilan.gardes += 1;
    }

    /* 3. Les doublons, annulés en pointant vers celui qui reste. */
    for (const a of plan.annulerDoublon) {
      await client.query(
        `UPDATE documents
            SET cancelled_at = now(), cancelled_by_name = $1, cancellation_reason = $2,
                duplicate_of_document_id = $3, replaced_by_document_id = $3
          WHERE id = $4 AND cancelled_at IS NULL
            /* Un passage concurrent a pu, entre-temps, rattacher ce bon à son
               événement : il décrit alors une sortie réelle et n'est plus un
               doublon. */
            AND stock_import_movement_event_id IS NULL`,
        ["Reconstruction des sorties rouge foncé",
         `Doublon de ${a.garde.document_number} : deux bons actifs pour la même sortie.`,
         a.garde.id, a.doc.id]);
      bilan.doublons += 1;
    }

    /* 4. Les bons consolidés, annulés avant que leurs remplaçants n'existent —
          l'unicité par mouvement n'accepte pas deux actifs à la fois. */
    for (const a of plan.annulerConsolide) {
      await client.query(
        `UPDATE documents
            SET cancelled_at = now(), cancelled_by_name = $1, cancellation_reason = $2
          WHERE id = $3 AND cancelled_at IS NULL
            AND stock_import_movement_event_id IS NULL`,
        ["Reconstruction des sorties rouge foncé",
         `Quantité consolidée (${Number(a.doc.quantite_imprimee)}) ne correspondant à aucune sortie réelle. `
         + `Remplacé par ${a.evenements.length} bon(s) : ${a.evenements.map((e) => `${e.quantity} le ${e.effective_date}`).join(", ")}.`,
         a.doc.id]);
      bilan.consolides += 1;
    }

    /* 5. Un bon par événement, portant la quantité de l'ÉVÉNEMENT. */
    const premierRemplacant = new Map();
    for (const e of plan.creer) {
      /* Le recontrôle sous verrou : un passage concurrent a pu émettre ce bon
         entre le calcul du plan et maintenant. */
      if (dejaFaits.has(e.event_key)) continue;
      const mvt = mouvements.find((m) => m.id === e.movement_id);
      const numero = await nextShortDocumentNumber("BS", societe, client);
      const provenance = `Sortie EM2S — ${imp.file_name} · feuille ${e.excel_sheet}`
        + ` · ligne ${e.excel_row} · cellule ${e.excel_cell} · rouge foncé ${COULEUR_NOUVELLE_SORTIE}`
        + (e.movement_id ? ` · mouvement #${e.movement_id}` : " · sans mouvement rattaché");

      const { rows: doc } = await client.query(
        `INSERT INTO documents
           (document_type, document_number, client_name, client_phone, client_address,
            total_amount, observation, created_by, company_id,
            related_entity_type, related_entity_id, stock_movement_id,
            stock_import_movement_event_id, warehouse_id, status, document_datetime)
         VALUES ('Bon de sortie',$1,'','','',0,$2,$3,$4,'stock_import_movement_event',
                 $5::integer,$6::integer,$5::bigint,$7::integer,'Validé',$8::timestamptz)
         RETURNING id, document_number`,
        [numero, provenance, "Reconstruction EM2S", societe,
         e.id, e.movement_id, mvt?.warehouse_id || null,
         `${e.effective_date}T12:00:00Z`]);

      await client.query(
        `INSERT INTO document_items
           (document_id, product_reference, product_name, quantity, unit_price, total_price)
         VALUES ($1,$2,$3,$4,0,0)`,
        [doc[0].id, mvt?.product_reference || null, e.produit, e.quantity]);

      /* Le bon consolidé annulé pointe vers le premier de ses remplaçants :
         on retrouve la chaîne depuis l'ancien numéro. */
      if (e.movement_id && !premierRemplacant.has(e.movement_id)) {
        premierRemplacant.set(e.movement_id, doc[0].id);
      }
      bilan.bons += 1;
      console.log(`  ${doc[0].document_number}  ${String(e.quantity).padStart(4)}  ${e.effective_date}  ${e.produit}`);
    }

    for (const a of plan.annulerConsolide) {
      const remplacant = premierRemplacant.get(a.doc.stock_movement_id);
      if (remplacant) {
        await client.query(
          `UPDATE documents SET replaced_by_document_id = $1 WHERE id = $2`,
          [remplacant, a.doc.id]);
        await client.query(
          `UPDATE documents SET replaces_document_id = $1 WHERE id = $2`,
          [a.doc.id, remplacant]);
      }
    }

    /* 6. Le contrôle qui rend l'opération sûre. */
    const apres = await empreinteStock(client);
    for (const cle of Object.keys(avant)) {
      if (String(avant[cle]) !== String(apres[cle])) {
        throw new Error(
          `Une donnée hors documents a bougé (${cle} : ${avant[cle]} → ${apres[cle]}). `
          + "Cette reconstruction ne doit toucher que des événements et des documents. Tout est annulé.");
      }
    }

    await client.query("COMMIT");
    console.log(`\n${V}RECONSTRUCTION TERMINÉE${Z}`);
    console.log(`  événements créés          : ${bilan.evenements}`);
    console.log(`  bons conservés            : ${bilan.gardes}`);
    console.log(`  doublons annulés          : ${bilan.doublons}`);
    console.log(`  bons consolidés annulés   : ${bilan.consolides}`);
    console.log(`  bons de sortie créés      : ${bilan.bons}`);
    console.log(`  ${V}stock, mouvements, produits et balances : inchangés, vérifiés avant COMMIT.${Z}\n`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n${R}ÉCHEC : ${e.message}${Z}`);
    console.error("Aucun événement, aucun document n'a été écrit.\n");
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(async (e) => {
  console.error(`${R}ÉCHEC : ${e.message}${Z}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
