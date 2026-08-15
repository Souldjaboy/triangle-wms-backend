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
const { normName, similarity } = require("../import-inventory/excel-inventory-parser");

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
/* La provenance est tracée, mais elle ne change RIEN au workflow : une
   réception saisie à la main et une réception importée suivent le même
   parcours et produisent le même bon de réception. */
const SOURCE = { MANUAL: "MANUAL", EXCEL: "EXCEL_IMPORT" };
const SOURCE_FR = { MANUAL: "Saisie manuelle", EXCEL_IMPORT: "Import Excel" };

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
  supplierName = null, supplierReference = null, carrier = null,
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
    const merged = Boolean(reception);
    if (merged && reception.status === RECEPTION_STATUS.CANCELLED) {
      throw new ReceptionError(
        `Le conteneur ${containerNumber} a déjà une réception annulée à cette date (${reception.reception_number}). Corrigez la date ou le conteneur.`,
        "RECEPTION_CANCELLED", 409
      );
    }
    /* Le numéro Triangle est TOUJOURS généré ici : il n'est jamais saisi. */
    const number = reception ? reception.reception_number
                             : await nextReceptionNumber(client, companyId);

    if (!reception) reception = (await client.query(
      `INSERT INTO stock_receptions
         (company_id, warehouse_id, warehouse_code, reception_number, container_number,
          reception_date, source, source_file, status, notes, created_by,
          supplier_name, supplier_reference, carrier)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::date,CURRENT_DATE),$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [companyId, warehouse.id, warehouse.code, number, containerNumber,
       receptionDate, source, sourceFile, RECEPTION_STATUS.PENDING, notes, user?.id || null,
       supplierName, supplierReference, carrier]
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
    /* `merged` dit à l'appelant que les lignes ont rejoint une réception
       existante : l'écran doit l'annoncer plutôt que de laisser croire à une
       nouvelle réception. */
    return { reception, lineCount: n - firstLineNo + 1, totalLines: n, merged };
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

    // Statut recalculé depuis les lignes — jamais incrémenté.
    const status = await refreshStatus(client, companyId, receptionId);

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

/* Charge une réception verrouillée, avec le total déjà rangé : toutes les
   corrections ci-dessous en dépendent. */
async function lockReception(client, companyId, receptionId) {
  const reception = (await client.query(
    `SELECT * FROM stock_receptions WHERE id=$1 AND company_id=$2 FOR UPDATE`,
    [receptionId, companyId]
  )).rows[0];
  if (!reception) throw new ReceptionError("Réception introuvable.", "NOT_FOUND", 404);
  if (reception.status === RECEPTION_STATUS.CANCELLED) {
    throw new ReceptionError("Réception annulée : elle n'est plus modifiable.", "CANCELLED", 409);
  }
  const putaway = Number((await client.query(
    `SELECT COALESCE(SUM(quantity_putaway),0) AS q FROM stock_reception_lines
      WHERE reception_id=$1 AND company_id=$2`, [receptionId, companyId]
  )).rows[0].q);
  return { reception, putaway };
}

/** Recalcule le statut depuis les lignes — jamais incrémenté à la main. */
async function refreshStatus(client, companyId, receptionId) {
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
  return status;
}

/**
 * Corrige l'en-tête d'une réception.
 *
 * Fournisseur, BL, transporteur et notes restent corrigibles à tout moment :
 * ils n'ont aucun effet sur le stock. Le conteneur et la date, eux, sont figés
 * dès qu'une ligne est rangée — ils figurent sur les bons de mise en stock déjà
 * émis, qu'une correction rétroactive rendrait faux.
 */
async function updateReception(pool, { companyId, receptionId, patch = {}, user }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { reception, putaway } = await lockReception(client, companyId, receptionId);

    const touchesIdentity = ["containerNumber", "receptionDate"].some((k) => k in patch);
    if (touchesIdentity && putaway > 0) {
      throw new ReceptionError(
        `Conteneur et date figés : ${putaway} unité(s) de cette réception sont déjà rangées et figurent sur des bons de mise en stock émis.`,
        "PUTAWAY_LOCKED", 409, { putaway }
      );
    }

    const map = {
      containerNumber: "container_number", receptionDate: "reception_date",
      supplierName: "supplier_name", supplierReference: "supplier_reference",
      carrier: "carrier", notes: "notes",
    };
    const sets = [], vals = [];
    for (const [key, col] of Object.entries(map)) {
      if (!(key in patch)) continue;
      vals.push(patch[key] === "" ? null : patch[key]);
      sets.push(`${col}=$${vals.length}${col === "reception_date" ? "::date" : ""}`);
    }
    if (!sets.length) {
      await client.query("ROLLBACK");
      return { reception, changed: 0 };
    }
    vals.push(user?.id || null); sets.push(`updated_by=$${vals.length}`);
    vals.push(receptionId, companyId);
    let updated;
    try {
      updated = (await client.query(
        `UPDATE stock_receptions SET ${sets.join(", ")}, updated_at=NOW()
          WHERE id=$${vals.length - 1} AND company_id=$${vals.length} RETURNING *`,
        vals
      )).rows[0];
    } catch (e) {
      /* L'index unique (entreprise, conteneur, date) protège contre le doublon :
         on traduit l'erreur SQL en message métier au lieu d'un 500. */
      if (e.code === "23505") {
        throw new ReceptionError(
          "Une autre réception existe déjà pour ce conteneur à cette date.",
          "DUPLICATE_CONTAINER", 409
        );
      }
      throw e;
    }
    await client.query("COMMIT");
    return { reception: updated, changed: sets.length - 1 };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/** Ajoute des lignes à une réception existante, sans toucher au stock. */
async function addReceptionLines(pool, { companyId, receptionId, lines = [], user }) {
  if (!lines.length) throw new ReceptionError("Aucune ligne à ajouter.", "NO_LINES", 400);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { reception } = await lockReception(client, companyId, receptionId);

    let n = Number((await client.query(
      `SELECT COALESCE(MAX(line_no),0) AS m FROM stock_reception_lines
        WHERE reception_id=$1 AND company_id=$2`, [receptionId, companyId]
    )).rows[0].m);
    const added = [];
    for (const l of lines) {
      const qty = Number(l.quantity);
      if (!(qty > 0)) throw new ReceptionError("Quantité invalide.", "INVALID_QUANTITY", 400);
      if (!String(l.label || "").trim()) {
        throw new ReceptionError("Désignation reçue obligatoire.", "LABEL_REQUIRED", 400);
      }
      n += 1;
      const lw = await ensureWarehouse(client, companyId, l.warehouseCode || reception.warehouse_code);
      const row = (await client.query(
        `INSERT INTO stock_reception_lines
           (company_id, reception_id, line_no, received_label, product_id, match_status,
            unit, quantity_received, supplier_reference, notes, warehouse_id, warehouse_code,
            updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [companyId, receptionId, n, String(l.label).trim(), l.productId || null,
         l.productId ? MATCH_STATUS.MATCHED : MATCH_STATUS.REVIEW,
         l.unit || "EACH", qty, l.supplierReference || null, l.notes || null,
         lw.warehouse.id, lw.warehouse.code, user?.id || null]
      )).rows[0];
      added.push(row);
    }
    const status = await refreshStatus(client, companyId, receptionId);
    await client.query("COMMIT");
    return { added, status, stockImpact: 0 };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/**
 * Corrige une ligne. Dès qu'une partie est rangée, les champs à effet stock —
 * produit, quantité reçue, unité, entrepôt — sont refusés : le mouvement déjà
 * passé ne correspondrait plus à la ligne qui l'a produit. Les notes et la
 * référence fournisseur restent corrigibles.
 */
const STOCK_IMPACT_FIELDS = ["productId", "quantity", "unit", "warehouseCode"];

async function updateReceptionLine(pool, { companyId, receptionId, lineId, patch = {}, user }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockReception(client, companyId, receptionId);
    const line = (await client.query(
      `SELECT * FROM stock_reception_lines
        WHERE id=$1 AND reception_id=$2 AND company_id=$3 FOR UPDATE`,
      [lineId, receptionId, companyId]
    )).rows[0];
    if (!line) throw new ReceptionError("Ligne introuvable.", "LINE_NOT_FOUND", 404);

    const already = Number(line.quantity_putaway);
    const touched = STOCK_IMPACT_FIELDS.filter((k) => k in patch);
    if (already > 0 && touched.length) {
      throw new ReceptionError(
        `Ligne déjà rangée (${already}/${Number(line.quantity_received)}) : produit, quantité, unité et entrepôt ne sont plus modifiables. Passez par un mouvement de correction.`,
        "LINE_PUTAWAY_LOCKED", 409, { putaway: already, fields: touched }
      );
    }

    const sets = [], vals = [];
    const push = (col, v, cast = "") => { vals.push(v); sets.push(`${col}=$${vals.length}${cast}`); };
    if ("label" in patch) {
      if (!String(patch.label || "").trim()) {
        throw new ReceptionError("Désignation reçue obligatoire.", "LABEL_REQUIRED", 400);
      }
      push("received_label", String(patch.label).trim());
    }
    if ("quantity" in patch) {
      const q = Number(patch.quantity);
      if (!(q > 0)) throw new ReceptionError("Quantité invalide.", "INVALID_QUANTITY", 400);
      /* Garde-fou applicatif doublé du CHECK en base : jamais moins que rangé. */
      if (q < already) {
        throw new ReceptionError(
          `Quantité reçue (${q}) inférieure à la quantité déjà rangée (${already}).`,
          "BELOW_PUTAWAY", 409
        );
      }
      push("quantity_received", q);
    }
    if ("unit" in patch) push("unit", patch.unit || "EACH");
    if ("notes" in patch) push("notes", patch.notes || null);
    if ("supplierReference" in patch) push("supplier_reference", patch.supplierReference || null);
    if ("productId" in patch) {
      const pid = patch.productId ? Number(patch.productId) : null;
      if (pid) {
        const ok = (await client.query(
          `SELECT id FROM products WHERE id=$1 AND company_id=$2`, [pid, companyId]
        )).rows[0];
        if (!ok) throw new ReceptionError("Produit introuvable.", "PRODUCT_NOT_FOUND", 404);
      }
      push("product_id", pid);
      /* Retirer le produit d'une ligne la ramène à TO_REVIEW : elle redevient
         non rangeable, ce qui est exactement l'effet voulu. */
      push("match_status", pid ? MATCH_STATUS.MATCHED : MATCH_STATUS.REVIEW);
    }
    if ("warehouseCode" in patch) {
      const lw = await ensureWarehouse(client, companyId, patch.warehouseCode);
      push("warehouse_id", lw.warehouse.id);
      push("warehouse_code", lw.warehouse.code);
    }
    if (!sets.length) {
      await client.query("ROLLBACK");
      return { line, changed: 0 };
    }
    push("updated_by", user?.id || null);
    vals.push(lineId, companyId);
    const updated = (await client.query(
      `UPDATE stock_reception_lines SET ${sets.join(", ")}, updated_at=NOW()
        WHERE id=$${vals.length - 1} AND company_id=$${vals.length} RETURNING *`,
      vals
    )).rows[0];
    const status = await refreshStatus(client, companyId, receptionId);
    await client.query("COMMIT");
    return { line: updated, status, changed: sets.length - 1, stockImpact: 0 };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/** Supprime une ligne non rangée. Une ligne rangée n'est jamais supprimée. */
async function deleteReceptionLine(pool, { companyId, receptionId, lineId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockReception(client, companyId, receptionId);
    const line = (await client.query(
      `SELECT * FROM stock_reception_lines
        WHERE id=$1 AND reception_id=$2 AND company_id=$3 FOR UPDATE`,
      [lineId, receptionId, companyId]
    )).rows[0];
    if (!line) throw new ReceptionError("Ligne introuvable.", "LINE_NOT_FOUND", 404);
    if (Number(line.quantity_putaway) > 0) {
      throw new ReceptionError(
        `Ligne déjà rangée (${Number(line.quantity_putaway)}) : elle ne peut pas être supprimée. Passez par un mouvement de correction.`,
        "LINE_PUTAWAY_LOCKED", 409
      );
    }
    await client.query(
      `DELETE FROM stock_reception_lines WHERE id=$1 AND company_id=$2`, [lineId, companyId]
    );
    const status = await refreshStatus(client, companyId, receptionId);
    await client.query("COMMIT");
    return { deleted: lineId, status, stockImpact: 0 };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/**
 * Annule une réception. Rien n'est supprimé : la réception reste visible avec
 * son historique. Si une seule unité a été rangée, l'annulation est refusée —
 * il faudrait alors un mouvement inverse, qui relève du moteur de stock et non
 * d'un changement de statut.
 */
async function cancelReception(pool, { companyId, receptionId, reason = null, user }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { reception, putaway } = await lockReception(client, companyId, receptionId);
    if (putaway > 0) {
      throw new ReceptionError(
        `Annulation impossible : ${putaway} unité(s) sont déjà en stock. Corrigez-les par un mouvement inverse avant d'annuler.`,
        "ALREADY_PUTAWAY", 409, { putaway }
      );
    }
    const updated = (await client.query(
      `UPDATE stock_receptions
          SET status=$1, cancelled_at=NOW(), cancelled_by=$2, cancel_reason=$3,
              updated_by=$2, updated_at=NOW()
        WHERE id=$4 AND company_id=$5 RETURNING *`,
      [RECEPTION_STATUS.CANCELLED, user?.id || null, reason, receptionId, companyId]
    )).rows[0];
    await client.query("COMMIT");
    return { reception: updated, stockImpact: 0 };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/**
 * AIDE AU RAPPROCHEMENT — propose, ne décide jamais.
 *
 * Les scores servent à ordonner des propositions à l'écran. Aucune association
 * n'est appliquée automatiquement, quel que soit le score : c'est l'utilisateur
 * qui confirme. Deux produits ne sont jamais fusionnés par similarité.
 */
async function suggestProducts(runner, companyId, label, limit = 3) {
  const norm = normName(label);
  const { rows } = await runner.query(
    `SELECT id, name, reference, stock, unit, category, warehouse
       FROM products WHERE company_id=$1 AND COALESCE(is_active,TRUE)=TRUE`,
    [companyId]
  );
  const scored = rows.map((p) => {
    const pn = normName(p.name);
    let score = similarity(norm, pn);
    // Un libellé entièrement contenu dans l'autre est un indice fort mais non décisif.
    if (score < 1 && (pn.includes(norm) || norm.includes(pn))) {
      score = Math.max(score, 0.85);
    }
    return { ...p, score: Math.round(score * 100), exact: pn === norm };
  });
  const exact = scored.filter((s) => s.exact);
  return {
    normalizedLabel: norm,
    /* Plusieurs correspondances exactes = ambiguïté : on l'affiche au lieu de
       trancher. */
    exactCount: exact.length,
    suggestions: scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map(({ exact: _e, ...s }) => s),
  };
}

/** Référence produit — même convention que le moteur d'import (`IMP-…`). */
function productReferenceFor(label) {
  return `IMP-${String(label).toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 40)}`;
}

/**
 * Confirme le produit d'une ligne. `applyToIdentical` n'étend la confirmation
 * qu'aux lignes dont le libellé normalisé est STRICTEMENT identique — jamais
 * entre deux libellés différents, si proches soient-ils.
 */
async function confirmLineProduct(pool, {
  companyId, lineId, productId, applyToIdentical = false, receptionId = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const line = (await client.query(
      `SELECT * FROM stock_reception_lines WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [lineId, companyId]
    )).rows[0];
    if (!line) throw new ReceptionError("Ligne de réception introuvable.", "LINE_NOT_FOUND", 404);

    const product = (await client.query(
      `SELECT id, name FROM products WHERE id=$1 AND company_id=$2`, [productId, companyId]
    )).rows[0];
    if (!product) throw new ReceptionError("Produit introuvable.", "PRODUCT_NOT_FOUND", 404);

    /* Une ligne déjà rangée garde son produit : changer la cible après coup
       rendrait le mouvement de stock incohérent. */
    if (Number(line.quantity_putaway) > 0 && Number(line.product_id) !== Number(productId)) {
      throw new ReceptionError(
        "Cette ligne est déjà partiellement rangée : son produit ne peut plus être changé.",
        "ALREADY_PUTAWAY_LOCKED", 409
      );
    }

    const applied = [];
    const target = applyToIdentical
      ? (await client.query(
          `SELECT l.id, l.received_label, l.quantity_putaway
             FROM stock_reception_lines l
            WHERE l.company_id=$1 AND l.quantity_putaway=0
              AND ($2::int IS NULL OR l.reception_id=$2)
            FOR UPDATE`,
          [companyId, receptionId]
        )).rows.filter((l) => normName(l.received_label) === normName(line.received_label))
      : [{ id: line.id }];

    for (const t of target) {
      await client.query(
        `UPDATE stock_reception_lines
            SET product_id=$1, match_status=$2, updated_at=NOW()
          WHERE id=$3 AND company_id=$4`,
        [productId, MATCH_STATUS.MATCHED, t.id, companyId]
      );
      applied.push(t.id);
    }
    await client.query("COMMIT");
    return { product, lineIds: applied, count: applied.length };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/**
 * Crée la fiche produit d'une ligne inconnue, puis l'associe. Stock initial 0 :
 * la marchandise n'entre en stock qu'à la mise en stock, jamais à la création.
 */
async function createProductForLine(pool, {
  companyId, lineId, name = null, unit = null, category = null, reference = null, user,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const line = (await client.query(
      `SELECT * FROM stock_reception_lines WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [lineId, companyId]
    )).rows[0];
    if (!line) throw new ReceptionError("Ligne de réception introuvable.", "LINE_NOT_FOUND", 404);
    if (line.product_id) {
      throw new ReceptionError("Cette ligne a déjà un produit associé.", "ALREADY_MATCHED", 409);
    }

    const label = String(name || line.received_label).trim();
    if (!label) throw new ReceptionError("Nom de produit requis.", "NAME_REQUIRED", 400);

    /* On ne crée jamais un doublon d'une fiche existante : si le nom normalisé
       existe déjà, c'est une association, pas une création. */
    const clash = (await client.query(
      `SELECT id, name FROM products WHERE company_id=$1 AND COALESCE(is_active,TRUE)=TRUE`,
      [companyId]
    )).rows.filter((p) => normName(p.name) === normName(label));
    if (clash.length) {
      throw new ReceptionError(
        `Un produit portant ce nom existe déjà (« ${clash[0].name} »). Associez-le au lieu d'en créer un second.`,
        "PRODUCT_EXISTS", 409, { existing: clash }
      );
    }

    const { rows } = await client.query(
      `INSERT INTO products (company_id, name, reference, stock, unit, category, warehouse,
                             is_active, created_at, updated_at)
       VALUES ($1,$2,$3,0,$4,$5,$6,TRUE,NOW(),NOW()) RETURNING id, name, reference, unit, stock`,
      [companyId, label, reference || productReferenceFor(label),
       unit || line.unit || "EACH", category || "", line.warehouse_code || ""]
    );
    const product = rows[0];

    await client.query(
      `UPDATE stock_reception_lines
          SET product_id=$1, match_status=$2, updated_at=NOW()
        WHERE id=$3 AND company_id=$4`,
      [product.id, MATCH_STATUS.MATCHED, lineId, companyId]
    );
    await client.query("COMMIT");
    return { product, createdBy: user?.id || null };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/**
 * Situation par entrepôt. Le stock disponible et la quantité en attente de
 * rangement sont deux colonnes DISTINCTES : on ne les additionne jamais, sans
 * quoi une marchandise encore sur le quai serait comptée comme disponible.
 */
async function warehouseSummary(runner, companyId) {
  const { rows } = await runner.query(
    `WITH pending AS (
       SELECT l.warehouse_code AS code,
              COALESCE(SUM(l.quantity_received - l.quantity_putaway),0)::numeric AS qty,
              COUNT(DISTINCT l.reception_id) FILTER (
                WHERE l.quantity_received > l.quantity_putaway)::int AS receptions
         FROM stock_reception_lines l
         JOIN stock_receptions r ON r.id=l.reception_id AND r.company_id=l.company_id
        WHERE l.company_id=$1 AND r.status <> 'CANCELLED'
        GROUP BY l.warehouse_code
     ), putaway AS (
       SELECT warehouse_code AS code,
              COALESCE(SUM(quantity),0)::numeric AS qty
         FROM stock_putaways WHERE company_id=$1 GROUP BY warehouse_code
     ), stocked AS (
       SELECT warehouse AS code, COALESCE(SUM(stock),0)::numeric AS qty,
              COUNT(*)::int AS products
         FROM products
        WHERE company_id=$1 AND COALESCE(is_active,TRUE)=TRUE
        GROUP BY warehouse
     )
     SELECT w.id, w.code, w.name, w.status,
            COALESCE(s.qty,0)::numeric      AS stock_available,
            COALESCE(s.products,0)::int     AS product_count,
            COALESCE(pw.qty,0)::numeric     AS quantity_putaway,
            COALESCE(p.qty,0)::numeric      AS quantity_pending,
            COALESCE(p.receptions,0)::int   AS receptions_pending
       FROM warehouses w
       LEFT JOIN pending  p  ON UPPER(p.code)  = UPPER(w.code)
       LEFT JOIN putaway  pw ON UPPER(pw.code) = UPPER(w.code)
       LEFT JOIN stocked  s  ON UPPER(s.code)  = UPPER(w.code)
      WHERE w.company_id=$1
      ORDER BY w.code`,
    [companyId]
  );
  return rows;
}

/** Indicateurs de tableau de bord — disponible et en attente restent séparés. */
async function receptionDashboard(runner, companyId) {
  const { rows } = await runner.query(
    `SELECT
       (SELECT COALESCE(SUM(stock),0)::numeric FROM products
         WHERE company_id=$1 AND COALESCE(is_active,TRUE)=TRUE)          AS stock_available,
       (SELECT COUNT(*)::int FROM stock_receptions
         WHERE company_id=$1 AND status='RECEIVED_PENDING_PUTAWAY')      AS receptions_pending,
       (SELECT COUNT(*)::int FROM stock_receptions
         WHERE company_id=$1 AND status='PARTIALLY_PUTAWAY')             AS receptions_partial,
       (SELECT COUNT(*)::int FROM stock_receptions
         WHERE company_id=$1 AND status='PUTAWAY_COMPLETED')             AS receptions_completed,
       (SELECT COALESCE(SUM(l.quantity_received - l.quantity_putaway),0)::numeric
          FROM stock_reception_lines l
          JOIN stock_receptions r ON r.id=l.reception_id AND r.company_id=l.company_id
         WHERE l.company_id=$1 AND r.status <> 'CANCELLED')              AS quantity_pending,
       (SELECT COUNT(*)::int FROM stock_reception_lines l
          JOIN stock_receptions r ON r.id=l.reception_id AND r.company_id=l.company_id
         WHERE l.company_id=$1 AND l.match_status='TO_REVIEW'
           AND r.status <> 'CANCELLED')                                  AS lines_to_review`,
    [companyId]
  );
  return rows[0];
}

module.exports = {
  RECEPTION_STATUS, STATUS_FR, MATCH_STATUS, SOURCE, SOURCE_FR, ReceptionError,
  ensureWarehouse, createReception, putaway, receptionTotals, nextReceptionNumber,
  suggestProducts, confirmLineProduct, createProductForLine, productReferenceFor,
  warehouseSummary, receptionDashboard,
  updateReception, addReceptionLines, updateReceptionLine, deleteReceptionLine,
  cancelReception, refreshStatus,
};
