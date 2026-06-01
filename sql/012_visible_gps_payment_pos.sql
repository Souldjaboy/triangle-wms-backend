-- Triangle WMS Pro - Visible GPS pointage settings and POS payment support
-- Safe additive migration: no DROP TABLE, no data deletion.

ALTER TABLE attendance_gps_settings ADD COLUMN IF NOT EXISTS site_name TEXT DEFAULT '';
ALTER TABLE attendance_gps_settings ADD COLUMN IF NOT EXISTS allow_remote_attendance BOOLEAN DEFAULT false;
ALTER TABLE attendance_gps_settings ADD COLUMN IF NOT EXISTS kiosk_mode BOOLEAN DEFAULT true;
ALTER TABLE attendance_gps_settings ADD COLUMN IF NOT EXISTS employee_scanner_access BOOLEAN DEFAULT false;

ALTER TABLE attendance_settings ADD COLUMN IF NOT EXISTS gps_required BOOLEAN DEFAULT false;
ALTER TABLE attendance_settings ADD COLUMN IF NOT EXISTS site_name TEXT DEFAULT '';
ALTER TABLE attendance_settings ADD COLUMN IF NOT EXISTS site_latitude DECIMAL(10,7);
ALTER TABLE attendance_settings ADD COLUMN IF NOT EXISTS site_longitude DECIMAL(10,7);
ALTER TABLE attendance_settings ADD COLUMN IF NOT EXISTS allowed_radius_meters INTEGER DEFAULT 100;
ALTER TABLE attendance_settings ADD COLUMN IF NOT EXISTS allow_remote_attendance BOOLEAN DEFAULT false;

ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,7);
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS longitude DECIMAL(10,7);
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS accuracy DECIMAL(12,2);
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS distance_meters DECIMAL(12,2);
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS is_inside_zone BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_company_id ON payment_transactions(company_id);
CREATE INDEX IF NOT EXISTS idx_payments_sale_id ON payments(sale_id);
