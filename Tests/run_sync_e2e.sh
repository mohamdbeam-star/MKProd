#!/bin/zsh
# Runs a two-teammate sync scenario against the real Worker (web/) on a throwaway local D1.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=8799
cleanup() {
  pkill -f "wrangler dev --port $PORT" 2>/dev/null || true
  pkill -f "smtp_sink.mjs $((PORT + 1))" 2>/dev/null || true
  pkill -f "entry=127.0.0.1:$PORT" 2>/dev/null || true
  [[ -n ${WORK:-} && -z ${KEEP:-} ]] && rm -rf "$WORK"
  # Sessions/keys left by an earlier (differently signed) test binary would trigger a Keychain prompt.
  for who in alice bob; do
    while security delete-generic-password -s "com.mkoussa.mkprod.cloud.$who" >/dev/null 2>&1; do :; done
    defaults delete "com.mkoussa.mkprod.$who" >/dev/null 2>&1 || true
  done
  return 0
}
cleanup; WORK=$(mktemp -d)
trap cleanup EXIT

xcodebuild -version >/dev/null 2>&1 || export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
SRC=(Sources/MKProd/*.swift)
SRC=(${SRC:#*/App.swift})
swiftc -parse-as-library -O -o "$WORK/SyncE2E" "${SRC[@]}" Tests/SyncE2E.swift 2>&1 | grep -E "error" || true
[[ -x "$WORK/SyncE2E" ]] || { echo "build failed"; exit 1; }

(cd web && [[ -d dist ]] || npx vite build >/dev/null)
(cd web && npx wrangler d1 migrations apply mkprod --local --persist-to "$WORK/d1" >/dev/null)
# Emails go to a local SMTP sink that saves each message under $WORK/mail.
node Tests/smtp_sink.mjs $((PORT + 1)) "$WORK/mail" &
(cd web && exec npx wrangler dev --port $PORT --ip 127.0.0.1 --persist-to "$WORK/d1" \
  --var SMTP_HOST:127.0.0.1 --var SMTP_PORT:$((PORT + 1)) --var SMTP_FROM:noreply@mkprod.test >"$WORK/wrangler.log" 2>&1) &
for i in {1..60}; do curl -sf http://127.0.0.1:$PORT/api/health >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:$PORT/api/health >/dev/null || { echo "wrangler dev did not start:"; tail -20 "$WORK/wrangler.log"; exit 1; }
URL=http://127.0.0.1:$PORT
mkdir -p "$WORK/share"
for step in alice-setup bob-join alice-share bob-joined alice-edit bob-check alice-check bob-viewer alice-final bob-concurrent alice-merge bob-merge \
            alice-finance bob-approve alice-fulfil bob-prefs alice-notify bob-recover alice-reset-bob bob-after-reset alice-reshare bob-rekeyed alice-remove-bob bob-removed; do
  who=${step%%-*}
  echo "▶ $step"
  E2E_SHARE="$WORK/share" MKPROD_HOME="$WORK/$who" "$WORK/SyncE2E" $step $URL
done

echo "▶ server holds only ciphertext"
q() { (cd web && npx wrangler d1 execute mkprod --local --persist-to "$WORK/d1" --json --command "$1" 2>/dev/null) | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["results"][0]["n"])'; }
plain=$(q "SELECT COUNT(*) n FROM records WHERE deleted = 0 AND (json_extract(data, '\$.enc') IS NULL OR json_type(data, '\$.enc') != 'text')")
total=$(q "SELECT COUNT(*) n FROM records WHERE deleted = 0")
oldv=$(q "SELECT COUNT(*) n FROM records WHERE deleted = 0 AND json_extract(data, '\$.v') != 2")
[[ $plain == 0 && $total -gt 20 ]] && echo "  ✓ all $total live records are encrypted" || { echo "  ✗ $plain of $total records readable"; exit 1; }
[[ $oldv == 0 ]] && echo "  ✓ every record re-encrypted with key v2 after the removal" || { echo "  ✗ $oldv records still on the old key"; exit 1; }
leak=$(q "SELECT COUNT(*) n FROM records WHERE data LIKE '%Created by Alice%' OR data LIKE '%Redesign onboarding%'")
[[ $leak == 0 ]] && echo "  ✓ task titles don't appear anywhere in the database" || { echo "  ✗ plaintext found"; exit 1; }
echo "▶ email notifications"
mails() { python3 Tests/mail_check.py "$WORK/mail" "$@"; }
expect() { local n=$1; shift; local got=$(mails "${@:2}"); [[ $got == $n ]] && echo "  ✓ $1" || { echo "  ✗ $1 (expected $n, got $got)"; ls "$WORK/mail"; exit 1; }; }
expect 1 "Bob was emailed when Alice assigned him a task" bob@example.test "You were assigned: Created by Alice"
expect 1 "Alice was emailed when Bob @mentioned her" alice@example.test "Bob mentioned you on"
expect 1 "Bob was emailed to approve the order" bob@example.test "Approval needed: #"
expect 1 "Alice was emailed when her order was approved" alice@example.test "is now Approved"
expect 1 "Bob got the test email" bob@example.test "Test email from MK Prod"
expect 0 "no assignment email after Bob turned them off" bob@example.test "A task was assigned to you"
expect 0 "Bob's emails carry no details once he hid them" bob@example.test "Muted assignment"
expect 1 "Bob was emailed (without details) when his task was updated" bob@example.test "A task you follow was updated"
expect 1 "contract reminder reached Bob once, despite repeated checks" bob@example.test "A contract for your entity is ending soon"
expect 1 "Alice got the detailed contract reminder" alice@example.test "Contract ending in 10 days: Hosting renewal" "Acme Cloud"
expect 0 "nobody is emailed about their own edits" alice@example.test "Updated: Muted assignment"
echo "All sync scenarios passed."
