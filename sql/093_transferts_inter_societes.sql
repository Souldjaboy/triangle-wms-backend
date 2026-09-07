BEGIN;

ALTER TABLE intercompany_transfers
  ADD COLUMN IF NOT EXISTS from_account_type TEXT NOT NULL DEFAULT 'TREASURY';

ALTER TABLE intercompany_transfers
  ADD COLUMN IF NOT EXISTS to_account_type TEXT NOT NULL DEFAULT 'TREASURY';

ALTER TABLE intercompany_transfers
  ADD COLUMN IF NOT EXISTS to_bank_id INTEGER
    REFERENCES accounting_banks(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_intercompany_from_company
  ON intercompany_transfers(from_company_id);

CREATE INDEX IF NOT EXISTS idx_intercompany_to_company
  ON intercompany_transfers(to_company_id);

CREATE INDEX IF NOT EXISTS idx_intercompany_to_bank
  ON intercompany_transfers(to_bank_id);

COMMIT;
