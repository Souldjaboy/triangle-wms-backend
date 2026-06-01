-- Triangle WMS Pro - POS real payments foundation
-- Safe additive migration: no DROP TABLE, no data deletion.

CREATE TABLE IF NOT EXISTS payment_providers (
  id SERIAL PRIMARY KEY,
  provider_key VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(80) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_settings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  provider_key VARCHAR(100) NOT NULL,
  public_key TEXT DEFAULT '',
  secret_key_encrypted TEXT DEFAULT '',
  merchant_number VARCHAR(255) DEFAULT '',
  orange_money_account VARCHAR(255) DEFAULT '',
  moov_money_account VARCHAR(255) DEFAULT '',
  wave_account VARCHAR(255) DEFAULT '',
  currency VARCHAR(20) DEFAULT 'FCFA',
  mode VARCHAR(30) DEFAULT 'test',
  webhook_url TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT false,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, provider_key)
);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  sale_id INTEGER,
  provider_key VARCHAR(100) DEFAULT '',
  payment_method VARCHAR(100) DEFAULT '',
  amount NUMERIC(14,2) DEFAULT 0,
  currency VARCHAR(20) DEFAULT 'FCFA',
  status VARCHAR(80) DEFAULT 'en attente',
  provider_reference VARCHAR(255) DEFAULT '',
  external_reference VARCHAR(255) DEFAULT '',
  checkout_url TEXT DEFAULT '',
  request_payload JSONB,
  response_payload JSONB,
  error_message TEXT DEFAULT '',
  created_by INTEGER,
  paid_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sale_payments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  sale_id INTEGER,
  transaction_id INTEGER,
  payment_method VARCHAR(100) DEFAULT '',
  amount NUMERIC(14,2) DEFAULT 0,
  currency VARCHAR(20) DEFAULT 'FCFA',
  status VARCHAR(80) DEFAULT 'en attente',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS refunds (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  sale_id INTEGER,
  transaction_id INTEGER,
  amount NUMERIC(14,2) DEFAULT 0,
  reason TEXT DEFAULT '',
  status VARCHAR(80) DEFAULT 'en attente',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE sales ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(14,2) DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS amount_due NUMERIC(14,2) DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS change_due NUMERIC(14,2) DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(255) DEFAULT '';
ALTER TABLE sales ADD COLUMN IF NOT EXISTS provider VARCHAR(100) DEFAULT '';
ALTER TABLE sales ADD COLUMN IF NOT EXISTS transaction_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_payment_settings_company_provider ON payment_settings(company_id, provider_key);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_sale_id ON payment_transactions(sale_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_provider_reference ON payment_transactions(provider_reference);
CREATE INDEX IF NOT EXISTS idx_sale_payments_sale_id ON sale_payments(sale_id);
CREATE INDEX IF NOT EXISTS idx_refunds_sale_id ON refunds(sale_id);

INSERT INTO payment_providers (provider_key, name)
VALUES
  ('card', 'Carte bancaire'),
  ('orange_money', 'Orange Money'),
  ('moov_money', 'Moov Money'),
  ('wave', 'Wave'),
  ('bank_transfer', 'Virement'),
  ('check', 'Chèque'),
  ('cash', 'Espèces'),
  ('mixed', 'Paiement mixte'),
  ('customer_credit', 'Crédit client')
ON CONFLICT (provider_key) DO UPDATE SET
  name = EXCLUDED.name,
  updated_at = CURRENT_TIMESTAMP;
