-- Triangle WMS Pro - Attendance GPS security
-- Safe additive migration: no DROP TABLE, no data deletion.

CREATE TABLE IF NOT EXISTS attendance_gps_settings (
  id SERIAL PRIMARY KEY,
  gps_required BOOLEAN DEFAULT false,
  site_latitude DECIMAL(10,7),
  site_longitude DECIMAL(10,7),
  allowed_radius_meters INTEGER DEFAULT 100,
  updated_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO attendance_gps_settings (id, gps_required, allowed_radius_meters)
VALUES (1, false, 100)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,7);
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS longitude DECIMAL(10,7);
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS accuracy DECIMAL(12,2);
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS distance_meters DECIMAL(12,2);
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS is_inside_zone BOOLEAN;

ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,7);
ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS longitude DECIMAL(10,7);
ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS accuracy DECIMAL(12,2);
ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS distance_meters DECIMAL(12,2);
ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS is_inside_zone BOOLEAN;
