-- 053 — Les modules Vente de ciment / Vente de sable deviennent configurables.
--
-- AVANT : l'accès au Sable était décidé par « if (companyId !== 5) » dans
-- routes/sand-sales.js, et le Ciment n'avait aucune restriction d'entreprise.
-- APRÈS : les deux passent par company_modules + RBAC. Il faut donc que les
-- entreprises qui utilisent DÉJÀ ces modules gardent leur accès.
--
-- Aucun identifiant d'entreprise n'est écrit en dur : on active le module pour
-- les entreprises qui possèdent déjà des données de ce module. Sur un
-- environnement neuf, rien n'est activé — c'est le comportement voulu, un
-- administrateur active ensuite le module depuis l'écran Modules.
--
-- RÈGLE : cette migration ne fait que CRÉER des lignes manquantes.
--   - ligne absente + données du module  -> création avec is_enabled = TRUE
--   - ligne déjà présente                -> laissée telle quelle, quelle que
--                                           soit sa valeur
-- Elle ne réactive donc JAMAIS un module qu'un administrateur a volontairement
-- désactivé, et ne désactive jamais rien. Migration NON destructive et
-- rejouable : aucune ligne supprimée, aucune valeur existante modifiée.
--
-- Schéma company_modules (production) : id, company_id, module_key, is_enabled,
-- updated_by, created_at, updated_at. Il n'existe pas de colonne « enabled ».

BEGIN;

-- Entreprises ayant déjà des données Ciment.
INSERT INTO company_modules (company_id, module_key, is_enabled, created_at, updated_at)
SELECT DISTINCT c.company_id, 'cement', TRUE, NOW(), NOW()
  FROM (
        SELECT company_id FROM cement_products
        UNION SELECT company_id FROM cement_customers
        UNION SELECT company_id FROM cement_sales
        UNION SELECT company_id FROM cement_prices
       ) c
 WHERE c.company_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM companies co WHERE co.id = c.company_id)
   AND NOT EXISTS (
         SELECT 1 FROM company_modules m
          WHERE m.company_id = c.company_id AND m.module_key = 'cement'
       );

-- Entreprises ayant déjà des données Sable.
INSERT INTO company_modules (company_id, module_key, is_enabled, created_at, updated_at)
SELECT DISTINCT s.company_id, 'sand', TRUE, NOW(), NOW()
  FROM (
        SELECT company_id FROM sand_products
        UNION SELECT company_id FROM sand_customers
        UNION SELECT company_id FROM sand_sales
        UNION SELECT company_id FROM sand_prices
       ) s
 WHERE s.company_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM companies co WHERE co.id = s.company_id)
   AND NOT EXISTS (
         SELECT 1 FROM company_modules m
          WHERE m.company_id = s.company_id AND m.module_key = 'sand'
       );

COMMIT;
