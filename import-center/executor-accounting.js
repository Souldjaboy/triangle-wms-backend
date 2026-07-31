"use strict";

/**
 * Exécuteur comptable (Triangle) — RÉUTILISE le modèle existant :
 * accounting_transactions (trésorerie, direction entrée/sortie) +
 * accounting_entries (partie double équilibrée) + treasury_accounts.
 * Ne modifie JAMAIS un solde isolément : chaque ligne crée des écritures
 * traçables. Total débit = Total crédit (auto-équilibré pour dépense/recette).
 */

async function ensureTreasury(client, companyId, userId) {
  const { rows } = await client.query(`SELECT current_balance FROM treasury_accounts WHERE company_id=$1 ORDER BY id LIMIT 1`, [companyId]);
  if (rows[0]) return Number(rows[0].current_balance) || 0;
  await client.query(
    `INSERT INTO treasury_accounts (company_id, currency, initial_balance, current_balance, updated_by) VALUES ($1,'FCFA',0,0,$2)`,
    [companyId, userId || null]
  );
  return 0;
}

// Empreinte pour éviter les doubles imports comptables (idempotence).
function isClosedError(msg) { const e = new Error(msg); e.statusCode = 409; return e; }

/**
 * @param helpers { nextAccountingNumber, createAccountingEntry, isPeriodClosed }
 * @param rows lignes staging { __row, mapped, status }
 * @param kind "expense" | "income"
 */
async function executeAccounting(pool, companyId, userId, profile, rows, options, helpers) {
  const kind = profile.key.endsWith("income") ? "income" : "expense";
  const client = await pool.connect();
  const rowResults = [];
  const report = { imported: 0, transactions: 0, entries: 0, failed: 0, totalIncome: 0, totalExpense: 0 };
  try {
    await client.query("BEGIN");
    let balance = await ensureTreasury(client, companyId, userId);

    for (const r of rows) {
      if (["invalid", "duplicate", "skipped"].includes(r.status)) { rowResults.push({ __row: r.__row, status: "skipped", result_ref: {} }); continue; }
      const m = r.mapped;
      const amount = Number(kind === "income" ? m.income_amount : m.expense_amount);
      if (!(amount > 0)) { rowResults.push({ __row: r.__row, status: "failed", result_ref: {} }); report.failed++; continue; }
      const date = m.transaction_date || new Date().toISOString().slice(0, 10);

      // Refus d'écriture dans une période clôturée.
      if (helpers.isPeriodClosed && await helpers.isPeriodClosed(client, companyId, date)) {
        rowResults.push({ __row: r.__row, status: "failed", result_ref: {}, messages: [{ code: "PERIOD_CLOSED", message: `Période de ${date} clôturée.`, severity: "error" }] });
        report.failed++; continue;
      }

      const direction = kind === "income" ? "entrée" : "sortie";
      const delta = kind === "income" ? amount : -amount;
      const txNum = await helpers.nextAccountingNumber(client, "accounting_transactions", "transaction_number", "IMP", companyId);
      const tx = await client.query(
        `INSERT INTO accounting_transactions
           (company_id, transaction_number, transaction_type, source_type, source_id, amount, currency,
            direction, category, description, status, created_by, validated_by, validated_at, created_at, updated_at)
         VALUES ($1,$2,$3,'import',$4,$5,'FCFA',$6,$7,$8,'validé',$9,$9,NOW(),NOW(),NOW()) RETURNING id`,
        [companyId, txNum, kind === "income" ? "recette" : "depense", null, amount, direction,
         kind === "income" ? "Recette (import)" : "Dépense (import)", m.description || `Import ${profile.key}`, userId]
      );
      const txId = tx.rows[0].id;

      // Trésorerie (jamais isolée : couplée à l'écriture).
      await client.query(`UPDATE treasury_accounts SET current_balance=COALESCE(current_balance,0)+$1, updated_by=$2, updated_at=NOW() WHERE company_id=$3`, [delta, userId, companyId]);
      balance += delta;

      // Partie double équilibrée.
      if (kind === "income") {
        await helpers.createAccountingEntry(client, { companyId, sourceType: "import", sourceId: txId, accountLabel: "Caisse", debit: amount, credit: 0, description: m.description || "Recette importée", createdBy: userId });
        await helpers.createAccountingEntry(client, { companyId, sourceType: "import", sourceId: txId, accountLabel: "Produits / Recettes", debit: 0, credit: amount, description: m.description || "Recette importée", createdBy: userId });
        report.totalIncome += amount;
      } else {
        await helpers.createAccountingEntry(client, { companyId, sourceType: "import", sourceId: txId, accountLabel: "Charges / Dépenses", debit: amount, credit: 0, description: m.description || "Dépense importée", createdBy: userId });
        await helpers.createAccountingEntry(client, { companyId, sourceType: "import", sourceId: txId, accountLabel: "Caisse", debit: 0, credit: amount, description: m.description || "Dépense importée", createdBy: userId });
        report.totalExpense += amount;
      }
      report.transactions++; report.entries += 2; report.imported++;
      rowResults.push({ __row: r.__row, status: "imported", result_ref: { transaction_id: txId, direction, amount, delta } });
    }

    await client.query("COMMIT");
    report.treasuryAfter = balance;
    return { report, rowResults };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Simulation comptable : projette la trésorerie sans rien écrire.
async function simulateAccounting(pool, companyId, profile, rows) {
  const kind = profile.key.endsWith("income") ? "income" : "expense";
  const before = Number((await pool.query(`SELECT COALESCE(SUM(current_balance),0) AS b FROM treasury_accounts WHERE company_id=$1`, [companyId])).rows[0].b) || 0;
  let income = 0, expense = 0, entries = 0, rejected = 0;
  const detail = [];
  for (const r of rows) {
    if (["invalid", "duplicate", "skipped"].includes(r.status)) continue;
    const m = r.mapped;
    const amount = Number(kind === "income" ? m.income_amount : m.expense_amount);
    if (!(amount > 0)) { rejected++; continue; }
    if (kind === "income") income += amount; else expense += amount;
    entries += 2;
    detail.push({ __row: r.__row, date: m.transaction_date, amount, direction: kind === "income" ? "entrée" : "sortie", description: m.description || "" });
  }
  const after = before + income - expense;
  return {
    rows: detail,
    totals: { treasuryBefore: before, totalIncome: income, totalExpense: expense, treasuryAfter: after, entriesCreated: entries, rejected, balanced: true },
  };
}

// Annulation comptable : écritures de CONTREPASSATION (jamais de suppression d'écriture validée).
async function reverseAccounting(pool, companyId, userId, job, importedRows, helpers) {
  const client = await pool.connect();
  let reverted = 0;
  const detail = { counter_transactions: 0, counter_entries: 0 };
  try {
    await client.query("BEGIN");
    for (const r of importedRows) {
      const ref = r.result_ref || {};
      if (!ref.transaction_id) continue;
      const counterDir = ref.direction === "entrée" ? "sortie" : "entrée";
      const txNum = await helpers.nextAccountingNumber(client, "accounting_transactions", "transaction_number", "ANN", companyId);
      const ctx = await client.query(
        `INSERT INTO accounting_transactions
           (company_id, transaction_number, transaction_type, source_type, source_id, amount, currency,
            direction, category, description, status, created_by, validated_by, validated_at, created_at, updated_at)
         VALUES ($1,$2,'annulation','import_rollback',$3,$4,'FCFA',$5,'Annulation import',$6,'validé',$7,$7,NOW(),NOW(),NOW()) RETURNING id`,
        [companyId, txNum, ref.transaction_id, ref.amount, counterDir, `Contrepassation import job #${job.id}`, userId]
      );
      // Trésorerie inversée.
      await client.query(`UPDATE treasury_accounts SET current_balance=COALESCE(current_balance,0)-$1, updated_by=$2, updated_at=NOW() WHERE company_id=$3`, [ref.delta || 0, userId, companyId]);
      // Contrepassation partie double.
      await helpers.createAccountingEntry(client, { companyId, sourceType: "import_rollback", sourceId: ctx.rows[0].id, accountLabel: "Contrepassation", debit: counterDir === "sortie" ? ref.amount : 0, credit: counterDir === "entrée" ? ref.amount : 0, description: "Annulation import", createdBy: userId });
      await helpers.createAccountingEntry(client, { companyId, sourceType: "import_rollback", sourceId: ctx.rows[0].id, accountLabel: "Caisse", debit: counterDir === "entrée" ? ref.amount : 0, credit: counterDir === "sortie" ? ref.amount : 0, description: "Annulation import", createdBy: userId });
      detail.counter_transactions++; detail.counter_entries += 2; reverted++;
      await client.query(`UPDATE import_rows SET status='rolled_back' WHERE job_id=$1 AND row_index=$2`, [job.id, r.row_index]);
    }
    await client.query(`UPDATE import_jobs SET status='rolled_back', rolled_back_at=NOW() WHERE id=$1`, [job.id]);
    await client.query(`INSERT INTO import_rollback_logs (job_id, company_id, strategy, reverted_rows, detail, user_id) VALUES ($1,$2,'accounting_counter',$3,$4,$5)`, [job.id, companyId, reverted, JSON.stringify(detail), userId]);
    await client.query("COMMIT");
    return { reverted, detail };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { executeAccounting, simulateAccounting, reverseAccounting, ensureTreasury, isClosedError };
