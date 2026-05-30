-- Triangle WMS Pro - QR scans, notifications and approval workflow
-- Safe additive migration: no DROP TABLE, no data deletion.

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS location_code TEXT DEFAULT '';
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS warehouse_id INTEGER;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS rejection_reason TEXT DEFAULT '';
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS original_quantity INTEGER;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS final_quantity INTEGER;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS approval_status VARCHAR(80) DEFAULT 'En attente';
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS modified_by INTEGER;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS modified_at TIMESTAMP;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS correction_note TEXT DEFAULT '';

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS status VARCHAR(80) DEFAULT 'unread';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority VARCHAR(50) DEFAULT 'normal';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS related_entity_type VARCHAR(100) DEFAULT '';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS related_entity_id INTEGER;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_url TEXT DEFAULT '';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_by INTEGER;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS assigned_to INTEGER;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS warehouse_id INTEGER;

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  action VARCHAR(255) DEFAULT '',
  entity_type VARCHAR(100) DEFAULT '',
  entity_id INTEGER,
  old_values JSONB,
  new_values JSONB,
  created_by INTEGER,
  company_id INTEGER,
  warehouse_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_location_code ON stock_movements(location_code);
CREATE INDEX IF NOT EXISTS idx_stock_movements_approval_status ON stock_movements(approval_status);
CREATE INDEX IF NOT EXISTS idx_notifications_related_entity ON notifications(related_entity_type, related_entity_id);
CREATE INDEX IF NOT EXISTS idx_notifications_assigned_to ON notifications(assigned_to);
CREATE INDEX IF NOT EXISTS idx_notifications_company_id ON notifications(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_company_id ON audit_logs(company_id);

UPDATE stock_movements
SET approval_status = status
WHERE approval_status IS NULL OR approval_status = '';

UPDATE stock_movements
SET original_quantity = quantity
WHERE original_quantity IS NULL;

UPDATE stock_movements
SET final_quantity = quantity
WHERE final_quantity IS NULL;
