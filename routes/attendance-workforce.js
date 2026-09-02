"use strict";

const express = require("express");
const A = require("../services/attendance-workforce");
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

  router.post("/attendance-v2/check", authenticateToken, async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    const client = await pool.connect();
    try {
      const action = A.assertAction(req.body?.action_type);
      const employeeId = Number(req.body?.employee_id);
      if (!employeeId) return res.status(400).json({ error: "Employé obligatoire.", code: "EMPLOYEE_REQUIRED" });
      await client.query("BEGIN");
      const { rows: employees } = await client.query(
        `SELECT e.*, c.official_start_at, c.timezone,
                (timezone(c.timezone, now()))::date AS local_date,
                (timezone(c.timezone, now()))::time AS local_time
           FROM attendance_employees e
           JOIN attendance_company_configuration c ON c.company_id=e.company_id
          WHERE e.id=$1 AND e.company_id=$2 AND e.active=true FOR UPDATE OF e`,
        [employeeId, companyId]
      );
      const employee = employees[0];
      if (!employee) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Employé introuvable." }); }
      if (new Date() < new Date(employee.official_start_at)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Le nouveau pointage n’est pas encore ouvert.", code: "ATTENDANCE_NOT_STARTED" });
      }
      if (!await A.canPunchEmployee(client, companyId, req.user, employee)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Vous ne pouvez pas pointer cet employé.", code: "ATTENDANCE_SCOPE_DENIED" });
      }
      const { rows: days } = await client.query(
        `SELECT d.* FROM attendance_schedule_days d
          WHERE d.schedule_id=$1 AND d.iso_weekday=extract(isodow FROM $2::date)`,
        [employee.schedule_id, employee.local_date]
      );
      const day = days[0];
      if (!day?.is_working_day) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Jour non travaillé pour cet employé.", code: "NON_WORKING_DAY" });
      }
      const { rows: records } = await client.query(
        `INSERT INTO attendance_day_records_v2(company_id,employee_id,work_date,status,punched_by)
         VALUES($1,$2,$3,'ABSENT',$4)
         ON CONFLICT(company_id,employee_id,work_date) DO UPDATE SET updated_at=attendance_day_records_v2.updated_at
         RETURNING *`,
        [companyId, employee.id, employee.local_date, req.user.id]
      );
      const record = records[0];
      const column = A.ACTION_COLUMNS[action];
      if (record[column]) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Ce pointage est déjà enregistré.", code: "ATTENDANCE_ALREADY_RECORDED" });
      }
      const prerequisites = {
        BREAK_OUT: record.check_in,
        BREAK_IN: record.break_out,
        CHECK_OUT: record.check_in,
      };
      if (action !== "CHECK_IN" && !prerequisites[action]) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "L’étape précédente n’est pas pointée.", code: "ATTENDANCE_SEQUENCE_INVALID" });
      }
      const late = action === "CHECK_IN"
        ? Math.max(0, Math.floor((Number(String(employee.local_time).slice(0,2))*60 + Number(String(employee.local_time).slice(3,5))) -
          (Number(String(day.start_time).slice(0,2))*60 + Number(String(day.start_time).slice(3,5))))) : Number(record.late_minutes || 0);
      const status = action === "CHECK_IN" ? (late > 0 ? "LATE" : "PRESENT")
        : action === "BREAK_OUT" ? "ON_BREAK" : action === "BREAK_IN" ? "PRESENT" : "COMPLETED";
      const { rows: updated } = await client.query(
        `UPDATE attendance_day_records_v2 SET ${column}=now(), status=$1, late_minutes=$2,
          worked_minutes=CASE WHEN $3='CHECK_OUT' THEN GREATEST(0,extract(epoch FROM (now()-check_in))/60)::int ELSE worked_minutes END,
          punched_by=$4, updated_at=CURRENT_TIMESTAMP WHERE id=$5 RETURNING *`,
        [status, late, action, req.user.id, record.id]
      );
      await client.query(
        `INSERT INTO attendance_event_log_v2(company_id,employee_id,record_id,action_type,event_at,performed_by,performed_by_name)
         VALUES($1,$2,$3,$4,now(),$5,$6)`,
        [companyId, employee.id, record.id, action, req.user.id, req.user.fullname || req.user.email || ""]
      );
      await client.query("COMMIT");
      res.json({ success: true, attendance: updated[0], employee: { id: employee.id, full_name: employee.full_name } });
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
      await client.query(`DELETE FROM attendance_payroll_items_v2 WHERE payroll_run_id=$1`,[run.id]);
      for(const line of lines) await client.query(
        `INSERT INTO attendance_payroll_items_v2(company_id,payroll_run_id,employee_id,employee_name,
          monthly_salary,daily_rate,expected_days,attended_days,absence_days,late_minutes,
          absence_deduction,adjustments,net_salary,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [companyId,run.id,line.id,line.full_name,line.monthly_salary,line.daily_rate,line.expected_days,
         line.attended_days,line.absence_days,line.late_minutes,line.absence_deduction,line.adjustments,line.net_salary,line.status]
      );
      const totals=(await client.query(
        `UPDATE attendance_payroll_runs_v2 r SET
          gross_amount=x.gross,deductions_amount=x.deductions,adjustments_amount=x.adjustments,
          net_amount=x.net,updated_at=now()
         FROM (SELECT payroll_run_id,COALESCE(sum(monthly_salary),0) gross,
           COALESCE(sum(absence_deduction),0) deductions,COALESCE(sum(adjustments),0) adjustments,
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
      await client.query("COMMIT"); res.json({item,run});
    } catch(error){await client.query("ROLLBACK").catch(()=>{});fail(res,error,"Erreur paiement du salaire.");}
    finally{client.release();}
  });

  return router;
};
