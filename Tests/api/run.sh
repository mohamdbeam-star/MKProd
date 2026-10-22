#!/usr/bin/env bash
# API smoke tests against the real Worker on a throwaway local D1 + R2, with a local SMTP sink.
# Works on any machine with Node 20+ (no macOS needed). ~1 minute.
set -euo pipefail
cd "$(dirname "$0")/../.."
PORT=${PORT:-8799}
WORK=$(mktemp -d)
CREATED_SCHEMA=0
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$WORK"; [ "$CREATED_SCHEMA" = 1 ] && rm -f web/migrations/0001_init.sql' EXIT

(cd web && [ -d node_modules ] || npm ci --silent)
# Until the original migrations are committed, use the reconstructed schema (removed again on exit).
if [ ! -f web/migrations/0001_init.sql ]; then cp Tests/api/schema_reconstructed.sql web/migrations/0001_init.sql; CREATED_SCHEMA=1; fi
(cd web && CI=1 npx wrangler d1 migrations apply mkprod --local --persist-to "$WORK/d1" >/dev/null)
node Tests/smtp_sink.mjs $((PORT + 1)) "$WORK/mail" >"$WORK/sink.log" 2>&1 &
(cd web && exec env CI=1 npx wrangler dev --port "$PORT" --ip 127.0.0.1 --persist-to "$WORK/d1" \
  --var SMTP_HOST:127.0.0.1 --var SMTP_PORT:$((PORT + 1)) --var SMTP_USER: --var SMTP_FROM:noreply@mkprod.test >"$WORK/wrangler.log" 2>&1) &
# A leftover server on the port would answer with the wrong database and fail everything.
if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then echo "Port $PORT is already in use (stale wrangler dev?). Stop it or set PORT=…"; exit 1; fi
for _ in $(seq 1 90); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null || { echo "Worker did not start:"; tail -20 "$WORK/wrangler.log"; exit 1; }

status=0
echo "== core sync API"; node Tests/api/core.mjs "$WORK/mail" || status=1
echo "== trust & compliance"; node Tests/api/trust_and_compliance.mjs "$WORK/mail" || status=1
if grep -q "ERROR" "$WORK/wrangler.log"; then echo "== Worker logged errors:"; grep -A3 "ERROR" "$WORK/wrangler.log" | head -30; status=1; fi
exit $status
