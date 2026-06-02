-- Triangle WMS Pro - Multi-site GPS attendance
-- Safe additive migration: no DROP TABLE, no data deletion.

CREATE TABLE IF NOT EXISTS attendance_sites (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  nom_du_site TEXT NOT NULL,
  latitude DECIMAL(10,7) NOT NULL,
  longitude DECIMAL(10,7) NOT NULL,
  rayon_autorise_metre INTEGER DEFAULT 100,
  actif BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS employee_attendance_sites (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  attendance_site_id INTEGER NOT NULL,
  company_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, attendance_site_id)
);

ALTER TABLE attendance_gps_settings ADD COLUMN IF NOT EXISTS allow_out_of_zone_global BOOLEAN DEFAULT false;

ALTER TABLE attendance_settings ADD COLUMN IF NOT EXISTS primary_attendance_site_id INTEGER;
ALTER TABLE attendance_settings ADD COLUMN IF NOT EXISTS employee_mobile BOOLEAN DEFAULT false;
ALTER TABLE attendance_settings ADD COLUMN IF NOT EXISTS allow_out_of_zone BOOLEAN DEFAULT false;

ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_attendance_site_id INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_mobile BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS allow_out_of_zone BOOLEAN DEFAULT false;

ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS attendance_site_id INTEGER;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS attendance_site_name TEXT DEFAULT '';
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS gps_status TEXT DEFAULT '';

ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS attendance_site_id INTEGER;
ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS attendance_site_name TEXT DEFAULT '';
ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS gps_status TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_attendance_sites_company ON attendance_sites(company_id);
CREATE INDEX IF NOT EXISTS idx_employee_attendance_sites_user ON employee_attendance_sites(user_id);
CREATE INDEX IF NOT EXISTS idx_employee_attendance_sites_site ON employee_attendance_sites(attendance_site_id);
