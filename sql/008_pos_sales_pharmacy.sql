-- Triangle WMS Pro - POS / Caisse / pharmacie
-- Safe additive migration: no DROP TABLE, no data deletion.

ALTER TABLE products ADD COLUMN IF NOT EXISTS qr_code TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(14,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_price NUMERIC(14,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS margin NUMERIC(14,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS expiration_tracking_enabled BOOLEAN DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS batch_tracking_enabled BOOLEAN DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(6,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS lot_number TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS expiration_date DATE;

CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(100) DEFAULT '',
  email VARCHAR(255) DEFAULT '',
  address TEXT DEFAULT '',
  status VARCHAR(80) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_batches (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  lot_number VARCHAR(255) NOT NULL,
  product_id INTEGER,
  supplier_id INTEGER,
  quantity_initial INTEGER DEFAULT 0,
  quantity_remaining INTEGER DEFAULT 0,
  purchase_price NUMERIC(14,2) DEFAULT 0,
  sale_price NUMERIC(14,2) DEFAULT 0,
  expiration_date DATE,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  warehouse_id INTEGER,
  location_id INTEGER,
  status VARCHAR(80) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cash_registers (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  warehouse_id INTEGER,
  name VARCHAR(255) DEFAULT 'Caisse principale',
  status VARCHAR(80) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cash_sessions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  cash_register_id INTEGER,
  opened_by INTEGER,
  closed_by INTEGER,
  opening_amount NUMERIC(14,2) DEFAULT 0,
  closing_amount NUMERIC(14,2) DEFAULT 0,
  status VARCHAR(80) DEFAULT 'open',
  opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  warehouse_id INTEGER,
  cash_register_id INTEGER,
  cash_session_id INTEGER,
  sale_number VARCHAR(255) UNIQUE NOT NULL,
  customer_name VARCHAR(255) DEFAULT '',
  customer_phone VARCHAR(100) DEFAULT '',
  subtotal NUMERIC(14,2) DEFAULT 0,
  discount_amount NUMERIC(14,2) DEFAULT 0,
  tax_amount NUMERIC(14,2) DEFAULT 0,
  total_amount NUMERIC(14,2) DEFAULT 0,
  payment_method VARCHAR(100) DEFAULT 'Espèces',
  payment_status VARCHAR(80) DEFAULT 'payé',
  status VARCHAR(80) DEFAULT 'validée',
  created_by INTEGER,
  created_by_name VARCHAR(255) DEFAULT '',
  created_by_role VARCHAR(100) DEFAULT '',
  cancelled_by INTEGER,
  cancelled_at TIMESTAMP,
  cancel_reason TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
  company_id INTEGER,
  product_id INTEGER,
  product_reference VARCHAR(255) DEFAULT '',
  product_name VARCHAR(255) DEFAULT '',
  barcode VARCHAR(255) DEFAULT '',
  lot_number VARCHAR(255) DEFAULT '',
  batch_id INTEGER,
  quantity INTEGER DEFAULT 1,
  unit_price NUMERIC(14,2) DEFAULT 0,
  discount_amount NUMERIC(14,2) DEFAULT 0,
  tax_rate NUMERIC(6,2) DEFAULT 0,
  total_price NUMERIC(14,2) DEFAULT 0,
  warehouse_id INTEGER,
  location_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS receipts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  sale_id INTEGER,
  receipt_number VARCHAR(255) UNIQUE NOT NULL,
  receipt_data JSONB,
  total_amount NUMERIC(14,2) DEFAULT 0,
  payment_method VARCHAR(100) DEFAULT '',
  payment_status VARCHAR(80) DEFAULT '',
  status VARCHAR(80) DEFAULT 'active',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS sale_id INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_id INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_status VARCHAR(80) DEFAULT 'payé';

CREATE TABLE IF NOT EXISTS product_price_history (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  product_id INTEGER,
  old_purchase_price NUMERIC(14,2) DEFAULT 0,
  new_purchase_price NUMERIC(14,2) DEFAULT 0,
  old_sale_price NUMERIC(14,2) DEFAULT 0,
  new_sale_price NUMERIC(14,2) DEFAULT 0,
  changed_by INTEGER,
  reason TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS returns (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  sale_id INTEGER,
  return_number VARCHAR(255) UNIQUE NOT NULL,
  reason TEXT DEFAULT '',
  status VARCHAR(80) DEFAULT 'validé',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS return_items (
  id SERIAL PRIMARY KEY,
  return_id INTEGER REFERENCES returns(id) ON DELETE CASCADE,
  sale_item_id INTEGER,
  product_id INTEGER,
  quantity INTEGER DEFAULT 1,
  amount NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_product_batches_product_id ON product_batches(product_id);
CREATE INDEX IF NOT EXISTS idx_product_batches_expiration ON product_batches(expiration_date);
CREATE INDEX IF NOT EXISTS idx_sales_company_id ON sales(company_id);
CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_receipts_sale_id ON receipts(sale_id);
CREATE INDEX IF NOT EXISTS idx_payments_sale_id ON payments(sale_id);

UPDATE subscription_plans
SET modules = 'Produits, stocks simples, emplacements, rapports simples'
WHERE name IN ('Essentiel', 'Classique');

UPDATE subscription_plans
SET modules = 'Tout Essentiel, pointage, QR codes, mouvements, inventaires, notifications'
WHERE name = 'Standard';

UPDATE subscription_plans
SET modules = 'Tout Standard, POS / Caisse, lots et expiration, rapports avancés, IA, documents avancés, multi-entrepôts avancé'
WHERE name = 'Premium';
