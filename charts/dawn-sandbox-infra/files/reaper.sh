#!/usr/bin/env sh
set -eu
NS="${DAWN_SANDBOX_NS:?}"
TTL_SECONDS="${DAWN_REAPER_TTL_SECONDS:?}"
NOW="$(date -u +%s)"

# claimNames currently referenced by any pod in the namespace
BOUND="$(kubectl -n "$NS" get pods -o jsonpath='{range .items[*]}{range .spec.volumes[*]}{.persistentVolumeClaim.claimName}{"\n"}{end}{end}' | sort -u)"

# List only trusted Kubernetes metadata names. Annotation values are fetched
# separately so embedded newlines cannot fabricate additional PVC records.
PVC_NAMES="$(kubectl -n "$NS" get pvc -l app.kubernetes.io/managed-by=dawn \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')"

printf '%s\n' "$PVC_NAMES" | while IFS= read -r NAME; do
    [ -z "$NAME" ] && continue
    SINCE_WITH_SENTINEL="$(kubectl -n "$NS" get pvc "$NAME" --ignore-not-found \
      -o jsonpath='{.metadata.annotations.dawn\.sh/unbound-since}{"x"}')"
    [ -z "$SINCE_WITH_SENTINEL" ] && continue
    SINCE="${SINCE_WITH_SENTINEL%?}"

    if printf '%s\n' "$BOUND" | grep -Fxq "$NAME"; then
      # bound → clear any marker
      [ -n "${SINCE:-}" ] && kubectl -n "$NS" annotate pvc "$NAME" dawn.sh/unbound-since- >/dev/null 2>&1 || true
      continue
    fi

    # Only canonical positive decimal epochs that fit within NOW's digit width
    # may reach shell arithmetic. Invalid/tampered markers reset the clock.
    case "${SINCE:-}" in
      "" | 0* | *[!0-9]*)
        kubectl -n "$NS" annotate --overwrite pvc "$NAME" "dawn.sh/unbound-since=$NOW" >/dev/null
        echo "marked $NAME"
        continue
        ;;
    esac

    if [ "${#SINCE}" -gt "${#NOW}" ]; then
      kubectl -n "$NS" annotate --overwrite pvc "$NAME" "dawn.sh/unbound-since=$NOW" >/dev/null
      echo "marked $NAME"
      continue
    fi

    AGE=$(( NOW - SINCE ))
    if [ "$AGE" -lt 0 ]; then
      kubectl -n "$NS" annotate --overwrite pvc "$NAME" "dawn.sh/unbound-since=$NOW" >/dev/null
      echo "marked $NAME"
    elif [ "$AGE" -gt "$TTL_SECONDS" ]; then
      kubectl -n "$NS" delete pvc "$NAME" --wait=false >/dev/null
      echo "reaped $NAME (unbound ${AGE}s)"
    fi
  done
