-- 066 — SE CONNECTER PAR EMAIL OU PAR TÉLÉPHONE
--
-- `users.email` était UNIQUE NOT NULL. Tout le monde n'a pas d'adresse : pour
-- créer un magasinier qui n'a qu'un téléphone, le code fabriquait une fausse
-- adresse en « @pending.trianglewmspro.local ». Une adresse inventée ne reçoit
-- rien, ne vérifie rien, et occupe une place unique dans la table.
--
-- Cette migration rend l'email facultatif, donne au téléphone une forme
-- normalisée unique — le même numéro s'écrit de cinq façons — et laisse au
-- super-administrateur le choix d'exiger ou non une vérification.
--
-- Strictement additive et idempotente : aucune colonne retirée, aucun compte
-- modifié dans son mot de passe, aucun compte existant rendu non vérifié.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. L'EMAIL DEVIENT FACULTATIF
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

/* La contrainte UNIQUE d'origine porte sur la colonne entière : deux comptes
   sans email — donc deux chaînes vides — se heurtaient. On la remplace par un
   index partiel qui ignore l'absence d'adresse et compare sans la casse.
   Le nom de la contrainte varie selon l'âge de la base : on la retrouve par
   sa forme plutôt que de parier sur « users_email_key ». */
DO $$
DECLARE nom text;
BEGIN
  FOR nom IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'users' AND c.contype = 'u'
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
              FROM unnest(c.conkey) k
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k)
           = ARRAY['email']::text[]
  LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', nom);
    RAISE NOTICE 'Contrainte % retirée au profit d''un index partiel.', nom;
  END LOOP;
END $$;

/* Les adresses de remplissage fabriquées par l'ancien code ne sont pas des
   adresses : elles ne doivent ni occuper l'unicité, ni servir d'identifiant. */
UPDATE users
   SET email = NULL
 WHERE email IS NOT NULL
   AND lower(email) LIKE '%@pending.trianglewmspro.local';

UPDATE users SET email = NULL WHERE btrim(COALESCE(email, '')) = '';

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_reel
  ON users (lower(email))
  WHERE email IS NOT NULL AND btrim(email) <> '';

-- ═════════════════════════════════════════════════════════════════════════
-- 2. LE TÉLÉPHONE DEVIENT UN IDENTIFIANT FIABLE
--
-- Forme normalisée : « +223XXXXXXXX ». Sans elle, « 76 32 77 99 » et
-- « +22376327799 » sont deux comptes différents, et la personne qui se
-- connecte avec l'écriture qu'elle n'a pas utilisée reste dehors.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_normalise text;

/* Même règle que `services/identifiants.js`, écrite une fois en SQL pour
   reprendre l'existant. Un numéro trop court ou trop long reste NULL : on ne
   devine pas un numéro à moitié. */
WITH chiffres AS (
  SELECT id,
         CASE
           WHEN btrim(COALESCE(phone, '')) = '' THEN NULL
           WHEN phone LIKE '+%' THEN regexp_replace(phone, '[^0-9]', '', 'g')
           WHEN regexp_replace(phone, '[^0-9]', '', 'g') LIKE '00%'
             THEN substr(regexp_replace(phone, '[^0-9]', '', 'g'), 3)
           WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) = 8
             THEN '223' || regexp_replace(phone, '[^0-9]', '', 'g')
           ELSE regexp_replace(phone, '[^0-9]', '', 'g')
         END AS n
    FROM users
),
retenus AS (
  SELECT id, '+' || n AS normalise
    FROM chiffres
   WHERE n IS NOT NULL AND length(n) BETWEEN 8 AND 15
)
UPDATE users u
   SET phone_normalise = r.normalise
  FROM retenus r
 WHERE r.id = u.id
   AND u.phone_normalise IS DISTINCT FROM r.normalise;

/* Un numéro ne doit jamais désigner deux personnes. Les doublons hérités —
   s'il y en a — empêcheraient la création de l'index : on les signale sans
   rien supprimer, et l'index n'est posé que si la voie est libre. */
DO $$
DECLARE doublons int;
BEGIN
  SELECT count(*) INTO doublons FROM (
    SELECT phone_normalise FROM users
     WHERE phone_normalise IS NOT NULL
     GROUP BY phone_normalise HAVING count(*) > 1
  ) d;

  IF doublons > 0 THEN
    RAISE WARNING 'Index d''unicité du téléphone non posé : % numéro(s) déjà partagé(s) par plusieurs comptes. Corrigez-les puis rejouez 066.', doublons;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS users_phone_normalise_unique
      ON users (phone_normalise)
      WHERE phone_normalise IS NOT NULL;
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. LA VÉRIFICATION DEVIENT UN CHOIX EXPLICITE
--
-- `verification_required` existe depuis 027 et vaut `false` par défaut sur
-- beaucoup de comptes : s'en servir pour dispenser de vérification ouvrirait
-- d'un coup des comptes que personne n'a examinés. On ajoute donc un réglage
-- neuf, vide pour tout l'existant, qui ne dispense que ce qu'un
-- super-administrateur a explicitement dispensé. NULL = comportement actuel.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_mode text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_verification_mode_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_verification_mode_check
      CHECK (verification_mode IS NULL OR verification_mode IN ('none', 'email', 'phone'));
  END IF;
END $$;

/* Qui a dispensé, et quand : une exemption sans trace n'est pas vérifiable. */
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS verification_mode_set_by integer,
  ADD COLUMN IF NOT EXISTS verification_mode_set_at timestamptz;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. RECHERCHE PAR IDENTIFIANT
-- ═════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS users_email_recherche
  ON users (lower(email)) WHERE email IS NOT NULL;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'email' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'users.email est toujours NOT NULL : la création sans email resterait impossible.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'phone_normalise'
  ) THEN
    RAISE EXCEPTION 'La colonne phone_normalise est absente.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'users_email_unique_reel') THEN
    RAISE EXCEPTION 'L''unicité des adresses réelles n''est pas garantie.';
  END IF;

  RAISE NOTICE 'Connexion par email ou téléphone : schéma conforme.';
END $$;
