"use strict";

/**
 * STOCK PAR EMPLACEMENT PHYSIQUE EXACT.
 *
 * Ce service porte la RÉPARTITION : combien d'un produit se trouve dans quel
 * bin. Il ne remplace pas services/stock-operations.js — il le complète.
 * Le stock global reste `products.stock` ; les balances disent où il est.
 *
 * INVARIANTS, tenus dans la transaction de l'appelant :
 *   quantity >= 0                       (aucun bin négatif)
 *   reserved_quantity >= 0
 *   reserved_quantity <= quantity       (on ne réserve pas ce qui n'existe pas)
 *   disponible = quantity - reserved_quantity
 *   products.stock = SUM(balances)      dès que products.location_managed
 *
 * Aucun GREATEST(x, 0) nulle part : un stock qui deviendrait négatif est un
 * REFUS explicite, jamais un rabotage silencieux.
 *
 * Un emplacement vidé n'est JAMAIS supprimé : sa balance tombe à 0, il passe
 * EMPTY et redevient immédiatement disponible comme destination.
 */

const OCCUPANCY = { EMPTY: "EMPTY", OCCUPIED: "OCCUPIED", INACTIVE: "INACTIVE" };
const RESERVATION = { ACTIVE: "ACTIVE", RELEASED: "RELEASED", CONSUMED: "CONSUMED" };

class LocationStockError extends Error {
  constructor(message, code, httpStatus = 409, details = {}) {
    super(message);
    this.code = code; this.httpStatus = httpStatus; this.details = details;
  }
}

const num = (v) => Number(v || 0);

/* ------------------------------------------------------------------ lecture */

/** Répartition d'un produit : une ligne par emplacement, avec le disponible. */
async function productBalances(runner, companyId, productId) {
  const { rows } = await runner.query(
    `SELECT b.*, (b.quantity - b.reserved_quantity) AS available,
            l.full_code, l.emplacement_code, l.warehouse_code,
            COALESCE(NULLIF(l.rayon_code,''), l.zone)    AS row_code,
            COALESCE(NULLIF(l.case_code,''),  l.rayon)   AS loc_code,
            COALESCE(NULLIF(l.level_code,''), l.etagere) AS lvl_code,
            l.bin_code, l.occupancy_status
       FROM stock_location_balances b
       JOIN locations l ON l.id = b.location_id AND l.company_id = b.company_id
      WHERE b.company_id = $1 AND b.product_id = $2
      ORDER BY l.warehouse_code, l.rayon_code, l.case_code, l.level_code, l.bin_code`,
    [companyId, productId]
  );
  return rows;
}

/**
 * CONTRÔLE D'INTÉGRITÉ — jamais masqué.
 *
 * L'écart n'est vérifié que pour les produits dont la répartition est établie
 * (`location_managed`). Un produit non encore migré vit légitimement sur son
 * seul `products.stock` : le signaler serait un faux positif.
 */
async function checkIntegrity(runner, companyId, productId = null) {
  const { rows } = await runner.query(
    `SELECT p.id, p.name, p.reference, p.stock::numeric AS stock,
            COALESCE(SUM(b.quantity), 0)::numeric        AS balances,
            COALESCE(SUM(b.reserved_quantity), 0)::numeric AS reserved
       FROM products p
       LEFT JOIN stock_location_balances b
              ON b.product_id = p.id AND b.company_id = p.company_id
      WHERE p.company_id = $1
        AND COALESCE(p.location_managed, FALSE) = TRUE
        AND ($2::int IS NULL OR p.id = $2)
      GROUP BY p.id
     HAVING p.stock::numeric <> COALESCE(SUM(b.quantity), 0)::numeric`,
    [companyId, productId]
  );
  return rows.map((r) => ({
    ...r, ecart: num(r.stock) - num(r.balances), code: "LOCATION_BALANCE_MISMATCH",
  }));
}

/** Lève si l'écart existe. Appelé en fin de chaque opération transactionnelle. */
async function assertIntegrity(client, companyId, productId) {
  const bad = await checkIntegrity(client, companyId, productId);
  if (bad.length) {
    const b = bad[0];
    throw new LocationStockError(
      `Répartition incohérente pour « ${b.name} » : stock ${b.stock}, somme des emplacements ${b.balances} (écart ${b.ecart}).`,
      "LOCATION_BALANCE_MISMATCH", 409, { produits: bad }
    );
  }
}

/* ------------------------------------------------------------- verrouillage */

/** Charge l'emplacement et refuse tout ce qui n'est pas un bin exploitable. */
async function lockLocation(client, companyId, locationId) {
  const { rows } = await client.query(
    `SELECT * FROM locations WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [locationId, companyId]
  );
  const loc = rows[0];
  if (!loc) throw new LocationStockError("Emplacement introuvable.", "LOCATION_NOT_FOUND", 404);
  if (loc.is_active === false || loc.occupancy_status === OCCUPANCY.INACTIVE) {
    throw new LocationStockError(
      `Emplacement ${loc.full_code || loc.emplacement_code} inactif.`, "LOCATION_INACTIVE", 409
    );
  }
  /* Sans BIN, l'emplacement ne désigne pas un contenant physique : on refuse
     d'y poser du stock plutôt que de créer une répartition invérifiable. */
  if (!String(loc.bin_code || "").trim()) {
    throw new LocationStockError(
      `L'emplacement ${loc.emplacement_code || loc.id} n'a pas de BIN : complétez-le avant d'y ranger du stock.`,
      "LOCATION_WITHOUT_BIN", 409, { locationId }
    );
  }
  return loc;
}

/**
 * Verrouille la balance (produit, emplacement), en la créant à 0 si besoin.
 * Créer une balance à 0 ne change AUCUN stock : c'est l'ouverture d'un compte.
 */
async function lockBalance(client, companyId, productId, location, { create = false } = {}) {
  const found = (await client.query(
    `SELECT * FROM stock_location_balances
      WHERE company_id = $1 AND product_id = $2 AND location_id = $3 FOR UPDATE`,
    [companyId, productId, location.id]
  )).rows[0];
  if (found) return found;
  if (!create) {
    throw new LocationStockError(
      `Aucun stock de ce produit à l'emplacement ${location.full_code || location.emplacement_code}.`,
      "NO_BALANCE_AT_LOCATION", 409, { locationId: location.id }
    );
  }
  return (await client.query(
    `INSERT INTO stock_location_balances
       (company_id, product_id, warehouse_id, location_id, quantity, reserved_quantity)
     VALUES ($1,$2,$3,$4,0,0) RETURNING *`,
    [companyId, productId, location.warehouse_id, location.id]
  )).rows[0];
}

async function lockProduct(client, companyId, productId) {
  const { rows } = await client.query(
    `SELECT * FROM products WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [productId, companyId]
  );
  if (!rows[0]) throw new LocationStockError("Produit introuvable.", "PRODUCT_NOT_FOUND", 404);
  return rows[0];
}

/* ------------------------------------------------------------------ écriture */

/**
 * Applique un delta sur une balance et met à jour l'occupation.
 * `EMPTY` à quantité nulle, `OCCUPIED` sinon — l'emplacement reste EN BASE.
 */
async function applyToBalance(client, companyId, balance, delta) {
  const before = num(balance.quantity);
  const after = before + delta;
  if (after < 0) {
    throw new LocationStockError(
      `Stock insuffisant à cet emplacement : disponible ${before}, demandé ${Math.abs(delta)}.`,
      "LOCATION_STOCK_INSUFFICIENT", 409, { available: before, requested: Math.abs(delta) }
    );
  }
  /* Retirer du stock ne doit jamais laisser une réservation orpheline
     supérieure à ce qui reste physiquement présent. */
  if (num(balance.reserved_quantity) > after) {
    throw new LocationStockError(
      `Cet emplacement porte ${balance.reserved_quantity} unité(s) réservée(s) : impossible de descendre à ${after}. Libérez la réservation d'abord.`,
      "RESERVED_EXCEEDS_REMAINING", 409,
      { reserved: num(balance.reserved_quantity), remaining: after }
    );
  }
  const updated = (await client.query(
    `UPDATE stock_location_balances SET quantity = $1, updated_at = NOW()
      WHERE id = $2 AND company_id = $3 RETURNING *`,
    [after, balance.id, companyId]
  )).rows[0];

  await client.query(
    `UPDATE locations
        SET occupancy_status = $1,
            emptied_at = CASE WHEN $2::numeric = 0 THEN NOW() ELSE emptied_at END,
            updated_at = NOW()
      WHERE id = $3 AND company_id = $4`,
    [after > 0 ? OCCUPANCY.OCCUPIED : OCCUPANCY.EMPTY, after, balance.location_id, companyId]
  );
  return { balance: updated, before, after };
}

/** Écrit le mouvement, avec les stocks avant/après GLOBAUX et par emplacement. */
async function writeMovement(client, {
  companyId, product, type, quantity, globalBefore, globalAfter, user, reason,
  sourceLocation = null, destinationLocation = null,
  locationBefore = null, locationAfter = null,
  destinationBefore = null, destinationAfter = null, status = "Validé",
}) {
  const main = destinationLocation || sourceLocation;
  const { rows } = await client.query(
    `INSERT INTO stock_movements
       (type, product_reference, product_name, product_id, quantity,
        source_warehouse, destination_warehouse, reason, status, company_id,
        created_by, created_by_name, created_by_role,
        location_code, warehouse_id, location_id,
        source_location_id, destination_location_id,
        source_warehouse_id, destination_warehouse_id,
        location_stock_before, location_stock_after,
        destination_stock_before, destination_stock_after,
        approval_status, original_quantity, final_quantity,
        stock_before, stock_after, validated_by, validated_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             $21,$22,$23,$24,$25,$26,$26,$27,$28,$29,NOW(),NOW(),NOW())
     RETURNING *`,
    [
      type, product.reference || null, product.name, product.id, Math.abs(quantity),
      sourceLocation?.warehouse_code || null, destinationLocation?.warehouse_code || null,
      reason, status, companyId,
      user?.id || null, user?.name || user?.email || null, user?.role || null,
      main?.full_code || main?.emplacement_code || null,
      main?.warehouse_id || null, main?.id || null,
      sourceLocation?.id || null, destinationLocation?.id || null,
      sourceLocation?.warehouse_id || null, destinationLocation?.warehouse_id || null,
      locationBefore, locationAfter, destinationBefore, destinationAfter,
      status === "Validé" ? "Approuvé" : "En attente", Math.abs(quantity),
      globalBefore, globalAfter, status === "Validé" ? user?.id || null : null,
    ]
  );
  return rows[0];
}

/**
 * ENTRÉE dans un bin précis. Augmente la balance ET le stock global.
 * C'est l'opération qu'appelle la mise en stock d'une réception.
 */
async function entryAtLocation(client, {
  companyId, productId, locationId, quantity, user, reason = "Entrée",
  type = "Entrée", markManaged = false,
}) {
  const q = num(quantity);
  if (!(q > 0)) throw new LocationStockError("Quantité invalide.", "INVALID_QUANTITY", 400);

  const product = await lockProduct(client, companyId, productId);
  const location = await lockLocation(client, companyId, locationId);
  const balance = await lockBalance(client, companyId, productId, location, { create: true });

  const loc = await applyToBalance(client, companyId, balance, q);
  const globalBefore = num(product.stock);
  const globalAfter = globalBefore + q;
  await client.query(
    `UPDATE products SET stock = $1, ${markManaged ? "location_managed = TRUE," : ""} updated_at = NOW()
      WHERE id = $2 AND company_id = $3`,
    [globalAfter, product.id, companyId]
  );

  const movement = await writeMovement(client, {
    companyId, product, type, quantity: q, globalBefore, globalAfter, user, reason,
    destinationLocation: location, destinationBefore: loc.before, destinationAfter: loc.after,
    locationBefore: loc.before, locationAfter: loc.after,
  });
  if (product.location_managed || markManaged) await assertIntegrity(client, companyId, product.id);
  return {
    movement, balance: loc.balance, location,
    locationBefore: loc.before, locationAfter: loc.after,
    stockBefore: globalBefore, stockAfter: globalAfter,
  };
}

/**
 * SORTIE depuis un bin précis, immédiate (sans préparation).
 * Ne prend jamais dans un autre emplacement de sa propre initiative.
 */
async function exitFromLocation(client, {
  companyId, productId, locationId, quantity, user, reason = "Sortie", type = "Sortie",
}) {
  const q = num(quantity);
  if (!(q > 0)) throw new LocationStockError("Quantité invalide.", "INVALID_QUANTITY", 400);

  const product = await lockProduct(client, companyId, productId);
  const location = await lockLocation(client, companyId, locationId);
  const balance = await lockBalance(client, companyId, productId, location);

  const available = num(balance.quantity) - num(balance.reserved_quantity);
  if (q > available) {
    throw new LocationStockError(
      `Disponible insuffisant à l'emplacement ${location.full_code || location.emplacement_code} : ` +
      `${balance.quantity} présent(s) dont ${balance.reserved_quantity} réservé(s), soit ${available} disponible(s), demandé ${q}.`,
      "LOCATION_STOCK_INSUFFICIENT", 409,
      { quantity: num(balance.quantity), reserved: num(balance.reserved_quantity), available, requested: q }
    );
  }

  const loc = await applyToBalance(client, companyId, balance, -q);
  const globalBefore = num(product.stock);
  const globalAfter = globalBefore - q;
  if (globalAfter < 0) {
    throw new LocationStockError(
      `Stock global insuffisant pour « ${product.name} » : ${globalBefore} disponible, ${q} demandé.`,
      "STOCK_INSUFFICIENT", 409
    );
  }
  await client.query(
    `UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
    [globalAfter, product.id, companyId]
  );

  const movement = await writeMovement(client, {
    companyId, product, type, quantity: q, globalBefore, globalAfter, user, reason,
    sourceLocation: location, locationBefore: loc.before, locationAfter: loc.after,
  });
  if (product.location_managed) await assertIntegrity(client, companyId, product.id);
  return {
    movement, balance: loc.balance, location,
    locationBefore: loc.before, locationAfter: loc.after,
    stockBefore: globalBefore, stockAfter: globalAfter,
  };
}

/* --------------------------------------------------------------- réservation */

/**
 * PRÉPARER une sortie : réserve sans déduire.
 * Le stock physique ne bouge pas, le disponible baisse. Deux préparateurs ne
 * peuvent pas réserver plus que le disponible : la balance est verrouillée.
 */
async function reserveAtLocation(client, {
  companyId, productId, locationId, quantity, user, movementId = null,
}) {
  const q = num(quantity);
  if (!(q > 0)) throw new LocationStockError("Quantité invalide.", "INVALID_QUANTITY", 400);

  const location = await lockLocation(client, companyId, locationId);
  const balance = await lockBalance(client, companyId, productId, location);
  const available = num(balance.quantity) - num(balance.reserved_quantity);
  if (q > available) {
    throw new LocationStockError(
      `Réservation refusée : ${available} disponible(s) à l'emplacement ${location.full_code || location.emplacement_code}, ${q} demandé(s).`,
      "RESERVATION_EXCEEDS_AVAILABLE", 409,
      { quantity: num(balance.quantity), reserved: num(balance.reserved_quantity), available, requested: q }
    );
  }

  const updated = (await client.query(
    `UPDATE stock_location_balances
        SET reserved_quantity = reserved_quantity + $1, updated_at = NOW()
      WHERE id = $2 AND company_id = $3 RETURNING *`,
    [q, balance.id, companyId]
  )).rows[0];

  const reservation = (await client.query(
    `INSERT INTO stock_reservations
       (company_id, balance_id, movement_id, product_id, location_id, quantity, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [companyId, balance.id, movementId, productId, location.id, q, RESERVATION.ACTIVE, user?.id || null]
  )).rows[0];

  return {
    reservation, balance: updated, location,
    /* Preuve à l'écran : la quantité physique n'a pas bougé. */
    quantityBefore: num(balance.quantity), quantityAfter: num(updated.quantity),
    reservedBefore: num(balance.reserved_quantity), reservedAfter: num(updated.reserved_quantity),
    availableAfter: num(updated.quantity) - num(updated.reserved_quantity),
  };
}

/** Annuler une préparation : la réservation est libérée, rien d'autre ne bouge. */
async function releaseReservation(client, { companyId, reservationId, user }) {
  const res = (await client.query(
    `SELECT * FROM stock_reservations WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [reservationId, companyId]
  )).rows[0];
  if (!res) throw new LocationStockError("Réservation introuvable.", "RESERVATION_NOT_FOUND", 404);
  if (res.status !== RESERVATION.ACTIVE) {
    throw new LocationStockError(`Réservation déjà ${res.status}.`, "RESERVATION_NOT_ACTIVE", 409);
  }
  const balance = (await client.query(
    `SELECT * FROM stock_location_balances WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [res.balance_id, companyId]
  )).rows[0];

  const updated = (await client.query(
    `UPDATE stock_location_balances
        SET reserved_quantity = reserved_quantity - $1, updated_at = NOW()
      WHERE id = $2 AND company_id = $3 RETURNING *`,
    [num(res.quantity), balance.id, companyId]
  )).rows[0];
  await client.query(
    `UPDATE stock_reservations SET status = $1, released_at = NOW() WHERE id = $2 AND company_id = $3`,
    [RESERVATION.RELEASED, reservationId, companyId]
  );
  return {
    released: num(res.quantity), balance: updated,
    availableAfter: num(updated.quantity) - num(updated.reserved_quantity),
  };
}

/**
 * VALIDER une sortie préparée : la réservation devient une sortie réelle.
 * quantity -= q ET reserved -= q, donc le disponible ne bouge pas — il avait
 * déjà été retiré à la réservation. Le stock global baisse de q.
 */
async function consumeReservation(client, { companyId, reservationId, user, reason = "Sortie validée" }) {
  const res = (await client.query(
    `SELECT * FROM stock_reservations WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [reservationId, companyId]
  )).rows[0];
  if (!res) throw new LocationStockError("Réservation introuvable.", "RESERVATION_NOT_FOUND", 404);
  if (res.status !== RESERVATION.ACTIVE) {
    throw new LocationStockError(`Réservation déjà ${res.status}.`, "RESERVATION_NOT_ACTIVE", 409);
  }
  const q = num(res.quantity);
  const product = await lockProduct(client, companyId, res.product_id);
  const location = await lockLocation(client, companyId, res.location_id);
  const balance = (await client.query(
    `SELECT * FROM stock_location_balances WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [res.balance_id, companyId]
  )).rows[0];

  const qtyBefore = num(balance.quantity);
  const qtyAfter = qtyBefore - q;
  if (qtyAfter < 0) {
    throw new LocationStockError(
      `Incohérence : la réservation de ${q} dépasse les ${qtyBefore} présents.`,
      "LOCATION_STOCK_INSUFFICIENT", 409
    );
  }
  const updated = (await client.query(
    `UPDATE stock_location_balances
        SET quantity = $1, reserved_quantity = reserved_quantity - $2, updated_at = NOW()
      WHERE id = $3 AND company_id = $4 RETURNING *`,
    [qtyAfter, q, balance.id, companyId]
  )).rows[0];
  await client.query(
    `UPDATE locations
        SET occupancy_status = $1,
            emptied_at = CASE WHEN $2::numeric = 0 THEN NOW() ELSE emptied_at END,
            updated_at = NOW()
      WHERE id = $3 AND company_id = $4`,
    [qtyAfter > 0 ? OCCUPANCY.OCCUPIED : OCCUPANCY.EMPTY, qtyAfter, location.id, companyId]
  );
  await client.query(
    `UPDATE stock_reservations SET status = $1, released_at = NOW() WHERE id = $2 AND company_id = $3`,
    [RESERVATION.CONSUMED, reservationId, companyId]
  );

  const globalBefore = num(product.stock);
  const globalAfter = globalBefore - q;
  if (globalAfter < 0) {
    throw new LocationStockError(
      `Stock global insuffisant pour « ${product.name} ».`, "STOCK_INSUFFICIENT", 409
    );
  }
  await client.query(
    `UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
    [globalAfter, product.id, companyId]
  );

  const movement = await writeMovement(client, {
    companyId, product, type: "Sortie", quantity: q, globalBefore, globalAfter, user, reason,
    sourceLocation: location, locationBefore: qtyBefore, locationAfter: qtyAfter,
  });
  if (product.location_managed) await assertIntegrity(client, companyId, product.id);
  return {
    movement, balance: updated, location,
    locationBefore: qtyBefore, locationAfter: qtyAfter,
    reservedAfter: num(updated.reserved_quantity),
    stockBefore: globalBefore, stockAfter: globalAfter,
  };
}

/* ----------------------------------------------------------------- transfert */

/**
 * TRANSFERT bin → bin. Le stock GLOBAL ne bouge pas d'une seule unité :
 * il n'y a ni entrée ni sortie, seulement un déplacement.
 * Fonctionne dans le même entrepôt comme entre deux entrepôts.
 */
async function transferBetweenLocations(client, {
  companyId, productId, sourceLocationId, destinationLocationId, quantity, user,
  reason = "Transfert interne",
}) {
  const q = num(quantity);
  if (!(q > 0)) throw new LocationStockError("Quantité invalide.", "INVALID_QUANTITY", 400);
  if (Number(sourceLocationId) === Number(destinationLocationId)) {
    throw new LocationStockError(
      "Source et destination identiques.", "SAME_LOCATION", 400
    );
  }

  const product = await lockProduct(client, companyId, productId);
  /* Verrous pris dans un ordre déterministe (id croissant) : deux transferts
     croisés simultanés ne peuvent pas se bloquer mutuellement. */
  const ids = [Number(sourceLocationId), Number(destinationLocationId)].sort((a, b) => a - b);
  const locks = {};
  for (const id of ids) locks[id] = await lockLocation(client, companyId, id);
  const source = locks[sourceLocationId];
  const destination = locks[destinationLocationId];

  const srcBalance = await lockBalance(client, companyId, productId, source);
  const available = num(srcBalance.quantity) - num(srcBalance.reserved_quantity);
  if (q > available) {
    throw new LocationStockError(
      `Disponible insuffisant à la source ${source.full_code || source.emplacement_code} : ` +
      `${available} disponible(s), ${q} demandé(s).`,
      "LOCATION_STOCK_INSUFFICIENT", 409,
      { quantity: num(srcBalance.quantity), reserved: num(srcBalance.reserved_quantity), available, requested: q }
    );
  }
  const dstBalance = await lockBalance(client, companyId, productId, destination, { create: true });

  const src = await applyToBalance(client, companyId, srcBalance, -q);
  const dst = await applyToBalance(client, companyId, dstBalance, q);

  const globalStock = num(product.stock);
  const movement = await writeMovement(client, {
    companyId, product, type: "Transfert", quantity: q,
    globalBefore: globalStock, globalAfter: globalStock,   // strictement inchangé
    user, reason,
    sourceLocation: source, destinationLocation: destination,
    locationBefore: src.before, locationAfter: src.after,
    destinationBefore: dst.before, destinationAfter: dst.after,
  });
  if (product.location_managed) await assertIntegrity(client, companyId, product.id);
  return {
    movement, source, destination,
    sourceBefore: src.before, sourceAfter: src.after,
    destinationBefore: dst.before, destinationAfter: dst.after,
    stockBefore: globalStock, stockAfter: globalStock,
    /* L'emplacement vidé RESTE en base et redevient disponible. */
    sourceEmptied: src.after === 0,
  };
}

/* --------------------------------------------------- répartition manuelle */

/**
 * Établit la répartition d'un produit sur plusieurs emplacements.
 *
 * C'est l'outil de résolution des TO_REVIEW_LOCATION : l'utilisateur dit
 * « 80 en BIN A, 70 en BIN B, 50 en BIN C ». La somme DOIT être exactement
 * égale au stock à répartir — sinon refus. Aucune unité n'est créée ni perdue :
 * `products.stock` n'est pas touché, seule la répartition est écrite.
 */
async function allocateProduct(client, { companyId, productId, allocations = [], user }) {
  if (!allocations.length) {
    throw new LocationStockError("Aucune répartition fournie.", "NO_ALLOCATION", 400);
  }
  const product = await lockProduct(client, companyId, productId);
  const stock = num(product.stock);

  const existing = (await client.query(
    `SELECT COALESCE(SUM(quantity),0)::numeric AS q,
            COALESCE(SUM(reserved_quantity),0)::numeric AS r
       FROM stock_location_balances WHERE company_id = $1 AND product_id = $2`,
    [companyId, productId]
  )).rows[0];
  if (num(existing.q) > 0) {
    throw new LocationStockError(
      `Ce produit a déjà une répartition (${existing.q} unité(s)). Utilisez les transferts pour la corriger.`,
      "ALREADY_ALLOCATED", 409
    );
  }

  const total = allocations.reduce((s, a) => s + num(a.quantity), 0);
  if (total !== stock) {
    throw new LocationStockError(
      `La répartition doit être exactement égale au stock : ${stock} attendu(s), ${total} saisi(s) (écart ${total - stock}).`,
      "ALLOCATION_SUM_MISMATCH", 409, { stock, total, ecart: total - stock }
    );
  }
  const seen = new Set();
  const lignes = [];
  for (const a of allocations) {
    const q = num(a.quantity);
    if (!(q > 0)) throw new LocationStockError("Quantité de répartition invalide.", "INVALID_QUANTITY", 400);
    if (seen.has(Number(a.locationId))) {
      throw new LocationStockError(
        "Le même emplacement apparaît deux fois dans la répartition.", "DUPLICATE_LOCATION", 400
      );
    }
    seen.add(Number(a.locationId));

    const location = await lockLocation(client, companyId, a.locationId);
    const balance = await lockBalance(client, companyId, productId, location, { create: true });
    const applied = await applyToBalance(client, companyId, balance, q);
    lignes.push({ location, quantity: q, after: applied.after });
  }

  /* Le stock global n'est PAS modifié : on ne fait que dire où il se trouve. */
  await client.query(
    `UPDATE products SET location_managed = TRUE, updated_at = NOW()
      WHERE id = $1 AND company_id = $2`,
    [productId, companyId]
  );
  await assertIntegrity(client, companyId, productId);

  return {
    product: { id: product.id, name: product.name, stock },
    lignes: lignes.map((l) => ({
      locationId: l.location.id,
      code: l.location.full_code || l.location.emplacement_code,
      quantity: l.quantity, balanceAfter: l.after,
    })),
    total, stockBefore: stock, stockAfter: stock, stockImpact: 0,
  };
}

/**
 * GARDE-FOU DES ÉCRITURES GLOBALES.
 *
 * Trois routes métier écrivaient `products.stock` directement, hors du moteur :
 * annulation de vente, réception d'achat marketplace, confirmation de demande
 * de stock. Les réécrire entièrement dépasse le périmètre de cette phase ; ce
 * garde-fou garantit en revanche qu'aucune d'elles ne peut désynchroniser la
 * répartition physique :
 *
 *   - produit NON encore réparti : comportement inchangé, stock global ajusté ;
 *   - produit réparti (`location_managed`) : l'emplacement devient OBLIGATOIRE.
 *     Sans lui, l'opération est REFUSÉE plutôt que d'accepter un stock global
 *     que la somme des bins ne justifierait plus.
 *
 * Le filtre company_id est appliqué ici, ce que deux de ces routes omettaient.
 */
async function adjustGlobalStock(client, {
  companyId, productId, delta, user, reason, locationId = null,
  type = null, origin = "route métier",
}) {
  const d = num(delta);
  if (d === 0) return { skipped: true };
  const product = await lockProduct(client, companyId, productId);

  if (product.location_managed) {
    if (!locationId) {
      throw new LocationStockError(
        `« ${product.name} » est géré par emplacement : précisez le bin concerné (${origin}).`,
        "LOCATION_REQUIRED", 409, { productId, origin }
      );
    }
    return d > 0
      ? entryAtLocation(client, {
          companyId, productId, locationId, quantity: d, user,
          reason: reason || origin, type: type || "Entrée",
        })
      : exitFromLocation(client, {
          companyId, productId, locationId, quantity: -d, user,
          reason: reason || origin, type: type || "Sortie",
        });
  }

  const before = num(product.stock);
  const after = before + d;
  if (after < 0) {
    throw new LocationStockError(
      `Stock insuffisant pour « ${product.name} » : ${before} disponible(s), ${Math.abs(d)} demandé(s) (${origin}).`,
      "STOCK_INSUFFICIENT", 409, { available: before, requested: Math.abs(d) }
    );
  }
  await client.query(
    `UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
    [after, product.id, companyId]
  );
  return { stockBefore: before, stockAfter: after, locationManaged: false };
}

/* ------------------------------------------------------ emplacements libres */

/** Emplacements exploitables d'un entrepôt, vides et occupés — jamais supprimés. */
async function availableLocations(runner, companyId, { warehouseId = null, onlyEmpty = false } = {}) {
  const { rows } = await runner.query(
    `SELECT l.id, l.full_code, l.emplacement_code, l.warehouse_id, l.warehouse_code,
            COALESCE(NULLIF(l.rayon_code,''), l.zone)    AS row_code,
            COALESCE(NULLIF(l.case_code,''),  l.rayon)   AS loc_code,
            COALESCE(NULLIF(l.level_code,''), l.etagere) AS lvl_code,
            l.bin_code, l.occupancy_status, l.emptied_at,
            COALESCE(SUM(b.quantity), 0)::numeric          AS quantity,
            COALESCE(SUM(b.reserved_quantity), 0)::numeric AS reserved,
            COUNT(b.id) FILTER (WHERE b.quantity > 0)::int AS produits
       FROM locations l
       LEFT JOIN stock_location_balances b
              ON b.location_id = l.id AND b.company_id = l.company_id
      WHERE l.company_id = $1
        AND COALESCE(l.is_active, TRUE) = TRUE
        AND COALESCE(l.bin_code, '') <> ''
        AND ($2::int IS NULL OR l.warehouse_id = $2)
      GROUP BY l.id
     HAVING ($3::bool = FALSE OR COALESCE(SUM(b.quantity), 0) = 0)
      ORDER BY l.warehouse_code, l.rayon_code, l.case_code, l.level_code, l.bin_code`,
    [companyId, warehouseId, onlyEmpty]
  );
  return rows.map((r) => ({
    ...r,
    available: num(r.quantity) - num(r.reserved),
    status: num(r.quantity) > 0 ? OCCUPANCY.OCCUPIED : OCCUPANCY.EMPTY,
  }));
}

module.exports = {
  OCCUPANCY, RESERVATION, LocationStockError,
  productBalances, checkIntegrity, assertIntegrity, availableLocations,
  lockLocation, lockBalance,
  entryAtLocation, exitFromLocation, adjustGlobalStock,
  reserveAtLocation, releaseReservation, consumeReservation,
  transferBetweenLocations, allocateProduct,
};
