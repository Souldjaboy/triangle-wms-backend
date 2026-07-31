"use strict";

/**
 * Exécuteur générique d'entités (create/update) piloté par `profile.entity` :
 *   { table, map:{field:column}, compute:{column:fn(m)}, defaults:{},
 *     dedupBy:[[col,...], ...], updatable:[col,...], canDelete:bool,
 *     dependencyCheck:async(client,id)->bool }
 * Transactionnel. Ne remplace jamais une valeur existante non vide par une
 * cellule vide (stratégie « compléter »).
 */

async function findExisting(client, companyId, cfg, values) {
  for (const group of cfg.dedupBy || []) {
    if (!group.every((col) => values[col] != null && String(values[col]).trim() !== "")) continue;
    const conds = group.map((col, i) => `${col}=$${i + 2}`);
    const params = [companyId, ...group.map((col) => values[col])];
    const { rows } = await client.query(
      `SELECT id FROM ${cfg.table} WHERE company_id=$1 AND ${conds.join(" AND ")} LIMIT 1`,
      params
    );
    if (rows[0]) return rows[0].id;
  }
  return null;
}

async function executeEntity(pool, companyId, userId, profile, rows, options = {}) {
  const cfg = profile.entity;
  const strategy = options.strategy || "create_update"; // create_only | update_only | create_update
  const client = await pool.connect();
  const rowResults = [];
  const report = { imported: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      if (["invalid", "duplicate", "skipped"].includes(r.status)) { rowResults.push({ __row: r.__row, status: "skipped", result_ref: {} }); report.skipped++; continue; }
      const m = r.mapped;
      const values = {};
      for (const [col, field] of Object.entries(cfg.map || {})) values[col] = m[field] ?? null;
      if (cfg.compute) for (const [col, fn] of Object.entries(cfg.compute)) values[col] = fn(m);
      Object.assign(values, cfg.defaults || {}, { company_id: companyId });
      if (userId && cfg.createdByColumn) values[cfg.createdByColumn] = userId;

      const existingId = await findExisting(client, companyId, cfg, values);
      if (existingId) {
        if (strategy === "create_only") { rowResults.push({ __row: r.__row, status: "skipped", result_ref: { id: existingId } }); report.skipped++; continue; }
        // Mise à jour : uniquement les colonnes non vides (jamais écraser par vide).
        const cols = (cfg.updatable || []).filter((c) => values[c] != null && String(values[c]).trim() !== "");
        if (cols.length) {
          const sets = cols.map((c, i) => `${c}=$${i + 2}`);
          await client.query(`UPDATE ${cfg.table} SET ${sets.join(", ")}, updated_at=NOW() WHERE id=$1`, [existingId, ...cols.map((c) => values[c])]);
        }
        report.updated++; report.imported++;
        rowResults.push({ __row: r.__row, status: "imported", result_ref: { id: existingId, created: false } });
      } else {
        if (strategy === "update_only") { rowResults.push({ __row: r.__row, status: "skipped", result_ref: {} }); report.skipped++; continue; }
        const cols = Object.keys(values);
        const ph = cols.map((_, i) => `$${i + 1}`);
        const ins = await client.query(`INSERT INTO ${cfg.table} (${cols.join(", ")}) VALUES (${ph.join(", ")}) RETURNING id`, cols.map((c) => values[c]));
        report.created++; report.imported++;
        rowResults.push({ __row: r.__row, status: "imported", result_ref: { id: ins.rows[0].id, created: true } });
      }
    }
    await client.query("COMMIT");
    return { report, rowResults };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Simulation générique : compte créations/mises à jour attendues (sans écrire).
async function simulateEntity(pool, companyId, profile, rows) {
  const cfg = profile.entity;
  const client = await pool.connect();
  let willCreate = 0, willUpdate = 0, skipped = 0;
  const detail = [];
  try {
    for (const r of rows) {
      if (["invalid", "duplicate", "skipped"].includes(r.status)) { skipped++; continue; }
      const m = r.mapped;
      const values = { company_id: companyId };
      for (const [col, field] of Object.entries(cfg.map || {})) values[col] = m[field] ?? null;
      if (cfg.compute) for (const [col, fn] of Object.entries(cfg.compute)) values[col] = fn(m);
      const existingId = await findExisting(client, companyId, cfg, values);
      if (existingId) willUpdate++; else willCreate++;
      detail.push({ __row: r.__row, willCreateProduct: !existingId, product_name: values[cfg.labelColumn] || "", movementType: existingId ? "MAJ" : "CRÉATION", stockBefore: 0, delta: 0, stockAfter: 0 });
    }
    return { rows: detail, totals: { willCreate, willUpdate, skipped, entity: cfg.table } };
  } finally { client.release(); }
}

// Rollback entité : supprime les lignes créées (si autorisé et sans dépendance).
async function rollbackEntity(pool, companyId, userId, profile, job, importedRows) {
  const cfg = profile.entity;
  const client = await pool.connect();
  let reverted = 0;
  const detail = { deleted: 0, kept: [] };
  try {
    await client.query("BEGIN");
    for (const r of importedRows) {
      const ref = r.result_ref || {};
      if (!ref.id) continue;
      if (ref.created && cfg.canDelete) {
        let hasDep = false;
        if (cfg.dependencyCheck) hasDep = await cfg.dependencyCheck(client, ref.id, companyId);
        if (!hasDep) { await client.query(`DELETE FROM ${cfg.table} WHERE id=$1 AND company_id=$2`, [ref.id, companyId]); detail.deleted++; reverted++; }
        else detail.kept.push(ref.id);
      } else {
        detail.kept.push(ref.id); // création non supprimable ou ligne mise à jour : on conserve
      }
      await client.query(`UPDATE import_rows SET status='rolled_back' WHERE job_id=$1 AND row_index=$2`, [job.id, r.row_index]);
    }
    await client.query(`UPDATE import_jobs SET status='rolled_back', rolled_back_at=NOW() WHERE id=$1`, [job.id]);
    await client.query(`INSERT INTO import_rollback_logs (job_id, company_id, strategy, reverted_rows, detail, user_id) VALUES ($1,$2,'entity_delete',$3,$4,$5)`, [job.id, companyId, reverted, JSON.stringify(detail), userId]);
    await client.query("COMMIT");
    return { reverted, detail };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { executeEntity, simulateEntity, rollbackEntity, findExisting };
