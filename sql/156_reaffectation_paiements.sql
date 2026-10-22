-- ═════════════════════════════════════════════════════════════════════════
--  156 — RÉAFFECTER UN PAIEMENT À LA BONNE FACTURE
--
--  L'argent est entré. Il a été imputé à la mauvaise facture. Deux gestes
--  possibles, et un seul convient ici :
--
--    • CONTREPASSER (migration 152) — l'argent ressort. Des écritures
--      inverses sont créées, le solde revient. C'est le geste quand l'argent
--      n'aurait pas dû être encaissé, ou doit être rendu.
--
--    • RÉAFFECTER (ce fichier) — l'argent reste. Seule son IMPUTATION change.
--      Aucune écriture nouvelle, aucun second encaissement : c'est tout
--      l'intérêt. La facture d'origine redevient due, la facture visée est
--      créditée, et les deux soldes sont RECALCULÉS depuis la somme réelle
--      des paiements, jamais par différence.
--
--  CE QUE LA STRUCTURE INTERDIT. Un paiement appartient à une facture par
--  clé étrangère : il ne peut pas en créditer deux. La réaffectation est un
--  DÉPLACEMENT atomique, pas un détachement suivi d'un rattachement — rien
--  n'existe donc jamais « en attente d'affectation », état dans lequel un
--  même paiement pourrait être attribué deux fois.
--
--  ADDITIVE. Ne réécrit aucune donnée existante.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- LE JOURNAL DES RÉAFFECTATIONS
--
-- Il porte les DEUX côtés, et les noms tels qu'ils étaient au moment du
-- geste. Un identifiant seul ne dit rien à la relecture, et une facture peut
-- être renumérotée.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_reallocations (
  id                  BIGSERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product             TEXT    NOT NULL,

  payment_id          BIGINT  NOT NULL,
  payment_number      TEXT    NOT NULL,
  amount              NUMERIC(18,2) NOT NULL,
  payment_date        DATE,

  from_invoice_id     BIGINT  NOT NULL,
  from_invoice_number TEXT    NOT NULL,
  from_customer       TEXT    NOT NULL DEFAULT '',
  to_invoice_id       BIGINT  NOT NULL,
  to_invoice_number   TEXT    NOT NULL,
  to_customer         TEXT    NOT NULL DEFAULT '',

  reason              TEXT    NOT NULL,

  /* Déplacer 600 000 sur une facture qui n'en doit que 300 000 la met en
     trop-perçu. Ce n'est pas interdit — cela arrive — mais cela se décide,
     et la décision se garde. */
  overpay_accepted    BOOLEAN NOT NULL DEFAULT FALSE,
  overpay_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,

  /* Une réaffectation peut elle-même être une erreur. L'annuler remet le
     paiement sur la facture d'origine, et laisse les deux lignes lisibles. */
  reverted_at         TIMESTAMPTZ,
  reverted_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reverted_by_name    TEXT    NOT NULL DEFAULT '',
  revert_reason       TEXT    NOT NULL DEFAULT '',

  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name     TEXT    NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_reallocations_coherent') THEN
    ALTER TABLE payment_reallocations ADD CONSTRAINT payment_reallocations_coherent CHECK (
          product IN ('SABLE','CIMENT')
      AND amount > 0
      /* On ne réaffecte pas une facture sur elle-même : ce serait un geste
         sans effet, qui encombrerait l'historique d'une ligne trompeuse. */
      AND from_invoice_id <> to_invoice_id
      /* Le motif n'est pas facultatif. Six mois plus tard, « pourquoi ce
         paiement a-t-il changé de facture ? » doit avoir une réponse. */
      AND length(btrim(reason)) >= 10
      AND (reverted_at IS NULL OR btrim(revert_reason) <> '')
      AND (overpay_accepted OR overpay_amount = 0)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS payment_reallocations_paiement_idx
  ON payment_reallocations (company_id, product, payment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_reallocations_facture_idx
  ON payment_reallocations (company_id, product, to_invoice_id);
CREATE INDEX IF NOT EXISTS payment_reallocations_origine_idx
  ON payment_reallocations (company_id, product, from_invoice_id);
CREATE INDEX IF NOT EXISTS payment_reallocations_actives_idx
  ON payment_reallocations (company_id, product, payment_id)
  WHERE reverted_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- CE QUE LES PAIEMENTS GARDENT D'EUX-MÊMES
--
-- `original_invoice_id` retient la PREMIÈRE facture à laquelle le paiement a
-- été imputé. Sans elle, après deux réaffectations, plus rien ne dit où
-- l'argent a d'abord été porté — il faudrait relire tout le journal.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE sand_payments
  ADD COLUMN IF NOT EXISTS original_invoice_id  BIGINT,
  ADD COLUMN IF NOT EXISTS reallocated_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reallocation_count   INTEGER NOT NULL DEFAULT 0;

ALTER TABLE cement_payments
  ADD COLUMN IF NOT EXISTS original_invoice_id  BIGINT,
  ADD COLUMN IF NOT EXISTS reallocated_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reallocation_count   INTEGER NOT NULL DEFAULT 0;

/* Les paiements déjà en base n'ont jamais bougé : leur facture actuelle est
   bien leur facture d'origine. On le dit une fois, pour les anciens, sans
   écraser ceux qui auraient déjà une valeur. */
UPDATE sand_payments   SET original_invoice_id = invoice_id WHERE original_invoice_id IS NULL;
UPDATE cement_payments SET original_invoice_id = invoice_id WHERE original_invoice_id IS NULL;

CREATE INDEX IF NOT EXISTS sand_payments_reaffectes_idx
  ON sand_payments (company_id, invoice_id) WHERE reallocation_count > 0;
CREATE INDEX IF NOT EXISTS cement_payments_reaffectes_idx
  ON cement_payments (company_id, invoice_id) WHERE reallocation_count > 0;

-- ─────────────────────────────────────────────────────────────────────────
-- LES PAIEMENTS QUI ONT CHANGÉ DE FACTURE
--
-- Une vue, pour que la question se pose au même endroit pour les deux
-- produits, et que l'écran d'une facture puisse dire « ce paiement venait
-- d'ailleurs » sans refaire la jointure.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_paiements_reaffectes AS
SELECT r.company_id, r.product, r.payment_id, r.payment_number, r.amount,
       r.from_invoice_id, r.from_invoice_number, r.from_customer,
       r.to_invoice_id, r.to_invoice_number, r.to_customer,
       r.reason, r.overpay_accepted, r.overpay_amount,
       r.created_by_name, r.created_at,
       r.reverted_at, r.reverted_by_name, r.revert_reason,
       (r.reverted_at IS NULL) AS active
  FROM payment_reallocations r;

-- ─────────────────────────────────────────────────────────────────────────
-- LES DROITS
--
-- `paiement_reaffecter` est une action NOUVELLE : permission_actions est un
-- catalogue fermé dont role_permissions.action dépend par clé étrangère, et
-- une action non déclarée ferait échouer le semis.
--
-- Elle est distincte de `paiement_contrepasser` : contrepasser fait ressortir
-- l'argent, réaffecter le laisse en place. Ce ne sont ni le même geste ni le
-- même risque, et la personne qui peut faire l'un ne peut pas forcément
-- faire l'autre.
--
-- ATTENTION AUX CLÉS. services/permissions.js normalise « cement » en
-- « ciment » et « sand » en « sable » (table ALIAS). Un droit posé sous la
-- clé anglaise ne répondrait à AUCUNE question : le moteur retomberait sur le
-- rôle, personne n'aurait rien, et le bouton resterait invisible malgré la
-- permission accordée.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO permission_actions (action_key, label, description, sort_order, is_write) VALUES
  ('paiement_reaffecter', 'Réaffecter un paiement',
   'Imputer un encaissement déjà reçu à une autre facture, sans le ressortir ni le réencaisser.',
   168, TRUE)
ON CONFLICT (action_key) DO UPDATE
  SET label = EXCLUDED.label, description = EXCLUDED.description;

UPDATE permission_modules
   SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                    FROM unnest(actions || ARRAY['paiement_reaffecter']) AS a),
       updated_at = now()
 WHERE module_key IN ('sable','ciment');

DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'direction', 'sable',  'paiement_reaffecter', true),
      (soc.id, 'direction', 'ciment', 'paiement_reaffecter', true),
      (soc.id, 'admin',     'sable',  'paiement_reaffecter', true),
      (soc.id, 'admin',     'ciment', 'paiement_reaffecter', true),
      /* Le comptable réaffecte : c'est lui qui constate l'erreur d'imputation
         en rapprochant les comptes. Il ne contrepasse pas pour autant. */
      (soc.id, 'comptable', 'sable',  'paiement_reaffecter', true),
      (soc.id, 'comptable', 'ciment', 'paiement_reaffecter', true),
      (soc.id, 'magasinier','sable',  'paiement_reaffecter', false),
      (soc.id, 'magasinier','ciment', 'paiement_reaffecter', false)
    ON CONFLICT (company_id, role, module_key, action)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
     WHERE role_permissions.updated_by IS NULL;
  END LOOP;
END $$;

/* Si un module « cement » ou « sand » existait sous sa clé anglaise, les
   droits posés ci-dessus ne le concerneraient pas. On le signale plutôt que
   de le corriger en silence : créer un module est une décision. */
DO $$
DECLARE anglais TEXT;
BEGIN
  FOR anglais IN SELECT module_key FROM permission_modules WHERE module_key IN ('cement','sand') LOOP
    RAISE NOTICE 'ATTENTION : un module « % » existe sous sa clé anglaise. Les droits de réaffectation ont été posés sous la clé française, seule reconnue par le moteur.', anglais;
  END LOOP;
END $$;

COMMIT;
