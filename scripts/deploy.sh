#!/usr/bin/env bash
#
# DÉPLOIEMENT TRIANGLE WMS — backend + frontend.
#
#   ./scripts/deploy.sh <company_id> <chemin_frontend>
#
# Applique UNIQUEMENT les migrations pas encore passées : chacune est testée
# par sa propre empreinte en base avant d'être jouée. 061 et 061a sont déjà
# appliquées en production et ne seront JAMAIS rejouées.
#
# Le stock est contrôlé avant et après. Un écart interrompt le déploiement.

set -euo pipefail

COMPANY="${1:-}"
FRONT="${2:-}"
BACK="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${3:-/var/backups/triangle}"

ATTENDU_PRODUITS=247
ATTENDU_STOCK=151237

if [ -z "$COMPANY" ] || [ -z "$FRONT" ]; then
  echo "Usage : $0 <company_id> <chemin_frontend> [dossier_sauvegardes]" >&2
  exit 1
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ARRÊT : DATABASE_URL absent de l'environnement." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="$OUT_DIR/triangle-avant-deploy-$STAMP.dump"
LOG="$OUT_DIR/deploy-$STAMP.log"
exec > >(tee -a "$LOG") 2>&1

q() { psql "$DATABASE_URL" -tAX -c "$1"; }
titre() { echo; echo "### $* ###"; }

echo "########################################################################"
echo "# DÉPLOIEMENT TRIANGLE WMS · entreprise $COMPANY · $(date '+%F %T %Z')"
echo "########################################################################"

# ── 1. SAUVEGARDE ───────────────────────────────────────────────────────────
titre "1/13 — SAUVEGARDE"
pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$DATABASE_URL"
TAILLE=$(wc -c < "$DUMP" | tr -d ' ')
[ "$TAILLE" -lt 100000 ] && { echo "ARRÊT : sauvegarde suspecte ($TAILLE octets)." >&2; exit 1; }
echo "Sauvegarde : $DUMP ($TAILLE octets)"
echo "Restauration : pg_restore --clean --if-exists --no-owner -d \"\$DATABASE_URL\" \"$DUMP\""

# ── 2. CONTRÔLE AVANT ───────────────────────────────────────────────────────
titre "2/13 — CONTRÔLE AVANT"
P_AVANT=$(q "SELECT COUNT(*) FROM products WHERE company_id=$COMPANY AND COALESCE(is_active,TRUE)")
S_AVANT=$(q "SELECT COALESCE(SUM(stock),0) FROM products WHERE company_id=$COMPANY AND COALESCE(is_active,TRUE)")
N_AVANT=$(q "SELECT COUNT(*) FROM products WHERE company_id=$COMPANY AND stock<0")
printf "  produits %s (attendu %s) · stock %s (attendu %s) · négatifs %s\n" \
  "$P_AVANT" "$ATTENDU_PRODUITS" "$S_AVANT" "$ATTENDU_STOCK" "$N_AVANT"
if [ "$P_AVANT" != "$ATTENDU_PRODUITS" ] || [ "$S_AVANT" != "$ATTENDU_STOCK" ] || [ "$N_AVANT" != "0" ]; then
  echo "ARRÊT : état de départ non conforme. Rien n'a été déployé." >&2; exit 1
fi
echo "  → conforme."

# ── 3. MIGRATIONS MANQUANTES SEULEMENT ──────────────────────────────────────
titre "3/13 — MIGRATIONS"
cd "$BACK"
# 061 et 061a : déjà appliquées. On le VÉRIFIE au lieu de le supposer.
[ "$(q "SELECT COUNT(*) FROM pg_tables WHERE tablename='stock_location_balances'")" = "1" ] \
  && echo "  061  déjà appliquée — non rejouée" \
  || { echo "ARRÊT : 061 absente. Ce script ne l'applique pas." >&2; exit 1; }
[ "$(q "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='locations' AND column_name='merged_into_location_id'")" = "1" ] \
  && echo "  061a déjà appliquée — non rejouée" \
  || { echo "ARRÊT : 061a absente." >&2; exit 1; }

if [ "$(q "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='products' AND column_name='allocation_priority'")" = "0" ]; then
  echo "  062  à appliquer…"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/062_allocation_priority.sql
  echo "  062  appliquée."
else
  echo "  062  déjà appliquée — non rejouée"
fi

# ── 4-7. BACKEND ────────────────────────────────────────────────────────────
titre "4/13 — PULL BACKEND"
git pull --ff-only
echo "commit backend : $(git rev-parse HEAD)"

titre "5/13 — DÉPENDANCES BACKEND"
if git diff --name-only HEAD@{1} HEAD 2>/dev/null | grep -q '^package\(-lock\)\?\.json$'; then
  npm ci --omit=dev && echo "  dépendances réinstallées"
else
  echo "  package.json inchangé — installation ignorée"
fi

titre "6/13 — REDÉMARRAGE BACKEND"
pm2 restart triangle-backend --update-env
sleep 4

titre "7/13 — LOGS BACKEND"
pm2 logs triangle-backend --lines 25 --nostream || true
if pm2 logs triangle-backend --lines 60 --nostream 2>/dev/null | grep -qiE "error|cannot find module|listen eaddrinuse"; then
  echo "ATTENTION : des erreurs figurent dans les logs — vérifiez ci-dessus." >&2
fi

# ── 8-10. FRONTEND ──────────────────────────────────────────────────────────
titre "8/13 — PULL FRONTEND"
cd "$FRONT"
git pull --ff-only
echo "commit frontend : $(git rev-parse HEAD)"

titre "9/13 — BUILD FRONTEND"
if git diff --name-only HEAD@{1} HEAD 2>/dev/null | grep -q '^package\(-lock\)\?\.json$'; then
  npm ci && echo "  dépendances réinstallées"
else
  echo "  package.json inchangé — installation ignorée"
fi
npm run build

titre "10/13 — REDÉMARRAGE FRONTEND"
pm2 restart triangle-frontend --update-env
sleep 4

titre "11/13 — PM2 SAVE"
pm2 save
pm2 status

# ── 12-13. CONTRÔLES FINAUX ─────────────────────────────────────────────────
titre "12/13 — CONTRÔLE FINAL DU STOCK"
P_APRES=$(q "SELECT COUNT(*) FROM products WHERE company_id=$COMPANY AND COALESCE(is_active,TRUE)")
S_APRES=$(q "SELECT COALESCE(SUM(stock),0) FROM products WHERE company_id=$COMPANY AND COALESCE(is_active,TRUE)")
N_APRES=$(q "SELECT COUNT(*) FROM products WHERE company_id=$COMPANY AND stock<0")
BAL=$(q "SELECT COUNT(*) FROM stock_location_balances WHERE company_id=$COMPANY")
ECARTS=$(q "SELECT COUNT(*) FROM (
   SELECT p.id FROM products p
     LEFT JOIN stock_location_balances b ON b.product_id=p.id AND b.company_id=p.company_id
    WHERE p.company_id=$COMPANY AND COALESCE(p.location_managed,FALSE)
    GROUP BY p.id,p.stock HAVING p.stock::numeric <> COALESCE(SUM(b.quantity),0)::numeric) t")
printf "  produits %s → %s · stock %s → %s · négatifs %s · balances %s · écarts %s\n" \
  "$P_AVANT" "$P_APRES" "$S_AVANT" "$S_APRES" "$N_APRES" "$BAL" "$ECARTS"

titre "13/13 — COMPTES MOHAMADO ET HAWA"
cd "$BACK"
node scripts/activer-comptes.js --company="$COMPANY" --noms="Mohamado,Hawa" || \
  echo "  (comptes non activés : lisez le message ci-dessus, puis relancez avec --appliquer)"

echo
if [ "$S_AVANT" = "$S_APRES" ] && [ "$P_AVANT" = "$P_APRES" ] && [ "$N_APRES" = "0" ] && [ "$ECARTS" = "0" ]; then
  echo "DÉPLOIEMENT TERMINÉ. Stock $S_APRES inchangé, $P_APRES produits, 0 négatif, 0 écart."
else
  echo "ANOMALIE : restaurez depuis $DUMP et signalez l'écart." >&2
  exit 1
fi
echo "Journal : $LOG"
