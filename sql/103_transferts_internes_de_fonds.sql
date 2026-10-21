-- ═════════════════════════════════════════════════════════════════════════
-- 103 — TRANSFERT INTERNE DE FONDS, ET CORRECTION D'UN DÉFAUT EN PRODUCTION
--
-- ─────────────────────────────────────────────────────────────────────────
-- 1. UNE COLONNE QUE LE TABLEAU DE BORD LIT DÉJÀ, ET QUI N'EXISTE PAS
--
-- `server.js` agrège les recettes et les dépenses du jour avec
-- « COALESCE(show_in_financial_movements, TRUE) = TRUE ». Cette colonne n'est
-- créée par AUCUNE migration : la requête échoue avec « column
-- show_in_financial_movements does not exist », et le bloc financier du
-- tableau de bord tombe en erreur.
--
-- Le mécanisme avait donc été PENSÉ — distinguer un mouvement qui pèse dans
-- les recettes d'un mouvement qui ne fait que déplacer de l'argent — mais
-- jamais créé. On le crée, et c'est lui qui porte la correction demandée.
--
-- ─────────────────────────────────────────────────────────────────────────
-- 2. POURQUOI UN TRANSFERT N'EST NI UNE RECETTE NI UNE DÉPENSE
--
-- Déplacer 5 000 000 FCFA de la banque BDM vers la caisse ne fait entrer ni
-- sortir un franc de l'entreprise : le total de ses fonds est inchangé. Compté
-- comme une recette à l'arrivée et une dépense au départ, le même argent
-- gonflerait le chiffre d'affaires ET les charges, et le bénéfice du mois
-- deviendrait faux dans les deux sens à la fois.
--
-- Les deux écritures existent quand même — un solde qui bouge sans écriture
-- est intraçable — mais elles sont marquées comme n'étant pas des mouvements
-- financiers d'exploitation.
--
-- ─────────────────────────────────────────────────────────────────────────
-- 3. CE QUE CETTE MIGRATION NE FAIT PAS
--
-- Elle ne reclasse AUCUN mouvement ancien. Des dépôts caisse→banque déjà
-- enregistrés comme recettes ou dépenses existent peut-être ; les retourner
-- en masse changerait des totaux publiés sans diagnostic. La migration fournit
-- une VUE qui les recense, en lecture seule, pour une régularisation décidée
-- ensuite, pièce par pièce.
--
-- Additive et idempotente.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- LA COLONNE MANQUANTE, ET LES MARQUEURS DU TRANSFERT
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE accounting_transactions
  /* TRUE par défaut : tout ce qui existe garde exactement le sens qu'il avait.
     Seul un transfert interne, créé par le service dédié, vaut FALSE. */
  ADD COLUMN IF NOT EXISTS show_in_financial_movements BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS is_internal_transfer        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS internal_transfer_id        BIGINT,
  /* La trace d'une annulation. Une opération comptable validée ne s'efface
     pas : elle se contre-passe, et les deux restent lisibles. */
  ADD COLUMN IF NOT EXISTS cancelled_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by   INTEGER,
  ADD COLUMN IF NOT EXISTS cancel_reason  TEXT,
  ADD COLUMN IF NOT EXISTS reverses_transaction_id INTEGER;

/* Une contre-écriture ne doit pas peser une seconde fois dans les totaux
   d'exploitation : elle annule, elle ne dépense pas. */
CREATE INDEX IF NOT EXISTS accounting_transactions_mouvements_idx
  ON accounting_transactions (company_id, direction, show_in_financial_movements)
  WHERE show_in_financial_movements = TRUE;
CREATE INDEX IF NOT EXISTS accounting_transactions_transfert_idx
  ON accounting_transactions (company_id, internal_transfer_id)
  WHERE internal_transfer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS accounting_transactions_annulees_idx
  ON accounting_transactions (company_id, cancelled_at)
  WHERE cancelled_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- LE TRANSFERT LUI-MÊME
--
-- Un objet à part, et non un type de transaction de plus : un transfert a DEUX
-- comptes, et une transaction n'en porte qu'un. Les deux jambes pointent vers
-- cette ligne, qui seule sait que l'argent est allé d'ici à là.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS internal_fund_transfers (
  id              BIGSERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reference       TEXT    NOT NULL,
  transfer_date   DATE    NOT NULL DEFAULT CURRENT_DATE,
  amount          NUMERIC(16,2) NOT NULL,

  /* BANQUE | CAISSE | TRESORERIE — les trois natures que connaît déjà
     services/tresorerie.js. L'identifiant est NULL pour la trésorerie, qui est
     unique par société. */
  source_kind       TEXT NOT NULL,
  source_id         INTEGER,
  source_label      TEXT NOT NULL DEFAULT '',
  source_balance_before NUMERIC(16,2),
  source_balance_after  NUMERIC(16,2),

  destination_kind  TEXT NOT NULL,
  destination_id    INTEGER,
  destination_label TEXT NOT NULL DEFAULT '',
  destination_balance_before NUMERIC(16,2),
  destination_balance_after  NUMERIC(16,2),

  /* Les deux jambes comptables, pour pouvoir remonter du transfert aux
     écritures et inversement. */
  debit_transaction_id  INTEGER,
  credit_transaction_id INTEGER,

  status      TEXT NOT NULL DEFAULT 'ACTIF',
  reason      TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  cancelled_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_by_name TEXT NOT NULL DEFAULT '',
  cancelled_at  TIMESTAMPTZ,
  cancel_reason TEXT NOT NULL DEFAULT '',
  /* Les deux jambes de l'annulation : un transfert annulé garde ses quatre
     mouvements, et le solde revient à ce qu'il était. */
  reversal_debit_transaction_id  INTEGER,
  reversal_credit_transaction_id INTEGER,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'internal_fund_transfers_coherent') THEN
    ALTER TABLE internal_fund_transfers ADD CONSTRAINT internal_fund_transfers_coherent CHECK (
      amount > 0
      AND source_kind IN ('BANQUE','CAISSE','TRESORERIE')
      AND destination_kind IN ('BANQUE','CAISSE','TRESORERIE')
      AND status IN ('ACTIF','ANNULE')
      /* Un transfert vers soi-même ne déplace rien et ferait deux écritures
         qui s'annulent : la base le refuse plutôt que de l'enregistrer. */
      AND NOT (source_kind = destination_kind
               AND COALESCE(source_id, -1) = COALESCE(destination_id, -1))
      /* Un transfert annulé porte son auteur, sa date et son motif. */
      AND (status <> 'ANNULE'
           OR (cancelled_at IS NOT NULL AND BTRIM(cancel_reason) <> ''))
    );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS internal_fund_transfers_ref_uidx
  ON internal_fund_transfers (company_id, reference);
CREATE INDEX IF NOT EXISTS internal_fund_transfers_date_idx
  ON internal_fund_transfers (company_id, transfer_date DESC);
CREATE INDEX IF NOT EXISTS internal_fund_transfers_actifs_idx
  ON internal_fund_transfers (company_id, status) WHERE status = 'ACTIF';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'accounting_transactions_transfert_fkey') THEN
    ALTER TABLE accounting_transactions
      ADD CONSTRAINT accounting_transactions_transfert_fkey
      FOREIGN KEY (internal_transfer_id) REFERENCES internal_fund_transfers(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- LES ANCIENS MOUVEMENTS QUI RESSEMBLENT À DES TRANSFERTS
--
-- Une VUE, pas un UPDATE. Elle recense ce qui mériterait d'être reclassé, pour
-- qu'une personne décide pièce par pièce. Reclasser en masse changerait des
-- totaux déjà publiés — un bilan, un rapport remis — sans que personne ne
-- puisse dire lesquels.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_transferts_internes_candidats AS
SELECT t.id, t.company_id, t.transaction_number, t.transaction_type, t.direction,
       t.amount, t.operation_date, t.created_at, t.bank_id, t.caisse_id,
       t.source_label, t.destination_label, t.description,
       t.show_in_financial_movements, t.is_internal_transfer,
       CASE
         WHEN t.transaction_type = 'depot_caisse_banque' THEN 'dépôt caisse → banque'
         WHEN t.transaction_type ILIKE '%transfert%'      THEN 'libellé « transfert »'
         WHEN t.transaction_type ILIKE '%virement%'       THEN 'libellé « virement »'
         WHEN t.description ILIKE '%transfert interne%'   THEN 'description « transfert interne »'
         ELSE 'autre indice'
       END AS indice
  FROM accounting_transactions t
 WHERE t.is_internal_transfer = FALSE
   AND t.cancelled_at IS NULL
   AND (t.transaction_type = 'depot_caisse_banque'
        OR t.transaction_type ILIKE '%transfert%'
        OR t.transaction_type ILIKE '%virement%'
        OR t.description ILIKE '%transfert interne%');

-- ─────────────────────────────────────────────────────────────────────────
-- QUI PEUT DÉPLACER DES FONDS
--
-- Déplacer de l'argent entre deux comptes de la société n'est pas saisir une
-- facture : un module distinct, pour qu'on puisse accorder la consultation
-- sans accorder le geste, et le geste sans l'annulation.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO permission_modules
  (module_key, parent_key, label, description, sort_order, is_active, is_system, actions) VALUES
  ('comptabilite.transfert_interne', 'comptabilite', 'Transferts internes de fonds',
   'Déplacer des fonds entre comptes de la société. Ni une recette, ni une dépense.',
   420, TRUE, FALSE,
   ARRAY['visible','view','create','delete','print','export'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      label = EXCLUDED.label, description = EXCLUDED.description, updated_at = now();

DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    /* `create` déplace les fonds, `delete` annule un transfert déjà passé.
       Le comptable peut déplacer ; défaire une opération validée reste à la
       Direction, comme pour toute contre-passation. */
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'direction', 'comptabilite.transfert_interne', 'visible', true),
      (soc.id, 'direction', 'comptabilite.transfert_interne', 'view',    true),
      (soc.id, 'direction', 'comptabilite.transfert_interne', 'create',  true),
      (soc.id, 'direction', 'comptabilite.transfert_interne', 'delete',  true),
      (soc.id, 'direction', 'comptabilite.transfert_interne', 'print',   true),
      (soc.id, 'direction', 'comptabilite.transfert_interne', 'export',  true),
      (soc.id, 'comptable', 'comptabilite.transfert_interne', 'visible', true),
      (soc.id, 'comptable', 'comptabilite.transfert_interne', 'view',    true),
      (soc.id, 'comptable', 'comptabilite.transfert_interne', 'create',  true),
      (soc.id, 'comptable', 'comptabilite.transfert_interne', 'print',   true),
      (soc.id, 'comptable', 'comptabilite.transfert_interne', 'export',  true),
      (soc.id, 'comptable', 'comptabilite.transfert_interne', 'delete',  false)
    ON CONFLICT (company_id, role, module_key, action)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
     WHERE role_permissions.updated_by IS NULL;
  END LOOP;
END $$;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE candidats INTEGER; flag BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'accounting_transactions'
                    AND column_name = 'show_in_financial_movements') INTO flag;
  IF NOT flag THEN
    RAISE EXCEPTION '103 : sans cette colonne, le tableau de bord financier continue d''échouer.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_name = 'internal_fund_transfers') THEN
    RAISE EXCEPTION '103 : sans table de transfert, un déplacement de fonds resterait une recette.';
  END IF;

  /* La requête qui échouait doit maintenant répondre. On l'exécute pour de
     vrai : une colonne créée mais mal nommée ne se verrait pas autrement. */
  PERFORM COALESCE(SUM(amount), 0) FROM accounting_transactions
   WHERE direction = 'entrée' AND COALESCE(show_in_financial_movements, TRUE) = TRUE;

  SELECT count(*) INTO candidats FROM v_transferts_internes_candidats;
  IF candidats > 0 THEN
    RAISE NOTICE '103 : % mouvement(s) ressemblent à des transferts internes et pèsent encore dans les recettes ou les dépenses. Aucun n''a été modifié : voir v_transferts_internes_candidats.', candidats;
  ELSE
    RAISE NOTICE '103 : aucun ancien mouvement candidat au reclassement.';
  END IF;
  RAISE NOTICE 'Transfert interne de fonds en place. Aucun mouvement ancien reclassé, aucun solde touché.';
END $$;
