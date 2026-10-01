BEGIN;

CREATE TABLE IF NOT EXISTS sand_invoice_statements (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  statement_number TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invoices_count INTEGER NOT NULL DEFAULT 0 CHECK (invoices_count >= 0),
  total_invoiced NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_paid NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_remaining NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_m3 NUMERIC(18,3) NOT NULL DEFAULT 0,
  period_from DATE,
  period_to DATE,
  print_count INTEGER NOT NULL DEFAULT 0,
  last_printed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, statement_number)
);

CREATE TABLE IF NOT EXISTS sand_invoice_statement_items (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  statement_id BIGINT NOT NULL REFERENCES sand_invoice_statements(id) ON DELETE CASCADE,
  invoice_id INTEGER NOT NULL REFERENCES sand_invoices(id) ON DELETE RESTRICT,
  invoice_number TEXT NOT NULL,
  invoice_date DATE,
  client_name TEXT,
  site TEXT,
  quantity_m3 NUMERIC(18,3),
  total_amount_snapshot NUMERIC(18,2) NOT NULL DEFAULT 0,
  paid_amount_snapshot NUMERIC(18,2) NOT NULL DEFAULT 0,
  remaining_amount_snapshot NUMERIC(18,2) NOT NULL DEFAULT 0,
  status_snapshot TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_sand_statements_company_date
  ON sand_invoice_statements(company_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sand_statement_items_statement
  ON sand_invoice_statement_items(company_id, statement_id);

COMMIT;
