#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════
# RÉPÉTITION GÉNÉRALE SUR UNE COPIE RESTAURÉE DE LA PRODUCTION.
#
#   1. restaurez le dump de production dans une base NEUVE ;
#   2. exportez son DATABASE_URL ;
#   3. lancez ce script.
#
#   pg_restore -d triangle_repetition ~/triangle-prod.dump
#   DATABASE_URL=postgresql://…/triangle_repetition \
#     bash scripts/repetition-production.sh
#
# CE SCRIPT N'EST PAS FAIT POUR LA PRODUCTION et refuse de s'y exécuter :
# il applique une migration et joue de vraies opérations. Il faut donc lui
# donner une COPIE, jetable, et le confirmer explicitement.
#
# Il relève l'état avant, applique 064 DEUX FOIS (idempotence), joue les
# scénarios du terrain, puis relève l'état après et compare. Le stock total
# doit être strictement identique : aucun scénario n'en crée ni n'en détruit.
# ══════════════════════════════════════════════════════════════════════════
set -u

: "${DATABASE_URL:?Exportez DATABASE_URL vers la COPIE restaurée}"
BASE_DE_DONNEES=$(echo "$DATABASE_URL" | sed 's#.*/##; s#?.*##')
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RACINE"

# ── garde-fou : jamais sur la production ────────────────────────────────
if [ "${JE_CONFIRME_UNE_COPIE:-non}" != "oui" ]; then
  echo "Refus : ce script modifie la base. Confirmez qu'il s'agit d'une COPIE :"
  echo "  JE_CONFIRME_UNE_COPIE=oui DATABASE_URL=… bash $0"
  exit 2
fi
case "$BASE_DE_DONNEES" in
  *prod*|*production*|triangle_wms)
    echo "Refus : « $BASE_DE_DONNEES » ressemble à la base de production."
    echo "Restaurez le dump dans une base au nom distinct (ex. triangle_repetition)."
    exit 2;;
esac
echo "Base de répétition : $BASE_DE_DONNEES"

Q() { psql "$DATABASE_URL" -tAX -c "$1"; }

# ── relevé d'état ───────────────────────────────────────────────────────
# Le relevé AVANT s'exécute sur un schéma qui n'a pas encore reçu 064 :
# `archived_at` n'y existe pas. On adapte la requête plutôt que de supposer.
COL_ARCHIVED=$(Q "SELECT COUNT(*) FROM information_schema.columns
                   WHERE table_name='locations' AND column_name='archived_at'")
if [ "$COL_ARCHIVED" = "0" ]; then
  FILTRE_ACTIF="COALESCE(is_active,TRUE)"
else
  FILTRE_ACTIF="COALESCE(is_active,TRUE) AND archived_at IS NULL"
fi

releve() {
  local phase="$1"
  COL_ARCHIVED=$(Q "SELECT COUNT(*) FROM information_schema.columns
                     WHERE table_name='locations' AND column_name='archived_at'")
  if [ "$COL_ARCHIVED" = "0" ]; then
    FILTRE_ACTIF="COALESCE(is_active,TRUE)"
  else
    FILTRE_ACTIF="COALESCE(is_active,TRUE) AND archived_at IS NULL"
  fi
  cat <<EOF > "/tmp/repetition-$phase.txt"
produits=$(Q "SELECT COUNT(*) FROM products")
stock_produits=$(Q "SELECT COALESCE(SUM(stock),0) FROM products")
stock_balances=$(Q "SELECT COALESCE(SUM(quantity),0) FROM stock_location_balances")
stock_negatif_produits=$(Q "SELECT COUNT(*) FROM products WHERE stock < 0")
stock_negatif_balances=$(Q "SELECT COUNT(*) FROM stock_location_balances WHERE quantity < 0")
locations=$(Q "SELECT COUNT(*) FROM locations")
locations_actives=$(Q "SELECT COUNT(*) FROM locations WHERE $FILTRE_ACTIF")
balances=$(Q "SELECT COUNT(*) FROM stock_location_balances")
balances_orphelines=$(Q "SELECT COUNT(*) FROM stock_location_balances b WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.id=b.location_id)")
doublons_full_code=$(Q "SELECT COALESCE(SUM(n-1),0) FROM (SELECT COUNT(*) AS n FROM locations WHERE COALESCE(full_code,'')<>'' GROUP BY company_id, full_code HAVING COUNT(*)>1) x")
sans_full_code=$(Q "SELECT COUNT(*) FROM locations WHERE COALESCE(full_code,'')=''")
ambigus=$(Q "SELECT COUNT(*) FROM locations WHERE COALESCE(bin_code,'') ~ '[,;+]' OR TRIM(COALESCE(bin_code,'')) ~* '^(BIN[[:space:]]*)?[0-9]+[[:space:]]*[-/][[:space:]]*[0-9]+\$'")
produits_incoherents=$(Q "SELECT COUNT(*) FROM products p WHERE COALESCE(p.location_managed,FALSE) AND p.stock <> COALESCE((SELECT SUM(b.quantity) FROM stock_location_balances b WHERE b.product_id=p.id AND b.company_id=p.company_id),0)")
documents=$(Q "SELECT COUNT(*) FROM documents")
documents_created_at=$(Q "SELECT COALESCE(MD5(STRING_AGG(id::text||':'||created_at::text, '|' ORDER BY id)),'vide') FROM documents")
mouvements=$(Q "SELECT COUNT(*) FROM stock_movements")
mouvements_quantite=$(Q "SELECT COALESCE(SUM(quantity),0) FROM stock_movements")
permissions_role=$(Q "SELECT COUNT(*) FROM role_permissions")
permissions_exceptions=$(Q "SELECT COUNT(*) FROM user_permission_overrides")
utilisateurs=$(Q "SELECT COUNT(*) FROM users")
EOF
  echo "  relevé « $phase » écrit"
}

echo; echo "════════ ÉTAT AVANT ════════"
releve avant
cat /tmp/repetition-avant.txt | sed 's/^/  /'

# ── migration, deux fois ────────────────────────────────────────────────
echo; echo "════════ MIGRATION 064 — appliquée DEUX FOIS ════════"
for passage in 1 2; do
  erreurs=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f sql/064_emplacements_dates_documents.sql 2>&1 | grep -c "ERROR")
  echo "  passage $passage : $erreurs erreur(s)"
  [ "$erreurs" != "0" ] && { echo "  ÉCHEC : la migration n'est pas idempotente."; exit 1; }
done

# ── scénarios du terrain ────────────────────────────────────────────────
echo; echo "════════ SCÉNARIOS ════════"
# server.js écoute sur un port CODÉ EN DUR (5050) : il n'y a pas de variable
# à régler. La répétition doit donc être seule à l'utiliser.
export PORT=5050
export JWT_SECRET="${JWT_SECRET:-repetition-$(date +%s)}"
export NODE_ENV=test EMAIL_PROVIDER=sandbox SMS_PROVIDER=sandbox
node server.js > /tmp/repetition-serveur.log 2>&1 &
SERVEUR=$!
trap 'kill $SERVEUR 2>/dev/null' EXIT
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/locations" 2>/dev/null)
  [ "$code" = "401" ] && break
  sleep 0.5
done
[ "$code" != "401" ] && { echo "  le serveur n'a pas démarré"; tail -20 /tmp/repetition-serveur.log; exit 1; }

BASE_URL="http://127.0.0.1:$PORT" node scripts/repetition-scenarios.js
SCENARIOS=$?

# ── état après et comparaison ───────────────────────────────────────────
echo; echo "════════ ÉTAT APRÈS ════════"
releve apres

echo; echo "════════ COMPARAISON ════════"
ECART=0
while IFS='=' read -r cle avant; do
  apres=$(grep "^$cle=" /tmp/repetition-apres.txt | cut -d= -f2-)
  if [ "$avant" = "$apres" ]; then
    printf "  %-28s %s\n" "$cle" "$avant  (inchangé)"
  else
    printf "  %-28s %s → %s\n" "$cle" "$avant" "$apres"
    case "$cle" in
      # Ce que les scénarios font BOUGER, et c'est attendu :
      locations|locations_actives|balances|mouvements|mouvements_quantite|permissions_role|sans_full_code) ;;
      # Ce qui ne doit JAMAIS bouger :
      *) ECART=1; echo "      ↑ ÉCART NON ATTENDU";;
    esac
  fi
done < /tmp/repetition-avant.txt

echo
if [ "$ECART" = "0" ] && [ "$SCENARIOS" = "0" ]; then
  echo "RÉPÉTITION RÉUSSIE — stock, documents et permissions intacts."
  exit 0
fi
echo "RÉPÉTITION EN ÉCHEC — n'appliquez rien en production."
exit 1
