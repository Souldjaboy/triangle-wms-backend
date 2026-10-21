#!/usr/bin/env bash
#
# ═════════════════════════════════════════════════════════════════════════
#  RÉCUPÉRER LA V16 RH DEPUIS LE VPS — EN LECTURE SEULE
#
#  La V16 des documents RH a été posée directement sur le serveur : elle
#  n'est pas dans Git. Avant de déployer la nouvelle partie A, il faut la
#  voir, pour n'en garder qu'une seule.
#
#  CE SCRIPT NE MODIFIE RIEN SUR LE VPS. Il copie, il ne pousse pas. Il ne
#  redémarre rien. Il n'ouvre aucune transaction en écriture.
#
#  CE QU'IL NE RAMÈNE JAMAIS
#    • aucun .env, aucune clé, aucun certificat, aucun secret ;
#    • aucune donnée personnelle : pas de noms, pas de salaires, pas de
#      numéros. Seulement la STRUCTURE — colonnes, types, contraintes.
#
#  USAGE, depuis votre poste :
#      ./recuperer-v16.sh utilisateur@vps.exemple.com
#  ou directement SUR le VPS :
#      ./recuperer-v16.sh --local
#
#  Le résultat est une archive à rapatrier et à poser dans
#  `livraison/v16-recuperee/` du dépôt.
# ═════════════════════════════════════════════════════════════════════════
set -euo pipefail

CIBLE="${1:-}"
RACINE_VPS="${RACINE_VPS:-/var/www/triangle-wms/backend}"
FRONT_VPS="${FRONT_VPS:-/var/www/triangle-wms/frontend}"
SORTIE="${SORTIE:-/tmp/v16-$(date +%Y%m%d-%H%M%S)}"

ROUGE=$'\033[31m'; VERT=$'\033[32m'; JAUNE=$'\033[33m'; GRAS=$'\033[1m'; ZERO=$'\033[0m'
titre() { echo; echo "${GRAS}── $* ${ZERO}"; }
ok()    { echo "  ${VERT}✔${ZERO} $*"; }
alerte(){ echo "  ${JAUNE}!${ZERO} $*"; }
echec() { echo "  ${ROUGE}✘ $*${ZERO}" >&2; exit 1; }

[ -n "$CIBLE" ] || echec "Usage : $0 utilisateur@serveur   (ou --local sur le VPS)"

# ── CE QU'ON CHERCHE ─────────────────────────────────────────────────────
# Des MOTIFS, pas une liste figée : la V16 peut nommer ses fichiers autrement
# que je ne l'imagine. On ratisse large sur le nom, et on filtre ensuite.
MOTIFS_RH='rh|hr|contrat|contract|bulletin|payslip|paie|attestation|certificat|diplome|diplôme|employe|salarie'

# ── CE QU'ON NE RAMÈNE JAMAIS ────────────────────────────────────────────
# Première barrière : on n'entre pas dans ces fichiers. La seconde barrière
# est le caviardage, plus bas — on ne compte pas sur une seule.
EXCLUS='\.env|\.pem$|\.key$|\.crt$|\.p12$|id_rsa|credentials|secret|password|node_modules|\.git/|uploads/|\.log$'

# ── EXÉCUTION LOCALE OU DISTANTE ─────────────────────────────────────────
if [ "$CIBLE" = "--local" ]; then
  distant() { bash -c "$1"; }
  rapatrier() { cp -r "$1" "$2"; }
else
  # `-n` : jamais d'invite interactive qui pourrait faire attendre un script.
  distant() { ssh -o BatchMode=yes "$CIBLE" "$1"; }
  rapatrier() { scp -q -r "$CIBLE:$1" "$2"; }
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$CIBLE" true 2>/dev/null \
    || echec "Connexion SSH impossible vers $CIBLE (clé absente ou hôte injoignable)."
fi

mkdir -p "$SORTIE"/{routes,services,sql,frontend,schema,permissions}

titre "Ce qui va être récupéré"
echo "    source  : ${CIBLE/--local/ce serveur} — $RACINE_VPS"
echo "    sortie  : $SORTIE"
echo "    exclus  : .env, clés, certificats, uploads, journaux, données"
echo

# ── 1. LES FICHIERS SOURCE ───────────────────────────────────────────────
titre "Fichiers source RH"
for dossier in routes services sql; do
  liste="$(distant "ls -1 '$RACINE_VPS/$dossier' 2>/dev/null | grep -Ei '$MOTIFS_RH' | grep -Ev '$EXCLUS' || true")"
  n=0
  while read -r f; do
    [ -n "$f" ] || continue
    rapatrier "$RACINE_VPS/$dossier/$f" "$SORTIE/$dossier/" 2>/dev/null && n=$((n+1)) || true
  done <<< "$liste"
  ok "$dossier : $n fichier(s)"
done

liste_front="$(distant "find '$FRONT_VPS/app' -maxdepth 3 -type f \\( -name '*.tsx' -o -name '*.ts' \\) 2>/dev/null | grep -Ei '$MOTIFS_RH' | grep -Ev '$EXCLUS' || true")"
n=0
while read -r f; do
  [ -n "$f" ] || continue
  nom="$(echo "$f" | sed "s|$FRONT_VPS/app/||; s|/|__|g")"
  rapatrier "$f" "$SORTIE/frontend/$nom" 2>/dev/null && n=$((n+1)) || true
done <<< "$liste_front"
ok "frontend : $n fichier(s)"

# ── 2. LE SCHÉMA, SANS LES DONNÉES ───────────────────────────────────────
# `--schema-only` : la STRUCTURE seule. Aucun nom, aucun salaire, aucune
# ligne ne quitte le serveur.
titre "Schéma des tables RH (structure seule, aucune donnée)"
distant "cd '$RACINE_VPS' && \
  DB=\"\$( [ -n \"\${DATABASE_URL:-}\" ] && echo \"\$DATABASE_URL\" || grep -E '^DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\\"'\\\''' )\" && \
  TABLES=\"\$(psql \"\$DB\" -tAc \"SELECT string_agg('-t '||quote_ident(table_name), ' ') FROM information_schema.tables WHERE table_schema='public' AND table_name ~* '^(hr_|rh_)'\")\" && \
  [ -n \"\$TABLES\" ] && eval pg_dump --schema-only --no-owner --no-acl \$TABLES \\\"\$DB\\\" || echo '-- aucune table RH trouvée'" \
  > "$SORTIE/schema/tables-rh.sql" 2>/dev/null || alerte "Extraction du schéma impossible."
lignes="$(wc -l < "$SORTIE/schema/tables-rh.sql" 2>/dev/null || echo 0)"
ok "schéma : $lignes lignes"

# Le registre des migrations : des noms de fichiers, rien de personnel.
distant "cd '$RACINE_VPS' && \
  DB=\"\$( [ -n \"\${DATABASE_URL:-}\" ] && echo \"\$DATABASE_URL\" || grep -E '^DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\\"'\\\''' )\" && \
  psql \"\$DB\" -tAc 'SELECT filename FROM schema_migrations ORDER BY filename' 2>/dev/null || true" \
  > "$SORTIE/schema/migrations-appliquees.txt" 2>/dev/null || true
ok "registre : $(wc -l < "$SORTIE/schema/migrations-appliquees.txt" 2>/dev/null || echo 0) migration(s)"

# ── 3. LES PERMISSIONS ───────────────────────────────────────────────────
# Des clés de module et des rôles. Aucun nom d'utilisateur.
titre "Modules de permission RH"
distant "cd '$RACINE_VPS' && \
  DB=\"\$( [ -n \"\${DATABASE_URL:-}\" ] && echo \"\$DATABASE_URL\" || grep -E '^DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\\"'\\\''' )\" && \
  psql \"\$DB\" -tAc \"SELECT module_key||' | '||COALESCE(parent_key,'-')||' | '||array_to_string(actions,',') FROM permission_modules WHERE module_key ~* '(rh|hr|paie|contrat)' ORDER BY module_key\" 2>/dev/null || true" \
  > "$SORTIE/permissions/modules-rh.txt" 2>/dev/null || true
ok "$(wc -l < "$SORTIE/permissions/modules-rh.txt" 2>/dev/null || echo 0) module(s)"

distant "cd '$RACINE_VPS' && \
  DB=\"\$( [ -n \"\${DATABASE_URL:-}\" ] && echo \"\$DATABASE_URL\" || grep -E '^DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\\"'\\\''' )\" && \
  psql \"\$DB\" -tAc \"SELECT DISTINCT role||' | '||module_key||' | '||action||' | '||allowed FROM role_permissions WHERE module_key ~* '(rh|hr|paie|contrat)' ORDER BY 1\" 2>/dev/null || true" \
  > "$SORTIE/permissions/droits-par-role.txt" 2>/dev/null || true
ok "$(wc -l < "$SORTIE/permissions/droits-par-role.txt" 2>/dev/null || echo 0) droit(s) par rôle"

# ── 4. LES ROUTES DÉCLARÉES ──────────────────────────────────────────────
titre "Routes RH déclarées"
distant "grep -rhoE '(router|app)\\.(get|post|put|patch|delete)\\(\\s*[\"'\\''\\\`][^\"'\\''\\\`]+' '$RACINE_VPS/routes' '$RACINE_VPS/server.js' 2>/dev/null | grep -Ei '$MOTIFS_RH' | sort -u || true" \
  > "$SORTIE/routes/liste-routes.txt" 2>/dev/null || true
ok "$(wc -l < "$SORTIE/routes/liste-routes.txt" 2>/dev/null || echo 0) route(s)"

# ── 5. LE CAVIARDAGE — SECONDE BARRIÈRE ──────────────────────────────────
# On a déjà écarté les fichiers sensibles. On passe quand même sur ce qui a
# été ramené : une clé recopiée en dur dans un fichier source ne doit pas
# traverser. Une seule barrière n'est pas une barrière.
titre "Caviardage"
trouves=0
while IFS= read -r -d '' f; do
  avant="$(md5sum "$f" | cut -d' ' -f1)"
  sed -i -E \
    -e "s/(password|passwd|secret|token|api[_-]?key|private[_-]?key)([\"' ]*[:=][\"' ]*)[^\"',;) ]+/\\1\\2«CAVIARDÉ»/gi" \
    -e "s#(postgres(ql)?://[^:]+:)[^@]+@#\\1«CAVIARDÉ»@#g" \
    -e "s/(Bearer )[A-Za-z0-9._-]{20,}/\\1«CAVIARDÉ»/g" \
    -e "s/eyJ[A-Za-z0-9._-]{20,}/«JETON-CAVIARDÉ»/g" \
    "$f"
  [ "$(md5sum "$f" | cut -d' ' -f1)" != "$avant" ] && trouves=$((trouves+1)) || true
done < <(find "$SORTIE" -type f -print0)
if [ "$trouves" -gt 0 ]; then
  alerte "$trouves fichier(s) contenaient une valeur sensible : elle a été remplacée."
else
  ok "aucune valeur sensible trouvée dans ce qui a été ramené"
fi

# ── 6. LE CONTRÔLE FINAL ─────────────────────────────────────────────────
titre "Contrôle"
# Le contrôle cherche une VALEUR qui ressemble encore à un secret, pas un
# nom de clé : « api_key = "«CAVIARDÉ»" » doit passer. Six caractères au
# moins, et qui ne commencent pas par le marqueur de caviardage. Sans cela,
# ["' ]* pouvait ne rien consommer et [^«] matchait l'espace après le =.
MOTIF_RESTE=$'(password|passwd|secret|token|api[_-]?key|private[_-]?key)[^=:]{0,16}[:=][[:space:]]*["\'`]?[^«"\'`[:space:],;)]{6,}'
restes="$(grep -rlIE "$MOTIF_RESTE" "$SORTIE" 2>/dev/null || true)"
[ -z "$restes" ] || { echo "$restes"; echec "Des valeurs sensibles subsistent. Archive NON créée."; }
ok "aucune valeur sensible résiduelle"

# Les formes de secret reconnaissables, quel que soit le nom de la variable.
# C'est cette passe qui attrape ce qu'on n'avait pas prévu de nommer.
FORMES='(sk_live_|sk_test_|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9._-]{30,}|BEGIN [A-Z ]*PRIVATE KEY)'
formes="$(grep -rlIE "$FORMES" "$SORTIE" 2>/dev/null || true)"
[ -z "$formes" ] || { echo "$formes"; echec "Des valeurs de forme secrète subsistent. Archive NON créée."; }
ok "aucune valeur de forme secrète (clé d'API, jeton, clé privée)"

donnees="$(grep -rlIE 'INSERT INTO (hr_|rh_)' "$SORTIE/schema" 2>/dev/null || true)"
[ -z "$donnees" ] || { echo "$donnees"; echec "Le schéma contient des données. Archive NON créée."; }
ok "le schéma ne contient aucune donnée"

archive="$SORTIE.tar.gz"
tar -czf "$archive" -C "$(dirname "$SORTIE")" "$(basename "$SORTIE")"
ok "archive : $archive  ($(du -h "$archive" | cut -f1))"

titre "Suite"
echo "    1. Rapatriez l'archive et décompressez-la dans le dépôt :"
echo "         tar -xzf $(basename "$archive") -C livraison/"
echo "         mv livraison/$(basename "$SORTIE") livraison/v16-recuperee"
echo "    2. Comparez :"
echo "         node scripts/comparer-rh-v16.js livraison/v16-recuperee"
echo
alerte "Rien n'a été modifié sur le serveur."
