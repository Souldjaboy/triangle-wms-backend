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

async function canManagePayroll(client, companyId, user, action = "prepare") {
  if (user?.is_super_admin === true) return true;
  const role = String(user?.role || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (role === "super_admin" || role === "comptable") return true;
  const column = action === "pay" ? "can_pay" : "can_prepare";
  const { rows } = await client.query(
    `SELECT 1 FROM attendance_payroll_authorizations
      WHERE company_id=$1 AND user_id=$2 AND ${column}=true LIMIT 1`,
    [companyId,user?.id]
  );
  return Boolean(rows[0]);
}

module.exports = { calculatePayrollLine, assertPaymentMethod, canManagePayroll };
