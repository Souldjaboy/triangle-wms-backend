-- Triangle WMS Pro - Liaisons partenaires et valeurs financières opérations

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS partner_id INTEGER;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS partner_name TEXT DEFAULT '';
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS partner_type TEXT DEFAULT '';
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS apply_price BOOLEAN DEFAULT false;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS unit_price NUMERIC DEFAULT 0;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS total_amount NUMERIC DEFAULT 0;

ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_price NUMERIC DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_price NUMERIC DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS default_supplier_id INTEGER;

ALTER TABLE sales ADD COLUMN IF NOT EXISTS client_id INTEGER;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS client_name TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_stock_movements_partner_id ON stock_movements(partner_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_partner_type ON stock_movements(partner_type);
CREATE INDEX IF NOT EXISTS idx_products_default_supplier_id ON products(default_supplier_id);
CREATE INDEX IF NOT EXISTS idx_sales_client_name ON sales(client_name);
