BEGIN;

CREATE TABLE IF NOT EXISTS stock_import_stock_allocations (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  batch_id bigint REFERENCES stock_import_batches(id) ON DELETE SET NULL,
  file_sha256 text NOT NULL,
  excel_sheet text NOT NULL,
  excel_row integer NOT NULL,
  expected_quantity numeric(14,3) NOT NULL CHECK (expected_quantity >= 0),
  allocation jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','VALIDATED','REOPENED')),
  version integer NOT NULL DEFAULT 1,
  validated_by integer REFERENCES users(id) ON DELETE SET NULL,
  validated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, file_sha256, excel_sheet, excel_row)
);

CREATE TABLE IF NOT EXISTS stock_import_movement_events (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  batch_id bigint REFERENCES stock_import_batches(id) ON DELETE SET NULL,
  file_sha256 text NOT NULL,
  excel_sheet text NOT NULL,
  excel_row integer NOT NULL,
  excel_cell text,
  event_key text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('IN','OUT','TRANSFER_SOURCE','TRANSFER_DESTINATION')),
  effective_date date NOT NULL,
  event_sequence integer NOT NULL DEFAULT 1 CHECK (event_sequence > 0),
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  allowed_bins jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PENDING_ALLOCATION'
    CHECK (status IN ('PENDING_ALLOCATION','READY','IMPORTED','CANCELLED')),
  movement_id integer REFERENCES stock_movements(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, event_key),
  UNIQUE (company_id, file_sha256, excel_sheet, excel_row, direction, effective_date, event_sequence)
);

CREATE TABLE IF NOT EXISTS stock_import_movement_allocations (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  movement_event_id bigint NOT NULL UNIQUE REFERENCES stock_import_movement_events(id) ON DELETE CASCADE,
  expected_quantity numeric(14,3) NOT NULL CHECK (expected_quantity > 0),
  allocation jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','VALIDATED','REOPENED')),
  version integer NOT NULL DEFAULT 1,
  validated_by integer REFERENCES users(id) ON DELETE SET NULL,
  validated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_import_allocation_audit (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('STOCK_ALLOCATION','MOVEMENT_ALLOCATION','MOVEMENT_EVENT')),
  entity_id bigint NOT NULL,
  action text NOT NULL CHECK (action IN ('CREATE','VALIDATE','REOPEN','CORRECT','IMPORT')),
  before_value jsonb,
  after_value jsonb,
  reason text,
  actor_id integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_import_movement_events_source_idx
  ON stock_import_movement_events(company_id, file_sha256, excel_sheet, excel_row, direction);
CREATE INDEX IF NOT EXISTS stock_import_allocation_audit_entity_idx
  ON stock_import_allocation_audit(company_id, entity_type, entity_id, created_at);

INSERT INTO permission_actions (action_key,label,description,sort_order,is_write)
VALUES ('import_reopen','Réouvrir une répartition',
        'Réouvrir une répartition déjà validée avec un motif.',178,true)
ON CONFLICT (action_key) DO NOTHING;

UPDATE permission_modules
SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                 FROM unnest(actions || ARRAY['import_reopen']) AS a),
    updated_at = now()
WHERE module_key = 'stock.import';

COMMIT;
