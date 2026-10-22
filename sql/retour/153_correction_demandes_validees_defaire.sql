-- ═════════════════════════════════════════════════════════════════════════
--  DÉFAIRE 153_correction_demandes_validees.sql
--
--  ATTENTION : les colonnes retirées de stock_requests et stock_movements
--  portent l'historique des corrections DÉJÀ FAITES. Si des corrections ont
--  été enregistrées, « retour-base.sh » les exporte d'abord ; sans cet export,
--  l'information est perdue.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

DROP VIEW  IF EXISTS v_demandes_incoherentes;
DROP TABLE IF EXISTS stock_request_corrections CASCADE;

ALTER TABLE stock_movements
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS cancelled_by,
  DROP COLUMN IF EXISTS cancel_reason,
  DROP COLUMN IF EXISTS reverses_movement_id;

ALTER TABLE stock_requests
  DROP COLUMN IF EXISTS cancel_reason,
  DROP COLUMN IF EXISTS cancelled_by_name,
  DROP COLUMN IF EXISTS last_correction_at,
  DROP COLUMN IF EXISTS last_correction_by,
  DROP COLUMN IF EXISTS corrections_count;

-- Retirer « contrepasser » de la liste d'actions du module « demande », qui
-- existait AVANT le lot : on le remet dans l'état où 153 l'a trouvé, sans
-- toucher aux autres actions qui auraient pu y être ajoutées depuis.
UPDATE permission_modules
   SET actions = (SELECT COALESCE(array_agg(a ORDER BY a), ARRAY[]::text[])
                    FROM unnest(actions) AS a WHERE a <> 'contrepasser'),
       updated_at = now()
 WHERE module_key = 'demande' AND 'contrepasser' = ANY(actions);

-- ─────────────────────────────────────────────────────────────────────────
-- LES DROITS RÉGLÉS À LA MAIN NE SONT PAS TOUCHÉS
--
-- Les migrations ne posaient leurs droits que « WHERE updated_by IS NULL » :
-- elles ne recouvraient jamais un réglage fait par une personne. Le retour
-- arrière applique la même règle à l'envers — il ne retire que ce qu'il a
-- posé lui-même. Un droit qu'un administrateur a modifié reste en place.
-- ─────────────────────────────────────────────────────────────────────────

DELETE FROM role_permissions
 WHERE module_key = 'demande' AND action = 'contrepasser' AND updated_by IS NULL;

COMMIT;
