"use strict";

/**
 * Exécuteur CASHBOOK (trésorerie & suivi comptable) : chaque ligne devient une
 * ou deux écritures RÉELLES (recette=entrée, dépense=sortie), partie double
 * équilibrée, trésorerie recalculée. Rattachement camion pour le suivi Fat et Mat.
 * Réutilise le modèle comptable existant (helpers injectés).
 */
const { ensureTreasury } = require("./executor-accounting");

async function ensureCamion(client, companyId, userId, code) {
  const c = String(code || "").trim();
  const found = (await client.query(`SELECT id FROM camions WHERE company_id=$1 AND code=$2 LIMIT 1`, [companyId, c])).rows[0];
  if (found) return found.id;
  const ins = await client.query(`INSERT INTO camions (company_id, code, created_by) VALUES ($1,$2,$3) RETURNING id`, [companyId, c, userId || null]);
  return ins.rows[0].id;
}

async function postLine(client, helpers, companyId, userId, kind, amount, m, profileKey) {
  const direction = kind === "income" ? "entrée" : "sortie";
  const delta = kind === "income" ? amount : -amount;
  const num = await helpers.nextAccountingNumber(client, "accounting_transactions", "transaction_number", "IMP", companyId);
  const tx = await client.query(
    `INSERT INTO accounting_transactions (company_id, transaction_number, transaction_type, source_type, source_id, amount, currency,
       direction, category, description, status, created_by, validated_by, validated_at, created_at, updated_at)
     VALUES ($1,$2,$3,'import',$4,$5,'FCFA',$6,$7,$8,'validé',$9,$9,NOW(),NOW(),NOW()) RETURNING id`,
    [companyId, num, kind === "income" ? "recette" : "depense", null, amount, direction,
     kind === "income" ? "Recette (import)" : "Dépense (import)", m.libelle || `Import ${profileKey}`, userId]
  );
  await client.query(`UPDATE treasury_accounts SET current_balance=COALESCE(current_balance,0)+$1, updated_by=$2, updated_at=NOW() WHERE company_id=$3`, [delta, userId, companyId]);
  if (kind === "income") {
    await helpers.createAccountingEntry(client, { companyId, sourceType: "import", sourceId: tx.rows[0].id, accountLabel: "Caisse", debit: amount, credit: 0, description: m.libelle || "", createdBy: userId });
    await helpers.createAccountingEntry(client, { companyId, sourceType: "import", sourceId: tx.rows[0].id, accountLabel: "Produits / Recettes", debit: 0, credit: amount, description: m.libelle || "", createdBy: userId });
  } else {
    await helpers.createAccountingEntry(client, { companyId, sourceType: "import", sourceId: tx.rows[0].id, accountLabel: "Charges / Dépenses", debit: amount, credit: 0, description: m.libelle || "", createdBy: userId });
    await helpers.createAccountingEntry(client, { companyId, sourceType: "import", sourceId: tx.rows[0].id, accountLabel: "Caisse", debit: 0, credit: amount, description: m.libelle || "", createdBy: userId });
  }
  return { id: tx.rows[0].id, direction, amount, delta };
}

async function executeCashbook(pool, companyId, userId, profile, rows, options, helpers) {
  const client = await pool.connect();
  const rowResults = [];
  const report = { imported: 0, transactions: 0, entries: 0, camionOps: 0, camionsCreated: 0, totalIncome: 0, totalExpense: 0, failed: 0, skipped: 0 };
  try {
    await client.query("BEGIN");
    let balance = await ensureTreasury(client, companyId, userId);
    for (const r of rows) {
      if (["invalid", "duplicate", "skipped"].includes(r.status)) { rowResults.push({ __row: r.__row, status: "skipped", result_ref: {} }); report.skipped++; continue; }
      const m = r.mapped;
      if (profile.skipRow && profile.skipRow(m)) { rowResults.push({ __row: r.__row, status: "skipped", result_ref: {} }); report.skipped++; continue; }
      const income = Number(m.income) || 0, expense = Number(m.expense) || 0;
      if (income <= 0 && expense <= 0) { rowResults.push({ __row: r.__row, status: "skipped", result_ref: {} }); report.skipped++; continue; }
      const date = m.op_date || new Date().toISOString().slice(0, 10);
      if (helpers.isPeriodClosed && await helpers.isPeriodClosed(client, companyId, date)) {
        rowResults.push({ __row: r.__row, status: "failed", result_ref: {}, messages: [{ code: "PERIOD_CLOSED", message: `Période de ${date} clôturée.`, severity: "error" }] });
        report.failed++; continue;
      }
      const txIds = [];
      if (income > 0) { const t = await postLine(client, helpers, companyId, userId, "income", income, m, profile.key); txIds.push(t.id); report.totalIncome += income; report.transactions++; report.entries += 2; balance += income; }
      if (expense > 0) { const t = await postLine(client, helpers, companyId, userId, "expense", expense, m, profile.key); txIds.push(t.id); report.totalExpense += expense; report.transactions++; report.entries += 2; balance -= expense; }

      // Rattachement camion (suivi Fat et Mat).
      let camionOpId = null;
      if (profile.hasCamion && profile.isRealCamion && profile.isRealCamion(m.camion)) {
        const before = (await client.query(`SELECT id FROM camions WHERE company_id=$1 AND code=$2`, [companyId, String(m.camion).trim()])).rows[0];
        const camionId = await ensureCamion(client, companyId, userId, m.camion);
        if (!before) report.camionsCreated++;
        const op = await client.query(
          `INSERT INTO camion_operations (company_id, camion_id, op_date, libelle, recette, depense, piece_ref, source_type, source_id, accounting_transaction_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'import',$8,$9,$10) RETURNING id`,
          [companyId, camionId, m.op_date || null, m.libelle || null, income, expense, m.piece_ref || null, options.jobId || null, txIds[0] || null, userId]
        );
        camionOpId = op.rows[0].id; report.camionOps++;
      }
      report.imported++;
      rowResults.push({ __row: r.__row, status: "imported", result_ref: { tx_ids: txIds, camion_op_id: camionOpId, income, expense } });
    }
    await client.query("COMMIT");
    report.treasuryAfter = balance;
    return { report, rowResults };
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
}

async function simulateCashbook(pool, companyId, profile, rows) {
  const before = Number((await pool.query(`SELECT COALESCE(SUM(current_balance),0) b FROM treasury_accounts WHERE company_id=$1`, [companyId])).rows[0].b) || 0;
  let income = 0, expense = 0, camionOps = 0, skipped = 0;
  const detail = [];
  for (const r of rows) {
    if (["invalid", "duplicate", "skipped"].includes(r.status)) { skipped++; continue; }
    const m = r.mapped;
    if (profile.skipRow && profile.skipRow(m)) { skipped++; continue; }
    const inc = Number(m.income) || 0, exp = Number(m.expense) || 0;
    if (inc <= 0 && exp <= 0) { skipped++; continue; }
    income += inc; expense += exp;
    if (profile.hasCamion && profile.isRealCamion && profile.isRealCamion(m.camion)) camionOps++;
    detail.push({ __row: r.__row, product_name: m.libelle || "", movementType: inc > 0 ? "RECETTE" : "DÉPENSE", stockBefore: 0, delta: inc - exp, stockAfter: 0 });
  }
  return { rows: detail, totals: { treasuryBefore: before, totalIncome: income, totalExpense: expense, treasuryAfter: before + income - expense, camionOperations: camionOps, skipped, balanced: true } };
}

async function rollbackCashbook(pool, companyId, userId, job, importedRows, helpers) {
  const client = await pool.connect();
  let reverted = 0;
  const detail = { counter_transactions: 0, camion_ops_deleted: 0 };
  try {
    await client.query("BEGIN");
    for (const r of importedRows) {
      const ref = r.result_ref || {};
      for (const txId of ref.tx_ids || []) {
        const tx = (await client.query(`SELECT amount, direction FROM accounting_transactions WHERE id=$1 AND company_id=$2`, [txId, companyId])).rows[0];
        if (!tx) continue;
        const counterDir = tx.direction === "entrée" ? "sortie" : "entrée";
        const num = await helpers.nextAccountingNumber(client, "accounting_transactions", "transaction_number", "ANN", companyId);
        const ctx = await client.query(
          `INSERT INTO accounting_transactions (company_id, transaction_number, transaction_type, source_type, source_id, amount, currency, direction, category, description, status, created_by, validated_by, validated_at, created_at, updated_at)
           VALUES ($1,$2,'annulation','import_rollback',$3,$4,'FCFA',$5,'Annulation import','Contrepassation','validé',$6,$6,NOW(),NOW(),NOW()) RETURNING id`,
          [companyId, num, txId, tx.amount, counterDir, userId]
        );
        const delta = counterDir === "entrée" ? Number(tx.amount) : -Number(tx.amount);
        await client.query(`UPDATE treasury_accounts SET current_balance=COALESCE(current_balance,0)+$1, updated_by=$2, updated_at=NOW() WHERE company_id=$3`, [delta, userId, companyId]);
        await helpers.createAccountingEntry(client, { companyId, sourceType: "import_rollback", sourceId: ctx.rows[0].id, accountLabel: "Contrepassation", debit: counterDir === "sortie" ? tx.amount : 0, credit: counterDir === "entrée" ? tx.amount : 0, description: "Annulation import", createdBy: userId });
        await helpers.createAccountingEntry(client, { companyId, sourceType: "import_rollback", sourceId: ctx.rows[0].id, accountLabel: "Caisse", debit: counterDir === "entrée" ? tx.amount : 0, credit: counterDir === "sortie" ? tx.amount : 0, description: "Annulation import", createdBy: userId });
        detail.counter_transactions++;
      }
      if (ref.camion_op_id) { await client.query(`DELETE FROM camion_operations WHERE id=$1 AND company_id=$2`, [ref.camion_op_id, companyId]); detail.camion_ops_deleted++; }
      reverted++;
      await client.query(`UPDATE import_rows SET status='rolled_back' WHERE job_id=$1 AND row_index=$2`, [job.id, r.row_index]);
    }
    await client.query(`UPDATE import_jobs SET status='rolled_back', rolled_back_at=NOW() WHERE id=$1`, [job.id]);
    await client.query(`INSERT INTO import_rollback_logs (job_id, company_id, strategy, reverted_rows, detail, user_id) VALUES ($1,$2,'cashbook_counter',$3,$4,$5)`, [job.id, companyId, reverted, JSON.stringify(detail), userId]);
    await client.query("COMMIT");
    return { reverted, detail };
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
}

module.exports = { executeCashbook, simulateCashbook, rollbackCashbook, ensureCamion };
