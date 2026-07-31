"use strict";
/* Durcissement production : anti-doublons persistant, import incrémental,
   clôture sécurisée, saisie manuelle équilibrée. DB requise. */
const assert = require("assert");
require("dotenv").config();
if (!process.env.DATABASE_URL) { console.log("⏭  import-prod: DATABASE_URL absente, ignoré."); process.exit(0); }

const { Pool } = require("pg");
const ic = require("../import-center");
const { validateRows, fingerprint } = require("../import-center/validator");
const closure = require("../import-center/closure");
const { executeCashbook } = require("../import-center/executor-cashbook");

async function nextAccountingNumber(client, table, col, prefix, cid) {
  const { rows } = await client.query(`SELECT COUNT(*)::int n FROM ${table} WHERE company_id=$1`, [cid]);
  return `${prefix}-${cid}-${rows[0].n + 1}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}
async function createAccountingEntry(client, { companyId, sourceType, sourceId, accountLabel, debit = 0, credit = 0, description = "", createdBy = null }) {
  const num = await nextAccountingNumber(client, "accounting_entries", "entry_number", "ECR", companyId);
  await client.query(`INSERT INTO accounting_entries (company_id, entry_number, source_type, source_id, account_label, debit, credit, description, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [companyId, num, sourceType, sourceId, accountLabel, Number(debit), Number(credit), description, createdBy]);
}
const helpers = { nextAccountingNumber, createAccountingEntry, isPeriodClosed: async () => false };
const CO = 1;

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let passed = 0;
  const test = (n, c) => { assert.ok(c, n); passed++; console.log("  ✓ " + n); };
  const clean = async () => {
    await pool.query("DELETE FROM accounting_transactions WHERE company_id=$1 AND description LIKE 'PROD %'", [CO]).catch(() => {});
    await pool.query("DELETE FROM accounting_entries WHERE company_id=$1 AND description IN ('PRODUNBAL')", [CO]).catch(() => {});
    await pool.query("DELETE FROM accounting_period_closures WHERE company_id=$1 AND period_year=2099", [CO]).catch(() => {});
  };
  try {
    await clean();
    console.log("Import — durcissement production");

    // 1) ANTI-DOUBLONS PERSISTANT / INCRÉMENTAL
    const profile = ic.registry.getProfile("triangle.tresorerie");
    const items = [
      { __row: 3, mapped: { op_date: "2026-05-18", libelle: "PROD reception", income: 3000000, expense: 0 } },
      { __row: 4, mapped: { op_date: "2026-05-19", libelle: "PROD paiement", income: 0, expense: 200000 } },
    ];
    const firstPass = validateRows(items, profile, CO, {});
    test("1er passage : 2 nouvelles lignes", firstPass.summary.new === 2 && firstPass.summary.existing === 0);
    // Simule que ces empreintes sont déjà importées.
    const already = new Set(firstPass.rows.map((r) => r.fingerprint));
    const secondPass = validateRows(items, profile, CO, { existingFingerprints: already });
    test("2e passage (même fichier) : 0 nouvelle, 2 déjà importées", secondPass.summary.new === 0 && secondPass.summary.existing === 2);
    test("2e passage : lignes marquées duplicate", secondPass.rows.every((r) => r.status === "duplicate"));
    // Import incrémental : une ligne nouvelle + les 2 anciennes -> seule la nouvelle passe.
    const incr = validateRows([...items, { __row: 5, mapped: { op_date: "2026-05-20", libelle: "PROD nouveau", income: 500000, expense: 0 } }], profile, CO, { existingFingerprints: already });
    test("import incrémental : 1 seule nouvelle ligne", incr.summary.new === 1 && incr.summary.existing === 2);

    // 2) CLÔTURE SÉCURISÉE — écriture déséquilibrée bloque.
    // Insère une écriture déséquilibrée sur 2099-01.
    const cx = await pool.connect();
    try {
      await cx.query(`INSERT INTO accounting_entries (company_id, entry_number, account_label, debit, credit, description, created_at) VALUES ($1,'UNBAL-1','Test',1000,0,'PRODUNBAL', '2099-01-15')`, [CO]);
    } finally { cx.release(); }
    const snap = await closure.computeClosure(pool, CO, 2099, 1);
    test("clôture : déséquilibre détecté (débit 1000 ≠ crédit 0)", snap.unbalanced === true && snap.can_close === false);
    test("clôture : anomalie listée", snap.anomalies.some((a) => /déséquilibr/i.test(a)));
    let blocked = false;
    try { await closure.closePeriod(pool, CO, 1, 2099, 1, { force: false }); } catch (e) { blocked = e.statusCode === 409; }
    test("clôture bloquée sans forçage (409)", blocked);
    const forced = await closure.closePeriod(pool, CO, 1, 2099, 1, { force: true });
    test("clôture possible avec forçage explicite", forced && forced.status === "closed");

    // 3) SAISIE MANUELLE ÉQUILIBRÉE (trésorerie)
    const before = (await pool.query("SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM accounting_entries WHERE company_id=$1", [CO])).rows[0];
    const man = await executeCashbook(pool, CO, 1, profile, [{ __row: 1, status: "new", mapped: { op_date: "2026-06-01", libelle: "PROD manuel", income: 750000, expense: 0 } }], {}, helpers);
    test("saisie manuelle : 1 transaction + 2 écritures", man.report.transactions === 1 && man.report.entries === 2);
    const after = (await pool.query("SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM accounting_entries WHERE company_id=$1", [CO])).rows[0];
    test("saisie manuelle : débit = crédit maintenu", (Number(after.d) - Number(before.d)) === (Number(after.c) - Number(before.c)));

    await clean();
    console.log(`\n✅ ${passed} tests import-prod passés.`);
    await pool.end();
  } catch (e) {
    console.error("❌", e.message);
    await clean().catch(() => {});
    await pool.end();
    process.exit(1);
  }
})();
