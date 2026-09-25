-- 098 — UNE PÉRIODE PEUT NE PAS RETENIR SES ABSENCES, ET ON SAIT POURQUOI
--
-- Septembre 2026 : le pointage a connu des incidents, et tous les salariés
-- n'ont pas pu pointer. La Direction décide que, pour CETTE période seulement,
-- aucune absence ne réduit le salaire.
--
-- Deux façons de le faire, et une seule est honnête.
--
-- La première serait d'écrire, pour chaque salarié et chaque jour manquant, une
-- régularisation disant « présent ». Environ six cents lignes affirmant qu'une
-- personne était là un jour donné — ce que personne n'a constaté. Le pointage
-- cesserait de dire la vérité, et plus jamais on ne pourrait savoir quels jours
-- avaient réellement manqué.
--
-- La seconde, retenue ici : la période porte la décision. Les absences restent
-- enregistrées telles qu'elles sont, visibles sur chaque bulletin, et elles ne
-- réduisent pas le salaire. La paie dit alors exactement ce qui s'est passé :
-- « 3 jours manquants, non retenus, par décision du <date> de <qui>, motif ».
--
-- La portée est la période, et rien d'autre. La période suivante repart au
-- comportement normal sans qu'on ait à défaire quoi que ce soit — c'est
-- précisément ce qu'un réglage global n'aurait pas permis.
--
-- Additive, idempotente, réversible : remettre le drapeau à FALSE et préparer à
-- nouveau la paie suffit à revenir au calcul habituel. Aucune ligne existante
-- n'est modifiée ; la valeur par défaut FALSE décrit l'état actuel.

BEGIN;

ALTER TABLE attendance_periods
  ADD COLUMN IF NOT EXISTS absences_non_retenues BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS absences_non_retenues_motif TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS absences_non_retenues_par INTEGER,
  ADD COLUMN IF NOT EXISTS absences_non_retenues_le TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE attendance_periods
    ADD CONSTRAINT attendance_periods_absences_non_retenues_par_fkey
    FOREIGN KEY (absences_non_retenues_par) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/* Une exception sans motif ni auteur ne se relit pas six mois plus tard, quand
   il faudra expliquer pourquoi ce mois-là ne ressemble à aucun autre. */
DO $$ BEGIN
  ALTER TABLE attendance_periods
    ADD CONSTRAINT attendance_periods_exception_justifiee
    CHECK (NOT absences_non_retenues
           OR (BTRIM(absences_non_retenues_motif) <> ''
               AND absences_non_retenues_le IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/* La part de salaire qu'une absence aurait retirée, si elle avait été retenue.
   Sans elle, on ne pourrait plus chiffrer ce que l'exception a coûté. */
ALTER TABLE attendance_payroll_items_v2
  ADD COLUMN IF NOT EXISTS absence_deduction_annulee NUMERIC(14,2) NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE attendance_payroll_items_v2
    ADD CONSTRAINT attendance_payroll_items_annulee_non_negatif
    CHECK (absence_deduction_annulee >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE exceptions INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'attendance_periods'
                    AND column_name = 'absences_non_retenues') THEN
    RAISE EXCEPTION '098 : la colonne absences_non_retenues est absente.';
  END IF;

  SELECT count(*) INTO exceptions FROM attendance_periods WHERE absences_non_retenues;
  IF exceptions > 0 THEN
    RAISE NOTICE '098 : % période(s) portent déjà une exception d''absences.', exceptions;
  ELSE
    RAISE NOTICE '098 : aucune exception posée. Toutes les périodes retiennent leurs absences, comme avant.';
  END IF;
END $$;
