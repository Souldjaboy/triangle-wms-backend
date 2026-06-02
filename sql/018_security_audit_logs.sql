-- Triangle WMS Pro - Journal d'audit sécurité
-- À exécuter après déploiement backend.

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  user_email TEXT DEFAULT '',
  user_role TEXT DEFAULT '',
  company_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT DEFAULT '',
  entity_id TEXT,
  ip_address TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_company_id ON audit_logs(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
