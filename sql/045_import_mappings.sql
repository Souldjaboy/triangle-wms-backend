-- 070 — Centre d'importation : mappings réutilisables. Idempotent, additif.
-- Isolation stricte : company_id + product_code + module_key + profile_key.

CREATE TABLE IF NOT EXISTS import_mapping_templates (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  tenant_id TEXT,
  product_code TEXT NOT NULL,
  module_key TEXT,
  profile_key TEXT NOT NULL,
  name TEXT NOT NULL,
  mapping JSONB NOT NULL DEFAULT '{}',
  header_signature TEXT,              -- empreinte des en-têtes source (auto-suggestion)
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, profile_key, name)
);
CREATE INDEX IF NOT EXISTS idx_import_mapping_scope ON import_mapping_templates (company_id, product_code, profile_key);
CREATE INDEX IF NOT EXISTS idx_import_mapping_sig ON import_mapping_templates (company_id, profile_key, header_signature);
