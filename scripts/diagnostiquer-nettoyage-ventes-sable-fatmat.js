"use strict";

/**
 * Diagnostic STRICTEMENT EN LECTURE SEULE avant le retrait des ventes test
 * de sable FAT & MAT. Ce script ne supprime, n'annule et ne modifie rien.
 *
 * DATABASE_URL=... node scripts/diagnostiquer-nettoyage-ventes-sable-fatmat.js --preview
 */

const { Pool } = require("pg");

if (!process.argv.includes("--preview") || process.argv.includes("--apply")) {
  console.error("Mode autorisé : --preview uniquement.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'");

    const companies = (await client.query(
      `SELECT id, name FROM companies
        WHERE name ILIKE '%FAT%' AND name ILIKE '%MAT%' ORDER BY id`
    )).rows;
    if (companies.length !== 1) {
      throw new Error(`FAT & MAT doit correspondre à une seule société (trouvé : ${companies.length}).`);
    }
    const company = companies[0];

    const sales = (await client.query(
      `SELECT s.id, s.sale_number, s.sale_date, s.status, s.customer_name,
              s.quantity_m3, s.total_amount,
              i.id AS invoice_id, i.invoice_number, i.status AS invoice_status,
              d.id AS delivery_id, d.delivery_number, CASE WHEN d.cancelled_at IS NOT NULL THEN 'ANNULE' ELSE 'ACTIF' END AS delivery_status,
              COALESCE(p.payment_count,0)::int AS payment_count,
              COALESCE(p.paid_amount,0)::numeric AS paid_amount
         FROM sand_sales s
         LEFT JOIN sand_invoices i ON i.sale_id=s.id AND i.company_id=s.company_id
         LEFT JOIN sand_deliveries d ON d.sale_id=s.id AND d.company_id=s.company_id
         LEFT JOIN LATERAL (
           SELECT count(*) AS payment_count, COALESCE(sum(sp.amount),0) AS paid_amount
             FROM sand_payments sp
            WHERE sp.company_id=s.company_id AND sp.invoice_id=i.id
         ) p ON true
        WHERE s.company_id=$1
        ORDER BY s.id`, [company.id]
    )).rows;

    const treasury = (await client.query(
      `SELECT id, initial_balance, current_balance, updated_at
         FROM treasury_accounts WHERE company_id=$1 ORDER BY id`, [company.id]
    )).rows;

    const accounting = (await client.query(
      `SELECT id, transaction_number, transaction_type, amount, direction,
              category, description, source_type, source_id, operation_date, status
         FROM accounting_transactions
        WHERE company_id=$1
          AND (source_type ILIKE '%sand%' OR transaction_type ILIKE '%sable%'
               OR category ILIKE '%sable%' OR description ILIKE '%sable%'
               OR amount IN (555000,570000))
        ORDER BY id`, [company.id]
    )).rows;

    const foreignKeys = (await client.query(
      `SELECT conrelid::regclass::text AS dependent_table,
              pg_get_constraintdef(oid) AS constraint_definition
         FROM pg_constraint
        WHERE contype='f'
          AND confrelid IN ('sand_sales'::regclass, 'sand_invoices'::regclass,
                            'sand_deliveries'::regclass, 'sand_payments'::regclass)
        ORDER BY 1,2`
    )).rows;

    const historicalImports = (await client.query(
      `SELECT company_id, import_key, status, file_name, applied_at
         FROM accounting_historical_imports
        WHERE company_id=$1 ORDER BY id`, [company.id]
    )).rows;

    const summary = {
      company,
      sales_count: sales.length,
      active_sales: sales.filter((s) => !["ANNULEE", "REMPLACEE"].includes(String(s.status).toUpperCase())).length,
      sales_total: sales.reduce((n, s) => n + Number(s.total_amount || 0), 0),
      paid_total: sales.reduce((n, s) => n + Number(s.paid_amount || 0), 0),
      treasury,
      matching_accounting_transactions: accounting,
      protected_excel_imports: historicalImports,
      foreign_keys: foreignKeys,
      sales,
    };
    console.log("DIAGNOSTIC NETTOYAGE VENTES SABLE FAT & MAT — LECTURE SEULE");
    console.log(JSON.stringify(summary, null, 2));
    console.log("\nAucune écriture effectuée. Ne lancez aucun nettoyage avant validation de ce résultat.");
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`ARRÊT : ${error.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
