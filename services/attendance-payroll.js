"use strict";

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function calculatePayrollLine(input) {
  const monthly = input.monthly_salary == null ? null : money(input.monthly_salary);
  const daily = input.daily_rate == null ? null : money(input.daily_rate);
  const absenceDays = Math.max(0, Number(input.absence_days || 0));
  const adjustments = money(input.adjustments);
  if (monthly == null || daily == null) {
    return { ...input, absence_deduction: 0, adjustments, net_salary: null, status: "BLOCKED" };
  }
  const absenceDeduction = money(absenceDays * daily);
  return {
    ...input,
    monthly_salary: monthly,
    daily_rate: daily,
    absence_deduction: absenceDeduction,
    adjustments,
    net_salary: Math.max(0, money(monthly - absenceDeduction + adjustments)),
    status: "TO_PAY",
  };
}


/**
 * LA PAIE D'UNE PÉRIODE RÉELLE, DU 25 AU 24.
 *
 * `calculatePayroll()` (routes/attendance-workforce.js) calcule sur un mois
 * CIVIL. L'écran, lui, annonce une période du 25 au 24 : les deux ne
 * couvraient pas les mêmes journées, et personne ne pouvait le voir sans
 * recompter à la main. Une présence du 25 août tombait hors de la paie de
 * septembre alors qu'elle en fait partie, et une présence du 25 septembre y
 * tombait alors qu'elle appartient à octobre.
 *
 * Cette fonction part des BORNES de la période, telles qu'elles sont
 * enregistrées, et de la valeur EFFECTIVE de chaque journée :
 *
 *   1. une absence marquée par-dessus une régularisation l'emporte ;
 *   2. sinon la régularisation ;
 *   3. sinon le pointage brut ;
 *   4. sinon rien — et c'est une absence si la journée était due.
 *
 * Un jour non dû — dimanche, samedi chômé selon le réglage, jour férié — ne
 * compte ni comme attendu ni comme absence.
 */
async function calculerPaiePeriode(client, companyId, periode) {
  const { rows } = await client.query(
    `WITH cfg AS (
       SELECT COALESCE(saturday_mode, 'NORMAL') AS samedi,
              COALESCE(timezone, 'Africa/Bamako') AS tz
         FROM attendance_company_configuration WHERE company_id = $1
     ),
     jours AS (
       SELECT d::date AS jour, extract(isodow FROM d)::int AS isodow
         FROM generate_series($2::date, $3::date, interval '1 day') d
     ),
     employes AS (
       SELECT e.id, e.employee_number, e.full_name, e.schedule_id
         FROM attendance_employees e
        WHERE e.company_id = $1 AND e.active
          AND e.effective_from <= $3::date
          AND (e.effective_to IS NULL OR e.effective_to >= $2::date)
     ),
     detail AS (
       SELECT e.id AS employee_id, e.employee_number, e.full_name, j.jour,
              /* La journée est-elle DUE ? */
              (d.id IS NOT NULL
               AND j.isodow <> 7
               AND ((SELECT samedi FROM cfg) = 'NORMAL' OR j.isodow <> 6)
               AND h.id IS NULL) AS due,
              /* La personne était-elle là, au sens de la valeur retenue ? */
              CASE
                WHEN NULLIF(g.overridden_status, '') IS NOT NULL
                  THEN g.overridden_status IN ('PRESENT','LATE','COMPLETED')
                WHEN r.check_in IS NOT NULL THEN true
                WHEN g.effective_check_in IS NOT NULL THEN true
                ELSE false
              END AS presente,
              COALESCE(r.late_minutes, 0) AS retard
         FROM employes e
         CROSS JOIN jours j
         LEFT JOIN attendance_schedule_days d
           ON d.schedule_id = e.schedule_id AND d.iso_weekday = j.isodow AND d.is_working_day
         LEFT JOIN attendance_holidays h
           ON h.company_id = $1 AND h.holiday_date = j.jour
         LEFT JOIN attendance_day_records_v2 r
           ON r.company_id = $1 AND r.employee_id = e.id AND r.work_date = j.jour
         LEFT JOIN attendance_regularizations g
           ON g.company_id = $1 AND g.employee_id = e.id AND g.work_date = j.jour
     ),
     totaux AS (
       SELECT employee_id, employee_number, full_name,
              count(*) FILTER (WHERE due)::int AS expected_days,
              count(*) FILTER (WHERE due AND presente)::int AS attended_days,
              count(*) FILTER (WHERE due AND NOT presente)::int AS absence_days,
              COALESCE(sum(retard) FILTER (WHERE presente), 0)::int AS late_minutes
         FROM detail
        GROUP BY employee_id, employee_number, full_name
     )
     SELECT t.employee_id AS id, t.employee_number, t.full_name,
            t.expected_days, t.attended_days, t.absence_days, t.late_minutes,
            s.monthly_salary, s.daily_rate,
            COALESCE((SELECT sum(a.amount) FROM attendance_salary_adjustments_v2 a
                       WHERE a.company_id = $1 AND a.employee_id = t.employee_id
                         AND a.work_date BETWEEN $2::date AND $3::date), 0) AS adjustments
       FROM totaux t
       LEFT JOIN LATERAL (
         SELECT monthly_salary, daily_rate
           FROM attendance_salary_settings_v2 v
          WHERE v.company_id = $1 AND v.employee_id = t.employee_id
            AND v.effective_from <= $3::date
          ORDER BY v.effective_from DESC LIMIT 1
       ) s ON true
      ORDER BY t.employee_number`,
    [companyId, periode.date_debut, periode.date_fin]
  );
  return rows.map(calculatePayrollLine);
}

function assertPaymentMethod(value) {
  const method = String(value || "").trim().toUpperCase();
  const allowed = new Set(["CASH","BANK","CASHBOX","TRANSFER","CHECK","MOBILE_MONEY"]);
  if (!allowed.has(method)) {
    const error = new Error("Mode de paiement invalide.");
    error.httpStatus = 400;
    error.code = "PAYROLL_PAYMENT_METHOD_INVALID";
    throw error;
  }
  return method;
}

/**
 * OBSOLÈTE — NE DÉCIDE PLUS D'UN PAIEMENT.
 *
 * Cette fonction accordait la paie à quiconque portait le rôle « comptable »,
 * avant même de regarder les permissions. Un administrateur pouvait donc poser
 * DENY sur `paie|pay`, voir le bouton disparaître de l'écran — et le comptable
 * payait quand même en appelant la route directement. Le refus n'existait
 * qu'à l'écran.
 *
 * Deux moteurs décidaient d'un même paiement, et le mauvais gagnait parce
 * qu'il répondait le premier. Les routes de paie passent désormais toutes par
 * `requirePermission("paie", …)` : un seul moteur, celui que l'écran des
 * droits pilote.
 *
 * Les autorisations de `attendance_payroll_authorizations` ont été reportées
 * en exceptions personnelles par la migration 089 — personne n'a rien perdu,
 * et ce qui était accordé se voit maintenant à l'écran des droits.
 *
 * La fonction reste, sans le repli par rôle, pour les appelants historiques
 * qui n'ont pas encore de garde de permission. Elle n'accorde plus rien
 * qu'une ligne d'autorisation explicite ne dise.
 */
async function canManagePayroll(client, companyId, user, action = "prepare") {
  if (user?.is_super_admin === true) return true;
  const role = String(user?.role || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (role === "super_admin") return true;
  const column = action === "pay" ? "can_pay" : "can_prepare";
  const { rows } = await client.query(
    `SELECT 1 FROM attendance_payroll_authorizations
      WHERE company_id=$1 AND user_id=$2 AND ${column}=true LIMIT 1`,
    [companyId,user?.id]
  );
  return Boolean(rows[0]);
}

module.exports = { calculatePayrollLine, calculerPaiePeriode, assertPaymentMethod, canManagePayroll };
