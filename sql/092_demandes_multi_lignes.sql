BEGIN;

CREATE TABLE IF NOT EXISTS disbursement_request_lines (
  id          BIGSERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  request_id  INTEGER NOT NULL REFERENCES disbursement_requests(id) ON DELETE CASCADE,
  line_no     INTEGER NOT NULL,
  category    TEXT,
  label       TEXT NOT NULL,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (request_id, line_no)
);

CREATE INDEX IF NOT EXISTS
  idx_disbursement_request_lines_company
ON disbursement_request_lines(company_id);

CREATE INDEX IF NOT EXISTS
  idx_disbursement_request_lines_request
ON disbursement_request_lines(request_id);

-- Compatibilité historique :
-- chaque ancienne demande devient automatiquement une demande à 1 ligne.
INSERT INTO disbursement_request_lines
  (
    company_id,
    request_id,
    line_no,
    category,
    label,
    amount
  )
SELECT
  r.company_id,
  r.id,
  1,
  r.category,
  COALESCE(NULLIF(BTRIM(r.reason), ''), 'Demande'),
  r.amount
FROM disbursement_requests r
WHERE r.company_id IS NOT NULL
  AND COALESCE(r.amount, 0) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM disbursement_request_lines l
    WHERE l.request_id = r.id
  );

COMMIT;
