#!/usr/bin/env bash
#
# SÉQUENCES DE MIGRATION 063 / 064 / 065.
#
# 064 a changé plusieurs fois pendant sa mise au point : rien ne prouve
# qu'une version antérieure n'a pas déjà été appliquée quelque part. 065 doit
# donc rattraper toutes les combinaisons plausibles, y compris une 063 rejouée
# après 064 — son upsert de modules réécrit la liste d'actions et ferait
# disparaître « archiver » et « réorganiser » sans le moindre message.
#
# Chaque séquence part d'une base NEUVE reconstruite depuis le squelette de
# référence, pour qu'aucune ne profite du travail de la précédente.
#
#   SOCLE=/chemin/schema-reference.sql PGURL_BASE=… ./test-migrations-064-065.sh
#
set -uo pipefail
cd "$(dirname "$0")/.."

SOCLE="${SOCLE:?indiquez SOCLE=<dump de schéma de référence>}"
HOTE="${PGHOST_SOCKET:?indiquez PGHOST_SOCKET=<répertoire de socket>}"
PORT="${PGPORT_TEST:-5475}"
ADMIN="postgresql://postgres@localhost/postgres?host=$HOTE&port=$PORT"

ok=0; ko=0
verifier() { if [ "$2" = "$3" ]; then ok=$((ok+1)); echo "      ✓ $1";
             else ko=$((ko+1)); echo "      ✗ $1 — attendu « $3 », obtenu « $2 »"; fi; }

# Le §0 de 061a : 061 en dépend, et la consolidation de données qu'il porte
# est une opération de production ponctuelle, hors sujet ici.
SCHEMA_061A=$(mktemp)
sed -n '/ALTER TABLE locations/,/;/p' sql/061a_prepare_physical_locations.sql | head -8 > "$SCHEMA_061A"

preparer() {
  local base="$1"
  psql "$ADMIN" -q -c "DROP DATABASE IF EXISTS $base" -c "CREATE DATABASE $base" >/dev/null 2>&1
  local url="postgresql://postgres@localhost/$base?host=$HOTE&port=$PORT"
  psql "$url" -q -f "$SOCLE" >/dev/null 2>&1
  # Deux entreprises et quelques comptes, dont un badge attribué par erreur.
  psql "$url" -q >/dev/null 2>&1 <<'SQL'
TRUNCATE user_permission_overrides, role_permissions, permission_audit_log CASCADE;
DELETE FROM users; DELETE FROM companies;
INSERT INTO companies (id,name) VALUES (1,'Triangle Logistics Transport & Intérim SARL'),(2,'FAT & MAT Entreprise');
UPDATE companies SET badge_prefix = NULL, badge_sequence = 0;
-- `password` est NOT NULL dans le schéma réel : on met une empreinte factice,
-- jamais un mot de passe utilisable.
INSERT INTO users (id,company_id,fullname,email,password,role,badge_code,is_super_admin) VALUES
 (1,1,'Super','s@t','$test$','super_admin','TRIANGLE-EMP-001',true),
 (2,1,'Amary','a@t','$test$','responsable_entrepot','TRIANGLE-EMP-011',false),
 (3,2,'Issa','i@f','$test$','employe',NULL,false),
 (4,2,'Jules','j@f','$test$','employe','TRIANGLE-EMP-022',false);
INSERT INTO user_permissions (user_id,module_key,can_view,can_create,can_edit,can_delete,can_validate)
VALUES (2,'stocks',true,true,true,false,true);
SQL
  echo "$url"
}

appliquer() {
  psql "$2" -q -v ON_ERROR_STOP=1 -v company_id=1 -v expected_balances=0 -v dry_run=0 -v expected_groups=0 \
    -f "sql/$1" >/dev/null 2>&1
  return $?
}

controler() {
  local url="$1" nom="$2"
  local actions prefixe1 prefixe2 seq perms badges idx
  actions=$(psql "$url" -tAc "SELECT CASE WHEN actions @> ARRAY['archive','reorganize','audit'] THEN 'oui' ELSE 'non' END
                                FROM permission_modules WHERE module_key='stock.emplacement'")
  prefixe1=$(psql "$url" -tAc "SELECT COALESCE(badge_prefix,'—') FROM companies WHERE id=1")
  prefixe2=$(psql "$url" -tAc "SELECT COALESCE(badge_prefix,'—') FROM companies WHERE id=2")
  seq=$(psql "$url" -tAc "SELECT badge_sequence FROM companies WHERE id=1")
  perms=$(psql "$url" -tAc "SELECT count(*) FROM user_permissions")
  badges=$(psql "$url" -tAc "SELECT string_agg(COALESCE(badge_code,'—'),',' ORDER BY id) FROM users")
  idx=$(psql "$url" -tAc "SELECT count(*) FROM pg_indexes WHERE indexname='users_badge_code_par_societe'")

  echo "    $nom"
  verifier "les trois actions sont portées"        "$actions"  "oui"
  verifier "préfixe Triangle conservé"             "$prefixe1" "TRIANGLE"
  verifier "préfixe FAT & MAT court"               "$prefixe2" "FATMAT"
  verifier "séquence au-dessus des badges existants" "$seq"    "11"
  verifier "aucune permission historique perdue"   "$perms"    "1"
  verifier "aucun badge modifié"                   "$badges"   "TRIANGLE-EMP-001,TRIANGLE-EMP-011,—,TRIANGLE-EMP-022"
  verifier "index d'unicité présent"               "$idx"      "1"
}

echo "SÉQUENCE 1 — 063 → 064 → 065"
U=$(preparer seq1); appliquer 063_permissions_avancees.sql "$U"
appliquer 064_emplacements_dates_documents.sql "$U"
appliquer 065_reaffirmation_catalogue_badges.sql "$U"
controler "$U" "état final"

echo "SÉQUENCE 2 — 063 → structure ancienne simulée → 065"
U=$(preparer seq2); appliquer 063_permissions_avancees.sql "$U"
# Une 064 antérieure : les colonnes de dates, mais ni badges ni actions.
psql "$U" -q >/dev/null 2>&1 <<'SQL'
ALTER TABLE documents ADD COLUMN IF NOT EXISTS operation_effective_at timestamptz;
SQL
appliquer 065_reaffirmation_catalogue_badges.sql "$U"
controler "$U" "065 rattrape l'absence de 064"

echo "SÉQUENCE 3 — 063 → 064 → 063 → 065"
U=$(preparer seq3); appliquer 063_permissions_avancees.sql "$U"
appliquer 064_emplacements_dates_documents.sql "$U"
appliquer 063_permissions_avancees.sql "$U"   # rejeu accidentel, écrase les actions
appliquer 065_reaffirmation_catalogue_badges.sql "$U"
controler "$U" "065 répare la 063 rejouée"

echo "SÉQUENCE 4 — 063 → 064 → 065 → 065"
U=$(preparer seq4); appliquer 063_permissions_avancees.sql "$U"
appliquer 064_emplacements_dates_documents.sql "$U"
appliquer 065_reaffirmation_catalogue_badges.sql "$U"
appliquer 065_reaffirmation_catalogue_badges.sql "$U"
controler "$U" "065 rejouée sans effet"

echo "SÉQUENCE 5 — 063 → 064 → 065 → 063 → 065"
U=$(preparer seq5); appliquer 063_permissions_avancees.sql "$U"
appliquer 064_emplacements_dates_documents.sql "$U"
appliquer 065_reaffirmation_catalogue_badges.sql "$U"
appliquer 063_permissions_avancees.sql "$U"
appliquer 065_reaffirmation_catalogue_badges.sql "$U"
controler "$U" "catalogue restauré après le second rejeu"

rm -f "$SCHEMA_061A"
echo
echo "$ok réussis, $ko échoués"
[ "$ko" -eq 0 ]
