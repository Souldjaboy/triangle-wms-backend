-- Triangle WMS Pro - Connexion sociale OAuth officielle
-- Ne stocke jamais les mots de passe sociaux.

CREATE TABLE IF NOT EXISTS social_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  provider VARCHAR(80) NOT NULL,
  provider_user_id TEXT NOT NULL,
  email VARCHAR(255) DEFAULT '',
  phone VARCHAR(100) DEFAULT '',
  avatar_url TEXT DEFAULT '',
  scopes_granted TEXT DEFAULT '',
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_social_accounts_user_id ON social_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_social_accounts_email ON social_accounts(email);
