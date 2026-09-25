#!/usr/bin/env bash
# Le calendrier administratif et le rapport de pointage dans un vrai navigateur.
# 1280 px et 375 px, de la base vierge au verdict.
set -euo pipefail
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}; PGPORT=${PGPORT:-5433}
PGDATA=${PGDATA:-/var/lib/postgresql/pgtest}; BASE=${BASE:-wms_cal_nav}
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
FRONT=${FRONT:-$(cd "$RACINE/../triangle-wms-frontend" && pwd)}
export DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${BASE}"
export JWT_SECRET="${JWT_SECRET:-test_chomes}" FRONTEND_URL="http://localhost:3000" NODE_ENV=test

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
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$RACINE/scripts/jeu-essai-avances-paie.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$RACINE/scripts/jeu-essai-jours-chomes.sql"

echo "── backend"
cd "$RACINE"; node server.js > /tmp/serveur-cal-nav.log 2>&1 &
SRV=$!
echo "── frontend (construction)"
cd "$FRONT"; BACKEND_URL=http://127.0.0.1:5050 npm run build > /tmp/front-build.log 2>&1 \
  || { tail -30 /tmp/front-build.log; kill $SRV; exit 1; }
BACKEND_URL=http://127.0.0.1:5050 npx next start -p 3000 > /tmp/front-run.log 2>&1 &
WEB=$!
trap 'kill $SRV $WEB 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null http://localhost:3000/ 2>/dev/null && break; sleep 1; done

echo "── navigateur"
cd "$FRONT"
# `jsonwebtoken` vit côté backend, `playwright-core` côté frontend : on rend les
# deux visibles plutôt que de dupliquer une dépendance dans un package.json.
NODE_PATH="$FRONT/node_modules:$RACINE/node_modules" \
BASE=http://localhost:3000 BACKEND=http://127.0.0.1:5050 SECRET="$JWT_SECRET" \
  SORTIE="${SORTIE:-/tmp/captures-calendrier}" node scripts/verif-calendrier-jours-chomes.js
