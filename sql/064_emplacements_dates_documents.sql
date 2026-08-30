-- 064 — EMPLACEMENTS CONFIGURABLES ET DATES MÉTIER DES DOCUMENTS
--
-- Strictement ADDITIVE et IDEMPOTENTE. Aucune table supprimée, aucune colonne
-- retirée, aucune ligne d'emplacement, de stock, de mouvement ou de document
-- effacée. Aucune quantité touchée.
--
-- CE QUI EXISTE DÉJÀ ET QUI EST CONSERVÉ TEL QUEL :
--   `locations`      table PLATE : un rayon n'est pas une entité, c'est du
--                    texte recopié sur chaque bin. On garde ce modèle.
--   `full_code`      code complet calculé, sous index unique partiel.
--   `stock_location_balances`  le stock, rattaché à locations.id.
--   `stock_movements`, `documents`  l'historique.
--
-- Le choix de garder le modèle plat a une conséquence assumée : renommer un
-- rayon reste un UPDATE de masse. Cette migration ne le rend pas inutile ;
-- elle donne au moteur de renommage de quoi le faire SANS RISQUE — un ordre
-- d'affichage stable, un journal, et l'archivage à la place de la suppression.
--
-- ═════════════════════════════════════════════════════════════════════════
-- FUSEAU HORAIRE
--   Africa/Bamako est UTC+0 toute l'année (le Mali n'applique aucun
--   changement d'heure). Les colonnes nouvelles sont donc en TIMESTAMPTZ :
--   l'instant est absolu, et l'affichage se fait explicitement dans ce fuseau
--   plutôt que dans celui, imprévisible, du navigateur de l'utilisateur.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. DATES DES DOCUMENTS — quatre notions, quatre colonnes, jamais confondues
--
--   created_at              date TECHNIQUE de création en base. Intouchable.
--   operation_effective_at  date à laquelle l'opération a EU LIEU sur le
--                           terrain. C'est un fait métier.
--   document_datetime       date et heure IMPRIMÉES sur le bon. Par défaut
--                           égale à la date effective ; corrigible.
--   printed_at              dernière impression réelle.
--
-- Aucune de ces colonnes n'en double une autre : la première est technique,
-- la deuxième décrit le terrain, la troisième ce que lit le destinataire, la
-- quatrième trace la diffusion.
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS operation_effective_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS document_datetime      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS printed_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS print_count            INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS document_revision      INTEGER NOT NULL DEFAULT 1;

/* Le mouvement porte lui aussi sa date de terrain : un bon peut être édité
   plusieurs jours après l'opération, et deux bons issus du même mouvement
   doivent afficher la même réalité. */
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS operation_effective_at TIMESTAMPTZ;

/* JOURNAL DES CORRECTIONS DE DATE — consultable, jamais modifiable depuis
   l'application. Une correction n'écrase rien : elle ajoute une révision. */
CREATE TABLE IF NOT EXISTS document_date_revisions (
  id              bigserial PRIMARY KEY,
  company_id      integer NOT NULL,
  document_id     integer,
  movement_id     integer,
  revision        integer NOT NULL,
  field           text    NOT NULL DEFAULT 'document_datetime',
  old_value       timestamptz,
  new_value       timestamptz,
  /* Motif obligatoire côté API dès la deuxième révision. */
  reason          text    NOT NULL DEFAULT '',
  was_printed     boolean NOT NULL DEFAULT false,
  changed_by      integer,
  changed_by_name text    NOT NULL DEFAULT '',
  context         text    NOT NULL DEFAULT '',
  changed_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ddr_cible CHECK (document_id IS NOT NULL OR movement_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ddr_document_idx ON document_date_revisions (company_id, document_id, revision DESC);
CREATE INDEX IF NOT EXISTS ddr_movement_idx ON document_date_revisions (company_id, movement_id, revision DESC);

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. EMPLACEMENTS — ordre d'affichage, archivage, journal
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE locations
  /* Rang d'affichage du niveau. « Top » n'est pas un texte décoratif : c'est
     un niveau réel, qui doit se ranger APRÈS Level 3 ou Level 4 et non entre
     « 3 » et « 4 » comme le ferait un tri alphabétique. */
  ADD COLUMN IF NOT EXISTS level_rank  integer,
  ADD COLUMN IF NOT EXISTS bin_rank    integer,
  /* Archivage : un emplacement ne se supprime pas, il se retire de la vue.
     La ligne, son id et son historique restent. */
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by integer,
  /* Trace du dernier renommage, pour retrouver un bin sous son ancien nom. */
  ADD COLUMN IF NOT EXISTS previous_full_code text,
  ADD COLUMN IF NOT EXISTS renamed_at         timestamptz;

CREATE INDEX IF NOT EXISTS locations_company_active_idx
  ON locations (company_id, is_active) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS locations_row_idx
  ON locations (company_id, warehouse_code, rayon_code);

/* JOURNAL DES EMPLACEMENTS — qui a renommé, archivé, créé ou réorganisé quoi. */
CREATE TABLE IF NOT EXISTS location_audit_log (
  id              bigserial PRIMARY KEY,
  company_id      integer NOT NULL,
  location_id     integer,
  /* CREATE | RENAME | ACTIVATE | DEACTIVATE | ARCHIVE | REORGANIZE | SPLIT */
  action          text    NOT NULL,
  scope           text    NOT NULL DEFAULT 'BIN',
  old_value       text,
  new_value       text,
  reason          text    NOT NULL DEFAULT '',
  batch_id        text,
  quantity_before numeric,
  quantity_after  numeric,
  changed_by      integer,
  changed_by_name text    NOT NULL DEFAULT '',
  context         text    NOT NULL DEFAULT '',
  changed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS location_audit_company_idx ON location_audit_log (company_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS location_audit_location_idx ON location_audit_log (location_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS location_audit_batch_idx ON location_audit_log (batch_id);

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. RANGS D'AFFICHAGE — remplissage d'une colonne neuve, pas une réécriture
--
-- level_rank et bin_rank sont DÉRIVÉS du code déjà présent. Les renseigner ne
-- change aucun code, aucune quantité, aucun rattachement : cela donne
-- seulement un ordre stable à des chaînes de caractères qui n'en avaient pas.
-- Seules les lignes où la colonne est encore NULL sont touchées : rejouer la
-- migration ne défait aucun rang ajusté à la main depuis.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

UPDATE locations l
   SET level_rank = CASE
         /* « TOP », « HAUT », « SUP » : toujours en dernier, quel que soit le
            nombre de niveaux de l'étagère. */
         WHEN UPPER(TRIM(COALESCE(NULLIF(l.level_code,''), l.etagere, ''))) ~ '(TOP|HAUT|SUP)'
           THEN 9000
         /* Premier nombre rencontré : « L4 », « LEVEL 4 », « 4 » → 4. */
         WHEN COALESCE(NULLIF(l.level_code,''), l.etagere, '') ~ '[0-9]'
           THEN LEAST(
                  (REGEXP_MATCH(COALESCE(NULLIF(l.level_code,''), l.etagere, ''), '([0-9]+)'))[1]::integer,
                  8999)
         ELSE 8999
       END
 WHERE l.level_rank IS NULL;

UPDATE locations l
   SET bin_rank = CASE
         WHEN COALESCE(l.bin_code,'') ~ '[0-9]'
           THEN LEAST((REGEXP_MATCH(l.bin_code, '([0-9]+)'))[1]::integer, 999999)
         ELSE 999999
       END
 WHERE l.bin_rank IS NULL;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. PERMISSIONS — le contrôle est au backend, pas dans un bouton caché
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO permission_actions (action_key, label, description, sort_order, is_write) VALUES
  ('reprint',    'Réimprimer',        'Rééditer un document déjà imprimé.',              175, true),
  ('archive',    'Archiver',          'Retirer de la vue sans jamais supprimer.',        180, true),
  ('reorganize', 'Réorganiser',       'Renommer et redécouper les emplacements en masse.', 185, true),
  ('audit',      'Consulter le journal','Lire l''historique des modifications.',          190, false)
ON CONFLICT (action_key) DO NOTHING;

/* L'ordre du tableau `actions` est celui des colonnes de l'écran des droits :
   on le reconstruit par sort_order plutôt que par concaténation, sinon les
   colonnes se réordonnent à chaque passage de la migration.
   Le module « document » ne savait ni modifier ni réimprimer : corriger la
   date d'un bon n'était donc couvert par aucun droit. On complète sa liste
   d'actions sans retirer les existantes. */
UPDATE permission_modules m
   SET actions = sub.ordonnees, updated_at = now()
  FROM (SELECT ARRAY(SELECT a.action_key
                       FROM permission_actions a
                      WHERE a.action_key = ANY (pm.actions || ARRAY['update','reprint','audit'])
                      ORDER BY a.sort_order) AS ordonnees
          FROM permission_modules pm WHERE pm.module_key = 'document') sub
 WHERE m.module_key = 'document';

/* Les emplacements : le module existait au référentiel mais aucune route ne
   s'en servait. On lui ajoute ce que réclament la réorganisation et l'archivage. */
UPDATE permission_modules m
   SET actions = sub.ordonnees, updated_at = now()
  FROM (SELECT ARRAY(SELECT a.action_key
                       FROM permission_actions a
                      WHERE a.action_key = ANY (pm.actions || ARRAY['archive','reorganize','audit'])
                      ORDER BY a.sort_order) AS ordonnees
          FROM permission_modules pm WHERE pm.module_key = 'stock.emplacement') sub
 WHERE m.module_key = 'stock.emplacement';

/* Droits par rôle pour les couples (module, action) nouvellement déclarés.
   Même règle qu'en 063 : les rôles d'administration reçoivent, les autres
   non. Aucun droit existant n'est modifié — ON CONFLICT DO NOTHING. */
INSERT INTO role_permissions (company_id, role, module_key, action, allowed)
SELECT c.id, r.role, m.module_key, a.action,
       r.role IN ('super_admin','admin','administrateur','direction','directeur','gerant','manager')
  FROM companies c
  JOIN (SELECT DISTINCT company_id, lower(trim(role)) AS role
          FROM users WHERE NULLIF(trim(role), '') IS NOT NULL) r ON r.company_id = c.id
  CROSS JOIN permission_modules m
  CROSS JOIN LATERAL unnest(m.actions) AS a(action)
 WHERE m.module_key IN ('document', 'stock.emplacement')
ON CONFLICT (company_id, role, module_key, action) DO NOTHING;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. CE QUE CETTE MIGRATION NE FAIT PAS — volontairement
--
--   Elle ne découpe AUCUN emplacement « 1,2,3 » en trois bacs. Ces lignes ont
--   été créées par l'ancien écran, qui envoyait un seul INSERT pour un « Full
--   Bin ». Les découper automatiquement supposerait de savoir quelle part du
--   stock va dans quel bac — ce que la base ne dit pas. Le découpage est donc
--   une action humaine, explicite, tracée, offerte par l'API.
--
--   Elle ne renomme aucun rayon, ne remplit aucun full_code manquant, ne
--   supprime aucun doublon. Tout cela reste sous décision humaine.
-- ═════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════
-- BADGES PAR ENTREPRISE
--
-- Le badge était fabriqué en dur : `TRIANGLE-EMP-<id>`, quelle que soit la
-- société. Un employé créé dans FAT & MAT recevait donc une étiquette
-- Triangle — un badge n'est pas un libellé décoratif, il identifie la
-- personne à l'entrée d'un site.
--
-- Le préfixe et la séquence appartiennent désormais à l'entreprise. Rien
-- n'est deviné : à défaut de valeur, on dérive un préfixe des premières
-- lettres du nom, et l'administrateur peut le corriger.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS badge_prefix   text,
  ADD COLUMN IF NOT EXISTS badge_sequence integer NOT NULL DEFAULT 0;

/* Préfixe initial : celui que portent DÉJÀ les badges de l'entreprise.
   Le déduire du nom donnerait « TRIANGLELOGI » là où les cartes en
   circulation disent « TRIANGLE » — les anciennes cesseraient de concorder
   avec les nouvelles. On reprend donc le préfixe dominant existant, et l'on
   ne se rabat sur le nom que faute de badge exploitable. */
WITH candidats AS (
  SELECT company_id, upper(split_part(badge_code, '-', 1)) AS prefixe, count(*) AS n
    FROM users
   WHERE company_id IS NOT NULL AND COALESCE(badge_code,'') <> ''
     AND position('-' IN badge_code) > 1
   GROUP BY 1, 2
),
/* Un préfixe n'appartient qu'à une entreprise : celle qui en porte le plus.
   Sans cette règle, un badge attribué par erreur — celui d'un employé
   FAT & MAT étiqueté TRIANGLE — donnerait le préfixe Triangle à FAT & MAT,
   et l'erreur d'hier deviendrait la règle de demain. */
attribue AS (
  SELECT DISTINCT ON (prefixe) prefixe, company_id
    FROM candidats ORDER BY prefixe, n DESC, company_id
)
UPDATE companies c SET badge_prefix = a.prefixe
  FROM attribue a
 WHERE a.company_id = c.id
   AND COALESCE(NULLIF(TRIM(c.badge_prefix), ''), '') = '';

/* Faute de badge existant : premier mot du nom, en majuscules. */
UPDATE companies
   SET badge_prefix = NULLIF(left(upper(regexp_replace(translate(name,
         'àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ', 'aaaeeeeiioouuucAAAEEEEIIOOUUUC'),
         '[^A-Za-z0-9]', '', 'g')), 12), '')
 WHERE COALESCE(NULLIF(TRIM(badge_prefix), ''), '') = '';

UPDATE companies SET badge_prefix = 'ENT' || id
 WHERE COALESCE(NULLIF(TRIM(badge_prefix), ''), '') = '';

/* La séquence repart au-dessus du plus grand numéro déjà attribué, pour que
   la génération ne réutilise jamais un badge existant. */
UPDATE companies c
   SET badge_sequence = GREATEST(c.badge_sequence, COALESCE(m.plus_haut, 0))
  FROM (
    SELECT u.company_id,
           max(NULLIF(regexp_replace(COALESCE(u.badge_code,''), '^.*[^0-9]', '', 'g'), '')::bigint) AS plus_haut
      FROM users u
     WHERE u.company_id IS NOT NULL
       AND COALESCE(u.badge_code,'') ~ '[0-9]$'
     GROUP BY u.company_id
  ) m
 WHERE m.company_id = c.id;

/* Un badge ne doit jamais désigner deux personnes de la même société. */
CREATE UNIQUE INDEX IF NOT EXISTS users_badge_code_par_societe
  ON users (company_id, upper(badge_code))
  WHERE badge_code IS NOT NULL AND badge_code <> '';

COMMIT;
