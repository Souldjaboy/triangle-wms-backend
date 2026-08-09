-- ============================================================
-- CORRECTION CIBLÉE — vente sable VS-260807-001 (production)
-- ============================================================
--
-- CE N'EST PAS UNE MIGRATION. Script de correction de données, à exécuter UNE
-- fois, manuellement, après lecture du plan. Il ne s'applique qu'à UN document.
--
-- ANOMALIE : la vente a été saisie avec le prix du PALIER (170 000 FCFA pour
-- 10 m³) dans le champ « prix au m³ ». Résultat : 10 × 170 000 = 1 700 000 au
-- lieu de 170 000. Le tarif de production confirme 10 m³ = 170 000, soit
-- 17 000 FCFA/m³.
--
-- CE QUI N'EST PAS TOUCHÉ :
--   - aucune ligne supprimée, aucun document renuméroté ;
--   - identifiants, numéros, dates, client, camion, chauffeur : inchangés ;
--   - le bon de livraison BL-SAB-260807-001 ne porte aucun montant ;
--   - paid_amount reste 0 ;
--   - le module Sable ne génère aucune écriture comptable ni mouvement de
--     trésorerie (vérifié : 0 référence dans routes/sand-sales.js), il n'y a
--     donc rien à rééquilibrer ailleurs.
--
-- SÉCURITÉ : tout se joue dans UNE transaction. Chaque hypothèse est vérifiée
-- AVANT écriture, et le moindre écart déclenche une exception, donc un
-- ROLLBACK automatique et intégral.
--
-- Usage :
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f fix-sand-sale-VS-260807-001.sql

\echo '=== ÉTAT AVANT ==='
SELECT s.sale_number, s.quantity_m3, s.unit_price, s.sand_subtotal,
       s.total_amount, s.remaining_amount, s.price_reference_qty,
       i.invoice_number, i.total_amount AS facture_total,
       i.paid_amount AS facture_payee, i.remaining_amount AS facture_reste, i.status
  FROM sand_sales s
  LEFT JOIN sand_invoices i ON i.sale_id = s.id AND i.company_id = s.company_id
 WHERE s.sale_number = 'VS-260807-001';

BEGIN;

DO $$
DECLARE
  v_sale       sand_sales%ROWTYPE;
  v_qty        NUMERIC;
  v_ref_qty    NUMERIC;
  v_ref_price  NUMERIC;
  v_unit       NUMERIC;
  v_total      NUMERIC;
  v_payments   INTEGER;
  v_invoices   INTEGER;
BEGIN
  -- 1. La vente doit exister, et une seule fois.
  SELECT * INTO v_sale FROM sand_sales WHERE sale_number = 'VS-260807-001';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vente VS-260807-001 introuvable — rien n''est modifié.';
  END IF;

  -- 2. Refus si la vente a déjà été corrigée (script rejouable sans dégât).
  IF v_sale.unit_price = 17000 THEN
    RAISE EXCEPTION 'Déjà corrigée (unit_price=17000) — aucune action.';
  END IF;

  -- 3. On ne corrige QUE le cas d'anomalie connu, jamais autre chose.
  IF v_sale.unit_price <> 170000 OR v_sale.quantity_m3 <> 10 THEN
    RAISE EXCEPTION 'Valeurs inattendues (unit_price=%, quantity=%) : correction refusée.',
      v_sale.unit_price, v_sale.quantity_m3;
  END IF;

  -- 4. Un paiement déjà encaissé changerait le raisonnement : on s'arrête.
  SELECT COUNT(*) INTO v_payments
    FROM sand_payments p
    JOIN sand_invoices i ON i.id = p.invoice_id
   WHERE i.sale_id = v_sale.id;
  IF v_payments > 0 THEN
    RAISE EXCEPTION 'La facture porte % paiement(s) : correction refusée, à traiter manuellement.', v_payments;
  END IF;

  -- 5. Le tarif de référence vient du CATALOGUE de la destination, jamais de
  --    unit_price (qui est précisément la valeur erronée).
  SELECT quantity_reference, price INTO v_ref_qty, v_ref_price
    FROM sand_prices
   WHERE company_id = v_sale.company_id
     AND LOWER(destination) = LOWER(v_sale.destination)
     AND status = 'ACTIF'
   ORDER BY id DESC LIMIT 1;
  IF v_ref_qty IS NULL OR v_ref_qty <= 0 OR v_ref_price IS NULL THEN
    RAISE EXCEPTION 'Aucun tarif actif pour % : correction refusée.', v_sale.destination;
  END IF;

  v_qty  := v_sale.quantity_m3;
  v_unit := v_ref_price / v_ref_qty;          -- 170 000 / 10 = 17 000
  v_total := ROUND(v_qty * v_unit, 2)
             + COALESCE(v_sale.transport_total, 0)
             - COALESCE(v_sale.discount, 0)
             + COALESCE(v_sale.tax_amount, 0);

  -- 6. Garde-fou métier : pour 10 m³ au tarif Bamako, on attend 170 000.
  IF v_total <> 170000 THEN
    RAISE EXCEPTION 'Total recalculé inattendu (%) : correction refusée.', v_total;
  END IF;

  UPDATE sand_sales
     SET unit_price          = v_unit,
         sand_subtotal       = ROUND(v_qty * v_unit, 2),
         total_amount        = v_total,
         remaining_amount    = v_total - COALESCE(paid_amount, 0),
         price_reference_qty = COALESCE(price_reference_qty, v_ref_qty),
         updated_at          = NOW()
   WHERE id = v_sale.id;

  UPDATE sand_invoices
     SET total_amount     = v_total,
         remaining_amount = v_total - COALESCE(paid_amount, 0),
         status           = CASE WHEN COALESCE(paid_amount,0) >= v_total THEN 'PAYEE'
                                 WHEN COALESCE(paid_amount,0) > 0 THEN 'PARTIELLEMENT_PAYEE'
                                 ELSE 'IMPAYEE' END,
         updated_at       = NOW()
   WHERE sale_id = v_sale.id AND company_id = v_sale.company_id;
  GET DIAGNOSTICS v_invoices = ROW_COUNT;
  IF v_invoices <> 1 THEN
    RAISE EXCEPTION '% facture(s) touchée(s) au lieu d''une seule : ROLLBACK.', v_invoices;
  END IF;

  -- 7. Cohérence finale vente <-> facture, sinon ROLLBACK.
  PERFORM 1 FROM sand_sales s
     JOIN sand_invoices i ON i.sale_id = s.id AND i.company_id = s.company_id
    WHERE s.id = v_sale.id
      AND s.total_amount = i.total_amount
      AND i.remaining_amount = i.total_amount - i.paid_amount
      AND s.unit_price * s.price_reference_qty = v_ref_price;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incohérence après correction : ROLLBACK intégral.';
  END IF;

  RAISE NOTICE 'OK — % m3 x % = % FCFA (Prix % m3 = %)',
    v_qty, v_unit, v_total, v_ref_qty, v_ref_price;
END $$;

COMMIT;

\echo '=== ÉTAT APRÈS ==='
SELECT s.sale_number, s.quantity_m3, s.unit_price, s.sand_subtotal,
       s.total_amount, s.remaining_amount, s.price_reference_qty,
       (s.unit_price * s.price_reference_qty) AS prix_palier_affiche,
       i.invoice_number, i.total_amount AS facture_total,
       i.paid_amount AS facture_payee, i.remaining_amount AS facture_reste, i.status
  FROM sand_sales s
  LEFT JOIN sand_invoices i ON i.sale_id = s.id AND i.company_id = s.company_id
 WHERE s.sale_number = 'VS-260807-001';
