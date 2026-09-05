-- 086 — RÉGULARISER SANS RÉÉCRIRE
--
-- Triangle n'a pas pointé du 25 août 2026 à la mise en service. Ces journées
-- ont pourtant été travaillées, et la paie doit pouvoir les compter.
--
-- Le piège serait d'écrire directement dans `attendance_day_records_v2` des
-- arrivées à 08h00 et des départs à 17h00 : plus rien ne distinguerait alors
-- un pointage réel d'un pointage supposé, ni sur l'écran, ni dans un rapport,
-- ni des mois plus tard quand quelqu'un contestera une absence.
--
-- On sépare donc ce qui a été CONSTATÉ de ce qui a été RETENU :
--
--   • `attendance_day_records_v2` garde ses valeurs d'origine — souvent
--     aucune, puisque personne n'a pointé ;
--   • `attendance_regularizations` porte la valeur EFFECTIVE, son motif, son
--     auteur et le lot qui l'a produite.
--
-- Les rapports et la paie lisent l'effectif ; l'audit garde l'original. Une
-- absence réelle se marque ensuite par-dessus, sans rien effacer.
--
-- `attendance_regularization_batches` regroupe une exécution du script : sa
-- clé d'idempotence est ce qui rend un second passage inoffensif, et une
-- exécution simultanée impossible.

BEGIN;

CREATE TABLE IF NOT EXISTS attendance_regularization_batches (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  date_from   DATE NOT NULL,
  date_to     DATE NOT NULL,
  saturday_mode TEXT NOT NULL DEFAULT 'NORMAL',
  holidays    DATE[] NOT NULL DEFAULT '{}',
  default_check_in  TIME NOT NULL DEFAULT '08:00',
  default_check_out TIME NOT NULL DEFAULT '17:00',
  reason      TEXT NOT NULL,
  employees_count INTEGER NOT NULL DEFAULT 0,
  days_count      INTEGER NOT NULL DEFAULT 0,
  performed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_regularization_batches_key') THEN
    ALTER TABLE attendance_regularization_batches
      ADD CONSTRAINT attendance_regularization_batches_key UNIQUE (company_id, idempotency_key);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_regularization_batches_bornes_check') THEN
    ALTER TABLE attendance_regularization_batches
      ADD CONSTRAINT attendance_regularization_batches_bornes_check CHECK (date_to >= date_from);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS attendance_regularizations (
  id          BIGSERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  batch_id    INTEGER REFERENCES attendance_regularization_batches(id) ON DELETE SET NULL,
  employee_id INTEGER NOT NULL REFERENCES attendance_employees(id) ON DELETE CASCADE,
  record_id   INTEGER REFERENCES attendance_day_records_v2(id) ON DELETE SET NULL,
  work_date   DATE NOT NULL,

  /* CE QUI ÉTAIT — souvent rien, et c'est précisément ce qu'il faut garder. */
  original_check_in  TIMESTAMPTZ,
  original_check_out TIMESTAMPTZ,
  original_status    TEXT NOT NULL DEFAULT '',

  /* CE QUI EST RETENU. */
  effective_check_in  TIMESTAMPTZ,
  effective_check_out TIMESTAMPTZ,
  effective_status    TEXT NOT NULL,

  reason      TEXT NOT NULL,
  performed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  /* Une absence réelle marquée après coup PAR-DESSUS la régularisation. On ne
     supprime pas la ligne : on note qu'elle a été corrigée, par qui et
     pourquoi. */
  overridden_at     TIMESTAMPTZ,
  overridden_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  overridden_status TEXT NOT NULL DEFAULT '',
  override_reason   TEXT NOT NULL DEFAULT ''
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_regularizations_statut_check') THEN
    ALTER TABLE attendance_regularizations
      ADD CONSTRAINT attendance_regularizations_statut_check
      CHECK (effective_status IN ('PRESENT','LATE','COMPLETED','ABSENT','ABSENCE_JUSTIFIEE','REPOS','FERIE'));
  END IF;
END $$;

/* Une seule régularisation par employé et par jour : c'est ce qui rend le
   second passage du script inoffensif, et une exécution simultanée
   incapable de doubler quoi que ce soit. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_regularizations_unique
  ON attendance_regularizations (company_id, employee_id, work_date);

CREATE INDEX IF NOT EXISTS idx_attendance_regularizations_lot
  ON attendance_regularizations (batch_id);

-- ═════════════════════════════════════════════════════════════════════════
-- LES DROITS
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO permission_modules (module_key, parent_key, label, description, sort_order, is_active, is_system, actions) VALUES
  ('pointage.regularisation', 'pointage', 'Régularisation de pointage',
   'Retenir des journées non pointées, et marquer les absences réelles par-dessus.',
   310, true, false,
   ARRAY['visible','view','create','update','audit','export'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      label = EXCLUDED.label, parent_key = EXCLUDED.parent_key, updated_at = now();

COMMIT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_attendance_regularizations_unique') THEN
    RAISE EXCEPTION '086 : sans unicité par employé et par jour, un second passage doublerait les journées.';
  END IF;
  RAISE NOTICE 'Régularisation : valeur d''origine et valeur effective séparées, lots idempotents.';
END $$;
