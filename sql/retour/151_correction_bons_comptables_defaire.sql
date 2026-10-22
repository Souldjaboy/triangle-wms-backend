-- ═════════════════════════════════════════════════════════════════════════
--  DÉFAIRE 151_correction_bons_comptables.sql
--
--  cash_voucher_history est le journal des corrections de bons. Les colonnes
--  cancelled_* de cash_vouchers portent le motif des annulations faites : les
--  retirer laisse des bons annulés sans explication.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

DROP VIEW  IF EXISTS v_bons_incoherents;
DROP TABLE IF EXISTS cash_voucher_history CASCADE;

DROP INDEX IF EXISTS cash_vouchers_annules_idx;

ALTER TABLE cash_vouchers
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS cancelled_by,
  DROP COLUMN IF EXISTS cancelled_by_name,
  DROP COLUMN IF EXISTS cancel_reason;

-- ─────────────────────────────────────────────────────────────────────────
-- LES DROITS RÉGLÉS À LA MAIN NE SONT PAS TOUCHÉS
--
-- Les migrations ne posaient leurs droits que « WHERE updated_by IS NULL » :
-- elles ne recouvraient jamais un réglage fait par une personne. Le retour
-- arrière applique la même règle à l'envers — il ne retire que ce qu'il a
-- posé lui-même. Un droit qu'un administrateur a modifié reste en place.
-- ─────────────────────────────────────────────────────────────────────────

DELETE FROM role_permissions
 WHERE module_key = 'comptabilite.bon' AND updated_by IS NULL;

DELETE FROM permission_modules
 WHERE module_key = 'comptabilite.bon'
   AND NOT EXISTS (SELECT 1 FROM role_permissions WHERE module_key = 'comptabilite.bon')
   AND NOT EXISTS (SELECT 1 FROM user_permission_overrides WHERE module_key = 'comptabilite.bon');

COMMIT;
