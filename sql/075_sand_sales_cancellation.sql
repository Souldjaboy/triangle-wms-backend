-- 075 — ANNULER, CORRIGER ET SUPPRIMER UNE VENTE DE SABLE, EN SÉCURITÉ
--
-- Le module sable (052-056) sait créer, valider et encaisser une vente. Il ne
-- sait pas revenir en arrière : aucune route de suppression, d'annulation ou
-- de correction n'existe. Un statut « ANNULEE » est même déjà référencé par
-- le tableau de bord (`WHERE status <> 'ANNULEE'`) sans jamais être posé.
--
-- Cette migration pose les fondations, additives et idempotentes :
--
--   1. Un statut contraint sur les trois tables (BROUILLON, VALIDEE, ANNULEE,
--      REMPLACEE) — aujourd'hui `status` est un VARCHAR libre.
--   2. Les colonnes d'annulation, sur le même patron que `documents`
--      (migration 073) : jamais de suppression physique d'un document
--      validé, toujours une trace de qui, quand, pourquoi, et vers quoi.
--   3. Une table d'audit dédiée (`sand_sale_audit_log`) qui journalise CHAQUE
--      opération sensible — brouillon modifié/supprimé, vente corrigée,
--      vente annulée, paiement contrepassé — avec l'avant/après complet.
--   4. Une table de contrepassation de paiement (`sand_payment_reversals`) :
--      un encaissement ne se supprime jamais, il se contrepasse.
--   5. Cinq permissions nouvelles, rattachées au module `sable` déjà en
--      place. `update`/`delete` sur `sable` gouvernent déjà l'édition des
--      TARIFS (`PATCH`/`DELETE /sand/prices/:id`) : les réutiliser pour les
--      brouillons de vente donnerait par erreur aux magasiniers le droit de
--      modifier les tarifs. D'où des actions dédiées.
--
-- Rien ici ne touche `stock_movements` ni `stock_location_balances` : le
-- module sable n'a jamais créé de mouvement de stock (`stock_impacted:
-- false` partout dans routes/sand-sales.js), donc aucune restitution n'est
-- possible ni nécessaire au niveau du schéma — c'est la route d'annulation,
-- pas la migration, qui doit s'assurer de ne jamais inventer un mouvement.
--
-- `entrepôt`/`emplacement` n'existent pas comme concept dans ce module (pas
-- de FK vers `locations`/`warehouses` — cohérent avec son commentaire
-- d'origine « Module indépendant du stock et du ciment »). Les champs de
-- lieu réels sont `destination` (site/chantier) et `delivery_place`
-- (lieu de livraison) : ce sont eux que la correction modifiera.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. STATUTS CONTRAINTS
--
-- Posés en DO $$ pour ne jamais casser une base qui porterait déjà une
-- valeur imprévue : dans ce cas, avertir plutôt qu'échouer.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE hors_norme INTEGER;
BEGIN
  SELECT count(*) INTO hors_norme FROM sand_sales
   WHERE status NOT IN ('BROUILLON','VALIDEE','ANNULEE','REMPLACEE');
  IF hors_norme > 0 THEN
    RAISE WARNING 'sand_sales : % ligne(s) portent un statut hors norme, contrainte non posée.', hors_norme;
  ELSE
    ALTER TABLE sand_sales DROP CONSTRAINT IF EXISTS sand_sales_status_chk;
    ALTER TABLE sand_sales ADD CONSTRAINT sand_sales_status_chk
      CHECK (status IN ('BROUILLON','VALIDEE','ANNULEE','REMPLACEE'));
  END IF;
END $$;

DO $$
DECLARE hors_norme INTEGER;
BEGIN
  SELECT count(*) INTO hors_norme FROM sand_invoices
   WHERE status NOT IN ('IMPAYEE','PARTIELLEMENT_PAYEE','PAYEE','ANNULEE','REMPLACEE');
  IF hors_norme > 0 THEN
    RAISE WARNING 'sand_invoices : % ligne(s) portent un statut hors norme, contrainte non posée.', hors_norme;
  ELSE
    ALTER TABLE sand_invoices DROP CONSTRAINT IF EXISTS sand_invoices_status_chk;
    ALTER TABLE sand_invoices ADD CONSTRAINT sand_invoices_status_chk
      CHECK (status IN ('IMPAYEE','PARTIELLEMENT_PAYEE','PAYEE','ANNULEE','REMPLACEE'));
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. LES COLONNES D'ANNULATION — sand_sales, sand_invoices, sand_deliveries
--
-- sand_sales porte déjà `cancelled_by`/`cancelled_at` (052), jamais écrites.
-- On complète sans les redéfinir.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE sand_sales
  ADD COLUMN IF NOT EXISTS cancelled_by_name    TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_reason   TEXT,
  ADD COLUMN IF NOT EXISTS replaced_by_sale_id   INTEGER REFERENCES sand_sales(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS replaces_sale_id      INTEGER REFERENCES sand_sales(id) ON DELETE SET NULL,
  /* Mode de paiement ATTENDU, saisi sur le brouillon. Le mode RÉEL reste
     celui choisi à l'encaissement (sand_payments.payment_method) : ce champ
     est indicatif, jamais une source de vérité financière. */
  ADD COLUMN IF NOT EXISTS expected_payment_method TEXT;

ALTER TABLE sand_invoices
  ADD COLUMN IF NOT EXISTS cancelled_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by_name      TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reason     TEXT,
  ADD COLUMN IF NOT EXISTS replaced_by_invoice_id  INTEGER REFERENCES sand_invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS replaces_invoice_id     INTEGER REFERENCES sand_invoices(id) ON DELETE SET NULL,
  /* Aucune trace d'impression n'existait sur ce module (contrairement à
     `documents.printed_at`/`print_count`) : impossible jusqu'ici de savoir
     si une facture avait déjà circulé avant de la corriger. */
  ADD COLUMN IF NOT EXISTS printed_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS print_count            INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sand_deliveries
  ADD COLUMN IF NOT EXISTS cancelled_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by_name        TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reason       TEXT,
  ADD COLUMN IF NOT EXISTS replaced_by_delivery_id   INTEGER REFERENCES sand_deliveries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS replaces_delivery_id      INTEGER REFERENCES sand_deliveries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS printed_at               TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS print_count              INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sand_sales_cancelled     ON sand_sales(company_id, cancelled_at) WHERE cancelled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sand_sales_replaced       ON sand_sales(company_id, replaced_by_sale_id) WHERE replaced_by_sale_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sand_invoices_cancelled   ON sand_invoices(company_id, cancelled_at) WHERE cancelled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sand_deliveries_cancelled ON sand_deliveries(company_id, cancelled_at) WHERE cancelled_at IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. L'AUDIT — une ligne par opération sensible, avant/après complet
--
-- Ne remplace pas `sand_sales.cancelled_*` (l'état courant), mais garde
-- l'HISTOIRE : plusieurs opérations peuvent toucher la même vente au fil du
-- temps, chacune doit rester lisible séparément.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sand_sale_audit_log (
  id                    BIGSERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  action                TEXT NOT NULL CHECK (action IN
                           ('DRAFT_UPDATE','DRAFT_DELETE','CORRECT','CANCEL','PAYMENT_REVERSE')),
  sale_id               INTEGER REFERENCES sand_sales(id) ON DELETE SET NULL,
  original_sale_id      INTEGER REFERENCES sand_sales(id) ON DELETE SET NULL,
  replacement_sale_id   INTEGER REFERENCES sand_sales(id) ON DELETE SET NULL,
  invoice_id            INTEGER REFERENCES sand_invoices(id) ON DELETE SET NULL,
  delivery_id           INTEGER REFERENCES sand_deliveries(id) ON DELETE SET NULL,
  payment_id            INTEGER REFERENCES sand_payments(id) ON DELETE SET NULL,
  reason                TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  old_value             JSONB,
  new_value             JSONB,
  was_already_printed   BOOLEAN NOT NULL DEFAULT FALSE,
  performed_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name     TEXT NOT NULL DEFAULT '',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sand_sale_audit_sale    ON sand_sale_audit_log(company_id, sale_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sand_sale_audit_original ON sand_sale_audit_log(company_id, original_sale_id);

-- ═════════════════════════════════════════════════════════════════════════
-- 4. LA CONTREPASSATION DE PAIEMENT
--
-- Un encaissement ne se supprime jamais. On enregistre la contrepassation à
-- côté, avec un lien exprès vers l'écriture comptable inverse et un drapeau
-- disant si un remboursement réel de la somme reste dû au client.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sand_payment_reversals (
  id                              SERIAL PRIMARY KEY,
  company_id                      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id                      INTEGER NOT NULL REFERENCES sand_invoices(id) ON DELETE CASCADE,
  original_payment_id             INTEGER NOT NULL REFERENCES sand_payments(id) ON DELETE RESTRICT,
  amount                          NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  reason                          TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  reversal_accounting_transaction_id INTEGER REFERENCES accounting_transactions(id) ON DELETE SET NULL,
  refund_pending                  BOOLEAN NOT NULL DEFAULT TRUE,
  refunded_at                     TIMESTAMPTZ,
  created_by                      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name                 TEXT NOT NULL DEFAULT '',
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  /* Un paiement ne se contrepasse qu'une fois : la seconde tentative doit
     trouver ce qui existe déjà, jamais en écrire un second. */
  UNIQUE (company_id, original_payment_id)
);

CREATE INDEX IF NOT EXISTS idx_sand_payment_reversals_invoice ON sand_payment_reversals(company_id, invoice_id);

/* Le filet de sécurité posé par 056 (« un paiement ne produit jamais deux
   transactions comptables ») s'élargit à la contrepassation : une
   contrepassation ne doit pas non plus, par rejeu ou concurrence, produire
   deux écritures inverses. Recréé à l'identique + le nouveau type, jamais
   restreint. */
DROP INDEX IF EXISTS accounting_sales_payment_source_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS accounting_sales_payment_source_uidx
    ON accounting_transactions (company_id, source_type, source_id)
 WHERE source_type IN ('cement_payment', 'sand_payment', 'sand_payment_reversal');

-- ═════════════════════════════════════════════════════════════════════════
-- 5. LES PERMISSIONS — cinq actions nouvelles, module `sable` existant
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO permission_actions (action_key, label, description, sort_order, is_write) VALUES
  ('vente_modifier_brouillon',  'Modifier un brouillon de vente',
   'Modifier intégralement une vente de sable tant qu''elle est en brouillon.', 190, true),
  ('vente_supprimer_brouillon', 'Supprimer un brouillon de vente',
   'Supprimer une vente de sable en brouillon, sans document définitif actif.', 191, true),
  ('vente_corriger_validee',    'Corriger une vente validée',
   'Annuler une vente validée et la remplacer par une nouvelle, corrigée.', 192, true),
  ('vente_annuler',             'Annuler une vente validée',
   'Annuler une vente validée avec motif, sans la remplacer.', 193, true),
  ('paiement_contrepasser',     'Contrepasser un encaissement',
   'Contrepasser un paiement de vente sable déjà encaissé.', 194, true)
ON CONFLICT (action_key) DO NOTHING;

UPDATE permission_modules
   SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                    FROM unnest(actions || ARRAY[
                      'vente_modifier_brouillon','vente_supprimer_brouillon',
                      'vente_corriger_validee','vente_annuler','paiement_contrepasser'
                    ]) AS a),
       updated_at = now()
 WHERE module_key = 'sable'
   AND NOT (actions @> ARRAY[
     'vente_modifier_brouillon','vente_supprimer_brouillon',
     'vente_corriger_validee','vente_annuler','paiement_contrepasser'
   ]);

-- ── Droits par défaut, pour CHAQUE société existante ────────────────────
--
-- super_admin : toujours autorisé par le contournement du moteur de
--   permissions (services/permissions.js, `estSuperAdmin`) — aucune ligne à
--   écrire.
-- admin : la même famille d'actions que le reste du module `sable`, où admin
--   porte déjà create/update/delete/validate/... = true.
-- comptable : paiement et contrepassation seulement — jamais la correction
--   ou l'annulation d'une vente, jamais les brouillons.
-- employe / responsable_entrepot (magasinier) : brouillons seulement,
--   jamais la correction, l'annulation ou la contrepassation.
-- direction : intentionnellement AUCUNE ligne — « droits configurables »,
--   laissé à l'écran de gestion des droits existant.
DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'admin', 'sable', 'vente_modifier_brouillon', true),
      (soc.id, 'admin', 'sable', 'vente_supprimer_brouillon', true),
      (soc.id, 'admin', 'sable', 'vente_corriger_validee', true),
      (soc.id, 'admin', 'sable', 'vente_annuler', true),
      (soc.id, 'admin', 'sable', 'paiement_contrepasser', true),
      (soc.id, 'comptable', 'sable', 'paiement_contrepasser', true),
      (soc.id, 'employe', 'sable', 'vente_modifier_brouillon', true),
      (soc.id, 'employe', 'sable', 'vente_supprimer_brouillon', true),
      (soc.id, 'responsable_entrepot', 'sable', 'vente_modifier_brouillon', true),
      (soc.id, 'responsable_entrepot', 'sable', 'vente_supprimer_brouillon', true)
    ON CONFLICT (company_id, role, module_key, action) DO NOTHING;
  END LOOP;
END $$;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- 6. CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sand_sale_audit_log') THEN
    RAISE EXCEPTION 'Sans audit, une correction de vente ne serait pas vérifiable.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sand_payment_reversals') THEN
    RAISE EXCEPTION 'Sans contrepassation tracée, un paiement annulé serait juste supprimé.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'sand_sales' AND column_name = 'replaced_by_sale_id') THEN
    RAISE EXCEPTION 'Sans lien de remplacement, une correction perdrait la chaîne ancienne→nouvelle.';
  END IF;
  RAISE NOTICE 'Annulation et correction des ventes de sable : schéma conforme.';
END $$;
