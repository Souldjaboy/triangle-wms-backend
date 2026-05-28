-- Triangle WMS Pro - Schéma initial complet
-- À exécuter AVANT sql/001_stabilisation.sql.
-- Ce script crée les tables manquantes sans supprimer les données existantes.

CREATE TABLE IF NOT EXISTS subscription_plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL DEFAULT 'Entreprise',
  price_monthly NUMERIC(12,2) DEFAULT 0,
  max_users INTEGER DEFAULT 0,
  max_warehouses INTEGER DEFAULT 0,
  max_products INTEGER DEFAULT 0,
  max_movements_monthly INTEGER DEFAULT 0,
  trial_days INTEGER DEFAULT 15,
  modules TEXT DEFAULT '',
  can_use_reports BOOLEAN DEFAULT true,
  can_use_qr BOOLEAN DEFAULT true,
  can_use_advanced_inventory BOOLEAN DEFAULT true,
  can_use_documents BOOLEAN DEFAULT true,
  can_use_chat BOOLEAN DEFAULT true,
  can_use_ai BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  business_type VARCHAR(150) DEFAULT '',
  responsible_name VARCHAR(255) DEFAULT '',
  email VARCHAR(255) DEFAULT '',
  phone VARCHAR(100) DEFAULT '',
  address TEXT DEFAULT '',
  plan_id INTEGER REFERENCES subscription_plans(id) ON DELETE SET NULL,
  status VARCHAR(50) DEFAULT 'active',
  subscription_status VARCHAR(50) DEFAULT 'trial',
  trial_ends_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  plan_id INTEGER REFERENCES subscription_plans(id) ON DELETE SET NULL,
  start_date DATE DEFAULT CURRENT_DATE,
  end_date DATE,
  status VARCHAR(50) DEFAULT 'trial',
  payment_status VARCHAR(50) DEFAULT 'free_trial',
  payment_mode VARCHAR(50) DEFAULT 'manual',
  is_payment_required BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  fullname VARCHAR(255),
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(80) DEFAULT 'magasinier',
  phone VARCHAR(100) DEFAULT '',
  profile_image_url TEXT DEFAULT '',
  schedule_group_id INTEGER,
  hourly_rate NUMERIC(12,2) DEFAULT 0,
  daily_rate NUMERIC(12,2) DEFAULT 0,
  payment_type VARCHAR(50) DEFAULT 'horaire',
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  is_super_admin BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  badge_code VARCHAR(150),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS company_settings (
  id SERIAL PRIMARY KEY,
  company_name VARCHAR(255) DEFAULT '',
  address TEXT DEFAULT '',
  phone VARCHAR(100) DEFAULT '',
  email VARCHAR(255) DEFAULT '',
  website VARCHAR(255) DEFAULT '',
  logo_url TEXT DEFAULT '',
  slogan TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS warehouses (
  id SERIAL PRIMARY KEY,
  code VARCHAR(100),
  name VARCHAR(255),
  location TEXT DEFAULT '',
  manager VARCHAR(255) DEFAULT '',
  racks_count INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'Actif',
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS locations (
  id SERIAL PRIMARY KEY,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
  warehouse_code VARCHAR(100) DEFAULT '',
  zone VARCHAR(100) DEFAULT '',
  rayon VARCHAR(100) DEFAULT '',
  etagere VARCHAR(100) DEFAULT '',
  emplacement_code TEXT DEFAULT '',
  qr_code TEXT DEFAULT '',
  status VARCHAR(50) DEFAULT 'Disponible',
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  product_id INTEGER,
  product_reference TEXT DEFAULT '',
  product_name TEXT DEFAULT '',
  rayon_code TEXT DEFAULT '',
  case_code TEXT DEFAULT '',
  level_code TEXT DEFAULT '',
  bin_code TEXT DEFAULT '',
  bin_mode TEXT DEFAULT 'single',
  bin_group TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  reference VARCHAR(255),
  name VARCHAR(255),
  category VARCHAR(255) DEFAULT '',
  stock INTEGER DEFAULT 0,
  warehouse VARCHAR(255) DEFAULT '',
  status VARCHAR(80) DEFAULT 'Disponible',
  unit VARCHAR(80) DEFAULT 'pièce',
  weight NUMERIC(12,3) DEFAULT 0,
  dimensions VARCHAR(255) DEFAULT '',
  barcode VARCHAR(255) DEFAULT '',
  description TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT true,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  location_code TEXT DEFAULT '',
  minimum_stock INTEGER DEFAULT 5,
  image_url TEXT DEFAULT '',
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id SERIAL PRIMARY KEY,
  type VARCHAR(80),
  product_reference VARCHAR(255),
  product_name VARCHAR(255),
  quantity INTEGER DEFAULT 0,
  source_warehouse VARCHAR(255) DEFAULT '',
  destination_warehouse VARCHAR(255) DEFAULT '',
  reason TEXT DEFAULT '',
  status VARCHAR(80) DEFAULT 'En attente',
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT DEFAULT '',
  created_by_role TEXT DEFAULT '',
  validated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  validated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_history (
  id SERIAL PRIMARY KEY,
  product_reference VARCHAR(255),
  product_name VARCHAR(255),
  system_stock INTEGER DEFAULT 0,
  real_stock INTEGER DEFAULT 0,
  difference INTEGER DEFAULT 0,
  warehouse VARCHAR(255) DEFAULT '',
  location_code TEXT DEFAULT '',
  user_name VARCHAR(255) DEFAULT '',
  user_role VARCHAR(100) DEFAULT '',
  status VARCHAR(80) DEFAULT 'En attente',
  observation TEXT DEFAULT '',
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  document_type VARCHAR(100),
  document_number VARCHAR(150),
  client_name VARCHAR(255) DEFAULT '',
  client_phone VARCHAR(100) DEFAULT '',
  client_address TEXT DEFAULT '',
  total_amount NUMERIC(14,2) DEFAULT 0,
  observation TEXT DEFAULT '',
  created_by VARCHAR(255) DEFAULT 'Administrateur',
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS document_items (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  product_reference VARCHAR(255) DEFAULT '',
  product_name VARCHAR(255) DEFAULT '',
  quantity NUMERIC(12,2) DEFAULT 0,
  unit_price NUMERIC(14,2) DEFAULT 0,
  total_price NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_activities (
  id SERIAL PRIMARY KEY,
  user_name VARCHAR(255) DEFAULT 'Système',
  user_role VARCHAR(100) DEFAULT 'Non défini',
  action VARCHAR(255),
  module VARCHAR(150),
  details TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) DEFAULT '',
  type VARCHAR(50) DEFAULT 'private',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  receiver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content TEXT DEFAULT '',
  message_type VARCHAR(50) DEFAULT 'text',
  audio_url TEXT DEFAULT '',
  is_read BOOLEAN DEFAULT false,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) DEFAULT '',
  message TEXT DEFAULT '',
  type VARCHAR(100) DEFAULT '',
  is_read BOOLEAN DEFAULT false,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schedule_groups (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  start_time TIME,
  end_time TIME,
  break_start TIME,
  break_end TIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendance_settings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  schedule_group VARCHAR(150) DEFAULT 'Standard',
  salary_type VARCHAR(50) DEFAULT 'horaire',
  hourly_rate NUMERIC(12,2) DEFAULT 0,
  daily_salary NUMERIC(12,2) DEFAULT 0,
  monthly_salary NUMERIC(12,2) DEFAULT 0,
  start_time TIME DEFAULT '08:00',
  end_time TIME DEFAULT '17:00',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  work_date DATE DEFAULT CURRENT_DATE,
  check_in TIMESTAMP,
  break_out TIMESTAMP,
  break_in TIMESTAMP,
  check_out TIMESTAMP,
  status VARCHAR(80) DEFAULT 'Absent',
  late_minutes INTEGER DEFAULT 0,
  break_late_minutes INTEGER DEFAULT 0,
  early_leave_minutes INTEGER DEFAULT 0,
  total_work_minutes INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  expected_start TIME,
  expected_end TIME,
  expected_break_start TIME,
  expected_break_end TIME,
  total_break_minutes INTEGER DEFAULT 0,
  overtime_minutes INTEGER DEFAULT 0,
  salary_amount NUMERIC(12,2) DEFAULT 0,
  corrected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  correction_reason TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, work_date)
);

CREATE TABLE IF NOT EXISTS attendance_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  action_type VARCHAR(100),
  action_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  device_info TEXT DEFAULT '',
  ip_address VARCHAR(100) DEFAULT '',
  location_info TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
  amount NUMERIC(14,2) DEFAULT 0,
  currency VARCHAR(20) DEFAULT 'FCFA',
  payment_method VARCHAR(100) DEFAULT '',
  payment_reference VARCHAR(255) DEFAULT '',
  status VARCHAR(50) DEFAULT 'pending',
  notes TEXT DEFAULT '',
  paid_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS partners (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  type VARCHAR(80),
  name VARCHAR(255),
  phone VARCHAR(100) DEFAULT '',
  email VARCHAR(255) DEFAULT '',
  address TEXT DEFAULT '',
  city VARCHAR(150) DEFAULT '',
  country VARCHAR(150) DEFAULT '',
  contact_person VARCHAR(255) DEFAULT '',
  nif VARCHAR(150) DEFAULT '',
  rccm VARCHAR(150) DEFAULT '',
  notes TEXT DEFAULT '',
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_products_company_id ON products(company_id);
CREATE INDEX IF NOT EXISTS idx_products_reference ON products(reference);
CREATE INDEX IF NOT EXISTS idx_warehouses_company_id ON warehouses(company_id);
CREATE INDEX IF NOT EXISTS idx_locations_company_id ON locations(company_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_company_id ON stock_movements(company_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_status ON stock_movements(status);
CREATE INDEX IF NOT EXISTS idx_inventory_history_company_id ON inventory_history(company_id);
CREATE INDEX IF NOT EXISTS idx_documents_company_id ON documents(company_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_attendance_records_user_date ON attendance_records(user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_partners_company_id ON partners(company_id);

INSERT INTO subscription_plans (
  name,
  price_monthly,
  max_users,
  max_warehouses,
  max_products,
  max_movements_monthly,
  trial_days,
  modules
)
SELECT
  'Entreprise',
  0,
  0,
  0,
  0,
  0,
  15,
  'all'
WHERE NOT EXISTS (
  SELECT 1 FROM subscription_plans WHERE name = 'Entreprise'
);
