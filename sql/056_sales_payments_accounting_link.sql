-- 056 — Encaissement des factures Ciment / Sable vers la comptabilité.
--
-- DÉJÀ APPLIQUÉE EN PRODUCTION. Ce fichier la versionne dans le dépôt : elle y
-- manquait, l'historique des migrations était donc incomplet et un nouvel
-- environnement n'aurait pas pu être reconstruit. Entièrement idempotente,
-- la rejouer ne produit aucun effet.
--
-- Rattache chaque paiement à sa destination financière (banque) et à l'écriture
-- comptable produite, et empêche qu'un même paiement génère deux transactions.

BEGIN;

ALTER TABLE cement_payments
  ADD COLUMN IF NOT EXISTS bank_id INTEGER,
  ADD COLUMN IF NOT EXISTS accounting_transaction_id INTEGER;

ALTER TABLE sand_payments
  ADD COLUMN IF NOT EXISTS bank_id INTEGER,
  ADD COLUMN IF NOT EXISTS accounting_transaction_id INTEGER;

-- Filet de sécurité en base : un paiement ne peut pas produire deux
-- encaissements comptables, même en cas de rejeu ou de requêtes concurrentes.
CREATE UNIQUE INDEX IF NOT EXISTS accounting_sales_payment_source_uidx
    ON accounting_transactions (company_id, source_type, source_id)
 WHERE source_type IN ('cement_payment', 'sand_payment');

COMMIT;
