#!/bin/bash
# Tests for systemd/iap-tunnel-run using a fake gcloud. Run: make test
set -u
here=$(cd "$(dirname "$0")" && pwd)
run="$here/../iap-tunnels@alexheidl.github.io/systemd/iap-tunnel-run"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Fake gcloud. Behaviour is controlled by files in $FAKE_DIR:
#   token-expired   -> print-access-token fails with a reauth error
#   token-offline   -> print-access-token fails with a network error
#   tunnel-reauth   -> the tunnel logs a reauth error after 1s but keeps running
cat > "$tmp/gcloud" <<'EOF'
#!/bin/bash
if [ "$1 $2" = "auth print-access-token" ]; then
    [ -e "$FAKE_DIR/token-expired" ] && { echo "ERROR: Reauthentication failed. cannot prompt during non-interactive execution." >&2; exit 1; }
    [ -e "$FAKE_DIR/token-offline" ] && { echo "ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: Unable to find the server at oauth2.googleapis.com" >&2; exit 1; }
    echo token; exit 0
fi
echo "$*" > "$FAKE_DIR/args"
echo "Listening on port [$5]." >&2
trap 'exit 0' TERM
if [ -e "$FAKE_DIR/tunnel-reauth" ]; then
    sleep 1
    echo "googlecloudsdk.core.credentials.exceptions.TokenRefreshError: There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution." >&2
fi
while :; do sleep 0.2; done
EOF
chmod +x "$tmp/gcloud"

export FAKE_DIR=$tmp GCLOUD=$tmp/gcloud AUTH_CHECK_INTERVAL=1
export INSTANCE=vm REMOTE_PORT=22 LOCAL_PORT=2222 ZONE=z-1 PROJECT=p EXTRA_ARGS="--verbosity=info"

failures=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi; }
reset() { rm -f "$tmp"/token-* "$tmp"/tunnel-* "$tmp/args"; }

# 1. Healthy tunnel, stopped with SIGTERM (systemctl stop) -> exit 0
reset
"$run" 2> "$tmp/log" & p=$!
sleep 2.5
kill -TERM $p; wait $p; rc=$?
check "healthy tunnel stops cleanly (rc=$rc)" '[ $rc -eq 0 ]'
check "gcloud gets the right arguments" 'grep -q -- "compute start-iap-tunnel vm 22 --local-host-port=localhost:2222 --zone=z-1 --project=p --verbosity=info" "$tmp/args"'
check "no gcloud left running" '! pgrep -f "$tmp/gcloud compute" > /dev/null'

# 2. Sign-in already expired -> exit 75 without starting the tunnel
reset; touch "$tmp/token-expired"
"$run" 2> "$tmp/log"; rc=$?
check "expired at start exits 75 (rc=$rc)" '[ $rc -eq 75 ]'
check "tunnel not started" '[ ! -e "$tmp/args" ]'

# 3. gcloud keeps running but logs reauth errors -> exit 75 quickly
reset; touch "$tmp/tunnel-reauth"
start=$(date +%s)
timeout 20 "$run" 2> "$tmp/log"; rc=$?
took=$(( $(date +%s) - start ))
check "reauth error while running exits 75 (rc=$rc)" '[ $rc -eq 75 ]'
check "detected within 5s (took ${took}s)" '[ $took -le 5 ]'
check "gcloud output still reaches the journal" 'grep -q "Listening on port" "$tmp/log"'
check "no gcloud left running" '! pgrep -f "$tmp/gcloud compute" > /dev/null'

# 4. Token expires later (periodic check) -> exit 75
reset
( sleep 1.5; touch "$tmp/token-expired" ) &
timeout 20 "$run" 2> "$tmp/log"; rc=$?
check "periodic sign-in check exits 75 (rc=$rc)" '[ $rc -eq 75 ]'

# 5. Offline token check must NOT be reported as an expired sign-in
reset
( sleep 1.5; touch "$tmp/token-offline" ) &
"$run" 2> "$tmp/log" & p=$!
sleep 4
check "offline check keeps the tunnel running" 'kill -0 $p 2> /dev/null'
kill -TERM $p; wait $p

# 6. Missing config -> exit 64
reset
( unset ZONE; "$run" 2> /dev/null ); rc=$?
check "missing setting exits 64 (rc=$rc)" '[ $rc -eq 64 ]'

echo
[ $failures -eq 0 ] && echo "all passed" || echo "$failures failed"
exit $failures
