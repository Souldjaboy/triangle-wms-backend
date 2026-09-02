BEGIN;

ALTER TABLE attendance_employees
  ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';

ALTER TABLE attendance_salary_settings_v2
  ADD COLUMN IF NOT EXISTS monthly_salary NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS basis_days INTEGER NOT NULL DEFAULT 30;

DO $$ BEGIN
  ALTER TABLE attendance_salary_settings_v2
    ADD CONSTRAINT attendance_salary_monthly_nonnegative
    CHECK (monthly_salary IS NULL OR monthly_salary >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE attendance_salary_settings_v2
    ADD CONSTRAINT attendance_salary_basis_days_positive
    CHECK (basis_days > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS attendance_payroll_authorizations (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_prepare BOOLEAN NOT NULL DEFAULT TRUE,
  can_pay BOOLEAN NOT NULL DEFAULT TRUE,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id,user_id)
);

CREATE TABLE IF NOT EXISTS attendance_payroll_runs_v2 (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_month DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PARTIALLY_PAID','PAID','CANCELLED')),
  gross_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  deductions_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  adjustments_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  prepared_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id,period_month),
  CHECK (date_trunc('month',period_month)::date = period_month)
);

CREATE TABLE IF NOT EXISTS attendance_payroll_items_v2 (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id INTEGER NOT NULL REFERENCES attendance_payroll_runs_v2(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES attendance_employees(id) ON DELETE RESTRICT,
  employee_name TEXT NOT NULL,
  monthly_salary NUMERIC(14,2),
  daily_rate NUMERIC(14,2),
  expected_days INTEGER NOT NULL DEFAULT 0,
  attended_days INTEGER NOT NULL DEFAULT 0,
  absence_days INTEGER NOT NULL DEFAULT 0,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  absence_deduction NUMERIC(14,2) NOT NULL DEFAULT 0,
  adjustments NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_salary NUMERIC(14,2),
  status TEXT NOT NULL DEFAULT 'TO_PAY'
    CHECK (status IN ('TO_PAY','PAID','BLOCKED','CANCELLED')),
  payment_method TEXT CHECK (payment_method IS NULL OR payment_method IN
    ('CASH','BANK','CASHBOX','TRANSFER','CHECK','MOBILE_MONEY')),
  payment_reference TEXT NOT NULL DEFAULT '',
  bank_id INTEGER,
  caisse_id INTEGER,
  paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  paid_at TIMESTAMPTZ,
  accounting_transaction_id INTEGER REFERENCES accounting_transactions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id,employee_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_payroll_runs_company_month
  ON attendance_payroll_runs_v2(company_id,period_month);
CREATE INDEX IF NOT EXISTS idx_attendance_payroll_items_run
  ON attendance_payroll_items_v2(payroll_run_id,status);

COMMIT;
