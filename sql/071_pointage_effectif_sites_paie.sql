-- Triangle WMS Pro — pointage opérationnel multi-sites.
-- Migration additive : elle ne supprime ni utilisateurs ni anciens pointages.

BEGIN;

CREATE TABLE IF NOT EXISTS attendance_work_sites (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  site_type TEXT NOT NULL CHECK (site_type IN ('OFFICE','WAREHOUSE')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS attendance_work_schedules (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS attendance_schedule_days (
  id SERIAL PRIMARY KEY,
  schedule_id INTEGER NOT NULL REFERENCES attendance_work_schedules(id) ON DELETE CASCADE,
  iso_weekday SMALLINT NOT NULL CHECK (iso_weekday BETWEEN 1 AND 7),
  is_working_day BOOLEAN NOT NULL DEFAULT TRUE,
  start_time TIME,
  end_time TIME,
  break_start TIME,
  break_end TIME,
  UNIQUE (schedule_id, iso_weekday),
  CHECK (NOT is_working_day OR (start_time IS NOT NULL AND end_time IS NOT NULL)),
  CHECK (break_start IS NULL OR break_end IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS attendance_employees (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_number INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  site_id INTEGER REFERENCES attendance_work_sites(id) ON DELETE RESTRICT,
  schedule_id INTEGER REFERENCES attendance_work_schedules(id) ON DELETE RESTRICT,
  job_title TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, employee_number),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_employee_user
  ON attendance_employees(company_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS attendance_operator_scopes (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  operator_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES attendance_work_sites(id) ON DELETE CASCADE,
  can_punch BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, operator_user_id, site_id)
);

CREATE TABLE IF NOT EXISTS attendance_salary_viewers (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, user_id)
);

CREATE TABLE IF NOT EXISTS attendance_salary_settings_v2 (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES attendance_employees(id) ON DELETE CASCADE,
  daily_rate NUMERIC(14,2),
  effective_from DATE NOT NULL,
  effective_to DATE,
  set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (employee_id, effective_from),
  CHECK (daily_rate IS NULL OR daily_rate >= 0),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE IF NOT EXISTS attendance_day_records_v2 (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES attendance_employees(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  check_in TIMESTAMPTZ,
  break_out TIMESTAMPTZ,
  break_in TIMESTAMPTZ,
  check_out TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ABSENT',
  late_minutes INTEGER NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  worked_minutes INTEGER NOT NULL DEFAULT 0 CHECK (worked_minutes >= 0),
  punched_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS attendance_event_log_v2 (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES attendance_employees(id) ON DELETE CASCADE,
  record_id INTEGER NOT NULL REFERENCES attendance_day_records_v2(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('CHECK_IN','BREAK_OUT','BREAK_IN','CHECK_OUT')),
  event_at TIMESTAMPTZ NOT NULL,
  performed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'WEB',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendance_salary_adjustments_v2 (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES attendance_employees(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount <> 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendance_company_configuration (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  official_start_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Africa/Bamako',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendance_reset_archives (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reset_key TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (company_id, reset_key, source_table, source_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_employees_site ON attendance_employees(company_id, site_id, active);
CREATE INDEX IF NOT EXISTS idx_attendance_records_date ON attendance_day_records_v2(company_id, work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_events_employee ON attendance_event_log_v2(company_id, employee_id, event_at);
CREATE INDEX IF NOT EXISTS idx_attendance_adjustments_employee ON attendance_salary_adjustments_v2(company_id, employee_id, work_date);

COMMIT;
