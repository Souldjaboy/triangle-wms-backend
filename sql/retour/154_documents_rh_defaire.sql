-- ═════════════════════════════════════════════════════════════════════════
--  DÉFAIRE 154_documents_rh.sql
--
--  À n'exécuter qu'après avoir exporté le contenu. « retour-base.sh
--  defaire-ajouts » s'en charge et refuse d'aller plus loin si l'export a
--  échoué.
--
--  Ce fichier ne touche QUE ce que 154 a créé. Les tables rh_* de la V16, les
--  salariés, les salaires et les bulletins déjà émis ne sont pas concernés.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

DROP TABLE IF EXISTS hr_documents        CASCADE;
DROP TABLE IF EXISTS hr_contract_clauses CASCADE;
DROP TABLE IF EXISTS hr_contracts        CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- LES DROITS RÉGLÉS À LA MAIN NE SONT PAS TOUCHÉS
--
-- Les migrations ne posaient leurs droits que « WHERE updated_by IS NULL » :
-- elles ne recouvraient jamais un réglage fait par une personne. Le retour
-- arrière applique la même règle à l'envers — il ne retire que ce qu'il a
-- posé lui-même. Un droit qu'un administrateur a modifié reste en place.
-- ─────────────────────────────────────────────────────────────────────────

DELETE FROM role_permissions
 WHERE module_key = 'rh.document' AND updated_by IS NULL;

-- Le module ne part que si plus aucun droit ne le vise : sinon la clé
-- étrangère refuserait, et surtout cela voudrait dire qu'une personne a réglé
-- quelque chose dessus.
DELETE FROM permission_modules
 WHERE module_key = 'rh.document'
   AND NOT EXISTS (SELECT 1 FROM role_permissions WHERE module_key = 'rh.document')
   AND NOT EXISTS (SELECT 1 FROM user_permission_overrides WHERE module_key = 'rh.document');

-- permission_actions est un catalogue partagé : on n'y supprime rien. Une
-- action inutilisée ne gêne personne, alors qu'une action supprimée casserait
-- la clé étrangère d'une ligne de droits posée à la main.

COMMIT;
