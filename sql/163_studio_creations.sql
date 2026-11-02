-- ═════════════════════════════════════════════════════════════════════════
--  163 — LES CRÉATIONS GRAPHIQUES
--
--  LE DOCUMENT EST L'IMAGE, PAS LE PLAN.
--
--  Une carte de visite, un badge, un certificat : ce qu'on partage, ce qu'on
--  imprime, ce qu'on envoie, c'est l'IMAGE. Si le document rangé était le
--  plan de la mise en page, personne n'en verrait rien : ni aperçu dans la
--  bibliothèque, ni pièce jointe utilisable, ni impression.
--
--  Le document est donc une image ordinaire — elle se cherche, se partage,
--  se signe, se verse dans un PDF comme n'importe quelle autre — et elle
--  PORTE SON PLAN, pour qu'on puisse la rouvrir et la modifier.
--
--  Deux colonnes sur la table existante, pas une table de plus : un plan
--  sans son image n'a pas de sens, et les séparer ferait deux choses à tenir
--  en accord.
--
--  ADDITIVE. Aucune table existante n'est modifiée dans sa structure.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE studio_documents
  /* Le plan : les éléments, leurs positions, leurs styles. NULL pour tout
     ce qui n'est pas une création — un scan n'a pas de plan. */
  ADD COLUMN IF NOT EXISTS design JSONB,
  /* Le format physique voulu, en millimètres, et son nom. C'est ce qui
     permet d'exporter un PDF aux VRAIES dimensions : une carte de visite
     imprimée à 90 % n'entre plus dans un porte-cartes. */
  ADD COLUMN IF NOT EXISTS design_format TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS design_mm_width  NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS design_mm_height NUMERIC(8,2);

/* Un plan n'existe qu'avec ses dimensions : sans elles, on ne saurait pas à
   quelle taille imprimer, et le PDF produit serait faux. */
ALTER TABLE studio_documents
  DROP CONSTRAINT IF EXISTS studio_documents_design_chk;
ALTER TABLE studio_documents
  ADD CONSTRAINT studio_documents_design_chk CHECK (
    design IS NULL OR (design_mm_width > 0 AND design_mm_height > 0)
  );

/* Retrouver ses créations sans parcourir toute la bibliothèque. */
CREATE INDEX IF NOT EXISTS studio_documents_creations_idx
  ON studio_documents (company_id, updated_at DESC)
  WHERE design IS NOT NULL AND trashed_at IS NULL;

COMMIT;
