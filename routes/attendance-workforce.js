"use strict";

const express = require("express");
const crypto = require("crypto");
const A = require("../services/attendance-workforce");
const identifiants = require("../services/identifiants");
const companyContext = require("../services/company-context");
const AV = require("../services/avances-salaire");
const P = require("../services/attendance-payroll");
const PERM = require("../services/permissions");

module.exports = function createAttendanceWorkforceRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission,
          nextAccountingNumber, createAccountingEntry, hashPassword, logActivity } = deps;

  /* Les routes de paie sont gardées par le moteur de droits, comme partout
     ailleurs. Sans cela, elles reposaient sur `canManagePayroll()`, qui
     accordait la paie au seul vu du rôle : un DENY posé par l'administrateur
     ne tenait pas devant un appel direct à l'API. Si le garde n'était pas
     fourni — un appelant qui n'aurait pas été mis à jour — on refuse plutôt
     que d'ouvrir. */
  const garde = (action) => (
    typeof requirePermission === "function"
      ? requirePermission("paie", action)
      : (_req, res) => res.status(503).json({
          error: "Contrôle des droits indisponible.", code: "PERMISSION_CHECK_MISSING",
        })
  );
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const fail = (res, error, fallback) => {
    console.error(fallback, error);
    res.status(error.httpStatus || 500).json({ error: error.message || fallback, code: error.code });
  };
  /* Mot de passe provisoire d'un compte créé avec un salarié. Personne ne le
     reçoit : il n'existe que pour que la colonne ne soit pas vide, et il est
     remplacé depuis la fiche du compte. On garantit une lettre et un chiffre
     parce que `validatePasswordStrength` les exige — un tirage purement
     aléatoire échouerait un jour sur mille, et ce jour-là sans explication. */
  const motDePasseProvisoire = () =>
    `Aa1${crypto.randomBytes(12).toString("base64url")}`;

  const requireCompany = (req, res) => {
    const companyId = companyOf(req);
    if (!companyId) res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" });
    return companyId;
  };

  async function calculatePayroll(client, companyId, month) {
    const { rows } = await client.query(
      `WITH cfg AS (
         SELECT official_start_at,timezone FROM attendance_company_configuration WHERE company_id=$1
       ), bounds AS (
         SELECT $2::date AS first_day,
                LEAST(($2::date + interval '1 month - 1 day')::date,
                  (timezone(COALESCE((SELECT timezone FROM cfg),'Africa/Bamako'),now()))::date) AS last_day,
                (timezone(COALESCE((SELECT timezone FROM cfg),'Africa/Bamako'),
                  (SELECT official_start_at FROM cfg)))::date AS official_day
       ), employees AS (
         SELECT e.id,e.employee_number,e.full_name,e.schedule_id,
                e.site_id,e.service,e.categorie
           FROM attendance_employees e,bounds b
          WHERE e.company_id=$1 AND e.active=true
            AND e.effective_from <= b.last_day
            AND (e.effective_to IS NULL OR e.effective_to >= b.first_day)
       ), expected AS (
         SELECT e.id,g.day::date AS work_date
           FROM employees e CROSS JOIN bounds b
           CROSS JOIN LATERAL generate_series(GREATEST(b.first_day,b.official_day),b.last_day,interval '1 day') g(day)
           JOIN attendance_schedule_days d ON d.schedule_id=e.schedule_id
             AND d.iso_weekday=extract(isodow FROM g.day) AND d.is_working_day=true
          /* Une journée que le calendrier administratif a déclarée chômée sans
             exiger de pointage n'est pas attendue — donc son absence de pointage
             n'est pas une absence. Sans ce filtre, cet aperçu annonçait des
             absences que la paie de la période ne retenait pas : deux chiffres
             contradictoires sur le même mois, dans le même écran. */
          WHERE NOT EXISTS (
            SELECT 1 FROM attendance_special_days s
             WHERE s.company_id=$1 AND s.status='ACTIF' AND s.day_date=g.day::date
               AND s.impact_absence='AUCUNE'
               AND (s.portee='ENTREPRISE' OR EXISTS (
                     SELECT 1 FROM attendance_special_day_targets c
                      WHERE c.special_day_id=s.id
                        AND (c.employee_id=e.id OR c.site_id=e.site_id
                             OR NULLIF(BTRIM(c.service),'')=NULLIF(BTRIM(e.service),'')
                             OR NULLIF(BTRIM(c.categorie),'')=NULLIF(BTRIM(e.categorie),''))))
          )
       ), totals AS (
         SELECT e.id,e.employee_number,e.full_name,
                count(x.work_date)::int AS expected_days,
                count(r.check_in)::int AS attended_days,
                (count(x.work_date)-count(r.check_in))::int AS absence_days,
                COALESCE(sum(r.late_minutes),0)::int AS late_minutes
           FROM employees e
           LEFT JOIN expected x ON x.id=e.id
           LEFT JOIN attendance_day_records_v2 r
             ON r.company_id=$1 AND r.employee_id=e.id AND r.work_date=x.work_date
          GROUP BY e.id,e.employee_number,e.full_name
       )
       SELECT t.*, rate.monthly_salary,rate.daily_rate,COALESCE(adj.amount,0) AS adjustments
         FROM totals t,bounds b
         LEFT JOIN LATERAL (SELECT monthly_salary,daily_rate FROM attendance_salary_settings_v2 s
           WHERE s.employee_id=t.id AND s.effective_from <= b.last_day
             AND (s.effective_to IS NULL OR s.effective_to >= b.first_day)
           ORDER BY s.effective_from DESC LIMIT 1) rate ON true
         LEFT JOIN LATERAL (SELECT sum(amount) AS amount FROM attendance_salary_adjustments_v2 a
           WHERE a.employee_id=t.id AND a.company_id=$1
             AND a.work_date BETWEEN b.first_day AND b.last_day) adj ON true
        ORDER BY t.employee_number`,
      [companyId, `${month}-01`]
    );
    return rows.map(P.calculatePayrollLine);
  }

  router.get("/attendance-v2/employees", authenticateToken, async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    try {
      const client = await pool.connect();
      try {
        const salaryAll = await A.canViewAllSalaries(client, companyId, req.user);
        const sites = await A.operatorSiteIds(client, companyId, req.user);
        const unrestricted = sites === null || salaryAll;
        const { rows } = await client.query(
          `SELECT e.id, e.employee_number, e.full_name, e.user_id, e.job_title,
                  e.active, e.effective_from, s.id AS site_id, s.code AS site_code,
                  s.name AS site_name, w.id AS schedule_id, w.code AS schedule_code,
                  w.name AS schedule_name, sal.monthly_salary, sal.daily_rate
             FROM attendance_employees e
             JOIN attendance_work_sites s ON s.id=e.site_id AND s.company_id=e.company_id
             JOIN attendance_work_schedules w ON w.id=e.schedule_id AND w.company_id=e.company_id
             LEFT JOIN LATERAL (
               SELECT monthly_salary,daily_rate FROM attendance_salary_settings_v2 x
                WHERE x.employee_id=e.id AND x.effective_from <= CURRENT_DATE
                  AND (x.effective_to IS NULL OR x.effective_to >= CURRENT_DATE)
                ORDER BY x.effective_from DESC LIMIT 1
             ) sal ON true
            WHERE e.company_id=$1 AND e.active=true
              AND ($2::boolean OR e.user_id=$3 OR e.site_id = ANY($4::int[]))
            ORDER BY e.employee_number`,
          [companyId, unrestricted, req.user.id, sites || []]
        );
        const ownId = Number(req.user.id);
        res.json({
          employees: rows.map((row) => A.stripSalary(row, salaryAll || Number(row.user_id) === ownId)),
          permissions: { can_view_all_salaries: salaryAll, can_manage: A.isSuperAdmin(req.user), can_punch_all: sites === null },
        });
      } finally { client.release(); }
    } catch (error) { fail(res, error, "Erreur lecture effectif de pointage."); }
  });

  router.get("/attendance-v2/organization", authenticateToken, async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    if (!A.isSuperAdmin(req.user)) return res.status(403).json({ error: "Réservé au super administrateur." });
    try {
      const [sites, schedules, operators] = await Promise.all([
        pool.query(`SELECT id,code,name,city,site_type,active FROM attendance_work_sites WHERE company_id=$1 ORDER BY id`, [companyId]),
        pool.query(`SELECT id,code,name,active FROM attendance_work_schedules WHERE company_id=$1 ORDER BY id`, [companyId]),
        pool.query(`SELECT o.id,o.operator_user_id,u.fullname,s.id AS site_id,s.name AS site_name,o.can_punch
                      FROM attendance_operator_scopes o JOIN users u ON u.id=o.operator_user_id
                      JOIN attendance_work_sites s ON s.id=o.site_id WHERE o.company_id=$1 ORDER BY s.id`, [companyId]),
      ]);
      res.json({ sites: sites.rows, schedules: schedules.rows, operators: operators.rows });
    } catch (error) { fail(res, error, "Erreur lecture organisation du pointage."); }
  });

  router.get("/attendance-v2/today", authenticateToken, async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    try {
      const client = await pool.connect();
      try {
        const salaryAll = await A.canViewAllSalaries(client, companyId, req.user);
        const sites = await A.operatorSiteIds(client, companyId, req.user);
        const unrestricted = sites === null || salaryAll;
        const { rows } = await client.query(
          `WITH cfg AS (
             SELECT timezone FROM attendance_company_configuration WHERE company_id=$1
           ), local_day AS (
             SELECT (timezone(COALESCE((SELECT timezone FROM cfg),'Africa/Bamako'), now()))::date AS d
           )
           SELECT e.id AS employee_id, e.employee_number, e.full_name, e.user_id,
                  s.id AS site_id, s.name AS site_name, w.name AS schedule_name,
                  d.start_time, d.end_time, d.break_start, d.break_end,
                  l.d AS current_work_date, r.id AS attendance_id, r.work_date, r.check_in, r.break_out,
                  r.break_in, r.check_out, COALESCE(r.status,'ABSENT') AS status,
                  COALESCE(r.late_minutes,0) AS late_minutes, COALESCE(r.worked_minutes,0) AS worked_minutes,
                  sal.monthly_salary,sal.daily_rate
             FROM attendance_employees e
             JOIN attendance_work_sites s ON s.id=e.site_id
             JOIN attendance_work_schedules w ON w.id=e.schedule_id
             CROSS JOIN local_day l
             LEFT JOIN attendance_schedule_days d ON d.schedule_id=w.id AND d.iso_weekday=extract(isodow FROM l.d)
             LEFT JOIN attendance_day_records_v2 r ON r.company_id=e.company_id AND r.employee_id=e.id AND r.work_date=l.d
             LEFT JOIN LATERAL (
               SELECT monthly_salary,daily_rate FROM attendance_salary_settings_v2 x
                WHERE x.employee_id=e.id AND x.effective_from <= l.d
                  AND (x.effective_to IS NULL OR x.effective_to >= l.d)
                ORDER BY x.effective_from DESC LIMIT 1
             ) sal ON true
            WHERE e.company_id=$1 AND e.active=true AND e.effective_from <= l.d
              AND (e.effective_to IS NULL OR e.effective_to >= l.d)
              AND ($2::boolean OR e.user_id=$3 OR e.site_id=ANY($4::int[]))
            ORDER BY e.employee_number`,
          [companyId, unrestricted, req.user.id, sites || []]
        );
        res.json({ date: rows[0]?.current_work_date || null, records: rows.map((row) => A.stripSalary(row, salaryAll || Number(row.user_id) === Number(req.user.id))) });
      } finally { client.release(); }
    } catch (error) { fail(res, error, "Erreur lecture pointages du jour."); }
  });

  /* POINTAGE MANUEL — on choisit l'employé dans une liste.
     Distinct du pointage QR (routes/attendance-qr.js) : deux écrans, deux
     droits, deux sources dans les rapports. Ce qu'ils écrivent une fois
     l'employé identifié passe en revanche par le MÊME moteur
     (`A.enregistrerPointage`), pour qu'une règle métier n'ait jamais deux
     versions. */
  router.post("/attendance-v2/check", authenticateToken, async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    const client = await pool.connect();
    try {
      const action = A.assertAction(req.body?.action_type);
      const employeeId = Number(req.body?.employee_id);
      if (!employeeId) return res.status(400).json({ error: "Employé obligatoire.", code: "EMPLOYEE_REQUIRED" });

      await client.query("BEGIN");
      const employee = await A.chargerEmployePourPointage(client, companyId, employeeId);
      if (!employee) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Employé introuvable." }); }

      if (!await A.canPunchEmployee(client, companyId, req.user, employee)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Vous ne pouvez pas pointer cet employé.", code: "ATTENDANCE_SCOPE_DENIED" });
      }

      const day = await A.chargerJourTravaille(client, employee.schedule_id, employee.local_date);
      const resultat = await A.enregistrerPointage(client, {
        companyId, employee, day, action, user: req.user, source: "MANUEL",
      });

      await client.query("COMMIT");
      res.json({
        success: true,
        attendance: resultat.record,
        employee: { id: employee.id, full_name: employee.full_name },
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      fail(res, error, "Erreur d’enregistrement du pointage.");
    } finally { client.release(); }
  });

  /* ══════════════════════════════════════════════════════════════════════
     AJOUTER UN SALARIÉ

     Une personne, deux enregistrements qui ne se confondent pas : `users`
     porte l'identité (se connecter, un rôle, une société),
     `attendance_employees` porte la fiche RH (matricule, site, horaire,
     salaire). L'un peut exister sans l'autre — un gardien que l'opérateur
     pointe n'a pas besoin de compte — mais jamais deux fiches RH pour la même
     personne dans la même société. `uq_attendance_employee_user` l'interdit
     déjà ; on le vérifie ici avant d'écrire, pour répondre une phrase plutôt
     qu'une violation d'index que personne ne sait lire.

     `site_id` et `schedule_id` sont obligatoires, et ce n'est pas une
     préférence : la liste de l'effectif les joint en JOIN interne. Un salarié
     créé sans eux existerait en base et resterait invisible à l'écran — le
     pire des deux mondes, puisque personne ne peut corriger ce qu'il ne voit
     pas.

     Une seule transaction pour l'ensemble. Un compte créé sans sa fiche RH
     laisserait une identité orpheline qu'aucun écran ne montre, et un
     matricule consommé sans salarié derrière.
     ══════════════════════════════════════════════════════════════════════ */
  router.post("/attendance-v2/employees", authenticateToken, async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    if (!A.isSuperAdmin(req.user)) return res.status(403).json({ error: "Réservé au super administrateur." });

    const fullName = String(req.body?.full_name || "").trim();
    const siteId = Number(req.body?.site_id);
    const scheduleId = Number(req.body?.schedule_id);
    const jobTitle = String(req.body?.job_title || "").trim();
    const telephone = String(req.body?.phone || "").trim();
    const compteDemande = Number(req.body?.user_id) || null;

    if (fullName.length < 3) {
      return res.status(400).json({ error: "Nom complet obligatoire (3 caractères minimum).", code: "FULL_NAME_REQUIRED" });
    }
    if (!siteId || !scheduleId) {
      return res.status(400).json({
        error: "Site et horaire sont obligatoires : sans eux, le salarié n'apparaîtrait pas dans la liste.",
        code: "SITE_AND_SCHEDULE_REQUIRED",
      });
    }

    const salaireMensuel = req.body?.monthly_salary === undefined || req.body?.monthly_salary === null
      || req.body?.monthly_salary === "" ? null : Number(req.body.monthly_salary);
    const salaireJournalier = req.body?.daily_rate === undefined || req.body?.daily_rate === null
      || req.body?.daily_rate === "" ? null : Number(req.body.daily_rate);
    if ((salaireMensuel !== null && (!Number.isFinite(salaireMensuel) || salaireMensuel < 0))
        || (salaireJournalier !== null && (!Number.isFinite(salaireJournalier) || salaireJournalier < 0))) {
      return res.status(400).json({ error: "Salaire mensuel ou journalier invalide.", code: "SALARY_INVALID" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      /* Le site et l'horaire doivent appartenir à l'entreprise active. Les
         accepter d'ailleurs rattacherait un salarié de Triangle à un site de
         FAT & MAT, et le ferait apparaître dans l'effectif de l'autre. */
      const { rows: perimetre } = await client.query(
        `SELECT (SELECT 1 FROM attendance_work_sites WHERE id=$2 AND company_id=$1) AS site,
                (SELECT 1 FROM attendance_work_schedules WHERE id=$3 AND company_id=$1) AS horaire`,
        [companyId, siteId, scheduleId]
      );
      if (!perimetre[0]?.site || !perimetre[0]?.horaire) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Ce site ou cet horaire n'appartient pas à l'entreprise active.",
          code: "SITE_OR_SCHEDULE_NOT_IN_COMPANY",
        });
      }

      /* ── L'IDENTITÉ : rattacher un compte existant, en créer un, ou aucun ── */
      let userId = null;
      let compteCree = null;

      if (compteDemande) {
        const { rows } = await client.query(
          `SELECT id, fullname, company_id FROM users WHERE id=$1 AND company_id=$2`,
          [compteDemande, companyId]
        );
        if (!rows[0]) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Ce compte n'existe pas dans l'entreprise active.",
            code: "USER_NOT_IN_COMPANY",
          });
        }
        const { rows: deja } = await client.query(
          `SELECT id, full_name FROM attendance_employees WHERE company_id=$1 AND user_id=$2`,
          [companyId, compteDemande]
        );
        if (deja[0]) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: `Ce compte a déjà une fiche salarié dans cette entreprise : ${deja[0].full_name}.`,
            code: "EMPLOYEE_ALREADY_LINKED",
          });
        }
        userId = rows[0].id;
      } else if (identifiants.emailReel(req.body?.email) || telephone) {
        /* Un compte a besoin d'UN moyen d'être reconnu, pas des deux : le
           téléphone tient lieu d'adresse pour qui n'en a pas. Même lecture
           que POST /users, pour que les deux chemins ne divergent jamais. */
        const identite = identifiants.lireIdentifiants({ email: req.body?.email, phone: telephone });
        if (identite.telephoneIllisible) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Ce numéro de téléphone n'est pas exploitable. Exemples acceptés : "
                 + "76327799, 76 32 77 99, +22376327799, 0022376327799.",
            code: "PHONE_INVALID",
          });
        }
        if (identite.emailNormalise) {
          const { rows } = await client.query(
            `SELECT id FROM users WHERE lower(email)=$1 LIMIT 1`, [identite.emailNormalise]
          );
          if (rows[0]) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              error: "Cette adresse email est déjà utilisée par un autre compte.",
              code: "EMAIL_TAKEN",
            });
          }
        }
        if (identite.telephone) {
          const { rows } = await client.query(
            `SELECT id FROM users WHERE phone_normalise=$1 LIMIT 1`, [identite.telephone]
          );
          if (rows[0]) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              error: "Ce numéro de téléphone est déjà utilisé par un autre compte.",
              code: "PHONE_TAKEN",
            });
          }
        }

        /* Le rôle ne se déduit JAMAIS du poste : « Directeur » est une
           fonction RH, pas une autorisation. Un nouveau salarié entre avec le
           rôle le moins ouvert, et les droits se posent ensuite à l'écran. */
        const { rows: cree } = await client.query(
          `INSERT INTO users (fullname, email, password, role, phone, phone_normalise,
                              company_id, is_super_admin, is_active)
           VALUES ($1,$2,$3,'magasinier',$4,$5,$6,false,true)
           RETURNING id, fullname, email, phone, role`,
          [fullName, identite.email, await hashPassword(motDePasseProvisoire()),
           telephone, identite.telephone, companyId]
        );
        userId = cree[0].id;
        /* Le badge suit l'entreprise, et la séquence est incrémentée sous
           verrou dans CETTE transaction : deux créations simultanées
           obtiennent deux numéros distincts. */
        const badge = await companyContext.prochainBadge(client, companyId);
        await client.query(`UPDATE users SET badge_code=$1 WHERE id=$2`, [badge, userId]);
        compteCree = { ...cree[0], badge_code: badge };
      }

      /* ── LE MATRICULE ──
         `MAX+1` lu puis écrit sans verrou donne deux fois le même numéro à
         deux créations simultanées, et c'est l'index unique qui refuse la
         seconde — après avoir peut-être déjà créé un compte. Le verrou
         d'avis, pris par société, sérialise la numérotation et se relâche au
         COMMIT. Deux sociétés ne s'attendent pas l'une l'autre. */
      await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [812_374_51, companyId]);
      const { rows: numero } = await client.query(
        `SELECT COALESCE(MAX(employee_number),0)+1 AS suivant
           FROM attendance_employees WHERE company_id=$1`,
        [companyId]
      );
      const employeeNumber = Number(numero[0].suivant);

      const { rows: employe } = await client.query(
        `INSERT INTO attendance_employees
           (company_id, employee_number, full_name, user_id, site_id, schedule_id,
            job_title, phone, active, effective_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,COALESCE($9::date, CURRENT_DATE))
         RETURNING *`,
        [companyId, employeeNumber, fullName, userId, siteId, scheduleId,
         jobTitle, telephone, req.body?.effective_from || null]
      );

      /* ── LE SALAIRE INITIAL, s'il est fourni ──
         Daté du jour d'entrée par défaut, jamais d'une date en dur : un
         salaire posé rétroactivement sur une période déjà close rouvrirait un
         calcul que la clôture avait arrêté. */
      let salaire = null;
      if (salaireMensuel !== null || salaireJournalier !== null) {
        const { rows } = await client.query(
          `INSERT INTO attendance_salary_settings_v2
             (company_id, employee_id, monthly_salary, daily_rate, basis_days, effective_from, set_by)
           VALUES ($1,$2,$3,$4,30,$5,$6)
           ON CONFLICT (employee_id, effective_from) DO UPDATE
             SET monthly_salary=EXCLUDED.monthly_salary, daily_rate=EXCLUDED.daily_rate,
                 basis_days=30, set_by=EXCLUDED.set_by, updated_at=CURRENT_TIMESTAMP
           RETURNING monthly_salary, daily_rate, effective_from`,
          [companyId, employe[0].id, salaireMensuel, salaireJournalier,
           employe[0].effective_from, req.user.id]
        );
        salaire = rows[0];
      }

      await client.query("COMMIT");

      if (typeof logActivity === "function") {
        await logActivity(req.user.fullname, req.user.role, "Ajout d'un salarié", "Paie",
          `Matricule ${employeeNumber} — ${fullName} — entreprise ${companyId}`
          + (compteCree ? " — compte de connexion créé" : userId ? " — compte existant rattaché" : " — sans compte")
        ).catch(() => {});
      }

      const salaireVisible = await A.canViewAllSalaries(pool, companyId, req.user);
      res.status(201).json({
        employee: A.stripSalary({ ...employe[0], ...(salaire || {}) }, salaireVisible),
        compte: compteCree,
        message: compteCree
          ? `${fullName} est ajouté, avec un compte de connexion. Son mot de passe doit être défini depuis la fiche du compte.`
          : `${fullName} est ajouté à l'effectif.`,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      /* L'index unique reste le dernier rempart : si deux créations passent
         malgré tout, on répond la cause plutôt qu'une erreur 500 opaque. */
      if (error?.code === "23505") {
        return res.status(409).json({
          error: "Ce salarié existe déjà dans cette entreprise.",
          code: "EMPLOYEE_DUPLICATE",
        });
      }
      fail(res, error, "Erreur ajout du salarié.");
    } finally { client.release(); }
  });

  router.put("/attendance-v2/employees/:id/assignment", authenticateToken, async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    if (!A.isSuperAdmin(req.user)) return res.status(403).json({ error: "Réservé au super administrateur." });
    try {
      const { rows } = await pool.query(
        `UPDATE attendance_employees e SET site_id=s.id, schedule_id=w.id, updated_at=CURRENT_TIMESTAMP
          FROM attendance_work_sites s, attendance_work_schedules w
         WHERE e.id=$1 AND e.company_id=$2 AND s.id=$3 AND s.company_id=e.company_id
           AND w.id=$4 AND w.company_id=e.company_id RETURNING e.*`,
        [Number(req.params.id), companyId, Number(req.body?.site_id), Number(req.body?.schedule_id)]
      );
      if (!rows[0]) return res.status(404).json({ error: "Employé, site ou horaire introuvable." });
      res.json(rows[0]);
    } catch (error) { fail(res, error, "Erreur transfert employé."); }
  });

  /* ══════════════════════════════════════════════════════════════════════
     MODIFIER LE SALAIRE

     Trois règles, et chacune corrige un piège précis.

     1. La date d'effet par défaut est CURRENT_DATE, décidée par le serveur.
        Elle était figée à « 2026-09-03 » : tout salaire enregistré sans date
        atterrissait en septembre 2026, donc rétroactivement sur des périodes
        déjà closes, et rouvrait un calcul que la clôture avait arrêté.

     2. Un champ ABSENT du corps n'est pas un champ vidé. Envoyer le seul
        salaire mensuel effaçait le journalier, parce que `undefined` devenait
        NULL. Ce qui n'est pas mentionné est repris tel quel depuis le salaire
        en vigueur à cette date — lu dans la même instruction, donc sans
        fenêtre entre la lecture et l'écriture. Pour vider une valeur, il faut
        la dire : `null` ou chaîne vide.

     3. L'historique ne se réécrit pas. Chaque date d'effet est une ligne ; les
        lignes antérieures ne sont jamais touchées. Réenregistrer à une date
        déjà présente corrige cette ligne-là, et elle seule.
     ══════════════════════════════════════════════════════════════════════ */
  router.put("/attendance-v2/employees/:id/salary", authenticateToken, async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    if (!A.isSuperAdmin(req.user)) return res.status(403).json({ error: "Réservé au super administrateur." });

    /* Absent = « ne touche pas ». Explicitement null ou vide = « efface ». */
    const fourni = (champ) => Object.prototype.hasOwnProperty.call(req.body || {}, champ)
      && req.body[champ] !== undefined;
    const lireMontant = (champ) => {
      const brut = req.body[champ];
      if (brut === null || brut === "") return { valide: true, valeur: null };
      const nombre = Number(brut);
      if (!Number.isFinite(nombre) || nombre < 0) return { valide: false };
      return { valide: true, valeur: nombre };
    };

    const mensuelFourni = fourni("monthly_salary");
    const journalierFourni = fourni("daily_rate");
    if (!mensuelFourni && !journalierFourni) {
      return res.status(400).json({
        error: "Indiquez au moins un salaire à modifier : mensuel, journalier, ou les deux.",
        code: "SALARY_FIELD_REQUIRED",
      });
    }
    const mensuel = mensuelFourni ? lireMontant("monthly_salary") : { valide: true, valeur: null };
    const journalier = journalierFourni ? lireMontant("daily_rate") : { valide: true, valeur: null };
    if (!mensuel.valide || !journalier.valide) {
      return res.status(400).json({ error: "Salaire mensuel ou journalier invalide.", code: "SALARY_INVALID" });
    }

    /* Une date illisible n'est pas une date absente : la remplacer en silence
       par aujourd'hui daterait le salaire d'un jour que personne n'a choisi. */
    const dateDemandee = req.body?.effective_from;
    let dateEffet = null;
    if (dateDemandee !== undefined && dateDemandee !== null && String(dateDemandee).trim() !== "") {
      const texte = String(dateDemandee).trim();
      const jour = new Date(`${texte}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(texte) || Number.isNaN(jour.getTime())) {
        return res.status(400).json({
          error: "Date d'effet attendue au format AAAA-MM-JJ.", code: "EFFECTIVE_FROM_INVALID",
        });
      }
      dateEffet = texte;
    }

    try {
      const { rows } = await pool.query(
        `WITH date_effet AS (SELECT COALESCE($4::date, CURRENT_DATE) AS jour)
         INSERT INTO attendance_salary_settings_v2
           (company_id, employee_id, monthly_salary, daily_rate, basis_days, effective_from, set_by)
         SELECT $1, e.id,
                CASE WHEN $2::boolean THEN $3::numeric ELSE actuel.monthly_salary END,
                CASE WHEN $5::boolean THEN $6::numeric ELSE actuel.daily_rate END,
                30, d.jour, $7
           FROM attendance_employees e
           CROSS JOIN date_effet d
           LEFT JOIN LATERAL (
             SELECT s.monthly_salary, s.daily_rate
               FROM attendance_salary_settings_v2 s
              WHERE s.employee_id = e.id AND s.effective_from <= d.jour
              ORDER BY s.effective_from DESC LIMIT 1
           ) actuel ON true
          WHERE e.id = $8 AND e.company_id = $1
         ON CONFLICT (employee_id, effective_from) DO UPDATE
           SET monthly_salary = EXCLUDED.monthly_salary,
               daily_rate = EXCLUDED.daily_rate,
               basis_days = 30,
               set_by = EXCLUDED.set_by,
               updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [companyId, mensuelFourni, mensuel.valeur, dateEffet,
         journalierFourni, journalier.valeur, req.user.id, Number(req.params.id)]
      );
      if (!rows[0]) return res.status(404).json({ error: "Employé introuvable.", code: "EMPLOYEE_NOT_FOUND" });
      res.json(rows[0]);
    } catch (error) { fail(res, error, "Erreur enregistrement du salaire."); }
  });


  /* ══════════════════════════════════════════════════════════════════════
     RETIRER UN SALARIÉ — une désactivation, jamais une suppression.

     Le verbe DELETE décrit l'intention de l'écran, pas l'opération en base.
     Sept des neuf clés étrangères qui visent `attendance_employees` sont en
     ON DELETE CASCADE : une vraie suppression emporterait les pointages, le
     badge, l'historique de salaire, les corrections et les régularisations.
     Les deux autres — avances et lignes de paie — sont en RESTRICT, donc un
     salarié qui a déjà une avance ou un bulletin payé RÉSISTE à la
     suppression. C'est exactement le piège : le DELETE ne réussit que sur les
     salariés qu'on peut détruire sans que rien ne s'y oppose, c'est-à-dire
     les nouveaux, et il réussit en silence.

     On désactive donc, et rien ne se perd. Le pointage manuel comme le scan QR
     passent tous deux par `chargerEmployePourPointage`, qui filtre
     `active = true` : le badge reste en base, lisible et intact, et cesse
     d'ouvrir un pointage sans qu'on ait à y toucher.
     ══════════════════════════════════════════════════════════════════════ */
  router.delete("/attendance-v2/employees/:id", authenticateToken, async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    if (!A.isSuperAdmin(req.user)) return res.status(403).json({ error: "Réservé au super administrateur." });

    const employeeId = Number(req.params.id);
    if (!employeeId) return res.status(400).json({ error: "Salarié obligatoire.", code: "EMPLOYEE_REQUIRED" });
    const motif = String(req.body?.reason || "").trim();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      /* `company_id` dans le WHERE est l'isolation elle-même : une demande de
         Triangle portant l'identifiant d'un salarié de FAT & MAT ne trouve
         rien et repart en 404. Aucune ligne de l'autre société n'est lue. */
      const { rows: trouve } = await client.query(
        `SELECT id, full_name, employee_number, user_id, active, effective_from, effective_to
           FROM attendance_employees
          WHERE id=$1 AND company_id=$2
          FOR UPDATE`,
        [employeeId, companyId]
      );
      if (!trouve[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Salarié introuvable dans cette entreprise.", code: "EMPLOYEE_NOT_FOUND" });
      }
      const employe = trouve[0];

      /* Se retirer soi-même, c'est se fermer la porte depuis l'intérieur :
         plus de compte actif pour rouvrir. */
      if (employe.user_id && Number(employe.user_id) === Number(req.user.id)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "Vous ne pouvez pas vous retirer vous-même de l'effectif.",
          code: "SELF_REMOVAL_FORBIDDEN",
        });
      }

      if (employe.active === false) {
        await client.query("ROLLBACK");
        return res.json({
          deja_retire: true,
          employee: employe,
          message: `${employe.full_name} était déjà retiré de l'effectif.`,
        });
      }

      /* `effective_to` doit rester >= `effective_from` (contrainte de la
         table). Pour un salarié dont l'entrée est datée du futur, aujourd'hui
         serait antérieur à son arrivée : on ferme alors au jour d'entrée. */
      const { rows: retire } = await client.query(
        `UPDATE attendance_employees
            SET active = false,
                effective_to = GREATEST(effective_from, CURRENT_DATE),
                updated_at = CURRENT_TIMESTAMP
          WHERE id=$1 AND company_id=$2
          RETURNING *`,
        [employeeId, companyId]
      );

      /* Le compte de connexion suit, quand il y en a un : laisser une session
         ouverte à quelqu'un qui ne fait plus partie de l'effectif serait la
         moitié d'un retrait. Le compte est désactivé, pas supprimé — son nom
         doit rester lisible sur les paies et les avances qu'il a signées.
         Un compte super-administrateur n'est jamais désactivé par ce chemin :
         il dépasse le périmètre d'une société. */
      let compteDesactive = null;
      if (employe.user_id) {
        const { rows } = await client.query(
          `UPDATE users SET is_active=false, updated_at=CURRENT_TIMESTAMP
            WHERE id=$1 AND company_id=$2 AND is_super_admin IS NOT TRUE
            RETURNING id, fullname, is_active`,
          [employe.user_id, companyId]
        );
        compteDesactive = rows[0] || null;
      }

      /* Ce qui est conservé, compté dans la même transaction : la réponse le
         montre plutôt que de l'affirmer, et l'écran peut le dire à qui
         confirme le retrait. */
      const { rows: conserve } = await client.query(
        `SELECT
           (SELECT count(*) FROM attendance_day_records_v2 WHERE employee_id=$1) AS pointages,
           (SELECT count(*) FROM attendance_badges WHERE employee_id=$1) AS badges,
           (SELECT count(*) FROM attendance_salary_settings_v2 WHERE employee_id=$1) AS salaires,
           (SELECT count(*) FROM attendance_payroll_items_v2 WHERE employee_id=$1) AS lignes_de_paie,
           (SELECT count(*) FROM salary_advances WHERE employee_id=$1) AS avances,
           (SELECT count(*) FROM salary_advance_installments i
              JOIN salary_advances a ON a.id=i.advance_id WHERE a.employee_id=$1) AS echeances,
           (SELECT count(*) FROM salary_advance_repayments r
              JOIN salary_advances a ON a.id=r.advance_id WHERE a.employee_id=$1) AS remboursements,
           (SELECT COALESCE(sum(balance),0) FROM salary_advances WHERE employee_id=$1) AS solde_avances_restant`,
        [employeeId]
      );

      await client.query("COMMIT");

      if (typeof logActivity === "function") {
        await logActivity(req.user.fullname, req.user.role, "Retrait d'un salarié", "Paie",
          `Matricule ${employe.employee_number} — ${employe.full_name} — entreprise ${companyId}`
          + (motif ? ` — motif : ${motif}` : "")
          + ` — conservé : ${conserve[0].pointages} pointage(s), ${conserve[0].avances} avance(s), `
          + `${conserve[0].lignes_de_paie} ligne(s) de paie`
        ).catch(() => {});
      }

      const soldeDu = Number(conserve[0].solde_avances_restant) > 0;
      res.json({
        employee: retire[0],
        compte_desactive: compteDesactive,
        conserve: conserve[0],
        message: `${employe.full_name} est retiré de l'effectif. Son historique reste consultable.`
          + (soldeDu
            ? ` Attention : une avance reste due (${conserve[0].solde_avances_restant} FCFA) — le dossier reste ouvert dans les avances.`
            : ""),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      fail(res, error, "Erreur retrait du salarié.");
    } finally { client.release(); }
  });

  router.post("/attendance-v2/salary-adjustments", authenticateToken, async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    if (!A.isSuperAdmin(req.user)) return res.status(403).json({ error: "Réservé au super administrateur." });
    const amount = Number(req.body?.amount); const reason = String(req.body?.reason || "").trim();
    if (!Number.isFinite(amount) || amount === 0 || reason.length < 3) return res.status(400).json({ error: "Montant non nul et justification obligatoire." });
    try {
      const { rows } = await pool.query(
        `INSERT INTO attendance_salary_adjustments_v2(company_id,employee_id,work_date,amount,reason,created_by)
         SELECT $1,e.id,$2,$3,$4,$5 FROM attendance_employees e WHERE e.id=$6 AND e.company_id=$1 RETURNING *`,
        [companyId, req.body?.work_date, amount, reason, req.user.id, Number(req.body?.employee_id)]
      );
      if (!rows[0]) return res.status(404).json({ error: "Employé introuvable." });
      res.status(201).json(rows[0]);
    } catch (error) { fail(res, error, "Erreur ajustement salarial."); }
  });

  router.get("/attendance-v2/payroll", authenticateToken, garde("view"), async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    const month = String(req.query.month || "");
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "Mois attendu au format AAAA-MM." });
    const client = await pool.connect();
    try {
      if (!await A.canViewAllSalaries(client, companyId, req.user)) return res.status(403).json({ error: "Accès aux salaires refusé." });
      const employees = await calculatePayroll(client,companyId,month);
      const run = (await client.query(
        `SELECT * FROM attendance_payroll_runs_v2 WHERE company_id=$1 AND period_month=$2::date`,
        [companyId,`${month}-01`]
      )).rows[0] || null;
      const items = run ? (await client.query(
        `SELECT * FROM attendance_payroll_items_v2 WHERE payroll_run_id=$1 ORDER BY employee_id`,[run.id]
      )).rows : [];

      /* La demande en attente, et qui l'a soumise. L'écran en a besoin pour
         savoir s'il doit proposer « retirer ma soumission » plutôt que des
         boutons de décision que le serveur refusera. Sans cette information, la
         page affichait les trois boutons de la Direction à l'auteur lui-même,
         qui découvrait le refus après avoir cliqué. */
      const demande = run ? (await client.query(
        `SELECT id, status, amount_submitted, submitted_by, submitted_by_name, submitted_at
           FROM payroll_requests
          WHERE payroll_run_id = $1 AND status = 'EN_ATTENTE_DIRECTION'
          ORDER BY submitted_at DESC LIMIT 1`, [run.id]
      )).rows[0] || null : null;

      /* Une paie « en attente de la Direction » SANS demande en attente est une
         INCOHÉRENCE, pas une règle métier. L'écran doit la nommer, et non en
         déduire que la validation revient à quelqu'un d'autre. On relit donc la
         dernière demande quel que soit son statut, pour pouvoir dire ce qui
         s'est réellement passé. */
      const derniereDemande = run ? (await client.query(
        `SELECT id, status, submitted_by, submitted_by_name, submitted_at,
                decided_at, decision_reason
           FROM payroll_requests WHERE payroll_run_id = $1
          ORDER BY submitted_at DESC LIMIT 1`, [run.id]
      )).rows[0] || null : null;

      /* Le droit de lever la séparation est relu EN BASE, jamais déduit du
         jeton : un jeton émis avant un retrait de privilège continuerait sinon
         d'ouvrir ce passage — et c'est précisément le passage qui lève un
         contrôle. */
      const { rows: compte } = await client.query(
        `SELECT is_super_admin FROM users WHERE id = $1`, [req.user?.id || 0]
      );
      const estSuperAdmin = compte[0]?.is_super_admin === true;

      /* Les droits RBAC sont évalués ici avec LE MÊME moteur que les gardes des
         routes d'action, et non re-déduits à l'écran depuis un autre endpoint.
         Sans cela l'écran proposait un bouton que la route refusait : « Retirer
         ma soumission » appelle une route gardée par `paie.submit`, que le rôle
         `direction` n'a justement pas.

         Si le moteur est indisponible, le droit est INCONNU — pas « non ». La
         différence compte : c'est en confondant les deux que la page affirmait
         une règle métier là où il n'y avait qu'une absence de données. */
      let ctxDroits = null;
      try { ctxDroits = await PERM.chargerContexte(pool, req.user, companyId); }
      catch (e) { console.error("droits paie indisponibles:", e.message || e); }
      const aLeDroit = (action) =>
        ctxDroits ? PERM.decider(ctxDroits, "paie", action).autorise : null;
      const peutSoumettre = aLeDroit("submit");
      const peutValiderRbac = aLeDroit("validate");

      const enAttente = Boolean(demande);
      const estAuteurDeLaDemande = enAttente
        && Number(demande.submitted_by) === Number(req.user?.id);

      /* POURQUOI une action manque est dit par le serveur. L'écran ne le devine
         plus par la négation d'un autre droit : c'est cette déduction qui
         faisait annoncer « la validation revient à quelqu'un d'autre » alors
         que les droits n'étaient, en réalité, pas connus du tout. */
      const sansSoumission = !enAttente
        ? (run && run.status === "EN_ATTENTE_DIRECTION" ? "DEMANDE_INTROUVABLE" : "AUCUNE_SOUMISSION")
        : null;
      const motifSansDecision =
        sansSoumission ? sansSoumission
        : peutValiderRbac === null ? "DROITS_INDISPONIBLES"
        : peutValiderRbac === false ? "DROIT_VALIDATE_MANQUANT"
        : (estAuteurDeLaDemande && !estSuperAdmin) ? "AUTEUR_DE_LA_SOUMISSION"
        : null;
      const motifSansRetrait =
        sansSoumission ? sansSoumission
        : !(estAuteurDeLaDemande || estSuperAdmin) ? "NI_AUTEUR_NI_SUPER_ADMIN"
        : peutSoumettre === null ? "DROITS_INDISPONIBLES"
        : peutSoumettre === false ? "DROIT_SUBMIT_MANQUANT"
        : null;

      res.json({
        month, employees, run, items, demande,
        droits: {
          est_super_admin: estSuperAdmin,
          est_auteur_de_la_soumission: estAuteurDeLaDemande,
          soumission_en_attente: enAttente,
          peut_valider: peutValiderRbac === true,
          peut_soumettre: peutSoumettre === true,
          /* La règle du serveur, telle quelle : l'auteur ne décide pas, sauf
             s'il est super administrateur — et dans tous les cas il faut le
             droit que la route exigera. */
          peut_decider: motifSansDecision === null,
          peut_retirer_sa_soumission: motifSansRetrait === null,
          motif_sans_decision: motifSansDecision,
          motif_sans_retrait: motifSansRetrait,
          incoherence: (run && run.status === "EN_ATTENTE_DIRECTION" && !enAttente)
            ? {
                code: "DEMANDE_INTROUVABLE",
                derniere_demande_statut: derniereDemande?.status || null,
                derniere_demande_le: derniereDemande?.decided_at || derniereDemande?.submitted_at || null,
                derniere_demande_motif: derniereDemande?.decision_reason || "",
              }
            : null,
        },
      });
    } catch (error) { fail(res, error, "Erreur calcul de la paie."); }
    finally { client.release(); }
  });

  router.post("/attendance-v2/payroll/:month/generate", authenticateToken, garde("prepare"), async (req,res) => {
    const companyId=requireCompany(req,res); if(!companyId) return;
    const month=String(req.params.month||"");
    if(!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({error:"Mois attendu au format AAAA-MM."});
    const client=await pool.connect();
    try {
      /* Le droit a déjà été tranché par `garde("prepare")`, à l'entrée de la
         route. On n'interroge plus `canManagePayroll()` : c'était le second
         moteur, celui qui accordait la paie au vu du rôle et qui, une fois ce
         repli retiré, se mettait à refuser des comptes pourtant autorisés par
         l'écran des droits. Deux moteurs concurrents se trompent toujours dans
         un sens ou dans l'autre ; il n'en reste qu'un. */

      /* CETTE ROUTE CALCULE UN MOIS CIVIL, PAS UNE PÉRIODE DU 25 AU 24.
         Dès qu'une période existe pour ce mois, l'utiliser produirait une paie
         qui ne couvre pas les mêmes journées que celles annoncées à l'écran —
         et, faute de `period_id`, le verrou de paiement la prendrait ensuite
         pour une paie historique, donc payable sans passer par la Direction.
         On refuse, en indiquant la route qui convient. */
      {
        const { rows: periodes } = await client.query(
          `SELECT code FROM attendance_periods WHERE company_id = $1 AND code = $2`,
          [companyId, month]
        );
        if (periodes[0]) {
          return res.status(409).json({
            error: `La période ${month} est ouverte : préparez sa paie sur ses vraies bornes, du 25 au 24.`,
            code: "USE_PERIOD_ENDPOINT",
            route: `/paie/periodes/${month}/preparer`,
          });
        }
      }

      const lines=await calculatePayroll(client,companyId,month);
      await client.query("BEGIN");
      const run=(await client.query(
        `INSERT INTO attendance_payroll_runs_v2(company_id,period_month,prepared_by)
         VALUES($1,$2::date,$3)
         ON CONFLICT(company_id,period_month) DO UPDATE SET prepared_by=EXCLUDED.prepared_by,prepared_at=now(),updated_at=now()
         WHERE attendance_payroll_runs_v2.status='DRAFT' RETURNING *`,
        [companyId,`${month}-01`,req.user.id]
      )).rows[0];
      if(!run) throw Object.assign(new Error("Une paie déjà payée ne peut pas être recalculée."),{httpStatus:409,code:"PAYROLL_LOCKED"});
      /* Régénérer une paie efface ses lignes — donc aussi les retenues
         d'avance qui y étaient rattachées. Les contrepasser AVANT la
         suppression rend le solde des avances à ce qu'il était : sans cela,
         préparer deux fois la paie retiendrait deux fois la même échéance,
         et le salarié rembourserait le double. */
      {
        const { rows: retenues } = await client.query(
          `SELECT r.id, r.advance_id, r.installment_id, r.amount
             FROM salary_advance_repayments r
             JOIN attendance_payroll_items_v2 i ON i.id = r.payroll_item_id
            WHERE i.payroll_run_id = $1 AND r.origin = 'RETENUE_PAIE'`,
          [run.id]
        );
        for (const retenue of retenues) {
          await client.query(
            `UPDATE salary_advances
                SET balance = balance + $1,
                    status = CASE WHEN balance + $1 >= amount_paid THEN 'VERSEE' ELSE 'EN_REMBOURSEMENT' END,
                    updated_at = now()
              WHERE id = $2`, [retenue.amount, retenue.advance_id]);
          if (retenue.installment_id) {
            await client.query(
              `UPDATE salary_advance_installments
                  SET amount_taken = GREATEST(0, amount_taken - $1), status = 'A_VENIR', updated_at = now()
                WHERE id = $2`, [retenue.amount, retenue.installment_id]);
          }
        }
        /* Les lignes de remboursement partent avec les lignes de paie
           (ON DELETE SET NULL les laisserait orphelines et fausserait
           l'historique d'une avance). */
        await client.query(
          `DELETE FROM salary_advance_repayments
            WHERE origin = 'RETENUE_PAIE' AND payroll_item_id IN
              (SELECT id FROM attendance_payroll_items_v2 WHERE payroll_run_id = $1)`,
          [run.id]);
      }

      await client.query(`DELETE FROM attendance_payroll_items_v2 WHERE payroll_run_id=$1`,[run.id]);
      for(const line of lines){
        const { rows: creees } = await client.query(
          `INSERT INTO attendance_payroll_items_v2(company_id,payroll_run_id,employee_id,employee_name,
            monthly_salary,daily_rate,expected_days,attended_days,absence_days,late_minutes,
            absence_deduction,adjustments,net_salary,status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, net_salary`,
          [companyId,run.id,line.id,line.full_name,line.monthly_salary,line.daily_rate,line.expected_days,
           line.attended_days,line.absence_days,line.late_minutes,line.absence_deduction,line.adjustments,line.net_salary,line.status]
        );
        const ligne = creees[0];

        /* La retenue d'avance vient APRÈS le calcul du net : elle est plafonnée
           par ce qui reste dû ET par le net disponible. Une retenue ne doit
           jamais rendre un salaire négatif ; ce qui n'a pas pu être pris reste
           dû et repassera à la période suivante. */
        if (ligne.net_salary != null) {
          /* Même règle que la préparation par période : une retenue déjà
             enregistrée hors paie compte, et elle plafonne ce qui reste
             prélevable. Deux générateurs qui compteraient différemment
             donneraient deux nets pour le même mois. */
          const externes = await AV.retenuesHorsPaie(client, {
            companyId, employeeId: line.id, periodCode: month,
          });
          const totalExterne = externes.reduce((somme, r) => somme + r.montant, 0);

          const retenues = await AV.retenueDue(client, {
            companyId, employeeId: line.id, periodCode: month,
            netDisponible: Math.max(0, Number(ligne.net_salary) - totalExterne),
          });
          let total = 0;
          for (const r of retenues) {
            await AV.rembourser(client, {
              companyId, advanceId: r.advance_id, montant: r.montant,
              origine: "RETENUE_PAIE", installmentId: r.installment_id,
              payrollItemId: ligne.id, reference: r.reference,
              userId: req.user?.id || null, userName: req.user?.fullname || "",
            });
            total += r.montant;
          }
          const totalRetenu = total + totalExterne;
          if (totalRetenu > 0) {
            await client.query(
              `UPDATE attendance_payroll_items_v2
                  SET advance_deduction = $1, advance_deduction_externe = $2,
                      net_salary = GREATEST(0, net_salary - $1), updated_at = now()
                WHERE id = $3`, [totalRetenu, totalExterne, ligne.id]);
          }
        }
      }
      const totals=(await client.query(
        `UPDATE attendance_payroll_runs_v2 r SET
          gross_amount=x.gross,deductions_amount=x.deductions,adjustments_amount=x.adjustments,
          net_amount=x.net,updated_at=now()
         FROM (SELECT payroll_run_id,COALESCE(sum(monthly_salary),0) gross,
           COALESCE(sum(absence_deduction),0)+COALESCE(sum(advance_deduction),0) deductions,
           COALESCE(sum(adjustments),0) adjustments,
           COALESCE(sum(net_salary),0) net FROM attendance_payroll_items_v2 WHERE payroll_run_id=$1 GROUP BY payroll_run_id) x
         WHERE r.id=x.payroll_run_id RETURNING r.*`,[run.id]
      )).rows[0];
      await client.query("COMMIT"); res.status(201).json({run:totals,employees:lines});
    } catch(error){await client.query("ROLLBACK").catch(()=>{});fail(res,error,"Erreur génération de la paie.");}
    finally{client.release();}
  });

  /**
   * PAYER UN SALAIRE.
   *
   * ─────────────────────────────────────────────────────────────────────
   * POURQUOI TOUT SE PASSE DANS UNE SEULE TRANSACTION
   *
   * Les contrôles étaient auparavant faits AVANT le `BEGIN`, sur des lignes
   * non verrouillées. Entre la lecture et l'écriture, la Direction pouvait
   * refuser la paie, ou un second clic pouvait passer : on vérifiait un
   * état qui n'était plus celui qu'on modifiait ensuite. Ici, la ligne de
   * paie est verrouillée d'abord, tout est lu sous ce verrou, et le débit
   * comme les écritures partent dans la même transaction.
   *
   * ─────────────────────────────────────────────────────────────────────
   * POURQUOI « AUCUNE DEMANDE » N'EST PLUS UN LAISSEZ-PASSER
   *
   * L'ancien verrou n'exigeait une demande validée que si une demande
   * EXISTAIT. Une paie neuve dont personne n'avait rien soumis restait donc
   * payable — c'est-à-dire précisément le contournement qu'il fallait
   * fermer : il suffisait de ne pas soumettre pour n'avoir personne à
   * convaincre.
   *
   * L'exception historique est désormais NOMMÉE (migration 088) plutôt que
   * déduite : seules les paies qui existaient au moment de cette migration,
   * et qui n'ont pas de période, portent `legacy_sans_validation`. Toute
   * paie créée ensuite naît à FALSE. L'exception ne peut donc pas s'élargir.
   */
  router.post("/attendance-v2/payroll-items/:id/pay", authenticateToken, garde("pay"), async(req,res)=>{
    const companyId=requireCompany(req,res); if(!companyId) return;
    const client=await pool.connect();
    try {
      /* Le droit a déjà été tranché par `garde("pay")`. Voir la note de la
         route de préparation : un seul moteur décide, celui que l'écran des
         droits pilote. Les règles MÉTIER — demande validée, décideur distinct
         du demandeur, statut payable, solde, anti-doublon — restent entières,
         plus bas, et doivent toutes être satisfaites en plus du droit. */

      const method=P.assertPaymentMethod(req.body?.payment_method);
      if(["BANK","TRANSFER","CHECK"].includes(method) && !req.body?.bank_id)
        return res.status(400).json({error:"Sélectionnez la banque utilisée.",code:"PAYROLL_BANK_REQUIRED"});
      if(method==="CASHBOX" && !req.body?.caisse_id)
        return res.status(400).json({error:"Sélectionnez la caisse utilisée.",code:"PAYROLL_CASHBOX_REQUIRED"});

      await client.query("BEGIN");

      /* Le verrou d'abord : deux paiements simultanés se sérialisent ici, et
         le second trouvera la ligne déjà payée. */
      const { rows: lignes } = await client.query(
        `SELECT i.id, i.status, i.net_salary, i.payroll_run_id,
                r.status AS run_status, r.period_id, r.legacy_sans_validation
           FROM attendance_payroll_items_v2 i
           JOIN attendance_payroll_runs_v2 r ON r.id = i.payroll_run_id
          WHERE i.id = $1 AND i.company_id = $2
          FOR UPDATE OF i`,
        [Number(req.params.id), companyId]
      );
      const ligne = lignes[0];
      if (!ligne) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Salaire introuvable.", code: "PAYROLL_ITEM_NOT_FOUND" });
      }

      /* L'exception historique, et rien d'autre. Une paie rattachée à une
         période n'y a jamais droit, même marquée par erreur. */
      const historique = ligne.legacy_sans_validation === true && ligne.period_id === null;

      if (!historique) {
        const { rows: demandes } = await client.query(
          `SELECT status, submitted_by, decided_by
             FROM payroll_requests
            WHERE payroll_run_id = $1
            ORDER BY submitted_at DESC, id DESC
            LIMIT 1`,
          [ligne.payroll_run_id]
        );
        const demande = demandes[0] || null;

        if (!demande) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "Cette paie n'a jamais été soumise à la Direction : elle ne peut pas être payée.",
            code: "PAYROLL_NOT_SUBMITTED",
          });
        }
        if (demande.status !== "VALIDEE") {
          const explications = {
            EN_ATTENTE_DIRECTION: "Cette paie attend encore la décision de la Direction.",
            REFUSEE:              "Cette paie a été refusée par la Direction.",
            CORRECTION_DEMANDEE:  "La Direction a demandé une correction : corrigez puis soumettez à nouveau.",
            ANNULEE:              "La demande de paiement a été annulée.",
          };
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: explications[demande.status] || "Cette paie n'est pas autorisée au paiement.",
            code: "PAYROLL_NOT_AUTHORIZED",
            statut_demande: demande.status,
          });
        }

        /* Le décideur doit être quelqu'un d'AUTRE. La route de décision le
           refuse déjà, mais une demande validée est ce qui autorise à sortir
           de l'argent : on ne s'en remet pas à un contrôle fait ailleurs.

           MÊME EXCEPTION QU'À LA VALIDATION, ET RELUE EN BASE DE LA MÊME
           FAÇON : le super administrateur. Sans elle, les deux règles se
           contredisaient — la Direction autorisait l'auto-validation d'un
           super administrateur, puis ce contrôle-ci refusait éternellement de
           payer la paie ainsi autorisée. Une paie autorisée qu'on ne peut pas
           payer n'est pas un contrôle, c'est une impasse. Le privilège est
           relu dans `users`, jamais pris du jeton, et la trace reste dans le
           motif de la décision. */
        const autoValidee = demande.decided_by !== null
          && Number(demande.decided_by) === Number(demande.submitted_by);
        if (autoValidee) {
          const { rows: decideur } = await client.query(
            `SELECT is_super_admin FROM users WHERE id = $1`, [demande.decided_by]
          );
          if (decideur[0]?.is_super_admin !== true) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              error: "Cette paie a été validée par la personne qui l'a soumise : elle n'est pas valablement autorisée.",
              code: "SELF_APPROVED_REQUEST",
            });
          }
        } else if (demande.decided_by === null) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "Cette paie ne porte pas de décideur : elle n'est pas valablement autorisée.",
            code: "SELF_APPROVED_REQUEST",
          });
        }

        const STATUTS_PAYABLES = ["AUTORISEE_AU_PAIEMENT", "PARTIALLY_PAID", "PAID"];
        if (!STATUTS_PAYABLES.includes(ligne.run_status)) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "Cette paie n'est pas dans un état qui permet le paiement.",
            code: "PAYROLL_NOT_AUTHORIZED",
            statut_paie: ligne.run_status,
          });
        }
      }

      const item=(await client.query(
        `UPDATE attendance_payroll_items_v2 SET status='PAID',payment_method=$1,payment_reference=$2,
          bank_id=$3,caisse_id=$4,paid_by=$5,paid_at=now(),updated_at=now()
         WHERE id=$6 AND company_id=$7 AND status='TO_PAY' AND net_salary IS NOT NULL RETURNING *`,
        [method,String(req.body?.payment_reference||"").trim(),req.body?.bank_id||null,
         req.body?.caisse_id||null,req.user.id,Number(req.params.id),companyId]
      )).rows[0];
      if(!item) throw Object.assign(new Error("Salaire introuvable, bloqué ou déjà payé."),{httpStatus:409,code:"PAYROLL_ITEM_NOT_PAYABLE"});
      const amount=Number(item.net_salary||0);
      let sourceLabel="Trésorerie interne";
      if(["BANK","TRANSFER","CHECK"].includes(method)) {
        const bank=(await client.query(`SELECT * FROM accounting_banks WHERE id=$1 AND company_id=$2 FOR UPDATE`,[req.body.bank_id,companyId])).rows[0];
        if(!bank || Number(bank.current_balance||0)<amount) throw Object.assign(new Error("Banque introuvable ou solde insuffisant."),{httpStatus:409,code:"PAYROLL_BANK_INSUFFICIENT"});
        await client.query(`UPDATE accounting_banks SET current_balance=current_balance-$1,updated_at=now() WHERE id=$2`,[amount,bank.id]);
        sourceLabel=bank.bank_name||"Banque";
      } else if(method==="CASHBOX" || (method==="CASH" && req.body?.caisse_id)) {
        const caisse=(await client.query(`SELECT * FROM caisses WHERE id=$1 AND company_id=$2 FOR UPDATE`,[req.body.caisse_id,companyId])).rows[0];
        if(!caisse || Number(caisse.solde_actuel||0)<amount) throw Object.assign(new Error("Caisse introuvable ou solde insuffisant."),{httpStatus:409,code:"PAYROLL_CASHBOX_INSUFFICIENT"});
        await client.query(`UPDATE caisses SET solde_actuel=solde_actuel-$1,updated_at=now() WHERE id=$2`,[amount,caisse.id]);
        sourceLabel=caisse.nom_caisse||"Caisse";
      } else {
        const treasury=(await client.query(`SELECT * FROM treasury_accounts WHERE company_id=$1 FOR UPDATE`,[companyId])).rows[0];
        if(!treasury || Number(treasury.current_balance||0)<amount) throw Object.assign(new Error("Trésorerie insuffisante."),{httpStatus:409,code:"PAYROLL_TREASURY_INSUFFICIENT"});
        await client.query(`UPDATE treasury_accounts SET current_balance=current_balance-$1,updated_by=$2,updated_at=now() WHERE company_id=$3`,[amount,req.user.id,companyId]);
      }
      const transactionNumber=await nextAccountingNumber(client,"accounting_transactions","transaction_number","SAL",companyId);
      const transaction=(await client.query(
        `INSERT INTO accounting_transactions(company_id,transaction_number,transaction_type,source_type,source_id,
          bank_id,caisse_id,amount,currency,direction,category,partner_name,description,status,
          source_label,destination_label,created_by,validated_by,validated_at)
         VALUES($1,$2,'paiement_salaire','attendance_payroll_item',$3,$4,$5,$6,'FCFA','sortie','Salaire',$7,$8,'validé',$9,$7,$10,$10,now()) RETURNING *`,
        [companyId,transactionNumber,item.id,req.body?.bank_id||null,req.body?.caisse_id||null,amount,
         item.employee_name,`Paiement salaire ${item.employee_name}`,sourceLabel,req.user.id]
      )).rows[0];
      await createAccountingEntry(client,{companyId,sourceType:"attendance_payroll_item",sourceId:item.id,
        accountLabel:"Charges de personnel",debit:amount,credit:0,description:`Salaire ${item.employee_name}`,createdBy:req.user.id});
      await createAccountingEntry(client,{companyId,sourceType:"attendance_payroll_item",sourceId:item.id,
        accountLabel:sourceLabel,debit:0,credit:amount,description:`Paiement salaire ${item.employee_name}`,createdBy:req.user.id});
      await client.query(`UPDATE attendance_payroll_items_v2 SET accounting_transaction_id=$1 WHERE id=$2`,[transaction.id,item.id]);
      const run=(await client.query(
        `UPDATE attendance_payroll_runs_v2 r SET status=CASE
           WHEN NOT EXISTS(SELECT 1 FROM attendance_payroll_items_v2 i WHERE i.payroll_run_id=r.id AND i.status IN ('TO_PAY','BLOCKED')) THEN 'PAID'
           ELSE 'PARTIALLY_PAID' END,updated_at=now()
         WHERE r.id=$1 RETURNING r.*`,[item.payroll_run_id]
      )).rows[0];
      /* La période suit son unique paie : tout payé, elle passe à PAYEE et
         devient clôturable. Un paiement partiel la laisse où elle est. */
      if (run?.period_id && run.status === "PAID") {
        await client.query(
          `UPDATE attendance_periods SET status='PAYEE', updated_at=now()
            WHERE id=$1 AND status IN ('AUTORISEE_AU_PAIEMENT','VALIDEE_DIRECTION')`,
          [run.period_id]
        );
      }
      await client.query("COMMIT"); res.json({item,run});
    } catch(error){await client.query("ROLLBACK").catch(()=>{});fail(res,error,"Erreur paiement du salaire.");}
    finally{client.release();}
  });

  return router;
};
