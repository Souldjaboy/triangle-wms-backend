CREATE TABLE IF NOT EXISTS disbursement_requests (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  request_number VARCHAR(80) UNIQUE NOT NULL,
  requester_id INTEGER,
  requester_name VARCHAR(255) DEFAULT '',
  requester_role VARCHAR(100) DEFAULT '',
  amount NUMERIC(14,2) DEFAULT 0,
  category VARCHAR(120) DEFAULT '',
  urgency VARCHAR(50) DEFAULT 'normal',
  reason TEXT DEFAULT '',
  status VARCHAR(80) DEFAULT 'en_attente_validation',
  approval_comment TEXT DEFAULT '',
  disbursement_comment TEXT DEFAULT '',
  closure_comment TEXT DEFAULT '',
  payment_method VARCHAR(80) DEFAULT '',
  amount_disbursed NUMERIC(14,2) DEFAULT 0,
  initial_attachment_url TEXT DEFAULT '',
  receipt_url TEXT DEFAULT '',
  approved_by INTEGER,
  approved_by_name VARCHAR(255) DEFAULT '',
  approved_at TIMESTAMP,
  disbursed_by INTEGER,
  disbursed_by_name VARCHAR(255) DEFAULT '',
  disbursed_at TIMESTAMP,
  receipt_uploaded_at TIMESTAMP,
  closed_by INTEGER,
  closed_by_name VARCHAR(255) DEFAULT '',
  closed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS disbursement_audit_logs (
  id SERIAL PRIMARY KEY,
  request_id INTEGER REFERENCES disbursement_requests(id) ON DELETE CASCADE,
  company_id INTEGER,
  action VARCHAR(100),
  actor_id INTEGER,
  actor_name VARCHAR(255),
  comment TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_disbursement_company_status ON disbursement_requests(company_id, status);
CREATE INDEX IF NOT EXISTS idx_disbursement_requester ON disbursement_requests(requester_id);
