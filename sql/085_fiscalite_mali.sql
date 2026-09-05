-- 085 — FISCALITÉ ET COTISATIONS : UN MOTEUR, PAS DES TAUX EN DUR
--
-- ═════════════════════════════════════════════════════════════════════════
-- CE QUE CETTE MIGRATION N'ACTIVE PAS, ET POURQUOI
--
-- Aucune règle n'est posée avec un taux actif. Pas une.
--
-- Les valeurs qui circulent — CFE 3,5 %, CGS 0,5 %, TFP 2 %, TEJ 2 %, taxe
-- logement 1 %, impôt synthétique 3 % — sont des CANDIDATS, pas des vérités.
-- Elles dépendent du régime réel de chaque société, de son activité, de sa
-- localisation et de la loi de finances en vigueur. La patente, en
-- particulier, n'a jamais de montant unique universel.
--
-- La recherche menée le 2026-09-04 n'a permis de corroborer qu'un seul de ces
-- chiffres, et encore indirectement (CFE à 3,5 % sur les rémunérations
-- brutes), à partir de :
--   • Direction Générale des Impôts du Mali — https://www.dgi.gouv.ml/
--   • Code général des impôts — https://www.dgi.gouv.ml/CGI/
--   • Ministère de l'Économie et des Finances — https://finances.ml/node/264
--   • Loi de finances (budget) — https://budget.gouv.ml/
-- Aucune de ces sources n'a pu être lue article par article depuis cet
-- environnement. Inscrire ces taux comme actifs reviendrait à faire calculer
-- à l'application des montants que personne n'a vérifiés — et qu'un comptable
-- déclarerait ensuite à l'administration.
--
-- Le catalogue est donc chargé avec les TYPES d'obligation (code, nom,
-- explication, organisme, base, périodicité) et le statut `A_VERIFIER`, sans
-- taux. Un taux ne devient calculable qu'une fois qu'une personne a saisi sa
-- source, sa référence de texte et sa date de vérification, puis l'a
-- explicitement validé. C'est le sens du champ `verification_status`.
-- ═════════════════════════════════════════════════════════════════════════
--
-- Le moteur, lui, est complet : règles versionnées par période d'effet,
-- profil fiscal par société, obligations, déclarations, paiements partiels,
-- quittances, rappels et audit.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. LE CATALOGUE DES TYPES
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tax_types (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  /* En français simple : ce que l'utilisateur lit avant de cocher. */
  explanation TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL,
  authority   TEXT NOT NULL DEFAULT '',
  base_label  TEXT NOT NULL DEFAULT '',
  frequency   TEXT NOT NULL DEFAULT 'MENSUELLE',
  /* Jour d'échéance dans la période (le 15 du mois suivant, par exemple). */
  due_day     SMALLINT,
  country     TEXT NOT NULL DEFAULT 'ML',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_types_category_check') THEN
    ALTER TABLE tax_types ADD CONSTRAINT tax_types_category_check
      CHECK (category IN ('impot','cotisation','retenue','declaration','taxe_locale'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_types_frequency_check') THEN
    ALTER TABLE tax_types ADD CONSTRAINT tax_types_frequency_check
      CHECK (frequency IN ('MENSUELLE','TRIMESTRIELLE','ANNUELLE','PONCTUELLE'));
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. LES RÈGLES, VERSIONNÉES
--
-- Une règle n'existe pas dans l'absolu : elle vaut pour une période, avec une
-- source. Deux versions d'un même impôt coexistent donc, et c'est la date de
-- l'opération qui décide laquelle s'applique — pas la dernière saisie.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tax_rules (
  id          SERIAL PRIMARY KEY,
  tax_type_id INTEGER NOT NULL REFERENCES tax_types(id) ON DELETE CASCADE,
  company_id  INTEGER REFERENCES companies(id) ON DELETE CASCADE,

  rate_percent  NUMERIC(8,4),
  fixed_amount  NUMERIC(16,2),
  min_amount    NUMERIC(16,2),
  max_amount    NUMERIC(16,2),
  /* Barème progressif éventuel : [{ jusqu_a, taux }]. */
  brackets      JSONB,

  effective_from DATE NOT NULL,
  effective_to   DATE,

  /* Ce qui rend la règle opposable — ou pas. */
  source_reference TEXT NOT NULL DEFAULT '',
  source_url       TEXT NOT NULL DEFAULT '',
  verified_at      DATE,
  verified_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verification_status TEXT NOT NULL DEFAULT 'A_VERIFIER',
  notes            TEXT NOT NULL DEFAULT '',

  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_rules_verification_check') THEN
    ALTER TABLE tax_rules ADD CONSTRAINT tax_rules_verification_check
      CHECK (verification_status IN ('A_VERIFIER','VERIFIEE','OBSOLETE','CONTESTEE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_rules_periode_check') THEN
    ALTER TABLE tax_rules ADD CONSTRAINT tax_rules_periode_check
      CHECK (effective_to IS NULL OR effective_to > effective_from);
  END IF;
  /* Une règle VÉRIFIÉE doit porter sa source et sa date de vérification.
     C'est ce qui empêche de « valider » un taux sans dire d'où il vient. */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_rules_source_obligatoire_check') THEN
    ALTER TABLE tax_rules ADD CONSTRAINT tax_rules_source_obligatoire_check
      CHECK (verification_status <> 'VERIFIEE'
             OR (length(trim(source_reference)) > 0 AND verified_at IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tax_rules_applicable
  ON tax_rules (tax_type_id, company_id, effective_from DESC);

-- ═════════════════════════════════════════════════════════════════════════
-- 3. LE PROFIL FISCAL D'UNE SOCIÉTÉ
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS company_tax_profiles (
  company_id   INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  regime       TEXT NOT NULL DEFAULT 'NON_DEFINI',
  activity     TEXT NOT NULL DEFAULT '',
  vat_liable   BOOLEAN NOT NULL DEFAULT false,
  location     TEXT NOT NULL DEFAULT '',
  tax_id       TEXT NOT NULL DEFAULT '',
  configured_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  configured_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* Les obligations réellement actives d'une société. Une ligne n'apparaît que
   si quelqu'un l'a cochée : le code ne suppose jamais qu'une société est
   assujettie. */
CREATE TABLE IF NOT EXISTS company_tax_obligations (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tax_type_id INTEGER NOT NULL REFERENCES tax_types(id) ON DELETE CASCADE,
  active      BOOLEAN NOT NULL DEFAULT false,
  activated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ,
  exemption_reason TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_tax_obligations_key') THEN
    ALTER TABLE company_tax_obligations
      ADD CONSTRAINT company_tax_obligations_key UNIQUE (company_id, tax_type_id);
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. LES DÉCLARATIONS
--
-- Une obligation déclarée mais non payée crée une DETTE, sans toucher la
-- trésorerie. Seul le paiement réel débite un compte — et exactement une fois.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tax_declarations (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tax_type_id INTEGER NOT NULL REFERENCES tax_types(id) ON DELETE RESTRICT,
  tax_rule_id INTEGER REFERENCES tax_rules(id) ON DELETE SET NULL,
  reference   TEXT NOT NULL,

  period_code TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  due_date     DATE,

  base_amount     NUMERIC(16,2) NOT NULL DEFAULT 0,
  declared_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
  paid_amount     NUMERIC(16,2) NOT NULL DEFAULT 0,
  remaining_amount NUMERIC(16,2) NOT NULL DEFAULT 0,

  status      TEXT NOT NULL DEFAULT 'ESTIMEE',
  /* Une pénalité ne s'invente pas : sans règle validée, ce champ reste nul et
     l'écran affiche « taux de pénalité non configuré ». */
  penalty_amount NUMERIC(16,2),
  penalty_rule_id INTEGER REFERENCES tax_rules(id) ON DELETE SET NULL,

  exemption_reason TEXT NOT NULL DEFAULT '',
  dispute_reason   TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',

  declared_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  declared_at TIMESTAMPTZ,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_declarations_status_check') THEN
    ALTER TABLE tax_declarations ADD CONSTRAINT tax_declarations_status_check
      CHECK (status IN ('ESTIMEE','DECLAREE','PARTIELLEMENT_PAYEE','PAYEE',
                        'EN_RETARD','EXONEREE','CONTESTEE','ANNULEE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_declarations_montants_check') THEN
    ALTER TABLE tax_declarations ADD CONSTRAINT tax_declarations_montants_check
      CHECK (paid_amount >= 0 AND paid_amount <= declared_amount + COALESCE(penalty_amount, 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_declarations_company_reference_key') THEN
    ALTER TABLE tax_declarations
      ADD CONSTRAINT tax_declarations_company_reference_key UNIQUE (company_id, reference);
  END IF;
  /* Une seule déclaration par impôt et par période : déclarer deux fois le
     même mois créerait deux dettes pour une seule obligation. */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_declarations_periode_key') THEN
    ALTER TABLE tax_declarations
      ADD CONSTRAINT tax_declarations_periode_key UNIQUE (company_id, tax_type_id, period_code);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tax_declarations_echeance
  ON tax_declarations (company_id, due_date) WHERE status NOT IN ('PAYEE','EXONEREE','ANNULEE');

CREATE TABLE IF NOT EXISTS tax_payments (
  id          BIGSERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  declaration_id INTEGER NOT NULL REFERENCES tax_declarations(id) ON DELETE RESTRICT,
  amount      NUMERIC(16,2) NOT NULL,
  paid_before NUMERIC(16,2) NOT NULL,
  paid_after  NUMERIC(16,2) NOT NULL,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  bank_id     INTEGER REFERENCES accounting_banks(id) ON DELETE SET NULL,
  caisse_id   INTEGER REFERENCES caisses(id) ON DELETE SET NULL,
  accounting_transaction_id INTEGER,
  receipt_number TEXT NOT NULL DEFAULT '',
  receipt_url    TEXT NOT NULL DEFAULT '',
  reference   TEXT NOT NULL DEFAULT '',
  performed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tax_payments_declaration
  ON tax_payments (declaration_id, created_at);

-- ═════════════════════════════════════════════════════════════════════════
-- 5. LE CATALOGUE — DES TYPES, JAMAIS DE TAUX
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO tax_types (code, name, explanation, category, authority, base_label, frequency, due_day) VALUES
  ('TVA',   'Taxe sur la valeur ajoutée',
   'Taxe collectée sur les ventes et reversée à l''État, déduction faite de celle payée sur les achats.',
   'impot', 'DGI Mali', 'Chiffre d''affaires taxable', 'MENSUELLE', 15),
  ('IS',    'Impôt sur les sociétés',
   'Impôt sur le bénéfice de la société.', 'impot', 'DGI Mali', 'Bénéfice imposable', 'ANNUELLE', NULL),
  ('IBIC',  'Impôt sur les bénéfices industriels et commerciaux',
   'Impôt sur le bénéfice, pour les régimes qui en relèvent.', 'impot', 'DGI Mali', 'Bénéfice imposable', 'ANNUELLE', NULL),
  ('IS_SYNTH', 'Impôt synthétique',
   'Impôt forfaitaire des petites entreprises, en remplacement de plusieurs autres.',
   'impot', 'DGI Mali', 'Chiffre d''affaires', 'ANNUELLE', NULL),
  ('ITS',   'Impôt sur les traitements et salaires',
   'Impôt retenu sur le salaire de chaque employé et reversé par l''employeur.',
   'retenue', 'DGI Mali', 'Salaires bruts versés', 'MENSUELLE', 15),
  ('CFE',   'Contribution forfaitaire à la charge des employeurs',
   'Contribution due par l''employeur, calculée sur les rémunérations versées.',
   'cotisation', 'DGI Mali', 'Rémunérations brutes', 'MENSUELLE', 15),
  ('CGS',   'Contribution générale de solidarité',
   'Contribution de solidarité.', 'cotisation', 'DGI Mali', 'À déterminer', 'MENSUELLE', 15),
  ('TFP',   'Taxe de formation professionnelle',
   'Taxe affectée à la formation professionnelle.', 'cotisation', 'DGI Mali', 'Rémunérations brutes', 'MENSUELLE', 15),
  ('TEJ',   'Taxe emploi jeune',
   'Taxe affectée à l''emploi des jeunes.', 'cotisation', 'DGI Mali', 'Rémunérations brutes', 'MENSUELLE', 15),
  ('TL',    'Taxe logement',
   'Taxe liée au logement.', 'taxe_locale', 'DGI Mali', 'À déterminer', 'MENSUELLE', 15),
  ('PATENTE', 'Patente et licences',
   'Droit d''exercer une activité. Le montant dépend de l''activité, de la localisation et du chiffre d''affaires — il n''existe aucun montant universel.',
   'taxe_locale', 'Collectivité / DGI Mali', 'Selon activité et localisation', 'ANNUELLE', NULL),
  ('INPS',  'Cotisations INPS',
   'Cotisations sociales versées à l''Institut national de prévoyance sociale.',
   'cotisation', 'INPS Mali', 'Salaires plafonnés', 'MENSUELLE', 15),
  ('AMO',   'Assurance maladie obligatoire',
   'Cotisation d''assurance maladie.', 'cotisation', 'INPS / CANAM Mali', 'Salaires plafonnés', 'MENSUELLE', 15),
  ('RAS',   'Retenues à la source',
   'Montants retenus sur des paiements à des tiers et reversés à l''État.',
   'retenue', 'DGI Mali', 'Paiements concernés', 'MENSUELLE', 15),
  ('DE',    'Droits d''enregistrement',
   'Droits dus lors de l''enregistrement d''actes.', 'impot', 'DGI Mali', 'Valeur de l''acte', 'PONCTUELLE', NULL)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name, explanation = EXCLUDED.explanation,
      category = EXCLUDED.category, authority = EXCLUDED.authority,
      base_label = EXCLUDED.base_label, frequency = EXCLUDED.frequency,
      due_day = EXCLUDED.due_day;

-- ═════════════════════════════════════════════════════════════════════════
-- 6. LES DROITS
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO permission_modules (module_key, parent_key, label, description, sort_order, is_active, is_system, actions) VALUES
  ('fiscalite', 'comptabilite', 'Fiscalité et cotisations',
   'Configurer les obligations, déclarer, payer et suivre les échéances fiscales.',
   345, true, false,
   ARRAY['visible','view','create','update','configure','validate','pay','print','export'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      label = EXCLUDED.label, parent_key = EXCLUDED.parent_key, updated_at = now();

DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'comptable', 'fiscalite', 'visible',   true),
      (soc.id, 'comptable', 'fiscalite', 'view',      true),
      (soc.id, 'comptable', 'fiscalite', 'create',    true),
      (soc.id, 'comptable', 'fiscalite', 'update',    true),
      (soc.id, 'comptable', 'fiscalite', 'pay',       true),
      (soc.id, 'comptable', 'fiscalite', 'print',     true),
      /* Valider une règle fiscale, c'est engager les déclarations à venir :
         cela relève de la configuration, pas de la saisie quotidienne. */
      (soc.id, 'comptable', 'fiscalite', 'configure', false),
      (soc.id, 'direction', 'fiscalite', 'visible',   true),
      (soc.id, 'direction', 'fiscalite', 'view',      true),
      (soc.id, 'direction', 'fiscalite', 'configure', true),
      (soc.id, 'direction', 'fiscalite', 'validate',  true)
    ON CONFLICT (company_id, role, module_key, action)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
     WHERE role_permissions.updated_by IS NULL;
  END LOOP;
END $$;

COMMIT;

DO $$
DECLARE actives INTEGER;
BEGIN
  SELECT count(*) INTO actives FROM tax_rules WHERE verification_status = 'VERIFIEE';
  IF actives > 0 THEN
    RAISE WARNING 'Fiscalité : % règle(s) déjà marquée(s) VÉRIFIÉE — elles ne viennent pas de cette migration.', actives;
  END IF;
  RAISE NOTICE 'Fiscalité : % types au catalogue, AUCUNE règle active. Chaque taux doit être vérifié et validé par une personne avant tout calcul.',
    (SELECT count(*) FROM tax_types);
END $$;
