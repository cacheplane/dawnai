#!/usr/bin/env bash
#
# Pre-populate the `kind` and `kubectl` binaries in the GitHub Actions tool
# cache so that helm/kind-action skips its own fragile installers for both.
#
# Why this exists
# ---------------
# helm/kind-action's `kind.sh` downloads both binaries (and their checksums)
# with `curl -sSLo` and *no* `--fail`. When the upstream host answers with a
# 429, a 5xx, or a CDN error page, curl writes that HTML body into the
# checksum file and still exits 0. The follow-up `sha256sum -c` then receives
# garbage stdin and dies with
#
#     sha256sum: 'standard input': no properly formatted checksum lines found
#
# which `set -o errexit` turns into a failed step. That is the real cause of
# the intermittent sandbox-k8s / sandbox-k8s-e2e / chart-apply-smoke failures;
# the "No such container: kind-registry" line in Post-job cleanup is unrelated
# noise.
#
# `kind.sh` guards each install independently:
#
#     local cache_dir="${RUNNER_TOOL_CACHE}/kind/${version}/${arch}"
#     local kind_dir="${cache_dir}/kind/bin/"
#     if [[ ! -x "${kind_dir}/kind" ]]; then install_kind; fi
#     local kubectl_dir="${cache_dir}/kubectl/bin/"
#     if [[ ! -x "${kubectl_dir}/kubectl" ]]; then install_kubectl; fi
#
# so writing verified binaries to exactly those paths makes the action skip
# both downloads altogether. Note the path detail that is easy to get wrong:
# kubectl is cached under the *kind* version directory (`${cache_dir}` is
# keyed by `${version}`, the kind version), not a kubectl-versioned one.
#
# Both halves of this bug are closed here: kind fetches from GitHub releases,
# kubectl fetches from dl.k8s.io. kubectl was left open longer than kind
# because dl.k8s.io is a more reliable CDN and the failure had never been
# observed there — but the same curl footgun is present in the same script,
# so it is primed preventively rather than reactively.
#
# Contract
# --------
#   * Every fetch uses `curl --fail --retry ...`: a transient error is retried
#     and a persistent one is a loud, non-zero failure — never a corrupt file.
#   * The checksum is verified and a mismatch aborts. Failing silently is the
#     exact bug being fixed here.
#   * Each binary is only moved into the cache path after it verifies, so a
#     failed run can never leave a broken binary that the action would then
#     happily skip over.
#   * Idempotent: a second run with already-verified binaries exits 0 without
#     touching the network.
#
# Usage: scripts/prime-kind-cache.sh <kind-version> <kubectl-version>
#        (e.g. v0.31.0 v1.35.0)
#
# Both arguments MUST match the `version:` and `kubectl_version:` inputs given
# to the helm/kind-action step that follows. If any of them ever drift, this
# script simply primes a path the action does not consult, the action falls
# back to its own download for that tool, and CI behaves exactly as it does
# today — degraded, not broken.

set -euo pipefail

KIND_VERSION="${1:-}"
KUBECTL_VERSION="${2:-}"
if [[ -z "${KIND_VERSION}" || -z "${KUBECTL_VERSION}" ]]; then
  echo "prime-kind-cache: usage: $0 <kind-version> <kubectl-version>  (e.g. v0.31.0 v1.35.0)" >&2
  exit 2
fi

if [[ -z "${RUNNER_TOOL_CACHE:-}" ]]; then
  echo "prime-kind-cache: RUNNER_TOOL_CACHE is not set" >&2
  exit 2
fi

# Mirrors the architecture mapping in helm/kind-action's kind.sh. Both the
# kind and kubectl downloads below reuse this same mapping, exactly as
# kind.sh does.
case "$(uname -m)" in
i386 | i686) ARCH="386" ;;
x86_64) ARCH="amd64" ;;
arm | aarch64 | arm64) ARCH="arm64" ;;
*)
  echo "prime-kind-cache: unsupported architecture $(uname -m)" >&2
  exit 1
  ;;
esac

# macOS lacks sha256sum; keep the script runnable outside the Linux runner.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# --fail turns an HTTP error into a non-zero exit instead of a body that looks
# like a download; --retry-all-errors also retries the 4xx/5xx that --fail
# surfaces, so throttling is a retry and a real outage is a failure.
fetch() {
  curl --fail --retry 5 --retry-all-errors --retry-delay 2 -sSL -o "$2" "$1"
}

# Shared scratch space for both downloads below, created lazily so the fully
# idempotent fast path (both tools already cached) never touches disk beyond
# the cache itself, let alone the network.
WORK_DIR=""
ensure_work_dir() {
  if [[ -z "${WORK_DIR}" ]]; then
    WORK_DIR="$(mktemp -d)"
    trap 'rm -rf "${WORK_DIR}"' EXIT
  fi
}

CACHE_DIR="${RUNNER_TOOL_CACHE}/kind/${KIND_VERSION}/${ARCH}"

# ---------------------------------------------------------------------------
# kind
# ---------------------------------------------------------------------------
prime_kind() {
  local dir="${CACHE_DIR}/kind/bin"
  local bin="${dir}/kind"
  local sum="${dir}/kind.sha256"
  local asset="kind-linux-${ARCH}"
  local base_url="https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}"

  # Idempotent fast path: an already-verified binary needs no network at all.
  if [[ -x "${bin}" && -s "${sum}" ]]; then
    local cached
    cached="$(cat "${sum}")"
    if [[ "$(sha256_of "${bin}")" == "${cached}" ]]; then
      echo "prime-kind-cache: kind ${KIND_VERSION} (${ARCH}) already cached at ${bin}"
      return 0
    fi
    echo "prime-kind-cache: cached kind ${KIND_VERSION} (${ARCH}) failed its recorded checksum; refetching" >&2
  fi

  ensure_work_dir

  echo "prime-kind-cache: downloading kind ${KIND_VERSION} (${ARCH})"
  if ! fetch "${base_url}/${asset}" "${WORK_DIR}/${asset}"; then
    echo "prime-kind-cache: failed to download ${base_url}/${asset}" >&2
    return 1
  fi
  if ! fetch "${base_url}/${asset}.sha256sum" "${WORK_DIR}/${asset}.sha256sum"; then
    echo "prime-kind-cache: failed to download ${base_url}/${asset}.sha256sum" >&2
    return 1
  fi

  local expected
  expected="$(awk -v asset="${asset}" '
    { name = $2; sub(/^\*/, "", name) }
    name == asset { print $1; exit }
  ' "${WORK_DIR}/${asset}.sha256sum")"

  if [[ ! "${expected}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "prime-kind-cache: no checksum for ${asset} in ${base_url}/${asset}.sha256sum" >&2
    return 1
  fi

  local actual
  actual="$(sha256_of "${WORK_DIR}/${asset}")"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "prime-kind-cache: checksum mismatch for ${asset}" >&2
    echo "prime-kind-cache:   expected ${expected}" >&2
    echo "prime-kind-cache:   actual   ${actual}" >&2
    return 1
  fi

  chmod +x "${WORK_DIR}/${asset}"
  mkdir -p "${dir}"
  # Publish the checksum only after the binary lands, so an interrupted run
  # cannot leave a binary that the fast path would trust.
  mv -f "${WORK_DIR}/${asset}" "${bin}"
  printf '%s\n' "${expected}" >"${sum}"
  echo "prime-kind-cache: verified kind ${KIND_VERSION} (${ARCH}) at ${bin}"
}

# ---------------------------------------------------------------------------
# kubectl
# ---------------------------------------------------------------------------
prime_kubectl() {
  # Cached under the *kind* version directory — see the path-detail note at
  # the top of this file. This is what kind.sh's own guard reads.
  local dir="${CACHE_DIR}/kubectl/bin"
  local bin="${dir}/kubectl"
  local sum="${dir}/kubectl.sha256"
  local base_url="https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}"

  # Idempotent fast path: an already-verified binary needs no network at all.
  if [[ -x "${bin}" && -s "${sum}" ]]; then
    local cached
    cached="$(cat "${sum}")"
    if [[ "$(sha256_of "${bin}")" == "${cached}" ]]; then
      echo "prime-kind-cache: kubectl ${KUBECTL_VERSION} (${ARCH}) already cached at ${bin}"
      return 0
    fi
    echo "prime-kind-cache: cached kubectl ${KUBECTL_VERSION} (${ARCH}) failed its recorded checksum; refetching" >&2
  fi

  ensure_work_dir

  echo "prime-kind-cache: downloading kubectl ${KUBECTL_VERSION} (${ARCH})"
  if ! fetch "${base_url}/kubectl" "${WORK_DIR}/kubectl"; then
    echo "prime-kind-cache: failed to download ${base_url}/kubectl" >&2
    return 1
  fi
  if ! fetch "${base_url}/kubectl.sha256" "${WORK_DIR}/kubectl.sha256"; then
    echo "prime-kind-cache: failed to download ${base_url}/kubectl.sha256" >&2
    return 1
  fi

  # Unlike kind's checksum file, kubectl's `.sha256` contains only the bare
  # hex digest — no filename, no leading `*`/` ` markers to strip.
  local expected
  expected="$(tr -d '[:space:]' <"${WORK_DIR}/kubectl.sha256")"

  if [[ ! "${expected}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "prime-kind-cache: malformed checksum for kubectl at ${base_url}/kubectl.sha256" >&2
    return 1
  fi

  local actual
  actual="$(sha256_of "${WORK_DIR}/kubectl")"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "prime-kind-cache: checksum mismatch for kubectl" >&2
    echo "prime-kind-cache:   expected ${expected}" >&2
    echo "prime-kind-cache:   actual   ${actual}" >&2
    return 1
  fi

  chmod +x "${WORK_DIR}/kubectl"
  mkdir -p "${dir}"
  # Publish the checksum only after the binary lands, so an interrupted run
  # cannot leave a binary that the fast path would trust.
  mv -f "${WORK_DIR}/kubectl" "${bin}"
  printf '%s\n' "${expected}" >"${sum}"
  echo "prime-kind-cache: verified kubectl ${KUBECTL_VERSION} (${ARCH}) at ${bin}"
}

prime_kind
prime_kubectl
