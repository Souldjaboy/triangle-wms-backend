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
-- Migration NON destructive : uniquement des INSERT idempotents. Aucune ligne
-- n'est supprimée, aucun module existant n'est désactivé.

BEGIN;

-- Entreprises ayant déjà des données Ciment.
INSERT INTO company_modules (company_id, module_key, is_enabled, enabled, created_at, updated_at)
SELECT DISTINCT c.company_id, 'cement', TRUE, TRUE, NOW(), NOW()
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
INSERT INTO company_modules (company_id, module_key, is_enabled, enabled, created_at, updated_at)
SELECT DISTINCT s.company_id, 'sand', TRUE, TRUE, NOW(), NOW()
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

-- Une ligne présente mais désactivée par erreur bloquerait un module en service :
-- on réactive uniquement là où des données existent réellement.
UPDATE company_modules m
   SET is_enabled = TRUE, enabled = TRUE, updated_at = NOW()
 WHERE m.module_key = 'cement'
   AND m.is_enabled IS DISTINCT FROM TRUE
   AND EXISTS (SELECT 1 FROM cement_sales x WHERE x.company_id = m.company_id);

UPDATE company_modules m
   SET is_enabled = TRUE, enabled = TRUE, updated_at = NOW()
 WHERE m.module_key = 'sand'
   AND m.is_enabled IS DISTINCT FROM TRUE
   AND EXISTS (SELECT 1 FROM sand_sales x WHERE x.company_id = m.company_id);

COMMIT;
