-- Après sauvegarde. Aucune modification de stock, de rôle ou de permission générale.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS dt_module_owner (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS dt_module_access (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  allowed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(company_id,user_id)
);
DO $$
DECLARE owner_id INTEGER; owner_company INTEGER; owner_role TEXT; owner_email TEXT;
BEGIN
  IF (SELECT COUNT(*) FROM users WHERE lower(trim(email))='diallogcif@gmail.com') <> 1 THEN
    RAISE EXCEPTION 'Compte propriétaire absent ou ambigu : arrêt sans activation';
  END IF;
  SELECT u.id,u.company_id,u.role,u.email INTO owner_id,owner_company,owner_role,owner_email
  FROM users u JOIN companies c ON c.id=u.company_id
  WHERE lower(trim(u.email))='diallogcif@gmail.com' AND u.is_active IS TRUE
    AND (u.is_super_admin IS TRUE OR lower(u.role)='super_admin') AND c.tenant_id='triangle';
  IF owner_id IS NULL THEN RAISE EXCEPTION 'Compte super administrateur Triangle actif requis'; END IF;
  IF EXISTS(SELECT 1 FROM dt_module_owner WHERE user_id <> owner_id) THEN
    RAISE EXCEPTION 'Propriétaire déjà défini : aucun remplacement automatique';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM dt_module_owner) THEN
    INSERT INTO dt_module_owner(singleton,user_id) VALUES(TRUE,owner_id);
    INSERT INTO audit_logs(user_id,user_email,user_role,company_id,action,entity_type,entity_id,details)
    VALUES(owner_id,owner_email,owner_role,owner_company,'digital_twin.access.initialize','digital_twin_access',owner_id,
      '{"owner_only":true,"reason":"Demande explicite du propriétaire"}'::jsonb);
  END IF;
END $$;
COMMIT;
