-- 088 — PAYER EXIGE UNE VALIDATION, ET L'EXCEPTION HISTORIQUE EST NOMMÉE
--
-- La migration 081 a posé le chemin comptable → Direction → paiement. Le
-- verrou côté route, lui, était trop large : il n'exigeait une demande
-- validée que si une demande EXISTAIT DÉJÀ. Une paie neuve, rattachée à une
-- période, mais dont personne n'avait encore rien soumis, restait donc
-- payable — c'est-à-dire exactement le cas qu'il fallait fermer. Le comptable
-- n'avait qu'à ne pas soumettre pour n'avoir personne à convaincre.
--
-- La difficulté était réelle : on ne peut pas bloquer rétroactivement les
-- paies mensuelles enregistrées avant ce chantier, sous peine d'empêcher de
-- solder ce qui est en cours. Mais « aucune demande » ne peut pas servir de
-- laissez-passer, sinon toute paie neuve emprunte la porte des anciennes.
--
-- On NOMME donc l'exception au lieu de la déduire. Cette migration marque, une
-- fois pour toutes, les paies qui existaient au moment où elle s'applique :
-- celles-là, et elles seules, gardent l'ancien comportement. Toute paie créée
-- ensuite naît avec le drapeau à FALSE et devra passer par la Direction.
--
-- L'exception ne peut donc pas s'élargir : elle ne dépend ni d'une date
-- approximative, ni de l'absence d'un objet, mais d'un fait figé au moment de
-- la migration.

BEGIN;

ALTER TABLE attendance_payroll_runs_v2
  ADD COLUMN IF NOT EXISTS legacy_sans_validation BOOLEAN NOT NULL DEFAULT false;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- LE MARQUAGE, GARDÉ PAR UN TÉMOIN
--
-- Sans ce témoin, un rejeu de la migration marquerait comme « historiques »
-- les paies créées entre-temps — exactement ce qu'on veut interdire. Le
-- marquage n'a donc lieu qu'une fois, à la première application.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS schema_milestones (
  key         TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT NOT NULL DEFAULT ''
);

DO $$
DECLARE marquees INTEGER := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_milestones WHERE key = '088_paiement_sous_validation') THEN
    UPDATE attendance_payroll_runs_v2
       SET legacy_sans_validation = true
     WHERE period_id IS NULL;
    GET DIAGNOSTICS marquees = ROW_COUNT;

    INSERT INTO schema_milestones (key, note)
    VALUES ('088_paiement_sous_validation',
            format('%s paie(s) sans période marquée(s) historiques ; toute paie créée ensuite exige une validation.', marquees));

    RAISE NOTICE '088 : % paie(s) existante(s) sans période conservent l''ancien comportement.', marquees;
  ELSE
    RAISE NOTICE '088 : le marquage historique a déjà eu lieu — aucune paie neuve n''est requalifiée.';
  END IF;
END $$;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- UNE SEULE PAIE PAR PÉRIODE ET PAR SOCIÉTÉ
--
-- L'unicité existante porte sur `period_month`, un mois civil. Elle ne dit
-- donc rien de la période réelle du 25 au 24 : deux paies pouvaient viser la
-- même période, et payer deux fois les mêmes journées. Index PARTIEL, parce
-- que les anciennes paies mensuelles n'ont pas de période et doivent le
-- rester.
-- ═════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_runs_une_par_periode
  ON attendance_payroll_runs_v2 (company_id, period_id)
  WHERE period_id IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE fautives INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'attendance_payroll_runs_v2'
                    AND column_name = 'legacy_sans_validation') THEN
    RAISE EXCEPTION '088 : sans ce drapeau, toute paie neuve emprunterait la porte des anciennes.';
  END IF;

  /* Une paie rattachée à une période ne doit JAMAIS être historique : c'est la
     forme même que prend le contournement qu'on ferme ici. */
  SELECT count(*) INTO fautives
    FROM attendance_payroll_runs_v2
   WHERE legacy_sans_validation AND period_id IS NOT NULL;
  IF fautives > 0 THEN
    RAISE WARNING '088 : % paie(s) portent une période ET le drapeau historique. Elles doivent repasser par la Direction.', fautives;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_payroll_runs_une_par_periode') THEN
    RAISE EXCEPTION '088 : sans unicité par période, deux paies pourraient payer les mêmes journées.';
  END IF;

  RAISE NOTICE 'Paiement de la paie : la validation de la Direction est désormais incontournable pour toute paie neuve.';
END $$;
