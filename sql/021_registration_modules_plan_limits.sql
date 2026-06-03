-- Triangle WMS Pro - Inscription modules + correction limites plans

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

UPDATE subscription_plans
SET
  max_users = CASE
    WHEN LOWER(name)='premium' AND COALESCE(max_users,0) <= 0 THEN 30
    WHEN LOWER(name)='standard' AND COALESCE(max_users,0) <= 0 THEN 10
    WHEN LOWER(name) IN ('essentiel','starter') AND COALESCE(max_users,0) <= 0 THEN 3
    ELSE max_users
  END,
  max_warehouses = CASE
    WHEN LOWER(name)='premium' AND COALESCE(max_warehouses,0) <= 0 THEN 10
    WHEN LOWER(name)='standard' AND COALESCE(max_warehouses,0) <= 0 THEN 3
    WHEN LOWER(name) IN ('essentiel','starter') AND COALESCE(max_warehouses,0) <= 0 THEN 1
    ELSE max_warehouses
  END,
  max_products = CASE
    WHEN LOWER(name)='premium' AND COALESCE(max_products,0) <= 0 THEN 10000
    WHEN LOWER(name)='standard' AND COALESCE(max_products,0) < 2000 THEN 2000
    WHEN LOWER(name) IN ('essentiel','starter') AND COALESCE(max_products,0) < 300 THEN 300
    ELSE max_products
  END,
  max_movements_monthly = CASE
    WHEN LOWER(name)='premium' AND COALESCE(max_movements_monthly,0) <= 0 THEN 20000
    WHEN LOWER(name)='standard' AND COALESCE(max_movements_monthly,0) <= 0 THEN 3000
    WHEN LOWER(name) IN ('essentiel','starter') AND COALESCE(max_movements_monthly,0) <= 0 THEN 500
    ELSE max_movements_monthly
  END
WHERE LOWER(name) IN ('essentiel','starter','standard','premium');

CREATE INDEX IF NOT EXISTS idx_company_modules_company_id ON company_modules(company_id);
CREATE INDEX IF NOT EXISTS idx_company_modules_module_key ON company_modules(module_key);
