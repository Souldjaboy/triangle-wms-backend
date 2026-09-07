-- Comptabilité multi-sociétés : numéros isolés, imports historiques et avances.
-- Migration additive, idempotente et sans modification des montants existants.

BEGIN;

ALTER TABLE accounting_transactions
  ADD COLUMN IF NOT EXISTS operation_date DATE;

COMMENT ON COLUMN accounting_transactions.operation_date IS
  'Date métier de l’opération, distincte de created_at (date de saisie).';

-- Les générateurs sont isolés par company_id. Leur unicité doit l'être aussi.
DO $$
DECLARE
  cible RECORD;
  doublons BIGINT;
BEGIN
  FOR cible IN
    SELECT * FROM (VALUES
      ('accounting_transactions', 'transaction_number', 'accounting_transactions_transaction_number_key', 'accounting_transactions_company_number_uidx'),
      ('accounting_entries',      'entry_number',       'accounting_entries_entry_number_key',             'accounting_entries_company_number_uidx'),
      ('journal_entries',         'entry_number',       'journal_entries_entry_number_key',                'journal_entries_company_number_uidx'),
      ('cash_vouchers',           'voucher_number',     'cash_vouchers_voucher_number_key',                'cash_vouchers_company_number_uidx'),
      ('expense_requests',        'request_number',     'expense_requests_request_number_key',             'expense_requests_company_number_uidx'),
      ('payroll_runs',            'payroll_number',     'payroll_runs_payroll_number_key',                 'payroll_runs_company_number_uidx')
    ) AS v(tab, col, ancienne, nouvelle)
  LOOP
    IF to_regclass('public.' || cible.tab) IS NULL THEN CONTINUE; END IF;
    EXECUTE format(
      'SELECT count(*) FROM (SELECT company_id, %I FROM %I WHERE %I IS NOT NULL GROUP BY company_id, %I HAVING count(*) > 1) d',
      cible.col, cible.tab, cible.col, cible.col
    ) INTO doublons;
    IF doublons > 0 THEN
      RAISE WARNING 'Unicité %.% non modifiée : % doublon(s) intra-société.', cible.tab, cible.col, doublons;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', cible.tab, cible.ancienne);
    IF to_regclass('public.' || cible.nouvelle) IS NULL THEN
      EXECUTE format('CREATE UNIQUE INDEX %I ON %I(company_id, %I)', cible.nouvelle, cible.tab, cible.col);
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS accounting_historical_imports (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  import_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_sha256 CHAR(64) NOT NULL,
  file_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'PREVIEWED',
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  UNIQUE(company_id, import_key)
);

ALTER TABLE accounting_historical_imports
  ADD COLUMN IF NOT EXISTS file_manifest JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS accounting_historical_lines (
  id BIGSERIAL PRIMARY KEY,
  import_id BIGINT NOT NULL REFERENCES accounting_historical_imports(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  source_sheet TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  operation_date DATE,
  recorded_date DATE,
  line_type TEXT NOT NULL,
  account_kind TEXT NOT NULL DEFAULT 'INFORMATION',
  bank_id INTEGER REFERENCES accounting_banks(id),
  reference TEXT,
  description TEXT,
  income NUMERIC(16,2) NOT NULL DEFAULT 0,
  expense NUMERIC(16,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'IMPORTED',
  review_reason TEXT,
  accounting_transaction_id INTEGER REFERENCES accounting_transactions(id),
  fingerprint CHAR(64) NOT NULL,
  source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id, fingerprint),
  CHECK (income >= 0 AND expense >= 0),
  CHECK (NOT (income > 0 AND expense > 0))
);

CREATE TABLE IF NOT EXISTS intercompany_transfers (
  id BIGSERIAL PRIMARY KEY,
  transfer_number TEXT NOT NULL,
  from_company_id INTEGER NOT NULL REFERENCES companies(id),
  to_company_id INTEGER NOT NULL REFERENCES companies(id),
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'FCFA',
  operation_date DATE NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'VALIDATED',
  from_bank_id INTEGER REFERENCES accounting_banks(id),
  from_transaction_id INTEGER REFERENCES accounting_transactions(id),
  to_transaction_id INTEGER REFERENCES accounting_transactions(id),
  source_import_line_id BIGINT REFERENCES accounting_historical_lines(id),
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  CHECK (from_company_id <> to_company_id),
  UNIQUE(from_company_id, transfer_number)
);

CREATE INDEX IF NOT EXISTS accounting_historical_imports_company_idx
  ON accounting_historical_imports(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS accounting_historical_lines_import_idx
  ON accounting_historical_lines(import_id, source_sheet, source_row);
CREATE INDEX IF NOT EXISTS accounting_historical_lines_review_idx
  ON accounting_historical_lines(company_id, status) WHERE status <> 'IMPORTED';
CREATE INDEX IF NOT EXISTS intercompany_transfers_from_idx
  ON intercompany_transfers(from_company_id, operation_date DESC);
CREATE INDEX IF NOT EXISTS intercompany_transfers_to_idx
  ON intercompany_transfers(to_company_id, operation_date DESC);

COMMIT;
