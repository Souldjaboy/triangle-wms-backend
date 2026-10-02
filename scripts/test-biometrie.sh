#!/bin/bash
# Biométrie + passkeys : deux phases, le VRAI serveur relancé entre les deux.
#   1. avec BIOMETRIC_ENC_KEY : parcours complet (simulateurs de test) ;
#   2. sans clé : tout enregistrement biométrique doit être refusé.
set -u
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:triangle_test_password@127.0.0.1:5433/triangle_wms}"
export JWT_SECRET="${JWT_SECRET:-test-secret-durcissement}"
export PORT="${PORT:-5050}"
export NODE_ENV=test
export EMAIL_PROVIDER=sandbox
export SMS_PROVIDER=sandbox
export BIOMETRIC_ALLOW_MOCK=1
export WEBAUTHN_RP_ID=localhost
export WEBAUTHN_ORIGINS=http://localhost:3000
cd "$(dirname "$0")/.."

JOURNAL="${JOURNAL_SERVEUR:-${TMPDIR:-/tmp}/triangle-serveur-biometrie.log}"

lancer() {
  node server.js > "$JOURNAL" 2>&1 &
  SERVEUR=$!
  for i in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/locations" 2>/dev/null)
    [ "$code" = "401" ] && return 0
    sleep 0.5
  done
  echo "Le serveur n'a pas démarré :"; tail -20 "$JOURNAL"; kill $SERVEUR 2>/dev/null; exit 1
}

echo "═══ Phase 1 : avec BIOMETRIC_ENC_KEY"
export BIOMETRIC_ENC_KEY="$(openssl rand -hex 32)"
lancer
PHASE=avec_cle node scripts/test-biometrie.js
c1=$?
kill $SERVEUR 2>/dev/null; wait $SERVEUR 2>/dev/null

echo "═══ Phase 2 : sans BIOMETRIC_ENC_KEY"
unset BIOMETRIC_ENC_KEY BIOMETRIC_ENC_KEYS
lancer
PHASE=sans_cle node scripts/test-biometrie.js
c2=$?
kill $SERVEUR 2>/dev/null; wait $SERVEUR 2>/dev/null

exit $(( c1 || c2 ))
