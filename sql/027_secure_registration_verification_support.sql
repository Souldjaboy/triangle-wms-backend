-- Triangle WMS Pro - Inscription sécurisée, vérification OTP, trial et support
-- Migration non destructive.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS account_status VARCHAR(80) DEFAULT 'pending_verification';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS trial_start_date TIMESTAMP;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS trial_end_date TIMESTAMP;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(80) DEFAULT 'trial';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(120);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(80) DEFAULT 'pending_verification';
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS invitation_status VARCHAR(80) DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_required BOOLEAN DEFAULT false;

CREATE TABLE IF NOT EXISTS verification_codes (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  user_id INTEGER,
  target_type VARCHAR(20) NOT NULL,
  target_value TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  token_hash TEXT DEFAULT '',
  expires_at TIMESTAMP NOT NULL,
  attempts INTEGER DEFAULT 0,
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_verification_codes_user ON verification_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_verification_codes_company ON verification_codes(company_id);
CREATE INDEX IF NOT EXISTS idx_verification_codes_target ON verification_codes(target_type, target_value);
CREATE INDEX IF NOT EXISTS idx_verification_codes_expires ON verification_codes(expires_at);

CREATE TABLE IF NOT EXISTS support_requests (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  user_id INTEGER,
  name VARCHAR(255) DEFAULT '',
  email VARCHAR(255) DEFAULT '',
  phone VARCHAR(100) DEFAULT '',
  message TEXT NOT NULL,
  source_page TEXT DEFAULT '',
  status VARCHAR(80) DEFAULT 'nouveau',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_support_requests_company ON support_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_support_requests_status ON support_requests(status);

UPDATE companies
SET
  trial_start_date = COALESCE(trial_start_date, created_at, CURRENT_TIMESTAMP),
  trial_end_date = COALESCE(trial_end_date, trial_ends_at, created_at + INTERVAL '15 days', CURRENT_TIMESTAMP + INTERVAL '15 days'),
  subscription_expires_at = COALESCE(subscription_expires_at, trial_ends_at, created_at + INTERVAL '15 days', CURRENT_TIMESTAMP + INTERVAL '15 days'),
  account_status = COALESCE(NULLIF(account_status, ''), 'active')
WHERE account_status IS NULL OR account_status = '';

UPDATE users
SET account_status = 'active',
    email_verified = true
WHERE is_super_admin = true
  AND (account_status IS NULL OR account_status <> 'active');
