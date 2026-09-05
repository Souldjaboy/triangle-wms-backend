-- 083 — AVANCES SUR SALAIRE
--
-- Une avance n'est pas une dépense : c'est de l'argent qui sort de la caisse
-- et devient une CRÉANCE sur le salarié. La distinction n'est pas comptable
-- pour le plaisir — elle décide de ce qu'on retient sur les paies suivantes,
-- et de ce qui reste dû si le salarié part.
--
-- Rien de tel n'existait : aucune table ne portait le mot « avance ».
--
-- Trois objets :
--
--   • `salary_advances`  — la demande, son autorisation, son versement et
--     son solde. Le solde est la seule vérité : tout part de lui, jamais du
--     montant initial.
--   • `salary_advance_installments` — l'échéancier. Une avance de 25 000
--     remboursée par mensualités de 5 000 en produit cinq. Retenir 5 000 sur
--     cinq paies plutôt que 25 000 sur une seule est une décision qui se
--     prend une fois et s'applique toute seule ensuite.
--   • `salary_advance_repayments` — chaque remboursement, qu'il vienne d'une
--     retenue sur paie ou d'un versement direct au comptoir.
--
-- La règle centrale, garantie par la base et non par la vigilance :
-- `balance = amount_paid - total remboursé`, jamais négatif. Un
-- sur-remboursement silencieux est refusé.

BEGIN;

CREATE TABLE IF NOT EXISTS salary_advances (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES attendance_employees(id) ON DELETE RESTRICT,
  reference   TEXT NOT NULL,

  amount_requested  NUMERIC(14,2) NOT NULL,
  amount_authorized NUMERIC(14,2),
  amount_paid       NUMERIC(14,2) NOT NULL DEFAULT 0,
  /* Ce qui reste dû. Recalculé à chaque remboursement, dans la même
     transaction : deux sources de vérité divergeraient. */
  balance           NUMERIC(14,2) NOT NULL DEFAULT 0,

  /* 0 = retenue en une seule fois sur la prochaine paie. */
  installment_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  first_period_code  TEXT NOT NULL DEFAULT '',

  reason      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'BROUILLON',

  requested_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at  TIMESTAMPTZ,
  validated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  validated_at  TIMESTAMPTZ,
  refused_reason TEXT NOT NULL DEFAULT '',
  paid_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  paid_at       TIMESTAMPTZ,
  bank_id       INTEGER REFERENCES accounting_banks(id) ON DELETE SET NULL,
  caisse_id     INTEGER REFERENCES caisses(id) ON DELETE SET NULL,
  accounting_transaction_id INTEGER,
  justificatif_url TEXT NOT NULL DEFAULT '',

  cancelled_at  TIMESTAMPTZ,
  cancelled_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason TEXT NOT NULL DEFAULT '',

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salary_advances_status_check') THEN
    ALTER TABLE salary_advances ADD CONSTRAINT salary_advances_status_check
      CHECK (status IN ('BROUILLON','DEMANDEE','VALIDEE','REFUSEE','VERSEE',
                        'EN_REMBOURSEMENT','REMBOURSEE','ANNULEE'));
  END IF;

  /* Le solde ne descend jamais sous zéro : c'est ce qui interdit le
     sur-remboursement, quelle qu'en soit la voie. */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salary_advances_balance_check') THEN
    ALTER TABLE salary_advances ADD CONSTRAINT salary_advances_balance_check
      CHECK (balance >= 0 AND balance <= GREATEST(amount_paid, 0));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salary_advances_montants_check') THEN
    ALTER TABLE salary_advances ADD CONSTRAINT salary_advances_montants_check
      CHECK (amount_requested > 0
             AND (amount_authorized IS NULL OR amount_authorized > 0)
             AND amount_paid >= 0
             AND installment_amount >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salary_advances_company_reference_key') THEN
    ALTER TABLE salary_advances
      ADD CONSTRAINT salary_advances_company_reference_key UNIQUE (company_id, reference);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_salary_advances_employe
  ON salary_advances (company_id, employee_id, status);

/* Retrouver les avances encore dues d'un employé : la requête que fait la
   préparation de la paie, à chaque ligne. */
CREATE INDEX IF NOT EXISTS idx_salary_advances_dues
  ON salary_advances (company_id, employee_id) WHERE balance > 0;

-- ═════════════════════════════════════════════════════════════════════════
-- L'ÉCHÉANCIER
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS salary_advance_installments (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  advance_id  INTEGER NOT NULL REFERENCES salary_advances(id) ON DELETE CASCADE,
  rank        SMALLINT NOT NULL,
  period_code TEXT NOT NULL,
  amount_due  NUMERIC(14,2) NOT NULL,
  amount_taken NUMERIC(14,2) NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'A_VENIR',
  suspended_reason TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salary_advance_installments_status_check') THEN
    ALTER TABLE salary_advance_installments
      ADD CONSTRAINT salary_advance_installments_status_check
      CHECK (status IN ('A_VENIR','RETENUE','SUSPENDUE','ANNULEE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salary_advance_installments_rang_key') THEN
    ALTER TABLE salary_advance_installments
      ADD CONSTRAINT salary_advance_installments_rang_key UNIQUE (advance_id, rank);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_advance_installments_periode
  ON salary_advance_installments (company_id, period_code, status);

-- ═════════════════════════════════════════════════════════════════════════
-- LES REMBOURSEMENTS
--
-- Deux voies, un seul journal : la retenue automatique sur une paie et le
-- versement direct au comptoir. Les séparer en deux tables obligerait à
-- additionner deux sources pour connaître un solde.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS salary_advance_repayments (
  id          BIGSERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  advance_id  INTEGER NOT NULL REFERENCES salary_advances(id) ON DELETE CASCADE,
  installment_id INTEGER REFERENCES salary_advance_installments(id) ON DELETE SET NULL,
  payroll_item_id INTEGER REFERENCES attendance_payroll_items_v2(id) ON DELETE SET NULL,

  amount      NUMERIC(14,2) NOT NULL,
  origin      TEXT NOT NULL,
  balance_before NUMERIC(14,2) NOT NULL,
  balance_after  NUMERIC(14,2) NOT NULL,

  bank_id     INTEGER REFERENCES accounting_banks(id) ON DELETE SET NULL,
  caisse_id   INTEGER REFERENCES caisses(id) ON DELETE SET NULL,
  accounting_transaction_id INTEGER,
  reference   TEXT NOT NULL DEFAULT '',

  /* Une contrepassation renvoie à la ligne qu'elle défait : un remboursement
     annulé n'est pas effacé, il est contrepassé. */
  reverses_repayment_id BIGINT REFERENCES salary_advance_repayments(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL DEFAULT '',

  performed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salary_advance_repayments_origin_check') THEN
    ALTER TABLE salary_advance_repayments
      ADD CONSTRAINT salary_advance_repayments_origin_check
      CHECK (origin IN ('RETENUE_PAIE','VERSEMENT_DIRECT','CONTREPASSATION'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salary_advance_repayments_amount_check') THEN
    ALTER TABLE salary_advance_repayments
      ADD CONSTRAINT salary_advance_repayments_amount_check CHECK (amount <> 0);
  END IF;
END $$;

/* Une retenue par ligne de paie et par avance : c'est ce qui rend la
   préparation de la paie rejouable sans retenir deux fois. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_advance_repayments_une_par_paie
  ON salary_advance_repayments (advance_id, payroll_item_id)
  WHERE payroll_item_id IS NOT NULL AND origin = 'RETENUE_PAIE';

CREATE INDEX IF NOT EXISTS idx_advance_repayments_avance
  ON salary_advance_repayments (advance_id, created_at DESC);

-- ═════════════════════════════════════════════════════════════════════════
-- LA RETENUE SUR LA LIGNE DE PAIE
--
-- Le net doit montrer ce qui a été retenu, sinon le salarié voit un montant
-- plus faible sans explication.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE attendance_payroll_items_v2
  ADD COLUMN IF NOT EXISTS advance_deduction NUMERIC(14,2) NOT NULL DEFAULT 0;

-- ═════════════════════════════════════════════════════════════════════════
-- LES DROITS
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO permission_modules (module_key, parent_key, label, description, sort_order, is_active, is_system, actions) VALUES
  ('paie.avance', 'paie', 'Avances sur salaire',
   'Demander, valider, verser et suivre le remboursement des avances.', 335, true, false,
   ARRAY['visible','view','create','validate','pay','update','cancel','print','export'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      label = EXCLUDED.label, parent_key = EXCLUDED.parent_key, updated_at = now();

/* DO UPDATE sous garde `updated_by IS NULL` : la migration 063 remplit la
   matrice complète et passerait devant un DO NOTHING lors d'un rejeu complet
   (voir la note détaillée en 080/081). Une migration corrige un défaut
   généré, jamais une décision humaine. */
DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'comptable', 'paie.avance', 'visible',  true),
      (soc.id, 'comptable', 'paie.avance', 'view',     true),
      (soc.id, 'comptable', 'paie.avance', 'create',   true),
      (soc.id, 'comptable', 'paie.avance', 'pay',      true),
      (soc.id, 'comptable', 'paie.avance', 'print',    true),
      (soc.id, 'comptable', 'paie.avance', 'validate', false),

      (soc.id, 'direction', 'paie.avance', 'visible',  true),
      (soc.id, 'direction', 'paie.avance', 'view',     true),
      (soc.id, 'direction', 'paie.avance', 'validate', true),
      (soc.id, 'direction', 'paie.avance', 'cancel',   true),
      (soc.id, 'direction', 'paie.avance', 'pay',      false)
    ON CONFLICT (company_id, role, module_key, action)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
     WHERE role_permissions.updated_by IS NULL;
  END LOOP;
END $$;

COMMIT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salary_advances_balance_check') THEN
    RAISE EXCEPTION '083 : sans la borne sur le solde, un sur-remboursement passerait en silence.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_advance_repayments_une_par_paie') THEN
    RAISE EXCEPTION '083 : sans unicité, préparer deux fois la paie retiendrait deux fois la même échéance.';
  END IF;
  RAISE NOTICE 'Avances sur salaire : demande, échéancier, remboursements et retenue de paie en place.';
END $$;
