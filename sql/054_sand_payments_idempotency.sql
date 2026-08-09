-- 054 — Clé d'idempotence sur les paiements Sable.
--
-- sand_payments n'a AUCUNE contrainte d'unicité : un double-clic, ou un client
-- qui rejoue sa requête après une réponse perdue, créerait deux paiements et
-- fausserait durablement paid_amount / remaining_amount de la facture.
--
-- On ajoute une clé d'idempotence facultative. L'unicité n'est imposée QUE
-- lorsqu'elle est fournie : les paiements existants (clé NULL) ne sont donc pas
-- concernés, et plusieurs paiements légitimes sans clé restent possibles.
--
-- Migration NON destructive : ajout de colonne + index. Aucun paiement existant
-- n'est modifié ni supprimé. Rejouable sans erreur (IF NOT EXISTS partout).

BEGIN;

ALTER TABLE sand_payments
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Index unique PARTIEL : ne s'applique qu'aux lignes ayant une clé.
-- Deux paiements distincts sur la même facture restent autorisés tant qu'ils
-- portent des clés différentes (ou aucune clé).
CREATE UNIQUE INDEX IF NOT EXISTS sand_payments_idempotency_uidx
    ON sand_payments (company_id, invoice_id, idempotency_key)
 WHERE idempotency_key IS NOT NULL;

-- Recherche du paiement rejoué : même trio, sur la table telle quelle.
CREATE INDEX IF NOT EXISTS sand_payments_invoice_idx
    ON sand_payments (company_id, invoice_id);

COMMIT;
