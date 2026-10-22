-- ═════════════════════════════════════════════════════════════════════════
--  158 — DOUBLONS DE FACTURES : EXAMINER, DÉCIDER, NEUTRALISER
--
--  LE PIÈGE À ÉVITER. Deux factures du même client, du même montant, à un
--  mois d'intervalle, ne sont PAS un doublon : c'est très probablement un
--  abonnement, une location, un renouvellement. Les annuler en masse ferait
--  disparaître des créances réelles. À l'inverse, deux factures émises deux
--  fois pour la même vente sont un doublon technique, et le client est
--  réclamé deux fois.
--
--  Rien, dans un montant et une date, ne permet de trancher à coup sûr. Ce
--  fichier n'essaie donc pas de deviner : il installe un REGISTRE DE
--  DÉCISIONS. Le programme rassemble les signaux, une personne tranche, et sa
--  décision est conservée — de sorte qu'une paire examinée ne ressorte pas à
--  chaque passage.
--
--  NEUTRALISER N'EST PAS SUPPRIMER. Une facture neutralisée reste en base,
--  annulée, pointant vers celle qui fait foi. Ses encaissements légitimes
--  sont RÉAFFECTÉS vers la facture de référence (migration 156) : l'argent
--  n'est ni perdu, ni réencaissé.
--
--  ADDITIVE.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS invoice_duplicate_reviews (
  id                 BIGSERIAL PRIMARY KEY,
  company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product            TEXT    NOT NULL,

  /* La paire, dans un ordre FIXE : la plus ancienne d'abord. Sans cet ordre,
     la même paire pourrait être enregistrée deux fois, dans les deux sens, et
     recevoir deux verdicts contraires. */
  invoice_a_id       BIGINT  NOT NULL,
  invoice_a_number   TEXT    NOT NULL,
  invoice_b_id       BIGINT  NOT NULL,
  invoice_b_number   TEXT    NOT NULL,
  client_name        TEXT    NOT NULL DEFAULT '',
  amount             NUMERIC(18,2) NOT NULL DEFAULT 0,
  days_between       INTEGER,

  /* Les signaux relevés au moment de l'examen : même vente, série régulière,
     livraisons distinctes… Conservés tels quels, pour qu'on puisse relire la
     décision à la lumière de ce qui était su. */
  signals            JSONB   NOT NULL DEFAULT '{}'::jsonb,

  verdict            TEXT    NOT NULL DEFAULT 'A_EXAMINER',
  verdict_reason     TEXT    NOT NULL DEFAULT '',
  decided_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_by_name    TEXT    NOT NULL DEFAULT '',
  decided_at         TIMESTAMPTZ,

  /* Quelle facture fait foi, quand le verdict est « doublon ». */
  kept_invoice_id    BIGINT,
  neutralized_invoice_id BIGINT,
  neutralized_at     TIMESTAMPTZ,
  neutralized_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  neutralized_by_name TEXT   NOT NULL DEFAULT '',
  payments_moved     INTEGER NOT NULL DEFAULT 0,
  amount_moved       NUMERIC(18,2) NOT NULL DEFAULT 0,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_duplicate_reviews_coherent') THEN
    ALTER TABLE invoice_duplicate_reviews ADD CONSTRAINT invoice_duplicate_reviews_coherent CHECK (
          product IN ('SABLE','CIMENT')
      AND verdict IN ('A_EXAMINER','DOUBLON_CONFIRME','RENOUVELLEMENT','FACTURES_DISTINCTES')
      AND invoice_a_id <> invoice_b_id
      /* L'ordre fixe, posé en contrainte : une paire ne s'enregistre que dans
         un sens. */
      AND invoice_a_id < invoice_b_id
      /* Un verdict se motive. « Doublon » sans explication ne se relit pas,
         et « renouvellement » non plus : c'est ce qui empêchera quelqu'un de
         rouvrir le dossier dans six mois. */
      AND (verdict = 'A_EXAMINER' OR (decided_at IS NOT NULL AND length(btrim(verdict_reason)) >= 10))
      /* On ne neutralise que ce qui a été confirmé doublon, et la facture
         neutralisée n'est jamais celle qu'on garde. */
      AND (neutralized_at IS NULL OR (verdict = 'DOUBLON_CONFIRME'
                                      AND kept_invoice_id IS NOT NULL
                                      AND neutralized_invoice_id IS NOT NULL
                                      AND kept_invoice_id <> neutralized_invoice_id))
    );
  END IF;
END $$;

/* Une paire ne s'examine qu'une fois. */
CREATE UNIQUE INDEX IF NOT EXISTS invoice_duplicate_reviews_paire_uidx
  ON invoice_duplicate_reviews (company_id, product, invoice_a_id, invoice_b_id);
CREATE INDEX IF NOT EXISTS invoice_duplicate_reviews_verdict_idx
  ON invoice_duplicate_reviews (company_id, product, verdict, created_at DESC);
/* Une facture ne se neutralise qu'une fois. */
CREATE UNIQUE INDEX IF NOT EXISTS invoice_duplicate_reviews_neutralisee_uidx
  ON invoice_duplicate_reviews (company_id, product, neutralized_invoice_id)
  WHERE neutralized_invoice_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- CE QUE LA FACTURE NEUTRALISÉE GARDE D'ELLE-MÊME
--
-- Elle n'est pas supprimée : elle pointe vers celle qui fait foi. Un écran
-- qui tombe dessus peut donc dire « voir la facture X » au lieu d'afficher
-- une facture annulée sans explication.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE sand_invoices
  ADD COLUMN IF NOT EXISTS duplicate_of_invoice_id BIGINT,
  ADD COLUMN IF NOT EXISTS neutralized_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS neutralize_reason       TEXT NOT NULL DEFAULT '';
ALTER TABLE cement_invoices
  ADD COLUMN IF NOT EXISTS duplicate_of_invoice_id BIGINT,
  ADD COLUMN IF NOT EXISTS neutralized_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS neutralize_reason       TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS sand_invoices_doublons_idx
  ON sand_invoices (company_id, duplicate_of_invoice_id)
  WHERE duplicate_of_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cement_invoices_doublons_idx
  ON cement_invoices (company_id, duplicate_of_invoice_id)
  WHERE duplicate_of_invoice_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- LES PAIRES DÉJÀ TRANCHÉES
--
-- Une vue, pour que le détecteur n'ait pas à reposer la question. Une paire
-- déclarée « renouvellement » ou « factures distinctes » ne doit plus
-- remonter : sans cela, la même liste de suspects réapparaîtrait à chaque
-- passage, et personne ne la lirait plus.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_paires_tranchees AS
SELECT company_id, product, invoice_a_id, invoice_b_id, verdict,
       verdict_reason, decided_by_name, decided_at,
       kept_invoice_id, neutralized_invoice_id, neutralized_at
  FROM invoice_duplicate_reviews
 WHERE verdict <> 'A_EXAMINER';

-- ─────────────────────────────────────────────────────────────────────────
-- LES DROITS
--
-- Examiner (`view`) et trancher (`validate`) sont séparés de NEUTRALISER
-- (`delete`), qui annule une facture et déplace des encaissements. Le
-- comptable constate et propose ; la direction neutralise.
--
-- Aucune action nouvelle : view, validate et delete existent au catalogue.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'direction', 'sable',  'delete', true),
      (soc.id, 'direction', 'ciment', 'delete', true),
      (soc.id, 'comptable', 'sable',  'validate', true),
      (soc.id, 'comptable', 'ciment', 'validate', true)
    ON CONFLICT (company_id, role, module_key, action)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
     WHERE role_permissions.updated_by IS NULL;
  END LOOP;
END $$;

COMMIT;
