"use strict";

/**
 * PHASES 13-22 — Demandes de décaissement (Triangle WMS).
 * RÉUTILISE la table existante `disbursement_requests` (aucune table dupliquée).
 *
 * RÈGLE ABSOLUE : la trésorerie ne bouge NI à la création, NI à la soumission,
 * NI à la validation Direction. Elle ne change QU'AU décaissement réel, qui
 * crée une transaction de trésorerie + des écritures comptables ÉQUILIBRÉES
 * (jamais de solde modifié directement).
 *
 * Aucun nom de personne codé en dur : tout passe par les rôles/permissions.
 */
const express = require("express");

const S = {
  DRAFT: "BROUILLON", SUBMITTED: "SOUMISE", WAITING_DIR: "EN_ATTENTE_DIRECTION",
  APPROVED: "VALIDEE_DIRECTION", REJECTED: "REFUSEE_DIRECTION",
  WAITING_DISB: "EN_ATTENTE_DECAISSEMENT", DISBURSED: "DECAISSEE",
  WAITING_RECEIPTS: "EN_ATTENTE_JUSTIFICATIFS", RECEIPTS_UPLOADED: "JUSTIFICATIFS_DEPOSES",
  IN_REVIEW: "EN_CONTROLE", CLOSED: "CLOTUREE", CANCELLED: "ANNULEE",
};

module.exports = function createDisbursementsRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission,
          createNotification, accounting, upload } = deps;
  const router = express.Router();
  const companyOf = (req) => getEffectiveCompanyId(req, req.user.company_id);
  // Permissions : finance.request (création/suivi), finance.direction (validation),
  // finance.disbursement (exécution). Toutes via le moteur RBAC (pas de rôle en dur).
  const permRequest = (a) => requirePermission("finance.request", a);
  const permDirection = (a) => requirePermission("finance.direction", a);
  const permDisburse = (a) => requirePermission("finance.disbursement", a);

  async function notify(userIds, payload) {
    if (!createNotification) return;
    for (const uid of [...new Set((userIds || []).filter(Boolean))]) {
      try { await createNotification({ ...payload, user_id: uid }); } catch { /* non bloquant */ }
    }
  }
  /* Destinataires par capacité (permission explicite, sinon rôles de repli). */
  async function usersWithCapability(companyId, moduleKey, fallbackRoles) {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id FROM users u
         LEFT JOIN user_permissions p ON p.user_id=u.id AND p.module_key=$2
        WHERE u.company_id=$1
          AND (p.can_validate = TRUE OR (p.can_validate IS NULL AND lower(u.role) = ANY($3)))`,
      [companyId, moduleKey, fallbackRoles]
    );
    return rows.map((r) => r.id);
  }
  const DIRECTION_ROLES = ["direction", "directeur", "admin", "super_admin", "gerant"];
  const ACCOUNTING_ROLES = ["comptable", "admin", "super_admin", "direction"];

  async function shortNumber(client, prefix, companyId) {
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

  async function audit(client, companyId, userId, action, entityId, reference, oldV, newV, ip) {
    await client.query(
      `INSERT INTO stock_audit_logs (company_id, user_id, action, entity, entity_id, reference, old_value, new_value, ip)
       VALUES ($1,$2,$3,'disbursement_request',$4,$5,$6,$7,$8)`,
      [companyId, userId || null, action, entityId || null, reference || null,
       oldV ? JSON.stringify(oldV) : null, newV ? JSON.stringify(newV) : null, ip || null]
    ).catch(() => {});
  }

  // ---------- CRÉATION (aucun impact trésorerie) ----------
  router.post("/disbursements", authenticateToken, permRequest("create"), async (req, res) => {
    const client = await pool.connect();
    try {
      const b = req.body || {};
      const amount = Number(b.amount);
      if (!(amount > 0)) return res.status(400).json({ error: "Montant demandé invalide." });
      if (!String(b.reason || "").trim()) return res.status(400).json({ error: "Objet / motif obligatoire." });
      const companyId = companyOf(req);
      await client.query("BEGIN");
      const number = await shortNumber(client, "DD", companyId);
      const me = (await client.query(`SELECT fullname, role FROM users WHERE id=$1`, [req.user.id])).rows[0] || {};
      const status = b.submit === true ? S.WAITING_DIR : S.DRAFT;
      const { rows } = await client.query(
        `INSERT INTO disbursement_requests
           (company_id, request_number, requester_id, requester_name, requester_role, amount, category,
            urgency, reason, status, payment_method, initial_attachment_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [companyId, number, req.user.id, me.fullname || null, me.role || null, amount,
         b.category || null, b.urgency || "normale", String(b.reason).trim(), status,
         b.payment_method || null, b.initial_attachment_url || null]
      );
      await audit(client, companyId, req.user.id, "create", rows[0].id, number, null, { status, amount }, req.ip);
      await client.query("COMMIT");
      if (status === S.WAITING_DIR) {
        await notify(await usersWithCapability(companyId, "finance.direction", DIRECTION_ROLES), {
          company_id: companyId, type: "finance", title: "Demande de décaissement à valider",
          message: `${number} — ${amount} FCFA — ${String(b.reason).slice(0, 60)}`,
          related_entity_type: "disbursement_request", related_entity_id: rows[0].id,
          action_url: `/direction?id=${rows[0].id}`, created_by: req.user.id, priority: "high",
        });
      }
      res.status(201).json({ ...rows[0], treasury_impacted: false });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("disbursements create:", e);
      res.status(500).json({ error: "Erreur création de la demande." });
    } finally { client.release(); }
  });

  // ---------- LISTE / DÉTAIL ----------
  router.get("/disbursements", authenticateToken, permRequest("view"), async (req, res) => {
    try {
      const params = [companyOf(req)];
      let where = "company_id=$1";
      if (req.query.status) { params.push(req.query.status); where += ` AND status=$${params.length}`; }
      if (req.query.mine === "1") { params.push(req.user.id); where += ` AND requester_id=$${params.length}`; }
      const { rows } = await pool.query(
        `SELECT * FROM disbursement_requests WHERE ${where} ORDER BY created_at DESC LIMIT 300`, params
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur demandes." }); }
  });

  router.get("/disbursements/:id", authenticateToken, permRequest("view"), async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM disbursement_requests WHERE id=$1 AND company_id=$2`, [req.params.id, companyOf(req)]);
    if (!rows[0]) return res.status(404).json({ error: "Demande introuvable." });
    res.json(rows[0]);
  });

  // ---------- SOUMISSION ----------
  router.post("/disbursements/:id/submit", authenticateToken, permRequest("update"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM disbursement_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      if (cur.status !== S.DRAFT) { await client.query("ROLLBACK"); return res.status(409).json({ error: `Demande déjà ${cur.status}.`, code: "ALREADY_PROCESSED" }); }
      const { rows } = await client.query(`UPDATE disbursement_requests SET status=$3, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`, [cur.id, companyId, S.WAITING_DIR]);
      await audit(client, companyId, req.user.id, "submit", cur.id, cur.request_number, { status: cur.status }, { status: S.WAITING_DIR }, req.ip);
      await client.query("COMMIT");
      await notify(await usersWithCapability(companyId, "finance.direction", DIRECTION_ROLES), {
        company_id: companyId, type: "finance", title: "Demande de décaissement à valider",
        message: `${cur.request_number} — ${cur.amount} FCFA`, related_entity_type: "disbursement_request",
        related_entity_id: cur.id, action_url: `/direction?id=${cur.id}`, created_by: req.user.id, priority: "high",
      });
      res.json({ ...rows[0], treasury_impacted: false });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error(e); res.status(500).json({ error: "Erreur soumission." }); }
    finally { client.release(); }
  });

  // ---------- VALIDATION DIRECTION (aucun impact trésorerie) ----------
  router.post("/disbursements/:id/approve", authenticateToken, permDirection("validate"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM disbursement_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      if (![S.SUBMITTED, S.WAITING_DIR].includes(cur.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Validation impossible : demande ${cur.status}.`, code: "ALREADY_PROCESSED" });
      }
      const me = (await client.query(`SELECT fullname FROM users WHERE id=$1`, [req.user.id])).rows[0] || {};
      const { rows } = await client.query(
        `UPDATE disbursement_requests SET status=$3, approved_by=$4, approved_by_name=$5, approved_at=NOW(),
           approval_comment=$6, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`,
        [cur.id, companyId, S.WAITING_DISB, req.user.id, me.fullname || null, req.body?.comment || null]
      );
      await audit(client, companyId, req.user.id, "approve", cur.id, cur.request_number, { status: cur.status }, { status: S.WAITING_DISB }, req.ip);
      await client.query("COMMIT");
      // La demande apparaît AUTOMATIQUEMENT chez le comptable (statut EN_ATTENTE_DECAISSEMENT).
      await notify([cur.requester_id, ...(await usersWithCapability(companyId, "finance.disbursement", ACCOUNTING_ROLES))], {
        company_id: companyId, type: "finance", title: "Décaissement à effectuer",
        message: `${cur.request_number} validée par la Direction — ${cur.amount} FCFA à décaisser.`,
        related_entity_type: "disbursement_request", related_entity_id: cur.id,
        action_url: `/decaissements?id=${cur.id}`, created_by: req.user.id, priority: "high",
      });
      res.json({ ...rows[0], treasury_impacted: false });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error(e); res.status(500).json({ error: "Erreur validation." }); }
    finally { client.release(); }
  });

  // ---------- REFUS DIRECTION (motif obligatoire) ----------
  router.post("/disbursements/:id/reject", authenticateToken, permDirection("validate"), async (req, res) => {
    const client = await pool.connect();
    try {
      const reason = String(req.body?.reason || "").trim();
      if (!reason) return res.status(400).json({ error: "Motif de refus obligatoire." });
      const companyId = companyOf(req);
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM disbursement_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      if (![S.SUBMITTED, S.WAITING_DIR].includes(cur.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Refus impossible : demande ${cur.status}.`, code: "ALREADY_PROCESSED" });
      }
      const me = (await client.query(`SELECT fullname FROM users WHERE id=$1`, [req.user.id])).rows[0] || {};
      const { rows } = await client.query(
        `UPDATE disbursement_requests SET status=$3, approved_by=$4, approved_by_name=$5, approved_at=NOW(),
           approval_comment=$6, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`,
        [cur.id, companyId, S.REJECTED, req.user.id, me.fullname || null, reason]
      );
      await audit(client, companyId, req.user.id, "reject", cur.id, cur.request_number, { status: cur.status }, { status: S.REJECTED, reason }, req.ip);
      await client.query("COMMIT");
      await notify([cur.requester_id], {
        company_id: companyId, type: "finance", title: "Demande de décaissement refusée",
        message: `${cur.request_number} refusée. Motif : ${reason}`,
        related_entity_type: "disbursement_request", related_entity_id: cur.id,
        action_url: `/decaissements?id=${cur.id}`, created_by: req.user.id, priority: "high",
      });
      res.json({ ...rows[0], treasury_impacted: false });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error(e); res.status(500).json({ error: "Erreur refus." }); }
    finally { client.release(); }
  });

  // ---------- DÉCAISSEMENT RÉEL — SEUL POINT QUI TOUCHE LA TRÉSORERIE ----------
  router.post("/disbursements/:id/disburse", authenticateToken, permDisburse("validate"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      const b = req.body || {};
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM disbursement_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      // Anti double décaissement (double clic / double appel API).
      if (cur.status !== S.WAITING_DISB) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Décaissement impossible : demande ${cur.status}.`, code: "ALREADY_PROCESSED", status: cur.status });
      }
      const validated = Number(cur.amount) || 0;
      const real = b.amount_disbursed != null ? Number(b.amount_disbursed) : validated;
      if (!(real > 0)) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Montant décaissé invalide." }); }
      // Écart -> justification obligatoire ; dépassement -> refusé.
      if (real !== validated && !String(b.justification || "").trim()) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Montant différent du montant validé (${validated}) : justification obligatoire.`, code: "JUSTIFICATION_REQUIRED" });
      }
      if (real > validated && b.allow_over !== true) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Montant décaissé (${real}) supérieur au montant validé (${validated}).`, code: "OVER_AMOUNT" });
      }

      // Trésorerie : transaction + écritures ÉQUILIBRÉES (jamais de solde isolé).
      const num = await accounting.nextAccountingNumber(client, "accounting_transactions", "transaction_number", "DEC", companyId);
      const tx = await client.query(
        `INSERT INTO accounting_transactions (company_id, transaction_number, transaction_type, source_type, source_id,
           amount, currency, direction, category, partner_name, description, status, created_by, validated_by, validated_at, created_at, updated_at)
         VALUES ($1,$2,'decaissement','disbursement_request',$3,$4,'FCFA','sortie',$5,$6,$7,'validé',$8,$8,NOW(),NOW(),NOW()) RETURNING id`,
        [companyId, num, cur.id, real, cur.category || "Décaissement", b.beneficiary || cur.requester_name || null,
         `Décaissement ${cur.request_number} — ${String(cur.reason || "").slice(0, 80)}`, req.user.id]
      );
      await client.query(
        `INSERT INTO treasury_accounts (company_id, currency, initial_balance, current_balance, updated_by)
         SELECT $1,'FCFA',0,0,$2 WHERE NOT EXISTS (SELECT 1 FROM treasury_accounts WHERE company_id=$1)`,
        [companyId, req.user.id]
      );
      await client.query(
        `UPDATE treasury_accounts SET current_balance = COALESCE(current_balance,0) - $1, updated_by=$2, updated_at=NOW() WHERE company_id=$3`,
        [real, req.user.id, companyId]
      );
      await accounting.createAccountingEntry(client, { companyId, sourceType: "disbursement_request", sourceId: tx.rows[0].id,
        accountLabel: "Charges / Décaissements", debit: real, credit: 0, description: `Décaissement ${cur.request_number}`, createdBy: req.user.id });
      await accounting.createAccountingEntry(client, { companyId, sourceType: "disbursement_request", sourceId: tx.rows[0].id,
        accountLabel: b.account_label || "Caisse", debit: 0, credit: real, description: `Décaissement ${cur.request_number}`, createdBy: req.user.id });

      const me = (await client.query(`SELECT fullname FROM users WHERE id=$1`, [req.user.id])).rows[0] || {};
      const voucher = await shortNumber(client, "BD", companyId);
      const { rows } = await client.query(
        `UPDATE disbursement_requests SET status=$3, amount_disbursed=$4, disbursed_by=$5, disbursed_by_name=$6,
           disbursed_at=NOW(), payment_method=COALESCE($7, payment_method),
           disbursement_comment=$8, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`,
        [cur.id, companyId, S.WAITING_RECEIPTS, real, req.user.id, me.fullname || null,
         b.payment_method || null, `Bon ${voucher}${b.justification ? " — " + b.justification : ""}${b.payment_reference ? " — réf " + b.payment_reference : ""}`]
      );
      await audit(client, companyId, req.user.id, "disburse", cur.id, cur.request_number, { status: cur.status }, { status: S.WAITING_RECEIPTS, amount: real, voucher, transaction_id: tx.rows[0].id }, req.ip);
      await client.query("COMMIT");
      await notify([cur.requester_id, cur.approved_by], {
        company_id: companyId, type: "finance", title: "Décaissement effectué",
        message: `${cur.request_number} : ${real} FCFA décaissés. Justificatifs attendus.`,
        related_entity_type: "disbursement_request", related_entity_id: cur.id,
        action_url: `/decaissements?id=${cur.id}`, created_by: req.user.id,
      });
      res.json({ ...rows[0], voucher_number: voucher, transaction_id: tx.rows[0].id, treasury_impacted: true });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("disburse:", e);
      res.status(500).json({ error: "Erreur décaissement." });
    } finally { client.release(); }
  });

  // ---------- JUSTIFICATIFS ----------
  const receiptUpload = upload ? upload.single("file") : (req, res, next) => next();
  router.post("/disbursements/:id/receipt", authenticateToken, permRequest("update"), receiptUpload, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const url = req.file ? `/uploads/disbursements/${req.file.filename}` : (req.body?.receipt_url || null);
      if (!url) return res.status(400).json({ error: "Aucun justificatif fourni (PDF, JPG, JPEG ou PNG)." });
      const { rows } = await pool.query(
        `UPDATE disbursement_requests SET receipt_url=$3, receipt_uploaded_at=NOW(),
           status=CASE WHEN status=$4 THEN $5 ELSE status END, updated_at=NOW()
         WHERE id=$1 AND company_id=$2 RETURNING *`,
        [req.params.id, companyId, url, S.WAITING_RECEIPTS, S.RECEIPTS_UPLOADED]
      );
      if (!rows[0]) return res.status(404).json({ error: "Demande introuvable." });
      await notify(await usersWithCapability(companyId, "finance.disbursement", ACCOUNTING_ROLES), {
        company_id: companyId, type: "finance", title: "Justificatif déposé",
        message: `${rows[0].request_number} : justificatif à contrôler.`,
        related_entity_type: "disbursement_request", related_entity_id: rows[0].id,
        action_url: `/decaissements?id=${cur.id}`, created_by: req.user.id,
      });
      res.json({ ...rows[0], treasury_impacted: false });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur justificatif." }); }
  });

  /* Synthèse des montants d'une demande : décaissé / justifié / remboursé /
     reste à justifier. Un justificatif REFUSÉ ne compte pas. */
  async function amountsOf(companyId, requestId, client = pool) {
    const req = (await client.query(`SELECT amount, amount_disbursed FROM disbursement_requests WHERE id=$1 AND company_id=$2`, [requestId, companyId])).rows[0];
    if (!req) return null;
    const justified = Number((await client.query(
      `SELECT COALESCE(SUM(amount),0) s FROM disbursement_receipts
        WHERE request_id=$1 AND company_id=$2 AND review_status <> 'REFUSE'`, [requestId, companyId]
    )).rows[0].s) || 0;
    const refunded = Number((await client.query(
      `SELECT COALESCE(SUM(amount),0) s FROM disbursement_refunds WHERE request_id=$1 AND company_id=$2`, [requestId, companyId]
    )).rows[0].s) || 0;
    const disbursed = Number(req.amount_disbursed) || 0;
    const remaining = Math.max(0, disbursed - justified - refunded);
    return { disbursed, justified, refunded, remaining, fully_justified: remaining <= 0.009 };
  }

  // Détail complet : demande + justificatifs + remboursements + montants.
  router.get("/disbursements/:id/details", authenticateToken, permRequest("view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const request = (await pool.query(`SELECT * FROM disbursement_requests WHERE id=$1 AND company_id=$2`, [req.params.id, companyId])).rows[0];
      if (!request) return res.status(404).json({ error: "Demande introuvable." });
      const receipts = (await pool.query(
        `SELECT r.*, COALESCE(u.fullname,'') AS uploaded_by_name FROM disbursement_receipts r
           LEFT JOIN users u ON u.id=r.uploaded_by
          WHERE r.request_id=$1 AND r.company_id=$2 ORDER BY r.uploaded_at DESC`, [req.params.id, companyId]
      )).rows;
      const refunds = (await pool.query(`SELECT * FROM disbursement_refunds WHERE request_id=$1 AND company_id=$2 ORDER BY created_at DESC`, [req.params.id, companyId])).rows;
      const history = (await pool.query(
        `SELECT a.action, a.new_value, a.created_at, COALESCE(u.fullname,'') AS user_name FROM stock_audit_logs a
           LEFT JOIN users u ON u.id=a.user_id
          WHERE a.company_id=$1 AND a.entity='disbursement_request' AND a.entity_id=$2 ORDER BY a.created_at`, [companyId, req.params.id]
      )).rows;
      res.json({ request, receipts, refunds, amounts: await amountsOf(companyId, req.params.id), history });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur détail." }); }
  });

  // Dépôt d'un justificatif AVEC montant (photo mobile, PDF, JPG, PNG).
  router.post("/disbursements/:id/receipts", authenticateToken, permRequest("update"), receiptUpload, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const cur = (await pool.query(`SELECT * FROM disbursement_requests WHERE id=$1 AND company_id=$2`, [req.params.id, companyId])).rows[0];
      if (!cur) return res.status(404).json({ error: "Demande introuvable." });
      const url = req.file ? `/uploads/disbursements/${req.file.filename}` : (req.body?.file_url || null);
      if (!url) return res.status(400).json({ error: "Aucun fichier (PDF, JPG, JPEG ou PNG)." });
      const amount = Number(req.body?.amount) || 0;
      const { rows } = await pool.query(
        `INSERT INTO disbursement_receipts (company_id, request_id, file_url, file_name, mime_type, amount, label, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [companyId, cur.id, url, req.file ? req.file.originalname : (req.body?.file_name || null),
         req.file ? req.file.mimetype : null, amount, req.body?.label || null, req.user.id]
      );
      // Le premier justificatif fait avancer le statut + renseigne receipt_url (compat).
      await pool.query(
        `UPDATE disbursement_requests SET receipt_url=COALESCE(receipt_url,$3), receipt_uploaded_at=NOW(),
           status=CASE WHEN status=$4 THEN $5 ELSE status END, updated_at=NOW()
         WHERE id=$1 AND company_id=$2`,
        [cur.id, companyId, url, S.WAITING_RECEIPTS, S.RECEIPTS_UPLOADED]
      );
      await notify(await usersWithCapability(companyId, "finance.disbursement", ACCOUNTING_ROLES), {
        company_id: companyId, type: "finance", title: "Justificatif à contrôler",
        message: `${cur.request_number} : justificatif de ${amount} FCFA déposé.`,
        related_entity_type: "disbursement_request", related_entity_id: cur.id,
        action_url: `/decaissements?id=${cur.id}`, created_by: req.user.id,
      });
      res.status(201).json({ receipt: rows[0], amounts: await amountsOf(companyId, cur.id), treasury_impacted: false });
    } catch (e) { console.error("receipts:", e); res.status(500).json({ error: "Erreur justificatif." }); }
  });

  // Contrôle d'un justificatif par le comptable.
  router.patch("/disbursement-receipts/:id/review", authenticateToken, permDisburse("validate"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const decision = String(req.body?.review_status || "").toUpperCase();
      if (!["ACCEPTE", "REFUSE", "COMPLEMENT"].includes(decision)) {
        return res.status(400).json({ error: "Décision invalide (ACCEPTE, REFUSE ou COMPLEMENT)." });
      }
      const { rows } = await pool.query(
        `UPDATE disbursement_receipts SET review_status=$3, review_comment=$4, reviewed_by=$5, reviewed_at=NOW()
          WHERE id=$1 AND company_id=$2 RETURNING *`,
        [req.params.id, companyId, decision, req.body?.comment || null, req.user.id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Justificatif introuvable." });
      await pool.query(`UPDATE disbursement_requests SET status=$3, updated_at=NOW() WHERE id=$1 AND company_id=$2 AND status=$4`,
        [rows[0].request_id, companyId, S.IN_REVIEW, S.RECEIPTS_UPLOADED]);
      res.json({ receipt: rows[0], amounts: await amountsOf(companyId, rows[0].request_id) });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur contrôle." }); }
  });

  /* REMBOURSEMENT du reliquat — crée une VRAIE entrée de trésorerie
     + écritures équilibrées (jamais de solde modifié directement). */
  router.post("/disbursements/:id/refund", authenticateToken, permDisburse("validate"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      const amount = Number(req.body?.amount);
      if (!(amount > 0)) return res.status(400).json({ error: "Montant de remboursement invalide." });
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM disbursement_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      const before = await amountsOf(companyId, cur.id, client);
      if (amount > before.remaining + 0.009) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Remboursement (${amount}) supérieur au reste à justifier (${before.remaining}).`, code: "OVER_REFUND" });
      }
      const num = await accounting.nextAccountingNumber(client, "accounting_transactions", "transaction_number", "REMB", companyId);
      const tx = await client.query(
        `INSERT INTO accounting_transactions (company_id, transaction_number, transaction_type, source_type, source_id,
           amount, currency, direction, category, description, status, created_by, validated_by, validated_at, created_at, updated_at)
         VALUES ($1,$2,'remboursement','disbursement_request',$3,$4,'FCFA','entrée','Remboursement reliquat',$5,'validé',$6,$6,NOW(),NOW(),NOW()) RETURNING id`,
        [companyId, num, cur.id, amount, `Remboursement ${cur.request_number}`, req.user.id]
      );
      await client.query(`UPDATE treasury_accounts SET current_balance=COALESCE(current_balance,0)+$1, updated_by=$2, updated_at=NOW() WHERE company_id=$3`,
        [amount, req.user.id, companyId]);
      await accounting.createAccountingEntry(client, { companyId, sourceType: "disbursement_refund", sourceId: tx.rows[0].id,
        accountLabel: "Caisse", debit: amount, credit: 0, description: `Remboursement ${cur.request_number}`, createdBy: req.user.id });
      await accounting.createAccountingEntry(client, { companyId, sourceType: "disbursement_refund", sourceId: tx.rows[0].id,
        accountLabel: "Charges / Décaissements", debit: 0, credit: amount, description: `Remboursement ${cur.request_number}`, createdBy: req.user.id });
      const { rows } = await client.query(
        `INSERT INTO disbursement_refunds (company_id, request_id, amount, method, reference, accounting_transaction_id, comment, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [companyId, cur.id, amount, req.body?.method || null, req.body?.reference || null, tx.rows[0].id, req.body?.comment || null, req.user.id]
      );
      await audit(client, companyId, req.user.id, "refund", cur.id, cur.request_number, { remaining: before.remaining }, { amount, transaction_id: tx.rows[0].id }, req.ip);
      await client.query("COMMIT");
      res.status(201).json({ refund: rows[0], amounts: await amountsOf(companyId, cur.id), treasury_impacted: true });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error("refund:", e); res.status(500).json({ error: "Erreur remboursement." }); }
    finally { client.release(); }
  });

  // ---------- CLÔTURE (contrôle comptable) ----------
  router.post("/disbursements/:id/close", authenticateToken, permDisburse("validate"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM disbursement_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      if (![S.RECEIPTS_UPLOADED, S.IN_REVIEW, S.WAITING_RECEIPTS].includes(cur.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Clôture impossible : demande ${cur.status}.`, code: "INVALID_STATE" });
      }
      // Clôture autorisée seulement si tout est justifié (ou remboursé).
      const amt = await amountsOf(companyId, cur.id, client);
      if (amt && !amt.fully_justified && req.body?.force !== true) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `Clôture impossible : reste à justifier ${amt.remaining} FCFA (décaissé ${amt.disbursed}, justifié ${amt.justified}, remboursé ${amt.refunded}).`,
          code: "NOT_FULLY_JUSTIFIED", amounts: amt,
        });
      }
      const me = (await client.query(`SELECT fullname FROM users WHERE id=$1`, [req.user.id])).rows[0] || {};
      const { rows } = await client.query(
        `UPDATE disbursement_requests SET status=$3, closed_by=$4, closed_by_name=$5, closed_at=NOW(),
           closure_comment=$6, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`,
        [cur.id, companyId, S.CLOSED, req.user.id, me.fullname || null, req.body?.comment || null]
      );
      await audit(client, companyId, req.user.id, "close", cur.id, cur.request_number, { status: cur.status }, { status: S.CLOSED }, req.ip);
      await client.query("COMMIT");
      await notify([cur.requester_id], {
        company_id: companyId, type: "finance", title: "Demande clôturée",
        message: `${cur.request_number} est clôturée.`, related_entity_type: "disbursement_request",
        related_entity_id: cur.id, action_url: `/decaissements?id=${cur.id}`, created_by: req.user.id,
      });
      res.json({ ...rows[0], treasury_impacted: false });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error(e); res.status(500).json({ error: "Erreur clôture." }); }
    finally { client.release(); }
  });

  // ---------- TABLEAU DE BORD DIRECTION ----------
  router.get("/direction/dashboard", authenticateToken, permDirection("view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const { rows } = await pool.query(
        `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total,
                COALESCE(SUM(amount_disbursed),0) AS total_disbursed
           FROM disbursement_requests WHERE company_id=$1 GROUP BY status`, [companyId]
      );
      const byStatus = Object.fromEntries(rows.map((r) => [r.status, r]));
      const missing = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM disbursement_requests
          WHERE company_id=$1 AND status IN ($2,$3) AND receipt_url IS NULL`,
        [companyId, S.WAITING_RECEIPTS, S.IN_REVIEW]
      )).rows[0].n;
      const treasury = (await pool.query(`SELECT COALESCE(SUM(current_balance),0) AS b FROM treasury_accounts WHERE company_id=$1`, [companyId])).rows[0].b;
      res.json({ by_status: byStatus, missing_receipts: missing, treasury_balance: Number(treasury), statuses: S });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur tableau de bord Direction." }); }
  });

  return router;
};
module.exports.STATUS = S;
