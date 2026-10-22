#!/usr/bin/env bash
#
# ═════════════════════════════════════════════════════════════════════════
#  RAPPORT FAT & MAT — 34 FACTURES, LES ANOMALIES HISTORIQUES
#
#  UNE SEULE COMMANDE, STRICTEMENT EN LECTURE SEULE.
#
#      ./rapport-fatmat.sh
#
#  Elle n'annule aucune facture, ne crée aucun paiement, ne modifie aucun
#  solde. Trois barrières, et non une seule :
#
#    1. le script refuse les options d'écriture ;
#    2. il ouvre une transaction PostgreSQL `READ ONLY` — une écriture
#       échouerait avec le code 25006 ;
#    3. il se connecte, quand c'est possible, avec un rôle en lecture seule
#       (voir ROLE_LECTURE ci-dessous).
#
#  Le rapport sort à l'écran ET dans deux fichiers : un texte lisible et un
#  JSON exploitable.
# ═════════════════════════════════════════════════════════════════════════
set -euo pipefail

RACINE="${RACINE:-/var/www/triangle-wms/backend}"
SORTIE="${SORTIE:-/tmp/fatmat-$(date +%Y%m%d-%H%M%S)}"
# Si vous avez créé un rôle en lecture seule, nommez-le ici : le script
# l'utilisera de préférence. Sans lui, la transaction READ ONLY suffit.
ROLE_LECTURE="${ROLE_LECTURE:-}"

ROUGE=$'\033[31m'; VERT=$'\033[32m'; JAUNE=$'\033[33m'; GRAS=$'\033[1m'; ZERO=$'\033[0m'
titre() { echo; echo "${GRAS}── $* ${ZERO}"; }
ok()    { echo "  ${VERT}✔${ZERO} $*"; }
alerte(){ echo "  ${JAUNE}!${ZERO} $*"; }
echec() { echo "  ${ROUGE}✘ $*${ZERO}" >&2; exit 1; }

for interdit in "$@"; do
  case "$interdit" in
    --appliquer|--apply|--annuler|--supprimer|--delete|--fix)
      echec "« $interdit » n'existe pas ici. Ce rapport ne modifie rien.
     Annuler des factures réelles demandera une liste nominative que
     vous aurez validée, et un autre script." ;;
  esac
done

# ── L'ACCÈS ──────────────────────────────────────────────────────────────
if [ -z "${DATABASE_URL:-}" ] && [ -f "$RACINE/.env" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$RACINE/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
  export DATABASE_URL
fi
[ -n "${DATABASE_URL:-}" ] || echec "DATABASE_URL introuvable (ni dans l'environnement, ni dans $RACINE/.env)."

if [ -n "$ROLE_LECTURE" ]; then
  DATABASE_URL="$(echo "$DATABASE_URL" | sed -E "s#://[^:]+:#://$ROLE_LECTURE:#")"
  export DATABASE_URL
  alerte "Connexion avec le rôle « $ROLE_LECTURE »."
fi

url_masquee() { echo "${DATABASE_URL}" | sed -E 's#://[^@]*@#://***:***@#'; }

titre "Avant de lire"
command -v psql >/dev/null || echec "psql est absent."
command -v node >/dev/null || echec "node est absent."
[ -f "$RACINE/scripts/reconcilier-fatmat.js" ] || echec "Script de réconciliation introuvable dans $RACINE."
psql "$DATABASE_URL" -tAc "SELECT 1" >/dev/null 2>&1 || echec "Base inaccessible : $(url_masquee)"
ok "base accessible : $(url_masquee)"

# ── LA PREUVE DU VERROU ──────────────────────────────────────────────────
# On ne promet pas la lecture seule : on la démontre, avant de lire quoi que
# ce soit. PostgreSQL doit refuser une écriture avec le code 25006.
titre "Preuve du verrou en lecture seule"
# `VERBOSITY verbose` : sans lui, psql affiche le message d'erreur mais pas
# son code SQLSTATE, et l'on serait réduit à reconnaître une phrase — qui
# change avec la langue du serveur. Le code 25006, lui, ne change pas.
#
# Et PAS « CREATE TEMP TABLE » : PostgreSQL l'AUTORISE en transaction READ
# ONLY. La preuve ne prouvait rien. Une table ordinaire est refusée — et
# n'est jamais créée, puisque le refus précède.
code="$(psql "$DATABASE_URL" -tA -v ON_ERROR_STOP=0 <<'SQL' 2>&1 | grep -oE '\b25006\b' | head -1 || true
\set VERBOSITY verbose
BEGIN TRANSACTION READ ONLY;
CREATE TABLE preuve_du_verrou_lecture_seule (x int);
ROLLBACK;
SQL
)"
[ "$code" = "25006" ] || echec "PostgreSQL n'a pas refusé l'écriture comme attendu (code « ${code:-aucun} »).
     Le rapport n'a PAS été lancé."
ok "PostgreSQL refuse toute écriture dans ce mode (code 25006)"

# ── LE RAPPORT ───────────────────────────────────────────────────────────
mkdir -p "$(dirname "$SORTIE")"
titre "Lecture"
cd "$RACINE"
node scripts/reconcilier-fatmat.js | tee "$SORTIE.txt"
node scripts/reconcilier-fatmat.js --json > "$SORTIE.json"

titre "Fichiers produits"
ok "rapport lisible : $SORTIE.txt"
ok "rapport JSON    : $SORTIE.json"

# ── CE QUI N'A PAS ÉTÉ FAIT ──────────────────────────────────────────────
titre "Contrôle après lecture"
avant_apres="$(psql "$DATABASE_URL" -tAc "
  SELECT count(*)||'/'||COALESCE(SUM(total_amount),0)||'/'||
         count(*) FILTER (WHERE cancelled_at IS NOT NULL)
    FROM sand_invoices
   WHERE company_id = (SELECT id FROM companies WHERE name ILIKE '%FAT%' AND name ILIKE '%MAT%')")"
ok "factures / montant / annulées : $avant_apres"
paiements="$(psql "$DATABASE_URL" -tAc "
  SELECT count(*) FROM sand_payments
   WHERE company_id = (SELECT id FROM companies WHERE name ILIKE '%FAT%' AND name ILIKE '%MAT%')")"
ok "encaissements : $paiements — aucun créé, aucun supprimé"

echo
alerte "Aucune facture annulée. Aucun paiement créé. Aucun solde modifié."
echo "     Les candidates à l'annulation du §6 sont une PROPOSITION."
echo "     Elles attendent votre validation, facture par facture."
