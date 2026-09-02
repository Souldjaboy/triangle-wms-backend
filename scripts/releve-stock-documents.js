"use strict";

/**
 * PHOTOGRAPHIE DES SIX TABLES QUI COMPTENT, POUR COMPARER AVANT ET APRÈS.
 *
 *   DATABASE_URL=… node scripts/releve-stock-documents.js > avant.json
 *   DATABASE_URL=… node scripts/releve-stock-documents.js > apres.json
 *   node scripts/releve-stock-documents.js --comparer avant.json apres.json
 *
 * Comparer deux relevés vaut mieux que relire des chiffres à l'œil : une
 * balance déplacée d'une unité se voit ici, pas dans une capture d'écran.
 */

const { Pool } = require("pg");
const fs = require("fs");

const args = process.argv.slice(2);

if (args[0] === "--comparer") {
  const a = JSON.parse(fs.readFileSync(args[1], "utf8"));
  const b = JSON.parse(fs.readFileSync(args[2], "utf8"));
  const V = "\x1b[32m", R = "\x1b[31m", Z = "\x1b[0m";
  let differences = 0;

  /* Les documents ONT le droit de changer : c'est l'objet de l'opération. Le
     stock, lui, n'en a aucun. Les deux familles sont donc jugées séparément. */
  const intouchables = ["products", "stock_movements", "stock_location_balances"];
  const attendus = ["documents", "document_items", "compteurs"];

  for (const cle of intouchables) {
    const identique = JSON.stringify(a[cle]) === JSON.stringify(b[cle]);
    console.log(`${identique ? V + "  IDENTIQUE" : R + "  MODIFIÉ  "}${Z}  ${cle}`);
    if (!identique) {
      differences += 1;
      console.log(`    avant : ${JSON.stringify(a[cle])}`);
      console.log(`    après : ${JSON.stringify(b[cle])}`);
    }
  }
  for (const cle of attendus) {
    const identique = JSON.stringify(a[cle]) === JSON.stringify(b[cle]);
    console.log(`  ${identique ? "inchangé " : "changé   "}   ${cle} (changement autorisé)`);
  }

  console.log(differences === 0
    ? `\n${V}Aucune donnée de stock n'a bougé.${Z}`
    : `\n${R}${differences} table(s) de stock ont bougé : c'est un échec.${Z}`);
  process.exit(differences === 0 ? 0 : 1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const q = async (sql) => (await pool.query(sql)).rows;
  const releve = {
    products: await q(
      `SELECT id, reference, name, stock FROM products ORDER BY id`),
    stock_movements: await q(
      `SELECT id, company_id, type, product_name, quantity, status, import_id
         FROM stock_movements ORDER BY id`),
    stock_location_balances: await q(
      `SELECT id, company_id, product_id, location_id, quantity, reserved_quantity
         FROM stock_location_balances ORDER BY id`),
    documents: await q(
      `SELECT id, company_id, document_type, document_number, stock_movement_id,
              print_count, cancelled_at IS NOT NULL AS annule, cancelled_by_name,
              cancellation_reason, replaced_by_document_id, replaces_document_id
         FROM documents ORDER BY id`),
    document_items: await q(
      `SELECT id, document_id, product_name, quantity FROM document_items ORDER BY id`),
    compteurs: await q(
      `SELECT company_id, year, prefix, last_seq FROM stock_request_counters
        ORDER BY company_id, prefix`),
  };
  console.log(JSON.stringify(releve, null, 1));
  await pool.end();
})();
