import { createHash } from "node:crypto"

import { snapshotJson } from "./adapter-normalize.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "./manifest.mjs"
import { parseReleaseMarker } from "./metadata.mjs"

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u
const ASSET_NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/u
const MARKER_DELIMITER = "DAWN_RELEASE_CONTROLLER_MARKER"
const MAX_NOTICE_BYTES = 16 * 1024
const MAX_RECEIPT_BYTES = 64 * 1024
const MAX_DUPLICATE_DRAFT_EVIDENCE_BYTES = 512 * 1024
const DUPLICATE_EVIDENCE_FIELDS = [
  "schemaVersion",
  "capturedAt",
  "reviewedAuthority",
  "repository",
  "workflow",
  "immutableReleases",
  "candidate",
  "npm",
  "releaseRuns",
  "releases",
]
const DUPLICATE_OBSERVATION_FIELDS = DUPLICATE_EVIDENCE_FIELDS.filter(
  (field) => field !== "schemaVersion",
)
const DUPLICATE_SOURCE_FIELDS = [
  "releaseId",
  "tagName",
  "body",
  "marker",
  "assets",
  "evidenceAssets",
]
const DUPLICATE_DERIVED_FIELDS = [
  "originalBodySha256",
  "originalAssets",
  "baseAssetSetSha256",
  "archiveAssetName",
  "receiptAssetName",
  "receiptSha256",
  "receiptBytes",
  "noticeBytes",
  "state",
  "remainingTransitions",
]
const MAX_DUPLICATE_EVIDENCE_AGE_MS = 15 * 60 * 1000
const CANONICAL_OPAQUE_TAG = "untagged-be0ff4bee4ba43b521a9"
const CAPTURE_RUN_STATUSES = new Set([
  "requested",
  "waiting",
  "pending",
  "queued",
  "in_progress",
  "completed",
])
const CAPTURE_JOB_STATUSES = new Set(["waiting", "pending", "queued", "in_progress", "completed"])
const CAPTURE_TERMINAL_CONCLUSIONS = new Set([
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
const CAPTURE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u
const CAPTURE_READER_METHODS = [
  "readReviewedMergeAuthority",
  "readRepositoryState",
  "readCandidateTag",
  "readWorkflowState",
  "readImmutableReleases",
  "readReleaseRuns",
  "readCandidatePublishJobs",
  "readNpmAbsence",
  "readReleaseSnapshot",
  "listCandidateReleases",
]

export const DUPLICATE_DRAFT_RECOVERY_POLICY = deepFreeze({
  repository: "cacheplane/dawnai",
  version: "0.8.22",
  candidateSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
  canonicalReleaseId: 379991871,
  duplicates: [
    { releaseId: 379982100, tagName: "untagged-a13939767dd2419ade01" },
    { releaseId: 379986168, tagName: "untagged-20706099efa3c38335a8" },
  ],
})

export class DuplicateDraftRecoveryCaptureError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "DuplicateDraftRecoveryCaptureError"
    this.code = code
  }
}

/** Collect and seal one complete, read-only production recovery observation. */
export async function captureDuplicateDraftRecoveryEvidence({
  reviewedCommit,
  reader,
  now = Date.now,
}) {
  assertGitSha(reviewedCommit, "Reviewed recovery commit")
  assertCaptureReader(reader)
  if (typeof now !== "function") throw new TypeError("Duplicate draft capture clock is invalid")
  const capturedAtMs = now()
  if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs < 0) {
    throw new TypeError("Duplicate draft capture time is invalid")
  }
  if (capturedAtMs > 8_640_000_000_000_000) {
    throw new TypeError("Duplicate draft capture time is invalid")
  }
  const capturedAt = new Date(capturedAtMs).toISOString()

  const reviewedAuthority = await captureRead(
    reader,
    "readReviewedMergeAuthority",
    [reviewedCommit],
    "REVIEWED_AUTHORITY_UNAVAILABLE",
  )
  if (reviewedAuthority?.mergeCommitSha !== reviewedCommit) {
    captureFail(
      "REVIEWED_AUTHORITY_CONFLICT",
      "Reviewed recovery authority does not match the supplied commit",
    )
  }
  const repository = await captureRead(
    reader,
    "readRepositoryState",
    [],
    "REPOSITORY_STATE_UNAVAILABLE",
  )
  const workflow = await captureRead(reader, "readWorkflowState", [], "WORKFLOW_STATE_UNAVAILABLE")
  const immutableReleases = await captureRead(
    reader,
    "readImmutableReleases",
    [],
    "IMMUTABLE_RELEASES_UNAVAILABLE",
  )
  const candidate = await captureRead(reader, "readCandidateTag", [], "CANDIDATE_TAG_UNAVAILABLE")
  const runObservation = await captureRead(
    reader,
    "readReleaseRuns",
    [],
    "RELEASE_RUNS_UNAVAILABLE",
  )
  let normalizedRuns
  try {
    normalizedRuns = normalizeCaptureRuns(runObservation)
  } catch (error) {
    if (error instanceof DuplicateDraftRecoveryCaptureError) throw error
    captureFail("RELEASE_RUNS_MALFORMED", "Recovery workflow run observation is malformed")
  }
  const { nonterminalRuns, candidateRuns } = normalizedRuns
  if (nonterminalRuns.length !== 0) {
    captureFail("RELEASE_RUN_NONTERMINAL", "A Release workflow run is nonterminal")
  }
  const candidateJobObservations = []
  for (const run of candidateRuns) {
    candidateJobObservations.push({
      runId: run.id,
      runAttempt: run.runAttempt,
      jobs: await captureRead(
        reader,
        "readCandidatePublishJobs",
        [run.id, run.runAttempt],
        "CANDIDATE_JOBS_UNAVAILABLE",
      ),
    })
  }
  for (const { jobs, runId, runAttempt } of candidateJobObservations) {
    assertNoStartedPublishJob(jobs, runId, runAttempt)
  }

  const npmPackages = []
  for (const packageName of CANONICAL_RELEASE_PACKAGE_ORDER) {
    npmPackages.push(
      await captureRead(reader, "readNpmAbsence", [packageName], "NPM_ABSENCE_UNAVAILABLE"),
    )
  }

  const candidateReleases = await captureRead(
    reader,
    "listCandidateReleases",
    [],
    "CANDIDATE_RELEASES_UNAVAILABLE",
  )
  try {
    normalizeCandidateReleaseInventory(candidateReleases)
  } catch (error) {
    if (error instanceof DuplicateDraftRecoveryCaptureError) throw error
    captureFail("CANDIDATE_RELEASE_INVENTORY_CONFLICT", "Candidate Release inventory is not exact")
  }
  const canonical = await captureRead(
    reader,
    "readReleaseSnapshot",
    [DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId],
    "CANONICAL_RELEASE_UNAVAILABLE",
  )
  const duplicates = []
  for (const duplicate of DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates) {
    duplicates.push(
      await captureRead(
        reader,
        "readReleaseSnapshot",
        [duplicate.releaseId, { expectedOriginalBody: canonical?.body }],
        "DUPLICATE_RELEASE_UNAVAILABLE",
      ),
    )
  }

  try {
    return parseDuplicateDraftEvidence(
      canonicalDuplicateDraftEvidence({
        capturedAt,
        reviewedAuthority,
        repository,
        workflow,
        immutableReleases,
        candidate,
        npm: { packages: npmPackages },
        releaseRuns: [],
        releases: { canonical, duplicates },
      }),
    )
  } catch (error) {
    if (error instanceof DuplicateDraftRecoveryCaptureError) throw error
    captureFail("CAPTURE_EVIDENCE_CONFLICT", "Captured duplicate draft evidence is not exact")
  }
}

/**
 * Serialize the authority-bound recovery observation into its sole canonical
 * representation. It performs no I/O and accepts neither credentials nor
 * transport data.
 */
export function canonicalDuplicateDraftEvidence(value) {
  const evidence = normalizeDuplicateDraftEvidence(value)
  const bytes = Buffer.from(`${JSON.stringify(canonicalize(evidence))}\n`, "utf8")
  if (bytes.byteLength > MAX_DUPLICATE_DRAFT_EVIDENCE_BYTES) {
    throw new TypeError("Duplicate draft evidence exceeds its byte bounds")
  }
  return bytes
}

/** Parse only canonical, bounded evidence bytes and return an immutable value. */
export function parseDuplicateDraftEvidence(bytes) {
  const input = normalizeEvidenceBytes(bytes)
  let parsed
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input))
  } catch (error) {
    throw new TypeError("Duplicate draft evidence is not valid UTF-8 JSON", { cause: error })
  }
  const evidence = normalizeDuplicateDraftEvidence(parsed)
  const canonical = canonicalDuplicateDraftEvidence(evidence)
  if (!canonical.equals(input)) throw new TypeError("Duplicate draft evidence is not canonical")
  return deepFreeze(evidence)
}

/**
 * Reparse the sealed value, verify its short validity interval, and prove a
 * fresh observation derives byte-for-byte identical facts. Drift is never
 * repaired or inferred by the verifier.
 */
export function verifyDuplicateDraftEvidence({ evidence, current, now = Date.now }) {
  if (typeof now !== "function") throw new TypeError("Duplicate draft evidence clock is invalid")
  const sealed = parseDuplicateDraftEvidence(canonicalDuplicateDraftEvidence(evidence))
  const nowMs = now()
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("Duplicate draft evidence time is invalid")
  }
  const capturedAtMs = Date.parse(sealed.capturedAt)
  if (capturedAtMs > nowMs)
    throw new Error("Duplicate draft evidence capture time is in the future")
  if (nowMs - capturedAtMs > MAX_DUPLICATE_EVIDENCE_AGE_MS) {
    throw new Error("Duplicate draft evidence has expired and must be recaptured")
  }
  const currentObservation = validateCurrentObservationTimestamp(current, {
    evidenceCapturedAtMs: capturedAtMs,
    nowMs,
  })
  const fresh = normalizeDuplicateDraftObservation(currentObservation, sealed.capturedAt)
  if (!canonicalDuplicateDraftEvidence(fresh).equals(canonicalDuplicateDraftEvidence(sealed))) {
    throw new Error("Duplicate draft evidence drifted from the fresh observation")
  }
  return deepFreeze({ schemaVersion: 1, status: "PASS" })
}

export function classifyDuplicateDraft(value, expected) {
  const snapshot = exactObject(
    value,
    ["releaseId", "tagName", "body", "marker", "assets", "evidenceAssets"],
    "duplicate Release snapshot",
  )
  const requirements = exactObject(
    expected,
    [
      "releaseId",
      "tagName",
      "canonicalBody",
      "canonicalMarker",
      "originalBodySha256",
      "originalAssets",
      "recoveryReceipt",
      "recoveryNotice",
    ],
    "duplicate Release expectations",
  )

  assertDuplicateIdentity(snapshot.releaseId, snapshot.tagName, requirements)
  assertBodyDigest(requirements.canonicalBody, requirements.originalBodySha256)
  if (!Array.isArray(requirements.originalAssets) || requirements.originalAssets.length !== 45) {
    throw new TypeError("Duplicate Release expectations require exactly 45 original assets")
  }
  const originalAssets = normalizeAssets(
    requirements.originalAssets,
    "original Release assets",
    false,
  )
  assertUniqueAssets(originalAssets, "original Release assets")
  const assets = normalizeAssets(snapshot.assets, "duplicate Release assets", true)
  assertUniqueAssets(assets, "duplicate Release assets")
  const evidenceKinds = normalizeEvidenceKinds(snapshot.evidenceAssets)
  let parsedCanonicalMarker
  try {
    parsedCanonicalMarker = parseReleaseMarker(requirements.canonicalBody)
  } catch (error) {
    throw new Error("Duplicate canonical body is not a valid Dawn release body", { cause: error })
  }
  if (
    parsedCanonicalMarker.phase !== "ESCROWED" ||
    parsedCanonicalMarker.version !== DUPLICATE_DRAFT_RECOVERY_POLICY.version ||
    parsedCanonicalMarker.commitSha !== DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha ||
    parsedCanonicalMarker.tag !== `v${DUPLICATE_DRAFT_RECOVERY_POLICY.version}` ||
    !sameJson(parsedCanonicalMarker, requirements.canonicalMarker)
  ) {
    throw new Error("Duplicate canonical body marker is not the approved ESCROWED marker")
  }
  const expectedBaseAssetSetSha256 = assetSetSha256(originalAssets)
  if (parsedCanonicalMarker.baseAssetSetSha256 !== expectedBaseAssetSetSha256) {
    throw new Error("Duplicate canonical marker base-asset digest is not exact")
  }
  const bodyAssetName = originalBodyAssetName(
    requirements.releaseId,
    requirements.originalBodySha256,
  )
  const receiptAssetName = recoveryReceiptAssetName(requirements.releaseId)
  const recoveryReceiptInput = exactObject(
    requirements.recoveryReceipt,
    [
      "repository",
      "version",
      "candidateSha",
      "recoveryCommit",
      "canonicalReleaseId",
      "duplicateReleaseId",
      "originalBodySha256",
      "baseAssetSetSha256",
      "archiveAsset",
    ],
    "duplicate recovery receipt",
  )
  if (
    recoveryReceiptInput.repository !== DUPLICATE_DRAFT_RECOVERY_POLICY.repository ||
    recoveryReceiptInput.version !== DUPLICATE_DRAFT_RECOVERY_POLICY.version ||
    recoveryReceiptInput.candidateSha !== DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha ||
    recoveryReceiptInput.canonicalReleaseId !==
      DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId ||
    recoveryReceiptInput.duplicateReleaseId !== requirements.releaseId ||
    recoveryReceiptInput.originalBodySha256 !== requirements.originalBodySha256 ||
    recoveryReceiptInput.baseAssetSetSha256 !== expectedBaseAssetSetSha256 ||
    recoveryReceiptInput.archiveAsset.name !== bodyAssetName ||
    recoveryReceiptInput.archiveAsset.sha256 !== requirements.originalBodySha256
  ) {
    throw new Error("Duplicate recovery receipt identity is not bound to the classified draft")
  }
  const recoveryReceiptBytes = canonicalRecoveryReceipt(recoveryReceiptInput)
  const recoveryReceiptSha256 = sha256Bytes(recoveryReceiptBytes)
  const expectedAssetNames = new Set(originalAssets.map((asset) => asset.name))
  for (const asset of assets) {
    if (
      !expectedAssetNames.has(asset.name) &&
      asset.name !== bodyAssetName &&
      asset.name !== receiptAssetName
    ) {
      throw new Error("Duplicate Release has an unexpected asset")
    }
  }
  if (assets.length !== originalAssets.length + evidenceKinds.length) {
    throw new Error("Duplicate Release asset namespace is not exact")
  }
  const originalActual = assets.slice(0, originalAssets.length)
  if (!sameJson(assetNamespace(originalActual), assetNamespace(originalAssets))) {
    throw new Error("Duplicate Release original asset namespace changed")
  }
  const evidence = assets.slice(originalAssets.length)
  const notice =
    evidenceKinds.length === 2 && snapshot.marker === null
      ? parseCanonicalNotice(
          snapshot.body,
          requirements.releaseId,
          requirements.originalBodySha256,
          bodyAssetName,
        )
      : null
  for (const [index, asset] of evidence.entries()) {
    const kind = evidenceKinds[index]
    if (kind === "body") {
      if (
        asset.name !== bodyAssetName ||
        asset.sha256 !== requirements.originalBodySha256 ||
        (notice !== null &&
          (asset.name !== notice.archiveAssetName || asset.sha256 !== notice.originalBodySha256))
      ) {
        throw new Error("Duplicate Release original-body archive is not exact")
      }
    } else if (
      asset.name !== receiptAssetName ||
      asset.sha256 !== recoveryReceiptSha256 ||
      typeof asset.bytes !== "string" ||
      asset.bytes !== recoveryReceiptBytes.toString("utf8") ||
      (notice !== null && asset.sha256 !== notice.receiptSha256)
    ) {
      throw new Error("Duplicate Release recovery receipt asset is not exact")
    }
  }

  if (!sameJson(snapshot.marker, parsedCanonicalMarker)) {
    if (evidenceKinds.length === 2 && snapshot.marker === null) {
      // The quarantine state intentionally has no live Dawn marker.
    } else {
      throw new Error("Duplicate Release marker is not canonical")
    }
  }
  if (evidenceKinds.length === 2 && snapshot.marker === null) {
    if (snapshot.body !== requirements.recoveryNotice || !isCanonicalNotice(snapshot.body)) {
      throw new Error("Duplicate Release recovery notice is malformed")
    }
    return "quarantined"
  }
  if (snapshot.body !== requirements.canonicalBody) {
    throw new Error("Duplicate Release original body changed")
  }
  if (evidenceKinds.length === 0) return "untouched"
  if (evidenceKinds.length === 1 && evidenceKinds[0] === "body") return "body-archived"
  if (evidenceKinds.length === 2 && evidenceKinds[0] === "body" && evidenceKinds[1] === "receipt") {
    return "receipt-archived"
  }
  throw new Error("Duplicate Release state is unknown")
}

export function originalBodyAssetName(releaseId, bodySha256) {
  assertDuplicateReleaseId(releaseId)
  assertSha256(bodySha256, "Original body SHA-256")
  return `dawn-v${DUPLICATE_DRAFT_RECOVERY_POLICY.version}-duplicate-${releaseId}-original-body-${bodySha256}.txt`
}

export function recoveryReceiptAssetName(releaseId) {
  assertDuplicateReleaseId(releaseId)
  return `dawn-v${DUPLICATE_DRAFT_RECOVERY_POLICY.version}-duplicate-${releaseId}-recovery-receipt.json`
}

export function canonicalRecoveryReceipt(input) {
  const source = exactObject(
    input,
    [
      "repository",
      "version",
      "candidateSha",
      "recoveryCommit",
      "canonicalReleaseId",
      "duplicateReleaseId",
      "originalBodySha256",
      "baseAssetSetSha256",
      "archiveAsset",
    ],
    "recovery receipt",
  )
  assertPolicyIdentity(source)
  assertGitSha(source.recoveryCommit, "Recovery commit")
  assertReleaseId(source.canonicalReleaseId, "Canonical Release ID")
  if (source.canonicalReleaseId !== DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId) {
    throw new Error("Recovery receipt canonical Release ID is not approved")
  }
  assertDuplicateReleaseId(source.duplicateReleaseId)
  assertSha256(source.originalBodySha256, "Original body SHA-256")
  assertSha256(source.baseAssetSetSha256, "Base asset set SHA-256")
  const archiveAsset = exactObject(source.archiveAsset, ["name", "sha256"], "archive asset")
  if (
    archiveAsset.name !==
      originalBodyAssetName(source.duplicateReleaseId, source.originalBodySha256) ||
    archiveAsset.sha256 !== source.originalBodySha256
  ) {
    throw new Error("Recovery receipt archive asset is not derived from the candidate")
  }
  const record = {
    schemaVersion: 1,
    repository: source.repository,
    version: source.version,
    candidateSha: source.candidateSha,
    recoveryCommit: source.recoveryCommit,
    canonicalReleaseId: source.canonicalReleaseId,
    duplicateReleaseId: source.duplicateReleaseId,
    originalBodySha256: source.originalBodySha256,
    baseAssetSetSha256: source.baseAssetSetSha256,
    archiveAsset,
  }
  const bytes = Buffer.from(`${JSON.stringify(canonicalize(record))}\n`, "utf8")
  if (bytes.byteLength > MAX_RECEIPT_BYTES)
    throw new Error("Recovery receipt exceeds its byte limit")
  return bytes
}

export function canonicalRecoveryNotice(input) {
  const source = exactObject(
    input,
    [
      "repository",
      "version",
      "canonicalReleaseId",
      "duplicateReleaseId",
      "originalBodySha256",
      "archiveAssetName",
      "receiptAssetName",
      "receiptSha256",
    ],
    "recovery notice",
  )
  if (source.repository !== DUPLICATE_DRAFT_RECOVERY_POLICY.repository) {
    throw new Error("Recovery notice repository is not approved")
  }
  if (source.version !== DUPLICATE_DRAFT_RECOVERY_POLICY.version) {
    throw new Error("Recovery notice version is not approved")
  }
  assertReleaseId(source.canonicalReleaseId, "Canonical Release ID")
  if (source.canonicalReleaseId !== DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId) {
    throw new Error("Recovery notice canonical Release ID is not approved")
  }
  assertDuplicateReleaseId(source.duplicateReleaseId)
  assertSha256(source.originalBodySha256, "Original body SHA-256")
  if (
    source.archiveAssetName !==
    originalBodyAssetName(source.duplicateReleaseId, source.originalBodySha256)
  ) {
    throw new Error("Recovery notice archive asset is not derived from the candidate")
  }
  if (source.receiptAssetName !== recoveryReceiptAssetName(source.duplicateReleaseId)) {
    throw new Error("Recovery notice receipt asset is not derived from the candidate")
  }
  assertSha256(source.receiptSha256, "Recovery receipt SHA-256")
  const notice = {
    schemaVersion: 1,
    type: "DAWN_DUPLICATE_DRAFT_RECOVERY",
    repository: source.repository,
    version: source.version,
    candidateSha: DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha,
    canonicalReleaseId: source.canonicalReleaseId,
    duplicateReleaseId: source.duplicateReleaseId,
    originalBodySha256: source.originalBodySha256,
    archiveAssetName: source.archiveAssetName,
    receiptAssetName: source.receiptAssetName,
    receiptSha256: source.receiptSha256,
  }
  const text = `${JSON.stringify(canonicalize(notice))}\n`
  if (text.includes(MARKER_DELIMITER)) throw new Error("Recovery notice contains a Dawn marker")
  if (Buffer.byteLength(text, "utf8") > MAX_NOTICE_BYTES) {
    throw new Error("Recovery notice exceeds its byte limit")
  }
  return text
}

function normalizeDuplicateDraftEvidence(value) {
  const source = snapshotJson(value)
  if (!isRecord(source)) throw new TypeError("Duplicate draft evidence must be an object")
  if (!Object.hasOwn(source, "schemaVersion")) return normalizeDuplicateDraftObservation(source)
  exactObject(source, DUPLICATE_EVIDENCE_FIELDS, "duplicate draft evidence")
  if (source.schemaVersion !== 1) throw new TypeError("Duplicate draft evidence schema is invalid")
  const rawDuplicates = normalizeDuplicateEvidenceDuplicates(source.releases)
  const rebuilt = normalizeDuplicateDraftObservation({
    capturedAt: source.capturedAt,
    reviewedAuthority: source.reviewedAuthority,
    repository: source.repository,
    workflow: source.workflow,
    immutableReleases: source.immutableReleases,
    candidate: source.candidate,
    npm: source.npm,
    releaseRuns: source.releaseRuns,
    releases: { canonical: source.releases.canonical, duplicates: rawDuplicates },
  })
  if (!sameJson(source, rebuilt)) {
    throw new TypeError("Duplicate draft evidence contains caller-trusted derived fields")
  }
  return rebuilt
}

function normalizeDuplicateDraftObservation(value, capturedAtOverride) {
  const source = exactObject(value, DUPLICATE_OBSERVATION_FIELDS, "duplicate draft observation")
  const capturedAt = normalizeCanonicalTimestamp(
    capturedAtOverride === undefined ? source.capturedAt : capturedAtOverride,
    "Duplicate draft evidence capture time",
  )
  if (capturedAtOverride !== undefined) {
    normalizeCanonicalTimestamp(
      source.capturedAt,
      "Current duplicate draft observation capture time",
    )
  }
  const reviewedAuthority = normalizeReviewedAuthority(source.reviewedAuthority)
  const repository = normalizeRecoveryRepository(
    source.repository,
    reviewedAuthority.mergeCommitSha,
  )
  const workflow = normalizeRecoveryWorkflow(source.workflow)
  const immutableReleases = normalizeImmutableReleases(source.immutableReleases)
  const candidate = normalizeRecoveryCandidate(source.candidate)
  const npm = normalizeNpmAbsence(source.npm, candidate.version)
  const releaseRuns = normalizeReleaseRuns(source.releaseRuns)
  const releases = normalizeRecoveryReleases(source.releases, { reviewedAuthority, candidate })
  return {
    schemaVersion: 1,
    capturedAt,
    reviewedAuthority,
    repository,
    workflow,
    immutableReleases,
    candidate,
    npm,
    releaseRuns,
    releases,
  }
}

function validateCurrentObservationTimestamp(value, { evidenceCapturedAtMs, nowMs }) {
  const source = exactObject(
    value,
    DUPLICATE_OBSERVATION_FIELDS,
    "current duplicate draft observation",
  )
  const capturedAt = normalizeCanonicalTimestamp(
    source.capturedAt,
    "Current duplicate draft observation capture time",
  )
  const capturedAtMs = Date.parse(capturedAt)
  if (capturedAtMs > nowMs) {
    throw new Error("Current duplicate draft observation capture time is in the future")
  }
  if (nowMs - capturedAtMs > MAX_DUPLICATE_EVIDENCE_AGE_MS) {
    throw new Error("Current duplicate draft observation has expired and must be recaptured")
  }
  if (capturedAtMs < evidenceCapturedAtMs) {
    throw new Error("Current duplicate draft observation predates the sealed evidence")
  }
  return source
}

function normalizeReviewedAuthority(value) {
  const source = exactObject(
    value,
    [
      "mergeCommitSha",
      "mergeTreeSha",
      "pullRequestNumber",
      "reviewedHeadSha",
      "reviewedTreeSha",
      "validateRunId",
    ],
    "reviewed recovery authority",
  )
  assertGitSha(source.mergeCommitSha, "Recovery merge commit")
  assertGitSha(source.mergeTreeSha, "Recovery merge tree")
  assertGitSha(source.reviewedHeadSha, "Reviewed pull request head")
  assertGitSha(source.reviewedTreeSha, "Reviewed pull request tree")
  assertPositiveInteger(source.pullRequestNumber, "Reviewed pull request number")
  assertPositiveInteger(source.validateRunId, "Reviewed validate run ID")
  if (source.mergeTreeSha !== source.reviewedTreeSha) {
    throw new TypeError("Reviewed and merged recovery trees must be identical")
  }
  return {
    mergeCommitSha: source.mergeCommitSha,
    mergeTreeSha: source.mergeTreeSha,
    pullRequestNumber: source.pullRequestNumber,
    reviewedHeadSha: source.reviewedHeadSha,
    reviewedTreeSha: source.reviewedTreeSha,
    validateRunId: source.validateRunId,
  }
}

function normalizeRecoveryRepository(value, mergeCommitSha) {
  const source = exactObject(value, ["id", "nameWithOwner", "mainSha"], "recovery repository")
  assertGitSha(source.mainSha, "Recovery repository main SHA")
  if (
    source.id !== 1210070282 ||
    source.nameWithOwner !== DUPLICATE_DRAFT_RECOVERY_POLICY.repository ||
    source.mainSha !== mergeCommitSha
  ) {
    throw new TypeError("Recovery repository identity is not exact")
  }
  return { id: source.id, nameWithOwner: source.nameWithOwner, mainSha: source.mainSha }
}

function normalizeRecoveryWorkflow(value) {
  const source = exactObject(value, ["id", "state"], "recovery workflow")
  if (source.id !== 260503756 || source.state !== "disabled_manually") {
    throw new TypeError("Recovery workflow is not the disabled Release workflow")
  }
  return { id: 260503756, state: "disabled_manually" }
}

function normalizeImmutableReleases(value) {
  const source = exactObject(value, ["enabled"], "immutable Releases evidence")
  if (source.enabled !== true) throw new TypeError("Immutable Releases must be enabled")
  return { enabled: true }
}

function normalizeRecoveryCandidate(value) {
  const source = exactObject(value, ["version", "commitSha", "tagObjectSha"], "recovery candidate")
  assertGitSha(source.tagObjectSha, "Recovery candidate annotated tag object")
  if (
    source.version !== DUPLICATE_DRAFT_RECOVERY_POLICY.version ||
    source.commitSha !== DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha
  ) {
    throw new TypeError("Recovery candidate identity is not exact")
  }
  return { version: source.version, commitSha: source.commitSha, tagObjectSha: source.tagObjectSha }
}

function normalizeNpmAbsence(value, version) {
  const source = exactObject(value, ["packages"], "npm absence evidence")
  if (!Array.isArray(source.packages) || source.packages.length !== 21) {
    throw new TypeError("npm absence evidence package inventory is invalid")
  }
  const packageOrder = CANONICAL_RELEASE_PACKAGE_ORDER
  return {
    packages: source.packages.map((entry, index) => {
      const item = exactObject(entry, ["name", "version", "status"], "npm absence package")
      if (
        item.name !== packageOrder[index] ||
        item.version !== version ||
        item.status !== "absent"
      ) {
        throw new TypeError("npm absence evidence is not exact")
      }
      return { name: item.name, version: item.version, status: "absent" }
    }),
  }
}

function normalizeReleaseRuns(value) {
  if (!Array.isArray(value) || value.length !== 0) {
    throw new TypeError("Recovery evidence requires no release workflow runs")
  }
  return []
}

function normalizeRecoveryReleases(value, { reviewedAuthority, candidate }) {
  const source = exactObject(value, ["canonical", "duplicates"], "recovery Releases evidence")
  const canonical = normalizeCanonicalRecoveryRelease(source.canonical, candidate)
  if (
    !Array.isArray(source.duplicates) ||
    source.duplicates.length !== DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates.length
  ) {
    throw new TypeError("Recovery duplicate Release inventory is invalid")
  }
  const originalBodySha256 = sha256(canonical.body)
  const originalAssets = canonical.assets.map(({ name, sha256: digest }) => ({
    name,
    sha256: digest,
  }))
  const baseAssetSetSha256 = assetSetSha256(canonical.assets)
  const duplicates = source.duplicates.map((value, index) => {
    const raw = normalizeRecoveryDuplicateSource(value, canonical.assets)
    const configured = DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates[index]
    if (raw.releaseId !== configured.releaseId || raw.tagName !== configured.tagName) {
      throw new TypeError("Recovery duplicate Release order or identity is not exact")
    }
    const recoveryReceipt = {
      repository: DUPLICATE_DRAFT_RECOVERY_POLICY.repository,
      version: candidate.version,
      candidateSha: candidate.commitSha,
      recoveryCommit: reviewedAuthority.mergeCommitSha,
      canonicalReleaseId: DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId,
      duplicateReleaseId: raw.releaseId,
      originalBodySha256,
      baseAssetSetSha256,
      archiveAsset: {
        name: originalBodyAssetName(raw.releaseId, originalBodySha256),
        sha256: originalBodySha256,
      },
    }
    const receiptBytes = canonicalRecoveryReceipt(recoveryReceipt).toString("utf8")
    const receiptSha256 = sha256Bytes(Buffer.from(receiptBytes, "utf8"))
    const noticeBytes = canonicalRecoveryNotice({
      repository: DUPLICATE_DRAFT_RECOVERY_POLICY.repository,
      version: candidate.version,
      canonicalReleaseId: DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId,
      duplicateReleaseId: raw.releaseId,
      originalBodySha256,
      archiveAssetName: recoveryReceipt.archiveAsset.name,
      receiptAssetName: recoveryReceiptAssetName(raw.releaseId),
      receiptSha256,
    })
    const state = classifyDuplicateDraft(raw, {
      releaseId: raw.releaseId,
      tagName: raw.tagName,
      canonicalBody: canonical.body,
      canonicalMarker: canonical.marker,
      originalBodySha256,
      originalAssets: canonical.assets,
      recoveryReceipt,
      recoveryNotice: noticeBytes,
    })
    return {
      ...raw,
      originalBodySha256,
      originalAssets,
      baseAssetSetSha256,
      archiveAssetName: recoveryReceipt.archiveAsset.name,
      receiptAssetName: recoveryReceiptAssetName(raw.releaseId),
      receiptSha256,
      receiptBytes,
      noticeBytes,
      state,
      remainingTransitions: remainingTransitions(state),
    }
  })
  return { canonical, duplicates }
}

function normalizeRecoveryDuplicateSource(value, originalAssets) {
  const source = exactObject(value, DUPLICATE_SOURCE_FIELDS, "recovery duplicate Release")
  const evidenceKinds = normalizeEvidenceKinds(source.evidenceAssets)
  if (
    !Array.isArray(source.assets) ||
    source.assets.length !== originalAssets.length + evidenceKinds.length
  ) {
    throw new TypeError("Recovery duplicate Release asset inventory is invalid")
  }
  const original = normalizeAssets(
    source.assets.slice(0, originalAssets.length),
    "recovery duplicate original assets",
    false,
  )
  const evidence = source.assets
    .slice(originalAssets.length)
    .map(
      (asset, index) =>
        normalizeAssets(
          [asset],
          "recovery duplicate evidence asset",
          evidenceKinds[index] === "receipt",
        )[0],
    )
  assertUniqueAssets([...original, ...evidence], "recovery duplicate Release assets")
  return {
    releaseId: source.releaseId,
    tagName: source.tagName,
    body: source.body,
    marker: source.marker,
    assets: [...original, ...evidence],
    evidenceAssets: evidenceKinds,
  }
}

function normalizeCanonicalRecoveryRelease(value, candidate) {
  const source = exactObject(
    value,
    ["releaseId", "tagName", "body", "marker", "assets"],
    "canonical Release",
  )
  assertReleaseId(source.releaseId, "Canonical Release ID")
  if (
    source.releaseId !== DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId ||
    source.tagName !== CANONICAL_OPAQUE_TAG ||
    typeof source.body !== "string" ||
    !Array.isArray(source.assets) ||
    source.assets.length !== 45
  ) {
    throw new TypeError("Canonical Release identity is not exact")
  }
  const assets = normalizeAssets(source.assets, "canonical Release assets", false)
  assertUniqueAssets(assets, "canonical Release assets")
  let marker
  try {
    marker = parseReleaseMarker(source.body)
  } catch (error) {
    throw new TypeError("Canonical Release body is not a valid Dawn release body", { cause: error })
  }
  if (
    !sameJson(marker, source.marker) ||
    marker.phase !== "ESCROWED" ||
    marker.version !== candidate.version ||
    marker.commitSha !== candidate.commitSha ||
    marker.tag !== `v${candidate.version}` ||
    marker.baseAssetSetSha256 !== assetSetSha256(assets)
  ) {
    throw new TypeError("Canonical Release marker is not exact")
  }
  return { releaseId: source.releaseId, tagName: source.tagName, body: source.body, marker, assets }
}

function assertCaptureReader(value) {
  let prototype
  let keys
  let frozen
  try {
    if (!isRecord(value)) throw new TypeError("invalid reader")
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
    frozen = Object.isFrozen(value)
  } catch {
    captureFail("CAPTURE_READER_SURFACE_INVALID", "Recovery capture reader is invalid")
  }
  if (
    ![Object.prototype, null].includes(prototype) ||
    !frozen ||
    keys.some((key) => typeof key !== "string")
  ) {
    captureFail("CAPTURE_READER_SURFACE_INVALID", "Recovery capture reader is invalid")
  }
  const actual = [...keys].sort(compareText)
  const expected = [...CAPTURE_READER_METHODS].sort(compareText)
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    captureFail(
      "CAPTURE_READER_SURFACE_INVALID",
      "Recovery capture reader must expose only recovery reads",
    )
  }
  for (const name of CAPTURE_READER_METHODS) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, name)
    } catch {
      captureFail("CAPTURE_READER_SURFACE_INVALID", "Recovery capture reader is invalid")
    }
    if (
      descriptor?.enumerable !== true ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      typeof descriptor.value !== "function"
    ) {
      captureFail(
        "CAPTURE_READER_SURFACE_INVALID",
        "Recovery capture reader must expose only recovery reads",
      )
    }
  }
}

async function captureRead(reader, method, args, code) {
  try {
    return snapshotJson(await reader[method](...args))
  } catch (error) {
    if (error instanceof DuplicateDraftRecoveryCaptureError) throw error
    captureFail(code, `Recovery capture read ${method} failed`)
  }
}

function normalizeCaptureRuns(value) {
  const source = exactObject(value, ["runs", "candidateRuns"], "recovery workflow run observation")
  if (!Array.isArray(source.runs) || !Array.isArray(source.candidateRuns)) {
    captureFail("RELEASE_RUNS_MALFORMED", "Recovery workflow run observation is malformed")
  }
  const runs = source.runs
    .map((run) => normalizeCaptureRun(run, "Release workflow run", false))
    .sort(compareCaptureRun)
  const candidateRuns = source.candidateRuns
    .map((run) => normalizeCaptureRun(run, "candidate Release workflow run", true))
    .sort(compareCaptureRun)
  assertUniqueRunIds(runs, "exhaustive")
  assertUniqueRunIds(candidateRuns, "candidate")
  const expectedCandidates = runs.filter(
    (run) => run.headSha === DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha,
  )
  if (!sameJson(expectedCandidates, candidateRuns)) {
    captureFail("RELEASE_RUNS_MALFORMED", "Candidate workflow run set is not exhaustive")
  }
  return {
    nonterminalRuns: runs.filter((run) => run.status !== "completed"),
    candidateRuns,
  }
}

function compareCaptureRun(left, right) {
  return left.id - right.id || left.runAttempt - right.runAttempt
}

function normalizeCaptureRun(value, label, requireCandidateSha) {
  const source = exactObject(
    value,
    ["id", "runAttempt", "status", "conclusion", "headSha", "createdAt", "startedAt", "updatedAt"],
    label,
  )
  assertPositiveInteger(source.id, `${label} ID`)
  assertPositiveInteger(source.runAttempt, `${label} attempt`)
  assertGitSha(source.headSha, `${label} head SHA`)
  if (
    !CAPTURE_RUN_STATUSES.has(source.status) ||
    !isCaptureTimestamp(source.createdAt) ||
    !isNullableCaptureTimestamp(source.startedAt) ||
    !isCaptureTimestamp(source.updatedAt) ||
    !coherentCaptureTerminalState(source.status, source.conclusion) ||
    (source.status === "completed" || source.status === "in_progress") !==
      (source.startedAt !== null) ||
    !orderedCaptureTimestamps(source.createdAt, source.startedAt, source.updatedAt) ||
    (requireCandidateSha && source.headSha !== DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha)
  ) {
    captureFail("RELEASE_RUNS_MALFORMED", "Recovery workflow run observation is malformed")
  }
  return source
}

function assertUniqueRunIds(runs, label) {
  if (new Set(runs.map((run) => run.id)).size !== runs.length) {
    captureFail("RELEASE_RUNS_MALFORMED", `Recovery ${label} workflow runs are duplicated`)
  }
}

function assertNoStartedPublishJob(value, expectedRunId, currentAttempt) {
  if (!Array.isArray(value) || value.length === 0) {
    captureFail("CANDIDATE_JOBS_MALFORMED", "Candidate workflow jobs are malformed")
  }
  const ids = new Set()
  const identities = new Set()
  const attempts = new Set()
  const publishJobs = []
  for (const raw of value) {
    let job
    try {
      job = exactObject(
        raw,
        ["id", "runId", "runAttempt", "name", "status", "conclusion", "startedAt", "completedAt"],
        "candidate workflow job",
      )
    } catch {
      captureFail("CANDIDATE_JOBS_MALFORMED", "Candidate workflow jobs are malformed")
    }
    const identity = `${job.runAttempt}:${job.id}`
    if (
      !Number.isSafeInteger(job.id) ||
      job.id < 1 ||
      ids.has(job.id) ||
      identities.has(identity) ||
      !Number.isSafeInteger(job.runId) ||
      job.runId !== expectedRunId ||
      !Number.isSafeInteger(job.runAttempt) ||
      job.runAttempt < 1 ||
      job.runAttempt > currentAttempt ||
      !isBoundedCaptureText(job.name, 512) ||
      !CAPTURE_JOB_STATUSES.has(job.status) ||
      !isNullableCaptureTimestamp(job.startedAt) ||
      !isNullableCaptureTimestamp(job.completedAt) ||
      !coherentCaptureTerminalState(job.status, job.conclusion) ||
      (job.status === "completed"
        ? job.startedAt === null || job.completedAt === null
        : job.completedAt !== null ||
          (job.status === "in_progress") !== (job.startedAt !== null)) ||
      !orderedCaptureTimestamps(job.startedAt, job.completedAt)
    ) {
      captureFail("CANDIDATE_JOBS_MALFORMED", "Candidate workflow jobs are malformed")
    }
    ids.add(job.id)
    identities.add(identity)
    attempts.add(job.runAttempt)
    if (job.name === "publish-npm") publishJobs.push(job)
  }
  if (attempts.size !== currentAttempt) {
    captureFail("CANDIDATE_JOBS_MALFORMED", "Candidate workflow job attempt coverage is incomplete")
  }
  for (let attempt = 1; attempt <= currentAttempt; attempt += 1) {
    if (
      !attempts.has(attempt) ||
      publishJobs.filter((job) => job.runAttempt === attempt).length !== 1
    ) {
      captureFail(
        "CANDIDATE_JOBS_MALFORMED",
        "Candidate workflow publish job identity is not exact",
      )
    }
  }
  if (publishJobs.some(({ startedAt }) => startedAt !== null)) {
    captureFail("CANDIDATE_PUBLISH_JOB_STARTED", "A candidate publish-npm job has already started")
  }
}

function normalizeCandidateReleaseInventory(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    captureFail("CANDIDATE_RELEASE_INVENTORY_CONFLICT", "Candidate Release inventory is not exact")
  }
  const expected = [
    {
      releaseId: DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId,
      tagName: CANONICAL_OPAQUE_TAG,
    },
    ...DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates,
  ].sort((left, right) => left.releaseId - right.releaseId)
  const normalized = value
    .map((raw) => {
      const release = exactObject(
        raw,
        ["releaseId", "tagName", "draft", "prerelease", "immutable", "targetCommitish", "marker"],
        "candidate Release summary",
      )
      assertReleaseId(release.releaseId, "Candidate Release ID")
      if (
        typeof release.tagName !== "string" ||
        release.draft !== true ||
        release.prerelease !== false ||
        release.immutable !== false ||
        release.targetCommitish !== "main"
      ) {
        captureFail(
          "CANDIDATE_RELEASE_INVENTORY_CONFLICT",
          "Candidate Release metadata is not exact",
        )
      }
      return release
    })
    .sort((left, right) => left.releaseId - right.releaseId)
  if (
    normalized.some(
      (release, index) =>
        release.releaseId !== expected[index].releaseId ||
        release.tagName !== expected[index].tagName ||
        release.tagName === `v${DUPLICATE_DRAFT_RECOVERY_POLICY.version}`,
    )
  ) {
    captureFail(
      "CANDIDATE_RELEASE_INVENTORY_CONFLICT",
      "Candidate Release identities are not exact",
    )
  }
  for (const release of normalized) {
    if (release.marker === null) continue
    const marker = snapshotJson(release.marker)
    if (
      !isRecord(marker) ||
      marker.version !== DUPLICATE_DRAFT_RECOVERY_POLICY.version ||
      marker.commitSha !== DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha ||
      marker.tag !== `v${DUPLICATE_DRAFT_RECOVERY_POLICY.version}`
    ) {
      captureFail(
        "CANDIDATE_RELEASE_INVENTORY_CONFLICT",
        "Candidate Release marker identity is not exact",
      )
    }
  }
}

function captureFail(code, message) {
  throw new DuplicateDraftRecoveryCaptureError(code, message)
}

function normalizeDuplicateEvidenceDuplicates(value) {
  const releases = exactObject(value, ["canonical", "duplicates"], "recovery Releases evidence")
  if (!Array.isArray(releases.duplicates))
    throw new TypeError("Recovery duplicate Release inventory is invalid")
  return releases.duplicates.map((duplicate) => {
    const item = exactObject(
      duplicate,
      [...DUPLICATE_SOURCE_FIELDS, ...DUPLICATE_DERIVED_FIELDS],
      "sealed recovery duplicate Release",
    )
    return Object.fromEntries(DUPLICATE_SOURCE_FIELDS.map((field) => [field, item[field]]))
  })
}

function remainingTransitions(state) {
  if (state === "untouched") return ["archive-body", "archive-receipt", "quarantine"]
  if (state === "body-archived") return ["archive-receipt", "quarantine"]
  if (state === "receipt-archived") return ["quarantine"]
  if (state === "quarantined") return []
  throw new TypeError("Duplicate Release state is invalid")
}

function normalizeEvidenceBytes(value) {
  if (!(value instanceof Uint8Array))
    throw new TypeError("Duplicate draft evidence bytes are invalid")
  const bytes = Buffer.from(value)
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_DUPLICATE_DRAFT_EVIDENCE_BYTES ||
    bytes.at(-1) !== 0x0a ||
    bytes.includes(0x0d)
  ) {
    throw new TypeError("Duplicate draft evidence bytes are outside canonical bounds")
  }
  return bytes
}

function normalizeCanonicalTimestamp(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`)
  const milliseconds = Date.parse(value)
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${label} is not canonical`)
  }
  return value
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} is invalid`)
}

function assertUniqueAssets(assets, label) {
  const ids = new Set()
  const names = new Set()
  for (const asset of assets) {
    if (ids.has(asset.id) || names.has(asset.name)) throw new TypeError(`${label} are not unique`)
    ids.add(asset.id)
    names.add(asset.name)
  }
}

function assertPolicyIdentity(source) {
  if (
    source.repository !== DUPLICATE_DRAFT_RECOVERY_POLICY.repository ||
    source.version !== DUPLICATE_DRAFT_RECOVERY_POLICY.version ||
    source.candidateSha !== DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha
  ) {
    throw new Error("Recovery receipt candidate identity is not approved")
  }
}

function assertDuplicateIdentity(releaseId, tagName, expected) {
  assertDuplicateReleaseId(releaseId)
  const configured = DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates.find(
    (duplicate) => duplicate.releaseId === releaseId,
  )
  if (
    configured === undefined ||
    releaseId !== expected.releaseId ||
    tagName !== expected.tagName ||
    tagName !== configured.tagName
  ) {
    throw new Error("Duplicate Release identity is not exact")
  }
  if (tagName === `v${DUPLICATE_DRAFT_RECOVERY_POLICY.version}`) {
    throw new Error("Duplicate Release must retain its opaque temporary tag")
  }
}

function assertDuplicateReleaseId(value) {
  assertReleaseId(value, "Duplicate Release ID")
  if (!DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates.some((item) => item.releaseId === value)) {
    throw new Error("Release ID is not an approved duplicate")
  }
}

function assertReleaseId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} is invalid`)
}

function assertGitSha(value, label) {
  if (typeof value !== "string" || !GIT_SHA_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase Git SHA-1`)
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`)
  }
}

function assertBodyDigest(body, expectedDigest) {
  if (typeof body !== "string") throw new TypeError("Canonical duplicate body is invalid")
  assertSha256(expectedDigest, "Original body SHA-256")
  if (sha256(body) !== expectedDigest)
    throw new Error("Canonical duplicate body digest is not exact")
}

function normalizeEvidenceKinds(value) {
  if (!Array.isArray(value) || value.length > 2)
    throw new TypeError("Duplicate evidence asset list is invalid")
  const result = value.map((kind) => {
    if (kind !== "body" && kind !== "receipt") throw new Error("Unknown duplicate evidence asset")
    return kind
  })
  if (new Set(result).size !== result.length)
    throw new Error("Duplicate evidence asset list contains duplicates")
  if (result.includes("receipt") && !result.includes("body")) {
    throw new Error("Recovery receipt cannot exist without the original-body archive")
  }
  return result
}

function normalizeAssets(value, label, allowBytes) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value.map((asset, index) => {
    const source = snapshotJson(asset)
    const normalized = exactObject(
      source,
      allowBytes && Object.hasOwn(source, "bytes")
        ? ["id", "name", "sha256", "bytes"]
        : ["id", "name", "sha256"],
      `${label}[${index}]`,
    )
    assertReleaseId(normalized.id, `${label}[${index}] id`)
    if (typeof normalized.name !== "string" || !ASSET_NAME_PATTERN.test(normalized.name)) {
      throw new TypeError(`${label}[${index}] name is invalid`)
    }
    assertSha256(normalized.sha256, `${label}[${index}] SHA-256`)
    if (Object.hasOwn(normalized, "bytes") && typeof normalized.bytes !== "string") {
      throw new TypeError(`${label}[${index}] bytes are invalid`)
    }
    return normalized
  })
}

function exactObject(value, fields, label) {
  const source = snapshotJson(value)
  if (!isRecord(source)) throw new TypeError(`${label} must be an object`)
  const actual = Object.keys(source).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} contains unexpected or missing fields`)
  }
  return source
}

function isCanonicalNotice(value) {
  if (typeof value !== "string" || !value.endsWith("\n") || value.includes(MARKER_DELIMITER))
    return false
  try {
    const parsed = JSON.parse(value)
    return `${JSON.stringify(canonicalize(parsed))}\n` === value
  } catch {
    return false
  }
}

function parseCanonicalNotice(
  value,
  expectedDuplicateReleaseId,
  expectedOriginalBodySha256,
  expectedArchiveAssetName,
) {
  if (!isCanonicalNotice(value)) throw new Error("Duplicate Release recovery notice is malformed")
  const notice = snapshotJson(JSON.parse(value))
  if (
    !isRecord(notice) ||
    Object.keys(notice).sort().join(",") !==
      [
        "archiveAssetName",
        "candidateSha",
        "canonicalReleaseId",
        "duplicateReleaseId",
        "originalBodySha256",
        "receiptAssetName",
        "receiptSha256",
        "repository",
        "schemaVersion",
        "type",
        "version",
      ]
        .sort()
        .join(",") ||
    notice.repository !== DUPLICATE_DRAFT_RECOVERY_POLICY.repository ||
    notice.version !== DUPLICATE_DRAFT_RECOVERY_POLICY.version ||
    notice.candidateSha !== DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha ||
    notice.canonicalReleaseId !== DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId ||
    notice.duplicateReleaseId !== expectedDuplicateReleaseId ||
    notice.originalBodySha256 !== expectedOriginalBodySha256 ||
    notice.archiveAssetName !== expectedArchiveAssetName ||
    notice.archiveAssetName !==
      originalBodyAssetName(notice.duplicateReleaseId, notice.originalBodySha256) ||
    notice.receiptAssetName !== recoveryReceiptAssetName(notice.duplicateReleaseId) ||
    notice.schemaVersion !== 1 ||
    notice.type !== "DAWN_DUPLICATE_DRAFT_RECOVERY"
  ) {
    throw new Error("Duplicate Release recovery notice identity is not exact")
  }
  assertSha256(notice.originalBodySha256, "Recovery notice original body SHA-256")
  assertSha256(notice.receiptSha256, "Recovery notice receipt SHA-256")
  return notice
}

function sameJson(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isCaptureTimestamp(value) {
  if (typeof value !== "string" || !CAPTURE_TIMESTAMP_PATTERN.test(value)) return false
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return false
  const canonical = new Date(milliseconds).toISOString()
  return (
    value === canonical ||
    (canonical.endsWith(".000Z") && value === canonical.replace(".000Z", "Z"))
  )
}

function isNullableCaptureTimestamp(value) {
  return value === null || isCaptureTimestamp(value)
}

function isBoundedCaptureText(value, maximumBytes) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximumBytes &&
    !/[\0\r\n]/u.test(value)
  )
}

function coherentCaptureTerminalState(status, conclusion) {
  return status === "completed" ? CAPTURE_TERMINAL_CONCLUSIONS.has(conclusion) : conclusion === null
}

function orderedCaptureTimestamps(...values) {
  const timestamps = values.filter((value) => value !== null).map((value) => Date.parse(value))
  return timestamps.every((value, index) => index === 0 || timestamps[index - 1] <= value)
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function assetSetSha256(assets) {
  return sha256(`${JSON.stringify(assetNamespace(assets))}\n`)
}

function assetNamespace(assets) {
  return assets.map(({ name, sha256: digest }) => ({ name, sha256: digest }))
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex")
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
