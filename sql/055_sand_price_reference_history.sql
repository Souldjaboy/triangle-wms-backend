-- 055 — Historisation du palier tarifaire Sable.
--
-- AUDIT PRÉALABLE : tout le reste est déjà historisé et n'a besoin d'AUCUNE
-- migration —
--   sand_sales          : unit_price (prix au m³ au moment de la vente),
--                         quantity_m3, total_amount, destination, product_name
--   sand_proforma_lines : quantity, unit_price, line_total
--   sand_invoices       : total_amount
-- Seul « quantity_reference » (le palier : 10 m³) n'existait QUE dans
-- sand_prices, c'est-à-dire dans le catalogue COURANT. Un document ancien
-- devait donc rejoindre le catalogue pour afficher sa colonne « Prix 10 m³ »,
-- et changeait d'apparence dès qu'un administrateur modifiait le tarif.
--
-- On stocke donc le palier utilisé sur l'EN-TÊTE de chaque document (un seul
-- palier par opération : pas de duplication ligne à ligne).
-- Le prix du palier n'est PAS stocké : il se recalcule exactement par
-- unit_price × price_reference_qty, deux valeurs désormais historiques.
--
-- Migration NON destructive : ajout de colonnes + backfill. Aucune ligne
-- supprimée, aucun montant modifié. Rejouable sans erreur.

BEGIN;

ALTER TABLE sand_sales
  ADD COLUMN IF NOT EXISTS price_reference_qty NUMERIC;

ALTER TABLE sand_proformas
  ADD COLUMN IF NOT EXISTS price_reference_qty NUMERIC;

-- Reprise de l'historique : pour les documents déjà créés, le palier n'a jamais
-- été enregistré. On prend celui du tarif ACTUEL de la destination — c'est la
-- meilleure information disponible, et elle est exacte tant qu'aucun palier n'a
-- encore changé (cas au moment de cette migration). À défaut : 10 m³.
UPDATE sand_sales s
   SET price_reference_qty = COALESCE((
         SELECT p.quantity_reference
           FROM sand_prices p
          WHERE p.company_id = s.company_id
            AND LOWER(p.destination) = LOWER(COALESCE(s.destination, ''))
          ORDER BY p.id DESC
          LIMIT 1
       ), 10)
 WHERE price_reference_qty IS NULL;

UPDATE sand_proformas pf
   SET price_reference_qty = COALESCE((
         SELECT p.quantity_reference
           FROM sand_prices p
          WHERE p.company_id = pf.company_id
            AND LOWER(p.destination) = LOWER(COALESCE(pf.destination, ''))
          ORDER BY p.id DESC
          LIMIT 1
       ), 10)
 WHERE price_reference_qty IS NULL;

COMMIT;
