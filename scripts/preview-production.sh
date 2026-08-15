#!/usr/bin/env bash
#
# PREVIEW PRODUCTION COMPLET — LECTURE SEULE.
#
#   ./scripts/preview-production.sh <company_id> [dossier_sortie]
#
# Enchaîne les quatre analyses et écrit un rapport horodaté :
#   1. audit-stock-locations.js       volumétrie stock et emplacements
#   2. audit-location-duplicates.js   les groupes de codes en doublon
#   3. preview-location-consolidation.js  FK réelles + plan des doublons
#   4. preview-location-migration.js  décision par produit + contrôle, avec la
#                                     simulation « après consolidation »
#   5. preview-users-triangle.js      tableau avant/après des comptes
#
# AUCUNE ÉCRITURE EN BASE. Les quatre scripts ne contiennent que des SELECT :
# aucune migration n'est exécutée, aucune balance créée, aucun stock modifié,
# aucun utilisateur touché, aucun email envoyé, PM2 n'est pas redémarré.
#
# Les seuls fichiers écrits sont le rapport et les CSV, en local sur le VPS.

set -euo pipefail

COMPANY="${1:-}"
OUT_DIR="${2:-/tmp/triangle-preview}"

if [ -z "$COMPANY" ]; then
  echo "Usage : $0 <company_id> [dossier_sortie]" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
REPORT="$OUT_DIR/preview-$COMPANY-$STAMP.txt"

{
  echo "########################################################################"
  echo "# PREVIEW PRODUCTION TRIANGLE WMS — LECTURE SEULE"
  echo "# entreprise : $COMPANY"
  echo "# date       : $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "# commit     : $(git rev-parse HEAD 2>/dev/null || echo 'hors dépôt git')"
  echo "# AUCUNE écriture en base. 061 N'EST PAS exécutée."
  echo "########################################################################"
  echo

  echo "########## 1/5 — AUDIT STOCK ET EMPLACEMENTS ##########"
  node scripts/audit-stock-locations.js --company="$COMPANY"
  echo

  echo "########## 2/5 — DOUBLONS DE CODE D'EMPLACEMENT ##########"
  node scripts/audit-location-duplicates.js --company="$COMPANY" \
       --csv="$OUT_DIR/doublons-$COMPANY-$STAMP.csv"
  echo

  echo "########## 3/5 — PLAN DE CONSOLIDATION DES EMPLACEMENTS ##########"
  node scripts/preview-location-consolidation.js --company="$COMPANY" \
       --csv="$OUT_DIR/consolidation-$COMPANY-$STAMP.csv"
  echo

  echo "########## 4/5 — PREVIEW MIGRATION + CONTRÔLE AVANT MIGRATION ##########"
  node scripts/preview-location-migration.js --company="$COMPANY" \
       --simulate-consolidation \
       --csv="$OUT_DIR/migration-$COMPANY-$STAMP.csv"
  echo

  echo "########## 5/5 — PREVIEW UTILISATEURS ##########"
  node scripts/preview-users-triangle.js --company="$COMPANY"
  echo

  echo "########################################################################"
  echo "# FIN DU PREVIEW — aucune donnée de production modifiée."
  echo "########################################################################"
} 2>&1 | tee "$REPORT"

echo
echo "Rapport   : $REPORT"
echo "CSV       : $OUT_DIR/doublons-$COMPANY-$STAMP.csv"
echo "            $OUT_DIR/consolidation-$COMPANY-$STAMP.csv"
echo "            $OUT_DIR/migration-$COMPANY-$STAMP.csv"
