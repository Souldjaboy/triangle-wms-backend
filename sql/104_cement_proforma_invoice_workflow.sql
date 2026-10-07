-- Proforma -> facture : traçabilité et anti-doublon, isolées par société.
ALTER TABLE cement_invoices
  ADD COLUMN IF NOT EXISTS proforma_id BIGINT REFERENCES cement_proformas(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cement_invoice_company_proforma
  ON cement_invoices(company_id, proforma_id)
  WHERE proforma_id IS NOT NULL;

ALTER TABLE cement_proformas DROP CONSTRAINT IF EXISTS cement_proforma_status_chk;
ALTER TABLE cement_proformas
  ADD CONSTRAINT cement_proforma_status_chk
  CHECK (status IN ('BROUILLON','VALIDEE','ACCEPTEE','REFUSEE','ANNULEE','FACTUREE'));

ALTER TABLE cement_proformas
  ADD COLUMN IF NOT EXISTS converted_invoice_id BIGINT REFERENCES cement_invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS converted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cement_proforma_converted_invoice
  ON cement_proformas(company_id, converted_invoice_id)
  WHERE converted_invoice_id IS NOT NULL;
