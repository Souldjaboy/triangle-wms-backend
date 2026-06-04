-- Triangle WMS Pro - Triangle Marketplace B2B/B2C
-- Migration additive uniquement. Ne supprime aucune donnee.

CREATE TABLE IF NOT EXISTS marketplace_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  company_id INTEGER,
  profile_type VARCHAR(40) DEFAULT 'customer',
  full_name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  status VARCHAR(40) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS marketplace_vendor_settings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER UNIQUE,
  store_name TEXT DEFAULT '',
  store_description TEXT DEFAULT '',
  logo_url TEXT DEFAULT '',
  contact_email TEXT DEFAULT '',
  contact_phone TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS marketplace_delivery_settings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  delivery_method VARCHAR(80) DEFAULT 'standard',
  delivery_fee NUMERIC(14,2) DEFAULT 0,
  delivery_zone TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS marketplace_products (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  product_id INTEGER,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT DEFAULT '',
  price NUMERIC(14,2) DEFAULT 0,
  image_url TEXT DEFAULT '',
  status VARCHAR(40) DEFAULT 'published',
  available_stock NUMERIC(14,2) DEFAULT 0,
  is_b2b BOOLEAN DEFAULT true,
  is_b2c BOOLEAN DEFAULT true,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS marketplace_carts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  company_id INTEGER,
  customer_email TEXT DEFAULT '',
  status VARCHAR(40) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS marketplace_cart_items (
  id SERIAL PRIMARY KEY,
  cart_id INTEGER,
  marketplace_product_id INTEGER,
  vendor_company_id INTEGER,
  product_id INTEGER,
  quantity NUMERIC(14,2) DEFAULT 1,
  unit_price NUMERIC(14,2) DEFAULT 0,
  total_price NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS marketplace_orders (
  id SERIAL PRIMARY KEY,
  order_number TEXT UNIQUE,
  customer_user_id INTEGER,
  buyer_company_id INTEGER,
  vendor_company_id INTEGER,
  customer_name TEXT DEFAULT '',
  customer_email TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  delivery_address TEXT DEFAULT '',
  order_type VARCHAR(20) DEFAULT 'b2c',
  status VARCHAR(40) DEFAULT 'pending_payment',
  payment_status VARCHAR(40) DEFAULT 'pending',
  payment_method VARCHAR(80) DEFAULT '',
  subtotal NUMERIC(14,2) DEFAULT 0,
  delivery_fee NUMERIC(14,2) DEFAULT 0,
  total_amount NUMERIC(14,2) DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS marketplace_order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER,
  marketplace_product_id INTEGER,
  vendor_company_id INTEGER,
  product_id INTEGER,
  product_reference TEXT DEFAULT '',
  product_name TEXT DEFAULT '',
  quantity NUMERIC(14,2) DEFAULT 1,
  unit_price NUMERIC(14,2) DEFAULT 0,
  total_price NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS marketplace_payments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER,
  company_id INTEGER,
  amount NUMERIC(14,2) DEFAULT 0,
  currency VARCHAR(20) DEFAULT 'FCFA',
  method VARCHAR(80) DEFAULT '',
  status VARCHAR(40) DEFAULT 'pending',
  provider_reference TEXT DEFAULT '',
  paid_at TIMESTAMP,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS marketplace_reviews (
  id SERIAL PRIMARY KEY,
  marketplace_product_id INTEGER,
  order_id INTEGER,
  user_id INTEGER,
  rating INTEGER DEFAULT 5,
  comment TEXT DEFAULT '',
  status VARCHAR(40) DEFAULT 'published',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS product_id INTEGER;
ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS status VARCHAR(40) DEFAULT 'published';
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS buyer_company_id INTEGER;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS vendor_company_id INTEGER;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(40) DEFAULT 'pending';
ALTER TABLE marketplace_payments ADD COLUMN IF NOT EXISTS provider_reference TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_marketplace_products_company ON marketplace_products(company_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_products_product ON marketplace_products(product_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_products_status ON marketplace_products(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_carts_user ON marketplace_carts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_marketplace_cart_items_cart ON marketplace_cart_items(cart_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_customer ON marketplace_orders(customer_user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_buyer_company ON marketplace_orders(buyer_company_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_vendor_company ON marketplace_orders(vendor_company_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_status ON marketplace_orders(status, payment_status);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_items_order ON marketplace_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_payments_order ON marketplace_payments(order_id);

INSERT INTO ai_module_knowledge (
  module_key, module_name, description, role_explanation,
  available_actions, pages, permissions, data_sources, examples, is_active
) SELECT
  'marketplace',
  'Triangle Marketplace',
  'Module B2B/B2C reliant catalogue, panier, commandes, paiements, documents, stock et comptabilite.',
  'Les clients voient leurs paniers et commandes. Les vendeurs voient leurs produits publies et commandes recues. Le super admin voit tout.',
  '["publier produit","ajouter panier","creer commande","confirmer paiement","suivre commandes","generer documents"]'::jsonb,
  '["/marketplace","/marketplace/cart","/client/orders","/vendor/products","/vendor/orders","/super-admin/marketplace"]'::jsonb,
  '{"super_admin":"tout","vendor":"produits et commandes vendeur","customer":"panier et commandes personnelles"}'::jsonb,
  '["marketplace_products","marketplace_orders","marketplace_payments","marketplace_order_items","products","documents","stock_movements"]'::jsonb,
  '["Combien de commandes marketplace aujourd hui ?","Quels produits sont publies ?","Quelle entreprise vend le plus ?"]'::jsonb,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM ai_module_knowledge WHERE module_key='marketplace'
);

UPDATE ai_module_knowledge SET
  module_name='Triangle Marketplace',
  description='Module B2B/B2C reliant catalogue, panier, commandes, paiements, documents, stock et comptabilite.',
  role_explanation='Les clients voient leurs paniers et commandes. Les vendeurs voient leurs produits publies et commandes recues. Le super admin voit tout.',
  available_actions='["publier produit","ajouter panier","creer commande","confirmer paiement","suivre commandes","generer documents"]'::jsonb,
  pages='["/marketplace","/marketplace/cart","/client/orders","/vendor/products","/vendor/orders","/super-admin/marketplace"]'::jsonb,
  permissions='{"super_admin":"tout","vendor":"produits et commandes vendeur","customer":"panier et commandes personnelles"}'::jsonb,
  data_sources='["marketplace_products","marketplace_orders","marketplace_payments","marketplace_order_items","products","documents","stock_movements"]'::jsonb,
  examples='["Combien de commandes marketplace aujourd hui ?","Quels produits sont publies ?","Quelle entreprise vend le plus ?"]'::jsonb,
  is_active=true,
  updated_at=CURRENT_TIMESTAMP
WHERE module_key='marketplace';
