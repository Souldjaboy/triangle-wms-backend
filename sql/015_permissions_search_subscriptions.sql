-- Triangle WMS Pro - Permissions modules + abonnements SaaS
-- Non destructif : aucune suppression de données.

CREATE TABLE IF NOT EXISTS modules (
  id SERIAL PRIMARY KEY,
  module_key VARCHAR(120) UNIQUE NOT NULL,
  module_name VARCHAR(180) NOT NULL,
  description TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS company_modules (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  module_key VARCHAR(120) NOT NULL,
  is_enabled BOOLEAN DEFAULT true,
  enabled BOOLEAN DEFAULT true,
  updated_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, module_key)
);

ALTER TABLE company_modules ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN DEFAULT true;
ALTER TABLE company_modules ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT true;
ALTER TABLE company_modules ADD COLUMN IF NOT EXISTS updated_by INTEGER;
ALTER TABLE company_modules ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE company_modules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS user_permissions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  module_key VARCHAR(120) NOT NULL,
  can_view BOOLEAN DEFAULT true,
  can_create BOOLEAN DEFAULT false,
  can_edit BOOLEAN DEFAULT false,
  can_delete BOOLEAN DEFAULT false,
  can_validate BOOLEAN DEFAULT false,
  updated_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, module_key)
);

CREATE TABLE IF NOT EXISTS company_subscriptions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  plan_id INTEGER,
  plan_name VARCHAR(120) DEFAULT '',
  status VARCHAR(80) DEFAULT 'active',
  starts_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS monthly_price NUMERIC(14,2) DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS yearly_price NUMERIC(14,2) DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_products INTEGER DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_users INTEGER DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_warehouses INTEGER DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_cash_registers INTEGER DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_sales_per_month INTEGER DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_stock_movements_per_month INTEGER DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(40) DEFAULT 'monthly';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS features_json JSONB DEFAULT '{}'::jsonb;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

INSERT INTO modules (module_key, module_name, description)
VALUES
  ('dashboard', 'Tableau de bord', 'Vue globale WMS'),
  ('products', 'Produits', 'Gestion des produits'),
  ('stocks', 'Stocks', 'Stocks et mouvements'),
  ('locations', 'Emplacements', 'Emplacements et QR codes'),
  ('inventory', 'Inventaires', 'Inventaires et ajustements'),
  ('attendance', 'Pointage', 'Pointage QR et GPS'),
  ('documents', 'Documents', 'Documents et reçus'),
  ('reports', 'Rapports', 'Rapports et exports'),
  ('pos', 'POS / Caisse', 'Ventes, paiements et reçus'),
  ('ai', 'Assistant IA', 'Assistant IA connecté au WMS'),
  ('chat', 'Chat interne', 'Messages et vocaux'),
  ('meetings', 'Réunions', 'Réunions et invitations'),
  ('settings', 'Paramètres', 'Paramètres entreprise'),
  ('users', 'Utilisateurs', 'Utilisateurs et permissions')
ON CONFLICT (module_key) DO UPDATE SET
  module_name=EXCLUDED.module_name,
  description=EXCLUDED.description,
  updated_at=CURRENT_TIMESTAMP;

INSERT INTO subscription_plans
  (name, monthly_price, yearly_price, max_products, max_users, max_warehouses,
   max_cash_registers, max_sales_per_month, max_stock_movements_per_month,
   billing_cycle, features_json, is_active)
SELECT 'Essentiel', 15000, 150000, 500, 5, 1, 0, 0, 1000, 'monthly',
       '{"products":true,"stocks":true,"locations":true,"simple_reports":true,"pos":false,"ai":false}'::jsonb,
       true
WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE lower(name)='essentiel');

INSERT INTO subscription_plans
  (name, monthly_price, yearly_price, max_products, max_users, max_warehouses,
   max_cash_registers, max_sales_per_month, max_stock_movements_per_month,
   billing_cycle, features_json, is_active)
SELECT 'Standard', 30000, 300000, 3000, 20, 3, 0, 0, 10000, 'monthly',
       '{"products":true,"stocks":true,"locations":true,"attendance":true,"qr":true,"inventory":true,"notifications":true,"pos":false,"ai":false}'::jsonb,
       true
WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE lower(name)='standard');

INSERT INTO subscription_plans
  (name, monthly_price, yearly_price, max_products, max_users, max_warehouses,
   max_cash_registers, max_sales_per_month, max_stock_movements_per_month,
   billing_cycle, features_json, is_active)
SELECT 'Premium', 60000, 600000, 0, 0, 0, 5, 0, 0, 'monthly',
       '{"products":true,"stocks":true,"locations":true,"attendance":true,"qr":true,"inventory":true,"notifications":true,"pos":true,"batches":true,"advanced_reports":true,"ai":true,"documents":true,"multi_warehouse":true}'::jsonb,
       true
WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE lower(name)='premium');

UPDATE subscription_plans SET
  price_monthly=15000,
  monthly_price=15000,
  yearly_price=150000,
  max_products=500,
  max_users=5,
  max_warehouses=1,
  max_cash_registers=0,
  max_sales_per_month=0,
  max_stock_movements_per_month=1000,
  billing_cycle='monthly',
  features_json='{"products":true,"stocks":true,"locations":true,"simple_reports":true,"pos":false,"ai":false}'::jsonb,
  is_active=true
WHERE lower(name)='essentiel';

UPDATE subscription_plans SET
  price_monthly=30000,
  monthly_price=30000,
  yearly_price=300000,
  max_products=3000,
  max_users=20,
  max_warehouses=3,
  max_cash_registers=0,
  max_sales_per_month=0,
  max_stock_movements_per_month=10000,
  billing_cycle='monthly',
  features_json='{"products":true,"stocks":true,"locations":true,"attendance":true,"qr":true,"inventory":true,"notifications":true,"pos":false,"ai":false}'::jsonb,
  is_active=true
WHERE lower(name)='standard';

UPDATE subscription_plans SET
  price_monthly=60000,
  monthly_price=60000,
  yearly_price=600000,
  max_products=0,
  max_users=0,
  max_warehouses=0,
  max_cash_registers=5,
  max_sales_per_month=0,
  max_stock_movements_per_month=0,
  billing_cycle='monthly',
  features_json='{"products":true,"stocks":true,"locations":true,"attendance":true,"qr":true,"inventory":true,"notifications":true,"pos":true,"batches":true,"advanced_reports":true,"ai":true,"documents":true,"multi_warehouse":true}'::jsonb,
  is_active=true
WHERE lower(name)='premium';

UPDATE subscription_plans
SET name='Essentiel',
    price_monthly=15000,
    monthly_price=15000,
    yearly_price=150000,
    features_json='{"products":true,"stocks":true,"locations":true,"simple_reports":true,"pos":false,"ai":false}'::jsonb
WHERE lower(name)='starter';

CREATE INDEX IF NOT EXISTS idx_modules_key ON modules(module_key);
CREATE INDEX IF NOT EXISTS idx_company_modules_company ON company_modules(company_id);
CREATE INDEX IF NOT EXISTS idx_company_modules_key ON company_modules(module_key);
CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_permissions_module ON user_permissions(module_key);
CREATE INDEX IF NOT EXISTS idx_company_subscriptions_company ON company_subscriptions(company_id);
