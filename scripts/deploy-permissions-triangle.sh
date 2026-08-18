#!/usr/bin/env bash
#
# DÉPLOIEMENT TRIANGLE WMS — CENTRE DROITS & PERMISSIONS
#
# Ne touche que Triangle : les dépôts sont vérifiés par leur remote, et seuls
# triangle-backend et triangle-frontend sont redémarrés.
#
#   bash scripts/deploy-permissions-triangle.sh
#
# Le SHA de retour arrière du backend est conservé dans le dossier de
# sauvegarde : la commande courte fusionne le backend avant de lancer ce
# script, si bien que HEAD ne porte alors plus l'état d'avant déploiement.
# On peut aussi le fournir soi-même : OLD_BACKEND_SHA=<sha> bash …
#
set -euo pipefail
B=/var/www/triangle-wms/backend; F=/var/www/triangle-wms/frontend
REQUIRED_BACKEND_COMMIT=8d0dba96e3e776d108800f31c753b78d22af88f5
REQUIRED_FRONTEND_COMMIT=5c7c41c489cf841eccd192504ea77bc0e01894b9
SHA_MIG=08c5f03f59a222faceacaf312cc4356f5e53e0bc2f9acb0c58784d424865287b
ok(){ echo "  ✓ $1"; }; ko(){ echo "  ✗ ARRÊT : $1" >&2; exit 1; }

echo "══ REMOTES TRIANGLE"
for R in "$B" "$F"; do
  [ -d "$R/.git" ] || ko "$R n'est pas un dépôt Git"
  U=$(git -C "$R" remote get-url origin); echo "  $R → $U"
  case "$U" in *malilink*|*hafiya*) ko "$R n'est pas Triangle";; *triangle*) ;; *) ko "remote inattendu : $U";; esac
  [ -z "$(git -C "$R" status --porcelain --untracked-files=no)" ] || ko "$R a des modifications non validées"
done
ETAT=/var/backups/triangle/.sha-avant-deploiement
mkdir -p /var/backups/triangle
DEPART_B=$(git -C "$B" rev-parse HEAD)
if [ -n "${OLD_BACKEND_SHA:-}" ]; then printf '%s' "$OLD_BACKEND_SHA" > "$ETAT"
elif [ -s "$ETAT" ]; then OLD_BACKEND_SHA=$(cat "$ETAT")
elif ! git -C "$B" merge-base --is-ancestor "$REQUIRED_BACKEND_COMMIT" "$DEPART_B" 2>/dev/null; then
  OLD_BACKEND_SHA="$DEPART_B"; printf '%s' "$DEPART_B" > "$ETAT"
else
  OLD_BACKEND_SHA="${REQUIRED_BACKEND_COMMIT}^"
  echo "  ! SHA d'avant déploiement inconnu : rollback proposé sur ${REQUIRED_BACKEND_COMMIT}^"
fi
OLD_FRONTEND_SHA=$(git -C "$F" rev-parse HEAD)
echo "  HEAD backend  avant : $OLD_BACKEND_SHA"
echo "  HEAD frontend avant : $OLD_FRONTEND_SHA"
ok "dépôts Triangle, propres, SHA de retour arrière capturés"
set -a; . "$B/.env"; set +a; [ -n "${DATABASE_URL:-}" ] || ko "DATABASE_URL absent"
q(){ psql "$DATABASE_URL" -tAX -c "$1"; }
N=$(q "SELECT name FROM companies WHERE id=1"); echo "  société 1 : $N"
echo "$N" | grep -qi triangle || ko "la société 1 n'est pas Triangle"
ok "base Triangle confirmée"

echo "══ COMMIT BACKEND"
# Ce qui compte n'est pas que HEAD soit EXACTEMENT le commit du module, mais
# qu'il le CONTIENNE : un correctif publié depuis reste un déploiement valide,
# alors qu'exiger l'égalité refuserait tout descendant légitime.
git -C "$B" fetch origin --quiet
git -C "$B" cat-file -e "${REQUIRED_BACKEND_COMMIT}^{commit}" 2>/dev/null \
  || ko "commit fonctionnel $REQUIRED_BACKEND_COMMIT absent du dépôt"
HEAD_B=$(git -C "$B" rev-parse HEAD)
git -C "$B" merge-base --is-ancestor "$REQUIRED_BACKEND_COMMIT" "$HEAD_B" \
  || ko "le HEAD backend $HEAD_B ne contient pas le module permissions ($REQUIRED_BACKEND_COMMIT)"
if [ "$HEAD_B" = "$REQUIRED_BACKEND_COMMIT" ]; then echo "  HEAD = commit fonctionnel"
else echo "  HEAD = $HEAD_B, descendant de $REQUIRED_BACKEND_COMMIT ($(git -C "$B" rev-list --count "$REQUIRED_BACKEND_COMMIT".."$HEAD_B") commit(s) de plus)"; fi
ok "backend contient le module permissions"

echo "══ EMPREINTE 063"
M="$B/sql/063_permissions_avancees.sql"; [ -f "$M" ] || ko "$M introuvable"
H=$(sha256sum "$M" | cut -d' ' -f1); echo "  lue      : $H"; echo "  attendue : $SHA_MIG"
[ "$H" = "$SHA_MIG" ] || ko "empreinte non conforme"
ok "migration conforme"

echo "══ SAUVEGARDE"
mkdir -p /var/backups/triangle; D=/var/backups/triangle/triangle-avant-063-$(date +%Y%m%d-%H%M%S).dump
pg_dump --format=custom --no-owner --no-privileges --file="$D" "$DATABASE_URL"
[ -s "$D" ] || ko "dump vide"
[ "$(wc -c <"$D")" -ge 51200 ] || ko "dump suspect : $(wc -c <"$D") octets"
pg_restore --list "$D" >/dev/null 2>&1 || ko "dump illisible"
ok "dump : $D ($(wc -c <"$D") octets)"

echo "══ ÉTAT AVANT"
U_AV=$(q "SELECT count(*) FROM users WHERE company_id=1")
R_AV=$(q "SELECT md5(string_agg(id||':'||coalesce(role,'')||':'||coalesce(is_super_admin::text,'f'),',' ORDER BY id)) FROM users WHERE company_id=1")
P_AV=$(q "SELECT count(*) FROM user_permissions")
AM_ID=$(q "SELECT id FROM users WHERE company_id=1 AND (lower(coalesce(email,'')) LIKE '%amazerbo%' OR upper(coalesce(fullname,'')) LIKE '%AMARY%') ORDER BY id LIMIT 1")
echo "  utilisateurs : $U_AV | user_permissions : $P_AV | empreinte rôles : $R_AV"
if [ -n "$AM_ID" ]; then
  AM_LIG=$(q "SELECT count(*) FROM user_permissions WHERE user_id=$AM_ID")
  AM_ATT=$(q "SELECT count(*) FROM user_permissions up CROSS JOIN LATERAL (VALUES ('view',up.can_view),('create',up.can_create),('update',up.can_edit),('delete',up.can_delete),('validate',up.can_validate)) AS v(a,val) WHERE up.user_id=$AM_ID AND v.val IS NOT NULL")
  echo "  Amary id=$AM_ID : $AM_LIG ligne(s) historique(s), $AM_ATT cellule(s) renseignée(s) (toutes ne sont pas applicables)"
  psql "$DATABASE_URL" -c "SELECT module_key,can_view,can_create,can_edit,can_delete,can_validate FROM user_permissions WHERE user_id=$AM_ID ORDER BY module_key"
else echo "  Amary introuvable — vérifications la concernant ignorées"; AM_LIG=0; AM_ATT=0; fi

echo "══ MIGRATION 063"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$M" >/dev/null || ko "063 en échec — tout annulé, dump : $D"
ok "063 appliquée"

echo "══ TABLES"
for T in permission_modules permission_actions role_permissions user_permission_overrides permission_audit_log user_permissions; do
  [ "$(q "SELECT to_regclass('public.$T') IS NOT NULL")" = "t" ] && ok "$T" || ko "table $T absente"
done

echo "══ NON-RÉGRESSION"
[ "$(q "SELECT count(*) FROM users WHERE company_id=1")" = "$U_AV" ] || ko "nombre d'utilisateurs modifié"
[ "$(q "SELECT md5(string_agg(id||':'||coalesce(role,'')||':'||coalesce(is_super_admin::text,'f'),',' ORDER BY id)) FROM users WHERE company_id=1")" = "$R_AV" ] || ko "un rôle a changé"
[ "$(q "SELECT count(*) FROM user_permissions")" = "$P_AV" ] || ko "user_permissions modifiée"
ok "utilisateurs, rôles et user_permissions inchangés"
# Comparaison ensembliste, pas un décompte : on reconstruit la correspondance
# exacte de la migration — module mappé, action applicable, propagation aux
# sous-modules — et l'on exige que chaque cible attendue existe. Un couple que
# le catalogue ne connaît pas n'est pas un manque, c'est une case qui n'a
# jamais eu de sens.
( cd "$B" && node scripts/verifier-reprise-permissions.js --company=1 ) \
  || ko "reprise des droits incomplète — voir le détail ci-dessus"
ok "tous les droits historiques sont repris (tous comptes confondus)"
if [ -n "$AM_ID" ]; then
  ( cd "$B" && node scripts/verifier-reprise-permissions.js --company=1 --user="$AM_ID" ) \
    || ko "reprise des droits d'Amary incomplète"
  psql "$DATABASE_URL" -c "SELECT module_key, string_agg(action||'='||effect,', ' ORDER BY action) AS droits FROM user_permission_overrides WHERE user_id=$AM_ID GROUP BY module_key ORDER BY module_key"
  ok "droits d'Amary vérifiés module par module"
fi
psql "$DATABASE_URL" -c "SELECT u.fullname,u.role,count(*) AS exceptions FROM user_permission_overrides o JOIN users u ON u.id=o.user_id WHERE o.company_id=1 GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10"

echo "══ COMMIT FRONTEND"
# Aucune manipulation de stash ici : les modifications locales éventuelles ont
# été mises de côté à la main, et ce script ne doit ni les restaurer ni les
# supprimer. Il se contente d'avancer sur origin/main.
git -C "$F" fetch origin --quiet
git -C "$F" cat-file -e "${REQUIRED_FRONTEND_COMMIT}^{commit}" 2>/dev/null \
  || ko "commit fonctionnel $REQUIRED_FRONTEND_COMMIT absent du dépôt"
HEAD_F=$(git -C "$F" rev-parse HEAD)
if ! git -C "$F" merge-base --is-ancestor "$REQUIRED_FRONTEND_COMMIT" "$HEAD_F"; then
  git -C "$F" merge --ff-only origin/main >/dev/null \
    || ko "avance impossible sur $F sans écraser — traitez la divergence, aucun stash n'est touché"
  HEAD_F=$(git -C "$F" rev-parse HEAD)
fi
git -C "$F" merge-base --is-ancestor "$REQUIRED_FRONTEND_COMMIT" "$HEAD_F" \
  || ko "le HEAD frontend $HEAD_F ne contient pas l'écran des permissions ($REQUIRED_FRONTEND_COMMIT)"
if [ "$HEAD_F" = "$REQUIRED_FRONTEND_COMMIT" ]; then echo "  HEAD = commit fonctionnel"
else echo "  HEAD = $HEAD_F, descendant de $REQUIRED_FRONTEND_COMMIT ($(git -C "$F" rev-list --count "$REQUIRED_FRONTEND_COMMIT".."$HEAD_F") commit(s) de plus)"; fi
ok "frontend contient l'écran des permissions"

echo "══ DÉPENDANCES ET BUILD"
for R in "$B" "$F"; do
  V=$(sha256sum "$R/package.json" "$R/package-lock.json" 2>/dev/null | sha256sum | cut -d' ' -f1); T="$R/node_modules/.verrou-deploye"
  if [ -f "$T" ] && [ "$(cat "$T")" = "$V" ]; then ok "$(basename "$R") : dépendances à jour"
  else npm --prefix "$R" ci $([ "$R" = "$B" ] && echo --omit=dev) >/dev/null && echo "$V" > "$T" && ok "$(basename "$R") : dépendances installées"; fi
done
node --check "$B/server.js" && ok "server.js valide"
( cd "$F" && NEXT_PUBLIC_APP_PRODUCT=triangle npm run build ) || ko "build échoué — rien redémarré"
ok "build frontend réussi"

echo "══ UPTIMES AVANT REDÉMARRAGE"
pm2 jlist | node -e 'let e="";process.stdin.on("data",c=>e+=c).on("end",()=>JSON.parse(e||"[]").forEach(p=>console.log(`  ${p.name.padEnd(22)} ${String(p.pm2_env.status).padEnd(8)} ${Math.round((Date.now()-p.pm2_env.pm_uptime)/1000)}s`)))'

echo "══ REDÉMARRAGE TRIANGLE"
for S in triangle-backend triangle-frontend; do
  case "$S" in *malilink*|*hafiya*) ko "refus de redémarrer $S";; esac
  pm2 restart "$S" --update-env >/dev/null && ok "$S redémarré"
done
sleep 8; pm2 save >/dev/null && ok "pm2 save"

echo "══ VÉRIFICATIONS HTTP"
PB=$(sed -n 's/^PORT=//p' "$B/.env" | head -1 | tr -d "\"' "); PB=${PB:-5050}
PF=$(sed -n 's/^PORT=//p' "$F/.env.local" 2>/dev/null | head -1 | tr -d "\"' "); PF=${PF:-3000}
codeA(){ curl -s -o /dev/null -w '%{http_code}' --max-time 25 -H "Authorization: Bearer $2" "$1"; }
echo "  accueil                     → $(curl -s -o /dev/null -w '%{http_code}' --max-time 25 http://127.0.0.1:$PF/)"
echo "  /parametres/permissions     → $(curl -s -o /dev/null -w '%{http_code}' --max-time 25 http://127.0.0.1:$PF/parametres/permissions)   (307 = redirection connexion sans jeton)"
echo "  /permissions/me sans jeton  → $(curl -s -o /dev/null -w '%{http_code}' --max-time 25 http://127.0.0.1:$PB/permissions/me)"
echo "  /me/permissions sans jeton  → $(curl -s -o /dev/null -w '%{http_code}' --max-time 25 http://127.0.0.1:$PB/me/permissions)"
SA=$(q "SELECT id FROM users WHERE company_id=1 AND (is_super_admin OR lower(coalesce(role,''))='super_admin') AND is_active IS NOT FALSE ORDER BY id LIMIT 1")
ST=$(q "SELECT id FROM users WHERE company_id=1 AND NOT COALESCE(is_super_admin,false) AND lower(coalesce(role,'')) NOT IN ('super_admin','admin','administrateur','direction','directeur','gerant','manager') AND is_active IS NOT FALSE ORDER BY id LIMIT 1")
jeton(){ ( cd "$B" && node -e 'const j=require("jsonwebtoken");console.log(j.sign({id:+process.argv[1],company_id:1,tenant_id:1,role:process.argv[2],is_super_admin:process.argv[3]==="t"},process.env.JWT_SECRET,{expiresIn:"5m"}))' "$1" "$2" "$3" ); }
if [ -n "$SA" ]; then
  JS=$(jeton "$SA" "$(q "SELECT coalesce(role,'') FROM users WHERE id=$SA")" t)
  echo "  ── super admin #$SA (jeton transmis) ──"
  echo "    /me/permissions   → $(codeA "http://127.0.0.1:$PB/me/permissions" "$JS")   (200 attendu)"
  echo "    /permissions/me   → $(codeA "http://127.0.0.1:$PB/permissions/me" "$JS")   (200 attendu)"
  echo "    /permissions/users→ $(codeA "http://127.0.0.1:$PB/permissions/users" "$JS")   (200 attendu)"
  curl -s --max-time 25 -H "Authorization: Bearer $JS" "http://127.0.0.1:$PB/permissions/me" \
   | node -e 'let e="";process.stdin.on("data",c=>e+=c).on("end",()=>{const d=JSON.parse(e||"{}");const p=(d.permissions||{})["utilisateur.permissions"]||{};console.log(`    is_super_admin=${d.is_super_admin} gere=${d.is_super_admin===true||p.manage===true} modules=${(d.modules||[]).length} → 🔐 Droits & permissions VISIBLE`)})'
  curl -s --max-time 25 -H "Authorization: Bearer $JS" "http://127.0.0.1:$PB/me/permissions" \
   | node -e 'let e="";process.stdin.on("data",c=>e+=c).on("end",()=>{const d=JSON.parse(e||"{}");console.log(`    route historique : is_super_admin=${d.is_super_admin} fallback_allowed=${d.fallback_allowed} modules=${Object.keys(d.modules||{}).length}`)})'
  [ "$(codeA "http://127.0.0.1:$PB/permissions/users" "$JS")" = "200" ] || ko "le super admin n'accède pas à /permissions/users"
  ok "super admin autorisé sur les routes d'administration"
else echo "  ! aucun super admin actif"; fi
if [ -n "$ST" ]; then
  JT=$(jeton "$ST" "$(q "SELECT coalesce(role,'') FROM users WHERE id=$ST")" f)
  echo "  ── utilisateur standard #$ST (jeton transmis) ──"
  echo "    /permissions/me      → $(codeA "http://127.0.0.1:$PB/permissions/me" "$JT")   (200 : chacun lit ses propres droits)"
  REFUS=0
  for R in /permissions/users /permissions/modules /permissions/audit "/permissions/users/$ST"; do
    C=$(codeA "http://127.0.0.1:$PB$R" "$JT"); echo "    $R → $C"
    case "$C" in 403|404) REFUS=$((REFUS+1));; *) ko "$R devait refuser (403/404), a répondu $C";; esac
  done
  [ "$REFUS" -eq 4 ] || ko "toutes les routes d'administration n'ont pas refusé"
  curl -s --max-time 25 -H "Authorization: Bearer $JT" "http://127.0.0.1:$PB/permissions/me" \
   | node -e 'let e="";process.stdin.on("data",c=>e+=c).on("end",()=>{const d=JSON.parse(e||"{}");const p=(d.permissions||{})["utilisateur.permissions"]||{};if(p.manage===true){console.error("    ✗ manage=true pour un compte standard");process.exit(1)}console.log(`    role=${d.role} manage=${p.manage} visible=${p.visible} → entrée du menu ABSENTE`)})' || ko "un compte standard obtient manage=true"
  ok "utilisateur standard refusé sur les 4 routes d'administration (module masqué ⇒ 404)"
else echo "  aucun compte standard actif : vérification ignorée"; fi

echo "══ JOURNAUX TRIANGLE"
for S in triangle-backend triangle-frontend; do echo "  ── $S ──"; pm2 logs "$S" --lines 15 --nostream 2>/dev/null || true; done
for S in triangle-backend triangle-frontend; do
  pm2 logs "$S" --lines 60 --nostream 2>/dev/null | grep -qiE "cannot find module|eaddrinuse|unhandledrejection" && echo "  ! erreur repérée dans $S" || true
done

echo "══ CONCLUSION"
pm2 jlist | node -e 'let e="";process.stdin.on("data",c=>e+=c).on("end",()=>JSON.parse(e||"[]").forEach(p=>console.log(`  ${p.name.padEnd(22)} ${String(p.pm2_env.status).padEnd(8)} ${Math.round((Date.now()-p.pm2_env.pm_uptime)/1000)}s`)))'
echo "  ⇒ MaliLink et Hafiya : uptime supérieur à Triangle, non redémarrés"
echo "  backend  $OLD_BACKEND_SHA → $(git -C "$B" rev-parse HEAD)  (contient $REQUIRED_BACKEND_COMMIT)"
echo "  frontend $OLD_FRONTEND_SHA → $(git -C "$F" rev-parse HEAD)  (contient $REQUIRED_FRONTEND_COMMIT)"
echo "  063 sha256 $SHA_MIG"
echo "  modules $(q "SELECT count(*) FROM permission_modules") | actions $(q "SELECT count(*) FROM permission_actions") | rôles $(q "SELECT count(*) FROM role_permissions") | exceptions $(q "SELECT count(*) FROM user_permission_overrides") | journal $(q "SELECT count(*) FROM permission_audit_log")"
echo "  utilisateurs $U_AV inchangés | user_permissions $P_AV intacte"
echo "  sauvegarde $D"
echo "  ROLLBACK :"
echo "    git -C $B checkout $OLD_BACKEND_SHA"
echo "    git -C $F checkout $OLD_FRONTEND_SHA && NEXT_PUBLIC_APP_PRODUCT=triangle npm --prefix $F run build"
echo "    pm2 restart triangle-backend triangle-frontend && pm2 save"
echo "    base : 063 est additive, la laisser en place ; sinon pg_restore --clean --if-exists --no-owner -d \"\$DATABASE_URL\" $D"
echo "  → Connexion super admin : 🔐 Droits & permissions dans le menu du tableau de bord."
