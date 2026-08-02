-- 049 — Justificatifs de décaissement + remboursements (PHASES 5-8). Idempotent.
-- Complète la table EXISTANTE disbursement_requests (non modifiée) : plusieurs
-- justificatifs par demande, chacun avec son montant justifié et son contrôle.

CREATE TABLE IF NOT EXISTS disbursement_receipts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  request_id INTEGER NOT NULL REFERENCES disbursement_requests(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  amount NUMERIC(16,2) NOT NULL DEFAULT 0,   -- montant justifié par cette pièce
  label TEXT,
  review_status TEXT NOT NULL DEFAULT 'EN_ATTENTE', -- EN_ATTENTE | ACCEPTE | REFUSE | COMPLEMENT
  review_comment TEXT,
  reviewed_by INTEGER,
  reviewed_at TIMESTAMPTZ,
  uploaded_by INTEGER,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_disb_receipts_req ON disbursement_receipts (request_id, review_status);

-- Remboursements du reliquat non utilisé (créent une VRAIE entrée de trésorerie).
CREATE TABLE IF NOT EXISTS disbursement_refunds (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  request_id INTEGER NOT NULL REFERENCES disbursement_requests(id) ON DELETE CASCADE,
  amount NUMERIC(16,2) NOT NULL,
  method TEXT,
  reference TEXT,
  accounting_transaction_id INTEGER,
  comment TEXT,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_disb_refunds_req ON disbursement_refunds (request_id);
