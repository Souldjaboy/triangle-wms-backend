-- Triangle WMS Pro - Connaissance automatique des modules pour Assistant IA
-- Ajoute une base de connaissance interne sans supprimer les données existantes.

CREATE TABLE IF NOT EXISTS ai_module_knowledge (
  id SERIAL PRIMARY KEY,
  module_key VARCHAR(120) UNIQUE NOT NULL,
  module_name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  role_explanation TEXT DEFAULT '',
  available_actions JSONB DEFAULT '[]'::jsonb,
  pages JSONB DEFAULT '[]'::jsonb,
  permissions JSONB DEFAULT '[]'::jsonb,
  data_sources JSONB DEFAULT '[]'::jsonb,
  examples JSONB DEFAULT '[]'::jsonb,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_module_knowledge_key ON ai_module_knowledge(module_key);
CREATE INDEX IF NOT EXISTS idx_ai_module_knowledge_active ON ai_module_knowledge(active);

INSERT INTO ai_module_knowledge (
  module_key,
  module_name,
  description,
  role_explanation,
  available_actions,
  pages,
  permissions,
  data_sources,
  examples
) VALUES
(
  'dashboard',
  'Tableau de bord',
  'Vue centrale de pilotage avec les indicateurs produits, stocks, mouvements, ventes, alertes et activité récente.',
  'Le tableau de bord sert à comprendre rapidement l''état global de l''entreprise et à détecter les priorités.',
  '["consulter indicateurs","voir alertes","voir mouvements récents","actualiser données"]',
  '["/dashboard"]',
  '["super_admin","admin","direction","responsable_entrepot","magasinier","client"]',
  '["products","warehouses","locations","stock_movements","inventory_history","sales","user_activities"]',
  '["Combien de produits ai-je ?","Quel est le stock total ?","Quelles sont les alertes importantes ?"]'
),
(
  'stock',
  'Stocks & mouvements',
  'Module de suivi des quantités, entrées, sorties, transferts, inventaires et validations de mouvements.',
  'Il permet de contrôler les flux physiques de marchandises et de garder une traçabilité complète.',
  '["entrée stock","sortie stock","transfert","inventaire","validation","refus"]',
  '["/stocks","/inventaires","/scanner"]',
  '["super_admin","admin","responsable_entrepot","magasinier"]',
  '["products","stock_movements","inventory_history","locations","warehouses"]',
  '["Quel est le dernier mouvement ?","Quels produits sont en rupture ?","Explique-moi un transfert stock"]'
),
(
  'products',
  'Produits',
  'Gestion des fiches produits, références, prix, images, QR codes, codes-barres, lots et stock minimum.',
  'Ce module centralise l''identité des articles utilisés par le WMS, le POS et les rapports.',
  '["créer produit","modifier produit","consulter produit","générer QR","imprimer étiquette"]',
  '["/produits","/pos/produits","/scan/product/[code]"]',
  '["super_admin","admin","responsable_entrepot","magasinier","direction","client"]',
  '["products","product_batches","product_price_history","locations"]',
  '["Montre-moi les produits","Quel produit a le stock faible ?","Explique-moi les lots"]'
),
(
  'pos',
  'POS / Caisse',
  'Point de vente pour scanner les produits, créer des ventes, encaisser, imprimer les reçus et déduire le stock.',
  'Le POS transforme les produits en ventes payées, crée les paiements, reçus et mouvements de stock associés.',
  '["vendre","scanner produit","encaisser","imprimer reçu","annuler vente","consulter historique"]',
  '["/pos","/pos/historique","/pos/ventes","/pos/paiements","/pos/recus","/pos/caisses"]',
  '["super_admin","admin","caissier","direction"]',
  '["sales","sale_items","payments","receipts","caisses","products"]',
  '["Montre-moi les ventes d''aujourd''hui","Explique-moi les paiements POS","Quel est le total vendu ?"]'
),
(
  'accounting',
  'Comptabilité & Trésorerie',
  'Module permettant de gérer les banques, caisses, mouvements financiers, bons, demandes de décaissement, salaires, états financiers et rapports comptables.',
  'Ce module sert à suivre les entrées et sorties d''argent, contrôler la trésorerie, gérer les dépenses, suivre les paiements et produire des états financiers.',
  '["afficher banques","afficher caisses","afficher mouvements","créer bon","valider demande","consulter états","générer rapport comptable"]',
  '["/comptabilite","/comptabilite/banques","/comptabilite/tresorerie","/comptabilite/demandes","/comptabilite/etats"]',
  '["super_admin","admin","direction","comptable"]',
  '["accounting_banks","caisses","accounting_transactions","cash_vouchers","expense_requests","treasury_accounts","journal_entries","journal_entry_lines"]',
  '["C''est quoi la comptabilité ?","Combien j''ai dans les banques ?","Quels sont les mouvements comptables ?"]'
),
(
  'attendance',
  'Pointage QR & RH',
  'Module de pointage par badge QR avec horaires, pauses, historique, règles GPS, sites de pointage et calculs RH.',
  'Il sert à contrôler la présence, les retards, les pauses et les affectations horaires des employés.',
  '["scanner badge","début travail","début pause","fin pause","fin travail","consulter historique"]',
  '["/attendance-scan","/pointage","/parametres-pointage"]',
  '["super_admin","admin","responsable_entrepot","employe","magasinier"]',
  '["attendance_records","attendance_settings","attendance_sites","users"]',
  '["Explique-moi le pointage GPS","Quels employés sont présents ?","C''est quoi un site de pointage ?"]'
),
(
  'documents_reports',
  'Documents & Rapports',
  'Centralise les documents, reçus, bons, rapports de stock, ventes, inventaires, pointage et comptabilité.',
  'Il sert à imprimer, télécharger, consulter et tracer les pièces importantes de l''entreprise.',
  '["voir document","imprimer","exporter PDF","filtrer rapport","envoyer par email si configuré"]',
  '["/documents","/rapports","/pos/recus"]',
  '["super_admin","admin","direction"]',
  '["documents","receipts","sales","stock_movements","inventory_history","accounting_transactions"]',
  '["Quels documents récents ?","Explique-moi les rapports","Où voir les reçus ?"]'
),
(
  'partners',
  'Partenaires, clients & fournisseurs',
  'Gestion des partenaires avec ventes, achats, paiements, documents liés, solde client et dette fournisseur.',
  'Ce module relie les clients et fournisseurs aux opérations commerciales, documents et soldes.',
  '["consulter fiche","voir historique ventes","voir paiements","désactiver partenaire"]',
  '["/partenaires"]',
  '["super_admin","admin","direction","commercial"]',
  '["partners","sales","documents","receipts","accounting_transactions"]',
  '["Explique-moi les partenaires","Quel est le solde client ?","Quels documents sont liés ?"]'
),
(
  'users_permissions',
  'Utilisateurs, rôles & permissions',
  'Gestion des comptes, rôles, permissions, modules activés et restrictions par entreprise.',
  'Ce module protège l''accès au logiciel et adapte les menus/actions au rôle de chaque utilisateur.',
  '["créer utilisateur","modifier rôle","désactiver utilisateur","contrôler permissions"]',
  '["/utilisateurs","/super-admin","/parametres"]',
  '["super_admin","admin"]',
  '["users","companies","module_settings","audit_logs"]',
  '["Explique-moi les rôles","Qui peut voir les rapports ?","Quels modules sont activés ?"]'
)
ON CONFLICT (module_key) DO UPDATE SET
  module_name = EXCLUDED.module_name,
  description = EXCLUDED.description,
  role_explanation = EXCLUDED.role_explanation,
  available_actions = EXCLUDED.available_actions,
  pages = EXCLUDED.pages,
  permissions = EXCLUDED.permissions,
  data_sources = EXCLUDED.data_sources,
  examples = EXCLUDED.examples,
  active = true,
  updated_at = CURRENT_TIMESTAMP;
