#!/usr/bin/env bash
#
# MIGRATION 061 — STOCK PAR EMPLACEMENT.  DEUX PHASES SÉPARÉES.
#
#   PHASE A (défaut) : sauvegarde, contrôles, exécution puis ROLLBACK.
#     ./scripts/apply-061.sh <company_id> <balances_attendues>
#
#   PHASE B : exécution réelle. À lancer SÉPARÉMENT, après lecture du dry-run.
#     PHASE=B ./scripts/apply-061.sh <company_id> <balances_attendues>
#
# `balances_attendues` vient du preview (produits AUTO_MATCH). La migration
# refuse d'écrire si elle en trouve un nombre différent : un désaccord avec le
# preview validé est un signal d'arrêt.
#
# Ce script ne déploie pas le frontend, ne touche pas aux utilisateurs et ne
# redémarre pas PM2.

set -euo pipefail

COMPANY="${1:-}"
BALANCES="${2:-}"
OUT_DIR="${3:-/var/backups/triangle}"
PHASE="${PHASE:-A}"

ATTENDU_PRODUITS=247
ATTENDU_STOCK=151237

if [ -z "$COMPANY" ] || [ -z "$BALANCES" ]; then
  echo "Usage : [PHASE=B] $0 <company_id> <balances_attendues> [dossier]" >&2
  exit 1
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ARRÊT : DATABASE_URL absent de l'environnement." >&2
  exit 1
fi

cd "$(dirname "$0")/.."
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="$OUT_DIR/triangle-avant-061-$STAMP.dump"
LOG="$OUT_DIR/061-phase$PHASE-$STAMP.log"

q() { psql "$DATABASE_URL" -tAX -c "$1"; }
has_col() {
  [ "$(q "SELECT COUNT(*) FROM information_schema.columns
          WHERE table_schema='public' AND table_name='$1' AND column_name='$2'")" = "1" ]
}
has_table() {
  [ "$(q "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public' AND tablename='$1'")" = "1" ]
}

exec > >(tee -a "$LOG") 2>&1

echo "########################################################################"
echo "# 061 — STOCK PAR EMPLACEMENT — PHASE $PHASE"
echo "# entreprise $COMPANY · balances attendues $BALANCES · $(date '+%F %T %Z')"
echo "# commit $(git rev-parse HEAD 2>/dev/null || echo '?')"
echo "########################################################################"

# ── 1. SAUVEGARDE ───────────────────────────────────────────────────────────
echo
echo "### 1/4 — SAUVEGARDE ###"
pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$DATABASE_URL"
TAILLE=$(wc -c < "$DUMP" | tr -d ' ')
[ "$TAILLE" -lt 100000 ] && { echo "ARRÊT : sauvegarde suspecte ($TAILLE octets)." >&2; exit 1; }
echo "Sauvegarde : $DUMP ($TAILLE octets)"
echo "Restauration : pg_restore --clean --if-exists --no-owner -d \"\$DATABASE_URL\" \"$DUMP\""

# ── 2. CONTRÔLES AVANT ──────────────────────────────────────────────────────
echo
echo "### 2/4 — CONTRÔLES AVANT ###"
P_AVANT=$(q "SELECT COUNT(*) FROM products WHERE company_id=$COMPANY AND COALESCE(is_active,TRUE)")
S_AVANT=$(q "SELECT COALESCE(SUM(stock),0) FROM products WHERE company_id=$COMPANY AND COALESCE(is_active,TRUE)")
N_AVANT=$(q "SELECT COUNT(*) FROM products WHERE company_id=$COMPANY AND stock<0")
printf "  produits          %s   (attendu %s)\n" "$P_AVANT" "$ATTENDU_PRODUITS"
printf "  stock total       %s   (attendu %s)\n" "$S_AVANT" "$ATTENDU_STOCK"
printf "  stock négatif     %s   (attendu 0)\n" "$N_AVANT"

echo "  ── état post-061a ──"
if ! has_col locations merged_into_location_id; then
  echo "ARRÊT : 061a n'a pas été appliquée (merged_into_location_id absent)." >&2; exit 1
fi
FUSION=$(q "SELECT COUNT(*) FROM locations WHERE company_id=$COMPANY AND merged_into_location_id IS NOT NULL")
ORPH=$(q "SELECT COUNT(*) FROM products p JOIN locations l ON l.id=p.location_id
           WHERE l.merged_into_location_id IS NOT NULL AND p.company_id=$COMPANY")
printf "  locations fusionnées   %s   (attendu 10)\n" "$FUSION"
printf "  produits orphelins     %s   (attendu 0)\n" "$ORPH"

if has_table stock_location_balances; then
  echo "ARRÊT : stock_location_balances existe déjà — 061 semble déjà exécutée." >&2; exit 1
fi

if [ "$P_AVANT" != "$ATTENDU_PRODUITS" ] || [ "$S_AVANT" != "$ATTENDU_STOCK" ] \
   || [ "$N_AVANT" != "0" ] || [ "$ORPH" != "0" ]; then
  echo; echo "ARRÊT : l'état de départ ne correspond pas à la référence validée." >&2
  echo "Aucune écriture n'a eu lieu." >&2
  exit 1
fi
echo "  → état de départ conforme."

# ── 3. EXÉCUTION ────────────────────────────────────────────────────────────
echo
if [ "$PHASE" = "A" ]; then
  echo "### 3/4 — PHASE A : ESSAI À BLANC (aucune écriture) ###"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v dry_run=true \
       -v company_id="$COMPANY" -v expected_balances="$BALANCES" \
       -f sql/061_stock_location_balances.sql
  echo
  echo "### 4/4 — CE QUE 061 CRÉERAIT ###"
  node scripts/preview-061.js --company="$COMPANY" \
       --produits="$ATTENDU_PRODUITS" --stock="$ATTENDU_STOCK" \
    | sed -n '/RÉCAPITULATIF/,$p'
  echo
  echo "PHASE A terminée. La base est INCHANGÉE — le ROLLBACK a tout annulé,"
  echo "y compris la création des tables et colonnes."
  echo "Pour appliquer réellement :"
  echo "  PHASE=B $0 $COMPANY $BALANCES"
  exit 0
fi

echo "### 3/4 — PHASE B : EXÉCUTION RÉELLE ###"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
     -v company_id="$COMPANY" -v expected_balances="$BALANCES" \
     -f sql/061_stock_location_balances.sql

# ── 4. CONTRÔLES APRÈS ──────────────────────────────────────────────────────
echo
echo "### 4/4 — CONTRÔLES APRÈS ###"
P_APRES=$(q "SELECT COUNT(*) FROM products WHERE company_id=$COMPANY AND COALESCE(is_active,TRUE)")
S_APRES=$(q "SELECT COALESCE(SUM(stock),0) FROM products WHERE company_id=$COMPANY AND COALESCE(is_active,TRUE)")
N_APRES=$(q "SELECT COUNT(*) FROM products WHERE company_id=$COMPANY AND stock<0")
TABLE_OK=$(has_table stock_location_balances && echo oui || echo NON)
NB_BAL=$(q "SELECT COUNT(*) FROM stock_location_balances WHERE company_id=$COMPANY")
U_BAL=$(q "SELECT COALESCE(SUM(quantity),0) FROM stock_location_balances WHERE company_id=$COMPANY")
GERES=$(q "SELECT COUNT(*) FROM products WHERE company_id=$COMPANY AND COALESCE(location_managed,FALSE)")
A_LOC=$(q "SELECT COALESCE(SUM(stock),0) FROM products
            WHERE company_id=$COMPANY AND COALESCE(is_active,TRUE)
              AND COALESCE(location_managed,FALSE)=FALSE")
# Aucune balance ne doit s'appuyer sur un emplacement non physique.
MAUVAIS=$(q "SELECT COUNT(*) FROM stock_location_balances b JOIN locations l ON l.id=b.location_id
              WHERE b.company_id=$COMPANY AND COALESCE(l.full_code,'')=''")
NON_PHYS=$(q "SELECT COUNT(*) FROM locations
               WHERE company_id=$COMPANY AND COALESCE(full_code,'')<>''
                 AND (bin_code ~* '(WRITE[[:space:]_-]*OFF|REBUT|CASSE|NON[[:space:]_-]*PRECISE|NON[[:space:]_-]*PRÉCIS|INCONNU|DIVERS)'
                   OR TRIM(bin_code) ~* '^(BIN[[:space:]]*)?[0-9]+[[:space:]]*[-/][[:space:]]*[0-9]+\$'
                   OR UPPER(TRIM(COALESCE(NULLIF(rayon_code,''),zone,''))) ~ '^(NOUVEAU|AUTO)\$'
                   OR UPPER(TRIM(COALESCE(NULLIF(case_code,''),rayon,''))) ~ '^(NOUVEAU|AUTO)\$')")
ECARTS=$(q "SELECT COUNT(*) FROM (
              SELECT p.id FROM products p
                LEFT JOIN stock_location_balances b ON b.product_id=p.id AND b.company_id=p.company_id
               WHERE p.company_id=$COMPANY AND COALESCE(p.location_managed,FALSE)
               GROUP BY p.id,p.stock HAVING p.stock::numeric <> COALESCE(SUM(b.quantity),0)::numeric) t")

verdict() { [ "$1" = "$2" ] && echo OK || echo ÉCART; }
echo
printf "  %-42s %-12s %-12s %s\n" "CONTRÔLE" "AVANT" "APRÈS" "VERDICT"
printf "  %s\n" "$(printf '─%.0s' {1..82})"
printf "  %-42s %-12s %-12s %s\n" "produits actifs"        "$P_AVANT" "$P_APRES" "$(verdict "$P_AVANT" "$P_APRES")"
printf "  %-42s %-12s %-12s %s\n" "stock total"            "$S_AVANT" "$S_APRES" "$(verdict "$S_AVANT" "$S_APRES")"
printf "  %-42s %-12s %-12s %s\n" "stock négatif"          "$N_AVANT" "$N_APRES" "$(verdict 0 "$N_APRES")"
printf "  %-42s %-12s %-12s %s\n" "stock_location_balances" "absente" "$TABLE_OK" "$(verdict oui "$TABLE_OK")"
printf "  %-42s %-12s %-12s %s\n" "balances créées"        "0" "$NB_BAL" "$(verdict "$BALANCES" "$NB_BAL")"
printf "  %-42s %-12s %-12s %s\n" "unités en balances"     "0" "$U_BAL" "AUTO_MATCH"
printf "  %-42s %-12s %-12s %s\n" "produits gérés par emplacement" "0" "$GERES" "$(verdict "$BALANCES" "$GERES")"
printf "  %-42s %-12s %-12s %s\n" "unités restant à localiser" "—" "$A_LOC" "sans balance"
printf "  %-42s %-12s %-12s %s\n" "balances sur emplacement non physique" "—" "$MAUVAIS" "$(verdict 0 "$MAUVAIS")"
printf "  %-42s %-12s %-12s %s\n" "plages/rebuts avec full_code" "—" "$NON_PHYS" "$(verdict 0 "$NON_PHYS")"
printf "  %-42s %-12s %-12s %s\n" "stock <> somme des balances" "—" "$ECARTS" "$(verdict 0 "$ECARTS")"

echo
if [ "$S_AVANT" = "$S_APRES" ] && [ "$P_AVANT" = "$P_APRES" ] && [ "$N_APRES" = "0" ] \
   && [ "$TABLE_OK" = "oui" ] && [ "$NB_BAL" = "$BALANCES" ] && [ "$MAUVAIS" = "0" ] \
   && [ "$NON_PHYS" = "0" ] && [ "$ECARTS" = "0" ]; then
  echo "061 APPLIQUÉE. Stock $S_APRES inchangé, $NB_BAL balance(s) AUTO_MATCH,"
  echo "$U_BAL unité(s) localisées, $A_LOC unité(s) restant à répartir manuellement."
else
  echo "ANOMALIE APRÈS EXÉCUTION : restaurez depuis $DUMP et signalez l'écart." >&2
  exit 1
fi
echo
echo "Journal : $LOG"
echo "STOP — frontend non déployé, utilisateurs non modifiés, PM2 non redémarré."
