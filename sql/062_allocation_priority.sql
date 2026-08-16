-- 062 — Ordre de rangement des produits à répartir.
--
-- Le magasinier traite les 99 942 unités restantes progressivement. L'ordre
-- dans lequel il veut les ranger lui appartient : il doit survivre à un
-- rechargement, pas vivre dans l'écran.
--
-- Migration ADDITIVE et idempotente. Elle ne touche AUCUN stock : une priorité
-- n'est qu'un rang d'affichage.

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS allocation_priority INTEGER;

/* Tri par priorité puis par stock décroissant : un produit sans priorité
   reste visible, il passe simplement après ceux qui en ont une. */
CREATE INDEX IF NOT EXISTS products_allocation_priority_idx
    ON products (company_id, allocation_priority)
 WHERE allocation_priority IS NOT NULL;

COMMIT;
