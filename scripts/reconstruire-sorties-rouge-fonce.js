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
 *
 * ── L'EXCEPTION DE VERSION MÉTIER ──────────────────────────────────────────
 *
 * Une empreinte différente est REFUSÉE. Le binaire importé le 2 septembre
 * n'existe plus ; le fichier restant a le même contenu métier mais d'autres
 * octets. Pour ce seul cas, une exception nommée s'ouvre — et seulement si
 * société, import, nom de fichier, les deux empreintes, les 21 lignes
 * certifiées et les totaux enregistrés concordent TOUS :
 *
 *   --autoriser-version-metier \
 *   --empreinte-import-attendue=61b7104201a1… \
 *   --confirmer-version-metier=OUI-JE-CONFIRME-LA-VERSION-METIER
 *
 * `inventory_imports.file_hash` n'est jamais modifié. Les deux empreintes et
 * le motif sont inscrits dans chaque événement et chaque bon créés.
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

/* ═══════════════════════════════════════════════════════════════════════════
   L'EXCEPTION DE VERSION MÉTIER
   ═══════════════════════════════════════════════════════════════════════════

   Le classeur importé le 2 septembre portait l'empreinte 61b710… ; ce binaire
   n'existe plus. Le fichier encore disponible porte 2ceb08… — même contenu
   métier, octets différents : un classeur Excel ré-enregistré change de
   binaire sans que rien du métier ne bouge.

   Refuser tout net serait défendable mais bloquant : sans le binaire d'origine,
   les 21 bons de sortie ne pourraient jamais être émis. Accepter sur le seul
   nom du fichier serait pire — c'est exactement ainsi qu'on reconstruit des
   événements à partir d'une version retouchée à la main.

   La sortie est donc une exception NOMMÉE, valable pour ce seul cas, et qui ne
   s'ouvre que si TOUT concorde en même temps : la société, l'import, le nom du
   fichier, les deux empreintes attendues, le contenu ligne à ligne du
   classeur, et les totaux enregistrés de l'import. Une seule divergence, et
   rien ne s'écrit — pas même en prévisualisation.

   L'empreinte enregistrée n'est JAMAIS modifiée : la base continue de dire la
   vérité sur ce qui a été importé. Ce sont les événements et les bons créés
   qui portent la trace des deux empreintes et du motif. */

const EXCEPTION = {
  companyId: 1,
  importId: 3,
  fileName: "Copie de dernier actualisation bby me.xlsx",
  empreinteEnregistree: "61b7104201a146f27812c6b2603ee3b9dbc790879282b0c081d81e6379690e9e",
  empreinteFournie: "2ceb0871526eb452a003fdab0852c2881892e131cfbd41974242b9a737f5bc42",
  phrase: "OUI-JE-CONFIRME-LA-VERSION-METIER",
  motif: "Binaire d'origine indisponible ; version métier identique validée "
       + "ligne à ligne contre le relevé certifié et les totaux de l'import n°3.",
  /* Le résumé enregistré de l'import n°3, tel qu'il figure en base. */
  totaux: {
    totalIn: 6073, totalOut: 12193, totalWriteOff: 3,
    stockBefore: 151244, stockAfter: 149840,
    rows_read: 235, rows_imported: 200, rows_skipped: 5,
  },
};

/* ── ALIAS CERTIFIÉS ──────────────────────────────────────────────────────
   Le classeur écrit « OFFICIENCY AMPLIFIER » ; la base porte
   « EFFICIENCY AMPLIFIER ». Une lettre, une faute de frappe d'origine, et le
   rapprochement échoue — le preview production s'est arrêté là, à juste titre.

   Un rapprochement approximatif serait la mauvaise réponse. Une distance de
   Levenshtein accepterait « OFFICIENCY AMPLIFIER » pour
   « HIGHT EFFICIENCY AMPLIFIER POWER », qui est un AUTRE produit du même
   classeur, avec une autre quantité et une autre date. Coller un bon sur le
   mauvais mouvement est pire que de ne pas le coller.

   Chaque alias est donc NOMMÉ et ancré : une société, un import, un mouvement,
   un produit, une quantité. Il ne s'applique que si tout cela concorde et que
   les deux empreintes sont celles de la version métier certifiée. Ailleurs, il
   n'existe pas. */
const ALIAS_CERTIFIES = [{
  libelleExcel: "OFFICIENCY AMPLIFIER",
  libelleMouvement: "EFFICIENCY AMPLIFIER",
  excelRow: 175,
  companyId: 1,
  importId: 3,
  movementId: 671,
  productId: 87,
  quantite: 8,
  motif: "Faute de frappe du classeur d'origine : le O initial de "
       + "« OFFICIENCY » n'existe pas dans la base, qui porte "
       + "« EFFICIENCY AMPLIFIER ». Même article, vérifié sur le mouvement "
       + "#671 (product_id 87, sortie de 8) de l'import n°3.",
}];

/* Les 21 sorties rouge foncé, certifiées : ligne, cellule, produit, quantité,
   date. C'est contre CELA que le classeur est relu, cellule par cellule.
   Comparer des totaux ne suffirait pas : deux erreurs qui se compensent
   passeraient. */
const MANIFESTE_CERTIFIE = [
  [167, "M167", "PROFESSIONAL AMPLIFIER POWER", 2, "2026-07-29"],
  [171, "M171", "AUDIO DEVISE", 6, "2026-07-20"],
  [175, "M175", "OFFICIENCY AMPLIFIER", 8, "2026-07-27"],
  [196, "M196", "PROFESSIONAL SPEAKER (GRAND)", 8, "2026-07-20"],
  [199, "M199", "POWER SEQUENCY", 7, "2026-07-27"],
  [205, "M205", "STADE 4 AOUT", 7, "2026-08-31"],
  [207, "M207", "STADE 4 AOUT", 7, "2026-08-31"],
  [208, "M208", "STADE 4 AOUT", 6, "2026-08-31"],
  [234, "M234", "ROULEAU CABLE NOIR 30M", 2, "2026-08-17"],
  [248, "M248", "MAMBRANE", 25, "2026-08-25"],
  [250, "M250", "MICRO BALADEUR BL X24", 8, "2026-07-31"],
  [253, "M253", "PROCESSEUR NUMERIQUE", 6, "2026-07-24"],
  [255, "M255", "MG 16XU", 2, "2026-08-17"],
  [256, "M256", "TETE DE JACK", 504, "2026-07-27"],
  [260, "M260", "MICRO CONFERENCE", 2, "2026-08-17"],
  [263, "M263", "MICROPHONE ST 9380", 1, "2026-07-09"],
  [265, "M265", "AUDIO DEVISE", 1, "2026-08-25"],
  [266, "M266", "HIGHT EFFICIENCY AMPLIFIER POWER", 6, "2026-08-25"],
  [267, "M267", "PROFESSIONAL AMPLIFIER POWER", 3, "2026-08-25"],
  [297, "M297", "FAUX PLAFOND D", 80, "2026-08-20"],
  [342, "M342", "WALL LAMP", 48, "2026-08-21"],
];

const args = process.argv.slice(2);
const opt = (nom) => {
  const t = args.find((a) => a.startsWith(`--${nom}=`));
  return t ? t.slice(nom.length + 3) : null;
};
const PREVIEW = args.includes("--preview");
const APPLY = args.includes("--apply");
const DOCUMENTER_NON_RATTACHES = args.includes("--documenter-non-rattaches");
const SANS_DOCUMENTS = args.includes("--sans-documents");
const AUTORISER_VERSION_METIER = args.includes("--autoriser-version-metier");

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
/**
 * L'alias applicable à ce groupe, ou rien.
 *
 * Toutes les conditions sont exigées ensemble. Il n'y a pas de « presque » :
 * un mouvement de 7 au lieu de 8, un autre import, un autre `product_id`, et
 * l'alias ne s'applique pas — le produit ressort non rattaché, ce qui est le
 * comportement sûr.
 *
 * `product_id` n'est vérifié que s'il est renseigné : une base où la colonne
 * est vide ne doit pas faire échouer un rapprochement par ailleurs prouvé,
 * mais une valeur PRÉSENTE et différente est un refus.
 */
function aliasApplicable({ produit, somme, mouvements, contexte }) {
  if (!contexte.aliasAutorise) return null;

  for (const alias of ALIAS_CERTIFIES) {
    if (compacter(alias.libelleExcel) !== produit) continue;
    if (alias.companyId !== contexte.societe) continue;
    if (alias.importId !== contexte.importId) continue;
    if (alias.quantite !== somme) continue;

    const mouvement = mouvements.find((m) => Number(m.id) === alias.movementId);
    if (!mouvement) continue;
    if (compacter(mouvement.product_name) !== compacter(alias.libelleMouvement)) continue;
    if (Number(mouvement.quantity) !== alias.quantite) continue;
    if (mouvement.type !== "Sortie") continue;
    if (mouvement.product_id != null && Number(mouvement.product_id) !== alias.productId) continue;

    return { alias, mouvement };
  }
  return null;
}

function rattacher(evenements, mouvements, contexte) {
  const parProduit = new Map();
  for (const e of evenements) {
    if (!parProduit.has(e.produitCompacte)) parProduit.set(e.produitCompacte, []);
    parProduit.get(e.produitCompacte).push(e);
  }

  const dejaPris = new Set();
  const aliasUtilises = [];

  for (const [produit, groupe] of parProduit) {
    const somme = groupe.reduce((s, e) => s + e.quantity, 0);
    let candidats = mouvements.filter(
      (m) => compacter(m.product_name) === produit && !dejaPris.has(m.id));

    /* Rien sous ce libellé : un alias certifié peut désigner le mouvement,
       et lui seul. */
    if (candidats.length === 0) {
      const trouve = aliasApplicable({ produit, somme, mouvements, contexte });
      if (trouve && !dejaPris.has(trouve.mouvement.id)) {
        candidats = [trouve.mouvement];
        for (const e of groupe) {
          e.alias = {
            libelle_excel: trouve.alias.libelleExcel,
            libelle_mouvement: trouve.alias.libelleMouvement,
            mouvement_id: trouve.mouvement.id,
            product_id: trouve.mouvement.product_id ?? null,
            quantite: trouve.alias.quantite,
            motif: trouve.alias.motif,
          };
        }
        aliasUtilises.push(groupe[0].alias);
      }
    }

    const consolide = candidats.find((m) => Number(m.quantity) === somme);
    if (consolide) {
      dejaPris.add(consolide.id);
      for (const e of groupe) {
        e.movement_id = consolide.id;
        e.rattachement = (groupe.length > 1
          ? `mouvement consolidé #${consolide.id} (${somme} = ${groupe.map((x) => x.quantity).join(" + ")})`
          : `mouvement #${consolide.id}`)
          + (e.alias ? ` · alias certifié « ${e.alias.libelle_excel} » → « ${e.alias.libelle_mouvement} »` : "");
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
        e.rattachement = `mouvement #${seul.id}`
          + (e.alias ? ` · alias certifié « ${e.alias.libelle_excel} » → « ${e.alias.libelle_mouvement} »` : "");
      } else {
        e.movement_id = null;
        e.rattachement = candidats.length
          ? `AUCUN mouvement de ${e.quantity} — candidats : ${candidats.map((m) => `#${m.id}=${Number(m.quantity)}`).join(", ")}`
          : "AUCUN mouvement de ce produit dans cet import";
      }
    }
  }

  return aliasUtilises;
}

/** Clé stable : rejouer le script ne recrée jamais un événement déjà écrit. */
function cleEvenement(sha256, e) {
  return `EM2S:${sha256.slice(0, 12)}:${e.excel_sheet}:R${e.excel_row}:${e.direction}:${e.effective_date}`;
}

/* ═══════════════════════════ VALIDATION DE LA VERSION MÉTIER ══ */

/** Le résumé d'import nomme ses totaux différemment selon la version qui
    l'a écrit. On accepte les graphies connues plutôt que d'échouer sur un
    détail de nommage — mais une valeur introuvable reste une divergence. */
function valeurResume(resume, ...cles) {
  if (!resume || typeof resume !== "object") return undefined;
  const plat = { ...resume, ...(resume.totaux || {}), ...(resume.totals || {}) };
  for (const cle of cles) {
    for (const variante of [cle, cle.toLowerCase(),
      cle.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()]) {
      if (plat[variante] !== undefined && plat[variante] !== null) return Number(plat[variante]);
    }
  }
  return undefined;
}

/**
 * L'exception n'est accordée que si TOUT concorde.
 *
 * Chaque contrôle produit une preuve affichée, ou une divergence. Une seule
 * divergence suffit à tout arrêter : le but n'est pas de trouver une raison
 * d'accepter, c'est de rendre impossible d'accepter le mauvais fichier.
 */
async function validerVersionMetier({ lu, imp, societe, mouvements }) {
  const preuves = [];
  const divergences = [];
  const controle = (titre, ok, attendu, obtenu) => {
    (ok ? preuves : divergences).push({ titre, attendu, obtenu });
  };

  /* ── 1. Le périmètre de l'exception, terme à terme ── */
  controle("société", societe === EXCEPTION.companyId, EXCEPTION.companyId, societe);
  controle("import", Number(imp.id) === EXCEPTION.importId, EXCEPTION.importId, Number(imp.id));
  controle("nom exact du fichier", imp.file_name === EXCEPTION.fileName,
    EXCEPTION.fileName, imp.file_name);
  controle("empreinte enregistrée en base",
    imp.file_hash === EXCEPTION.empreinteEnregistree,
    EXCEPTION.empreinteEnregistree, imp.file_hash);
  controle("empreinte du fichier fourni",
    lu.sha256 === EXCEPTION.empreinteFournie,
    EXCEPTION.empreinteFournie, lu.sha256);
  controle("empreinte attendue annoncée par l'opérateur",
    opt("empreinte-import-attendue") === EXCEPTION.empreinteEnregistree,
    EXCEPTION.empreinteEnregistree, opt("empreinte-import-attendue") || "(absente)");
  controle("phrase de confirmation",
    opt("confirmer-version-metier") === EXCEPTION.phrase,
    EXCEPTION.phrase, opt("confirmer-version-metier") || "(absente)");

  /* ── 2. Le contenu du classeur, ligne à ligne ── */
  controle("feuille lue", FEUILLE === "LISTE DES STOCK", "LISTE DES STOCK", FEUILLE);
  controle("nombre de sorties rouge foncé",
    lu.evenements.length === MANIFESTE_CERTIFIE.length,
    MANIFESTE_CERTIFIE.length, lu.evenements.length);
  controle("total des unités", lu.total === ATTENDU_UNITES, ATTENDU_UNITES, lu.total);

  const parLigne = new Map(lu.evenements.map((e) => [e.excel_row, e]));
  let lignesConformes = 0;
  for (const [ligne, cellule, produit, quantite, date] of MANIFESTE_CERTIFIE) {
    const e = parLigne.get(ligne);
    if (!e) {
      divergences.push({ titre: `ligne ${ligne}`, attendu: `${produit} ${quantite} le ${date}`,
        obtenu: "absente du classeur" });
      continue;
    }
    const memeCellule = e.excel_cell === cellule;
    const memeProduit = compacter(e.produit) === compacter(produit);
    const memeQuantite = Number(e.quantity) === quantite;
    const memeDate = e.effective_date === date;
    if (memeCellule && memeProduit && memeQuantite && memeDate) { lignesConformes += 1; continue; }
    divergences.push({
      titre: `ligne ${ligne}`,
      attendu: `${cellule} · ${produit} · ${quantite} · ${date}`,
      obtenu: `${e.excel_cell} · ${e.produit} · ${Number(e.quantity)} · ${e.effective_date}`,
    });
  }
  controle(`les ${MANIFESTE_CERTIFIE.length} lignes certifiées (cellule, produit, quantité, date)`,
    lignesConformes === MANIFESTE_CERTIFIE.length,
    `${MANIFESTE_CERTIFIE.length} conformes`, `${lignesConformes} conformes`);

  /* Aucune ligne rouge foncé EN PLUS de celles certifiées : une sortie
     ajoutée dans une version retouchée doit se voir. */
  const enTrop = lu.evenements
    .filter((e) => !MANIFESTE_CERTIFIE.some(([l]) => l === e.excel_row))
    .map((e) => `ligne ${e.excel_row} (${e.produit} ${e.quantity})`);
  controle("aucune sortie rouge foncé hors du relevé certifié",
    enTrop.length === 0, "aucune", enTrop.join(", ") || "aucune");

  /* ── 3. Cohérence avec les mouvements consolidés de l'import ── */
  const parProduit = new Map();
  for (const e of lu.evenements) {
    const k = compacter(e.produit);
    parProduit.set(k, (parProduit.get(k) || 0) + e.quantity);
  }
  /* L'alias n'est consultable que si les deux empreintes sont exactement
     celles de la version métier certifiée : c'est la même porte, pas une
     seconde. */
  const aliasAutorise = imp.file_hash === EXCEPTION.empreinteEnregistree
    && lu.sha256 === EXCEPTION.empreinteFournie;
  const aliasVus = [];

  const sansCorrespondance = [];
  for (const [produit, somme] of parProduit) {
    const candidats = mouvements.filter((m) => compacter(m.product_name) === produit);
    if (candidats.some((m) => Number(m.quantity) === somme)) continue;

    const parAlias = candidats.length === 0
      ? aliasApplicable({ produit, somme, mouvements,
        contexte: { societe, importId: Number(imp.id), aliasAutorise } })
      : null;
    if (parAlias) {
      aliasVus.push(`« ${parAlias.alias.libelleExcel} » → `
        + `« ${parAlias.alias.libelleMouvement} », mouvement #${parAlias.mouvement.id}, `
        + `quantité ${parAlias.alias.quantite}`
        + (parAlias.mouvement.product_id != null
          ? `, product_id ${parAlias.mouvement.product_id}` : ""));
      continue;
    }
    sansCorrespondance.push(`${produit} (${somme})`);
  }

  if (aliasVus.length) {
    controle(`alias certifié appliqué : ${aliasVus.join(" ; ")}`, true,
      "alias nommé et ancré", aliasVus.join(" ; "));
  }
  /* MAMBRANE est le seul produit connu sans mouvement dans cet import. Tout
     autre produit sans correspondance signale un classeur qui ne décrit pas
     le même import. */
  const inattendus = sansCorrespondance.filter((s) => !s.startsWith("MAMBRANE"));
  controle("chaque produit correspond à un mouvement consolidé de l'import "
    + "(hors MAMBRANE, connue sans mouvement)",
    inattendus.length === 0, "aucun écart", inattendus.join(", ") || "aucun écart");

  const totalSorties = mouvements.reduce((s, m) => s + Number(m.quantity), 0);
  controle("somme réelle des sorties de l'import",
    totalSorties === EXCEPTION.totaux.totalOut, EXCEPTION.totaux.totalOut, totalSorties);
  controle("nombre de mouvements de sortie", mouvements.length === 43, 43, mouvements.length);

  /* ── 4. Les totaux enregistrés de l'import ── */
  const resume = imp.summary || {};
  const attendus = [
    ["totalIn", valeurResume(resume, "totalIn", "total_in", "totalEntrees"), EXCEPTION.totaux.totalIn],
    ["totalOut", valeurResume(resume, "totalOut", "total_out", "totalSorties"), EXCEPTION.totaux.totalOut],
    ["totalWriteOff", valeurResume(resume, "totalWriteOff", "total_write_off", "totalWriteOffs"), EXCEPTION.totaux.totalWriteOff],
    ["stockBefore", valeurResume(resume, "stockBefore", "stock_before", "stockAvant"), EXCEPTION.totaux.stockBefore],
    ["stockAfter", valeurResume(resume, "stockAfter", "stock_after", "stockApres"), EXCEPTION.totaux.stockAfter],
  ];
  for (const [nom, obtenu, attendu] of attendus) {
    controle(`résumé enregistré · ${nom}`, obtenu === attendu, attendu,
      obtenu === undefined ? "(absent du résumé)" : obtenu);
  }
  for (const [colonne, attendu] of [
    ["rows_read", EXCEPTION.totaux.rows_read],
    ["rows_imported", EXCEPTION.totaux.rows_imported],
    ["rows_skipped", EXCEPTION.totaux.rows_skipped],
  ]) {
    controle(`import · ${colonne}`, Number(imp[colonne]) === attendu, attendu, imp[colonne]);
  }

  return { preuves, divergences };
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

  const societe = opt("societe") ? Number(opt("societe")) : imp.company_id;
  const empreinteDifferente = Boolean(imp.file_hash) && imp.file_hash !== lu.sha256;

  console.log(`\n${G}IMPORT VISÉ${Z}`);
  console.log(`  n°${imp.id} — ${imp.file_name}`);
  console.log(`  société ${societe} · statut ${imp.status} · ${new Date(imp.created_at).toISOString().slice(0, 19).replace("T", " ")}`);
  console.log(`  empreinte ${imp.file_hash ? (empreinteDifferente ? R + "DIFFÉRENTE" + Z : V + "conforme" + Z) : J + "non enregistrée" + Z}`);

  /* ── L'état actuel ──────────────────────────────────────────────────── */
  const { rows: mouvements } = await pool.query(
    `SELECT id, type, product_id, product_name, product_reference, quantity,
            warehouse_id, location_code
       FROM stock_movements
      WHERE company_id = $1 AND import_id = $2 AND type = 'Sortie'
      ORDER BY id`,
    [societe, imp.id]);
  const totalMouvements = mouvements.reduce((s, m) => s + Number(m.quantity), 0);

  /* ── Le SHA-256, seule preuve que le fichier relu est celui qui a été
        importé. Un fichier « du même nom » ne suffit pas : c'est ainsi qu'on
        reconstruit des événements à partir d'une version retouchée. ────── */
  let auditVersionMetier = null;

  if (empreinteDifferente && !AUTORISER_VERSION_METIER) {
    stop(`\nL'import n°${imp.id} porte l'empreinte ${String(imp.file_hash).slice(0, 16)}…\n`
       + `Le fichier fourni porte    ${lu.sha256.slice(0, 16)}…\n`
       + "Ce n'est pas le classeur qui a été importé. Arrêt.");
  }

  if (empreinteDifferente) {
    console.log(`\n${R}${G}EMPREINTE BINAIRE DIFFÉRENTE${Z}`);
    console.log(`  enregistrée à l'import : ${imp.file_hash}`);
    console.log(`  fichier fourni         : ${lu.sha256}`);
    console.log(`  Le binaire d'origine n'est plus disponible. La version métier`);
    console.log(`  doit donc être validée pièce par pièce avant toute écriture.\n`);

    const { preuves, divergences } = await validerVersionMetier(
      { lu, imp, societe, mouvements });

    console.log(`${G}PREUVES COMPARÉES${Z}`);
    for (const p of preuves) {
      console.log(`  ${V}✓${Z} ${p.titre.padEnd(62)} ${String(p.obtenu).slice(0, 40)}`);
    }
    if (divergences.length) {
      console.log(`\n${R}${G}DIVERGENCES${Z}`);
      for (const d of divergences) {
        console.log(`  ${R}✗${Z} ${d.titre}`);
        console.log(`      attendu : ${d.attendu}`);
        console.log(`      obtenu  : ${d.obtenu}`);
      }
      stop(`\n${divergences.length} divergence(s). La version métier n'est PAS validée. `
         + "Rien n'a été lu plus loin, rien n'a été écrit. Arrêt.");
    }

    console.log(`\n${V}${G}VERSION MÉTIER STRICTEMENT VALIDÉE${Z}`);
    console.log(`  ${preuves.length} contrôles concordants, 0 divergence.`);
    console.log(`  L'empreinte enregistrée en base n'est pas modifiée.`);
    console.log(`  Les deux empreintes et le motif sont inscrits dans chaque`);
    console.log(`  événement et chaque document créés.\n`);

    auditVersionMetier = {
      version_metier_acceptee: true,
      empreinte_enregistree: imp.file_hash,
      empreinte_fichier_relu: lu.sha256,
      motif: EXCEPTION.motif,
      controles_concordants: preuves.length,
      valide_le: new Date().toISOString(),
    };
  }

  /* L'identité d'un événement est celle de son IMPORT, pas celle du binaire
     qu'on a sous la main. En version métier, les événements portent donc
     l'empreinte ENREGISTRÉE : c'est elle qui les rattache à l'import n°3, et
     c'est sur elle que l'écran Documents les retrouve. */
  const empreinteImport = imp.file_hash || lu.sha256;

  /* ── Le lot d'import, s'il existe ───────────────────────────────────── */
  const { rows: lots } = await pool.query(
    `SELECT id, status FROM stock_import_batches
      WHERE company_id = $1 AND file_sha256 = ANY($2::text[]) ORDER BY id DESC LIMIT 1`,
    [societe, [...new Set([empreinteImport, lu.sha256])]]);
  const batchId = lots[0]?.id || null;

  const { rows: evExistants } = await pool.query(
    `SELECT count(*) FILTER (WHERE direction = 'OUT') AS sorties, count(*) AS total
       FROM stock_import_movement_events WHERE company_id = $1`, [societe]);

  console.log(`\n${G}ÉTAT ACTUEL${Z}`);
  console.log(`  mouvements de sortie de cet import : ${mouvements.length} pour ${totalMouvements} unités`);
  console.log(`  événements métier enregistrés      : ${evExistants[0].total} (dont ${evExistants[0].sorties} OUT)`);
  console.log(`  lot d'import correspondant         : ${batchId ? `#${batchId} (${lots[0].status})` : "aucun"}`);

  /* ── Rattachement ───────────────────────────────────────────────────── */
  /* L'alias n'existe que dans le cadre certifié : mêmes empreintes, même
     société, même import. Hors de là, il n'est jamais consulté. */
  const aliasAutorise = imp.file_hash === EXCEPTION.empreinteEnregistree
    && lu.sha256 === EXCEPTION.empreinteFournie;
  const aliasUtilises = rattacher(lu.evenements, mouvements,
    { societe, importId: Number(imp.id), aliasAutorise });
  for (const e of lu.evenements) e.event_key = cleEvenement(empreinteImport, e);

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

  if (aliasUtilises.length) {
    console.log(`\n${G}ALIAS CERTIFIÉS UTILISÉS${Z}`);
    for (const a of aliasUtilises) {
      console.log(`  « ${a.libelle_excel} » → « ${a.libelle_mouvement} »`
        + `, mouvement #${a.mouvement_id}, quantité ${a.quantite}`
        + (a.product_id != null ? `, product_id ${a.product_id}` : ""));
      console.log(`    ${a.motif}`);
    }
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
    console.log(`  alias certifiés utilisés : ${aliasUtilises.length}`);
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
      ["reconstruire-sorties-rouge-fonce", `${societe}:${empreinteImport}`]);

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
        [societe, batchId, empreinteImport, e.excel_sheet, e.excel_row, e.excel_cell,
         e.event_key, e.effective_date, e.quantity,
         JSON.stringify({
           produit: e.produit, couleur: COULEUR_NOUVELLE_SORTIE,
           import_id: imp.id, fichier: imp.file_name,
           rayon: e.rayon, location: e.location, niveau: e.niveau, bins: e.bins,
           dates_proposees: e.datesProposees,
           rattachement: e.rattachement,
           reconstruit_le: new Date().toISOString(),
           /* Les deux empreintes voyagent avec l'événement : dans six mois,
              on doit pouvoir dire d'où vient ce bon sans relire ce script. */
           empreinte_import: empreinteImport,
           empreinte_fichier_relu: lu.sha256,
           /* Les deux libellés restent lisibles côte à côte : celui du
              classeur et celui de la base. Sans cela, on ne saurait plus
              pourquoi un bon « OFFICIENCY » pointe vers « EFFICIENCY ». */
           ...(e.alias ? { alias_certifie: e.alias } : {}),
           ...(auditVersionMetier ? {
             audit_version_metier: {
               ...auditVersionMetier,
               ...(e.alias ? {
                 libelle_excel: e.alias.libelle_excel,
                 libelle_mouvement: e.alias.libelle_mouvement,
                 alias_motif: e.alias.motif,
               } : {}),
             },
           } : {}),
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
      /* La preuve — fichier, feuille, ligne, cellule, mouvement, empreintes,
         alias — vit dans stock_import_movement_events.source_context, jamais
         sur le bon lui-même. Un client qui reçoit ce document ne doit jamais
         lire de jargon technique ; `observation` reste donc intacte ici,
         sans y injecter la provenance de l'événement. */
      await client.query(
        `UPDATE documents
            SET stock_import_movement_event_id = $1,
                document_datetime = COALESCE(document_datetime, $2::timestamptz),
                updated_at = now()
          WHERE id = $3 AND cancelled_at IS NULL`,
        [g.evenement.id, `${g.evenement.effective_date}T12:00:00Z`, g.doc.id]);
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
      /* `observation` est un champ CLIENT : un bon imprimé part parfois chez
         quelqu'un d'extérieur, et rien de technique — fichier, feuille,
         cellule, empreintes, mention « VERSION MÉTIER VALIDÉE » — n'a sa
         place là. Toute cette preuve est déjà écrite, complète, dans
         `stock_import_movement_events.source_context` (et son
         `audit_version_metier` le cas échéant), accessible via
         `stock_import_movement_event_id`. Le bon reste donc muet ici. */
      const { rows: doc } = await client.query(
        `INSERT INTO documents
           (document_type, document_number, client_name, client_phone, client_address,
            total_amount, observation, created_by, company_id,
            related_entity_type, related_entity_id, stock_movement_id,
            stock_import_movement_event_id, warehouse_id, status, document_datetime)
         VALUES ('Bon de sortie',$1,'','','',0,'',$2,$3,'stock_import_movement_event',
                 $4::integer,$5::integer,$4::bigint,$6::integer,'Validé',$7::timestamptz)
         RETURNING id, document_number`,
        [numero, "Reconstruction EM2S", societe,
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
