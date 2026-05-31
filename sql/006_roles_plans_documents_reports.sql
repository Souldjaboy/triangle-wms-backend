-- Triangle WMS Pro - French plans and role/workflow polish
-- Safe additive/update migration: no DROP TABLE, no data deletion.

UPDATE subscription_plans
SET name = 'Essentiel'
WHERE name = 'Starter';

ALTER TABLE users ADD COLUMN IF NOT EXISTS warehouse_id INTEGER;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS product_id INTEGER;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS location_id INTEGER;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS status VARCHAR(80) DEFAULT 'Brouillon';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS warehouse_id INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS related_entity_type VARCHAR(100) DEFAULT '';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS related_entity_id INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_url TEXT DEFAULT '';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS email_status VARCHAR(80) DEFAULT 'not_configured';

CREATE INDEX IF NOT EXISTS idx_users_warehouse_id ON users(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product_id ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_location_id ON stock_movements(location_id);
CREATE INDEX IF NOT EXISTS idx_documents_related_entity ON documents(related_entity_type, related_entity_id);
