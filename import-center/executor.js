"use strict";

/**
 * Exécution TRANSACTIONNELLE. Réutilise le système officiel : chaque ligne de
 * stock crée un mouvement traçable dans stock_movements + met à jour
 * products.stock. Aucune addition SQL « isolée » non tracée.
 * Enregistre les ids créés/modifiés dans import_rows.result_ref (rollback).
 */
const crypto = require("crypto");
const { simulateStock, resolveProduct, movementDelta } = require("./simulator");

function genRef(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`.toUpperCase();
}

async function ensureProduct(client, companyId, userId, m) {
  const existing = await resolveProduct(client, companyId, m);
  if (existing) return { id: existing.id, reference: existing.reference, name: existing.name, created: false };
  const reference = (m.product_code && String(m.product_code).trim()) || genRef("PRD");
  const { rows } = await client.query(
    `INSERT INTO products (company_id, name, reference, sku, barcode, sale_price, purchase_price, stock, is_active, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6,0,true,NOW(),NOW()) RETURNING id, reference, name`,
    [companyId, String(m.product_name).trim(), reference, m.product_code || null, m.barcode || null, Number(m.unit_price) || 0]
  );
  return { id: rows[0].id, reference: rows[0].reference, name: rows[0].name, created: true };
}

/**
 * Exécute un import de stock dans UNE transaction.
 * @param validatedRows lignes validées (statut new/warning) avec mapped.
 * @returns { report, rowResults } — rowResults: [{__row, status, result_ref}]
 */
async function executeStock(pool, companyId, userId, profile, validatedRows, options = {}) {
  const client = await pool.connect();
  const rowResults = [];
  const report = { imported: 0, createdProducts: 0, movements: 0, failed: 0 };
  try {
    await client.query("BEGIN");
    // Re-simule dans la transaction pour cohérence (stock à jour).
    const sim = await simulateStock(client, companyId, profile, validatedRows, options);
    const decisionByRow = new Map(sim.rows.map((d) => [d.__row, d]));

    for (const r of validatedRows) {
      if (["invalid", "duplicate", "skipped"].includes(r.status)) { rowResults.push({ __row: r.__row, status: "skipped", result_ref: {} }); continue; }
      const d = decisionByRow.get(r.__row);
      if (!d || d.blocked) { rowResults.push({ __row: r.__row, status: "failed", result_ref: {}, messages: d ? d.messages : [] }); report.failed++; continue; }
      const m = r.mapped;
      const prod = await ensureProduct(client, companyId, userId, m);
      if (prod.created) report.createdProducts++;

      const qty = Math.abs(Number(m.quantity) || 0);
      const delta = movementDelta(d.movementType, qty);
      const mv = await client.query(
        `INSERT INTO stock_movements
           (type, product_reference, product_name, quantity, reason, status, company_id, created_by, product_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'validated',$6,$7,$8,NOW(),NOW()) RETURNING id`,
        [d.movementType, prod.reference, prod.name, qty, m.description || `Import ${profile.key}`, companyId, userId, prod.id]
      );
      await client.query(`UPDATE products SET stock = COALESCE(stock,0) + $1, updated_at=NOW() WHERE id=$2 AND company_id=$3`, [delta, prod.id, companyId]);

      report.movements++; report.imported++;
      rowResults.push({
        __row: r.__row, status: "imported",
        result_ref: { movement_id: mv.rows[0].id, product_id: prod.id, created_product: prod.created, delta },
      });
    }

    await client.query("COMMIT");
    return { report, rowResults };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Simulation d'un transfert : source -> destination (stock global inchangé).
async function simulateTransfer(pool, companyId, profile, rows) {
  const out = [];
  let movements = 0, blocked = 0;
  for (const r of rows) {
    if (["invalid", "duplicate", "skipped"].includes(r.status)) { out.push({ __row: r.__row, skip: true }); continue; }
    const m = r.mapped;
    const product = await resolveProduct(pool, companyId, m);
    out.push({
      __row: r.__row, product_name: product ? product.name : m.product_name, willCreateProduct: !product,
      movementType: `TRANSFER ${m.source_warehouse} → ${m.destination_warehouse}`,
      stockBefore: product ? Number(product.stock) || 0 : 0, delta: 0, stockAfter: product ? Number(product.stock) || 0 : 0, blocked: false,
    });
    movements += 2;
  }
  return { rows: out, totals: { movements, transfers: out.filter((x) => !x.skip).length, blocked } };
}

// Exécution transactionnelle d'un transfert : deux mouvements liés.
async function executeTransfer(pool, companyId, userId, profile, rows) {
  const client = await pool.connect();
  const rowResults = [];
  const report = { imported: 0, movements: 0, createdProducts: 0, failed: 0 };
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      if (["invalid", "duplicate", "skipped"].includes(r.status)) { rowResults.push({ __row: r.__row, status: "skipped", result_ref: {} }); continue; }
      const m = r.mapped;
      const prod = await ensureProduct(client, companyId, userId, m);
      if (prod.created) report.createdProducts++;
      const qty = Math.abs(Number(m.quantity) || 0);
      const reason = m.description || `Transfert ${m.source_warehouse} → ${m.destination_warehouse}`;
      const mvOut = await client.query(
        `INSERT INTO stock_movements (type, product_reference, product_name, quantity, source_warehouse, destination_warehouse, reason, status, company_id, created_by, product_id, created_at, updated_at)
         VALUES ('TRANSFER_OUT',$1,$2,$3,$4,$5,$6,'validated',$7,$8,$9,NOW(),NOW()) RETURNING id`,
        [prod.reference, prod.name, qty, m.source_warehouse, m.destination_warehouse, reason, companyId, userId, prod.id]
      );
      const mvIn = await client.query(
        `INSERT INTO stock_movements (type, product_reference, product_name, quantity, source_warehouse, destination_warehouse, reason, status, company_id, created_by, product_id, created_at, updated_at)
         VALUES ('TRANSFER_IN',$1,$2,$3,$4,$5,$6,'validated',$7,$8,$9,NOW(),NOW()) RETURNING id`,
        [prod.reference, prod.name, qty, m.source_warehouse, m.destination_warehouse, reason, companyId, userId, prod.id]
      );
      report.movements += 2; report.imported++;
      rowResults.push({ __row: r.__row, status: "imported", result_ref: { out_id: mvOut.rows[0].id, in_id: mvIn.rows[0].id, product_id: prod.id, created_product: prod.created } });
    }
    await client.query("COMMIT");
    return { report, rowResults };
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
}

// Rollback transfert : supprime les deux mouvements liés + produit créé sans dépendance.
async function rollbackTransfer(pool, companyId, userId, job, importedRows) {
  const client = await pool.connect();
  let reverted = 0;
  const detail = { movements_deleted: 0, products_deleted: 0 };
  try {
    await client.query("BEGIN");
    for (const r of importedRows) {
      const ref = r.result_ref || {};
      if (ref.out_id) { await client.query(`DELETE FROM stock_movements WHERE id=$1 AND company_id=$2`, [ref.out_id, companyId]); detail.movements_deleted++; }
      if (ref.in_id) { await client.query(`DELETE FROM stock_movements WHERE id=$1 AND company_id=$2`, [ref.in_id, companyId]); detail.movements_deleted++; }
      if (ref.created_product && ref.product_id) {
        const other = await client.query(`SELECT COUNT(*)::int n FROM stock_movements WHERE product_id=$1 AND company_id=$2`, [ref.product_id, companyId]);
        if (other.rows[0].n === 0) { await client.query(`DELETE FROM products WHERE id=$1 AND company_id=$2`, [ref.product_id, companyId]); detail.products_deleted++; }
      }
      reverted++;
      await client.query(`UPDATE import_rows SET status='rolled_back' WHERE job_id=$1 AND row_index=$2`, [job.id, r.row_index]);
    }
    await client.query(`UPDATE import_jobs SET status='rolled_back', rolled_back_at=NOW() WHERE id=$1`, [job.id]);
    await client.query(`INSERT INTO import_rollback_logs (job_id, company_id, strategy, reverted_rows, detail, user_id) VALUES ($1,$2,'transfer_reverse',$3,$4,$5)`, [job.id, companyId, reverted, JSON.stringify(detail), userId]);
    await client.query("COMMIT");
    return { reverted, detail };
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
}

module.exports = { executeStock, ensureProduct, simulateTransfer, executeTransfer, rollbackTransfer };
