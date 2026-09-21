-- 090 — QUI A LIVRÉ N'EST PAS QUI A SAISI
--
-- Sur un bon de livraison de sable, `delivered_by` reçoit ceci
-- (routes/sand-sales.js) :
--
--     const author = userRow?.fullname || req.user.email || "Utilisateur";
--     … INSERT INTO sand_deliveries(… delivered_by …) VALUES(… author …)
--
-- Autrement dit : le nom imprimé sous « Livré par » est celui de la personne
-- CONNECTÉE au moment où le bon a été enregistré. Un stagiaire qui saisit les
-- bons depuis le bureau voit donc son nom signer des livraisons qu'il n'a
-- jamais faites — et le client, lui, lit ce nom comme celui du livreur.
--
-- C'est exactement ce qui est arrivé chez FAT & MAT : les bons portent
-- « Djoulédé Traoré », qui saisissait, au lieu du livreur réel.
--
-- Deux choses sont nécessaires, et une seule ne suffirait pas :
--
--   1. corriger les bons déjà enregistrés — c'est le travail du script
--      `scripts/corriger-livreur-bons-livraison.js`, avec --preview et
--      --apply, parce qu'il touche des documents déjà imprimés ;
--
--   2. empêcher que cela recommence — c'est l'objet de cette migration.
--
-- On n'écrit PAS « Issa Diallo » dans le code. Un nom en dur dans une source
-- est faux le jour où la personne change de poste, et il faudrait alors un
-- déploiement pour imprimer un bon correctement. Le livreur devient donc un
-- RÉGLAGE de la société, modifiable sans toucher au code, et les routes de
-- création s'en servent à défaut d'une valeur saisie.
--
-- Additive et idempotente. Sans valeur renseignée, le comportement reste
-- exactement celui d'avant.

BEGIN;

ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS default_delivered_by TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN company_settings.default_delivered_by IS
  'Nom imprimé sous « Livré par » sur les bons de livraison, à défaut d''une valeur saisie à la main. Vide = on retombe sur l''auteur de la saisie, comportement historique.';

COMMIT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'company_settings'
                    AND column_name = 'default_delivered_by') THEN
    RAISE EXCEPTION '090 : sans ce réglage, le nom du livreur resterait celui de qui saisit.';
  END IF;
  RAISE NOTICE 'Bons de livraison : le livreur par défaut est désormais un réglage de société, pas un nom codé en dur.';
END $$;
