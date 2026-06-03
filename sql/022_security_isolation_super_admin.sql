-- Triangle WMS Pro - Isolation entreprises + Super Admin principal
-- Migration additive, sans suppression de données.

ALTER TABLE schedule_groups ADD COLUMN IF NOT EXISTS company_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_schedule_groups_company_id ON schedule_groups(company_id);

ALTER TABLE attendance_gps_settings ADD COLUMN IF NOT EXISTS company_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_gps_settings_company_unique
  ON attendance_gps_settings(company_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

UPDATE users
SET
  role='super_admin',
  is_super_admin=true,
  is_active=true,
  company_id=NULL,
  updated_at=CURRENT_TIMESTAMP
WHERE LOWER(email)='diallogcif@gmail.com';
