-- 060a — LES COLONNES PHYSIQUES DES EMPLACEMENTS
--
-- Ces cinq colonnes étaient créées à l'intérieur de `061a`, au milieu d'une
-- migration de CONSOLIDATION qui exige deux variables psql et refuse de
-- s'exécuter s'il n'y a rien à consolider.
--
-- Trois migrations en dépendent pourtant — 061, 064 et 065 — et deux d'entre
-- elles s'exécutent AVANT 061a dans l'ordre alphabétique : « 061_ » passe
-- avant « 061a_ », le tiret bas précédant la lettre « a ». Sur une base
-- neuve, la chaîne cassait donc systématiquement sur
-- « column "is_active" does not exist », sans rapport apparent avec la cause.
--
-- La création des colonnes est séparée ici de la consolidation des données :
-- créer une colonne est additif, sans condition et rejouable ; consolider des
-- lignes est une opération ponctuelle qui demande des paramètres et un état
-- de départ. Les mêmes `ADD COLUMN IF NOT EXISTS` restent dans 061a, où ils
-- ne coûtent rien : une base déjà migrée ne les rejoue pas.
--
-- Strictement additive et idempotente. Aucune donnée n'est lue ni écrite.

BEGIN;

ALTER TABLE locations
  /* Un emplacement retiré de la circulation sans être supprimé : les
     mouvements et les balances qui le citent restent lisibles. */
  ADD COLUMN IF NOT EXISTS is_active               BOOLEAN DEFAULT TRUE,
  /* Libre, occupé, partiellement occupé — recalculé par le moteur de stock. */
  ADD COLUMN IF NOT EXISTS occupancy_status        TEXT DEFAULT 'EMPTY',
  /* Le chemin complet « Entrepôt-Rayon-Étagère-Niveau-Bac », qui identifie un
     bac d'un seul coup d'œil et sert de clé d'unicité. */
  ADD COLUMN IF NOT EXISTS full_code               TEXT,
  /* Deux lignes pour un seul bac physique : la survivante reçoit le stock, la
     doublonne pointe vers elle plutôt que d'être effacée. */
  ADD COLUMN IF NOT EXISTS merged_into_location_id INTEGER,
  ADD COLUMN IF NOT EXISTS merged_at               TIMESTAMP;

COMMIT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'locations' AND column_name = 'is_active'
  ) THEN
    RAISE EXCEPTION 'locations.is_active est absente : 061, 064 et 065 échoueraient.';
  END IF;
  RAISE NOTICE 'Colonnes physiques des emplacements en place.';
END $$;
