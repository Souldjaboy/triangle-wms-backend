"use strict";

/**
 * CIMENT : DÉFAIRE UN ENCAISSEMENT, SANS JAMAIS L'EFFACER.
 *
 *   POST /cement/payments/:id/reverse          contrepasser un encaissement
 *   POST /cement/reversals/:id/refunded        constater que l'argent est revenu
 *   GET  /cement/invoices/:id/payments         les paiements et leurs contrepassations
 *   GET  /cement/remboursements-attendus       ce que l'on doit encore aux clients
 *
 * Le Sable sait faire tout cela depuis la migration 075. Le Ciment partageait
 * déjà le moteur comptable (routes/sales-payment-accounting.js écrit un
 * `cement_payment_reversal` dès qu'on lui passe module = "cement") mais n'avait
 * ni la table ni la route : un encaissement ciment saisi par erreur ne pouvait
 * pas être défait.
 *
 * DEUX CHOSES QUI NE SONT PAS LA MÊME
 *
 * Contrepasser défait l'écriture : la facture redevient due, l'argent ressort
 * du compte qui l'avait reçu dans la comptabilité. Rembourser, c'est rendre
 * l'argent au client. Le premier est immédiat, le second ne l'est pas — et
 * `refund_pending` reste vrai tant que personne ne l'a constaté. Confondre les
 * deux fait clore un dossier alors qu'un client attend toujours son virement.
 */

const express = require("express");
const { reverseSalePaymentAccounting } = require("./sales-payment-accounting");

module.exports = function createCementCancellationRouter({
  pool, authenticateToken, getEffectiveCompanyId, requirePermission,
  requireCompanyModule, accounting = {},
}) {
  const router = express.Router();
  const perm = (action) => requirePermission("cement", action);
  const cementModuleGuard = requireCompanyModule("cement");
  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const nomDe = (req) => req.user?.fullname || req.user?.email || "Utilisateur";

  const erreur = (message, code, httpStatus) => {
    const e = new Error(message); e.code = code; e.httpStatus = httpStatus; return e;
  };
  const echec = (res, e, secours) => {
    if (!e.httpStatus) console.error(secours, e);
    res.status(e.httpStatus || 500).json({ error: e.message || secours, code: e.code });
  };
  /* Le même seuil que le Sable : un motif de trois lettres n'explique rien
     six mois plus tard. */
  const motifValide = (m) => String(m || "").trim().length >= 10;

  async function audit(client, req, action, entityId, reference, avant, apres) {
    await client.query(
      `INSERT INTO cement_audit_logs
         (company_id, user_id, action, entity_type, entity_id, reference, old_value, new_value)
       VALUES ($1,$2,$3,'cement_invoice',$4,$5,$6::jsonb,$7::jsonb)`,
      [companyOf(req), req.user?.id || null, action, entityId, reference,
       JSON.stringify(avant || {}), JSON.stringify(apres || {})]);
  }

  /**
   * Le solde de la facture, reconstruit depuis la SOMME RÉELLE des paiements
   * NON contrepassés. « ancien − montant » dériverait au moindre incident.
   */
  async function recomputerFacture(client, companyId, invoiceId) {
    const { rows } = await client.query(
      `UPDATE cement_invoices i
          SET paid_amount = p.total,
              remaining_amount = GREATEST(i.total_amount - p.total, 0),
              status = CASE
                WHEN i.cancelled_at IS NOT NULL THEN i.status
                WHEN p.total >= i.total_amount AND i.total_amount > 0 THEN 'PAYEE'
                WHEN p.total > 0 THEN 'PARTIELLEMENT_PAYEE'
                ELSE 'IMPAYEE' END,
              updated_at = NOW()
         FROM (SELECT COALESCE(SUM(pay.amount), 0) AS total
                 FROM cement_payments pay
                WHERE pay.company_id = $1 AND pay.invoice_id = $2
                  AND NOT EXISTS (SELECT 1 FROM cement_payment_reversals r
                                   WHERE r.company_id = pay.company_id
                                     AND r.original_payment_id = pay.id)) p
        WHERE i.id = $2 AND i.company_id = $1
        RETURNING i.*`,
      [companyId, invoiceId]);
    const facture = rows[0];

    /* La vente porte les mêmes montants que sa facture : les laisser diverger
       ferait dire deux choses différentes à deux écrans. */
    if (facture?.sale_id) {
      await client.query(
        /* Deux pièges tenus ici.

           Les types sont donnés explicitement : le même paramètre sert de
           valeur à affecter ET de terme de comparaison, et PostgreSQL refuse
           alors de deviner.

           Et une VENTE ne connaît pas le statut « IMPAYEE » — c'est la
           facture qui l'emploie. Une vente facturée dont plus rien n'est
           réglé retourne à « FACTUREE ». L'encaissement n'avait jamais
           rencontré ce cas : un paiement fait toujours monter le payé. La
           contrepassation, elle, peut le ramener à zéro. */
        `UPDATE cement_sales
            SET paid_amount = $3::numeric, remaining_amount = $4::numeric,
                status = CASE WHEN $4::numeric <= 0 THEN 'PAYEE'
                              WHEN $3::numeric > 0 THEN 'PARTIELLEMENT_PAYEE'
                              ELSE 'FACTUREE' END,
                updated_at = NOW()
          WHERE id = $1::int AND company_id = $2::int`,
        [facture.sale_id, companyId,
         Number(facture.paid_amount), Number(facture.remaining_amount)]);
    }
    return facture;
  }

  /* ─────────────────────── CONTREPASSER UN PAIEMENT ───────────────────── */
  router.post(
    "/cement/payments/:id/reverse",
    authenticateToken, cementModuleGuard, perm("paiement_contrepasser"),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const companyId = companyOf(req);
        const reason = String(req.body?.reason || req.body?.motif || "").trim();
        if (!motifValide(reason)) {
          return res.status(400).json({
            error: "Un motif de contrepassation est obligatoire (10 caractères minimum) : il restera attaché au paiement.",
            code: "REASON_REQUIRED" });
        }

        await client.query("BEGIN");

        const payment = (await client.query(
          `SELECT * FROM cement_payments WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [req.params.id, companyId])).rows[0];
        if (!payment) throw erreur("Paiement introuvable.", "PAYMENT_NOT_FOUND", 404);

        const invoice = (await client.query(
          `SELECT * FROM cement_invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [payment.invoice_id, companyId])).rows[0];
        if (!invoice) throw erreur("Facture introuvable.", "INVOICE_NOT_FOUND", 404);

        /* Le contrôle explicite donne un message clair ; l'index unique, lui,
           tient même si deux requêtes passent ce contrôle en même temps. */
        const deja = (await client.query(
          `SELECT id, created_at FROM cement_payment_reversals
            WHERE company_id = $1 AND original_payment_id = $2`,
          [companyId, payment.id])).rows[0];
        if (deja) {
          throw erreur(
            `Ce paiement a déjà été contrepassé le ${new Date(deja.created_at).toLocaleDateString("fr-FR")}.`,
            "ALREADY_REVERSED", 409);
        }

        const reversal = (await client.query(
          `INSERT INTO cement_payment_reversals
             (company_id, invoice_id, original_payment_id, amount, reason,
              refund_pending, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7)
           RETURNING *`,
          [companyId, invoice.id, payment.id, payment.amount, reason,
           req.user.id, nomDe(req)])).rows[0];

        const { transaction, destination } = await reverseSalePaymentAccounting(client, {
          companyId, module: "cement", payment, amount: Number(payment.amount),
          invoiceNumber: invoice.invoice_number, partnerName: null,
          userId: req.user.id, accounting, reversalSourceId: reversal.id,
        });

        await client.query(
          `UPDATE cement_payment_reversals SET reversal_accounting_transaction_id = $1 WHERE id = $2`,
          [transaction.id, reversal.id]);

        const facture = await recomputerFacture(client, companyId, invoice.id);

        await audit(client, req, "PAYMENT_REVERSE", invoice.id, invoice.invoice_number,
          { paid_amount: invoice.paid_amount, remaining_amount: invoice.remaining_amount,
            status: invoice.status, payment_number: payment.payment_number },
          { paid_amount: facture.paid_amount, remaining_amount: facture.remaining_amount,
            status: facture.status, reversal_id: reversal.id, reason });

        await client.query("COMMIT");
        res.json({
          success: true,
          reversal: { ...reversal, reversal_accounting_transaction_id: transaction.id },
          invoice: facture,
          payment,          /* inchangé, et il le restera */
          destination,
          /* Ce que l'écran doit dire, et que l'on confond toujours. */
          message: `Encaissement ${payment.payment_number} contrepassé. La facture `
            + `${invoice.invoice_number} redevient due de `
            + `${Number(facture.remaining_amount).toLocaleString("fr-FR")} FCFA. `
            + `Le paiement d'origine est conservé.`,
          remboursement: {
            en_attente: true,
            montant: Number(payment.amount),
            avertissement: "L'écriture est défaite, mais l'argent n'est pas revenu au client. "
              + "Aucun virement n'a été demandé : constatez le remboursement une fois effectué.",
          },
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        /* L'index unique a parlé avant nous : deux clics simultanés. */
        if (e?.code === "23505") {
          return res.status(409).json({
            error: "Ce paiement a déjà été contrepassé.", code: "ALREADY_REVERSED" });
        }
        echec(res, e, "Erreur de contrepassation du paiement.");
      } finally { client.release(); }
    });

  /* ──────────────────── CONSTATER LE REMBOURSEMENT ────────────────────── */
  router.post(
    "/cement/reversals/:id/refunded",
    authenticateToken, cementModuleGuard, perm("remboursement_constater"),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const companyId = companyOf(req);
        const reference = String(req.body?.reference || "").trim();
        if (reference.length < 3) {
          return res.status(400).json({
            error: "Indiquez la référence du remboursement (virement, reçu, numéro de chèque).",
            code: "REFERENCE_REQUIRED" });
        }

        await client.query("BEGIN");
        const r = (await client.query(
          `SELECT * FROM cement_payment_reversals WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [req.params.id, companyId])).rows[0];
        if (!r) throw erreur("Contrepassation introuvable.", "REVERSAL_NOT_FOUND", 404);
        if (!r.refund_pending) {
          throw erreur(
            `Ce remboursement a déjà été constaté le ${new Date(r.refunded_at).toLocaleDateString("fr-FR")}.`,
            "ALREADY_REFUNDED", 409);
        }

        const { rows } = await client.query(
          `UPDATE cement_payment_reversals
              SET refund_pending = FALSE, refunded_at = now(),
                  refunded_by = $1, refund_reference = $2
            WHERE id = $3 RETURNING *`,
          [req.user.id, reference, r.id]);

        await audit(client, req, "REFUND_CONFIRMED", r.invoice_id, reference,
          { refund_pending: true }, { refund_pending: false, reference });

        await client.query("COMMIT");
        res.json({
          success: true, reversal: rows[0],
          /* Constater n'écrit AUCUN mouvement : l'argent était déjà sorti de
             la comptabilité au moment de la contrepassation. L'écrire une
             seconde fois le ferait sortir deux fois. */
          message: `Remboursement de ${Number(r.amount).toLocaleString("fr-FR")} FCFA constaté `
            + `(réf. ${reference}). Aucun nouveau mouvement comptable : l'argent était `
            + `déjà sorti des comptes lors de la contrepassation.`,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        echec(res, e, "Erreur d'enregistrement du remboursement.");
      } finally { client.release(); }
    });

  /* ───────────── LES PAIEMENTS D'UNE FACTURE, CONTREPASSATIONS COMPRISES ─ */
  router.get(
    "/cement/invoices/:id/payments",
    authenticateToken, cementModuleGuard, perm("view"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        const facture = (await pool.query(
          `SELECT * FROM cement_invoices WHERE id = $1 AND company_id = $2`,
          [req.params.id, companyId])).rows[0];
        if (!facture) {
          return res.status(404).json({ error: "Facture introuvable.", code: "INVOICE_NOT_FOUND" });
        }
        const { rows } = await pool.query(
          `SELECT p.*,
                  r.id AS reversal_id, r.reason AS reversal_reason, r.created_at AS reversed_at,
                  r.created_by_name AS reversed_by_name, r.refund_pending, r.refunded_at,
                  r.refund_reference, b.bank_name
             FROM cement_payments p
             LEFT JOIN cement_payment_reversals r
               ON r.original_payment_id = p.id AND r.company_id = p.company_id
             LEFT JOIN accounting_banks b ON b.id = p.bank_id
            WHERE p.company_id = $1 AND p.invoice_id = $2
            ORDER BY p.payment_date, p.id`, [companyId, req.params.id]);
        res.json({
          invoice: facture,
          paiements: rows.map((p) => ({ ...p, contrepasse: !!p.reversal_id })),
          /* Le total qui compte : les paiements contrepassés n'en font pas
             partie, et l'écran n'a pas à refaire ce calcul. */
          total_encaisse: rows.filter((p) => !p.reversal_id)
            .reduce((s, p) => s + Number(p.amount || 0), 0),
          total_contrepasse: rows.filter((p) => p.reversal_id)
            .reduce((s, p) => s + Number(p.amount || 0), 0),
          remboursements_dus: rows.filter((p) => p.reversal_id && p.refund_pending)
            .reduce((s, p) => s + Number(p.amount || 0), 0),
        });
      } catch (e) { echec(res, e, "Erreur de lecture des paiements."); }
    });

  /* ──────────────────── CE QUE L'ON DOIT ENCORE ───────────────────────── */
  router.get(
    "/cement/remboursements-attendus",
    authenticateToken, cementModuleGuard, perm("view"),
    async (req, res) => {
      try {
        const { rows } = await pool.query(
          `SELECT * FROM v_remboursements_attendus
            WHERE company_id = $1 ORDER BY created_at DESC LIMIT 300`, [companyOf(req)]);
        res.json({
          remboursements: rows,
          total: rows.reduce((s, r) => s + Number(r.amount || 0), 0),
          /* Sable ET ciment : la question « à qui devons-nous de l'argent ? »
             ne dépend pas du module où la vente a été saisie. */
          note: rows.length
            ? `${rows.length} contrepassation(s) dont l'argent n'est pas encore revenu au client.`
            : "Aucun remboursement en attente.",
        });
      } catch (e) { echec(res, e, "Erreur de lecture des remboursements."); }
    });

  return router;
};
