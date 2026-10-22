-- ═════════════════════════════════════════════════════════════════════════
--  DÉFAIRE 150_transferts_internes_de_fonds.sql
--
--  C'EST LE SEUL DES CINQ QUI MÉRITE UNE HÉSITATION.
--
--  show_in_financial_movements est la colonne qui empêche un transfert interne
--  d'être compté comme une recette ou une dépense. Si des transferts ont été
--  enregistrés, retirer cette colonne les fait RÉAPPARAÎTRE dans les mouvements
--  financiers : le résultat de l'entreprise s'en trouve faussé, à la hausse
--  comme à la baisse, du montant de chaque transfert.
--
--  « retour-base.sh » refuse donc ce fichier tant que internal_fund_transfers
--  contient une ligne non annulée, sauf ordre explicite de votre part.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

DROP VIEW IF EXISTS v_transferts_internes_candidats;

-- D'abord la contrainte qui lie accounting_transactions aux transferts, sinon
-- la suppression de la table échouerait.
ALTER TABLE accounting_transactions
  DROP CONSTRAINT IF EXISTS accounting_transactions_transfert_fkey;

DROP TABLE IF EXISTS internal_fund_transfers CASCADE;

DROP INDEX IF EXISTS accounting_transactions_mouvements_idx;
DROP INDEX IF EXISTS accounting_transactions_transfert_idx;
DROP INDEX IF EXISTS accounting_transactions_annulees_idx;

ALTER TABLE accounting_transactions
  DROP COLUMN IF EXISTS show_in_financial_movements,
  DROP COLUMN IF EXISTS is_internal_transfer,
  DROP COLUMN IF EXISTS internal_transfer_id;

-- ─────────────────────────────────────────────────────────────────────────
-- LES DROITS RÉGLÉS À LA MAIN NE SONT PAS TOUCHÉS
--
-- Les migrations ne posaient leurs droits que « WHERE updated_by IS NULL » :
-- elles ne recouvraient jamais un réglage fait par une personne. Le retour
-- arrière applique la même règle à l'envers — il ne retire que ce qu'il a
-- posé lui-même. Un droit qu'un administrateur a modifié reste en place.
-- ─────────────────────────────────────────────────────────────────────────

DELETE FROM role_permissions
 WHERE module_key = 'comptabilite.transfert_interne' AND updated_by IS NULL;

DELETE FROM permission_modules
 WHERE module_key = 'comptabilite.transfert_interne'
   AND NOT EXISTS (SELECT 1 FROM role_permissions WHERE module_key = 'comptabilite.transfert_interne')
   AND NOT EXISTS (SELECT 1 FROM user_permission_overrides WHERE module_key = 'comptabilite.transfert_interne');

COMMIT;
