-- Base schema for disbursement requests.
-- Kept separate so a clean database can apply migration 049 safely.
CREATE TABLE IF NOT EXISTS disbursement_requests (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  request_number TEXT UNIQUE,
  requester_id INTEGER,
  requester_name TEXT DEFAULT '',
  requester_role TEXT DEFAULT '',
  beneficiary_name TEXT,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_disbursed NUMERIC(14,2) DEFAULT 0,
  category TEXT,
  urgency TEXT DEFAULT 'normale',
  reason TEXT NOT NULL DEFAULT '',
  disbursement_comment TEXT DEFAULT '';

  description TEXT DEFAULT '',
  status TEXT DEFAULT 'brouillon',
  payment_method TEXT,
  initial_attachment_url TEXT,
  receipt_url TEXT,
  receipt_uploaded_at TIMESTAMP,
  approved_by INTEGER,
  approved_by_name TEXT,
  approved_at TIMESTAMP,
  disbursed_by INTEGER,
  disbursed_by_name TEXT,
  disbursed_at TIMESTAMP,
  closed_by INTEGER,
  closed_by_name TEXT,
  closed_at TIMESTAMP,
  rejection_reason TEXT,
  approval_comment TEXT,
  voucher_number TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_disbursement_requests_company ON disbursement_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_disbursement_requests_status ON disbursement_requests(status);
CREATE INDEX IF NOT EXISTS idx_disbursement_requests_created_at ON disbursement_requests(created_at);
