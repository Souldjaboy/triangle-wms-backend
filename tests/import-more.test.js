"use strict";
/* Intégration : transferts + fournisseurs + isolation mappings. DB requise. */
const assert = require("assert");
require("dotenv").config();
if (!process.env.DATABASE_URL) { console.log("⏭  import-more: DATABASE_URL absente, ignoré."); process.exit(0); }

const { Pool } = require("pg");
const ic = require("../import-center");
const { simulateTransfer, executeTransfer, rollbackTransfer } = require("../import-center/executor");
const { executeEntity } = require("../import-center/executor-entity");

const CO = 1;
const row = (i, mapped) => ({ __row: i, status: "new", mapped });

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let passed = 0;
  const test = (n, c) => { assert.ok(c, n); passed++; console.log("  ✓ " + n); };
  const clean = async () => {
    await pool.query("DELETE FROM stock_movements WHERE company_id=$1 AND product_name='ProdTransfTest'", [CO]).catch(() => {});
    await pool.query("DELETE FROM products WHERE company_id=$1 AND name='ProdTransfTest'", [CO]).catch(() => {});
    await pool.query("DELETE FROM suppliers WHERE company_id=$1 AND name='FournIntegTest'", [CO]).catch(() => {});
    await pool.query("DELETE FROM import_mapping_templates WHERE name IN ('MapTestA','MapTestB')").catch(() => {});
  };
  try {
    await clean();
    console.log("Import — transferts / fournisseurs / mappings");

    // TRANSFERT : double mouvement lié.
    const tProfile = ic.registry.getProfile("triangle.transfer");
    const tRows = [row(2, { product_name: "ProdTransfTest", quantity: 4, source_warehouse: "A", destination_warehouse: "B" })];
    const sim = await simulateTransfer(pool, CO, tProfile, tRows);
    test("transfert: simulation = 2 mouvements", sim.totals.movements === 2);
    const ex = await executeTransfer(pool, CO, 1, tProfile, tRows);
    test("transfert: exécuté (2 mouvements)", ex.report.movements === 2 && ex.report.imported === 1);
    const types = (await pool.query("SELECT type FROM stock_movements WHERE company_id=$1 AND product_name='ProdTransfTest' ORDER BY type", [CO])).rows.map((r) => r.type);
    test("transfert: TRANSFER_IN + TRANSFER_OUT créés", types.includes("TRANSFER_IN") && types.includes("TRANSFER_OUT"));
    // Rollback
    const job = (await pool.query(`INSERT INTO import_jobs (job_uid, company_id, product_code, module_key, import_type, status, created_by) VALUES ($1,$2,'triangle','logistique','triangle.transfer','imported',1) RETURNING id`, ["tr-" + Date.now(), CO])).rows[0];
    const rr = ex.rowResults.map((r, i) => ({ row_index: 300 + i, result_ref: r.result_ref }));
    for (const x of rr) await pool.query(`INSERT INTO import_rows (job_id, company_id, row_index, raw, status, result_ref) VALUES ($1,$2,$3,'{}','imported',$4)`, [job.id, CO, x.row_index, JSON.stringify(x.result_ref)]);
    const rb = await rollbackTransfer(pool, CO, 1, job, rr);
    test("transfert: rollback supprime 2 mouvements", rb.detail.movements_deleted === 2);
    const remain = (await pool.query("SELECT COUNT(*)::int n FROM stock_movements WHERE company_id=$1 AND product_name='ProdTransfTest'", [CO])).rows[0].n;
    test("transfert: mouvements supprimés", remain === 0);
    await pool.query("DELETE FROM import_rows WHERE job_id=$1", [job.id]);
    await pool.query("DELETE FROM import_jobs WHERE id=$1", [job.id]);

    // FOURNISSEURS (entité)
    const sProfile = ic.registry.getProfile("triangle.suppliers");
    const rs = await executeEntity(pool, CO, 1, sProfile, [row(2, { supplier_name: "FournIntegTest", phone: "75000000", description: "Bamako" })], {});
    test("fournisseur créé", rs.report.created === 1);
    const sup = (await pool.query("SELECT name, phone FROM suppliers WHERE company_id=$1 AND name='FournIntegTest'", [CO])).rows[0];
    test("fournisseur: nom/téléphone", sup.name === "FournIntegTest" && sup.phone === "75000000");

    // MAPPINGS : isolation par entreprise.
    await pool.query(`INSERT INTO import_mapping_templates (company_id, product_code, profile_key, name, mapping) VALUES (1,'triangle','triangle.transfer','MapTestA','{}')`);
    await pool.query(`INSERT INTO import_mapping_templates (company_id, product_code, profile_key, name, mapping) VALUES (2,'triangle','triangle.transfer','MapTestB','{}')`);
    const c1 = (await pool.query("SELECT COUNT(*)::int n FROM import_mapping_templates WHERE company_id=1 AND name='MapTestA'")).rows[0].n;
    const c1seesB = (await pool.query("SELECT COUNT(*)::int n FROM import_mapping_templates WHERE company_id=1 AND name='MapTestB'")).rows[0].n;
    test("mappings: isolés par entreprise (A visible pour 1, B non)", c1 === 1 && c1seesB === 0);

    await clean();
    console.log(`\n✅ ${passed} tests import-more passés.`);
    await pool.end();
  } catch (e) {
    console.error("❌", e.message);
    await clean().catch(() => {});
    await pool.end();
    process.exit(1);
  }
})();
