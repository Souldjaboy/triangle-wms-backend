-- Triangle WMS Pro - Identite entreprise et contexte actif super admin
-- Migration additive uniquement. Ne supprime aucune donnee.

ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS company_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_company_settings_company_id ON company_settings(company_id);

UPDATE company_settings
SET company_id = 1
WHERE company_id IS NULL
  AND EXISTS (SELECT 1 FROM companies WHERE id = 1);
