-- ═════════════════════════════════════════════════════════════════════════
--  DÉFAIRE 158_doublons_factures.sql
--
--  ATTENTION : invoice_duplicate_reviews porte les VERDICTS rendus. Les
--  perdre, c'est rouvrir tous les dossiers déjà tranchés — et risquer qu'on
--  reprenne la question « ces douze factures mensuelles sont-elles des
--  doublons ? » depuis le début.
--
--  Les factures NEUTRALISÉES ne sont PAS rétablies ici : elles ont été
--  annulées, leurs encaissements déplacés. Défaire cela demanderait
--  d'annuler les réaffectations une par une, décision par décision. Le
--  script de retour l'exporte et le signale.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

DROP VIEW  IF EXISTS v_paires_tranchees;
DROP TABLE IF EXISTS invoice_duplicate_reviews CASCADE;

DROP INDEX IF EXISTS sand_invoices_doublons_idx;
DROP INDEX IF EXISTS cement_invoices_doublons_idx;

ALTER TABLE sand_invoices
  DROP COLUMN IF EXISTS duplicate_of_invoice_id,
  DROP COLUMN IF EXISTS neutralized_at,
  DROP COLUMN IF EXISTS neutralize_reason;
ALTER TABLE cement_invoices
  DROP COLUMN IF EXISTS duplicate_of_invoice_id,
  DROP COLUMN IF EXISTS neutralized_at,
  DROP COLUMN IF EXISTS neutralize_reason;

/* Les droits « validate » et « delete » sur sable et ciment ne sont PAS
   retirés : ils existaient avant ce lot pour d'autres usages, et 158 n'a fait
   que les accorder à des rôles qui ne les avaient pas. Les retirer casserait
   des gestes sans rapport. */

COMMIT;
