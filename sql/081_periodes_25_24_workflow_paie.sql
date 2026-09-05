-- 081 — LE CYCLE DU 25 AU 24, ET LE CHEMIN D'UNE PAIE JUSQU'AU PAIEMENT
--
-- Deux manques, liés :
--
--   1. `attendance_payroll_runs_v2.period_month` est contraint au PREMIER
--      jour d'un mois calendaire. Or le cycle réel court du 25 d'un mois au
--      24 du suivant : la paie de septembre couvre le 25 août → 24 septembre.
--      Le mois calendaire ne peut pas exprimer cette période.
--
--   2. Le statut d'une paie ne connaît que DRAFT → PAID. Le comptable qui
--      prépare peut donc payer dans la foulée : rien, structurellement,
--      n'oblige à passer par la Direction. Une règle qui ne vit que dans la
--      tête des gens n'est pas une règle.
--
-- Ce que pose cette migration :
--
--   • `attendance_periods` — la période elle-même, du 25 au 24, avec son
--     statut. Les périodes se génèrent sans trou ni chevauchement (contrainte
--     d'exclusion : PostgreSQL refuse deux périodes qui se recouvrent, plutôt
--     que de compter sur la discipline du code).
--   • `attendance_holidays` — les jours fériés, par société. Un jour férié
--     n'est pas une absence.
--   • le mode du samedi, configurable par société.
--   • `payroll_requests` — la demande à la Direction, avec sa décision et son
--     motif. C'est elle qui rend le passage obligatoire.
--   • `payroll_item_adjustments` — toute modification d'un montant par la
--     Direction, avec avant/après, motif et auteur.
--   • `payroll_vouchers` — le bon numéroté, figé après émission.
--
-- Additive. `period_month` reste en place et gardé : les paies déjà
-- enregistrées restent lisibles, et rien de l'écran actuel ne cesse de
-- fonctionner tant que la période n'est pas renseignée.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. LE CALENDRIER DE LA SOCIÉTÉ
--
-- Le dimanche n'est jamais travaillé et ne crée aucune absence : c'est déjà
-- ce que dit `attendance_schedule_days`. Le samedi, lui, varie d'une société
-- et d'une saison à l'autre — d'où un réglage explicite plutôt qu'une
-- convention enfouie dans le code.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE attendance_company_configuration
  ADD COLUMN IF NOT EXISTS saturday_mode    TEXT NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS period_start_day SMALLINT NOT NULL DEFAULT 25;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_company_configuration_saturday_mode_check') THEN
    ALTER TABLE attendance_company_configuration
      ADD CONSTRAINT attendance_company_configuration_saturday_mode_check
      CHECK (saturday_mode IN ('NORMAL', 'FACULTATIF', 'EXCEPTIONNEL', 'NON_TRAVAILLE'));
  END IF;
  /* Entre 1 et 28 : au-delà, un mois de février ferait disparaître le jour
     de bascule une année sur quatre. */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_company_configuration_period_start_day_check') THEN
    ALTER TABLE attendance_company_configuration
      ADD CONSTRAINT attendance_company_configuration_period_start_day_check
      CHECK (period_start_day BETWEEN 1 AND 28);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS attendance_holidays (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  label        TEXT NOT NULL,
  /* Un jour férié travaillé exceptionnellement reste un jour férié : on ne
     l'efface pas du calendrier, on note que le travail y a eu lieu. */
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_holidays_company_date_key') THEN
    ALTER TABLE attendance_holidays
      ADD CONSTRAINT attendance_holidays_company_date_key UNIQUE (company_id, holiday_date);
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. LES PÉRIODES
--
-- `daterange` et une contrainte d'EXCLUSION plutôt qu'un simple UNIQUE : ce
-- qu'on veut interdire n'est pas la répétition d'une date, c'est le
-- CHEVAUCHEMENT de deux périodes. Deux paies qui se recouvrent paieraient
-- deux fois les mêmes journées, et aucune application ne le remarquerait.
-- ═════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS attendance_periods (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  /* Le mois de PAIE, pas le mois de début : la période 25/08 → 24/09 est
     « la paie de septembre », c'est ainsi qu'on en parle. */
  code        TEXT NOT NULL,
  date_debut  DATE NOT NULL,
  date_fin    DATE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'OUVERTE',

  attendance_validated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  attendance_validated_at   TIMESTAMPTZ,
  reopened_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reopened_at               TIMESTAMPTZ,
  reopen_reason             TEXT NOT NULL DEFAULT '',
  closed_by                 INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at                 TIMESTAMPTZ,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_periods_status_check') THEN
    ALTER TABLE attendance_periods ADD CONSTRAINT attendance_periods_status_check
      CHECK (status IN (
        'OUVERTE', 'EN_REVISION_POINTAGE', 'POINTAGE_VALIDE', 'PAIE_PREPAREE',
        'EN_ATTENTE_DIRECTION', 'VALIDEE_DIRECTION', 'AUTORISEE_AU_PAIEMENT',
        'PAYEE', 'CLOTUREE', 'ANNULEE'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_periods_bornes_check') THEN
    ALTER TABLE attendance_periods ADD CONSTRAINT attendance_periods_bornes_check
      CHECK (date_fin > date_debut);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_periods_company_code_key') THEN
    ALTER TABLE attendance_periods
      ADD CONSTRAINT attendance_periods_company_code_key UNIQUE (company_id, code);
  END IF;

  /* Le cœur : deux périodes d'une même société ne peuvent pas se recouvrir.
     `daterange(…, ']')` inclut la date de fin — le 24 appartient bien à la
     période, et la suivante commence le 25. */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_periods_sans_chevauchement') THEN
    ALTER TABLE attendance_periods
      ADD CONSTRAINT attendance_periods_sans_chevauchement
      EXCLUDE USING gist (
        company_id WITH =,
        daterange(date_debut, date_fin, '[]') WITH &&
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_attendance_periods_societe
  ON attendance_periods (company_id, date_debut DESC);

/* La paie s'accroche à une période. Nullable : les paies mensuelles déjà
   enregistrées n'en ont pas, et les réécrire leur inventerait des bornes que
   personne n'a validées. */
ALTER TABLE attendance_payroll_runs_v2
  ADD COLUMN IF NOT EXISTS period_id INTEGER REFERENCES attendance_periods(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_payroll_runs_periode
  ON attendance_payroll_runs_v2 (period_id);

-- ═════════════════════════════════════════════════════════════════════════
-- 3. LES STATUTS DE PAIE, ÉLARGIS
--
-- On remplace la contrainte au lieu de l'étendre : une contrainte CHECK ne
-- s'ajoute pas, elle se redéfinit. Les quatre valeurs d'origine restent
-- admises — aucune ligne existante ne devient invalide.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE attendance_payroll_runs_v2
  DROP CONSTRAINT IF EXISTS attendance_payroll_runs_v2_status_check;

ALTER TABLE attendance_payroll_runs_v2
  ADD CONSTRAINT attendance_payroll_runs_v2_status_check
  CHECK (status IN (
    'DRAFT', 'PARTIALLY_PAID', 'PAID', 'CANCELLED',
    'EN_ATTENTE_DIRECTION', 'CORRECTION_DEMANDEE', 'REFUSEE',
    'VALIDEE_DIRECTION', 'AUTORISEE_AU_PAIEMENT'));

-- ═════════════════════════════════════════════════════════════════════════
-- 4. LA DEMANDE À LA DIRECTION
--
-- C'est cette table qui rend le passage obligatoire : sans demande VALIDEE,
-- la route de paiement refuse. Le contrôle ne dépend donc plus du rôle de
-- celui qui clique, mais de l'état d'un objet que quelqu'un d'autre a dû
-- toucher.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payroll_requests (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id INTEGER NOT NULL REFERENCES attendance_payroll_runs_v2(id) ON DELETE CASCADE,
  period_id      INTEGER REFERENCES attendance_periods(id) ON DELETE SET NULL,

  status         TEXT NOT NULL DEFAULT 'EN_ATTENTE_DIRECTION',
  amount_submitted NUMERIC(14,2) NOT NULL DEFAULT 0,

  submitted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_by_name TEXT NOT NULL DEFAULT '',
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  decided_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_by_name TEXT NOT NULL DEFAULT '',
  decided_at     TIMESTAMPTZ,
  decision_reason TEXT NOT NULL DEFAULT '',

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_requests_status_check') THEN
    ALTER TABLE payroll_requests ADD CONSTRAINT payroll_requests_status_check
      CHECK (status IN ('EN_ATTENTE_DIRECTION', 'VALIDEE', 'REFUSEE', 'CORRECTION_DEMANDEE', 'ANNULEE'));
  END IF;
END $$;

/* Une seule demande en attente par paie : soumettre deux fois ne doit pas
   créer deux files où la Direction devrait décider deux fois. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_requests_une_en_attente
  ON payroll_requests (payroll_run_id) WHERE status = 'EN_ATTENTE_DIRECTION';

CREATE INDEX IF NOT EXISTS idx_payroll_requests_societe
  ON payroll_requests (company_id, status, submitted_at DESC);

-- ═════════════════════════════════════════════════════════════════════════
-- 5. LES MODIFICATIONS DE LA DIRECTION
--
-- « Le directeur peut modifier un montant avec motif » : sans avant/après
-- conservé, on ne saurait plus, un mois après, si un net a été corrigé de
-- 100 000 à 90 000 ou l'inverse.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payroll_item_adjustments (
  id               BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_item_id  INTEGER NOT NULL REFERENCES attendance_payroll_items_v2(id) ON DELETE CASCADE,
  field            TEXT NOT NULL,
  old_value        TEXT NOT NULL DEFAULT '',
  new_value        TEXT NOT NULL DEFAULT '',
  reason           TEXT NOT NULL,
  performed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payroll_item_adjustments_ligne
  ON payroll_item_adjustments (payroll_item_id, created_at DESC);

-- ═════════════════════════════════════════════════════════════════════════
-- 6. LE BON DE PAIEMENT
--
-- Numéroté par société (`nextAccountingNumber`, préfixe BON-SAL) et FIGÉ :
-- le contenu est recopié dans `payload` au moment de l'émission plutôt que
-- relu par jointures. Un bon signé doit dire ce qu'il disait le jour où il a
-- été signé, même si l'employé change de nom ou de salaire ensuite.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payroll_vouchers (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_item_id INTEGER NOT NULL REFERENCES attendance_payroll_items_v2(id) ON DELETE CASCADE,
  voucher_number  TEXT NOT NULL,
  payload         JSONB NOT NULL,
  issued_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_by_name  TEXT NOT NULL DEFAULT '',
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  print_count     INTEGER NOT NULL DEFAULT 0,
  last_printed_at TIMESTAMPTZ
);

DO $$
BEGIN
  /* Unicité PAR SOCIÉTÉ, jamais globale : le compteur qui produit ces
     numéros compte par société (leçon des migrations 077 et 078). */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_vouchers_company_number_key') THEN
    ALTER TABLE payroll_vouchers
      ADD CONSTRAINT payroll_vouchers_company_number_key UNIQUE (company_id, voucher_number);
  END IF;
END $$;

/* Un seul bon par ligne de paie : réimprimer ne réémet pas. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_vouchers_une_par_ligne
  ON payroll_vouchers (payroll_item_id);

-- ═════════════════════════════════════════════════════════════════════════
-- 7. LES DROITS
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO permission_actions (action_key, label, description, sort_order, is_write) VALUES
  ('prepare',  'Préparer',  'Préparer la paie d''une période.',                      182, true),
  ('submit',   'Soumettre', 'Soumettre la paie préparée à la Direction.',            184, true),
  ('pay',      'Payer',     'Payer un salaire autorisé au paiement.',                186, true),
  ('adjust',   'Ajuster',   'Modifier un montant de paie, avec motif obligatoire.',  188, true),
  ('reopen',   'Rouvrir',   'Rouvrir une période close, avec motif.',                190, true)
ON CONFLICT (action_key) DO NOTHING;

INSERT INTO permission_modules (module_key, parent_key, label, description, sort_order, is_active, is_system, actions) VALUES
  ('pointage.periode', 'pointage', 'Périodes de pointage',
   'Ouvrir, contrôler, valider et clôturer les périodes du 25 au 24.', 308, true, false,
   ARRAY['visible','view','create','validate','close','reopen','print','export']),
  ('paie', NULL, 'Paie',
   'Préparer, soumettre, valider et payer les salaires.', 330, true, false,
   ARRAY['visible','view','prepare','submit','validate','pay','adjust','print','export'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      label = EXCLUDED.label, description = EXCLUDED.description, updated_at = now();

/* Le comptable prépare, soumet et paie — jamais il ne valide. La Direction
   valide et ajuste — elle ne paie pas. La séparation vit au catalogue, pas
   seulement dans le code de la route. */
DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'comptable', 'paie', 'visible',  true),
      (soc.id, 'comptable', 'paie', 'view',     true),
      (soc.id, 'comptable', 'paie', 'prepare',  true),
      (soc.id, 'comptable', 'paie', 'submit',   true),
      (soc.id, 'comptable', 'paie', 'pay',      true),
      (soc.id, 'comptable', 'paie', 'print',    true),
      (soc.id, 'comptable', 'paie', 'validate', false),
      (soc.id, 'comptable', 'paie', 'adjust',   false),

      (soc.id, 'direction', 'paie', 'visible',  true),
      (soc.id, 'direction', 'paie', 'view',     true),
      (soc.id, 'direction', 'paie', 'validate', true),
      (soc.id, 'direction', 'paie', 'adjust',   true),
      (soc.id, 'direction', 'paie', 'print',    true),
      (soc.id, 'direction', 'paie', 'prepare',  false),
      (soc.id, 'direction', 'paie', 'submit',   false),
      (soc.id, 'direction', 'paie', 'pay',      false)
    ON CONFLICT (company_id, role, module_key, action) DO NOTHING;
  END LOOP;
END $$;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_periods_sans_chevauchement') THEN
    RAISE EXCEPTION '081 : sans exclusion, deux périodes pourraient se recouvrir et payer deux fois les mêmes journées.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_payroll_requests_une_en_attente') THEN
    RAISE EXCEPTION '081 : sans unicité, une paie pourrait attendre deux décisions de la Direction.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permission_modules WHERE module_key = 'paie') THEN
    RAISE EXCEPTION '081 : sans module paie, la séparation préparer/valider/payer ne serait opposable nulle part.';
  END IF;
  RAISE NOTICE 'Périodes 25→24, calendrier, demande Direction, ajustements et bons : en place.';
END $$;
