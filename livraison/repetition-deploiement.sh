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
  [ -n "${COPIE:-}" ] && rm -rf "$COPIE" || true
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

# Des données d'AVANT le lot, pour que « rien n'a été perdu » veuille dire
# quelque chose. Le jeu d'essai de la partie C dépend de la migration 153 : il
# ne peut donc pas servir ici, où l'on simule l'état antérieur. On écrit donc
# directement dans les tables que la production possède déjà.
psql "$DATABASE_URL" -q <<'SQL' >/dev/null
INSERT INTO companies(id, name) VALUES (1,'Triangle'),(2,'FAT & MAT') ON CONFLICT (id) DO NOTHING;
INSERT INTO stock_requests(company_id, reference, request_type, status, motif, validated_at)
VALUES (1,'REP-AVANT-1','SORTIE','VALIDEE','antérieure au lot', now()),
       (1,'REP-AVANT-2','TRANSFERT','RECUE','antérieure au lot', now()),
       (2,'REP-AVANT-3','ENTREE','VALIDEE','antérieure au lot', now())
ON CONFLICT (company_id, reference) DO NOTHING;
SQL
avant_demandes="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM stock_requests")"
avant_empreinte="$(psql "$DATABASE_URL" -tAc "SELECT md5(string_agg(reference||status, ',' ORDER BY id)) FROM stock_requests")"
[ "$avant_demandes" -ge 3 ] || echec "Les données d'avant ne se sont pas écrites : la suite ne prouverait rien."
ok "$avant_demandes demande(s) antérieure(s) en base, empreinte ${avant_empreinte:0:12}"

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
titre "Parcours Git — pour de vrai, sur une copie isolée"
cd "$RACINE"
BRANCHE_ACTUELLE="$(git rev-parse --abbrev-ref HEAD)"
COMMIT_CIBLE="$(git rev-parse HEAD)"
COMMIT_AVANT_LOT="${COMMIT_AVANT_LOT:-$(git merge-base HEAD origin/main 2>/dev/null || echo '')}"
[ -z "$(git status --porcelain)" ] && c=0 || c=1
v $c "l'arbre de travail est propre (sinon le déploiement écraserait du local)"

# On ne se contente pas de regarder : on refait le geste du déploiement sur une
# COPIE placée à l'état d'avant le lot, comme l'est la production.
COPIE="$(mktemp -d /tmp/repetition-prod-XXXXXX)"
if [ -n "$COMMIT_AVANT_LOT" ]; then
  git clone --quiet --no-hardlinks "$RACINE" "$COPIE/backend" 2>/dev/null
  ( cd "$COPIE/backend" && git checkout --quiet "$COMMIT_AVANT_LOT" -B simulation-production ) 2>/dev/null
  [ -d "$COPIE/backend/.git" ] && c=0 || c=1
  v $c "copie « production » placée sur ${COMMIT_AVANT_LOT:0:8}, avant le lot"

  # git fetch — le geste exact du script de déploiement
  ( cd "$COPIE/backend" && git fetch origin "$BRANCHE_ACTUELLE" ) >/dev/null 2>&1
  v $? "git fetch origin $BRANCHE_ACTUELLE"

  # git checkout puis merge --ff-only : ce qui échoue si la branche a divergé
  ( cd "$COPIE/backend" && git checkout --quiet "$BRANCHE_ACTUELLE" ) >/dev/null 2>&1
  v $? "git checkout $BRANCHE_ACTUELLE (la branche locale est créée au besoin)"
  ( cd "$COPIE/backend" && git merge --ff-only "origin/$BRANCHE_ACTUELLE" ) >/dev/null 2>&1
  v $? "git merge --ff-only : avance sans commit de fusion"
  [ "$(cd "$COPIE/backend" && git rev-parse HEAD)" = "$COMMIT_CIBLE" ] && c=0 || c=1
  v $c "la copie est arrivée sur ${COMMIT_CIBLE:0:8}, le commit visé"

  # Et le refus attendu quand la production a un commit local : le déploiement
  # doit s'arrêter, pas écraser.
  ( cd "$COPIE/backend" && git checkout --quiet -B divergence "$COMMIT_AVANT_LOT" \
      && git commit --quiet --allow-empty -m "commit posé à la main sur la production" \
      && ! git merge --ff-only "origin/$BRANCHE_ACTUELLE" ) >/dev/null 2>&1
  v $? "merge --ff-only REFUSE d'avancer si la production porte un commit local"
else
  alerte "origin/main introuvable : parcours Git réel non testé."
fi

# ═══════════════════════════════════════════════════════════════════════
titre "Dépendances — npm ci réellement exécuté"
[ -f package-lock.json ] && c=0 || c=1
v $c "package-lock.json présent (npm ci l'exige)"
if [ -d "$COPIE/backend" ]; then
  ( cd "$COPIE/backend" && git checkout --quiet "$BRANCHE_ACTUELLE" 2>/dev/null
    npm ci --omit=dev --no-audit --no-fund ) > /tmp/repetition-npmci.log 2>&1
  v $? "npm ci --omit=dev aboutit sur la copie"
  [ -d "$COPIE/backend/node_modules/express" ] && c=0 || c=1
  v $c "les dépendances sont bien installées (express présent)"
  # pdfkit sert aux documents RH : s'il est en devDependencies, --omit=dev le perd.
  [ -d "$COPIE/backend/node_modules/pdfkit" ] && c=0 || c=1
  v $c "pdfkit survit à --omit=dev (sinon les PDF RH casseraient en production)"
fi
node -e "require('pdfkit'); require('pg'); require('express')" 2>/dev/null
v $? "les dépendances clés se chargent ici aussi"

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
apres_empreinte="$(psql "$DATABASE_URL" -tAc "SELECT md5(string_agg(reference||status, ',' ORDER BY id)) FROM stock_requests")"
[ "$apres_demandes" = "$avant_demandes" ] && c=0 || c=1
v $c "aucune demande perdue ($avant_demandes avant, $apres_demandes après)"
[ "$apres_empreinte" = "$avant_empreinte" ] && c=0 || c=1
v $c "aucune demande MODIFIÉE (même empreinte de contenu)"

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
retour_empreinte="$(psql "$DATABASE_URL" -tAc "SELECT md5(string_agg(reference||status, ',' ORDER BY id)) FROM stock_requests" 2>/dev/null || echo vide)"
[ "$retour_demandes" = "$avant_demandes" ] && c=0 || c=1
v $c "les données d'avant sont retrouvées ($retour_demandes demandes)"
[ "$retour_empreinte" = "$avant_empreinte" ] && c=0 || c=1
v $c "et à l'identique (même empreinte de contenu)"

# ═══════════════════════════════════════════════════════════════════════
titre "Retour arrière du CODE — distinct de celui de la base"
cd "$RACINE"
# Le déploiement note le commit d'avant dans $SAUVEGARDES/.commit-<horodatage> :
# c'est ce fichier, et non la base, qui permet de revenir au code d'avant.
git rev-parse --verify "$COMMIT_AVANT_LOT" >/dev/null 2>&1
v $? "le commit d'avant le lot est retrouvable (${COMMIT_AVANT_LOT:0:8})"
ls "$SAUVEGARDES"/.commit-* >/dev/null 2>&1 && c=1 || c=0
v $c "« migrer » seul n'a pas touché au code (aucun .commit-* écrit)"
[ "$(git rev-parse HEAD)" = "$COMMIT_CIBLE" ] && c=0 || c=1
v $c "le dépôt est resté sur son commit (la répétition n'a rien déplacé)"

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
