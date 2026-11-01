#!/usr/bin/env bash
#
# ═════════════════════════════════════════════════════════════════════════
#  REPRODUIRE LE 404 DES PIÈCES JOINTES DU CHAT
#
#  Le cahier des charges demande de REPRODUIRE le défaut avant de le
#  corriger, et de ne pas supposer la cause. Ce script monte le backend ET le
#  frontend, envoie un fichier Excel dans une conversation, puis suit
#  exactement le chemin que suit le navigateur du destinataire.
#
#  Il mesure trois choses, et seule la première est le défaut visible :
#
#    1. L'URL que le frontend place dans le lien répond-elle ?
#    2. Le fichier est-il servi SANS authentification ?
#    3. Un utilisateur d'une AUTRE société peut-il le lire ?
#
#  Les deux dernières ne provoquent aucune erreur à l'écran : elles ne se
#  voient qu'en les cherchant.
# ═════════════════════════════════════════════════════════════════════════
set -uo pipefail
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}; PGPORT=${PGPORT:-5433}
PGDATA=${PGDATA:-/var/lib/postgresql/pgtest}; BASE=${BASE:-wms_chat404}
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
FRONT=${FRONT:-$(cd "$RACINE/../triangle-wms-frontend" 2>/dev/null && pwd || echo '')}
export DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${BASE}"
export JWT_SECRET="${JWT_SECRET:-test_chat404}" FRONTEND_URL="http://localhost:3000" NODE_ENV=test

VERT=$'\033[32m'; ROUGE=$'\033[31m'; JAUNE=$'\033[33m'; GRAS=$'\033[1m'; ZERO=$'\033[0m'
titre(){ echo; echo "${GRAS}── $* ${ZERO}"; }
ok(){ echo "  ${VERT}✔${ZERO} $*"; }
ko(){ echo "  ${ROUGE}✘${ZERO} $*"; }
note(){ echo "  ${JAUNE}!${ZERO} $*"; }

pg_isready -p "$PGPORT" -q 2>/dev/null || \
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PGPORT -c listen_addresses=127.0.0.1' -l /tmp/pg.log start -w" >/dev/null
fuser -k 5050/tcp 2>/dev/null; fuser -k 3000/tcp 2>/dev/null; sleep 1
psql "postgresql://postgres@127.0.0.1:${PGPORT}/postgres" -tAc \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${BASE}'" >/dev/null 2>&1
su postgres -c "$PGBIN/dropdb -p $PGPORT --force --if-exists $BASE" >/dev/null
su postgres -c "$PGBIN/createdb -p $PGPORT $BASE"

titre "Mise en place"
cd "$RACINE/sql"; N=0
for f in $(ls *.sql | grep -E '^[0-9]' | sort -V); do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1 && N=$((N+1))
done
ok "$N migrations"
cd "$RACINE"
psql "$DATABASE_URL" -q >/dev/null 2>&1 <<SQL
INSERT INTO companies(id,name,tenant_id) VALUES (1,'Triangle','triangle'),(2,'FAT & MAT','triangle')
  ON CONFLICT (id) DO UPDATE SET tenant_id='triangle';
INSERT INTO users(id,fullname,email,password,role,company_id,is_super_admin,is_active) VALUES
 (900,'Expediteur','exp@t.local','x','direction',1,true,true),
 (901,'Destinataire','dest@t.local','x','comptable',1,false,true),
 (902,'Tiers Triangle','tiers@t.local','x','magasinier',1,false,true),
 (903,'Etranger Fatemat','etr@t.local','x','direction',2,true,true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO role_permissions(company_id,role,module_key,action,allowed)
SELECT c.id, r.role, 'chat', a.action, true
  FROM (VALUES (1),(2)) c(id), (VALUES ('direction'),('comptable'),('magasinier')) r(role),
       (VALUES ('visible'),('view'),('create')) a(action)
ON CONFLICT (company_id,role,module_key,action) DO UPDATE SET allowed=true;
SQL
ok "4 comptes, droits de chat posés"

node server.js > /tmp/chat404-backend.log 2>&1 &
SRV=$!
for _ in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:5050/ 2>/dev/null && break; sleep 1; done
ok "backend démarré"

if [ -n "$FRONT" ]; then
  ( cd "$FRONT" && BACKEND_URL=http://127.0.0.1:5050 npx next start -p 3000 > /tmp/chat404-front.log 2>&1 ) &
  WEB=$!
  for _ in $(seq 1 45); do curl -s -o /dev/null http://127.0.0.1:3000/ 2>/dev/null && break; sleep 1; done
  curl -s -o /dev/null http://127.0.0.1:3000/ 2>/dev/null && ok "frontend démarré" || note "frontend non démarré (build absent ?)"
fi
trap 'kill $SRV ${WEB:-} 2>/dev/null' EXIT

jeton() {
  node -e "console.log(require('jsonwebtoken').sign({id:$1,fullname:'$2',role:'$3',company_id:$4,is_super_admin:$5,tenant_id:'triangle'},process.env.JWT_SECRET,{expiresIn:'1h'}))"
}
TEXP=$(jeton 900 Expediteur direction 1 true)
TDEST=$(jeton 901 Destinataire comptable 1 false)
TTIERS=$(jeton 902 Tiers magasinier 1 false)
TETR=$(jeton 903 Etranger direction 2 true)
H_EXP=(-H "Authorization: Bearer $TEXP" -H "x-tenant-id: triangle" -H "x-active-company-id: 1")
H_DEST=(-H "Authorization: Bearer $TDEST" -H "x-tenant-id: triangle" -H "x-active-company-id: 1")
H_TIERS=(-H "Authorization: Bearer $TTIERS" -H "x-tenant-id: triangle" -H "x-active-company-id: 1")
H_ETR=(-H "Authorization: Bearer $TETR" -H "x-tenant-id: triangle" -H "x-active-company-id: 2")

titre "Une conversation entre deux personnes"
CONV=$(curl -s "${H_EXP[@]}" -H "Content-Type: application/json" \
  -d '{"participant_ids":[901],"title":"Essai 404"}' \
  http://127.0.0.1:5050/chat/conversations | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.conversation?.id||j.id||'')}catch{console.log('')}})")
[ -n "$CONV" ] && ok "conversation n° $CONV" || { ko "création de conversation impossible"; curl -s "${H_EXP[@]}" -H "Content-Type: application/json" -d '{"participant_ids":[901]}' http://127.0.0.1:5050/chat/conversations | head -c 300; echo; }

titre "L'expéditeur envoie un fichier Excel"
printf 'PK\003\004essai-classeur-triangle' > /tmp/bilan-septembre.xlsx
REP=$(curl -s "${H_EXP[@]}" -F "file=@/tmp/bilan-septembre.xlsx;type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" \
  -F "conversation_id=$CONV" http://127.0.0.1:5050/chat/upload-file)
URL=$(echo "$REP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).file_url||'')}catch{console.log('')}})")
if [ -n "$URL" ]; then ok "téléversé — le serveur renvoie file_url = $URL"
else ko "téléversement refusé : $(echo "$REP" | head -c 300)"; fi

titre "1. L'URL que le navigateur du destinataire va suivre"
echo "  Le chat pose href={message.file_url}, donc le navigateur demande"
echo "  cette adresse à l'ORIGINE DU FRONTEND, pas au backend."
if [ -n "${WEB:-}" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000${URL}")
  if [ "$CODE" = "404" ]; then
    ko "http://localhost:3000${URL} → ${GRAS}404${ZERO}  ← LE DÉFAUT, REPRODUIT"
  else
    note "http://localhost:3000${URL} → $CODE"
  fi
  CODE_API=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000/api${URL}")
  echo "  Par comparaison, /api${URL} → $CODE_API  (la seule route réécrite vers le backend)"
else
  note "frontend non démarré : contrôle 1 non exécuté"
fi

titre "2. Le fichier est-il protégé sur le backend ?"
if [ -z "$URL" ]; then
  ko "Pas d'URL : le téléversement a échoué, les contrôles 2 et 3 ne mesurent rien."
  exit 1
fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:5050${URL}")
if [ "$CODE" = "200" ]; then
  ko "GET ${URL} ${GRAS}SANS AUCUN JETON${ZERO} → 200. Le fichier est public pour qui connaît son nom."
else
  ok "GET sans jeton → $CODE"
fi

titre "3. Et pour quelqu'un d'une autre société ?"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${H_ETR[@]}" "http://127.0.0.1:5050${URL}")
[ "$CODE" = "200" ] && ko "FAT & MAT lit la pièce jointe de Triangle → 200" || ok "FAT & MAT → $CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${H_TIERS[@]}" "http://127.0.0.1:5050${URL}")
[ "$CODE" = "200" ] && ko "un tiers hors de la conversation la lit aussi → 200" || ok "tiers → $CODE"

titre "Diagnostic"
echo "  La réécriture de Next.js ne couvre que « /api/:path* ». Une adresse"
echo "  « /uploads/... » est donc demandée au serveur Next, qui n'a pas cette"
echo "  route : il répond 404. Les images et vidéos échouent de la même façon,"
echo "  mais un navigateur montre une image cassée au lieu d'une page d'erreur —"
echo "  c'est pourquoi seul le clic sur un Excel rend le défaut visible."
echo
echo "  Et la correction évidente — rendre le dossier public — est précisément"
echo "  celle que le cahier des charges interdit : le contrôle 2 montre que le"
echo "  fichier est DÉJÀ servi sans authentification."
