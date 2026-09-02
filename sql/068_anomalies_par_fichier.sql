-- 068 — UNE ANOMALIE APPARTIENT À UN FICHIER, PAS À UN LOT
--
-- La 067 identifiait une anomalie par son lot d'import. Or rejouer le même
-- classeur crée un NOUVEAU lot : les mêmes cellules rouvraient donc les mêmes
-- anomalies, et la liste de ce qui attend une décision doublait à chaque
-- passage. Cinq anomalies devenaient dix sans qu'aucune donnée n'ait changé.
--
-- Ce qui identifie une anomalie, c'est le fichier — par son empreinte — et la
-- cellule qui l'a produite. Le lot dit seulement quand on l'a vue la première
-- fois.
--
-- 067 est figée : cette migration la complète, elle ne la réécrit pas.
-- Additive et idempotente.

BEGIN;

ALTER TABLE stock_import_anomalies
  ADD COLUMN IF NOT EXISTS file_sha256 TEXT;

/* Les anomalies déjà ouvertes récupèrent l'empreinte de leur lot d'origine :
   elles gardent leur place dans la file au lieu d'être dédoublées demain. */
UPDATE stock_import_anomalies a
   SET file_sha256 = b.file_sha256
  FROM stock_import_batches b
 WHERE b.id = a.batch_id
   AND a.file_sha256 IS NULL;

/* Doublons hérités de l'ancienne clé : on garde la PLUS ANCIENNE de chaque
   groupe — celle qu'une personne a peut-être déjà commencé à traiter — et on
   retire les copies exactes créées par un rejeu. Aucune décision n'est
   perdue : une anomalie déjà tranchée n'est jamais supprimée. */
WITH classees AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY company_id, file_sha256, anomaly_type, excel_sheet, excel_row
           ORDER BY (status = 'RESOLVED') DESC, resolved_at NULLS LAST, id
         ) AS rang
    FROM stock_import_anomalies
   WHERE file_sha256 IS NOT NULL
)
DELETE FROM stock_import_anomalies a
 USING classees c
 WHERE c.id = a.id AND c.rang > 1 AND a.status = 'OPEN';

/* L'ancienne unicité, fondée sur le lot, n'a plus de sens. */
DROP INDEX IF EXISTS stock_import_anomalies_source_uidx;

/* Index NON partiel, volontairement : PostgreSQL n'accroche un `ON CONFLICT`
   à un index partiel que si la requête répète son prédicat, ce qui rendrait
   l'insertion dépendante d'un détail de l'index. Une empreinte absente ne
   pose pas de problème : dans un index d'unicité, deux valeurs nulles ne se
   heurtent jamais. */
DROP INDEX IF EXISTS stock_import_anomalies_fichier_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS stock_import_anomalies_fichier_uidx
  ON stock_import_anomalies (company_id, file_sha256, anomaly_type, excel_sheet, excel_row);

CREATE INDEX IF NOT EXISTS stock_import_anomalies_fichier_idx
  ON stock_import_anomalies (company_id, file_sha256, status);

COMMIT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE indexname = 'stock_import_anomalies_fichier_uidx') THEN
    RAISE EXCEPTION 'L''unicité des anomalies par fichier n''est pas garantie : un rejeu les doublerait.';
  END IF;
  RAISE NOTICE 'Anomalies d''import : identifiées par fichier et cellule.';
END $$;
