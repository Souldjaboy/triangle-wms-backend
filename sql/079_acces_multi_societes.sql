-- 079 — UN COMPTE, PLUSIEURS SOCIÉTÉS, SANS DOUBLON DE COMPTE
--
-- Le comptable et le directeur travaillent pour Triangle ET pour FAT & MAT.
-- Aujourd'hui, `services/company-context.js:societesAutorisees()` ne laisse
-- basculer que le `super_admin` ; tout autre compte est enfermé dans son seul
-- `users.company_id`. Il n'existe aucune table d'accès multi-sociétés.
--
-- Sans elle, il n'y a que deux issues, toutes deux mauvaises :
--   • créer un second compte « Fofana FAT & MAT » — deux mots de passe, deux
--     journaux d'audit, deux jeux de droits qui divergent en silence ;
--   • élever ces comptes en super_admin — qui donne bien plus que la bascule.
--
-- On introduit donc l'habilitation explicite : une ligne par (compte,
-- société). La société d'origine (`users.company_id`) reste acquise sans
-- ligne ; cette table ne fait qu'AJOUTER des sociétés accessibles.
--
-- Ce qu'elle ne fait PAS : elle n'accorde aucun droit métier. Une fois dans
-- FAT & MAT, le compte est soumis au même moteur RBAC (`role_permissions`,
-- `user_permission_overrides`), évalué avec le `company_id` effectif. Un
-- accès n'est donc pas un passe-droit : c'est la permission d'aller voir,
-- pas celle de tout faire une fois arrivé.
--
-- Additive et idempotente. Aucune donnée existante n'est modifiée : sans
-- ligne insérée, le comportement reste exactement celui d'avant.

BEGIN;

CREATE TABLE IF NOT EXISTS user_company_access (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  /* Pourquoi ce compte voit cette société — lisible en audit des mois plus
     tard, quand personne ne se souvient de la décision. */
  reason      TEXT NOT NULL DEFAULT '',
  granted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* Une seule ligne par couple : accorder deux fois le même accès ne doit pas
   créer un doublon que la révocation oublierait ensuite à moitié. */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_company_access_user_company_key') THEN
    ALTER TABLE user_company_access
      ADD CONSTRAINT user_company_access_user_company_key UNIQUE (user_id, company_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_company_access_user
  ON user_company_access (user_id) WHERE active;

-- ═════════════════════════════════════════════════════════════════════════
-- JOURNAL DES HABILITATIONS
--
-- Séparé de la table d'état : révoquer un accès efface la ligne active, mais
-- pas le fait qu'il a existé. « Qui pouvait voir FAT & MAT en septembre ? »
-- doit rester une question à laquelle la base sait répondre.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_company_access_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  company_id  INTEGER NOT NULL,
  action      TEXT NOT NULL,          -- 'accorde' | 'revoque' | 'reactive'
  reason      TEXT NOT NULL DEFAULT '',
  performed_by      INTEGER,
  performed_by_name TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_company_access_log_action_check') THEN
    ALTER TABLE user_company_access_log
      ADD CONSTRAINT user_company_access_log_action_check
      CHECK (action IN ('accorde', 'revoque', 'reactive'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_company_access_log_user
  ON user_company_access_log (user_id, created_at DESC);

-- ═════════════════════════════════════════════════════════════════════════
-- LE MODULE QUI REND CET ÉCRAN OPPOSABLE
--
-- Sans entrée au catalogue, `decider()` ne trouve pas la clé, remonte à
-- `utilisateur` puis retombe sur le rôle : l'écran serait ouvert à tout
-- administrateur. Accorder l'accès d'un compte à une autre société est une
-- opération sensible ; elle mérite sa propre case.
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO permission_modules (module_key, parent_key, label, description, sort_order, is_active, is_system, actions)
VALUES ('utilisateur.acces_societes', 'utilisateur', 'Accès multi-sociétés',
        'Autoriser un compte à basculer vers une autre société sans créer de second compte.',
        420, true, false, ARRAY['visible','view','manage','audit'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      label = EXCLUDED.label,
      updated_at = now();

INSERT INTO permission_actions (action_key, label, description, sort_order, is_write) VALUES
  ('manage', 'Gérer', 'Modifier la configuration de ce module.', 170, true)
ON CONFLICT (action_key) DO NOTHING;

COMMIT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='user_company_access') THEN
    RAISE EXCEPTION '079 : user_company_access absente après migration.';
  END IF;
  RAISE NOTICE 'Accès multi-sociétés : table, journal et module de droits en place.';
END $$;
