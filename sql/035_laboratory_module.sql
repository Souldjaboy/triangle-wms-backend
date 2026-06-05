-- Triangle WMS Pro - Module Laboratoire
-- Migration additive uniquement. Ne supprime aucune donnee.

CREATE TABLE IF NOT EXISTS laboratory_settings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  lab_name TEXT DEFAULT '',
  logo_url TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  whatsapp TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  opening_hours TEXT DEFAULT '',
  description TEXT DEFAULT '',
  home_sampling_enabled BOOLEAN DEFAULT false,
  appointments_enabled BOOLEAN DEFAULT true,
  online_payment_enabled BOOLEAN DEFAULT false,
  is_published BOOLEAN DEFAULT false,
  public_category TEXT DEFAULT 'Santé / Laboratoire',
  public_image_url TEXT DEFAULT '',
  public_description TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS laboratory_analyses (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price NUMERIC(14,2) DEFAULT 0,
  result_delay TEXT DEFAULT '',
  is_available BOOLEAN DEFAULT true,
  home_sampling_available BOOLEAN DEFAULT false,
  patient_instructions TEXT DEFAULT '',
  is_standard BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS laboratory_patients (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  full_name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  gender TEXT DEFAULT '',
  birth_date DATE,
  age INTEGER,
  address TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  client_user_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS laboratory_cases (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  patient_id INTEGER,
  client_user_id INTEGER,
  appointment_id INTEGER,
  case_number TEXT UNIQUE,
  result_code TEXT UNIQUE,
  status TEXT DEFAULT 'en_attente',
  total_amount NUMERIC(14,2) DEFAULT 0,
  payment_status TEXT DEFAULT 'pending',
  result_summary TEXT DEFAULT '',
  result_file_url TEXT DEFAULT '',
  result_published BOOLEAN DEFAULT false,
  published_at TIMESTAMP,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS laboratory_case_analyses (
  id SERIAL PRIMARY KEY,
  case_id INTEGER,
  analysis_id INTEGER,
  analysis_name TEXT DEFAULT '',
  price NUMERIC(14,2) DEFAULT 0,
  result_value TEXT DEFAULT '',
  result_notes TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS laboratory_appointments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  client_user_id INTEGER,
  patient_name TEXT DEFAULT '',
  patient_phone TEXT DEFAULT '',
  patient_email TEXT DEFAULT '',
  analysis_id INTEGER,
  analysis_name TEXT DEFAULT '',
  requested_date DATE,
  requested_time TEXT DEFAULT '',
  home_sampling BOOLEAN DEFAULT false,
  home_address TEXT DEFAULT '',
  message TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  proposed_date DATE,
  proposed_time TEXT DEFAULT '',
  lab_response TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS laboratory_payments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  case_id INTEGER,
  appointment_id INTEGER,
  amount NUMERIC(14,2) DEFAULT 0,
  method TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  payment_reference TEXT DEFAULT '',
  paid_at TIMESTAMP,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS laboratory_result_access_logs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  case_id INTEGER,
  result_code TEXT DEFAULT '',
  verifier TEXT DEFAULT '',
  success BOOLEAN DEFAULT false,
  ip_address TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE laboratory_settings ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE laboratory_settings ADD COLUMN IF NOT EXISTS city TEXT DEFAULT '';
ALTER TABLE laboratory_settings ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT false;
ALTER TABLE laboratory_settings ADD COLUMN IF NOT EXISTS public_category TEXT DEFAULT 'Santé / Laboratoire';
ALTER TABLE laboratory_settings ADD COLUMN IF NOT EXISTS public_image_url TEXT DEFAULT '';
ALTER TABLE laboratory_settings ADD COLUMN IF NOT EXISTS public_description TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_laboratory_settings_company ON laboratory_settings(company_id);
CREATE INDEX IF NOT EXISTS idx_laboratory_analyses_company ON laboratory_analyses(company_id);
CREATE INDEX IF NOT EXISTS idx_laboratory_patients_company ON laboratory_patients(company_id);
CREATE INDEX IF NOT EXISTS idx_laboratory_cases_company ON laboratory_cases(company_id);
CREATE INDEX IF NOT EXISTS idx_laboratory_cases_code ON laboratory_cases(result_code);
CREATE INDEX IF NOT EXISTS idx_laboratory_appointments_company ON laboratory_appointments(company_id);
CREATE INDEX IF NOT EXISTS idx_laboratory_payments_company ON laboratory_payments(company_id);

INSERT INTO laboratory_analyses
  (company_id, name, description, price, result_delay, is_available, is_standard)
SELECT NULL, data.name, data.description, 0, data.delay, true, true
FROM (VALUES
  ('NFS','Numération formule sanguine','24h'),
  ('Glycémie','Dosage du glucose sanguin','24h'),
  ('Cholestérol','Dosage cholestérol total','24h'),
  ('Triglycérides','Dosage triglycérides','24h'),
  ('Créatinine','Fonction rénale','24h'),
  ('Urée','Fonction rénale','24h'),
  ('Bilan hépatique','Transaminases et marqueurs hépatiques','48h'),
  ('Bilan lipidique','Cholestérol, HDL, LDL, triglycérides','48h'),
  ('Groupe sanguin','Détermination groupe sanguin','24h'),
  ('Test grossesse','Beta HCG ou test rapide','24h'),
  ('Paludisme','Test rapide ou goutte épaisse','24h'),
  ('Typhoïde','Test sérologique','24h'),
  ('VIH','Dépistage VIH','48h'),
  ('Hépatite B','Dépistage VHB','48h'),
  ('Hépatite C','Dépistage VHC','48h'),
  ('CRP','Inflammation','24h'),
  ('VS','Vitesse de sédimentation','24h'),
  ('ECBU','Examen cytobactériologique des urines','72h'),
  ('Coproculture','Analyse selles','72h'),
  ('Spermogramme','Analyse fertilité masculine','72h'),
  ('Tests hormonaux','Bilan hormonal','72h'),
  ('Tests allergie','Panel allergènes','5 jours'),
  ('PCR','Analyse PCR','48h'),
  ('Tests COVID','Test COVID antigénique ou PCR','24h'),
  ('Analyse personnalisée','Analyse définie par le laboratoire','Selon analyse')
) AS data(name, description, delay)
WHERE NOT EXISTS (
  SELECT 1 FROM laboratory_analyses a
  WHERE a.company_id IS NULL AND a.name=data.name
);

INSERT INTO ai_module_knowledge (
  module_key, module_name, description, capabilities, data_sources, examples, is_active, active
)
SELECT
  'laboratoire',
  'Laboratoire',
  'Gestion laboratoire, analyses, patients, rendez-vous, résultats et paiements.',
  '["analyses","patients","rendez-vous","resultats","paiements","marketplace"]'::jsonb,
  '["laboratory_settings","laboratory_analyses","laboratory_patients","laboratory_cases","laboratory_appointments","laboratory_payments"]'::jsonb,
  '["Quelles analyses propose ce laboratoire ?","Quels résultats sont prêts ?","Quels rendez-vous sont en attente ?","Quels paiements laboratoire aujourd hui ?"]'::jsonb,
  true,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM ai_module_knowledge WHERE module_key='laboratoire'
);
