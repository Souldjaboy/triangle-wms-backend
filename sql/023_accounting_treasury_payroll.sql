-- Triangle WMS Pro - Comptabilite, tresorerie, banques, decaissements, paie
-- Migration additive uniquement. Ne supprime aucune donnee.

CREATE TABLE IF NOT EXISTS accounting_banks (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  bank_name TEXT NOT NULL,
  account_number TEXT DEFAULT '',
  iban TEXT DEFAULT '',
  swift TEXT DEFAULT '',
  currency TEXT DEFAULT 'FCFA',
  initial_balance NUMERIC(14,2) DEFAULT 0,
  current_balance NUMERIC(14,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS treasury_accounts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER UNIQUE,
  currency TEXT DEFAULT 'FCFA',
  initial_balance NUMERIC(14,2) DEFAULT 0,
  current_balance NUMERIC(14,2) DEFAULT 0,
  updated_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounting_transactions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  transaction_number TEXT UNIQUE,
  transaction_type TEXT NOT NULL,
  source_type TEXT DEFAULT '',
  source_id INTEGER,
  bank_id INTEGER,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'FCFA',
  direction TEXT DEFAULT '',
  category TEXT DEFAULT '',
  partner_id INTEGER,
  partner_name TEXT DEFAULT '',
  description TEXT DEFAULT '',
  attachment_url TEXT DEFAULT '',
  status TEXT DEFAULT 'validé',
  created_by INTEGER,
  validated_by INTEGER,
  validated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cash_vouchers (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  voucher_number TEXT UNIQUE,
  voucher_type TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'FCFA',
  origin TEXT DEFAULT '',
  beneficiary TEXT DEFAULT '',
  bank_id INTEGER,
  partner_id INTEGER,
  partner_name TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  expense_category TEXT DEFAULT '',
  attachment_url TEXT DEFAULT '',
  status TEXT DEFAULT 'brouillon',
  created_by INTEGER,
  validated_by INTEGER,
  validated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS expense_requests (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  request_number TEXT UNIQUE,
  requested_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'FCFA',
  reason TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  urgency TEXT DEFAULT 'normale',
  attachment_url TEXT DEFAULT '',
  proof_url TEXT DEFAULT '',
  status TEXT DEFAULT 'brouillon',
  created_by INTEGER,
  created_by_name TEXT DEFAULT '',
  approved_by INTEGER,
  approved_at TIMESTAMP,
  paid_by INTEGER,
  paid_at TIMESTAMP,
  closed_by INTEGER,
  closed_at TIMESTAMP,
  rejection_reason TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  payroll_number TEXT UNIQUE,
  period_start DATE,
  period_end DATE,
  gross_amount NUMERIC(14,2) DEFAULT 0,
  deductions_amount NUMERIC(14,2) DEFAULT 0,
  advances_amount NUMERIC(14,2) DEFAULT 0,
  net_amount NUMERIC(14,2) DEFAULT 0,
  status TEXT DEFAULT 'brouillon',
  payment_method TEXT DEFAULT '',
  bank_id INTEGER,
  paid_by INTEGER,
  paid_at TIMESTAMP,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payroll_items (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  payroll_run_id INTEGER,
  user_id INTEGER,
  employee_name TEXT DEFAULT '',
  worked_hours NUMERIC(12,2) DEFAULT 0,
  absences INTEGER DEFAULT 0,
  late_minutes INTEGER DEFAULT 0,
  overtime_minutes INTEGER DEFAULT 0,
  gross_salary NUMERIC(14,2) DEFAULT 0,
  deductions NUMERIC(14,2) DEFAULT 0,
  advances NUMERIC(14,2) DEFAULT 0,
  net_salary NUMERIC(14,2) DEFAULT 0,
  status TEXT DEFAULT 'à payer',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounting_entries (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  entry_number TEXT UNIQUE,
  entry_date DATE DEFAULT CURRENT_DATE,
  source_type TEXT DEFAULT '',
  source_id INTEGER,
  account_label TEXT NOT NULL DEFAULT '',
  debit NUMERIC(14,2) DEFAULT 0,
  credit NUMERIC(14,2) DEFAULT 0,
  description TEXT DEFAULT '',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_accounting_banks_company ON accounting_banks(company_id);
CREATE INDEX IF NOT EXISTS idx_accounting_transactions_company ON accounting_transactions(company_id);
CREATE INDEX IF NOT EXISTS idx_accounting_transactions_type ON accounting_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_cash_vouchers_company ON cash_vouchers(company_id);
CREATE INDEX IF NOT EXISTS idx_cash_vouchers_status ON cash_vouchers(status);
CREATE INDEX IF NOT EXISTS idx_expense_requests_company ON expense_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_expense_requests_status ON expense_requests(status);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_company ON payroll_runs(company_id);
CREATE INDEX IF NOT EXISTS idx_accounting_entries_company ON accounting_entries(company_id);
