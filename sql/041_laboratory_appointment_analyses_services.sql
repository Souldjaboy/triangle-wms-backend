-- Triangle WMS Pro - Rendez-vous laboratoire multi-analyses

ALTER TABLE laboratory_analyses ADD COLUMN IF NOT EXISTS estimated_duration TEXT DEFAULT '';
ALTER TABLE laboratory_analyses ADD COLUMN IF NOT EXISTS on_site_available BOOLEAN DEFAULT true;
ALTER TABLE laboratory_analyses ADD COLUMN IF NOT EXISTS teleconsultation_available BOOLEAN DEFAULT false;

ALTER TABLE laboratory_appointments ADD COLUMN IF NOT EXISTS analysis_ids INTEGER[] DEFAULT '{}';
ALTER TABLE laboratory_appointments ADD COLUMN IF NOT EXISTS total_amount NUMERIC(14,2) DEFAULT 0;
ALTER TABLE laboratory_appointments ADD COLUMN IF NOT EXISTS service_type TEXT DEFAULT 'sur_place';

CREATE INDEX IF NOT EXISTS idx_laboratory_appointments_client_user_id
  ON laboratory_appointments(client_user_id);
