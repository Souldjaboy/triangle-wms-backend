#!/usr/bin/env bash
# LE SCANNER DANS UN VRAI NAVIGATEUR, AVEC UNE CAMÉRA SIMULÉE.
# Chromium reçoit un fichier vidéo montrant une feuille posée de biais : ce
# qui est éprouvé est le parcours réel, pas une maquette cliquée.
set -uo pipefail
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}; PGPORT=${PGPORT:-5433}
PGDATA=${PGDATA:-/var/lib/postgresql/pgtest}; BASE=${BASE:-wms_ecrans_scanner}
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
FRONT=${FRONT:-$(cd "$RACINE/../triangle-wms-frontend" && pwd)}
export DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${BASE}"
export JWT_SECRET="${JWT_SECRET:-test_studio}" FRONTEND_URL="http://localhost:3000" NODE_ENV=test
export STUDIO_STORAGE_DIR="${STUDIO_STORAGE_DIR:-/tmp/studio-ecrans-scanner}"
PAPIER=${PAPIER:-/tmp/papier}

pg_isready -p "$PGPORT" -q 2>/dev/null || \
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PGPORT -c listen_addresses=127.0.0.1' -l /tmp/pg.log start -w" >/dev/null
fuser -k 5050/tcp 2>/dev/null; fuser -k 3000/tcp 2>/dev/null; sleep 1
psql "postgresql://postgres@127.0.0.1:${PGPORT}/postgres" -tAc \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${BASE}'" >/dev/null 2>&1
su postgres -c "$PGBIN/dropdb -p $PGPORT --force --if-exists $BASE" >/dev/null
su postgres -c "$PGBIN/createdb -p $PGPORT $BASE"
psql -q "$DATABASE_URL" -tAc "CREATE ROLE triangle_user LOGIN" >/dev/null 2>&1 || true

echo "── migrations"
cd "$RACINE/sql"; N=0
for f in $(ls *.sql | grep -E '^[0-9]' | sort -V); do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1 && N=$((N+1))
done
echo "   $N appliquées"
cd "$RACINE"

echo "── comptes et droits"
psql "$DATABASE_URL" -q >/dev/null 2>&1 <<SQL
INSERT INTO companies(id,name,tenant_id) VALUES (1,'Triangle','triangle'),(2,'FAT & MAT','triangle')
  ON CONFLICT (id) DO UPDATE SET tenant_id='triangle';
SELECT setval(pg_get_serial_sequence('companies','id'), 10, true);
INSERT INTO users(id,fullname,email,password,role,company_id,is_super_admin,is_active) VALUES
 (900,'Direction Triangle','dir@t.local','x','direction',1,false,true),
 (901,'Comptable Triangle','compta@t.local','x','comptable',1,false,true)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('users','id'), 2000, true);
INSERT INTO role_permissions(company_id,role,module_key,action,allowed)
SELECT c.id, r.role, m.module, a.action, true
  FROM (VALUES (1),(2)) c(id), (VALUES ('direction'),('comptable')) r(role),
       (VALUES ('studio'),('studio.bibliotheque'),('studio.scanner')) m(module),
       (VALUES ('visible'),('view'),('create'),('update'),('share'),('export')) a(action)
ON CONFLICT (company_id,role,module_key,action) DO UPDATE SET allowed=true;
INSERT INTO company_modules (company_id, module_key, is_enabled)
SELECT c.id, 'studio', TRUE FROM (VALUES (1),(2)) c(id)
ON CONFLICT (company_id, module_key) DO UPDATE SET is_enabled = TRUE;
SQL

echo "── feuille d'essai"
node "$FRONT/scripts/papier-synthetique.js" "$PAPIER" | sed 's/^/   /'

echo "── backend"
rm -rf "$STUDIO_STORAGE_DIR"
node server.js > /tmp/serveur-ecrans-scanner.log 2>&1 &
SRV=$!
for _ in $(seq 1 40); do curl -s -o /dev/null http://localhost:5050/ 2>/dev/null && break; sleep 1; done

echo "── frontend"
cd "$FRONT"
BACKEND_URL=http://127.0.0.1:5050 npm run build > /tmp/front-scanner.log 2>&1 \
  || { echo "   la compilation a échoué :"; tail -25 /tmp/front-scanner.log; kill $SRV; exit 1; }
BACKEND_URL=http://127.0.0.1:5050 npx next start -p 3000 > /tmp/front-run-scanner.log 2>&1 &
WEB=$!
trap 'kill $SRV $WEB 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null http://localhost:3000/ 2>/dev/null && break; sleep 1; done

echo "── navigateur"
NODE_PATH="$FRONT/node_modules:$RACINE/node_modules" \
  SECRET="$JWT_SECRET" PAPIER="$PAPIER" SORTIE="${SORTIE:-/tmp/captures-scanner}" \
  node "$FRONT/scripts/verif-studio-scanner.js"
