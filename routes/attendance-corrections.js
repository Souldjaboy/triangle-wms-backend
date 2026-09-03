"use strict";

/**
 * CORRIGER UN POINTAGE — avec motif obligatoire, avant/après complet.
 *
 *   PATCH /attendance-v2/records/:id
 *
 * Qui peut pointer pour un employé peut aussi corriger son pointage : c'est
 * la même responsabilité (services/attendance-workforce.js, canPunchEmployee)
 * — super admin, l'employé lui-même, ou l'opérateur du site
 * (attendance_operator_scopes). Un opérateur FAT & MAT ne peut donc jamais
 * corriger un pointage Triangle : le site appartient à une seule société,
 * `company_id` filtre chaque requête.
 *
 * Une correction ne réécrit jamais silencieusement : `old_value`/`new_value`
 * sont posés dans `attendance_day_record_corrections` avant la mise à jour,
 * dans la même transaction — un échec plus loin annule les deux.
 */

const express = require("express");
const A = require("../services/attendance-workforce");

const CHAMPS_HORODATES = new Set(["check_in", "break_out", "break_in", "check_out"]);
const STATUTS_VALIDES = new Set(["ABSENT", "PRESENT", "LATE", "ON_BREAK", "COMPLETED"]);

module.exports = function createAttendanceCorrectionsRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId } = deps;
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const nomDe = (req) => req.user?.fullname || req.user?.email || "Utilisateur";
  const fail = (res, error, fallback) => {
    console.error(fallback, error);
    res.status(error.httpStatus || 500).json({ error: error.message || fallback, code: error.code });
  };

  router.patch("/attendance-v2/records/:id", authenticateToken, async (req, res) => {
    const companyId = companyOf(req);
    if (!companyId) return res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" });

    const champ = String(req.body?.field || "");
    const raison = String(req.body?.reason || "").trim();
    if (!CHAMPS_HORODATES.has(champ) && champ !== "status") {
      return res.status(400).json({
        error: "Champ à corriger invalide (check_in, break_out, break_in, check_out ou status).",
        code: "FIELD_INVALID",
      });
    }
    if (raison.length < 3) {
      return res.status(400).json({ error: "Un motif de correction est obligatoire.", code: "REASON_REQUIRED" });
    }
    if (champ === "status" && !STATUTS_VALIDES.has(String(req.body?.value || ""))) {
      return res.status(400).json({ error: "Statut invalide.", code: "STATUS_INVALID" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: records } = await client.query(
        `SELECT r.*, e.company_id AS employee_company_id, e.site_id, e.user_id, e.schedule_id, e.full_name
           FROM attendance_day_records_v2 r
           JOIN attendance_employees e ON e.id = r.employee_id
          WHERE r.id = $1 AND r.company_id = $2
          FOR UPDATE OF r`,
        [Number(req.params.id), companyId]
      );
      const record = records[0];
      if (!record) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Pointage introuvable." }); }

      if (!await A.canPunchEmployee(client, companyId, req.user, record)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Vous ne pouvez pas corriger le pointage de cet employé.", code: "ATTENDANCE_SCOPE_DENIED" });
      }

      const avant = { ...record };

      let nouvelleValeur = req.body?.value ?? null;
      let lateMinutes = record.late_minutes;

      if (CHAMPS_HORODATES.has(champ)) {
        /* null efface un pointage saisi par erreur (par exemple une pause
           jamais réellement prise) ; une valeur non nulle doit être une date
           valide. */
        if (nouvelleValeur !== null) {
          const d = new Date(nouvelleValeur);
          if (Number.isNaN(d.getTime())) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "Date/heure invalide.", code: "VALUE_INVALID" });
          }
          nouvelleValeur = d.toISOString();
        }

        if (champ === "check_in") {
          if (nouvelleValeur === null) {
            lateMinutes = 0;
          } else {
            const { rows: jours } = await client.query(
              `SELECT start_time FROM attendance_schedule_days
                WHERE schedule_id = $1 AND iso_weekday = extract(isodow FROM $2::date)`,
              [record.schedule_id, record.work_date]
            );
            lateMinutes = A.minutesLate(nouvelleValeur, record.work_date, jours[0]?.start_time || null);
          }
        }
      }

      const apresRows = (await client.query(
        `UPDATE attendance_day_records_v2
            SET ${champ} = $1,
                late_minutes = $2,
                status = COALESCE($3, status),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $4 AND company_id = $5
          RETURNING *`,
        [champ === "status" ? record.status : nouvelleValeur, lateMinutes,
         champ === "status" ? nouvelleValeur : null, record.id, companyId]
      )).rows;
      const apres = apresRows[0];

      /* L'audit s'écrit AVANT que la fonction ne rende la main : si tout le
         reste échoue, la transaction annule l'écriture ET la correction. */
      await client.query(
        `INSERT INTO attendance_day_record_corrections
           (company_id, record_id, employee_id, field, reason, old_value, new_value,
            corrected_by, corrected_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [companyId, record.id, record.employee_id, champ, raison,
         JSON.stringify(avant), JSON.stringify(apres), req.user.id, nomDe(req)]
      );

      await client.query("COMMIT");
      res.json({ success: true, record: apres, employee: { id: record.employee_id, full_name: record.full_name } });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      fail(res, error, "Erreur de correction du pointage.");
    } finally { client.release(); }
  });

  /** L'historique des corrections d'un pointage — jamais réécrit. */
  router.get("/attendance-v2/records/:id/corrections", authenticateToken, async (req, res) => {
    const companyId = companyOf(req);
    if (!companyId) return res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" });
    try {
      const { rows } = await pool.query(
        `SELECT * FROM attendance_day_record_corrections
          WHERE record_id = $1 AND company_id = $2 ORDER BY corrected_at`,
        [Number(req.params.id), companyId]
      );
      res.json({ success: true, corrections: rows });
    } catch (error) { fail(res, error, "Erreur de lecture des corrections."); }
  });

  return router;
};
