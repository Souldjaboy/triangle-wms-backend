"use strict";

/**
 * VENTES DE SABLE : MODIFIER UN BROUILLON, LE SUPPRIMER, ANNULER OU
 * CORRIGER UNE VENTE VALIDÉE, CONTREPASSER UN PAIEMENT.
 *
 *   PATCH  /sand/sales/:id              modifier un brouillon en entier
 *   DELETE /sand/sales/:id              supprimer un brouillon
 *   POST   /sand/sales/:id/cancel       annuler une vente validée (motif obligatoire)
 *   POST   /sand/sales/:id/correct      annuler + remplacer par une vente corrigée
 *   POST   /sand/payments/:id/reverse   contrepasser un encaissement, sans annuler la vente
 *   GET    /sand/sales/:id/audit        historique complet d'une vente
 *   POST   /sand/invoices/:id/printed   enregistrer qu'une facture a été imprimée
 *   POST   /sand/deliveries/:id/printed enregistrer qu'un BL a été imprimé
 *
 * Fichier séparé de routes/sand-sales.js (déjà volumineux) : mêmes
 * dépendances, mêmes garanties de compagnie, mais un périmètre net —
 * « défaire », jamais « faire ».
 *
 * Trois règles gouvernent tout ce fichier.
 *
 * La première : rien n'est supprimé physiquement au-delà d'un BROUILLON. Une
 * vente validée s'annule ou se remplace ; sa facture et son BL suivent
 * toujours son sort, jamais séparément.
 *
 * La seconde : le module sable n'a jamais touché au stock
 * (`stock_impacted: false` partout dans sand-sales.js — aucune ligne
 * `stock_movements` n'existe pour une vente sable). Aucune route ici ne va
 * donc jamais lire ni écrire `stock_movements` ou `stock_location_balances` :
 * il n'y a rien à restituer, et en inventer un mouvement serait pire que de
 * ne rien faire.
 *
 * La troisième : un paiement encaissé ne se supprime jamais. Il se
 * contrepasse — l'argent ressort de la même destination qui l'avait reçu,
 * une écriture comptable inverse et équilibrée est posée, et le paiement
 * d'origine reste lisible, inchangé, pour toujours.
 */

const express = require("express");
const {
  recordSalePaymentAccounting, reverseSalePaymentAccounting,
} = require("./sales-payment-accounting");

const MOTIF_MIN = 3;

module.exports = function createSandSalesCancellationRouter({
  pool, authenticateToken, getEffectiveCompanyId, requirePermission,
  requireCompanyModule, accounting = {},
}) {
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const perm = (action) => requirePermission("sand", action);
  const sandModuleGuard = requireCompanyModule("sand");
  const nomDe = (req) => req.user?.fullname || req.user?.email || "Utilisateur";

  const erreur = (message, code, statut = 400) => {
    const e = new Error(message); e.code = code; e.httpStatus = statut; return e;
  };
  const echec = (res, e, defaut) => {
    if (e && e.httpStatus) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
    console.error(defaut, e);
    res.status(500).json({ error: defaut });
  };

  /** Même série que routes/sand-sales.js : PREFIX-AAMMJJ-NNN. */
  async function nextSandNumber(client, companyId, prefix) {
    const { rows } = await client.query(
      `INSERT INTO sand_counters (company_id,counter_key,counter_date,current_value)
       VALUES ($1,$2,CURRENT_DATE,1)
       ON CONFLICT (company_id,counter_key,counter_date)
       DO UPDATE SET current_value = sand_counters.current_value + 1
       RETURNING current_value`,
      [companyId, prefix]
    );
    const d = new Date();
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${prefix}-${yy}${mm}${dd}-${String(rows[0].current_value).padStart(3, "0")}`;
  }

  const motifValide = (m) => typeof m === "string" && m.trim().length >= MOTIF_MIN;

  /** Photographie complète d'une vente — pour l'avant/après de l'audit. */
  async function snapshot(client, companyId, saleId) {
    const sale = (await client.query(
      `SELECT * FROM sand_sales WHERE id = $1 AND company_id = $2`, [saleId, companyId]
    )).rows[0];
    if (!sale) return null;
    const invoice = (await client.query(
      `SELECT * FROM sand_invoices WHERE sale_id = $1 AND company_id = $2
        ORDER BY id DESC LIMIT 1`, [saleId, companyId]
    )).rows[0] || null;
    const delivery = (await client.query(
      `SELECT * FROM sand_deliveries WHERE sale_id = $1 AND company_id = $2
        ORDER BY id DESC LIMIT 1`, [saleId, companyId]
    )).rows[0] || null;
    const payments = invoice ? (await client.query(
      `SELECT p.*, EXISTS(SELECT 1 FROM sand_payment_reversals r
                            WHERE r.original_payment_id = p.id) AS reversed
         FROM sand_payments p WHERE p.invoice_id = $1 AND p.company_id = $2
        ORDER BY p.id`, [invoice.id, companyId]
    )).rows : [];
    return { sale, invoice, delivery, payments };
  }

  /** Journal — une ligne, jamais réécrite, jamais écrasée. */
  async function journal(client, {
    companyId, action, saleId, originalSaleId, replacementSaleId, invoiceId, deliveryId,
    paymentId, reason, oldValue, newValue, wasPrinted, userId, userName,
  }) {
    await client.query(
      `INSERT INTO sand_sale_audit_log
         (company_id, action, sale_id, original_sale_id, replacement_sale_id,
          invoice_id, delivery_id, payment_id, reason, old_value, new_value,
          was_already_printed, performed_by, performed_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [companyId, action, saleId || null, originalSaleId || null, replacementSaleId || null,
       invoiceId || null, deliveryId || null, paymentId || null, reason,
       oldValue ? JSON.stringify(oldValue) : null, newValue ? JSON.stringify(newValue) : null,
       Boolean(wasPrinted), userId || null, userName || ""]
    );
  }

  /** paid_amount/remaining_amount/status recalculés en EXCLUANT les paiements
      contrepassés — un paiement contrepassé reste en base, mais ne compte
      plus dans les recettes actives ni dans le solde de la facture. */
  async function recomputerFacture(client, companyId, invoiceId) {
    const { rows } = await client.query(
      `UPDATE sand_invoices i
          SET paid_amount = p.total,
              remaining_amount = GREATEST(i.total_amount - p.total, 0),
              status = CASE
                WHEN i.cancelled_at IS NOT NULL THEN i.status
                WHEN p.total >= i.total_amount AND i.total_amount > 0 THEN 'PAYEE'
                WHEN p.total > 0 THEN 'PARTIELLEMENT_PAYEE'
                ELSE 'IMPAYEE' END,
              updated_at = NOW()
         FROM (SELECT COALESCE(SUM(pay.amount), 0) AS total
                 FROM sand_payments pay
                WHERE pay.company_id = $1 AND pay.invoice_id = $2
                  AND NOT EXISTS (SELECT 1 FROM sand_payment_reversals r
                                    WHERE r.original_payment_id = pay.id)) p
        WHERE i.id = $2 AND i.company_id = $1
        RETURNING i.*`,
      [companyId, invoiceId]
    );
    return rows[0];
  }

  /**
   * Contrepasse UN paiement : argent ressorti, écritures inverses, jamais
   * une seconde fois pour le même paiement (index unique sur
   * sand_payment_reversals(company_id, original_payment_id)).
   */
  async function contrepasserPaiement(client, {
    companyId, payment, invoice, reason, userId, userName,
  }) {
    const dejaContrepasse = (await client.query(
      `SELECT id FROM sand_payment_reversals WHERE company_id = $1 AND original_payment_id = $2`,
      [companyId, payment.id]
    )).rows[0];
    if (dejaContrepasse) {
      throw erreur("Ce paiement a déjà été contrepassé.", "ALREADY_REVERSED", 409);
    }

    const reversal = (await client.query(
      `INSERT INTO sand_payment_reversals
         (company_id, invoice_id, original_payment_id, amount, reason,
          refund_pending, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7)
       RETURNING *`,
      [companyId, invoice.id, payment.id, payment.amount, reason, userId, userName]
    )).rows[0];

    const { transaction } = await reverseSalePaymentAccounting(client, {
      companyId, module: "sand", payment, amount: Number(payment.amount),
      invoiceNumber: invoice.invoice_number, partnerName: invoice.customer_id ? null : null,
      userId, accounting, reversalSourceId: reversal.id,
    });

    await client.query(
      `UPDATE sand_payment_reversals SET reversal_accounting_transaction_id = $1 WHERE id = $2`,
      [transaction.id, reversal.id]
    );

    const updatedInvoice = await recomputerFacture(client, companyId, invoice.id);
    return { reversal: { ...reversal, reversal_accounting_transaction_id: transaction.id }, invoice: updatedInvoice };
  }

  // ══════════════════════════ BROUILLON : MODIFIER ══════════════════════

  router.patch(
    "/sand/sales/:id",
    authenticateToken, sandModuleGuard, perm("vente_modifier_brouillon"),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const companyId = companyOf(req);
        await client.query("BEGIN");

        const sale = (await client.query(
          `SELECT * FROM sand_sales WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [req.params.id, companyId]
        )).rows[0];
        if (!sale) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Vente introuvable." }); }
        if (sale.status !== "BROUILLON") {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: `Seul un brouillon se modifie ainsi (statut actuel : ${sale.status}). `
                 + "Utilisez la correction pour une vente validée.",
            code: "NOT_DRAFT",
          });
        }

        const b = req.body || {};
        const customerId = b.customer_id != null ? Number(b.customer_id) : sale.customer_id;
        const productId = b.sand_product_id != null ? Number(b.sand_product_id) : sale.sand_product_id;
        const destination = b.destination != null ? String(b.destination).trim() : sale.destination;
        const deliveryPlace = b.delivery_place != null ? String(b.delivery_place).trim() : sale.delivery_place;
        const quantity = b.quantity_m3 != null ? Number(b.quantity_m3) : Number(sale.quantity_m3);
        const unitPrice = b.unit_price != null ? Number(b.unit_price) : Number(sale.unit_price);
        const transportPrice = b.transport_price != null ? Number(b.transport_price) : Number(sale.transport_price);
        const transportMode = String(b.transport_mode || "PAR_OPERATION");
        const discount = b.discount != null ? Math.max(Number(b.discount), 0) : Number(sale.discount);
        const taxAmount = b.tax_amount != null ? Math.max(Number(b.tax_amount), 0) : Number(sale.tax_amount);
        const saleDate = b.sale_date || sale.sale_date;

        if (!customerId || !productId || !destination || !(quantity > 0) || !(unitPrice > 0)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Client, produit, destination, quantité et prix sont obligatoires." });
        }

        const customer = (await client.query(
          `SELECT * FROM sand_customers WHERE id = $1 AND company_id = $2`, [customerId, companyId]
        )).rows[0];
        if (!customer) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Client introuvable." }); }
        const product = (await client.query(
          `SELECT * FROM sand_products WHERE id = $1 AND company_id = $2`, [productId, companyId]
        )).rows[0];
        if (!product) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Produit sable introuvable." }); }

        const sandSubtotal = quantity * unitPrice;
        const transportTotal = transportMode === "PAR_M3" ? quantity * transportPrice : transportPrice;
        const total = Math.max(sandSubtotal + transportTotal - discount + taxAmount, 0);
        const paid = Math.max(Math.min(b.paid_amount != null ? Number(b.paid_amount) : Number(sale.paid_amount), total), 0);
        const remaining = total - paid;

        const avant = { ...sale };
        const { rows: majs } = await client.query(
          `UPDATE sand_sales SET
             customer_id=$1, customer_name=$2, customer_phone=$3, customer_address=$4,
             sand_product_id=$5, product_name=$6, destination=$7, delivery_place=$8,
             quantity_m3=$9, unit_price=$10, sand_subtotal=$11,
             transport_price=$12, transport_total=$13, discount=$14, tax_amount=$15,
             total_amount=$16, paid_amount=$17, remaining_amount=$18,
             truck=$19, driver_name=$20, voucher_number=$21, notes=$22,
             sale_date=$23, expected_payment_method=$24, updated_at=NOW()
           WHERE id=$25 AND company_id=$26 AND status='BROUILLON'
           RETURNING *`,
          [customer.id, customer.name, customer.phone, customer.address,
           product.id, product.name, destination, deliveryPlace || destination,
           quantity, unitPrice, sandSubtotal,
           transportPrice, transportTotal, discount, taxAmount,
           total, paid, remaining,
           b.truck != null ? String(b.truck).trim() || null : sale.truck,
           b.driver_name != null ? String(b.driver_name).trim() || null : sale.driver_name,
           b.voucher_number != null ? String(b.voucher_number).trim() || null : sale.voucher_number,
           b.notes != null ? String(b.notes).trim() || null : sale.notes,
           saleDate,
           b.expected_payment_method != null ? String(b.expected_payment_method).trim() || null : sale.expected_payment_method,
           sale.id, companyId]
        );
        if (!majs[0]) {
          /* Une validation a pu se glisser entre le SELECT FOR UPDATE et
             maintenant sur une connexion concurrente inattendue : le WHERE
             status='BROUILLON' l'aurait déjà empêché, mais on le dit
             explicitement plutôt que de renvoyer un succès trompeur. */
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "La vente a changé de statut entre-temps.", code: "STATUS_CHANGED" });
        }

        await journal(client, {
          companyId, action: "DRAFT_UPDATE", saleId: sale.id, reason: "Modification du brouillon",
          oldValue: avant, newValue: majs[0], wasPrinted: false,
          userId: req.user.id, userName: nomDe(req),
        });

        await client.query("COMMIT");
        res.json({ success: true, sale: majs[0] });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        echec(res, e, "Erreur de modification du brouillon.");
      } finally { client.release(); }
    }
  );

  // ══════════════════════════ BROUILLON : SUPPRIMER ═════════════════════

  router.delete(
    "/sand/sales/:id",
    authenticateToken, sandModuleGuard, perm("vente_supprimer_brouillon"),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const companyId = companyOf(req);
        await client.query("BEGIN");

        const sale = (await client.query(
          `SELECT * FROM sand_sales WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [req.params.id, companyId]
        )).rows[0];
        if (!sale) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Vente introuvable." }); }
        if (sale.status !== "BROUILLON") {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: `Seul un brouillon se supprime (statut actuel : ${sale.status}). `
                 + "Une vente validée s'annule, elle ne se supprime pas.",
            code: "NOT_DRAFT",
          });
        }

        /* Garde-fou : un brouillon ne devrait jamais porter de facture ou de
           BL actifs (ils ne naissent qu'à la validation) — mais si l'état
           réel en dit autrement, refuser plutôt que supprimer un document
           définitif par la bande. */
        const documentActif = (await client.query(
          `SELECT
             (SELECT count(*) FROM sand_invoices WHERE sale_id=$1 AND company_id=$2 AND cancelled_at IS NULL) AS factures,
             (SELECT count(*) FROM sand_deliveries WHERE sale_id=$1 AND company_id=$2 AND cancelled_at IS NULL) AS bls`,
          [sale.id, companyId]
        )).rows[0];
        if (Number(documentActif.factures) > 0 || Number(documentActif.bls) > 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "Ce brouillon porte déjà une facture ou un BL actif : il ne peut pas être supprimé silencieusement.",
            code: "ACTIVE_DOCUMENT_EXISTS",
          });
        }

        await journal(client, {
          companyId, action: "DRAFT_DELETE", saleId: sale.id, reason: "Suppression du brouillon",
          oldValue: sale, newValue: null, wasPrinted: false,
          userId: req.user.id, userName: nomDe(req),
        });

        await client.query(`DELETE FROM sand_sales WHERE id = $1 AND company_id = $2`, [sale.id, companyId]);

        await client.query("COMMIT");
        res.json({ success: true, deleted_sale_number: sale.sale_number });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        echec(res, e, "Erreur de suppression du brouillon.");
      } finally { client.release(); }
    }
  );

  // ══════════════════════════ VENTE VALIDÉE : ANNULER ═══════════════════

  /**
   * Le cœur commun à l'annulation pure et à la correction : tout ce qui doit
   * disparaître ensemble, dans UNE transaction déjà ouverte par l'appelant.
   * Ne fait JAMAIS le COMMIT/ROLLBACK — c'est la route appelante qui décide.
   */
  async function annulerVenteCore(client, { companyId, sale, reason, userId, userName }) {
    if (sale.status !== "VALIDEE") {
      throw erreur(`Seule une vente validée s'annule ainsi (statut actuel : ${sale.status}).`, "NOT_VALIDATED", 409);
    }

    const invoice = (await client.query(
      `SELECT * FROM sand_invoices WHERE sale_id = $1 AND company_id = $2 AND cancelled_at IS NULL FOR UPDATE`,
      [sale.id, companyId]
    )).rows[0];
    const delivery = (await client.query(
      `SELECT * FROM sand_deliveries WHERE sale_id = $1 AND company_id = $2 AND cancelled_at IS NULL FOR UPDATE`,
      [sale.id, companyId]
    )).rows[0];

    const avant = await snapshot(client, companyId, sale.id);
    const paiementsContrepasses = [];

    /* Vente payée (même partiellement) : chaque paiement encore actif est
       contrepassé — jamais supprimé. Vente impayée : rien à contrepasser,
       seule la dette disparaît avec la facture annulée. */
    if (invoice) {
      const paiementsActifs = (await client.query(
        `SELECT p.* FROM sand_payments p
          WHERE p.invoice_id = $1 AND p.company_id = $2
            AND NOT EXISTS (SELECT 1 FROM sand_payment_reversals r WHERE r.original_payment_id = p.id)
          ORDER BY p.id FOR UPDATE OF p`,
        [invoice.id, companyId]
      )).rows;

      for (const paiement of paiementsActifs) {
        const { reversal } = await contrepasserPaiement(client, {
          companyId, payment: paiement, invoice, reason: `Annulation de la vente ${sale.sale_number} : ${reason}`,
          userId, userName,
        });
        paiementsContrepasses.push({ payment_id: paiement.id, reversal_id: reversal.id, amount: Number(paiement.amount) });
        await journal(client, {
          companyId, action: "PAYMENT_REVERSE", saleId: sale.id, invoiceId: invoice.id, paymentId: paiement.id,
          reason: `Annulation de la vente ${sale.sale_number} : ${reason}`,
          oldValue: paiement, newValue: { reversal }, wasPrinted: false, userId, userName,
        });
      }
    }

    let invoiceAnnulee = null;
    if (invoice) {
      const { rows } = await client.query(
        `UPDATE sand_invoices
            SET status='ANNULEE', cancelled_by=$1, cancelled_by_name=$2, cancelled_at=NOW(),
                cancellation_reason=$3, updated_at=NOW()
          WHERE id=$4 AND company_id=$5
          RETURNING *`,
        [userId, userName, reason, invoice.id, companyId]
      );
      invoiceAnnulee = rows[0];
    }

    let deliveryAnnulee = null;
    if (delivery) {
      const { rows } = await client.query(
        `UPDATE sand_deliveries
            SET cancelled_by=$1, cancelled_by_name=$2, cancelled_at=NOW(), cancellation_reason=$3, updated_at=NOW()
          WHERE id=$4 AND company_id=$5
          RETURNING *`,
        [userId, userName, reason, delivery.id, companyId]
      );
      deliveryAnnulee = rows[0];
    }

    const { rows: saleAnnulee } = await client.query(
      `UPDATE sand_sales
          SET status='ANNULEE', cancelled_by=$1, cancelled_by_name=$2, cancelled_at=NOW(),
              cancellation_reason=$3, updated_at=NOW()
        WHERE id=$4 AND company_id=$5
        RETURNING *`,
      [userId, userName, reason, sale.id, companyId]
    );

    return {
      sale: saleAnnulee[0], invoice: invoiceAnnulee, delivery: deliveryAnnulee,
      paiementsContrepasses, avant,
    };
  }

  router.post(
    "/sand/sales/:id/cancel",
    authenticateToken, sandModuleGuard, perm("vente_annuler"),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const companyId = companyOf(req);
        const reason = String(req.body?.reason || "").trim();
        if (!motifValide(reason)) {
          return res.status(400).json({ error: "Un motif d'annulation est obligatoire.", code: "REASON_REQUIRED" });
        }

        await client.query("BEGIN");
        const sale = (await client.query(
          `SELECT * FROM sand_sales WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [req.params.id, companyId]
        )).rows[0];
        if (!sale) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Vente introuvable." }); }

        const resultat = await annulerVenteCore(client, {
          companyId, sale, reason, userId: req.user.id, userName: nomDe(req),
        });

        await journal(client, {
          companyId, action: "CANCEL", saleId: sale.id,
          invoiceId: resultat.invoice?.id, deliveryId: resultat.delivery?.id,
          reason, oldValue: resultat.avant, newValue: { sale: resultat.sale },
          wasPrinted: Number(resultat.avant.invoice?.print_count || 0) > 0
            || Number(resultat.avant.delivery?.print_count || 0) > 0,
          userId: req.user.id, userName: nomDe(req),
        });

        await client.query("COMMIT");
        res.json({
          success: true,
          sale_cancelled: true,
          invoice_cancelled: Boolean(resultat.invoice),
          delivery_cancelled: Boolean(resultat.delivery),
          stock_restored: false,
          payments_reversed: resultat.paiementsContrepasses,
          sale: resultat.sale, invoice: resultat.invoice, delivery: resultat.delivery,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        echec(res, e, "Erreur d'annulation de la vente.");
      } finally { client.release(); }
    }
  );

  // ══════════════════════════ VENTE VALIDÉE : CORRIGER ══════════════════

  router.post(
    "/sand/sales/:id/correct",
    authenticateToken, sandModuleGuard, perm("vente_corriger_validee"),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const companyId = companyOf(req);
        const reason = String(req.body?.reason || "").trim();
        if (!motifValide(reason)) {
          return res.status(400).json({ error: "Un motif de correction est obligatoire.", code: "REASON_REQUIRED" });
        }

        const b = req.body || {};
        await client.query("BEGIN");

        const sale = (await client.query(
          `SELECT * FROM sand_sales WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [req.params.id, companyId]
        )).rows[0];
        if (!sale) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Vente introuvable." }); }

        // ── 1. Les nouvelles valeurs, résolues AVANT d'annuler quoi que ce soit ──
        const customerId = b.customer_id != null ? Number(b.customer_id) : sale.customer_id;
        const productId = b.sand_product_id != null ? Number(b.sand_product_id) : sale.sand_product_id;
        const destination = b.destination != null ? String(b.destination).trim() : sale.destination;
        const deliveryPlace = b.delivery_place != null ? String(b.delivery_place).trim() : sale.delivery_place;
        const quantity = b.quantity_m3 != null ? Number(b.quantity_m3) : Number(sale.quantity_m3);
        const unitPrice = b.unit_price != null ? Number(b.unit_price) : Number(sale.unit_price);
        const transportPrice = b.transport_price != null ? Number(b.transport_price) : Number(sale.transport_price);
        const transportMode = String(b.transport_mode || "PAR_OPERATION");
        const discount = b.discount != null ? Math.max(Number(b.discount), 0) : Number(sale.discount);
        const taxAmount = b.tax_amount != null ? Math.max(Number(b.tax_amount), 0) : Number(sale.tax_amount);
        const saleDate = b.sale_date || sale.sale_date;

        if (!customerId || !productId || !destination || !(quantity > 0) || !(unitPrice > 0)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Client, produit, destination, quantité et prix sont obligatoires." });
        }
        const customer = (await client.query(
          `SELECT * FROM sand_customers WHERE id = $1 AND company_id = $2`, [customerId, companyId]
        )).rows[0];
        if (!customer) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Client introuvable." }); }
        const product = (await client.query(
          `SELECT * FROM sand_products WHERE id = $1 AND company_id = $2`, [productId, companyId]
        )).rows[0];
        if (!product) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Produit sable introuvable." }); }

        // ── 2. Annuler l'ancienne vente, sa facture, son BL, ses paiements ──
        const ancien = await annulerVenteCore(client, {
          companyId, sale, reason: `Correction : ${reason}`, userId: req.user.id, userName: nomDe(req),
        });

        // ── 3. Créer la nouvelle vente, déjà VALIDÉE (elle produit tout de
        //      suite sa facture et son BL, comme demandé). ──
        const sandSubtotal = quantity * unitPrice;
        const transportTotal = transportMode === "PAR_M3" ? quantity * transportPrice : transportPrice;
        const total = Math.max(sandSubtotal + transportTotal - discount + taxAmount, 0);
        const saleNumber = await nextSandNumber(client, companyId, "VS");

        const nouvelleVente = (await client.query(
          `INSERT INTO sand_sales
             (company_id, sale_number, customer_id, customer_name, customer_phone, customer_address,
              sand_product_id, product_name, destination, delivery_place,
              quantity_m3, unit_price, sand_subtotal, transport_price, transport_total,
              discount, tax_amount, total_amount, paid_amount, remaining_amount,
              truck, driver_name, voucher_number, notes, status, sale_date,
              created_by, validated_by, validated_at, price_reference_qty,
              expected_payment_method, replaces_sale_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,0,$18,
                   $19,$20,$21,$22,'VALIDEE',$23,$24,$24,NOW(),$25,$26,$27)
           RETURNING *`,
          [companyId, saleNumber, customer.id, customer.name, customer.phone, customer.address,
           product.id, product.name, destination, deliveryPlace || destination,
           quantity, unitPrice, sandSubtotal, transportPrice, transportTotal,
           discount, taxAmount, total,
           b.truck != null ? String(b.truck).trim() || null : sale.truck,
           b.driver_name != null ? String(b.driver_name).trim() || null : sale.driver_name,
           b.voucher_number != null ? String(b.voucher_number).trim() || null : sale.voucher_number,
           b.notes != null ? String(b.notes).trim() || null : sale.notes,
           saleDate, req.user.id, Number(sale.price_reference_qty || 10),
           /* « Conserver le mode de paiement d'origine » : celui du dernier
              paiement contrepassé s'il y en a un, sinon celui déjà indiqué
              sur l'ancienne vente. Une indication, jamais une écriture
              financière automatique — le nouvel encaissement reste à faire. */
           (ancien.paiementsContrepasses[0] && ancien.avant.payments.find(
             (p) => p.id === ancien.paiementsContrepasses[0].payment_id)?.payment_method)
             || sale.expected_payment_method || null,
           sale.id]
        )).rows[0];

        const deliveryNumber = await nextSandNumber(client, companyId, "BL-SAB");
        const invoiceNumber = await nextSandNumber(client, companyId, "FAC-SAB");

        const nouveauBL = (await client.query(
          `INSERT INTO sand_deliveries
             (company_id, sale_id, delivery_number, destination, quantity_m3, truck, driver_name,
              voucher_number, delivered_by, notes, created_by, replaces_delivery_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING *`,
          [companyId, nouvelleVente.id, deliveryNumber, nouvelleVente.delivery_place || nouvelleVente.destination,
           nouvelleVente.quantity_m3, nouvelleVente.truck, nouvelleVente.driver_name,
           nouvelleVente.voucher_number, nomDe(req), nouvelleVente.notes, req.user.id,
           ancien.delivery?.id || null]
        )).rows[0];

        const nouvelleFacture = (await client.query(
          `INSERT INTO sand_invoices
             (company_id, sale_id, customer_id, invoice_number, operation_reference, destination,
              total_amount, paid_amount, remaining_amount, status, notes, created_by, validated_by,
              validated_at, replaces_invoice_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,0,$7,'IMPAYEE',$8,$9,$9,NOW(),$10)
           RETURNING *`,
          [companyId, nouvelleVente.id, nouvelleVente.customer_id, invoiceNumber, nouvelleVente.sale_number,
           nouvelleVente.destination, nouvelleVente.total_amount, nouvelleVente.notes, req.user.id,
           ancien.invoice?.id || null]
        )).rows[0];

        // ── 4. Boucler les liens dans les deux sens ──
        await client.query(
          `UPDATE sand_sales SET replaced_by_sale_id = $1 WHERE id = $2 AND company_id = $3`,
          [nouvelleVente.id, sale.id, companyId]
        );
        if (ancien.invoice) {
          await client.query(
            `UPDATE sand_invoices SET replaced_by_invoice_id = $1 WHERE id = $2 AND company_id = $3`,
            [nouvelleFacture.id, ancien.invoice.id, companyId]
          );
        }
        if (ancien.delivery) {
          await client.query(
            `UPDATE sand_deliveries SET replaced_by_delivery_id = $1 WHERE id = $2 AND company_id = $3`,
            [nouveauBL.id, ancien.delivery.id, companyId]
          );
        }
        /* La vente REMPLACÉE, distincte d'ANNULÉE : elle n'a pas disparu
           sans suite, elle a une adresse de correction connue. */
        const { rows: venteFinale } = await client.query(
          `UPDATE sand_sales SET status='REMPLACEE' WHERE id=$1 AND company_id=$2 RETURNING *`,
          [sale.id, companyId]
        );

        await journal(client, {
          companyId, action: "CORRECT", saleId: sale.id, originalSaleId: sale.id,
          replacementSaleId: nouvelleVente.id, invoiceId: ancien.invoice?.id, deliveryId: ancien.delivery?.id,
          reason, oldValue: ancien.avant,
          newValue: { sale: nouvelleVente, invoice: nouvelleFacture, delivery: nouveauBL },
          wasPrinted: Number(ancien.avant.invoice?.print_count || 0) > 0
            || Number(ancien.avant.delivery?.print_count || 0) > 0,
          userId: req.user.id, userName: nomDe(req),
        });

        await client.query("COMMIT");
        res.status(201).json({
          success: true,
          old_sale: venteFinale[0], old_invoice: ancien.invoice, old_delivery: ancien.delivery,
          new_sale: nouvelleVente, new_invoice: nouvelleFacture, new_delivery: nouveauBL,
          payments_reversed: ancien.paiementsContrepasses,
          comparison: { before: ancien.avant.sale, after: nouvelleVente },
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        echec(res, e, "Erreur de correction de la vente.");
      } finally { client.release(); }
    }
  );

  // ══════════════════════════ PAIEMENT : CONTREPASSER SEUL ══════════════

  router.post(
    "/sand/payments/:id/reverse",
    authenticateToken, sandModuleGuard, perm("paiement_contrepasser"),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const companyId = companyOf(req);
        const reason = String(req.body?.reason || "").trim();
        if (!motifValide(reason)) {
          return res.status(400).json({ error: "Un motif de contrepassation est obligatoire.", code: "REASON_REQUIRED" });
        }

        await client.query("BEGIN");
        const payment = (await client.query(
          `SELECT * FROM sand_payments WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [req.params.id, companyId]
        )).rows[0];
        if (!payment) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Paiement introuvable." }); }

        const invoice = (await client.query(
          `SELECT * FROM sand_invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [payment.invoice_id, companyId]
        )).rows[0];
        if (!invoice) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Facture introuvable." }); }

        const { reversal, invoice: updatedInvoice } = await contrepasserPaiement(client, {
          companyId, payment, invoice, reason, userId: req.user.id, userName: nomDe(req),
        });

        await journal(client, {
          companyId, action: "PAYMENT_REVERSE", invoiceId: invoice.id, paymentId: payment.id,
          reason, oldValue: payment, newValue: { reversal }, wasPrinted: Number(invoice.print_count || 0) > 0,
          userId: req.user.id, userName: nomDe(req),
        });

        await client.query("COMMIT");
        res.json({ success: true, reversal, invoice: updatedInvoice, payment });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        echec(res, e, "Erreur de contrepassation du paiement.");
      } finally { client.release(); }
    }
  );

  // ══════════════════════════ HISTORIQUE ════════════════════════════════

  router.get(
    "/sand/sales/:id/audit",
    authenticateToken, sandModuleGuard, perm("view"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        const sale = (await pool.query(
          `SELECT * FROM sand_sales WHERE id = $1 AND company_id = $2`, [req.params.id, companyId]
        )).rows[0];
        if (!sale) return res.status(404).json({ error: "Vente introuvable." });

        /* La chaîne complète : on remonte vers l'origine (replaces_sale_id),
           puis on descend vers le remplaçant le plus récent
           (replaced_by_sale_id). `chaine.includes` coupe court à toute
           boucle si les données étaient un jour incohérentes. */
        const chaine = [sale.id];
        let curseur = sale.replaces_sale_id;
        while (curseur && !chaine.includes(curseur)) {
          chaine.push(curseur);
          const precedente = (await pool.query(
            `SELECT replaces_sale_id FROM sand_sales WHERE id = $1 AND company_id = $2`,
            [curseur, companyId]
          )).rows[0];
          curseur = precedente?.replaces_sale_id || null;
        }
        curseur = sale.replaced_by_sale_id;
        while (curseur && !chaine.includes(curseur)) {
          chaine.push(curseur);
          const suivante = (await pool.query(
            `SELECT replaced_by_sale_id FROM sand_sales WHERE id = $1 AND company_id = $2`,
            [curseur, companyId]
          )).rows[0];
          curseur = suivante?.replaced_by_sale_id || null;
        }

        const { rows: entries } = await pool.query(
          `SELECT * FROM sand_sale_audit_log
            WHERE company_id = $1 AND (sale_id = ANY($2::int[]) OR original_sale_id = ANY($2::int[])
                                        OR replacement_sale_id = ANY($2::int[]))
            ORDER BY created_at`,
          [companyId, chaine]
        );
        const { rows: ventesLiees } = await pool.query(
          `SELECT * FROM sand_sales WHERE id = ANY($1::int[]) AND company_id = $2 ORDER BY id`,
          [chaine, companyId]
        );

        res.json({ success: true, sale, chain: ventesLiees, entries });
      } catch (e) { echec(res, e, "Erreur de lecture de l'historique."); }
    }
  );

  // ══════════════════════════ IMPRESSION ═════════════════════════════════

  router.post(
    "/sand/invoices/:id/printed",
    authenticateToken, sandModuleGuard, perm("print"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        const { rows } = await pool.query(
          `UPDATE sand_invoices SET printed_at = NOW(), print_count = print_count + 1, updated_at = NOW()
            WHERE id = $1 AND company_id = $2 RETURNING id, printed_at, print_count`,
          [req.params.id, companyId]
        );
        if (!rows[0]) return res.status(404).json({ error: "Facture introuvable." });
        res.json({ success: true, ...rows[0] });
      } catch (e) { echec(res, e, "Erreur d'enregistrement d'impression."); }
    }
  );

  router.post(
    "/sand/deliveries/:id/printed",
    authenticateToken, sandModuleGuard, perm("print"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        const { rows } = await pool.query(
          `UPDATE sand_deliveries SET printed_at = NOW(), print_count = print_count + 1, updated_at = NOW()
            WHERE id = $1 AND company_id = $2 RETURNING id, printed_at, print_count`,
          [req.params.id, companyId]
        );
        if (!rows[0]) return res.status(404).json({ error: "BL introuvable." });
        res.json({ success: true, ...rows[0] });
      } catch (e) { echec(res, e, "Erreur d'enregistrement d'impression."); }
    }
  );

  return router;
};
