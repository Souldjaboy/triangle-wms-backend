-- ═════════════════════════════════════════════════════════════════════════
--  DÉFAIRE 152_contrepassation_paiements_ciment.sql
--
--  cement_payment_reversals porte la trace des contre-passations faites et la
--  justification d'annulations déjà comptabilisées. La supprimer efface cette
--  justification : ne lancer ce fichier que si la table est vide, ou après
--  export.
--
--  Le module « ciment » n'est PAS supprimé : il existait avant le lot, 152 n'a
--  fait qu'ajouter deux actions à sa liste.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

DROP VIEW  IF EXISTS v_remboursements_attendus;
DROP TABLE IF EXISTS cement_payment_reversals CASCADE;

-- Index posé par 152 sur une table antérieure : il part, la table reste.
DROP INDEX IF EXISTS sand_payment_reversals_unique_idx;

UPDATE permission_modules
   SET actions = (SELECT COALESCE(array_agg(a ORDER BY a), ARRAY[]::text[])
                    FROM unnest(actions) AS a
                   WHERE a <> 'remboursement_constater'),
       updated_at = now()
 WHERE module_key = 'ciment' AND 'remboursement_constater' = ANY(actions);

-- « paiement_contrepasser » reste dans la liste : il vient du Sable, pas de
-- cette migration.

-- ─────────────────────────────────────────────────────────────────────────
-- LES DROITS RÉGLÉS À LA MAIN NE SONT PAS TOUCHÉS
--
-- Les migrations ne posaient leurs droits que « WHERE updated_by IS NULL » :
-- elles ne recouvraient jamais un réglage fait par une personne. Le retour
-- arrière applique la même règle à l'envers — il ne retire que ce qu'il a
-- posé lui-même. Un droit qu'un administrateur a modifié reste en place.
-- ─────────────────────────────────────────────────────────────────────────

DELETE FROM role_permissions
 WHERE module_key = 'ciment'
   AND action IN ('paiement_contrepasser','remboursement_constater')
   AND updated_by IS NULL;

COMMIT;
