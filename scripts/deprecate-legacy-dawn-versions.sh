#!/usr/bin/env bash
#
# One-time cleanup: retire the pre-realignment npm versions of @dawn-ai/testing
# and @dawn-ai/evals that sit ABOVE the unified 0.8.0 line.
#
# NOTE: this DEPRECATES rather than unpublishes. npm refuses to unpublish these
# packages — `405 ... has dependent packages in the registry` — because
# @dawn-ai/evals declares a real peerDependency on @dawn-ai/testing, and npm's
# "no dependents" unpublish criterion is package-level across ALL published
# versions. Deprecation is npm's sanctioned alternative and achieves the goal:
# `latest` already points to 0.8.0, and these versions get flagged so installs
# are steered to ^0.8.0. (Applied once on 2026-06-16; kept for reference and in
# case a future version drifts and needs the same treatment.)
#
# Requirements:
#   - Logged in to npm as a @dawn-ai owner (`npm login`; `npm whoami` must NOT
#     return 401). Deprecate is a write op → needs an OTP: pass NPM_OTP=<code>.
#   - The 0.8.0 release is published and tagged `latest` (preflight enforces it).
#
# Usage:
#   npm login
#   bash scripts/deprecate-legacy-dawn-versions.sh                       # dry run
#   NPM_OTP=123456 bash scripts/deprecate-legacy-dawn-versions.sh --apply

set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

OTP_ARG=()
[[ -n "${NPM_OTP:-}" ]] && OTP_ARG=("--otp=${NPM_OTP}")

# package -> semver range to deprecate. ">=1.0.0" hits exactly the drifted
# versions (testing 1.x-5.x, evals 1.x-3.x) and spares 0.8.0 and evals@0.1.0.
TESTING_RANGE='@dawn-ai/testing@>=1.0.0'
EVALS_RANGE='@dawn-ai/evals@>=1.0.0'
MSG_TESTING="Superseded by the unified 0.8.0 release line; install @dawn-ai/testing@^0.8.0"
MSG_EVALS="Superseded by the unified 0.8.0 release line; install @dawn-ai/evals@^0.8.0"

echo "==> Verifying npm auth"
WHO=$(npm whoami 2>/dev/null || true)
if [[ -z "$WHO" ]]; then
  echo "ERROR: not logged in to npm. Run 'npm login' as a @dawn-ai owner first." >&2
  exit 1
fi
echo "    logged in as: $WHO"

preflight() {
  local pkg="$1"
  local latest
  latest=$(npm view "${pkg}" dist-tags.latest 2>/dev/null || true)
  if [[ "$latest" != "0.8.0" ]]; then
    echo "ERROR: ${pkg} 'latest' is '$latest', not '0.8.0'. Publish the 0.8.0 release first." >&2
    exit 1
  fi
  echo "    ok: ${pkg} latest=0.8.0"
}

deprecate() {
  local spec="$1" msg="$2"
  if [[ "$APPLY" == "1" ]]; then
    echo "    deprecating ${spec}"
    npm deprecate "${spec}" "${msg}" "${OTP_ARG[@]}"
  else
    echo "    [dry-run] npm deprecate '${spec}' \"${msg}\""
  fi
}

echo "==> Preflight"
preflight "@dawn-ai/testing"
preflight "@dawn-ai/evals"

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "DRY RUN — nothing deprecated. Re-run with --apply (and NPM_OTP=<code>) to execute."
fi

echo "==> @dawn-ai/testing"
deprecate "$TESTING_RANGE" "$MSG_TESTING"
echo "==> @dawn-ai/evals"
deprecate "$EVALS_RANGE" "$MSG_EVALS"

echo
echo "Done. (testing@0.8.0, evals@0.8.0, and evals@0.1.0 are left clean.)"
echo "To UN-deprecate later: npm deprecate '<pkg>@<range>' \"\" --otp=<code>"
