"use strict";

const stockLocations = require("../services/stock-locations");

/**
 * Workflows stock MULTI-PRODUITS (PHASES 3-10) — Triangle WMS.
 *
 * RÈGLE ABSOLUE : ni la création, ni la validation ne modifient le stock.
 * Le stock ne bouge QU'À la confirmation réelle (réception / sortie), dans une
 * transaction PostgreSQL avec verrouillage (SELECT ... FOR UPDATE) qui empêche :
 *  - la double validation      (garde de statut + verrou de ligne)
 *  - la double réception       (idem : seule une demande VALIDEE/PARTIELLEMENT_RECUE passe)
 *  - le double clic / double appel API (2e requête = 409, aucun effet)
 *  - le stock négatif          (contrôle serveur avant écriture)
 *
 * RBAC : toutes les routes passent par requirePermission (aucun hardcode rôle).
 */
const express = require("express");

const STATUS = {
  DRAFT: "BROUILLON", PENDING: "EN_ATTENTE", VALIDATED: "VALIDEE", REJECTED: "REFUSEE",
  PARTIAL: "PARTIELLEMENT_RECUE", RECEIVED: "RECUE", CANCELLED: "ANNULEE",
};
const PREFIX = { entree: "DE", sortie: "DS", transfert: "TR", inventaire: "IN" };
const TYPES = Object.keys(PREFIX);

module.exports = function createStockWorkflowRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission, createNotification, rbac } = deps;
  const router = express.Router();
  const companyOf = (req) => getEffectiveCompanyId(req, req.user.company_id);
  const perm = (action) => requirePermission("stock", action);

  /* Date au format AAAA-MM-JJ à partir des composantes LOCALES : toISOString()
     renvoie la date UTC et décalait le bon d'un jour en soirée. */
  const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  /* Numéro COURT PREFIX-AAMMJJ-NNN, unique par entreprise + préfixe + jour.
     Séquence atomique (UPSERT) : sûr en cas d'appels simultanés. */
  async function shortDocNumber(client, prefix, companyId) {
    const d = new Date();
    const stamp = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
    const { rows } = await client.query(
      `INSERT INTO stock_request_counters (company_id, year, prefix, last_seq) VALUES ($1,$2,$3,1)
       ON CONFLICT (company_id, year, prefix) DO UPDATE SET last_seq = stock_request_counters.last_seq + 1
       RETURNING last_seq`,
      [companyId, d.getFullYear(), `${prefix}#${stamp}`]
    );
    return `${prefix}-${stamp}-${String(rows[0].last_seq).padStart(3, "0")}`;
  }

  /* PHASE 5 — notifications (moteur existant réutilisé, jamais bloquant). */
  async function notifyUsers(userIds, payload) {
    if (!createNotification) return;
    for (const uid of [...new Set(userIds.filter(Boolean))]) {
      try { await createNotification({ ...payload, user_id: uid }); } catch { /* non bloquant */ }
    }
  }
  /* Destinataires = utilisateurs de l'entreprise pouvant VALIDER le stock
     (permission explicite, sinon rôles de repli) — aucun nom codé en dur. */
  async function validatorsOf(companyId) {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id FROM users u
         LEFT JOIN user_permissions p ON p.user_id=u.id AND p.module_key='stock'
        WHERE u.company_id=$1
          AND (p.can_validate = TRUE
               OR (p.can_validate IS NULL AND lower(u.role) IN
                   ('admin','administrateur','super_admin','direction','directeur','gerant','manager',
                    'chef_entrepot','responsable_entrepot')))`,
      [companyId]
    );
    return rows.map((r) => r.id);
  }

  async function audit(client, { companyId, userId, action, entity, entityId, reference, oldValue, newValue, ip }) {
    await client.query(
      `INSERT INTO stock_audit_logs (company_id, user_id, action, entity, entity_id, reference, old_value, new_value, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [companyId, userId || null, action, entity, entityId || null, reference || null,
       oldValue ? JSON.stringify(oldValue) : null, newValue ? JSON.stringify(newValue) : null, ip || null]
    ).catch(() => {});
  }

  async function nextReference(client, companyId, type) {
    const year = new Date().getFullYear();
    const prefix = PREFIX[type] || "DM";
    const { rows } = await client.query(
      `INSERT INTO stock_request_counters (company_id, year, prefix, last_seq) VALUES ($1,$2,$3,1)
       ON CONFLICT (company_id, year, prefix) DO UPDATE SET last_seq = stock_request_counters.last_seq + 1
       RETURNING last_seq`,
      [companyId, year, prefix]
    );
    return `${prefix}-${year}-${String(rows[0].last_seq).padStart(5, "0")}`;
  }

  // ---------- CRÉATION (multi-produits) — n'affecte PAS le stock ----------
  router.post("/stock-requests", authenticateToken, perm("create"), async (req, res) => {
    const client = await pool.connect();
    try {
      const b = req.body || {};
      const type = String(b.request_type || "").toLowerCase();
      if (!TYPES.includes(type)) return res.status(400).json({ error: `Type invalide (${TYPES.join(", ")}).` });
      const lines = Array.isArray(b.lines) ? b.lines : [];
      if (lines.length === 0) return res.status(400).json({ error: "Au moins un produit est requis." });
      if (lines.length > 200) return res.status(400).json({ error: "200 lignes maximum par opération." });
      for (const [i, l] of lines.entries()) {
        if (!l.product_name && !l.product_reference) return res.status(400).json({ error: `Ligne ${i + 1} : produit manquant.` });
        if (!(Number(l.quantity_requested) > 0)) return res.status(400).json({ error: `Ligne ${i + 1} : quantité invalide.` });
      }
      if (type === "transfert" && (!b.source_warehouse || !b.target_warehouse)) {
        return res.status(400).json({ error: "Transfert : entrepôt source et destination requis." });
      }

      const companyId = companyOf(req);
      await client.query("BEGIN");
      const reference = await nextReference(client, companyId, type);
      const status = b.submit === true ? STATUS.PENDING : STATUS.DRAFT;
      const { rows } = await client.query(
        `INSERT INTO stock_requests (company_id, reference, request_type, status, supplier_name, partner_id,
           source_warehouse, source_location, target_warehouse, target_location, motif, observations, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [companyId, reference, type, status, b.supplier_name || null, b.partner_id || null,
         b.source_warehouse || null, b.source_location || null, b.target_warehouse || null, b.target_location || null,
         b.motif || null, b.observations || null, req.user.id]
      );
      const request = rows[0];
      for (const [i, l] of lines.entries()) {
        await client.query(
          `INSERT INTO stock_request_lines (company_id, request_id, line_no, product_id, product_reference, product_name,
             unit, quantity_requested, unit_price, warehouse, location_code, observation)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [companyId, request.id, i + 1, l.product_id || null, l.product_reference || null, l.product_name || l.product_reference,
           l.unit || null, Number(l.quantity_requested), l.unit_price != null ? Number(l.unit_price) : null,
           l.warehouse || b.target_warehouse || b.source_warehouse || null, l.location_code || null, l.observation || null]
        );
      }
      await audit(client, { companyId, userId: req.user.id, action: "create", entity: "stock_request", entityId: request.id, reference, newValue: { status, lines: lines.length }, ip: req.ip });
      await client.query("COMMIT");
      res.status(201).json({ ...request, lines_count: lines.length, stock_impacted: false });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("stock-requests create:", e);
      res.status(500).json({ error: "Erreur création de la demande." });
    } finally { client.release(); }
  });

  // ---------- LISTE + DÉTAIL ----------
  router.get("/stock-requests", authenticateToken, perm("view"), async (req, res) => {
    try {
      const params = [companyOf(req)];
      let where = "r.company_id=$1";
      if (req.query.status) { params.push(req.query.status); where += ` AND r.status=$${params.length}`; }
      if (req.query.type) { params.push(String(req.query.type).toLowerCase()); where += ` AND r.request_type=$${params.length}`; }
      if (req.query.q) {
        params.push(`%${String(req.query.q).toLowerCase()}%`);
        where += ` AND (lower(r.reference) LIKE $${params.length} OR lower(coalesce(r.supplier_name,'')) LIKE $${params.length}
                   OR EXISTS (SELECT 1 FROM stock_request_lines l WHERE l.request_id=r.id AND lower(l.product_name) LIKE $${params.length}))`;
      }
      const { rows } = await pool.query(
        `SELECT r.*, (SELECT COUNT(*) FROM stock_request_lines l WHERE l.request_id=r.id)::int AS lines_count,
                COALESCE(u.fullname,'') AS requested_by_name, COALESCE(v.fullname,'') AS validated_by_name
           FROM stock_requests r
           LEFT JOIN users u ON u.id=r.requested_by
           LEFT JOIN users v ON v.id=r.validated_by
          WHERE ${where} ORDER BY r.requested_at DESC LIMIT 300`,
        params
      );
      res.json(rows);
    } catch (e) { console.error("stock-requests list:", e); res.status(500).json({ error: "Erreur demandes." }); }
  });

  async function loadRequest(companyId, id) {
    const r = (await pool.query(`SELECT * FROM stock_requests WHERE id=$1 AND company_id=$2`, [id, companyId])).rows[0];
    if (!r) return null;
    r.lines = (await pool.query(`SELECT * FROM stock_request_lines WHERE request_id=$1 ORDER BY line_no`, [id])).rows;
    r.document = (await pool.query(`SELECT * FROM stock_documents WHERE request_id=$1 ORDER BY id DESC LIMIT 1`, [id])).rows[0] || null;
    return r;
  }

  router.get("/stock-requests/:id", authenticateToken, perm("view"), async (req, res) => {
    const r = await loadRequest(companyOf(req), req.params.id);
    if (!r) return res.status(404).json({ error: "Demande introuvable." });
    res.json(r);
  });

  // ---------- SOUMISSION ----------
  router.post("/stock-requests/:id/submit", authenticateToken, perm("update"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM stock_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      if (cur.status !== STATUS.DRAFT) { await client.query("ROLLBACK"); return res.status(409).json({ error: `Demande déjà ${cur.status}.`, code: "INVALID_STATE" }); }
      const { rows } = await client.query(`UPDATE stock_requests SET status=$3, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`, [cur.id, companyId, STATUS.PENDING]);
      await audit(client, { companyId, userId: req.user.id, action: "update", entity: "stock_request", entityId: cur.id, reference: cur.reference, oldValue: { status: cur.status }, newValue: { status: STATUS.PENDING }, ip: req.ip });
      await client.query("COMMIT");
      // Notifie les utilisateurs habilités à valider.
      await notifyUsers(await validatorsOf(companyId), {
        company_id: companyId, type: "stock", title: "Demande stock à valider",
        message: `La demande ${cur.reference} attend votre validation.`,
        related_entity_type: "stock_request", related_entity_id: cur.id,
        action_url: "/demandes-stock", created_by: req.user.id, priority: "high",
      });
      res.json({ ...rows[0], stock_impacted: false });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error(e); res.status(500).json({ error: "Erreur soumission." }); }
    finally { client.release(); }
  });

  // ---------- VALIDATION — NE MODIFIE PAS LE STOCK ----------
  router.post("/stock-requests/:id/validate", authenticateToken, perm("validate"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM stock_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      // Anti double validation / double clic : seule une demande EN_ATTENTE passe.
      if (cur.status !== STATUS.PENDING) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Impossible de valider : demande ${cur.status}.`, code: "ALREADY_PROCESSED", status: cur.status });
      }
      const { rows } = await client.query(
        `UPDATE stock_requests SET status=$3, validated_by=$4, validated_at=NOW(), updated_at=NOW()
          WHERE id=$1 AND company_id=$2 RETURNING *`, [cur.id, companyId, STATUS.VALIDATED, req.user.id]
      );
      await audit(client, { companyId, userId: req.user.id, action: "validate", entity: "stock_request", entityId: cur.id, reference: cur.reference, oldValue: { status: cur.status }, newValue: { status: STATUS.VALIDATED }, ip: req.ip });
      await client.query("COMMIT");
      await notifyUsers([cur.requested_by], {
        company_id: companyId, type: "stock", title: "Demande stock validée",
        message: `Votre demande ${cur.reference} a été validée. Le stock sera mis à jour à la réception.`,
        related_entity_type: "stock_request", related_entity_id: cur.id,
        action_url: "/demandes-stock", created_by: req.user.id,
      });
      res.json({ ...rows[0], stock_impacted: false });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error(e); res.status(500).json({ error: "Erreur validation." }); }
    finally { client.release(); }
  });

  // ---------- REFUS ----------
  router.post("/stock-requests/:id/reject", authenticateToken, perm("validate"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      const reason = String(req.body?.reason || "").trim();
      if (!reason) return res.status(400).json({ error: "Motif de refus obligatoire." });
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM stock_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      if (![STATUS.PENDING, STATUS.VALIDATED].includes(cur.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Impossible de refuser : demande ${cur.status}.`, code: "ALREADY_PROCESSED" });
      }
      const { rows } = await client.query(
        `UPDATE stock_requests SET status=$3, reject_reason=$4, validated_by=$5, validated_at=NOW(), updated_at=NOW()
          WHERE id=$1 AND company_id=$2 RETURNING *`, [cur.id, companyId, STATUS.REJECTED, reason, req.user.id]
      );
      await audit(client, { companyId, userId: req.user.id, action: "reject", entity: "stock_request", entityId: cur.id, reference: cur.reference, oldValue: { status: cur.status }, newValue: { status: STATUS.REJECTED, reason }, ip: req.ip });
      await client.query("COMMIT");
      await notifyUsers([cur.requested_by], {
        company_id: companyId, type: "stock", title: "Demande stock refusée",
        message: `Votre demande ${cur.reference} a été refusée. Motif : ${reason}`,
        related_entity_type: "stock_request", related_entity_id: cur.id,
        action_url: "/demandes-stock", created_by: req.user.id, priority: "high",
      });
      res.json({ ...rows[0], stock_impacted: false });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error(e); res.status(500).json({ error: "Erreur refus." }); }
    finally { client.release(); }
  });

  // ---------- ANNULATION ----------
  router.post("/stock-requests/:id/cancel", authenticateToken, perm("update"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM stock_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      if ([STATUS.RECEIVED, STATUS.CANCELLED].includes(cur.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Impossible d'annuler : demande ${cur.status}.`, code: "ALREADY_PROCESSED" });
      }
      const { rows } = await client.query(
        `UPDATE stock_requests SET status=$3, cancelled_by=$4, cancelled_at=NOW(), updated_at=NOW()
          WHERE id=$1 AND company_id=$2 RETURNING *`, [cur.id, companyId, STATUS.CANCELLED, req.user.id]
      );
      await audit(client, { companyId, userId: req.user.id, action: "cancel", entity: "stock_request", entityId: cur.id, reference: cur.reference, oldValue: { status: cur.status }, newValue: { status: STATUS.CANCELLED }, ip: req.ip });
      await client.query("COMMIT");
      res.json({ ...rows[0], stock_impacted: false });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error(e); res.status(500).json({ error: "Erreur annulation." }); }
    finally { client.release(); }
  });

  // Sens du mouvement selon le type de demande.
  const MOVEMENT = { entree: "Entrée", sortie: "Sortie", transfert: "Transfert", inventaire: "Inventaire" };

  // ---------- CONFIRMATION RÉELLE — SEUL POINT QUI MODIFIE LE STOCK ----------
  router.post("/stock-requests/:id/confirm", authenticateToken, perm("validate"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      const received = Array.isArray(req.body?.lines) ? req.body.lines : null; // [{line_id, quantity_received}]
      await client.query("BEGIN");

      // Verrou de la demande : bloque tout second appel concurrent (double clic / double API).
      const cur = (await client.query(`SELECT * FROM stock_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      if (![STATUS.VALIDATED, STATUS.PARTIAL].includes(cur.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Réception impossible : demande ${cur.status}.`, code: "ALREADY_PROCESSED", status: cur.status });
      }

      const lines = (await client.query(`SELECT * FROM stock_request_lines WHERE request_id=$1 ORDER BY line_no FOR UPDATE`, [cur.id])).rows;
      const wanted = new Map((received || []).map((l) => [Number(l.line_id), Number(l.quantity_received)]));
      // Réception PARTIELLE explicite : si l'appelant fournit une liste de lignes,
      // seules celles-ci sont réceptionnées (les autres ne bougent pas).
      const explicitLines = Array.isArray(received) && received.length > 0;
      const type = cur.request_type;
      const movementType = MOVEMENT[type] || "Entrée";
      const results = [];
      let totalMoved = 0;

      for (const line of lines) {
        const already = Number(line.quantity_received) || 0;
        const requested = Number(line.quantity_requested) || 0;
        if (explicitLines && !wanted.has(line.id)) continue; // ligne non listée = non réceptionnée
        // Quantité de CETTE confirmation : fournie, sinon le reliquat.
        const qty = wanted.has(line.id) ? wanted.get(line.id) : Math.max(0, requested - already);
        if (!(qty > 0)) continue;
        if (already + qty > requested + 1e-9) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: `Ligne ${line.line_no} : quantité reçue (${already + qty}) supérieure à la demande (${requested}).`, code: "OVER_RECEIPT" });
        }

        // Produit verrouillé : contrôle de stock côté serveur (anti stock négatif).
        let product = null;
        if (line.product_id) {
          product = (await client.query(`SELECT id, reference, name, stock FROM products WHERE id=$1 AND company_id=$2 FOR UPDATE`, [line.product_id, companyId])).rows[0];
        }
        if (!product && line.product_reference) {
          product = (await client.query(`SELECT id, reference, name, stock FROM products WHERE reference=$1 AND company_id=$2 FOR UPDATE`, [line.product_reference, companyId])).rows[0];
        }
        if (!product) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: `Ligne ${line.line_no} : produit « ${line.product_name} » introuvable.`, code: "PRODUCT_NOT_FOUND" });
        }

        const current = Number(product.stock) || 0;
        let delta = 0;
        if (type === "entree") delta = qty;
        else if (type === "sortie" || type === "transfert") delta = -qty;
        else if (type === "inventaire") delta = qty - current; // ajustement vers le compté

        if (current + delta < 0 && req.body?.allow_negative !== true) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: `Stock insuffisant pour « ${product.name} » : disponible ${current}, demandé ${qty}.`,
            code: "INSUFFICIENT_STOCK", product: product.name, available: current, requested: qty,
          });
        }

        // Mouvement traçable + mise à jour du stock (UNE SEULE FOIS par confirmation).
        const mv = await client.query(
          `INSERT INTO stock_movements (type, product_reference, product_name, quantity, source_warehouse, destination_warehouse,
             reason, status, approval_status, company_id, created_by, validated_by, validated_at, product_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'Validé','Validé',$8,$9,$9,NOW(),$10,NOW(),NOW()) RETURNING id`,
          [movementType, product.reference, product.name, qty, cur.source_warehouse, cur.target_warehouse,
           `Demande ${cur.reference}${line.observation ? " — " + line.observation : ""}`, companyId, req.user.id, product.id]
        );
        /* Garde-fou partagé : dès que le produit est réparti par bin, un
           mouvement sans emplacement est refusé au lieu de désynchroniser. */
        await stockLocations.adjustGlobalStock(client, {
          companyId, productId: product.id, delta,
          user: { id: req.user.id, name: req.user.email, role: req.user.role },
          reason: `Demande ${cur.reference}`, type: movementType,
          locationId: line.location_id || null, origin: "confirmation de demande",
        });
        await client.query(`UPDATE stock_request_lines SET quantity_received = quantity_received + $2, movement_id=$3 WHERE id=$1`, [line.id, qty, mv.rows[0].id]);
        results.push({ line_no: line.line_no, product: product.name, quantity: qty, delta, movement_id: mv.rows[0].id, stock_before: current, stock_after: current + delta });
        totalMoved++;
      }

      if (totalMoved === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Aucune quantité à réceptionner.", code: "NOTHING_TO_RECEIVE" });
      }

      // Statut : totalement reçu ou partiel.
      const after = (await client.query(`SELECT quantity_requested, quantity_received FROM stock_request_lines WHERE request_id=$1`, [cur.id])).rows;
      const complete = after.every((l) => Number(l.quantity_received) >= Number(l.quantity_requested) - 1e-9);
      const newStatus = complete ? STATUS.RECEIVED : STATUS.PARTIAL;
      await client.query(
        `UPDATE stock_requests SET status=$3, received_by=$4, received_at=NOW(), updated_at=NOW() WHERE id=$1 AND company_id=$2`,
        [cur.id, companyId, newStatus, req.user.id]
      );

      // Bon de réception (BROUILLON), pré-rempli avec le réceptionnaire connu.
      let doc = null;
      if (type === "entree" || type === "transfert" || type === "sortie") {
        const existing = (await client.query(`SELECT * FROM stock_documents WHERE request_id=$1 LIMIT 1`, [cur.id])).rows[0];
        if (existing) doc = existing;
        else {
          // Numéro COURT : BR-AAMMJJ-NNN / BS- / BT- (jamais Date.now()).
          const docPrefix = type === "sortie" ? "BS" : type === "transfert" ? "BT" : "BR";
          const docNumber = await shortDocNumber(client, docPrefix, companyId);
          const me = (await client.query(`SELECT fullname, role FROM users WHERE id=$1`, [req.user.id])).rows[0] || {};
          const now = new Date();
          const docType = type === "sortie" ? "sortie" : type === "transfert" ? "transfert" : "reception";
          doc = (await client.query(
            `INSERT INTO stock_documents (company_id, request_id, doc_number, doc_type, status,
               received_by_name, received_by_function, received_at_date, received_at_time,
               delivered_by_name, delivered_by_function, generated_by)
             VALUES ($1,$2,$3,$4,'BROUILLON',$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [companyId, cur.id, docNumber, docType,
             me.fullname || null, me.role || null, localDate(now), now.toTimeString().slice(0, 5),
             cur.supplier_name || null, cur.supplier_name ? "Fournisseur" : null, req.user.id]
          )).rows[0];
        }
      }

      await audit(client, { companyId, userId: req.user.id, action: "receive", entity: "stock_request", entityId: cur.id, reference: cur.reference, oldValue: { status: cur.status }, newValue: { status: newStatus, lines: results.length }, ip: req.ip });
      await client.query("COMMIT");
      const partial = newStatus === STATUS.PARTIAL;
      await notifyUsers([cur.requested_by, ...(await validatorsOf(companyId))], {
        company_id: companyId, type: "stock",
        title: partial ? "Réception partielle" : "Réception confirmée",
        message: partial
          ? `Demande ${cur.reference} : ${results.length} ligne(s) reçue(s), un reliquat reste attendu.`
          : `Demande ${cur.reference} : réception complète, stock mis à jour.`,
        related_entity_type: "stock_request", related_entity_id: cur.id,
        action_url: "/demandes-stock", created_by: req.user.id,
      });
      res.json({ ok: true, status: newStatus, moved_lines: results.length, results, document: doc, stock_impacted: true });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("stock-requests confirm:", e);
      res.status(500).json({ error: "Erreur confirmation." });
    } finally { client.release(); }
  });

  // ---------- DOCUMENTS (PHASE 8-9) ----------
  router.get("/stock-documents/:id", authenticateToken, perm("view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      // Les colonnes DATE sont renvoyées en TEXTE : évite toute conversion UTC
      // côté client (le bon affichait la veille en soirée).
      const doc = (await pool.query(
        `SELECT *, received_at_date::text AS received_at_date, delivered_at_date::text AS delivered_at_date
           FROM stock_documents WHERE id=$1 AND company_id=$2`, [req.params.id, companyId])).rows[0];
      if (!doc) return res.status(404).json({ error: "Document introuvable." });
      const request = doc.request_id ? await loadRequest(companyId, doc.request_id) : null;
      res.json({ document: doc, request });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur document." }); }
  });

  // Complète les blocs RÉCEPTIONNÉ PAR / LIVRÉ PAR.
  router.patch("/stock-documents/:id", authenticateToken, perm("update"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const b = req.body || {};
      const { rows } = await pool.query(
        `UPDATE stock_documents SET
           received_by_name=COALESCE($3, received_by_name), received_by_function=COALESCE($4, received_by_function),
           received_at_date=COALESCE($5, received_at_date), received_at_time=COALESCE($6, received_at_time),
           delivered_by_name=COALESCE($7, delivered_by_name), delivered_by_function=COALESCE($8, delivered_by_function),
           delivered_at_date=COALESCE($9, delivered_at_date), delivered_at_time=COALESCE($10, delivered_at_time)
         WHERE id=$1 AND company_id=$2 AND status='BROUILLON' RETURNING *`,
        [req.params.id, companyId, b.received_by_name ?? null, b.received_by_function ?? null, b.received_at_date ?? null,
         b.received_at_time ?? null, b.delivered_by_name ?? null, b.delivered_by_function ?? null,
         b.delivered_at_date ?? null, b.delivered_at_time ?? null]
      );
      if (!rows[0]) return res.status(409).json({ error: "Document introuvable ou déjà validé." });
      res.json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur document." }); }
  });

  // Validation du document (BROUILLON -> VALIDE). N'affecte JAMAIS le stock.
  router.post("/stock-documents/:id/validate", authenticateToken, perm("validate"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM stock_documents WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Document introuvable." }); }
      if (cur.status !== "BROUILLON") { await client.query("ROLLBACK"); return res.status(409).json({ error: `Document déjà ${cur.status}.`, code: "ALREADY_PROCESSED" }); }
      const { rows } = await client.query(`UPDATE stock_documents SET status='VALIDE', validated_by=$3, validated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`, [cur.id, companyId, req.user.id]);
      await audit(client, { companyId, userId: req.user.id, action: "validate", entity: "stock_document", entityId: cur.id, reference: cur.doc_number, oldValue: { status: cur.status }, newValue: { status: "VALIDE" }, ip: req.ip });
      await client.query("COMMIT");
      res.json({ ...rows[0], stock_impacted: false });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error(e); res.status(500).json({ error: "Erreur validation document." }); }
    finally { client.release(); }
  });

  /* IMPRESSION (PHASE 9) — permission dédiée.
     N'écrit AUCUN mouvement, ne touche pas au stock : incrémente seulement le
     compteur d'impressions et journalise (réimpression auditée). */
  router.post("/stock-documents/:id/print", authenticateToken, requirePermission("stock.document.print", "validate"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM stock_documents WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Document introuvable." }); }
      const { rows } = await client.query(
        `UPDATE stock_documents SET print_count=print_count+1, last_printed_by=$3, last_printed_at=NOW()
          WHERE id=$1 AND company_id=$2 RETURNING *`, [cur.id, companyId, req.user.id]
      );
      await audit(client, { companyId, userId: req.user.id, action: cur.print_count > 0 ? "reprint" : "print", entity: "stock_document", entityId: cur.id, reference: cur.doc_number, newValue: { print_count: rows[0].print_count }, ip: req.ip });
      await client.query("COMMIT");
      res.json({ ok: true, document: rows[0], stock_impacted: false });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error(e); res.status(500).json({ error: "Erreur impression." }); }
    finally { client.release(); }
  });

  // ---------- AUDIT (PHASE 10) ----------
  router.get("/stock-audit", authenticateToken, perm("view"), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT a.*, COALESCE(u.fullname,'') AS user_name FROM stock_audit_logs a
           LEFT JOIN users u ON u.id=a.user_id
          WHERE a.company_id=$1 ORDER BY a.created_at DESC LIMIT 300`,
        [companyOf(req)]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur audit." }); }
  });

  return router;
};
module.exports.STATUS = STATUS;
