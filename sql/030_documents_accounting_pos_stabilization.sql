-- Triangle WMS Pro - Documents, email, comptabilite POS
-- Migration additive uniquement. Ne supprime aucune donnee.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS related_entity_type TEXT DEFAULT '';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS related_entity_id INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS stock_movement_id INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS client_phone TEXT DEFAULT '';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS client_address TEXT DEFAULT '';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS email_sent_to TEXT DEFAULT '';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMP;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS accounting_transaction_id INTEGER;

ALTER TABLE accounting_transactions ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT '';
ALTER TABLE accounting_transactions ADD COLUMN IF NOT EXISTS source_id INTEGER;
ALTER TABLE accounting_transactions ADD COLUMN IF NOT EXISTS caisse_id INTEGER;
ALTER TABLE accounting_transactions ADD COLUMN IF NOT EXISTS source_label TEXT DEFAULT '';
ALTER TABLE accounting_transactions ADD COLUMN IF NOT EXISTS destination_label TEXT DEFAULT '';
ALTER TABLE accounting_transactions ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'FCFA';
ALTER TABLE accounting_transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_documents_related_entity
  ON documents(related_entity_type, related_entity_id);

CREATE INDEX IF NOT EXISTS idx_documents_stock_movement_id
  ON documents(stock_movement_id);

CREATE INDEX IF NOT EXISTS idx_payments_accounting_transaction_id
  ON payments(accounting_transaction_id);

CREATE INDEX IF NOT EXISTS idx_accounting_transactions_source
  ON accounting_transactions(source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_accounting_transactions_pos_payment
  ON accounting_transactions(company_id, source_type, source_id)
  WHERE source_type='pos_payment';
