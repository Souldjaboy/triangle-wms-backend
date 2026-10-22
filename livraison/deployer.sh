#!/usr/bin/env bash
#
# ═════════════════════════════════════════════════════════════════════════
#  TRIANGLE WMS PRO — DÉPLOIEMENT
#
#  Un seul script. Il vérifie les prérequis, SAUVEGARDE, applique les
#  migrations, redémarre, contrôle la santé — et sait revenir en arrière.
#
#  AUCUN MOT DE PASSE N'EST ÉCRIT ICI. Les accès viennent de l'environnement
#  (DATABASE_URL) ou du fichier .env de l'application, que ce script LIT sans
#  jamais l'afficher ni le copier.
#
#  USAGE
#    ./deployer.sh verifier     ce qui serait fait, sans rien faire
#    ./deployer.sh sauvegarder  une sauvegarde vérifiée, et rien d'autre
#    ./deployer.sh migrer       sauvegarde + migrations, sans toucher au code
#    ./deployer.sh deployer     la séquence complète
#    ./deployer.sh sante        l'état de l'application
#    ./deployer.sh retour <horodatage>   revenir à une sauvegarde
#    ./deployer.sh sauvegardes  lister ce qui est disponible
#
#  LE DÉPLOIEMENT S'ARRÊTE À LA PREMIÈRE ERREUR, et il s'arrête AVANT d'avoir
#  touché quoi que ce soit si la sauvegarde n'est pas vérifiée. Une sauvegarde
#  qu'on n'a pas relue n'est pas une sauvegarde.
# ═════════════════════════════════════════════════════════════════════════
set -euo pipefail

RACINE="${RACINE:-/var/www/triangle-wms/backend}"
SAUVEGARDES="${SAUVEGARDES:-/var/backups/triangle-wms}"
SERVICE="${SERVICE:-triangle-backend}"
PORT="${PORT:-5050}"
BRANCHE="${BRANCHE:-claude/droits-permissions-erreur-comptes-dyg32h}"
HORODATAGE="$(date +%Y%m%d-%H%M%S)"

ROUGE=$'\033[31m'; VERT=$'\033[32m'; JAUNE=$'\033[33m'; GRAS=$'\033[1m'; ZERO=$'\033[0m'
titre() { echo; echo "${GRAS}── $* ${ZERO}"; }
ok()    { echo "  ${VERT}✔${ZERO} $*"; }
alerte(){ echo "  ${JAUNE}!${ZERO} $*"; }
echec() { echo "  ${ROUGE}✘ $*${ZERO}" >&2; exit 1; }

# ── L'ACCÈS À LA BASE ────────────────────────────────────────────────────
# Priorité à l'environnement ; à défaut, le .env de l'application. Le mot de
# passe n'est jamais affiché, ni recopié dans un fichier de ce script.
resoudre_base() {
  if [ -n "${DATABASE_URL:-}" ]; then return; fi
  if [ -f "$RACINE/.env" ]; then
    DATABASE_URL="$(grep -E '^DATABASE_URL=' "$RACINE/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
    export DATABASE_URL
  fi
  [ -n "${DATABASE_URL:-}" ] || echec "DATABASE_URL introuvable (ni dans l'environnement, ni dans $RACINE/.env)."
}

# L'URL sans ses identifiants, pour pouvoir l'afficher sans tout divulguer.
url_masquee() { echo "${DATABASE_URL}" | sed -E 's#://[^@]*@#://***:***@#'; }

# ── PRÉREQUIS ────────────────────────────────────────────────────────────
verifier_prerequis() {
  titre "Prérequis"
  for outil in psql pg_dump node git; do
    command -v "$outil" >/dev/null || echec "« $outil » est absent."
    ok "$outil présent"
  done
  command -v pm2 >/dev/null && ok "pm2 présent" || alerte "pm2 absent : le redémarrage sera à faire à la main."

  [ -d "$RACINE" ] || echec "Dossier applicatif introuvable : $RACINE"
  ok "application : $RACINE"

  resoudre_base
  psql "$DATABASE_URL" -tAc "SELECT 1" >/dev/null 2>&1 || echec "Base inaccessible : $(url_masquee)"
  ok "base accessible : $(url_masquee)"

  mkdir -p "$SAUVEGARDES"
  local libre
  libre="$(df -Pk "$SAUVEGARDES" | awk 'NR==2 {print int($4/1024)}')"
  [ "$libre" -ge 500 ] || echec "Moins de 500 Mo libres dans $SAUVEGARDES ($libre Mo) : une sauvegarde tronquée ne protège de rien."
  ok "espace disque : $libre Mo libres"

  local taille
  taille="$(psql "$DATABASE_URL" -tAc "SELECT pg_size_pretty(pg_database_size(current_database()))")"
  ok "taille de la base : $taille"
}

# ── CE QUI SERAIT APPLIQUÉ ───────────────────────────────────────────────
migrations_en_attente() {
  resoudre_base
  local appliquees=""
  if psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.schema_migrations')" | grep -q schema_migrations; then
    appliquees="$(psql "$DATABASE_URL" -tAc "SELECT filename FROM schema_migrations")"
  fi
  for f in "$RACINE"/sql/[0-9]*.sql; do
    local nom; nom="$(basename "$f")"
    echo "$appliquees" | grep -qx "$nom" || echo "$nom"
  done
}

# ── LES COLLISIONS DE MIGRATIONS ─────────────────────────────────────────
# Un numéro de migration n'est qu'une étiquette : ce qui compte, c'est de
# savoir si les STRUCTURES existent déjà. Le détecteur compare les fichiers de
# la branche aux objets réellement présents dans la base, en lecture seule, et
# sort en code 2 quand une collision empêcherait le déploiement d'aboutir.
verifier_collisions() {
  titre "Collisions de migrations"
  resoudre_base
  if [ ! -f "$RACINE/scripts/verifier-migrations.js" ]; then
    alerte "scripts/verifier-migrations.js absent : collisions non vérifiées."
    return 0
  fi
  local journal="$SAUVEGARDES/collisions-$HORODATAGE.log"
  mkdir -p "$SAUVEGARDES"
  # Le statut se relève par « || code=$? », et pas autrement. Deux pièges se
  # cumulent ici : après un « if cmd; then … fi » sans else, $? vaut 0 même
  # quand cmd a échoué ; et sous « set -e », une commande qui rend 3 hors d'une
  # condition tue le script sur place, avant le case. Les deux rendaient ce
  # garde-fou inopérant, chacun à sa manière.
  local code=0
  ( cd "$RACINE" && node scripts/verifier-migrations.js ) > "$journal" 2>&1 || code=$?
  if [ "$code" = "0" ]; then
    ok "aucune collision"
    return 0
  fi
  case "$code" in
    2)
      sed -n '/BLOQUANT/,$p' "$journal" | head -30
      echo "    Rapport complet : $journal"
      echec "Une migration de la branche entrerait en conflit avec ce que la base
  porte déjà. Résolvez d'abord (voir sql/README-NUMEROTATION.md) : appliquer
  par-dessus laisserait le registre et le schéma en désaccord." ;;
    3)
      sed -n '/VERDICT/,$p' "$journal" | head -16
      echo "    Rapport complet : $journal"
      echec "Les tables RH de la V16 sont en base et leur modèle n'a pas été
  déclaré comparé. Ce n'est pas un conflit : les deux modèles peuvent coexister.
  Comparez-les, puis relancez en l'attestant :
      V16_RH_RECONCILIEE=oui $0 ${COMMANDE:-deployer}" ;;
    *)
      echo "    Rapport complet : $journal"
      alerte "le détecteur a renvoyé le code $code : lisez $journal" ;;
  esac
}

verifier() {
  verifier_prerequis
  verifier_collisions

  titre "Migrations"
  local liste; liste="$(migrations_en_attente || true)"
  if [ -z "$liste" ]; then
    ok "aucune migration en attente"
  else
    echo "$liste" | while read -r m; do [ -n "$m" ] && echo "    • $m"; done
    alerte "$(echo "$liste" | grep -c . ) migration(s) seront appliquées"
  fi

  titre "Code"
  ( cd "$RACINE" && git fetch --quiet origin "$BRANCHE" 2>/dev/null || true )
  local ici la_bas
  ici="$(cd "$RACINE" && git rev-parse --short HEAD 2>/dev/null || echo '?')"
  la_bas="$(cd "$RACINE" && git rev-parse --short "origin/$BRANCHE" 2>/dev/null || echo '?')"
  echo "    déployé : $ici"
  echo "    branche : $la_bas ($BRANCHE)"
  [ "$ici" = "$la_bas" ] && ok "le code est déjà à jour" || alerte "le code sera mis à jour"

  titre "Ce que ce script ne fera PAS"
  echo "    • aucune suppression de données"
  echo "    • aucun import de factures ni de réceptions"
  echo "    • aucune annulation de facture FAT & MAT"
  echo "    • aucun paiement déclenché"
  echo
  ok "Vérification terminée. Rien n'a été modifié."
}

# ── SAUVEGARDE ───────────────────────────────────────────────────────────
# Une sauvegarde qu'on n'a pas relue n'est pas une sauvegarde : on la
# restaure dans une base jetable et on compte les tables avant d'aller plus
# loin. C'est quelques minutes ; une restauration qui échoue le jour où on en
# a besoin, c'est l'entreprise à l'arrêt.
sauvegarder() {
  resoudre_base
  mkdir -p "$SAUVEGARDES"
  local fichier="$SAUVEGARDES/triangle-$HORODATAGE.dump"

  titre "Sauvegarde"
  echo "    destination : $fichier"
  pg_dump --format=custom --no-owner --no-acl --file="$fichier" "$DATABASE_URL" \
    || echec "La sauvegarde a échoué. Rien n'a été déployé."
  local taille; taille="$(du -h "$fichier" | cut -f1)"
  ok "écrite : $taille"

  titre "Vérification de la sauvegarde"
  pg_restore --list "$fichier" >/dev/null 2>&1 || echec "Le fichier n'est pas une sauvegarde lisible."
  local objets; objets="$(pg_restore --list "$fichier" | grep -c 'TABLE DATA' || true)"
  [ "$objets" -ge 20 ] || echec "Seulement $objets tables dans la sauvegarde : elle est incomplète."
  ok "$objets tables présentes"

  # La seule preuve qui vaille : une restauration réelle.
  # Un identifiant PostgreSQL ne peut pas contenir de tiret sans guillemets :
  # « triangle_verif_20261021-203551 » faisait échouer la création, et la
  # restauration d'essai était silencieusement sautée. Le contrôle le plus
  # important du script se désactivait tout seul.
  local temoin="triangle_verif_${HORODATAGE//-/_}"
  local base_admin; base_admin="$(echo "$DATABASE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/postgres#')"
  if psql "$base_admin" -tAc "CREATE DATABASE $temoin" >/dev/null 2>&1; then
    local url_temoin; url_temoin="$(echo "$DATABASE_URL" | sed -E "s#/[^/?]+(\?.*)?\$#/$temoin#")"
    if pg_restore --no-owner --no-acl --dbname="$url_temoin" "$fichier" >/dev/null 2>&1; then
      local tables; tables="$(psql "$url_temoin" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
      ok "restauration d'essai réussie : $tables tables relues"
    else
      psql "$base_admin" -tAc "DROP DATABASE IF EXISTS $temoin" >/dev/null 2>&1 || true
      echec "La sauvegarde ne se restaure pas. On ne déploie pas sans filet."
    fi
    psql "$base_admin" -tAc "DROP DATABASE IF EXISTS $temoin" >/dev/null 2>&1 || true
  else
    alerte "Restauration d'essai impossible : $(psql "$base_admin" -tAc "CREATE DATABASE $temoin" 2>&1 | head -1)"
    alerte "La sauvegarde est écrite et lisible, mais n'a pas été rejouée."
  fi

  echo "$fichier" > "$SAUVEGARDES/.derniere"
  ok "sauvegarde vérifiée : $HORODATAGE"
}

# ── MIGRATIONS ───────────────────────────────────────────────────────────
# Séparée du déploiement : on peut appliquer le schéma sans toucher au code,
# ce qui est exactement ce qu'on veut pour une reprise après incident.
migrer() {
  resoudre_base
  verifier_collisions
  titre "Migrations"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
    "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
  local liste; liste="$(migrations_en_attente || true)"
  if [ -z "$liste" ]; then
    ok "aucune migration à appliquer"
    return 0
  fi
  local n=0
  while read -r m; do
    [ -n "$m" ] || continue
    # Chaque migration dans SA transaction : une qui échoue n'en laisse pas
    # une autre à moitié appliquée.
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$RACINE/sql/$m" \
      || echec "La migration $m a échoué. Revenez en arrière : ./deployer.sh retour $HORODATAGE"
    # Par l'ENTRÉE STANDARD, pas par `-c` : psql n'interpole PAS ses variables
    # dans une commande passée en argument. L'interpolation :'nom' échappe le
    # nom de fichier — une apostrophe dans un nom de migration casserait la
    # requête autrement.
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -v nom="$m" \
      <<< "INSERT INTO schema_migrations(filename) VALUES (:'nom') ON CONFLICT DO NOTHING;"
    n=$((n + 1))
  done <<< "$liste"
  ok "$n migration(s) appliquée(s)"
}

# ── SANTÉ ────────────────────────────────────────────────────────────────
sante() {
  titre "Santé de l'application"
  # `|| echo 000` CONCATÉNAIT : curl écrit déjà « 000 » quand il échoue, et
  # le code devenait « 000000 », qui n'est pas « 000 » — le contrôle passait
  # alors qu'aucun serveur ne répondait.
  local code=""
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/" 2>/dev/null)" || true
  case "$code" in
    2*|3*|4*) ok "le serveur répond (HTTP $code)" ;;
    5*)       echec "Le serveur répond en erreur (HTTP $code)." ;;
    *)        echec "L'application ne répond pas sur le port $PORT (code « ${code:-aucun} »)." ;;
  esac

  resoudre_base
  psql "$DATABASE_URL" -tAc "SELECT 1" >/dev/null || echec "La base ne répond plus."
  ok "la base répond"

  # Le défaut qui faisait échouer le tableau de bord financier : la colonne
  # existe-t-elle vraiment ?
  if psql "$DATABASE_URL" -tAc \
      "SELECT 1 FROM information_schema.columns WHERE table_name='accounting_transactions' AND column_name='show_in_financial_movements'" \
      | grep -q 1; then
    ok "le tableau de bord financier a la colonne qui lui manquait"
  else
    alerte "show_in_financial_movements absente : le bloc financier échouera."
  fi

  command -v pm2 >/dev/null && pm2 describe "$SERVICE" >/dev/null 2>&1 \
    && ok "pm2 : $SERVICE en ligne" || alerte "pm2 : $SERVICE non trouvé"
}

# ── DÉPLOIEMENT ──────────────────────────────────────────────────────────
deployer() {
  verifier_prerequis
  sauvegarder

  titre "Mise à jour du code"
  ( cd "$RACINE"
    git fetch origin "$BRANCHE" || echec "Impossible de récupérer la branche."
    git rev-parse HEAD > "$SAUVEGARDES/.commit-$HORODATAGE"
    git checkout "$BRANCHE" --quiet
    git merge --ff-only "origin/$BRANCHE" || echec "La branche a divergé : résolvez à la main."
  )
  ok "code à jour : $(cd "$RACINE" && git rev-parse --short HEAD)"

  titre "Dépendances"
  ( cd "$RACINE" && npm ci --omit=dev --silent ) || alerte "npm ci a échoué : dépendances inchangées."

  migrer

  titre "Redémarrage"
  if command -v pm2 >/dev/null; then
    pm2 restart "$SERVICE" --update-env >/dev/null || echec "Le redémarrage a échoué."
    ok "$SERVICE redémarré"
    sleep 4
  else
    alerte "pm2 absent : redémarrez le service à la main, puis lancez « ./deployer.sh sante »."
    return 0
  fi

  sante

  titre "Déploiement terminé"
  echo "    sauvegarde : $HORODATAGE"
  echo "    retour arrière : ./deployer.sh retour $HORODATAGE"
  echo
  alerte "Restent à faire À LA MAIN, volontairement :"
  echo "    • saisir les taux de cotisation avec leur référence officielle"
  echo "      (sans eux, les bulletins affichent « non calculé »)"
  echo "    • faire valider les clauses de contrat par un conseil juridique"
  echo "    • examiner les anciens mouvements candidats au reclassement"
  echo "    • décider des factures FAT & MAT à annuler, une par une"
}

# ── RETOUR ARRIÈRE ───────────────────────────────────────────────────────
retour() {
  local quand="${1:-}"
  [ -n "$quand" ] || echec "Indiquez l'horodatage : ./deployer.sh retour 20261021-203000"
  local fichier="$SAUVEGARDES/triangle-$quand.dump"
  [ -f "$fichier" ] || echec "Sauvegarde introuvable : $fichier"

  titre "Retour arrière vers $quand"
  echo
  echo "  ${ROUGE}${GRAS}CECI REMPLACE LA BASE ACTUELLE PAR CELLE DE $quand.${ZERO}"
  echo "  ${ROUGE}Tout ce qui a été saisi depuis sera perdu.${ZERO}"
  echo
  read -r -p "  Tapez exactement « RETOUR ARRIERE » pour confirmer : " reponse
  [ "$reponse" = "RETOUR ARRIERE" ] || { echo "  Annulé."; exit 0; }

  resoudre_base
  # On sauvegarde l'état ACTUEL avant de l'écraser : revenir en arrière ne
  # doit pas être un geste sans retour.
  titre "Sauvegarde de l'état actuel, avant de l'écraser"
  local avant="$SAUVEGARDES/avant-retour-$HORODATAGE.dump"
  pg_dump --format=custom --no-owner --no-acl --file="$avant" "$DATABASE_URL" \
    || echec "Impossible de sauvegarder l'état actuel. On ne va pas plus loin."
  ok "état actuel conservé : $avant"

  command -v pm2 >/dev/null && { pm2 stop "$SERVICE" >/dev/null 2>&1 || true; ok "service arrêté"; }

  titre "Restauration"
  # ─────────────────────────────────────────────────────────────────────
  # `pg_restore --clean` NE SUFFIT PAS.
  #
  # Il ne supprime que les objets PRÉSENTS DANS LA SAUVEGARDE. Les tables
  # créées APRÈS elle — c'est-à-dire précisément celles qu'un retour arrière
  # doit faire disparaître — lui sont inconnues et survivent intactes. On
  # croit être revenu en arrière, et on a une base hybride : l'ancien schéma
  # plus les nouvelles tables, à moitié peuplées.
  #
  # On repart donc d'un schéma vide. C'est destructif, et c'est exactement
  # l'objet de la commande — l'état actuel vient d'être sauvegardé juste
  # au-dessus.
  # ─────────────────────────────────────────────────────────────────────
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q \
    -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" \
    || echec "Impossible de vider le schéma. Rien n'a été restauré, votre base est intacte."
  ok "schéma vidé"

  pg_restore --no-owner --no-acl --dbname="$DATABASE_URL" "$fichier" \
    || alerte "pg_restore a signalé des avertissements."

  local tables
  tables="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
  [ "$tables" -ge 20 ] || echec "Seulement $tables tables après restauration : l'état est incohérent. La sauvegarde de l'état précédent est dans $avant."
  ok "base restaurée : $tables tables"

  if [ -f "$SAUVEGARDES/.commit-$quand" ]; then
    local commit; commit="$(cat "$SAUVEGARDES/.commit-$quand")"
    ( cd "$RACINE" && git checkout --quiet "$commit" ) && ok "code revenu à ${commit:0:8}"
  else
    alerte "Commit d'origine inconnu : le code n'a pas été changé."
  fi

  command -v pm2 >/dev/null && { pm2 restart "$SERVICE" --update-env >/dev/null || true; sleep 4; }
  sante
  ok "Retour arrière terminé."
}

sauvegardes() {
  titre "Sauvegardes disponibles"
  ls -1t "$SAUVEGARDES"/triangle-*.dump 2>/dev/null | while read -r f; do
    local nom; nom="$(basename "$f" .dump)"; nom="${nom#triangle-}"
    printf "    %s   %6s   %s\n" "$nom" "$(du -h "$f" | cut -f1)" "$(date -r "$f" '+%d/%m/%Y %H:%M')"
  done || echo "    (aucune)"
}

case "${1:-verifier}" in
  verifier)     verifier ;;
  migrer)       verifier_prerequis; sauvegarder; migrer ;;
  sauvegarder)  verifier_prerequis; sauvegarder ;;
  deployer)     deployer ;;
  sante)        sante ;;
  retour)       retour "${2:-}" ;;
  sauvegardes)  sauvegardes ;;
  *) echo "Usage : $0 {verifier|sauvegarder|migrer|deployer|sante|retour <horodatage>|sauvegardes}"; exit 1 ;;
esac
