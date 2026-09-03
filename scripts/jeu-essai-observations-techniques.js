"use strict";

/**
 * LE JEU D'ESSAI DE L'ÉTAT SALE RÉEL — 21 BONS AVEC OBSERVATION TECHNIQUE.
 *
 *   DATABASE_URL=… node scripts/jeu-essai-observations-techniques.js
 *
 * Reproduit exactement ce que la production porte aujourd'hui : 21 documents
 * actifs, rattachés à leurs événements (société 1, empreinte 61b710…), dont
 * `observation` contient le texte technique que l'ancienne version de
 * `reconstruire-sorties-rouge-fonce.js` écrivait — nom de fichier, feuille,
 * ligne, cellule, et pour certains la mention « VERSION MÉTIER VALIDÉE » avec
 * les deux empreintes.
 *
 * Il pose aussi, à dessein, ce qui NE doit JAMAIS être touché par le script de
 * nettoyage :
 *
 *   • un document de la société 1, rattaché à un événement d'un AUTRE import
 *     (autre empreinte) — même société, mauvais périmètre ;
 *   • un document d'une AUTRE société (2), rattaché à un événement qui porte
 *     la MÊME empreinte que la cible — bon fichier, mauvaise société ;
 *   • un document ANNULÉ parmi les événements de la cible — il ne doit ni
 *     compter dans les 21 actifs, ni être modifié.
 *
 * Trois états d'impression sont couverts sur les 21 cibles : imprimé par
 * `print_count`, imprimé par `printed_at`, et jamais imprimé — pour que le
 * script les marque tous correctement dans `was_printed`.
 *
 * Chiffres de simulation. Aucune de ces valeurs n'est une décision du client.
 */

const { Pool } = require("pg");
const crypto = require("crypto");

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL manquant."); process.exit(1); }
if (/5432|prod|production/i.test(process.env.DATABASE_URL)) {
  console.error("Cette URL ressemble à une base de production. Refus."); process.exit(1);
}

const CIBLE_SHA = "61b7104201a146f27812c6b2603ee3b9dbc790879282b0c081d81e6379690e9e";
const AUTRE_IMPORT_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/* Les 21 lignes certifiées — même liste que le relevé du classeur, reprise
   ici pour que la somme fasse exactement 739 sur exactement 21 lignes. */
const LIGNES_CERTIFIEES = [
  [167, "M167", "PROFESSIONAL AMPLIFIER POWER", 2, "2026-07-29"],
  [171, "M171", "AUDIO DEVISE", 6, "2026-07-20"],
  [175, "M175", "EFFICIENCY AMPLIFIER", 8, "2026-07-27"],
  [196, "M196", "PROFESSIONAL SPEAKER (grand)", 8, "2026-07-20"],
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

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Le texte technique que l'ancien script écrivait — reproduit à l'identique. */
function observationSale(ligne, cellule, produit, avecVersionMetier) {
  let s = `Sortie EM2S — Copie de dernier actualisation bby me.xlsx · feuille LISTE DES STOCK`
    + ` · ligne ${ligne} · cellule ${cellule} · rouge foncé C00000`;
  if (avecVersionMetier) {
    s += ` · VERSION MÉTIER VALIDÉE (empreinte import 61b7104201a1…,`
       + ` fichier relu 2ceb0871526e…) — Binaire d'origine indisponible ;`
       + ` version métier identique validée ligne à ligne.`;
  }
  return s;
}

async function main() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    /* Base propre : ce jeu se rejoue plusieurs fois de suite dans une suite
       de tests. */
    await c.query(`DELETE FROM document_content_revisions`);
    await c.query(`DELETE FROM document_items`);
    await c.query(`DELETE FROM documents`);
    await c.query(`DELETE FROM stock_import_movement_events`);
    await c.query(`DELETE FROM stock_movements`);
    await c.query(`DELETE FROM stock_location_balances`);
    await c.query(`DELETE FROM inventory_imports`);
    await c.query(`DELETE FROM stock_request_counters`);
    await c.query(`DELETE FROM locations`);
    await c.query(`DELETE FROM products`);

    const societes = (await c.query(`SELECT id FROM companies ORDER BY id LIMIT 2`)).rows;
    const S1 = societes[0].id;
    const S2 = societes[1] ? societes[1].id : S1;

    /* Du stock réel, pour que « rien n'a bougé » veuille dire quelque chose. */
    const produit = (await c.query(
      `INSERT INTO products (company_id, reference, name, stock, is_active, created_at)
       VALUES ($1, 'REF-CTRL', 'ARTICLE DE CONTROLE', 500, true, now()) RETURNING id`,
      [S1])).rows[0].id;
    const emplacement = (await c.query(
      `INSERT INTO locations (company_id, warehouse_code, full_code, is_active, created_at)
       VALUES ($1, 'D', 'D-A-01-01', true, now()) RETURNING id`, [S1])).rows[0].id;
    await c.query(
      `INSERT INTO stock_location_balances (company_id, product_id, location_id, quantity)
       VALUES ($1, $2, $3, 500)`, [S1, produit, emplacement]);
    const mvtControle = (await c.query(
      `INSERT INTO stock_movements
         (company_id, type, product_name, product_reference, quantity, status, created_by_name, created_at)
       VALUES ($1, 'Sortie', 'ARTICLE DE CONTROLE', 'REF-CTRL', 10, 'Validé', 'Essai', now())
       RETURNING id`, [S1])).rows[0].id;

    const imp = (await c.query(
      `INSERT INTO inventory_imports (company_id, file_name, file_hash, status, created_at)
       VALUES ($1, 'Copie de dernier actualisation bby me.xlsx', $2, 'COMPLETED', now())
       RETURNING id`, [S1, CIBLE_SHA])).rows[0].id;

    const document = async (societe, numero, obs, extra = {}) => {
      const d = (await c.query(
        `INSERT INTO documents
           (company_id, document_type, document_number, observation, created_by,
            print_count, printed_at, cancelled_at, status, created_at)
         VALUES ($1,'Bon de sortie',$2,$3,'Import EM2S',$4,$5,$6,'Validé',now())
         RETURNING id`,
        [societe, numero, obs, extra.printCount || 0, extra.printedAt || null,
         extra.cancelledAt || null])).rows[0].id;
      await c.query(
        `INSERT INTO document_items
           (document_id, product_reference, product_name, quantity, unit_price, total_price)
         VALUES ($1, $2, $3, $4, 0, 0)`,
        [d, extra.reference || "REF-X", extra.produit || "Produit", extra.quantite || 1]);
      return d;
    };

    const evenement = async (societe, sha, ligne, cellule, quantite, date, docId) =>
      (await c.query(
        `INSERT INTO stock_import_movement_events
           (company_id, batch_id, file_sha256, excel_sheet, excel_row, excel_cell,
            event_key, direction, effective_date, event_sequence, quantity,
            source_context, status)
         VALUES ($1,NULL,$2,'LISTE DES STOCK',$3,$4,$5,'OUT',$6,1,$7,$8,'IMPORTED')
         RETURNING id`,
        [societe, sha, ligne, cellule, `ESSAI:${sha.slice(0, 8)}:${ligne}:${crypto.randomUUID()}`,
         date, quantite,
         JSON.stringify({ produit: "essai", couleur: "C00000", import_id: imp,
           empreinte_import: sha, empreinte_fichier_relu: "2ceb0871526eb452a003fdab0852c2881892e131cfbd41974242b9a737f5bc42" })]))
        .rows[0].id;

    /* Les 21 documents cibles. Trois états d'impression, répartis sur les
       trois premiers ; le reste n'a jamais été imprimé. */
    const cibles = [];
    for (let i = 0; i < LIGNES_CERTIFIEES.length; i += 1) {
      const [ligne, cellule, produitNom, quantite, date] = LIGNES_CERTIFIEES[i];
      const extra = i === 0 ? { printCount: 2, printedAt: new Date().toISOString() }
        : i === 1 ? { printCount: 0, printedAt: new Date().toISOString() }
        : i === 2 ? { printCount: 1, printedAt: null }
        : {};
      const numero = `BS-260902-${String(126 + i).padStart(3, "0")}`;
      const obs = observationSale(ligne, cellule, produitNom, i % 3 === 0);
      const docId = await document(S1, numero, obs,
        { ...extra, produit: produitNom, quantite, reference: `REF-${i}` });
      const evtId = await evenement(S1, CIBLE_SHA, ligne, cellule, quantite, date, docId);
      await c.query(`UPDATE documents SET stock_import_movement_event_id = $1 WHERE id = $2`,
        [evtId, docId]);
      cibles.push({ docId, evtId, numero });
    }

    /* Un document ANNULÉ dans le même périmètre : ne doit ni compter dans les
       21 actifs, ni être touché. */
    const docAnnule = await document(S1, "BS-260902-999",
      observationSale(999, "M999", "ARTICLE ANNULE", true),
      { cancelledAt: new Date().toISOString(), produit: "ARTICLE ANNULE", quantite: 1 });
    const evtAnnule = await evenement(S1, CIBLE_SHA, 999, "M999", 1, "2026-08-01", docAnnule);
    await c.query(`UPDATE documents SET stock_import_movement_event_id = $1 WHERE id = $2`,
      [evtAnnule, docAnnule]);

    /* Un document de la MÊME société, mais d'un AUTRE import : mauvais
       périmètre, ne doit pas être touché. */
    const docAutreImport = await document(S1, "BS-AUTRE-IMPORT-001",
      observationSale(1, "M1", "ARTICLE AUTRE IMPORT", false),
      { produit: "ARTICLE AUTRE IMPORT", quantite: 5 });
    const evtAutreImport = await evenement(S1, AUTRE_IMPORT_SHA, 1, "M1", 5, "2026-06-01", docAutreImport);
    await c.query(`UPDATE documents SET stock_import_movement_event_id = $1 WHERE id = $2`,
      [evtAutreImport, docAutreImport]);

    /* Un document d'une AUTRE société, sur la MÊME empreinte que la cible :
       mauvaise société, ne doit pas être touché. */
    const docAutreSociete = await document(S2, "BS-AUTRE-SOCIETE-001",
      observationSale(1, "M1", "ARTICLE AUTRE SOCIETE", true),
      { produit: "ARTICLE AUTRE SOCIETE", quantite: 9 });
    const evtAutreSociete = await evenement(S2, CIBLE_SHA, 1, "M1", 9, "2026-06-01", docAutreSociete);
    await c.query(`UPDATE documents SET stock_import_movement_event_id = $1 WHERE id = $2`,
      [evtAutreSociete, docAutreSociete]);

    /* Un document de la cible sans le moindre lien à un événement (saisie
       manuelle) : ne doit jamais être ramené par la requête du script. */
    const docSansEvenement = await document(S1, "BS-SANS-EVENEMENT-001",
      "Document généré depuis mouvement stock ID 999 - Sortie",
      { produit: "ARTICLE MANUEL", quantite: 3 });

    await c.query("COMMIT");

    console.log(JSON.stringify({
      societes: { S1, S2 },
      import_id: imp,
      documents_cibles: cibles.length,
      total_unites_cibles: LIGNES_CERTIFIEES.reduce((s, l) => s + l[3], 0),
      controles: { docAnnule, docAutreImport, docAutreSociete, docSansEvenement, mvtControle },
    }, null, 2));
  } catch (e) {
    await c.query("ROLLBACK");
    console.error("ÉCHEC :", e.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

main();
