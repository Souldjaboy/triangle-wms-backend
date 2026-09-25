-- ═════════════════════════════════════════════════════════════════════════
-- 101 — POINTAGE BRUT ET POINTAGE OFFICIEL
--
-- LE PROBLÈME
--
-- La migration 098 a permis à une période de ne pas RETENIR les absences : la
-- paie n'en déduit plus rien. Mais le rapport officiel, lui, continuait
-- d'annoncer « Absences : 110 » — parce que le compte d'absences et la
-- décision de ne pas les retenir vivaient à deux endroits différents, et que
-- le rapport ne connaissait que le premier.
--
-- Un document officiel qui annonce 110 absences pendant que la paie n'en
-- retient aucune n'est pas une nuance : ce sont deux vérités contradictoires
-- sur le même mois, signées par la même entreprise.
--
-- CE QUE CETTE MIGRATION FAIT
--
-- Elle sépare ce que la MACHINE a enregistré de ce que l'ENTREPRISE retient :
--
--   • `*_brut`     — ce que les pointages disent. Jamais modifié, jamais mis à
--                    zéro. C'est la matière de l'audit.
--   • `*_officiel` — ce que l'entreprise retient après décision administrative.
--                    C'est ce qui va au rapport, au bulletin et à la paie.
--
-- Les colonnes historiques `absence_days` et `late_minutes` portent désormais
-- la valeur OFFICIELLE. Tous les écrans et toutes les impressions qui les
-- lisent deviennent donc justes sans être modifiés, et rien n'est perdu :
-- le brut est à côté.
--
-- CE QU'ELLE NE FAIT PAS
--
-- Elle ne supprime aucun pointage, n'en crée aucun, et n'écrit « présent »
-- nulle part. Une régularisation administrative n'est pas une présence
-- constatée. Elle ne touche pas non plus aux avances, aux remboursements ni
-- aux salaires : zéro absence ne veut pas dire zéro retenue d'avance.
--
-- Elle n'active rien pour septembre : c'est la ROUTE de la période qui pose la
-- décision, avec son motif et son auteur. Aucune date n'est écrite ici.
--
-- Additive et idempotente.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. LES RETARDS AUSSI PEUVENT ÊTRE NEUTRALISÉS — mais SÉPARÉMENT
--
-- Un drapeau distinct, et non un effet de bord de l'exception d'absences :
-- décider que des retards ne sont pas opposables est une décision à part, qui
-- porte son propre motif et son propre auteur. Une période peut très bien
-- neutraliser les absences et garder ses retards.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE attendance_periods
  ADD COLUMN IF NOT EXISTS retards_non_retenus BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS retards_non_retenus_motif TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS retards_non_retenus_par INTEGER,
  ADD COLUMN IF NOT EXISTS retards_non_retenus_le TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE attendance_periods
    ADD CONSTRAINT attendance_periods_retards_non_retenus_par_fkey
    FOREIGN KEY (retards_non_retenus_par) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE attendance_periods
    ADD CONSTRAINT attendance_periods_retards_justifies
    CHECK (NOT retards_non_retenus
           OR (BTRIM(retards_non_retenus_motif) <> ''
               AND retards_non_retenus_le IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. LA LIGNE DE PAIE PORTE LES DEUX VALEURS
--
-- `absence_days` et `late_minutes` existent déjà et deviennent l'OFFICIEL.
-- Les deux colonnes ajoutées ici disent d'où l'on vient — et le brut est
-- initialisé avec la valeur actuelle, qui est bien le brut : jusqu'à présent,
-- aucune exception n'avait encore été posée sur une paie enregistrée.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE attendance_payroll_items_v2
  ADD COLUMN IF NOT EXISTS absence_days_brut     INTEGER,
  ADD COLUMN IF NOT EXISTS absence_days_officiel INTEGER,
  ADD COLUMN IF NOT EXISTS late_minutes_brut     INTEGER,
  ADD COLUMN IF NOT EXISTS late_minutes_officiel INTEGER,
  /* Ce que la régularisation a neutralisé, chiffré : sans cela, personne ne
     pourrait dire des mois plus tard ce que ce mois-là a représenté. */
  ADD COLUMN IF NOT EXISTS absences_neutralisees INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retards_neutralises   INTEGER NOT NULL DEFAULT 0;

UPDATE attendance_payroll_items_v2
   SET absence_days_brut     = COALESCE(absence_days_brut, absence_days),
       absence_days_officiel = COALESCE(absence_days_officiel, absence_days),
       late_minutes_brut     = COALESCE(late_minutes_brut, late_minutes),
       late_minutes_officiel = COALESCE(late_minutes_officiel, late_minutes)
 WHERE absence_days_brut IS NULL OR absence_days_officiel IS NULL
    OR late_minutes_brut IS NULL OR late_minutes_officiel IS NULL;

DO $$ BEGIN
  /* L'officiel ne peut pas dépasser le brut : on neutralise des absences, on
     n'en invente pas. Une inégalité dans l'autre sens serait le signe d'un
     calcul qui s'est trompé de source. */
  ALTER TABLE attendance_payroll_items_v2
    ADD CONSTRAINT attendance_payroll_items_officiel_borne
    CHECK (absence_days_officiel IS NULL OR absence_days_brut IS NULL
           OR absence_days_officiel <= absence_days_brut);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE incoherentes INTEGER; sans_brut INTEGER;
BEGIN
  SELECT count(*) INTO sans_brut FROM attendance_payroll_items_v2
   WHERE absence_days_brut IS NULL;
  SELECT count(*) INTO incoherentes FROM attendance_payroll_items_v2
   WHERE absence_days_officiel > absence_days_brut;

  IF sans_brut > 0 THEN
    RAISE EXCEPTION '101 : % ligne(s) sans absences brutes : l''audit perdrait sa matière.', sans_brut;
  END IF;
  IF incoherentes > 0 THEN
    RAISE EXCEPTION '101 : % ligne(s) annoncent plus d''absences officielles que de brutes.', incoherentes;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'attendance_periods' AND column_name = 'retards_non_retenus') THEN
    RAISE EXCEPTION '101 : sans drapeau distinct, neutraliser des retards deviendrait un effet de bord.';
  END IF;
  RAISE NOTICE 'Brut et officiel séparés. Le brut n''est jamais remis à zéro ; l''officiel est ce que l''entreprise retient.';
END $$;
