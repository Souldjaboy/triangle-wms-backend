BEGIN;

/* Lire ses propres avances et administrer celles de toute l'entreprise sont
   deux pouvoirs différents. La portée globale apparaît donc explicitement
   dans le centre des droits. */
INSERT INTO permission_actions
  (action_key, label, description, sort_order, is_write)
VALUES
  ('view_all', 'Voir tout', 'Consulter les dossiers de tous les salariés.', 25, false)
ON CONFLICT (action_key) DO NOTHING;

/* Le fret existait sur le tableau de bord avec un contrôle par société
   uniquement. Il devient un vrai module de la matrice des droits. */
INSERT INTO permission_modules
  (module_key, parent_key, label, description, sort_order, is_active, is_system, actions)
VALUES
  ('fret_chine_mali', NULL, 'Fret Chine–Mali',
   'Réceptions, clients, marchandises, photos et suivi du fret Chine–Mali.',
   245, true, false, ARRAY['visible','view','create','update','export','print'])
ON CONFLICT (module_key) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      is_active = true,
      actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      updated_at = now();

INSERT INTO permission_modules
  (module_key, parent_key, label, description, sort_order, is_active, is_system, actions)
VALUES
  ('presentation_reunion', 'rapport', 'Présentation hebdomadaire',
   'Chiffre d’affaires, dépenses et résultat, sans solde bancaire ni trésorerie.',
   125, true, false, ARRAY['visible','view','print','export'])
ON CONFLICT (module_key) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      parent_key = EXCLUDED.parent_key,
      is_active = true,
      actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      updated_at = now();

INSERT INTO permission_modules
  (module_key, parent_key, label, description, sort_order, is_active, is_system, actions)
VALUES
  ('centre_camera', NULL, 'Centre caméras',
   'Consulter et configurer les sites et canaux de vidéosurveillance.',
   246, true, false, ARRAY['visible','view','create','update','configure'])
ON CONFLICT (module_key) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      is_active = true,
      actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      updated_at = now();

UPDATE permission_modules
   SET actions = CASE
       WHEN actions @> ARRAY['view_all']::text[] THEN actions
       ELSE actions || ARRAY['view_all']::text[]
     END,
       updated_at = now()
 WHERE module_key = 'paie.avance';

DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    /* Les salariés peuvent demander et suivre uniquement leur propre avance.
       Les actions sensibles restent explicitement refusées par défaut. */
    INSERT INTO role_permissions
      (company_id, role, module_key, action, allowed)
    SELECT soc.id, r.role, 'paie.avance', a.action, a.allowed
      FROM (VALUES
        ('employe'), ('responsable_entrepot'), ('magasinier'),
        ('chef_entrepot'), ('secretaire')
      ) AS r(role)
      CROSS JOIN (VALUES
        ('visible', true), ('view', true), ('create', true),
        ('view_all', false), ('validate', false), ('pay', false),
        ('update', false), ('cancel', false), ('delete', false)
      ) AS a(action, allowed)
    ON CONFLICT (company_id, role, module_key, action)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
      WHERE role_permissions.updated_by IS NULL;

    /* Comptabilité, Direction et Direction générale voient tous les dossiers.
       Les autres actions continuent d'être réglées séparément. */
    INSERT INTO role_permissions
      (company_id, role, module_key, action, allowed)
    SELECT soc.id, role, 'paie.avance', 'view_all', true
      FROM (VALUES
        ('comptable'), ('direction'), ('directeur'), ('directeur_general'),
        ('directeur_général'), ('dg'), ('admin'), ('administrateur'),
        ('gerant'), ('manager')
      ) AS r(role)
    ON CONFLICT (company_id, role, module_key, action)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
      WHERE role_permissions.updated_by IS NULL;
  END LOOP;
END $$;

/* Le comportement historique des caméras est conservé comme valeur initiale,
   puis chaque utilisateur peut être autorisé ou refusé depuis la matrice. */
INSERT INTO role_permissions
  (company_id, role, module_key, action, allowed)
SELECT c.id, r.role, 'centre_camera', a.action, a.allowed
  FROM companies c
  CROSS JOIN (VALUES
    ('direction'), ('directeur'), ('directeur_general'), ('directeur_général'),
    ('dg'), ('admin'), ('administrateur'), ('responsable_admin'),
    ('responsable_administratif')
  ) AS r(role)
  CROSS JOIN (VALUES
    ('visible', true), ('view', true), ('create', true),
    ('update', true), ('configure', true)
  ) AS a(action, allowed)
ON CONFLICT (company_id, role, module_key, action)
DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
  WHERE role_permissions.updated_by IS NULL;

/* Le responsable d'entrepôt peut créer et corriger une fiche produit. La
   suppression reste un droit distinct, refusé par défaut ; les quantités se
   corrigent par un mouvement de stock auditable, pas en réécrivant la fiche. */
INSERT INTO role_permissions
  (company_id, role, module_key, action, allowed)
SELECT c.id, 'responsable_entrepot', 'produit', a.action, a.allowed
  FROM companies c
  CROSS JOIN (VALUES
    ('visible', true), ('view', true), ('create', true), ('update', true),
    ('delete', false)
  ) AS a(action, allowed)
ON CONFLICT (company_id, role, module_key, action)
DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
  WHERE role_permissions.updated_by IS NULL;

COMMIT;
