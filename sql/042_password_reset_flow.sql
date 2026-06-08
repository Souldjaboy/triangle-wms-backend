-- Triangle WMS Pro - Mot de passe oublié sécurisé

CREATE TABLE IF NOT EXISTS password_reset_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  company_id INTEGER,
  target_type VARCHAR(20) NOT NULL,
  target_value TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  token_hash TEXT DEFAULT '',
  expires_at TIMESTAMP NOT NULL,
  attempts INTEGER DEFAULT 0,
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_password_reset_codes_user ON password_reset_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_codes_target ON password_reset_codes(target_type, target_value);
CREATE INDEX IF NOT EXISTS idx_password_reset_codes_expires ON password_reset_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_password_reset_codes_active_user
  ON password_reset_codes(user_id, target_type, target_value)
  WHERE used_at IS NULL;
