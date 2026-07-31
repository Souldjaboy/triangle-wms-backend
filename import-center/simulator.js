"use strict";

/**
 * Simulation : calcule EXACTEMENT ce qui se passera, sans rien écrire.
 * Spécialisé stock Triangle (mouvements traçables) + catalogue produits.
 */

// Sens du mouvement -> delta de stock.
const POSITIVE = new Set(["OPENING_STOCK", "IN", "ADJUSTMENT_IN", "TRANSFER_IN", "INVENTORY_CORRECTION"]);
const NEGATIVE = new Set(["OUT", "DAMAGE", "LOSS", "ADJUSTMENT_OUT", "TRANSFER_OUT"]);

function movementDelta(type, qty) {
  const q = Math.abs(Number(qty) || 0);
  if (POSITIVE.has(type)) return q;
  if (NEGATIVE.has(type)) return -q;
  return 0;
}

// Résout un produit existant : code-barres > sku > référence > nom normalisé.
async function resolveProduct(pool, companyId, m) {
  const tries = [];
  if (m.barcode) tries.push(["barcode", String(m.barcode).trim()]);
  if (m.product_code) { tries.push(["sku", String(m.product_code).trim()]); tries.push(["reference", String(m.product_code).trim()]); }
  for (const [col, val] of tries) {
    const { rows } = await pool.query(
      `SELECT id, name, reference, stock FROM products WHERE company_id=$1 AND ${col}=$2 LIMIT 1`,
      [companyId, val]
    );
    if (rows[0]) return rows[0];
  }
  if (m.product_name) {
    const { rows } = await pool.query(
      `SELECT id, name, reference, stock FROM products
        WHERE company_id=$1 AND lower(trim(name))=lower(trim($2)) LIMIT 1`,
      [companyId, String(m.product_name)]
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

/**
 * Simule un import de stock. options.allowNegative : autoriser stock négatif.
 * @returns { rows: [{__row, ...decision}], totals }
 */
async function simulateStock(pool, companyId, profile, rows, options = {}) {
  const allowNegative = options.allowNegative === true;
  const out = [];
  let productsToCreate = 0, movements = 0, added = 0, removed = 0, blocked = 0;
  // Stock projeté par produit (pour enchaîner plusieurs lignes du même produit).
  const projected = new Map();

  for (const r of rows) {
    if (["invalid", "duplicate", "skipped"].includes(r.status)) { out.push({ __row: r.__row, skip: true, status: r.status }); continue; }
    const m = r.mapped;
    const type = profile.forcedMovementType || (profile.normalizeMovementType ? profile.normalizeMovementType(m.movement_type) : null);
    const qty = Math.abs(Number(m.quantity) || 0);
    const product = await resolveProduct(pool, companyId, m);
    const key = product ? `id:${product.id}` : `name:${String(m.product_name || "").toLowerCase().trim()}`;
    const base = projected.has(key) ? projected.get(key) : (product ? Number(product.stock) || 0 : 0);
    const willCreate = !product && !!String(m.product_name || "").trim();
    const delta = movementDelta(type, qty);
    const after = base + delta;
    projected.set(key, after);

    const decision = {
      __row: r.__row,
      product_id: product ? product.id : null,
      product_name: product ? product.name : m.product_name,
      willCreateProduct: willCreate,
      movementType: type,
      stockBefore: base,
      delta,
      stockAfter: after,
      reason: m.description || null,
      blocked: false,
      messages: [],
    };
    if (!type) { decision.blocked = true; decision.messages.push({ code: "NO_TYPE", message: "Type de mouvement indéterminé.", severity: "error" }); blocked++; }
    if (!allowNegative && after < 0) { decision.blocked = true; decision.messages.push({ code: "NEGATIVE_STOCK", message: `Stock négatif interdit (résultat ${after}).`, severity: "error" }); blocked++; }
    if (!decision.blocked) {
      movements++;
      if (willCreate) productsToCreate++;
      if (delta >= 0) added += delta; else removed += -delta;
    }
    out.push(decision);
  }

  return {
    rows: out,
    totals: { productsToCreate, movements, quantityAdded: added, quantityRemoved: removed, blocked },
  };
}

module.exports = { simulateStock, resolveProduct, movementDelta, POSITIVE, NEGATIVE };
