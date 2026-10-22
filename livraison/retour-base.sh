#!/usr/bin/env bash
#
# ═════════════════════════════════════════════════════════════════════════
#  RETOUR ARRIÈRE DE LA BASE — distinct de celui du code
#
#  Le code se remet en place par Git : une commande, aucun risque de perte.
#  La base, non. Une restauration ramène la photo du passé et EFFACE tout ce
#  qui a été enregistré depuis — les factures saisies hier, les paiements
#  encaissés ce matin. C'est précisément ce qu'il faut éviter.
#
#  Trois niveaux, du plus sûr au plus brutal :
#
#    niveau 1   ./retour-base.sh verifier
#               Ne touche à rien. Dit si le retour du CODE SEUL suffit.
#               Dans la quasi-totalité des cas, c'est la bonne réponse : les
#               neuf migrations du lot n'ajoutent que des tables, des colonnes
#               et des vues. L'ancien code les ignore.
#
#    niveau 2   ./retour-base.sh defaire-ajouts
#               Retire ce que le lot a ajouté, et RIEN D'AUTRE. Exporte
#               d'abord le contenu des nouvelles tables. Aucune ligne
#               antérieure, aucune opération postérieure n'est touchée.
#
#    niveau 3   ./retour-base.sh restaurer <horodatage>
#               La restauration complète. À ne lancer que si le schéma est
#               cassé. Capture d'abord TOUT ce qui a été écrit depuis la
#               sauvegarde, dans un fichier rejouable, puis restaure.
#
#  Aucun niveau ne s'exécute sans confirmation tapée à la main.
# ═════════════════════════════════════════════════════════════════════════
set -uo pipefail

RACINE="$(cd "$(dirname "$0")/.." && pwd)"
SAUVEGARDES="${SAUVEGARDES:-/var/backups/triangle-wms}"
SORTIES="${SORTIES:-$SAUVEGARDES/retour}"
HORODATAGE="$(date +%Y%m%d-%H%M%S)"

ROUGE=$'\033[31m'; VERT=$'\033[32m'; JAUNE=$'\033[33m'; GRAS=$'\033[1m'; ZERO=$'\033[0m'
titre() { echo; echo "${GRAS}── $* ${ZERO}"; }
ok()    { echo "  ${VERT}✔${ZERO} $*"; }
alerte(){ echo "  ${JAUNE}!${ZERO} $*"; }
echec() { echo "  ${ROUGE}✘ $*${ZERO}" >&2; exit 1; }

[ -n "${DATABASE_URL:-}" ] || echec "DATABASE_URL n'est pas défini."
q() { psql "$DATABASE_URL" -tA -c "$1" 2>/dev/null; }
q "SELECT 1" >/dev/null || echec "Base inaccessible."

# Les migrations du lot et ce qu'elles ont apporté.
LOT=(150 151 152 153 154 155 156 157 158)
NOUVELLES_TABLES=(internal_fund_transfers cash_voucher_history cement_payment_reversals
                  stock_request_corrections hr_contracts hr_contract_clauses hr_documents
                  invoice_statements invoice_statement_lines invoice_statement_history
                  invoice_statement_history_notice payment_reallocations
                  hr_document_history invoice_duplicate_reviews)
NOUVELLES_VUES=(v_transferts_internes_candidats v_bons_incoherents
                v_remboursements_attendus v_demandes_incoherentes
                v_factures_deja_sur_etat v_paiements_reaffectes
                v_documents_rh_courants v_paires_tranchees)

confirmer() {
  local phrase="$1"
  echo
  echo "${JAUNE}Pour continuer, tapez exactement : ${GRAS}$phrase${ZERO}"
  printf "  > "
  local reponse; read -r reponse
  [ "$reponse" = "$phrase" ] || echec "Annulé. Rien n'a été fait."
}

# ─────────────────────────────────────────────────────────────────────────
# NIVEAU 1 — dire si le code seul suffit
# ─────────────────────────────────────────────────────────────────────────
verifier() {
  titre "Ce que le lot a laissé dans la base"
  local avec_contenu=0
  for t in "${NOUVELLES_TABLES[@]}"; do
    if [ "$(q "SELECT to_regclass('public.$t') IS NOT NULL")" = "t" ]; then
      local n; n="$(q "SELECT count(*) FROM $t")"
      if [ "${n:-0}" -gt 0 ]; then
        echo "  • $t : ${GRAS}$n ligne(s)${ZERO}"
        avec_contenu=$((avec_contenu+1))
      else
        echo "  • $t : vide"
      fi
    else
      echo "  • $t : absente (migration non appliquée)"
    fi
  done

  titre "Les gestes déjà faits, que défaire ne défera PAS"
  for t in payment_reallocations invoice_duplicate_reviews; do
    if [ "$(q "SELECT to_regclass('public.$t') IS NOT NULL")" = "t" ]; then
      n="$(q "SELECT count(*) FROM $t")"
      [ "${n:-0}" -gt 0 ] && echo "  • $t : ${GRAS}$n${ZERO} — voir ci-dessous"
    fi
  done
  reaff="$(q "SELECT count(*) FROM payment_reallocations WHERE reverted_at IS NULL" 2>/dev/null || echo 0)"
  neutr="$(q "SELECT count(*) FROM invoice_duplicate_reviews WHERE neutralized_at IS NOT NULL" 2>/dev/null || echo 0)"
  if [ "${reaff:-0}" -gt 0 ]; then
    alerte "$reaff paiement(s) ont été portés sur une autre facture. Retirer le"
    alerte "journal des réaffectations ne les ramènera PAS : ils resteront où ils"
    alerte "sont, et plus rien ne dira qu'ils ont bougé. Annulez-les d'abord si"
    alerte "vous voulez revenir en arrière."
  fi
  if [ "${neutr:-0}" -gt 0 ]; then
    alerte "$neutr facture(s) ont été neutralisées comme doublons. Elles restent"
    alerte "annulées : supprimer le registre des verdicts n'y change rien."
  fi

  titre "Les transferts internes, le point sensible"
  if [ "$(q "SELECT to_regclass('public.internal_fund_transfers') IS NOT NULL")" = "t" ]; then
    local actifs; actifs="$(q "SELECT count(*) FROM internal_fund_transfers WHERE status = 'ACTIF'")"
    local masques; masques="$(q "SELECT count(*) FROM accounting_transactions WHERE show_in_financial_movements = FALSE")"
    echo "  transferts non annulés            : ${actifs:-0}"
    echo "  mouvements exclus du résultat     : ${masques:-0}"
    if [ "${masques:-0}" -gt 0 ]; then
      alerte "Retirer la colonne show_in_financial_movements ferait RÉAPPARAÎTRE"
      alerte "ces ${masques} mouvements dans les recettes et les dépenses."
      alerte "Le niveau 2 est donc à éviter tant que ces transferts existent."
    fi
  else
    echo "  migration 150 non appliquée : rien à craindre ici."
  fi

  titre "Verdict"
  echo "  Les neuf migrations du lot sont ${GRAS}additives${ZERO} : nouvelles tables,"
  echo "  nouvelles colonnes avec valeur par défaut, nouvelles vues, nouveaux"
  echo "  droits. Aucune ne réécrit ni ne supprime de donnée antérieure."
  echo
  echo "  ${GRAS}Conséquence : remettre le CODE en arrière suffit.${ZERO} L'ancien code"
  echo "  n'interroge pas les nouvelles tables et ignore les nouvelles"
  echo "  colonnes. La base peut rester telle quelle, sans aucune perte."
  echo
  echo "    cd $RACINE"
  echo "    git checkout \$(cat $SAUVEGARDES/.commit-<horodatage>)"
  echo "    npm ci --omit=dev && pm2 restart triangle-backend"
  echo
  if [ "$avec_contenu" -gt 0 ]; then
    echo "  $avec_contenu nouvelle(s) table(s) contiennent déjà des données. Elles"
    echo "  resteront en place, inertes, et seront relues telles quelles si vous"
    echo "  redéployez plus tard. ${GRAS}C'est un avantage, pas un problème.${ZERO}"
  fi
  echo
  echo "  Le niveau 2 ne se justifie que si une des nouvelles structures gêne"
  echo "  réellement — par exemple si une contrainte d'unicité nouvelle empêche"
  echo "  une saisie que l'ancien code acceptait."
}

# ─────────────────────────────────────────────────────────────────────────
# Capturer ce qui a été écrit APRÈS un instant donné
# ─────────────────────────────────────────────────────────────────────────
capturer_posterieur() {
  local depuis="$1" dossier="$2"
  mkdir -p "$dossier"
  # Toute table portant une colonne de date de création : on sort les lignes
  # plus récentes que la sauvegarde. C'est ce qu'une restauration détruirait.
  local tables
  tables="$(q "
    SELECT c.table_name || '|' || c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND c.column_name IN ('created_at','requested_at','applied_at','recorded_at','payment_date')
       AND c.data_type LIKE 'timestamp%'
     ORDER BY 1")"
  local total=0 fichiers=0
  while IFS='|' read -r table colonne; do
    [ -n "$table" ] || continue
    local n; n="$(q "SELECT count(*) FROM \"$table\" WHERE \"$colonne\" > '$depuis'::timestamptz")"
    [ "${n:-0}" -gt 0 ] || continue
    psql "$DATABASE_URL" -q -c "\\copy (SELECT * FROM \"$table\" WHERE \"$colonne\" > '$depuis'::timestamptz) TO '$dossier/$table.csv' WITH CSV HEADER" 2>/dev/null \
      && { echo "  • $table : $n ligne(s) postérieure(s)"; total=$((total+n)); fichiers=$((fichiers+1)); } \
      || alerte "$table : export impossible"
  done <<< "$tables"
  echo "$total" > "$dossier/.total"
  if [ "$fichiers" -eq 0 ]; then
    ok "Rien n'a été écrit depuis la sauvegarde : une restauration ne perdrait rien."
  else
    ok "$total ligne(s) dans $fichiers fichier(s) : $dossier"
    cat > "$dossier/LISEZ-MOI.txt" <<TXT
Ce dossier contient tout ce qui a été écrit dans la base APRÈS la sauvegarde
du $depuis, et que la restauration complète va effacer.

Un fichier CSV par table, avec son en-tête.

Pour remettre une table après la restauration :

  psql "\$DATABASE_URL" -c "\\copy <table> FROM '<table>.csv' WITH CSV HEADER"

Ne rejouez pas aveuglément : certaines lignes dépendent d'autres (une facture
avant son paiement, un salarié avant son contrat). Rejouez dans l'ordre des
dépendances, et vérifiez les séquences ensuite :

  SELECT setval(pg_get_serial_sequence('<table>','id'), (SELECT max(id) FROM <table>));

Les soldes de trésorerie (accounting_banks.current_balance, caisses.solde_actuel,
treasury_accounts.current_balance) ne sont PAS dans ces fichiers : ce sont des
cumuls, pas des opérations. Après un rejeu, recalculez-les ou corrigez-les à la
main, sinon ils refléteront l'état de la sauvegarde et non celui des opérations
rejouées.
TXT
  fi
}

# ─────────────────────────────────────────────────────────────────────────
# NIVEAU 2 — défaire les ajouts, sans toucher au reste
# ─────────────────────────────────────────────────────────────────────────
defaire_ajouts() {
  titre "Niveau 2 — retirer ce que le lot a ajouté"
  echo "  Rien de ce qui existait avant, rien de ce qui a été enregistré depuis"
  echo "  ne sera touché. Seules les structures créées par les migrations"
  echo "  150 à 154 seront retirées."

  # Le garde-fou sur les transferts internes.
  if [ "$(q "SELECT to_regclass('public.internal_fund_transfers') IS NOT NULL")" = "t" ]; then
    local actifs; actifs="$(q "SELECT count(*) FROM internal_fund_transfers WHERE status = 'ACTIF'")"
    if [ "${actifs:-0}" -gt 0 ] && [ "${FORCER_TRANSFERTS:-}" != "oui" ]; then
      echo
      echec "$actifs transfert(s) interne(s) non annulé(s) existent.
  Retirer la colonne show_in_financial_movements les ferait réapparaître dans
  les recettes et les dépenses, et fausserait le résultat de l'entreprise.

  Si c'est vraiment ce que vous voulez, relancez avec :
      FORCER_TRANSFERTS=oui $0 defaire-ajouts
  Sinon, préférez le niveau 1 : remettre le code suffit."
    fi
  fi

  titre "Export du contenu avant suppression"
  local dossier="$SORTIES/$HORODATAGE-defaire"
  mkdir -p "$dossier" || echec "Impossible d'écrire dans $dossier."
  local exportees=0
  for t in "${NOUVELLES_TABLES[@]}"; do
    [ "$(q "SELECT to_regclass('public.$t') IS NOT NULL")" = "t" ] || continue
    local n; n="$(q "SELECT count(*) FROM $t")"
    psql "$DATABASE_URL" -q -c "\\copy $t TO '$dossier/$t.csv' WITH CSV HEADER" 2>/dev/null \
      || echec "Export de $t impossible. On s'arrête : rien n'a été supprimé."
    echo "  • $t : ${n:-0} ligne(s) exportée(s)"
    exportees=$((exportees+1))
  done
  # Les colonnes qui vont disparaître d'une table antérieure : l'historique
  # des annulations et des corrections vit là, pas dans une table à part.
  if [ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='stock_requests' AND column_name='last_correction_at'")" = "1" ]; then
    psql "$DATABASE_URL" -q -c "\\copy (SELECT id, company_id, reference, cancel_reason, cancelled_by_name, last_correction_at, last_correction_by, corrections_count FROM stock_requests WHERE cancel_reason IS NOT NULL OR last_correction_at IS NOT NULL) TO '$dossier/stock_requests-colonnes-retirees.csv' WITH CSV HEADER" 2>/dev/null \
      && ok "colonnes de correction de stock_requests exportées"
  fi
  if [ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='cash_vouchers' AND column_name='cancel_reason'")" = "1" ]; then
    psql "$DATABASE_URL" -q -c "\\copy (SELECT id, company_id, cancelled_at, cancelled_by, cancelled_by_name, cancel_reason FROM cash_vouchers WHERE cancelled_at IS NOT NULL) TO '$dossier/cash_vouchers-colonnes-retirees.csv' WITH CSV HEADER" 2>/dev/null \
      && ok "colonnes d'annulation de cash_vouchers exportées"
  fi
  psql "$DATABASE_URL" -q -c "\\copy (SELECT * FROM role_permissions WHERE module_key IN ('comptabilite.transfert_interne','comptabilite.bon','rh.document') OR (module_key='demande' AND action='contrepasser') OR (module_key='ciment' AND action IN ('paiement_contrepasser','remboursement_constater'))) TO '$dossier/role_permissions-concernees.csv' WITH CSV HEADER" 2>/dev/null \
    && ok "droits concernés exportés (y compris ceux réglés à la main)"
  ok "export complet : $dossier"

  confirmer "RETIRER LES AJOUTS"

  titre "Suppression, dans l'ordre inverse de l'application"
  local echecs=0
  for n in 158 157 156 155 154 153 152 151 150; do
    local f; f="$(ls "$RACINE"/sql/retour/${n}_*_defaire.sql 2>/dev/null | head -1)"
    [ -n "$f" ] || { alerte "aucun fichier de retour pour $n"; continue; }
    if psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>"$dossier/erreur-$n.log"; then
      ok "$n défait"
      psql "$DATABASE_URL" -q -c "DELETE FROM schema_migrations WHERE filename LIKE '${n}\\_%'" >/dev/null 2>&1
    else
      echo "  ${ROUGE}✘ $n : $(head -3 "$dossier/erreur-$n.log" | tr '\n' ' ')${ZERO}"
      echecs=$((echecs+1))
    fi
  done

  titre "Contrôle"
  local restantes=0
  for t in "${NOUVELLES_TABLES[@]}"; do
    [ "$(q "SELECT to_regclass('public.$t') IS NOT NULL")" = "t" ] && { echo "  • $t subsiste"; restantes=$((restantes+1)); }
  done
  [ "$restantes" = "0" ] && ok "toutes les tables du lot ont été retirées" \
                         || alerte "$restantes table(s) subsistent"
  for v in "${NOUVELLES_VUES[@]}"; do
    [ "$(q "SELECT to_regclass('public.$v') IS NOT NULL")" = "t" ] && alerte "vue $v subsiste"
  done
  echo
  if [ "$echecs" = "0" ]; then
    ok "Base ramenée à l'état d'avant le lot, sans restauration et sans perte."
    echo "    Le contenu retiré est dans $dossier"
    echo "    Remettez maintenant le code en arrière (voir « verifier »)."
  else
    echec "$echecs étape(s) ont échoué. Les journaux sont dans $dossier."
  fi
}

# ─────────────────────────────────────────────────────────────────────────
# NIVEAU 3 — restauration complète, en dernier recours
# ─────────────────────────────────────────────────────────────────────────
restaurer() {
  local horo="${1:-}"
  [ -n "$horo" ] || echec "Donnez l'horodatage : $0 restaurer 20261022-063904"
  local dump="$SAUVEGARDES/triangle-$horo.dump"
  [ -f "$dump" ] || dump="$SAUVEGARDES/triangle-avant-v17-$horo.dump"
  [ -f "$dump" ] || echec "Sauvegarde introuvable pour $horo dans $SAUVEGARDES."

  titre "Niveau 3 — restauration complète"
  echo "  ${ROUGE}${GRAS}CECI EFFACE TOUT CE QUI A ÉTÉ ENREGISTRÉ DEPUIS LA SAUVEGARDE.${ZERO}"
  echo "  Fichier  : $dump"
  echo "  Écrit le : $(date -r "$dump" '+%d/%m/%Y à %H:%M:%S' 2>/dev/null || echo inconnu)"

  titre "D'abord : capturer ce que la restauration va détruire"
  local instant; instant="$(date -r "$dump" '+%Y-%m-%d %H:%M:%S' 2>/dev/null)"
  [ -n "$instant" ] || echec "Impossible de dater la sauvegarde : capture impossible, on s'arrête."
  local dossier="$SORTIES/$HORODATAGE-posterieur-a-$horo"
  capturer_posterieur "$instant" "$dossier"
  local total; total="$(cat "$dossier/.total" 2>/dev/null || echo 0)"

  titre "Vérifier que la sauvegarde est lisible AVANT de vider quoi que ce soit"
  local essai="essai_restauration_${HORODATAGE//-/_}"
  createdb "$essai" 2>/dev/null || echec "Impossible de créer la base d'essai $essai."
  if pg_restore --no-owner --no-privileges -d "$essai" "$dump" >/dev/null 2>&1 \
     || [ "$(psql -d "$essai" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")" -gt 10 ]; then
    ok "la sauvegarde se restaure ($(psql -d "$essai" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'") tables)"
    dropdb "$essai" 2>/dev/null
  else
    dropdb "$essai" 2>/dev/null
    echec "La sauvegarde ne se restaure pas. ON NE TOUCHE PAS À LA BASE."
  fi

  echo
  if [ "${total:-0}" -gt 0 ]; then
    echo "  ${ROUGE}${GRAS}$total ligne(s) enregistrée(s) après la sauvegarde vont disparaître.${ZERO}"
    echo "  Elles sont copiées dans :"
    echo "    $dossier"
    echo "  Leur rejeu est MANUEL et demande de l'attention (voir LISEZ-MOI.txt)."
  fi
  confirmer "JE PERDS LES DONNEES POSTERIEURES"

  titre "Sauvegarde de l'état actuel, pour pouvoir revenir du retour"
  local filet="$SAUVEGARDES/avant-restauration-$HORODATAGE.dump"
  pg_dump -Fc "$DATABASE_URL" -f "$filet" 2>/dev/null \
    && ok "état actuel conservé : $filet" \
    || echec "Impossible de sauvegarder l'état actuel. On s'arrête."

  titre "Restauration"
  psql "$DATABASE_URL" -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null 2>&1 \
    && ok "schéma vidé (pg_restore --clean ne suffit pas : il ne supprime que ce qu'il connaît)" \
    || echec "Impossible de vider le schéma."
  pg_restore --no-owner --no-privileges -d "$DATABASE_URL" "$filet" >/dev/null 2>&1 # calage des extensions
  psql "$DATABASE_URL" -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null 2>&1
  pg_restore --no-owner --no-privileges -d "$DATABASE_URL" "$dump" >/dev/null 2>&1
  local n; n="$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
  [ "${n:-0}" -gt 10 ] && ok "restauration faite : $n tables" || echec "La restauration a échoué. L'état d'avant est dans $filet."

  titre "Et ensuite"
  echo "  1. Remettez le code sur le commit correspondant."
  echo "  2. Relisez $dossier/LISEZ-MOI.txt et décidez du rejeu."
  echo "  3. Recalculez les soldes de trésorerie : ils reflètent la sauvegarde."
  echo "  4. Si vous vous êtes trompé, l'état d'avant la restauration est dans :"
  echo "     $filet"
}

case "${1:-aide}" in
  verifier|verifie|niveau1)        verifier ;;
  defaire-ajouts|niveau2)          defaire_ajouts ;;
  restaurer|niveau3)               shift; restaurer "${1:-}" ;;
  capturer)                        shift; capturer_posterieur "${1:?donnez un instant}" "${2:-$SORTIES/$HORODATAGE-capture}" ;;
  *) sed -n '3,30p' "$0" | sed 's/^#\s\?//' ;;
esac
