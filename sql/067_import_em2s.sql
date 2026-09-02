-- 067 — IMPORT DU CLASSEUR EM2S
--
-- La 058 porte déjà les réceptions conteneur et sépare la réception de la mise
-- en stock. Il manque trois choses pour importer un classeur sans jamais
-- créer deux fois la même opération :
--
--   1. l'entrepôt AU NIVEAU DE LA LIGNE. Un même conteneur est dépoté une
--      fois et ses articles rangés dans deux entrepôts : sans cette colonne,
--      il faudrait créer deux réceptions pour un seul conteneur physique.
--
--   2. une trace de ce qui a déjà été appliqué, indépendante du nombre de
--      lignes lues. Compter les lignes ne dit pas si l'opération existe déjà.
--
--   3. un endroit où une donnée ambiguë ATTEND. Sans lui, la seule façon
--      d'importer serait de deviner — répartir une quantité entre des bacs,
--      ou entre des dates — ce qui est exactement l'erreur à ne pas commettre.
--
-- Migration ADDITIVE et idempotente : aucune table existante n'est remplacée,
-- aucune donnée supprimée, aucun stock touché.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. L'ENTREPÔT DESCEND AU NIVEAU DE LA LIGNE
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE stock_reception_lines
  ADD COLUMN IF NOT EXISTS warehouse_code TEXT,
  ADD COLUMN IF NOT EXISTS warehouse_id   INTEGER,
  ADD COLUMN IF NOT EXISTS excel_cell     TEXT,
  ADD COLUMN IF NOT EXISTS import_batch_id INTEGER;

/* Les lignes déjà présentes héritent de l'entrepôt de leur réception : leur
   sens ne change pas, elles cessent seulement d'être muettes. */
UPDATE stock_reception_lines l
   SET warehouse_code = r.warehouse_code
  FROM stock_receptions r
 WHERE r.id = l.reception_id
   AND l.warehouse_code IS NULL
   AND r.warehouse_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS stock_reception_lines_warehouse_idx
  ON stock_reception_lines (company_id, warehouse_code);

-- ═════════════════════════════════════════════════════════════════════════
-- 2. LES LOTS D'IMPORT
--
-- Un lot = un fichier, une empreinte, une entreprise. L'empreinte est la
-- seule identité fiable d'un classeur : deux fichiers de même nom n'ont pas
-- le même contenu, et le même contenu renommé reste le même contenu.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS stock_import_batches (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL,
  file_name      TEXT    NOT NULL,
  file_sha256    TEXT    NOT NULL,
  file_size      INTEGER,
  source         TEXT    NOT NULL DEFAULT 'EM2S',
  status         TEXT    NOT NULL DEFAULT 'PREVIEW',
  sheets         JSONB,
  summary        JSONB,
  created_by     INTEGER,
  created_at     TIMESTAMP DEFAULT NOW(),
  executed_at    TIMESTAMP,
  cancelled_at   TIMESTAMP,
  CONSTRAINT stock_import_batches_status_chk CHECK (status IN
    ('PREVIEW', 'EXECUTED', 'PARTIAL', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS stock_import_batches_sha_idx
  ON stock_import_batches (company_id, file_sha256);

-- ═════════════════════════════════════════════════════════════════════════
-- 3. CE QUI A DÉJÀ ÉTÉ APPLIQUÉ
--
-- Une clé par opération, stable et calculée à partir de ce qui la définit :
-- empreinte du fichier, feuille, ligne, nature, produit, emplacement, sens,
-- quantité. Rejouer le même fichier retombe sur les mêmes clés, et l'index
-- d'unicité refuse la seconde écriture — l'idempotence est garantie par la
-- base, pas par la bonne volonté du code appelant.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS stock_import_operations (
  id               SERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  batch_id         INTEGER REFERENCES stock_import_batches(id) ON DELETE SET NULL,
  idempotency_key  TEXT    NOT NULL,
  kind             TEXT    NOT NULL,
  file_sha256      TEXT    NOT NULL,
  excel_sheet      TEXT,
  excel_row        INTEGER,
  excel_cell       TEXT,
  container_number TEXT,
  business_date    DATE,
  warehouse_code   TEXT,
  product_id       INTEGER,
  product_label    TEXT,
  location_id      INTEGER,
  location_code    TEXT,
  movement_kind    TEXT,
  quantity         NUMERIC,
  reception_id     INTEGER,
  reception_line_id INTEGER,
  movement_id      INTEGER,
  document_id      INTEGER,
  created_by       INTEGER,
  created_at       TIMESTAMP DEFAULT NOW(),
  CONSTRAINT stock_import_operations_kind_chk CHECK (kind IN
    ('RECEPTION', 'RECEPTION_LINE', 'PRODUCT', 'LOCATION', 'MOVEMENT'))
);

/* Le cœur de l'anti-doublon. Une clé ne peut désigner qu'une opération. */
CREATE UNIQUE INDEX IF NOT EXISTS stock_import_operations_key_uidx
  ON stock_import_operations (company_id, idempotency_key);

CREATE INDEX IF NOT EXISTS stock_import_operations_batch_idx
  ON stock_import_operations (company_id, batch_id);
CREATE INDEX IF NOT EXISTS stock_import_operations_sha_idx
  ON stock_import_operations (company_id, file_sha256, kind);

-- ═════════════════════════════════════════════════════════════════════════
-- 4. CE QUI ATTEND UNE DÉCISION HUMAINE
--
-- Une anomalie ne bloque pas par punition : elle bloque parce que la donnée
-- manquante ne peut pas être inventée sans risquer de fausser un stock réel.
-- Tant qu'elle est ouverte, aucune écriture de stock ne la concerne.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS stock_import_anomalies (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL,
  batch_id       INTEGER NOT NULL REFERENCES stock_import_batches(id) ON DELETE CASCADE,
  anomaly_type   TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'OPEN',
  excel_sheet    TEXT,
  excel_row      INTEGER,
  excel_cell     TEXT,
  description    TEXT,
  message        TEXT    NOT NULL,
  /* Ce que le classeur dit, tel quel : bacs cochés, dates proposées,
     quantité attendue. On le garde pour que la personne qui tranche voie la
     source, pas seulement notre interprétation. */
  payload        JSONB,
  /* Ce que la personne a décidé : quantités par bac, quantités par date. */
  resolution     JSONB,
  resolved_by    INTEGER,
  resolved_at    TIMESTAMP,
  created_at     TIMESTAMP DEFAULT NOW(),
  CONSTRAINT stock_import_anomalies_status_chk CHECK (status IN
    ('OPEN', 'RESOLVED', 'IGNORED')),
  CONSTRAINT stock_import_anomalies_type_chk CHECK (anomaly_type IN
    ('MULTI_BIN', 'DATES_MULTIPLES', 'NEW_STOCK_INCOHERENT', 'NIVEAU_INCONNU',
     'PRODUIT_AMBIGU', 'EMPLACEMENT_AMBIGU', 'DATE_CONTENEUR_DIVERGENTE'))
);

/* Une même anomalie ne s'ouvre qu'une fois par lot et par cellule. */
CREATE UNIQUE INDEX IF NOT EXISTS stock_import_anomalies_source_uidx
  ON stock_import_anomalies (batch_id, anomaly_type, excel_sheet, excel_row);

CREATE INDEX IF NOT EXISTS stock_import_anomalies_ouvertes_idx
  ON stock_import_anomalies (company_id, status)
  WHERE status = 'OPEN';

-- ═════════════════════════════════════════════════════════════════════════
-- 5. ALIAS DE PRODUIT
--
-- Le libellé du classeur est conservé tel quel. « SPEACKER » et « SPEAKER »,
-- « MAMBRANE » et « MEMBRANE » se ressemblent : les rapprocher tout seul
-- fusionnerait peut-être deux articles distincts. L'alias enregistre ce qu'un
-- humain a confirmé, une fois, et évite de reposer la question au prochain
-- import.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS product_import_aliases (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL,
  alias        TEXT    NOT NULL,
  alias_norm   TEXT    NOT NULL,
  product_id   INTEGER NOT NULL,
  source       TEXT    DEFAULT 'EM2S',
  confirmed_by INTEGER,
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS product_import_aliases_uidx
  ON product_import_aliases (company_id, alias_norm);

-- ═════════════════════════════════════════════════════════════════════════
-- 6. STATUTS DE RÉCEPTION
--
-- Réaffirmés ici pour que l'écran et l'import parlent des mêmes mots. Aucune
-- réception existante n'est modifiée : on décrit, on ne réécrit pas.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS stock_reception_statuses (
  code       TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_final   BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO stock_reception_statuses (code, label, sort_order, is_final) VALUES
  ('IMPORT_DRAFT',              'Brouillon d''import',        10, false),
  ('RECORDED',                  'Réception enregistrée',      20, false),
  ('RECEIVED_PENDING_PUTAWAY',  'Reçue, non mise en stock',   30, false),
  ('PARTIALLY_PUTAWAY',         'Partiellement mise en stock', 40, false),
  ('FULLY_PUTAWAY',             'Entièrement mise en stock',  50, true),
  ('ANOMALY',                   'Anomalie à corriger',        60, false),
  ('CANCELLED',                 'Annulée',                    70, true)
ON CONFLICT (code) DO UPDATE
  SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
      is_final = EXCLUDED.is_final;

-- ═════════════════════════════════════════════════════════════════════════
-- 7. TRAÇABILITÉ DE LA SOURCE SUR LES RÉCEPTIONS
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE stock_receptions
  ADD COLUMN IF NOT EXISTS import_batch_id INTEGER,
  ADD COLUMN IF NOT EXISTS file_sha256     TEXT,
  ADD COLUMN IF NOT EXISTS warehouses      TEXT[];

CREATE INDEX IF NOT EXISTS stock_receptions_import_idx
  ON stock_receptions (company_id, import_batch_id)
  WHERE import_batch_id IS NOT NULL;

/* Un conteneur ne peut être reçu qu'une fois par entreprise. C'est la règle
   qui empêche la feuille A et la feuille C de créer deux réceptions pour un
   seul dépotage. Posée seulement si les données existantes le permettent —
   on ne casse pas une base au passage d'une migration. */
DO $$
DECLARE doublons INTEGER;
BEGIN
  SELECT count(*) INTO doublons FROM (
    SELECT company_id, upper(btrim(container_number))
      FROM stock_receptions
     WHERE COALESCE(btrim(container_number), '') <> ''
     GROUP BY 1, 2 HAVING count(*) > 1
  ) d;

  IF doublons > 0 THEN
    RAISE WARNING 'Unicité du conteneur non posée : % numéro(s) déjà en double. Corrigez-les puis rejouez 067.', doublons;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS stock_receptions_container_uidx
      ON stock_receptions (company_id, upper(btrim(container_number)))
      WHERE COALESCE(btrim(container_number), '') <> '';
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 8. DROITS
--
-- L'import touche au stock : il lui faut ses propres actions, sinon le seul
-- moyen de l'autoriser serait d'ouvrir tout le module des stocks.
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO permission_actions (action_key, label, description, sort_order, is_write) VALUES
  ('import_preview',  'Prévisualiser un import', 'Lire un classeur et voir ce qu''il produirait.', 170, false),
  ('import_execute',  'Exécuter un import',      'Écrire les réceptions et mouvements prévisualisés.', 172, true),
  ('import_resolve',  'Lever une anomalie',      'Saisir une répartition par bac ou par date.', 174, true),
  ('import_cancel',   'Annuler un import',       'Marquer un lot comme annulé.', 176, true)
ON CONFLICT (action_key) DO NOTHING;

INSERT INTO permission_modules (module_key, parent_key, label, description, sort_order, is_system, actions)
VALUES ('stock.import', 'stock', 'Import de classeur',
        'Réceptions et mouvements historiques importés depuis un fichier Excel.',
        28, false,
        ARRAY['visible','view','import_preview','import_execute','import_resolve','import_cancel'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      updated_at = now();

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- 9. CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'stock_reception_lines' AND column_name = 'warehouse_code') THEN
    RAISE EXCEPTION 'La ligne de réception ne porte pas son entrepôt : la fusion A/C serait impossible.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'stock_import_operations_key_uidx') THEN
    RAISE EXCEPTION 'L''unicité des clés d''idempotence n''est pas garantie.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM permission_modules WHERE module_key = 'stock.import') THEN
    RAISE EXCEPTION 'Le module de droits « stock.import » est absent.';
  END IF;

  RAISE NOTICE 'Import EM2S : schéma conforme.';
END $$;
