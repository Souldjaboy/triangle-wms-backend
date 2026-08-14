-- 058 — Réceptions conteneur et mise en stock (putaway).
--
-- RÉCEPTION ≠ ENTRÉE EN STOCK. Une marchandise reçue sur le quai n'est pas
-- encore disponible : elle doit être contrôlée puis rangée à un emplacement.
-- Ces tables portent l'étape intermédiaire, absente jusqu'ici du logiciel :
-- l'audit n'a trouvé aucune table de réception générique (`receipts` relève du
-- POS, `disbursement_receipts` de la finance).
--
-- Le stock disponible n'est JAMAIS modifié par une réception. Il ne bouge qu'à
-- la mise en stock, via services/stock-operations.js — le moteur existant.
--
-- Migration ADDITIVE et idempotente : aucune table existante n'est touchée.

BEGIN;

CREATE TABLE IF NOT EXISTS stock_receptions (
  id               SERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  warehouse_id     INTEGER,
  warehouse_code   TEXT,
  reception_number TEXT    NOT NULL,
  container_number TEXT,
  reception_date   DATE    NOT NULL DEFAULT CURRENT_DATE,
  source           TEXT,                       -- feuille Excel, fournisseur…
  source_file      TEXT,
  status           TEXT    NOT NULL DEFAULT 'RECEIVED_PENDING_PUTAWAY',
  notes            TEXT,
  created_by       INTEGER,
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW()
);

-- Un même numéro de réception ne peut exister qu'une fois par entreprise.
CREATE UNIQUE INDEX IF NOT EXISTS stock_receptions_number_uidx
    ON stock_receptions (company_id, reception_number);
CREATE INDEX IF NOT EXISTS stock_receptions_status_idx
    ON stock_receptions (company_id, status);

CREATE TABLE IF NOT EXISTS stock_reception_lines (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  reception_id      INTEGER NOT NULL REFERENCES stock_receptions(id) ON DELETE CASCADE,
  line_no           INTEGER,
  received_label    TEXT    NOT NULL,          -- libellé EXACT du document reçu
  /* product_id volontairement NULLABLE : une marchandise peut arriver avant que
     sa fiche produit existe. La correspondance est confirmée à la mise en
     stock, jamais devinée à la réception. */
  product_id        INTEGER,
  match_status      TEXT    NOT NULL DEFAULT 'TO_REVIEW',
  supplier_reference TEXT,
  unit              TEXT    DEFAULT 'EACH',
  quantity_received NUMERIC NOT NULL,
  quantity_checked  NUMERIC DEFAULT 0,
  quantity_putaway  NUMERIC NOT NULL DEFAULT 0,
  excel_sheet       TEXT,
  excel_row         INTEGER,
  notes             TEXT,
  created_at        TIMESTAMP DEFAULT NOW(),
  updated_at        TIMESTAMP DEFAULT NOW(),
  /* Garde-fou en base : on ne peut jamais ranger plus que ce qui a été reçu,
     ni une quantité négative. */
  CONSTRAINT stock_reception_lines_putaway_chk
    CHECK (quantity_putaway >= 0 AND quantity_putaway <= quantity_received)
);

CREATE INDEX IF NOT EXISTS stock_reception_lines_reception_idx
    ON stock_reception_lines (company_id, reception_id);

-- Journal des mises en stock : chaque rangement partiel reste traçable.
CREATE TABLE IF NOT EXISTS stock_putaways (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  reception_id      INTEGER NOT NULL REFERENCES stock_receptions(id) ON DELETE CASCADE,
  reception_line_id INTEGER NOT NULL REFERENCES stock_reception_lines(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL,
  movement_id       INTEGER,                   -- mouvement de stock produit
  document_id       INTEGER,                   -- bon de mise en stock
  quantity          NUMERIC NOT NULL,
  stock_before      NUMERIC,
  stock_after       NUMERIC,
  warehouse_code    TEXT,
  location_id       INTEGER,
  location_code     TEXT,
  rayon_code        TEXT,
  case_code         TEXT,
  level_code        TEXT,
  bin_code          TEXT,
  created_by        INTEGER,
  created_at        TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stock_putaways_reception_idx
    ON stock_putaways (company_id, reception_id);

-- Rattachement d'un mouvement à la réception qui l'a produit.
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS reception_id INTEGER;

CREATE INDEX IF NOT EXISTS stock_movements_reception_idx
    ON stock_movements (company_id, reception_id)
 WHERE reception_id IS NOT NULL;

COMMIT;
