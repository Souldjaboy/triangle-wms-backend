#!/usr/bin/env bash
#
# RECTIFICATION DE SIX BONS — TRIANGLE WMS, company_id = 1
#
# Sauvegarde, instantané ciblé, correction transactionnelle, contrôles, puis
# redémarrage des seuls processus Triangle.
#
# La correction elle-même vit dans sql/corrections/2026-08-rectification-six-bons.sql
# et tient dans UNE transaction : toute incohérence annule l'ensemble. Ce
# pilote ajoute ce que le SQL ne peut pas faire — la sauvegarde physique, et la
# comparaison de l'état complet des stocks avant et après, qui prouve que six
# produits exactement ont changé.
#
# Ne touche ni MaliLink ni Hafiya : les chemins sont vérifiés par leur remote
# Git, et aucun processus PM2 hors Triangle n'est redémarré.
#
#   ./rectifier-six-bons.sh              # contrôle seul, aucune écriture
#   ./rectifier-six-bons.sh --executer   # correction et redémarrage
#
set -Eeuo pipefail

readonly RACINE_BACKEND="/var/www/triangle-wms/backend"
readonly RACINE_FRONTEND="/var/www/triangle-wms/frontend"
readonly PM2_BACKEND="triangle-backend"
readonly PM2_FRONTEND="triangle-frontend"
readonly SOCIETE=1
readonly DOSSIER_SAUVEGARDE="${BACKUP_DIR:-/var/backups/triangle}"
readonly HORODATAGE="$(date +%Y%m%d-%H%M%S)"

EXECUTER=0
if [ "${1:-}" = "--executer" ]; then EXECUTER=1; fi

titre()  { printf '\n\033[1m══ %s\033[0m\n' "$1"; }
info()   { printf '   %s\n' "$1"; }
ok()     { printf '   \033[32m✓\033[0m %s\n' "$1"; }
alerte() { printf '   \033[33m!\033[0m %s\n' "$1"; }
stop()   { printf '\n\033[31mARRÊT : %s\033[0m\n\n' "$1" >&2; exit 1; }

trap 'stop "commande en échec ligne $LINENO. La transaction SQL, si elle était en cours, a été annulée par PostgreSQL."' ERR

# ═══════════════════════════════════════════════════════════════════════════
titre "1. PÉRIMÈTRE — TRIANGLE UNIQUEMENT"
# ═══════════════════════════════════════════════════════════════════════════

[ -d "$RACINE_BACKEND/.git" ] || stop "$RACINE_BACKEND n'est pas un dépôt Git."
REMOTE="$(git -C "$RACINE_BACKEND" remote get-url origin 2>/dev/null || echo '')"
info "backend  : $RACINE_BACKEND"
info "  remote : $REMOTE"
case "$REMOTE" in
  *malilink*|*hafiya*) stop "ce dépôt n'est pas Triangle ($REMOTE)." ;;
  *triangle*) ok "dépôt Triangle confirmé" ;;
  *) stop "remote inattendu : « $REMOTE ». Vérifiez avant de continuer." ;;
esac

[ -f "$RACINE_BACKEND/.env" ] || stop "$RACINE_BACKEND/.env absent."
set -a; . "$RACINE_BACKEND/.env"; set +a
[ -n "${DATABASE_URL:-}" ] || stop "DATABASE_URL absent."

q() { psql "$DATABASE_URL" -tAX -c "$1"; }

NOM_SOCIETE="$(q "SELECT name FROM companies WHERE id = $SOCIETE")"
[ -n "$NOM_SOCIETE" ] || stop "aucune société d'identifiant $SOCIETE dans cette base."
info "société $SOCIETE : $NOM_SOCIETE"
case "$NOM_SOCIETE" in
  *[Tt]riangle*) ok "base Triangle confirmée" ;;
  *) stop "la société $SOCIETE se nomme « $NOM_SOCIETE ». Ce n'est pas Triangle — refus d'écrire." ;;
esac

# ═══════════════════════════════════════════════════════════════════════════
titre "2. ÉTAT AVANT CORRECTION"
# ═══════════════════════════════════════════════════════════════════════════

STOCK_GLOBAL_AVANT="$(q "SELECT COALESCE(sum(stock),0) FROM products WHERE company_id = $SOCIETE")"
NB_PRODUITS="$(q "SELECT count(*) FROM products WHERE company_id = $SOCIETE")"
info "produits    : $NB_PRODUITS"
info "stock global: $STOCK_GLOBAL_AVANT"

echo
psql "$DATABASE_URL" -c "
SELECT d.document_number AS bon, d.document_type AS type_doc,
       m.id AS mvt, m.type AS sens, m.quantity AS qte,
       m.stock_before AS avant, m.stock_after AS apres,
       p.reference, p.stock AS stock_produit,
       COALESCE(p.location_managed,false) AS par_emplacement,
       COALESCE(m.location_code,'—') AS emplacement
  FROM documents d
  LEFT JOIN stock_movements m ON m.id = d.stock_movement_id
  LEFT JOIN products p ON p.company_id = $SOCIETE
       AND upper(trim(p.reference)) = upper(trim(m.product_reference))
 WHERE d.company_id = $SOCIETE
   AND d.document_number IN ('BR-260814-057','BR-260814-035','BR-260803-001',
                             'BR-260814-059','BR-260803-002','BR-260814-049')
 ORDER BY d.document_number;"

TROUVES="$(q "SELECT count(*) FROM documents WHERE company_id = $SOCIETE
   AND document_number IN ('BR-260814-057','BR-260814-035','BR-260803-001',
                           'BR-260814-059','BR-260803-002','BR-260814-049')")"
info "documents trouvés : $TROUVES / 6"
[ "$TROUVES" = "6" ] || stop "seuls $TROUVES des 6 bons existent. La correction exige les six — aucune écriture."

# ═══════════════════════════════════════════════════════════════════════════
titre "3. SAUVEGARDE"
# ═══════════════════════════════════════════════════════════════════════════

DUMP="$DOSSIER_SAUVEGARDE/triangle-avant-rectification-$HORODATAGE.dump"
INSTANTANE="$DOSSIER_SAUVEGARDE/triangle-instantane-six-bons-$HORODATAGE.sql"
AVANT_CSV="$DOSSIER_SAUVEGARDE/triangle-stocks-avant-$HORODATAGE.csv"

if [ "$EXECUTER" -eq 1 ]; then
  mkdir -p "$DOSSIER_SAUVEGARDE"
  pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$DATABASE_URL"
  [ -s "$DUMP" ] || stop "le dump est vide."
  TAILLE="$(wc -c < "$DUMP" | tr -d ' ')"
  [ "$TAILLE" -ge 51200 ] || stop "dump suspect : $TAILLE octets."
  pg_restore --list "$DUMP" > /dev/null 2>&1 || stop "dump illisible par pg_restore."
  ok "dump : $DUMP ($TAILLE octets, table des matières lisible)"

  # Instantané lisible des seuls enregistrements concernés, pour pouvoir
  # revenir en arrière sans restaurer toute la base.
  {
    echo "-- Instantané avant rectification — $HORODATAGE"
    echo "-- Restauration ciblée : rejouer ces UPDATE remet les six enregistrements dans leur état d'origine."
    psql "$DATABASE_URL" -tAX -c "
      SELECT format('UPDATE stock_movements SET type=%L, quantity=%s, stock_before=%s, stock_after=%s WHERE id=%s;',
                    m.type, m.quantity, COALESCE(m.stock_before::text,'NULL'), COALESCE(m.stock_after::text,'NULL'), m.id)
        FROM documents d JOIN stock_movements m ON m.id = d.stock_movement_id
       WHERE d.company_id = $SOCIETE AND d.document_number IN
             ('BR-260814-057','BR-260814-035','BR-260803-001','BR-260814-059','BR-260803-002','BR-260814-049');"
    psql "$DATABASE_URL" -tAX -c "
      SELECT format('UPDATE documents SET document_type=%L, total_amount=%s WHERE id=%s;',
                    d.document_type, COALESCE(d.total_amount::text,'NULL'), d.id)
        FROM documents d WHERE d.company_id = $SOCIETE AND d.document_number IN
             ('BR-260814-057','BR-260814-035','BR-260803-001','BR-260814-059','BR-260803-002','BR-260814-049');"
    psql "$DATABASE_URL" -tAX -c "
      SELECT format('UPDATE document_items SET quantity=%s, total_price=%s WHERE id=%s;',
                    di.quantity, COALESCE(di.total_price::text,'NULL'), di.id)
        FROM document_items di JOIN documents d ON d.id = di.document_id
       WHERE d.company_id = $SOCIETE AND d.document_number IN
             ('BR-260814-057','BR-260814-035','BR-260803-001','BR-260814-059','BR-260803-002','BR-260814-049');"
    psql "$DATABASE_URL" -tAX -c "
      SELECT format('UPDATE products SET stock=%s WHERE id=%s;', p.stock, p.id)
        FROM products p WHERE p.company_id = $SOCIETE AND upper(trim(p.reference)) IN
             ('IMP-CHAISE-DE-VESTIAIRE','IMP-CONTROLEUR-VOLUME-DE-VENTILO','IMP-ACCESSOIRE-D-ECRAN',
              'IMP-UNDERCOUNTER-BASIN-BC-8322','IMP-ACCESOIRE-POUR-CONTROLEUR-VOLUME','IMP-TOURNIQUET-D-ENTREE');"
    psql "$DATABASE_URL" -tAX -c "
      SELECT format('UPDATE stock_location_balances SET quantity=%s WHERE id=%s;', b.quantity, b.id)
        FROM stock_location_balances b JOIN products p ON p.id = b.product_id
       WHERE b.company_id = $SOCIETE AND upper(trim(p.reference)) IN
             ('IMP-CHAISE-DE-VESTIAIRE','IMP-CONTROLEUR-VOLUME-DE-VENTILO','IMP-ACCESSOIRE-D-ECRAN',
              'IMP-UNDERCOUNTER-BASIN-BC-8322','IMP-ACCESOIRE-POUR-CONTROLEUR-VOLUME','IMP-TOURNIQUET-D-ENTREE');"
  } > "$INSTANTANE"
  ok "instantané ciblé : $INSTANTANE ($(wc -l < "$INSTANTANE" | tr -d ' ') lignes)"

  # État complet des stocks, pour prouver ensuite qu'aucun autre produit n'a bougé.
  psql "$DATABASE_URL" -tAX -F',' -c \
    "SELECT id, stock FROM products WHERE company_id = $SOCIETE ORDER BY id" > "$AVANT_CSV"
  ok "photo des $(wc -l < "$AVANT_CSV" | tr -d ' ') stocks : $AVANT_CSV"
else
  info "(contrôle) pg_dump vers $DUMP"
  info "(contrôle) instantané vers $INSTANTANE"
fi

# ═══════════════════════════════════════════════════════════════════════════
titre "4. CORRECTION TRANSACTIONNELLE"
# ═══════════════════════════════════════════════════════════════════════════

SQL="$RACINE_BACKEND/sql/corrections/2026-08-rectification-six-bons.sql"
[ -f "$SQL" ] || stop "$SQL introuvable."

if [ "$EXECUTER" -eq 1 ]; then
  # ON_ERROR_STOP + BEGIN/COMMIT dans le fichier : toute exception annule tout.
  if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SQL"; then
    ok "transaction validée"
  else
    stop "la correction a échoué. PostgreSQL a tout annulé : la base est dans son état d'avant. Dump disponible : $DUMP"
  fi
else
  info "(contrôle) psql -v ON_ERROR_STOP=1 -f $SQL"
fi

# ═══════════════════════════════════════════════════════════════════════════
titre "5. CONTRÔLES APRÈS CORRECTION"
# ═══════════════════════════════════════════════════════════════════════════

ECHECS=0
verifier() {
  if [ "$2" = "$3" ]; then ok "$1 : $3"
  else alerte "$1 : $2 au lieu de $3"; ECHECS=$((ECHECS+1)); fi
}

if [ "$EXECUTER" -eq 1 ]; then
  stock_de() { q "SELECT stock FROM products WHERE company_id = $SOCIETE AND upper(trim(reference)) = upper('$1')"; }

  verifier "CHAISE DE VESTIAIRE"               "$(stock_de IMP-CHAISE-DE-VESTIAIRE)"             "10"
  verifier "CONTROLEUR VOLUME DE VENTILO"      "$(stock_de IMP-CONTROLEUR-VOLUME-DE-VENTILO)"    "220"
  verifier "ACCESSOIRE D'ECRAN"                "$(stock_de IMP-ACCESSOIRE-D-ECRAN)"              "0"
  verifier "UNDERCOUNTER BASIN/BC-8322"        "$(stock_de IMP-UNDERCOUNTER-BASIN-BC-8322)"      "312"
  verifier "ACCESSOIRE POUR CONTROLEUR VOLUME" "$(stock_de IMP-ACCESOIRE-POUR-CONTROLEUR-VOLUME)" "200"
  verifier "TOURNIQUET D'ENTREE"               "$(stock_de IMP-TOURNIQUET-D-ENTREE)"             "117"

  verifier "BR-260803-001 devenu bon de sortie" \
    "$(q "SELECT count(*) FROM documents d JOIN stock_movements m ON m.id = d.stock_movement_id
           WHERE d.document_number='BR-260803-001' AND d.company_id=$SOCIETE
             AND d.document_type='Bon de sortie' AND m.type='Sortie' AND m.quantity=2")" "1"

  verifier "produits à stock négatif" \
    "$(q "SELECT count(*) FROM products WHERE company_id=$SOCIETE AND stock < 0")" "0"
  verifier "balances négatives" \
    "$(q "SELECT count(*) FROM stock_location_balances WHERE company_id=$SOCIETE AND quantity < 0")" "0"
  verifier "réservations actives orphelines" \
    "$(q "SELECT count(*) FROM stock_reservations sr WHERE sr.company_id=$SOCIETE AND sr.status='ACTIVE'
            AND NOT EXISTS (SELECT 1 FROM stock_location_balances b WHERE b.company_id=$SOCIETE
                             AND b.product_id=sr.product_id AND b.location_id=sr.location_id)")" "0"
  verifier "écarts stock/balances (produits localisés)" \
    "$(q "SELECT count(*) FROM products p
            LEFT JOIN (SELECT product_id, sum(quantity) AS t FROM stock_location_balances
                        WHERE company_id=$SOCIETE GROUP BY product_id) b ON b.product_id=p.id
           WHERE p.company_id=$SOCIETE AND COALESCE(p.location_managed,false)
             AND COALESCE(b.t,0) <> COALESCE(p.stock,0)")" "0"

  # ── Aucun autre produit modifié : comparaison de l'état complet ──
  APRES_CSV="$DOSSIER_SAUVEGARDE/triangle-stocks-apres-$HORODATAGE.csv"
  psql "$DATABASE_URL" -tAX -F',' -c \
    "SELECT id, stock FROM products WHERE company_id = $SOCIETE ORDER BY id" > "$APRES_CSV"
  # On n'attend PAS six changements : deux des six produits sont déjà au bon
  # stock (leur bon portait une quantité fausse sans que le stock le soit).
  # Ce qui compte est qu'aucun produit HORS des six ne bouge.
  ATTENDUS="$(q "SELECT string_agg(p.id::text, ' ' ORDER BY p.id) FROM products p
                  WHERE p.company_id = $SOCIETE AND upper(trim(p.reference)) IN
                        ('IMP-CHAISE-DE-VESTIAIRE','IMP-CONTROLEUR-VOLUME-DE-VENTILO',
                         'IMP-ACCESSOIRE-D-ECRAN','IMP-UNDERCOUNTER-BASIN-BC-8322',
                         'IMP-ACCESOIRE-POUR-CONTROLEUR-VOLUME','IMP-TOURNIQUET-D-ENTREE')")"
  CHANGES="$(diff <(sort "$AVANT_CSV") <(sort "$APRES_CSV") | grep '^>' | sed 's/^> //' | cut -d, -f1 | sort -n | tr '\n' ' ' || true)"
  info "produits dont le stock a changé : ${CHANGES:-aucun}"
  info "périmètre autorisé              : $ATTENDUS"

  HORS_PERIMETRE=""
  for id in $CHANGES; do
    case " $ATTENDUS " in
      *" $id "*) ;;
      *) HORS_PERIMETRE="$HORS_PERIMETRE $id" ;;
    esac
  done
  verifier "produits modifiés hors des six" "${HORS_PERIMETRE:-aucun}" "aucun"
  if [ -n "$HORS_PERIMETRE" ]; then
    alerte "détail des écarts :"
    diff <(sort "$AVANT_CSV") <(sort "$APRES_CSV") | head -20 | sed 's/^/       /'
  fi

  # ── Stock global, expliqué ──
  STOCK_GLOBAL_APRES="$(q "SELECT COALESCE(sum(stock),0) FROM products WHERE company_id = $SOCIETE")"
  echo
  # L'écart se calcule en SQL : un stock NUMERIC à décimales ferait échouer
  # l'arithmétique entière de bash.
  VARIATION="$(q "SELECT ($STOCK_GLOBAL_APRES::numeric) - ($STOCK_GLOBAL_AVANT::numeric)")"
  info "stock global : $STOCK_GLOBAL_AVANT → $STOCK_GLOBAL_APRES  (variation : $VARIATION)"

  echo
  psql "$DATABASE_URL" -c "
  SELECT d.document_number AS bon, d.document_type AS type_doc,
         m.type AS sens, m.quantity AS qte,
         m.stock_before || ' → ' || m.stock_after AS mouvement,
         p.stock AS stock_final,
         COALESCE((SELECT sum(b.quantity) FROM stock_location_balances b
                    WHERE b.company_id=$SOCIETE AND b.product_id=p.id)::text,'—') AS somme_balances
    FROM documents d
    JOIN stock_movements m ON m.id = d.stock_movement_id
    JOIN products p ON p.company_id=$SOCIETE AND upper(trim(p.reference))=upper(trim(m.product_reference))
   WHERE d.company_id = $SOCIETE
     AND d.document_number IN ('BR-260814-057','BR-260814-035','BR-260803-001',
                               'BR-260814-059','BR-260803-002','BR-260814-049')
   ORDER BY d.document_number;"
fi

# ═══════════════════════════════════════════════════════════════════════════
titre "6. REDÉMARRAGE TRIANGLE"
# ═══════════════════════════════════════════════════════════════════════════

# La correction ne touche que des données : le code n'a pas changé et un
# redémarrage n'est pas nécessaire au bon affichage. Il est fait parce qu'il
# est demandé, et il est sans effet de bord.
if [ "$EXECUTER" -eq 1 ] && [ "$ECHECS" -eq 0 ]; then
  command -v pm2 >/dev/null || stop "pm2 introuvable."
  for nom in "$PM2_BACKEND" "$PM2_FRONTEND"; do
    case "$nom" in
      *malilink*|*hafiya*) stop "refus de redémarrer $nom." ;;
    esac
    pm2 restart "$nom" --update-env
    ok "$nom redémarré"
  done
  sleep 5
  pm2 save
  ok "pm2 save effectué"
  echo
  info "Processus PM2 après opération :"
  pm2 status
elif [ "$ECHECS" -gt 0 ]; then
  alerte "$ECHECS contrôle(s) en échec : aucun redémarrage, aucun pm2 save."
fi

# ═══════════════════════════════════════════════════════════════════════════
titre "7. CONCLUSION"
# ═══════════════════════════════════════════════════════════════════════════

if [ "$EXECUTER" -ne 1 ]; then
  info "CONTRÔLE TERMINÉ — aucune écriture."
  info "Relancez avec --executer pour appliquer."
  exit 0
fi

if [ "$ECHECS" -gt 0 ]; then
  echo
  alerte "RETOUR ARRIÈRE — deux voies, de la plus fine à la plus lourde :"
  echo "     1. ciblée   : psql \"\$DATABASE_URL\" -v ON_ERROR_STOP=1 -f $INSTANTANE"
  echo "     2. complète : pg_restore --clean --if-exists --no-owner -d \"\$DATABASE_URL\" $DUMP"
  echo "        (la restauration complète ANNULE toute écriture faite depuis $HORODATAGE)"
  exit 1
fi

ok "RECTIFICATION TERMINÉE"
info "sauvegarde   : $DUMP"
info "instantané   : $INSTANTANE"
info "stock global : $STOCK_GLOBAL_AVANT → ${STOCK_GLOBAL_APRES:-?}"
echo
