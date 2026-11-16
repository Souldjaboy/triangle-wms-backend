-- CANDIDAT : exécuter uniquement après audit du schéma réel et sauvegarde.
-- Aucune quantité, aucun emplacement métier n'est créé ou modifié.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS dt_layouts (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  base_id BIGINT REFERENCES dt_layouts(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published','archived')),
  high_threshold NUMERIC NOT NULL DEFAULT 80 CHECK(high_threshold > 0 AND high_threshold < 100),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  UNIQUE(id,company_id,warehouse_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS dt_one_published ON dt_layouts(company_id,warehouse_id) WHERE state='published';
CREATE INDEX IF NOT EXISTS dt_layout_history ON dt_layouts(company_id,warehouse_id,id DESC);
CREATE TABLE IF NOT EXISTS dt_nodes (
  layout_id BIGINT NOT NULL REFERENCES dt_layouts(id) ON DELETE RESTRICT,
  id UUID NOT NULL,
  parent_id UUID,
  kind TEXT NOT NULL CHECK(kind IN ('warehouse','zone','aisle','rack','level','bin')),
  code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 100),
  name TEXT NOT NULL DEFAULT '',
  zone_type TEXT,
  location_id INTEGER REFERENCES locations(id) ON DELETE RESTRICT,
  geometry JSONB,
  capacity NUMERIC CHECK(capacity > 0),
  capacity_unit TEXT,
  operational_state TEXT NOT NULL DEFAULT 'active' CHECK(operational_state IN ('active','blocked','quarantine','maintenance','inactive')),
  PRIMARY KEY(layout_id,id),
  FOREIGN KEY(layout_id,parent_id) REFERENCES dt_nodes(layout_id,id) DEFERRABLE INITIALLY DEFERRED,
  CHECK((kind='bin') = (location_id IS NOT NULL)),
  CHECK((capacity IS NULL) = (capacity_unit IS NULL)),
  CHECK(kind='bin' OR capacity IS NULL),
  UNIQUE(layout_id,location_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS dt_node_code ON dt_nodes(layout_id,COALESCE(parent_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(code));
CREATE INDEX IF NOT EXISTS dt_node_parent ON dt_nodes(layout_id,parent_id);
-- Périmètre additionnel explicite. Aucun droit attribué par défaut.
CREATE TABLE IF NOT EXISTS dt_warehouse_access (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  PRIMARY KEY(company_id,user_id,warehouse_id)
);
COMMIT;
