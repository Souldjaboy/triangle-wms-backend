"use strict";

/**
 * RÉAFFECTER UN PAIEMENT À LA BONNE FACTURE.
 *
 *   GET  /payments/:produit/:id/historique     d'où vient ce paiement
 *   GET  /payments/:produit/:id/cibles         vers quelles factures le porter
 *   POST /payments/:produit/:id/reaffecter     le déplacer
 *   POST /payment-reallocations/:id/annuler    revenir sur un déplacement
 *   GET  /invoices/:produit/:id/paiements      les paiements d'une facture
 *
 * `:produit` vaut « sable » ou « ciment ». Le droit exigé est celui du
 * produit — `sable.paiement_reaffecter` ou `ciment.paiement_reaffecter` —
 * et non un droit transversal : qui n'a pas le ciment n'en déplace pas les
 * encaissements.
 *
 * Aucune route ne crée d'écriture de trésorerie. C'est le point entier de ce
 * module : l'argent est déjà encaissé, seule son imputation change.
 */

const express = require("express");
const R = require("../services/reaffectation-paiements");
const S = require("../services/soldes-factures");

/* Les clés d'URL, et le module de permission correspondant. Les clés
   françaises sont celles que le moteur reconnaît : services/permissions.js
   normalise « sand » en « sable » et « cement » en « ciment », de sorte
   qu'un droit posé sous la clé anglaise ne répondrait à aucune question. */
const PRODUITS = Object.freeze({
  sable: { cle: "SABLE", module: "sable" },
  ciment: { cle: "CIMENT", module: "ciment" },
});

module.exports = function createReaffectationPaiementsRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId,
          permissionsService, logActivity, isCompanyModuleEnabled } = deps;
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const utilisateurDe = (req) => ({
    id: req.user?.id || null,
    name: req.user?.fullname || req.user?.email || "Utilisateur",
  });
  const fail = (res, e, secours) => {
    if (!e.httpStatus) console.error(secours, e);
    res.status(e.httpStatus || 500).json({
      error: e.message || secours, code: e.code,
      ...(e.depassement !== undefined
        ? { depassement: e.depassement, restant_cible: e.restant_cible, montant: e.montant }
        : {}),
    });
  };

  /**
   * Le produit de l'URL, la société de la session, et le droit du produit.
   * Un module qu'on n'a pas répond 404 et non 403 : dire « interdit »
   * apprend déjà que la chose existe.
   */
  async function contexte(req, res, action) {
    const p = PRODUITS[String(req.params.produit || "").toLowerCase()];
    if (!p) {
      res.status(404).json({ error: "Ressource introuvable.", code: "NOT_FOUND" });
      return null;
    }
    const companyId = companyOf(req);
    if (!companyId) {
      res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" });
      return null;
    }
    /* La société a-t-elle souscrit au module ? Question distincte du droit
       de la personne : sans elle, une société sans le module ciment pourrait
       déplacer les encaissements de ses factures ciment. */
    try {
      if (isCompanyModuleEnabled) {
        const anglais = p.cle === "SABLE" ? "sand" : "cement";
        if (!(await isCompanyModuleEnabled(companyId, anglais))) {
          res.status(404).json({ error: "Ressource introuvable.", code: "NOT_FOUND" });
          return null;
        }
      }
      const ctx = await permissionsService.chargerContexte(pool, req.user, companyId);
      const decision = permissionsService.decider(ctx, p.module, action);
      if (decision.autorise !== true) {
        /* Si le module lui-même est invisible, 404. S'il est visible mais que
           l'action manque, 403 : la personne sait que la facture existe, elle
           doit comprendre que c'est le geste qui lui est refusé. */
        const vu = permissionsService.decider(ctx, p.module, "visible").autorise === true
                || permissionsService.decider(ctx, p.module, "view").autorise === true;
        if (!vu) { res.status(404).json({ error: "Ressource introuvable.", code: "NOT_FOUND" }); return null; }
        res.status(403).json({
          error: `Vous n'avez pas le droit de réaffecter un encaissement ${p.cle.toLowerCase()}.`,
          code: "FORBIDDEN",
        });
        return null;
      }
    } catch (e) {
      console.error("réaffectation — contrôle des droits :", e);
      res.status(500).json({ error: "Contrôle des droits impossible.", code: "PERMISSION_CHECK_FAILED" });
      return null;
    }
    return { produit: p.cle, module: p.module, companyId };
  }

  /* ───────────────────────── L'HISTOIRE D'UN PAIEMENT ─────────────────── */
  router.get("/payments/:produit/:id/historique",
    authenticateToken, async (req, res) => {
      const c = await contexte(req, res, "view"); if (!c) return;
      try {
        res.json(await R.historiquePaiement(pool, {
          companyId: c.companyId, product: c.produit, paymentId: Number(req.params.id),
        }));
      } catch (e) { fail(res, e, "Lecture impossible."); }
    });

  /* ───────────────────── VERS QUELLES FACTURES LE PORTER ──────────────── */
  router.get("/payments/:produit/:id/cibles",
    authenticateToken, async (req, res) => {
      const c = await contexte(req, res, "paiement_reaffecter"); if (!c) return;
      try {
        res.json({
          factures: await R.ciblesPossibles(pool, {
            companyId: c.companyId, product: c.produit,
            paymentId: Number(req.params.id),
            recherche: req.query.q || null,
            limite: Math.min(Number(req.query.limite) || 50, 200),
          }),
        });
      } catch (e) { fail(res, e, "Lecture impossible."); }
    });

  /* ────────────────────────────── DÉPLACER ───────────────────────────── */
  router.post("/payments/:produit/:id/reaffecter",
    authenticateToken, async (req, res) => {
      const c = await contexte(req, res, "paiement_reaffecter"); if (!c) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const r = await R.reaffecter(client, {
          companyId: c.companyId, product: c.produit,
          paymentId: Number(req.params.id),
          versFactureId: Number(req.body?.vers_facture),
          motif: req.body?.motif,
          accepterDepassement: req.body?.accepter_depassement === true,
          utilisateur: utilisateurDe(req),
        });
        await client.query("COMMIT");
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `Paiement ${r.reaffectation.payment_number} réaffecté de ${r.reaffectation.from_invoice_number} à ${r.reaffectation.to_invoice_number}`,
          c.module, r.reaffectation.reason);
        res.json({
          ...r,
          /* Dit explicitement ce qui n'a PAS eu lieu : sans cette phrase, on
             peut croire qu'un second encaissement a été enregistré. */
          avertissement: "Aucune écriture de trésorerie n'a été créée : l'argent était déjà encaissé, seule son imputation a changé.",
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Réaffectation impossible.");
      } finally { client.release(); }
    });

  /* ─────────────────── REVENIR SUR UNE RÉAFFECTATION ──────────────────── */
  router.post("/payment-reallocations/:id/annuler",
    authenticateToken, async (req, res) => {
      const companyId = companyOf(req);
      if (!companyId) return res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" });

      /* Le produit n'est pas dans l'URL : on le lit sur la trace, puis on
         vérifie le droit correspondant. Sans cela, le droit sur le sable
         permettrait d'annuler une réaffectation de ciment. */
      let trace;
      try {
        const { rows } = await pool.query(
          `SELECT product FROM payment_reallocations WHERE id = $1 AND company_id = $2`,
          [Number(req.params.id), companyId]);
        trace = rows[0];
      } catch (e) { return fail(res, e, "Lecture impossible."); }
      if (!trace) return res.status(404).json({ error: "Réaffectation introuvable.", code: "REALLOCATION_NOT_FOUND" });

      const module = trace.product === "CIMENT" ? "ciment" : "sable";
      try {
        const ctx = await permissionsService.chargerContexte(pool, req.user, companyId);
        if (permissionsService.decider(ctx, module, "paiement_reaffecter").autorise !== true) {
          return res.status(403).json({
            error: "Vous n'avez pas le droit de revenir sur cette réaffectation.", code: "FORBIDDEN",
          });
        }
      } catch (e) {
        return res.status(500).json({ error: "Contrôle des droits impossible.", code: "PERMISSION_CHECK_FAILED" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const r = await R.annulerReaffectation(client, {
          companyId, reallocationId: Number(req.params.id),
          motif: req.body?.motif, utilisateur: utilisateurDe(req),
        });
        await client.query("COMMIT");
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `Réaffectation du paiement ${r.reaffectation.payment_number} annulée`,
          module, r.reaffectation.revert_reason);
        res.json(r);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Annulation impossible.");
      } finally { client.release(); }
    });

  /* ─────────────────── LES PAIEMENTS D'UNE FACTURE ────────────────────── */
  router.get("/invoices/:produit/:id/paiements",
    authenticateToken, async (req, res) => {
      const c = await contexte(req, res, "view"); if (!c) return;
      try {
        const facture = await R.chargerFacture(pool, {
          companyId: c.companyId, product: c.produit, invoiceId: Number(req.params.id),
        });
        const paiements = await R.paiementsDeFacture(pool, {
          companyId: c.companyId, product: c.produit, invoiceId: facture.id,
        });
        res.json({
          facture: {
            id: Number(facture.id), numero: facture.invoice_number,
            client: facture.client_name, statut: facture.status,
            montant: Number(facture.total_amount),
            paye: Number(facture.paid_amount),
            restant: Number(facture.remaining_amount),
          },
          paiements,
        });
      } catch (e) { fail(res, e, "Lecture impossible."); }
    });

  return router;
};
