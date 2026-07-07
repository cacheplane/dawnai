#!/usr/bin/env sh
# Unit test for files/reaper.sh using a stub kubectl on PATH.
# Exercises: mark (fresh unbound PVC gets a marker), reap (stale unbound PVC
# past TTL gets deleted), clear (bound PVC's marker is removed), and
# leave-alone (unbound PVC within TTL — none of the fixtures fall in this
# case with only "fresh"/"stale"... see the dedicated leave-alone assertion
# below using a second run with a within-TTL marker).
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$(mktemp -d)"
export PATH="$BIN:$PATH"
CALLS="$BIN/calls.log"
: > "$CALLS"

# stub kubectl: dispatch on args, echo canned data, log mutations
cat > "$BIN/kubectl" <<'STUB'
#!/usr/bin/env sh
echo "kubectl $*" >> "$CALLS"
case "$*" in
  *"get pods"*"jsonpath"*) cat "$FIX/pods.jsonpath" ;;
  *"get pvc"*"jsonpath"*) cat "$FIX/pvc.jsonpath" ;;
  *"annotate"*|*"delete"*) : ;;  # mutation: just logged
esac
STUB
chmod +x "$BIN/kubectl"
export CALLS FIX="$DIR/fixtures"

DAWN_SANDBOX_NS=ns DAWN_REAPER_TTL_SECONDS=3600 sh "$DIR/../files/reaper.sh"

# (a) fresh unbound PVC (no marker) gets annotated with a marker
grep -q "annotate --overwrite pvc dawn-sbx-vol-fresh-unbound dawn.sh/unbound-since=" "$CALLS" \
  || { echo "FAIL: mark (fresh unbound PVC should be annotated)"; cat "$CALLS"; exit 1; }
echo "ok: mark"

# (b) stale unbound PVC (marker far in the past, > TTL) gets deleted
grep -q "delete pvc dawn-sbx-vol-stale-unbound" "$CALLS" \
  || { echo "FAIL: reap (stale unbound PVC should be deleted)"; cat "$CALLS"; exit 1; }
echo "ok: reap"

# (c) bound PVC (referenced by a pod) has its marker cleared
grep -q "annotate pvc dawn-sbx-vol-bound dawn.sh/unbound-since-" "$CALLS" \
  || { echo "FAIL: clear (bound PVC's marker should be removed)"; cat "$CALLS"; exit 1; }
echo "ok: clear"

# (d) the fresh-unbound PVC must NOT be deleted (it was only just marked, not reaped in the same run)
if grep -q "delete pvc dawn-sbx-vol-fresh-unbound" "$CALLS"; then
  echo "FAIL: leave-alone (freshly-marked PVC should not be deleted in the same run)"
  cat "$CALLS"
  exit 1
fi
echo "ok: leave-alone (fresh mark not deleted same-run)"

# --- second run: an unbound PVC marked recently (within TTL) must be left alone ---
: > "$CALLS"

WITHIN_DIR="$(mktemp -d)"
NOW_EPOCH="$(date -u +%s)"
WITHIN_SINCE=$((NOW_EPOCH - 60)) # marked 60s ago, well within the 3600s TTL
printf 'dawn-sbx-vol-bound\n' > "$WITHIN_DIR/pods.jsonpath"
printf 'dawn-sbx-vol-within-ttl %s\n' "$WITHIN_SINCE" > "$WITHIN_DIR/pvc.jsonpath"
FIX="$WITHIN_DIR" DAWN_SANDBOX_NS=ns DAWN_REAPER_TTL_SECONDS=3600 sh "$DIR/../files/reaper.sh"

if grep -q "delete pvc dawn-sbx-vol-within-ttl" "$CALLS"; then
  echo "FAIL: leave-alone (unbound PVC within TTL should not be deleted)"
  cat "$CALLS"
  exit 1
fi
if grep -q "annotate --overwrite pvc dawn-sbx-vol-within-ttl" "$CALLS"; then
  echo "FAIL: leave-alone (already-marked within-TTL PVC should not be re-marked)"
  cat "$CALLS"
  exit 1
fi
echo "ok: leave-alone (within-TTL unbound PVC untouched)"

echo "reaper test passed"
