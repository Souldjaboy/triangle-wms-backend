-- 063 — CENTRE DROITS & PERMISSIONS
--
-- Strictement additif et idempotent. Aucune table supprimée, aucune colonne
-- retirée, aucun droit existant révoqué.
--
-- CE QUI EXISTE DÉJÀ ET QUI EST CONSERVÉ :
--   `user_permissions` (user_id, module_key, can_view/create/edit/delete/validate)
--   `rbac-triangle.js` : requirePermission(module, action), repli par rôle
--   `modules`, `user_modules`, `company_modules`
--
-- On ne construit PAS un second RBAC à côté. Les nouvelles tables complètent
-- le modèle existant sur les trois points qui lui manquent :
--   1. un référentiel de modules hiérarchisé (parent, ordre, système) ;
--   2. des droits par rôle, servant de base à tous les comptes ;
--   3. des exceptions par utilisateur en trois états — ALLOW, DENY, INHERIT —
--      là où `user_permissions` ne savait dire que vrai/faux/non renseigné.
--
-- NON-RÉGRESSION : les lignes de `user_permissions` sont reprises telles
-- quelles en overrides explicites. Un compte configuré à la main garde
-- exactement ses accès ; un compte jamais configuré continue de relever de
-- son rôle. Personne ne perd un droit du fait de cette migration.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. RÉFÉRENTIEL DES MODULES
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS permission_modules (
  module_key   text PRIMARY KEY,
  parent_key   text REFERENCES permission_modules(module_key) ON DELETE CASCADE,
  label        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  sort_order   integer NOT NULL DEFAULT 100,
  is_active    boolean NOT NULL DEFAULT true,
  /* Un module système ne peut pas être masqué au dernier super admin. */
  is_system    boolean NOT NULL DEFAULT false,
  /* Les seules actions qui ont un sens ici. Déclarer « mettre en stock » sur
     la comptabilité afficherait une case que rien n'applique : le tableau ne
     propose donc que ce que le module sait réellement faire. */
  actions      text[] NOT NULL DEFAULT ARRAY['visible','view'],
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS permission_modules_parent_idx ON permission_modules (parent_key);

-- ═════════════════════════════════════════════════════════════════════════
-- 2. RÉFÉRENTIEL DES ACTIONS
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS permission_actions (
  action_key  text PRIMARY KEY,
  label       text NOT NULL,
  description text NOT NULL DEFAULT '',
  sort_order  integer NOT NULL DEFAULT 100,
  /* Une action qui écrit : le bouton « Lecture seule » les retire toutes. */
  is_write    boolean NOT NULL DEFAULT true
);

INSERT INTO permission_actions (action_key, label, description, sort_order, is_write) VALUES
  ('visible',  'Visible',        'Le module apparaît dans le menu et son URL répond.', 10, false),
  ('view',     'Voir',           'Consulter le contenu du module.',                    20, false),
  ('export',   'Exporter',       'Extraire les données vers un fichier.',              30, false),
  ('print',    'Imprimer',       'Éditer un document imprimable.',                     40, false),
  ('create',   'Créer',          'Ajouter un enregistrement.',                         50, true),
  ('update',   'Modifier',       'Changer un enregistrement existant.',                60, true),
  ('delete',   'Supprimer',      'Retirer un enregistrement.',                         70, true),
  ('import',   'Importer',       'Charger des données depuis un fichier.',             80, true),
  ('validate', 'Valider',        'Confirmer une opération en attente.',                90, true),
  ('cancel',   'Annuler',        'Annuler une opération déjà enregistrée.',           100, true),
  ('putaway',  'Mettre en stock','Ranger une réception dans un emplacement.',         110, true),
  ('transfer', 'Transférer',     'Déplacer du stock entre emplacements.',             120, true),
  ('reserve',  'Réserver',       'Immobiliser du stock sans le sortir.',              130, true),
  ('assign',   'Affecter',       'Attribuer un élément à un utilisateur ou un lieu.', 140, true),
  ('configure','Configurer',     'Modifier les réglages du module.',                  150, true),
  ('share',    'Partager',       'Transmettre un contenu hors de l''application.',    160, true),
  ('manage',   'Gérer les droits','Administrer les permissions d''autrui.',           170, true)
ON CONFLICT (action_key) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. DROITS PAR RÔLE — la base dont hérite chaque compte
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS role_permissions (
  id          serial PRIMARY KEY,
  company_id  integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role        text NOT NULL,
  module_key  text NOT NULL REFERENCES permission_modules(module_key) ON DELETE CASCADE,
  action      text NOT NULL REFERENCES permission_actions(action_key) ON DELETE CASCADE,
  allowed     boolean NOT NULL DEFAULT false,
  updated_by  integer,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, role, module_key, action)
);

CREATE INDEX IF NOT EXISTS role_permissions_lookup_idx
  ON role_permissions (company_id, role);

-- ═════════════════════════════════════════════════════════════════════════
-- 4. EXCEPTIONS PAR UTILISATEUR
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_permission_overrides (
  id          serial PRIMARY KEY,
  company_id  integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_key  text NOT NULL REFERENCES permission_modules(module_key) ON DELETE CASCADE,
  action      text NOT NULL REFERENCES permission_actions(action_key) ON DELETE CASCADE,
  /* INHERIT n'est pas stocké : c'est l'absence de ligne. Le garder comme
     valeur possible permet à l'API de recevoir « remets ça par défaut »
     sans inventer un verbe de suppression. */
  effect      text NOT NULL CHECK (effect IN ('ALLOW','DENY')),
  changed_by  integer,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id, module_key, action)
);

CREATE INDEX IF NOT EXISTS user_permission_overrides_lookup_idx
  ON user_permission_overrides (company_id, user_id);

-- ═════════════════════════════════════════════════════════════════════════
-- 5. JOURNAL — non modifiable par les écrans applicatifs
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS permission_audit_log (
  id            bigserial PRIMARY KEY,
  company_id    integer NOT NULL,
  target_user_id integer,
  target_role   text,
  module_key    text,
  action        text,
  old_value     text,
  new_value     text,
  /* manual | role | copy | reset | migration */
  origin        text NOT NULL DEFAULT 'manual',
  changed_by    integer,
  changed_by_name text,
  changed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS permission_audit_log_company_idx
  ON permission_audit_log (company_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS permission_audit_log_user_idx
  ON permission_audit_log (target_user_id, changed_at DESC);

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- 6. CATALOGUE DES MODULES TRIANGLE
--
-- Établi à partir des modules réellement déclarés pour Triangle dans
-- product-config.ts et des pages qui existent, pas d'une liste recopiée d'un
-- autre produit. Chaque module ne déclare que les actions qu'il sait faire.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO permission_modules (module_key, parent_key, label, description, sort_order, is_system, actions) VALUES
 ('tableau_de_bord', NULL, 'Tableau de bord', 'Vue d''ensemble et indicateurs.', 10, true,
    ARRAY['visible','view','export']),

 ('produit', NULL, 'Produits', 'Catalogue des articles gérés.', 20, false,
    ARRAY['visible','view','create','update','delete','import','export','print']),
 ('produit.repartition', 'produit', 'Répartition par emplacement', 'Affecter un produit à ses bacs physiques.', 21, false,
    ARRAY['visible','view','update','assign']),

 ('stock', NULL, 'Stocks', 'Niveaux, mouvements et emplacements.', 30, false,
    ARRAY['visible','view','export','print']),
 ('stock.entree', 'stock', 'Entrées', 'Enregistrer une entrée de stock.', 31, false,
    ARRAY['visible','view','create','validate','cancel']),
 ('stock.sortie', 'stock', 'Sorties', 'Enregistrer une sortie de stock.', 32, false,
    ARRAY['visible','view','create','validate','cancel']),
 ('stock.transfert', 'stock', 'Transferts', 'Déplacer du stock entre emplacements.', 33, false,
    ARRAY['visible','view','create','transfer','validate','cancel']),
 ('stock.inventaire', 'stock', 'Inventaires', 'Comptages et ajustements.', 34, false,
    ARRAY['visible','view','create','update','validate','cancel','export','print']),
 ('stock.emplacement', 'stock', 'Emplacements', 'Bacs, allées et niveaux.', 35, false,
    ARRAY['visible','view','create','update','delete','reserve','configure']),

 ('reception', NULL, 'Réceptions', 'Arrivages fournisseurs et conteneurs.', 40, false,
    ARRAY['visible','view','create','update','import','validate','putaway','cancel','print','export']),

 ('entrepot', NULL, 'Entrepôts', 'Sites de stockage.', 50, false,
    ARRAY['visible','view','create','update','delete','configure']),

 ('document', NULL, 'Documents', 'Bons de réception, de sortie et de livraison.', 60, false,
    ARRAY['visible','view','create','delete','print','export','share']),
 ('document.impression_groupee', 'document', 'Impression groupée', 'Imprimer plusieurs bons en une fois.', 61, false,
    ARRAY['visible','view','print']),

 ('achat', NULL, 'Achats', 'Commandes fournisseurs.', 70, false,
    ARRAY['visible','view','create','update','delete','validate','cancel','print','export']),
 ('vente', NULL, 'Ventes', 'Commandes et facturation clients.', 80, false,
    ARRAY['visible','view','create','update','delete','validate','cancel','print','export']),
 ('pos', NULL, 'Caisse (POS)', 'Encaissement au comptoir.', 85, false,
    ARRAY['visible','view','create','cancel','print','configure']),

 ('crm', NULL, 'Clients', 'Fiches et suivi commercial.', 90, false,
    ARRAY['visible','view','create','update','delete','import','export']),
 ('fournisseur', NULL, 'Fournisseurs', 'Fiches fournisseurs.', 95, false,
    ARRAY['visible','view','create','update','delete','import','export']),
 ('partenaire', NULL, 'Partenaires', 'Fiches partenaires et encours.', 100, false,
    ARRAY['visible','view','create','update','delete','export']),

 ('comptabilite', NULL, 'Comptabilité', 'Écritures, trésorerie et factures.', 110, false,
    ARRAY['visible','view','create','update','delete','validate','export','print']),
 ('rapport', NULL, 'Rapports', 'Analyses et états.', 120, false,
    ARRAY['visible','view','create','export','print','share']),

 ('rh', NULL, 'Ressources humaines', 'Personnel et contrats.', 130, false,
    ARRAY['visible','view','create','update','delete','export']),
 ('pointage', NULL, 'Pointage', 'Présences et heures.', 135, false,
    ARRAY['visible','view','create','update','validate','export','configure']),
 ('badge', NULL, 'Badges', 'Cartes et identifiants du personnel.', 140, false,
    ARRAY['visible','view','create','update','delete','print','assign']),

 ('logistique', NULL, 'Logistique', 'Camions et transport.', 150, false,
    ARRAY['visible','view','create','update','delete','validate','print','export']),
 ('demande', NULL, 'Demandes', 'Demandes internes et validations.', 155, false,
    ARRAY['visible','view','create','update','validate','cancel']),

 ('ciment', NULL, 'Ciment', 'Activité ciment.', 160, false,
    ARRAY['visible','view','create','update','delete','validate','export','print']),
 ('sable', NULL, 'Sable', 'Activité sable.', 165, false,
    ARRAY['visible','view','create','update','delete','validate','export','print']),

 ('notification', NULL, 'Notifications', 'Alertes et messages système.', 170, false,
    ARRAY['visible','view','configure']),
 ('chat', NULL, 'Messagerie', 'Discussions internes.', 175, false,
    ARRAY['visible','view','create','share']),
 ('ia', NULL, 'Assistant IA', 'Aide et analyses assistées.', 180, false,
    ARRAY['visible','view','create']),

 ('utilisateur', NULL, 'Utilisateurs', 'Comptes et accès.', 190, true,
    ARRAY['visible','view','create','update','delete','export']),
 ('utilisateur.permissions', 'utilisateur', 'Droits & permissions', 'Attribuer les droits des comptes.', 191, true,
    ARRAY['visible','view','manage']),

 ('parametre', NULL, 'Paramètres', 'Réglages de l''entreprise.', 200, true,
    ARRAY['visible','view','update','configure']),
 ('administration', NULL, 'Administration', 'Opérations réservées à la direction.', 210, true,
    ARRAY['visible','view','configure'])
ON CONFLICT (module_key) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order,
      parent_key = EXCLUDED.parent_key,
      is_system = EXCLUDED.is_system,
      actions = EXCLUDED.actions,
      updated_at = now();

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- 7. NON-RÉGRESSION
--
-- Le moteur actuel décide ainsi : super admin toujours autorisé ; sinon une
-- ligne explicite de `user_permissions` fait foi ; sinon repli sur le rôle,
-- où seuls les rôles d'administration passent. On reproduit ce comportement
-- à l'identique, pour que personne ne gagne ni ne perde un accès aujourd'hui.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 7.1 Droits par rôle ────────────────────────────────────────────────
-- Seuls les rôles réellement portés par des comptes sont matérialisés :
-- inventer des lignes pour des rôles inexistants encombrerait l'écran sans
-- rien décrire. Les rôles d'administration reçoivent tout, les autres rien,
-- ce qui est exactement le repli actuel.
INSERT INTO role_permissions (company_id, role, module_key, action, allowed)
SELECT c.id,
       r.role,
       m.module_key,
       a.action,
       r.role IN ('super_admin','admin','administrateur','direction','directeur','gerant','manager')
  FROM companies c
  JOIN (SELECT DISTINCT company_id, lower(trim(role)) AS role
          FROM users WHERE NULLIF(trim(role), '') IS NOT NULL) r ON r.company_id = c.id
  CROSS JOIN permission_modules m
  CROSS JOIN LATERAL unnest(m.actions) AS a(action)
ON CONFLICT (company_id, role, module_key, action) DO NOTHING;

-- ── 7.2 Reprise des permissions individuelles existantes ───────────────
-- Chaque case cochée devient un ALLOW, chaque case décochée un DENY. Une
-- valeur NULL reste non renseignée : elle continue de relever du rôle.
--
-- `visible` suit `can_view` : un module qu'on avait le droit de consulter
-- doit rester visible, sinon la migration le ferait disparaître des menus.
INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect, changed_by)
SELECT u.company_id,
       up.user_id,
       applique.module_key,
       v.action,
       CASE WHEN v.valeur THEN 'ALLOW' ELSE 'DENY' END,
       NULL
  FROM user_permissions up
  JOIN users u ON u.id = up.user_id
  /* Les clés historiques portent des variantes de forme : on les ramène au
     référentiel avec les mêmes alias que rbac-triangle.js, et l'on ignore
     celles qui ne désignent aucun module connu plutôt que d'en inventer. */
  JOIN LATERAL (
    SELECT m.module_key, m.actions FROM permission_modules m
     WHERE m.module_key = CASE lower(trim(up.module_key))
       WHEN 'stocks' THEN 'stock'          WHEN 'inventaires' THEN 'stock.inventaire'
       WHEN 'inventaire' THEN 'stock.inventaire'
       WHEN 'emplacements' THEN 'stock.emplacement'
       WHEN 'emplacement' THEN 'stock.emplacement'
       WHEN 'produits' THEN 'produit'      WHEN 'utilisateurs' THEN 'utilisateur'
       WHEN 'entrepots' THEN 'entrepot'    WHEN 'demandes' THEN 'demande'
       WHEN 'receptions' THEN 'reception'  WHEN 'documents' THEN 'document'
       WHEN 'rapports' THEN 'rapport'      WHEN 'badges' THEN 'badge'
       WHEN 'notifications' THEN 'notification'
       WHEN 'assistant_ia' THEN 'ia'       WHEN 'assistant' THEN 'ia'
       WHEN 'tresorerie' THEN 'comptabilite'
       WHEN 'factures' THEN 'comptabilite' WHEN 'camions' THEN 'logistique'
       WHEN 'clients' THEN 'crm'           WHEN 'fournisseurs' THEN 'fournisseur'
       WHEN 'partenaires' THEN 'partenaire'
       WHEN 'ventes' THEN 'vente'          WHEN 'achats' THEN 'achat'
       WHEN 'ciment' THEN 'ciment'         WHEN 'sable' THEN 'sable'
       WHEN 'parametres' THEN 'parametre'
       ELSE lower(trim(up.module_key))
     END
     LIMIT 1
  ) cible ON true
  CROSS JOIN LATERAL (VALUES
      ('visible',  up.can_view),
      ('view',     up.can_view),
      ('create',   up.can_create),
      ('update',   up.can_edit),
      ('delete',   up.can_delete),
      ('validate', up.can_validate)
  ) AS v(action, valeur)
  /* Où poser ce droit.
     L'ancien modèle était plat : « créer sur stocks » désignait la création de
     mouvements. Le nouveau distingue entrées, sorties, transferts et
     inventaires, et le parent « stock » ne déclare plus « créer ». Poser le
     droit sur le seul parent le ferait donc disparaître. On l'applique au
     parent quand il connaît l'action, sinon à tous ses enfants qui la
     connaissent — ce que l'utilisateur pouvait faire hier, il le peut encore. */
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN v.action = ANY (cible.actions) THEN ARRAY[cible.module_key]
      ELSE COALESCE((SELECT array_agg(enfant.module_key)
                       FROM permission_modules enfant
                      WHERE enfant.parent_key = cible.module_key
                        AND v.action = ANY (enfant.actions)), ARRAY[]::text[])
    END AS modules
  ) portee
  CROSS JOIN LATERAL unnest(portee.modules) AS applique(module_key)
 WHERE v.valeur IS NOT NULL
   AND u.company_id IS NOT NULL
ON CONFLICT (company_id, user_id, module_key, action) DO NOTHING;

-- ── 7.3 Le super admin ne peut pas se voir retirer le centre des droits ──
-- Une exception qui bloquerait un super admin sur son propre écran de
-- permissions le priverait des moyens de se le rendre : on la retire.
DELETE FROM user_permission_overrides o
 USING users u
 WHERE u.id = o.user_id
   AND (u.is_super_admin = true OR lower(trim(u.role)) = 'super_admin')
   AND o.effect = 'DENY';

-- ── 7.4 Trace de la migration elle-même ────────────────────────────────
INSERT INTO permission_audit_log (company_id, target_user_id, module_key, action,
                                  old_value, new_value, origin, changed_by_name)
SELECT o.company_id, o.user_id, o.module_key, o.action,
       'user_permissions', o.effect, 'migration', 'migration 063'
  FROM user_permission_overrides o
 WHERE NOT EXISTS (SELECT 1 FROM permission_audit_log l
                    WHERE l.origin = 'migration' AND l.target_user_id = o.user_id
                      AND l.module_key = o.module_key AND l.action = o.action);

COMMIT;
