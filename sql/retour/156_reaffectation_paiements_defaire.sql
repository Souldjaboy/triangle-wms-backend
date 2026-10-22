-- ═════════════════════════════════════════════════════════════════════════
--  DÉFAIRE 156_reaffectation_paiements.sql
--
--  ATTENTION. Les paiements qui ont été RÉAFFECTÉS restent sur la facture où
--  ils ont été portés : ce fichier supprime le JOURNAL des déplacements, pas
--  les déplacements eux-mêmes. Après coup, plus rien ne dira qu'un
--  encaissement a changé de facture, ni pourquoi.
--
--  Les remettre en place demanderait d'annuler chaque réaffectation une par
--  une, AVANT de lancer ce fichier. « retour-base.sh » exporte le journal et
--  le signale.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

DROP VIEW  IF EXISTS v_paiements_reaffectes;
DROP TABLE IF EXISTS payment_reallocations CASCADE;

DROP INDEX IF EXISTS sand_payments_reaffectes_idx;
DROP INDEX IF EXISTS cement_payments_reaffectes_idx;

ALTER TABLE sand_payments
  DROP COLUMN IF EXISTS original_invoice_id,
  DROP COLUMN IF EXISTS reallocated_at,
  DROP COLUMN IF EXISTS reallocation_count;
ALTER TABLE cement_payments
  DROP COLUMN IF EXISTS original_invoice_id,
  DROP COLUMN IF EXISTS reallocated_at,
  DROP COLUMN IF EXISTS reallocation_count;

DELETE FROM role_permissions
 WHERE action = 'paiement_reaffecter' AND updated_by IS NULL;

UPDATE permission_modules
   SET actions = (SELECT COALESCE(array_agg(a ORDER BY a), ARRAY[]::text[])
                    FROM unnest(actions) AS a WHERE a <> 'paiement_reaffecter'),
       updated_at = now()
 WHERE module_key IN ('sable','ciment');

-- permission_actions n'est pas amputé : une action inutilisée ne gêne
-- personne, une action supprimée casse la clé étrangère d'un droit posé à la
-- main.

COMMIT;
