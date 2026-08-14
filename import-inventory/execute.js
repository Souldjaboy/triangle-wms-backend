"use strict";

/**
 * ORCHESTRATEUR D'IMPORT D'INVENTAIRE.
 *
 * Ne contient AUCUNE logique de stock : il enchaîne les opérations du service
 * partagé services/stock-operations.js, dans UNE transaction unique. Si une
 * seule étape échoue, tout est annulé — il ne peut pas rester un bon sans
 * mouvement, ni un stock modifié sans document.
 *
 * Ordre d'exécution, conforme à la décision du responsable :
 *   1. produits manquants créés (stock 0, alimenté ensuite par un mouvement) ;
 *   2. AJUSTEMENTS PRÉALABLES : le stock est aligné sur la quantité
 *      physiquement constatée — un comptage est un état, pas une variation ;
 *   3. ENTRÉES puis SORTIES : les vraies variations s'appliquent ensuite, ce
 *      qui rend possible une sortie supérieure au stock initialement connu ;
 *   4. WRITE-OFF des seuls nouveaux rebuts ;
 *   5. inventaire récapitulatif.
 *
 * Les cas AMBIGUOUS_PRODUCT, TO_REVIEW et MISSING_EXCEL_QUANTITY ne sont JAMAIS
 * exécutés : leur stock reste celui de la base.
 */

const crypto = require("crypto");
const stockOps = require("../services/stock-operations");

const IMPORT_STATUS = { PENDING: "PENDING", COMPLETED: "COMPLETED", FAILED: "FAILED", ROLLED_BACK: "ROLLED_BACK" };

function fileHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** Numéro de document, séquentiel et propre à l'entreprise. */
async function nextDocNumber(client, companyId, prefix) {
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
    [companyId, d.getFullYear(), `${prefix}#${stamp}`]
  );
  return `${prefix}-${stamp}-${String(rows[0].last_seq).padStart(3, "0")}`;
}

/* Bon d'entrée / de sortie : on réutilise stock_documents, le moteur
   documentaire existant. request_id reste nul — le document ne provient pas
   d'une demande de stock mais d'un import d'inventaire. */
async function createDocument(client, { companyId, docType, prefix, user }) {
  const number = await nextDocNumber(client, companyId, prefix);
  const { rows } = await client.query(
    `INSERT INTO stock_documents
       (company_id, request_id, doc_number, doc_type, status,
        received_by_name, received_at_date, generated_by, created_at)
     VALUES ($1, NULL, $2, $3, 'VALIDE', $4, CURRENT_DATE, $5, NOW())
     RETURNING *`,
    [companyId, number, docType, user?.name || "Import Excel", user?.id || null]
  );
  return rows[0];
}

/**
 * Vérifie l'idempotence PUIS exécute. Le contrôle et l'insertion du journal
 * sont dans la même transaction que les mouvements : deux imports simultanés du
 * même fichier ne peuvent pas passer tous les deux.
 */
async function executeImport(pool, { companyId, plan, recon, user, fileName, hash, warehouse = "W-EM2S-A" }) {
  const client = await pool.connect();
  const created = {
    products: [], entries: [], exits: [], writeOffs: [], priorAdjustments: [],
    transfers: [], documents: [], inventoryId: null, skipped: [],
  };

  try {
    await client.query("BEGIN");

    /* Idempotence : l'index unique partiel sur (company_id, file_hash)
       WHERE status='COMPLETED' rend un second import impossible, même en cas
       de double clic simultané. */
    const dup = await client.query(
      `SELECT id, status FROM inventory_imports
        WHERE company_id=$1 AND file_hash=$2 AND status=$3`,
      [companyId, hash, IMPORT_STATUS.COMPLETED]
    );
    if (dup.rows[0]) {
      await client.query("ROLLBACK");
      const e = new Error("Ce fichier a déjà été importé avec succès.");
      e.httpStatus = 409; e.code = "ALREADY_IMPORTED"; e.importId = dup.rows[0].id;
      throw e;
    }

    const imp = (await client.query(
      `INSERT INTO inventory_imports
         (company_id, file_name, file_hash, imported_by, status, rows_read)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [companyId, fileName, hash, user?.id || null, IMPORT_STATUS.PENDING, recon.items.length]
    )).rows[0];
    const importId = imp.id;

    // 1 — Produits manquants : une seule fiche par produit, stock à 0.
    const newIds = new Map();
    for (const np of plan.newProducts) {
      const ref = `IMP-${np.desc.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 40)}`;
      const { rows } = await client.query(
        `INSERT INTO products (company_id, name, reference, stock, unit, warehouse, is_active, created_at, updated_at)
         VALUES ($1,$2,$3,0,$4,$5,TRUE,NOW(),NOW()) RETURNING *`,
        [companyId, np.desc, ref, np.unit || "EACH", warehouse]
      );
      newIds.set(np.desc, rows[0].id);
      created.products.push({ id: rows[0].id, name: np.desc });
    }

    const resolve = (p) => (p.id ? p.id : newIds.get(p.name));

    // 2 — Ajustements PRÉALABLES : aligner sur le comptage physique.
    for (const a of plan.preAdjustments) {
      const pid = resolve(a.product);
      if (!pid) { created.skipped.push({ product: a.product.name, reason: "PRODUCT_UNRESOLVED" }); continue; }
      const r = await stockOps.createInventoryAdjustment(client, {
        companyId, productId: pid, countedQuantity: a.counted, user,
        reason: a.reason, importId, sourceReference: fileName,
        locationCode: null, warehouseId: null,
      });
      if (!r.skipped) created.priorAdjustments.push({ product: a.product.name, delta: a.delta, after: r.stockAfter });
    }

    // 3a — ENTRÉES, regroupées sous un unique bon d'entrée.
    if (plan.entries.length) {
      const doc = await createDocument(client, { companyId, docType: "entree", prefix: "BE", user });
      created.documents.push({ type: "BON_ENTREE", number: doc.doc_number, id: doc.id });
      for (const e of plan.entries) {
        const pid = resolve(e.product);
        if (!pid) { created.skipped.push({ product: e.product.name, reason: "PRODUCT_UNRESOLVED" }); continue; }
        const r = await stockOps.createEntry(client, {
          companyId, productId: pid, quantity: e.quantity, user,
          reason: `Import inventaire ${fileName}`, importId,
          sourceReference: doc.doc_number, destinationWarehouse: warehouse,
        });
        created.entries.push({ product: e.product.name, quantity: e.quantity, after: r.stockAfter });
      }
    }

    // 3b — SORTIES, regroupées sous un unique bon de sortie.
    if (plan.exits.length) {
      const doc = await createDocument(client, { companyId, docType: "sortie", prefix: "BS", user });
      created.documents.push({ type: "BON_SORTIE", number: doc.doc_number, id: doc.id });
      for (const x of plan.exits) {
        const pid = resolve(x.product);
        if (!pid) { created.skipped.push({ product: x.product.name, reason: "PRODUCT_UNRESOLVED" }); continue; }
        const r = await stockOps.createExit(client, {
          companyId, productId: pid, quantity: x.quantity, user,
          reason: `Import inventaire ${fileName}`, importId,
          sourceReference: doc.doc_number, sourceWarehouse: warehouse,
        });
        created.exits.push({ product: x.product.name, quantity: x.quantity, after: r.stockAfter });
      }
    }

    // 4 — WRITE-OFF : uniquement les nouveaux rebuts.
    for (const w of plan.writeOffs || []) {
      const pid = resolve(w.product);
      if (!pid) { created.skipped.push({ product: w.product.name, reason: "PRODUCT_UNRESOLVED" }); continue; }
      const r = await stockOps.createWriteOff(client, {
        companyId, productId: pid, quantity: w.quantity, user,
        reason: w.reason || "Write-off inventaire Excel", importId, sourceReference: fileName,
      });
      created.writeOffs.push({ product: w.product.name, quantity: w.quantity, after: r.stockAfter });
    }

    // 5 — Inventaire récapitulatif. L'ancien inventaire n'est jamais touché.
    for (const it of recon.items) {
      if (!it.match) continue;
      await client.query(
        `INSERT INTO inventory_history
           (product_reference, product_name, system_stock, real_stock, difference,
            warehouse, user_name, user_role, status, observation, company_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Validé',$9,$10,NOW())`,
        [it.match.reference || null, it.match.name, it.dbStock, it.expected,
         it.expected - it.dbStock, warehouse, user?.name || "Import Excel",
         user?.role || null, `Actualisation Excel — import #${importId}`, companyId]
      );
    }
    created.inventoryId = importId;

    await client.query(
      `UPDATE inventory_imports
          SET status=$1, rows_imported=$2, rows_skipped=$3, summary=$4, updated_at=NOW()
        WHERE id=$5`,
      [IMPORT_STATUS.COMPLETED,
       created.entries.length + created.exits.length + created.priorAdjustments.length + created.writeOffs.length,
       created.skipped.length + plan.blocked.length,
       JSON.stringify({ documents: created.documents, totals: plan.totals, blocked: plan.blocked }),
       importId]
    );

    await client.query("COMMIT");
    return { importId, created };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Annulation métier : on ne supprime RIEN. Chaque mouvement de l'import reçoit
 * son mouvement inverse, et l'import passe en ROLLED_BACK — l'historique reste
 * entièrement lisible.
 */
async function rollbackImport(pool, { companyId, importId, user }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const imp = (await client.query(
      `SELECT * FROM inventory_imports WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [importId, companyId]
    )).rows[0];
    if (!imp) { await client.query("ROLLBACK"); const e = new Error("Import introuvable."); e.httpStatus = 404; throw e; }
    if (imp.status !== IMPORT_STATUS.COMPLETED) {
      await client.query("ROLLBACK");
      const e = new Error(`Import non annulable (${imp.status}).`); e.httpStatus = 409; throw e;
    }

    const movements = (await client.query(
      `SELECT * FROM stock_movements
        WHERE company_id=$1 AND import_id=$2 AND status='Validé'
        ORDER BY id DESC`,            // ordre inverse de création
      [companyId, importId]
    )).rows;

    let reversed = 0;
    for (const mv of movements) {
      const qty = Number(mv.final_quantity || mv.quantity);
      const isIncrease = mv.type === stockOps.MOVEMENT_TYPES.ENTRY
        || (mv.type === stockOps.MOVEMENT_TYPES.INVENTORY && Number(mv.stock_after) > Number(mv.stock_before));
      const opts = {
        companyId, productId: mv.product_id, quantity: Math.abs(Number(mv.stock_after) - Number(mv.stock_before)) || qty,
        user, reason: `Annulation import #${importId}`, importId, sourceReference: `ROLLBACK-${mv.id}`,
      };
      if (opts.quantity === 0) continue;
      if (isIncrease) await stockOps.createExit(client, opts);
      else await stockOps.createEntry(client, opts);
      reversed++;
    }

    await client.query(
      `UPDATE inventory_imports SET status=$1, updated_at=NOW() WHERE id=$2`,
      [IMPORT_STATUS.ROLLED_BACK, importId]
    );
    await client.query("COMMIT");
    return { importId, reversed };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { executeImport, rollbackImport, fileHash, IMPORT_STATUS };
