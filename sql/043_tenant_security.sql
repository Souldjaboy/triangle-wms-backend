CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  primary_domain TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE IF EXISTS companies ADD COLUMN IF NOT EXISTS tenant_id TEXT DEFAULT 'triangle';
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS tenant_id TEXT DEFAULT 'triangle';
ALTER TABLE IF EXISTS marketplace_orders ADD COLUMN IF NOT EXISTS tenant_id TEXT DEFAULT 'triangle';
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS tenant_id TEXT DEFAULT 'triangle';
ALTER TABLE IF EXISTS sales ADD COLUMN IF NOT EXISTS tenant_id TEXT DEFAULT 'triangle';
ALTER TABLE IF EXISTS notifications ADD COLUMN IF NOT EXISTS tenant_id TEXT DEFAULT 'triangle';

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'triangle',
  company_id INTEGER,
  user_id INTEGER,
  endpoint TEXT NOT NULL,
  p256dh TEXT,
  auth TEXT,
  user_agent TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, endpoint)
);

CREATE TABLE IF NOT EXISTS pos_receipt_email_logs (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'triangle',
  company_id INTEGER,
  sale_id INTEGER,
  receipt_id INTEGER,
  recipient_email TEXT NOT NULL,
  subject TEXT,
  status TEXT DEFAULT 'pending',
  provider_message_id TEXT,
  error_message TEXT,
  sent_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMP
);
