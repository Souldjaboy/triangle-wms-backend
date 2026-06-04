-- Triangle WMS Pro - Stabilisation comptabilite lot 2
-- Migration additive uniquement. Ne supprime aucune donnee.

ALTER TABLE cash_vouchers ADD COLUMN IF NOT EXISTS rejection_reason TEXT DEFAULT '';

ALTER TABLE accounting_banks ADD COLUMN IF NOT EXISTS updated_by INTEGER;
ALTER TABLE accounting_transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE cash_vouchers ADD COLUMN IF NOT EXISTS updated_by INTEGER;
ALTER TABLE expense_requests ADD COLUMN IF NOT EXISTS updated_by INTEGER;

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  action TEXT DEFAULT '',
  entity_type TEXT DEFAULT '',
  entity_id TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_email TEXT DEFAULT '';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_role TEXT DEFAULT '';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address TEXT DEFAULT '';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT DEFAULT '';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}'::jsonb;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS created_by INTEGER;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS warehouse_id INTEGER;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS old_values JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS new_values JSONB;

CREATE TABLE IF NOT EXISTS ai_module_knowledge (
  id SERIAL PRIMARY KEY,
  module_key TEXT UNIQUE NOT NULL,
  module_name TEXT NOT NULL,
  description TEXT DEFAULT '',
  role_explanation TEXT DEFAULT '',
  available_actions JSONB DEFAULT '[]'::jsonb,
  pages JSONB DEFAULT '[]'::jsonb,
  permissions JSONB DEFAULT '{}'::jsonb,
  data_sources JSONB DEFAULT '[]'::jsonb,
  examples JSONB DEFAULT '[]'::jsonb,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE ai_module_knowledge ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_accounting_banks_company_active
  ON accounting_banks(company_id, is_active);

CREATE INDEX IF NOT EXISTS idx_accounting_transactions_company_created
  ON accounting_transactions(company_id, created_at);

CREATE INDEX IF NOT EXISTS idx_cash_vouchers_company_status
  ON cash_vouchers(company_id, status);

CREATE INDEX IF NOT EXISTS idx_expense_requests_company_created
  ON expense_requests(company_id, created_at);

CREATE INDEX IF NOT EXISTS idx_treasury_accounts_company
  ON treasury_accounts(company_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_company_created
  ON audit_logs(company_id, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id
  ON audit_logs(user_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action
  ON audit_logs(action);
