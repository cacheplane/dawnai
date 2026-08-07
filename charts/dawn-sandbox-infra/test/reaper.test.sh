#!/usr/bin/env sh
# Unit test for files/reaper.sh using a stateful kubectl stub.
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
BIN="$TMP/bin"
FIX="$TMP/fixtures"
CALLS="$TMP/calls.log"
FAILURES=0
mkdir -p "$BIN" "$FIX/annotations" "$FIX/not-found" "$FIX/api-errors"
trap 'rm -rf "$TMP"' 0
export PATH="$BIN:$PATH" CALLS FIX

cat > "$BIN/kubectl" <<'STUB'
#!/usr/bin/env sh
set -eu
printf 'kubectl' >> "$CALLS"
printf ' %s' "$@" >> "$CALLS"
printf '\n' >> "$CALLS"

if [ "${1:-}" = "-n" ]; then
  shift 2
fi

if [ "${1:-}" = "get" ] && [ "${2:-}" = "pods" ]; then
  cat "$FIX/pods.jsonpath"
  exit 0
fi

if [ "${1:-}" = "get" ] && [ "${2:-}" = "pvc" ]; then
  if [ "${3:-}" = "-l" ]; then
    case "$*" in
      *unbound-since*) cat "$FIX/legacy-pvc-records.jsonpath" ;;
      *) cat "$FIX/pvc-names.jsonpath" ;;
    esac
  else
    if [ -f "$FIX/api-errors/${3:-}" ]; then
      printf '%s\n' 'Error from server (InternalError): injected API failure' >&2
      exit 1
    fi
    if [ -f "$FIX/not-found/${3:-}" ]; then
      case " $* " in
        *' --ignore-not-found '*) exit 0 ;;
      esac
      printf 'Error from server (NotFound): persistentvolumeclaims "%s" not found\n' "${3:-}" >&2
      exit 1
    fi
    marker="$FIX/annotations/${3:-}"
    [ ! -f "$marker" ] || cat "$marker"
    case "$*" in
      *'{"x"}'*) printf x ;;
    esac
  fi
  exit 0
fi

case "${1:-}" in
  annotate | delete) exit 0 ;;
esac

printf '%s\n' "unexpected kubectl call: $*" >&2
exit 1
STUB
chmod +x "$BIN/kubectl"

reset_fixtures() {
  : > "$CALLS"
  : > "$FIX/pods.jsonpath"
  : > "$FIX/pvc-names.jsonpath"
  : > "$FIX/legacy-pvc-records.jsonpath"
  rm -f "$FIX/annotations"/*
  rm -f "$FIX/not-found"/*
  rm -f "$FIX/api-errors"/*
}

run_reaper() {
  if DAWN_SANDBOX_NS=ns DAWN_REAPER_TTL_SECONDS=3600 sh "$DIR/../files/reaper.sh"; then
    return 0
  fi
  printf '%s\n' "FAIL: reaper exited non-zero" >&2
  FAILURES=$((FAILURES + 1))
  return 0
}

require_reaper_failure() {
  description=$1
  if DAWN_SANDBOX_NS=ns DAWN_REAPER_TTL_SECONDS=3600 sh "$DIR/../files/reaper.sh"; then
    printf '%s\n' "FAIL: $description" >&2
    FAILURES=$((FAILURES + 1))
  else
    printf '%s\n' "ok: $description"
  fi
}

require_call() {
  description=$1
  pattern=$2
  if grep -Fq "$pattern" "$CALLS"; then
    printf '%s\n' "ok: $description"
  else
    printf '%s\n' "FAIL: $description" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

reject_call() {
  description=$1
  pattern=$2
  if grep -Fq "$pattern" "$CALLS"; then
    printf '%s\n' "FAIL: $description" >&2
    FAILURES=$((FAILURES + 1))
  else
    printf '%s\n' "ok: $description"
  fi
}

# Main behavior plus an annotation newline that fabricates a victim record in
# the legacy combined JSONPath stream.
reset_fixtures
NOW_EPOCH="$(date -u +%s)"
WITHIN_SINCE=$((NOW_EPOCH - 60))
cat > "$FIX/pvc-names.jsonpath" <<'EOF'
dawn-sbx-vol-bound
dawn-sbx-vol-fresh-unbound
dawn-sbx-vol-stale-unbound
dawn-sbx-vol-attacker
dawn-sbx-vol-trailing-newline
dawn-sbx-vol-zero
dawn-sbx-vol-leading-zero
dawn-sbx-vol-within-ttl
EOF
printf '%s\n' 'dawn-sbx-vol-bound' > "$FIX/pods.jsonpath"
printf '%s' '1700000000' > "$FIX/annotations/dawn-sbx-vol-bound"
: > "$FIX/annotations/dawn-sbx-vol-fresh-unbound"
printf '%s' '1000000000' > "$FIX/annotations/dawn-sbx-vol-stale-unbound"
printf '0\ndawn-sbx-vol-injected-victim 1000000000' > "$FIX/annotations/dawn-sbx-vol-attacker"
printf '123\n' > "$FIX/annotations/dawn-sbx-vol-trailing-newline"
printf '%s' '0' > "$FIX/annotations/dawn-sbx-vol-zero"
printf '%s' '0123' > "$FIX/annotations/dawn-sbx-vol-leading-zero"
printf '%s' "$WITHIN_SINCE" > "$FIX/annotations/dawn-sbx-vol-within-ttl"
cat > "$FIX/legacy-pvc-records.jsonpath" <<EOF
dawn-sbx-vol-bound 1700000000
dawn-sbx-vol-fresh-unbound
dawn-sbx-vol-stale-unbound 1000000000
dawn-sbx-vol-attacker 0
dawn-sbx-vol-injected-victim 1000000000
dawn-sbx-vol-trailing-newline 123
dawn-sbx-vol-zero 0
dawn-sbx-vol-leading-zero 0123
dawn-sbx-vol-within-ttl $WITHIN_SINCE
EOF
run_reaper

require_call "fresh unbound PVC is marked" \
  "annotate --overwrite pvc dawn-sbx-vol-fresh-unbound dawn.sh/unbound-since="
require_call "stale unbound PVC is deleted without waiting for watch permission" \
  "delete pvc dawn-sbx-vol-stale-unbound --wait=false"
require_call "bound PVC marker is cleared" \
  "annotate pvc dawn-sbx-vol-bound dawn.sh/unbound-since-"
reject_call "within-TTL PVC is not re-marked" \
  "annotate --overwrite pvc dawn-sbx-vol-within-ttl"
reject_call "within-TTL PVC is not deleted" \
  "delete pvc dawn-sbx-vol-within-ttl"
require_call "multiline marker is re-marked" \
  "annotate --overwrite pvc dawn-sbx-vol-attacker dawn.sh/unbound-since="
reject_call "injected victim record is never deleted" \
  "delete pvc dawn-sbx-vol-injected-victim"
require_call "trailing-newline marker is re-marked" \
  "annotate --overwrite pvc dawn-sbx-vol-trailing-newline dawn.sh/unbound-since="
require_call "zero marker is re-marked" \
  "annotate --overwrite pvc dawn-sbx-vol-zero dawn.sh/unbound-since="
require_call "leading-zero marker is re-marked" \
  "annotate --overwrite pvc dawn-sbx-vol-leading-zero dawn.sh/unbound-since="

# A digit string longer than NOW must be rejected before shell arithmetic.
reset_fixtures
printf '%s\n' 'dawn-sbx-vol-oversized' > "$FIX/pvc-names.jsonpath"
printf '%s' '9999999999999999999999999999999999999999' > "$FIX/annotations/dawn-sbx-vol-oversized"
printf '%s\n' 'dawn-sbx-vol-oversized 9999999999999999999999999999999999999999' \
  > "$FIX/legacy-pvc-records.jsonpath"
run_reaper
require_call "oversized numeric marker is re-marked" \
  "annotate --overwrite pvc dawn-sbx-vol-oversized dawn.sh/unbound-since="
reject_call "oversized numeric marker never drives deletion" \
  "delete pvc dawn-sbx-vol-oversized"

# A canonical, same-width future epoch is numerically safe but tampered.
reset_fixtures
FUTURE_SINCE=$((NOW_EPOCH + 3600))
printf '%s\n' 'dawn-sbx-vol-future' > "$FIX/pvc-names.jsonpath"
printf '%s' "$FUTURE_SINCE" > "$FIX/annotations/dawn-sbx-vol-future"
printf 'dawn-sbx-vol-future %s\n' "$FUTURE_SINCE" > "$FIX/legacy-pvc-records.jsonpath"
run_reaper
require_call "future marker is re-marked" \
  "annotate --overwrite pvc dawn-sbx-vol-future dawn.sh/unbound-since="
reject_call "future marker never drives deletion" \
  "delete pvc dawn-sbx-vol-future"

# A PVC may disappear after the initial list. Confirmed NotFound is skipped and
# must not prevent later listed PVCs from being processed.
reset_fixtures
cat > "$FIX/pvc-names.jsonpath" <<'EOF'
dawn-sbx-vol-disappeared
dawn-sbx-vol-after-disappeared
EOF
: > "$FIX/not-found/dawn-sbx-vol-disappeared"
: > "$FIX/annotations/dawn-sbx-vol-after-disappeared"
run_reaper
require_call "per-PVC lookup tolerates confirmed NotFound" \
  "get pvc dawn-sbx-vol-disappeared --ignore-not-found"
reject_call "disappeared PVC is not annotated" \
  "annotate --overwrite pvc dawn-sbx-vol-disappeared"
reject_call "disappeared PVC is not deleted" \
  "delete pvc dawn-sbx-vol-disappeared"
require_call "processing continues after a disappeared PVC" \
  "annotate --overwrite pvc dawn-sbx-vol-after-disappeared dawn.sh/unbound-since="

# --ignore-not-found must not turn genuine API failures into successful reads.
reset_fixtures
printf '%s\n' 'dawn-sbx-vol-api-error' > "$FIX/pvc-names.jsonpath"
: > "$FIX/api-errors/dawn-sbx-vol-api-error"
require_reaper_failure "genuine per-PVC API errors fail the reaper"

if [ "$FAILURES" -ne 0 ]; then
  printf '\n%s\n' "kubectl calls from final scenario:" >&2
  cat "$CALLS" >&2
  printf '%s\n' "reaper test failed: $FAILURES assertion(s)" >&2
  exit 1
fi

printf '%s\n' "reaper test passed"
