#!/usr/bin/env bash
#
# APPLICATION DE 061a EN PRODUCTION — CONSOLIDATION DES EMPLACEMENTS.
#
#   ./scripts/apply-061a.sh <company_id> [groupes_attendus] [dossier_sortie]
#
# Ce script applique UNIQUEMENT 061a. Il ne lance pas 061, ne touche pas aux
# utilisateurs, ne redémarre pas PM2, ne déploie rien.
#
# Déroulé :
#   1. sauvegarde PostgreSQL complète, vérifiée non vide ;
#   2. contrôles AVANT — produits, stock total, stock négatif. Tout écart
#      arrête le script sans rien écrire ;
#   3. rappel en lecture seule des groupes consolidables ;
#   4. exécution de 061a dans UNE transaction. La migration refuse d'agir si
#      elle ne trouve pas exactement le nombre de groupes attendu, et annule
#      tout si un invariant échoue ;
#   5. contrôles APRÈS — stock, produits, négatifs, références orphelines,
#      résultat des consolidations, emplacements hors plan.
#
# Toute erreur interrompt immédiatement : set -e + ON_ERROR_STOP=1.

set -euo pipefail

COMPANY="${1:-}"
EXPECTED="${2:-7}"
OUT_DIR="${3:-/var/backups/triangle}"

ATTENDU_PRODUITS=247
ATTENDU_STOCK=151237

if [ -z "$COMPANY" ]; then
  echo "Usage : $0 <company_id> [groupes_attendus] [dossier_sortie]" >&2
  exit 1
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ARRÊT : DATABASE_URL absent de l'environnement." >&2
  exit 1
fi

cd "$(dirname "$0")/.."
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="$OUT_DIR/triangle-avant-061a-$STAMP.dump"
LOG="$OUT_DIR/061a-$STAMP.log"

q() { psql "$DATABASE_URL" -tAX -c "$1"; }

# `locations.is_active` et les colonnes de fusion n'existent qu'APRÈS le §0 de
# 061a. Les contrôles AVANT tournent donc sur le schéma de production nu : ils
# doivent s'y adapter au lieu de supposer un schéma futur.
#   NB : products.is_active et users.is_active, eux, existent déjà.
has_col() {
  [ "$(q "SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema='public' AND table_name='$1' AND column_name='$2'")" = "1" ]
}
# Emplacements « actifs » : avant 061a aucun n'est fusionné, donc tous le sont.
locations_actives() {
  if has_col locations is_active; then
    q "SELECT COUNT(*) FROM locations WHERE company_id=$COMPANY AND COALESCE(is_active,TRUE)"
  else
    q "SELECT COUNT(*) FROM locations WHERE company_id=$COMPANY"
  fi
}
locations_fusionnees() {
  if has_col locations merged_into_location_id; then
    q "SELECT COUNT(*) FROM locations WHERE company_id=$COMPANY AND merged_into_location_id IS NOT NULL"
  else
    echo 0
  fi
}
# Les colonnes d'emplacement de stock_movements varient selon les migrations
# déjà passées : source_location_id et destination_location_id n'existent
# qu'à partir de 061. On DÉCOUVRE donc celles réellement présentes plutôt que
# de les supposer — c'est ce qui faisait planter le contrôle APRÈS.
# Les colonnes homonymes référençant une autre table sont exclues.
colonnes_emplacement() {
  q "SELECT c.table_name||'.'||c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_name=c.table_name AND t.table_schema=c.table_schema
      WHERE c.table_schema='public' AND t.table_type='BASE TABLE'
        AND c.column_name ~ '(^|_)location_id\$'
        AND c.table_name <> 'locations'
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name=tc.constraint_name
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name=tc.constraint_name
           WHERE tc.constraint_type='FOREIGN KEY'
             AND tc.table_name=c.table_name AND kcu.column_name=c.column_name
             AND ccu.table_name <> 'locations')
      ORDER BY 1"
}
# Total des références pointant encore vers un emplacement fusionné.
references_orphelines() {
  has_col locations merged_into_location_id || { echo 0; return; }
  local total=0 tc col n
  while IFS= read -r tc; do
    [ -z "$tc" ] && continue
    col="${tc#*.}"
    n=$(q "SELECT COUNT(*) FROM \"${tc%%.*}\" x
             JOIN locations l ON l.id = x.\"$col\"
            WHERE l.merged_into_location_id IS NOT NULL")
    total=$((total + ${n:-0}))
  done <<< "$(colonnes_emplacement)"
  echo "$total"
}

exec > >(tee -a "$LOG") 2>&1

echo "########################################################################"
echo "# 061a — CONSOLIDATION DES EMPLACEMENTS PHYSIQUES"
echo "# entreprise $COMPANY | groupes attendus $EXPECTED | $(date '+%F %T %Z')"
echo "# commit $(git rev-parse HEAD 2>/dev/null || echo '?')"
echo "########################################################################"

# ── 1. SAUVEGARDE ───────────────────────────────────────────────────────────
echo
echo "### 1/5 — SAUVEGARDE ###"
pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$DATABASE_URL"
TAILLE=$(wc -c < "$DUMP" | tr -d ' ')
if [ "$TAILLE" -lt 100000 ]; then
  echo "ARRÊT : sauvegarde suspecte ($TAILLE octets). Rien n'a été modifié." >&2
  exit 1
fi
echo "Sauvegarde : $DUMP ($TAILLE octets)"
echo "Restauration si besoin :"
echo "  pg_restore --clean --if-exists --no-owner -d \"\$DATABASE_URL\" \"$DUMP\""

# ── 2. CONTRÔLES AVANT ──────────────────────────────────────────────────────
echo
echo "### 2/5 — CONTRÔLES AVANT ###"
P_AVANT=$(q "SELECT COUNT(*) FROM products WHERE company_id=$COMPANY AND COALESCE(is_active,TRUE)")
S_AVANT=$(q "SELECT COALESCE(SUM(stock),0) FROM products WHERE company_id=$COMPANY AND COALESCE(is_active,TRUE)")
N_AVANT=$(q "SELECT COUNT(*) FROM products WHERE company_id=$COMPANY AND stock<0")
L_AVANT=$(q "SELECT COUNT(*) FROM locations WHERE company_id=$COMPANY")
A_AVANT=$(locations_actives)
F_AVANT=$(locations_fusionnees)
printf "  produits        %s   (attendu %s)\n" "$P_AVANT" "$ATTENDU_PRODUITS"
printf "  stock total     %s   (attendu %s)\n" "$S_AVANT" "$ATTENDU_STOCK"
printf "  stock négatif   %s   (attendu 0)\n" "$N_AVANT"
printf "  emplacements    %s dont %s actifs, %s déjà fusionné(s)\n" "$L_AVANT" "$A_AVANT" "$F_AVANT"

if [ "$P_AVANT" != "$ATTENDU_PRODUITS" ] || [ "$S_AVANT" != "$ATTENDU_STOCK" ] || [ "$N_AVANT" != "0" ]; then
  echo
  echo "ARRÊT : l'état de départ ne correspond pas à la référence validée." >&2
  echo "Aucune écriture n'a eu lieu. Vérifiez l'entreprise et le preview." >&2
  exit 1
fi
echo "  → état de départ conforme."

# ── 3. RAPPEL DES GROUPES (lecture seule) ───────────────────────────────────
echo
echo "### 3/5 — GROUPES CONSOLIDABLES (lecture seule) ###"
node scripts/preview-location-consolidation.js --company="$COMPANY" \
  | sed -n '/§3 — PLAN DE CONSOLIDATION/,$p' | grep -E "GROUPE|décision|Paire validée|CONSOLIDATE" || true

# ── 4. EXÉCUTION ────────────────────────────────────────────────────────────
echo
echo "### 4/5 — ESSAI À BLANC (aucune écriture) ###"
echo "La migration refuse d'agir si elle ne trouve pas exactement $EXPECTED groupe(s)."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v dry_run=true \
     -v company_id="$COMPANY" -v expected_groups="$EXPECTED" \
     -f sql/061a_prepare_physical_locations.sql

if [ "${DRY_RUN:-}" = "1" ]; then
  echo
  echo "DRY_RUN=1 : essai à blanc uniquement, la base est inchangée."
  echo "Relancez sans DRY_RUN pour appliquer réellement."
  exit 0
fi

echo
echo "### 4bis/5 — EXÉCUTION RÉELLE DE 061a ###"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
     -v company_id="$COMPANY" -v expected_groups="$EXPECTED" \
     -f sql/061a_prepare_physical_locations.sql

# ── 5. CONTRÔLES APRÈS ──────────────────────────────────────────────────────
echo
echo "### 5/5 — CONTRÔLES APRÈS ###"
P_APRES=$(q "SELECT COUNT(*) FROM products WHERE company_id=$COMPANY AND COALESCE(is_active,TRUE)")
S_APRES=$(q "SELECT COALESCE(SUM(stock),0) FROM products WHERE company_id=$COMPANY AND COALESCE(is_active,TRUE)")
N_APRES=$(q "SELECT COUNT(*) FROM products WHERE company_id=$COMPANY AND stock<0")
L_APRES=$(q "SELECT COUNT(*) FROM locations WHERE company_id=$COMPANY")
A_APRES=$(locations_actives)
FUSIONNES=$(locations_fusionnees)
CANONIQUES=$(q "SELECT COUNT(DISTINCT merged_into_location_id) FROM locations WHERE company_id=$COMPANY AND merged_into_location_id IS NOT NULL")
ORPHELINES=$(references_orphelines)
PROD_ORPH=$(q "SELECT COUNT(*) FROM products p JOIN locations l ON l.id=p.location_id WHERE l.merged_into_location_id IS NOT NULL AND p.company_id=$COMPANY")
RESTANTS=$(q "WITH c AS (SELECT ARRAY_TO_STRING(ARRAY[NULLIF(TRIM(COALESCE(warehouse_code,'')),''),NULLIF(TRIM(COALESCE(NULLIF(rayon_code,''),zone)),''),NULLIF(TRIM(COALESCE(NULLIF(case_code,''),rayon)),''),NULLIF(TRIM(COALESCE(NULLIF(level_code,''),etagere)),''),NULLIF(TRIM(COALESCE(bin_code,'')),'')],'-') fc, bin_code FROM locations WHERE company_id=$COMPANY AND merged_into_location_id IS NULL) SELECT COUNT(*) FROM (SELECT fc FROM c WHERE COALESCE(TRIM(bin_code),'')<>'' AND bin_code !~* '(WRITE[[:space:]_-]*OFF|REBUT|CASSE|NON[[:space:]_-]*PRECISE|NON[[:space:]_-]*PRÉCIS|INCONNU|DIVERS)' AND fc !~* '(WRITE[[:space:]_-]*OFF|REBUT)' AND TRIM(bin_code) !~* '^(BIN[[:space:]]*)?[0-9]+[[:space:]]*[-/][[:space:]]*[0-9]+\$' GROUP BY fc HAVING COUNT(*)>1) t")

echo
printf "  %-34s %-14s %-14s %s\n" "CONTRÔLE" "AVANT" "APRÈS" "VERDICT"
printf "  %s\n" "$(printf '─%.0s' {1..76})"
verdict() { [ "$2" = "$3" ] && echo "OK" || echo "ÉCART"; }
printf "  %-34s %-14s %-14s %s\n" "stock total"            "$S_AVANT" "$S_APRES" "$(verdict x "$S_AVANT" "$S_APRES")"
printf "  %-34s %-14s %-14s %s\n" "produits actifs"        "$P_AVANT" "$P_APRES" "$(verdict x "$P_AVANT" "$P_APRES")"
printf "  %-34s %-14s %-14s %s\n" "stock négatif"          "$N_AVANT" "$N_APRES" "$(verdict x "0" "$N_APRES")"
printf "  %-34s %-14s %-14s %s\n" "lignes locations"       "$L_AVANT" "$L_APRES" "$(verdict x "$L_AVANT" "$L_APRES")"
printf "  %-34s %-14s %-14s %s\n" "emplacements actifs"    "$A_AVANT" "$A_APRES" "réduits de $((A_AVANT-A_APRES))"
printf "  %-34s %-14s %-14s %s\n" "doublons désactivés"    "0" "$FUSIONNES" "vers $CANONIQUES canonique(s)"
printf "  %-34s %-14s %-14s %s\n" "références orphelines (toutes tables)" "—" "$ORPHELINES" "$(verdict x "0" "$ORPHELINES")"
printf "  %-34s %-14s %-14s %s\n" "produits orphelins"     "—" "$PROD_ORPH" "$(verdict x "0" "$PROD_ORPH")"
printf "  %-34s %-14s %-14s %s\n" "doublons physiques restants" "—" "$RESTANTS" "$(verdict x "0" "$RESTANTS")"

echo
if [ "$S_AVANT" = "$S_APRES" ] && [ "$P_AVANT" = "$P_APRES" ] && [ "$N_APRES" = "0" ] \
   && [ "$L_AVANT" = "$L_APRES" ] && [ "$ORPHELINES" = "0" ] && [ "$PROD_ORPH" = "0" ]; then
  echo "061a APPLIQUÉE. Stock $S_APRES inchangé, $FUSIONNES doublon(s) désactivé(s),"
  echo "aucune ligne supprimée, aucune référence orpheline."
  [ "$RESTANTS" = "0" ] \
    && echo "Aucun doublon physique restant : 061 pourra être lancée après votre accord." \
    || echo "ATTENTION : $RESTANTS doublon(s) physique(s) subsistent. NE PAS lancer 061."
else
  echo "ANOMALIE APRÈS EXÉCUTION. La transaction 061a a pourtant abouti :" >&2
  echo "restaurez immédiatement depuis $DUMP et signalez l'écart." >&2
  exit 1
fi
echo
echo "Journal : $LOG"
echo "STOP — 061 n'a PAS été lancée. Aucun utilisateur modifié. PM2 non redémarré."
