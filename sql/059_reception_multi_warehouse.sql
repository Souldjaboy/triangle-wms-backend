-- 059 — Un conteneur peut alimenter plusieurs entrepôts.
--
-- Le modèle initial portait l'entrepôt sur l'EN-TÊTE de réception : un même
-- conteneur déchargé sur deux entrepôts aurait donc produit deux réceptions
-- indépendantes portant le même numéro. C'est le cas réel de MSNU 5745901/6,
-- TEMU 824100/0 et ECMU 710881/7, présents à la fois en W-EM2S-A et W-EM2S-C.
--
-- L'entrepôt descend donc au niveau de la LIGNE : une réception unique par
-- (entreprise, conteneur, date), dont chaque ligne connaît sa destination.
--
-- Migration ADDITIVE et idempotente. L'entrepôt d'en-tête est conservé — il
-- reste utile comme quai de déchargement par défaut — mais n'est plus la
-- destination effective.

BEGIN;

ALTER TABLE stock_reception_lines
  ADD COLUMN IF NOT EXISTS warehouse_id   INTEGER,
  ADD COLUMN IF NOT EXISTS warehouse_code TEXT;

/* Reprise : les lignes déjà créées héritent de l'entrepôt de leur en-tête. */
UPDATE stock_reception_lines l
   SET warehouse_code = r.warehouse_code, warehouse_id = r.warehouse_id
  FROM stock_receptions r
 WHERE r.id = l.reception_id
   AND l.warehouse_code IS NULL;

/* Unicité métier : un conteneur n'est réceptionné qu'une fois par date.
   Index partiel — les réceptions sans numéro de conteneur restent possibles. */
CREATE UNIQUE INDEX IF NOT EXISTS stock_receptions_container_uidx
    ON stock_receptions (company_id, container_number, reception_date)
 WHERE container_number IS NOT NULL;

COMMIT;
