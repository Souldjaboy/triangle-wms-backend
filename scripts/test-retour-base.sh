#!/usr/bin/env bash
# Éprouve les trois niveaux de retour arrière de la base.
set -uo pipefail
PGBIN=/usr/lib/postgresql/16/bin; PGPORT=5433
B="retour_$(date +%H%M%S)"
export DATABASE_URL="postgresql://postgres@127.0.0.1:$PGPORT/$B"
export SAUVEGARDES="/tmp/retour-essai-$$" SORTIES="/tmp/retour-essai-$$/retour"
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
VERT=$'\033[32m'; ROUGE=$'\033[31m'; GRAS=$'\033[1m'; ZERO=$'\033[0m'
r=0; e=0
v(){ if [ "$1" = 0 ]; then r=$((r+1)); echo "  ${VERT}✔${ZERO} $2"; else e=$((e+1)); echo "  ${ROUGE}✘ $2${ZERO}"; fi; }
t(){ echo; echo "${GRAS}── $* ${ZERO}"; }
fin(){ su postgres -c "$PGBIN/dropdb -p $PGPORT --force --if-exists $B" >/dev/null 2>&1; rm -rf "$SAUVEGARDES"; }
trap fin EXIT
q(){ psql "$DATABASE_URL" -tA -c "$1" 2>/dev/null; }

mkdir -p "$SAUVEGARDES"
su postgres -c "$PGBIN/createdb -p $PGPORT $B" || exit 1
cd "$RACINE/sql"
# Les sociétés d'abord : les semis de droits bouclent sur « SELECT id FROM
# companies ». Sans elles, les migrations ne posent aucun droit — c'est ce qui
# avait fait échouer cet essai la première fois.
for f in $(ls *.sql | sort -V | grep -vE '^15'); do psql "$DATABASE_URL" -q -f "$f" >/dev/null 2>&1; done
psql "$DATABASE_URL" -q -c "INSERT INTO companies(id,name) VALUES (1,'Triangle'),(2,'FAT & MAT') ON CONFLICT DO NOTHING" >/dev/null 2>&1
for f in 15*.sql; do psql "$DATABASE_URL" -q -f "$f" >/dev/null 2>&1; done
cd "$RACINE"
# Le registre, que le script de déploiement tient normalement.
psql "$DATABASE_URL" -q -c "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())" >/dev/null 2>&1
for f in "$RACINE"/sql/15*.sql; do
  psql "$DATABASE_URL" -q -c "INSERT INTO schema_migrations(filename) VALUES ('$(basename "$f")') ON CONFLICT DO NOTHING" >/dev/null 2>&1
done

t "Mise en situation"
for x in internal_fund_transfers hr_contracts stock_request_corrections; do
  [ "$(q "SELECT to_regclass('public.$x') IS NOT NULL")" = t ] && c=0 || c=1; v $c "table $x en place"
done

# Des données antérieures, et des données postérieures : ce sont elles qu'il
# ne faut jamais perdre.
psql "$DATABASE_URL" -q <<SQL >/dev/null 2>&1
INSERT INTO stock_requests(company_id,reference,request_type,status,requested_at)
VALUES (1,'ANTERIEURE-1','SORTIE','VALIDEE', now() - interval '10 days');
SQL
anterieures="$(q "SELECT count(*) FROM stock_requests")"
[ "${anterieures:-0}" -ge 1 ] && c=0 || c=1; v $c "$anterieures demande(s) antérieure(s)"

t "Niveau 1 : il doit dire que le code seul suffit"
bash livraison/retour-base.sh verifier > /tmp/n1.log 2>&1
grep -q "remettre le CODE en arrière suffit" /tmp/n1.log; v $? "le verdict recommande le retour du code seul"
grep -q "additives" /tmp/n1.log; v $? "il explique pourquoi (migrations additives)"
[ "$(q "SELECT to_regclass('public.internal_fund_transfers') IS NOT NULL")" = t ] && c=0 || c=1
v $c "niveau 1 n'a rien supprimé"

t "Garde-fou : un transfert interne en place doit BLOQUER le niveau 2"
# Un vrai transfert, avec son mouvement masqué du résultat.
psql "$DATABASE_URL" -q <<SQL >/dev/null 2>&1
INSERT INTO internal_fund_transfers
  (company_id, reference, transfer_date, amount,
   source_kind, source_label, destination_kind, destination_label,
   status, reason, created_by_name, cancelled_by_name, cancel_reason)
VALUES (1,'TR-ESSAI-1',current_date,2000000,
        'BANQUE','BDM compte courant','CAISSE','Caisse principale',
        'ACTIF','approvisionnement de la caisse','essai','','');
INSERT INTO accounting_transactions(company_id, transaction_type, direction, amount, description, show_in_financial_movements, is_internal_transfer)
VALUES (1,'transfert_interne','sortie',2000000,'Transfert banque vers caisse',FALSE,TRUE),
       (1,'transfert_interne','entrée',2000000,'Transfert banque vers caisse',FALSE,TRUE);
SQL
transferts="$(q "SELECT count(*) FROM internal_fund_transfers WHERE status = 'ACTIF'")"
[ "${transferts:-0}" -ge 1 ] && c=0 || c=1; v $c "$transferts transfert(s) enregistré(s)"
masques="$(q "SELECT count(*) FROM accounting_transactions WHERE show_in_financial_movements = FALSE")"
[ "${masques:-0}" -ge 2 ] && c=0 || c=1; v $c "$masques mouvement(s) exclus du résultat"

# Pas de « | grep -q » ici : grep ferme le tube, le producteur reçoit SIGPIPE,
# et « pipefail » transforme un contrôle réussi en échec.
bash livraison/retour-base.sh verifier > /tmp/n1b.log 2>&1
grep -q "RÉAPPARAÎTRE" /tmp/n1b.log
v $? "niveau 1 avertit que défaire ferait réapparaître ces mouvements"

echo "RETIRER LES AJOUTS" | bash livraison/retour-base.sh defaire-ajouts > /tmp/n2-bloque.log 2>&1
code=$?
[ "$code" != "0" ] && c=0 || c=1; v $c "niveau 2 REFUSE (code $code)"
grep -q "fausserait le résultat" /tmp/n2-bloque.log; v $? "il dit pourquoi il refuse"
[ "$(q "SELECT to_regclass('public.internal_fund_transfers') IS NOT NULL")" = t ] && c=0 || c=1
v $c "et n'a effectivement rien supprimé"

t "Le refus demande un ordre explicite, pas une option cachée"
grep -q "FORCER_TRANSFERTS=oui" /tmp/n2-bloque.log; v $? "il indique la commande pour passer outre"

t "Niveau 2 forcé : il doit exporter avant de supprimer"
echo "RETIRER LES AJOUTS" | FORCER_TRANSFERTS=oui bash livraison/retour-base.sh defaire-ajouts > /tmp/n2.log 2>&1
grep -q "export complet" /tmp/n2.log; v $? "le contenu a été exporté avant suppression"
ls "$SORTIES"/*-defaire/internal_fund_transfers.csv >/dev/null 2>&1; v $? "internal_fund_transfers.csv écrit"
grep -q "TR-ESSAI-1" "$SORTIES"/*-defaire/internal_fund_transfers.csv 2>/dev/null
v $? "et il contient réellement le transfert"
ls "$SORTIES"/*-defaire/role_permissions-concernees.csv >/dev/null 2>&1
v $? "les droits concernés ont été exportés"

t "Niveau 2 forcé : le résultat"
for x in internal_fund_transfers cash_voucher_history cement_payment_reversals stock_request_corrections hr_contracts hr_contract_clauses hr_documents invoice_statements invoice_statement_lines payment_reallocations hr_document_history invoice_duplicate_reviews; do
  [ "$(q "SELECT to_regclass('public.$x') IS NULL")" = t ] && c=0 || c=1; v $c "$x retirée"
done
for x in v_transferts_internes_candidats v_bons_incoherents v_remboursements_attendus v_demandes_incoherentes v_factures_deja_sur_etat v_paiements_reaffectes v_documents_rh_courants v_paires_tranchees; do
  [ "$(q "SELECT to_regclass('public.$x') IS NULL")" = t ] && c=0 || c=1; v $c "vue $x retirée"
done
[ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='accounting_transactions' AND column_name='show_in_financial_movements'")" = 0 ] && c=0 || c=1
v $c "colonne show_in_financial_movements retirée"
[ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='stock_requests' AND column_name='corrections_count'")" = 0 ] && c=0 || c=1
v $c "colonnes de correction retirées de stock_requests"

t "LE POINT CRUCIAL : l'antérieur et le reste sont intacts"
[ "$(q "SELECT count(*) FROM stock_requests")" = "$anterieures" ] && c=0 || c=1
v $c "les demandes antérieures sont toujours là ($anterieures)"
[ "$(q "SELECT to_regclass('public.stock_requests') IS NOT NULL")" = t ] && c=0 || c=1
v $c "stock_requests existe toujours (seules ses colonnes ajoutées sont parties)"
[ "$(q "SELECT to_regclass('public.cash_vouchers') IS NOT NULL")" = t ] && c=0 || c=1
v $c "cash_vouchers existe toujours"
[ "$(q "SELECT to_regclass('public.accounting_transactions') IS NOT NULL")" = t ] && c=0 || c=1
v $c "accounting_transactions existe toujours"
[ "$(q "SELECT count(*) FROM permission_actions WHERE action_key='contrepasser'")" = 1 ] && c=0 || c=1
v $c "le catalogue permission_actions n'a PAS été amputé"
[ "$(q "SELECT count(*) FROM permission_modules WHERE module_key='ciment'")" = 1 ] && c=0 || c=1
v $c "le module ciment, antérieur au lot, est préservé"
[ "$(q "SELECT 'contrepasser' = ANY(actions) FROM permission_modules WHERE module_key='demande'")" = f ] && c=0 || c=1
v $c "« contrepasser » a été retiré de la liste du module demande"
[ "$(q "SELECT count(*) FROM schema_migrations WHERE filename LIKE '15%'")" = 0 ] && c=0 || c=1
v $c "les cinq migrations ont été retirées du registre"

t "Les droits réglés à la main survivent"
# On remet le lot, on règle un droit à la main, on défait : il doit rester.
cd "$RACINE/sql"; for f in 15*.sql; do psql "$DATABASE_URL" -q -f "$f" >/dev/null 2>&1; done; cd "$RACINE"
psql "$DATABASE_URL" -q -c "UPDATE role_permissions SET allowed=false, updated_by=1 WHERE module_key='rh.document' AND role='comptable' AND action='view'" >/dev/null 2>&1
regles="$(q "SELECT count(*) FROM role_permissions WHERE module_key='rh.document' AND updated_by IS NOT NULL")"
[ "${regles:-0}" -ge 1 ] && c=0 || c=1; v $c "$regles droit(s) réglé(s) à la main posé(s) pour l'essai"
echo "RETIRER LES AJOUTS" | FORCER_TRANSFERTS=oui bash livraison/retour-base.sh defaire-ajouts > /tmp/n2b.log 2>&1
reste="$(q "SELECT count(*) FROM role_permissions WHERE module_key='rh.document' AND updated_by IS NOT NULL")"
[ "$reste" = "$regles" ] && c=0 || c=1
v $c "ils sont toujours là après le retour arrière ($reste)"
[ "$(q "SELECT count(*) FROM permission_modules WHERE module_key='rh.document'")" = 1 ] && c=0 || c=1
v $c "le module rh.document est donc conservé aussi (sinon la clé étrangère casserait)"

t "Capture de ce qui a été écrit après un instant donné"
psql "$DATABASE_URL" -q -c "INSERT INTO stock_requests(company_id,reference,request_type,status) VALUES (1,'POSTERIEURE-1','SORTIE','VALIDEE')" >/dev/null 2>&1
bash livraison/retour-base.sh capturer "$(date -d '1 hour ago' '+%Y-%m-%d %H:%M:%S')" /tmp/capture-$$ > /tmp/n3cap.log 2>&1
grep -q "stock_requests" /tmp/n3cap.log; v $? "stock_requests figure dans la capture"
grep -q "POSTERIEURE-1" /tmp/capture-$$/stock_requests.csv 2>/dev/null
v $? "la ligne postérieure y est, celle d'il y a dix jours non"
grep -q "ANTERIEURE-1" /tmp/capture-$$/stock_requests.csv 2>/dev/null && c=1 || c=0
v $c "l'antérieure est bien exclue de la capture"
[ -f /tmp/capture-$$/LISEZ-MOI.txt ]; v $? "un LISEZ-MOI explique le rejeu"
grep -q "soldes de trésorerie" /tmp/capture-$$/LISEZ-MOI.txt
v $? "il avertit que les soldes ne sont pas rejouables"
rm -rf /tmp/capture-$$

t "Le niveau 3 refuse sans confirmation tapée"
echo "n'importe quoi" | bash livraison/retour-base.sh restaurer 20260101-000000 > /tmp/n3.log 2>&1
[ "$?" != "0" ] && c=0 || c=1; v $c "il refuse un horodatage inexistant"
grep -qi "introuvable" /tmp/n3.log; v $? "et le dit clairement"

echo; echo "${GRAS}$(printf '─%.0s' $(seq 1 56))${ZERO}"
echo "  $r réussis, $e échoués"
echo "${GRAS}$(printf '─%.0s' $(seq 1 56))${ZERO}"
[ "$e" = 0 ]
