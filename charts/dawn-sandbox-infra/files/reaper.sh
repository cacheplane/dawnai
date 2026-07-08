#!/usr/bin/env sh
set -eu
NS="${DAWN_SANDBOX_NS:?}"
TTL_SECONDS="${DAWN_REAPER_TTL_SECONDS:?}"
NOW="$(date -u +%s)"

# claimNames currently referenced by any pod in the namespace
BOUND="$(kubectl -n "$NS" get pods -o jsonpath='{range .items[*]}{range .spec.volumes[*]}{.persistentVolumeClaim.claimName}{"\n"}{end}{end}' | sort -u)"

# managed PVCs: "<name> <unbound-since-or-empty>"
kubectl -n "$NS" get pvc -l app.kubernetes.io/managed-by=dawn \
  -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.annotations.dawn\.sh/unbound-since}{"\n"}{end}' \
| while read -r NAME SINCE; do
    [ -z "$NAME" ] && continue
    if printf '%s\n' "$BOUND" | grep -qx "$NAME"; then
      # bound → clear any marker
      [ -n "${SINCE:-}" ] && kubectl -n "$NS" annotate pvc "$NAME" dawn.sh/unbound-since- >/dev/null 2>&1 || true
      continue
    fi
    # Re-mark (reset the clock) when the marker is missing OR not a positive
    # integer — a corrupted/tampered annotation must never drive a delete.
    case "${SINCE:-}" in
      "" | *[!0-9]*)
        kubectl -n "$NS" annotate --overwrite pvc "$NAME" "dawn.sh/unbound-since=$NOW" >/dev/null
        echo "marked $NAME"
        ;;
      *)
        AGE=$(( NOW - SINCE ))
        if [ "$AGE" -gt "$TTL_SECONDS" ]; then
          kubectl -n "$NS" delete pvc "$NAME" >/dev/null
          echo "reaped $NAME (unbound ${AGE}s)"
        fi
        ;;
    esac
  done
