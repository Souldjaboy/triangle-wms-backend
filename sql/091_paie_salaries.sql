-- 091 — PAIE : IDENTITÉ D'UN SALARIÉ
--
-- Numérotée 091 et non 065 : le numéro 065 est déjà pris par
-- `065_reaffirmation_catalogue_badges.sql` sur la branche pointage/paie. Deux
-- migrations portant le même numéro rendent l'ordre d'application ambigu et
-- empêchent de dire, après coup, laquelle a tourné. 091 est libre au-dessus de
-- tout ce qui existe des deux côtés (le plus haut occupé est 090).
--
-- Strictement ADDITIVE et IDEMPOTENTE. Deux colonnes nullables, rien d'autre :
-- aucune table créée, aucune colonne retirée, aucune donnée réécrite, aucun
-- salaire ni historique de paie touché.
--
-- POURQUOI CES DEUX COLONNES
--
-- Le formulaire « Ajouter un salarié » demande une FONCTION (« magasinier
-- livreur », « chauffeur ») et une DATE D'ENTRÉE. Ni l'une ni l'autre n'existe
-- dans `users`.
--
-- `users.role` ne peut pas servir de fonction : c'est le rôle RBAC, celui qui
-- décide de ce que le compte a le droit de faire. Y écrire « chauffeur »
-- donnerait à ce salarié un rôle inconnu du moteur de droits, qui retomberait
-- sur le repli par rôle — c'est-à-dire sur rien, ou sur tout selon les écrans.
-- La fonction affichée et le rôle applicatif sont deux choses différentes, et
-- les confondre se paierait en droits mal attribués.
--
-- `hire_date` est la date d'entrée déclarée par la paie. Elle ne remplace pas
-- `created_at`, qui reste la date de création de la fiche en base : un salarié
-- entré en mars peut être saisi en septembre.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS job_title TEXT,
  ADD COLUMN IF NOT EXISTS hire_date DATE;

/* Retrouver les salariés d'une entreprise, actifs d'abord : c'est l'accès de
   l'écran de préparation de la paie. */
CREATE INDEX IF NOT EXISTS users_company_active_idx
  ON users (company_id, is_active);
