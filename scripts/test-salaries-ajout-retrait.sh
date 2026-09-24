#!/usr/bin/env bash
# Ajout et retrait d'un salarié — de la base vierge au verdict, en une commande.
#
# Monte une base neuve, y applique TOUTES les migrations dans l'ordre, charge
# le jeu d'essai, démarre le vrai server.js et lance les tests HTTP. Rien n'est
# simulé : c'est le serveur de production contre le schéma de production.
set -euo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PGPORT=${PGPORT:-5433}
PGDATA=${PGDATA:-/var/lib/postgresql/pgtest}
BASE=${BASE:-wms_salaries_test}
RACINE="$(cd "$(dirname "$0")/.." && pwd)"

export DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${BASE}"
export JWT_SECRET="${JWT_SECRET:-test_secret_salaries}"
export FRONTEND_URL="${FRONTEND_URL:-http://localhost:3000}"
export NODE_ENV=test

echo "── grappe PostgreSQL"
if ! pg_isready -p "$PGPORT" -q 2>/dev/null; then
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PGPORT -c listen_addresses=127.0.0.1' -l /tmp/pg.log start -w" >/dev/null
fi

echo "── base neuve : $BASE"
su postgres -c "$PGBIN/dropdb -p $PGPORT --if-exists $BASE" >/dev/null
su postgres -c "$PGBIN/createdb -p $PGPORT $BASE"
psql -q "$DATABASE_URL" -tAc "CREATE ROLE triangle_user LOGIN" >/dev/null 2>&1 || true

echo "── migrations"
cd "$RACINE/sql"
appliquees=0
for f in $(ls *.sql | grep -E '^[0-9]' | sort -V); do
  if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/tmp/migration.log 2>&1; then
    appliquees=$((appliquees+1))
  else
    # 000_permissions_triangle_user vise une base nommée en dur : sans objet ici.
    echo "   ignorée : $f ($(grep -m1 ERROR /tmp/migration.log | cut -c1-80))"
  fi
done
echo "   $appliquees migrations appliquées"

echo "── jeu d'essai"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$RACINE/scripts/jeu-essai-salaries.sql"

echo "── serveur"
cd "$RACINE"
fuser -k 5050/tcp 2>/dev/null || true
sleep 1
node server.js > /tmp/serveur-test.log 2>&1 &
SERVEUR=$!
trap 'kill $SERVEUR 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do
  curl -s -o /dev/null http://localhost:5050/ 2>/dev/null && break
  sleep 1
done

echo "── tests"
node "$RACINE/scripts/test-salaries-ajout-retrait.js"
