"use strict";

/** Exécuteur FACTURES : insère/actualise dans `factures`, recalcule statut/reste. */

async function executeFactures(pool, companyId, userId, profile, rows, options = {}) {
  const strategy = options.strategy || "create_update";
  const client = await pool.connect();
  const rowResults = [];
  const report = { imported: 0, created: 0, updated: 0, skipped: 0, failed: 0, totalInvoiced: 0, totalPaid: 0 };
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      if (["invalid", "duplicate", "skipped"].includes(r.status)) { rowResults.push({ __row: r.__row, status: "skipped", result_ref: {} }); report.skipped++; continue; }
      const m = r.mapped;
      const invoiced = Number(m.invoiced_amount) || 0;
      const paid = Number(m.paid_amount) || 0;
      const remaining = Math.max(0, invoiced - paid);
      const status = profile.invoiceStatus(invoiced, paid);
      const ref = String(m.reference || "").trim();

      const existing = ref ? (await client.query(`SELECT id FROM factures WHERE company_id=$1 AND reference=$2 LIMIT 1`, [companyId, ref])).rows[0] : null;
      if (existing) {
        if (strategy === "create_only") { rowResults.push({ __row: r.__row, status: "skipped", result_ref: { id: existing.id } }); report.skipped++; continue; }
        await client.query(
          `UPDATE factures SET numero=$3, invoice_date=$4, site=$5, description=$6, invoiced_amount=$7, paid_amount=$8,
             remaining_amount=$9, payment_date=$10, status=$11, observations=$12, updated_at=NOW() WHERE id=$1 AND company_id=$2`,
          [existing.id, companyId, m.numero || null, m.invoice_date || null, m.site || null, m.description || null,
           invoiced, paid, remaining, m.payment_date || null, status, m.observations || null]
        );
        report.updated++; report.imported++;
        rowResults.push({ __row: r.__row, status: "imported", result_ref: { id: existing.id, created: false } });
      } else {
        const ins = await client.query(
          `INSERT INTO factures (company_id, numero, reference, invoice_date, site, description, invoiced_amount, paid_amount,
             remaining_amount, payment_date, status, observations, source_type, source_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'import',$13,$14) RETURNING id`,
          [companyId, m.numero || null, ref || null, m.invoice_date || null, m.site || null, m.description || null,
           invoiced, paid, remaining, m.payment_date || null, status, m.observations || null, options.jobId || null, userId]
        );
        report.created++; report.imported++;
        rowResults.push({ __row: r.__row, status: "imported", result_ref: { id: ins.rows[0].id, created: true } });
      }
      report.totalInvoiced += invoiced; report.totalPaid += paid;
    }
    await client.query("COMMIT");
    return { report, rowResults };
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
}

async function simulateFactures(pool, companyId, profile, rows) {
  let willCreate = 0, willUpdate = 0, invoiced = 0, paid = 0;
  const byStatus = { paye: 0, partiel: 0, impaye: 0 };
  const detail = [];
  const client = await pool.connect();
  try {
    for (const r of rows) {
      if (["invalid", "duplicate", "skipped"].includes(r.status)) continue;
      const m = r.mapped;
      const inv = Number(m.invoiced_amount) || 0, pd = Number(m.paid_amount) || 0;
      const st = profile.invoiceStatus(inv, pd);
      byStatus[st] = (byStatus[st] || 0) + 1;
      invoiced += inv; paid += pd;
      const ref = String(m.reference || "").trim();
      const exists = ref ? (await client.query(`SELECT 1 FROM factures WHERE company_id=$1 AND reference=$2 LIMIT 1`, [companyId, ref])).rows[0] : null;
      if (exists) willUpdate++; else willCreate++;
      detail.push({ __row: r.__row, product_name: ref, movementType: st, stockBefore: inv, delta: pd, stockAfter: Math.max(0, inv - pd), willCreateProduct: !exists });
    }
    return { rows: detail, totals: { willCreate, willUpdate, totalInvoiced: invoiced, totalPaid: paid, totalRemaining: invoiced - paid, paye: byStatus.paye, partiel: byStatus.partiel, impaye: byStatus.impaye } };
  } finally { client.release(); }
}

async function rollbackFactures(pool, companyId, userId, profile, job, importedRows) {
  const client = await pool.connect();
  let reverted = 0;
  const detail = { deleted: 0, kept: [] };
  try {
    await client.query("BEGIN");
    for (const r of importedRows) {
      const ref = r.result_ref || {};
      if (ref.id && ref.created) { await client.query(`DELETE FROM factures WHERE id=$1 AND company_id=$2`, [ref.id, companyId]); detail.deleted++; reverted++; }
      else if (ref.id) detail.kept.push(ref.id);
      await client.query(`UPDATE import_rows SET status='rolled_back' WHERE job_id=$1 AND row_index=$2`, [job.id, r.row_index]);
    }
    await client.query(`UPDATE import_jobs SET status='rolled_back', rolled_back_at=NOW() WHERE id=$1`, [job.id]);
    await client.query(`INSERT INTO import_rollback_logs (job_id, company_id, strategy, reverted_rows, detail, user_id) VALUES ($1,$2,'factures_delete',$3,$4,$5)`, [job.id, companyId, reverted, JSON.stringify(detail), userId]);
    await client.query("COMMIT");
    return { reverted, detail };
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
}

module.exports = { executeFactures, simulateFactures, rollbackFactures };
