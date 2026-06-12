#!/usr/bin/env bash
#
# One-time cleanup: remove the pre-realignment npm versions of @dawn-ai/testing
# and @dawn-ai/evals that sit ABOVE the unified 0.8.0 line.
#
# Context: testing/evals drifted to independent 5.x / 3.x major lines. The
# 0.8.0 release realigns every public package to a single shared version. This
# script deletes the now-orphaned higher versions from npm so 0.8.0 is the only
# forward line.
#
# DESTRUCTIVE + IRREVERSIBLE: `npm unpublish` permanently removes a version and
# burns that exact version number for 24h. Anyone with `^5`/`^3` installs of
# these packages will break. Only run this if you accept that.
#
# Requirements:
#   - You are logged in to npm as an owner/maintainer of the @dawn-ai org
#     (`npm login`; the account must have unpublish rights). 2FA: pass --otp
#     via NPM_OTP env var below, or let npm prompt interactively.
#   - The 0.8.0 release has already published (merge the version-unification PR
#     first and let CI publish). This script REFUSES to run until 0.8.0 is live
#     and tagged `latest` for each package — otherwise unpublishing could orphan
#     the package.
#
# Usage:
#   npm login                      # as a @dawn-ai owner
#   bash scripts/unpublish-legacy-dawn-versions.sh            # dry run (prints commands)
#   bash scripts/unpublish-legacy-dawn-versions.sh --apply    # actually unpublish
#   NPM_OTP=123456 bash scripts/unpublish-legacy-dawn-versions.sh --apply

set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

OTP_ARG=()
[[ -n "${NPM_OTP:-}" ]] && OTP_ARG=(--otp "${NPM_OTP}")

# package -> space-separated list of versions to remove (everything > 0.8.0)
TESTING_VERSIONS="1.0.0 2.0.0 3.0.0 4.0.0 5.0.0"
EVALS_VERSIONS="1.0.0 2.0.0 3.0.0"

echo "==> Verifying npm auth"
WHO=$(npm whoami 2>/dev/null || true)
if [[ -z "$WHO" ]]; then
  echo "ERROR: not logged in to npm. Run 'npm login' as a @dawn-ai owner first." >&2
  exit 1
fi
echo "    logged in as: $WHO"

preflight() {
  local pkg="$1"
  echo "==> Preflight: $pkg"
  local live latest
  live=$(npm view "${pkg}@0.8.0" version 2>/dev/null || true)
  if [[ "$live" != "0.8.0" ]]; then
    echo "ERROR: ${pkg}@0.8.0 is not published yet. Merge the version PR and let CI publish before running this." >&2
    exit 1
  fi
  latest=$(npm view "${pkg}" dist-tags.latest 2>/dev/null || true)
  if [[ "$latest" != "0.8.0" ]]; then
    echo "ERROR: ${pkg} 'latest' is '$latest', not '0.8.0'. Refusing to unpublish (would orphan the package)." >&2
    echo "       Fix with: npm dist-tag add ${pkg}@0.8.0 latest" >&2
    exit 1
  fi
  echo "    ok: ${pkg}@0.8.0 is live and tagged latest"
}

unpublish_set() {
  local pkg="$1"; shift
  for v in "$@"; do
    if [[ "$APPLY" == "1" ]]; then
      echo "    unpublishing ${pkg}@${v}"
      npm unpublish "${pkg}@${v}" "${OTP_ARG[@]}"
    else
      echo "    [dry-run] npm unpublish ${pkg}@${v}"
    fi
  done
}

preflight "@dawn-ai/testing"
preflight "@dawn-ai/evals"

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "DRY RUN — no versions removed. Re-run with --apply to execute."
fi

echo "==> @dawn-ai/testing"
unpublish_set "@dawn-ai/testing" $TESTING_VERSIONS
echo "==> @dawn-ai/evals"
unpublish_set "@dawn-ai/evals" $EVALS_VERSIONS

echo
echo "Done. (evals 0.1.0 is intentionally kept — it is below 0.8.0.)"
