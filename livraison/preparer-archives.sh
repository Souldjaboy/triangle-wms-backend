#!/usr/bin/env bash
#
# ═════════════════════════════════════════════════════════════════════════
#  LES ARCHIVES TRANSFÉRABLES
#
#  Le dépôt de ce poste et celui du VPS n'ont pas forcément la même histoire :
#  des fusions y ont été faites, des commits y existent que l'on ne connaît
#  pas. On ne livre donc pas « un commit à récupérer », mais TROIS FORMES du
#  même travail, de la plus simple à la plus robuste :
#
#    1. LE BUNDLE GIT — un dépôt dans un fichier. Se récupère avec
#       `git fetch`, garde l'historique et les messages. Marche si les deux
#       dépôts ont un ancêtre commun.
#
#    2. LA SÉRIE DE CORRECTIFS — un fichier .patch par commit, applicable
#       avec `git am` sur n'importe quelle base. Marche même si les histoires
#       ont divergé ; les conflits se résolvent fichier par fichier.
#
#    3. L'ARCHIVE DES FICHIERS — l'arbre complet des fichiers touchés, sans
#       Git. Dernier recours, quand ni l'un ni l'autre ne s'applique : on
#       copie, on relit, on commit soi-même.
#
#  Chaque forme est accompagnée de son empreinte SHA-256, et le manifeste
#  liste les empreintes de TOUS les fichiers livrés — pour qu'on puisse
#  vérifier qu'aucun n'a été altéré en route.
#
#      ./preparer-archives.sh [base]
#
#  `base` est le commit à partir duquel compter (défaut : la divergence
#  d'avec origin/main).
# ═════════════════════════════════════════════════════════════════════════
set -uo pipefail

RACINE="$(cd "$(dirname "$0")/.." && pwd)"
FRONT="${FRONT:-$(cd "$RACINE/../triangle-wms-frontend" 2>/dev/null && pwd || echo '')}"
SORTIE="${SORTIE:-$RACINE/livraison/archives}"
HORODATAGE="$(date +%Y%m%d-%H%M%S)"

VERT=$'\033[32m'; JAUNE=$'\033[33m'; ROUGE=$'\033[31m'; GRAS=$'\033[1m'; ZERO=$'\033[0m'
titre() { echo; echo "${GRAS}── $* ${ZERO}"; }
ok()    { echo "  ${VERT}✔${ZERO} $*"; }
alerte(){ echo "  ${JAUNE}!${ZERO} $*"; }
echec() { echo "  ${ROUGE}✘ $*${ZERO}" >&2; exit 1; }

rm -rf "$SORTIE"; mkdir -p "$SORTIE"

preparer_depot() {
  local nom="$1" chemin="$2" base="$3"
  [ -d "$chemin/.git" ] || { alerte "$nom : dépôt introuvable ($chemin)"; return; }

  titre "$nom"
  local branche commit n
  branche="$(cd "$chemin" && git rev-parse --abbrev-ref HEAD)"
  commit="$(cd "$chemin" && git rev-parse HEAD)"
  if [ -z "$base" ]; then
    base="$(cd "$chemin" && git merge-base HEAD origin/main 2>/dev/null || echo '')"
  fi
  [ -n "$base" ] || echec "$nom : impossible de déterminer la base. Donnez-la en argument."
  n="$(cd "$chemin" && git rev-list --count "$base..HEAD")"
  echo "  branche : $branche"
  echo "  base    : ${base:0:12}"
  echo "  sommet  : ${commit:0:12}"
  echo "  commits : $n"

  [ -z "$(cd "$chemin" && git status --porcelain)" ] \
    || echec "$nom : l'arbre de travail n'est pas propre. Committez d'abord."

  local d="$SORTIE/$nom"
  mkdir -p "$d/correctifs"

  # 1. Le bundle
  ( cd "$chemin" && git bundle create "$d/$nom-$HORODATAGE.bundle" "$base..HEAD" "$branche" ) >/dev/null 2>&1 \
    && ok "bundle : $(du -h "$d/$nom-$HORODATAGE.bundle" | cut -f1)" \
    || echec "$nom : création du bundle impossible."
  ( cd "$chemin" && git bundle verify "$d/$nom-$HORODATAGE.bundle" ) >/dev/null 2>&1 \
    && ok "bundle vérifié" || echec "$nom : le bundle ne se vérifie pas."

  # 2. Les correctifs
  ( cd "$chemin" && git format-patch --quiet -o "$d/correctifs" "$base..HEAD" ) >/dev/null 2>&1
  local p; p="$(ls "$d/correctifs"/*.patch 2>/dev/null | wc -l)"
  [ "$p" = "$n" ] && ok "$p correctif(s) écrits" \
                  || alerte "$p correctif(s) pour $n commit(s) — vérifiez"

  # 3. L'archive des fichiers touchés
  ( cd "$chemin" && git archive --format=tar HEAD \
      $(git diff --name-only --diff-filter=d "$base..HEAD") ) \
    | gzip > "$d/$nom-fichiers-$HORODATAGE.tar.gz" 2>/dev/null \
    && ok "archive des fichiers : $(du -h "$d/$nom-fichiers-$HORODATAGE.tar.gz" | cut -f1)" \
    || alerte "archive des fichiers : échec"

  # La liste des fichiers touchés, lisible.
  ( cd "$chemin" && git diff --name-status "$base..HEAD" ) > "$d/fichiers-modifies.txt"
  ( cd "$chemin" && git log --format='%H%n    %s%n' "$base..HEAD" ) > "$d/commits.txt"
  ok "$(wc -l < "$d/fichiers-modifies.txt") ligne(s) dans fichiers-modifies.txt"
}

preparer_depot "backend"  "$RACINE" "${1:-}"
[ -n "$FRONT" ] && preparer_depot "frontend" "$FRONT" "${2:-}"

# ─────────────────────────────────────────────────────────────────────────
# LES MIGRATIONS, À PART
# Elles s'appliquent dans l'ordre et se relisent avant d'être lancées : on
# les sort du lot pour qu'on puisse les ouvrir sans détarer quoi que ce soit.
# ─────────────────────────────────────────────────────────────────────────
titre "Les migrations"
mkdir -p "$SORTIE/migrations" "$SORTIE/migrations/retour"
cp "$RACINE"/sql/15*.sql "$SORTIE/migrations/" 2>/dev/null
cp "$RACINE"/sql/retour/*.sql "$SORTIE/migrations/retour/" 2>/dev/null
cp "$RACINE"/sql/README-NUMEROTATION.md "$SORTIE/migrations/" 2>/dev/null
ok "$(ls "$SORTIE"/migrations/*.sql 2>/dev/null | wc -l) migration(s), $(ls "$SORTIE"/migrations/retour/*.sql 2>/dev/null | wc -l) fichier(s) de retour"

titre "La documentation et les outils"
mkdir -p "$SORTIE/documentation"
for f in PROCEDURE-DEPLOIEMENT.md PLAN-RETOUR-ARRIERE.md RAPPORT-FINAL-INTEGRATION.md \
         RAPPORT-DE-LIVRAISON.md INTEGRATION-V16-V17.md RAPPORT-V17.md; do
  [ -f "$RACINE/livraison/$f" ] && cp "$RACINE/livraison/$f" "$SORTIE/documentation/"
done
for f in deployer.sh retour-base.sh repetition-deploiement.sh rapport-fatmat.sh recuperer-v16.sh; do
  [ -f "$RACINE/livraison/$f" ] && cp "$RACINE/livraison/$f" "$SORTIE/documentation/"
done
ok "$(ls "$SORTIE"/documentation 2>/dev/null | wc -l) fichier(s)"

# ─────────────────────────────────────────────────────────────────────────
# LE MANIFESTE
# ─────────────────────────────────────────────────────────────────────────
titre "Empreintes SHA-256"
( cd "$SORTIE" && find . -type f ! -name "MANIFESTE-SHA256.txt" -print0 \
    | sort -z | xargs -0 sha256sum ) > "$SORTIE/MANIFESTE-SHA256.txt"
ok "$(wc -l < "$SORTIE/MANIFESTE-SHA256.txt") fichier(s) empreintés"

# L'archive globale, et SON empreinte — celle qu'on compare après transfert.
GLOBALE="$RACINE/livraison/triangle-livraison-$HORODATAGE.tar.gz"
rm -f "$RACINE"/livraison/triangle-livraison-*.tar.gz
( cd "$SORTIE/.." && tar czf "$GLOBALE" "$(basename "$SORTIE")" ) \
  && ok "archive globale : $(du -h "$GLOBALE" | cut -f1)" \
  || echec "Archive globale impossible."
EMPREINTE="$(sha256sum "$GLOBALE" | cut -d' ' -f1)"
echo "$EMPREINTE  $(basename "$GLOBALE")" > "$RACINE/livraison/triangle-livraison-$HORODATAGE.sha256"

# ─────────────────────────────────────────────────────────────────────────
titre "À vérifier après transfert"
echo
echo "  Archive : $GLOBALE"
echo "  SHA-256 : $EMPREINTE"
echo
echo "  Sur le VPS, avant d'ouvrir quoi que ce soit :"
echo "      sha256sum triangle-livraison-$HORODATAGE.tar.gz"
echo "  La chaîne doit être identique, caractère pour caractère."
echo
echo "  Puis, après extraction :"
echo "      cd $(basename "$SORTIE") && sha256sum -c MANIFESTE-SHA256.txt"
echo
