-- 050 — Colonne dédiée voucher_number (numéro de bon BD). Idempotent.
-- Remplace l'extraction par regex depuis disbursement_comment : le commentaire
-- redevient un simple commentaire, voucher_number est la SOURCE DE VÉRITÉ.

ALTER TABLE disbursement_requests ADD COLUMN IF NOT EXISTS voucher_number VARCHAR(40);

-- Migration des numéros BD déjà présents dans le commentaire (sans rien casser).
UPDATE disbursement_requests
   SET voucher_number = substring(disbursement_comment from 'BD-[0-9]{6}-[0-9]{3}')
 WHERE voucher_number IS NULL
   AND disbursement_comment ~ 'BD-[0-9]{6}-[0-9]{3}';

-- Unicité par entreprise (les demandes non décaissées restent à NULL).
CREATE UNIQUE INDEX IF NOT EXISTS uidx_disbursement_voucher
  ON disbursement_requests (company_id, voucher_number)
  WHERE voucher_number IS NOT NULL;
