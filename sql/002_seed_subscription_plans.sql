-- Triangle WMS Pro - Plans SaaS par défaut
-- À exécuter après 000_init_tables.sql.

INSERT INTO subscription_plans (
  name,
  price_monthly,
  max_users,
  max_warehouses,
  max_products,
  max_movements_monthly,
  trial_days,
  modules,
  can_use_reports,
  can_use_qr,
  can_use_advanced_inventory,
  can_use_documents,
  can_use_chat,
  can_use_ai
)
SELECT 'Starter', 5000, 3, 1, 200, 500, 15, 'all', true, true, true, true, true, true
WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE name='Starter');

INSERT INTO subscription_plans (
  name,
  price_monthly,
  max_users,
  max_warehouses,
  max_products,
  max_movements_monthly,
  trial_days,
  modules,
  can_use_reports,
  can_use_qr,
  can_use_advanced_inventory,
  can_use_documents,
  can_use_chat,
  can_use_ai
)
SELECT 'Standard', 10000, 10, 3, 1000, 3000, 15, 'all', true, true, true, true, true, true
WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE name='Standard');

INSERT INTO subscription_plans (
  name,
  price_monthly,
  max_users,
  max_warehouses,
  max_products,
  max_movements_monthly,
  trial_days,
  modules,
  can_use_reports,
  can_use_qr,
  can_use_advanced_inventory,
  can_use_documents,
  can_use_chat,
  can_use_ai
)
SELECT 'Premium', 15000, 0, 0, 0, 0, 15, 'all', true, true, true, true, true, true
WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE name='Premium');
