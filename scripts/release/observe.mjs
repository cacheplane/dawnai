import { createHash } from "node:crypto"
import { canonicalAbandonmentBytes, parseAbandonmentReleaseBody } from "./abandonment.mjs"
import { normalizeAdapterEnvelope, snapshotJson } from "./adapter-normalize.mjs"
import { extractActionsArtifactZip } from "./artifact-store.mjs"
import { discoverManagedCandidate, discoverScheduledCandidate } from "./candidate.mjs"
import { assertValidReleaseInventory, readReleaseInventory } from "./inventory.mjs"
import { assertPayloadByteLength, RELEASE_PAYLOAD_LIMITS } from "./limits.mjs"
import {
  CANONICAL_RELEASE_PACKAGE_ORDER,
  canonicalManifestBytes,
  manifestSha256,
  parseSealedReleaseManifest,
} from "./manifest.mjs"
import {
  canonicalReleaseBody,
  isManagedReleaseForTag,
  MAX_AUDIT_ATTEMPTS,
  MAX_PUBLICATION_ASSETS,
  MAX_SMOKE_ASSETS,
  MAX_SMOKE_ATTEMPTS,
  parseReleaseMarker,
  parseSmokeReleaseAssetName,
  validatePublicationAuditAssets,
  verifyReleaseAttestationAnchor,
} from "./metadata.mjs"
import { NPM_AUDIT_VERIFIER } from "./npm-audit.mjs"
import { canonicalNpmEvidenceBytes } from "./npm-evidence.mjs"
import {
  canonicalReleaseRecordBytes,
  parseReleaseRecord,
  releaseRecordSha256,
} from "./release-record.mjs"
import { compareSemver, isExactSemver, parseSemver } from "./semver.mjs"
import {
  aggregateSmokeResults,
  canonicalAggregateSmokeResultBytes,
  parseSmokeResult,
  REQUIRED_RELEASE_SMOKE_LANES,
} from "./smoke-result.mjs"
import { ReleaseState } from "./state.mjs"
import { readTerminalRecord } from "./terminal-record-store.mjs"
import { canonicalAuditResultBytes, parseAuditResult } from "./terminal-records.mjs"

const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const ACTIONS_RUN_STATUSES = Object.freeze([
  "requested",
  "waiting",
  "pending",
  "queued",
  "in_progress",
  "completed",
])
const ACTIONS_TERMINAL_CONCLUSIONS = Object.freeze([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
])
const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const DEFAULT_CANDIDATE_POLICY = Object.freeze({
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})
const REQUIRED_SMOKE_LANES = REQUIRED_RELEASE_SMOKE_LANES
const ACTIVE_PACKAGE_NAMES = Object.freeze([...CANONICAL_RELEASE_PACKAGE_ORDER].sort(compareText))
const PRODUCTION_SELECTION_STATES = new Set(Object.values(ReleaseState))
const PRODUCTION_SELECTION_DISPOSITIONS = new Set(["selected", "blocked", "audit-only", "noop"])
const MAX_ACTIONS_ARTIFACT_CANDIDATES = 16
const MAX_ACTIONS_OBSERVATION_BYTES = RELEASE_PAYLOAD_LIMITS.actionsArchiveBytes * 2

export function classifyProductionEvent(value) {
  const event = snapshotJson(value)
  if (!isRecord(event)) throw new TypeError("Production release event must be one JSON object")
  const scheduled = Object.hasOwn(event, "schedule")
  const pushed = Object.hasOwn(event, "after")
  const dispatched = Object.hasOwn(event, "inputs")
  if (Number(scheduled) + Number(pushed) + Number(dispatched) !== 1) {
    throw new TypeError("Production release event candidate source is ambiguous")
  }
  if (scheduled) {
    if (typeof event.schedule !== "string" || event.schedule.length === 0) {
      throw new TypeError("Production release schedule is invalid")
    }
    return deepFreeze({ kind: "scheduled", ref: null, expectedVersion: null })
  }
  if (pushed) {
    if (event.ref !== "refs/heads/main" || !isSha(event.after)) {
      throw new TypeError("Production release push event is not exact main")
    }
    return deepFreeze({
      kind: "exact-ref",
      ref: event.after,
      expectedVersion: null,
    })
  }
  if (
    !isRecord(event.inputs) ||
    !hasExactKeys(event.inputs, ["version", "commitSha"]) ||
    !isReleaseVersion(event.inputs.version) ||
    !isSha(event.inputs.commitSha)
  ) {
    throw new TypeError("Production release dispatch inputs are invalid")
  }
  return deepFreeze({
    kind: "exact-ref",
    ref: event.inputs.commitSha,
    expectedVersion: event.inputs.version,
  })
}

export async function resolveProductionCandidate({
  event,
  inventory,
  git,
  github,
  npm,
  npmAuditFactory,
  attestations,
  marker,
  terminalRecordRef,
  discovery = { discoverManagedCandidate, discoverScheduledCandidate },
}) {
  assertTerminalRecordRef(terminalRecordRef)
  assertMethods(inventory, ["read"], "inventory reader")
  assertMethods(
    discovery,
    ["discoverManagedCandidate", "discoverScheduledCandidate"],
    "candidate discovery",
  )
  const invocation = classifyProductionEvent(event)
  const verifyTerminalAbandonment =
    npm !== undefined && attestations !== undefined
      ? async ({ candidate, release }) => {
          try {
            const immutableInventory = await inventory.read({
              ref: candidate.commitSha,
            })
            const verified = await observeProductionCandidate({
              candidate,
              inventory: immutableInventory,
              marker,
              git,
              github,
              npm,
              npmAuditFactory,
              attestations,
              terminalRecordRef,
            })
            const observation = verified.observation
            const baseAssets = observation.release.assets.filter(
              (asset) => asset.name !== "abandonment.json",
            )
            return (
              verified.diagnostics.length === 0 &&
              observation.release.status === "draft" &&
              observation.release.tag === release.tag &&
              observation.release.commitSha === candidate.commitSha &&
              observation.release.bodySha256 === release.bodySha256 &&
              observation.release.marker?.phase === "ABANDONED_PREPUBLICATION" &&
              observation.release.marker.abandonmentSha256 === release.abandonmentSha256 &&
              observation.release.marker.baseAssetSetSha256 === release.baseAssetSetSha256 &&
              observation.artifacts.status === "attested" &&
              baseAssets.length === 45 &&
              baseAssets.every((asset) => asset.status === "matching") &&
              observation.abandonment.requested === true &&
              observation.abandonment.recorded === true
            )
          } catch {
            return false
          }
        }
      : undefined
  const discoverScheduled = () =>
    discovery.discoverScheduledCandidate({
      inventory,
      git,
      github,
      marker,
      ...(verifyTerminalAbandonment === undefined ? {} : { verifyTerminalAbandonment }),
    })
  let normalized
  if (invocation.kind === "scheduled") {
    normalized = normalizeProductionCandidateSelection(await discoverScheduled())
  } else {
    const exact = normalizeProductionCandidateSelection(
      await discovery.discoverManagedCandidate({
        ref: invocation.ref,
        inventory,
        git,
        marker,
      }),
    )
    if (exact.candidate !== null && exact.candidate.commitSha !== invocation.ref) {
      throw new Error("Production candidate identity does not match the exact invocation ref")
    }
    const global = normalizeProductionCandidateSelection(await discoverScheduled())
    if (
      invocation.expectedVersion !== null &&
      global.candidate !== null &&
      (global.candidate.version !== invocation.expectedVersion ||
        global.candidate.commitSha !== invocation.ref)
    ) {
      throw new Error("Production exact dispatch conflicts with global candidate arbitration")
    }
    normalized = global.candidate === null ? exact : global
  }
  const verifiedCurrentVersionNoop =
    invocation.expectedVersion !== null && normalized.candidate === null
      ? matchesCurrentVersionNoCandidateInventory(
          await inventory.read({ ref: invocation.ref }),
          invocation.expectedVersion,
        )
      : false
  if (
    invocation.expectedVersion !== null &&
    !verifiedCurrentVersionNoop &&
    (normalized.candidate?.version !== invocation.expectedVersion ||
      normalized.candidate?.commitSha !== invocation.ref)
  ) {
    throw new Error("Production dispatch inputs do not match the discovered candidate")
  }
  return deepFreeze(normalized)
}

function matchesCurrentVersionNoCandidateInventory(value, expectedVersion) {
  const inventory = snapshotJson(value)
  if (
    !hasExactKeys(inventory, ["status", "packages"]) ||
    inventory.status !== "valid" ||
    !Array.isArray(inventory.packages) ||
    inventory.packages.length !== ACTIVE_PACKAGE_NAMES.length
  ) {
    return false
  }
  const names = []
  for (const pkg of inventory.packages) {
    if (
      !isRecord(pkg) ||
      !hasExactKeys(pkg, ["name", "version"]) ||
      typeof pkg.name !== "string" ||
      pkg.version !== expectedVersion
    ) {
      return false
    }
    names.push(pkg.name)
  }
  return arraysEqual(names.slice().sort(compareText), ACTIVE_PACKAGE_NAMES)
}

function normalizeProductionCandidateSelection(value) {
  const normalized = snapshotJson(value)
  if (
    !hasExactKeys(normalized, ["candidate", "state", "disposition", "tag", "conflicts"]) ||
    !PRODUCTION_SELECTION_STATES.has(normalized.state) ||
    !PRODUCTION_SELECTION_DISPOSITIONS.has(normalized.disposition) ||
    !Array.isArray(normalized.conflicts) ||
    normalized.conflicts.some(
      (conflict) => typeof conflict !== "string" || conflict.length === 0,
    ) ||
    new Set(normalized.conflicts).size !== normalized.conflicts.length ||
    !arraysEqual(normalized.conflicts, [...normalized.conflicts].sort(compareText))
  ) {
    throw new TypeError("Production candidate selection is malformed")
  }
  const selectedCandidate =
    normalized.candidate === null ? null : normalizeCandidate(normalized.candidate)
  if (
    (selectedCandidate === null &&
      (normalized.state !== ReleaseState.NO_CANDIDATE ||
        normalized.disposition !== "noop" ||
        normalized.tag !== null ||
        normalized.conflicts.length !== 0)) ||
    (selectedCandidate !== null &&
      !(normalized.tag === null || normalized.tag === `v${selectedCandidate.version}`)) ||
    (normalized.disposition === "blocked"
      ? normalized.conflicts.length === 0
      : normalized.conflicts.length !== 0)
  ) {
    throw new TypeError("Production candidate selection is malformed")
  }
  return { ...normalized, candidate: selectedCandidate }
}

export function createProductionInventoryReader({
  root,
  git,
  readReleaseInventory: readInventory = readReleaseInventory,
  assertValidReleaseInventory: assertInventory = assertValidReleaseInventory,
}) {
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("Production inventory root is invalid")
  }
  if (typeof readInventory !== "function" || typeof assertInventory !== "function") {
    throw new TypeError("Production inventory functions are invalid")
  }
  return Object.freeze({
    async read({ ref }) {
      if (!isSha(ref) && ref !== "main" && ref !== "refs/heads/main") {
        throw new TypeError("Production inventory ref is invalid")
      }
      const validated = assertInventory(await readInventory({ root, ref, git }))
      if (
        !isRecord(validated) ||
        !Array.isArray(validated.packages) ||
        !isReleaseVersion(validated.version)
      ) {
        throw new TypeError("Production release inventory validation is malformed")
      }
      const names = [...validated.packages].sort(compareText)
      if (!arraysEqual(names, ACTIVE_PACKAGE_NAMES)) {
        throw new Error("Production release inventory must match the canonical 21-package set")
      }
      return deepFreeze({
        status: "valid",
        packages: names.map((name) => ({ name, version: validated.version })),
      })
    },
  })
}

export async function observeProductionCandidate({
  candidate,
  inventory,
  marker,
  git,
  github,
  npm,
  npmAuditFactory,
  attestations,
  terminalRecordRef,
  includeRecovery = false,
  currentPublisherRun = null,
}) {
  if (typeof includeRecovery !== "boolean") {
    throw new TypeError("Production recovery inclusion flag is invalid")
  }
  assertTerminalRecordRef(terminalRecordRef)
  const identity = normalizeCandidate(candidate)
  const currentRun = normalizeCurrentPublisherRun(currentPublisherRun, identity)
  const managedInventory = normalizeProductionInventory(inventory, identity)
  normalizeControllerMarker(marker)
  assertMethods(git, ["resolveTag", "listTree", "showFile"], "Git reader")
  assertMethods(
    github,
    [
      "getCommitCheckRuns",
      "listWorkflowRuns",
      "listTagRefs",
      "getRef",
      "getGitTag",
      "listReleases",
      "getRelease",
      "listReleaseAssets",
      "downloadReleaseAsset",
      "listActionsArtifacts",
      "listActionsRunArtifacts",
      "downloadActionsArtifact",
      "getActionsRun",
      "getActionsRunAttempt",
      "listActionsRunJobs",
    ],
    "GitHub reader",
  )
  assertMethods(npm, ["observePackageVersion", "downloadRegistryTarball"], "npm reader")
  if (attestations !== undefined) {
    assertMethods(attestations, ["verify"], "attestation verifier")
  }

  const diagnostics = []
  let committedTerminalRecord = null
  let terminalRecordUnusable = false
  let terminalRecordMismatch = false
  try {
    committedTerminalRecord = await readTerminalRecord({
      git,
      ref: terminalRecordRef,
      version: identity.version,
    })
  } catch (error) {
    // The store throws TypeError for a record it read but could not validate; anything else came
    // from the git transport itself (spawn failure, timeout, output cap), which is not evidence
    // of tampering. Both fail closed, but an operator must be able to tell them apart.
    terminalRecordUnusable = true
    addDiagnostic(
      diagnostics,
      "git",
      "terminal-record",
      "AMBIGUOUS",
      error instanceof TypeError ? "TERMINAL_RECORD_INVALID" : "TERMINAL_RECORD_UNREADABLE",
    )
  }
  if (
    committedTerminalRecord !== null &&
    !terminalRecordBindsCandidate(committedTerminalRecord, identity)
  ) {
    // A record for another version or another commit proves nothing about THIS candidate, and a
    // record whose own tag disagrees with its commit is self-inconsistent. Discard it entirely
    // (it is never read again below) and fail closed exactly like a draft mismatch, under its own
    // code: a foreign record is a different operator situation from a draft that disagrees.
    committedTerminalRecord = null
    terminalRecordMismatch = true
    addDiagnostic(diagnostics, "git", "terminal-record", "AMBIGUOUS", "TERMINAL_RECORD_FOREIGN")
  }
  const [ciResult, ciWorkflowResult, tagRefsResult, releasesResult, artifactResult, publisherRuns] =
    await Promise.all([
      observeAdapter(() => github.getCommitCheckRuns({ commitSha: identity.commitSha }), {
        source: "github",
        operation: "commit-check-runs",
        payloadKey: "value",
        diagnostics,
      }),
      observeAdapter(
        () =>
          github.listWorkflowRuns({
            workflow: "ci.yml",
            commitSha: identity.commitSha,
          }),
        {
          source: "github",
          operation: "workflow-runs",
          payloadKey: "value",
          diagnostics,
        },
      ),
      observeAdapter(() => github.listTagRefs(), {
        source: "github",
        operation: "tag-refs",
        payloadKey: "value",
        diagnostics,
      }),
      observeAdapter(() => github.listReleases(), {
        source: "github",
        operation: "releases",
        payloadKey: "value",
        diagnostics,
      }),
      observeAdapter(
        () => github.listActionsArtifacts({ name: productionArtifactName(identity) }),
        {
          source: "github",
          operation: "actions-artifacts",
          payloadKey: "value",
          diagnostics,
        },
      ),
      observeAdapter(
        () =>
          github.listWorkflowRuns({
            workflow: "release.yml",
            commitSha: identity.commitSha,
          }),
        {
          source: "github",
          operation: "workflow-runs",
          payloadKey: "value",
          diagnostics,
        },
      ),
    ])

  const latestCi = mapCi(ciResult, ciWorkflowResult, identity, diagnostics)
  const preparedArtifactState = await mapProductionArtifacts({
    result: artifactResult,
    inventory: managedInventory,
    candidate: identity,
    github,
    diagnostics,
  })
  const artifactState = preparedArtifactState
  const releaseState = await mapProductionRelease({
    result: releasesResult,
    candidate: identity,
    inventory: managedInventory,
    artifactState,
    github,
    marker,
    attestations,
    diagnostics,
  })
  let abandonment = releaseState.abandonment
  if (committedTerminalRecord !== null) {
    if (terminalRecordMatchesRelease(committedTerminalRecord, releaseState.release)) {
      abandonment = {
        requested: true,
        recorded: true,
        predecessor: committedTerminalRecord.predecessor.state,
      }
    } else {
      // The committed record and the visible draft disagree, so neither may be reported as the
      // abandonment of record. The release itself is forced ambiguous further below, where the
      // observed release is finalized, so planRelease blocks rather than only the CLI.
      terminalRecordMismatch = true
      addDiagnostic(diagnostics, "github", "release", "AMBIGUOUS", "TERMINAL_RECORD_MISMATCH")
    }
  }
  if (terminalRecordMismatch) abandonment = { requested: true, recorded: false, predecessor: null }
  const retentionResolvedByDurableRelease =
    releaseState.release.status !== "absent" &&
    releaseState.release.status !== "ambiguous" &&
    releaseState.release.marker !== null &&
    ((releaseState.artifactState.artifacts.status === "attested" &&
      releaseState.release.marker.attestationSet !== null) ||
      (releaseState.release.marker.phase === "ABANDONED_PREPUBLICATION" &&
        abandonment.requested === true &&
        abandonment.recorded === true))
  if (!retentionResolvedByDurableRelease) {
    diagnostics.push(...(preparedArtifactState.deferredDiagnostics ?? []))
  }
  const observedArtifactState = releaseState.artifactState
  const observedInventory = observedArtifactState.inventory
  const ci = observedArtifactState.ci ?? latestCi
  let registryPackages = []
  let registryMutationObserved = false
  const registryResults = []
  for (const pkg of observedInventory.packages) {
    const result = await observeAdapter(
      () =>
        npm.observePackageVersion({
          name: pkg.name,
          version: identity.version,
        }),
      {
        source: "npm",
        operation: "package-version",
        payloadKey: "package",
        diagnostics,
      },
    )
    registryMutationObserved ||= result.status === "PRESENT"
    registryResults.push({ expected: pkg, result })
  }
  const registryPresenceObserved = registryResults.some(({ result }) => result.status === "PRESENT")
  let npmAuditVerifier = null
  let npmAuditDisposeFailed = false
  if (registryPresenceObserved) {
    if (typeof npmAuditFactory?.create !== "function") {
      addDiagnostic(
        diagnostics,
        "npm",
        "audit-signatures",
        "AMBIGUOUS",
        "OFFICIAL_NPM_AUDIT_UNAVAILABLE",
      )
    } else {
      try {
        npmAuditVerifier = await npmAuditFactory.create()
        assertMethods(npmAuditVerifier, ["verifyPackage", "dispose"], "npm audit verifier")
      } catch (error) {
        addDiagnostic(
          diagnostics,
          "npm",
          "audit-signatures",
          "AMBIGUOUS",
          safeCode(error?.code, "OFFICIAL_NPM_AUDIT_UNAVAILABLE"),
        )
        npmAuditVerifier = null
      }
    }
  }
  try {
    for (const { expected, result } of registryResults) {
      registryPackages.push(
        await mapProductionRegistryPackage({
          result,
          expected,
          candidate: identity,
          manifest: observedArtifactState.manifest,
          npm,
          npmAuditVerifier,
          diagnostics,
        }),
      )
    }
  } finally {
    if (npmAuditVerifier !== null) {
      try {
        await npmAuditVerifier.dispose()
      } catch (error) {
        npmAuditDisposeFailed = true
        addDiagnostic(
          diagnostics,
          "npm",
          "audit-signatures",
          "AMBIGUOUS",
          safeCode(error?.code, "NPM_AUDIT_DISPOSE_FAILED"),
        )
      }
    }
  }
  if (npmAuditDisposeFailed) {
    registryPackages = registryPackages.map((pkg) =>
      pkg.status === "present" ? ambiguousRegistryPackage(pkg.name) : pkg,
    )
  }

  // registryPresenceObserved, not the mapped package status: without an npmAuditFactory an
  // observed-PRESENT package is downgraded to "ambiguous", and a record can never mask a
  // publication just because signature verification was unavailable.
  if ((committedTerminalRecord !== null || terminalRecordUnusable) && registryPresenceObserved) {
    addDiagnostic(
      diagnostics,
      "npm",
      "package-version",
      "AMBIGUOUS",
      "TERMINAL_RECORD_PUBLISHED_VERSION",
    )
  }

  const tag = await mapProductionTag({
    result: tagRefsResult,
    candidate: identity,
    git,
    github,
    diagnostics,
  })
  const artifacts = observedArtifactState.artifacts
  let release = releaseState.release
  const observedNpmEvidence = createObservedNpmEvidence({
    candidate: identity,
    manifest: observedArtifactState.manifest,
    registryPackages,
  })
  if (release.marker !== null && release.marker.npmEvidenceSha256 !== null) {
    try {
      if (
        observedNpmEvidence === null ||
        sha256(
          canonicalNpmEvidenceBytes(observedNpmEvidence, {
            candidate: identity,
            manifest: observedArtifactState.manifest,
            manifestSha256: manifestSha256(observedArtifactState.manifest),
          }),
        ) !== release.marker.npmEvidenceSha256
      ) {
        throw observationError("NPM_EVIDENCE_DIGEST_MISMATCH")
      }
    } catch (error) {
      addDiagnostic(
        diagnostics,
        "npm",
        "npm-evidence",
        "AMBIGUOUS",
        safeCode(error?.code, "NPM_EVIDENCE_DIGEST_MISMATCH"),
      )
      release = nonPresentRelease("ambiguous")
    }
  }
  // A record we cannot parse, or one the visible draft contradicts, leaves the terminal state
  // unknown: fail closed so planRelease blocks on github-release-ambiguous, not only the CLI.
  if (terminalRecordUnusable || terminalRecordMismatch) release = nonPresentRelease("ambiguous")
  const publicationHistory = await observeProductionPublicationHistory({
    result: publisherRuns,
    candidate: identity,
    github,
    diagnostics,
    currentPublisherRun: currentRun,
  })
  if (publicationHistory.ambiguous) {
    registryPackages = registryPackages.map((pkg) => ambiguousRegistryPackage(pkg.name))
  }
  const observation = {
    inventory: observedInventory,
    ci,
    otherCandidates: [],
    tag,
    artifacts,
    escrow: releaseState.escrow,
    registry: {
      publishJobStarted: publicationHistory.started,
      mutationStarted: publicationHistory.started || registryMutationObserved,
      packages: registryPackages,
    },
    release,
    requiredSmokeLanes: [...REQUIRED_SMOKE_LANES],
    smokes:
      releaseState.smokes.length === REQUIRED_SMOKE_LANES.length
        ? releaseState.smokes
        : pendingProductionSmokeObservations(identity, artifacts.manifestSha256),
    audit: releaseState.audit,
    abandonment,
  }
  diagnostics.sort(compareDiagnostics)
  const result = { observation, diagnostics }
  if (includeRecovery) {
    result.recovery = productionRecovery({
      candidate: identity,
      artifactState: observedArtifactState,
      releaseState,
      npmEvidence: observedNpmEvidence,
    })
  }
  return deepFreeze(result)
}

export async function discoverShadowCandidate({ ref, git, inventory }) {
  assertRef(ref)
  assertMethods(git, ["listFirstParentHistory", "firstParent"], "Git reader")
  assertMethods(inventory, ["read"], "inventory reader")

  const history = await git.listFirstParentHistory({ ref, maxCount: 1 })
  if (!Array.isArray(history) || history.length !== 1 || !SHA_PATTERN.test(history[0])) {
    throw new TypeError("Git history did not resolve the requested ref to one exact commit")
  }
  const commitSha = history[0]
  const parentSha = await git.firstParent(commitSha)
  if (typeof parentSha !== "string" || !SHA_PATTERN.test(parentSha)) {
    throw new TypeError("Git first parent is not an exact commit")
  }
  const current = normalizeDiscoveryInventory(await inventory.read({ ref: commitSha }), "current")
  const parent = normalizeDiscoveryInventory(await inventory.read({ ref: parentSha }), "parent")
  const currentNames = current.packages.map((pkg) => pkg.name)
  const parentNames = parent.packages.map((pkg) => pkg.name)
  if (!arraysEqual(currentNames, parentNames)) {
    throw new TypeError("Release inventory package set changed across the candidate commit")
  }
  if (current.version === parent.version) return null
  if (compareSemver(current.version, parent.version) <= 0) {
    throw new TypeError("Release inventory version delta must increase uniformly")
  }
  return deepFreeze({
    version: current.version,
    commitSha,
    ...DEFAULT_CANDIDATE_POLICY,
  })
}

export async function observeCandidate({ candidate, inventory, git, npm, github }) {
  const normalizedCandidate = normalizeCandidate(candidate)
  const normalizedInventory = normalizeManagedInventory(inventory, normalizedCandidate)
  assertMethods(git, ["resolveTag"], "Git reader")
  assertMethods(npm, ["observePackageVersion"], "npm reader")
  assertMethods(
    github,
    ["getCommitCheckRuns", "listWorkflowRuns", "getRef", "getReleaseByTag", "listActionsArtifacts"],
    "GitHub reader",
  )

  const tagName = `v${normalizedCandidate.version}`
  const diagnostics = []
  const ciResult = normalizeEnvelope(
    await github.getCommitCheckRuns({
      commitSha: normalizedCandidate.commitSha,
    }),
    { source: "github", operation: "commit-check-runs", payloadKey: "value" },
    diagnostics,
  )
  const ciWorkflowResult = normalizeEnvelope(
    await github.listWorkflowRuns({
      workflow: "ci.yml",
      commitSha: normalizedCandidate.commitSha,
    }),
    { source: "github", operation: "workflow-runs", payloadKey: "value" },
    diagnostics,
  )
  const refResult = normalizeEnvelope(
    await github.getRef({ ref: `tags/${tagName}` }),
    { source: "github", operation: "ref", payloadKey: "value" },
    diagnostics,
  )
  let localTagSha = null
  let localTagAmbiguous = false
  try {
    localTagSha = await git.resolveTag({ tag: tagName })
    if (typeof localTagSha !== "string" || !SHA_PATTERN.test(localTagSha)) {
      throw new TypeError("malformed tag identity")
    }
  } catch (error) {
    localTagAmbiguous = true
    diagnostics.push({
      source: "git",
      operation: "resolve-tag",
      status: "AMBIGUOUS",
      httpStatus: null,
      code: safeCode(error?.code, "GIT_READ_FAILED"),
    })
  }
  const releaseResult = normalizeEnvelope(
    await github.getReleaseByTag({ tag: tagName }),
    { source: "github", operation: "release", payloadKey: "value" },
    diagnostics,
  )
  const artifactResult = normalizeEnvelope(
    await github.listActionsArtifacts({
      name: managedArtifactName(normalizedCandidate),
    }),
    { source: "github", operation: "actions-artifacts", payloadKey: "value" },
    diagnostics,
  )
  const publisherRunsResult = normalizeEnvelope(
    await github.listWorkflowRuns({
      workflow: "release.yml",
      commitSha: normalizedCandidate.commitSha,
    }),
    { source: "github", operation: "workflow-runs", payloadKey: "value" },
    diagnostics,
  )

  const registryPackages = []
  let rawNpmPresent = false
  for (const pkg of normalizedInventory.packages) {
    const result = normalizeEnvelope(
      await npm.observePackageVersion({
        name: pkg.name,
        version: normalizedCandidate.version,
      }),
      { source: "npm", operation: "package-version", payloadKey: "package" },
      diagnostics,
    )
    rawNpmPresent ||= result.status === "PRESENT"
    registryPackages.push(mapRegistryPackage(result, pkg, normalizedCandidate, diagnostics))
  }

  const ci = mapCi(ciResult, ciWorkflowResult, normalizedCandidate, diagnostics)
  const tag = mapTag(refResult, localTagSha, localTagAmbiguous, diagnostics)
  const artifacts = mapArtifacts(artifactResult, normalizedInventory, diagnostics)
  const escrow =
    artifacts.status === "ambiguous"
      ? { status: "ambiguous", manifestSha256: null, assets: [] }
      : { status: "absent", manifestSha256: null, assets: [] }
  const observedSmokes = []
  const release = await mapRelease(
    releaseResult,
    normalizedInventory,
    normalizedCandidate,
    github,
    diagnostics,
    observedSmokes,
  )
  const published = rawNpmPresent || publicationRunStarted(publisherRunsResult, normalizedCandidate)
  const smokes =
    observedSmokes.length > 0
      ? observedSmokes
      : pendingSmokeObservations(normalizedCandidate, normalizedInventory)
  const observation = {
    inventory: {
      status: normalizedInventory.status,
      packages: normalizedInventory.packages,
    },
    ci,
    otherCandidates: [],
    tag,
    artifacts,
    escrow,
    registry: {
      publishJobStarted: published,
      mutationStarted: published,
      packages: registryPackages,
    },
    release,
    requiredSmokeLanes: normalizedInventory.requiredSmokeLanes,
    smokes,
    audit: {
      status: "none",
      version: null,
      commitSha: null,
      manifestSha256: null,
      workflowRunId: null,
      runAttempt: null,
      conclusion: null,
    },
    abandonment: { requested: false, recorded: false, predecessor: null },
  }
  diagnostics.sort(compareDiagnostics)
  return deepFreeze({ observation, diagnostics })
}

function normalizeProductionInventory(value, candidate) {
  if (!isRecord(value) || value.status !== "valid" || !Array.isArray(value.packages)) {
    throw new TypeError("Production inventory is invalid")
  }
  const packages = value.packages.map((pkg) => {
    if (!isRecord(pkg) || !isPackageName(pkg.name) || pkg.version !== candidate.version) {
      throw new TypeError("Production inventory package identity is invalid")
    }
    const filename = `${tarballName(pkg.name)}-${candidate.version}.tgz`
    return {
      name: pkg.name,
      version: pkg.version,
      filename,
      tarballSha256: null,
      attestationFilename: `${filename}.intoto.jsonl`,
      attestationSha256: null,
      integrity: null,
    }
  })
  packages.sort((left, right) => compareText(left.name, right.name))
  if (
    !arraysEqual(
      packages.map((pkg) => pkg.name),
      ACTIVE_PACKAGE_NAMES,
    )
  ) {
    throw new Error("Production inventory must match the canonical 21-package set")
  }
  return { status: "valid", packages }
}

function normalizeControllerMarker(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "publishingOwner",
      "epoch",
      "npmTrustedPublisherEnvironment",
      "abandonmentEnvironment",
    ]) ||
    value.schemaVersion !== 1 ||
    value.publishingOwner !== "release-controller" ||
    value.epoch !== "fixed-group-v1" ||
    !(
      value.npmTrustedPublisherEnvironment === null ||
      (typeof value.npmTrustedPublisherEnvironment === "string" &&
        value.npmTrustedPublisherEnvironment.length > 0)
    ) ||
    typeof value.abandonmentEnvironment !== "string" ||
    value.abandonmentEnvironment.length === 0
  ) {
    throw new TypeError("Production controller marker is invalid")
  }
}

async function observeAdapter(call, options) {
  let value
  try {
    value = await call()
  } catch (error) {
    value = {
      status: "ERROR",
      operation: options.operation,
      httpStatus: null,
      code: safeCode(error?.code, "ADAPTER_FAILURE"),
    }
  }
  return normalizeEnvelope(value, options, options.diagnostics)
}

async function mapProductionTag({ result, candidate, git, github, diagnostics }) {
  if (result.status !== "PRESENT" || !Array.isArray(result.value)) {
    return { status: "ambiguous", commitSha: null }
  }
  const expectedRef = `refs/tags/v${candidate.version}`
  const matches = result.value.filter((record) => record?.ref === expectedRef)
  if (matches.length === 0) return { status: "absent", commitSha: null }
  if (matches.length !== 1 || !isRecord(matches[0].object)) {
    addDiagnostic(diagnostics, "github", "tag-refs", "AMBIGUOUS", "TAG_IDENTITY_AMBIGUOUS")
    return { status: "ambiguous", commitSha: null }
  }
  const refResult = await observeAdapter(
    () => github.getRef({ ref: `tags/v${candidate.version}` }),
    {
      source: "github",
      operation: "ref",
      payloadKey: "value",
      diagnostics,
    },
  )
  if (refResult.status !== "PRESENT" || !isRecord(refResult.value)) {
    return { status: "ambiguous", commitSha: null }
  }
  const listedObject = matches[0].object
  const exactObject = refResult.value.object
  if (
    matches[0].ref !== refResult.value.ref ||
    listedObject.type !== "tag" ||
    exactObject?.type !== "tag" ||
    !isSha(listedObject.sha) ||
    listedObject.sha !== exactObject.sha
  ) {
    addDiagnostic(diagnostics, "github", "ref", "AMBIGUOUS", "ANNOTATED_TAG_REQUIRED")
    return { status: "ambiguous", commitSha: null }
  }
  const tagResult = await observeAdapter(() => github.getGitTag({ tagSha: exactObject.sha }), {
    source: "github",
    operation: "git-tag",
    payloadKey: "value",
    diagnostics,
  })
  let localCommit = null
  try {
    localCommit = await git.resolveTag({ tag: `v${candidate.version}` })
  } catch (error) {
    addDiagnostic(
      diagnostics,
      "git",
      "resolve-tag",
      "AMBIGUOUS",
      safeCode(error?.code, "GIT_READ_FAILED"),
    )
  }
  if (
    tagResult.status !== "PRESENT" ||
    tagResult.value?.tag !== `v${candidate.version}` ||
    tagResult.value?.object?.type !== "commit" ||
    tagResult.value.object.sha !== candidate.commitSha ||
    localCommit !== candidate.commitSha
  ) {
    addDiagnostic(diagnostics, "github", "git-tag", "AMBIGUOUS", "TAG_IDENTITY_CONFLICT")
    return { status: "ambiguous", commitSha: null }
  }
  return { status: "present", commitSha: candidate.commitSha }
}

async function mapProductionArtifacts({ result, inventory, candidate, github, diagnostics }) {
  const absent = emptyProductionArtifacts(inventory)
  if (result.status !== "PRESENT" || !Array.isArray(result.value)) {
    return {
      artifacts: { ...absent, status: "ambiguous" },
      inventory,
      manifest: null,
    }
  }
  if (result.value.length === 0) return { artifacts: absent, inventory, manifest: null }
  if (result.value.length > MAX_ACTIONS_ARTIFACT_CANDIDATES) {
    addDiagnostic(
      diagnostics,
      "github",
      "actions-artifacts",
      "AMBIGUOUS",
      "ARTIFACT_CANDIDATE_LIMIT_EXCEEDED",
    )
    return {
      artifacts: { ...absent, status: "ambiguous" },
      inventory,
      manifest: null,
    }
  }

  const deferredDiagnostics = []
  try {
    const payloadIds = new Set()
    const expiredManifestDigests = new Set()
    const workBudget = { remainingBytes: MAX_ACTIONS_OBSERVATION_BYTES }
    let complete = null
    let retentionExpired = false
    for (const metadata of result.value) {
      const inspected = await inspectProductionArtifactCandidate({
        metadata,
        inventory,
        candidate,
        github,
        workBudget,
        diagnostics: deferredDiagnostics,
      })
      const payloadId = String(inspected.payloadId)
      if (payloadIds.has(payloadId)) throw observationError("ARTIFACT_IDENTITY_AMBIGUOUS")
      payloadIds.add(payloadId)
      if (inspected.status === "complete") {
        if (complete !== null) throw observationError("RELEASE_RECORD_HANDOFF_AMBIGUOUS")
        if (
          [...expiredManifestDigests].some(
            (digest) => digest !== inspected.state.artifacts.manifestSha256,
          )
        ) {
          throw observationError("EXPIRED_HANDOFF_CONFLICT")
        }
        complete = inspected.state
      } else if (inspected.status === "expired-sealed") {
        expiredManifestDigests.add(inspected.manifestSha256)
        if (
          expiredManifestDigests.size > 1 ||
          (complete !== null && complete.artifacts.manifestSha256 !== inspected.manifestSha256)
        ) {
          throw observationError("EXPIRED_HANDOFF_CONFLICT")
        }
        retentionExpired = true
      } else if (inspected.status === "expired") {
        retentionExpired = true
      }
    }
    if (complete !== null) return complete
    if (expiredManifestDigests.size > 0 || retentionExpired) {
      return {
        artifacts: { ...absent, status: "ambiguous" },
        inventory,
        manifest: null,
        retentionExpired: true,
        deferredDiagnostics,
      }
    }
    return {
      artifacts: absent,
      inventory,
      manifest: null,
      replacementRequired: true,
    }
  } catch (error) {
    addDiagnostic(
      deferredDiagnostics,
      "github",
      "actions-artifacts",
      "AMBIGUOUS",
      safeCode(error?.code, "ARTIFACT_CONTENT_INVALID"),
    )
    return {
      artifacts: { ...absent, status: "ambiguous" },
      inventory,
      manifest: null,
      retentionExpired: result.value.some((metadata) => metadata?.expired === true),
      deferredDiagnostics,
    }
  }
}

async function inspectProductionArtifactCandidate({
  metadata,
  inventory,
  candidate,
  github,
  workBudget,
  diagnostics,
}) {
  const payload = normalizeActionsArtifactMetadata(metadata, candidate, {
    allowExpired: true,
  })
  if (payload.expired) {
    return await inspectExpiredProductionArtifactCandidate({
      payload,
      candidate,
      github,
      workBudget,
      diagnostics,
    })
  }
  const payloadArchive = await downloadActionsArchive({
    github,
    artifactId: payload.id,
    workBudget,
    diagnostics,
  })
  if (payloadArchive === null || sha256Service(payloadArchive) !== payload.digest) {
    throw observationError("ACTIONS_ARTIFACT_DIGEST_MISMATCH")
  }
  const payloadFiles = extractActionsArtifactZip(payloadArchive)
  const manifestFile = uniqueFile(payloadFiles, "manifest.json")
  const manifest = parseProductionManifest(manifestFile.bytes, { candidate })
  const sealedCi = await validateProductionManifestCi({
    manifest,
    candidate,
    github,
    diagnostics,
  })
  if (!Buffer.from(manifestFile.bytes).equals(canonicalManifestBytes(manifest))) {
    throw observationError("MANIFEST_BYTES_NONCANONICAL")
  }
  verifyPayloadFiles(payloadFiles, manifest)
  if (
    String(manifest.artifact.prepareRunId) !== String(payload.workflowRunId) ||
    manifest.artifact.name !== payload.name
  ) {
    throw observationError("ACTIONS_ARTIFACT_RUN_MISMATCH")
  }
  const prepareRunResult = await observeAdapter(
    () =>
      github.getActionsRunAttempt({
        runId: manifest.artifact.prepareRunId,
        attempt: manifest.artifact.prepareRunAttempt,
      }),
    {
      source: "github",
      operation: "actions-run-attempt",
      payloadKey: "value",
      diagnostics,
    },
  )
  validatePreparationRun({
    result: prepareRunResult,
    candidate,
    runId: manifest.artifact.prepareRunId,
    runAttempt: manifest.artifact.prepareRunAttempt,
  })

  const runArtifactsResult = await observeAdapter(
    () => github.listActionsRunArtifacts({ runId: manifest.artifact.prepareRunId }),
    {
      source: "github",
      operation: "actions-run-artifacts",
      payloadKey: "value",
      diagnostics,
    },
  )
  if (
    runArtifactsResult.status !== "PRESENT" ||
    !Array.isArray(runArtifactsResult.value) ||
    runArtifactsResult.value.length < 1 ||
    runArtifactsResult.value.length > 8
  ) {
    throw observationError("RELEASE_RECORD_HANDOFF_AMBIGUOUS")
  }
  const runPayloads = runArtifactsResult.value.filter(
    (record) => String(record?.id) === String(payload.id),
  )
  if (
    runPayloads.length !== 1 ||
    normalizeActionsArtifactMetadata(runPayloads[0], candidate).digest !== payload.digest
  ) {
    throw observationError("ACTIONS_ARTIFACT_RUN_MISMATCH")
  }
  const handoffName = productionReleaseRecordArtifactName(candidate)
  const handoffCandidates = runArtifactsResult.value.filter(
    (record) => String(record?.id) !== String(payload.id) && record?.name === handoffName,
  )
  if (handoffCandidates.length === 0) return { status: "orphan", payloadId: payload.id }
  if (handoffCandidates.length !== 1) {
    throw observationError("RELEASE_RECORD_HANDOFF_AMBIGUOUS")
  }
  const handoff = normalizeRunArtifactMetadata(
    handoffCandidates[0],
    candidate,
    payload.workflowRunId,
  )
  const archive = await downloadActionsArchive({
    github,
    artifactId: handoff.id,
    workBudget,
    diagnostics,
  })
  if (archive === null || sha256Service(archive) !== handoff.digest) {
    throw observationError("RELEASE_RECORD_HANDOFF_DIGEST_MISMATCH")
  }
  const releaseRecords = extractActionsArtifactZip(archive)
  if (releaseRecords.length !== 1 || releaseRecords[0].name !== "release-record.json") {
    throw observationError("RELEASE_RECORD_HANDOFF_CONTENT_INVALID")
  }
  const recordFile = releaseRecords[0]
  const record = parseReleaseRecord(recordFile.bytes)
  if (!Buffer.from(recordFile.bytes).equals(canonicalReleaseRecordBytes(record))) {
    throw observationError("RELEASE_RECORD_BYTES_NONCANONICAL")
  }
  if (
    record.version !== candidate.version ||
    record.commitSha !== candidate.commitSha ||
    record.manifestSha256 !== manifestSha256(manifest) ||
    record.actionsArtifact.id !== String(payload.id) ||
    record.actionsArtifact.name !== payload.name ||
    record.actionsArtifact.serviceDigest !== payload.digest ||
    record.actionsArtifact.prepareRunId !== String(manifest.artifact.prepareRunId) ||
    record.actionsArtifact.prepareRunAttempt !== manifest.artifact.prepareRunAttempt
  ) {
    throw observationError("RELEASE_RECORD_IDENTITY_MISMATCH")
  }
  const observedInventory = inventoryFromManifest(inventory, manifest)
  return {
    status: "complete",
    payloadId: payload.id,
    state: {
      artifacts: preparedArtifacts({
        inventory: observedInventory,
        manifest,
        recordSha256: releaseRecordSha256(record),
      }),
      inventory: observedInventory,
      manifest,
      record,
      ci: sealedCi,
      files: payloadFiles.map((file) => ({
        name: file.name,
        bytes: Buffer.from(file.bytes),
      })),
    },
  }
}

async function inspectExpiredProductionArtifactCandidate({
  payload,
  candidate,
  github,
  workBudget,
  diagnostics,
}) {
  const runArtifactsResult = await observeAdapter(
    () => github.listActionsRunArtifacts({ runId: payload.workflowRunId }),
    {
      source: "github",
      operation: "actions-run-artifacts",
      payloadKey: "value",
      diagnostics,
    },
  )
  if (
    runArtifactsResult.status !== "PRESENT" ||
    !Array.isArray(runArtifactsResult.value) ||
    runArtifactsResult.value.length < 1 ||
    runArtifactsResult.value.length > 8
  ) {
    throw observationError("RELEASE_RECORD_HANDOFF_AMBIGUOUS")
  }
  const runPayloads = runArtifactsResult.value.filter(
    (record) => String(record?.id) === String(payload.id),
  )
  if (
    runPayloads.length !== 1 ||
    normalizeActionsArtifactMetadata(runPayloads[0], candidate, {
      allowExpired: true,
    }).digest !== payload.digest
  ) {
    throw observationError("ACTIONS_ARTIFACT_RUN_MISMATCH")
  }
  const handoffName = productionReleaseRecordArtifactName(candidate)
  const handoffCandidates = runArtifactsResult.value.filter(
    (record) => String(record?.id) !== String(payload.id) && record?.name === handoffName,
  )
  if (handoffCandidates.length === 0) return { status: "orphan", payloadId: payload.id }
  if (handoffCandidates.length !== 1) {
    throw observationError("RELEASE_RECORD_HANDOFF_AMBIGUOUS")
  }
  if (handoffCandidates[0]?.expired === true) {
    return { status: "expired", payloadId: payload.id }
  }
  const handoff = normalizeRunArtifactMetadata(
    handoffCandidates[0],
    candidate,
    payload.workflowRunId,
  )
  const archive = await downloadActionsArchive({
    github,
    artifactId: handoff.id,
    workBudget,
    diagnostics,
  })
  if (archive === null || sha256Service(archive) !== handoff.digest) {
    throw observationError("RELEASE_RECORD_HANDOFF_DIGEST_MISMATCH")
  }
  const files = extractActionsArtifactZip(archive)
  if (files.length !== 1 || files[0].name !== "release-record.json") {
    throw observationError("RELEASE_RECORD_HANDOFF_CONTENT_INVALID")
  }
  const record = parseReleaseRecord(files[0].bytes)
  if (!Buffer.from(files[0].bytes).equals(canonicalReleaseRecordBytes(record))) {
    throw observationError("RELEASE_RECORD_BYTES_NONCANONICAL")
  }
  if (
    record.version !== candidate.version ||
    record.commitSha !== candidate.commitSha ||
    record.actionsArtifact.id !== String(payload.id) ||
    record.actionsArtifact.name !== payload.name ||
    record.actionsArtifact.serviceDigest !== payload.digest ||
    record.actionsArtifact.prepareRunId !== String(payload.workflowRunId)
  ) {
    throw observationError("RELEASE_RECORD_IDENTITY_MISMATCH")
  }
  const prepareRunResult = await observeAdapter(
    () =>
      github.getActionsRunAttempt({
        runId: record.actionsArtifact.prepareRunId,
        attempt: record.actionsArtifact.prepareRunAttempt,
      }),
    {
      source: "github",
      operation: "actions-run-attempt",
      payloadKey: "value",
      diagnostics,
    },
  )
  validatePreparationRun({
    result: prepareRunResult,
    candidate,
    runId: record.actionsArtifact.prepareRunId,
    runAttempt: record.actionsArtifact.prepareRunAttempt,
  })
  return {
    status: "expired-sealed",
    payloadId: payload.id,
    manifestSha256: record.manifestSha256,
  }
}

function validatePreparationRun({ result, candidate, runId, runAttempt }) {
  const run = result.value
  if (
    result.status !== "PRESENT" ||
    !isRecord(run) ||
    String(run.id) !== String(runId) ||
    run.run_attempt !== runAttempt ||
    run.head_sha !== candidate.commitSha ||
    run.head_branch !== `v${candidate.version}` ||
    run.path !== candidate.publisherWorkflow ||
    !["push", "workflow_dispatch", "schedule"].includes(run.event) ||
    !ACTIONS_RUN_STATUSES.includes(run.status) ||
    (run.status === "completed"
      ? !ACTIONS_TERMINAL_CONCLUSIONS.includes(run.conclusion)
      : run.conclusion !== null)
  ) {
    throw observationError("PREPARE_RUN_IDENTITY_MISMATCH")
  }
}

function canonicalAttestationSubjects(manifest) {
  return [
    { name: "manifest.json", sha256: manifestSha256(manifest) },
    ...manifest.packages.map((pkg) => ({
      name: pkg.filename,
      sha256: pkg.sha256,
    })),
  ]
}

function normalizeActionsArtifactMetadata(value, candidate, { allowExpired = false } = {}) {
  if (
    !isRecord(value) ||
    !isPositiveId(value.id) ||
    value.name !== productionArtifactName(candidate) ||
    typeof value.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.digest) ||
    typeof value.expired !== "boolean" ||
    (!allowExpired && value.expired !== false) ||
    !isRecord(value.workflow_run) ||
    !isPositiveId(value.workflow_run.id) ||
    value.workflow_run.head_sha !== candidate.commitSha
  ) {
    throw observationError("ACTIONS_ARTIFACT_METADATA_INVALID")
  }
  return {
    id: value.id,
    name: value.name,
    digest: value.digest,
    expired: value.expired,
    workflowRunId: value.workflow_run.id,
  }
}

function normalizeRunArtifactMetadata(value, candidate, workflowRunId) {
  if (
    !isRecord(value) ||
    !isPositiveId(value.id) ||
    value.name !== productionReleaseRecordArtifactName(candidate) ||
    typeof value.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.digest) ||
    value.expired !== false ||
    !isRecord(value.workflow_run) ||
    String(value.workflow_run.id) !== String(workflowRunId) ||
    value.workflow_run.head_sha !== candidate.commitSha
  ) {
    throw observationError("RELEASE_RECORD_HANDOFF_METADATA_INVALID")
  }
  return { id: value.id, digest: value.digest }
}

function productionReleaseRecordArtifactName(candidate) {
  return `release-record-v${candidate.version}-${candidate.commitSha.slice(0, 12)}`
}

async function downloadActionsArchive({ github, artifactId, workBudget, diagnostics }) {
  const maximumBytes = Math.min(
    RELEASE_PAYLOAD_LIMITS.actionsArchiveBytes,
    workBudget?.remainingBytes ?? RELEASE_PAYLOAD_LIMITS.actionsArchiveBytes,
  )
  if (maximumBytes < 1) throw observationError("ACTIONS_ARTIFACT_WORK_LIMIT_EXCEEDED")
  const result = await observeAdapter(
    () => github.downloadActionsArtifact({ artifactId, maximumBytes }),
    {
      source: "github",
      operation: "actions-artifact-download",
      payloadKey: "contentBase64",
      diagnostics,
    },
  )
  if (result.status !== "PRESENT" || typeof result.contentBase64 !== "string") return null
  const bytes = Buffer.from(result.contentBase64, "base64")
  if (bytes.toString("base64") !== result.contentBase64 || bytes.byteLength > maximumBytes) {
    return null
  }
  if (workBudget !== undefined) workBudget.remainingBytes -= bytes.byteLength
  return bytes
}

function verifyPayloadFiles(files, manifest) {
  const expectedNames = ["manifest.json", ...manifest.packages.map((pkg) => pkg.filename)]
  if (
    files.length !== expectedNames.length ||
    new Set(files.map((file) => file.name)).size !== files.length ||
    !expectedNames.every((name) => files.some((file) => file.name === name))
  ) {
    throw observationError("ACTIONS_ARTIFACT_FILE_SET_MISMATCH")
  }
  for (const pkg of manifest.packages) {
    const file = uniqueFile(files, pkg.filename)
    if (file.bytes.byteLength !== pkg.size || sha256(file.bytes) !== pkg.sha256) {
      throw observationError("ACTIONS_ARTIFACT_PACKAGE_DIGEST_MISMATCH")
    }
  }
}

function uniqueFile(files, name) {
  const matches = files.filter((file) => file.name === name)
  if (matches.length !== 1) throw observationError("ACTIONS_ARTIFACT_FILE_SET_MISMATCH")
  return matches[0]
}

function inventoryFromManifest(inventory, manifest) {
  const manifestByName = new Map(manifest.packages.map((pkg) => [pkg.name, pkg]))
  return {
    status: inventory.status,
    packages: inventory.packages.map((expected) => {
      const pkg = manifestByName.get(expected.name)
      if (
        pkg === undefined ||
        pkg.version !== expected.version ||
        pkg.filename !== expected.filename
      ) {
        throw observationError("MANIFEST_INVENTORY_MISMATCH")
      }
      return {
        ...expected,
        tarballSha256: pkg.sha256,
        attestationSha256: null,
        integrity: pkg.npmIntegrity,
      }
    }),
  }
}

function parseProductionManifest(bytes, { candidate }) {
  return parseSealedReleaseManifest(bytes, { candidate })
}

async function validateProductionManifestCi({ manifest, candidate, github, diagnostics }) {
  const [runResult, jobsResult] = await Promise.all([
    observeAdapter(
      () =>
        github.getActionsRunAttempt({
          runId: manifest.ci.runId,
          attempt: manifest.ci.runAttempt,
        }),
      {
        source: "github",
        operation: "actions-run-attempt",
        payloadKey: "value",
        diagnostics,
      },
    ),
    observeAdapter(() => github.listActionsRunJobs({ runId: manifest.ci.runId }), {
      source: "github",
      operation: "actions-run-jobs",
      payloadKey: "value",
      diagnostics,
    }),
  ])
  const run = runResult.value
  const jobs = jobsResult.value
  if (
    runResult.status !== "PRESENT" ||
    jobsResult.status !== "PRESENT" ||
    !isRecord(run) ||
    String(run.id) !== String(manifest.ci.runId) ||
    run.run_attempt !== manifest.ci.runAttempt ||
    run.name !== candidate.ciWorkflow ||
    run.path !== ".github/workflows/ci.yml" ||
    run.head_sha !== candidate.commitSha ||
    run.head_branch !== "main" ||
    run.event !== "push" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !Array.isArray(jobs) ||
    jobs.length === 0 ||
    jobs.length > 10_000
  ) {
    throw observationError("MANIFEST_CI_IDENTITY_MISMATCH")
  }

  const identities = new Set()
  const attempts = new Set()
  const validateJobs = new Map()
  let maximumAttempt = 0
  let previousAttempt = 0
  let previousId = 0
  for (const job of jobs) {
    if (
      !isRecord(job) ||
      !isPositiveSafeInteger(job.id) ||
      !isPositiveSafeInteger(job.runAttempt) ||
      typeof job.name !== "string" ||
      job.name.length === 0 ||
      typeof job.status !== "string" ||
      job.status.length === 0 ||
      !(job.conclusion === null || typeof job.conclusion === "string") ||
      !isNullableTimestamp(job.startedAt) ||
      !isNullableTimestamp(job.completedAt) ||
      job.runAttempt < previousAttempt ||
      (job.runAttempt === previousAttempt && job.id <= previousId)
    ) {
      throw observationError("MANIFEST_CI_JOB_IDENTITY_MISMATCH")
    }
    const terminal = job.status === "completed"
    if (
      terminal !== (job.conclusion !== null) ||
      terminal !== (job.completedAt !== null) ||
      (job.completedAt !== null && job.startedAt === null)
    ) {
      throw observationError("MANIFEST_CI_JOB_IDENTITY_MISMATCH")
    }
    const identity = `${job.runAttempt}:${job.id}`
    if (identities.has(identity)) {
      throw observationError("MANIFEST_CI_JOB_IDENTITY_MISMATCH")
    }
    identities.add(identity)
    attempts.add(job.runAttempt)
    maximumAttempt = Math.max(maximumAttempt, job.runAttempt)
    previousAttempt = job.runAttempt
    previousId = job.id
    if (job.name === candidate.ciCheck) {
      validateJobs.set(job.runAttempt, [...(validateJobs.get(job.runAttempt) ?? []), job])
    }
  }
  if (
    attempts.size !== maximumAttempt ||
    manifest.ci.runAttempt > maximumAttempt ||
    [...attempts].some((attempt) => attempt < 1 || attempt > maximumAttempt)
  ) {
    throw observationError("MANIFEST_CI_JOB_ATTEMPT_COVERAGE_INCOMPLETE")
  }
  const sealed = validateJobs.get(manifest.ci.runAttempt) ?? []
  if (
    sealed.length !== 1 ||
    sealed[0].status !== "completed" ||
    sealed[0].conclusion !== "success" ||
    sealed[0].startedAt === null ||
    sealed[0].completedAt === null
  ) {
    throw observationError("MANIFEST_CI_JOB_IDENTITY_MISMATCH")
  }
  return ciIdentity("success", {
    workflow: manifest.ci.workflow,
    check: candidate.ciCheck,
    commitSha: candidate.commitSha,
    workflowRunId: manifest.ci.runId,
    runAttempt: manifest.ci.runAttempt,
  })
}

function preparedArtifacts({ inventory, manifest, recordSha256 }) {
  const digest = manifestSha256(manifest)
  return {
    status: "prepared",
    manifestVersion: manifest.version,
    manifestCommitSha: manifest.commitSha,
    manifestSha256: digest,
    files: inventory.packages.map((pkg) => ({
      name: pkg.name,
      status: "valid",
      assetName: pkg.filename,
      sha256: pkg.tarballSha256,
      integrity: pkg.integrity,
    })),
    manifestAsset: { name: "manifest.json", sha256: digest },
    releaseRecordAsset: { name: "release-record.json", sha256: recordSha256 },
    manifestAttestationAsset: {
      name: "manifest.json.intoto.jsonl",
      sha256: null,
    },
    attestations: [
      ...inventory.packages.map((pkg) => ({
        name: pkg.attestationFilename,
        status: "pending",
        sha256: null,
        subjectName: pkg.filename,
        subjectSha256: pkg.tarballSha256,
      })),
      {
        name: "manifest.json.intoto.jsonl",
        status: "pending",
        sha256: null,
        subjectName: "manifest.json",
        subjectSha256: digest,
      },
    ],
  }
}

function observationError(code) {
  const error = new Error("Production observation evidence is invalid")
  error.code = code
  return error
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function sha256Service(bytes) {
  return `sha256:${sha256(bytes)}`
}

function emptyProductionArtifacts(inventory) {
  return {
    status: "absent",
    manifestVersion: null,
    manifestCommitSha: null,
    manifestSha256: null,
    files: inventory.packages.map((pkg) => ({
      name: pkg.name,
      status: "pending",
      assetName: pkg.filename,
      sha256: null,
      integrity: null,
    })),
    manifestAsset: { name: "manifest.json", sha256: null },
    releaseRecordAsset: { name: "release-record.json", sha256: null },
    manifestAttestationAsset: {
      name: "manifest.json.intoto.jsonl",
      sha256: null,
    },
    attestations: [
      ...inventory.packages.map((pkg) => ({
        name: pkg.attestationFilename,
        status: "pending",
        sha256: null,
        subjectName: pkg.filename,
        subjectSha256: null,
      })),
      {
        name: "manifest.json.intoto.jsonl",
        status: "pending",
        sha256: null,
        subjectName: "manifest.json",
        subjectSha256: null,
      },
    ],
  }
}

async function mapProductionRelease({
  result,
  candidate,
  inventory,
  artifactState,
  github,
  marker: controllerMarker,
  attestations,
  diagnostics,
}) {
  if (result.status !== "PRESENT" || !Array.isArray(result.value)) {
    return productionReleaseState({
      release: nonPresentRelease("ambiguous"),
      artifactState,
      escrow: { status: "ambiguous", manifestSha256: null, assets: [] },
    })
  }
  const matches = result.value.filter((release) =>
    isManagedReleaseForTag(release, `v${candidate.version}`),
  )
  if (matches.length === 0) {
    return productionReleaseState({
      release: nonPresentRelease("absent"),
      artifactState,
      escrow:
        artifactState.artifacts.status === "ambiguous"
          ? { status: "ambiguous", manifestSha256: null, assets: [] }
          : { status: "absent", manifestSha256: null, assets: [] },
    })
  }
  if (matches.length !== 1) {
    addDiagnostic(diagnostics, "github", "releases", "AMBIGUOUS", "RELEASE_IDENTITY_AMBIGUOUS")
    return productionReleaseState({
      release: nonPresentRelease("ambiguous"),
      artifactState,
      escrow: { status: "ambiguous", manifestSha256: null, assets: [] },
    })
  }
  try {
    const listed = normalizeReleaseIdentity(matches[0], candidate)
    const exactResult = await observeAdapter(() => github.getRelease({ releaseId: listed.id }), {
      source: "github",
      operation: "release",
      payloadKey: "value",
      diagnostics,
    })
    if (exactResult.status !== "PRESENT") throw observationError("RELEASE_READ_AMBIGUOUS")
    const release = normalizeReleaseIdentity(exactResult.value, candidate)
    if (
      String(listed.id) !== String(release.id) ||
      listed.name !== release.name ||
      listed.targetCommitish !== release.targetCommitish ||
      listed.draft !== release.draft ||
      listed.immutable !== release.immutable ||
      (listed.body !== null && listed.body !== release.body)
    ) {
      throw observationError("RELEASE_IDENTITY_CHANGED")
    }
    if (release.body === null) throw observationError("RELEASE_MARKER_MISSING")
    const releaseMarker = parseReleaseMarker(release.body)
    if (
      releaseMarker.version !== candidate.version ||
      releaseMarker.commitSha !== candidate.commitSha ||
      releaseMarker.tag !== `v${candidate.version}`
    ) {
      throw observationError("RELEASE_MARKER_IDENTITY_MISMATCH")
    }
    const expectedTitle =
      releaseMarker.phase === "ABANDONED_PREPUBLICATION"
        ? `Dawn v${candidate.version} (abandoned before publication)`
        : `Dawn v${candidate.version}`
    if (release.name !== expectedTitle) throw observationError("RELEASE_TITLE_PHASE_MISMATCH")
    if (
      !["ATTACHING", "ESCROWED", "ABANDONED_PREPUBLICATION"].includes(releaseMarker.phase) &&
      release.body !== canonicalReleaseBody({ marker: releaseMarker, manifest: null })
    ) {
      throw observationError("RELEASE_BODY_NONCANONICAL")
    }
    const assetsResult = await observeAdapter(
      () => github.listReleaseAssets({ releaseId: release.id }),
      {
        source: "github",
        operation: "release-assets",
        payloadKey: "value",
        diagnostics,
      },
    )
    if (assetsResult.status !== "PRESENT" || !Array.isArray(assetsResult.value)) {
      throw observationError("RELEASE_ASSET_INVENTORY_AMBIGUOUS")
    }
    const remoteAssets = normalizeReleaseAssetInventory(assetsResult.value)
    assertReleaseAssetBudgets(remoteAssets)
    if (releaseMarker.phase === "ABANDONED_PREPUBLICATION") {
      return await mapProductionAbandonmentRelease({
        candidate,
        controllerMarker,
        release,
        marker: releaseMarker,
        remoteAssets,
        artifactState,
        github,
        attestations,
        diagnostics,
      })
    }
    if (releaseMarker.phase === "ATTACHING") {
      return await mapProductionAttachingRelease({
        candidate,
        release,
        marker: releaseMarker,
        remoteAssets,
        artifactState,
        github,
        attestations,
        diagnostics,
      })
    }
    const manifestAsset = uniqueRemoteAsset(remoteAssets, "manifest.json")
    const recordAsset = uniqueRemoteAsset(remoteAssets, "release-record.json")
    const [manifestBytes, recordBytes] = await Promise.all([
      downloadReleaseBytes({ github, asset: manifestAsset, diagnostics }),
      downloadReleaseBytes({ github, asset: recordAsset, diagnostics }),
    ])
    if (
      manifestBytes === null ||
      recordBytes === null ||
      sha256(manifestBytes) !== manifestAsset.sha256 ||
      sha256(recordBytes) !== recordAsset.sha256
    ) {
      throw observationError("RELEASE_BASE_ASSET_DIGEST_MISMATCH")
    }
    const manifest = parseProductionManifest(manifestBytes, { candidate })
    const sealedCi = await validateProductionManifestCi({
      manifest,
      candidate,
      github,
      diagnostics,
    })
    const record = parseReleaseRecord(recordBytes)
    if (
      !manifestBytes.equals(canonicalManifestBytes(manifest)) ||
      !recordBytes.equals(canonicalReleaseRecordBytes(record)) ||
      record.manifestSha256 !== manifestSha256(manifest) ||
      record.version !== candidate.version ||
      record.commitSha !== candidate.commitSha ||
      releaseMarker.manifestSha256 !== record.manifestSha256 ||
      releaseMarker.releaseRecordSha256 !== releaseRecordSha256(record)
    ) {
      throw observationError("RELEASE_BASE_RECORD_IDENTITY_MISMATCH")
    }
    if (
      releaseMarker.phase === "ESCROWED" &&
      release.body !== canonicalReleaseBody({ marker: releaseMarker, manifest })
    ) {
      throw observationError("RELEASE_BODY_NONCANONICAL")
    }
    await verifyDurableReleaseAttestation({
      candidate,
      manifest,
      record,
      marker: releaseMarker,
      remoteAssets,
      github,
      attestations,
      diagnostics,
    })
    const smokeEvidence = await observeDurableSmokeReceipts({
      marker: releaseMarker,
      candidate,
      github,
      rawAssets: assetsResult.value,
      diagnostics,
    })
    if (smokeEvidence === null) {
      throw observationError("SMOKE_RECEIPT_EVIDENCE_INVALID")
    }
    const preparedInventory = inventoryFromManifest(inventory, manifest)
    const observedInventory = inventoryFromAttestationSet({
      inventory: preparedInventory,
      manifest,
      marker: releaseMarker,
    })
    const artifacts = attestedArtifacts({
      inventory: observedInventory,
      manifest,
      recordSha256: releaseRecordSha256(record),
      marker: releaseMarker,
    })
    const expectedBase = markerBaseAssets(releaseMarker)
    const expectedByName = new Map(expectedBase.map((asset) => [asset.name, asset]))
    const releaseAssets = remoteAssets.map((asset) => {
      const expected = expectedByName.get(asset.name)
      const smoke = smokeEvidence.assets.get(String(asset.id))
      return {
        name: asset.name,
        status:
          smoke !== undefined
            ? smoke.status
            : asset.sha256 === null
              ? "ambiguous"
              : expected !== undefined && asset.sha256 === expected.sha256
                ? "matching"
                : "different",
        sha256: smoke?.sha256 ?? asset.sha256,
      }
    })
    const actualBase = releaseAssets.filter((asset) => expectedByName.has(asset.name))
    const baseExact =
      actualBase.length === expectedBase.length &&
      expectedBase.every((expected) =>
        actualBase.some(
          (actual) =>
            actual.name === expected.name &&
            actual.status === "matching" &&
            actual.sha256 === expected.sha256,
        ),
      )
    const terminal = await observeReleaseTerminal({
      candidate,
      controllerMarker,
      release,
      marker: releaseMarker,
      remoteAssets,
      github,
      diagnostics,
    })
    const expectedTerminal = new Map(terminal.assets.map((asset) => [asset.name, asset]))
    for (const asset of releaseAssets) {
      const expected = expectedTerminal.get(asset.name)
      if (expected !== undefined) {
        asset.status = asset.sha256 === expected.sha256 ? "matching" : "different"
      }
    }
    return productionReleaseState({
      release: {
        status: release.draft ? "draft" : "published",
        tag: `v${candidate.version}`,
        commitSha: candidate.commitSha,
        immutable: release.immutable,
        bodySha256: sha256(Buffer.from(release.body, "utf8")),
        marker: releaseMarker,
        assets: releaseAssets,
      },
      artifactState: {
        artifacts,
        inventory: observedInventory,
        manifest,
        record,
        ci: sealedCi,
      },
      escrow: baseExact
        ? {
            status: "present",
            manifestSha256: record.manifestSha256,
            assets: actualBase,
          }
        : { status: "absent", manifestSha256: null, assets: [] },
      audit: terminal.audit,
      auditResult: terminal.auditResult,
      abandonment: terminal.abandonment,
      smokes: smokeEvidence.smokes,
    })
  } catch (error) {
    addDiagnostic(
      diagnostics,
      "github",
      "releases",
      "AMBIGUOUS",
      safeCode(error?.code, "RELEASE_CONTENT_INVALID"),
    )
    return productionReleaseState({
      release: nonPresentRelease("ambiguous"),
      artifactState,
      escrow: { status: "ambiguous", manifestSha256: null, assets: [] },
    })
  }
}

async function mapProductionAttachingRelease({
  candidate,
  release,
  marker,
  remoteAssets,
  artifactState,
  github,
  attestations,
  diagnostics,
}) {
  if (release.draft !== true || release.immutable !== false) {
    throw observationError("ATTACHING_RELEASE_STATE_INVALID")
  }
  let manifest = artifactState.manifest
  let record = artifactState.record ?? null
  let sealedCi = artifactState.ci ?? null
  if (manifest === null) {
    const manifestAsset = remoteAssets.find((asset) => asset.name === "manifest.json")
    const recordAsset = remoteAssets.find((asset) => asset.name === "release-record.json")
    if (manifestAsset === undefined || recordAsset === undefined) {
      throw observationError("ATTACHING_ARTIFACT_CONTEXT_UNAVAILABLE")
    }
    const [manifestBytes, recordBytes] = await Promise.all([
      downloadReleaseBytes({ github, asset: manifestAsset, diagnostics }),
      downloadReleaseBytes({ github, asset: recordAsset, diagnostics }),
    ])
    if (
      manifestBytes === null ||
      recordBytes === null ||
      sha256(manifestBytes) !== marker.manifestSha256 ||
      sha256(recordBytes) !== marker.releaseRecordSha256
    ) {
      throw observationError("ATTACHING_ARTIFACT_CONTEXT_DIGEST_MISMATCH")
    }
    manifest = parseProductionManifest(manifestBytes, { candidate })
    sealedCi = await validateProductionManifestCi({
      manifest,
      candidate,
      github,
      diagnostics,
    })
    record = parseReleaseRecord(recordBytes)
    if (
      !manifestBytes.equals(canonicalManifestBytes(manifest)) ||
      !recordBytes.equals(canonicalReleaseRecordBytes(record)) ||
      record.version !== candidate.version ||
      record.commitSha !== candidate.commitSha ||
      record.manifestSha256 !== marker.manifestSha256 ||
      releaseRecordSha256(record) !== marker.releaseRecordSha256
    ) {
      throw observationError("ATTACHING_ARTIFACT_CONTEXT_IDENTITY_MISMATCH")
    }
  }
  if (record === null) {
    const recordAsset = remoteAssets.find((asset) => asset.name === "release-record.json")
    if (recordAsset !== undefined) {
      const recordBytes = await downloadReleaseBytes({
        github,
        asset: recordAsset,
        diagnostics,
      })
      if (recordBytes !== null) record = parseReleaseRecord(recordBytes)
    }
  }
  if (
    manifestSha256(manifest) !== marker.manifestSha256 ||
    (record !== null && releaseRecordSha256(record) !== marker.releaseRecordSha256) ||
    release.body !== canonicalReleaseBody({ marker, manifest })
  ) {
    throw observationError("ATTACHING_ARTIFACT_CONTEXT_MISMATCH")
  }

  const expectedPrepared = [
    { name: "release-record.json", sha256: marker.releaseRecordSha256 },
    { name: "manifest.json", sha256: marker.manifestSha256 },
    ...manifest.packages.map((pkg) => ({
      name: pkg.filename,
      sha256: pkg.sha256,
    })),
  ]
  const preparedByName = new Map(expectedPrepared.map((asset) => [asset.name, asset]))
  const bundleNames = new Set(
    canonicalAttestationSubjects(manifest).map((subject) => `${subject.name}.intoto.jsonl`),
  )
  if (
    remoteAssets.some((asset) => {
      const prepared = preparedByName.get(asset.name)
      return (
        (prepared === undefined && !bundleNames.has(asset.name)) ||
        (prepared !== undefined && asset.sha256 !== prepared.sha256)
      )
    })
  ) {
    throw observationError("ATTACHING_RELEASE_SUBSET_INVALID")
  }
  const releaseAssets = remoteAssets.map((asset) => ({
    name: asset.name,
    status: "matching",
    sha256: asset.sha256,
  }))
  const remotePreparedComplete = expectedPrepared.every((expected) =>
    remoteAssets.some((asset) => asset.name === expected.name && asset.sha256 === expected.sha256),
  )
  if (!remotePreparedComplete) {
    return productionReleaseState({
      release: {
        status: "draft",
        tag: `v${candidate.version}`,
        commitSha: candidate.commitSha,
        immutable: false,
        bodySha256: sha256(Buffer.from(release.body, "utf8")),
        marker,
        assets: releaseAssets,
      },
      artifactState,
      escrow: { status: "absent", manifestSha256: null, assets: [] },
    })
  }
  const downloaded = new Map()
  for (const asset of remoteAssets) {
    const bytes = await downloadReleaseBytes({ github, asset, diagnostics })
    if (bytes === null || sha256(bytes) !== asset.sha256) {
      throw observationError("ATTACHING_RELEASE_ASSET_DIGEST_MISMATCH")
    }
    downloaded.set(asset.name, bytes)
  }
  const remoteRecordBytes = downloaded.get("release-record.json")
  const remoteManifestBytes = downloaded.get("manifest.json")
  const remoteRecord = parseReleaseRecord(remoteRecordBytes)
  const remoteManifest = parseProductionManifest(remoteManifestBytes, {
    candidate,
  })
  sealedCi ??= await validateProductionManifestCi({
    manifest: remoteManifest,
    candidate,
    github,
    diagnostics,
  })
  if (
    !remoteRecordBytes.equals(canonicalReleaseRecordBytes(remoteRecord)) ||
    !remoteManifestBytes.equals(canonicalManifestBytes(remoteManifest)) ||
    releaseRecordSha256(remoteRecord) !== marker.releaseRecordSha256 ||
    remoteRecord.manifestSha256 !== marker.manifestSha256 ||
    !remoteManifestBytes.equals(canonicalManifestBytes(manifest))
  ) {
    throw observationError("ATTACHING_DURABLE_PREPARED_IDENTITY_MISMATCH")
  }
  const preparedInventory = inventoryFromManifest(artifactState.inventory, remoteManifest)
  const durablePreparedState = {
    inventory: preparedInventory,
    manifest: remoteManifest,
    record: remoteRecord,
    ci: sealedCi,
    artifacts: preparedArtifacts({
      inventory: preparedInventory,
      manifest: remoteManifest,
      recordSha256: releaseRecordSha256(remoteRecord),
    }),
  }
  const retainedBundles = remoteAssets.filter((asset) => bundleNames.has(asset.name))
  if (retainedBundles.length === 0) {
    return productionReleaseState({
      release: {
        status: "draft",
        tag: `v${candidate.version}`,
        commitSha: candidate.commitSha,
        immutable: false,
        bodySha256: sha256(Buffer.from(release.body, "utf8")),
        marker,
        assets: releaseAssets,
      },
      artifactState: durablePreparedState,
      escrow: { status: "absent", manifestSha256: null, assets: [] },
    })
  }
  const anchorBytes = downloaded.get(retainedBundles[0].name)
  if (
    retainedBundles.some(
      (asset) =>
        asset.sha256 !== retainedBundles[0].sha256 ||
        !downloaded.get(asset.name).equals(anchorBytes),
    )
  ) {
    throw observationError("ATTACHING_ATTESTATION_ANCHOR_MIXED")
  }
  const verified = await verifyReleaseAttestationAnchor({
    candidate,
    record: remoteRecord,
    artifact: {
      manifest: remoteManifest,
      files: [
        { name: "manifest.json", bytes: remoteManifestBytes },
        ...remoteManifest.packages.map((pkg) => ({
          name: pkg.filename,
          bytes: downloaded.get(pkg.filename),
        })),
      ],
    },
    bundleBytes: anchorBytes,
    attestations,
  })
  const observedInventory = inventoryFromAttestationSet({
    inventory: preparedInventory,
    manifest: remoteManifest,
    attestationSet: verified.attestationSet,
  })
  return productionReleaseState({
    release: {
      status: "draft",
      tag: `v${candidate.version}`,
      commitSha: candidate.commitSha,
      immutable: false,
      bodySha256: sha256(Buffer.from(release.body, "utf8")),
      marker,
      assets: releaseAssets,
    },
    artifactState: {
      inventory: observedInventory,
      manifest: remoteManifest,
      record: remoteRecord,
      ci: sealedCi,
      artifacts: attestedArtifacts({
        inventory: observedInventory,
        manifest: remoteManifest,
        recordSha256: releaseRecordSha256(remoteRecord),
        attestationSet: verified.attestationSet,
      }),
    },
    escrow: { status: "absent", manifestSha256: null, assets: [] },
  })
}

async function mapProductionAbandonmentRelease({
  candidate,
  controllerMarker,
  release,
  marker,
  remoteAssets,
  artifactState,
  github,
  attestations,
  diagnostics,
}) {
  if (
    release.draft !== true ||
    release.immutable !== false ||
    controllerMarker.abandonmentEnvironment !== "release-abandonment"
  ) {
    throw observationError("ABANDONMENT_RELEASE_STATE_INVALID")
  }
  const tombstone = parseAbandonmentReleaseBody(release.body)
  const tombstoneBytes = canonicalAbandonmentBytes(tombstone)
  if (sha256(tombstoneBytes) !== marker.abandonmentSha256) {
    throw observationError("ABANDONMENT_BODY_DIGEST_MISMATCH")
  }
  const terminalArtifact = {
    manifestSha256: marker.manifestSha256,
    releaseRecordSha256: marker.releaseRecordSha256,
    baseAssetSetSha256: marker.baseAssetSetSha256,
    attestationSet: marker.attestationSet,
  }
  if (!jsonValuesEqual(tombstone.predecessor.artifact, terminalArtifact)) {
    throw observationError("ABANDONMENT_PREDECESSOR_ARTIFACT_MISMATCH")
  }
  const escrowedPredecessor = marker.attestationSet !== null
  if (
    escrowedPredecessor
      ? tombstone.predecessor.state !== "CANDIDATE_ESCROWED" ||
        tombstone.predecessor.releaseStatus !== "draft" ||
        String(tombstone.predecessor.releaseId) !== String(release.id) ||
        tombstone.predecessor.marker?.phase !== "ESCROWED" ||
        !jsonValuesEqual(
          {
            manifestSha256: tombstone.predecessor.marker.manifestSha256,
            releaseRecordSha256: tombstone.predecessor.marker.releaseRecordSha256,
            baseAssetSetSha256: tombstone.predecessor.marker.baseAssetSetSha256,
            attestationSet: tombstone.predecessor.marker.attestationSet,
          },
          terminalArtifact,
        )
      : !["CANDIDATE_TAGGED", "ARTIFACTS_PREPARED"].includes(tombstone.predecessor.state) ||
        tombstone.predecessor.releaseStatus !== "absent" ||
        tombstone.predecessor.releaseId !== null ||
        tombstone.predecessor.bodySha256 !== null ||
        tombstone.predecessor.marker !== null
  ) {
    throw observationError("ABANDONMENT_PREDECESSOR_IDENTITY_MISMATCH")
  }
  const tombstones = remoteAssets.filter((asset) => asset.name === "abandonment.json")
  if (tombstones.length !== 1 || tombstones[0].sha256 !== marker.abandonmentSha256) {
    throw observationError("ABANDONMENT_ASSET_MISSING")
  }
  const remoteTombstone = await downloadReleaseBytes({
    github,
    asset: tombstones[0],
    diagnostics,
  })
  if (
    remoteTombstone === null ||
    sha256(remoteTombstone) !== marker.abandonmentSha256 ||
    !remoteTombstone.equals(tombstoneBytes)
  ) {
    throw observationError("ABANDONMENT_ASSET_DIGEST_MISMATCH")
  }

  const expectedBase = marker.attestationSet === null ? [] : markerBaseAssets(marker)
  const expectedByName = new Map(expectedBase.map((asset) => [asset.name, asset]))
  const baseAssets = remoteAssets.filter((asset) => asset.name !== "abandonment.json")
  if (
    baseAssets.some(
      (asset) =>
        isAuditAssetName(asset.name) ||
        !expectedByName.has(asset.name) ||
        expectedByName.get(asset.name).sha256 !== asset.sha256,
    )
  ) {
    throw observationError("ABANDONMENT_RETAINED_ASSET_INVALID")
  }
  if (
    marker.attestationSet !== null &&
    (baseAssets.length !== expectedBase.length ||
      expectedBase.some(
        (expected) =>
          !baseAssets.some(
            (asset) => asset.name === expected.name && asset.sha256 === expected.sha256,
          ),
      ))
  ) {
    throw observationError("ABANDONMENT_VERIFIABLE_BASE_INCOMPLETE")
  }

  let observedArtifactState =
    artifactState.retentionExpired === true
      ? {
          artifacts: emptyProductionArtifacts(artifactState.inventory),
          inventory: artifactState.inventory,
          manifest: null,
        }
      : artifactState
  let durableManifest = observedArtifactState.manifest
  if (durableManifest === null && marker.manifestSha256 !== null) {
    const retainedManifest = baseAssets.find((asset) => asset.name === "manifest.json")
    if (retainedManifest !== undefined) {
      const bytes = await downloadReleaseBytes({
        github,
        asset: retainedManifest,
        diagnostics,
      })
      if (bytes === null || sha256(bytes) !== marker.manifestSha256) {
        throw observationError("ABANDONMENT_MANIFEST_DIGEST_MISMATCH")
      }
      durableManifest = parseProductionManifest(bytes, { candidate })
      const sealedCi = await validateProductionManifestCi({
        manifest: durableManifest,
        candidate,
        github,
        diagnostics,
      })
      observedArtifactState = { ...observedArtifactState, ci: sealedCi }
      if (!bytes.equals(canonicalManifestBytes(durableManifest))) {
        throw observationError("ABANDONMENT_MANIFEST_NONCANONICAL")
      }
    }
  }
  if (durableManifest !== null && marker.manifestSha256 !== null) {
    if (
      manifestSha256(durableManifest) !== marker.manifestSha256 ||
      (observedArtifactState.manifest !== null &&
        (observedArtifactState.artifacts.manifestSha256 !== marker.manifestSha256 ||
          observedArtifactState.artifacts.releaseRecordAsset.sha256 !== marker.releaseRecordSha256))
    ) {
      throw observationError("ABANDONMENT_ARTIFACT_CONTEXT_MISMATCH")
    }
    const retainedRecord = baseAssets.find((asset) => asset.name === "release-record.json")
    let durableRecord = null
    if (retainedRecord !== undefined) {
      const bytes = await downloadReleaseBytes({
        github,
        asset: retainedRecord,
        diagnostics,
      })
      if (bytes === null || sha256(bytes) !== marker.releaseRecordSha256) {
        throw observationError("ABANDONMENT_RELEASE_RECORD_DIGEST_MISMATCH")
      }
      const record = parseReleaseRecord(bytes)
      if (
        !bytes.equals(canonicalReleaseRecordBytes(record)) ||
        record.version !== candidate.version ||
        record.commitSha !== candidate.commitSha ||
        record.manifestSha256 !== marker.manifestSha256 ||
        releaseRecordSha256(record) !== marker.releaseRecordSha256
      ) {
        throw observationError("ABANDONMENT_RELEASE_RECORD_IDENTITY_MISMATCH")
      }
      durableRecord = record
    }
    if (marker.attestationSet !== null) {
      if (durableRecord === null) {
        throw observationError("ABANDONMENT_RELEASE_RECORD_MISSING")
      }
      const predecessorBody = canonicalReleaseBody({
        marker: tombstone.predecessor.marker,
        manifest: durableManifest,
      })
      if (sha256(Buffer.from(predecessorBody, "utf8")) !== tombstone.predecessor.bodySha256) {
        throw observationError("ABANDONMENT_PREDECESSOR_BODY_MISMATCH")
      }
      await verifyDurableReleaseAttestation({
        candidate,
        manifest: durableManifest,
        record: durableRecord,
        marker,
        remoteAssets: baseAssets,
        github,
        attestations,
        diagnostics,
      })
    }
    const preparedInventory = inventoryFromManifest(
      observedArtifactState.inventory,
      durableManifest,
    )
    const observedInventory =
      marker.attestationSet === null
        ? preparedInventory
        : inventoryFromAttestationSet({
            inventory: preparedInventory,
            manifest: durableManifest,
            marker,
          })
    observedArtifactState = {
      inventory: observedInventory,
      manifest: durableManifest,
      artifacts:
        marker.attestationSet === null
          ? preparedArtifacts({
              inventory: observedInventory,
              manifest: durableManifest,
              recordSha256: marker.releaseRecordSha256,
            })
          : attestedArtifacts({
              inventory: observedInventory,
              manifest: durableManifest,
              recordSha256: marker.releaseRecordSha256,
              marker,
            }),
    }
  }
  const releaseAssets = remoteAssets.map((asset) => ({
    name: asset.name,
    status: "matching",
    sha256: asset.sha256,
  }))
  return productionReleaseState({
    release: {
      status: "draft",
      tag: `v${candidate.version}`,
      commitSha: candidate.commitSha,
      immutable: false,
      bodySha256: sha256(Buffer.from(release.body, "utf8")),
      marker,
      assets: releaseAssets,
    },
    artifactState: observedArtifactState,
    escrow: { status: "absent", manifestSha256: null, assets: [] },
    audit: emptyAudit(),
    abandonment: {
      requested: true,
      recorded: true,
      predecessor: tombstone.predecessor.state,
    },
  })
}

/** The ref a terminal record is read from is always explicit: never defaulted, never empty. */
function assertTerminalRecordRef(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Terminal record ref is invalid")
  }
}

/** The record must name exactly this candidate: version, commit, and its own self-consistent tag. */
function terminalRecordBindsCandidate(record, identity) {
  return (
    record.version === identity.version &&
    record.commitSha === identity.commitSha &&
    record.tag.name === `v${identity.version}` &&
    record.tag.commitSha === identity.commitSha
  )
}

/**
 * true  — no draft is visible (absent/ambiguous: the committed record stands alone), or the
 *         visible draft is the stamped abandonment whose marker digest and tombstone asset
 *         digest both equal the record's canonical SHA-256.
 * false — a draft is visible but is not the stamped tombstone for this exact record.
 * The numeric Release ID is not part of the observation; the apply command verifies it.
 */
function terminalRecordMatchesRelease(record, release) {
  // An already-ambiguous release means GitHub itself was unreadable, not that the draft
  // contradicts the record; that path carries its own AMBIGUOUS diagnostic, so the committed
  // record still stands alone here rather than being reported as a mismatch.
  if (release.status === "absent" || release.status === "ambiguous") return true
  if (release.status !== "draft") return false
  const marker = release.marker
  if (
    marker === null ||
    marker.phase !== "ABANDONED_PREPUBLICATION" ||
    marker.abandonmentSha256 !== record.sha256
  ) {
    return false
  }
  const tombstones = release.assets.filter((asset) => asset.name === "abandonment.json")
  return tombstones.length === 1 && tombstones[0].sha256 === record.sha256
}

function normalizeReleaseIdentity(value, candidate) {
  const allowedTitles = new Set([
    `Dawn v${candidate.version}`,
    `Dawn v${candidate.version} (abandoned before publication)`,
  ])
  if (
    !isRecord(value) ||
    !isPositiveId(value.id) ||
    !allowedTitles.has(value.name) ||
    (!(value.draft === true && value.immutable === false) &&
      value.tag_name !== `v${candidate.version}`) ||
    value.target_commitish !== "main" ||
    typeof value.draft !== "boolean" ||
    typeof value.immutable !== "boolean" ||
    value.prerelease !== false ||
    !(value.body === undefined || value.body === null || typeof value.body === "string")
  ) {
    throw observationError("RELEASE_IDENTITY_INVALID")
  }
  return {
    id: value.id,
    name: value.name,
    targetCommitish: value.target_commitish,
    draft: value.draft,
    immutable: value.immutable,
    body: value.body ?? null,
  }
}

function normalizeReleaseAssetInventory(value) {
  if (!Array.isArray(value) || value.length > MAX_PUBLICATION_ASSETS) {
    throw observationError("RELEASE_ASSET_INVENTORY_INVALID")
  }
  const ids = new Set()
  const names = new Set()
  return value.map((asset) => {
    const sha256 = normalizeAssetDigest(asset?.digest)
    if (
      !isRecord(asset) ||
      !isPositiveId(asset.id) ||
      typeof asset.name !== "string" ||
      !/^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(asset.name) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1 ||
      ids.has(String(asset.id)) ||
      names.has(asset.name)
    ) {
      throw observationError("RELEASE_ASSET_IDENTITY_INVALID")
    }
    ids.add(String(asset.id))
    names.add(asset.name)
    return { id: asset.id, name: asset.name, sha256, size: asset.size }
  })
}

function assertReleaseAssetBudgets(assets) {
  let tarballs = 0
  let bundles = 0
  let audit = 0
  let auditAssets = 0
  let base = 0
  let smoke = 0
  let smokeAssets = 0
  const smokeAttempts = new Set()
  for (const asset of assets) {
    let maximum
    const smokeIdentity = parseSmokeReleaseAssetName(asset.name)
    if (asset.name === "release-record.json") {
      maximum = RELEASE_PAYLOAD_LIMITS.releaseRecordBytes
      base += asset.size
    } else if (asset.name === "manifest.json") {
      maximum = RELEASE_PAYLOAD_LIMITS.manifestBytes
      base += asset.size
    } else if (asset.name.endsWith(".tgz")) {
      maximum = RELEASE_PAYLOAD_LIMITS.tarballBytes
      tarballs += asset.size
      base += asset.size
    } else if (asset.name.endsWith(".intoto.jsonl")) {
      maximum = RELEASE_PAYLOAD_LIMITS.attestationBundleBytes
      bundles += asset.size
      base += asset.size
    } else if (smokeIdentity !== null) {
      maximum = RELEASE_PAYLOAD_LIMITS.smokeReceiptBytes
      smoke += asset.size
      smokeAssets += 1
      smokeAttempts.add(`${smokeIdentity.workflowRunId}:${smokeIdentity.runAttempt}`)
    } else if (isAuditAssetName(asset.name) || asset.name === "abandonment.json") {
      maximum = RELEASE_PAYLOAD_LIMITS.auditReceiptBytes
      audit += asset.size
      auditAssets += 1
    } else {
      throw observationError("RELEASE_ASSET_NAMESPACE_INVALID")
    }
    if (asset.size > maximum) {
      throw observationError("RELEASE_ASSET_SIZE_LIMIT_EXCEEDED")
    }
  }
  if (
    tarballs > RELEASE_PAYLOAD_LIMITS.preparedTarballsBytes ||
    bundles > RELEASE_PAYLOAD_LIMITS.attestationBundlesBytes ||
    base > RELEASE_PAYLOAD_LIMITS.escrowBytes ||
    audit > RELEASE_PAYLOAD_LIMITS.auditEvidenceBytes ||
    auditAssets > MAX_AUDIT_ATTEMPTS + 1 ||
    smoke > RELEASE_PAYLOAD_LIMITS.smokeReceiptsBytes ||
    smokeAssets > MAX_SMOKE_ASSETS ||
    smokeAttempts.size > MAX_SMOKE_ATTEMPTS
  ) {
    throw observationError("RELEASE_ASSET_SIZE_LIMIT_EXCEEDED")
  }
}

function uniqueRemoteAsset(assets, name) {
  const matches = assets.filter((asset) => asset.name === name)
  if (matches.length !== 1 || matches[0].sha256 === null) {
    throw observationError("RELEASE_REQUIRED_ASSET_MISSING")
  }
  return matches[0]
}

async function downloadReleaseBytes({ github, asset, diagnostics }) {
  const result = await observeAdapter(
    () =>
      github.downloadReleaseAsset({
        assetId: asset.id,
        maximumBytes: asset.size,
      }),
    {
      source: "github",
      operation: "release-asset-download",
      payloadKey: "contentBase64",
      diagnostics,
    },
  )
  if (result.status !== "PRESENT" || typeof result.contentBase64 !== "string") return null
  const bytes = Buffer.from(result.contentBase64, "base64")
  return bytes.length === asset.size && bytes.toString("base64") === result.contentBase64
    ? bytes
    : null
}

async function verifyDurableReleaseAttestation({
  candidate,
  manifest,
  record,
  marker,
  remoteAssets,
  github,
  attestations,
  diagnostics,
}) {
  const expected = markerBaseAssets(marker)
  const byName = new Map(remoteAssets.map((asset) => [asset.name, asset]))
  const bytesByName = new Map()
  for (const descriptor of expected) {
    const asset = byName.get(descriptor.name)
    if (asset === undefined || asset.sha256 !== descriptor.sha256) {
      throw observationError("RELEASE_VERIFIABLE_BASE_INCOMPLETE")
    }
    const bytes = await downloadReleaseBytes({ github, asset, diagnostics })
    if (bytes === null || sha256(bytes) !== descriptor.sha256) {
      throw observationError("RELEASE_VERIFIABLE_BASE_DIGEST_MISMATCH")
    }
    bytesByName.set(descriptor.name, bytes)
  }
  const anchor = bytesByName.get(marker.attestationSet.subjects[0].bundleName)
  if (
    marker.attestationSet.subjects.some(
      (subject) => !bytesByName.get(subject.bundleName)?.equals(anchor),
    )
  ) {
    throw observationError("RELEASE_ATTESTATION_BUNDLE_SET_MIXED")
  }
  const verified = await verifyReleaseAttestationAnchor({
    candidate,
    record,
    artifact: {
      manifest,
      files: [
        { name: "manifest.json", bytes: bytesByName.get("manifest.json") },
        ...manifest.packages.map((pkg) => ({
          name: pkg.filename,
          bytes: bytesByName.get(pkg.filename),
        })),
      ],
    },
    bundleBytes: anchor,
    attestations,
  })
  if (verified.baseAssetSetSha256 !== marker.baseAssetSetSha256) {
    throw observationError("RELEASE_ATTESTATION_BASE_DIGEST_MISMATCH")
  }
  if (!jsonValuesEqual(verified.attestationSet, marker.attestationSet)) {
    throw observationError("RELEASE_ATTESTATION_CRYPTOGRAPHIC_IDENTITY_MISMATCH")
  }
  await validateRetainedAttestationRun({
    candidate,
    attestationSet: verified.attestationSet,
    github,
  })
}

async function validateRetainedAttestationRun({ candidate, attestationSet, github }) {
  const [runResult, jobsResult] = await Promise.all([
    observeOptionalCorroboration(
      () =>
        github.getActionsRunAttempt({
          runId: attestationSet.workflowRunId,
          attempt: attestationSet.runAttempt,
        }),
      {
        source: "github",
        operation: "actions-run-attempt",
        payloadKey: "value",
      },
    ),
    observeOptionalCorroboration(
      () => github.listActionsRunJobs({ runId: attestationSet.workflowRunId }),
      {
        source: "github",
        operation: "actions-run-jobs",
        payloadKey: "value",
      },
    ),
  ])
  if (runResult?.status !== "PRESENT" || jobsResult?.status !== "PRESENT") return
  const run = runResult.value
  const runTerminal = run?.status === "completed"
  if (
    runResult.status !== "PRESENT" ||
    !isRecord(run) ||
    run.id !== attestationSet.workflowRunId ||
    run.run_attempt !== attestationSet.runAttempt ||
    run.path !== candidate.publisherWorkflow ||
    run.head_sha !== candidate.commitSha ||
    run.head_branch !== `v${candidate.version}` ||
    !["push", "workflow_dispatch", "schedule"].includes(run.event) ||
    !ACTIONS_RUN_STATUSES.includes(run.status) ||
    (run.status === "completed"
      ? !ACTIONS_TERMINAL_CONCLUSIONS.includes(run.conclusion)
      : run.conclusion !== null) ||
    runTerminal !== (run.conclusion !== null)
  ) {
    throw observationError("RELEASE_ATTESTATION_RUN_IDENTITY_MISMATCH")
  }
  if (!retainedWinnerJobsCorrelate(jobsResult.value, attestationSet.runAttempt)) {
    throw observationError("RELEASE_ATTESTATION_RUN_JOB_HISTORY_INVALID")
  }
}

function retainedWinnerJobsCorrelate(value, winnerAttempt) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) return false
  const identities = new Set()
  let publisherJobs = 0
  for (const job of value) {
    if (
      !hasExactKeys(job, [
        "id",
        "runAttempt",
        "name",
        "status",
        "conclusion",
        "startedAt",
        "completedAt",
      ]) ||
      !isPositiveSafeInteger(job.id) ||
      !isPositiveSafeInteger(job.runAttempt) ||
      typeof job.name !== "string" ||
      job.name.length === 0 ||
      !ACTIONS_RUN_STATUSES.includes(job.status) ||
      (job.status === "completed"
        ? !ACTIONS_TERMINAL_CONCLUSIONS.includes(job.conclusion)
        : job.conclusion !== null) ||
      !isNullableTimestamp(job.startedAt) ||
      !isNullableTimestamp(job.completedAt)
    ) {
      return false
    }
    const terminal = job.status === "completed"
    if (
      terminal !== (job.conclusion !== null) ||
      terminal !== (job.completedAt !== null) ||
      (job.completedAt !== null && job.startedAt === null)
    ) {
      return false
    }
    const identity = `${job.runAttempt}:${job.id}`
    if (identities.has(identity)) return false
    identities.add(identity)
    if (job.runAttempt === winnerAttempt && job.name === "publish-npm") publisherJobs += 1
  }
  return publisherJobs === 1
}

async function observeOptionalCorroboration(call, options) {
  try {
    return normalizeAdapterEnvelope(await call(), options)
  } catch {
    return null
  }
}

function jsonValuesEqual(left, right) {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    )
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort(compareText)
  const rightKeys = Object.keys(right).sort(compareText)
  return (
    arraysEqual(leftKeys, rightKeys) &&
    leftKeys.every((key) => jsonValuesEqual(left[key], right[key]))
  )
}

function inventoryFromAttestationSet({ inventory, manifest, marker, attestationSet }) {
  const observedSet = attestationSet ?? marker?.attestationSet
  const subjects = observedSet?.subjects
  const expectedSubjects = canonicalAttestationSubjects(manifest)
  if (
    !Array.isArray(subjects) ||
    subjects.length !== 22 ||
    observedSet.repository !== "cacheplane/dawnai" ||
    observedSet.workflow !== ".github/workflows/release.yml" ||
    observedSet.sourceRef !== `refs/tags/v${manifest.version}` ||
    observedSet.commitSha !== manifest.commitSha ||
    !isPositiveSafeInteger(observedSet.workflowRunId) ||
    !isPositiveSafeInteger(observedSet.runAttempt)
  ) {
    throw observationError("RELEASE_ATTESTATION_SET_INVALID")
  }
  if (
    subjects.some(
      (subject, index) =>
        subject?.subjectName !== expectedSubjects[index].name ||
        subject.subjectSha256 !== expectedSubjects[index].sha256 ||
        subject.bundleName !== `${expectedSubjects[index].name}.intoto.jsonl` ||
        !SHA256_PATTERN.test(subject.bundleSha256),
    )
  ) {
    throw observationError("RELEASE_ATTESTATION_SET_INVALID")
  }
  const bySubject = new Map(subjects.map((subject) => [subject.subjectName, subject]))
  return {
    status: inventory.status,
    packages: inventory.packages.map((pkg) => {
      const subject = bySubject.get(pkg.filename)
      if (
        subject?.subjectSha256 !== pkg.tarballSha256 ||
        subject.bundleName !== pkg.attestationFilename ||
        !SHA256_PATTERN.test(subject.bundleSha256)
      ) {
        throw observationError("RELEASE_ATTESTATION_SET_INVALID")
      }
      return { ...pkg, attestationSha256: subject.bundleSha256 }
    }),
  }
}

function attestedArtifacts({ inventory, manifest, recordSha256, marker, attestationSet }) {
  const prepared = preparedArtifacts({ inventory, manifest, recordSha256 })
  const observedSet = attestationSet ?? marker?.attestationSet
  const subjects = new Map(observedSet.subjects.map((subject) => [subject.subjectName, subject]))
  return {
    ...prepared,
    status: "attested",
    manifestAttestationAsset: {
      name: "manifest.json.intoto.jsonl",
      sha256: subjects.get("manifest.json").bundleSha256,
    },
    attestations: prepared.attestations.map((attestation) => {
      const subject = subjects.get(attestation.subjectName)
      return { ...attestation, status: "valid", sha256: subject.bundleSha256 }
    }),
  }
}

function markerBaseAssets(marker) {
  const assets = [
    { name: "release-record.json", sha256: marker.releaseRecordSha256 },
    { name: "manifest.json", sha256: marker.manifestSha256 },
    ...marker.attestationSet.subjects.slice(1).map((subject) => ({
      name: subject.subjectName,
      sha256: subject.subjectSha256,
    })),
    ...marker.attestationSet.subjects.map((subject) => ({
      name: subject.bundleName,
      sha256: subject.bundleSha256,
    })),
  ]
  if (
    assets.length !== 45 ||
    new Set(assets.map((asset) => asset.name)).size !== 45 ||
    assets.some((asset) => !SHA256_PATTERN.test(asset.sha256)) ||
    sha256(Buffer.from(`${JSON.stringify(assets)}\n`, "utf8")) !== marker.baseAssetSetSha256
  ) {
    throw observationError("RELEASE_BASE_NAMESPACE_INVALID")
  }
  return assets
}

async function observeReleaseTerminal({
  candidate,
  release,
  marker,
  remoteAssets,
  github,
  diagnostics,
}) {
  const baseNames = new Set(markerBaseAssets(marker).map((asset) => asset.name))
  const terminalAssets = remoteAssets.filter(
    (asset) => !baseNames.has(asset.name) && parseSmokeReleaseAssetName(asset.name) === null,
  )
  if (marker.phase === "ABANDONED_PREPUBLICATION") {
    throw observationError("ABANDONMENT_RECORD_UNREAD")
  }
  if (terminalAssets.some((asset) => !isAuditAssetName(asset.name))) {
    throw observationError("RELEASE_TERMINAL_NAMESPACE_INVALID")
  }
  const auditPhase = ["AUDIT_DISPATCHED", "AUDIT_RETRYABLE", "AUDIT_VERIFIED"].includes(
    marker.phase,
  )
  if (!auditPhase) {
    if (terminalAssets.length !== 0) throw observationError("RELEASE_AUDIT_ASSET_PREMATURE")
    return {
      audit: emptyAudit(),
      auditResult: null,
      abandonment: { requested: false, recorded: false, predecessor: null },
      assets: [],
    }
  }

  const runId = marker.audit.workflowRunId
  const exactAttempt = marker.audit.runAttempt
  const runOperation = exactAttempt === null ? "actions-run" : "actions-run-attempt"
  const [runResult, jobsResult] = await Promise.all([
    observeAdapter(
      () =>
        exactAttempt === null
          ? github.getActionsRun({ runId })
          : github.getActionsRunAttempt({ runId, attempt: exactAttempt }),
      {
        source: "github",
        operation: runOperation,
        payloadKey: "value",
        diagnostics,
      },
    ),
    observeAdapter(() => github.listActionsRunJobs({ runId }), {
      source: "github",
      operation: "actions-run-jobs",
      payloadKey: "value",
      diagnostics,
    }),
  ])
  if (runResult.status !== "PRESENT" || jobsResult.status !== "PRESENT") {
    throw observationError("RELEASE_AUDIT_RUN_AMBIGUOUS")
  }
  const run = validateProductionAuditRun({
    value: runResult.value,
    jobs:
      exactAttempt === null
        ? jobsResult.value
        : jobsResult.value.filter((job) => job?.runAttempt <= exactAttempt),
    candidate,
    marker,
  })
  const downloaded = []
  for (const asset of terminalAssets) {
    const bytes = await downloadReleaseBytes({ github, asset, diagnostics })
    if (bytes === null || sha256(bytes) !== asset.sha256) {
      throw observationError("RELEASE_AUDIT_ASSET_DIGEST_MISMATCH")
    }
    const result = parseCanonicalAuditBytes(bytes)
    if (
      result.version !== candidate.version ||
      result.commitSha !== candidate.commitSha ||
      result.manifestSha256 !== marker.manifestSha256
    ) {
      throw observationError("RELEASE_AUDIT_RECEIPT_IDENTITY_MISMATCH")
    }
    downloaded.push({ name: asset.name, bytes, result, sha256: asset.sha256 })
  }
  validateAuditAssetPhase({ marker, downloaded })
  const status =
    marker.phase === "AUDIT_VERIFIED"
      ? "success"
      : marker.phase === "AUDIT_RETRYABLE"
        ? "failed"
        : "dispatched"
  const conclusion = status === "dispatched" ? null : marker.audit.conclusion
  if (
    (status === "success" && (run.status !== "completed" || run.conclusion !== "success")) ||
    (status === "failed" &&
      (run.status !== "completed" ||
        !ACTIONS_TERMINAL_CONCLUSIONS.includes(run.conclusion) ||
        run.conclusion === "success"))
  ) {
    throw observationError("RELEASE_AUDIT_RUN_CONCLUSION_MISMATCH")
  }
  if (release.draft === false && (status !== "success" || release.immutable !== true)) {
    throw observationError("RELEASE_PUBLICATION_TERMINAL_INVALID")
  }
  return {
    audit: {
      status,
      version: candidate.version,
      commitSha: candidate.commitSha,
      manifestSha256: marker.manifestSha256,
      workflowRunId: runId,
      runAttempt: run.runAttempt,
      conclusion,
    },
    auditResult: downloaded.find((asset) => asset.name === "audit-result.json")?.result ?? null,
    abandonment: { requested: false, recorded: false, predecessor: null },
    assets: downloaded.map((asset) => ({
      name: asset.name,
      sha256: asset.sha256,
    })),
  }
}

export function validateProductionAuditRun({ value, jobs, candidate, marker }) {
  if (
    !isRecord(value) ||
    String(value.id) !== String(marker.audit.workflowRunId) ||
    !isPositiveSafeInteger(value.run_attempt) ||
    value.run_attempt > MAX_AUDIT_ATTEMPTS ||
    value.head_sha !== candidate.commitSha ||
    value.head_branch !== `v${candidate.version}` ||
    value.event !== "workflow_dispatch" ||
    value.path !== ".github/workflows/published-artifact-verify.yml" ||
    !ACTIONS_RUN_STATUSES.includes(value.status) ||
    (value.status === "completed"
      ? !ACTIONS_TERMINAL_CONCLUSIONS.includes(value.conclusion)
      : value.conclusion !== null) ||
    (marker.audit.runAttempt !== null && marker.audit.runAttempt !== value.run_attempt) ||
    !Array.isArray(jobs) ||
    jobs.length === 0
  ) {
    throw observationError("RELEASE_AUDIT_RUN_IDENTITY_MISMATCH")
  }
  const identities = new Set()
  const currentAttemptJobs = []
  const verifyJobsByAttempt = new Map()
  let coveredAttempt = 0
  let previousAttempt = 0
  let previousId = 0
  for (const job of jobs) {
    if (
      !isRecord(job) ||
      !isPositiveSafeInteger(job.id) ||
      !isPositiveSafeInteger(job.runAttempt) ||
      job.runAttempt > value.run_attempt ||
      typeof job.name !== "string" ||
      job.name.length === 0 ||
      !ACTIONS_RUN_STATUSES.includes(job.status) ||
      (job.status === "completed"
        ? !ACTIONS_TERMINAL_CONCLUSIONS.includes(job.conclusion)
        : job.conclusion !== null) ||
      !isNullableTimestamp(job.startedAt) ||
      !isNullableTimestamp(job.completedAt) ||
      job.runAttempt < previousAttempt ||
      (job.runAttempt === previousAttempt && job.id <= previousId)
    ) {
      throw observationError("RELEASE_AUDIT_JOB_IDENTITY_MISMATCH")
    }
    const identity = `${job.runAttempt}:${job.id}`
    if (identities.has(identity)) throw observationError("RELEASE_AUDIT_JOB_IDENTITY_MISMATCH")
    identities.add(identity)
    if (job.runAttempt > coveredAttempt) {
      if (job.runAttempt !== coveredAttempt + 1) {
        throw observationError("RELEASE_AUDIT_JOB_ATTEMPT_COVERAGE_INCOMPLETE")
      }
      coveredAttempt = job.runAttempt
    }
    if (job.runAttempt === value.run_attempt) currentAttemptJobs.push(job)
    if (job.name === "verify") {
      const verifyJobs = verifyJobsByAttempt.get(job.runAttempt) ?? []
      verifyJobs.push(job)
      verifyJobsByAttempt.set(job.runAttempt, verifyJobs)
    }
    const terminal =
      job.status === "completed" && job.conclusion !== null && job.completedAt !== null
    if (
      (job.status === "completed" && !terminal) ||
      (job.status !== "completed" && (job.conclusion !== null || job.completedAt !== null)) ||
      (job.runAttempt < value.run_attempt && !terminal)
    ) {
      throw observationError("RELEASE_AUDIT_JOB_TERMINAL_MISMATCH")
    }
    previousAttempt = job.runAttempt
    previousId = job.id
  }
  if (coveredAttempt !== value.run_attempt) {
    throw observationError("RELEASE_AUDIT_JOB_ATTEMPT_COVERAGE_INCOMPLETE")
  }
  for (let attempt = 1; attempt <= value.run_attempt; attempt += 1) {
    const verifyJobs = verifyJobsByAttempt.get(attempt) ?? []
    if (verifyJobs.length !== 1) {
      throw observationError("RELEASE_AUDIT_VERIFY_JOB_IDENTITY_MISMATCH")
    }
    const [verifyJob] = verifyJobs
    if (
      attempt < value.run_attempt
        ? verifyJob.status !== "completed" ||
          verifyJob.conclusion === null ||
          verifyJob.conclusion === "success" ||
          verifyJob.startedAt === null ||
          verifyJob.completedAt === null
        : value.status === "completed" &&
          (verifyJob.status !== "completed" ||
            (value.conclusion === "success"
              ? verifyJob.conclusion !== "success"
              : verifyJob.conclusion === "success") ||
            verifyJob.startedAt === null ||
            verifyJob.completedAt === null)
    ) {
      throw observationError("RELEASE_AUDIT_VERIFY_JOB_TERMINAL_MISMATCH")
    }
  }
  if (
    (value.status === "completed" &&
      (value.conclusion === null ||
        currentAttemptJobs.some(
          (job) =>
            job.status !== "completed" || job.conclusion === null || job.completedAt === null,
        ) ||
        (value.conclusion === "success" &&
          currentAttemptJobs.some(
            (job) => !["success", "neutral", "skipped"].includes(job.conclusion),
          )))) ||
    (value.status !== "completed" && value.conclusion !== null)
  ) {
    throw observationError("RELEASE_AUDIT_JOB_TERMINAL_MISMATCH")
  }
  return {
    status: value.status,
    conclusion: value.conclusion,
    runAttempt: value.run_attempt,
  }
}

function validateAuditAssetPhase({ marker, downloaded }) {
  if (marker.phase === "AUDIT_VERIFIED") {
    validatePublicationAuditAssets(
      downloaded.map((asset) => ({ name: asset.name, bytes: asset.bytes })),
      { marker },
    )
    return
  }
  if (downloaded.some((asset) => asset.name === "audit-result.json")) {
    throw observationError("RELEASE_AUDIT_CANONICAL_PREMATURE")
  }
  const identities = new Set()
  let current = null
  for (const asset of downloaded) {
    const match = /^audit-attempt-([1-9][0-9]*)-([1-9][0-9]*)\.json$/u.exec(asset.name)
    if (
      match === null ||
      Number(match[1]) !== asset.result.workflowRunId ||
      Number(match[2]) !== asset.result.runAttempt ||
      identities.has(`${match[1]}:${match[2]}`)
    ) {
      throw observationError("RELEASE_AUDIT_ATTEMPT_IDENTITY_MISMATCH")
    }
    identities.add(`${match[1]}:${match[2]}`)
    if (asset.result.workflowRunId === marker.audit.workflowRunId) {
      if (current !== null) throw observationError("RELEASE_AUDIT_CURRENT_ATTEMPT_AMBIGUOUS")
      current = asset
    } else if (asset.result.conclusion !== "failure") {
      throw observationError("RELEASE_AUDIT_HISTORY_INVALID")
    }
  }
  if (marker.phase === "AUDIT_RETRYABLE") {
    if (
      current?.name !== marker.audit.attemptAssetName ||
      current?.sha256 !== marker.audit.attemptSha256 ||
      current?.result.conclusion !== "failure"
    ) {
      throw observationError("RELEASE_AUDIT_RETRYABLE_EVIDENCE_INVALID")
    }
  } else if (current !== null) {
    throw observationError("RELEASE_AUDIT_DISPATCH_EVIDENCE_PREMATURE")
  }
}

function parseCanonicalAuditBytes(bytes) {
  let value
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw observationError("RELEASE_AUDIT_ASSET_MALFORMED")
  }
  const result = parseAuditResult(value)
  if (!bytes.equals(canonicalAuditResultBytes(result))) {
    throw observationError("RELEASE_AUDIT_ASSET_NONCANONICAL")
  }
  return result
}

function isAuditAssetName(value) {
  return (
    value === "audit-result.json" || /^audit-attempt-[1-9][0-9]*-[1-9][0-9]*\.json$/u.test(value)
  )
}

function isNullableTimestamp(value) {
  return (
    value === null ||
    (typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)))
  )
}

function productionReleaseState({
  release,
  artifactState,
  escrow,
  audit = emptyAudit(),
  auditResult = null,
  abandonment = { requested: false, recorded: false, predecessor: null },
  smokes = [],
}) {
  return {
    release,
    artifactState,
    escrow,
    audit,
    auditResult,
    abandonment,
    smokes,
  }
}

function productionRecovery({ candidate, artifactState, releaseState, npmEvidence }) {
  const audit = releaseState.release.marker?.audit
  const auditDispatch =
    isRecord(audit) &&
    audit.workflow === ".github/workflows/published-artifact-verify.yml" &&
    isPositiveId(audit.workflowRunId) &&
    typeof audit.runUrl === "string" &&
    typeof audit.htmlUrl === "string"
      ? {
          workflow: audit.workflow,
          workflowRunId: Number(audit.workflowRunId),
          runUrl: audit.runUrl,
          htmlUrl: audit.htmlUrl,
        }
      : null
  return {
    schemaVersion: 1,
    candidate,
    manifest: artifactState.manifest ?? null,
    releaseRecord: artifactState.record ?? null,
    npmEvidence,
    auditDispatch,
    auditResult: releaseState.auditResult,
  }
}

async function mapProductionRegistryPackage({
  result,
  expected,
  candidate,
  manifest,
  npm,
  npmAuditVerifier,
  diagnostics,
}) {
  if (result.status === "ABSENT") return absentRegistryPackage(expected.name)
  if (result.status !== "PRESENT") return ambiguousRegistryPackage(expected.name)
  const pkg = result.package
  const entry = manifest?.packages?.find((item) => item.name === expected.name)
  if (
    !isRecord(pkg) ||
    pkg.name !== expected.name ||
    pkg.version !== expected.version ||
    !isRecord(entry) ||
    entry.name !== expected.name ||
    entry.version !== expected.version ||
    expected.tarballSha256 !== entry.sha256 ||
    expected.integrity !== entry.npmIntegrity ||
    pkg.integrity !== entry.npmIntegrity ||
    !isExactRegistryTarballUrl(pkg.tarballUrl, entry) ||
    typeof pkg.shasum !== "string" ||
    !/^[0-9a-f]{40}$/u.test(pkg.shasum) ||
    !isRecord(pkg.distTags) ||
    pkg.latest !== pkg.distTags.latest
  ) {
    addDiagnostic(diagnostics, "npm", "package-version", "ERROR", "PACKAGE_IDENTITY_MISMATCH")
    return ambiguousRegistryPackage(expected.name)
  }
  if (npmAuditVerifier === null) return ambiguousRegistryPackage(expected.name)

  const tarballResult = await observeAdapter(
    () => npm.downloadRegistryTarball({ tarballUrl: pkg.tarballUrl }),
    {
      source: "npm",
      operation: "package-tarball",
      payloadKey: "tarball",
      diagnostics,
    },
  )
  if (tarballResult.status !== "PRESENT") return ambiguousRegistryPackage(expected.name)
  const tarball = tarballResult.tarball
  if (!exactRegistryTarball(tarball, pkg, entry)) {
    addDiagnostic(diagnostics, "npm", "package-tarball", "AMBIGUOUS", "NPM_BYTES_MISMATCH")
    return ambiguousRegistryPackage(expected.name)
  }

  let audit
  try {
    audit = snapshotJson(await npmAuditVerifier.verifyPackage({ entry, candidate }))
  } catch (error) {
    addDiagnostic(
      diagnostics,
      "npm",
      "audit-signatures",
      "AMBIGUOUS",
      safeCode(error?.code, "OFFICIAL_NPM_AUDIT_FAILED"),
    )
    return ambiguousRegistryPackage(expected.name)
  }
  if (!exactNpmAuditEvidence(audit, candidate)) {
    addDiagnostic(
      diagnostics,
      "npm",
      "audit-signatures",
      "AMBIGUOUS",
      "OFFICIAL_NPM_AUDIT_IDENTITY_MISMATCH",
    )
    return ambiguousRegistryPackage(expected.name)
  }

  const latest =
    pkg.latest === null
      ? { status: "e404", version: null }
      : isReleaseVersion(pkg.latest)
        ? { status: "present", version: pkg.latest }
        : { status: "ambiguous", version: null }
  if (latest.status === "ambiguous") {
    addDiagnostic(diagnostics, "npm", "package-metadata", "AMBIGUOUS", "LATEST_INVALID")
    return ambiguousRegistryPackage(expected.name)
  }
  return {
    name: expected.name,
    status: "present",
    version: expected.version,
    tarballSha256: entry.sha256,
    integrity: entry.npmIntegrity,
    latest,
    signature: { status: "valid" },
    provenance: {
      workflow: audit.provenance.workflow,
      commitSha: audit.provenance.commitSha,
    },
  }
}

function createObservedNpmEvidence({ candidate, manifest, registryPackages }) {
  if (!isRecord(manifest)) return null
  const entries = new Map(manifest.packages.map((entry) => [entry.name, entry]))
  const observed = new Map(registryPackages.map((pkg) => [pkg.name, pkg]))
  const packages = []
  for (const name of CANONICAL_RELEASE_PACKAGE_ORDER) {
    const entry = entries.get(name)
    const pkg = observed.get(name)
    if (
      !isRecord(entry) ||
      !isRecord(pkg) ||
      pkg.status !== "present" ||
      pkg.version !== candidate.version ||
      pkg.tarballSha256 !== entry.sha256 ||
      pkg.integrity !== entry.npmIntegrity ||
      pkg.latest?.status !== "present" ||
      pkg.latest.version !== candidate.version ||
      pkg.signature?.status !== "valid" ||
      pkg.provenance?.workflow !== candidate.publisherWorkflow ||
      pkg.provenance.commitSha !== candidate.commitSha
    ) {
      return null
    }
    packages.push({
      name,
      version: candidate.version,
      status: "present",
      size: entry.size,
      tarballSha256: entry.sha256,
      tarballSha512: entry.sha512,
      integrity: entry.npmIntegrity,
      latest: { status: "present", version: candidate.version },
      signature: { status: "valid", verifier: NPM_AUDIT_VERIFIER },
      provenance: {
        predicateType: "https://slsa.dev/provenance/v1",
        workflow: candidate.publisherWorkflow,
        commitSha: candidate.commitSha,
        repository: "https://github.com/cacheplane/dawnai",
        ref: `refs/tags/v${candidate.version}`,
      },
    })
  }
  const bytes = canonicalNpmEvidenceBytes(
    {
      schemaVersion: 1,
      version: candidate.version,
      commitSha: candidate.commitSha,
      manifestSha256: manifestSha256(manifest),
      complete: true,
      status: "NPM_COMPLETE",
      packages,
    },
    {
      candidate,
      manifest,
      manifestSha256: manifestSha256(manifest),
    },
  )
  return JSON.parse(bytes.toString("utf8"))
}

function isExactRegistryTarballUrl(value, entry) {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    const unscopedName = entry.name.includes("/")
      ? entry.name.slice(entry.name.lastIndexOf("/") + 1)
      : entry.name
    const expected = `https://registry.npmjs.org/${entry.name}/-/${unscopedName}-${entry.version}.tgz`
    return (
      url.origin === "https://registry.npmjs.org" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.href === expected
    )
  } catch {
    return false
  }
}

function exactRegistryTarball(tarball, pkg, entry) {
  if (
    !isRecord(tarball) ||
    tarball.url !== pkg.tarballUrl ||
    tarball.size !== entry.size ||
    tarball.sha1 !== pkg.shasum ||
    tarball.sha256 !== entry.sha256 ||
    tarball.sha512 !== entry.sha512 ||
    typeof tarball.contentBase64 !== "string"
  ) {
    return false
  }
  const bytes = Buffer.from(tarball.contentBase64, "base64")
  return (
    bytes.length === entry.size &&
    bytes.toString("base64") === tarball.contentBase64 &&
    sha256(bytes) === entry.sha256 &&
    createHash("sha512").update(bytes).digest("hex") === entry.sha512
  )
}

function exactNpmAuditEvidence(value, candidate) {
  return (
    isRecord(value) &&
    value.status === "verified" &&
    isRecord(value.signature) &&
    value.signature.status === "valid" &&
    value.signature.verifier === NPM_AUDIT_VERIFIER &&
    isRecord(value.provenance) &&
    value.provenance.predicateType === "https://slsa.dev/provenance/v1" &&
    value.provenance.workflow === candidate.publisherWorkflow &&
    value.provenance.commitSha === candidate.commitSha &&
    value.provenance.repository === "https://github.com/cacheplane/dawnai" &&
    value.provenance.ref === `refs/tags/v${candidate.version}`
  )
}

function emptyAudit() {
  return {
    status: "none",
    version: null,
    commitSha: null,
    manifestSha256: null,
    workflowRunId: null,
    runAttempt: null,
    conclusion: null,
  }
}

function pendingProductionSmokeObservations(candidate, manifestSha256) {
  return REQUIRED_SMOKE_LANES.map((name) => ({
    name,
    status: "pending",
    version: candidate.version,
    commitSha: candidate.commitSha,
    manifestSha256,
    workflowRunId: null,
    runAttempt: null,
  }))
}

function productionArtifactName(candidate) {
  return `release-v${candidate.version}-${candidate.commitSha.slice(0, 12)}`
}

function tarballName(packageName) {
  return packageName.startsWith("@") ? packageName.slice(1).replaceAll("/", "-") : packageName
}

function hasExactKeys(value, fields) {
  return (
    isRecord(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  )
}

function isSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value)
}

function pendingSmokeObservations(candidate, inventory) {
  return inventory.requiredSmokeLanes.map((name) => ({
    name,
    status: "pending",
    version: candidate.version,
    commitSha: candidate.commitSha,
    manifestSha256: inventory.manifestSha256,
    workflowRunId: null,
    runAttempt: null,
  }))
}

function normalizeDiscoveryInventory(value, label) {
  if (!isRecord(value) || value.status !== "valid" || !Array.isArray(value.packages)) {
    throw new TypeError(`${label} release inventory must be valid`)
  }
  if (value.packages.length === 0) throw new TypeError(`${label} release inventory is empty`)
  const packages = value.packages.map((pkg) => {
    if (!isRecord(pkg) || !isPackageName(pkg.name) || !isReleaseVersion(pkg.version)) {
      throw new TypeError(`${label} release inventory package is invalid`)
    }
    return { name: pkg.name, version: pkg.version }
  })
  packages.sort((left, right) => compareText(left.name, right.name))
  if (new Set(packages.map((pkg) => pkg.name)).size !== packages.length) {
    throw new TypeError(`${label} release inventory package set contains duplicates`)
  }
  const versions = new Set(packages.map((pkg) => pkg.version))
  if (versions.size !== 1) throw new TypeError(`${label} release inventory version is not uniform`)
  return { packages, version: packages[0].version }
}

function normalizeManagedInventory(value, candidate) {
  if (
    !isRecord(value) ||
    !["valid", "invalid"].includes(value.status) ||
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    typeof value.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(value.manifestSha256) ||
    !Array.isArray(value.requiredSmokeLanes)
  ) {
    throw new TypeError("Managed inventory is incomplete")
  }
  if (!value.requiredSmokeLanes.every((lane) => typeof lane === "string" && lane.length > 0)) {
    throw new TypeError("Managed smoke lane inventory is invalid")
  }
  const packages = value.packages.map((pkg) => {
    if (
      !isRecord(pkg) ||
      !isPackageName(pkg.name) ||
      pkg.version !== candidate.version ||
      typeof pkg.filename !== "string" ||
      typeof pkg.tarballSha256 !== "string" ||
      !SHA256_PATTERN.test(pkg.tarballSha256) ||
      typeof pkg.attestationFilename !== "string" ||
      typeof pkg.attestationSha256 !== "string" ||
      !SHA256_PATTERN.test(pkg.attestationSha256) ||
      typeof pkg.integrity !== "string" ||
      !pkg.integrity.startsWith("sha512-")
    ) {
      throw new TypeError("Managed inventory package is invalid")
    }
    return {
      name: pkg.name,
      version: pkg.version,
      filename: pkg.filename,
      tarballSha256: pkg.tarballSha256,
      attestationFilename: pkg.attestationFilename,
      attestationSha256: pkg.attestationSha256,
      integrity: pkg.integrity,
    }
  })
  if (
    !arraysEqual(
      packages.map((pkg) => pkg.name),
      [...packages].map((pkg) => pkg.name).sort(),
    )
  ) {
    throw new TypeError("Managed inventory packages must use exact deterministic order")
  }
  return {
    status: value.status,
    manifestSha256: value.manifestSha256,
    requiredSmokeLanes: [...value.requiredSmokeLanes].sort(compareText),
    packages,
    releaseRecordSha256: validOptionalSha256(value.releaseRecordSha256),
    manifestAttestationSha256: validOptionalSha256(value.manifestAttestationSha256),
  }
}

function mapCi(checkResult, workflowResult, candidate, diagnostics) {
  const observed = observedCiIdentity(checkResult, workflowResult)
  if (checkResult.status !== "PRESENT" || workflowResult.status !== "PRESENT") {
    return ciIdentity("ambiguous", observed)
  }
  if (!Array.isArray(checkResult.value) || !Array.isArray(workflowResult.value)) {
    addDiagnostic(diagnostics, "github", "commit-check-runs", "ERROR", "MALFORMED_VALUE")
    return ciIdentity("ambiguous", observed)
  }
  const workflows = workflowResult.value.filter(
    (run) =>
      run?.name === candidate.ciWorkflow &&
      run?.path === ".github/workflows/ci.yml" &&
      run?.head_sha === candidate.commitSha &&
      run?.head_branch === "main" &&
      run?.event === "push",
  )
  const namedChecks = checkResult.value.filter(
    (check) => check?.name === candidate.ciCheck && check?.head_sha === candidate.commitSha,
  )
  if (workflows.length !== 1) {
    addDiagnostic(diagnostics, "github", "ci-correlation", "AMBIGUOUS", "CI_IDENTITY_AMBIGUOUS")
    return ciIdentity("ambiguous", observed)
  }
  const [workflow] = workflows
  const workflowSuiteId = workflow.check_suite_id
  if (
    !isPositiveSafeInteger(workflow.id) ||
    !isPositiveSafeInteger(workflow.run_attempt) ||
    !isPositiveSafeInteger(workflowSuiteId) ||
    namedChecks.some((check) => !isPositiveSafeInteger(check?.check_suite?.id))
  ) {
    addDiagnostic(diagnostics, "github", "ci-correlation", "AMBIGUOUS", "CI_RUN_MISMATCH")
    return ciIdentity("ambiguous", observed)
  }
  const checks = namedChecks.filter((check) => check.check_suite.id === workflowSuiteId)
  if (checks.length !== 1) {
    addDiagnostic(diagnostics, "github", "ci-correlation", "AMBIGUOUS", "CI_IDENTITY_AMBIGUOUS")
    return ciIdentity("ambiguous", observed)
  }
  const [check] = checks
  const correlated = {
    workflow: workflow.name,
    check: check.name,
    commitSha: candidate.commitSha,
    workflowRunId: null,
    runAttempt: null,
  }
  const checkSuiteId = check.check_suite?.id
  if (!isPositiveSafeInteger(checkSuiteId) || workflowSuiteId !== checkSuiteId) {
    addDiagnostic(diagnostics, "github", "ci-correlation", "AMBIGUOUS", "CI_RUN_MISMATCH")
    return ciIdentity("ambiguous", correlated)
  }
  correlated.workflowRunId = workflow.id
  correlated.runAttempt = workflow.run_attempt
  if (workflow.status !== "completed" || check.status !== "completed") {
    return ciIdentity("ambiguous", correlated)
  }
  return ciIdentity(
    workflow.conclusion === "success" && check.conclusion === "success" ? "success" : "failed",
    correlated,
  )
}

function observedCiIdentity(checkResult, workflowResult) {
  const workflows = Array.isArray(workflowResult.value) ? workflowResult.value : []
  const checks = Array.isArray(checkResult.value) ? checkResult.value : []
  const workflow = workflows.length === 1 ? workflows[0] : null
  const check = checks.length === 1 ? checks[0] : null
  const workflowSha = SHA_PATTERN.test(workflow?.head_sha) ? workflow.head_sha : null
  const checkSha = SHA_PATTERN.test(check?.head_sha) ? check.head_sha : null
  return {
    workflow: typeof workflow?.name === "string" ? workflow.name : null,
    check: typeof check?.name === "string" ? check.name : null,
    commitSha:
      workflowSha !== null && checkSha !== null
        ? workflowSha === checkSha
          ? workflowSha
          : null
        : (workflowSha ?? checkSha),
    workflowRunId: null,
    runAttempt: null,
  }
}

function ciIdentity(status, identity) {
  return {
    status,
    workflow: identity.workflow,
    check: identity.check,
    commitSha: identity.commitSha,
    workflowRunId: identity.workflowRunId,
    runAttempt: identity.runAttempt,
  }
}

function mapTag(result, localSha, localAmbiguous, diagnostics) {
  if (result.status !== "PRESENT" || localAmbiguous) {
    return {
      status: result.status === "ABSENT" && !localAmbiguous ? "absent" : "ambiguous",
      commitSha: null,
    }
  }
  const remoteSha = peelGitHubRefSha(result.value)
  if (remoteSha === null || remoteSha !== localSha) {
    addDiagnostic(diagnostics, "github", "ref", "AMBIGUOUS", "TAG_IDENTITY_CONFLICT")
    return { status: "ambiguous", commitSha: null }
  }
  return { status: "present", commitSha: remoteSha }
}

function mapArtifacts(result, inventory, diagnostics) {
  const base = {
    status: "absent",
    manifestVersion: null,
    manifestCommitSha: null,
    manifestSha256: null,
    files: inventory.packages.map((pkg) => ({
      name: pkg.name,
      status: "pending",
      assetName: pkg.filename,
      sha256: null,
      integrity: null,
    })),
    manifestAsset: { name: "manifest.json", sha256: null },
    releaseRecordAsset: { name: "release-record.json", sha256: null },
    manifestAttestationAsset: {
      name: "manifest.json.intoto.jsonl",
      sha256: null,
    },
    attestations: [
      ...inventory.packages.map((pkg) => ({
        name: pkg.attestationFilename,
        status: "pending",
        sha256: null,
        subjectName: pkg.filename,
        subjectSha256: pkg.tarballSha256,
      })),
      {
        name: "manifest.json.intoto.jsonl",
        status: "pending",
        sha256: null,
        subjectName: "manifest.json",
        subjectSha256: inventory.manifestSha256,
      },
    ],
  }
  if (result.status !== "PRESENT") return { ...base, status: "ambiguous" }
  if (!Array.isArray(result.value)) {
    addDiagnostic(diagnostics, "github", "actions-artifacts", "ERROR", "MALFORMED_VALUE")
    return { ...base, status: "ambiguous" }
  }
  if (result.value.length > 0) {
    // A listed archive is not proof of its contents. Download/manifest parsing is a later
    // managed observation step; this boundary fails closed instead of inventing preparation.
    addDiagnostic(
      diagnostics,
      "github",
      "actions-artifacts",
      "AMBIGUOUS",
      "ARTIFACT_CONTENT_UNREAD",
    )
    return { ...base, status: "ambiguous" }
  }
  return base
}

function mapRegistryPackage(result, expected, candidate, diagnostics) {
  if (result.status === "ABSENT") return absentRegistryPackage(expected.name)
  if (result.status !== "PRESENT") return ambiguousRegistryPackage(expected.name)
  const pkg = result.package
  if (!isRecord(pkg) || pkg.name !== expected.name || pkg.version !== candidate.version) {
    addDiagnostic(diagnostics, "npm", "package-version", "ERROR", "PACKAGE_IDENTITY_MISMATCH")
    return ambiguousRegistryPackage(expected.name)
  }
  diagnostics.push({
    source: "npm",
    operation: "signatures",
    status: "AMBIGUOUS",
    httpStatus: null,
    code: "NPM_SIGNATURE_UNVERIFIED",
    evidenceCount: Array.isArray(pkg.signatures) ? pkg.signatures.length : null,
  })
  if (!isRecord(pkg.provenance) || pkg.provenance.status !== "PRESENT") {
    addDiagnostic(diagnostics, "npm", "provenance", "AMBIGUOUS", "PROVENANCE_UNAVAILABLE")
    return ambiguousRegistryPackage(expected.name)
  }
  if (pkg.integrity !== expected.integrity) {
    // npm does not expose SHA-256. Only an exact SHA-512 match to the managed manifest
    // correlates the public tarball to its known SHA-256 without downloading it.
    addDiagnostic(diagnostics, "npm", "package-version", "AMBIGUOUS", "NPM_BYTES_MISMATCH")
    return ambiguousRegistryPackage(expected.name)
  }
  return ambiguousRegistryPackage(expected.name)
}

async function mapRelease(result, inventory, candidate, github, diagnostics, observedSmokes) {
  if (result.status !== "PRESENT") {
    return nonPresentRelease(result.status === "ABSENT" ? "absent" : "ambiguous")
  }
  const release = result.value
  if (
    !isRecord(release) ||
    !isPositiveId(release.id) ||
    typeof release.draft !== "boolean" ||
    typeof release.immutable !== "boolean" ||
    typeof release.tag_name !== "string" ||
    typeof release.body !== "string"
  ) {
    addDiagnostic(diagnostics, "github", "release", "ERROR", "MALFORMED_VALUE")
    return ambiguousRelease()
  }
  let marker
  try {
    marker = parseReleaseMarker(release.body)
  } catch {
    addDiagnostic(diagnostics, "github", "release", "AMBIGUOUS", "RELEASE_MARKER_INVALID")
    return ambiguousRelease()
  }
  const tag = release.tag_name
  const expectedTag = `v${candidate.version}`
  const commitSha = marker.commitSha
  const mutableDraft = release.draft === true && release.immutable === false
  if (
    (mutableDraft ? !isManagedReleaseForTag(release, expectedTag) : tag !== expectedTag) ||
    marker.tag !== expectedTag ||
    marker.version !== candidate.version ||
    commitSha !== candidate.commitSha
  ) {
    addDiagnostic(diagnostics, "github", "release", "AMBIGUOUS", "RELEASE_IDENTITY_MISMATCH")
    return ambiguousRelease()
  }
  if (typeof github.listReleaseAssets !== "function") {
    addDiagnostic(diagnostics, "github", "release-assets", "ERROR", "METHOD_UNAVAILABLE")
    return ambiguousRelease()
  }
  const assetsResult = normalizeEnvelope(
    await github.listReleaseAssets({ releaseId: release.id }),
    { source: "github", operation: "release-assets", payloadKey: "value" },
    diagnostics,
  )
  if (assetsResult.status !== "PRESENT" || !Array.isArray(assetsResult.value)) {
    return ambiguousRelease()
  }
  const expectedAssets = expectedReleaseAssets(inventory, marker)
  if (expectedAssets === null) {
    addDiagnostic(
      diagnostics,
      "github",
      "release-assets",
      "AMBIGUOUS",
      "EXPECTED_DIGESTS_UNAVAILABLE",
    )
    return ambiguousRelease()
  }
  const expectedByName = new Map(expectedAssets.map((asset) => [asset.name, asset]))
  const rawAssets = [...assetsResult.value].sort(compareRemoteAssets)
  if (
    rawAssets.some(
      (asset) =>
        !isRecord(asset) ||
        !isPositiveId(asset.id) ||
        typeof asset.name !== "string" ||
        !/^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(asset.name),
    )
  ) {
    addDiagnostic(diagnostics, "github", "release-assets", "ERROR", "MALFORMED_VALUE")
    return ambiguousRelease()
  }
  const idCounts = new Map()
  for (const asset of rawAssets) {
    const id = String(asset?.id)
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
  }
  const duplicateIds = new Set([...idCounts].filter(([, count]) => count > 1).map(([id]) => id))
  for (const assetId of duplicateIds) {
    diagnostics.push({
      source: "github",
      operation: "release-assets",
      status: "AMBIGUOUS",
      httpStatus: null,
      code: "REMOTE_ASSET_ID_DUPLICATE",
      assetId,
    })
  }
  const resumableSmoke = await observeDurableSmokeReceipts({
    marker,
    candidate,
    github,
    rawAssets,
    diagnostics,
  })
  if (resumableSmoke === null) return ambiguousRelease()
  observedSmokes.push(...resumableSmoke.smokes)
  const assets = rawAssets.map((actual) => {
    const expected = expectedByName.get(actual?.name)
    const digest = normalizeAssetDigest(actual?.digest)
    const resumable = resumableSmoke.assets.get(String(actual.id))
    return {
      name: actual?.name,
      status:
        duplicateIds.has(String(actual?.id)) || digest === null
          ? "ambiguous"
          : resumable !== undefined
            ? resumable.status
            : expected !== undefined && digest === expected.sha256
              ? "matching"
              : "different",
      sha256: resumable?.sha256 ?? digest,
    }
  })
  return {
    status: release.draft === true ? "draft" : "published",
    tag: expectedTag,
    commitSha,
    immutable: release.immutable,
    bodySha256: sha256(Buffer.from(release.body, "utf8")),
    marker,
    assets,
  }
}

function expectedReleaseAssets(inventory, marker) {
  if (inventory.releaseRecordSha256 === null || inventory.manifestAttestationSha256 === null) {
    return null
  }
  return [
    { name: "release-record.json", sha256: inventory.releaseRecordSha256 },
    { name: "manifest.json", sha256: inventory.manifestSha256 },
    {
      name: "manifest.json.intoto.jsonl",
      sha256: inventory.manifestAttestationSha256,
    },
    ...inventory.packages.map((pkg) => ({
      name: pkg.filename,
      sha256: pkg.tarballSha256,
    })),
    ...inventory.packages.map((pkg) => ({
      name: pkg.attestationFilename,
      sha256: pkg.attestationSha256,
    })),
    ...(Array.isArray(marker?.smoke?.receiptAssets)
      ? marker.smoke.receiptAssets.map((asset) => ({
          name: asset.releaseAssetName,
          sha256: asset.receiptSha256,
        }))
      : []),
  ]
}

export async function observeDurableSmokeReceipts({
  marker,
  candidate,
  github,
  rawAssets,
  diagnostics = [],
}) {
  if (!Array.isArray(rawAssets) || !Array.isArray(diagnostics)) {
    throw new TypeError("Durable smoke observation inputs are invalid")
  }
  const idCounts = new Map()
  for (const asset of rawAssets) {
    const id = String(asset?.id)
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
  }
  const duplicateIds = new Set([...idCounts].filter(([, count]) => count > 1).map(([id]) => id))
  const observed = new Map()
  const smokeAssets = rawAssets
    .map((asset) => ({
      asset,
      identity: parseSmokeReleaseAssetName(asset.name),
    }))
    .filter(({ identity }) => identity !== null)
  if (smokeAssets.length === 0) {
    return marker.smoke === null ? { assets: observed, smokes: [] } : null
  }
  if (smokeAssets.length > MAX_SMOKE_ASSETS) {
    addDiagnostic(diagnostics, "github", "release-assets", "ERROR", "SMOKE_RECEIPTS_UNBOUNDED")
    return null
  }
  let totalBytes = 0
  const attempts = new Set()
  for (const { asset, identity } of smokeAssets) {
    if (duplicateIds.has(String(asset.id)) || !Number.isSafeInteger(asset.size) || asset.size < 1) {
      addDiagnostic(diagnostics, "github", "release-assets", "ERROR", "MALFORMED_VALUE")
      return null
    }
    try {
      assertPayloadByteLength(
        asset.size,
        RELEASE_PAYLOAD_LIMITS.smokeReceiptBytes,
        `Smoke Release asset ${asset.name}`,
      )
      totalBytes += asset.size
      assertPayloadByteLength(
        totalBytes,
        RELEASE_PAYLOAD_LIMITS.smokeReceiptsBytes,
        "Smoke Release receipts",
      )
    } catch {
      addDiagnostic(diagnostics, "github", "release-assets", "ERROR", "PAYLOAD_LIMIT_EXCEEDED")
      return null
    }
    attempts.add(`${identity.workflowRunId}:${identity.runAttempt}`)
  }
  if (attempts.size > MAX_SMOKE_ATTEMPTS) {
    addDiagnostic(diagnostics, "github", "release-assets", "ERROR", "SMOKE_ATTEMPTS_UNBOUNDED")
    return null
  }
  const markerBound = marker.smoke !== null
  if (!markerBound && marker.phase !== "NPM_COMPLETE") {
    return { assets: observed, smokes: [] }
  }
  if (typeof github.downloadReleaseAsset !== "function") {
    addDiagnostic(diagnostics, "github", "release-assets", "ERROR", "METHOD_UNAVAILABLE")
    return null
  }
  if (markerBound) {
    const expectedById = new Map(
      marker.smoke.receiptAssets.map((receipt) => [String(receipt.releaseAssetId), receipt]),
    )
    if (
      smokeAssets.length !== marker.smoke.receiptAssets.length ||
      smokeAssets.some(({ asset }) => {
        const expected = expectedById.get(String(asset.id))
        return (
          expected === undefined ||
          asset.name !== expected.releaseAssetName ||
          normalizeAssetDigest(asset.digest) !== expected.receiptSha256
        )
      })
    ) {
      addDiagnostic(
        diagnostics,
        "github",
        "release-assets",
        "AMBIGUOUS",
        "SMOKE_RECEIPT_SET_MISMATCH",
      )
      return null
    }
  }
  const parsedReceipts = []
  for (const { asset, identity } of smokeAssets) {
    const digest = normalizeAssetDigest(asset.digest)
    if (digest === null) {
      observed.set(String(asset.id), { status: "ambiguous", sha256: null })
      continue
    }
    try {
      const envelope = normalizeAdapterEnvelope(
        await github.downloadReleaseAsset({
          assetId: asset.id,
          maximumBytes: asset.size,
        }),
        {
          source: "github",
          operation: "release-asset-download",
          payloadKey: "contentBase64",
        },
      )
      if (envelope.status !== "PRESENT" || typeof envelope.contentBase64 !== "string") {
        throw new Error("Smoke receipt download is not exact")
      }
      const bytes = Buffer.from(envelope.contentBase64, "base64")
      if (bytes.toString("base64") !== envelope.contentBase64 || bytes.byteLength !== asset.size) {
        throw new Error("Smoke receipt bytes are not exact")
      }
      const receipt = parseSmokeResult(bytes)
      const bytesSha256 = sha256(bytes)
      const matching =
        bytesSha256 === digest &&
        receipt.lane === identity.lane &&
        receipt.workflowRunId === identity.workflowRunId &&
        receipt.runAttempt === identity.runAttempt &&
        receipt.version === candidate.version &&
        receipt.commitSha === candidate.commitSha &&
        receipt.manifestSha256 === marker.manifestSha256 &&
        receipt.conclusion === "success"
      observed.set(String(asset.id), {
        status: matching ? "matching" : "different",
        sha256: bytesSha256,
      })
      if (matching) parsedReceipts.push({ bytes, receipt })
      if (markerBound && !matching) {
        addDiagnostic(
          diagnostics,
          "github",
          "release-asset-download",
          "AMBIGUOUS",
          "SMOKE_RECEIPT_IDENTITY_MISMATCH",
        )
        return null
      }
    } catch {
      if (markerBound) {
        addDiagnostic(
          diagnostics,
          "github",
          "release-asset-download",
          "AMBIGUOUS",
          "SMOKE_RECEIPT_UNREADABLE",
        )
        return null
      }
      observed.set(String(asset.id), { status: "ambiguous", sha256: digest })
      addDiagnostic(
        diagnostics,
        "github",
        "release-asset-download",
        "AMBIGUOUS",
        "SMOKE_RECEIPT_UNREADABLE",
      )
    }
  }
  if (!markerBound) return { assets: observed, smokes: [] }
  const selected = parsedReceipts.filter(
    ({ receipt }) =>
      receipt.workflowRunId === marker.smoke.workflowRunId &&
      receipt.runAttempt === marker.smoke.runAttempt,
  )
  try {
    const aggregate = aggregateSmokeResults(
      selected.map(({ bytes }) => bytes),
      {
        version: candidate.version,
        commitSha: candidate.commitSha,
        manifestSha256: marker.manifestSha256,
        workflowRunId: marker.smoke.workflowRunId,
        runAttempt: marker.smoke.runAttempt,
      },
    )
    if (sha256(canonicalAggregateSmokeResultBytes(aggregate)) !== marker.smoke.aggregateSha256) {
      throw new Error("Smoke aggregate digest does not match its marker")
    }
  } catch {
    addDiagnostic(
      diagnostics,
      "github",
      "release-assets",
      "AMBIGUOUS",
      "SMOKE_RECEIPT_AGGREGATE_MISMATCH",
    )
    return null
  }
  const selectedByLane = new Map(selected.map(({ receipt }) => [receipt.lane, receipt]))
  return {
    assets: observed,
    smokes: REQUIRED_RELEASE_SMOKE_LANES.map((name) => {
      const receipt = selectedByLane.get(name)
      return {
        name,
        status: "passed",
        version: receipt.version,
        commitSha: receipt.commitSha,
        manifestSha256: receipt.manifestSha256,
        workflowRunId: receipt.workflowRunId,
        runAttempt: receipt.runAttempt,
      }
    }),
  }
}

function normalizeEnvelope(value, options, diagnostics) {
  const result = normalizeAdapterEnvelope(value, options)
  if (result.status !== "PRESENT" && result.status !== "ABSENT") {
    diagnostics.push({
      source: options.source,
      operation: result.operation,
      status: result.status,
      httpStatus: result.httpStatus,
      code: safeCode(result.code, "REMOTE_FAILURE"),
    })
  }
  return result
}

async function observeProductionPublicationHistory({
  result,
  candidate,
  github,
  diagnostics,
  currentPublisherRun,
}) {
  if (result.status !== "PRESENT" || !Array.isArray(result.value)) {
    return { started: false, ambiguous: true }
  }
  if (result.value.length > 100) {
    addDiagnostic(
      diagnostics,
      "github",
      "publisher-runs",
      "AMBIGUOUS",
      "PUBLISHER_RUN_HISTORY_EXCEEDS_BOUND",
    )
    return { started: false, ambiguous: true }
  }
  const runIds = new Set()
  const runs = []
  for (const value of result.value) {
    if (
      !isRecord(value) ||
      !isPositiveSafeInteger(value.id) ||
      !isPositiveSafeInteger(value.run_attempt) ||
      value.head_sha !== candidate.commitSha ||
      value.path !== candidate.publisherWorkflow ||
      !["main", `v${candidate.version}`].includes(value.head_branch) ||
      typeof value.status !== "string" ||
      value.status.length === 0 ||
      !(value.conclusion === null || typeof value.conclusion === "string") ||
      runIds.has(value.id)
    ) {
      addDiagnostic(
        diagnostics,
        "github",
        "publisher-runs",
        "AMBIGUOUS",
        "PUBLISHER_RUN_IDENTITY_MISMATCH",
      )
      return { started: false, ambiguous: true }
    }
    runIds.add(value.id)
    if (value.head_branch === `v${candidate.version}`) {
      runs.push({
        id: value.id,
        runAttempt: value.run_attempt,
        status: value.status,
        conclusion: value.conclusion,
      })
    }
  }

  let started = false
  for (const run of runs) {
    const jobsResult = await observeAdapter(() => github.listActionsRunJobs({ runId: run.id }), {
      source: "github",
      operation: "actions-run-jobs",
      payloadKey: "value",
      diagnostics,
    })
    const jobs = normalizePublisherJobs(jobsResult, run.runAttempt, {
      allowCurrentAttemptWithoutPublisherJob:
        currentPublisherRun !== null &&
        run.id === currentPublisherRun.runId &&
        run.runAttempt === currentPublisherRun.runAttempt &&
        run.status === "in_progress" &&
        run.conclusion === null,
    })
    if (jobs === null) {
      addDiagnostic(
        diagnostics,
        "github",
        "publisher-jobs",
        "AMBIGUOUS",
        "PUBLISHER_JOB_HISTORY_INVALID",
      )
      return { started: false, ambiguous: true }
    }
    started ||= jobs.some((job) => job.name === "publish-npm" && publisherJobObservedStarted(job))
  }
  return { started, ambiguous: false }
}

function normalizePublisherJobs(
  result,
  currentAttempt,
  { allowCurrentAttemptWithoutPublisherJob = false } = {},
) {
  if (
    result.status !== "PRESENT" ||
    !Array.isArray(result.value) ||
    result.value.length === 0 ||
    result.value.length > 10_000
  ) {
    return null
  }
  const identities = new Set()
  const attempts = new Set()
  const publisherJobsByAttempt = new Map()
  const jobs = []
  for (const value of result.value) {
    if (
      !hasExactKeys(value, [
        "id",
        "runAttempt",
        "name",
        "status",
        "conclusion",
        "startedAt",
        "completedAt",
      ]) ||
      !isPositiveSafeInteger(value.id) ||
      !isPositiveSafeInteger(value.runAttempt) ||
      value.runAttempt > currentAttempt ||
      typeof value.name !== "string" ||
      value.name.length === 0 ||
      typeof value.status !== "string" ||
      value.status.length === 0 ||
      !(value.conclusion === null || typeof value.conclusion === "string") ||
      !isNullableTimestamp(value.startedAt) ||
      !isNullableTimestamp(value.completedAt)
    ) {
      return null
    }
    const terminal = value.status === "completed"
    if (
      terminal !== (value.conclusion !== null) ||
      terminal !== (value.completedAt !== null) ||
      (value.completedAt !== null && value.startedAt === null)
    ) {
      return null
    }
    const identity = `${value.runAttempt}:${value.id}`
    if (identities.has(identity)) return null
    identities.add(identity)
    attempts.add(value.runAttempt)
    if (value.name === "publish-npm") {
      publisherJobsByAttempt.set(
        value.runAttempt,
        (publisherJobsByAttempt.get(value.runAttempt) ?? 0) + 1,
      )
      try {
        publisherJobObservedStarted(value)
      } catch {
        return null
      }
    }
    jobs.push(value)
  }
  if (
    attempts.size !== currentAttempt ||
    [...attempts].some((attempt) => attempt < 1 || attempt > currentAttempt)
  ) {
    return null
  }
  for (let attempt = 1; attempt <= currentAttempt; attempt += 1) {
    const publisherJobs = publisherJobsByAttempt.get(attempt) ?? 0
    if (
      publisherJobs !== 1 &&
      !(allowCurrentAttemptWithoutPublisherJob && attempt === currentAttempt && publisherJobs === 0)
    ) {
      return null
    }
  }
  return jobs
}

function normalizeCurrentPublisherRun(value, candidate) {
  if (value === null || value === undefined) return null
  if (
    !hasExactKeys(value, ["runId", "runAttempt", "ref", "sha"]) ||
    !isPositiveSafeInteger(value.runId) ||
    !isPositiveSafeInteger(value.runAttempt) ||
    value.ref !== `refs/tags/v${candidate.version}` ||
    value.sha !== candidate.commitSha
  ) {
    throw new TypeError("Current publisher run identity is invalid")
  }
  return snapshotJson(value)
}

function publisherJobObservedStarted(job) {
  if (job.status === "completed" && job.conclusion === "skipped") {
    if (job.startedAt === null || job.completedAt === null) {
      throw observationError("PUBLISHER_SKIPPED_JOB_INVALID")
    }
    return false
  }
  return job.startedAt !== null
}

function publicationRunStarted(result, candidate) {
  if (result.status !== "PRESENT" || !Array.isArray(result.value)) return false
  return result.value.some(
    (run) =>
      isRecord(run) &&
      isPositiveId(run.id) &&
      isPositiveId(run.run_attempt) &&
      run.head_sha === candidate.commitSha &&
      (run.path === candidate.publisherWorkflow || run.name === candidate.publisherWorkflow),
  )
}

function absentRegistryPackage(name) {
  return {
    name,
    status: "e404",
    version: null,
    tarballSha256: null,
    integrity: null,
    latest: { status: "e404", version: null },
    signature: { status: "missing" },
    provenance: null,
  }
}

function ambiguousRegistryPackage(name) {
  return {
    name,
    status: "ambiguous",
    version: null,
    tarballSha256: null,
    integrity: null,
    latest: { status: "ambiguous", version: null },
    signature: { status: "ambiguous" },
    provenance: null,
  }
}

function ambiguousRelease() {
  return nonPresentRelease("ambiguous")
}

function nonPresentRelease(status) {
  return {
    status,
    tag: null,
    commitSha: null,
    immutable: null,
    bodySha256: null,
    marker: null,
    assets: [],
  }
}

function normalizeCandidate(value) {
  if (
    !isRecord(value) ||
    !isReleaseVersion(value.version) ||
    typeof value.commitSha !== "string" ||
    !SHA_PATTERN.test(value.commitSha) ||
    ![value.ciWorkflow, value.ciCheck, value.publisherWorkflow].every(
      (item) => typeof item === "string" && item.length > 0,
    )
  ) {
    throw new TypeError("Release candidate is invalid")
  }
  const keys = ["version", "commitSha", "ciWorkflow", "ciCheck", "publisherWorkflow"]
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError("Release candidate fields are invalid")
  }
  return structuredClone(value)
}

function peelGitHubRefSha(value) {
  let object = value?.object
  for (let depth = 0; depth < 2; depth += 1) {
    if (typeof object?.sha === "string" && SHA_PATTERN.test(object.sha)) return object.sha
    object = object?.object
  }
  return null
}

function managedArtifactName(candidate) {
  return `release-candidate-${candidate.version}-${candidate.commitSha}`
}

function normalizeAssetDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value) ? value.slice(7) : null
}

function compareRemoteAssets(left, right) {
  return compareText(
    `${String(left?.name)}\0${String(left?.id)}\0${String(left?.digest)}`,
    `${String(right?.name)}\0${String(right?.id)}\0${String(right?.digest)}`,
  )
}

function validOptionalSha256(value) {
  if (value === undefined) return null
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError("Managed optional asset digest is invalid")
  }
  return value
}

function addDiagnostic(diagnostics, source, operation, status, code) {
  diagnostics.push({ source, operation, status, httpStatus: null, code })
}

function compareDiagnostics(left, right) {
  return compareText(
    `${left.source}\0${left.operation}\0${left.code}`,
    `${right.source}\0${right.operation}\0${right.code}`,
  )
}

function assertMethods(value, methods, label) {
  if (!isRecord(value) || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${label} does not expose the required named methods`)
  }
}

function assertRef(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/u.test(value) ||
    value.includes("..") ||
    value.includes("//")
  ) {
    throw new TypeError("Invalid discovery ref")
  }
}

function safeCode(value, fallback) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_-]{0,63}$/u.test(value) ? value : fallback
}

function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function isPackageName(value) {
  return typeof value === "string" && PACKAGE_PATTERN.test(value)
}

function isPositiveId(value) {
  return (
    (Number.isSafeInteger(value) && value > 0) ||
    (typeof value === "string" && /^[1-9][0-9]*$/u.test(value))
  )
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object"
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
