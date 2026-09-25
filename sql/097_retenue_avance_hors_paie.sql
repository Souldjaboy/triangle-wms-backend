-- 097 — DISTINGUER UNE RETENUE FAITE PAR LA PAIE D'UNE RETENUE ENREGISTRÉE AILLEURS
--
-- `advance_deduction` disait « ce que cette préparation de paie a retenu ».
-- Or une retenue peut avoir été enregistrée hors de l'application — c'est le
-- cas des avances historiques reprises par script, dont les remboursements
-- portent `payroll_item_id = NULL` faute de ligne de paie à désigner au moment
-- de l'import.
--
-- Conséquence observée en production : l'échéance de septembre est RETENUE, le
-- remboursement existe, le solde est juste — et le bulletin de septembre
-- annonce un net complet, sans aucune ligne d'avance. Le journal et la paie
-- disaient deux choses différentes du même argent.
--
-- La paie devient une projection du journal : `advance_deduction` porte le
-- TOTAL retenu pour la période, et cette colonne dit quelle part n'a pas été
-- produite par la préparation. Sans elle, personne ne pourrait distinguer les
-- deux, et la régénération risquerait un jour de « rendre » un solde qu'elle
-- n'avait pas prélevé.
--
-- Additive, idempotente, réversible : cesser de lire la colonne suffit à
-- revenir au comportement précédent. Aucune ligne existante n'est modifiée —
-- la valeur par défaut 0 décrit exactement l'état actuel.

BEGIN;

ALTER TABLE attendance_payroll_items_v2
  ADD COLUMN IF NOT EXISTS advance_deduction_externe NUMERIC(14,2) NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE attendance_payroll_items_v2
    ADD CONSTRAINT attendance_payroll_items_externe_non_negatif
    CHECK (advance_deduction_externe >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/* Retrouver les remboursements de retenue qui ne désignent aucune ligne de
   paie : la requête que fait désormais chaque préparation, pour chaque
   salarié. Sans cet index elle balaierait tout le journal. */
CREATE INDEX IF NOT EXISTS idx_advance_repayments_sans_ligne
  ON salary_advance_repayments (advance_id, installment_id)
  WHERE payroll_item_id IS NULL AND origin = 'RETENUE_PAIE';

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE orphelines INTEGER; montant NUMERIC;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'attendance_payroll_items_v2'
                    AND column_name = 'advance_deduction_externe') THEN
    RAISE EXCEPTION '097 : la colonne advance_deduction_externe est absente.';
  END IF;

  SELECT count(*), COALESCE(sum(amount), 0) INTO orphelines, montant
    FROM salary_advance_repayments
   WHERE payroll_item_id IS NULL AND origin = 'RETENUE_PAIE';

  IF orphelines > 0 THEN
    RAISE NOTICE '097 : % retenue(s) enregistrée(s) hors paie, pour % FCFA. '
                 'Elles apparaîtront désormais sur la paie de leur période. '
                 'Aucune n''est modifiée.', orphelines, montant;
  ELSE
    RAISE NOTICE '097 : aucune retenue orpheline. La colonne reste à 0 partout.';
  END IF;
END $$;
