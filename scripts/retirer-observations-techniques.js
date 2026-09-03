"use strict";

/**
 * RETIRER LES MENTIONS TECHNIQUES DE L'OBSERVATION DES 21 BONS EM2S.
 *
 *   node scripts/retirer-observations-techniques.js --preview
 *
 *   node scripts/retirer-observations-techniques.js --apply \
 *        --confirmer=OUI-JE-RETIRE-LES-OBSERVATIONS
 *
 * ── LE PROBLÈME ────────────────────────────────────────────────────────────
 *
 * `scripts/reconstruire-sorties-rouge-fonce.js` écrivait, avant sa dernière
 * correction, la provenance technique de chaque bon dans `documents.observation`
 * — nom du fichier Excel, feuille, ligne, cellule, et pour les bons issus de la
 * version métier, la mention « VERSION MÉTIER VALIDÉE » suivie des deux
 * empreintes SHA-256. Ce texte est déjà passé en production sur les 21 bons de
 * l'import n°3. `observation` est un champ CLIENT : un bon de sortie part
 * parfois chez quelqu'un d'extérieur à l'entreprise, qui n'a rien à faire d'un
 * nom de fichier ou d'une empreinte cryptographique.
 *
 * Ce script vide `observation` sur ces 21 bons, et seulement eux.
 *
 * ── CE QU'IL NE FAIT JAMAIS ────────────────────────────────────────────────
 *
 * Il ne supprime aucun document. Il ne touche ni `document_number`, ni
 * `document_datetime`, ni `document_items`, ni `stock_movement_id`, ni
 * `stock_import_movement_event_id`, ni la quantité, ni le statut.
 *
 * Il ne touche jamais `products`, `stock_movements` ni
 * `stock_location_balances` : le contrôle final relit ces tables et annule
 * toute la transaction si un seul chiffre a bougé.
 *
 * Il ne retire RIEN de `stock_import_movement_events.source_context` : la
 * preuve technique complète — empreintes, alias, ligne Excel, cellule, audit
 * de version métier — reste entièrement en base, accessible par
 * `stock_import_movement_event_id`. Ce script déplace la frontière entre ce
 * que voit un client et ce que garde l'audit ; il ne détruit aucune preuve.
 *
 * ── CE QU'IL ÉCRIT ─────────────────────────────────────────────────────────
 *
 * Avant chaque modification, une révision dans `document_content_revisions` :
 * le contenu avant (lignes inchangées + l'ancienne observation), le contenu
 * après (mêmes lignes + observation vide), le motif exact
 * « Retrait des mentions techniques internes du bon imprimable », si le bon
 * était déjà imprimé, et un auteur système clairement identifié. Le schéma de
 * cette table est relu tel qu'il existe ; aucune colonne n'est inventée.
 */

const { Pool } = require("pg");

const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";

/* Le périmètre est celui donné par la production : société 1, l'empreinte
   ENREGISTRÉE de l'import n°3 (celle que portent les 21 événements, pas celle
   du fichier relu — voir reconstruire-sorties-rouge-fonce.js). Nommer ces
   valeurs en dur, plutôt qu'en argument libre, empêche d'élargir par erreur
   le périmètre à une autre société ou un autre import. */
const CIBLE = {
  companyId: 1,
  fileSha256: "61b7104201a146f27812c6b2603ee3b9dbc790879282b0c081d81e6379690e9e",
};
const ATTENDU_DOCUMENTS = 21;
const ATTENDU_UNITES = 739;
const PHRASE = "OUI-JE-RETIRE-LES-OBSERVATIONS";
const MOTIF = "Retrait des mentions techniques internes du bon imprimable";
const AUTEUR = "Correction automatique (script retirer-observations-techniques.js)";

const args = process.argv.slice(2);
const PREVIEW = args.includes("--preview");
const APPLY = args.includes("--apply");
const opt = (nom) => {
  const t = args.find((a) => a.startsWith(`--${nom}=`));
  return t ? t.slice(nom.length + 3) : null;
};

function stop(message) { console.error(`${R}${message}${Z}`); process.exit(1); }

if (PREVIEW === APPLY) stop("Indiquez exactement un mode : --preview ou --apply.");
if (APPLY && opt("confirmer") !== PHRASE) {
  stop(`--apply modifie des documents déjà émis. Confirmez explicitement :\n`
     + `  --apply --confirmer=${PHRASE}`);
}
if (!process.env.DATABASE_URL) stop("DATABASE_URL manquant.");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Les tables qui n'ont pas le droit de bouger, ici comme partout ailleurs. */
async function empreinteStock(client) {
  const { rows } = await client.query(`
    SELECT (SELECT coalesce(sum(stock), 0)     FROM products)                AS produits_total,
           (SELECT count(*)                    FROM products)                AS produits_nb,
           (SELECT coalesce(sum(quantity), 0)  FROM stock_movements)         AS mouvements_total,
           (SELECT count(*)                    FROM stock_movements)         AS mouvements_nb,
           (SELECT coalesce(sum(quantity), 0)  FROM stock_location_balances) AS balances_total,
           (SELECT count(*)                    FROM stock_location_balances) AS balances_nb`);
  return rows[0];
}

/** Les 21 documents ciblés, tels qu'ils sont là maintenant. */
async function documentsCibles(executeur) {
  const { rows } = await executeur.query(
    `SELECT d.id, d.company_id, d.document_number, d.document_type,
            d.observation, d.print_count, d.printed_at, d.document_revision,
            d.stock_import_movement_event_id,
            (SELECT coalesce(sum(quantity), 0) FROM document_items i
              WHERE i.document_id = d.id) AS quantite
       FROM documents d
       JOIN stock_import_movement_events e ON e.id = d.stock_import_movement_event_id
      WHERE e.company_id = $1 AND e.file_sha256 = $2
        AND d.cancelled_at IS NULL
      ORDER BY d.id
      FOR UPDATE OF d`,
    [CIBLE.companyId, CIBLE.fileSha256]
  );
  return rows;
}

async function main() {
  console.log(`\n${G}RETRAIT DES MENTIONS TECHNIQUES — 21 BONS EM2S${Z}`);
  console.log(`Base   : ${String(process.env.DATABASE_URL).replace(/:\/\/[^@]*@/, "://***@")}`);
  console.log(`Mode   : ${PREVIEW ? "PRÉVISUALISATION — aucune écriture" : "APPLICATION"}`);
  console.log(`Cible  : société ${CIBLE.companyId}, import de l'empreinte ${CIBLE.fileSha256.slice(0, 16)}…`);

  const docs = await documentsCibles(pool);
  const total = docs.reduce((s, d) => s + Number(d.quantite), 0);

  console.log(`\n${G}CONTRÔLE DU PÉRIMÈTRE${Z}`);
  console.log(`  documents ciblés : ${docs.length} (attendu ${ATTENDU_DOCUMENTS}) `
    + `${docs.length === ATTENDU_DOCUMENTS ? V + "✓" : R + "✗"}${Z}`);
  console.log(`  total des unités : ${total} (attendu ${ATTENDU_UNITES}) `
    + `${total === ATTENDU_UNITES ? V + "✓" : R + "✗"}${Z}`);

  if (docs.length !== ATTENDU_DOCUMENTS || total !== ATTENDU_UNITES) {
    stop("\nLe périmètre ne correspond pas exactement à ce qui est attendu. "
       + "Rien n'est écrit. Arrêt.");
  }

  const aModifier = docs.filter((d) => (d.observation || "").trim() !== "");
  const dejaPropres = docs.length - aModifier.length;

  console.log(`\n${G}LES ${docs.length} DOCUMENTS CIBLÉS${Z}`);
  for (const d of docs) {
    const imprime = Number(d.print_count) > 0 || Boolean(d.printed_at);
    const etat = (d.observation || "").trim() === "" ? `${V}déjà vide${Z}` : `${R}à vider${Z}`;
    console.log(`  ${d.document_number.padEnd(16)} qté ${String(Number(d.quantite)).padStart(4)}`
      + `  ${imprime ? "imprimé" : "non imprimé"}  ${etat}`);
    if ((d.observation || "").trim() !== "") {
      console.log(`      observation actuelle : ${String(d.observation).slice(0, 90)}`
        + (String(d.observation).length > 90 ? "…" : ""));
    }
  }

  if (PREVIEW) {
    console.log(`\n${G}RÉSUMÉ${Z}`);
    console.log(`  documents ciblés         : ${docs.length}`);
    console.log(`  unités totales           : ${total}`);
    console.log(`  à vider                  : ${aModifier.length}`);
    console.log(`  déjà vides (idempotence) : ${dejaPropres}`);
    console.log(`  mouvements modifiés      : 0`);
    console.log(`  stock modifié            : 0`);
    console.log(`\n${V}Prévisualisation terminée. Rien n'a été écrit.${Z}`);
    console.log(`Pour appliquer : --apply --confirmer=${PHRASE}\n`);
    await pool.end();
    return;
  }

  /* ── APPLICATION ────────────────────────────────────────────────────── */
  const client = await pool.connect();
  let modifies = 0;
  let revisions = 0;
  try {
    await client.query("BEGIN");

    /* Verrou consultatif : deux lancements simultanés de ce script ne se
       marchent pas dessus, l'un attend la fin de l'autre puis ne trouve plus
       rien à faire — c'est ce que prouve le test de concurrence. */
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      ["retirer-observations-techniques", `${CIBLE.companyId}:${CIBLE.fileSha256}`]);

    const avantStock = await empreinteStock(client);

    /* Relu sous verrou : le monde a pu changer entre le calcul ci-dessus,
       hors transaction, et maintenant. */
    const ciblesVerrouilles = await documentsCibles(client);
    if (ciblesVerrouilles.length !== ATTENDU_DOCUMENTS
        || ciblesVerrouilles.reduce((s, d) => s + Number(d.quantite), 0) !== ATTENDU_UNITES) {
      throw new Error(`Le périmètre a changé entre la lecture et l'écriture `
        + `(${ciblesVerrouilles.length} documents, `
        + `${ciblesVerrouilles.reduce((s, d) => s + Number(d.quantite), 0)} unités). `
        + "Rien n'est modifié.");
    }

    for (const doc of ciblesVerrouilles) {
      /* Idempotence : un document déjà vide n'écrit ni révision ni mise à
         jour. Un second passage sur une base déjà nettoyée modifie donc
         zéro document et crée zéro nouvelle révision. */
      if ((doc.observation || "").trim() === "") continue;

      const { rows: lignes } = await client.query(
        `SELECT id, product_reference, product_name, quantity, unit_price, total_price
           FROM document_items WHERE document_id = $1 ORDER BY id`,
        [doc.id]);

      const contenuAvant = { items: lignes, observation: doc.observation };
      const contenuApres = { items: lignes, observation: "" };
      const imprime = Number(doc.print_count) > 0 || Boolean(doc.printed_at);
      const revision = Number(doc.document_revision || 0) + 1;

      /* L'historique s'écrit AVANT la mise à jour du document : si la suite
         échoue, la transaction annule les deux, jamais un contenu changé
         sans trace. */
      await client.query(
        `INSERT INTO document_content_revisions
           (company_id, document_id, revision, old_document_number, new_document_number,
            old_items, new_items, reason, was_printed, changed_by, changed_by_name)
         VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10)`,
        [doc.company_id, doc.id, revision, doc.document_number,
         JSON.stringify(contenuAvant), JSON.stringify(contenuApres),
         MOTIF, imprime, null, AUTEUR]);
      revisions += 1;

      await client.query(
        `UPDATE documents
            SET observation = '', document_revision = $1, updated_at = now()
          WHERE id = $2 AND cancelled_at IS NULL`,
        [revision, doc.id]);
      modifies += 1;

      console.log(`  ${doc.document_number} : observation vidée (révision ${revision})`);
    }

    /* Le contrôle qui rend l'opération sûre. */
    const apresStock = await empreinteStock(client);
    for (const cle of Object.keys(avantStock)) {
      if (String(avantStock[cle]) !== String(apresStock[cle])) {
        throw new Error(`Le stock a bougé (${cle} : ${avantStock[cle]} → ${apresStock[cle]}). `
          + "Cette opération ne doit toucher que documents.observation. Tout est annulé.");
      }
    }

    await client.query("COMMIT");
    console.log(`\n${V}TERMINÉ${Z}`);
    console.log(`  documents modifiés : ${modifies}`);
    console.log(`  déjà vides         : ${ciblesVerrouilles.length - modifies}`);
    console.log(`  révisions écrites  : ${revisions}`);
    console.log(`  ${V}stock, mouvements, produits et balances : inchangés, vérifiés avant COMMIT.${Z}\n`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n${R}ÉCHEC : ${e.message}${Z}`);
    console.error("Aucun document n'a été modifié, aucune révision écrite.\n");
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
