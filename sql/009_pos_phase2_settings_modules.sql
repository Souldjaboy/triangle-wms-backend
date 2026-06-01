-- Triangle WMS Pro - POS phase 2 settings, modules and product metadata
-- Safe additive migration: no DROP TABLE, no data deletion.

ALTER TABLE products ADD COLUMN IF NOT EXISTS wholesale_price NUMERIC(14,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS pharmacy_price NUMERIC(14,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS max_discount_rate NUMERIC(6,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS manufacture_date DATE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory VARCHAR(255) DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS blocked_for_sale BOOLEAN DEFAULT false;

CREATE TABLE IF NOT EXISTS pos_settings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER UNIQUE,
  pos_enabled BOOLEAN DEFAULT true,
  default_tax_rate NUMERIC(6,2) DEFAULT 18,
  currency VARCHAR(20) DEFAULT 'FCFA',
  receipt_format VARCHAR(50) DEFAULT '80mm',
  printer_name VARCHAR(255) DEFAULT '',
  allowed_payment_methods TEXT DEFAULT 'Espèces,Carte bancaire,Orange Money,Moov Money,Wave,Virement,Paiement mixte,Crédit client',
  max_discount_rate NUMERIC(6,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS company_modules (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  module_key VARCHAR(100) NOT NULL,
  is_enabled BOOLEAN DEFAULT true,
  updated_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, module_key)
);

CREATE TABLE IF NOT EXISTS user_modules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  module_key VARCHAR(100) NOT NULL,
  is_enabled BOOLEAN DEFAULT true,
  updated_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, module_key)
);

CREATE INDEX IF NOT EXISTS idx_pos_settings_company_id ON pos_settings(company_id);
CREATE INDEX IF NOT EXISTS idx_company_modules_company_id ON company_modules(company_id);
CREATE INDEX IF NOT EXISTS idx_user_modules_user_id ON user_modules(user_id);
CREATE INDEX IF NOT EXISTS idx_products_blocked_for_sale ON products(blocked_for_sale);

UPDATE products
SET qr_code = reference
WHERE (qr_code IS NULL OR qr_code = '') AND reference IS NOT NULL;

UPDATE pos_settings
SET default_tax_rate = 18
WHERE default_tax_rate IS NULL;
