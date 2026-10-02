-- ═════════════════════════════════════════════════════════════════════════
-- 104 — BIOMÉTRIE (VISAGE, EMPREINTE), PASSKEYS ET VALIDATION RENFORCÉE
--
-- Additive et idempotente. Aucune donnée existante n'est modifiée.
--
-- Triangle pointe des EMPLOYÉS (`attendance_employees`), pas des comptes :
-- la plupart des manœuvres et chauffeurs n'ont pas de compte. Le sujet
-- biométrique est donc toujours une fiche employé, de LA société, active.
--
-- Garde-fous portés PAR LA BASE, pas seulement par le code :
--   • un gabarit ne peut être stocké que chiffré (préfixe « bv1. ») ;
--   • un profil ou un consentement ne vise qu'un employé de SA société ;
--   • un seul profil actif par employé, modalité et doigt ;
--   • un défi ne sert qu'une fois (nonce unique, used_at) ;
--   • un pointage VISAGE / EMPREINTE porte son score.
-- Aucun événement ne porte de gabarit, d'image ou de secret.
--
-- Le pointage biométrique n'a PAS de table à lui : il écrit par le moteur v2
-- (`attendance_day_records_v2` + `attendance_event_log_v2`), comme le QR et
-- le manuel. Le journal v2 gagne seulement de quoi dire QUEL appareil, QUEL
-- score, QUEL fournisseur et QUEL défi.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Réglages par société ───────────────────────────────────────────────
-- Tout est FERMÉ par défaut : aucune modalité active tant qu'un
-- administrateur ne l'a pas décidé, avec un fournisseur configuré.
CREATE TABLE IF NOT EXISTS biometric_settings (
  company_id              INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id               TEXT,
  face_enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  fingerprint_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  face_provider           TEXT NOT NULL DEFAULT '',
  fingerprint_provider    TEXT NOT NULL DEFAULT '',
  face_threshold          NUMERIC(5,4) NOT NULL DEFAULT 0.8500,
  fingerprint_threshold   NUMERIC(5,4) NOT NULL DEFAULT 0.8500,
  require_liveness        BOOLEAN NOT NULL DEFAULT TRUE,
  require_known_device    BOOLEAN NOT NULL DEFAULT TRUE,
  require_challenge       BOOLEAN NOT NULL DEFAULT TRUE,
  allow_identification    BOOLEAN NOT NULL DEFAULT FALSE,
  self_enrollment         BOOLEAN NOT NULL DEFAULT FALSE,
  stepup_required         BOOLEAN NOT NULL DEFAULT FALSE,
  challenge_ttl_seconds   INTEGER NOT NULL DEFAULT 120 CHECK (challenge_ttl_seconds BETWEEN 15 AND 900),
  profile_validity_days   INTEGER NOT NULL DEFAULT 730 CHECK (profile_validity_days BETWEEN 1 AND 3650),
  event_retention_days    INTEGER NOT NULL DEFAULT 365 CHECK (event_retention_days BETWEEN 30 AND 3650),
  consent_text_version    TEXT NOT NULL DEFAULT 'v1',
  updated_by              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (face_threshold BETWEEN 0.5 AND 0.9999),
  CHECK (fingerprint_threshold BETWEEN 0.5 AND 0.9999)
);

-- ── Consentements ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS biometric_consents (
  id                 SERIAL PRIMARY KEY,
  company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id          TEXT,
  subject_type       TEXT NOT NULL CHECK (subject_type IN ('user', 'employee')),
  user_id            INTEGER REFERENCES users(id) ON DELETE CASCADE,
  employee_id        INTEGER REFERENCES attendance_employees(id) ON DELETE CASCADE,
  modalities         TEXT[] NOT NULL,
  purposes           TEXT[] NOT NULL,
  text_version       TEXT NOT NULL,
  text_hash          TEXT NOT NULL,
  method             TEXT NOT NULL CHECK (method IN ('ecran', 'papier')),
  paper_reference    TEXT NOT NULL DEFAULT '',
  given_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  withdrawn_at       TIMESTAMPTZ,
  withdrawn_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  withdrawal_reason  TEXT NOT NULL DEFAULT '',
  CHECK ((subject_type = 'user' AND user_id IS NOT NULL) OR (subject_type = 'employee' AND employee_id IS NOT NULL)),
  CHECK (modalities <@ ARRAY['face', 'fingerprint']::TEXT[] AND cardinality(modalities) > 0),
  CHECK (purposes <@ ARRAY['pointage', 'controle_acces', 'connexion', 'action_sensible', 'identification']::TEXT[]
         AND cardinality(purposes) > 0)
);
CREATE INDEX IF NOT EXISTS idx_biometric_consents_sujet ON biometric_consents (company_id, subject_type, user_id, employee_id);

-- ── Appareils ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS biometric_devices (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id         TEXT,
  site_id           INTEGER REFERENCES attendance_work_sites(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  provider          TEXT NOT NULL DEFAULT '',
  device_type       TEXT NOT NULL CHECK (device_type IN ('terminal_visage', 'terminal_empreinte', 'kiosque', 'pc_local', 'mobile')),
  serial            TEXT NOT NULL,
  auth_method       TEXT NOT NULL DEFAULT 'hmac' CHECK (auth_method IN ('hmac')),
  secret_encrypted  TEXT NOT NULL CHECK (secret_encrypted LIKE 'bv1.%'),
  public_key        TEXT NOT NULL DEFAULT '',
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at      TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, serial)
);

-- ── Profils biométriques ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS biometric_profiles (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id           TEXT,
  subject_type        TEXT NOT NULL CHECK (subject_type IN ('user', 'employee')),
  user_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,
  employee_id         INTEGER REFERENCES attendance_employees(id) ON DELETE CASCADE,
  biometric_type      TEXT NOT NULL CHECK (biometric_type IN ('face', 'fingerprint')),
  provider            TEXT NOT NULL,
  finger_index        SMALLINT CHECK (finger_index IS NULL OR finger_index BETWEEN 0 AND 9),
  template_format     TEXT NOT NULL DEFAULT '',
  template_encrypted  TEXT CHECK (template_encrypted IS NULL OR template_encrypted LIKE 'bv1.%'),
  template_key_id     TEXT,
  external_reference  TEXT NOT NULL DEFAULT '',
  device_id           INTEGER REFERENCES biometric_devices(id) ON DELETE SET NULL,
  quality             NUMERIC(5,4),
  status              TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'inactif', 'revoque')),
  consent_id          INTEGER NOT NULL REFERENCES biometric_consents(id) ON DELETE RESTRICT,
  enrolled_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  enrolled_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ,
  last_verified_at    TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  revoked_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason       TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((subject_type = 'user' AND user_id IS NOT NULL) OR (subject_type = 'employee' AND employee_id IS NOT NULL)),
  CHECK ((biometric_type = 'face' AND finger_index IS NULL) OR biometric_type = 'fingerprint'),
  -- Gabarit côté serveur OU référence dans un appareil : jamais ni l'un ni l'autre.
  CHECK (template_encrypted IS NOT NULL OR external_reference <> '' OR status <> 'actif'),
  -- Un profil révoqué ne garde aucun gabarit.
  CHECK (status <> 'revoque' OR template_encrypted IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_biometric_profile_actif
  ON biometric_profiles (company_id, subject_type, COALESCE(user_id, 0), COALESCE(employee_id, 0),
                         biometric_type, COALESCE(finger_index, -1))
  WHERE status = 'actif';
CREATE INDEX IF NOT EXISTS idx_biometric_profiles_reference
  ON biometric_profiles (company_id, biometric_type, external_reference) WHERE external_reference <> '';

/* Un EMPLOYÉ de LA société, et lui seul. Un compte (`users`) n'est jamais
   sujet biométrique à Triangle : les comptes s'authentifient par mot de
   passe et passkey ; la biométrie sert à pointer des employés.
   L'employé doit être actif pour recevoir un consentement ou un profil
   ACTIF ; révoquer reste toujours possible, même après son départ. */
CREATE OR REPLACE FUNCTION biometrie_employe_seulement() RETURNS trigger AS $$
DECLARE
  e_societe INTEGER;
  e_actif BOOLEAN;
  controler_actif BOOLEAN;
BEGIN
  IF NEW.subject_type <> 'employee' OR NEW.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'biometrie: à Triangle, seule une fiche employé peut recevoir une donnée biométrique'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT company_id, active INTO e_societe, e_actif FROM attendance_employees WHERE id = NEW.employee_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'biometrie: employé introuvable' USING ERRCODE = 'check_violation';
  END IF;
  IF e_societe IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'biometrie: l''employé n''appartient pas à cette société' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'biometric_profiles' THEN
    controler_actif := NEW.status = 'actif';
  ELSE
    controler_actif := TG_OP = 'INSERT';
  END IF;
  IF controler_actif AND e_actif IS NOT TRUE THEN
    RAISE EXCEPTION 'biometrie: employé inactif' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_biometric_profiles_employe ON biometric_profiles;
CREATE TRIGGER trg_biometric_profiles_employe BEFORE INSERT OR UPDATE ON biometric_profiles
  FOR EACH ROW EXECUTE FUNCTION biometrie_employe_seulement();
DROP TRIGGER IF EXISTS trg_biometric_consents_employe ON biometric_consents;
CREATE TRIGGER trg_biometric_consents_employe BEFORE INSERT OR UPDATE ON biometric_consents
  FOR EACH ROW EXECUTE FUNCTION biometrie_employe_seulement();

-- ── Défis à usage unique (anti-rejeu) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS biometric_challenges (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id         TEXT,
  requested_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  subject_type      TEXT CHECK (subject_type IN ('user', 'employee')),
  subject_user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  subject_employee_id INTEGER REFERENCES attendance_employees(id) ON DELETE CASCADE,
  device_id         INTEGER REFERENCES biometric_devices(id) ON DELETE CASCADE,
  biometric_type    TEXT NOT NULL CHECK (biometric_type IN ('face', 'fingerprint')),
  purpose           TEXT NOT NULL,
  action            TEXT NOT NULL DEFAULT '',
  nonce_hash        TEXT NOT NULL UNIQUE,
  expires_at        TIMESTAMPTZ NOT NULL,
  used_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_biometric_challenges_expiration ON biometric_challenges (expires_at);

-- ── Événements (journal biométrique) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS biometric_events (
  id                BIGSERIAL PRIMARY KEY,
  company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id         TEXT,
  subject_type      TEXT,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  employee_id       INTEGER REFERENCES attendance_employees(id) ON DELETE SET NULL,
  profile_id        INTEGER REFERENCES biometric_profiles(id) ON DELETE SET NULL,
  biometric_type    TEXT,
  action            TEXT NOT NULL,
  purpose           TEXT NOT NULL DEFAULT '',
  result            TEXT NOT NULL CHECK (result IN ('accepte', 'refuse', 'erreur')),
  reason_code       TEXT NOT NULL DEFAULT '',
  confidence        NUMERIC(5,4),
  threshold         NUMERIC(5,4),
  provider          TEXT NOT NULL DEFAULT '',
  device_id         INTEGER REFERENCES biometric_devices(id) ON DELETE SET NULL,
  challenge_id      INTEGER REFERENCES biometric_challenges(id) ON DELETE SET NULL,
  device_event_ref  TEXT,
  performed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip_address        TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (action IN ('enrolement', 'verification', 'identification', 'revocation', 'desactivation',
                    'reactivation', 'renouvellement', 'consentement', 'retrait_consentement',
                    'appareil', 'evenement_appareil', 'reglages', 'purge'))
);
CREATE INDEX IF NOT EXISTS idx_biometric_events_company ON biometric_events (company_id, created_at DESC);
-- Un événement d'appareil ne se rejoue pas : référence unique par appareil.
CREATE UNIQUE INDEX IF NOT EXISTS uq_biometric_events_appareil
  ON biometric_events (device_id, device_event_ref) WHERE device_event_ref IS NOT NULL;

-- ── Passkeys (WebAuthn) : AUCUNE donnée biométrique ────────────────────
-- Face ID, Touch ID, Windows Hello, empreinte Android : la biométrie reste
-- dans l'appareil. Le serveur ne garde qu'une clé publique.
CREATE TABLE IF NOT EXISTS auth_passkeys (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id       TEXT,
  credential_id   TEXT NOT NULL UNIQUE,
  public_key      TEXT NOT NULL,
  counter         BIGINT NOT NULL DEFAULT 0,
  transports      TEXT[] NOT NULL DEFAULT '{}',
  device_type     TEXT NOT NULL DEFAULT '',
  backed_up       BOOLEAN NOT NULL DEFAULT FALSE,
  aaguid          TEXT NOT NULL DEFAULT '',
  name            TEXT NOT NULL DEFAULT 'Appareil',
  rp_id           TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_auth_passkeys_user ON auth_passkeys (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_passkey_challenges (
  id          SERIAL PRIMARY KEY,
  purpose     TEXT NOT NULL CHECK (purpose IN ('enregistrement', 'connexion', 'step_up')),
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   TEXT,
  challenge   TEXT NOT NULL UNIQUE,
  rp_id       TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '',
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Validation renforcée (step-up) : 5 minutes après une preuve forte ──
CREATE TABLE IF NOT EXISTS auth_stepup_grants (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  method      TEXT NOT NULL CHECK (method IN ('passkey', 'visage', 'empreinte')),
  scope       TEXT NOT NULL DEFAULT '',
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_stepup_user ON auth_stepup_grants (user_id, expires_at DESC);

-- ═════════════════════════════════════════════════════════════════════════
-- LE JOURNAL v2 DIT D'OÙ VIENT UN POINTAGE BIOMÉTRIQUE
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE attendance_event_log_v2
  ADD COLUMN IF NOT EXISTS device_id          INTEGER REFERENCES biometric_devices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS biometric_score    NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS biometric_provider TEXT,
  ADD COLUMN IF NOT EXISTS challenge_id       INTEGER REFERENCES biometric_challenges(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata           JSONB NOT NULL DEFAULT '{}'::jsonb;

/* Le vocabulaire des sources s'élargit ; les valeurs déjà écrites restent
   valides (le nouvel ensemble contient l'ancien). */
ALTER TABLE attendance_event_log_v2 DROP CONSTRAINT IF EXISTS attendance_event_log_v2_source_check;
ALTER TABLE attendance_event_log_v2 ADD CONSTRAINT attendance_event_log_v2_source_check
  CHECK (source IN ('QR', 'MANUEL', 'IMPORT', 'CORRECTION_ADMINISTRATIVE', 'WEB',
                    'VISAGE', 'EMPREINTE', 'PASSKEY_CONFIRMATION'));

/* Un pointage biométrique sans score serait invérifiable après coup. */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_event_log_v2_score_biometrique') THEN
    ALTER TABLE attendance_event_log_v2 ADD CONSTRAINT attendance_event_log_v2_score_biometrique
      CHECK (source NOT IN ('VISAGE', 'EMPREINTE') OR biometric_score IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_attendance_event_log_v2_recent
  ON attendance_event_log_v2 (company_id, employee_id, created_at DESC);

-- ═════════════════════════════════════════════════════════════════════════
-- LES DROITS
--
-- Les noms communs du noyau (biometrie.voir, .enroler…) se traduisent ici en
-- couples module|action du centre des droits Triangle :
--   biometrie.voir        → biometrie|view
--   biometrie.enroler     → biometrie|enroll
--   biometrie.verifier    → biometrie|verify
--   biometrie.revoquer    → biometrie|revoke
--   biometrie.audit       → biometrie|audit
--   biometrie.appareils   → biometrie|devices
--   biometrie.parametres  → biometrie|configure
--   pointage.biometrie    → pointage.biometrie|scan
-- Sans ligne explicite, le repli du moteur n'accorde qu'aux rôles
-- d'administration : un opérateur ne reçoit rien tant qu'on ne le décide pas.
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO permission_actions (action_key, label, description, sort_order, is_write) VALUES
  ('enroll',  'Enrôler',    'Enregistrer le visage ou l''empreinte d''une personne, après consentement.', 196, true),
  ('verify',  'Vérifier',   'Comparer une capture au profil biométrique d''une personne.',             197, true),
  ('revoke',  'Révoquer',   'Révoquer un profil biométrique : le gabarit est effacé.',                198, true),
  ('devices', 'Appareils',  'Déclarer, désactiver un appareil biométrique et renouveler son secret.', 199, true)
ON CONFLICT (action_key) DO NOTHING;

INSERT INTO permission_modules (module_key, parent_key, label, description, sort_order, is_active, is_system, actions) VALUES
  ('biometrie', NULL, 'Biométrie',
   'Visage et empreinte : consentements, profils, appareils, réglages et journal. Aucun gabarit n''est jamais affiché.',
   320, true, false,
   ARRAY['visible','view','enroll','verify','revoke','audit','devices','configure']),
  ('pointage.biometrie', 'pointage', 'Pointage biométrique',
   'Pointer un employé par visage ou empreinte, sur un appareil déclaré.', 306, true, false,
   ARRAY['visible','view','scan'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      label = EXCLUDED.label, description = EXCLUDED.description,
      parent_key = EXCLUDED.parent_key, updated_at = now();

DO $$
DECLARE soc RECORD; act TEXT;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    FOREACH act IN ARRAY ARRAY['visible','view','enroll','verify','revoke','audit','devices','configure'] LOOP
      INSERT INTO role_permissions (company_id, role, module_key, action, allowed)
      VALUES (soc.id, 'admin', 'biometrie', act, true)
      ON CONFLICT (company_id, role, module_key, action)
      DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
       WHERE role_permissions.updated_by IS NULL;
    END LOOP;
    FOREACH act IN ARRAY ARRAY['visible','view','scan'] LOOP
      INSERT INTO role_permissions (company_id, role, module_key, action, allowed)
      VALUES (soc.id, 'admin', 'pointage.biometrie', act, true)
      ON CONFLICT (company_id, role, module_key, action)
      DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
       WHERE role_permissions.updated_by IS NULL;
    END LOOP;
  END LOOP;
END $$;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'attendance_event_log_v2' AND column_name = 'biometric_score') THEN
    RAISE EXCEPTION '104 : le journal v2 ne sait pas porter un score biométrique.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permission_modules WHERE module_key = 'biometrie') THEN
    RAISE EXCEPTION '104 : sans module biometrie, aucun droit biométrique ne serait opposable.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_biometric_profiles_employe') THEN
    RAISE EXCEPTION '104 : sans déclencheur, un profil pourrait viser un employé d''une autre société.';
  END IF;
END $$;
