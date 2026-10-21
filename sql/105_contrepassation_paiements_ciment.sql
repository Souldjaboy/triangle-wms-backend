-- ═════════════════════════════════════════════════════════════════════════
-- 105 — CONTREPASSER UN ENCAISSEMENT DE FACTURE CIMENT
--
-- Le module Sable sait défaire un encaissement depuis la migration 075 : le
-- paiement d'origine reste lisible et inchangé, une ligne de contrepassation
-- s'y adosse, l'argent ressort de la destination qui l'avait reçu et la
-- facture retrouve son solde dû.
--
-- Le Ciment n'avait pas cette table. Le moteur comptable, lui, la prévoyait
-- déjà : routes/sales-payment-accounting.js écrit depuis toujours un
-- `cement_payment_reversal` quand on lui passe module = "cement". Il ne
-- manquait que la table et la route — autrement dit, un encaissement ciment
-- encaissé par erreur ne pouvait pas être défait.
--
-- LE REMBOURSEMENT N'EST PAS L'ANNULATION
--
-- `refund_pending` dit que l'écriture est défaite mais que l'argent, lui,
-- n'est pas encore revenu au client. Confondre les deux conduit à clore un
-- dossier alors qu'une personne attend toujours son virement.
--
-- Idempotente. Aucun paiement existant n'est modifié.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS cement_payment_reversals (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL,
  invoice_id  INTEGER NOT NULL,
  original_payment_id INTEGER NOT NULL,
  amount      NUMERIC(18,2) NOT NULL,
  reason      TEXT NOT NULL,
  reversal_accounting_transaction_id INTEGER,
  /* L'écriture est défaite ; l'argent n'est pas revenu au client tant que
     `refunded_at` est vide. C'est tout l'objet de ces deux colonnes. */
  refund_pending BOOLEAN NOT NULL DEFAULT TRUE,
  refunded_at    TIMESTAMPTZ,
  refunded_by    INTEGER,
  refund_reference TEXT,
  created_by      INTEGER,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cement_payment_reversals_montant CHECK (amount > 0),
  CONSTRAINT cement_payment_reversals_motif CHECK (BTRIM(reason) <> ''),
  /* Un remboursement constaté porte sa date : sans elle, « remboursé » ne
     voudrait rien dire. */
  CONSTRAINT cement_payment_reversals_remboursement CHECK (
    refund_pending = TRUE OR refunded_at IS NOT NULL
  )
);

/* LA GARANTIE CENTRALE : un paiement ne se contrepasse qu'une fois, même si
   deux clics partent ensemble. C'est la base qui le tient, pas la prudence
   de l'appelant. */
CREATE UNIQUE INDEX IF NOT EXISTS cement_payment_reversals_unique_idx
  ON cement_payment_reversals (company_id, original_payment_id);
CREATE INDEX IF NOT EXISTS cement_payment_reversals_facture_idx
  ON cement_payment_reversals (company_id, invoice_id);
CREATE INDEX IF NOT EXISTS cement_payment_reversals_attente_idx
  ON cement_payment_reversals (company_id, refund_pending) WHERE refund_pending = TRUE;

/* Le même index côté Sable : la migration 075 l'annonce dans son commentaire,
   on s'assure ici qu'il existe réellement — une contrainte supposée ne
   protège rien. */
CREATE UNIQUE INDEX IF NOT EXISTS sand_payment_reversals_unique_idx
  ON sand_payment_reversals (company_id, original_payment_id);

-- ─────────────────────────────────────────────────────────────────────────
-- LE DROIT DE CONTREPASSER
--
-- Distinct de celui d'encaisser : reprendre de l'argent déjà encaissé n'est
-- pas le geste quotidien d'un caissier.
-- ─────────────────────────────────────────────────────────────────────────
/* Le catalogue des actions est fermé : une action non déclarée ici est
   rejetée par la clé étrangère de role_permissions. `paiement_contrepasser`
   existe depuis le Sable ; constater un remboursement est nouveau. */
INSERT INTO permission_actions (action_key, label, description, sort_order, is_write) VALUES
  ('remboursement_constater', 'Constater un remboursement',
   'Enregistrer que l''argent est réellement revenu au client après une contrepassation.',
   165, TRUE)
ON CONFLICT (action_key) DO UPDATE
  SET label = EXCLUDED.label, description = EXCLUDED.description;

INSERT INTO permission_modules
  (module_key, parent_key, label, description, sort_order, is_active, is_system, actions) VALUES
  ('ciment', NULL, 'Ciment',
   'Ventes, factures et encaissements ciment.', 200, TRUE, FALSE,
   ARRAY['visible','view','create','update','delete','validate','print','export',
         'paiement_contrepasser','remboursement_constater'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      updated_at = now();

/* ATTENTION À LA CLÉ.
   Le routeur interroge requirePermission("cement", …), mais services/permissions.js
   normalise « cement » en « ciment » (table ALIAS). Un droit accordé sous la clé
   anglaise ne répond donc à AUCUNE question : le moteur retombe sur le rôle,
   personne n'a rien, et le module reste invisible malgré la permission.
   Tous les droits se posent sous « ciment ». */
DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'direction', 'ciment', 'paiement_contrepasser',    true),
      (soc.id, 'direction', 'ciment', 'remboursement_constater',  true),
      (soc.id, 'comptable', 'ciment', 'paiement_contrepasser',    true),
      (soc.id, 'comptable', 'ciment', 'remboursement_constater',  true)
    ON CONFLICT (company_id, role, module_key, action)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
     WHERE role_permissions.updated_by IS NULL;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- LES REMBOURSEMENTS ENCORE DUS
--
-- Sable et ciment ensemble : la question « à qui devons-nous encore de
-- l'argent ? » ne doit pas dépendre du module où la vente a été saisie.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_remboursements_attendus AS
SELECT 'SABLE'::text AS module, r.id, r.company_id, r.invoice_id, r.original_payment_id,
       r.amount, r.reason, r.created_at, r.created_by_name,
       i.invoice_number, i.customer_id
  FROM sand_payment_reversals r
  JOIN sand_invoices i ON i.id = r.invoice_id AND i.company_id = r.company_id
 WHERE r.refund_pending = TRUE
UNION ALL
SELECT 'CIMENT'::text, r.id, r.company_id, r.invoice_id, r.original_payment_id,
       r.amount, r.reason, r.created_at, r.created_by_name,
       i.invoice_number, i.customer_id
  FROM cement_payment_reversals r
  JOIN cement_invoices i ON i.id = r.invoice_id AND i.company_id = r.company_id
 WHERE r.refund_pending = TRUE;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE attendus INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_name = 'cement_payment_reversals') THEN
    RAISE EXCEPTION '105 : sans cette table, un encaissement ciment saisi par erreur reste définitif.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE indexname = 'cement_payment_reversals_unique_idx') THEN
    RAISE EXCEPTION '105 : sans index unique, un double clic contrepasserait deux fois.';
  END IF;

  /* Un module « cement » dans le catalogue serait un doublon invisible au
     moteur : il apparaîtrait dans l'écran des droits et n'y déciderait rien. */
  IF EXISTS (SELECT 1 FROM permission_modules WHERE module_key = 'cement') THEN
    RAISE WARNING '105 : un module « cement » existe dans le catalogue. Le moteur normalise cette clé en « ciment » : les droits posés dessus ne décident rien.';
  END IF;

  SELECT count(*) INTO attendus FROM v_remboursements_attendus;
  RAISE NOTICE '105 : % remboursement(s) encore dû(s) aux clients, sable et ciment confondus.', attendus;
  RAISE NOTICE 'Contrepassation ciment en place. Aucun paiement existant modifié.';
END $$;
