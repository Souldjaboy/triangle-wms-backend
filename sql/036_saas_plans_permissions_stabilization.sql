-- Triangle WMS Pro - Stabilisation plans SaaS, permissions et limites
-- Migration additive uniquement. Ne supprime aucune donnee.

ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS currency VARCHAR(20) DEFAULT 'FCFA';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS duration_days INTEGER DEFAULT 30;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_cash_registers INTEGER DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_sales_per_month INTEGER DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_stock_movements_per_month INTEGER DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(40) DEFAULT 'monthly';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS features_json JSONB DEFAULT '{}'::jsonb;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS monthly_price NUMERIC(14,2) DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS yearly_price NUMERIC(14,2) DEFAULT 0;

UPDATE subscription_plans
SET
  monthly_price = COALESCE(NULLIF(monthly_price, 0), price_monthly, 0),
  max_stock_movements_per_month = COALESCE(NULLIF(max_stock_movements_per_month, 0), max_movements_monthly, 0),
  currency = COALESCE(NULLIF(currency, ''), 'FCFA'),
  duration_days = COALESCE(NULLIF(duration_days, 0), 30),
  is_active = COALESCE(is_active, true);

CREATE INDEX IF NOT EXISTS idx_subscription_plans_active ON subscription_plans(is_active);

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

CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_permissions_module_key ON user_permissions(module_key);
