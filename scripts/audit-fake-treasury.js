"use strict";
/*
 * AUDIT (lecture seule) de la trésorerie d'une entreprise.
 * Ne modifie RIEN. Liste toutes les lignes qui composent le solde et signale
 * les lignes potentiellement fictives (test/demo) pour décision humaine.
 *
 *   node scripts/audit-fake-treasury.js --company-id=<id>
 */
require("dotenv").config();
const { Pool } = require("pg");

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v === undefined ? true : v]; }));
const companyId = Number(args["company-id"]);
const SUSPECT = /(test|demo|démo|fictif|essai|exemple|sample|xxx|aaa|toto)/i;

async function main() {
  if (!companyId) { console.error("Usage: --company-id=<id>"); process.exit(2); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const co = (await pool.query("SELECT id, name FROM companies WHERE id=$1", [companyId])).rows[0];
  if (!co) { console.error(`Entreprise ${companyId} introuvable.`); await pool.end(); process.exit(3); }
  console.log(`\n=== AUDIT TRÉSORERIE (lecture seule) — ${co.name} (#${companyId}) ===`);

  const tre = (await pool.query("SELECT id, currency, initial_balance, current_balance FROM treasury_accounts WHERE company_id=$1", [companyId])).rows;
  console.log("\nComptes de trésorerie :");
  tre.forEach((t) => console.log(`  #${t.id} ${t.currency} initial=${t.initial_balance} current=${t.current_balance}`));

  const tx = (await pool.query(
    `SELECT id, company_id, created_at, description, amount, direction, status, source_type, source_id, created_by
       FROM accounting_transactions WHERE company_id=$1 ORDER BY created_at`, [companyId]
  )).rows;

  let income = 0, expense = 0, suspectIncome = 0, suspectExpense = 0;
  const suspects = [];
  for (const t of tx) {
    const amt = Number(t.amount) || 0;
    const isIn = t.direction === "entrée";
    if (isIn) income += amt; else expense += amt;
    const suspect = SUSPECT.test(String(t.description || "")) || (!t.source_type && !t.created_by);
    if (suspect) { suspects.push(t); if (isIn) suspectIncome += amt; else suspectExpense += amt; }
  }

  console.log(`\nTransactions : ${tx.length} | entrées=${income} | sorties=${expense} | solde théorique=${income - expense}`);
  console.log(`\nLignes SUSPECTES (test/démo) : ${suspects.length} | entrées=${suspectIncome} | sorties=${suspectExpense}`);
  console.log("  (table | id | company_id | date | libellé | montant | sens | statut | source | created_by)");
  for (const s of suspects.slice(0, 200)) {
    console.log(`  accounting_transactions | ${s.id} | ${s.company_id} | ${String(s.created_at).slice(0, 10)} | ${String(s.description || "").slice(0, 40)} | ${s.amount} | ${s.direction} | ${s.status} | ${s.source_type || "—"} | ${s.created_by || "—"}`);
  }
  console.log(`\nℹ️  Ce script ne modifie rien. Pour nettoyer : scripts/cleanup-fake-treasury.js (dry-run puis apply).`);
  await pool.end();
}
main().catch((e) => { console.error("ERREUR:", e.message); process.exit(1); });
