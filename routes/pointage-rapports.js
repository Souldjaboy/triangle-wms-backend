"use strict";

/**
 * CONTRÔLE ET IMPRESSION DU POINTAGE.
 *
 *   GET /pointage/rapports/global?periode=2026-09&site=3&statut=LATE
 *   GET /pointage/rapports/employe/:id?periode=2026-09
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LA VALEUR EFFECTIVE, PAS LA VALEUR BRUTE
 *
 * Un rapport lit ce qui est RETENU, pas ce qui a été pointé. Les deux
 * diffèrent dès qu'une journée a été régularisée (migration 086) : le
 * pointage brut est vide, la valeur retenue dit « présent à 08h00 ».
 *
 * L'ordre de résolution, pour chaque journée :
 *   1. une absence marquée par-dessus une régularisation l'emporte ;
 *   2. sinon la valeur régularisée ;
 *   3. sinon le pointage brut ;
 *   4. sinon rien — et c'est une absence si la journée était due.
 *
 * Chaque ligne dit d'où vient sa valeur (`source`), pour qu'un chiffre
 * contesté puisse être remonté jusqu'à son origine.
 */

const express = require("express");
const P = require("../services/attendance-periodes");

module.exports = function createPointageRapportsRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const requireCompany = (req, res) => {
    const id = companyOf(req);
    if (!id) { res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" }); return 0; }
    return id;
  };
  const fail = (res, e, secours) => {
    if (!e.httpStatus) console.error(secours, e);
    res.status(e.httpStatus || 500).json({ error: e.message || secours, code: e.code });
  };

  /** Les bornes de la période demandée, ou celles fournies à la main. */
  async function bornes(client, companyId, req) {
    if (req.query?.du && req.query?.au) {
      return { code: `${req.query.du}→${req.query.au}`, debut: String(req.query.du), fin: String(req.query.au) };
    }
    const code = String(req.query?.periode || "").trim();
    if (!/^\d{4}-\d{2}$/.test(code)) {
      throw P.erreur("Indiquez une période (AAAA-MM) ou un couple du/au.", "PERIOD_REQUIRED", 400);
    }
    const { rows } = await client.query(
      `SELECT code, date_debut::text AS debut, date_fin::text AS fin
         FROM attendance_periods WHERE company_id = $1 AND code = $2`, [companyId, code]);
    if (rows[0]) return rows[0];

    /* La période n'a pas encore été ouverte : on calcule ses bornes sans
       l'ouvrir. Consulter un rapport ne doit rien créer. */
    const { rows: config } = await client.query(
      `SELECT COALESCE(period_start_day, 25) AS jour FROM attendance_company_configuration
        WHERE company_id = $1`, [companyId]);
    const b = P.bornes(code, Number(config[0]?.jour || 25));
    return { code, debut: b.date_debut, fin: b.date_fin };
  }

  /**
   * Le détail journalier, valeur effective résolue.
   * Une seule requête pour toute la période : la faire par employé
   * multiplierait les allers-retours par le nombre de salariés.
   */
  const REQUETE_DETAIL = `
    WITH jours AS (
      SELECT d::date AS jour, extract(isodow FROM d)::int AS isodow
        FROM generate_series($2::date, $3::date, interval '1 day') d
    ),
    cfg AS (
      SELECT COALESCE(saturday_mode, 'NORMAL') AS samedi, COALESCE(timezone,'Africa/Bamako') AS tz
        FROM attendance_company_configuration WHERE company_id = $1
    ),
    employes AS (
      SELECT e.id, e.employee_number, e.full_name, e.job_title, e.schedule_id, e.site_id,
             s.name AS site
        FROM attendance_employees e
        LEFT JOIN attendance_work_sites s ON s.id = e.site_id
       WHERE e.company_id = $1 AND e.active
         AND ($4::int IS NULL OR e.id = $4)
         AND ($5::int IS NULL OR e.site_id = $5)
    )
    SELECT e.id AS employee_id, e.employee_number, e.full_name, e.job_title, e.site,
           j.jour::text AS jour, j.isodow,
           d.start_time::text AS heure_prevue, d.end_time::text AS fin_prevue,
           (d.id IS NOT NULL) AS jour_ouvre,
           (h.id IS NOT NULL) AS ferie, h.label AS ferie_label,
           (j.isodow = 6) AS samedi, (j.isodow = 7) AS dimanche,
           (SELECT samedi FROM cfg) AS mode_samedi,
           r.check_in, r.break_out, r.break_in, r.check_out,
           r.status AS statut_brut, r.late_minutes, r.worked_minutes,
           g.effective_check_in, g.effective_check_out, g.effective_status,
           g.overridden_status, g.override_reason, g.reason AS motif_regularisation,
           (SELECT count(*)::int FROM attendance_day_record_corrections c WHERE c.record_id = r.id) AS corrections,
           (SELECT string_agg(DISTINCT l.source, ',') FROM attendance_event_log_v2 l
             WHERE l.record_id = r.id) AS sources
      FROM employes e
      CROSS JOIN jours j
      LEFT JOIN attendance_schedule_days d
        ON d.schedule_id = e.schedule_id AND d.iso_weekday = j.isodow AND d.is_working_day
      LEFT JOIN attendance_holidays h ON h.company_id = $1 AND h.holiday_date = j.jour
      LEFT JOIN attendance_day_records_v2 r
        ON r.company_id = $1 AND r.employee_id = e.id AND r.work_date = j.jour
      LEFT JOIN attendance_regularizations g
        ON g.company_id = $1 AND g.employee_id = e.id AND g.work_date = j.jour
     ORDER BY e.employee_number, j.jour`;

  /** Résout une journée en une ligne lisible, en disant d'où vient la valeur. */
  function resoudre(l) {
    const modeSamedi = String(l.mode_samedi || "NORMAL");
    const samediChome = l.samedi && modeSamedi === "NON_TRAVAILLE";
    const du = Boolean(l.jour_ouvre) && !l.dimanche && !samediChome && !l.ferie;

    if (l.overridden_status) {
      return { ...l, du, statut: l.overridden_status, source: "correction_administrative",
               arrivee: null, depart: null, motif: l.override_reason };
    }
    if (l.check_in) {
      return { ...l, du, statut: l.statut_brut, source: (l.sources || "MANUEL").split(",")[0],
               arrivee: l.check_in, depart: l.check_out, motif: "" };
    }
    if (l.effective_check_in) {
      return { ...l, du, statut: l.effective_status, source: "regularisation",
               arrivee: l.effective_check_in, depart: l.effective_check_out,
               motif: l.motif_regularisation };
    }
    if (l.dimanche) return { ...l, du, statut: "REPOS", source: "calendrier", arrivee: null, depart: null, motif: "" };
    if (samediChome) return { ...l, du, statut: "REPOS", source: "calendrier", arrivee: null, depart: null, motif: "" };
    if (l.ferie) return { ...l, du, statut: "FERIE", source: "calendrier", arrivee: null, depart: null, motif: l.ferie_label || "" };
    if (!l.jour_ouvre) return { ...l, du, statut: "REPOS", source: "horaire", arrivee: null, depart: null, motif: "" };
    return { ...l, du, statut: "ABSENT", source: "aucune", arrivee: null, depart: null, motif: "" };
  }

  function totaliser(lignes) {
    const t = {
      jours_attendus: 0, jours_travailles: 0, absences: 0, absences_justifiees: 0,
      repos: 0, feries: 0, samedis_travailles: 0,
      retards: 0, minutes_retard: 0, departs_anticipes: 0,
      journees_incompletes: 0, corrections: 0, anomalies: 0,
      minutes_travaillees: 0,
      par_source: { QR: 0, MANUEL: 0, regularisation: 0, correction_administrative: 0, autre: 0 },
    };
    for (const l of lignes) {
      if (l.du) t.jours_attendus += 1;
      if (l.statut === "FERIE") t.feries += 1;
      if (l.statut === "REPOS") t.repos += 1;

      const present = ["PRESENT", "LATE", "COMPLETED", "ON_BREAK"].includes(l.statut);
      if (present) {
        t.jours_travailles += 1;
        if (l.samedi) t.samedis_travailles += 1;
        if (Number(l.late_minutes) > 0) { t.retards += 1; t.minutes_retard += Number(l.late_minutes); }
        t.minutes_travaillees += Number(l.worked_minutes || 0);
        /* Une journée sans départ pointé n'est pas une anomalie en soi, mais
           elle empêche de compter les heures : on la signale plutôt que de la
           compter pour zéro en silence. */
        if (!l.depart) t.journees_incompletes += 1;
        else if (l.fin_prevue && l.depart) {
          const fin = new Date(l.depart);
          const heures = String(l.fin_prevue).slice(0, 5).split(":").map(Number);
          if (fin.getUTCHours() * 60 + fin.getUTCMinutes() < heures[0] * 60 + heures[1] - 30) {
            t.departs_anticipes += 1;
          }
        }
      } else if (l.du) {
        if (l.statut === "ABSENCE_JUSTIFIEE") t.absences_justifiees += 1;
        else t.absences += 1;
      }

      t.corrections += Number(l.corrections || 0);
      const s = l.source === "QR" || l.source === "MANUEL" ? l.source
        : l.source === "regularisation" || l.source === "correction_administrative" ? l.source
        : l.source === "aucune" || l.source === "calendrier" || l.source === "horaire" ? null : "autre";
      if (s) t.par_source[s] = (t.par_source[s] || 0) + 1;
      if (l.source === "correction_administrative" || Number(l.corrections) > 0) t.anomalies += 1;
    }
    t.heures_travaillees = Math.floor(t.minutes_travaillees / 60);
    t.minutes_restantes  = t.minutes_travaillees % 60;
    /* Heures et minutes, jamais un décimal : 20 h 15 ne vaut pas 20,25. */
    t.duree_travaillee = `${t.heures_travaillees} h ${String(t.minutes_restantes).padStart(2, "0")}`;
    t.retard_cumule = `${Math.floor(t.minutes_retard / 60)} h ${String(t.minutes_retard % 60).padStart(2, "0")}`;
    return t;
  }

  async function enTete(client, companyId, req) {
    const { rows } = await client.query(
      `SELECT c.name, c.address, c.phone, c.email
         FROM companies c WHERE c.id = $1`, [companyId]);
    return {
      societe: rows[0] || {},
      imprime_le: new Date().toISOString(),
      imprime_par: req.user?.fullname || req.user?.email || "",
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  router.get(
    "/pointage/rapports/global", authenticateToken, requirePermission("pointage", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const b = await bornes(client, companyId, req);
        const { rows } = await client.query(REQUETE_DETAIL, [
          companyId, b.debut, b.fin, null,
          req.query?.site ? Number(req.query.site) : null,
        ]);
        const resolues = rows.map(resoudre);

        const parEmploye = new Map();
        for (const l of resolues) {
          if (!parEmploye.has(l.employee_id)) {
            parEmploye.set(l.employee_id, {
              employee_id: l.employee_id, matricule: l.employee_number,
              nom: l.full_name, poste: l.job_title, site: l.site, lignes: [],
            });
          }
          parEmploye.get(l.employee_id).lignes.push(l);
        }

        const filtreStatut = req.query?.statut ? String(req.query.statut).toUpperCase() : null;
        const employes = [...parEmploye.values()]
          .map((e) => ({
            employee_id: e.employee_id, matricule: e.matricule, nom: e.nom,
            poste: e.poste, site: e.site, totaux: totaliser(e.lignes),
          }))
          .filter((e) => {
            if (!filtreStatut) return true;
            if (filtreStatut === "LATE") return e.totaux.retards > 0;
            if (filtreStatut === "ABSENT") return e.totaux.absences > 0;
            if (filtreStatut === "ANOMALIE") return e.totaux.anomalies > 0;
            return true;
          });

        const cumul = totaliser(resolues);
        res.json({
          entete: await enTete(client, companyId, req),
          periode: b, employes,
          totaux_generaux: cumul,
          effectif: employes.length,
        });
      } catch (e) { fail(res, e, "Rapport global impossible."); }
      finally { client.release(); }
    }
  );

  router.get(
    "/pointage/rapports/employe/:id", authenticateToken, requirePermission("pointage", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const b = await bornes(client, companyId, req);
        const { rows } = await client.query(REQUETE_DETAIL, [
          companyId, b.debut, b.fin, Number(req.params.id), null,
        ]);
        if (!rows.length) return res.status(404).json({ error: "Employé introuvable dans cette société." });

        const resolues = rows.map(resoudre);
        const premiere = rows[0];
        res.json({
          entete: await enTete(client, companyId, req),
          periode: b,
          employe: {
            id: premiere.employee_id, matricule: premiere.employee_number,
            nom: premiere.full_name, poste: premiere.job_title, site: premiere.site,
          },
          journees: resolues.map((l) => ({
            jour: l.jour, du: l.du, statut: l.statut, source: l.source,
            heure_prevue: l.heure_prevue, arrivee: l.arrivee, depart: l.depart,
            pause_debut: l.break_out, pause_fin: l.break_in,
            retard_minutes: Number(l.late_minutes || 0),
            duree_minutes: Number(l.worked_minutes || 0),
            corrections: Number(l.corrections || 0),
            motif: l.motif || "",
          })),
          totaux: totaliser(resolues),
        });
      } catch (e) { fail(res, e, "Rapport individuel impossible."); }
      finally { client.release(); }
    }
  );

  return router;
};
