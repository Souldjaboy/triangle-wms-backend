-- 084 — ACOMPTES ET DÉPÔTS CLIENTS (sable et ciment)
--
-- Un client verse 40 000 000 avant toute livraison. Aujourd'hui, cet argent
-- n'a nulle part où aller : soit on l'enregistre comme un paiement de facture
-- — mais il n'y a pas encore de facture —, soit on le laisse hors du système
-- et le solde du compte client devient une conversation.
--
-- Un dépôt n'est PAS une vente. Il augmente réellement la trésorerie, mais du
-- côté du passif : c'est une DETTE envers le client, tant qu'aucune facture ne
-- vient l'absorber. Le comptabiliser en chiffre d'affaires gonflerait le
-- résultat d'un mois avec de l'argent qui ne l'a pas encore mérité.
--
-- Trois objets :
--
--   • `client_deposits`       — le versement, et son solde disponible ;
--   • `client_deposit_allocations` — chaque imputation sur une facture, avec
--     son montant ; c'est ce qui permet de dire « ces 2 000 000 de la facture
--     F-12 viennent du dépôt D-3 » ;
--   • `client_deposit_refunds` — remboursement au client, qui refait sortir
--     l'argent une fois et une seule.
--
-- ═════════════════════════════════════════════════════════════════════════
-- POURQUOI UNE ACTIVITÉ PLUTÔT QU'UNE CLÉ ÉTRANGÈRE
--
-- Sable et ciment ont chacun leurs tables de clients et de factures
-- (`sand_customers`/`sand_invoices`, `cement_customers`/`cement_invoices`),
-- avec des identifiants qui se recoupent : le client sable n°3 et le client
-- ciment n°3 sont deux personnes différentes. Un dépôt porte donc le couple
-- (activité, identifiant) plutôt qu'une clé étrangère unique — et l'activité
-- est contrainte, pas laissée libre.
--
-- Le prix de ce choix : PostgreSQL ne peut pas garantir l'intégrité
-- référentielle. Les routes vérifient donc explicitement l'existence du
-- client et de la facture dans la table de LEUR activité, à chaque écriture.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS client_deposits (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  activity    TEXT NOT NULL,
  customer_id INTEGER NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  reference   TEXT NOT NULL,

  amount            NUMERIC(16,2) NOT NULL,
  /* Ce qui n'a encore été imputé sur aucune facture ni remboursé. Recalculé
     à chaque mouvement, dans la même transaction : deux sources de vérité
     divergeraient au premier incident. */
  available_amount  NUMERIC(16,2) NOT NULL,

  business_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method TEXT NOT NULL DEFAULT '',
  external_reference TEXT NOT NULL DEFAULT '',
  justificatif_url   TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',

  bank_id     INTEGER REFERENCES accounting_banks(id) ON DELETE SET NULL,
  caisse_id   INTEGER REFERENCES caisses(id) ON DELETE SET NULL,
  accounting_transaction_id INTEGER,

  status      TEXT NOT NULL DEFAULT 'ACTIF',
  cancelled_at    TIMESTAMPTZ,
  cancelled_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason   TEXT NOT NULL DEFAULT '',

  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_deposits_activity_check') THEN
    ALTER TABLE client_deposits ADD CONSTRAINT client_deposits_activity_check
      CHECK (activity IN ('sable', 'ciment'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_deposits_status_check') THEN
    ALTER TABLE client_deposits ADD CONSTRAINT client_deposits_status_check
      CHECK (status IN ('ACTIF', 'EPUISE', 'ANNULE'));
  END IF;
  /* Le disponible ne dépasse jamais le versé et ne descend jamais sous zéro :
     c'est ce qui interdit la double affectation et le double remboursement,
     quelle que soit la voie. */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_deposits_available_check') THEN
    ALTER TABLE client_deposits ADD CONSTRAINT client_deposits_available_check
      CHECK (available_amount >= 0 AND available_amount <= amount AND amount > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_deposits_company_reference_key') THEN
    ALTER TABLE client_deposits
      ADD CONSTRAINT client_deposits_company_reference_key UNIQUE (company_id, reference);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_client_deposits_client
  ON client_deposits (company_id, activity, customer_id, business_date);

/* Les dépôts encore utilisables d'un client : la requête de l'affectation
   FIFO, faite à chaque facture. */
CREATE INDEX IF NOT EXISTS idx_client_deposits_disponibles
  ON client_deposits (company_id, activity, customer_id, business_date, id)
  WHERE available_amount > 0 AND status = 'ACTIF';

-- ═════════════════════════════════════════════════════════════════════════
-- LES IMPUTATIONS
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS client_deposit_allocations (
  id          BIGSERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  deposit_id  INTEGER NOT NULL REFERENCES client_deposits(id) ON DELETE RESTRICT,
  activity    TEXT NOT NULL,
  invoice_id  INTEGER NOT NULL,
  invoice_number TEXT NOT NULL DEFAULT '',

  amount      NUMERIC(16,2) NOT NULL,
  available_before NUMERIC(16,2) NOT NULL,
  available_after  NUMERIC(16,2) NOT NULL,

  /* Une imputation annulée n'est pas effacée : elle est contrepassée, et la
     ligne d'origine reste lisible dans l'état du dépôt. */
  reverses_allocation_id BIGINT REFERENCES client_deposit_allocations(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL DEFAULT '',

  performed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_deposit_allocations_activity_check') THEN
    ALTER TABLE client_deposit_allocations ADD CONSTRAINT client_deposit_allocations_activity_check
      CHECK (activity IN ('sable', 'ciment'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_deposit_allocations_amount_check') THEN
    ALTER TABLE client_deposit_allocations ADD CONSTRAINT client_deposit_allocations_amount_check
      CHECK (amount <> 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_deposit_allocations_depot
  ON client_deposit_allocations (deposit_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deposit_allocations_facture
  ON client_deposit_allocations (company_id, activity, invoice_id);

-- ═════════════════════════════════════════════════════════════════════════
-- LES REMBOURSEMENTS
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS client_deposit_refunds (
  id          BIGSERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  deposit_id  INTEGER NOT NULL REFERENCES client_deposits(id) ON DELETE RESTRICT,
  amount      NUMERIC(16,2) NOT NULL,
  available_before NUMERIC(16,2) NOT NULL,
  available_after  NUMERIC(16,2) NOT NULL,
  reason      TEXT NOT NULL,
  bank_id     INTEGER REFERENCES accounting_banks(id) ON DELETE SET NULL,
  caisse_id   INTEGER REFERENCES caisses(id) ON DELETE SET NULL,
  accounting_transaction_id INTEGER,
  reference   TEXT NOT NULL DEFAULT '',
  performed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deposit_refunds_depot
  ON client_deposit_refunds (deposit_id, created_at);

-- ═════════════════════════════════════════════════════════════════════════
-- LES DROITS
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO permission_modules (module_key, parent_key, label, description, sort_order, is_active, is_system, actions) VALUES
  ('acompte_client', 'comptabilite', 'Acomptes clients',
   'Enregistrer les dépôts clients, les imputer aux factures et suivre leur solde.',
   340, true, false,
   ARRAY['visible','view','create','update','cancel','validate','print','export'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      label = EXCLUDED.label, parent_key = EXCLUDED.parent_key, updated_at = now();

/* DO UPDATE sous garde `updated_by IS NULL` — voir la note détaillée en 080. */
DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'comptable', 'acompte_client', 'visible', true),
      (soc.id, 'comptable', 'acompte_client', 'view',    true),
      (soc.id, 'comptable', 'acompte_client', 'create',  true),
      (soc.id, 'comptable', 'acompte_client', 'update',  true),
      (soc.id, 'comptable', 'acompte_client', 'print',   true),
      (soc.id, 'comptable', 'acompte_client', 'cancel',  false),
      (soc.id, 'direction', 'acompte_client', 'visible', true),
      (soc.id, 'direction', 'acompte_client', 'view',    true),
      (soc.id, 'direction', 'acompte_client', 'cancel',  true),
      (soc.id, 'direction', 'acompte_client', 'print',   true)
    ON CONFLICT (company_id, role, module_key, action)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
     WHERE role_permissions.updated_by IS NULL;
  END LOOP;
END $$;

COMMIT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_deposits_available_check') THEN
    RAISE EXCEPTION '084 : sans la borne sur le disponible, un dépôt pourrait être affecté deux fois.';
  END IF;
  RAISE NOTICE 'Acomptes clients : dépôts, imputations et remboursements en place.';
END $$;
