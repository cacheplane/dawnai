#!/usr/bin/env bash
#
# Pre-populate the `kind` binary in the GitHub Actions tool cache so that
# helm/kind-action skips its own fragile installer.
#
# Why this exists
# ---------------
# helm/kind-action's `kind.sh` downloads the binary and its checksum with
# `curl -sSLo` and *no* `--fail`. When GitHub releases answers with a 429, a
# 5xx, or a CDN error page, curl writes that HTML body into the checksum file
# and still exits 0. The follow-up `grep ... | sha256sum -c` then receives
# empty stdin and dies with
#
#     sha256sum: 'standard input': no properly formatted checksum lines found
#
# which `set -o errexit` turns into a failed step. That is the real cause of
# the intermittent sandbox-k8s / sandbox-k8s-e2e / chart-apply-smoke failures;
# the "No such container: kind-registry" line in Post-job cleanup is unrelated
# noise.
#
# `kind.sh` guards the install with
#
#     local kind_dir="${RUNNER_TOOL_CACHE}/kind/${version}/${arch}/kind/bin/"
#     if [[ ! -x "${kind_dir}/kind" ]]; then install_kind; fi
#
# so writing a verified binary to exactly that path makes the action skip the
# download altogether.
#
# Contract
# --------
#   * Every fetch uses `curl --fail --retry ...`: a transient error is retried
#     and a persistent one is a loud, non-zero failure — never a corrupt file.
#   * The checksum is verified and a mismatch aborts. Failing silently is the
#     exact bug being fixed here.
#   * The binary is only moved into the cache path after it verifies, so a
#     failed run can never leave a broken `kind` that the action would then
#     happily skip over.
#   * Idempotent: a second run with an already-verified binary exits 0 without
#     touching the network.
#
# Usage: scripts/prime-kind-cache.sh <kind-version>   (e.g. v0.31.0)
#
# The version argument MUST match the `version:` input given to the
# helm/kind-action step that follows. If they ever drift, this script simply
# primes a path the action does not consult, the action falls back to its own
# download, and CI behaves exactly as it does today — degraded, not broken.

set -euo pipefail

VERSION="${1:-}"
if [[ -z "${VERSION}" ]]; then
  echo "prime-kind-cache: usage: $0 <kind-version>  (e.g. v0.31.0)" >&2
  exit 2
fi

if [[ -z "${RUNNER_TOOL_CACHE:-}" ]]; then
  echo "prime-kind-cache: RUNNER_TOOL_CACHE is not set" >&2
  exit 2
fi

# Mirrors the architecture mapping in helm/kind-action's kind.sh.
case "$(uname -m)" in
i386 | i686) ARCH="386" ;;
x86_64) ARCH="amd64" ;;
arm | aarch64 | arm64) ARCH="arm64" ;;
*)
  echo "prime-kind-cache: unsupported architecture $(uname -m)" >&2
  exit 1
  ;;
esac

KIND_DIR="${RUNNER_TOOL_CACHE}/kind/${VERSION}/${ARCH}/kind/bin"
KIND_BIN="${KIND_DIR}/kind"
KIND_SUM="${KIND_DIR}/kind.sha256"
ASSET="kind-linux-${ARCH}"
BASE_URL="https://github.com/kubernetes-sigs/kind/releases/download/${VERSION}"

# macOS lacks sha256sum; keep the script runnable outside the Linux runner.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Idempotent fast path: an already-verified binary needs no network at all.
if [[ -x "${KIND_BIN}" && -s "${KIND_SUM}" ]]; then
  cached="$(cat "${KIND_SUM}")"
  if [[ "$(sha256_of "${KIND_BIN}")" == "${cached}" ]]; then
    echo "prime-kind-cache: kind ${VERSION} (${ARCH}) already cached at ${KIND_BIN}"
    exit 0
  fi
  echo "prime-kind-cache: cached kind ${VERSION} (${ARCH}) failed its recorded checksum; refetching" >&2
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

fetch() {
  # --fail turns an HTTP error into a non-zero exit instead of a body that
  # looks like a download; --retry-all-errors also retries the 4xx/5xx that
  # --fail surfaces, so throttling is a retry and a real outage is a failure.
  curl --fail --retry 5 --retry-all-errors --retry-delay 2 -sSL -o "$2" "$1"
}

echo "prime-kind-cache: downloading kind ${VERSION} (${ARCH})"
if ! fetch "${BASE_URL}/${ASSET}" "${WORK_DIR}/${ASSET}"; then
  echo "prime-kind-cache: failed to download ${BASE_URL}/${ASSET}" >&2
  exit 1
fi
if ! fetch "${BASE_URL}/${ASSET}.sha256sum" "${WORK_DIR}/${ASSET}.sha256sum"; then
  echo "prime-kind-cache: failed to download ${BASE_URL}/${ASSET}.sha256sum" >&2
  exit 1
fi

expected="$(awk -v asset="${ASSET}" '
  { name = $2; sub(/^\*/, "", name) }
  name == asset { print $1; exit }
' "${WORK_DIR}/${ASSET}.sha256sum")"

if [[ ! "${expected}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "prime-kind-cache: no checksum for ${ASSET} in ${BASE_URL}/${ASSET}.sha256sum" >&2
  exit 1
fi

actual="$(sha256_of "${WORK_DIR}/${ASSET}")"
if [[ "${actual}" != "${expected}" ]]; then
  echo "prime-kind-cache: checksum mismatch for ${ASSET}" >&2
  echo "prime-kind-cache:   expected ${expected}" >&2
  echo "prime-kind-cache:   actual   ${actual}" >&2
  exit 1
fi

chmod +x "${WORK_DIR}/${ASSET}"
mkdir -p "${KIND_DIR}"
# Publish the checksum only after the binary lands, so an interrupted run
# cannot leave a binary that the fast path would trust.
mv -f "${WORK_DIR}/${ASSET}" "${KIND_BIN}"
printf '%s\n' "${expected}" >"${KIND_SUM}"
echo "prime-kind-cache: verified kind ${VERSION} (${ARCH}) at ${KIND_BIN}"
