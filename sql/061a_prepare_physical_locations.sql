-- 061a — Consolidation des emplacements physiques.
--
-- S'exécute AVANT 061, et seule. Objectif unique : qu'un même bac physique ne
-- soit plus représenté que par UNE ligne de `locations`.
--
-- APPEL OBLIGATOIRE — les deux variables sont exigées :
--   psql -v ON_ERROR_STOP=1 -v company_id=<ID> -v expected_groups=7 \
--        -f sql/061a_prepare_physical_locations.sql
--
-- POURQUOI LES GROUPES SONT DÉRIVÉS ET NON RECOPIÉS :
--   recopier sept triplets d'identifiants à la main est une source d'erreur
--   silencieuse — un chiffre faux consolide le mauvais bac. La migration
--   applique donc EXACTEMENT les mêmes règles que le preview, puis EXIGE d'en
--   trouver `expected_groups`. Si elle en trouve un de plus ou un de moins,
--   elle refuse tout : le désaccord avec le preview validé est un signal
--   d'arrêt, pas quelque chose à contourner.
--
-- CE QU'ELLE NE FAIT PAS :
--   - aucun produit n'est fusionné. Un bac contenant trois articles reste un
--     bac contenant trois articles ; ils auront trois balances en 061 ;
--   - aucun products.stock n'est modifié. Ni entrée, ni sortie, ni ajustement,
--     ni write-off ;
--   - aucune ligne n'est supprimée. Les doublons sont désactivés et gardent
--     leur trace via merged_into_location_id ;
--   - BIN-NON-PRECISE, WRITE OFF, NOUVEAU/AUTO et les bins de type « BIN2-3 »
--     sont exclus de la consolidation, par construction.
--
-- Idempotente : un rejeu ne déplace plus rien.

\set ON_ERROR_STOP on

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- §1 — ÉTAT AVANT. Sert de témoin aux contrôles finaux.
-- ═════════════════════════════════════════════════════════════════════════
/* Les variables psql ne s'interpolent PAS à l'intérieur d'un bloc DO $$ … $$ :
   on les matérialise donc ici, hors bloc, et les contrôles les relisent. */
CREATE TEMP TABLE _params ON COMMIT DROP AS
SELECT (:company_id)::int AS company_id, (:expected_groups)::int AS expected_groups;

CREATE TEMP TABLE _avant ON COMMIT DROP AS
SELECT COALESCE(SUM(stock), 0)::numeric AS stock_total,
       COUNT(*)::int                    AS produits,
       COUNT(*) FILTER (WHERE stock < 0)::int AS negatifs
  FROM products
 WHERE company_id = :company_id AND COALESCE(is_active, TRUE) = TRUE;

CREATE TEMP TABLE _locations_avant ON COMMIT DROP AS
SELECT id, is_active, occupancy_status, full_code, merged_into_location_id
  FROM locations WHERE company_id = :company_id;

-- ═════════════════════════════════════════════════════════════════════════
-- §2 — DÉRIVATION DES GROUPES CONSOLIDABLES.
--
-- Règles identiques au preview, dans le même ordre :
--   un bac exploitable a un BIN ; les rebuts, bins non précisés, plages
--   « BIN2-3 » et composantes générées (NOUVEAU / AUTO) sont écartés.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _eligibles ON COMMIT DROP AS
SELECT l.id, l.company_id, l.warehouse_id,
       UPPER(TRIM(COALESCE(NULLIF(l.rayon_code, ''), l.zone,    ''))) AS r,
       UPPER(TRIM(COALESCE(NULLIF(l.case_code,  ''), l.rayon,   ''))) AS c,
       UPPER(TRIM(COALESCE(NULLIF(l.level_code, ''), l.etagere, ''))) AS l4,
       UPPER(TRIM(COALESCE(l.bin_code, '')))                          AS b
  FROM locations l
 WHERE l.company_id = :company_id
   AND COALESCE(l.is_active, TRUE) = TRUE
   -- un bac doit avoir un BIN
   AND COALESCE(TRIM(l.bin_code), '') <> ''
   -- ni rebut, ni bin non précisé
   AND l.bin_code !~* '(WRITE[[:space:]_-]*OFF|\mREBUT\M|\mCASSE\M|NON[[:space:]_-]*PRECISE|NON[[:space:]_-]*PRÉCIS|\mINCONNU\M|\mDIVERS\M)'
   AND COALESCE(l.warehouse_code, '')    !~* '(WRITE[[:space:]_-]*OFF|\mREBUT\M)'
   AND COALESCE(l.emplacement_code, '')  !~* '(WRITE[[:space:]_-]*OFF|\mREBUT\M)'
   -- « BIN2-3 » : un bac ou deux ? indécidable, donc écarté
   AND TRIM(l.bin_code) !~* '^(BIN[[:space:]]*)?[0-9]+[[:space:]]*[-/][[:space:]]*[0-9]+$'
   -- composantes générées automatiquement : emplacement réel non prouvé
   AND UPPER(TRIM(COALESCE(NULLIF(l.rayon_code, ''), l.zone,  ''))) !~ '^(NOUVEAU|AUTO|DEFAUT|DEFAULT|TEST|TEMP|X+|-+|0+)$'
   AND UPPER(TRIM(COALESCE(NULLIF(l.case_code,  ''), l.rayon, ''))) !~ '^(NOUVEAU|AUTO|DEFAUT|DEFAULT|TEST|TEMP|X+|-+|0+)$';

/* Références par emplacement — c'est ce qui départage la ligne canonique.
   Les colonnes sont découvertes, et celles qui pointent vers une AUTRE table
   (travel_routes.*_location_id -> geo_locations) sont exclues. */
CREATE TEMP TABLE _refs (location_id INT PRIMARY KEY, n BIGINT) ON COMMIT DROP;
INSERT INTO _refs SELECT id, 0 FROM _eligibles;

DO $$
DECLARE col RECORD;
BEGIN
  FOR col IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = c.table_schema
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND c.column_name ~ '(^|_)location_id$'
       AND c.table_name NOT IN ('locations', '_refs', '_eligibles')
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
      'UPDATE _refs SET n = n + COALESCE(s.k, 0)
         FROM (SELECT %I AS loc, COUNT(*) AS k FROM %I WHERE %I IS NOT NULL GROUP BY 1) s
        WHERE s.loc = _refs.location_id',
      col.column_name, col.table_name, col.column_name);
  END LOOP;
END $$;

/* Canonique : le plus d'historique, puis le plus petit identifiant.
   Déterministe, donc rejouable à l'identique — et identique au preview. */
CREATE TEMP TABLE _plan ON COMMIT DROP AS
WITH classe AS (
  SELECT e.*, COALESCE(f.n, 0) AS refs,
         ROW_NUMBER() OVER (
           PARTITION BY e.warehouse_id, e.r, e.c, e.l4, e.b
           ORDER BY COALESCE(f.n, 0) DESC, e.id
         ) AS rang,
         COUNT(*) OVER (PARTITION BY e.warehouse_id, e.r, e.c, e.l4, e.b) AS taille
    FROM _eligibles e LEFT JOIN _refs f ON f.location_id = e.id
)
SELECT company_id, warehouse_id, r, c, l4, b,
       MIN(id) FILTER (WHERE rang = 1)              AS canonical_id,
       ARRAY_AGG(id ORDER BY id) FILTER (WHERE rang > 1) AS duplicate_ids
  FROM classe
 WHERE taille > 1
 GROUP BY company_id, warehouse_id, r, c, l4, b;

-- ═════════════════════════════════════════════════════════════════════════
-- §3 — ACCORD AVEC LE PREVIEW VALIDÉ. Tout écart arrête la migration.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE trouve INT; attendu INT; r RECORD;
BEGIN
  SELECT COUNT(*) INTO trouve FROM _plan;
  SELECT expected_groups INTO attendu FROM _params;

  RAISE NOTICE '─────────────────────────────────────────────────────────────';
  RAISE NOTICE '061a : % groupe(s) consolidable(s) dérivé(s).', trouve;
  FOR r IN SELECT * FROM _plan ORDER BY canonical_id LOOP
    RAISE NOTICE '  % / % / % / % / %  :  %  <-  %',
      COALESCE(r.warehouse_id::text,'?'), r.r, r.c, r.l4, r.b,
      r.canonical_id, array_to_string(r.duplicate_ids, ', ');
  END LOOP;
  RAISE NOTICE '─────────────────────────────────────────────────────────────';

  IF trouve <> attendu THEN
    RAISE EXCEPTION
      'Désaccord avec le preview validé : % groupe(s) trouvé(s), % attendu(s). Aucune consolidation appliquée.',
      trouve, attendu;
  END IF;
  IF trouve = 0 THEN
    RAISE EXCEPTION 'Aucun groupe consolidable : rien à faire.';
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- §4 — VERROUS ET CONTRÔLE DE COHÉRENCE PHYSIQUE.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r RECORD; d INT;
BEGIN
  FOR r IN SELECT * FROM _plan LOOP
    PERFORM 1 FROM locations
      WHERE id = r.canonical_id AND company_id = r.company_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Emplacement canonique % introuvable.', r.canonical_id;
    END IF;

    FOREACH d IN ARRAY r.duplicate_ids LOOP
      IF d = r.canonical_id THEN
        RAISE EXCEPTION 'L''emplacement % est à la fois canonique et doublon.', d;
      END IF;
      PERFORM 1 FROM locations WHERE id = d AND company_id = r.company_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Doublon % introuvable.', d;
      END IF;

      /* Deuxième barrière : canonique et doublon doivent désigner le MÊME bac.
         La dérivation le garantit déjà ; on le revérifie avant d'écrire. */
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
          'Emplacements % et % ne désignent pas le même bac physique : refus.',
          r.canonical_id, d;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- §5 — RÉAFFECTATION DES RÉFÉRENCES HISTORIQUES.
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
       AND c.table_name NOT IN ('locations', '_refs', '_eligibles')
       /* travel_routes.*_location_id référence geo_locations : la réaffecter
          par similitude de nom corromprait MaliLink Voyage. */
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
      EXECUTE format('UPDATE %I SET %I = $1 WHERE %I = ANY($2)',
        col.table_name, col.column_name, col.column_name)
        USING r.canonical_id, r.duplicate_ids;
      GET DIAGNOSTICS nb = ROW_COUNT;
      deplacees := deplacees + nb;
    END LOOP;
  END LOOP;
  RAISE NOTICE '061a : % référence(s) réaffectée(s).', deplacees;
END $$;

/* `inventory_history` référence l'emplacement par son CODE, pas par son id. */
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
-- §6 — DÉSACTIVATION DES DOUBLONS. Aucune suppression.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS is_active               BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS occupancy_status        TEXT DEFAULT 'EMPTY',
  ADD COLUMN IF NOT EXISTS full_code               TEXT,
  ADD COLUMN IF NOT EXISTS merged_into_location_id INTEGER,
  ADD COLUMN IF NOT EXISTS merged_at               TIMESTAMP;

UPDATE locations d
   SET is_active = FALSE,
       occupancy_status = 'INACTIVE',
       full_code = NULL,
       merged_into_location_id = p.canonical_id,
       merged_at = NOW(),
       updated_at = NOW()
  FROM _plan p
 WHERE d.id = ANY(p.duplicate_ids)
   AND d.company_id = p.company_id
   AND COALESCE(d.merged_into_location_id, 0) <> p.canonical_id;

/* products.location_id ne doit jamais pointer vers un doublon désactivé. */
UPDATE products p
   SET location_id = l.merged_into_location_id, updated_at = NOW()
  FROM locations l
 WHERE p.location_id = l.id
   AND l.merged_into_location_id IS NOT NULL
   AND p.company_id = l.company_id
   AND p.company_id = :company_id;

-- ═════════════════════════════════════════════════════════════════════════
-- §7 — CONTRÔLES FINAUX. Toute anomalie annule TOUT.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE col RECORD; orphelines BIGINT; a RECORD; ap RECORD; touchees INT; cid INT;
BEGIN
  SELECT company_id INTO cid FROM _params;
  -- 7.1 plus aucune référence vers un doublon désactivé
  FOR col IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = c.table_schema
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND c.column_name ~ '(^|_)location_id$'
       AND c.table_name NOT IN ('locations', '_refs', '_eligibles')
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
      col.table_name, col.column_name) INTO orphelines;
    IF orphelines > 0 THEN
      RAISE EXCEPTION '%.% pointe encore % fois vers un doublon désactivé.',
        col.table_name, col.column_name, orphelines;
    END IF;
  END LOOP;

  -- 7.2 stock, nombre de produits et négatifs strictement identiques
  SELECT * INTO a FROM _avant;
  SELECT COALESCE(SUM(stock), 0)::numeric AS stock_total,
         COUNT(*)::int AS produits,
         COUNT(*) FILTER (WHERE stock < 0)::int AS negatifs
    INTO ap
    FROM products WHERE company_id = cid AND COALESCE(is_active, TRUE) = TRUE;

  IF a.stock_total <> ap.stock_total THEN
    RAISE EXCEPTION 'Stock modifié : % avant, % après. Annulation.', a.stock_total, ap.stock_total;
  END IF;
  IF a.produits <> ap.produits THEN
    RAISE EXCEPTION 'Nombre de produits modifié : % avant, % après. Annulation.', a.produits, ap.produits;
  END IF;
  IF ap.negatifs > 0 THEN
    RAISE EXCEPTION 'Stock négatif apparu : % produit(s). Annulation.', ap.negatifs;
  END IF;

  -- 7.3 aucun emplacement HORS plan n'a été modifié
  SELECT COUNT(*) INTO touchees
    FROM locations n
    JOIN _locations_avant v ON v.id = n.id
   WHERE n.company_id = cid
     AND NOT EXISTS (SELECT 1 FROM _plan p WHERE n.id = ANY(p.duplicate_ids))
     AND (COALESCE(n.is_active, TRUE)             IS DISTINCT FROM COALESCE(v.is_active, TRUE)
       OR COALESCE(n.occupancy_status, '')        IS DISTINCT FROM COALESCE(v.occupancy_status, '')
       OR COALESCE(n.full_code, '')               IS DISTINCT FROM COALESCE(v.full_code, '')
       OR COALESCE(n.merged_into_location_id, 0)  IS DISTINCT FROM COALESCE(v.merged_into_location_id, 0));
  IF touchees > 0 THEN
    RAISE EXCEPTION '% emplacement(s) hors plan modifié(s). Annulation.', touchees;
  END IF;

  RAISE NOTICE '061a : contrôles passés — stock %, produits %, négatifs %, emplacements hors plan intacts.',
    ap.stock_total, ap.produits, ap.negatifs;
END $$;

COMMIT;
