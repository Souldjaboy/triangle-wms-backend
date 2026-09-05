"use strict";

/**
 * POINTAGE QR ET BADGES — distinct du pointage manuel, jamais confondu.
 *
 *   POST /attendance-v2/qr/scan            lire un badge et pointer
 *   GET  /attendance-v2/badges             les badges de la société
 *   POST /attendance-v2/badges             émettre le badge d'un employé
 *   GET  /attendance-v2/badges/:id         un badge, avec son QR à imprimer
 *   POST /attendance-v2/badges/:id/impression
 *   POST /attendance-v2/badges/:id/remplacement
 *   POST /attendance-v2/badges/:id/desactivation
 *   GET  /attendance-v2/badges/:id/journal
 *   GET  /attendance-v2/qr/scans           les lectures, acceptées et refusées
 *
 * Deux écrans, deux droits — `pointage.qr|scan` et `pointage.badge|…` — mais
 * un seul moteur d'écriture, partagé avec le manuel
 * (`services/attendance-workforce.js:enregistrerPointage`). Le mode change
 * qui déclenche et ce qu'on affiche ; il ne change pas la règle métier.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUI PROTÈGE UN SCAN
 *
 *   • le jeton est tiré au hasard, jamais dérivé du code imprimé ;
 *   • un badge d'une autre société est refusé du même message qu'un badge
 *     inconnu — sinon, scanner sur les deux postes révélerait à qui
 *     appartient une carte trouvée par terre ;
 *   • un verrou consultatif par badge sérialise les lectures simultanées ;
 *   • une seconde lecture identique dans la fenêtre anti-rebond ne crée pas
 *     d'erreur : elle renvoie le pointage déjà enregistré. Un doigt qui
 *     tremble devant une caméra ne doit pas produire un message rouge ;
 *   • l'heure retenue est celle du SERVEUR, dans le fuseau de la société ;
 *     l'heure déclarée par le téléphone n'entre jamais dans le calcul.
 */

const express = require("express");
const A = require("../services/attendance-workforce");
const B = require("../services/attendance-badges");

/* Deux lectures de la même carte à quelques secondes d'écart sont une seule
   intention. Au-delà, c'est un geste distinct — une pause qui commence juste
   après l'arrivée, par exemple, ce qui est parfaitement légitime. */
const ANTI_REBOND_SECONDES = 20;

module.exports = function createAttendanceQrRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const nomDe = (req) => req.user?.fullname || req.user?.email || "Utilisateur";
  const requireCompany = (req, res) => {
    const id = companyOf(req);
    if (!id) { res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" }); return 0; }
    return id;
  };
  const fail = (res, e, secours) => {
    if (!e.httpStatus) console.error(secours, e);
    res.status(e.httpStatus || 500).json({ error: e.message || secours, code: e.code });
  };

  // ═══════════════════════════════════════════════════════════════════════
  // LE SCAN
  // ═══════════════════════════════════════════════════════════════════════
  router.post(
    "/attendance-v2/qr/scan",
    authenticateToken,
    requirePermission("pointage.qr", "scan"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const jeton = String(req.body?.qr_token || "").trim();
      const actionForcee = req.body?.action_type ? String(req.body.action_type).toUpperCase() : null;

      const client = await pool.connect();
      let refus = null;
      try {
        await client.query("BEGIN");

        let resolu;
        try {
          resolu = await B.resoudreScan(client, { qrToken: jeton, companyId });
        } catch (e) {
          refus = e;
          throw e;
        }
        const { badge, employe } = resolu;

        /* Sérialise les lectures d'un même badge : deux caméras, ou deux
           images de la même caméra, ne doivent pas produire deux pointages.
           Le verrou tombe à la fin de la transaction, sans rien à libérer. */
        await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [
          811_000, Number(badge.id),
        ]);

        const employeComplet = await A.chargerEmployePourPointage(client, companyId, employe.id);
        if (!employeComplet) {
          refus = B.erreur("Employé introuvable.", "EMPLOYEE_NOT_FOUND", 404);
          throw refus;
        }

        /* Qui scanne doit avoir le droit de pointer CET employé : le droit
           `pointage.qr|scan` ouvre l'écran, le périmètre d'opérateur décide
           de qui. Un opérateur FAT & MAT ne pointe pas un site Triangle. */
        if (!await A.canPunchEmployee(client, companyId, req.user, employeComplet)) {
          refus = B.erreur("Vous ne pouvez pas pointer cet employé.", "ATTENDANCE_SCOPE_DENIED", 403);
          throw refus;
        }

        /* Anti-rebond : une lecture identique toute récente renvoie ce qui a
           déjà été écrit, sans rien réécrire ni rien refuser. */
        const { rows: recentes } = await client.query(
          `SELECT action_type, created_at FROM attendance_qr_scans
            WHERE badge_id = $1 AND accepted
              AND created_at > now() - ($2 || ' seconds')::interval
            ORDER BY created_at DESC LIMIT 1`,
          [badge.id, String(ANTI_REBOND_SECONDES)]
        );
        if (recentes[0]) {
          const { rows: jour } = await client.query(
            `SELECT * FROM attendance_day_records_v2
              WHERE company_id = $1 AND employee_id = $2 AND work_date = $3`,
            [companyId, employe.id, employeComplet.local_date]
          );
          await client.query("COMMIT");
          return res.json({
            success: true,
            repetition: true,
            message: "Pointage déjà enregistré à l'instant.",
            action: recentes[0].action_type,
            attendance: jour[0] || null,
            employe: {
              id: employe.id, nom: employe.full_name, matricule: employe.employee_number,
              badge: badge.badge_code, poste: employe.job_title,
            },
          });
        }

        const { rows: dejaLa } = await client.query(
          `SELECT * FROM attendance_day_records_v2
            WHERE company_id = $1 AND employee_id = $2 AND work_date = $3`,
          [companyId, employe.id, employeComplet.local_date]
        );
        const etape = actionForcee || A.prochaineEtape(dejaLa[0]);
        if (!etape) {
          refus = B.erreur("La journée de cet employé est déjà complète.", "ATTENDANCE_DAY_COMPLETE", 409);
          throw refus;
        }

        const jourTravaille = await A.chargerJourTravaille(client, employeComplet.schedule_id, employeComplet.local_date);
        const resultat = await A.enregistrerPointage(client, {
          companyId, employee: employeComplet, day: jourTravaille,
          action: etape, user: req.user, source: "QR",
        });

        await B.tracerScan(client, {
          companyId, badgeId: badge.id, employeeId: employe.id, actionType: resultat.action,
          accepted: true, qrToken: jeton, scannedBy: req.user?.id, scannedByName: nomDe(req),
          siteId: employeComplet.site_id,
        });

        await client.query("COMMIT");

        const libelles = {
          CHECK_IN: "Arrivée", BREAK_OUT: "Début de pause",
          BREAK_IN: "Retour de pause", CHECK_OUT: "Fin de journée",
        };
        res.json({
          success: true,
          action: resultat.action,
          action_libelle: libelles[resultat.action],
          retard_minutes: resultat.late,
          heure: resultat.record[A.ACTION_COLUMNS[resultat.action]],
          attendance: resultat.record,
          employe: {
            id: employe.id, nom: employe.full_name, matricule: employe.employee_number,
            badge: badge.badge_code, poste: employe.job_title,
          },
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        /* Le refus se trace HORS transaction : celle-ci vient d'être annulée,
           et un refus non consigné est un refus qu'on ne saura pas expliquer
           le lendemain matin. */
        if (refus) {
          await B.tracerScan(pool, {
            companyId, badgeId: null, employeeId: null, actionType: null,
            accepted: false, refusalCode: refus.code || "ERREUR", qrToken: jeton,
            scannedBy: req.user?.id, scannedByName: nomDe(req),
          }).catch(() => {});
        }
        fail(res, e, "Lecture du badge impossible.");
      } finally { client.release(); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // LES BADGES
  // ═══════════════════════════════════════════════════════════════════════
  router.get(
    "/attendance-v2/badges",
    authenticateToken,
    requirePermission("pointage.badge", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const inactifs = String(req.query?.inclure_inactifs || "") === "1";
        const { rows } = await pool.query(
          `SELECT b.id, b.badge_code, b.status, b.issued_at, b.print_count, b.last_printed_at,
                  b.deactivated_at, b.deactivation_reason, b.replaced_by_badge_id,
                  e.id AS employee_id, e.full_name, e.employee_number, e.job_title,
                  s.name AS site
             FROM attendance_badges b
             JOIN attendance_employees e ON e.id = b.employee_id
             LEFT JOIN attendance_work_sites s ON s.id = e.site_id
            WHERE b.company_id = $1 AND ($2 OR b.status = 'ACTIF')
            ORDER BY e.full_name, b.issued_at DESC`,
          [companyId, inactifs]
        );
        /* Jamais `qr_token` dans une liste : un seul écran fuité livrerait
           tous les badges de la société. Le jeton ne sort que sur la fiche
           d'un badge, pour l'imprimer. */
        res.json({ badges: rows });
      } catch (e) { fail(res, e, "Impossible de lire les badges."); }
    }
  );

  router.get(
    "/attendance-v2/badges/:id",
    authenticateToken,
    requirePermission("pointage.badge", "print"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT b.*, e.full_name, e.employee_number, e.job_title, e.site_id,
                  s.name AS site, c.name AS societe, c.badge_prefix
             FROM attendance_badges b
             JOIN attendance_employees e ON e.id = b.employee_id
             JOIN companies c ON c.id = b.company_id
             LEFT JOIN attendance_work_sites s ON s.id = e.site_id
            WHERE b.id = $1 AND b.company_id = $2`,
          [Number(req.params.id), companyId]
        );
        if (!rows[0]) return res.status(404).json({ error: "Badge introuvable." });
        res.json({ badge: rows[0] });
      } catch (e) { fail(res, e, "Impossible de lire ce badge."); }
    }
  );

  router.post(
    "/attendance-v2/badges",
    authenticateToken,
    requirePermission("pointage.badge", "create"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const employeeId = Number(req.body?.employee_id);
      if (!Number.isInteger(employeeId) || employeeId <= 0) {
        return res.status(400).json({ error: "Employé obligatoire.", code: "EMPLOYEE_REQUIRED" });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const badge = await B.emettre(client, {
          companyId, employeeId, reason: String(req.body?.reason || ""),
          performedBy: req.user?.id, performedByName: nomDe(req),
        });
        await client.query("COMMIT");
        res.status(201).json({ badge });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Émission du badge impossible.");
      } finally { client.release(); }
    }
  );

  router.post(
    "/attendance-v2/badges/:id/impression",
    authenticateToken,
    requirePermission("pointage.badge", "print"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const badge = await B.marquerImprime(client, {
          companyId, badgeId: Number(req.params.id),
          performedBy: req.user?.id, performedByName: nomDe(req),
        });
        await client.query("COMMIT");
        res.json({ badge, reimpression: badge.print_count > 1 });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Impression impossible.");
      } finally { client.release(); }
    }
  );

  router.post(
    "/attendance-v2/badges/:id/remplacement",
    authenticateToken,
    requirePermission("pointage.badge", "replace"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const motif = String(req.body?.reason || "").trim();
      if (motif.length < 3) {
        return res.status(400).json({
          error: "Un motif est obligatoire : perdu, abîmé, volé…", code: "REASON_REQUIRED",
        });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const r = await B.remplacer(client, {
          companyId, badgeId: Number(req.params.id), reason: motif,
          performedBy: req.user?.id, performedByName: nomDe(req),
        });
        await client.query("COMMIT");
        res.json({
          ancien: { id: r.ancien.id, code: r.ancien.badge_code, statut: "REMPLACE" },
          nouveau: { id: r.nouveau.id, code: r.nouveau.badge_code },
          message: `${r.ancien.badge_code} ne pointe plus. Nouveau badge : ${r.nouveau.badge_code}.`,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Remplacement impossible.");
      } finally { client.release(); }
    }
  );

  router.post(
    "/attendance-v2/badges/:id/desactivation",
    authenticateToken,
    requirePermission("pointage.badge", "replace"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const motif = String(req.body?.reason || "").trim();
      if (motif.length < 3) {
        return res.status(400).json({ error: "Un motif est obligatoire.", code: "REASON_REQUIRED" });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const badge = await B.desactiver(client, {
          companyId, badgeId: Number(req.params.id), reason: motif,
          performedBy: req.user?.id, performedByName: nomDe(req),
        });
        await client.query("COMMIT");
        res.json({ badge: { id: badge.id, code: badge.badge_code, statut: badge.status } });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Désactivation impossible.");
      } finally { client.release(); }
    }
  );

  router.get(
    "/attendance-v2/badges/:id/journal",
    authenticateToken,
    requirePermission("pointage.badge", "audit"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT event_type, reason, performed_by_name, created_at
             FROM attendance_badge_events
            WHERE badge_id = $1 AND company_id = $2
            ORDER BY created_at DESC, id DESC`,
          [Number(req.params.id), companyId]
        );
        res.json({ journal: rows });
      } catch (e) { fail(res, e, "Impossible de lire l'historique du badge."); }
    }
  );

  router.get(
    "/attendance-v2/qr/scans",
    authenticateToken,
    requirePermission("pointage.badge", "audit"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT s.created_at, s.accepted, s.refusal_code, s.action_type, s.token_hint,
                  s.scanned_by_name, b.badge_code, e.full_name
             FROM attendance_qr_scans s
             LEFT JOIN attendance_badges b ON b.id = s.badge_id
             LEFT JOIN attendance_employees e ON e.id = s.employee_id
            WHERE s.company_id = $1
            ORDER BY s.created_at DESC
            LIMIT 200`,
          [companyId]
        );
        res.json({ lectures: rows });
      } catch (e) { fail(res, e, "Impossible de lire le journal des scans."); }
    }
  );

  return router;
};
