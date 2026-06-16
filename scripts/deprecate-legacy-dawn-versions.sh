#!/usr/bin/env bash
#
# One-time cleanup: DEPRECATE the pre-realignment npm versions of
# @dawn-ai/testing and @dawn-ai/evals that sit ABOVE the unified 0.8.0 line.
#
# Why deprecate, not unpublish: npm blocks self-service `npm unpublish` for any
# version older than 72 hours ("You can no longer unpublish this package."). All
# the legacy versions are well past that window, so they cannot be removed
# without an npm support request. `npm deprecate` is the sanctioned alternative:
# it leaves the tarball in place but makes every install that resolves the
# version print a warning pointing at 0.8.0. It works at any age and is
# REVERSIBLE — re-run with an empty message ("") to undo.
#
# Context: testing/evals drifted to independent 5.x / 3.x major lines. The 0.8.0
# release realigned every public package to a single shared version, renumbering
# testing and evals DOWN to 0.8.0 (now `latest`). The higher versions are
# orphaned; this marks them deprecated so nobody pins them by accident.
#
# Requirements:
#   - Logged in to npm as a @dawn-ai owner/maintainer with publish rights
#     (`npm login`) — required only for --apply, NOT for the dry run.
#   - 0.8.0 already published + tagged `latest` for each package (orphan guard
#     below refuses to run otherwise).
#   - 2FA: pass NPM_OTP, or let npm prompt interactively.
#
# Usage:
#   bash scripts/deprecate-legacy-dawn-versions.sh             # dry run (read-only, no auth)
#   npm login                                                  # as a @dawn-ai owner
#   NPM_OTP=123456 bash scripts/deprecate-legacy-dawn-versions.sh --apply
#
# Undo one version:  npm deprecate <pkg>@<version> ""

# NOTE: intentionally NOT `-e`; we continue past per-version failures and print
# a summary so one refusal does not hide the rest.
set -uo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

OTP_ARG=()
[[ -n "${NPM_OTP:-}" ]] && OTP_ARG=(--otp "${NPM_OTP}")

MSG_TESTING='Superseded by the unified 0.8.0 release line; install @dawn-ai/testing@^0.8.0'
MSG_EVALS='Superseded by the unified 0.8.0 release line; install @dawn-ai/evals@^0.8.0'

# package -> space-separated list of legacy versions ABOVE the 0.8.0 line.
TESTING_VERSIONS="1.0.0 2.0.0 3.0.0 4.0.0 5.0.0"
EVALS_VERSIONS="1.0.0 2.0.0 3.0.0"

SUCCESSES=0
FAILURES=0

preflight() {
  local pkg="$1"
  echo "==> Preflight: $pkg"
  local live latest
  live=$(npm view "${pkg}@0.8.0" version 2>/dev/null || true)
  if [[ "$live" != "0.8.0" ]]; then
    echo "ERROR: ${pkg}@0.8.0 is not published yet. Release 0.8.0 before running this." >&2
    exit 1
  fi
  latest=$(npm view "${pkg}" dist-tags.latest 2>/dev/null || true)
  if [[ "$latest" != "0.8.0" ]]; then
    echo "ERROR: ${pkg} 'latest' is '$latest', not '0.8.0'. Refusing — fix with: npm dist-tag add ${pkg}@0.8.0 latest" >&2
    exit 1
  fi
  echo "    ok: ${pkg}@0.8.0 is live and tagged latest"
}

deprecate_set() {
  local pkg="$1" msg="$2"
  shift 2
  for v in "$@"; do
    if [[ "$APPLY" == "1" ]]; then
      echo "    deprecating ${pkg}@${v}"
      if npm deprecate "${pkg}@${v}" "$msg" "${OTP_ARG[@]}"; then
        SUCCESSES=$((SUCCESSES + 1))
      else
        echo "    FAILED: ${pkg}@${v}" >&2
        FAILURES=$((FAILURES + 1))
      fi
    else
      echo "    [dry-run] npm deprecate ${pkg}@${v} \"$msg\""
    fi
  done
}

if [[ "$APPLY" == "1" ]]; then
  WHO=$(npm whoami 2>/dev/null || true)
  if [[ -z "$WHO" ]]; then
    echo "ERROR: not logged in to npm. Run 'npm login' as a @dawn-ai owner first." >&2
    exit 1
  fi
  echo "==> logged in as: $WHO"
fi

preflight "@dawn-ai/testing"
preflight "@dawn-ai/evals"

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "DRY RUN — nothing changed. After 'npm login', re-run with --apply."
fi

echo "==> @dawn-ai/testing"
deprecate_set "@dawn-ai/testing" "$MSG_TESTING" $TESTING_VERSIONS
echo "==> @dawn-ai/evals"
deprecate_set "@dawn-ai/evals" "$MSG_EVALS" $EVALS_VERSIONS

if [[ "$APPLY" == "1" ]]; then
  echo
  echo "Summary: ${SUCCESSES} deprecated, ${FAILURES} failed."
  [[ "$FAILURES" -gt 0 ]] && exit 1
fi
echo "(evals 0.1.0 intentionally kept — it is below the 0.8.0 line.)"
