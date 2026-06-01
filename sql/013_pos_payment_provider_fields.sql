-- Triangle WMS Pro - POS payment provider fields and sandbox metadata
-- Safe additive migration: no DROP TABLE, no data deletion.

ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS provider VARCHAR(100) DEFAULT '';
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS client_id TEXT DEFAULT '';
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS client_secret_encrypted TEXT DEFAULT '';
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS merchant_id VARCHAR(255) DEFAULT '';
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS merchant_account VARCHAR(255) DEFAULT '';
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS webhook_secret_encrypted TEXT DEFAULT '';
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS connection_status VARCHAR(80) DEFAULT 'Non testé';
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP;

ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS phone_number VARCHAR(80) DEFAULT '';
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS provider_response JSONB;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON payment_transactions(status);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_phone ON payment_transactions(phone_number);
