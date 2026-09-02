-- 074 — UN BON PAR ÉVÉNEMENT MÉTIER, PAS PAR MOUVEMENT CONSOLIDÉ
--
-- L'ancien chemin d'import consolidait plusieurs sorties d'un même produit en
-- un seul `stock_movements`. Trois sorties de STADE 4 AOUT — 7, 7 et 6, faites
-- trois fois le même jour — deviennent un mouvement unique de 20. Deux sorties
-- de PROFESSIONAL AMPLIFIER POWER, 2 le 29 juillet et 3 le 25 août, deviennent
-- un mouvement de 5.
--
-- Ce mouvement de 20 ne correspond à aucun bon que quelqu'un puisse signer :
-- personne n'a sorti 20 pièces en une fois. Les trois sorties réelles sont
-- décrites dans `stock_import_movement_events`, une ligne par événement, avec
-- sa date, sa quantité et sa cellule d'origine. C'est à ce niveau-là que se
-- fabriquent les bons.
--
-- La migration 073 imposait « un document actif par mouvement ». Bien pour un
-- mouvement qui représente une seule opération ; bloquant dès qu'il en
-- représente trois. Cette règle est donc DÉPLACÉE, pas supprimée :
--
--   • un document rattaché à un événement    → unique par ÉVÉNEMENT ;
--   • un document sans événement (saisie
--     manuelle, ancien import)               → unique par MOUVEMENT, comme avant.
--
-- Aucune ligne existante n'est modifiée. Rien ici ne touche `products.stock`,
-- `stock_movements`, `stock_location_balances`, les inventaires, les
-- réceptions, les utilisateurs ni les permissions.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. LE LIEN VERS L'ÉVÉNEMENT MÉTIER
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS stock_import_movement_event_id BIGINT
    REFERENCES stock_import_movement_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS documents_evenement_idx
  ON documents (company_id, stock_import_movement_event_id)
  WHERE stock_import_movement_event_id IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. UN SEUL DOCUMENT ACTIF PAR ÉVÉNEMENT
--
-- C'est la garantie qui remplace celle de 073 pour les bons issus d'un
-- import : rejouer une génération groupée ne duplique rien, et deux requêtes
-- simultanées ne produisent pas deux bons pour la même sortie.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE doublons INTEGER;
BEGIN
  SELECT count(*) INTO doublons FROM (
    SELECT company_id, stock_import_movement_event_id
      FROM documents
     WHERE stock_import_movement_event_id IS NOT NULL AND cancelled_at IS NULL
     GROUP BY 1, 2 HAVING count(*) > 1
  ) d;

  IF doublons > 0 THEN
    RAISE WARNING 'Unicité document/événement non posée : % événement(s) portent déjà plusieurs documents actifs. Annulez les doublons puis rejouez 074.', doublons;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS documents_evenement_actif_uidx
      ON documents (company_id, stock_import_movement_event_id)
      WHERE stock_import_movement_event_id IS NOT NULL AND cancelled_at IS NULL;
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. LA PROTECTION PAR MOUVEMENT, RESSERRÉE
--
-- Elle ne doit plus s'appliquer aux documents rattachés à un événement : un
-- mouvement consolidé de 20 porte légitimement trois bons de 7, 7 et 6.
-- Elle continue de protéger tout le reste — saisies manuelles, anciens
-- imports —, où un mouvement représente bien une seule opération.
--
-- L'index de 073 est remplacé, pas retiré : la garantie survit, son périmètre
-- change. La recréation est protégée comme en 073 — une base qui porte déjà
-- des doublons reçoit un avertissement, pas une migration en échec. C'est le
-- cas de la production, où TETE DE JACK porte deux bons pour un mouvement :
-- corrigez les doublons, puis rejouez cette migration pour poser l'index.
-- ═════════════════════════════════════════════════════════════════════════
DROP INDEX IF EXISTS documents_mouvement_actif_uidx;

DO $$
DECLARE doublons INTEGER;
BEGIN
  SELECT count(*) INTO doublons FROM (
    SELECT company_id, stock_movement_id
      FROM documents
     WHERE stock_movement_id IS NOT NULL
       AND stock_import_movement_event_id IS NULL
       AND cancelled_at IS NULL
     GROUP BY 1, 2 HAVING count(*) > 1
  ) d;

  IF doublons > 0 THEN
    RAISE WARNING 'Unicité document/mouvement non posée : % mouvement(s) sans événement portent plusieurs documents actifs. Annulez les doublons puis rejouez 074.', doublons;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS documents_mouvement_actif_uidx
      ON documents (company_id, stock_movement_id)
      WHERE stock_movement_id IS NOT NULL
        AND stock_import_movement_event_id IS NULL
        AND cancelled_at IS NULL;
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. TRACER UN DOUBLON ANNULÉ
--
-- Deux bons pour une même sortie : l'un reste actif, l'autre est annulé comme
-- doublon. Sans ce motif distinct, on ne saurait plus, dans six mois,
-- pourquoi un bon régulièrement numéroté a été écarté.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS duplicate_of_document_id INTEGER;

CREATE INDEX IF NOT EXISTS documents_doublon_idx
  ON documents (company_id, duplicate_of_document_id)
  WHERE duplicate_of_document_id IS NOT NULL;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'documents'
                    AND column_name = 'stock_import_movement_event_id') THEN
    RAISE EXCEPTION 'Sans lien vers l''événement, un mouvement consolidé ne peut porter qu''un seul bon.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_indexes
              WHERE indexname = 'documents_mouvement_actif_uidx'
                AND indexdef NOT LIKE '%stock_import_movement_event_id IS NULL%') THEN
    RAISE EXCEPTION 'L''ancien index par mouvement est encore en place : il bloquerait les bons multiples d''un mouvement consolidé.';
  END IF;

  RAISE NOTICE 'Documents par événement d''import : schéma conforme.';
END $$;
