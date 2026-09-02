"use strict";

/**
 * LE JEU D'ESSAI DU CAS RÉEL, POSÉ EN BASE DE TEST.
 *
 *   DATABASE_URL=… node scripts/jeu-essai-bl-sortie.js
 *
 * Il reproduit exactement la situation du client :
 *
 *   • une ANCIENNE sortie de 20 (import de mars), qui doit rester dans
 *     l'historique et n'être jamais réutilisée ;
 *   • une NOUVELLE sortie de 10 (import de septembre) ;
 *   • un BON DE LIVRAISON incorrect émis depuis cette nouvelle sortie, et qui
 *     porte 30 sur le papier — le cumul 20 + 10 tel qu'il sortait à
 *     l'impression ;
 *   • du stock réel connu : products.stock et stock_location_balances, pour
 *     pouvoir prouver qu'ils ne bougent pas ;
 *   • un bon de réception sain, qui ne doit surtout pas être touché ;
 *   • une seconde société, pour vérifier l'isolation.
 *
 * Ce fichier ne sert qu'aux essais. Aucune de ces valeurs n'est une décision
 * du client : ce sont des chiffres de simulation.
 */

const { Pool } = require("pg");
const crypto = require("crypto");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant.");
  process.exit(1);
}
if (/5432|prod|production/i.test(process.env.DATABASE_URL)) {
  console.error("Cette URL ressemble à une base de production. Refus.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    const societes = (await c.query(
      `SELECT id, name FROM companies ORDER BY id LIMIT 2`)).rows;
    const TRIANGLE = societes[0].id;
    const FATMAT = societes[1] ? societes[1].id : TRIANGLE;

    const imports = {};
    for (const [cle, nom, societe] of [
      ["mars", "inventaire-mars-2026.xlsx", TRIANGLE],
      ["septembre", "inventaire-septembre-2026.xlsx", TRIANGLE],
      ["fatmat", "inventaire-fatmat-2026.xlsx", FATMAT],
    ]) {
      imports[cle] = (await c.query(
        `INSERT INTO inventory_imports (company_id, file_name, file_hash, status, created_at)
         VALUES ($1, $2, $3, 'done', now()) RETURNING id`,
        [societe, nom, crypto.createHash("sha256").update(nom).digest("hex")]
      )).rows[0].id;
    }

    /* Le stock réel : c'est lui qui ne doit pas bouger d'un gramme. */
    const ciment = (await c.query(
      `INSERT INTO products (company_id, reference, name, stock, unit, is_active, created_at)
       VALUES ($1, 'REF-CIM-425', 'CIMENT 42.5', 470, 'sac', true, now()) RETURNING id`,
      [TRIANGLE])).rows[0].id;
    const fer = (await c.query(
      `INSERT INTO products (company_id, reference, name, stock, unit, is_active, created_at)
       VALUES ($1, 'REF-FER-12', 'FER A BETON 12', 1250, 'barre', true, now()) RETURNING id`,
      [TRIANGLE])).rows[0].id;

    const emplacement = (await c.query(
      `INSERT INTO locations (company_id, warehouse_code, zone, rayon, full_code, is_active, created_at)
       VALUES ($1, 'D', 'D', 'A', 'D-A-01-01', true, now()) RETURNING id`,
      [TRIANGLE])).rows[0].id;

    for (const [produit, quantite] of [[ciment, 470], [fer, 1250]]) {
      await c.query(
        `INSERT INTO stock_location_balances (company_id, product_id, location_id, quantity)
         VALUES ($1, $2, $3, $4)`,
        [TRIANGLE, produit, emplacement, quantite]);
    }

    const mouvement = async (societe, type, quantite, nom, reference, importId) =>
      (await c.query(
        `INSERT INTO stock_movements
           (company_id, type, product_name, product_reference, quantity, status,
            import_id, created_by_name, created_at)
         VALUES ($1, $2, $3, $4, $5, 'Validé', $6, 'Import EM2S', now()) RETURNING id`,
        [societe, type, nom, reference, quantite, importId])).rows[0].id;

    const ANCIENNE_SORTIE = await mouvement(
      TRIANGLE, "Sortie", 20, "CIMENT 42.5", "REF-CIM-425", imports.mars);
    const NOUVELLE_SORTIE = await mouvement(
      TRIANGLE, "Sortie", 10, "CIMENT 42.5", "REF-CIM-425", imports.septembre);
    const ENTREE_SAINE = await mouvement(
      TRIANGLE, "Entrée", 300, "FER A BETON 12", "REF-FER-12", imports.septembre);
    const SORTIE_FATMAT = await mouvement(
      FATMAT, "Sortie", 8, "GRAVIER 15/25", "REF-GRA-1525", imports.fatmat);

    const document = async (societe, type, numero, mouvementId, lignes, extra = {}) => {
      const id = (await c.query(
        `INSERT INTO documents
           (company_id, document_type, document_number, stock_movement_id,
            observation, created_by, print_count, printed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'Import EM2S', $6, $7, now()) RETURNING id`,
        [societe, type, numero, mouvementId,
         `Document généré depuis mouvement stock ID ${mouvementId}`,
         extra.print_count || 0, extra.printed_at || null])).rows[0].id;
      for (const l of lignes) {
        await c.query(
          `INSERT INTO document_items
             (document_id, product_reference, product_name, quantity, unit_price, total_price)
           VALUES ($1, $2, $3, $4, 0, 0)`,
          [id, l.reference, l.nom, l.quantite]);
      }
      return id;
    };

    /* LE DOCUMENT FAUTIF : un bon de livraison né d'une sortie de stock, et
       qui porte 30 — l'ancienne sortie de 20 additionnée à la nouvelle de 10. */
    const BL_INCORRECT = await document(
      TRIANGLE, "Bon de livraison", "BL-260902-001", NOUVELLE_SORTIE,
      [{ reference: "REF-CIM-425", nom: "CIMENT 42.5", quantite: 30 }],
      { print_count: 1, printed_at: new Date().toISOString() });

    /* Un bon sain : il ne doit pas être effleuré. */
    const BR_SAIN = await document(
      TRIANGLE, "Bon de réception", "BR-260902-001", ENTREE_SAINE,
      [{ reference: "REF-FER-12", nom: "FER A BETON 12", quantite: 300 }]);

    /* Une autre société, pour vérifier que la correction ne déborde pas. */
    const BL_FATMAT = await document(
      FATMAT, "Bon de livraison", "BL-260902-002", SORTIE_FATMAT,
      [{ reference: "REF-GRA-1525", nom: "GRAVIER 15/25", quantite: 8 }]);

    await c.query("COMMIT");

    console.log(JSON.stringify({
      societes: { TRIANGLE, FATMAT },
      imports,
      produits: { ciment, fer },
      emplacement,
      mouvements: { ANCIENNE_SORTIE, NOUVELLE_SORTIE, ENTREE_SAINE, SORTIE_FATMAT },
      documents: { BL_INCORRECT, BR_SAIN, BL_FATMAT },
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
