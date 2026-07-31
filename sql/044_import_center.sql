-- 069 — Centre d'importation intelligent multi-produits (Phase 1).
-- Idempotent, additif. Isolation stricte company_id / tenant_id / product_code.
-- Aucune donnée métier n'est écrite ici : ce sont les tables de pilotage,
-- de staging et d'audit des importations.

-- Job d'importation : une importation = un cycle upload -> confirmation -> exécution.
CREATE TABLE IF NOT EXISTS import_jobs (
  id SERIAL PRIMARY KEY,
  job_uid TEXT NOT NULL UNIQUE,                 -- référence externe opaque (UUID)
  company_id INTEGER NOT NULL,
  tenant_id TEXT,
  product_code TEXT NOT NULL,                   -- triangle | malilink | hafiya
  module_key TEXT NOT NULL,
  submodule_key TEXT,
  import_type TEXT NOT NULL,                    -- clé de profil (ex. triangle.stock_in)
  original_filename TEXT,
  stored_filename TEXT,
  file_hash TEXT,                              -- empreinte SHA-256 (anti double import)
  file_size BIGINT,
  mime_type TEXT,
  status TEXT NOT NULL DEFAULT 'analyzed',      -- analyzed|mapped|validated|simulated|executing|imported|failed|rolled_back
  file_meta JSONB DEFAULT '{}',                 -- feuilles, lignes, dates détectées
  mapping JSONB DEFAULT '{}',                   -- correspondance colonne -> champ
  options JSONB DEFAULT '{}',                   -- stratégie (create/update, doublons…)
  summary JSONB DEFAULT '{}',                   -- résultats validation/simulation/exécution
  total_rows INTEGER DEFAULT 0,
  valid_rows INTEGER DEFAULT 0,
  invalid_rows INTEGER DEFAULT 0,
  imported_rows INTEGER DEFAULT 0,
  skipped_rows INTEGER DEFAULT 0,
  duplicate_rows INTEGER DEFAULT 0,
  created_by INTEGER,
  validated_by INTEGER,
  executed_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  validated_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_company ON import_jobs (company_id, product_code, status);
CREATE INDEX IF NOT EXISTS idx_import_jobs_hash ON import_jobs (company_id, file_hash);

-- Lignes en staging : la source de vérité tant que l'utilisateur n'a pas confirmé.
CREATE TABLE IF NOT EXISTS import_rows (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL,
  sheet_name TEXT,
  row_index INTEGER NOT NULL,                   -- ligne dans le fichier (1-based)
  raw JSONB NOT NULL DEFAULT '{}',              -- valeurs brutes du fichier
  mapped JSONB DEFAULT '{}',                    -- valeurs normalisées (après mapping)
  fingerprint TEXT,                             -- empreinte idempotente de la ligne
  status TEXT NOT NULL DEFAULT 'new',           -- new|update|duplicate|invalid|warning|skipped|imported|failed|rolled_back
  messages JSONB DEFAULT '[]',                  -- erreurs/avertissements de la ligne
  result_ref JSONB DEFAULT '{}',               -- ids créés/modifiés (pour rollback)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_import_rows_job ON import_rows (job_id, status);
CREATE INDEX IF NOT EXISTS idx_import_rows_fp ON import_rows (company_id, fingerprint);

-- Erreurs agrégées (pour le rapport téléchargeable).
CREATE TABLE IF NOT EXISTS import_errors (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL,
  row_index INTEGER,
  field TEXT,
  code TEXT,
  message TEXT,
  severity TEXT DEFAULT 'error',                -- error|warning
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_import_errors_job ON import_errors (job_id);

-- Audit complet du cycle de vie d'une importation (traçabilité).
CREATE TABLE IF NOT EXISTS import_audit_logs (
  id SERIAL PRIMARY KEY,
  job_id INTEGER REFERENCES import_jobs(id) ON DELETE SET NULL,
  company_id INTEGER NOT NULL,
  product_code TEXT,
  action TEXT NOT NULL,                         -- upload|analyze|map|validate|simulate|execute|rollback|reopen
  user_id INTEGER,
  detail JSONB DEFAULT '{}',
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_import_audit_company ON import_audit_logs (company_id, created_at DESC);

-- Journal de rollback (annulations d'importation).
CREATE TABLE IF NOT EXISTS import_rollback_logs (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL,
  strategy TEXT,
  reverted_rows INTEGER DEFAULT 0,
  detail JSONB DEFAULT '{}',
  user_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Clôtures mensuelles de comptabilité (Phase 4, table créée dès maintenant).
CREATE TABLE IF NOT EXISTS accounting_period_closures (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  period_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL,                -- 1-12
  status TEXT NOT NULL DEFAULT 'open',          -- open|closed
  opening_balance NUMERIC(16,2) DEFAULT 0,
  total_income NUMERIC(16,2) DEFAULT 0,
  total_expense NUMERIC(16,2) DEFAULT 0,
  closing_balance NUMERIC(16,2) DEFAULT 0,
  snapshot JSONB DEFAULT '{}',                  -- rapport de clôture figé
  closed_by INTEGER,
  closed_at TIMESTAMPTZ,
  reopened_by INTEGER,
  reopened_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, period_year, period_month)
);
