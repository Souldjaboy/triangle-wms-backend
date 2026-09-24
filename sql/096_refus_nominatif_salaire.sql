-- 096 — LA TABLE QUE LE CODE INTERROGE DÉJÀ
--
-- `canViewAllSalaries()` (services/attendance-workforce.js) lit
-- `attendance_salary_denials` pour qu'un refus nominatif l'emporte sur le
-- rôle — une comptable peut ainsi consulter les pointages sans voir les
-- salaires. Mais aucune migration ne crée cette table.
--
-- Sur une base reconstruite depuis les migrations seules, la lecture échoue
-- avec « relation does not exist », et comme elle est la PREMIÈRE instruction
-- de la fonction, c'est tout l'écran de l'effectif qui tombe : la liste des
-- salariés, l'ajout, le retrait. Un droit destiné à restreindre l'accès
-- finissait par interdire l'accès à tout le monde.
--
-- La table reprend exactement la forme de sa jumelle
-- `attendance_salary_viewers` (071) : mêmes colonnes, même unicité. Les deux
-- répondent à la même question, dans les deux sens.
--
-- Additive et idempotente : sans effet là où la table a déjà été créée à la
-- main. Aucune ligne n'est insérée — un refus se pose explicitement, il ne
-- s'hérite pas.

BEGIN;

CREATE TABLE IF NOT EXISTS attendance_salary_denials (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, user_id)
);

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE refus INTEGER;
BEGIN
  IF to_regclass('public.attendance_salary_denials') IS NULL THEN
    RAISE EXCEPTION '096 : la table attendance_salary_denials est absente.';
  END IF;
  SELECT count(*) INTO refus FROM attendance_salary_denials;
  RAISE NOTICE 'Refus nominatifs de salaire : table en place, % ligne(s) existante(s) conservée(s).', refus;
END $$;
