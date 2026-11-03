-- ════════════════════════════════════════════════════════════════════════
-- 164 — LES PRÉSENTATIONS
--
-- Une présentation se range dans la bibliothèque comme une création : son
-- plan vit dans `studio_documents.design`, à côté du fichier. La différence
-- est que ce plan contient PLUSIEURS diapositives, et que le fichier déposé
-- est un PDF d'autant de pages, non une image.
--
-- POURQUOI UNE COLONNE PLUTÔT QU'UNE CONVENTION SUR design_format.
--
-- Sans elle, la liste du studio graphique — « tout document ayant un
-- design » — ramasserait les présentations, et la liste des présentations
-- ramasserait les cartes de visite. On pourrait le deviner en lisant
-- design_format, mais une convention sur le contenu d'un texte se perd : le
-- premier qui écrit « 16/9 » au lieu de « presentation-16-9 » casse les deux
-- listes sans qu'aucune erreur ne se produise.
--
-- La contrainte ci-dessous rend l'information vérifiable par la base, et la
-- reprise des lignes existantes est explicite : tout ce qui portait un
-- design avant cette migration est une création du studio graphique.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE studio_documents
  ADD COLUMN IF NOT EXISTS design_kind TEXT NOT NULL DEFAULT 'CREATION';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'studio_documents_design_kind_chk'
  ) THEN
    ALTER TABLE studio_documents
      ADD CONSTRAINT studio_documents_design_kind_chk
      CHECK (design_kind IN ('CREATION', 'PRESENTATION'));
  END IF;
END $$;

/* Les lignes d'avant : toutes des créations, par construction — les
   présentations n'existaient pas. */
UPDATE studio_documents
   SET design_kind = 'CREATION'
 WHERE design IS NOT NULL AND design_kind IS DISTINCT FROM 'CREATION';

/* Les deux listes interrogent « les documents qui ont un plan, de telle
   sorte » : l'index porte donc sur les trois colonnes ensemble. */
DROP INDEX IF EXISTS studio_documents_creations_idx;
CREATE INDEX IF NOT EXISTS studio_documents_plans_idx
  ON studio_documents (company_id, design_kind, updated_at DESC)
  WHERE design IS NOT NULL AND trashed_at IS NULL;

COMMENT ON COLUMN studio_documents.design_kind IS
  'CREATION : une planche du studio graphique, un seul visuel. '
  'PRESENTATION : un jeu de diapositives. Sert à séparer les deux listes.';
