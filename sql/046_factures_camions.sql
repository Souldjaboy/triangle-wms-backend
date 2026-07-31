-- 071 — Modules Factures & Camions (adaptés aux fichiers réels Triangle).
-- Idempotent, additif. Isolation stricte company_id. Ne casse rien d'existant.

-- Factures (états des factures Triangle / Fat et Mat).
CREATE TABLE IF NOT EXISTS factures (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  numero TEXT,                         -- N° (ordre)
  reference TEXT,                      -- Ref/N° Facture (ex. S00318, 0034-2026)
  invoice_date DATE,                   -- Date de Facture
  site TEXT,                           -- Localité / Site
  description TEXT,
  invoiced_amount NUMERIC(16,2) NOT NULL DEFAULT 0,   -- Montant Facturé
  paid_amount NUMERIC(16,2) NOT NULL DEFAULT 0,       -- Montant Payé
  remaining_amount NUMERIC(16,2) NOT NULL DEFAULT 0,  -- Reste à payer (recalculé)
  payment_date DATE,
  status TEXT NOT NULL DEFAULT 'impaye',              -- paye | partiel | impaye (recalculé)
  observations TEXT,
  source_type TEXT DEFAULT 'manual',   -- manual | import
  source_id INTEGER,                   -- import_jobs.id
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_factures_company ON factures (company_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_factures_ref ON factures (company_id, reference) WHERE reference IS NOT NULL AND reference <> '';

-- Camions (parc). Le code = référence utilisée dans les fichiers (ex. "10R CH0578").
CREATE TABLE IF NOT EXISTS camions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,                  -- référence/plaque courte
  immatriculation TEXT,
  chauffeur TEXT,
  statut TEXT NOT NULL DEFAULT 'actif',
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code)
);
CREATE INDEX IF NOT EXISTS idx_camions_company ON camions (company_id);

-- Opérations liées à un camion (recettes / dépenses issues du suivi comptable).
CREATE TABLE IF NOT EXISTS camion_operations (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  camion_id INTEGER REFERENCES camions(id) ON DELETE SET NULL,
  op_date DATE,
  libelle TEXT,
  recette NUMERIC(16,2) NOT NULL DEFAULT 0,
  depense NUMERIC(16,2) NOT NULL DEFAULT 0,
  piece_ref TEXT,
  source_type TEXT DEFAULT 'import',
  source_id INTEGER,                   -- import_jobs.id
  accounting_transaction_id INTEGER,   -- lien vers l'écriture de trésorerie
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_camion_ops ON camion_operations (company_id, camion_id);
