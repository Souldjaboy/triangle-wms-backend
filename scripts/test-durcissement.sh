#!/bin/bash
# Démarre le VRAI serveur sur la base de test, lance les tests, puis l'arrête.
# Aucune donnée de production n'est touchée : tout vit dans triangle_test.
set -u
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres@127.0.0.1:5433/triangle_test}"
export JWT_SECRET="${JWT_SECRET:-test-secret-durcissement}"
export PORT="${PORT:-5050}"
export NODE_ENV=test
export EMAIL_PROVIDER=sandbox
export SMS_PROVIDER=sandbox
cd "$(dirname "$0")/.."

node server.js > /tmp/claude-0/-home-user-triangle-wms-backend/b8d8b3d8-0894-5b0a-b013-81323b4e6511/scratchpad/serveur-test.log 2>&1 &
SERVEUR=$!
trap 'kill $SERVEUR 2>/dev/null' EXIT

for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/locations" 2>/dev/null)
  [ "$code" = "401" ] && break
  sleep 0.5
done
if [ "$code" != "401" ]; then
  echo "Le serveur n'a pas démarré :"; tail -20 /tmp/claude-0/-home-user-triangle-wms-backend/b8d8b3d8-0894-5b0a-b013-81323b4e6511/scratchpad/serveur-test.log; exit 1
fi

BASE_URL="http://127.0.0.1:$PORT" node scripts/test-durcissement.js
