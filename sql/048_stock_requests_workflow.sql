-- 048 — Workflows stock (PHASES 3-10). Idempotent, additif.
-- Demandes MULTI-PRODUITS (entrée/sortie/transfert/inventaire) + réception +
-- documents (bon de réception) + audit. Isolation stricte company_id.
-- RÈGLE : aucune ligne de ces tables ne modifie le stock ; le stock ne bouge
-- qu'à la confirmation de réception/sortie (voir routes/stock-workflow.js).

CREATE TABLE IF NOT EXISTS stock_requests (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  reference TEXT NOT NULL,                    -- DE-2026-00001 / DS- / TR- / IN-
  request_type TEXT NOT NULL,                 -- entree | sortie | transfert | inventaire
  status TEXT NOT NULL DEFAULT 'BROUILLON',   -- BROUILLON|EN_ATTENTE|VALIDEE|REFUSEE|PARTIELLEMENT_RECUE|RECUE|ANNULEE
  supplier_name TEXT,
  partner_id INTEGER,
  source_warehouse TEXT,
  source_location TEXT,
  target_warehouse TEXT,
  target_location TEXT,
  motif TEXT,
  observations TEXT,
  reject_reason TEXT,
  requested_by INTEGER,
  validated_by INTEGER,
  received_by INTEGER,
  cancelled_by INTEGER,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  validated_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, reference)
);
CREATE INDEX IF NOT EXISTS idx_stock_requests_co ON stock_requests (company_id, status, request_type);

-- Lignes : une demande contient N produits (5, 20, 50…).
CREATE TABLE IF NOT EXISTS stock_request_lines (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  request_id INTEGER NOT NULL REFERENCES stock_requests(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id INTEGER,
  product_reference TEXT,
  product_name TEXT NOT NULL,
  unit TEXT,
  quantity_requested NUMERIC(16,3) NOT NULL DEFAULT 0,
  quantity_received NUMERIC(16,3) NOT NULL DEFAULT 0,  -- rempli à la confirmation
  unit_price NUMERIC(16,2),
  warehouse TEXT,
  location_code TEXT,
  observation TEXT,
  movement_id INTEGER,                        -- mouvement créé à la confirmation
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_request_lines_req ON stock_request_lines (request_id, line_no);

CREATE TABLE IF NOT EXISTS stock_request_counters (
  company_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  prefix TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, year, prefix)
);

-- Documents (bon de réception / sortie / transfert). PHASE 8-9.
CREATE TABLE IF NOT EXISTS stock_documents (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  request_id INTEGER REFERENCES stock_requests(id) ON DELETE SET NULL,
  doc_number TEXT NOT NULL,                   -- BR-2026-00001
  doc_type TEXT NOT NULL DEFAULT 'reception', -- reception | sortie | transfert
  status TEXT NOT NULL DEFAULT 'BROUILLON',   -- BROUILLON | VALIDE | ANNULE
  -- Bloc RÉCEPTIONNÉ PAR (pré-rempli si connu)
  received_by_name TEXT,
  received_by_function TEXT,
  received_at_date DATE,
  received_at_time TEXT,
  -- Bloc LIVRÉ PAR
  delivered_by_name TEXT,
  delivered_by_function TEXT,
  delivered_at_date DATE,
  delivered_at_time TEXT,
  generated_by INTEGER,
  validated_by INTEGER,
  validated_at TIMESTAMPTZ,
  cancelled_by INTEGER,
  cancelled_at TIMESTAMPTZ,
  print_count INTEGER NOT NULL DEFAULT 0,
  last_printed_by INTEGER,
  last_printed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, doc_number)
);
CREATE INDEX IF NOT EXISTS idx_stock_documents_co ON stock_documents (company_id, status);

-- Audit stock (PHASE 10).
CREATE TABLE IF NOT EXISTS stock_audit_logs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,                       -- create|update|validate|reject|receive|cancel|print|reprint
  entity TEXT NOT NULL,                       -- stock_request | stock_document
  entity_id INTEGER,
  reference TEXT,
  old_value JSONB,
  new_value JSONB,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_audit_co ON stock_audit_logs (company_id, created_at DESC);
