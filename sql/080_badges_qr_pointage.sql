-- 080 — BADGES QR ET POINTAGE PAR SCAN, DISTINCT DU POINTAGE MANUEL
--
-- L'effectif de pointage vit dans `attendance_employees` (v2) ; les badges,
-- eux, sont restés sur l'ancien modèle : une colonne `users.badge_code`, une
-- séquence dans `companies`, et rien d'autre. Trois conséquences :
--
--   1. un employé pointé n'a PAS forcément de compte utilisateur — la moitié
--      de l'effectif FAT & MAT n'en a pas — et ne peut donc pas porter de
--      badge du tout ;
--   2. `badge_code` est un identifiant LISIBLE et prévisible
--      (TRIANGLE-EMP-007) : le suivant se devine, ce qui suffit à pointer
--      pour autrui ;
--   3. rien ne garde l'émission, l'impression, la perte ni le remplacement.
--
-- La route de scan existante (`POST /attendance/legacy/scan`) cherche par
-- ailleurs `SELECT * FROM users WHERE badge_code = $1` — sans `company_id`.
-- Un badge Triangle scanné sur un poste FAT & MAT y est donc reconnu. Elle
-- reste en place pour ne rien casser de l'ancien écran, mais le nouveau
-- pointage QR ne s'y appuie pas.
--
-- Ce que cette migration pose :
--
--   • `attendance_badges` — un badge par employé de pointage, porteur d'un
--     JETON non prédictible distinct du code lisible. Le QR ne contient QUE
--     ce jeton : ni nom, ni matricule, ni société. Un QR photographié
--     n'apprend rien à qui le regarde, et ne vaut que lu par le serveur.
--   • `attendance_badge_events` — émission, impression, réimpression,
--     désactivation, remplacement. Un badge perdu se désactive ; son
--     remplaçant est un NOUVEAU jeton, et l'ancien ne pointe plus jamais.
--   • `attendance_qr_scans` — chaque lecture, acceptée ou refusée, avec son
--     motif. C'est ce qui permet de répondre à « pourquoi ça n'a pas marché
--     ce matin ? » sans deviner.
--   • `attendance_event_log_v2.source` distingue déjà QR de MANUEL ; on
--     s'assure que les deux valeurs sont admises et que le manuel cesse de
--     s'enregistrer comme « WEB ».
--
-- Additive et idempotente. Aucun badge existant n'est touché, aucune route
-- existante n'est retirée.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. LES BADGES
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS attendance_badges (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id     INTEGER NOT NULL REFERENCES attendance_employees(id) ON DELETE CASCADE,

  /* Ce que la carte affiche, lisible par un humain. */
  badge_code      TEXT NOT NULL,

  /* Ce que le QR encode. Tiré au hasard, jamais dérivé du code lisible ni
     d'une séquence : deviner le badge du voisin ne doit pas être possible.
     Unique globalement — un jeton scanné est résolu AVANT de savoir de quelle
     société il vient, et deux sociétés ne doivent jamais pouvoir tirer le
     même. (Même raisonnement que laboratory_cases.result_code, migration
     078 : ce qui se cherche sans société s'unicise sans société.) */
  qr_token        TEXT NOT NULL,

  status          TEXT NOT NULL DEFAULT 'ACTIF',
  replaced_by_badge_id INTEGER REFERENCES attendance_badges(id) ON DELETE SET NULL,

  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  print_count     INTEGER NOT NULL DEFAULT 0,
  last_printed_at TIMESTAMPTZ,
  deactivated_at  TIMESTAMPTZ,
  deactivated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deactivation_reason TEXT NOT NULL DEFAULT '',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_badges_status_check') THEN
    ALTER TABLE attendance_badges ADD CONSTRAINT attendance_badges_status_check
      CHECK (status IN ('ACTIF', 'DESACTIVE', 'REMPLACE'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_badges_qr_token_key') THEN
    ALTER TABLE attendance_badges ADD CONSTRAINT attendance_badges_qr_token_key UNIQUE (qr_token);
  END IF;

  /* Le jeton doit rester long : une contrainte vaut mieux qu'une convention
     dans le code, qui se contourne par un script d'import. */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_badges_qr_token_length_check') THEN
    ALTER TABLE attendance_badges ADD CONSTRAINT attendance_badges_qr_token_length_check
      CHECK (char_length(qr_token) >= 24);
  END IF;
END $$;

/* Un seul badge ACTIF par employé : c'est ce qui donne son sens au
   remplacement. L'index partiel laisse coexister autant de badges désactivés
   que l'histoire en a produit. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_badges_actif_par_employe
  ON attendance_badges (employee_id) WHERE status = 'ACTIF';

CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_badges_code_actif
  ON attendance_badges (company_id, badge_code) WHERE status = 'ACTIF';

CREATE INDEX IF NOT EXISTS idx_attendance_badges_societe
  ON attendance_badges (company_id, status);

-- ═════════════════════════════════════════════════════════════════════════
-- 2. LA VIE D'UN BADGE
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS attendance_badge_events (
  id          BIGSERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  badge_id    INTEGER NOT NULL REFERENCES attendance_badges(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL,
  event_type  TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  performed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_badge_events_type_check') THEN
    ALTER TABLE attendance_badge_events ADD CONSTRAINT attendance_badge_events_type_check
      CHECK (event_type IN ('emission','impression','reimpression','desactivation','remplacement'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_attendance_badge_events_badge
  ON attendance_badge_events (badge_id, created_at DESC);

-- ═════════════════════════════════════════════════════════════════════════
-- 3. LES LECTURES, ACCEPTÉES COMME REFUSÉES
--
-- Un scan refusé est l'information la plus utile du lot : c'est lui qui dit
-- pourquoi un employé n'a pas pu pointer. Sans lui, il ne reste que la
-- parole de l'un contre l'absence de trace de l'autre.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS attendance_qr_scans (
  id            BIGSERIAL PRIMARY KEY,
  company_id    INTEGER,
  badge_id      INTEGER REFERENCES attendance_badges(id) ON DELETE SET NULL,
  employee_id   INTEGER,
  action_type   TEXT,
  accepted      BOOLEAN NOT NULL,
  refusal_code  TEXT NOT NULL DEFAULT '',
  /* Jamais le jeton en clair : un journal n'est pas un trousseau. On garde
     de quoi rapprocher deux lectures, pas de quoi en rejouer une. */
  token_hint    TEXT NOT NULL DEFAULT '',
  scanned_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  scanned_by_name TEXT NOT NULL DEFAULT '',
  site_id       INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendance_qr_scans_societe
  ON attendance_qr_scans (company_id, created_at DESC);

/* Retrouver instantanément la dernière lecture d'un badge : c'est le test
   d'anti-doublon du scan, exécuté à chaque passage. */
CREATE INDEX IF NOT EXISTS idx_attendance_qr_scans_badge_recent
  ON attendance_qr_scans (badge_id, created_at DESC) WHERE accepted;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. LA SOURCE D'UN POINTAGE
--
-- La colonne existe déjà avec le défaut 'WEB', mais aucune contrainte ne dit
-- quelles valeurs ont un sens. Un rapport qui compare « QR » et « MANUEL »
-- doit pouvoir compter sur le vocabulaire.
--
-- 'WEB' est conservé : c'est ce que portent les lignes déjà écrites, et les
-- réécrire reviendrait à affirmer une origine qu'on ne connaît pas.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_event_log_v2_source_check') THEN
    ALTER TABLE attendance_event_log_v2 ADD CONSTRAINT attendance_event_log_v2_source_check
      CHECK (source IN ('QR', 'MANUEL', 'IMPORT', 'CORRECTION_ADMINISTRATIVE', 'WEB'));
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. LES DROITS
--
-- Pointer par QR, gérer les badges et voir la paie sont trois choses
-- différentes. Les séparer au catalogue est ce qui permet à un opérateur de
-- scanner toute la journée sans jamais approcher un salaire.
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO permission_actions (action_key, label, description, sort_order, is_write) VALUES
  ('scan',      'Scanner',      'Lire un badge QR pour enregistrer un pointage.', 172, true),
  ('correct',   'Corriger',     'Corriger un pointage déjà enregistré, avec motif.', 174, true),
  ('close',     'Clôturer',     'Clôturer une période après validation.',          176, true),
  ('reprint',   'Réimprimer',   'Réimprimer un document ou un badge déjà imprimé.', 178, true),
  ('replace',   'Remplacer',    'Remplacer un badge perdu : l''ancien cesse de valoir.', 180, true)
ON CONFLICT (action_key) DO NOTHING;

INSERT INTO permission_modules (module_key, parent_key, label, description, sort_order, is_active, is_system, actions) VALUES
  ('pointage.qr', 'pointage', 'Pointage QR',
   'Enregistrer un pointage en lisant le badge QR d''un employé.', 302, true, false,
   ARRAY['visible','view','scan']),
  ('pointage.manuel', 'pointage', 'Pointage manuel',
   'Enregistrer un pointage en choisissant l''employé dans une liste.', 301, true, false,
   ARRAY['visible','view','create','correct']),
  ('pointage.badge', 'pointage', 'Badges de pointage',
   'Émettre, imprimer, désactiver et remplacer les badges QR des employés.', 305, true, false,
   ARRAY['visible','view','create','print','reprint','replace','audit'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      label = EXCLUDED.label, description = EXCLUDED.description,
      parent_key = EXCLUDED.parent_key, updated_at = now();

/* Le module parent gagne les actions de ses enfants : `decider()` remonte du
   parent vers les sous-modules, mais l'écran des droits n'affiche que ce que
   le module DÉCLARE. Sans cette union, les cases resteraient invisibles. */
UPDATE permission_modules
   SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                    FROM unnest(actions || ARRAY['scan','correct','close','print']) AS a),
       updated_at = now()
 WHERE module_key = 'pointage'
   AND NOT (actions @> ARRAY['scan','correct','close','print']);

-- ═════════════════════════════════════════════════════════════════════════
-- 6. DROITS PAR RÔLE
--
-- Scanner un badge n'est pas administrer les badges, et ni l'un ni l'autre
-- n'ouvre le moindre salaire. `direction` reste sans ligne : configurable à
-- l'écran, comme pour le module sable (075).
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'admin',                'pointage.qr',     'visible', true),
      (soc.id, 'admin',                'pointage.qr',     'view',    true),
      (soc.id, 'admin',                'pointage.qr',     'scan',    true),
      (soc.id, 'admin',                'pointage.manuel', 'visible', true),
      (soc.id, 'admin',                'pointage.manuel', 'view',    true),
      (soc.id, 'admin',                'pointage.manuel', 'create',  true),
      (soc.id, 'admin',                'pointage.manuel', 'correct', true),
      (soc.id, 'admin',                'pointage.badge',  'visible', true),
      (soc.id, 'admin',                'pointage.badge',  'view',    true),
      (soc.id, 'admin',                'pointage.badge',  'create',  true),
      (soc.id, 'admin',                'pointage.badge',  'print',   true),
      (soc.id, 'admin',                'pointage.badge',  'reprint', true),
      (soc.id, 'admin',                'pointage.badge',  'replace', true),
      (soc.id, 'admin',                'pointage.badge',  'audit',   true),

      (soc.id, 'responsable_entrepot', 'pointage.qr',     'visible', true),
      (soc.id, 'responsable_entrepot', 'pointage.qr',     'view',    true),
      (soc.id, 'responsable_entrepot', 'pointage.qr',     'scan',    true),
      (soc.id, 'responsable_entrepot', 'pointage.manuel', 'visible', true),
      (soc.id, 'responsable_entrepot', 'pointage.manuel', 'view',    true),
      (soc.id, 'responsable_entrepot', 'pointage.manuel', 'create',  true),
      (soc.id, 'responsable_entrepot', 'pointage.badge',  'visible', true),
      (soc.id, 'responsable_entrepot', 'pointage.badge',  'view',    true),
      (soc.id, 'responsable_entrepot', 'pointage.badge',  'print',   true)
    ON CONFLICT (company_id, role, module_key, action) DO NOTHING;
  END LOOP;
END $$;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='attendance_badges') THEN
    RAISE EXCEPTION '080 : sans attendance_badges, le pointage QR n''a rien à lire.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE indexname = 'idx_attendance_badges_actif_par_employe') THEN
    RAISE EXCEPTION '080 : sans badge actif unique, un employé pourrait pointer avec deux cartes.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permission_modules WHERE module_key = 'pointage.qr') THEN
    RAISE EXCEPTION '080 : sans module pointage.qr, le droit de scanner ne serait opposable nulle part.';
  END IF;
  RAISE NOTICE 'Badges QR : table, historique, journal des scans et droits en place.';
END $$;
