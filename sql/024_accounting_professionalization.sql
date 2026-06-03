-- Triangle WMS Pro - Professionnalisation comptabilite et tresorerie
-- Migration additive uniquement. Ne supprime aucune donnee.

CREATE TABLE IF NOT EXISTS accounting_chart_accounts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  account_code VARCHAR(40) NOT NULL,
  account_name TEXT NOT NULL,
  account_class TEXT DEFAULT '',
  account_type TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT true,
  is_system BOOLEAN DEFAULT false,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, account_code)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  entry_number TEXT UNIQUE,
  entry_date DATE DEFAULT CURRENT_DATE,
  label TEXT NOT NULL DEFAULT '',
  module_source TEXT DEFAULT '',
  source_id INTEGER,
  status TEXT DEFAULT 'validé',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id SERIAL PRIMARY KEY,
  entry_id INTEGER REFERENCES journal_entries(id) ON DELETE CASCADE,
  company_id INTEGER,
  account_code VARCHAR(40) NOT NULL,
  account_name TEXT NOT NULL DEFAULT '',
  debit NUMERIC(14,2) DEFAULT 0,
  credit NUMERIC(14,2) DEFAULT 0,
  partner_id INTEGER,
  bank_id INTEGER,
  caisse_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE accounting_transactions ADD COLUMN IF NOT EXISTS caisse_id INTEGER;
ALTER TABLE accounting_transactions ADD COLUMN IF NOT EXISTS source_label TEXT DEFAULT '';
ALTER TABLE accounting_transactions ADD COLUMN IF NOT EXISTS destination_label TEXT DEFAULT '';

ALTER TABLE cash_vouchers ADD COLUMN IF NOT EXISTS caisse_id INTEGER;
ALTER TABLE cash_vouchers ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
ALTER TABLE cash_vouchers ADD COLUMN IF NOT EXISTS printable BOOLEAN DEFAULT false;

ALTER TABLE expense_requests ADD COLUMN IF NOT EXISTS payment_transaction_id INTEGER;
ALTER TABLE expense_requests ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT '';
ALTER TABLE expense_requests ADD COLUMN IF NOT EXISTS can_print BOOLEAN DEFAULT false;

ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT '';
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS bank_id INTEGER;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS caisse_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_chart_accounts_company ON accounting_chart_accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_company ON journal_entries(company_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_source ON journal_entries(module_source, source_id);
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_entry ON journal_entry_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_company ON journal_entry_lines(company_id);
CREATE INDEX IF NOT EXISTS idx_accounting_transactions_caisse ON accounting_transactions(caisse_id);

INSERT INTO accounting_chart_accounts
  (company_id, account_code, account_name, account_class, account_type, is_system)
SELECT c.id, seed.account_code, seed.account_name, seed.account_class, seed.account_type, true
FROM companies c
CROSS JOIN (
  VALUES
    ('52', 'Banque', 'Trésorerie', 'actif'),
    ('57', 'Caisse', 'Trésorerie', 'actif'),
    ('58', 'Virements internes', 'Trésorerie', 'actif'),
    ('40', 'Fournisseurs', 'Tiers', 'passif'),
    ('41', 'Clients', 'Tiers', 'actif'),
    ('42', 'Personnel', 'Tiers', 'passif'),
    ('60', 'Achats', 'Charges', 'charge'),
    ('61', 'Services extérieurs', 'Charges', 'charge'),
    ('62', 'Autres services', 'Charges', 'charge'),
    ('63', 'Impôts et taxes', 'Charges', 'charge'),
    ('64', 'Charges de personnel', 'Charges', 'charge'),
    ('65', 'Autres charges', 'Charges', 'charge'),
    ('70', 'Ventes', 'Produits', 'produit'),
    ('75', 'Autres produits', 'Produits', 'produit')
) AS seed(account_code, account_name, account_class, account_type)
ON CONFLICT (company_id, account_code) DO NOTHING;
