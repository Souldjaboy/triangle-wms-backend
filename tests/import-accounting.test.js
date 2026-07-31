"use strict";
/* Test d'intégration comptable (DB requise). Skippé sans DATABASE_URL. */
const assert = require("assert");
require("dotenv").config();

if (!process.env.DATABASE_URL) { console.log("⏭  import-accounting: DATABASE_URL absente, test ignoré."); process.exit(0); }

const { Pool } = require("pg");
const { executeAccounting, simulateAccounting, reverseAccounting } = require("../import-center/executor-accounting");
const closure = require("../import-center/closure");

// Helpers comptables minimaux (mêmes tables que server.js).
async function nextAccountingNumber(client, table, column, prefix, companyId) {
  const { rows } = await client.query(`SELECT COUNT(*)::int n FROM ${table} WHERE company_id=$1`, [companyId]);
  return `${prefix}-${companyId}-${rows[0].n + 1}-${Date.now().toString(36)}`;
}
async function createAccountingEntry(client, { companyId, sourceType, sourceId, accountLabel, debit = 0, credit = 0, description = "", createdBy = null }) {
  const num = await nextAccountingNumber(client, "accounting_entries", "entry_number", "ECR", companyId);
  await client.query(
    `INSERT INTO accounting_entries (company_id, entry_number, source_type, source_id, account_label, debit, credit, description, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [companyId, num, sourceType, sourceId, accountLabel, Number(debit), Number(credit), description, createdBy]
  );
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const CO = 999999; // entreprise de test isolée
  const helpers = { nextAccountingNumber, createAccountingEntry, isPeriodClosed: closure.isPeriodClosed };
  let passed = 0;
  const test = (n, c) => { assert.ok(c, n); passed++; console.log("  ✓ " + n); };

  async function clean() {
    await pool.query("DELETE FROM accounting_transactions WHERE company_id=$1", [CO]);
    await pool.query("DELETE FROM accounting_entries WHERE company_id=$1", [CO]);
    await pool.query("DELETE FROM accounting_period_closures WHERE company_id=$1", [CO]);
    await pool.query("DELETE FROM treasury_accounts WHERE company_id=$1", [CO]);
  }

  try {
    await clean();
    console.log("Import comptabilité (intégration)");

    const expenseProfile = { key: "triangle.expenses", module_key: "comptabilite" };
    const incomeProfile = { key: "triangle.income", module_key: "comptabilite" };
    const expRows = [
      { __row: 2, status: "new", mapped: { transaction_date: "2026-07-05", expense_amount: 12000, description: "Carburant" } },
      { __row: 3, status: "new", mapped: { transaction_date: "2026-07-06", expense_amount: 3500, description: "Fournitures" } },
    ];
    const incRows = [{ __row: 2, status: "new", mapped: { transaction_date: "2026-07-05", income_amount: 50000, description: "Vente" } }];

    // Simulation (aucune écriture).
    const sim = await simulateAccounting(pool, CO, expenseProfile, expRows);
    test("simulation: total dépense 15500, trésorerie après -15500", sim.totals.totalExpense === 15500 && sim.totals.treasuryAfter === -15500);
    const txBefore = (await pool.query("SELECT count(*)::int n FROM accounting_transactions WHERE company_id=$1", [CO])).rows[0].n;
    test("simulation n'écrit rien", txBefore === 0);

    // Exécution dépenses + recettes.
    const rExp = await executeAccounting(pool, CO, 1, expenseProfile, expRows, {}, helpers);
    const rInc = await executeAccounting(pool, CO, 1, incomeProfile, incRows, {}, helpers);
    test("exécution: 2 dépenses + 1 recette", rExp.report.imported === 2 && rInc.report.imported === 1);

    const bal = Number((await pool.query("SELECT current_balance FROM treasury_accounts WHERE company_id=$1", [CO])).rows[0].current_balance);
    test("trésorerie = 50000 - 15500 = 34500", bal === 34500);
    const ent = (await pool.query("SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM accounting_entries WHERE company_id=$1", [CO])).rows[0];
    test("partie double équilibrée (débit = crédit)", Number(ent.d) === Number(ent.c) && Number(ent.d) > 0);

    // Clôture.
    const snap = await closure.computeClosure(pool, CO, 2026, 7);
    test("clôture: income 50000, expense 15500, closing 34500", snap.total_income === 50000 && snap.total_expense === 15500 && snap.closing_balance === 34500);
    await closure.closePeriod(pool, CO, 1, 2026, 7);
    const isClosed = await closure.isPeriodClosed(pool, CO, "2026-07-10");
    test("période 07/2026 clôturée", isClosed === true);

    // Import bloqué en période clôturée.
    const blocked = await executeAccounting(pool, CO, 1, expenseProfile, [{ __row: 9, status: "new", mapped: { transaction_date: "2026-07-15", expense_amount: 1000 } }], {}, helpers);
    test("import refusé en période clôturée (failed=1, imported=0)", blocked.report.failed === 1 && blocked.report.imported === 0);

    // Réouverture.
    const reopened = await closure.reopenPeriod(pool, CO, 1, 2026, 7);
    test("réouverture OK", reopened && reopened.status === "open");

    // Rollback comptable (contrepassation, jamais de suppression).
    const revRows = rExp.rowResults.filter((r) => r.status === "imported").map((r, i) => ({ row_index: 100 + i, result_ref: r.result_ref }));
    // besoin d'un import_job réel pour rollback : on simule un job minimal
    const job = (await pool.query(
      `INSERT INTO import_jobs (job_uid, company_id, product_code, module_key, import_type, status, created_by)
       VALUES ($1,$2,'triangle','comptabilite','triangle.expenses','imported',1) RETURNING id`,
      ["test-" + Date.now(), CO]
    )).rows[0];
    for (const rr of revRows) await pool.query(`INSERT INTO import_rows (job_id, company_id, row_index, raw, status, result_ref) VALUES ($1,$2,$3,'{}','imported',$4)`, [job.id, CO, rr.row_index, JSON.stringify(rr.result_ref)]);
    const rb = await reverseAccounting(pool, CO, 1, job, revRows, helpers);
    test("rollback = contrepassation (2 dépenses inversées)", rb.reverted === 2 && rb.detail.counter_transactions === 2);
    const balAfter = Number((await pool.query("SELECT current_balance FROM treasury_accounts WHERE company_id=$1", [CO])).rows[0].current_balance);
    test("trésorerie après contrepassation = 34500 + 15500 = 50000", balAfter === 50000);
    const entAfter = (await pool.query("SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM accounting_entries WHERE company_id=$1", [CO])).rows[0];
    test("écritures toujours équilibrées après rollback", Number(entAfter.d) === Number(entAfter.c));

    await clean();
    await pool.query("DELETE FROM import_rows WHERE company_id=$1", [CO]);
    await pool.query("DELETE FROM import_jobs WHERE company_id=$1", [CO]);
    console.log(`\n✅ ${passed} tests import-comptabilité passés.`);
    await pool.end();
  } catch (e) {
    console.error("❌ ", e.message);
    await clean().catch(() => {});
    await pool.end();
    process.exit(1);
  }
})();
