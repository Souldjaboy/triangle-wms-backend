"use strict";

/**
 * ACCÈS MULTI-SOCIÉTÉS — un compte, plusieurs sociétés, sans second compte.
 *
 *   GET    /acces-societes/mes-societes      les sociétés que JE peux atteindre
 *   GET    /acces-societes/:userId           habilitations d'un compte
 *   POST   /acces-societes                   accorder   { user_id, company_id, reason }
 *   DELETE /acces-societes/:userId/:companyId  révoquer  { reason }
 *   GET    /acces-societes/:userId/journal    historique des décisions
 *
 * Deux gardes distinctes, et c'est volontaire :
 *
 *   • `/mes-societes` ne demande rien d'autre qu'un jeton valide : savoir
 *     entre quelles sociétés on peut basculer n'est pas un privilège, c'est
 *     ce dont le sélecteur d'entreprise a besoin pour s'afficher.
 *
 *   • accorder ou révoquer passe par `utilisateur.acces_societes|manage`
 *     (migration 079). Donner à un compte la vue sur une autre société est
 *     une décision d'administration, pas un réglage d'écran.
 *
 * Une habilitation n'accorde AUCUN droit métier : une fois dans la société
 * d'accueil, le compte est jugé par le même moteur RBAC avec le `company_id`
 * effectif. Ouvrir la porte et pouvoir agir derrière restent deux questions.
 */

const express = require("express");
const acces = require("../services/acces-societes");

module.exports = function createAccesSocietesRouter(deps) {
  const { pool, authenticateToken, requirePermission } = deps;
  const router = express.Router();

  const nomDe = (req) => req.user?.fullname || req.user?.email || "Utilisateur";
  const fail = (res, e, message) => {
    console.error(message, e);
    res.status(500).json({ error: message });
  };

  /* Les sociétés du sélecteur d'entreprise, avec leur nom. `authenticateToken`
     a déjà résolu la liste ; on n'y ajoute que de quoi l'afficher. */
  router.get("/acces-societes/mes-societes", authenticateToken, async (req, res) => {
    try {
      const ids = Array.isArray(req.user?.societes_autorisees) ? req.user.societes_autorisees : [];
      if (!ids.length) return res.json({ societes: [], active: Number(req.user?.company_id || 0) || null });

      const { rows } = await pool.query(
        `SELECT id, name, badge_prefix FROM companies WHERE id = ANY($1::int[]) ORDER BY name`,
        [ids]
      );
      res.json({
        societes: rows,
        active: Number(req.user?.company_id || 0) || null,
        origine: Number(req.user?.company_id || 0) || null,
      });
    } catch (e) { fail(res, e, "Impossible de lire les sociétés accessibles."); }
  });

  router.get(
    "/acces-societes/:userId",
    authenticateToken,
    requirePermission("utilisateur.acces_societes", "view"),
    async (req, res) => {
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: "Compte invalide." });
      }
      try {
        const { rows: compte } = await pool.query(
          `SELECT id, fullname, email, role, company_id, is_super_admin FROM users WHERE id = $1`,
          [userId]
        );
        if (!compte[0]) return res.status(404).json({ error: "Compte introuvable." });

        const { rows: habilitations } = await pool.query(
          `SELECT a.company_id, c.name AS company_name, a.reason, a.active,
                  a.created_at, a.updated_at, u.fullname AS granted_by_name
             FROM user_company_access a
             JOIN companies c ON c.id = a.company_id
             LEFT JOIN users u ON u.id = a.granted_by
            WHERE a.user_id = $1
            ORDER BY c.name`,
          [userId]
        );
        res.json({
          compte: compte[0],
          societe_origine: compte[0].company_id,
          habilitations,
        });
      } catch (e) { fail(res, e, "Impossible de lire les habilitations."); }
    }
  );

  router.post(
    "/acces-societes",
    authenticateToken,
    requirePermission("utilisateur.acces_societes", "manage"),
    async (req, res) => {
      const userId = Number(req.body?.user_id);
      const companyId = Number(req.body?.company_id);
      const reason = String(req.body?.reason || "").trim();

      if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: "Compte invalide." });
      if (!Number.isInteger(companyId) || companyId <= 0) return res.status(400).json({ error: "Société invalide." });
      if (reason.length < 3) {
        return res.status(400).json({
          error: "Un motif est obligatoire : il explique, des mois plus tard, pourquoi ce compte voit cette société.",
          code: "REASON_REQUIRED",
        });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const { rows: cible } = await client.query(
          `SELECT id, company_id, tenant_id, is_super_admin FROM users WHERE id = $1 FOR UPDATE`,
          [userId]
        );
        if (!cible[0]) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Compte introuvable." }); }

        const { rows: societe } = await client.query(
          `SELECT id, name, tenant_id, COALESCE(status,'active') AS status FROM companies WHERE id = $1`,
          [companyId]
        );
        if (!societe[0]) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Société introuvable." }); }
        if (societe[0].status === "deleted") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Cette société est supprimée." });
        }

        /* Le cloisonnement de version prime sur l'habilitation : une
           habilitation ne doit jamais faire franchir la frontière d'un
           tenant, même accordée de bonne foi. */
        const tenantCompte = String(cible[0].tenant_id || "");
        const tenantSociete = String(societe[0].tenant_id || "");
        if (tenantCompte && tenantSociete && tenantCompte !== tenantSociete) {
          await client.query("ROLLBACK");
          return res.status(403).json({
            error: "Ce compte et cette société n'appartiennent pas à la même version de l'application.",
            code: "TENANT_MISMATCH",
          });
        }

        if (Number(cible[0].company_id) === companyId) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "C'est déjà la société d'origine de ce compte : elle lui est acquise sans habilitation.",
            code: "ALREADY_HOME_COMPANY",
          });
        }

        const resultat = await acces.accorder(client, {
          userId, companyId, reason,
          performedBy: req.user?.id || null,
          performedByName: nomDe(req),
        });

        await client.query("COMMIT");
        res.status(201).json({
          ok: true,
          societe: societe[0].name,
          cree: resultat.creation === true,
          message: `Ce compte peut désormais basculer vers ${societe[0].name}.`,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Impossible d'accorder cet accès.");
      } finally { client.release(); }
    }
  );

  router.delete(
    "/acces-societes/:userId/:companyId",
    authenticateToken,
    requirePermission("utilisateur.acces_societes", "manage"),
    async (req, res) => {
      const userId = Number(req.params.userId);
      const companyId = Number(req.params.companyId);
      const reason = String(req.body?.reason || "").trim();
      if (!Number.isInteger(userId) || !Number.isInteger(companyId)) {
        return res.status(400).json({ error: "Paramètres invalides." });
      }
      if (reason.length < 3) {
        return res.status(400).json({ error: "Un motif de révocation est obligatoire.", code: "REASON_REQUIRED" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const retire = await acces.revoquer(client, {
          userId, companyId, reason,
          performedBy: req.user?.id || null,
          performedByName: nomDe(req),
        });
        await client.query("COMMIT");
        if (!retire) return res.status(404).json({ error: "Aucune habilitation active à révoquer." });
        res.json({ ok: true, message: "Accès révoqué. L'historique le conserve." });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Impossible de révoquer cet accès.");
      } finally { client.release(); }
    }
  );

  router.get(
    "/acces-societes/:userId/journal",
    authenticateToken,
    requirePermission("utilisateur.acces_societes", "audit"),
    async (req, res) => {
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: "Compte invalide." });
      try {
        const { rows } = await pool.query(
          `SELECT l.action, l.reason, l.performed_by_name, l.created_at,
                  c.name AS company_name
             FROM user_company_access_log l
             LEFT JOIN companies c ON c.id = l.company_id
            WHERE l.user_id = $1
            ORDER BY l.created_at DESC
            LIMIT 200`,
          [userId]
        );
        res.json({ journal: rows });
      } catch (e) { fail(res, e, "Impossible de lire le journal des habilitations."); }
    }
  );

  return router;
};
