"use strict";

/**
 * LES FACTURES QUI SE RESSEMBLENT — EXAMINER, TRANCHER, NEUTRALISER.
 *
 *   GET  /invoice-duplicates/:produit            les paires suspectes
 *   GET  /invoice-duplicates/:produit/examens    les verdicts déjà rendus
 *   POST /invoice-duplicates/:produit/trancher   rendre un verdict
 *   POST /invoice-duplicates/:id/neutraliser     neutraliser le doublon
 *
 * TROIS DROITS, PAS UN. Voir les paires demande `view`. Rendre un verdict
 * demande `validate` : dire « ce sont des renouvellements » décide qu'on ne
 * les réexaminera plus. Neutraliser demande `delete` : cela annule une
 * facture et déplace des encaissements.
 *
 * AUCUNE ROUTE NE NEUTRALISE SUR RESSEMBLANCE. La neutralisation exige un
 * examen préalablement classé DOUBLON_CONFIRME par une personne, avec son
 * motif. Il n'existe aucun chemin « tout nettoyer ».
 */

const express = require("express");
const D = require("../services/doublons-factures");

const PRODUITS = Object.freeze({
  sable: { cle: "SABLE", module: "sable", souscription: "sand" },
  ciment: { cle: "CIMENT", module: "ciment", souscription: "cement" },
});

module.exports = function createDoublonsFacturesRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId,
          permissionsService, logActivity, isCompanyModuleEnabled } = deps;
  const router = express.Router();

  const utilisateurDe = (req) => ({
    id: req.user?.id || null,
    name: req.user?.fullname || req.user?.email || "Utilisateur",
  });
  const fail = (res, e, secours) => {
    if (!e.httpStatus) console.error(secours, e);
    res.status(e.httpStatus || 500).json({
      error: e.message || secours, code: e.code,
      ...(e.paye_conservee !== undefined
        ? { paye_conservee: e.paye_conservee, paye_doublon: e.paye_doublon } : {}),
    });
  };

  async function contexte(req, res, action, produitUrl) {
    const p = PRODUITS[String(produitUrl || "").toLowerCase()];
    if (!p) { res.status(404).json({ error: "Ressource introuvable.", code: "NOT_FOUND" }); return null; }
    const companyId = Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
    if (!companyId) {
      res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" });
      return null;
    }
    try {
      if (isCompanyModuleEnabled && !(await isCompanyModuleEnabled(companyId, p.souscription))) {
        res.status(404).json({ error: "Ressource introuvable.", code: "NOT_FOUND" });
        return null;
      }
      const ctx = await permissionsService.chargerContexte(pool, req.user, companyId);
      if (permissionsService.decider(ctx, p.module, action).autorise !== true) {
        const vu = permissionsService.decider(ctx, p.module, "visible").autorise === true
                || permissionsService.decider(ctx, p.module, "view").autorise === true;
        if (!vu) { res.status(404).json({ error: "Ressource introuvable.", code: "NOT_FOUND" }); return null; }
        res.status(403).json({
          error: action === "delete"
            ? "Neutraliser une facture en double n'est pas dans vos droits."
            : "Trancher sur une paire de factures n'est pas dans vos droits.",
          code: "FORBIDDEN",
        });
        return null;
      }
    } catch (e) {
      console.error("doublons — contrôle des droits :", e);
      res.status(500).json({ error: "Contrôle des droits impossible.", code: "PERMISSION_CHECK_FAILED" });
      return null;
    }
    return { produit: p.cle, module: p.module, companyId };
  }

  /* ───────────────────────── LES PAIRES SUSPECTES ─────────────────────── */
  router.get("/invoice-duplicates/:produit", authenticateToken, async (req, res) => {
    const c = await contexte(req, res, "view", req.params.produit); if (!c) return;
    try {
      const paires = await D.paquetsSuspects(pool, {
        companyId: c.companyId, product: c.produit,
        inclureTranchees: req.query.inclure_tranchees === "1",
        limite: Math.min(Number(req.query.limite) || 200, 500),
      });
      res.json({
        produit: c.produit,
        paires,
        signaux: D.SIGNAUX,
        /* Dit en toutes lettres ce que la liste est, et ce qu'elle n'est pas. */
        avertissement: "Ces paires se RESSEMBLENT. Deux factures du même client et du même montant ne sont pas un doublon : un abonnement, une location ou une prestation répétée produisent des factures identiques. La suggestion n'est qu'un classement ; la décision appartient à une personne.",
      });
    } catch (e) { fail(res, e, "Lecture impossible."); }
  });

  /* ─────────────────────────── LES VERDICTS RENDUS ────────────────────── */
  router.get("/invoice-duplicates/:produit/examens", authenticateToken, async (req, res) => {
    const c = await contexte(req, res, "view", req.params.produit); if (!c) return;
    try {
      res.json({
        examens: await D.listerExamens(pool, {
          companyId: c.companyId, product: c.produit,
          verdict: req.query.verdict || null,
        }),
      });
    } catch (e) { fail(res, e, "Lecture impossible."); }
  });

  /* ──────────────────────────────── TRANCHER ──────────────────────────── */
  router.post("/invoice-duplicates/:produit/trancher", authenticateToken, async (req, res) => {
    const c = await contexte(req, res, "validate", req.params.produit); if (!c) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const examen = await D.trancher(client, {
        companyId: c.companyId, product: c.produit,
        factureA: req.body?.facture_a, factureB: req.body?.facture_b,
        verdict: req.body?.verdict, motif: req.body?.motif,
        utilisateur: utilisateurDe(req),
      });
      await client.query("COMMIT");
      logActivity?.(utilisateurDe(req).name, req.user?.role,
        `Paire ${examen.invoice_a_number} / ${examen.invoice_b_number} classée ${examen.verdict}`,
        c.module, examen.verdict_reason);
      res.status(201).json({
        examen,
        /* Un verdict ne neutralise rien par lui-même : il faut le dire, sans
           quoi on croit l'affaire close. */
        message: examen.verdict === "DOUBLON_CONFIRME"
          ? "Verdict enregistré. Aucune facture n'a été modifiée : la neutralisation est un geste distinct, à faire en choisissant laquelle des deux fait foi."
          : "Verdict enregistré. Cette paire ne reviendra plus dans la liste des suspects.",
      });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      fail(res, e, "Enregistrement du verdict impossible.");
    } finally { client.release(); }
  });

  /* ────────────────────────────── NEUTRALISER ─────────────────────────── */
  router.post("/invoice-duplicates/:id/neutraliser", authenticateToken, async (req, res) => {
    const companyId = Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
    if (!companyId) return res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" });

    /* Le produit se lit sur l'examen, pas sur l'URL : le droit sur le sable
       ne doit pas permettre de neutraliser une facture ciment. */
    let examen;
    try {
      const { rows } = await pool.query(
        `SELECT product FROM invoice_duplicate_reviews WHERE id = $1 AND company_id = $2`,
        [Number(req.params.id), companyId]);
      examen = rows[0];
    } catch (e) { return fail(res, e, "Lecture impossible."); }
    if (!examen) return res.status(404).json({ error: "Examen introuvable.", code: "REVIEW_NOT_FOUND" });

    const c = await contexte(req, res, "delete",
      examen.product === "CIMENT" ? "ciment" : "sable");
    if (!c) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await D.neutraliser(client, {
        companyId, examenId: Number(req.params.id),
        conserver: req.body?.conserver, motif: req.body?.motif,
        accepterPaiementsDesDeuxCotes: req.body?.accepter_paiements_des_deux_cotes === true,
        utilisateur: utilisateurDe(req),
      });
      await client.query("COMMIT");
      logActivity?.(utilisateurDe(req).name, req.user?.role,
        `Facture ${r.neutralisee.numero} neutralisée au profit de ${r.conservee.numero}`,
        c.module, `${r.paiements_deplaces} encaissement(s) déplacé(s)`);
      res.json(r);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      fail(res, e, "Neutralisation impossible.");
    } finally { client.release(); }
  });

  return router;
};
