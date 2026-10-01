-- ═════════════════════════════════════════════════════════════════════════
-- 102 — RÉCEPTIONS DE CONTENEURS : LE VÉHICULE, ET LES ALIAS D'ENTREPÔT
--
-- CE QUI MANQUAIT, ET POURQUOI C'EST GÊNANT
--
-- 1. LE VÉHICULE. Le document de réception porte une plaque — « N°V: AA 330 GQ »
--    — et `stock_receptions` n'a nulle part où la mettre : il connaît
--    `carrier` (le transporteur, une société), `supplier_name` et
--    `supplier_reference` (le bordereau). Un camion n'est ni l'un ni l'autre.
--    Faute de colonne, 22 plaques du classeur réel étaient perdues à l'import,
--    et un litige sur une livraison ne pouvait plus être tracé jusqu'au camion.
--
-- 2. LES ALIAS D'ENTREPÔT. Une feuille nommée « WAREHOUSE-E » désigne
--    l'entrepôt « W-EM2S-E ». Jusqu'ici, la seule façon de faire accepter ce
--    nom à l'import était que `ensureWarehouse` CRÉE un entrepôt « WAREHOUSE-E »
--    — un doublon du vrai, avec son propre stock, invisible à qui regarde la
--    liste des entrepôts. L'alias enregistre la correspondance UNE FOIS,
--    confirmée par une personne, exactement comme `product_import_aliases` le
--    fait déjà pour les libellés d'articles. Symétrie voulue : le même
--    problème, la même solution.
--
-- 3. TROIS NATURES D'ANOMALIE. `stock_import_anomalies` sait déjà faire
--    attendre une donnée ambiguë. Il lui manquait les trois cas que le
--    classeur réel produit : un entrepôt inconnu, une quantité absente, un
--    véhicule absent. Sans elles, ces cas n'avaient aucun endroit où attendre
--    et le seul choix restant était de deviner.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--
-- Elle ne crée AUCUN entrepôt, AUCUN alias, AUCUN produit, et ne touche aucun
-- stock. Les alias se posent ensuite, un par un, par une personne. En
-- particulier, elle n'écrit pas « WAREHOUSE-E → W-EM2S-E » : cette décision
-- vous appartient, et l'identifiant exact dépend de la base.
--
-- Additive et idempotente.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. LA PLAQUE DU VÉHICULE
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE stock_receptions
  ADD COLUMN IF NOT EXISTS vehicle_plate TEXT;

/* Recherche par plaque : « quel camion a livré ce conteneur ? » est la question
   qu'on pose quand une marchandise manque. L'index la rend instantanée, et ne
   porte que sur les lignes renseignées — la majorité des réceptions anciennes
   n'auront jamais de plaque. */
CREATE INDEX IF NOT EXISTS stock_receptions_vehicle_idx
  ON stock_receptions (company_id, UPPER(BTRIM(vehicle_plate)))
  WHERE vehicle_plate IS NOT NULL AND BTRIM(vehicle_plate) <> '';

/* La plaque vit aussi sur la ligne d'import, pour que l'opération tracée dise
   ce que le classeur disait — y compris quand la réception a été complétée
   plus tard par un autre camion. */
ALTER TABLE stock_import_operations
  ADD COLUMN IF NOT EXISTS vehicle_plate TEXT;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. LES ALIAS D'ENTREPÔT — le pendant exact de product_import_aliases
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warehouse_import_aliases (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  /* Ce que le document écrit, tel quel : « WAREHOUSE-E », « WH E », « Entrepot E ». */
  alias        TEXT    NOT NULL,
  /* La même chose, pliée pour la comparaison. Le brut n'est jamais écrasé. */
  alias_norm   TEXT    NOT NULL,
  /* RESTRICT : un entrepôt vers lequel un alias pointe ne se supprime pas en
     silence. On retire l'alias d'abord, volontairement. */
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  source       TEXT    NOT NULL DEFAULT 'IMPORT',
  /* Qui a confirmé, et quand. Un alias est une décision humaine : sans auteur,
     il serait indistinguable d'une correspondance devinée. */
  confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by_name TEXT NOT NULL DEFAULT '',
  reason       TEXT    NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

/* Un alias ne peut désigner qu'un entrepôt par société : sans cette unicité,
   « WAREHOUSE-E » pourrait pointer vers deux entrepôts et l'import choisirait
   au hasard. */
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_import_aliases_uidx
  ON warehouse_import_aliases (company_id, alias_norm);
CREATE INDEX IF NOT EXISTS warehouse_import_aliases_cible_idx
  ON warehouse_import_aliases (company_id, warehouse_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. TROIS NATURES D'ANOMALIE DE PLUS
--
-- La contrainte est remplacée par une version élargie : aucune valeur
-- existante n'est retirée, trois sont ajoutées. Les anomalies déjà
-- enregistrées restent valides.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'stock_import_anomalies_type_chk') THEN
    ALTER TABLE stock_import_anomalies DROP CONSTRAINT stock_import_anomalies_type_chk;
  END IF;
  ALTER TABLE stock_import_anomalies ADD CONSTRAINT stock_import_anomalies_type_chk
    CHECK (anomaly_type IN (
      'MULTI_BIN', 'DATES_MULTIPLES', 'NEW_STOCK_INCOHERENT', 'NIVEAU_INCONNU',
      'PRODUIT_AMBIGU', 'EMPLACEMENT_AMBIGU', 'DATE_CONTENEUR_DIVERGENTE',
      /* Nouvelles : le classeur réel les produit, et sans elles le seul choix
         restant serait de deviner. */
      'ENTREPOT_INCONNU', 'QUANTITE_ABSENTE', 'VEHICULE_ABSENT',
      'RECEPTION_DIVERGENTE'));
END $$;

/* L'unicité d'une anomalie se jouait sur (lot, type, feuille, ligne). Une
   feuille peut porter DEUX anomalies de même type sur la même ligne lorsque la
   ligne contient plusieurs colonnes problématiques ; la cellule les distingue.
   On ajoute un index qui tient compte de la cellule sans retirer l'ancien :
   l'ancien reste le garde-fou du cas courant. */
CREATE UNIQUE INDEX IF NOT EXISTS stock_import_anomalies_cellule_uidx
  ON stock_import_anomalies (batch_id, anomaly_type, excel_sheet, excel_row,
                             COALESCE(excel_cell, ''));

-- ─────────────────────────────────────────────────────────────────────────
-- 4. LA DÉSIGNATION D'ORIGINE NE DOIT JAMAIS ÊTRE ÉCRASÉE
--
-- `received_label` porte déjà le libellé exact du document. On ajoute à côté
-- la forme normalisée qui a servi au rapprochement : la garder permet de
-- rejouer une comparaison des mois plus tard, et de voir POURQUOI un libellé a
-- été rapproché d'un produit — sans jamais toucher à l'original.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE stock_reception_lines
  ADD COLUMN IF NOT EXISTS received_label_norm TEXT;

CREATE INDEX IF NOT EXISTS stock_reception_lines_norm_idx
  ON stock_reception_lines (company_id, received_label_norm)
  WHERE received_label_norm IS NOT NULL;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE alias_cree BOOLEAN; plaque BOOLEAN; types TEXT;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_name = 'warehouse_import_aliases') INTO alias_cree;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'stock_receptions' AND column_name = 'vehicle_plate') INTO plaque;
  SELECT pg_get_constraintdef(oid) INTO types FROM pg_constraint
   WHERE conname = 'stock_import_anomalies_type_chk';

  IF NOT alias_cree THEN
    RAISE EXCEPTION '102 : sans table d''alias, la seule façon d''accepter « WAREHOUSE-E » serait de créer un entrepôt en double.';
  END IF;
  IF NOT plaque THEN
    RAISE EXCEPTION '102 : sans colonne véhicule, les plaques du document restent perdues.';
  END IF;
  IF types IS NULL OR position('ENTREPOT_INCONNU' in types) = 0 THEN
    RAISE EXCEPTION '102 : sans la nature ENTREPOT_INCONNU, un entrepôt introuvable n''aurait aucun endroit où attendre.';
  END IF;

  /* Aucun alias n'est posé par la migration : la correspondance est une
     décision humaine, et l'identifiant dépend de la base. */
  IF EXISTS (SELECT 1 FROM warehouse_import_aliases) THEN
    RAISE NOTICE '102 : % alias d''entrepôt déjà enregistrés (posés par une personne, pas par cette migration).',
      (SELECT count(*) FROM warehouse_import_aliases);
  ELSE
    RAISE NOTICE '102 : aucun alias d''entrepôt enregistré — à poser explicitement avant l''import.';
  END IF;
  RAISE NOTICE 'Véhicule, alias d''entrepôt et natures d''anomalie en place. Aucun entrepôt, aucun produit, aucun stock touché.';
END $$;
