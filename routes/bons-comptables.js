"use strict";

/**
 * CORRECTION DES BONS D'ENCAISSEMENT ET DE DÉCAISSEMENT.
 *
 *   PUT  /accounting/vouchers/:id              modifier — tant qu'il n'a rien produit
 *   POST /accounting/vouchers/:id/annuler      contre-passer un bon validé
 *   GET  /accounting/vouchers/:id/historique   qui a changé quoi, quand, pourquoi
 *   GET  /accounting/vouchers/incoherents      les bons refusés dont l'argent a bougé
 *
 * Les routes existantes de création, validation et refus restent dans
 * server.js : ce routeur ajoute la correction, il ne réécrit pas le parcours.
 */

const express = require("express");
const T = require("../services/tresorerie");
const B = require("../services/bons-comptables");

const MODULE = "comptabilite.bon";

module.exports = function createBonsComptablesRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission,
          nextAccountingNumber, createJournalEntry, logActivity } = deps;
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const requireCompany = (req, res) => {
    const id = companyOf(req);
    if (!id) { res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" }); return 0; }
    return id;
  };
  const utilisateurDe = (req) => ({
    id: req.user?.id || null,
    name: req.user?.fullname || req.user?.email || "Utilisateur",
  });
  const fail = (res, e, secours) => {
    if (!e.httpStatus) console.error(secours, e);
    res.status(e.httpStatus || 500).json({
      error: e.message || secours, code: e.code,
      ...(e.statut !== undefined ? { statut: e.statut } : {}),
      ...(e.disponible !== undefined ? { disponible: e.disponible, requis: e.requis } : {}),
    });
  };

  /* ─────────── LES BONS REFUSÉS DONT L'ARGENT A POURTANT BOUGÉ ─────────── */
  router.get("/accounting/vouchers/incoherents",
    authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT * FROM v_bons_incoherents WHERE company_id = $1
            ORDER BY validated_at DESC NULLS LAST, id DESC LIMIT 200`, [companyId]);
        res.json({
          bons: rows, total: rows.length,
          /* Aucune correction automatique : régulariser change un solde réel. */
          avertissement: rows.length
            ? `${rows.length} bon(s) marqué(s) refusé(s) alors que leur mouvement d'argent `
              + `existe toujours et pèse sur le résultat. Aucun n'a été corrigé : chacun `
              + `doit être examiné, puis annulé par contre-passation s'il y a lieu.`
            : "Aucun bon refusé dont le mouvement serait resté actif.",
        });
      } catch (e) { fail(res, e, "Lecture impossible."); }
    });

  /* ───────────────────────────── L'HISTORIQUE ─────────────────────────── */
  router.get("/accounting/vouchers/:id/historique",
    authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const bon = await B.charger(pool, companyId, Number(req.params.id));
        res.json({ bon, historique: await B.historique(pool, companyId, bon.id) });
      } catch (e) { fail(res, e, "Lecture de l'historique impossible."); }
    });

  /* ───────────────────────────── MODIFIER ─────────────────────────────── */
  router.put("/accounting/vouchers/:id",
    authenticateToken, requirePermission(MODULE, "update"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const resultat = await B.modifier(client, {
          companyId, bonId: Number(req.params.id),
          modifications: req.body?.modifications || req.body || {},
          motif: req.body?.motif || req.body?.reason || "",
          utilisateur: utilisateurDe(req),
        });
        await client.query("COMMIT");

        if (typeof logActivity === "function") {
          logActivity(utilisateurDe(req).name, req.user?.role,
            "Modification d'un bon comptable", "Comptabilité",
            `${resultat.bon.voucher_number} : ${Object.values(resultat.changes)
              .map((c) => `${c.libelle} ${c.avant} → ${c.apres}`).join(", ")}`).catch(() => {});
        }
        res.json({
          ...resultat,
          message: `Bon ${resultat.bon.voucher_number} modifié. `
            + `${Object.keys(resultat.changes).length} champ(s) changé(s), `
            + `chacun conservé dans l'historique avec son motif.`,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Modification impossible.");
      } finally { client.release(); }
    });

  /* ───────────────────────────── ANNULER ──────────────────────────────── */
  router.post("/accounting/vouchers/:id/annuler",
    authenticateToken, requirePermission(MODULE, "delete"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const resultat = await B.annuler(client, {
          companyId, bonId: Number(req.params.id),
          motif: req.body?.motif || req.body?.reason || "",
          utilisateur: utilisateurDe(req),
          nextAccountingNumber, createJournalEntry,
        });
        await client.query("COMMIT");

        if (typeof logActivity === "function") {
          logActivity(utilisateurDe(req).name, req.user?.role,
            "Annulation d'un bon comptable", "Comptabilité",
            `${resultat.bon.voucher_number} (${resultat.montant} FCFA) contre-passé — `
            + `${resultat.bon.cancel_reason}`).catch(() => {});
        }
        res.json({
          ...resultat,
          message: `Bon ${resultat.bon.voucher_number} annulé par contre-passation. `
            + `${resultat.compte.libelle} : ${resultat.compte.solde.toLocaleString("fr-FR")} → `
            + `${resultat.compte.solde_apres.toLocaleString("fr-FR")} FCFA. `
            + `Les écritures d'origine sont conservées. `
            + `Aucun remboursement bancaire n'a été demandé.`,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Annulation impossible.");
      } finally { client.release(); }
    });

  return router;
};
