"use strict";

/**
 * TRANSFERTS INTERNES DE FONDS.
 *
 *   GET  /comptabilite/transferts-internes            la liste, avec filtres
 *   GET  /comptabilite/transferts-internes/comptes    les comptes et leurs soldes
 *   GET  /comptabilite/transferts-internes/:id        la fiche et ses 2 ou 4 mouvements
 *   POST /comptabilite/transferts-internes            déplacer des fonds
 *   POST /comptabilite/transferts-internes/:id/annuler  contre-passer
 *   GET  /comptabilite/transferts-internes/candidats  les anciens mouvements à examiner
 *
 * Déplacer n'est ni encaisser ni dépenser : voir services/transferts-internes.js.
 *
 * `candidats` ne reclasse rien. Elle lit la vue `v_transferts_internes_candidats`
 * et laisse une personne décider pièce par pièce — reclasser en masse changerait
 * des totaux déjà remis sans que personne ne puisse dire lesquels.
 */

const express = require("express");
const T = require("../services/tresorerie");
const TI = require("../services/transferts-internes");

const MODULE = "comptabilite.transfert_interne";

module.exports = function createTransfertsInternesRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission,
          nextAccountingNumber, createAccountingEntry, logActivity } = deps;
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
      ...(e.disponible !== undefined ? { disponible: e.disponible, demande: e.demande, requis: e.requis, manquant: e.manquant } : {}),
    });
  };

  /* ───────────────────────── LES COMPTES DISPONIBLES ───────────────────── */
  router.get("/comptabilite/transferts-internes/comptes",
    authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const [banques, caisses, tresorerie] = [
          await pool.query(
            `SELECT id, bank_name AS libelle, current_balance AS solde, is_active
               FROM accounting_banks WHERE company_id = $1 ORDER BY bank_name`, [companyId]),
          await pool.query(
            `SELECT id, nom_caisse AS libelle, solde_actuel AS solde, actif AS is_active
               FROM caisses WHERE company_id = $1 ORDER BY nom_caisse`, [companyId]),
          await pool.query(
            `SELECT id, 'Trésorerie' AS libelle, current_balance AS solde, TRUE AS is_active
               FROM treasury_accounts WHERE company_id = $1`, [companyId]),
        ];
        const forme = (r, kind) => r.rows.map((c) => ({
          kind, id: kind === TI.KINDS.TRESORERIE ? null : c.id,
          libelle: c.libelle, solde: T.francs(c.solde), actif: c.is_active !== false,
        }));
        const comptes = [
          ...forme(banques, TI.KINDS.BANQUE),
          ...forme(caisses, TI.KINDS.CAISSE),
          ...forme(tresorerie, TI.KINDS.TRESORERIE),
        ];
        res.json({
          comptes,
          /* Le total que le transfert ne doit jamais faire bouger. L'écran peut
             l'afficher avant et après : c'est la vérification la plus simple. */
          fonds_totaux: await TI.fondsTotaux(pool, companyId),
        });
      } catch (e) { fail(res, e, "Lecture des comptes impossible."); }
    });

  /* ───────────────────────────── LA LISTE ──────────────────────────────── */
  router.get("/comptabilite/transferts-internes",
    authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const conditions = ["t.company_id = $1"];
        const params = [companyId];
        const statut = String(req.query.statut || "").toUpperCase();
        if (statut === TI.STATUT.ACTIF || statut === TI.STATUT.ANNULE) {
          params.push(statut); conditions.push(`t.status = $${params.length}`);
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.du || ""))) {
          params.push(req.query.du); conditions.push(`t.transfer_date >= $${params.length}::date`);
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.au || ""))) {
          params.push(req.query.au); conditions.push(`t.transfer_date <= $${params.length}::date`);
        }
        const limite = Math.min(Math.max(Number(req.query.limite) || 100, 1), 500);

        const { rows } = await pool.query(
          `SELECT t.*, u.fullname AS auteur, a.fullname AS annulateur
             FROM internal_fund_transfers t
             LEFT JOIN users u ON u.id = t.created_by
             LEFT JOIN users a ON a.id = t.cancelled_by
            WHERE ${conditions.join(" AND ")}
            ORDER BY t.transfer_date DESC, t.id DESC
            LIMIT ${limite}`, params);

        const { rows: totaux } = await pool.query(
          `SELECT COUNT(*) FILTER (WHERE status = 'ACTIF')  AS actifs,
                  COUNT(*) FILTER (WHERE status = 'ANNULE') AS annules,
                  COALESCE(SUM(amount) FILTER (WHERE status = 'ACTIF'), 0) AS montant_actif
             FROM internal_fund_transfers WHERE company_id = $1`, [companyId]);

        res.json({
          transferts: rows,
          totaux: {
            actifs: Number(totaux[0].actifs),
            annules: Number(totaux[0].annules),
            montant_actif: T.francs(totaux[0].montant_actif),
          },
          /* Dit explicitement ce que ces montants ne sont pas, pour qu'aucun
             écran ne les additionne par erreur à un chiffre d'affaires. */
          nature: "Déplacements de fonds internes — ni recettes, ni dépenses.",
        });
      } catch (e) { fail(res, e, "Lecture des transferts impossible."); }
    });

  /* ─────────────── LES ANCIENS MOUVEMENTS À EXAMINER ───────────────────── */
  router.get("/comptabilite/transferts-internes/candidats",
    authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT * FROM v_transferts_internes_candidats
            WHERE company_id = $1 ORDER BY operation_date DESC NULLS LAST, id DESC
            LIMIT 500`, [companyId]);
        res.json({
          candidats: rows,
          total: rows.length,
          /* Aucune action automatique : la régularisation d'un mouvement ancien
             change un total déjà publié et demande une décision humaine. */
          avertissement: rows.length
            ? `${rows.length} mouvement(s) ancien(s) ressemblent à des transferts internes `
              + `et pèsent encore dans les recettes ou les dépenses. Aucun n'a été modifié : `
              + `chacun doit être examiné et régularisé pièce par pièce.`
            : "Aucun ancien mouvement candidat au reclassement.",
        });
      } catch (e) { fail(res, e, "Lecture des candidats impossible."); }
    });

  /* ─────────────────────────────── LA FICHE ────────────────────────────── */
  router.get("/comptabilite/transferts-internes/:id",
    authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT t.*, u.fullname AS auteur, a.fullname AS annulateur
             FROM internal_fund_transfers t
             LEFT JOIN users u ON u.id = t.created_by
             LEFT JOIN users a ON a.id = t.cancelled_by
            WHERE t.id = $1 AND t.company_id = $2`, [req.params.id, companyId]);
        if (!rows[0]) {
          return res.status(404).json({ error: "Transfert introuvable.", code: "TRANSFER_NOT_FOUND" });
        }
        /* Les deux mouvements d'origine, et les deux contre-écritures si le
           transfert a été annulé : quatre lignes qui expliquent chaque
           variation de solde. */
        const { rows: mouvements } = await pool.query(
          `SELECT id, transaction_number, transaction_type, direction, amount,
                  bank_id, caisse_id, source_label, destination_label, description,
                  operation_date, created_at, show_in_financial_movements,
                  is_internal_transfer, reverses_transaction_id,
                  cancelled_at, cancel_reason
             FROM accounting_transactions
            WHERE company_id = $1 AND internal_transfer_id = $2
            ORDER BY id`, [companyId, req.params.id]);
        res.json({ transfert: rows[0], mouvements });
      } catch (e) { fail(res, e, "Lecture du transfert impossible."); }
    });

  /* ───────────────────────────── DÉPLACER ─────────────────────────────── */
  router.post("/comptabilite/transferts-internes",
    authenticateToken, requirePermission(MODULE, "create"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const resultat = await TI.transferer(client, {
          companyId,
          source: req.body?.source,
          destination: req.body?.destination,
          montant: req.body?.montant ?? req.body?.amount,
          dateOperation: req.body?.date_operation || req.body?.transfer_date || null,
          motif: req.body?.motif || req.body?.reason || "",
          utilisateur: utilisateurDe(req),
          nextAccountingNumber, createAccountingEntry,
        });
        await client.query("COMMIT");

        if (typeof logActivity === "function") {
          logActivity(utilisateurDe(req).name, req.user?.role,
            "Transfert interne de fonds", "Comptabilité",
            `${resultat.transfert.reference} : ${resultat.source.libelle} → `
            + `${resultat.destination.libelle}, ${resultat.montant} FCFA — `
            + `${resultat.transfert.reason}`).catch(() => {});
        }
        res.status(201).json({
          ...resultat,
          message: `${resultat.montant.toLocaleString("fr-FR")} FCFA déplacés de `
            + `${resultat.source.libelle} vers ${resultat.destination.libelle}. `
            + `Ni recette, ni dépense : le total des fonds de l'entreprise est inchangé.`,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Transfert impossible.");
      } finally { client.release(); }
    });

  /* ───────────────────────────── ANNULER ──────────────────────────────── */
  router.post("/comptabilite/transferts-internes/:id/annuler",
    authenticateToken, requirePermission(MODULE, "delete"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const resultat = await TI.annuler(client, {
          companyId,
          transfertId: Number(req.params.id),
          motif: req.body?.motif || req.body?.reason || "",
          utilisateur: utilisateurDe(req),
          nextAccountingNumber, createAccountingEntry,
        });
        await client.query("COMMIT");

        if (typeof logActivity === "function") {
          logActivity(utilisateurDe(req).name, req.user?.role,
            "Annulation d'un transfert interne", "Comptabilité",
            `${resultat.transfert.reference} (${resultat.montant} FCFA) annulé — `
            + `${resultat.transfert.cancel_reason}`).catch(() => {});
        }
        res.json({
          ...resultat,
          message: `Transfert ${resultat.transfert.reference} annulé par contre-passation. `
            + `Les deux mouvements d'origine sont conservés ; deux mouvements inverses `
            + `les compensent. Aucune écriture n'a été effacée.`,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Annulation impossible.");
      } finally { client.release(); }
    });

  return router;
};
