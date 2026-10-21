-- ═════════════════════════════════════════════════════════════════════════
-- 104 — CORRIGER UN BON D'ENCAISSEMENT OU DE DÉCAISSEMENT
--
-- Un bon validé a déplacé de l'argent : son solde a bougé, une transaction et
-- deux écritures existent. Le corriger ne peut donc pas vouloir dire le
-- réécrire. Deux gestes distincts, et un seul est réversible sans trace :
--
--   • AVANT validation, le bon n'a rien produit : on le modifie, et chaque
--     modification laisse une ligne d'historique avec son motif.
--   • APRÈS validation, on CONTRE-PASSE : les écritures d'origine restent,
--     des écritures inverses s'y ajoutent, le solde revient, le bon passe
--     ANNULÉ. Rien n'est effacé.
--
-- Le défaut que cela ferme : un bon validé puis « refusé » laissait l'argent
-- déplacé et le bon marqué refusé — une dépense qui pesait toujours sur le
-- résultat sans qu'aucun écran ne la montre comme active.
--
-- Idempotente. Aucune donnée existante n'est modifiée : les bons déjà validés
-- restent validés, ceux déjà refusés restent refusés.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE cash_vouchers
  ADD COLUMN IF NOT EXISTS cancelled_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by      INTEGER,
  ADD COLUMN IF NOT EXISTS cancelled_by_name TEXT,
  ADD COLUMN IF NOT EXISTS cancel_reason     TEXT,
  /* La transaction d'origine et sa contre-écriture, pour qu'un journal se lise
     sans avoir à deviner laquelle défait laquelle. */
  ADD COLUMN IF NOT EXISTS transaction_id            INTEGER,
  ADD COLUMN IF NOT EXISTS reversal_transaction_id   INTEGER;

CREATE INDEX IF NOT EXISTS cash_vouchers_annules_idx
  ON cash_vouchers (company_id, cancelled_at) WHERE cancelled_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- L'HISTORIQUE
--
-- Une ligne par geste, avec ce qui a changé et pourquoi. Sans cela, « qui a
-- ramené ce bon de 400 000 à 40 000, et quand ? » n'a pas de réponse.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cash_voucher_history (
  id             BIGSERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL,
  voucher_id     INTEGER NOT NULL REFERENCES cash_vouchers(id) ON DELETE CASCADE,
  action         TEXT    NOT NULL,
  /* Les champs touchés : { champ: { avant, apres } }. Vide pour une action
     qui ne modifie aucun champ, comme une validation. */
  changes        JSONB   NOT NULL DEFAULT '{}'::jsonb,
  reason         TEXT    NOT NULL DEFAULT '',
  status_before  TEXT,
  status_after   TEXT,
  amount_before  NUMERIC(18,2),
  amount_after   NUMERIC(18,2),
  acted_by       INTEGER,
  acted_by_name  TEXT NOT NULL DEFAULT '',
  acted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cash_voucher_history_action_connue CHECK (
    action IN ('CREATION','MODIFICATION','VALIDATION','REFUS','ANNULATION')
  )
);

CREATE INDEX IF NOT EXISTS cash_voucher_history_bon_idx
  ON cash_voucher_history (voucher_id, acted_at DESC);
CREATE INDEX IF NOT EXISTS cash_voucher_history_societe_idx
  ON cash_voucher_history (company_id, acted_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- QUI PEUT CORRIGER
--
-- `update` modifie un bon non encore validé ; `delete` contre-passe un bon
-- validé. Le second est beaucoup plus lourd que le premier, et les deux droits
-- sont donc séparés — comme pour les transferts internes.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO permission_modules
  (module_key, parent_key, label, description, sort_order, is_active, is_system, actions) VALUES
  ('comptabilite.bon', 'comptabilite', 'Bons d''encaissement et de décaissement',
   'Créer, modifier avant validation, valider, refuser et contre-passer un bon validé.',
   410, TRUE, FALSE,
   ARRAY['visible','view','create','update','validate','delete','print','export'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      label = EXCLUDED.label, description = EXCLUDED.description, updated_at = now();

DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'direction', 'comptabilite.bon', 'visible',  true),
      (soc.id, 'direction', 'comptabilite.bon', 'view',     true),
      (soc.id, 'direction', 'comptabilite.bon', 'create',   true),
      (soc.id, 'direction', 'comptabilite.bon', 'update',   true),
      (soc.id, 'direction', 'comptabilite.bon', 'validate', true),
      (soc.id, 'direction', 'comptabilite.bon', 'delete',   true),
      (soc.id, 'direction', 'comptabilite.bon', 'print',    true),
      (soc.id, 'comptable', 'comptabilite.bon', 'visible',  true),
      (soc.id, 'comptable', 'comptabilite.bon', 'view',     true),
      (soc.id, 'comptable', 'comptabilite.bon', 'create',   true),
      (soc.id, 'comptable', 'comptabilite.bon', 'update',   true),
      (soc.id, 'comptable', 'comptabilite.bon', 'print',    true),
      /* Contre-passer une opération validée reste à la Direction. */
      (soc.id, 'comptable', 'comptabilite.bon', 'delete',   false)
    ON CONFLICT (company_id, role, module_key, action)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
     WHERE role_permissions.updated_by IS NULL;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- LES BONS DÉJÀ INCOHÉRENTS : RECENSÉS, PAS CORRIGÉS
--
-- Un bon refusé dont l'argent a pourtant bougé. Les régulariser en masse
-- changerait des soldes réels ; une personne doit décider bon par bon.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_bons_incoherents AS
SELECT v.id, v.company_id, v.voucher_number, v.voucher_type, v.amount,
       v.status, v.rejection_reason, v.validated_at, v.created_at,
       t.id AS transaction_id, t.transaction_number, t.direction, t.amount AS montant_mouvement,
       'bon refusé alors que son mouvement existe toujours' AS anomalie
  FROM cash_vouchers v
  JOIN accounting_transactions t
    ON t.source_type = 'cash_voucher' AND t.source_id = v.id
   AND t.company_id = v.company_id
 WHERE v.status = 'refusé'
   AND t.cancelled_at IS NULL
   AND COALESCE(t.show_in_financial_movements, TRUE) = TRUE;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE incoherents INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_name = 'cash_voucher_history') THEN
    RAISE EXCEPTION '104 : sans historique, une correction de bon serait intraçable.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'cash_vouchers' AND column_name = 'cancel_reason') THEN
    RAISE EXCEPTION '104 : sans motif d''annulation, un bon contre-passé ne s''expliquerait pas.';
  END IF;

  SELECT count(*) INTO incoherents FROM v_bons_incoherents;
  IF incoherents > 0 THEN
    RAISE NOTICE '104 : % bon(s) refusé(s) dont le mouvement d''argent existe toujours. Aucun n''a été corrigé : voir v_bons_incoherents.', incoherents;
  ELSE
    RAISE NOTICE '104 : aucun bon refusé avec un mouvement encore actif.';
  END IF;
  RAISE NOTICE 'Correction des bons comptables en place. Aucun bon existant modifié, aucun solde touché.';
END $$;
