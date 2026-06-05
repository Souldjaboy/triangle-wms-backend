-- Triangle WMS Pro - Produits, Marketplace et securite multi-entreprise
-- Additif uniquement. Ne supprime aucune donnee.

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_durable BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_products_company_active
  ON products(company_id, is_active);

CREATE INDEX IF NOT EXISTS idx_marketplace_products_sellable
  ON marketplace_products(company_id, status, is_published);
