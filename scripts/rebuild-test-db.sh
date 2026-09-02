#!/usr/bin/env bash
#
# RECONSTRUIRE LA BASE DE TEST, DEPUIS RIEN.
#
# Une base de test qui ne se reconstruit pas d'un seul geste finit par
# accumuler des correctifs appliqués à la main que personne ne retrouve. Ce
# script part d'une base vide et applique TOUTES les migrations du dépôt, dans
# l'ordre, en s'arrêtant à la première erreur.
#
#   bash scripts/rebuild-test-db.sh
#
# Réglages, tous surchargeables par l'environnement :
#   PGCONTAINER   conteneur Docker             (défaut : triangle-postgres-test)
#   PGHOST_TEST   hôte                          (défaut : 127.0.0.1)
#   PGPORT_TEST   port                          (défaut : 5433)
#   PGUSER_TEST   super-utilisateur             (défaut : postgres)
#   PGDB_TEST     base à reconstruire           (défaut : triangle_wms)
#   FIXTURES      charger le jeu minimal        (défaut : 1)
#   PGPASSWORD_TEST  mot de passe, exigé seulement si psql est utilisé en local
#
# GARDE-FOU : ce script REFUSE de travailler ailleurs que sur une base de test.
# Il ignore délibérément DATABASE_URL — la variable qui, sur un serveur, pointe
# vers la production.

set -Eeuo pipefail

cd "$(dirname "$0")/.."

CONTENEUR="${PGCONTAINER:-triangle-postgres-test}"
HOTE="${PGHOST_TEST:-127.0.0.1}"
PORT="${PGPORT_TEST:-5433}"
SUPER="${PGUSER_TEST:-postgres}"
BASE="${PGDB_TEST:-triangle_wms}"
AVEC_FIXTURES="${FIXTURES:-1}"

rouge()  { printf '\033[31m%s\033[0m\n' "$*"; }
vert()   { printf '\033[32m%s\033[0m\n' "$*"; }
gris()   { printf '\033[90m%s\033[0m\n' "$*"; }

# Une seule annonce en cas d'arrêt : la trap ERR se déclenche aussi dans les
# sous-shells, et trois lignes identiques cachent la vraie erreur.
DEJA_SIGNALE=0
signaler_arret() {
  [ "$DEJA_SIGNALE" = "1" ] && return
  DEJA_SIGNALE=1
  rouge ""
  rouge "Arrêt à la première erreur. La base laissée en l'état est celle du test."
}
trap signaler_arret ERR

# ─────────────────────────────────────────────── garde-fou d'abord ──
#
# On ne touche qu'à une base dont le nom ET le port disent « test ». Un
# script de reconstruction qui se trompe de cible efface une production.
if [ "$PORT" = "5432" ]; then
  rouge "Refus : le port 5432 est celui d'une base de service, pas d'un conteneur de test."
  rouge "Lancez le conteneur de test sur son port dédié, ou passez PGPORT_TEST."
  exit 1
fi
case "$BASE" in
  *prod*|*production*)
    rouge "Refus : « $BASE » ressemble à une base de production."
    exit 1;;
esac

# `DATABASE_URL` désigne la production sur un serveur. On la neutralise pour
# que rien, dans ce script ni dans ce qu'il appelle, ne puisse s'y connecter
# par inadvertance.
unset DATABASE_URL || true

# ─────────────────────────────────────────────────── comment parler ──
#
# Deux chemins : le client psql local s'il existe, sinon celui du conteneur.
# Le second évite d'exiger l'installation de PostgreSQL sur la machine.
DOCKER="$(command -v docker || echo /Applications/Docker.app/Contents/Resources/bin/docker)"

# Le conteneur d'abord, quand il tourne : il s'authentifie par son socket local
# et n'exige donc aucun mot de passe. On ne retombe sur le client psql de la
# machine que s'il n'y a pas de conteneur — et là seulement, un mot de passe
# devient nécessaire.
MODE=""
if [ -x "$DOCKER" ] && "$DOCKER" ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTENEUR"; then
  MODE="docker"
elif command -v psql >/dev/null 2>&1; then
  MODE="local"
else
  rouge "Ni le conteneur « $CONTENEUR » ni un client psql : impossible de joindre la base de test."
  exit 1
fi

# Aucun mot de passe en dur, même de test : un identifiant écrit dans un dépôt
# finit par être essayé ailleurs.
MDP="${PGPASSWORD_TEST:-}"
if [ "$MODE" = "local" ] && [ -z "$MDP" ]; then
  rouge "Le conteneur « $CONTENEUR » ne tourne pas et PGPASSWORD_TEST n'est pas défini."
  rouge "Démarrez le conteneur, ou exportez PGPASSWORD_TEST pour passer par psql."
  exit 1
fi

# `sql <base> [arguments…]` — le corps SQL arrive sur l'entrée standard.
sql() {
  local base="$1"; shift
  if [ "$MODE" = "local" ]; then
    PGPASSWORD="$MDP" psql -h "$HOTE" -p "$PORT" -U "$SUPER" -d "$base" \
      -v ON_ERROR_STOP=1 -q "$@"
  else
    "$DOCKER" exec -i "$CONTENEUR" psql -U "$SUPER" -d "$base" \
      -v ON_ERROR_STOP=1 -q "$@"
  fi
}

gris "Cible : $BASE sur $HOTE:$PORT (accès $MODE)"

# ───────────────────────────────────────────────────── table rase ──
#
# On coupe les sessions ouvertes avant de supprimer : une connexion oubliée
# dans un onglet suffit sinon à faire échouer le DROP.
echo "▸ Recréation de la base"
sql postgres <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname = '$BASE' AND pid <> pg_backend_pid();
SQL
sql postgres -c "DROP DATABASE IF EXISTS $BASE"
sql postgres -c "CREATE DATABASE $BASE"

# ───────────────────────────────────────────────────────── rôles ──
#
# Certaines migrations attribuent des droits à `triangle_user`. Le rôle doit
# exister avant elles, sinon le GRANT échoue sur une base neuve.
echo "▸ Rôles"
sql postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'triangle_user') THEN
    CREATE ROLE triangle_user LOGIN;
  END IF;
END \$\$;
SQL
gris "  triangle_user présent"

# ────────────────────────────────────────────────────── migrations ──
#
# Toutes, dans l'ordre du nom. Deux d'entre elles — 061 et 061a — ciblent une
# entreprise et attendent des nombres relevés dans un preview de production ;
# sans paramètres elles s'annoncent et ne font rien, ce qui est exactement ce
# qu'on veut sur une base de test vide.
appliquer_migrations() {
  local silencieux="${1:-0}"
  local nb=0
  for fichier in $(ls sql/*.sql | sort); do
    local nom; nom="$(basename "$fichier")"
    [ "$silencieux" = "0" ] && printf '  %-48s' "$nom"
    if sql "$BASE" < "$fichier" >/dev/null 2>"/tmp/rebuild-$$.err"; then
      [ "$silencieux" = "0" ] && echo "ok"
      nb=$((nb + 1))
    else
      [ "$silencieux" = "0" ] && echo "ÉCHEC"
      rouge "$nom :"
      rouge "$(head -5 "/tmp/rebuild-$$.err")"
      rm -f "/tmp/rebuild-$$.err"
      exit 1
    fi
  done
  rm -f "/tmp/rebuild-$$.err"
  MIGRATIONS_APPLIQUEES=$nb
}

echo "▸ Migrations"
appliquer_migrations 0
vert "  $MIGRATIONS_APPLIQUEES migrations appliquées"

# ─────────────────────────────────────────────────────── fixtures ──
#
# Le strict nécessaire pour que les suites aient de quoi mordre : deux
# entreprises et quelques comptes. Rien qui ressemble à des données réelles —
# aucun mot de passe utilisable, aucune adresse existante.
if [ "$AVEC_FIXTURES" = "1" ]; then
  echo "▸ Jeu de données minimal"
  sql "$BASE" <<'SQL'
INSERT INTO companies (id, name) VALUES
  (1, 'Triangle Logistics Transport & Intérim SARL'),
  (2, 'FAT & MAT Entreprise')
ON CONFLICT (id) DO NOTHING;

/* Empreinte volontairement invalide : aucun de ces comptes ne peut servir à
   se connecter, ici comme ailleurs. */
INSERT INTO users (id, company_id, fullname, email, password, role, badge_code, is_super_admin) VALUES
  (1,  1, 'Essai Super',        's@essai.test',  '$non-utilisable$', 'super_admin',          'TRIANGLE-EMP-001', true),
  (2,  1, 'Essai Responsable',  'r@essai.test',  '$non-utilisable$', 'responsable_entrepot', 'TRIANGLE-EMP-002', false),
  (3,  1, 'Essai Employé',      'e@essai.test',  '$non-utilisable$', 'employe',              'TRIANGLE-EMP-003', false),
  (4,  1, 'Essai Comptable',    'c@essai.test',  '$non-utilisable$', 'comptable',            'TRIANGLE-EMP-004', false),
  (5,  1, 'Essai Direction',    'd@essai.test',  '$non-utilisable$', 'direction',            'TRIANGLE-EMP-005', false),
  (10, 1, 'Essai Admin',        'a@essai.test',  '$non-utilisable$', 'admin',                'TRIANGLE-EMP-010', false),
  (11, 1, 'Essai Employé 2',    'e2@essai.test', '$non-utilisable$', 'employe',              'TRIANGLE-EMP-011', false),
  (20, 2, 'Essai Admin FatMat', 'af@essai.test', '$non-utilisable$', 'admin',                NULL,               false),
  (21, 2, 'Essai Issa',         'i@essai.test',  '$non-utilisable$', 'employe',              NULL,               false),
  /* Un badge attribué par erreur : ce compte appartient à FAT & MAT mais porte
     un badge Triangle. Le contrôle d'isolation doit le DÉSIGNER nommément, et
     il ne peut le faire que si le cas existe dans le jeu d'essai. C'est la
     reproduction exacte du défaut rencontré en production. */
  (22, 2, 'Essai Badge Discordant', 'bd@essai.test', '$non-utilisable$', 'employe',           'TRIANGLE-EMP-022', false)
ON CONFLICT (id) DO NOTHING;

/* Les identifiants explicites laissent la séquence derrière eux : la première
   insertion applicative réclamerait sinon un identifiant déjà pris. */
DO $seq$
BEGIN
  PERFORM setval(pg_get_serial_sequence('users', 'id'),
                 GREATEST((SELECT COALESCE(MAX(id), 1) FROM users), 1));
  PERFORM setval(pg_get_serial_sequence('companies', 'id'),
                 GREATEST((SELECT COALESCE(MAX(id), 1) FROM companies), 1));
END $seq$;

/* Quelques droits hérités, pour que l'ancien moteur ait de quoi répondre. */
INSERT INTO user_permissions (user_id, module_key, can_view, can_create, can_edit, can_delete, can_validate) VALUES
  (2, 'stocks',       true, true,  true,  false, true),
  (2, 'receptions',   true, true,  false, false, true),
  (3, 'stocks',       true, false, false, false, false),
  (3, 'documents',    true, false, false, false, NULL),
  (4, 'comptabilite', true, true,  true,  false, true)
ON CONFLICT DO NOTHING;
SQL
  gris "  2 entreprises, 10 comptes (dont un badge volontairement discordant), 5 droits hérités"

  # ─────────────────────────────────────────── référentiel par entreprise ──
  #
  # Plusieurs migrations DÉRIVENT leurs données des entreprises existantes :
  # 063 crée une ligne de `role_permissions` par entreprise, par rôle et par
  # action ; 065 déduit le préfixe de badge des badges déjà attribués. Sur une
  # base neuve, elles s'exécutent avant que la moindre entreprise existe et ne
  # produisent donc rien — le moteur de droits répond alors « rien » à tout, et
  # les suites échouent pour une raison qui n'a aucun rapport avec elles.
  #
  # On les rejoue après les fixtures. Toutes sont idempotentes : ce second
  # passage ne recrée rien de ce qui existe déjà.
  echo "▸ Référentiel dérivé des entreprises"
  appliquer_migrations 1
  gris "  $MIGRATIONS_APPLIQUEES migrations rejouées"
fi

# ─────────────────────────────────────────────────────── contrôles ──
echo "▸ Contrôles"
sql "$BASE" -tA <<'SQL' | sed 's/^/  /'
SELECT 'tables            : ' || count(*) FROM information_schema.tables WHERE table_schema = 'public';
SELECT 'modules de droits : ' || count(*) FROM permission_modules;
SELECT 'actions de droits : ' || count(*) FROM permission_actions;
SELECT 'entreprises       : ' || count(*) FROM companies;
SELECT 'comptes           : ' || count(*) FROM users;
SELECT 'stock total       : ' || COALESCE(SUM(quantity), 0) FROM stock_location_balances;
SELECT 'mouvements        : ' || count(*) FROM stock_movements;
SELECT 'droits par rôle   : ' || count(*) FROM role_permissions;
SELECT 'préfixes de badge : ' || string_agg(COALESCE(badge_prefix,'—'), ', ' ORDER BY id) FROM companies;
SQL

vert "
Base de test reconstruite. URL :
  postgresql://$SUPER:***@$HOTE:$PORT/$BASE"
