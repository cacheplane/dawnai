// This policy is dormant until its reviewed executable and fence contracts are admitted.
import { createHash } from "node:crypto"
import { types } from "node:util"
import { classifyRegistryResponse } from "../adapters/npm.mjs"
import { RECOVERY_LANES, snapshotRecoveryData } from "./schema.mjs"

export const RECOVERY_POLICY_PATH = "scripts/release/recovery/policy.json"
export const RECOVERY_RETRY = Object.freeze({
  readTimeoutMs: 15000,
  transportRetries: 5,
  operationDeadlineMs: 90000,
  maxRetryAfterMs: 15000,
  initialBackoffMs: 1000,
  phaseDeadlineMs: 1200000,
  fenceFreshnessMs: 30000,
})
const REQUIRED_CHECKS = Object.freeze({
  metadata: [
    "cleanup",
    "containment",
    "manifest",
    "official-npm-audit",
    "official-npm-audit-cleanup",
    "registry-packages",
  ],
  "published-harness": [
    "ag-ui",
    "cleanup",
    "cleanup-docker-probe",
    "containment",
    "docker-pid-recovery",
    "exact-install",
    "framework-assertions",
    "manifest",
    "npm-signatures",
    "runtime-assertions",
    "smoke-assertions",
    "temporary-project",
    "typescript-tooling",
  ],
  "runtime-targets": [
    "cleanup",
    "containment",
    "edge-bundle",
    "edge-import",
    "exact-install",
    "node-runtime",
    "probe-files",
    "temporary-project",
  ],
  scaffold: [
    "build",
    "cleanup",
    "containment",
    "dependency-install",
    "exact-versions",
    "runtime",
    "scaffold-create",
    "scaffolder-install",
    "temporary-project",
    "typecheck",
  ],
  storage: [
    "cleanup",
    "cleanup-pgvector",
    "cleanup-postgres",
    "cleanup-project",
    "containment",
    "docker",
    "exact-install",
    "pgvector-database",
    "pgvector-runtime",
    "postgres-database",
    "postgres-runtime",
    "temporary-project",
  ],
})
function requireThat(value, message) {
  if (!value) throw new TypeError(`Invalid recovery policy: ${message}`)
}
function exact(value, keys) {
  requireThat(
    value &&
      !Array.isArray(value) &&
      typeof value === "object" &&
      Object.keys(value).sort().join(" ") === keys.split(" ").sort().join(" "),
    "exact fields required",
  )
}
function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  return value
}
export function canonicalPolicyBytes(value) {
  return Buffer.from(`${JSON.stringify(canonical(snapshotRecoveryData(value, 128 * 1024)))}\n`)
}
export function parseRecoveryPolicy(raw) {
  requireThat(!types.isProxy(raw), "proxy policy forbidden")
  let bytes
  if (typeof raw === "string") {
    requireThat(
      raw.isWellFormed() && Buffer.byteLength(raw) > 0 && Buffer.byteLength(raw) <= 128 * 1024,
      "policy Unicode/byte limit",
    )
    bytes = Buffer.from(raw)
  } else {
    requireThat(
      Buffer.isBuffer(raw) && Object.getPrototypeOf(raw) === Buffer.prototype,
      "plain raw policy bytes required",
    )
    const proto = Object.getPrototypeOf(Uint8Array.prototype)
    const length = Object.getOwnPropertyDescriptor(proto, "byteLength").get.call(raw)
    requireThat(length > 0 && length <= 128 * 1024, "policy byte limit")
    requireThat(
      Reflect.ownKeys(raw).every(
        (key) => typeof key === "string" && /^(0|[1-9][0-9]*)$/u.test(key),
      ),
      "raw policy descriptors forbidden",
    )
    const buffer = Object.getOwnPropertyDescriptor(proto, "buffer").get.call(raw)
    const offset = Object.getOwnPropertyDescriptor(proto, "byteOffset").get.call(raw)
    bytes = Buffer.from(new Uint8Array(buffer, offset, length))
  }
  new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  const p = snapshotRecoveryData(JSON.parse(bytes.toString("utf8")), 128 * 1024)
  // Source formatting is reviewable; authority commits to the canonical sorted token stream.
  // Comparing tokens also rejects duplicate keys rather than trusting JSON.parse's last value.
  let tokens = "",
    inString = false,
    escaped = false
  for (const char of bytes.toString("utf8")) {
    if (inString || !/\s/u.test(char)) tokens += char
    if (escaped) escaped = false
    else if (inString && char === "\\") escaped = true
    else if (char === '"') inString = !inString
  }
  requireThat(
    canonicalPolicyBytes(p).toString() === `${tokens}\n`,
    "canonical policy tokens required",
  )
  exact(
    p,
    "schemaVersion status receiptVersions workflows ci environment lanes verifierClosure fence retry",
  )
  requireThat(
    p.schemaVersion === 2 && ["DORMANT", "ADMITTED"].includes(p.status),
    "supported policy required",
  )
  requireThat(equal(p.receiptVersions, [2]), "supported receipt versions required")
  requireThat(
    equal(p.workflows, [
      ".github/workflows/release-postpublication-audit.yml",
      ".github/workflows/release-postpublication.yml",
    ]),
    "exact recovery workflows required",
  )
  exact(p.ci, "workflow checks")
  requireThat(
    p.ci.workflow === ".github/workflows/ci.yml" &&
      equal(p.ci.checks, ["harness-verify", "pack-smoke", "validate"]),
    "all required main CI jobs required",
  )
  exact(p.environment, "profile node packageManager platform architecture containment dockerImages")
  requireThat(
    p.environment.profile === "recovery-linux-v2" &&
      /^24\.[0-9]+\.[0-9]+$/u.test(p.environment.node) &&
      /^npm@11\.[0-9]+\.[0-9]+$/u.test(p.environment.packageManager) &&
      p.environment.platform === "linux" &&
      p.environment.architecture === "x64" &&
      p.environment.containment === "systemd-cgroup-v2",
    "reviewed environment required",
  )
  requireThat(
    equal(p.environment.dockerImages, ["pgvector/pgvector:pg16", "postgres:16"]),
    "exact Docker image references required",
  )
  requireThat(
    Array.isArray(p.lanes) &&
      equal(
        p.lanes.map((x) => x.name),
        RECOVERY_LANES,
      ),
    "exact five lanes required",
  )
  for (const lane of p.lanes) {
    exact(lane, "name requiredChecks packageChecks")
    requireThat(
      equal(lane.requiredChecks, REQUIRED_CHECKS[lane.name]),
      "mandatory real checks required",
    )
    requireThat(
      lane.packageChecks === (lane.name === "metadata" ? "each-manifest-package" : "none"),
      "manifest-derived package checks required",
    )
  }
  exact(p.verifierClosure, "inputs sha256")
  validateInputs(p.verifierClosure.inputs)
  requireThat(
    (p.verifierClosure.sha256 === null && p.status === "DORMANT") ||
      /^[a-f0-9]{64}$/u.test(p.verifierClosure.sha256),
    "approved verifier digest required",
  )
  exact(p.fence, "concurrencyGroup contracts")
  requireThat(
    p.fence.concurrencyGroup === "dawn-release-controller" &&
      Array.isArray(p.fence.contracts) &&
      p.fence.contracts.length <= 32 &&
      p.fence.contracts.every(
        (x, i, list) => /^[a-f0-9]{64}$/u.test(x) && (i === 0 || list[i - 1] < x),
      ),
    "reviewed fence contracts required",
  )
  requireThat(
    p.status !== "ADMITTED" || p.fence.contracts.length > 0,
    "admission needs a proven legacy fence",
  )
  requireThat(
    canonicalPolicyBytes(p.retry).equals(canonicalPolicyBytes(RECOVERY_RETRY)),
    "central retry budgets required",
  )
  return p
}
function validateInputs(inputs) {
  requireThat(
    Array.isArray(inputs) && inputs.length > 0 && inputs.length <= 512,
    "bounded explicit source closure required",
  )
  requireThat(
    inputs.every(
      (x, i) =>
        typeof x === "string" &&
        x.length <= 512 &&
        /^(?:scripts|test|packages|\.github)\/[A-Za-z0-9._/-]+$/u.test(x) &&
        !x.split("/").some((part) => part === ".." || part === "." || part === "") &&
        x !== RECOVERY_POLICY_PATH &&
        (i === 0 || inputs[i - 1] < x),
    ),
    "sorted unique closure paths without policy self-hash required",
  )
}
export async function hashVerifierClosure(request, readFile) {
  const { controllerSha, inputs } = snapshotRecoveryData(request, 128 * 1024)
  requireThat(
    /^[a-f0-9]{40}$/u.test(controllerSha) &&
      typeof readFile === "function" &&
      !types.isProxy(readFile),
    "immutable source reader required",
  )
  validateInputs(inputs)
  const entries = []
  let total = 0
  for (const path of inputs) {
    const raw = await readFile({ ref: controllerSha, path })
    requireThat(
      typeof raw === "string" && raw.isWellFormed() && Buffer.byteLength(raw) <= 2 * 1024 * 1024,
      "source byte limit",
    )
    total += Buffer.byteLength(raw)
    requireThat(total <= 16 * 1024 * 1024, "closure total byte limit")
    entries.push({ path, sha256: createHash("sha256").update(raw).digest("hex") })
  }
  return createHash("sha256").update(canonicalPolicyBytes(entries)).digest("hex")
}

// Dependency objects are trusted adapters, but accessors/proxies must never run at the boundary.
export function recoveryMethods(object, names) {
  requireThat(
    object &&
      typeof object === "object" &&
      !types.isProxy(object) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(object)),
    "plain adapter required",
  )
  const output = {}
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name)
    requireThat(
      descriptor &&
        Object.hasOwn(descriptor, "value") &&
        typeof descriptor.value === "function" &&
        !types.isProxy(descriptor.value),
      `safe ${name} method required`,
    )
    output[name] = Reflect.apply(Function.prototype.bind, descriptor.value, [object])
  }
  return output
}
function retryable(result, metadataPresent) {
  // The shared HTTP adapter can report a timeout/cancellation before its
  // underlying transport settles. Neither envelope proves safe retry admission.
  if (["TIMEOUT", "ABORTED"].includes(result.code)) return false
  if (
    result.httpStatus === null &&
    ["TRANSPORT_ERROR", "NETWORK_ERROR", "FETCH_FAILED"].includes(result.code)
  )
    return true
  // Accept only normalized, completed transient response classes. In particular,
  // npm can retain a deterministic transport code under AMBIGUOUS plus HTTP 503;
  // the HTTP status alone must never erase that failure provenance.
  if (result.status === "AMBIGUOUS") {
    if (result.code === "RATE_LIMITED") return true
    const transientStatus = [408, 429, 500, 502, 503, 504].includes(result.httpStatus)
    if (
      transientStatus &&
      (result.code === `HTTP_${result.httpStatus}` ||
        (result.code === "SERVER_ERROR" && result.httpStatus >= 500))
    )
      return true
  }
  if (
    !metadataPresent ||
    result.operation !== "package-tarball" ||
    result.httpStatus !== 404 ||
    !["ABSENT", "AMBIGUOUS"].includes(result.status) ||
    result.code !== "HTTP_404"
  )
    return false
  // Same metadata-present tarball-only propagation class as publisher.mjs.
  return (
    classifyRegistryResponse({
      operation: "package-tarball",
      response: { status: result.httpStatus },
      body: null,
    }).status === "AMBIGUOUS"
  )
}
export async function runRecoveryRead(
  options,
  operation,
  dependencies = {
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
) {
  options = snapshotRecoveryData(options, 4096)
  requireThat(
    Object.keys(options).every((key) =>
      ["phaseDeadline", "registryMetadataPresent"].includes(key),
    ) &&
      Number.isSafeInteger(options.phaseDeadline) &&
      options.phaseDeadline >= 0 &&
      (!Object.hasOwn(options, "registryMetadataPresent") ||
        typeof options.registryMetadataPresent === "boolean"),
    "read options required",
  )
  requireThat(
    typeof operation === "function" && !types.isProxy(operation),
    "safe read operation required",
  )
  const { now, sleep } = recoveryMethods(dependencies, ["now", "sleep"])
  const timers =
    Object.hasOwn(dependencies, "setTimer") || Object.hasOwn(dependencies, "clearTimer")
      ? recoveryMethods(dependencies, ["setTimer", "clearTimer"])
      : { setTimer: setTimeout, clearTimer: clearTimeout }
  const started = now()
  requireThat(Number.isSafeInteger(started) && started >= 0, "clock required")
  const deadline = Math.min(options.phaseDeadline, started + RECOVERY_RETRY.operationDeadlineMs)
  const exhausted = () => ({ status: "ERROR", code: "RECOVERY_DEADLINE", httpStatus: null })
  for (let attempt = 0; attempt <= RECOVERY_RETRY.transportRetries; attempt++) {
    const remaining = deadline - now()
    if (remaining <= 0) return exhausted()
    const timeoutMs = Math.min(RECOVERY_RETRY.readTimeoutMs, remaining)
    const abort = new AbortController()
    let timer
    let result
    let unsettledTimeout = false
    try {
      result = await Promise.race([
        Promise.resolve().then(() => operation({ timeoutMs, signal: abort.signal })),
        new Promise((resolve) => {
          timer = timers.setTimer(() => {
            unsettledTimeout = true
            abort.abort()
            resolve({ status: "ERROR", code: "READ_TIMEOUT_UNSETTLED", httpStatus: null })
          }, timeoutMs)
        }),
      ])
    } finally {
      timers.clearTimer(timer)
    }
    if (unsettledTimeout) return result
    result = snapshotRecoveryData(result)
    if (now() >= deadline) return exhausted()
    if (
      !retryable(result, options.registryMetadataPresent === true) ||
      attempt === RECOVERY_RETRY.transportRetries
    )
      return result
    const delay = Math.max(
      Math.min(1000 * 2 ** attempt, RECOVERY_RETRY.maxRetryAfterMs),
      Number.isSafeInteger(result.retryAfterMs) && result.retryAfterMs >= 0
        ? Math.min(result.retryAfterMs, RECOVERY_RETRY.maxRetryAfterMs)
        : 0,
    )
    if (now() + delay >= deadline) return exhausted()
    let backoffTimer
    let backoffExpired = false
    try {
      await Promise.race([
        Promise.resolve().then(() => sleep(delay)),
        new Promise((resolve) => {
          backoffTimer = timers.setTimer(() => {
            backoffExpired = true
            resolve()
          }, deadline - now())
        }),
      ])
    } finally {
      timers.clearTimer(backoffTimer)
    }
    if (backoffExpired || now() >= deadline) return exhausted()
  }
}
