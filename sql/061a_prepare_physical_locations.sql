-- 061a — Consolidation des emplacements physiques.  *** PROPOSITION — NON EXÉCUTÉE ***
--
-- S'exécute AVANT 061. Objectif unique : faire qu'un même bac physique ne soit
-- représenté que par UNE ligne de `locations`, pour que l'index unique de 061
-- puisse être créé.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS :
--   - elle ne fusionne AUCUN produit. Un bac contenant trois articles reste un
--     bac contenant trois articles ; ils auront trois balances en 061 ;
--   - elle ne modifie AUCUN products.stock. Aucune entrée, aucune sortie,
--     aucun ajustement, aucun write-off. Le total reste ce qu'il était ;
--   - elle ne SUPPRIME aucune ligne. Les doublons sont désactivés et gardent
--     leur trace, la traçabilité reste intacte ;
--   - elle ne consolide RIEN de sa propre initiative : seules les paires
--     explicitement inscrites au §2 ci-dessous sont traitées.
--
-- Elle est idempotente : un rejeu ne déplace rien de plus.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- §1 — GARDE : le stock global ne doit pas bouger d'une seule unité.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _stock_avant ON COMMIT DROP AS
SELECT company_id, COALESCE(SUM(stock), 0)::numeric AS total
  FROM products WHERE COALESCE(is_active, TRUE) = TRUE GROUP BY company_id;

-- ═════════════════════════════════════════════════════════════════════════
-- §2 — PAIRES VALIDÉES  ← À REMPLIR DEPUIS LE PREVIEW, ET SEULEMENT LUI
--
-- Chaque ligne : (entreprise, emplacement canonique à CONSERVER, doublons à
-- rattacher). Ces valeurs proviennent de la ligne « Paire validée à reporter »
-- de preview-location-consolidation.js, groupe par groupe, après lecture.
--
-- N'inscrire ici QUE les groupes marqués CONSOLIDATE. Les groupes
-- TO_REVIEW_BIN_STRUCTURE, LEGACY_PLACEHOLDER, WRITE_OFF_EXCLUDE et
-- LOCATION_UNRESOLVED n'y figurent jamais.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _plan (company_id INT, canonical_id INT, duplicate_ids INT[])
  ON COMMIT DROP;

INSERT INTO _plan (company_id, canonical_id, duplicate_ids) VALUES
  -- (COMPANY_ID, CANONIQUE, ARRAY[doublons]),
  -- exemple :  (7, 1042, ARRAY[1087, 1131]),
  (NULL, NULL, NULL);           -- ligne sentinelle, retirée juste après

DELETE FROM _plan WHERE canonical_id IS NULL;

/* Refus net si le plan est vide : mieux vaut ne rien faire que laisser croire
   qu'une consolidation a eu lieu. */
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM _plan) = 0 THEN
    RAISE EXCEPTION 'Plan de consolidation vide : renseignez le §2 depuis le preview avant d''exécuter 061a.';
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- §3 — CONTRÔLES DE COHÉRENCE avant toute écriture.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r RECORD; d INT;
BEGIN
  FOR r IN SELECT * FROM _plan LOOP
    PERFORM 1 FROM locations
      WHERE id = r.canonical_id AND company_id = r.company_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Emplacement canonique % introuvable pour l''entreprise %',
        r.canonical_id, r.company_id;
    END IF;

    FOREACH d IN ARRAY r.duplicate_ids LOOP
      IF d = r.canonical_id THEN
        RAISE EXCEPTION 'L''emplacement % est à la fois canonique et doublon.', d;
      END IF;
      PERFORM 1 FROM locations WHERE id = d AND company_id = r.company_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Doublon % introuvable pour l''entreprise %', d, r.company_id;
      END IF;

      /* Le canonique et son doublon doivent désigner le MÊME bac physique.
         Sinon on déplacerait de l'historique vers un autre endroit. */
      IF NOT EXISTS (
        SELECT 1 FROM locations a, locations b
         WHERE a.id = r.canonical_id AND b.id = d
           AND COALESCE(a.warehouse_id, -1) = COALESCE(b.warehouse_id, -1)
           AND UPPER(TRIM(COALESCE(NULLIF(a.rayon_code,''), a.zone, '')))
             = UPPER(TRIM(COALESCE(NULLIF(b.rayon_code,''), b.zone, '')))
           AND UPPER(TRIM(COALESCE(NULLIF(a.case_code,''), a.rayon, '')))
             = UPPER(TRIM(COALESCE(NULLIF(b.case_code,''), b.rayon, '')))
           AND UPPER(TRIM(COALESCE(NULLIF(a.level_code,''), a.etagere, '')))
             = UPPER(TRIM(COALESCE(NULLIF(b.level_code,''), b.etagere, '')))
           AND UPPER(TRIM(COALESCE(a.bin_code, ''))) = UPPER(TRIM(COALESCE(b.bin_code, '')))
      ) THEN
        RAISE EXCEPTION
          'Emplacements % et % ne désignent pas le même bac physique : consolidation refusée.',
          r.canonical_id, d;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- §4 — RÉAFFECTATION DE TOUTES LES RÉFÉRENCES.
--
-- Les colonnes ne sont pas listées en dur : elles sont DÉCOUVERTES dans le
-- catalogue. Une colonne `*location_id` ajoutée demain sera traitée sans
-- modifier ce fichier — y compris celles sans contrainte FK déclarée, qui ne
-- sont protégées par rien.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r RECORD; col RECORD; deplacees BIGINT := 0; nb BIGINT;
BEGIN
  FOR col IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = c.table_schema
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND c.column_name ~ '(^|_)location_id$'
       AND c.table_name <> 'locations'
       /* Une colonne homonyme peut référencer une AUTRE table :
          travel_routes.origin_location_id pointe vers geo_locations. La
          réaffecter par similitude de nom corromprait MaliLink Voyage. */
       AND NOT EXISTS (
         SELECT 1 FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_name = c.table_name
            AND kcu.column_name = c.column_name
            AND ccu.table_name <> 'locations')
  LOOP
    FOR r IN SELECT * FROM _plan LOOP
      EXECUTE format(
        'UPDATE %I SET %I = $1 WHERE %I = ANY($2)',
        col.table_name, col.column_name, col.column_name
      ) USING r.canonical_id, r.duplicate_ids;
      GET DIAGNOSTICS nb = ROW_COUNT;
      deplacees := deplacees + nb;
    END LOOP;
  END LOOP;
  RAISE NOTICE '061a : % référence(s) réaffectée(s) vers les emplacements canoniques.', deplacees;
END $$;

/* `inventory_history` référence l'emplacement par son CODE, pas par son id :
   les lignes historiques doivent pointer vers le code du canonique. */
UPDATE inventory_history i
   SET location_code = c.emplacement_code
  FROM _plan p
  JOIN locations c ON c.id = p.canonical_id
  JOIN locations d ON d.id = ANY(p.duplicate_ids)
 WHERE i.company_id = p.company_id
   AND COALESCE(d.emplacement_code, '') <> ''
   AND UPPER(TRIM(COALESCE(i.location_code, ''))) = UPPER(TRIM(d.emplacement_code))
   AND UPPER(TRIM(COALESCE(i.location_code, ''))) <> UPPER(TRIM(COALESCE(c.emplacement_code, '')));

-- ═════════════════════════════════════════════════════════════════════════
-- §5 — DÉSACTIVATION DES DOUBLONS. Aucune suppression.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS is_active            BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS occupancy_status     TEXT DEFAULT 'EMPTY',
  ADD COLUMN IF NOT EXISTS full_code            TEXT,
  ADD COLUMN IF NOT EXISTS merged_into_location_id INTEGER,
  ADD COLUMN IF NOT EXISTS merged_at            TIMESTAMP;

UPDATE locations d
   SET is_active = FALSE,
       occupancy_status = 'INACTIVE',
       full_code = NULL,                     -- sort de l'index unique de 061
       merged_into_location_id = p.canonical_id,
       merged_at = NOW(),
       updated_at = NOW()
  FROM _plan p
 WHERE d.id = ANY(p.duplicate_ids)
   AND d.company_id = p.company_id
   AND COALESCE(d.merged_into_location_id, 0) <> p.canonical_id;

-- ═════════════════════════════════════════════════════════════════════════
-- §6 — WRITE OFF : un état du produit, pas un bac physique.
--
-- Le stock de ces produits n'est PAS touché : SMART DISPLAY, VIENJIC URINOIRE,
-- PROJECTEUR et les autres gardent leur quantité. Ils deviennent simplement
-- non localisés, donc TO_REVIEW_LOCATION, jusqu'à obtenir un vrai bac.
-- ═════════════════════════════════════════════════════════════════════════
UPDATE locations
   SET is_active = FALSE, occupancy_status = 'INACTIVE', full_code = NULL, updated_at = NOW()
 WHERE (COALESCE(warehouse_code,'') || ' ' || COALESCE(zone,'') || ' ' ||
        COALESCE(rayon,'') || ' ' || COALESCE(etagere,'') || ' ' ||
        COALESCE(rayon_code,'') || ' ' || COALESCE(case_code,'') || ' ' ||
        COALESCE(level_code,'') || ' ' || COALESCE(bin_code,'') || ' ' ||
        COALESCE(emplacement_code,''))
       ~* '(WRITE[[:space:]_-]*OFF|\mREBUT\M|\mCASSE\M)'
   AND COALESCE(is_active, TRUE) = TRUE;

-- ═════════════════════════════════════════════════════════════════════════
-- §7 — BIN NON PRÉCISÉ : marqueur « à localiser », jamais un bac disponible.
-- ═════════════════════════════════════════════════════════════════════════
UPDATE locations
   SET occupancy_status = 'INACTIVE', full_code = NULL, updated_at = NOW()
 WHERE (COALESCE(bin_code,'') = ''
        OR bin_code ~* '(NON[[:space:]_-]*PRECISE|NON[[:space:]_-]*PRÉCIS|\mINCONNU\M|\mDIVERS\M)')
   AND COALESCE(full_code, '') <> '';

-- ═════════════════════════════════════════════════════════════════════════
-- §8 — products.location_id ne doit jamais pointer vers un doublon désactivé.
-- ═════════════════════════════════════════════════════════════════════════
UPDATE products p
   SET location_id = l.merged_into_location_id, updated_at = NOW()
  FROM locations l
 WHERE p.location_id = l.id
   AND l.merged_into_location_id IS NOT NULL
   AND p.company_id = l.company_id;

-- ═════════════════════════════════════════════════════════════════════════
-- §9 — VÉRIFICATIONS FINALES. Toute anomalie annule TOUT.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE col RECORD; orphelines BIGINT; ecart RECORD;
BEGIN
  -- 9.1 aucune référence ne doit encore pointer vers un doublon désactivé
  FOR col IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = c.table_schema
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND c.column_name ~ '(^|_)location_id$' AND c.table_name <> 'locations'
       AND NOT EXISTS (
         SELECT 1 FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_name = c.table_name
            AND kcu.column_name = c.column_name
            AND ccu.table_name <> 'locations')
  LOOP
    EXECUTE format(
      'SELECT COUNT(*) FROM %I x JOIN _plan p ON x.%I = ANY(p.duplicate_ids)',
      col.table_name, col.column_name
    ) INTO orphelines;
    IF orphelines > 0 THEN
      RAISE EXCEPTION '%.% pointe encore % fois vers un doublon désactivé.',
        col.table_name, col.column_name, orphelines;
    END IF;
  END LOOP;

  -- 9.2 le stock global doit être STRICTEMENT identique
  FOR ecart IN
    SELECT a.company_id, a.total AS avant,
           COALESCE(SUM(p.stock), 0)::numeric AS apres
      FROM _stock_avant a
      LEFT JOIN products p
        ON p.company_id = a.company_id AND COALESCE(p.is_active, TRUE) = TRUE
     GROUP BY a.company_id, a.total
    HAVING a.total <> COALESCE(SUM(p.stock), 0)::numeric
  LOOP
    RAISE EXCEPTION
      'Stock modifié pour l''entreprise % : % avant, % après. Annulation totale.',
      ecart.company_id, ecart.avant, ecart.apres;
  END LOOP;

  RAISE NOTICE '061a : contrôles passés, stock global inchangé.';
END $$;

COMMIT;
