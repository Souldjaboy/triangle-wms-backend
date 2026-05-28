-- Triangle WMS Pro - Stabilisation structure emplacements + company_id
-- À exécuter UNE SEULE FOIS dans PostgreSQL : psql -d triangle_wms_db -f sql/001_stabilisation.sql

ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_url TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS badge_code TEXT;

ALTER TABLE products ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS location_id INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS location_code TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS minimum_stock INTEGER DEFAULT 5;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT '';

ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS company_id INTEGER;

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS created_by INTEGER;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS created_by_name TEXT DEFAULT '';
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS created_by_role TEXT DEFAULT '';
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS validated_by INTEGER;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS validated_at TIMESTAMP;

ALTER TABLE locations ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS product_id INTEGER;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS product_reference TEXT DEFAULT '';
ALTER TABLE locations ADD COLUMN IF NOT EXISTS product_name TEXT DEFAULT '';
ALTER TABLE locations ADD COLUMN IF NOT EXISTS rayon_code TEXT DEFAULT '';
ALTER TABLE locations ADD COLUMN IF NOT EXISTS case_code TEXT DEFAULT '';
ALTER TABLE locations ADD COLUMN IF NOT EXISTS level_code TEXT DEFAULT '';
ALTER TABLE locations ADD COLUMN IF NOT EXISTS bin_code TEXT DEFAULT '';
ALTER TABLE locations ADD COLUMN IF NOT EXISTS bin_mode TEXT DEFAULT 'single';
ALTER TABLE locations ADD COLUMN IF NOT EXISTS bin_group TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_products_company_id ON products(company_id);
CREATE INDEX IF NOT EXISTS idx_warehouses_company_id ON warehouses(company_id);
CREATE INDEX IF NOT EXISTS idx_locations_company_id ON locations(company_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_company_id ON stock_movements(company_id);
CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id);
