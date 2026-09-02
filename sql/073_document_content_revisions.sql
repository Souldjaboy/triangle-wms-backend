-- 073 — CORRIGER UN DOCUMENT SANS TOUCHER AU STOCK
--
-- Un bon imprimé peut porter un mauvais numéro ou une mauvaise quantité — une
-- erreur de saisie, un import qui a mélangé deux mouvements. Le corriger est
-- légitime. Modifier le stock au passage ne l'est pas : les quantités
-- physiques ne changent pas parce qu'un papier était faux.
--
-- Cette migration ne porte donc QUE le document. Rien ici ne touche
-- `stock_movements`, `products.stock` ni `stock_location_balances`.
--
-- Deux besoins, deux mécanismes :
--
--   1. CORRIGER le contenu imprimé — numéro et quantités des lignes — en
--      gardant l'avant et l'après. Un document dont le contenu change sans
--      trace ne peut plus servir de preuve.
--
--   2. ANNULER un document erroné en le REMPLAÇANT. On ne supprime jamais :
--      un numéro déjà sorti a pu partir chez un transporteur ou un client. Il
--      reste consultable, marqué annulé, et pointe vers son remplaçant.
--
-- Strictement additive et idempotente. Aucune donnée existante n'est modifiée.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. L'HISTORIQUE DES CORRECTIONS DE CONTENU
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS document_content_revisions (
  id                   SERIAL PRIMARY KEY,
  company_id           INTEGER NOT NULL,
  document_id          INTEGER NOT NULL,
  revision             INTEGER NOT NULL,
  old_document_number  TEXT,
  new_document_number  TEXT,
  /* Les lignes entières, avant et après : une quantité corrigée ne se
     comprend qu'à côté de celles qui n'ont pas bougé. */
  old_items            JSONB,
  new_items            JSONB,
  reason               TEXT    NOT NULL,
  /* Corriger un bon déjà sorti n'est pas la même chose que corriger un
     brouillon : la distinction se lit ici, sans avoir à recouper les dates. */
  was_printed          BOOLEAN NOT NULL DEFAULT FALSE,
  changed_by           INTEGER,
  changed_by_name      TEXT,
  changed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

/* Une révision porte un numéro par document, jamais deux fois le même. */
CREATE UNIQUE INDEX IF NOT EXISTS document_content_revisions_uidx
  ON document_content_revisions (company_id, document_id, revision);

CREATE INDEX IF NOT EXISTS document_content_revisions_document_idx
  ON document_content_revisions (company_id, document_id, changed_at DESC);

-- ═════════════════════════════════════════════════════════════════════════
-- 2. ANNULER EN REMPLAÇANT
--
-- Le document annulé garde son numéro, sa date et ses lignes. Il sort des
-- listes d'impression, mais pas de l'audit : c'est la trace de ce qui a
-- réellement été remis à quelqu'un.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS cancelled_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by            INTEGER,
  ADD COLUMN IF NOT EXISTS cancelled_by_name       TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_reason     TEXT,
  ADD COLUMN IF NOT EXISTS replaced_by_document_id INTEGER,
  /* Le document qui remplace sait ce qu'il remplace : on peut remonter la
     chaîne dans les deux sens. */
  ADD COLUMN IF NOT EXISTS replaces_document_id    INTEGER;

CREATE INDEX IF NOT EXISTS documents_cancelled_idx
  ON documents (company_id, cancelled_at)
  WHERE cancelled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS documents_replacement_idx
  ON documents (company_id, replaced_by_document_id)
  WHERE replaced_by_document_id IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. UN MOUVEMENT, UN DOCUMENT ACTIF
--
-- La génération groupée doit pouvoir être rejouée sans créer de doublon, et
-- deux requêtes simultanées ne doivent pas produire deux bons pour le même
-- mouvement. C'est la base qui le garantit, pas la prudence de l'appelant.
--
-- Index PARTIEL : un document annulé libère la place pour son remplaçant.
-- Posé seulement si les données existantes le permettent — une migration ne
-- casse pas une base au passage.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE doublons INTEGER;
BEGIN
  SELECT count(*) INTO doublons FROM (
    SELECT company_id, stock_movement_id
      FROM documents
     WHERE stock_movement_id IS NOT NULL AND cancelled_at IS NULL
     GROUP BY 1, 2 HAVING count(*) > 1
  ) d;

  IF doublons > 0 THEN
    RAISE WARNING 'Unicité document/mouvement non posée : % mouvement(s) portent déjà plusieurs documents actifs. Annulez les doublons puis rejouez 073.', doublons;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS documents_mouvement_actif_uidx
      ON documents (company_id, stock_movement_id)
      WHERE stock_movement_id IS NOT NULL AND cancelled_at IS NULL;
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. DROITS
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO permission_actions (action_key, label, description, sort_order, is_write) VALUES
  ('correct_content', 'Corriger un document',
   'Modifier le numéro ou les quantités imprimées, sans toucher au stock.', 184, true),
  ('cancel_replace',  'Annuler et remplacer',
   'Marquer un document erroné comme annulé et générer son remplaçant.', 186, true)
ON CONFLICT (action_key) DO NOTHING;

UPDATE permission_modules m
   SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                    FROM unnest(m.actions || ARRAY['correct_content', 'cancel_replace']) AS a),
       updated_at = now()
 WHERE m.module_key = 'document'
   AND NOT (m.actions @> ARRAY['correct_content', 'cancel_replace']);

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_name = 'document_content_revisions') THEN
    RAISE EXCEPTION 'Sans historique, une correction de document ne serait pas vérifiable.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'documents' AND column_name = 'cancelled_at') THEN
    RAISE EXCEPTION 'Les documents ne savent pas être annulés : il faudrait les supprimer.';
  END IF;

  RAISE NOTICE 'Correction et annulation de documents : schéma conforme.';
END $$;
