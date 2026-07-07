#!/usr/bin/env sh
# Renders the chart and greps assertions. Usage: test/render.sh
set -eu
CHART="$(dirname "$0")/.."
tmpl() { helm template test "$CHART" "$@"; }
assert() { if ! grep -qE "$2"; then echo "FAIL: $1"; exit 1; fi; echo "ok: $1"; }
refute() { if grep -qE "$2"; then echo "FAIL (expected absent): $1"; exit 1; fi; echo "ok: $1"; }

# Namespace + PSS (default baseline enforce, restricted warn/audit)
tmpl --show-only templates/namespace.yaml | assert "ns name" 'name: dawn-sandboxes'
tmpl --show-only templates/namespace.yaml | assert "pss enforce baseline" 'pod-security.kubernetes.io/enforce: baseline'
tmpl --show-only templates/namespace.yaml | assert "pss warn restricted" 'pod-security.kubernetes.io/warn: restricted'
# Override: enforce restricted
tmpl --show-only templates/namespace.yaml --set podSecurityStandard.enforce=restricted | assert "pss enforce override" 'pod-security.kubernetes.io/enforce: restricted'

echo "render checks passed"
