-- Triangle WMS Pro - Liens partenaires pour fiche complete

ALTER TABLE payments ADD COLUMN IF NOT EXISTS partner_id INTEGER;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS partner_id INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS partner_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_payments_partner_id ON payments(partner_id);
CREATE INDEX IF NOT EXISTS idx_receipts_partner_id ON receipts(partner_id);
CREATE INDEX IF NOT EXISTS idx_documents_partner_id ON documents(partner_id);
CREATE INDEX IF NOT EXISTS idx_sales_client_id ON sales(client_id);
CREATE INDEX IF NOT EXISTS idx_products_supplier_id ON products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_product_batches_supplier_id ON product_batches(supplier_id);
