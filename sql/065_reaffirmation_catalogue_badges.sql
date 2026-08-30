-- 065 — RÉAFFIRMATION DU CATALOGUE ET DES BADGES
--
-- La migration 064 a changé plusieurs fois pendant sa mise au point. Rien ne
-- prouve qu'une version antérieure — dépourvue des actions « archiver »,
-- « réorganiser », « audit » ou de la configuration des badges — n'a pas déjà
-- été appliquée quelque part. Elle est donc figée, et tout ce dont l'absence
-- casserait la version finale est réaffirmé ici.
--
-- 065 ne suppose rien de 064 : elle vérifie et complète. Elle répare aussi le
-- cas où 063 serait rejouée APRÈS 064 — son upsert de modules réécrit la liste
-- d'actions et ferait disparaître « archiver » et « réorganiser » sans le
-- moindre message. Rejouer 065 remet alors le catalogue en état.
--
-- Strictement additive et idempotente : aucune colonne retirée, aucune donnée
-- supprimée, aucun badge ni stock touché.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. ACTIONS DU RÉFÉRENTIEL
--
-- L'écran des emplacements interroge « archiver », « réorganiser » et
-- « audit ». Une action absente du référentiel ne porte sur rien : la
-- question reste sans réponse et le bouton demeure hors d'atteinte, quel que
-- soit le droit accordé.
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO permission_actions (action_key, label, description, sort_order, is_write) VALUES
  ('archive',    'Archiver',    'Retirer un emplacement vide de la circulation sans le supprimer.', 155, true),
  ('reorganize', 'Réorganiser', 'Renommer ou réordonner rayons, niveaux et bacs en masse.',        158, true),
  ('audit',      'Voir l''audit','Consulter le journal des opérations sur les emplacements.',      165, false)
ON CONFLICT (action_key) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. ACTIONS PORTÉES PAR LES MODULES
--
-- Réaffirmées par union : on ajoute ce qui manque sans jamais retirer ce qui
-- est déjà là. C'est ce qui rend 065 rejouable après une 063 accidentelle.
-- ═════════════════════════════════════════════════════════════════════════
UPDATE permission_modules m
   SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                    FROM unnest(m.actions || v.ajouts) AS a),
       updated_at = now()
  FROM (VALUES
    ('stock.emplacement', ARRAY['archive','reorganize','audit']),
    ('stock.transfert',   ARRAY['transfer']),
    ('reception',         ARRAY['putaway'])
  ) AS v(module_key, ajouts)
 WHERE m.module_key = v.module_key
   AND NOT (m.actions @> v.ajouts);

-- ═════════════════════════════════════════════════════════════════════════
-- 3. BADGES PAR ENTREPRISE
--
-- Le badge identifie une personne à l'entrée d'un site : il doit porter le
-- préfixe de SON entreprise. Ces colonnes sont réaffirmées au cas où une 064
-- antérieure les ignorait.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS badge_prefix   text,
  ADD COLUMN IF NOT EXISTS badge_sequence integer NOT NULL DEFAULT 0;

/* Préfixe : d'abord celui que portent déjà les badges de l'entreprise — le
   déduire du nom donnerait « TRIANGLELOGI » là où les cartes en circulation
   disent « TRIANGLE ». Un préfixe n'appartient qu'à une société : sans cette
   règle, un badge attribué par erreur donnerait le préfixe d'une entreprise
   à une autre, et l'erreur d'hier deviendrait la règle de demain. */
WITH candidats AS (
  SELECT company_id, upper(split_part(badge_code, '-', 1)) AS prefixe, count(*) AS n
    FROM users
   WHERE company_id IS NOT NULL AND COALESCE(badge_code,'') <> ''
     AND position('-' IN badge_code) > 1
   GROUP BY 1, 2
),
attribue AS (
  SELECT DISTINCT ON (prefixe) prefixe, company_id
    FROM candidats ORDER BY prefixe, n DESC, company_id
)
UPDATE companies c SET badge_prefix = a.prefixe
  FROM attribue a
 WHERE a.company_id = c.id
   AND COALESCE(NULLIF(TRIM(c.badge_prefix), ''), '') = '';

/* Faute de badge existant : mots entiers du nom tant que le total tient en
   huit caractères. « FAT & MAT Entreprise » donne FATMAT. Tronquer au
   caractère près donnerait FATMATEN, que personne ne reconnaît. */
UPDATE companies c
   SET badge_prefix = court.prefixe
  FROM (
    SELECT id,
           (SELECT string_agg(mot, '' ORDER BY rang)
              FROM (
                SELECT mot, rang, sum(length(mot)) OVER (ORDER BY rang) AS cumul
                  FROM (
                    SELECT upper(regexp_replace(m, '[^A-Za-z0-9]', '', 'g')) AS mot,
                           ordinalite AS rang
                      FROM regexp_split_to_table(
                             translate(x.name,
                               'àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ',
                               'aaaeeeeiioouuucAAAEEEEIIOOUUUC'),
                             '\s+') WITH ORDINALITY AS t(m, ordinalite)
                  ) mots
                 WHERE mot <> ''
              ) cumules
             WHERE cumul <= 8) AS prefixe
      FROM companies x
  ) court
 WHERE court.id = c.id
   AND COALESCE(NULLIF(TRIM(c.badge_prefix), ''), '') = ''
   AND COALESCE(NULLIF(TRIM(court.prefixe), ''), '') <> '';

UPDATE companies SET badge_prefix = 'ENT' || id
 WHERE COALESCE(NULLIF(TRIM(badge_prefix), ''), '') = '';

/* La séquence repart au-dessus du plus grand numéro déjà attribué : la
   génération ne doit jamais réutiliser un badge en circulation. GREATEST
   garantit qu'un rejeu ne la fait pas reculer. */
UPDATE companies c
   SET badge_sequence = GREATEST(COALESCE(c.badge_sequence, 0), COALESCE(m.plus_haut, 0))
  FROM (
    SELECT u.company_id,
           max(NULLIF(regexp_replace(COALESCE(u.badge_code,''), '^.*[^0-9]', '', 'g'), '')::bigint) AS plus_haut
      FROM users u
     WHERE u.company_id IS NOT NULL AND COALESCE(u.badge_code,'') ~ '[0-9]$'
     GROUP BY u.company_id
  ) m
 WHERE m.company_id = c.id
   AND COALESCE(c.badge_sequence, 0) < COALESCE(m.plus_haut, 0);

/* Un badge ne doit jamais désigner deux personnes de la même société. */
CREATE UNIQUE INDEX IF NOT EXISTS users_badge_code_par_societe
  ON users (company_id, upper(badge_code))
  WHERE badge_code IS NOT NULL AND badge_code <> '';

-- ═════════════════════════════════════════════════════════════════════════
-- 4. DÉPENDANCES TARDIVES DE 064
--
-- Réaffirmées pour qu'une 064 antérieure ne laisse pas la version finale
-- sans les colonnes qu'elle attend.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS level_rank         integer,
  ADD COLUMN IF NOT EXISTS bin_rank           integer,
  ADD COLUMN IF NOT EXISTS archived_at        timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by        integer,
  ADD COLUMN IF NOT EXISTS previous_full_code text,
  ADD COLUMN IF NOT EXISTS renamed_at         timestamptz;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS operation_effective_at timestamptz,
  ADD COLUMN IF NOT EXISTS document_datetime      timestamptz,
  ADD COLUMN IF NOT EXISTS printed_at             timestamptz,
  ADD COLUMN IF NOT EXISTS print_count            integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS document_revision      integer NOT NULL DEFAULT 0;

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS operation_effective_at timestamptz;

CREATE INDEX IF NOT EXISTS locations_company_active_idx
  ON locations (company_id, is_active);
CREATE INDEX IF NOT EXISTS locations_row_idx
  ON locations (company_id, rayon_code);

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. CONTRÔLE
--
-- Échoue bruyamment si le catalogue final n'est pas en place : mieux vaut
-- une migration qui s'arrête qu'un bouton silencieusement hors d'atteinte.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE manquantes text[];
BEGIN
  SELECT array_agg(a) INTO manquantes
    FROM unnest(ARRAY['archive','reorganize','audit']) AS a
   WHERE NOT EXISTS (SELECT 1 FROM permission_actions WHERE action_key = a);
  IF manquantes IS NOT NULL THEN
    RAISE EXCEPTION 'Actions absentes du référentiel : %', array_to_string(manquantes, ', ');
  END IF;

  IF EXISTS (SELECT 1 FROM permission_modules
              WHERE module_key = 'stock.emplacement'
                AND NOT (actions @> ARRAY['archive','reorganize','audit'])) THEN
    RAISE EXCEPTION 'Le module stock.emplacement ne porte pas ses trois actions.';
  END IF;

  IF EXISTS (SELECT 1 FROM companies
              WHERE COALESCE(NULLIF(TRIM(badge_prefix), ''), '') = '') THEN
    RAISE EXCEPTION 'Une entreprise au moins n''a pas de préfixe de badge.';
  END IF;

  RAISE NOTICE 'Catalogue et badges conformes.';
END $$;
