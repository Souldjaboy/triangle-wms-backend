-- 076 — CORRIGER UN POINTAGE, AVEC MOTIF ET TRACE COMPLÈTE
--
-- Le système de pointage v2 (071-072) sait enregistrer arrivée, pause,
-- retour et fin — mais rien ne permet de corriger une de ces quatre entrées
-- après coup. Une personne qui pointe pour un chantier, oublie une pause ou
-- se trompe d'heure au moment de la saisie n'a aujourd'hui aucun moyen de le
-- réparer sans passer par la base directement.
--
-- Additive, idempotente. Ne touche à aucune ligne existante de
-- `attendance_day_records_v2` ni `attendance_event_log_v2`.

BEGIN;

CREATE TABLE IF NOT EXISTS attendance_day_record_corrections (
  id                BIGSERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  record_id         INTEGER NOT NULL REFERENCES attendance_day_records_v2(id) ON DELETE CASCADE,
  employee_id       INTEGER NOT NULL REFERENCES attendance_employees(id) ON DELETE CASCADE,
  field             TEXT NOT NULL CHECK (field IN ('check_in','break_out','break_in','check_out','status')),
  reason            TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  old_value         JSONB NOT NULL,
  new_value         JSONB NOT NULL,
  corrected_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  corrected_by_name TEXT NOT NULL DEFAULT '',
  corrected_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendance_corrections_record
  ON attendance_day_record_corrections(company_id, record_id, corrected_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_corrections_employee
  ON attendance_day_record_corrections(company_id, employee_id, corrected_at DESC);

COMMIT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_name = 'attendance_day_record_corrections') THEN
    RAISE EXCEPTION 'Sans cette table, une correction de pointage ne laisserait aucune trace.';
  END IF;
  RAISE NOTICE 'Correction de pointage : schéma conforme.';
END $$;
