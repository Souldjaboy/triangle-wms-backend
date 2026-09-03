"use strict";

/**
 * LE JEU D'ESSAI QUI REPRODUIT LA PRODUCTION, IMPORT N°3.
 *
 *   DATABASE_URL=… node scripts/jeu-essai-import3-consolide.js
 *
 * Il recrée l'état constaté en production :
 *
 *   • un import n°3 « Copie de dernier actualisation bby me.xlsx », COMPLETED,
 *     portant l'empreinte réelle du classeur ;
 *   • 43 mouvements de type Sortie totalisant 12 193 unités, dont les sorties
 *     nouvelles CONSOLIDÉES par produit — un mouvement de 20 pour les trois
 *     sorties STADE 4 AOUT de 7, 7 et 6 ; un de 5 pour les deux
 *     PROFESSIONAL AMPLIFIER POWER de 2 et 3 ; un de 7 pour les deux
 *     AUDIO DEVISE de 6 et 1 ;
 *   • aucun événement dans `stock_import_movement_events` ;
 *   • les documents 126 à 130, dont DEUX bons actifs pour le mouvement
 *     TETE DE JACK — le doublon à traiter ;
 *   • du stock réel connu, pour prouver qu'il ne bouge pas.
 *
 * MAMBRANE n'a délibérément AUCUN mouvement : c'est le cas « événement sans
 * mouvement » qu'il faut savoir signaler sans rien inventer.
 *
 * Les index d'unicité sont retirés le temps de poser le doublon : la
 * production ne les a jamais reçus, et c'est précisément pour cela qu'elle a
 * pu écrire deux bons pour une même sortie.
 *
 * Chiffres de simulation. Aucune de ces valeurs n'est une décision du client.
 */

const { Pool } = require("pg");
const crypto = require("crypto");
const fs = require("fs");

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL manquant."); process.exit(1); }
if (/5432|prod|production/i.test(process.env.DATABASE_URL)) {
  console.error("Cette URL ressemble à une base de production. Refus."); process.exit(1);
}

const FICHIER = process.env.CLASSEUR_EM2S
  || `${process.env.HOME}/Downloads/administratif/Copie de dernier actualisation bby me.xlsx`;

/* L'empreinte RÉELLEMENT enregistrée en production pour l'import n°3. Le
   binaire qui la portait n'existe plus : le fichier encore disponible a le
   même contenu métier mais d'autres octets. Le jeu d'essai reproduit donc
   l'écart tel quel, sinon les garde-fous de version métier ne seraient
   jamais exercés.
   VERSION_METIER=0 rétablit l'empreinte du fichier, pour les essais qui
   veulent le cas nominal. */
const EMPREINTE_PRODUCTION =
  "61b7104201a146f27812c6b2603ee3b9dbc790879282b0c081d81e6379690e9e";
const ECART_EMPREINTE = process.env.VERSION_METIER !== "0";

/* Le résumé enregistré de l'import n°3, tel qu'il figure en production. */
const RESUME_IMPORT = {
  totalIn: 6073, totalOut: 12193, totalWriteOff: 3,
  stockBefore: 151244, stockAfter: 149840,
};
const LIGNES_IMPORT = { rows_read: 235, rows_imported: 200, rows_skipped: 5 };

/* Les sorties nouvelles, consolidées par produit — exactement ce que
   l'ancien chemin d'import a écrit. MAMBRANE (25) est absente à dessein. */
const CONSOLIDES = [
  ["PROFESSIONAL AMPLIFIER POWER", 5],       // 2 + 3
  ["AUDIO DEVISE", 7],                       // 6 + 1
  ["OFFICIENCY AMPLIFIER", 8],
  ["PROFESSIONAL SPEAKER (grand)", 8],
  ["POWER SEQUENCY", 7],
  ["STADE 4 AOUT", 20],                      // 7 + 7 + 6
  ["ROULEAU CABLE NOIR 30M", 2],
  ["MICRO BALADEUR BL X24", 8],
  ["PROCESSEUR NUMERIQUE", 6],
  ["MG 16XU", 2],
  ["TETE DE  JACK", 504],
  ["MICRO CONFERENCE", 2],
  ["MICROPHONE ST 9380", 1],
  ["HIGHT EFFICIENCY AMPLIFIER POWER", 6],
  ["FAUX PLAFOND D", 80],
  ["WALL LAMP", 48],
];

const TOTAL_SORTIES = 12193;
const NB_SORTIES = 43;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    /* La production n'a jamais reçu ces index : sans les retirer, on ne peut
       pas reproduire le doublon qu'elle porte. */
    await c.query(`DROP INDEX IF EXISTS documents_mouvement_actif_uidx`);
    await c.query(`DROP INDEX IF EXISTS documents_evenement_actif_uidx`);

    /* Reposable : les essais rejouent ce jeu plusieurs fois de suite. On
       repart d'une table propre plutôt que de buter sur l'import n°3 déjà
       présent. Base de TEST uniquement — les garde-fous du haut de fichier
       refusent toute URL qui ressemble à une production. */
    await c.query(`DELETE FROM document_items WHERE document_id IN
                     (SELECT id FROM documents WHERE stock_movement_id IS NOT NULL
                        OR stock_import_movement_event_id IS NOT NULL)`);
    await c.query(`DELETE FROM documents WHERE stock_movement_id IS NOT NULL
                     OR stock_import_movement_event_id IS NOT NULL`);
    await c.query(`DELETE FROM stock_import_movement_events`);
    await c.query(`DELETE FROM stock_movements`);
    await c.query(`DELETE FROM stock_location_balances`);
    await c.query(`DELETE FROM inventory_imports`);
    await c.query(`DELETE FROM stock_request_counters`);
    await c.query(`DELETE FROM locations`);
    await c.query(`DELETE FROM products`);

    const societe = (await c.query(`SELECT id FROM companies ORDER BY id LIMIT 1`)).rows[0].id;
    const sha = fs.existsSync(FICHIER)
      ? crypto.createHash("sha256").update(fs.readFileSync(FICHIER)).digest("hex")
      : crypto.createHash("sha256").update("classeur-absent").digest("hex");

    /* L'import porte le numéro 3, comme en production. */
    await c.query(`SELECT setval(pg_get_serial_sequence('inventory_imports','id'), 2, true)`);
    const imp = (await c.query(
      `INSERT INTO inventory_imports
         (company_id, file_name, file_hash, status, summary,
          rows_read, rows_imported, rows_skipped, created_at)
       VALUES ($1, 'Copie de dernier actualisation bby me.xlsx', $2, 'COMPLETED', $3,
               $4, $5, $6, '2026-09-02 05:59:45+00') RETURNING id`,
      [societe, ECART_EMPREINTE ? EMPREINTE_PRODUCTION : sha,
       JSON.stringify(RESUME_IMPORT),
       LIGNES_IMPORT.rows_read, LIGNES_IMPORT.rows_imported,
       LIGNES_IMPORT.rows_skipped])).rows[0].id;

    /* Du stock réel, qui devra rester au chiffre près. */
    const produits = {};
    for (const [nom, ref, stock] of [
      ["TETE DE  JACK", "REF-JACK", 3200],
      ["STADE 4 AOUT", "REF-STADE", 140],
      ["FAUX PLAFOND D", "REF-FPD", 900],
      ["WALL LAMP", "REF-LAMP", 260],
    ]) {
      produits[nom] = (await c.query(
        `INSERT INTO products (company_id, reference, name, stock, is_active, created_at)
         VALUES ($1,$2,$3,$4,true,now()) RETURNING id`, [societe, ref, nom, stock])).rows[0].id;
    }
    const emplacement = (await c.query(
      `INSERT INTO locations (company_id, warehouse_code, full_code, is_active, created_at)
       VALUES ($1,'D','D-A-01-01',true,now()) RETURNING id`, [societe])).rows[0].id;
    for (const [nom, quantite] of [["TETE DE  JACK", 3200], ["STADE 4 AOUT", 140]]) {
      await c.query(
        `INSERT INTO stock_location_balances (company_id, product_id, location_id, quantity)
         VALUES ($1,$2,$3,$4)`, [societe, produits[nom], emplacement, quantite]);
    }

    const mouvement = async (nom, quantite) => (await c.query(
      `INSERT INTO stock_movements
         (company_id, type, product_name, product_reference, quantity, status, import_id,
          created_by_name, created_at)
       VALUES ($1,'Sortie',$2,$3,$4,'Validé',$5,'Import EM2S','2026-09-02 05:59:45+00')
       RETURNING id`,
      [societe, nom, `REF-${nom.slice(0, 6).replace(/\s/g, "")}`, quantite, imp])).rows[0].id;

    const mouvements = {};
    let cumul = 0;
    for (const [nom, quantite] of CONSOLIDES) {
      mouvements[nom] = await mouvement(nom, quantite);
      cumul += quantite;
    }

    /* Le reste des 43 sorties : d'anciennes sorties, du même import, qui
       n'ont rien à faire dans les nouveaux bons. */
    const restant = NB_SORTIES - CONSOLIDES.length;
    const unites = TOTAL_SORTIES - cumul;
    const part = Math.floor(unites / restant);
    for (let i = 1; i <= restant; i += 1) {
      const q = i === restant ? unites - part * (restant - 1) : part;
      await mouvement(`ANCIEN ARTICLE ${String(i).padStart(2, "0")}`, q);
    }

    /* Les documents 126 à 130, tels qu'ils existent en production. */
    await c.query(`SELECT setval(pg_get_serial_sequence('documents','id'), 125, true)`);
    const document = async (numero, nom, quantite) => {
      const id = (await c.query(
        `INSERT INTO documents
           (company_id, document_type, document_number, stock_movement_id, observation,
            created_by, print_count, status, created_at)
         VALUES ($1,'Bon de sortie',$2,$3,$4,'Import EM2S',1,'Validé',now())
         RETURNING id`,
        [societe, numero, mouvements[nom],
         `Document généré depuis mouvement stock ID ${mouvements[nom]} - Sortie`])).rows[0].id;
      await c.query(
        `INSERT INTO document_items
           (document_id, product_reference, product_name, quantity, unit_price, total_price)
         VALUES ($1,$2,$3,$4,0,0)`, [id, `REF-${nom.slice(0, 6)}`, nom, quantite]);
      return id;
    };

    const d126 = await document("BS-260902-126", "STADE 4 AOUT", 20);   // quantité consolidée
    const d127 = await document("BS-260902-127", "AUDIO DEVISE", 7);    // quantité consolidée
    const d128 = await document("BS-260902-128", "FAUX PLAFOND D", 80); // quantité exacte
    const d129 = await document("BS-260902-129", "TETE DE  JACK", 504); // exacte
    const d130 = await document("BS-260902-130", "TETE DE  JACK", 504); // LE DOUBLON

    await c.query("COMMIT");

    console.log(JSON.stringify({
      societe, import_id: imp,
      empreinte_enregistree: (ECART_EMPREINTE ? EMPREINTE_PRODUCTION : sha).slice(0, 16) + "…",
      empreinte_fichier: sha.slice(0, 16) + "…",
      ecart_empreinte: ECART_EMPREINTE,
      mouvements_sortie: NB_SORTIES,
      total_unites: TOTAL_SORTIES,
      consolides: Object.fromEntries(
        Object.entries(mouvements).map(([n, id]) => [n, id])),
      documents: { d126, d127, d128, d129, d130 },
      doublon: "BS-260902-129 et BS-260902-130 sur le même mouvement TETE DE JACK",
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
