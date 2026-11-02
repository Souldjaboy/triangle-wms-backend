#!/usr/bin/env bash
# L.éditeur de pages du Studio. Base vierge → verdict.
set -uo pipefail
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}; PGPORT=${PGPORT:-5433}
PGDATA=${PGDATA:-/var/lib/postgresql/pgtest}; BASE=${BASE:-wms_pdf}
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
export DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${BASE}"
export JWT_SECRET="${JWT_SECRET:-test_studio}" FRONTEND_URL="http://localhost:3000" NODE_ENV=test
export STUDIO_STORAGE_DIR="${STUDIO_STORAGE_DIR:-/tmp/studio-pdf-storage}"

pg_isready -p "$PGPORT" -q 2>/dev/null || \
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PGPORT -c listen_addresses=127.0.0.1' -l /tmp/pg.log start -w" >/dev/null
fuser -k 5050/tcp 2>/dev/null; sleep 1
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
 (901,'Comptable Triangle','compta@t.local','x','comptable',1,false,true),
 (902,'Magasinier Triangle','maga@t.local','x','magasinier',1,false,true),
 (903,'Direction Fatemat','fat@t.local','x','direction',2,false,true)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('users','id'), 2000, true);
INSERT INTO role_permissions(company_id,role,module_key,action,allowed)
SELECT c.id, r.role, m.module, a.action, true
  FROM (VALUES (1),(2)) c(id), (VALUES ('direction'),('comptable'),('magasinier')) r(role),
       (VALUES ('chat'),('studio'),('studio.bibliotheque'),('studio.scanner'),('studio.signature'),('studio.pdf')) m(module),
       (VALUES ('visible'),('view'),('create'),('update'),('share'),('export')) a(action)
ON CONFLICT (company_id,role,module_key,action) DO UPDATE SET allowed=true;
INSERT INTO role_permissions(company_id,role,module_key,action,allowed) VALUES
 (1,'direction','studio.signature','validate',true),
 (2,'direction','studio.signature','validate',true),
 (1,'comptable','studio.signature','validate',false),
 (1,'magasinier','studio.signature','validate',false),
 (1,'direction','studio.bibliotheque','delete',true),
 (1,'comptable','studio.bibliotheque','delete',false),
 (1,'magasinier','studio.bibliotheque','delete',false),
 (2,'direction','studio.bibliotheque','delete',true)
ON CONFLICT (company_id,role,module_key,action) DO UPDATE SET allowed=EXCLUDED.allowed;
INSERT INTO company_modules (company_id, module_key, is_enabled)
SELECT c.id, m.k, TRUE FROM (VALUES (1),(2)) c(id), (VALUES ('chat'),('studio')) m(k)
ON CONFLICT (company_id, module_key) DO UPDATE SET is_enabled = TRUE;
SQL

echo "── serveur"
rm -rf "$STUDIO_STORAGE_DIR"
node server.js > /tmp/serveur-pdf.log 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 1 40); do curl -s -o /dev/null http://localhost:5050/ 2>/dev/null && break; sleep 1; done

echo "── tests"
node "$RACINE/scripts/test-studio-pdf.js"
