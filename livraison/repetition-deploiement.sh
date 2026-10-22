#!/usr/bin/env bash
#
# ═════════════════════════════════════════════════════════════════════════
#  RÉPÉTITION DU DÉPLOIEMENT, SUR UN ENVIRONNEMENT ISOLÉ
#
#  Tout le parcours — Git, dépendances, migrations, build, démarrage,
#  contrôles de santé, retour arrière — contre une base qui reproduit le
#  schéma de production, Y COMPRIS la V16 posée hors de Git.
#
#      ./repetition-deploiement.sh
#
#  Rien de ce qui est fait ici ne touche la production : base jetable, port
#  dédié, aucun PM2.
#
#  Le but n'est pas de voir le script « marcher » : c'est de voir ce qui
#  casse, dans un endroit où cela ne coûte rien.
# ═════════════════════════════════════════════════════════════════════════
# Pas de « set -e » : une répétition doit montrer TOUS les points qui cassent,
# pas s'arrêter au premier. Les commandes dont dépend la suite portent « || echec ».
set -uo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGPORT="${PGPORT:-5433}"
BASE="${BASE:-repetition_$(date +%H%M%S)}"
PORT=5050   # codé en dur dans server.js : on ne le choisit pas
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
FRONT="${FRONT:-$(cd "$RACINE/../triangle-wms-frontend" 2>/dev/null && pwd || echo '')}"
SAUVEGARDES="${SAUVEGARDES:-/tmp/repetition-sauvegardes}"
export DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${BASE}"
export JWT_SECRET="${JWT_SECRET:-repetition}" NODE_ENV=test

ROUGE=$'\033[31m'; VERT=$'\033[32m'; JAUNE=$'\033[33m'; GRAS=$'\033[1m'; ZERO=$'\033[0m'
etape=0
titre() { etape=$((etape+1)); echo; echo "${GRAS}── ÉTAPE $etape : $* ${ZERO}"; }
ok()    { echo "  ${VERT}✔${ZERO} $*"; }
alerte(){ echo "  ${JAUNE}!${ZERO} $*"; }
echec() { echo "  ${ROUGE}✘ $*${ZERO}" >&2; exit 1; }
reussis=0; echoues=0
v() { if [ "$1" = "0" ]; then reussis=$((reussis+1)); ok "$2"; else echoues=$((echoues+1)); echo "  ${ROUGE}✘ $2${ZERO}"; fi; }

nettoyer() {
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true
  psql "postgresql://postgres@127.0.0.1:${PGPORT}/postgres" -tAc \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${BASE}'" >/dev/null 2>&1 || true
  su postgres -c "$PGBIN/dropdb -p $PGPORT --force --if-exists $BASE" >/dev/null 2>&1 || true
}
trap nettoyer EXIT

echo "${GRAS}RÉPÉTITION DU DÉPLOIEMENT${ZERO}"
echo "  base   : $BASE (jetable)"
echo "  port   : $PORT"
echo "  racine : $RACINE"

# ═══════════════════════════════════════════════════════════════════════
titre "Un environnement qui ressemble à la production"
pg_isready -p "$PGPORT" -q 2>/dev/null || \
  su postgres -c "$PGBIN/pg_ctl -D ${PGDATA:-/var/lib/postgresql/pgtest} -o '-p $PGPORT -c listen_addresses=127.0.0.1' -l /tmp/pg.log start -w" >/dev/null
su postgres -c "$PGBIN/createdb -p $PGPORT $BASE" || echec "Création de la base impossible."
psql -q "$DATABASE_URL" -tAc "CREATE ROLE triangle_user LOGIN" >/dev/null 2>&1 || true
ok "base créée"

# L'état d'AVANT : les migrations 0xx à 102, comme la production.
cd "$RACINE/sql"; N=0
for f in $(ls *.sql | grep -E '^(0|10[0-2])' | sort -V); do
  psql "$DATABASE_URL" -q -f "$f" >/dev/null 2>&1 && N=$((N+1)) || true
done
cd "$RACINE"
ok "$N migrations antérieures appliquées"

# Le registre, et la V16 posée hors de Git — c'est ce détail qui rend la
# répétition fidèle : sans lui, on ne testerait pas le cas réel.
psql "$DATABASE_URL" -q <<SQL
CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO schema_migrations(filename)
SELECT f FROM unnest(ARRAY['106_documents_rh_v16.sql','106_1_correctif_postgresql.sql']) AS f
ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations(filename)
SELECT regexp_replace(f, '^.*/', '') FROM unnest(ARRAY['100_jours_feries_et_chomes.sql','101_pointage_brut_et_officiel.sql','102_receptions_conteneurs_vehicule_et_alias.sql']) AS f
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS rh_contrats (id SERIAL PRIMARY KEY, company_id INT, salarie_id INT, type TEXT);
CREATE TABLE IF NOT EXISTS rh_documents_emis (id SERIAL PRIMARY KEY, company_id INT, reference TEXT);
SQL
ok "V16 RH simulée (tables rh_*, migrations 106 au registre)"

# Des données, pour que le retour arrière ait quelque chose à protéger.
psql "$DATABASE_URL" -q -f scripts/jeu-essai-demandes-correction.sql >/dev/null 2>&1 || true
avant_demandes="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM stock_requests" 2>/dev/null || echo 0)"
ok "$avant_demandes demande(s) en base"

# ═══════════════════════════════════════════════════════════════════════
titre "Détection des conflits AVANT de toucher à quoi que ce soit"
set +e
node scripts/verifier-migrations.js > /tmp/repetition-conflits.log 2>&1
code=$?
set -e
grep -q "rh_contrats" /tmp/repetition-conflits.log; v $? "les tables de la V16 sont repérées"
grep -q "106_documents_rh_v16.sql" /tmp/repetition-conflits.log; v $? "la migration 106 hors Git est repérée"
grep -q "aucun numéro partagé entre la branche et la base" /tmp/repetition-conflits.log
v $? "aucune collision de numéro après renumérotation en 150–154"
[ "$code" = "2" ]; v $? "le détecteur sort en code 2 : il bloquerait le déploiement"

# ═══════════════════════════════════════════════════════════════════════
titre "Parcours Git"
cd "$RACINE"
git rev-parse --abbrev-ref HEAD >/dev/null 2>&1; v $? "le dépôt répond"
BRANCHE_ACTUELLE="$(git rev-parse --abbrev-ref HEAD)"
COMMIT_AVANT="$(git rev-parse HEAD)"
ok "branche $BRANCHE_ACTUELLE, commit ${COMMIT_AVANT:0:8}"
[ -z "$(git status --porcelain)" ]; v $? "l'arbre de travail est propre (sinon le déploiement écraserait du local)"

# ═══════════════════════════════════════════════════════════════════════
titre "Dépendances"
[ -f package-lock.json ]; v $? "package-lock.json présent (npm ci l'exige)"
node -e "require('pdfkit'); require('pg'); require('express')" 2>/dev/null
v $? "les dépendances clés se chargent (pdfkit, pg, express)"

# ═══════════════════════════════════════════════════════════════════════
titre "Sauvegarde vérifiée, puis migrations"
rm -rf "$SAUVEGARDES"
RACINE="$RACINE" SAUVEGARDES="$SAUVEGARDES" DATABASE_URL="$DATABASE_URL" \
  bash livraison/deployer.sh migrer > /tmp/repetition-migrer.log 2>&1
code=$?
grep -q "restauration d'essai réussie" /tmp/repetition-migrer.log
v $? "la sauvegarde a été RESTAURÉE pour vérification, pas seulement écrite"
grep -qE "[0-9]+ migration\(s\) appliquée\(s\)" /tmp/repetition-migrer.log
v $? "les migrations se sont appliquées"
[ "$code" = "0" ]; v $? "la commande s'est terminée sans erreur"

for t in internal_fund_transfers hr_contracts hr_documents stock_request_corrections cement_payment_reversals; do
  psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.$t')" | grep -q "$t"
  v $? "table $t créée"
done

# Le point le plus important : la V16 n'a pas été touchée.
psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.rh_contrats')" | grep -q rh_contrats
v $? "les tables de la V16 sont INTACTES"
apres_demandes="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM stock_requests")"
[ "$apres_demandes" = "$avant_demandes" ]
v $? "aucune donnée perdue ($avant_demandes demandes avant et après)"

# ═══════════════════════════════════════════════════════════════════════
titre "Idempotence : rejouer ne doit rien changer"
RACINE="$RACINE" SAUVEGARDES="$SAUVEGARDES" DATABASE_URL="$DATABASE_URL" \
  bash livraison/deployer.sh migrer > /tmp/repetition-migrer2.log 2>&1
grep -q "aucune migration à appliquer" /tmp/repetition-migrer2.log
v $? "le second passage ne rejoue rien"

# ═══════════════════════════════════════════════════════════════════════
titre "Démarrage et contrôles de santé"
fuser -k 5050/tcp 2>/dev/null || true
node server.js > /tmp/repetition-serveur.log 2>&1 &
SRV=$!
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:5050/" 2>/dev/null && break; sleep 1; done
curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:5050/" | grep -qE '^[234]'
v $? "le serveur répond"
grep -q "ROUTES MASQUÉES" /tmp/repetition-serveur.log
v $? "le détecteur de routes masquées s'exécute au démarrage"

RACINE="$RACINE" SAUVEGARDES="$SAUVEGARDES" DATABASE_URL="$DATABASE_URL" PORT=5050 SERVICE=inexistant \
  bash livraison/deployer.sh sante > /tmp/repetition-sante.log 2>&1 || true
grep -q "le tableau de bord financier a la colonne qui lui manquait" /tmp/repetition-sante.log
v $? "le contrôle de santé voit la colonne show_in_financial_movements"

# ═══════════════════════════════════════════════════════════════════════
titre "Construction du frontend"
if [ -n "$FRONT" ] && [ -d "$FRONT" ]; then
  ( cd "$FRONT" && BACKEND_URL=http://127.0.0.1:5050 npx next build > /tmp/repetition-build.log 2>&1 )
  v $? "le frontend se construit"
  grep -q "Compiled successfully" /tmp/repetition-build.log
  v $? "compilation sans erreur"
else
  alerte "Dépôt frontend introuvable : construction non testée."
fi

# ═══════════════════════════════════════════════════════════════════════
titre "Retour arrière de la BASE"
kill "$SRV" 2>/dev/null || true; SRV=""
HORO="$(ls -1t "$SAUVEGARDES"/triangle-*.dump 2>/dev/null | tail -1 | sed 's|.*triangle-||; s|\.dump||')"
[ -n "$HORO" ]; v $? "une sauvegarde d'avant les migrations existe"

echo "RETOUR ARRIERE" | RACINE="$RACINE" SAUVEGARDES="$SAUVEGARDES" DATABASE_URL="$DATABASE_URL" \
  PORT=5050 SERVICE=inexistant bash livraison/deployer.sh retour "$HORO" > /tmp/repetition-retour.log 2>&1 || true
grep -q "état actuel conservé" /tmp/repetition-retour.log
v $? "l'état d'avant le retour a été sauvegardé (revenir n'est pas sans retour)"
grep -q "schéma vidé" /tmp/repetition-retour.log
v $? "le schéma a été vidé (pg_restore --clean ne suffit pas)"

restantes=0
for t in internal_fund_transfers hr_contracts stock_request_corrections; do
  psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.$t')" | grep -q "$t" && restantes=$((restantes+1)) || true
done
[ "$restantes" = "0" ]
v $? "les tables du lot ont bien disparu ($restantes restante(s))"
psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.rh_contrats')" | grep -q rh_contrats
v $? "les tables de la V16 sont revenues avec la sauvegarde"
retour_demandes="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM stock_requests" 2>/dev/null || echo 0)"
[ "$retour_demandes" = "$avant_demandes" ]
v $? "les données d'avant sont retrouvées ($retour_demandes demandes)"

# ═══════════════════════════════════════════════════════════════════════
titre "Retour arrière du CODE — distinct de celui de la base"
cd "$RACINE"
git rev-parse --verify "$COMMIT_AVANT" >/dev/null 2>&1
v $? "le commit d'avant est retrouvable (${COMMIT_AVANT:0:8})"
[ "$(git rev-parse HEAD)" = "$COMMIT_AVANT" ]
v $? "le dépôt est resté sur son commit (la répétition n'a rien déplacé)"

echo
echo "${GRAS}$(printf '─%.0s' $(seq 1 62))${ZERO}"
echo "  $reussis réussis, $echoues échoués"
if [ "$echoues" = "0" ]; then
  echo "  Le parcours complet tient, V16 comprise, et le retour arrière"
  echo "  ramène exactement l'état d'avant."
else
  echo "  ${ROUGE}Des points restent à corriger avant de déployer.${ZERO}"
fi
echo "${GRAS}$(printf '─%.0s' $(seq 1 62))${ZERO}"
[ "$echoues" = "0" ]
