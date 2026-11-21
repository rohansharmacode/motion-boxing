#!/usr/bin/env bash
# Start server in mock mode, seed via API, run test-api.sh, stop server.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3001}"
BASE="http://localhost:$PORT"
LOG="${TMPDIR:-/tmp}/motion-server-e2e.log"
[ -d "$HERE/../server" ] || { echo "server/ not found"; exit 2; }
[ -d "$HERE/node_modules" ] || (cd "$HERE" && npm install --silent)

cd "$HERE/../server" || exit 2
[ -d node_modules ] || npm install --silent
SCRIPT=dev; grep -q '"dev"' package.json || SCRIPT=start
SNOWFLAKE_MOCK=1 PORT="$PORT" npm run "$SCRIPT" >"$LOG" 2>&1 &
SERVER_PID=$!
cleanup() { pkill -P "$SERVER_PID" 2>/dev/null; kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "server died; log:"; cat "$LOG"; exit 1; }
  sleep 1
done
curl -sf "$BASE/api/health" >/dev/null || { echo "server not healthy after 60s; log: $LOG"; exit 1; }

cd "$HERE" || exit 2
RC=0
npx tsx src/seed.ts --api "$BASE" --players 5 || RC=1
bash ./test-api.sh "$BASE" || RC=1
exit $RC
