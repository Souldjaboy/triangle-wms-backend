#!/usr/bin/env bash
# §E — Réconciliation FAT & MAT. Base vierge → verdict. Rien n'est écrit.
set -euo pipefail
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}; PGPORT=${PGPORT:-5433}
PGDATA=${PGDATA:-/var/lib/postgresql/pgtest}; BASE=${BASE:-wms_fatmat}
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
export DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${BASE}"
export JWT_SECRET="${JWT_SECRET:-test_fatmat}" NODE_ENV=test

pg_isready -p "$PGPORT" -q 2>/dev/null || \
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PGPORT -c listen_addresses=127.0.0.1' -l /tmp/pg.log start -w" >/dev/null
psql "postgresql://postgres@127.0.0.1:${PGPORT}/postgres" -tAc \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${BASE}'" >/dev/null 2>&1 || true
su postgres -c "$PGBIN/dropdb -p $PGPORT --force --if-exists $BASE" >/dev/null
su postgres -c "$PGBIN/createdb -p $PGPORT $BASE"
psql -q "$DATABASE_URL" -tAc "CREATE ROLE triangle_user LOGIN" >/dev/null 2>&1 || true

echo "── migrations"
cd "$RACINE/sql"; N=0
for f in $(ls *.sql | grep -E '^[0-9]' | sort -V); do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1 && N=$((N+1)) || true
done
echo "   $N appliquées"

echo "── jeu d'essai"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$RACINE/scripts/jeu-essai-reconciliation-fatmat.sql" 2>&1 \
  | grep -E "NOTICE|ERROR" || true

echo "── rapport de réconciliation"
cd "$RACINE" && node scripts/reconcilier-fatmat.js | sed -n '/§1/,/§2/p'

echo "── tests"
node "$RACINE/scripts/test-reconciliation-fatmat.js"
