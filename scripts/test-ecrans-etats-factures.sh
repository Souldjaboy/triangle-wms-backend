#!/usr/bin/env bash
# L'écran des états de factures dans un vrai navigateur. Base vierge → verdict.
set -euo pipefail
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}; PGPORT=${PGPORT:-5433}
PGDATA=${PGDATA:-/var/lib/postgresql/pgtest}; BASE=${BASE:-wms_ecrans_etats}
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
FRONT=${FRONT:-$(cd "$RACINE/../triangle-wms-frontend" && pwd)}
export DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${BASE}"
export JWT_SECRET="${JWT_SECRET:-test_integration}" FRONTEND_URL="http://localhost:3000" NODE_ENV=test

pg_isready -p "$PGPORT" -q 2>/dev/null || \
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PGPORT -c listen_addresses=127.0.0.1' -l /tmp/pg.log start -w" >/dev/null
fuser -k 5050/tcp 2>/dev/null || true; fuser -k 3000/tcp 2>/dev/null || true; sleep 1
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
cd "$RACINE"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f scripts/jeu-essai-etats-factures.sql 2>&1 | grep -E "ERROR" || true

echo "── backend"
node server.js > /tmp/serveur-ecrans-etats.log 2>&1 &
SRV=$!
echo "── frontend"
cd "$FRONT"; BACKEND_URL=http://127.0.0.1:5050 npm run build > /tmp/front-etats.log 2>&1 \
  || { tail -25 /tmp/front-etats.log; kill $SRV; exit 1; }
BACKEND_URL=http://127.0.0.1:5050 npx next start -p 3000 > /tmp/front-run-etats.log 2>&1 &
WEB=$!
trap 'kill $SRV $WEB 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null http://localhost:3000/ 2>/dev/null && break; sleep 1; done

echo "── navigateur"
cd "$FRONT"
NODE_PATH="$FRONT/node_modules:$RACINE/node_modules" \
  SECRET="$JWT_SECRET" SORTIE="${SORTIE:-/tmp/captures-etats}" \
  node scripts/verif-etats-factures.js
