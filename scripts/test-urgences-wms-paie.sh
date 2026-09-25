#!/usr/bin/env bash
# Les trois suites, sur une base vierge, en une commande. Aucun paiement déclenché.
set -euo pipefail
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}; PGPORT=${PGPORT:-5433}
PGDATA=${PGDATA:-/var/lib/postgresql/pgtest}; BASE=${BASE:-wms_urgences_test}
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
export DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${BASE}"
export JWT_SECRET="${JWT_SECRET:-test_urgences}" FRONTEND_URL="${FRONTEND_URL:-http://localhost:3000}" NODE_ENV=test

pg_isready -p "$PGPORT" -q 2>/dev/null || \
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PGPORT -c listen_addresses=127.0.0.1' -l /tmp/pg.log start -w" >/dev/null
fuser -k 5050/tcp 2>/dev/null || true; sleep 1
psql "postgresql://postgres@127.0.0.1:${PGPORT}/postgres" -tAc \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${BASE}'" >/dev/null 2>&1 || true
su postgres -c "$PGBIN/dropdb -p $PGPORT --force --if-exists $BASE" >/dev/null
su postgres -c "$PGBIN/createdb -p $PGPORT $BASE"
psql -q "$DATABASE_URL" -tAc "CREATE ROLE triangle_user LOGIN" >/dev/null 2>&1 || true

echo "── migrations"; cd "$RACINE/sql"; N=0
for f in $(ls *.sql | grep -E '^[0-9]' | sort -V); do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1 && N=$((N+1)) || true
done; echo "   $N appliquées"

echo "── jeux d'essai"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$RACINE/scripts/jeu-essai-avances-paie.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$RACINE/scripts/jeu-essai-emplacements.sql"

echo "── serveur"; cd "$RACINE"; node server.js > /tmp/serveur-urgences.log 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do curl -s -o /dev/null http://localhost:5050/ 2>/dev/null && break; sleep 1; done

echo "── avances → paie";        node "$RACINE/scripts/test-avances-retenue-paie.js"
echo "── entrepôts et rayons";   node "$RACINE/scripts/test-entrepots-rayons.js"
echo "── septembre 2026";        node "$RACINE/scripts/test-paie-septembre-exception.js"
