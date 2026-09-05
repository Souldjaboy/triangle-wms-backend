"use strict";

const express = require("express");
const A = require("../services/attendance-workforce");
const AV = require("../services/avances-salaire");
const P = require("../services/attendance-payroll");

module.exports = function createAttendanceWorkforceRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, nextAccountingNumber, createAccountingEntry } = deps;
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const fail = (res, error, fallback) => {
    console.error(fallback, error);
    res.status(error.httpStatus || 500).json({ error: error.message || fallback, code: error.code });
  };
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
         SELECT e.id,e.employee_number,e.full_name,e.schedule_id
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

  router.put("/attendance-v2/employees/:id/salary", authenticateToken, async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    if (!A.isSuperAdmin(req.user)) return res.status(403).json({ error: "Réservé au super administrateur." });
    const rate = req.body?.daily_rate === null || req.body?.daily_rate === "" ? null : Number(req.body?.daily_rate);
    const monthly = req.body?.monthly_salary === null || req.body?.monthly_salary === "" ? null : Number(req.body?.monthly_salary);
    if ((rate !== null && (!Number.isFinite(rate) || rate < 0)) ||
        (monthly !== null && (!Number.isFinite(monthly) || monthly < 0))) {
      return res.status(400).json({ error: "Salaire mensuel ou journalier invalide." });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO attendance_salary_settings_v2(company_id,employee_id,monthly_salary,daily_rate,basis_days,effective_from,set_by)
         SELECT $1,e.id,$2,$3,30,$4,$5 FROM attendance_employees e WHERE e.id=$6 AND e.company_id=$1
         ON CONFLICT(employee_id,effective_from) DO UPDATE SET monthly_salary=EXCLUDED.monthly_salary,
           daily_rate=EXCLUDED.daily_rate,basis_days=30,set_by=EXCLUDED.set_by,updated_at=CURRENT_TIMESTAMP
         RETURNING *`,
        [companyId, monthly, rate, req.body?.effective_from || "2026-09-03", req.user.id, Number(req.params.id)]
      );
      if (!rows[0]) return res.status(404).json({ error: "Employé introuvable." });
      res.json(rows[0]);
    } catch (error) { fail(res, error, "Erreur salaire journalier."); }
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

  router.get("/attendance-v2/payroll", authenticateToken, async (req, res) => {
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
      res.json({ month, employees, run, items });
    } catch (error) { fail(res, error, "Erreur calcul de la paie."); }
    finally { client.release(); }
  });

  router.post("/attendance-v2/payroll/:month/generate", authenticateToken, async (req,res) => {
    const companyId=requireCompany(req,res); if(!companyId) return;
    const month=String(req.params.month||"");
    if(!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({error:"Mois attendu au format AAAA-MM."});
    const client=await pool.connect();
    try {
      if(!await P.canManagePayroll(client,companyId,req.user,"prepare")) return res.status(403).json({error:"Préparation de la paie refusée."});
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
          const retenues = await AV.retenueDue(client, {
            companyId, employeeId: line.id, periodCode: month,
            netDisponible: Number(ligne.net_salary),
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
          if (total > 0) {
            await client.query(
              `UPDATE attendance_payroll_items_v2
                  SET advance_deduction = $1, net_salary = GREATEST(0, net_salary - $1), updated_at = now()
                WHERE id = $2`, [total, ligne.id]);
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

  router.post("/attendance-v2/payroll-items/:id/pay", authenticateToken, async(req,res)=>{
    const companyId=requireCompany(req,res); if(!companyId) return;
    const client=await pool.connect();
    try {
      if(!await P.canManagePayroll(client,companyId,req.user,"pay")) return res.status(403).json({error:"Paiement de salaire refusé."});

      /* LE VERROU (migration 081) : payer exige une autorisation de la
         Direction. Le contrôle ne porte pas sur le rôle de celui qui clique —
         un rôle se change à l'écran des droits — mais sur l'état d'un objet
         que quelqu'un d'AUTRE a dû toucher : une `payroll_requests` VALIDEE,
         décidée par un compte différent de celui qui a soumis.

         Une paie sans période et sans demande reste payable : ce sont les
         paies mensuelles enregistrées avant ce chantier, et les bloquer
         rétroactivement empêcherait de solder ce qui est en cours. Dès qu'une
         demande existe pour cette paie, en revanche, elle fait autorité. */
      {
        const { rows: etat } = await client.query(
          `SELECT r.id AS run_id, r.status AS run_status,
                  (SELECT status FROM payroll_requests q
                    WHERE q.payroll_run_id = r.id
                    ORDER BY q.submitted_at DESC, q.id DESC LIMIT 1) AS demande_status
             FROM attendance_payroll_items_v2 i
             JOIN attendance_payroll_runs_v2 r ON r.id = i.payroll_run_id
            WHERE i.id = $1 AND i.company_id = $2`,
          [Number(req.params.id), companyId]
        );
        const ligne = etat[0];
        if (!ligne) return res.status(404).json({ error: "Salaire introuvable.", code: "PAYROLL_ITEM_NOT_FOUND" });

        if (ligne.demande_status && ligne.demande_status !== "VALIDEE") {
          const explications = {
            EN_ATTENTE_DIRECTION: "Cette paie attend encore la décision de la Direction.",
            REFUSEE:              "Cette paie a été refusée par la Direction.",
            CORRECTION_DEMANDEE:  "La Direction a demandé une correction : corrigez puis soumettez à nouveau.",
            ANNULEE:              "La demande de paiement a été annulée.",
          };
          return res.status(409).json({
            error: explications[ligne.demande_status] || "Cette paie n'est pas autorisée au paiement.",
            code: "PAYROLL_NOT_AUTHORIZED",
            statut_demande: ligne.demande_status,
          });
        }
        if (["EN_ATTENTE_DIRECTION", "REFUSEE", "CORRECTION_DEMANDEE"].includes(ligne.run_status)) {
          return res.status(409).json({
            error: "Cette paie n'est pas autorisée au paiement.",
            code: "PAYROLL_NOT_AUTHORIZED", statut_paie: ligne.run_status,
          });
        }
      }

      const method=P.assertPaymentMethod(req.body?.payment_method);
      if(["BANK","TRANSFER","CHECK"].includes(method) && !req.body?.bank_id)
        return res.status(400).json({error:"Sélectionnez la banque utilisée.",code:"PAYROLL_BANK_REQUIRED"});
      if(method==="CASHBOX" && !req.body?.caisse_id)
        return res.status(400).json({error:"Sélectionnez la caisse utilisée.",code:"PAYROLL_CASHBOX_REQUIRED"});
      await client.query("BEGIN");
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
