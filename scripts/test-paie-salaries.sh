#!/bin/bash
# Démarre le serveur sur la base de TEST, lance les tests, puis l'arrête.
set -u
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres@127.0.0.1:5433/triangle_paie}"
export JWT_SECRET="${JWT_SECRET:-test-secret-paie}"
export NODE_ENV=test EMAIL_PROVIDER=sandbox SMS_PROVIDER=sandbox
cd "$(dirname "$0")/.."
node server.js > /tmp/claude-0/-home-user-triangle-wms-backend/b8d8b3d8-0894-5b0a-b013-81323b4e6511/scratchpad/serveur-paie.log 2>&1 &
SERVEUR=$!
trap 'kill $SERVEUR 2>/dev/null' EXIT
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:5050/users" 2>/dev/null)
  [ "$code" = "401" ] && break
  sleep 0.5
done
[ "$code" != "401" ] && { echo "Le serveur n'a pas démarré"; exit 1; }
BASE_URL="http://127.0.0.1:5050" node scripts/test-paie-salaries.js
