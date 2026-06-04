-- Triangle WMS Pro - Stabilisation globale
-- Migration additive uniquement. Ne supprime aucune donnee.

CREATE TABLE IF NOT EXISTS number_counters (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT 0,
  counter_key TEXT NOT NULL,
  last_value INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, counter_key)
);

CREATE INDEX IF NOT EXISTS idx_number_counters_key
  ON number_counters(company_id, counter_key);
