-- Triangle WMS Pro - Finalisation Marketplace B2B/B2C
-- Migration additive et compatible avec les anciennes colonnes.

ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS public_title TEXT DEFAULT '';
ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS public_description TEXT DEFAULT '';
ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS public_price NUMERIC(14,2) DEFAULT 0;
ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS published_quantity NUMERIC(14,2) DEFAULT 0;
ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS sold_quantity NUMERIC(14,2) DEFAULT 0;
ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS available_quantity NUMERIC(14,2) DEFAULT 0;
ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS images JSONB DEFAULT '[]'::jsonb;
ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT false;

UPDATE marketplace_products SET
  public_title=COALESCE(NULLIF(public_title,''), title, ''),
  public_description=COALESCE(NULLIF(public_description,''), description, ''),
  public_price=CASE WHEN COALESCE(public_price,0) > 0 THEN public_price ELSE COALESCE(price,0) END,
  published_quantity=CASE WHEN COALESCE(published_quantity,0) > 0 THEN published_quantity ELSE COALESCE(available_stock,0) END,
  available_quantity=CASE
    WHEN COALESCE(available_quantity,0) > 0 THEN available_quantity
    ELSE GREATEST(COALESCE(available_stock,0)-COALESCE(sold_quantity,0),0)
  END,
  is_published=CASE WHEN status='published' THEN true ELSE COALESCE(is_published,false) END
WHERE true;

ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS buyer_user_id INTEGER;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS seller_company_id INTEGER;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS order_type VARCHAR(20) DEFAULT 'B2C';
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS purchase_created BOOLEAN DEFAULT false;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS stock_entry_created BOOLEAN DEFAULT false;

UPDATE marketplace_orders SET
  buyer_user_id=COALESCE(buyer_user_id, customer_user_id),
  seller_company_id=COALESCE(seller_company_id, vendor_company_id),
  order_type=UPPER(COALESCE(NULLIF(order_type,''), CASE WHEN buyer_company_id IS NULL THEN 'B2C' ELSE 'B2B' END))
WHERE true;

ALTER TABLE marketplace_carts ADD COLUMN IF NOT EXISTS buyer_company_id INTEGER;
ALTER TABLE marketplace_carts ADD COLUMN IF NOT EXISTS cart_type VARCHAR(20) DEFAULT 'B2C';

ALTER TABLE marketplace_profiles ADD COLUMN IF NOT EXISTS country TEXT DEFAULT '';
ALTER TABLE marketplace_profiles ADD COLUMN IF NOT EXISTS city TEXT DEFAULT '';
ALTER TABLE marketplace_profiles ADD COLUMN IF NOT EXISTS address TEXT DEFAULT '';

UPDATE marketplace_carts SET
  buyer_company_id=COALESCE(buyer_company_id, company_id),
  cart_type=CASE WHEN company_id IS NULL THEN 'B2C' ELSE 'B2B' END
WHERE true;

CREATE INDEX IF NOT EXISTS idx_marketplace_products_published ON marketplace_products(is_published, status);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_seller_company ON marketplace_orders(seller_company_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_buyer_user ON marketplace_orders(buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_type ON marketplace_orders(order_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_profiles_user_type_unique
  ON marketplace_profiles(user_id, profile_type)
  WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  supplier_company_id INTEGER,
  supplier_name TEXT DEFAULT '',
  marketplace_order_id INTEGER,
  purchase_number TEXT UNIQUE,
  total_amount NUMERIC(14,2) DEFAULT 0,
  amount_paid NUMERIC(14,2) DEFAULT 0,
  amount_due NUMERIC(14,2) DEFAULT 0,
  status VARCHAR(60) DEFAULT 'pending',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE purchases ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS supplier_company_id INTEGER;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS supplier_name TEXT DEFAULT '';
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS marketplace_order_id INTEGER;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS purchase_number TEXT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS total_amount NUMERIC(14,2) DEFAULT 0;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(14,2) DEFAULT 0;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS amount_due NUMERIC(14,2) DEFAULT 0;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS status VARCHAR(60) DEFAULT 'pending';
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS created_by INTEGER;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_purchase_number_unique
  ON purchases(purchase_number)
  WHERE purchase_number IS NOT NULL AND purchase_number <> '';
CREATE INDEX IF NOT EXISTS idx_purchases_company_id ON purchases(company_id);
CREATE INDEX IF NOT EXISTS idx_purchases_marketplace_order_id ON purchases(marketplace_order_id);

UPDATE ai_module_knowledge SET
  description='Marketplace B2B/B2C pour clients particuliers, entreprises vendeuses et entreprises acheteuses.',
  data_sources='["marketplace_products","marketplace_orders","marketplace_order_items","marketplace_payments","marketplace_carts","marketplace_profiles","products","stock_movements","documents","payments","purchases"]'::jsonb,
  examples='["Combien de produits marketplace sont publies ?","Quelles commandes B2B sont en attente ?","Quelles commandes B2C aujourd hui ?","Quel vendeur vend le plus ?","Quel client a commande ?"]'::jsonb,
  updated_at=CURRENT_TIMESTAMP
WHERE module_key='marketplace';
