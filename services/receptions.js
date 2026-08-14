"use strict";

/**
 * RÉCEPTIONS CONTENEUR ET MISE EN STOCK.
 *
 * Règle fondatrice : RÉCEPTION ≠ ENTRÉE EN STOCK.
 *   - enregistrer une réception ne touche AUCUN stock ;
 *   - seule la mise en stock crée un mouvement, via le moteur partagé
 *     services/stock-operations.js — aucune logique de stock n'est réécrite ici.
 *
 * Le flux : conteneur reçu -> réception -> en attente -> contrôle ->
 * affectation d'emplacement -> mise en stock -> stock disponible.
 */

const stockOps = require("./stock-operations");

const RECEPTION_STATUS = {
  PENDING: "RECEIVED_PENDING_PUTAWAY",
  PARTIAL: "PARTIALLY_PUTAWAY",
  COMPLETED: "PUTAWAY_COMPLETED",
  CANCELLED: "CANCELLED",
};
const STATUS_FR = {
  RECEIVED_PENDING_PUTAWAY: "En attente de mise en stock",
  PARTIALLY_PUTAWAY: "Mise en stock partielle",
  PUTAWAY_COMPLETED: "Mise en stock terminée",
  CANCELLED: "Annulée",
};
const MATCH_STATUS = {
  MATCHED: "MATCH_EXISTING",
  NEW: "CREATE_NEW_PRODUCT",
  REVIEW: "TO_REVIEW",
};

class ReceptionError extends Error {
  constructor(message, code, httpStatus = 409, details = {}) {
    super(message);
    this.code = code; this.httpStatus = httpStatus; this.details = details;
  }
}

/* Entrepôt créé seulement s'il manque — jamais de doublon, aucun impact stock. */
async function ensureWarehouse(client, companyId, code, name = null) {
  const found = (await client.query(
    `SELECT * FROM warehouses WHERE company_id=$1 AND UPPER(code)=UPPER($2) LIMIT 1`,
    [companyId, code]
  )).rows[0];
  if (found) return { warehouse: found, created: false };
  const { rows } = await client.query(
    `INSERT INTO warehouses (code, name, status, company_id, created_at, updated_at)
     VALUES ($1,$2,'actif',$3,NOW(),NOW()) RETURNING *`,
    [code, name || code, companyId]
  );
  return { warehouse: rows[0], created: true };
}

async function nextReceptionNumber(client, companyId) {
  const d = new Date();
  const stamp = String(d.getFullYear()).slice(2)
    + String(d.getMonth() + 1).padStart(2, "0")
    + String(d.getDate()).padStart(2, "0");
  const { rows } = await client.query(
    `INSERT INTO stock_request_counters (company_id, year, prefix, last_seq)
     VALUES ($1,$2,$3,1)
     ON CONFLICT (company_id, year, prefix)
     DO UPDATE SET last_seq = stock_request_counters.last_seq + 1
     RETURNING last_seq`,
    [companyId, d.getFullYear(), `BR#${stamp}`]
  );
  return `BR-${stamp}-${String(rows[0].last_seq).padStart(3, "0")}`;
}

/**
 * Enregistre une réception. AUCUN stock n'est modifié : les marchandises sont
 * sur le quai, pas encore rangées.
 */
async function createReception(pool, {
  companyId, warehouseCode, containerNumber = null, receptionDate = null,
  source = null, sourceFile = null, notes = null, lines = [], user,
}) {
  if (!lines.length) throw new ReceptionError("Aucune ligne à réceptionner.", "NO_LINES", 400);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { warehouse } = await ensureWarehouse(client, companyId, warehouseCode);

    /* UN SEUL conteneur = UNE SEULE réception. Si (conteneur, date) existe
       déjà, on y AJOUTE les lignes au lieu de créer un doublon. */
    let reception = null;
    if (containerNumber) {
      reception = (await client.query(
        `SELECT * FROM stock_receptions
          WHERE company_id=$1 AND container_number=$2
            AND reception_date=COALESCE($3::date, CURRENT_DATE)
          FOR UPDATE`,
        [companyId, containerNumber, receptionDate]
      )).rows[0] || null;
    }
    const number = reception ? reception.reception_number
                             : await nextReceptionNumber(client, companyId);

    if (!reception) reception = (await client.query(
      `INSERT INTO stock_receptions
         (company_id, warehouse_id, warehouse_code, reception_number, container_number,
          reception_date, source, source_file, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::date,CURRENT_DATE),$7,$8,$9,$10,$11)
       RETURNING *`,
      [companyId, warehouse.id, warehouse.code, number, containerNumber,
       receptionDate, source, sourceFile, RECEPTION_STATUS.PENDING, notes, user?.id || null]
    )).rows[0];

    /* Numérotation reprise après les lignes déjà présentes : ajouter les lignes
       W-EM2S-C à une réception existante ne doit pas repartir de 1. */
    let n = Number((await client.query(
      `SELECT COALESCE(MAX(line_no),0) AS m FROM stock_reception_lines
        WHERE reception_id=$1 AND company_id=$2`, [reception.id, companyId]
    )).rows[0].m);
    const firstLineNo = n + 1;
    for (const l of lines) {
      n += 1;
      /* Chaque ligne porte SA destination : un conteneur peut être déchargé
         sur plusieurs entrepôts. L'entrepôt d'en-tête ne sert que de défaut. */
      const lw = await ensureWarehouse(client, companyId, l.warehouseCode || warehouseCode);
      await client.query(
        `INSERT INTO stock_reception_lines
           (company_id, reception_id, line_no, received_label, product_id, match_status,
            unit, quantity_received, excel_sheet, excel_row, notes,
            warehouse_id, warehouse_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [companyId, reception.id, n, l.label, l.productId || null,
         l.matchStatus || (l.productId ? MATCH_STATUS.MATCHED : MATCH_STATUS.REVIEW),
         l.unit || "EACH", l.quantity, l.sheet || null, l.excelRow || null, l.notes || null,
         lw.warehouse.id, lw.warehouse.code]
      );
    }

    await client.query("COMMIT");
    return { reception, lineCount: n - firstLineNo + 1, totalLines: n };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/**
 * Met en stock tout ou partie d'une ligne de réception. C'est la SEULE
 * opération qui augmente le stock disponible.
 */
async function putaway(pool, {
  companyId, receptionId, lineId, quantity, productId = null,
  locationCode = null, locationId = null, user,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    /* Verrous : réception puis ligne. Deux clics simultanés sont sérialisés,
       le second verra la quantité déjà rangée par le premier. */
    const reception = (await client.query(
      `SELECT * FROM stock_receptions WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [receptionId, companyId]
    )).rows[0];
    if (!reception) throw new ReceptionError("Réception introuvable.", "NOT_FOUND", 404);
    if (reception.status === RECEPTION_STATUS.CANCELLED) {
      throw new ReceptionError("Réception annulée.", "CANCELLED", 409);
    }

    const line = (await client.query(
      `SELECT * FROM stock_reception_lines
        WHERE id=$1 AND reception_id=$2 AND company_id=$3 FOR UPDATE`,
      [lineId, receptionId, companyId]
    )).rows[0];
    if (!line) throw new ReceptionError("Ligne de réception introuvable.", "LINE_NOT_FOUND", 404);

    const received = Number(line.quantity_received);
    const already = Number(line.quantity_putaway);
    const remaining = received - already;
    if (remaining <= 0) {
      throw new ReceptionError(
        `Ligne déjà entièrement rangée (${already}/${received}).`, "ALREADY_PUTAWAY", 409
      );
    }
    const qty = Number(quantity);
    if (!(qty > 0)) throw new ReceptionError("Quantité invalide.", "INVALID_QUANTITY", 400);
    if (qty > remaining) {
      throw new ReceptionError(
        `Quantité supérieure au reste à ranger (${remaining}).`, "OVER_REMAINING", 409,
        { received, already, remaining }
      );
    }

    /* Le produit doit être confirmé par l'utilisateur : on ne devine jamais une
       correspondance, et on ne crée aucune fiche automatiquement. */
    const pid = productId || line.product_id;
    if (!pid) {
      throw new ReceptionError(
        "Aucun produit confirmé pour cette ligne. Associez ou créez le produit avant la mise en stock.",
        "PRODUCT_NOT_CONFIRMED", 409
      );
    }
    if (line.match_status === MATCH_STATUS.REVIEW && !productId) {
      throw new ReceptionError(
        "Cette ligne est marquée TO_REVIEW : confirmez explicitement le produit.",
        "REVIEW_REQUIRED", 409
      );
    }

    // Entrée réelle par le moteur partagé — stock_before / stock_after inclus.
    const applied = await stockOps.createEntry(client, {
      companyId, productId: pid, quantity: qty, user,
      reason: `Mise en stock réception ${reception.reception_number}`,
      destinationWarehouse: line.warehouse_code || reception.warehouse_code,
      locationCode, locationId,
      sourceReference: reception.reception_number,
    });
    await client.query(
      `UPDATE stock_movements SET reception_id=$1 WHERE id=$2 AND company_id=$3`,
      [receptionId, applied.movement.id, companyId]
    );

    await client.query(
      `INSERT INTO stock_putaways
         (company_id, reception_id, reception_line_id, product_id, movement_id,
          quantity, stock_before, stock_after, warehouse_code, location_id,
          location_code, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [companyId, receptionId, lineId, pid, applied.movement.id, qty,
       applied.stockBefore, applied.stockAfter, line.warehouse_code || reception.warehouse_code,
       locationId, locationCode, user?.id || null]
    );

    const newPutaway = already + qty;
    await client.query(
      `UPDATE stock_reception_lines
          SET quantity_putaway=$1, product_id=COALESCE(product_id,$2),
              match_status=CASE WHEN $2::int IS NOT NULL THEN $3 ELSE match_status END,
              updated_at=NOW()
        WHERE id=$4 AND company_id=$5`,
      [newPutaway, pid, MATCH_STATUS.MATCHED, lineId, companyId]
    );

    /* Statut de la réception recalculé depuis les lignes — jamais incrémenté. */
    const agg = (await client.query(
      `SELECT COALESCE(SUM(quantity_received),0) AS recv,
              COALESCE(SUM(quantity_putaway),0)  AS put
         FROM stock_reception_lines WHERE reception_id=$1 AND company_id=$2`,
      [receptionId, companyId]
    )).rows[0];
    const status = Number(agg.put) <= 0 ? RECEPTION_STATUS.PENDING
      : Number(agg.put) >= Number(agg.recv) ? RECEPTION_STATUS.COMPLETED
      : RECEPTION_STATUS.PARTIAL;
    await client.query(
      `UPDATE stock_receptions SET status=$1, updated_at=NOW() WHERE id=$2 AND company_id=$3`,
      [status, receptionId, companyId]
    );

    await client.query("COMMIT");
    return {
      movement: applied.movement, stockBefore: applied.stockBefore,
      stockAfter: applied.stockAfter, linePutaway: newPutaway,
      lineRemaining: received - newPutaway, receptionStatus: status,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/** Totaux d'une réception : reçu, rangé, en attente. */
async function receptionTotals(runner, companyId, receptionId) {
  const { rows } = await runner.query(
    `SELECT COUNT(*)::int AS lines,
            COALESCE(SUM(quantity_received),0)::numeric AS received,
            COALESCE(SUM(quantity_putaway),0)::numeric  AS putaway,
            COALESCE(SUM(quantity_received - quantity_putaway),0)::numeric AS pending,
            COUNT(*) FILTER (WHERE match_status='TO_REVIEW')::int AS to_review
       FROM stock_reception_lines WHERE company_id=$1 AND reception_id=$2`,
    [companyId, receptionId]
  );
  return rows[0];
}

module.exports = {
  RECEPTION_STATUS, STATUS_FR, MATCH_STATUS, ReceptionError,
  ensureWarehouse, createReception, putaway, receptionTotals, nextReceptionNumber,
};
