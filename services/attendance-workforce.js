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

module.exports = {
  ACTION_COLUMNS,
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
