// Dormant v2 wire contract. Original v1 evidence is referenced, never re-serialized.
import { createHash } from "node:crypto"
import { types } from "node:util"
import { RELEASE_PAYLOAD_LIMITS } from "../limits.mjs"
import { isExactSemver, parseSemver } from "../semver.mjs"

export const RECOVERY_PHASES = Object.freeze([
  "RECOVERY_ADOPTED",
  "VERIFICATION_COMPLETE",
  "AUDIT_PENDING",
  "AUDIT_VERIFIED",
  "PUBLICATION_READY",
])
export const RECOVERY_LANES = Object.freeze([
  "metadata",
  "published-harness",
  "runtime-targets",
  "scaffold",
  "storage",
])
export const RECOVERY_LIMITS = Object.freeze({
  receiptBytes: 256 * 1024,
  selectionBytes: 1024 * 1024,
  retainedAssets: 2048,
  retainedBytes: 64 * 1024 * 1024,
  resolutionBytes: 64 * 1024,
  resolutions: 512,
  checks: 256,
  depth: 24,
  nodes: 100_000,
  originalAssets: 4096,
})
const FIELDS = {
  "recovery-adoption-intent": "legacyBodySha256 legacyPhase policySha256 operations",
  "recovery-marker": "revision phase policySha256 adoption verificationSet audit finalization",
  "recovery-adoption":
    "policySha256 authority executor archive baseAssets npmEvidence retainedAttempts",
  "recovery-lane":
    "policySha256 lane executor environment startedAt finishedAt checks resolutions conclusion",
  "recovery-verification-set": "policySha256 executor lanes provenance retainedReceipts conclusion",
  "recovery-audit-intent":
    "policySha256 requestId expectedAuditorSha verificationSetSha256 inventory executor",
  "recovery-audit-dispatch": "requestId intentSha256 runId expectedAuditorSha executor",
  "recovery-audit-result":
    "policySha256 requestId verificationSetSha256 inventorySha256 executor checks conclusion",
  "recovery-finalization": "policySha256 adoption verificationSet audit assets metadata",
  "recovery-run-result": "executor before after outcome effects evidence nextAction errors",
}
const sha = /^[a-f0-9]{40}$/u
const hash = /^[a-f0-9]{64}$/u
const decimal = /^[1-9][0-9]{0,31}$/u
const identifier = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const assetName = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,511}$/u
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const workflow = /^\.github\/workflows\/[a-z0-9][a-z0-9_-]*\.ya?ml$/u
const phases = ["UNKNOWN", "NPM_COMPLETE", ...RECOVERY_PHASES, "COMPLETE"]
const operations = ["adopt", "audit", "finalize", "publish", "verify"]
const effectOperations = [
  "adopt",
  "smoke",
  "dispatch-audit",
  "audit",
  "finalize",
  "publish",
  "write-marker",
]
function requireThat(value, message) {
  if (!value) throw new TypeError(`Invalid recovery evidence: ${message}`)
}
function exact(value, fields) {
  requireThat(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "expected object",
  )
  const keys = fields === "" ? [] : fields.split(" ")
  requireThat(
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
    `exact fields (${fields}) required`,
  )
}
function text(value, pattern, label, maximum = 512) {
  requireThat(
    typeof value === "string" && Buffer.byteLength(value) <= maximum && pattern.test(value),
    label,
  )
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  requireThat(
    Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max,
    "integer bounds",
  )
}
function enumeration(value, allowed) {
  requireThat(allowed.includes(value), `expected ${allowed.join("|")}`)
}
function same(left, right, label) {
  requireThat(JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right)), label)
}
function timestamp(value) {
  text(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u, "UTC timestamp")
  requireThat(
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    "valid UTC timestamp",
  )
}
function version(value) {
  requireThat(
    isExactSemver(value) && parseSemver(value).build.length === 0 && value.length <= 128,
    "exact version without build metadata",
  )
}
function list(value, maximum, validate, key = null, minimum = 0) {
  requireThat(
    Array.isArray(value) && value.length >= minimum && value.length <= maximum,
    "array count limit",
  )
  let previous = null
  for (const item of value) {
    validate(item)
    if (key) {
      const identity = key(item)
      requireThat(previous === null || previous < identity, "identities must be sorted and unique")
      previous = identity
    }
  }
}
function candidate(value) {
  exact(
    value,
    "repository repositoryId version candidateSha tag tagObjectSha releaseId manifestSha256 releaseRecordSha256",
  )
  text(
    value.repository,
    /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9][a-z0-9._-]{0,99}$/u,
    "canonical repository",
  )
  for (const field of ["repositoryId", "releaseId"]) text(value[field], decimal, field)
  version(value.version)
  requireThat(value.tag === `v${value.version}`, "exact candidate tag")
  for (const field of ["candidateSha", "tagObjectSha"]) text(value[field], sha, field)
  for (const field of ["manifestSha256", "releaseRecordSha256"]) text(value[field], hash, field)
}
function executor(value) {
  exact(value, "controllerSha verifierClosureSha256 workflow runId runAttempt jobId")
  text(value.controllerSha, sha, "executor SHA")
  text(value.verifierClosureSha256, hash, "executor closure")
  text(value.workflow, workflow, "executor workflow")
  for (const field of ["runId", "runAttempt", "jobId"]) text(value[field], decimal, field)
}
function sameRun(left, right) {
  for (const field of ["controllerSha", "verifierClosureSha256", "workflow", "runId", "runAttempt"])
    same(left[field], right[field], `executor ${field} mismatch`)
}
function ref(value, recovery = false) {
  exact(value, "assetName id sha256 size")
  text(value.assetName, assetName, "asset name")
  if (recovery)
    requireThat(value.assetName.startsWith("recovery-v2-"), "recovery namespace required")
  text(value.id, decimal, "asset ID")
  text(value.sha256, hash, "asset digest")
  integer(
    value.size,
    1,
    recovery ? RECOVERY_LIMITS.selectionBytes : RELEASE_PAYLOAD_LIMITS.escrowBytes,
  )
}
function inventory(value, mode = "all") {
  let originalBytes = 0
  let recoveryBytes = 0
  let originalCount = 0
  let recoveryCount = 0
  let tarballBytes = 0
  let bundleBytes = 0
  let smokeBytes = 0
  const ids = new Set()
  list(
    value,
    RECOVERY_LIMITS.originalAssets + RECOVERY_LIMITS.retainedAssets,
    (item) => {
      const recovery = item.assetName?.startsWith("recovery-v2-")
      ref(item, mode === "recovery")
      requireThat(mode !== "original" || !recovery, "original namespace required")
      requireThat(!ids.has(item.id), "duplicate asset ID")
      ids.add(item.id)
      if (recovery) {
        recoveryCount++
        recoveryBytes += item.size
        requireThat(item.size <= RECOVERY_LIMITS.selectionBytes, "recovery asset byte limit")
      } else {
        originalCount++
        originalBytes += item.size
        let limit
        if (item.assetName === "manifest.json") limit = RELEASE_PAYLOAD_LIMITS.manifestBytes
        else if (item.assetName === "release-record.json")
          limit = RELEASE_PAYLOAD_LIMITS.releaseRecordBytes
        else if (item.assetName.endsWith(".tgz")) {
          limit = RELEASE_PAYLOAD_LIMITS.tarballBytes
          tarballBytes += item.size
        } else if (
          item.assetName === "manifest.json.intoto.jsonl" ||
          item.assetName.endsWith(".tgz.intoto.jsonl")
        ) {
          limit = RELEASE_PAYLOAD_LIMITS.attestationBundleBytes
          bundleBytes += item.size
        } else if (
          /^smoke-result-(metadata|published-harness|runtime-targets|scaffold|storage)-[1-9][0-9]*-[1-9][0-9]*\.json$/u.test(
            item.assetName,
          )
        ) {
          limit = RELEASE_PAYLOAD_LIMITS.smokeReceiptBytes
          smokeBytes += item.size
        } else if (
          item.assetName === "audit-result.json" ||
          /^audit-attempt-[1-9][0-9]*-[1-9][0-9]*\.json$/u.test(item.assetName)
        )
          limit = RELEASE_PAYLOAD_LIMITS.auditReceiptBytes
        else throw new TypeError("Invalid recovery evidence: unknown original asset namespace")
        requireThat(item.size <= limit, "original asset byte limit")
      }
    },
    (item) => item.assetName,
  )
  requireThat(
    tarballBytes <= RELEASE_PAYLOAD_LIMITS.preparedTarballsBytes &&
      bundleBytes <= RELEASE_PAYLOAD_LIMITS.attestationBundlesBytes &&
      smokeBytes <= RELEASE_PAYLOAD_LIMITS.smokeReceiptsBytes,
    "original payload group limit",
  )
  requireThat(
    originalBytes <= RELEASE_PAYLOAD_LIMITS.escrowBytes &&
      originalCount <= RECOVERY_LIMITS.originalAssets,
    "original inventory limit",
  )
  requireThat(
    recoveryBytes <= RECOVERY_LIMITS.retainedBytes &&
      recoveryCount <= RECOVERY_LIMITS.retainedAssets,
    "retained inventory limit",
  )
}
function checks(value, conclusion, cleanup = false) {
  list(
    value,
    RECOVERY_LIMITS.checks,
    (item) => {
      exact(item, "name conclusion")
      text(item.name, identifier, "check name")
      enumeration(item.conclusion, ["success", "failure", "cancelled", "skipped"])
    },
    (item) => item.name,
    1,
  )
  if (cleanup)
    requireThat(
      value.some((item) => item.name === "cleanup"),
      "cleanup check required",
    )
  const derived = value.every((item) => item.conclusion === "success") ? "success" : "failure"
  requireThat(conclusion === derived, "conclusion must derive from all checks")
}
function npmEvidence(value, subject) {
  exact(value, "manifestSha256 packages conclusion")
  same(value.manifestSha256, subject.manifestSha256, "npm manifest mismatch")
  list(
    value.packages,
    RECOVERY_LIMITS.originalAssets,
    (item) => {
      exact(item, "name version sourceSha integrity tarballSha256 conclusion")
      text(item.name, packageName, "package name")
      same(item.version, subject.version, "npm version mismatch")
      same(item.sourceSha, subject.candidateSha, "npm source mismatch")
      integrity(item.integrity)
      text(item.tarballSha256, hash, "tarball digest")
      enumeration(item.conclusion, ["success", "failure"])
    },
    (item) => item.name,
    1,
  )
  requireThat(
    value.conclusion ===
      (value.packages.every((item) => item.conclusion === "success") ? "success" : "failure"),
    "npm conclusion derivation",
  )
}
function integrity(value) {
  text(value, /^sha512-[A-Za-z0-9+/]{86}==$/u, "sha512 integrity")
  requireThat(
    Buffer.from(value.slice(7), "base64").toString("base64") === value.slice(7),
    "canonical integrity",
  )
}
function contains(assets, receipt) {
  requireThat(
    assets.some(
      (item) => JSON.stringify(canonicalize(item)) === JSON.stringify(canonicalize(receipt)),
    ),
    "selected receipt missing from inventory",
  )
}
function validate(value) {
  requireThat(Object.hasOwn(FIELDS, value.kind), "unknown kind")
  exact(value, `schemaVersion kind candidate ${FIELDS[value.kind]}`)
  requireThat(value.schemaVersion === 2, "unsupported schema version")
  candidate(value.candidate)
  if (Object.hasOwn(value, "policySha256")) text(value.policySha256, hash, "policy digest")
  if (Object.hasOwn(value, "executor")) executor(value.executor)
  switch (value.kind) {
    case "recovery-adoption-intent":
      text(value.legacyBodySha256, hash, "legacy body digest")
      requireThat(value.legacyPhase === "NPM_COMPLETE", "adoption start phase")
      list(
        value.operations,
        operations.length,
        (item) => enumeration(item, operations),
        (item) => item,
        1,
      )
      break
    case "recovery-marker": {
      integer(value.revision, 1)
      enumeration(value.phase, RECOVERY_PHASES)
      const index = RECOVERY_PHASES.indexOf(value.phase)
      for (const [field, required] of [
        ["adoption", true],
        ["verificationSet", index >= 1],
        ["audit", index >= 2],
        ["finalization", index >= 4],
      ]) {
        if (required) ref(value[field], true)
        else requireThat(value[field] === null, `${field} must be explicitly absent`)
      }
      if (index >= 4)
        requireThat(
          value.finalization.assetName === "recovery-v2-finalization.json",
          "fixed finalization name",
        )
      break
    }
    case "recovery-adoption":
      exact(value.authority, "intentPath intentSha256 reviewedControllerSha")
      text(
        value.authority.intentPath,
        /^scripts\/release\/recovery-adoptions\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u,
        "git intent path",
      )
      text(value.authority.intentSha256, hash, "intent digest")
      same(
        value.authority.reviewedControllerSha,
        value.executor.controllerSha,
        "reviewed executor mismatch",
      )
      ref(value.archive, true)
      requireThat(
        value.archive.assetName ===
          `recovery-v2-legacy-${value.candidate.version}-${value.archive.sha256}.txt`,
        "digest-qualified archive name",
      )
      inventory(value.baseAssets, "original")
      requireThat(value.baseAssets.length >= 2, "original manifest and record required")
      requireThat(
        value.baseAssets.some(
          (item) =>
            item.assetName === "manifest.json" && item.sha256 === value.candidate.manifestSha256,
        ),
        "original manifest binding",
      )
      requireThat(
        value.baseAssets.some(
          (item) =>
            item.assetName === "release-record.json" &&
            item.sha256 === value.candidate.releaseRecordSha256,
        ),
        "original record binding",
      )
      npmEvidence(value.npmEvidence, value.candidate)
      inventory(value.retainedAttempts, "recovery")
      break
    case "recovery-lane":
      enumeration(value.lane, RECOVERY_LANES)
      exact(value.environment, "profile node packageManager platform architecture dockerImages")
      text(value.environment.profile, identifier, "environment profile")
      version(value.environment.node)
      text(
        value.environment.packageManager,
        /^(?:npm|pnpm)@[0-9]+\.[0-9]+\.[0-9]+$/u,
        "package manager",
      )
      text(value.environment.platform, identifier, "platform")
      text(value.environment.architecture, identifier, "architecture")
      list(
        value.environment.dockerImages,
        32,
        (item) => {
          exact(item, "reference digest")
          text(item.reference, /^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/u, "image reference")
          text(item.digest, /^sha256:[a-f0-9]{64}$/u, "image digest")
        },
        (item) => item.reference,
      )
      timestamp(value.startedAt)
      timestamp(value.finishedAt)
      requireThat(value.startedAt <= value.finishedAt, "timestamp order")
      checks(value.checks, value.conclusion, true)
      list(
        value.resolutions,
        RECOVERY_LIMITS.resolutions,
        (item) => {
          exact(item, "installPath subject name requested resolved source integrity")
          text(
            item.installPath,
            /^node_modules\/(?:[A-Za-z0-9@][A-Za-z0-9._@-]*\/)*[A-Za-z0-9@][A-Za-z0-9._@-]*$/u,
            "relative installation path",
            2048,
          )
          requireThat(
            item.installPath.endsWith(`/${item.name}`),
            "installation identity matches package",
          )
          requireThat(typeof item.subject === "boolean", "subject classification")
          text(item.name, packageName, "resolution package")
          text(item.requested, /^[^\p{Cc}]+$/u, "requested selector", 1024)
          version(item.resolved)
          if (item.subject) {
            same(item.requested, value.candidate.version, "subject exact requested version")
            same(item.resolved, value.candidate.version, "subject resolved version")
          }
          enumeration(item.source, ["registry", "verified-payload"])
          integrity(item.integrity)
        },
        (item) => item.installPath,
        1,
      )
      requireThat(
        value.resolutions.some((item) => item.subject),
        "subject resolution required",
      )
      requireThat(
        Buffer.byteLength(JSON.stringify(value.resolutions)) <= RECOVERY_LIMITS.resolutionBytes,
        "resolution details byte limit",
      )
      break
    case "recovery-verification-set": {
      list(
        value.lanes,
        RECOVERY_LANES.length,
        (item) => {
          exact(item, "lane receipt executor conclusion")
          enumeration(item.lane, RECOVERY_LANES)
          ref(item.receipt, true)
          executor(item.executor)
          sameRun(item.executor, value.executor)
          enumeration(item.conclusion, ["success", "failure"])
        },
        (item) => item.lane,
        RECOVERY_LANES.length,
      )
      same(
        value.lanes.map((item) => item.lane),
        RECOVERY_LANES,
        "exact five lanes required",
      )
      list(
        value.provenance,
        RECOVERY_LANES.length,
        (item) => {
          exact(item, "lane executor artifactId serviceDigest receiptSha256 conclusion validatedAt")
          enumeration(item.lane, RECOVERY_LANES)
          executor(item.executor)
          text(item.artifactId, decimal, "artifact ID")
          text(item.serviceDigest, /^sha256:[a-f0-9]{64}$/u, "service digest")
          text(item.receiptSha256, hash, "raw receipt digest")
          enumeration(item.conclusion, ["success", "failure"])
          timestamp(item.validatedAt)
          const lane = value.lanes.find((lane) => lane.lane === item.lane)
          same(item.executor, lane.executor, "API executor correlation")
          same(item.receiptSha256, lane.receipt.sha256, "API raw receipt correlation")
          same(item.conclusion, lane.conclusion, "API job conclusion correlation")
        },
        (item) => item.lane,
        RECOVERY_LANES.length,
      )
      requireThat(
        new Set(value.lanes.map((item) => item.executor.jobId)).size === RECOVERY_LANES.length,
        "distinct lane job identities required",
      )
      requireThat(
        new Set(value.provenance.map((item) => item.artifactId)).size === value.provenance.length,
        "duplicate artifact identity",
      )
      requireThat(
        new Set(value.lanes.map((item) => item.receipt.id)).size === value.lanes.length &&
          new Set(value.lanes.map((item) => item.receipt.assetName)).size === value.lanes.length,
        "duplicate lane receipt",
      )
      requireThat(
        value.conclusion ===
          (value.lanes.every((item) => item.conclusion === "success") ? "success" : "failure"),
        "set conclusion derivation",
      )
      inventory(value.retainedReceipts, "recovery")
      requireThat(
        !value.retainedReceipts.some((item) =>
          value.lanes.some(
            (lane) => lane.receipt.id === item.id || lane.receipt.assetName === item.assetName,
          ),
        ),
        "selected and retained receipt overlap",
      )
      break
    }
    case "recovery-audit-intent":
      text(value.requestId, identifier, "audit request ID")
      text(value.expectedAuditorSha, sha, "expected auditor SHA")
      text(value.verificationSetSha256, hash, "selected set digest")
      inventory(value.inventory)
      requireThat(
        value.inventory.some(
          (item) =>
            item.sha256 === value.verificationSetSha256 &&
            item.assetName.startsWith("recovery-v2-verification-set-"),
        ),
        "selected set missing from audit inventory",
      )
      requireThat(
        !value.inventory.some((item) => item.assetName === "recovery-v2-finalization.json"),
        "finalization cannot be audited recursively",
      )
      break
    case "recovery-audit-dispatch":
      text(value.requestId, identifier, "audit request ID")
      text(value.intentSha256, hash, "intent digest")
      text(value.runId, decimal, "audit run ID")
      text(value.expectedAuditorSha, sha, "auditor SHA")
      requireThat(value.runId !== value.executor.runId, "audit run must be independent")
      break
    case "recovery-audit-result":
      text(value.requestId, identifier, "request ID")
      text(value.verificationSetSha256, hash, "selected set digest")
      text(value.inventorySha256, hash, "audited inventory digest")
      checks(value.checks, value.conclusion)
      break
    case "recovery-finalization":
      for (const field of ["adoption", "verificationSet", "audit"]) ref(value[field], true)
      inventory(value.assets)
      requireThat(
        !value.assets.some((item) => item.assetName === "recovery-v2-finalization.json"),
        "finalization excludes itself",
      )
      for (const field of ["adoption", "verificationSet", "audit"])
        contains(value.assets, value[field])
      exact(value.metadata, "title body markerRevision")
      text(value.metadata.title, /^[^\r\n]+$/u, "final title", 1024)
      text(value.metadata.body, /^[\s\S]*$/u, "semantic body", 128 * 1024)
      integer(value.metadata.markerRevision, 1)
      break
    case "recovery-run-result": {
      enumeration(value.before, phases)
      enumeration(value.after, phases)
      enumeration(value.outcome, [
        "advanced",
        "planned",
        "blocked",
        "waiting",
        "complete",
        "unchanged",
      ])
      list(value.effects, 8, (item) => {
        exact(item, "operation target")
        enumeration(item.operation, effectOperations)
        text(item.target, /^[A-Za-z0-9._:-]+$/u, "effect target")
        if (item.operation === "write-marker") enumeration(item.target, RECOVERY_PHASES)
      })
      inventory(value.evidence, "recovery")
      text(value.nextAction, /^[a-z][a-z-]*$/u, "next action")
      list(value.errors, 32, (item) => text(item, /^[^\p{Cc}]+$/u, "error", 4096))
      requireThat(
        !["blocked", "waiting", "complete", "unchanged"].includes(value.outcome) ||
          value.effects.length === 0,
        "terminal or blocked effects",
      )
      requireThat(
        !["blocked", "waiting", "unchanged"].includes(value.outcome) ||
          value.before === value.after,
        "unproven observed phase",
      )
      requireThat(
        (value.outcome === "complete") === (value.after === "COMPLETE"),
        "completion outcome must match derived COMPLETE",
      )
      requireThat(
        value.outcome === "blocked" ? value.errors.length > 0 : value.errors.length === 0,
        "outcome error consistency",
      )
      if (["advanced", "planned"].includes(value.outcome))
        requireThat(value.effects.length > 0, "work outcome requires effects")
      if (["advanced", "unchanged", "complete"].includes(value.outcome))
        requireThat(value.evidence.length > 0, "successful observed outcome requires evidence")
      const finalProof = value.evidence.some(
        (item) => item.assetName === "recovery-v2-finalization.json",
      )
      if (value.outcome === "complete")
        requireThat(finalProof, "completion requires immutable finalization evidence")
      requireThat(
        value.before !== "COMPLETE" || (value.after === "COMPLETE" && value.outcome === "complete"),
        "terminal completion cannot reopen",
      )
      requireThat(
        value.effects.every(
          (item) => item.operation !== "write-marker" || item.target === value.after,
        ),
        "every marker mutation must match the reported ending phase",
      )
      const normalAdvance =
        value.before !== "UNKNOWN" &&
        phases.indexOf(value.after) === phases.indexOf(value.before) + 1 &&
        value.after !== "COMPLETE"
      const readinessRepair =
        value.after === "PUBLICATION_READY" &&
        finalProof &&
        value.effects.some(
          (item) => item.operation === "write-marker" && item.target === "PUBLICATION_READY",
        )
      if (value.outcome === "advanced") {
        requireThat(
          normalAdvance || readinessRepair,
          "observed advancement requires a supported transition or proven readiness repair",
        )
        requireThat(
          value.effects.some(
            (item) => item.operation === "write-marker" && item.target === value.after,
          ),
          "observed marker advancement requires matching completed mutation",
        )
      }
      if (value.outcome === "planned")
        requireThat(
          value.after === value.before || normalAdvance || readinessRepair,
          "planned transition is unsupported",
        )
      requireThat(
        value.after !== "UNKNOWN" || (value.before === "UNKNOWN" && value.outcome === "blocked"),
        "UNKNOWN is only a blocked observation",
      )
      break
    }
  }
}

// Shared by the pure planner: inspect descriptors before values, with bounds before descent.
export function snapshotRecoveryData(input, maximumBytes = RECOVERY_LIMITS.selectionBytes) {
  let nodes = 0
  let bytes = 0
  const ancestors = new Set()
  function visit(value, depth) {
    requireThat(!types.isProxy(value), "proxy data is forbidden")
    requireThat(
      depth <= RECOVERY_LIMITS.depth && ++nodes <= RECOVERY_LIMITS.nodes,
      "snapshot depth/node limit",
    )
    if (value === null || typeof value === "boolean") {
      bytes += 5
      requireThat(bytes <= maximumBytes, "snapshot byte limit")
      return value
    }
    if (typeof value === "string") {
      requireThat(value.isWellFormed(), "unpaired Unicode surrogate")
      bytes += Buffer.byteLength(value) + 2
      requireThat(bytes <= maximumBytes, "snapshot byte limit")
      return value
    }
    if (typeof value === "number") {
      requireThat(Number.isFinite(value) && !Object.is(value, -0), "finite canonical number")
      bytes += 24
      requireThat(bytes <= maximumBytes, "snapshot byte limit")
      return value
    }
    requireThat(
      value !== null && typeof value === "object" && !ancestors.has(value),
      "non-JSON value or cycle",
    )
    requireThat(
      Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null ||
        (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype),
      "plain data required",
    )
    ancestors.add(value)
    const keys = Reflect.ownKeys(value)
    requireThat(keys.length <= RECOVERY_LIMITS.nodes - nodes, "snapshot width limit")
    const array = Array.isArray(value)
    const result = array ? [] : {}
    if (array)
      requireThat(keys.length === value.length + 1, "dense array without extra fields required")
    for (const key of keys) {
      if (array && key === "length") continue
      requireThat(typeof key === "string" && key.isWellFormed(), "string keys required")
      if (array)
        requireThat(/^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < value.length, "array field")
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      requireThat(
        Object.hasOwn(descriptor, "value") && descriptor.enumerable,
        "accessors/hidden fields forbidden",
      )
      bytes += Buffer.byteLength(key) + 4
      requireThat(bytes <= maximumBytes, "snapshot byte limit")
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    ancestors.delete(value)
    return Object.freeze(result)
  }
  return visit(input, 0)
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  return value
}
function bytesFor(value) {
  return Buffer.from(`${JSON.stringify(canonicalize(value))}\n`, "utf8")
}
export function parseRecovery(input, options = {}) {
  requireThat(!types.isProxy(input), "proxy input is forbidden")
  options = snapshotRecoveryData(options, 16 * 1024)
  requireThat(
    options !== null &&
      !Array.isArray(options) &&
      typeof options === "object" &&
      Object.keys(options).every((key) => ["kind", "candidate", "executor"].includes(key)),
    "exact parser options",
  )
  let raw = null
  if (typeof input === "string" || input instanceof Uint8Array) {
    if (typeof input === "string") {
      requireThat(
        input.isWellFormed() && Buffer.byteLength(input, "utf8") <= RECOVERY_LIMITS.selectionBytes,
        "raw string Unicode/byte limit",
      )
      raw = Buffer.from(input, "utf8")
    } else {
      requireThat(
        Object.getPrototypeOf(input) === Buffer.prototype ||
          Object.getPrototypeOf(input) === Uint8Array.prototype,
        "plain raw bytes required",
      )
      const typedArray = Object.getPrototypeOf(Uint8Array.prototype)
      const length = Object.getOwnPropertyDescriptor(typedArray, "byteLength").get.call(input)
      requireThat(length > 0 && length <= RECOVERY_LIMITS.selectionBytes, "raw byte limit")
      requireThat(
        Reflect.ownKeys(input).every(
          (key) => typeof key === "string" && /^(0|[1-9][0-9]*)$/u.test(key),
        ),
        "raw byte descriptors forbidden",
      )
      const buffer = Object.getOwnPropertyDescriptor(typedArray, "buffer").get.call(input)
      const offset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset").get.call(input)
      raw = Buffer.from(new Uint8Array(buffer, offset, length))
    }
    requireThat(raw.length > 0 && raw.length <= RECOVERY_LIMITS.selectionBytes, "raw byte limit")
    let decoded
    try {
      decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw)
    } catch {
      throw new TypeError("Invalid recovery UTF8")
    }
    input = JSON.parse(decoded)
  }
  const value = snapshotRecoveryData(input)
  validate(value)
  const bytes = bytesFor(value)
  const maximum = ["recovery-verification-set", "recovery-finalization"].includes(value.kind)
    ? RECOVERY_LIMITS.selectionBytes
    : RECOVERY_LIMITS.receiptBytes
  requireThat(bytes.length <= maximum, "kind byte limit")
  if (raw !== null) requireThat(raw.equals(bytes), "canonical raw byte equality required")
  if (options.kind !== undefined) same(value.kind, options.kind, "requested kind mismatch")
  if (options.candidate !== undefined)
    same(value.candidate, snapshotRecoveryData(options.candidate), "candidate identity mismatch")
  if (options.executor !== undefined) {
    requireThat(value.executor !== undefined, "wire has no executor")
    same(value.executor, snapshotRecoveryData(options.executor), "executor identity mismatch")
  }
  return value
}
export function canonicalRecoveryBytes(value) {
  return bytesFor(parseRecovery(value))
}
export function recoveryDigest(value) {
  return createHash("sha256").update(canonicalRecoveryBytes(value)).digest("hex")
}
