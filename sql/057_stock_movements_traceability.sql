-- 057 — Traçabilité réelle des mouvements de stock.
--
-- stock_movements ne conservait ni l'état AVANT ni l'état APRÈS : impossible de
-- reconstituer l'histoire d'un produit (« stock initial -> entrée -> sortie ->
-- stock actuel »). Les colonnes original_quantity / final_quantity portent la
-- quantité du mouvement, pas le solde du produit.
--
-- Le rattachement se faisait aussi par product_reference (une chaîne) : deux
-- produits partageant une référence étaient indiscernables. product_id devient
-- la clé métier des NOUVEAUX mouvements ; product_reference est conservée pour
-- l'historique et la compatibilité.
--
-- Migration ADDITIVE et non destructive : aucune ligne modifiée, aucune valeur
-- existante réécrite. L'historique ancien garde stock_before/stock_after à NULL
-- — ces valeurs ne sont pas reconstituables de façon certaine et il serait
-- malhonnête d'inventer un solde passé. Rejouable sans erreur.

BEGIN;

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS stock_before NUMERIC,
  ADD COLUMN IF NOT EXISTS stock_after  NUMERIC,
  -- Rattachement à l'import d'inventaire qui a produit le mouvement, s'il y a lieu.
  ADD COLUMN IF NOT EXISTS import_id INTEGER,
  ADD COLUMN IF NOT EXISTS source_reference TEXT;

-- product_id peut déjà exister selon l'historique du schéma.
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS product_id INTEGER;

-- Rattachement des mouvements d'un produit et des mouvements d'un import.
CREATE INDEX IF NOT EXISTS stock_movements_product_idx
    ON stock_movements (company_id, product_id);
CREATE INDEX IF NOT EXISTS stock_movements_import_idx
    ON stock_movements (company_id, import_id)
 WHERE import_id IS NOT NULL;

-- Journal des imports d'inventaire : empreinte SHA-256 pour l'idempotence.
CREATE TABLE IF NOT EXISTS inventory_imports (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL,
  file_name     TEXT    NOT NULL,
  file_hash     TEXT    NOT NULL,
  imported_by   INTEGER,
  imported_at   TIMESTAMP DEFAULT NOW(),
  status        TEXT    NOT NULL DEFAULT 'PENDING',
  rows_read     INTEGER DEFAULT 0,
  rows_imported INTEGER DEFAULT 0,
  rows_skipped  INTEGER DEFAULT 0,
  rows_error    INTEGER DEFAULT 0,
  summary       JSONB,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

-- Un même fichier ne peut être importé qu'UNE fois avec succès par entreprise.
-- L'index partiel laisse rejouer un import échoué ou annulé.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_imports_hash_uidx
    ON inventory_imports (company_id, file_hash)
 WHERE status = 'COMPLETED';

COMMIT;
