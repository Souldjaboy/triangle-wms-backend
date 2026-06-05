-- Triangle WMS Pro - Finalisation commandes marketplace, modules SaaS et audit
-- Additif uniquement. Ne supprime aucune donnee.

ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_modules_allowed INTEGER DEFAULT 0;

UPDATE subscription_plans
SET max_modules_allowed = CASE
  WHEN LOWER(name) IN ('premium') THEN 999
  WHEN LOWER(name) IN ('standard') THEN 12
  WHEN LOWER(name) IN ('essentiel','starter') THEN 5
  ELSE COALESCE(NULLIF(max_modules_allowed, 0), 5)
END
WHERE COALESCE(max_modules_allowed, 0) = 0;

ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS delivery_method TEXT DEFAULT 'Retrait sur place';
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(14,2) DEFAULT 0;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS delivery_city TEXT DEFAULT '';
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS delivery_neighborhood TEXT DEFAULT '';
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS delivery_phone TEXT DEFAULT '';
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS delivery_note TEXT DEFAULT '';
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS vendor_message TEXT DEFAULT '';

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_email TEXT DEFAULT '';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_role TEXT DEFAULT '';

INSERT INTO modules (module_key, module_name, description)
VALUES
  ('dashboard', 'Dashboard', 'Tableau de bord'),
  ('recherche', 'Recherche', 'Recherche globale'),
  ('assistant_ia', 'Assistant IA', 'Assistant IA connecté'),
  ('super_admin', 'Super Admin', 'Administration plateforme'),
  ('chat', 'Chat interne', 'Messages internes'),
  ('notifications', 'Notifications', 'Notifications et actions'),
  ('produits', 'Produits', 'Produits et fiches article'),
  ('partenaires', 'Partenaires', 'Clients et fournisseurs'),
  ('stock', 'Stockages', 'Stocks et mouvements'),
  ('inventaire', 'Inventaires', 'Inventaires et ajustements'),
  ('entrepots', 'Entrepôts', 'Entrepôts'),
  ('emplacements', 'Emplacements', 'Emplacements et QR'),
  ('scanner', 'Scanner QR', 'Scans QR et codes-barres'),
  ('pos', 'POS / Caisse', 'Point de vente'),
  ('marketplace', 'Marketplace', 'Boutique publique et B2B'),
  ('commandes_recues', 'Commandes reçues', 'Commandes marketplace vendeur'),
  ('automobile', 'Automobile', 'Véhicules et ventes'),
  ('immobilier', 'Immobilier / Hôtel', 'Immobilier, hôtel et chambres'),
  ('restaurant', 'Restaurant', 'Restaurant et commandes'),
  ('laboratoire', 'Laboratoire', 'Laboratoire et résultats'),
  ('comptabilite', 'Comptabilité', 'Comptabilité, banques et trésorerie'),
  ('documents', 'Documents', 'Documents et PDF'),
  ('rapports', 'Rapports', 'Rapports et exports'),
  ('alertes', 'Alertes', 'Alertes métiers'),
  ('activites', 'Activités', 'Historique activités'),
  ('utilisateurs', 'Utilisateurs', 'Utilisateurs et droits'),
  ('badges', 'Badges', 'Badges QR'),
  ('pointage_qr', 'Pointage QR', 'Scanner pointage QR'),
  ('pointage', 'Pointage', 'Pointage et historique'),
  ('parametres_pointage', 'Paramètres pointage', 'Paramètres pointage GPS'),
  ('parametres', 'Paramètres', 'Paramètres entreprise'),
  ('electronique', 'Électronique', 'Catégorie marketplace'),
  ('telephones', 'Téléphones', 'Catégorie marketplace'),
  ('informatique', 'Informatique', 'Catégorie marketplace'),
  ('beaute', 'Beauté / Cosmétique', 'Catégorie marketplace'),
  ('maison_meubles', 'Maison / Meubles', 'Catégorie marketplace'),
  ('services', 'Services', 'Catégorie marketplace')
ON CONFLICT (module_key) DO UPDATE SET
  module_name=EXCLUDED.module_name,
  description=EXCLUDED.description,
  is_active=true,
  updated_at=CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_vendor_status
  ON marketplace_orders(vendor_company_id, status);

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_customer_status
  ON marketplace_orders(customer_user_id, status);
