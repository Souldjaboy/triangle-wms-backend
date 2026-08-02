-- 047 — Index de recherche produit (PHASE 1). Idempotent, additif.
-- Accélère /products/search (recherche multi-mots insensible casse/accents).

-- pg_trgm accélère les LIKE '%...%'. Si l'extension n'est pas disponible,
-- les index simples ci-dessous restent utiles (préfixes / égalité).
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN insufficient_privilege OR undefined_file THEN
  RAISE NOTICE 'pg_trgm indisponible : index trigram ignorés.';
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS idx_products_name_trgm
      ON products USING gin (lower(name) gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_products_reference_trgm
      ON products USING gin (lower(reference) gin_trgm_ops);
  END IF;
END $$;

-- Index de base (toujours créés) : filtrage entreprise + accès direct.
CREATE INDEX IF NOT EXISTS idx_products_company_name ON products (company_id, name);
CREATE INDEX IF NOT EXISTS idx_products_company_reference ON products (company_id, reference);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_sku ON products (sku) WHERE sku IS NOT NULL;
