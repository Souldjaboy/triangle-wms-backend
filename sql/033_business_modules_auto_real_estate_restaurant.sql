-- Triangle WMS Pro - Modules metiers Automobile, Immobilier/Hotel, Restaurant
-- Migration additive uniquement. Ne supprime aucune donnee.

ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(14,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_price NUMERIC(14,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS rental_price NUMERIC(14,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS daily_price NUMERIC(14,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS monthly_price NUMERIC(14,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_sellable BOOLEAN DEFAULT true;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_rentable BOOLEAN DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type VARCHAR(60) DEFAULT 'stock_normal';

CREATE TABLE IF NOT EXISTS vehicles (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  product_id INTEGER,
  marque TEXT DEFAULT '',
  modele TEXT DEFAULT '',
  immatriculation TEXT DEFAULT '',
  numero_chassis TEXT DEFAULT '',
  annee INTEGER,
  couleur TEXT DEFAULT '',
  kilometrage NUMERIC(14,2) DEFAULT 0,
  carburant TEXT DEFAULT '',
  statut VARCHAR(40) DEFAULT 'disponible',
  prix_vente NUMERIC(14,2) DEFAULT 0,
  prix_location_jour NUMERIC(14,2) DEFAULT 0,
  prix_location_mois NUMERIC(14,2) DEFAULT 0,
  images JSONB DEFAULT '[]'::jsonb,
  documents JSONB DEFAULT '[]'::jsonb,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vehicle_rentals (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  vehicle_id INTEGER,
  client_id INTEGER,
  client_name TEXT DEFAULT '',
  client_phone TEXT DEFAULT '',
  client_identity_file TEXT DEFAULT '',
  start_date DATE,
  end_date DATE,
  price_per_day NUMERIC(14,2) DEFAULT 0,
  total_amount NUMERIC(14,2) DEFAULT 0,
  deposit_amount NUMERIC(14,2) DEFAULT 0,
  paid_amount NUMERIC(14,2) DEFAULT 0,
  status VARCHAR(40) DEFAULT 'en_attente',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vehicle_sales (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  vehicle_id INTEGER,
  client_id INTEGER,
  client_name TEXT DEFAULT '',
  client_phone TEXT DEFAULT '',
  sale_price NUMERIC(14,2) DEFAULT 0,
  amount_paid NUMERIC(14,2) DEFAULT 0,
  remaining_amount NUMERIC(14,2) DEFAULT 0,
  payment_plan VARCHAR(40) DEFAULT 'comptant',
  status VARCHAR(40) DEFAULT 'en_attente',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vehicle_payment_schedules (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER,
  due_date DATE,
  amount NUMERIC(14,2) DEFAULT 0,
  paid_amount NUMERIC(14,2) DEFAULT 0,
  status VARCHAR(40) DEFAULT 'en_attente',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS properties (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  type VARCHAR(60) DEFAULT 'maison',
  title TEXT DEFAULT '',
  description TEXT DEFAULT '',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  surface NUMERIC(14,2) DEFAULT 0,
  rooms_count INTEGER DEFAULT 0,
  price_sale NUMERIC(14,2) DEFAULT 0,
  price_rent_day NUMERIC(14,2) DEFAULT 0,
  price_rent_month NUMERIC(14,2) DEFAULT 0,
  status VARCHAR(40) DEFAULT 'disponible',
  images JSONB DEFAULT '[]'::jsonb,
  documents JSONB DEFAULT '[]'::jsonb,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS property_rentals (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  property_id INTEGER,
  client_id INTEGER,
  client_name TEXT DEFAULT '',
  client_phone TEXT DEFAULT '',
  start_date DATE,
  end_date DATE,
  total_amount NUMERIC(14,2) DEFAULT 0,
  deposit_amount NUMERIC(14,2) DEFAULT 0,
  paid_amount NUMERIC(14,2) DEFAULT 0,
  status VARCHAR(40) DEFAULT 'en_attente',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS property_sales (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  property_id INTEGER,
  client_name TEXT DEFAULT '',
  client_phone TEXT DEFAULT '',
  sale_price NUMERIC(14,2) DEFAULT 0,
  amount_paid NUMERIC(14,2) DEFAULT 0,
  remaining_amount NUMERIC(14,2) DEFAULT 0,
  payment_plan VARCHAR(40) DEFAULT 'comptant',
  status VARCHAR(40) DEFAULT 'en_attente',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hotel_reservations (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  property_id INTEGER,
  room_number TEXT DEFAULT '',
  client_name TEXT DEFAULT '',
  client_phone TEXT DEFAULT '',
  checkin_date DATE,
  checkout_date DATE,
  nights INTEGER DEFAULT 1,
  price_per_night NUMERIC(14,2) DEFAULT 0,
  total_amount NUMERIC(14,2) DEFAULT 0,
  paid_amount NUMERIC(14,2) DEFAULT 0,
  status VARCHAR(40) DEFAULT 'reserve',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  table_number TEXT NOT NULL,
  qr_code TEXT DEFAULT '',
  status VARCHAR(40) DEFAULT 'libre',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS restaurant_menu_items (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  product_id INTEGER,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT DEFAULT '',
  price NUMERIC(14,2) DEFAULT 0,
  image TEXT DEFAULT '',
  is_available BOOLEAN DEFAULT true,
  preparation_time INTEGER DEFAULT 0,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS restaurant_orders (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  table_id INTEGER,
  customer_name TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  total_amount NUMERIC(14,2) DEFAULT 0,
  payment_status VARCHAR(40) DEFAULT 'pending',
  order_status VARCHAR(40) DEFAULT 'nouvelle',
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS restaurant_order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER,
  menu_item_id INTEGER,
  quantity NUMERIC(14,2) DEFAULT 1,
  unit_price NUMERIC(14,2) DEFAULT 0,
  total_price NUMERIC(14,2) DEFAULT 0,
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS restaurant_call_requests (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  table_id INTEGER,
  message TEXT DEFAULT '',
  status VARCHAR(40) DEFAULT 'nouveau',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vehicles_company ON vehicles(company_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_rentals_company ON vehicle_rentals(company_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_sales_company ON vehicle_sales(company_id);
CREATE INDEX IF NOT EXISTS idx_properties_company ON properties(company_id);
CREATE INDEX IF NOT EXISTS idx_property_rentals_company ON property_rentals(company_id);
CREATE INDEX IF NOT EXISTS idx_property_sales_company ON property_sales(company_id);
CREATE INDEX IF NOT EXISTS idx_hotel_reservations_company ON hotel_reservations(company_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_tables_company ON restaurant_tables(company_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_menu_company ON restaurant_menu_items(company_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_orders_company ON restaurant_orders(company_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_calls_company ON restaurant_call_requests(company_id);

INSERT INTO ai_module_knowledge (
  module_key, module_name, description, role_explanation,
  available_actions, pages, permissions, data_sources, examples, is_active
) SELECT * FROM (VALUES
  ('automobile','Automobile / Parking / Garage','Gestion des vehicules, locations, ventes, paiements partiels, contrats et historique.','Les admins gerent le parc auto. Les comptables suivent les paiements. Les directeurs valident et consultent.','["creer vehicule","louer vehicule","vendre vehicule","paiement partiel","contrat","recu"]'::jsonb,'["/automobile","/automobile/vehicules","/automobile/locations","/automobile/ventes","/automobile/paiements","/automobile/documents"]'::jsonb,'{"super_admin":"tout","admin":"entreprise","directeur":"vue validation","comptable":"paiements"}'::jsonb,'["vehicles","vehicle_rentals","vehicle_sales","vehicle_payment_schedules","documents","accounting_transactions"]'::jsonb,'["Quelles voitures sont disponibles ?","Quelles locations sont en retard ?","Combien les locations voiture ont rapporte ?"]'::jsonb,true),
  ('immobilier','Immobilier / Hotellerie','Gestion des biens, locations, ventes, chambres hotel, reservations, contrats et paiements.','Les agences gerent biens et reservations. Les comptables suivent les encaissements.','["creer bien","louer maison","vendre bien","reserver chambre","check-in","check-out","facture"]'::jsonb,'["/immobilier","/immobilier/biens","/immobilier/locations","/immobilier/ventes","/immobilier/hotel","/immobilier/reservations"]'::jsonb,'{"super_admin":"tout","admin":"entreprise","directeur":"vue validation","comptable":"paiements"}'::jsonb,'["properties","property_rentals","property_sales","hotel_reservations","documents","accounting_transactions"]'::jsonb,'["Quelles maisons sont disponibles ?","Quelles chambres sont occupees ?","Montre les reservations du jour"]'::jsonb,true),
  ('restaurant','Restauration / QR Table','Gestion restaurant, tables QR, menu, commandes, cuisine, paiements et appels serveur.','Le restaurant cree tables et menus. La cuisine suit les commandes. La caisse encaisse.','["creer table","generer QR","publier menu","prendre commande","changer statut cuisine","encaisser","ticket"]'::jsonb,'["/restaurant","/restaurant/menu","/restaurant/tables","/restaurant/commandes","/restaurant/cuisine","/restaurant/paiements","/restaurant/qr"]'::jsonb,'{"super_admin":"tout","admin":"entreprise","serveur":"commandes","cuisine":"preparation","comptable":"paiements"}'::jsonb,'["restaurant_tables","restaurant_menu_items","restaurant_orders","restaurant_order_items","restaurant_call_requests","documents","accounting_transactions"]'::jsonb,'["Quelles commandes sont en preparation ?","Combien le restaurant a vendu aujourd hui ?","Quelles tables sont occupees ?"]'::jsonb,true)
) AS data(module_key,module_name,description,role_explanation,available_actions,pages,permissions,data_sources,examples,is_active)
WHERE NOT EXISTS (
  SELECT 1 FROM ai_module_knowledge k WHERE k.module_key=data.module_key
);
