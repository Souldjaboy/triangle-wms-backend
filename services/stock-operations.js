"use strict";

/**
 * SERVICE PARTAGÉ DES OPÉRATIONS DE STOCK.
 *
 * Moteur UNIQUE : les routes manuelles et l'import d'inventaire Excel passent
 * par ici. Aucune logique de stock ne doit être réécrite ailleurs.
 *
 * Trois règles héritées de l'audit du moteur historique :
 *
 *  1. UNE SORTIE N'EST JAMAIS PLAFONNÉE. L'ancienne route faisait
 *     `GREATEST(stock - q, 0)` : une sortie de 23 100 sur 19 900 en stock
 *     ramenait à 0 et faisait disparaître 3 200 unités sans aucune trace.
 *     Ici, le stock insuffisant provoque un refus explicite (409) et rien
 *     n'est modifié.
 *  2. TOUT EST TRANSACTIONNEL. Le produit est verrouillé (FOR UPDATE), le
 *     mouvement et le stock sont écrits dans la MÊME transaction. Il ne peut
 *     plus exister de stock modifié sans mouvement, ni l'inverse.
 *  3. ON VALIDE UN MOUVEMENT PAR SON ID. L'ancienne route validait toutes les
 *     lignes partageant une product_reference : un clic pouvait en valider des
 *     dizaines sans bouger le stock correspondant.
 *
 * Chaque mouvement enregistre stock_before / quantity / stock_after : c'est ce
 * qui rend l'histoire d'un produit reconstituable.
 */

const MOVEMENT_TYPES = {
  ENTRY: "Entrée",
  EXIT: "Sortie",
  TRANSFER: "Transfert",
  INVENTORY: "Inventaire",
  WRITE_OFF: "casse / WRITE OFF",
};

/** Erreur métier : porte un code HTTP, pour que les routes le relaient tel quel. */
class StockError extends Error {
  constructor(message, code, httpStatus = 409, details = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/* Verrou de ligne : sérialise deux opérations concurrentes sur le même produit. */
async function lockProduct(client, companyId, { productId, reference }) {
  const { rows } = await client.query(
    `SELECT * FROM products
      WHERE company_id = $1
        AND ($2::int IS NULL OR id = $2)
        AND ($3::text IS NULL OR reference = $3)
      FOR UPDATE`,
    [companyId, productId || null, productId ? null : reference || null]
  );
  if (!rows[0]) {
    throw new StockError("Produit introuvable pour cette entreprise.", "PRODUCT_NOT_FOUND", 404);
  }
  return rows[0];
}

/**
 * Écrit le mouvement ET applique le stock, dans la transaction de l'appelant.
 * `delta` est signé : positif pour une entrée, négatif pour une sortie.
 */
async function applyMovement(client, {
  companyId, product, type, quantity, delta, user,
  reason = null, sourceWarehouse = null, destinationWarehouse = null,
  locationCode = null, warehouseId = null, locationId = null,
  importId = null, sourceReference = null, status = "Validé",
}) {
  const before = Number(product.stock || 0);
  const after = before + delta;

  if (after < 0) {
    /* Refus explicite : on ne rabote jamais silencieusement à zéro. */
    throw new StockError(
      `Stock insuffisant pour « ${product.name} » : disponible ${before}, demandé ${Math.abs(delta)}.`,
      "STOCK_INSUFFICIENT", 409,
      { productId: product.id, available: before, requested: Math.abs(delta) }
    );
  }

  const { rows } = await client.query(
    `INSERT INTO stock_movements
       (type, product_reference, product_name, product_id, quantity,
        source_warehouse, destination_warehouse, reason, status, company_id,
        created_by, created_by_name, created_by_role, location_code,
        warehouse_id, location_id, approval_status, original_quantity,
        final_quantity, stock_before, stock_after, import_id, source_reference,
        validated_by, validated_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
             $20,$21,$22,$23,$24,NOW(),NOW(),NOW())
     RETURNING *`,
    [
      type, product.reference || null, product.name, product.id, Math.abs(quantity),
      sourceWarehouse, destinationWarehouse, reason, status, companyId,
      user?.id || null, user?.name || user?.email || "Import", user?.role || null,
      locationCode, warehouseId, locationId, status === "Validé" ? "Approuvé" : "En attente",
      Math.abs(quantity), Math.abs(quantity), before, after, importId, sourceReference,
      status === "Validé" ? user?.id || null : null,
    ]
  );

  await client.query(
    `UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
    [after, product.id, companyId]
  );

  return { movement: rows[0], stockBefore: before, stockAfter: after };
}

/* ---------- Opérations métier ---------- */

async function createEntry(client, opts) {
  const product = await lockProduct(client, opts.companyId, opts);
  const q = Number(opts.quantity);
  if (!(q > 0)) throw new StockError("Quantité d'entrée invalide.", "INVALID_QUANTITY", 400);
  return applyMovement(client, { ...opts, product, type: MOVEMENT_TYPES.ENTRY, quantity: q, delta: q });
}

async function createExit(client, opts) {
  const product = await lockProduct(client, opts.companyId, opts);
  const q = Number(opts.quantity);
  if (!(q > 0)) throw new StockError("Quantité de sortie invalide.", "INVALID_QUANTITY", 400);
  return applyMovement(client, { ...opts, product, type: MOVEMENT_TYPES.EXIT, quantity: q, delta: -q });
}

async function createWriteOff(client, opts) {
  const product = await lockProduct(client, opts.companyId, opts);
  const q = Number(opts.quantity);
  if (!(q > 0)) throw new StockError("Quantité de write-off invalide.", "INVALID_QUANTITY", 400);
  return applyMovement(client, {
    ...opts, product, type: MOVEMENT_TYPES.WRITE_OFF, quantity: q, delta: -q,
    reason: opts.reason || "Write-off",
  });
}

/**
 * Ajustement d'inventaire : aligne le stock sur une quantité CONSTATÉE.
 * Le delta peut être positif ou négatif ; il n'est jamais une entrée ou une
 * sortie commerciale et doit rester identifiable comme une régularisation.
 */
async function createInventoryAdjustment(client, opts) {
  const product = await lockProduct(client, opts.companyId, opts);
  const counted = Number(opts.countedQuantity);
  if (!Number.isFinite(counted) || counted < 0) {
    throw new StockError("Quantité constatée invalide.", "INVALID_QUANTITY", 400);
  }
  const before = Number(product.stock || 0);
  const delta = counted - before;
  if (delta === 0) return { movement: null, stockBefore: before, stockAfter: before, skipped: true };
  return applyMovement(client, {
    ...opts, product, type: MOVEMENT_TYPES.INVENTORY, quantity: Math.abs(delta), delta,
    reason: opts.reason || "Régularisation inventaire",
  });
}

/**
 * Transfert interne : le stock GLOBAL du produit ne change pas, seule la
 * localisation évolue. On ne crée donc ni entrée ni sortie externe.
 */
async function createTransfer(client, opts) {
  const product = await lockProduct(client, opts.companyId, opts);
  const q = Number(opts.quantity);
  if (!(q > 0)) throw new StockError("Quantité de transfert invalide.", "INVALID_QUANTITY", 400);
  if (q > Number(product.stock || 0)) {
    throw new StockError(
      `Stock insuffisant pour transférer « ${product.name} » : disponible ${product.stock}, demandé ${q}.`,
      "STOCK_INSUFFICIENT", 409
    );
  }
  const res = await applyMovement(client, {
    ...opts, product, type: MOVEMENT_TYPES.TRANSFER, quantity: q, delta: 0,
    reason: opts.reason || "Transfert interne",
  });
  if (opts.destinationWarehouse) {
    await client.query(
      `UPDATE products SET warehouse = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
      [opts.destinationWarehouse, product.id, opts.companyId]
    );
  }
  return res;
}

/**
 * Valide UN mouvement, par son identifiant. Jamais par référence produit :
 * l'ancienne route validait toutes les lignes partageant une référence.
 */
async function validateMovement(client, { companyId, movementId, user, finalQuantity = null }) {
  const { rows } = await client.query(
    `SELECT * FROM stock_movements WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [movementId, companyId]
  );
  const mv = rows[0];
  if (!mv) throw new StockError("Mouvement introuvable.", "MOVEMENT_NOT_FOUND", 404);
  if (mv.status !== "En attente") {
    throw new StockError(`Mouvement déjà traité (${mv.status}).`, "ALREADY_PROCESSED", 409);
  }

  const product = await lockProduct(client, companyId, {
    productId: mv.product_id, reference: mv.product_reference,
  });
  const qty = finalQuantity != null ? Number(finalQuantity) : Number(mv.quantity);
  const before = Number(product.stock || 0);

  let after = before;
  if (mv.type === MOVEMENT_TYPES.ENTRY) after = before + qty;
  else if (mv.type === MOVEMENT_TYPES.EXIT || mv.type === MOVEMENT_TYPES.WRITE_OFF) after = before - qty;
  else if (mv.type === MOVEMENT_TYPES.INVENTORY) after = qty;

  if (after < 0) {
    throw new StockError(
      `Stock insuffisant pour valider ce mouvement : disponible ${before}, demandé ${qty}.`,
      "STOCK_INSUFFICIENT", 409, { available: before, requested: qty }
    );
  }

  await client.query(
    `UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
    [after, product.id, companyId]
  );
  const upd = await client.query(
    `UPDATE stock_movements
        SET status = 'Validé', approval_status = 'Approuvé', final_quantity = $1,
            stock_before = $2, stock_after = $3, validated_by = $4,
            validated_at = NOW(), updated_at = NOW()
      WHERE id = $5 AND company_id = $6
      RETURNING *`,
    [qty, before, after, user?.id || null, movementId, companyId]
  );
  return { movement: upd.rows[0], stockBefore: before, stockAfter: after };
}

module.exports = {
  MOVEMENT_TYPES, StockError,
  lockProduct, applyMovement,
  createEntry, createExit, createWriteOff, createTransfer,
  createInventoryAdjustment, validateMovement,
};
