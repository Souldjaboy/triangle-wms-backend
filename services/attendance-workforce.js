"use strict";

const ACTION_COLUMNS = Object.freeze({
  CHECK_IN: "check_in",
  BREAK_OUT: "break_out",
  BREAK_IN: "break_in",
  CHECK_OUT: "check_out",
});

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s-]+/g, "_");
}

function isSuperAdmin(user) {
  return user?.is_super_admin === true || normalizeRole(user?.role) === "super_admin";
}

function roleCanViewSalary(user) {
  return isSuperAdmin(user) || normalizeRole(user?.role) === "comptable";
}

function assertAction(action) {
  const normalized = String(action || "").trim().toUpperCase();
  if (!ACTION_COLUMNS[normalized]) {
    const error = new Error("Action de pointage invalide.");
    error.httpStatus = 400;
    error.code = "ATTENDANCE_ACTION_INVALID";
    throw error;
  }
  return normalized;
}

function minutesLate(eventDate, workDate, startTime, timezone = "Africa/Bamako") {
  if (!eventDate || !startTime) return 0;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(eventDate))
    .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  if (localDate !== workDate) return 0;
  const [hour, minute] = String(startTime).split(":").map(Number);
  return Math.max(0, Number(parts.hour) * 60 + Number(parts.minute) - (hour * 60 + minute));
}

async function canViewAllSalaries(client, companyId, user) {
  if (roleCanViewSalary(user)) return true;
  const { rows } = await client.query(
    `SELECT 1 FROM attendance_salary_viewers WHERE company_id=$1 AND user_id=$2 LIMIT 1`,
    [companyId, user?.id]
  );
  return Boolean(rows[0]);
}

async function operatorSiteIds(client, companyId, user) {
  if (isSuperAdmin(user)) return null;
  const { rows } = await client.query(
    `SELECT site_id FROM attendance_operator_scopes
      WHERE company_id=$1 AND operator_user_id=$2 AND can_punch=true`,
    [companyId, user?.id]
  );
  return rows.map((row) => Number(row.site_id));
}

async function canPunchEmployee(client, companyId, user, employee) {
  if (isSuperAdmin(user)) return true;
  if (Number(employee.user_id) === Number(user?.id)) return true;
  const sites = await operatorSiteIds(client, companyId, user);
  return sites.includes(Number(employee.site_id));
}

function stripSalary(employee, allowed) {
  if (allowed) return employee;
  const clean = { ...employee };
  delete clean.daily_rate;
  delete clean.monthly_salary;
  delete clean.salary_earned;
  delete clean.salary_adjustments;
  delete clean.salary_payable;
  return clean;
}


/* ═══════════════════════════════════════════════════════════════════════
   ENREGISTRER UN POINTAGE — un seul moteur pour le manuel et pour le QR.

   Les deux modes restent deux écrans, deux routes et deux droits distincts,
   parce qu'ils ne s'utilisent pas dans les mêmes conditions. Mais ce qu'ils
   font une fois l'employé identifié est exactement la même chose : ordre des
   étapes, calcul du retard, statut du jour, journal. Le dupliquer, c'était
   se condamner à corriger deux fois chaque règle métier — et à ne le faire
   qu'une fois le jour où l'on oublierait.

   Ne décide RIEN sur les droits : l'appelant a déjà répondu à « cette
   personne peut-elle pointer cet employé ? ». Ici on ne fait qu'écrire.
   ═══════════════════════════════════════════════════════════════════════ */

function erreur(message, code, httpStatus) {
  const e = new Error(message);
  e.code = code;
  e.httpStatus = httpStatus;
  return e;
}

/** L'employé, avec la date et l'heure LOCALES de sa société. */
async function chargerEmployePourPointage(client, companyId, employeeId) {
  const { rows } = await client.query(
    `SELECT e.*, c.official_start_at, c.timezone,
            (timezone(c.timezone, now()))::date AS local_date,
            (timezone(c.timezone, now()))::time AS local_time
       FROM attendance_employees e
       JOIN attendance_company_configuration c ON c.company_id = e.company_id
      WHERE e.id = $1 AND e.company_id = $2 AND e.active = true
      FOR UPDATE OF e`,
    [employeeId, companyId]
  );
  return rows[0] || null;
}

/** Le jour de travail théorique de cet employé, aujourd'hui. */
async function chargerJourTravaille(client, scheduleId, localDate) {
  const { rows } = await client.query(
    `SELECT * FROM attendance_schedule_days
      WHERE schedule_id = $1 AND iso_weekday = extract(isodow FROM $2::date)`,
    [scheduleId, localDate]
  );
  return rows[0] || null;
}

/* Minutes entre deux heures « HH:MM », sans jamais passer par un décimal.
   20 h 15 vaut 1215 minutes, pas 20,25 « heures ». */
const enMinutes = (heure) => {
  const t = String(heure || "00:00");
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
};

/**
 * @param {object} p
 * @param {string} p.source 'QR' | 'MANUEL' | 'IMPORT' | 'CORRECTION_ADMINISTRATIVE'
 * @returns {{record:object, action:string, late:number, employee:object}}
 */
async function enregistrerPointage(client, { companyId, employee, day, action, user, source }) {
  const acte = assertAction(action);

  if (new Date() < new Date(employee.official_start_at)) {
    throw erreur("Le nouveau pointage n’est pas encore ouvert.", "ATTENDANCE_NOT_STARTED", 409);
  }
  if (!day?.is_working_day) {
    throw erreur("Jour non travaillé pour cet employé.", "NON_WORKING_DAY", 409);
  }

  const { rows: records } = await client.query(
    `INSERT INTO attendance_day_records_v2 (company_id, employee_id, work_date, status, punched_by)
     VALUES ($1,$2,$3,'ABSENT',$4)
     ON CONFLICT (company_id, employee_id, work_date)
     DO UPDATE SET updated_at = attendance_day_records_v2.updated_at
     RETURNING *`,
    [companyId, employee.id, employee.local_date, user?.id || null]
  );
  const record = records[0];
  const colonne = ACTION_COLUMNS[acte];

  if (record[colonne]) {
    const e = erreur("Ce pointage est déjà enregistré.", "ATTENDANCE_ALREADY_RECORDED", 409);
    e.dejaEnregistre = { record, action: acte };
    throw e;
  }

  const prealables = { BREAK_OUT: record.check_in, BREAK_IN: record.break_out, CHECK_OUT: record.check_in };
  if (acte !== "CHECK_IN" && !prealables[acte]) {
    throw erreur("L’étape précédente n’est pas pointée.", "ATTENDANCE_SEQUENCE_INVALID", 409);
  }

  /* Le retard commence à la première minute après l'heure prévue : 08h00
     donne 0, 08h10 donne 10. Calculé en minutes entières côté serveur, sur
     l'heure locale de la société — jamais celle du téléphone. */
  const late = acte === "CHECK_IN"
    ? Math.max(0, enMinutes(employee.local_time) - enMinutes(day.start_time))
    : Number(record.late_minutes || 0);

  const statut = acte === "CHECK_IN" ? (late > 0 ? "LATE" : "PRESENT")
    : acte === "BREAK_OUT" ? "ON_BREAK"
    : acte === "BREAK_IN" ? "PRESENT" : "COMPLETED";

  const { rows: misAJour } = await client.query(
    `UPDATE attendance_day_records_v2
        SET ${colonne} = now(), status = $1, late_minutes = $2,
            worked_minutes = CASE WHEN $3 = 'CHECK_OUT'
              THEN GREATEST(0, extract(epoch FROM (now() - check_in)) / 60)::int
              ELSE worked_minutes END,
            punched_by = $4, updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *`,
    [statut, late, acte, user?.id || null, record.id]
  );

  await client.query(
    `INSERT INTO attendance_event_log_v2
       (company_id, employee_id, record_id, action_type, event_at, performed_by, performed_by_name, source)
     VALUES ($1,$2,$3,$4,now(),$5,$6,$7)`,
    [companyId, employee.id, record.id, acte, user?.id || null,
     user?.fullname || user?.email || "", String(source || "MANUEL")]
  );

  return { record: misAJour[0], action: acte, late, employee };
}

/** L'étape suivante, déduite de ce qui est déjà pointé. */
function prochaineEtape(record) {
  if (!record) return "CHECK_IN";
  if (!record.check_in) return "CHECK_IN";
  if (!record.break_out) return "BREAK_OUT";
  if (!record.break_in) return "BREAK_IN";
  if (!record.check_out) return "CHECK_OUT";
  return null;
}

module.exports = {
  ACTION_COLUMNS,
  erreur,
  chargerEmployePourPointage,
  chargerJourTravaille,
  enregistrerPointage,
  prochaineEtape,
  normalizeRole,
  isSuperAdmin,
  roleCanViewSalary,
  assertAction,
  minutesLate,
  canViewAllSalaries,
  operatorSiteIds,
  canPunchEmployee,
  stripSalary,
};
