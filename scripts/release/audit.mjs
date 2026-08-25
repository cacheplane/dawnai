import { createHash } from "node:crypto"

import { snapshotJson } from "./adapter-normalize.mjs"
import { extractActionsArtifactZip } from "./artifact-store.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "./limits.mjs"
import {
  canonicalReleaseBody,
  parseReleaseMarker,
  parseSmokeReleaseAssetName,
  preflightAuditDraftAssetMetadata,
  releaseBodySha256,
  validatePublicationAuditAssets,
} from "./metadata.mjs"
import { isExactSemver, parseSemver } from "./semver.mjs"
import {
  aggregateSmokeResults,
  canonicalAggregateSmokeResultBytes,
  parseSmokeResult,
} from "./smoke-result.mjs"
import { canonicalAuditResultBytes, parseAuditResult } from "./terminal-records.mjs"

const REPOSITORY = "cacheplane/dawnai"
const WORKFLOW = ".github/workflows/published-artifact-verify.yml"
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const ATTEMPT_NAME_PATTERN = /^audit-attempt-([1-9][0-9]*)-([1-9][0-9]*)\.json$/u
const CANDIDATE_FIELDS = Object.freeze([
  "version",
  "commitSha",
  "ciWorkflow",
  "ciCheck",
  "publisherWorkflow",
])
const DISPATCH_FIELDS = Object.freeze(["workflow", "workflowRunId", "runUrl", "htmlUrl"])
const MAX_POLL_ATTEMPTS = 1_000
const MAX_DELAY_MS = 300_000
const AUDIT_WAIT_BUDGET_MS = 30 * 60 * 1_000

class AuditWaitDeadlineError extends Error {}

export async function dispatchIndependentAudit({ candidate, manifestSha256, github }) {
  const identity = validateCandidate(snapshotJson(candidate))
  assertSha256(manifestSha256, "Audit manifest digest")
  const actions = bindMethods(github, ["dispatchWorkflowAtRef"], "Independent audit dispatcher")
  const receipt = snapshotJson(
    await actions.dispatchWorkflowAtRef({
      workflow: WORKFLOW,
      ref: `v${identity.version}`,
      inputs: {
        version: identity.version,
        commitSha: identity.commitSha,
        manifestSha256,
      },
    }),
  )
  if (!hasExactFields(receipt, ["workflowRunId", "runUrl", "htmlUrl"])) {
    throw new Error("Independent audit dispatch receipt is malformed")
  }
  return validateDispatch({ workflow: WORKFLOW, ...receipt })
}

export async function recordAuditDispatch({ candidate, dispatch, github }) {
  const identity = validateCandidate(snapshotJson(candidate))
  const receipt = validateDispatch(dispatch)
  const effects = releaseEffects(github)
  await verifyAnnotatedCandidateTag(effects.reader, identity)
  let release = await requireDraftRelease(effects.reader, identity)
  let marker = parseReleaseMarker(release.body)
  assertMarkerIdentity(marker, identity)
  const observed = await observeAuditAssets(effects.reader, release.id, marker)

  if (marker.phase === "AUDIT_DISPATCHED") {
    if (!sameDispatch(marker.audit, receipt)) {
      throw new Error("A different independent audit dispatch is already current")
    }
    await verifyAnnotatedCandidateTag(effects.reader, identity)
    return transitionResult(release, marker, "unchanged")
  }
  if (!["SMOKES_COMPLETE", "AUDIT_RETRYABLE"].includes(marker.phase)) {
    throw new Error("Audit dispatch recording requires SMOKES_COMPLETE or AUDIT_RETRYABLE")
  }
  if (marker.phase === "AUDIT_RETRYABLE" && marker.audit.workflowRunId === receipt.workflowRunId) {
    throw new Error("An audit retry requires a new directly returned workflow run")
  }
  if (
    marker.phase === "AUDIT_RETRYABLE" &&
    observed.auditFiles.some(
      ({ name, bytes }) =>
        name !== "audit-result.json" &&
        parseCanonicalAuditBytes(bytes).workflowRunId === receipt.workflowRunId,
    )
  ) {
    throw new Error("An audit retry cannot replay a historical workflow run ID")
  }

  const next = {
    ...marker,
    revision: marker.revision + 1,
    phase: "AUDIT_DISPATCHED",
    audit: dispatchMarker(receipt),
  }
  const body = canonicalReleaseBody({ marker: next, manifest: null, previousMarker: marker })
  await effects.writer.updateDraftReleaseIfCurrent({
    releaseId: release.id,
    tag: marker.tag,
    targetSha: identity.commitSha,
    expectedBodySha256: releaseBodySha256(release.body),
    title: `Dawn v${identity.version}`,
    body,
  })
  release = await readManagedRelease(effects.reader, release.id)
  marker = parseReleaseMarker(release.body)
  if (marker.phase !== "AUDIT_DISPATCHED" || !sameDispatch(marker.audit, receipt)) {
    throw new Error("Audit dispatch marker compare-and-swap was not durable")
  }
  await observeAuditAssets(effects.reader, release.id, marker)
  await verifyAnnotatedCandidateTag(effects.reader, identity)
  return transitionResult(release, marker, "updated")
}

export async function waitForAudit({
  runId,
  candidate,
  github,
  attempts,
  delayMs,
  delay,
  now = Date.now,
  timeoutMs = AUDIT_WAIT_BUDGET_MS,
}) {
  assertPositiveId(runId, "Audit workflow run ID")
  const identity = validateCandidate(snapshotJson(candidate))
  assertInteger(attempts, 1, MAX_POLL_ATTEMPTS, "Audit poll attempts")
  assertInteger(delayMs, 0, MAX_DELAY_MS, "Audit poll delay")
  assertInteger(timeoutMs, 1, AUDIT_WAIT_BUDGET_MS, "Audit poll timeout")
  if (typeof delay !== "function") throw new TypeError("Audit poll delay function is invalid")
  const clock = monotonicAuditClock(now)
  const deadline = clock() + timeoutMs
  if (!Number.isSafeInteger(deadline)) throw new TypeError("Audit poll deadline is invalid")
  const actions = bindMethods(
    github,
    ["getActionsRun", "listActionsRunArtifacts", "getActionsArtifact", "downloadActionsArtifact"],
    "Independent audit reader",
  )

  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      assertAuditTimeRemaining(deadline, clock)
      const run = await withinAuditDeadline(
        readValue(actions.getActionsRun({ runId }), "actions-run"),
        deadline,
        clock,
      )
      validateActionsRun(run, runId, identity)
      if (run.status !== "completed") {
        if (attempt < attempts) {
          const remaining = auditTimeRemaining(deadline, clock)
          if (remaining <= 0) throw new AuditWaitDeadlineError()
          const waitMs = Math.min(delayMs, remaining)
          await withinAuditDeadline(
            Promise.resolve().then(() => delay(waitMs)),
            deadline,
            clock,
          )
        }
        continue
      }
      return await readTerminalAudit({
        actions,
        run,
        runId,
        candidate: identity,
        deadline,
        clock,
      })
    }
  } catch (error) {
    if (!(error instanceof AuditWaitDeadlineError)) throw error
  }
  return deepFreeze({ status: "pending", workflowRunId: runId })
}

export function correlateAuditResult({ dispatch, result, candidate, manifestSha256 }) {
  const identity = validateCandidate(snapshotJson(candidate))
  const receipt = validateDispatch(dispatch)
  assertSha256(manifestSha256, "Audit manifest digest")
  const audit = parseAuditResult(result)
  if (
    audit.version !== identity.version ||
    audit.commitSha !== identity.commitSha ||
    audit.manifestSha256 !== manifestSha256 ||
    audit.workflowRunId !== receipt.workflowRunId
  ) {
    throw new Error("Audit result is not correlated to the dispatch and exact candidate")
  }
  return audit
}

export async function recordAuditAttempt({ candidate, dispatch, result, github }) {
  const identity = validateCandidate(snapshotJson(candidate))
  const receipt = validateDispatch(dispatch)
  const audit = parseAuditResult(result)
  const bytes = canonicalAuditResultBytes(audit)
  const digest = sha256(bytes)
  const attemptName = `audit-attempt-${audit.workflowRunId}-${audit.runAttempt}.json`
  const effects = releaseEffects(github)

  await verifyAnnotatedCandidateTag(effects.reader, identity)
  let release = await requireDraftRelease(effects.reader, identity)
  let marker = parseReleaseMarker(release.body)
  assertMarkerIdentity(marker, identity)
  correlateAuditResult({
    dispatch: receipt,
    result: audit,
    candidate: identity,
    manifestSha256: marker.manifestSha256,
  })
  let observed = await observeAuditAssets(effects.reader, release.id, marker)

  if (["AUDIT_RETRYABLE", "AUDIT_VERIFIED"].includes(marker.phase)) {
    assertRecordedResult(marker, receipt, audit, attemptName, digest)
    assertExactAuditAsset(observed, attemptName, bytes)
    await verifyAnnotatedCandidateTag(effects.reader, identity)
    return transitionResult(release, marker, "unchanged")
  }
  if (marker.phase !== "AUDIT_DISPATCHED" || !sameDispatch(marker.audit, receipt)) {
    throw new Error("Audit attempt requires its exact AUDIT_DISPATCHED marker")
  }

  const existing = observed.byName.get(attemptName)
  if (existing === undefined) {
    await effects.writer.uploadAssetIfAbsentAndEqual({
      releaseId: release.id,
      tag: marker.tag,
      targetSha: identity.commitSha,
      name: attemptName,
      bytes,
      sha256: digest,
    })
  } else {
    assertExactAuditAsset(observed, attemptName, bytes)
  }
  release = await readManagedRelease(effects.reader, release.id)
  marker = parseReleaseMarker(release.body)
  observed = await observeAuditAssets(effects.reader, release.id, marker)
  assertExactAuditAsset(observed, attemptName, bytes)

  if (audit.conclusion === "success") {
    await verifyAnnotatedCandidateTag(effects.reader, identity)
    return transitionResult(release, marker, existing === undefined ? "attached" : "unchanged")
  }

  const next = {
    ...marker,
    revision: marker.revision + 1,
    phase: "AUDIT_RETRYABLE",
    audit: {
      ...marker.audit,
      runAttempt: audit.runAttempt,
      attemptAssetName: attemptName,
      attemptSha256: digest,
      canonicalSha256: null,
      conclusion: "failure",
    },
  }
  const body = canonicalReleaseBody({ marker: next, manifest: null, previousMarker: marker })
  await effects.writer.updateDraftReleaseIfCurrent({
    releaseId: release.id,
    tag: marker.tag,
    targetSha: identity.commitSha,
    expectedBodySha256: releaseBodySha256(release.body),
    title: `Dawn v${identity.version}`,
    body,
  })
  release = await readManagedRelease(effects.reader, release.id)
  marker = parseReleaseMarker(release.body)
  assertRecordedResult(marker, receipt, audit, attemptName, digest)
  await observeAuditAssets(effects.reader, release.id, marker)
  await verifyAnnotatedCandidateTag(effects.reader, identity)
  return transitionResult(release, marker, "updated")
}

export async function verifyAuditSuccess({ candidate, dispatch, result, github }) {
  const identity = validateCandidate(snapshotJson(candidate))
  const receipt = validateDispatch(dispatch)
  const audit = parseAuditResult(result)
  if (audit.conclusion !== "success") {
    throw new Error("Canonical audit verification requires a successful audit result")
  }
  const bytes = canonicalAuditResultBytes(audit)
  const digest = sha256(bytes)
  const attemptName = `audit-attempt-${audit.workflowRunId}-${audit.runAttempt}.json`
  const effects = releaseEffects(github)

  await verifyAnnotatedCandidateTag(effects.reader, identity)
  let release = await requireDraftRelease(effects.reader, identity)
  let marker = parseReleaseMarker(release.body)
  assertMarkerIdentity(marker, identity)
  correlateAuditResult({
    dispatch: receipt,
    result: audit,
    candidate: identity,
    manifestSha256: marker.manifestSha256,
  })
  let observed = await observeAuditAssets(effects.reader, release.id, marker)

  if (marker.phase === "AUDIT_VERIFIED") {
    assertRecordedResult(marker, receipt, audit, attemptName, digest)
    assertExactAuditAsset(observed, attemptName, bytes)
    assertExactAuditAsset(observed, "audit-result.json", bytes)
    await verifyAnnotatedCandidateTag(effects.reader, identity)
    return transitionResult(release, marker, "unchanged")
  }
  if (marker.phase !== "AUDIT_DISPATCHED" || !sameDispatch(marker.audit, receipt)) {
    throw new Error("Audit success verification requires its exact AUDIT_DISPATCHED marker")
  }
  assertExactAuditAsset(observed, attemptName, bytes, { requiredBeforeCanonical: true })

  if (observed.byName.get("audit-result.json") === undefined) {
    await effects.writer.uploadAssetIfAbsentAndEqual({
      releaseId: release.id,
      tag: marker.tag,
      targetSha: identity.commitSha,
      name: "audit-result.json",
      bytes,
      sha256: digest,
    })
  } else {
    assertExactAuditAsset(observed, "audit-result.json", bytes)
  }
  release = await readManagedRelease(effects.reader, release.id)
  marker = parseReleaseMarker(release.body)
  observed = await observeAuditAssets(effects.reader, release.id, marker)
  assertExactAuditAsset(observed, attemptName, bytes)
  assertExactAuditAsset(observed, "audit-result.json", bytes)

  const next = {
    ...marker,
    revision: marker.revision + 1,
    phase: "AUDIT_VERIFIED",
    audit: {
      ...marker.audit,
      runAttempt: audit.runAttempt,
      attemptAssetName: attemptName,
      attemptSha256: digest,
      canonicalSha256: digest,
      conclusion: "success",
    },
  }
  const body = canonicalReleaseBody({ marker: next, manifest: null, previousMarker: marker })
  await effects.writer.updateDraftReleaseIfCurrent({
    releaseId: release.id,
    tag: marker.tag,
    targetSha: identity.commitSha,
    expectedBodySha256: releaseBodySha256(release.body),
    title: `Dawn v${identity.version}`,
    body,
  })
  release = await readManagedRelease(effects.reader, release.id)
  marker = parseReleaseMarker(release.body)
  assertRecordedResult(marker, receipt, audit, attemptName, digest)
  observed = await observeAuditAssets(effects.reader, release.id, marker)
  validatePublicationAuditAssets(observed.auditFiles, { marker })
  await verifyAnnotatedCandidateTag(effects.reader, identity)
  return transitionResult(release, marker, "updated")
}

async function readTerminalAudit({ actions, run, runId, candidate, deadline, clock }) {
  if (!isPositiveId(run.run_attempt)) throw new Error("Terminal audit run attempt is invalid")
  const expectedName = `audit-result-${runId}-${run.run_attempt}`
  const listed = await withinAuditDeadline(
    readValue(actions.listActionsRunArtifacts({ runId }), "actions-run-artifacts"),
    deadline,
    clock,
  )
  if (!Array.isArray(listed)) throw new Error("Audit result artifact list is malformed")
  const matches = listed.filter((artifact) => artifact?.name === expectedName)
  if (matches.length !== 1 || listed.length !== 1) {
    throw new Error("Terminal audit run must expose exactly one result artifact")
  }
  const listedArtifact = validateActionsArtifact(matches[0], {
    runId,
    runAttempt: run.run_attempt,
    name: expectedName,
    headBranch: `v${candidate.version}`,
    headSha: candidate.commitSha,
  })
  const exactArtifact = await withinAuditDeadline(
    readValue(actions.getActionsArtifact({ artifactId: listedArtifact.id }), "actions-artifact"),
    deadline,
    clock,
  )
  const artifact = validateActionsArtifact(exactArtifact, {
    runId,
    runAttempt: run.run_attempt,
    name: expectedName,
    headBranch: `v${candidate.version}`,
    headSha: candidate.commitSha,
  })
  if (artifact.id !== listedArtifact.id) {
    throw new Error("Audit result artifact identity changed on exact re-read")
  }
  const download = await withinAuditDeadline(
    readBinary(
      actions.downloadActionsArtifact({
        artifactId: artifact.id,
        maximumBytes: RELEASE_PAYLOAD_LIMITS.actionsArchiveBytes,
      }),
      "actions-artifact-download",
    ),
    deadline,
    clock,
  )
  assertAuditTimeRemaining(deadline, clock)
  const files = extractActionsArtifactZip(download, {
    maxOutputBytes: RELEASE_PAYLOAD_LIMITS.auditReceiptBytes,
  })
  assertAuditTimeRemaining(deadline, clock)
  if (files.length !== 1 || files[0].name !== "audit-result.json") {
    throw new Error("Audit result artifact must contain exactly audit-result.json")
  }
  const result = parseCanonicalAuditBytes(files[0].bytes)
  const conclusionMatches =
    (result.conclusion === "success" && run.conclusion === "success") ||
    (result.conclusion === "failure" && run.conclusion !== "success")
  if (
    result.workflowRunId !== runId ||
    result.runAttempt !== run.run_attempt ||
    !conclusionMatches
  ) {
    throw new Error("Audit result is not correlated to the terminal run attempt")
  }
  return deepFreeze({
    status: "terminal",
    workflowRunId: runId,
    runAttempt: run.run_attempt,
    conclusion: result.conclusion,
    result,
  })
}

function validateActionsRun(value, runId, candidate) {
  if (
    !isRecord(value) ||
    value.id !== runId ||
    !isPositiveId(value.run_attempt) ||
    !["requested", "waiting", "pending", "queued", "in_progress", "completed"].includes(
      value.status,
    ) ||
    value.event !== "workflow_dispatch" ||
    value.path !== WORKFLOW ||
    value.head_sha !== candidate.commitSha ||
    value.head_branch !== `v${candidate.version}`
  ) {
    throw new Error("Audit Actions run identity is malformed")
  }
  if (
    (value.status === "completed" &&
      ![
        "success",
        "failure",
        "neutral",
        "cancelled",
        "skipped",
        "timed_out",
        "action_required",
        "stale",
        "startup_failure",
      ].includes(value.conclusion)) ||
    (value.status !== "completed" && value.conclusion !== null)
  ) {
    throw new Error("Audit Actions run terminal state is malformed")
  }
}

function validateActionsArtifact(value, { runId, runAttempt, name, headBranch, headSha }) {
  if (
    !isRecord(value) ||
    !isPositiveId(value.id) ||
    value.name !== name ||
    value.expired !== false ||
    !isRecord(value.workflow_run) ||
    value.workflow_run.id !== runId ||
    value.workflow_run.head_branch !== headBranch ||
    value.workflow_run.head_sha !== headSha ||
    (value.workflow_run.run_attempt !== undefined && value.workflow_run.run_attempt !== runAttempt)
  ) {
    throw new Error("Audit result artifact is not correlated to its workflow run attempt")
  }
  return value
}

async function observeAuditAssets(reader, releaseId, marker) {
  const listed = await readValue(reader.listReleaseAssets({ releaseId }), "release-assets")
  const descriptors = preflightAuditDraftAssetMetadata(listed, { marker })
  const byName = new Map()
  const auditFiles = []
  const smokeFiles = []
  for (const descriptor of descriptors) {
    const bytes = await readBinary(
      reader.downloadReleaseAsset({
        assetId: descriptor.id,
        maximumBytes: descriptor.size,
      }),
      "release-asset-download",
    )
    if (bytes.byteLength !== descriptor.size) {
      throw new Error("Audit draft asset bytes conflict with their declared size")
    }
    const digest = sha256(bytes)
    if (descriptor.expectedSha256 !== null && digest !== descriptor.expectedSha256) {
      throw new Error("Audit draft base asset digest conflicts with its marker")
    }
    if (descriptor.group === "audit") {
      const result = parseCanonicalAuditBytes(bytes)
      if (
        result.version !== marker.version ||
        result.commitSha !== marker.commitSha ||
        result.manifestSha256 !== marker.manifestSha256
      ) {
        throw new Error("Audit receipt is not correlated to the draft candidate")
      }
      if (descriptor.name === "audit-result.json") {
        if (result.conclusion !== "success") {
          throw new Error("Canonical audit result is not successful")
        }
      } else {
        const match = ATTEMPT_NAME_PATTERN.exec(descriptor.name)
        if (
          match === null ||
          Number(match[1]) !== result.workflowRunId ||
          Number(match[2]) !== result.runAttempt
        ) {
          throw new Error("Audit attempt filename does not match its receipt identity")
        }
      }
      auditFiles.push({ name: descriptor.name, bytes })
    } else if (descriptor.group === "smoke") {
      const result = parseSmokeResult(bytes)
      const filenameIdentity = parseSmokeReleaseAssetName(descriptor.name)
      if (
        filenameIdentity === null ||
        result.lane !== filenameIdentity.lane ||
        result.workflowRunId !== filenameIdentity.workflowRunId ||
        result.runAttempt !== filenameIdentity.runAttempt ||
        result.version !== marker.version ||
        result.commitSha !== marker.commitSha ||
        result.manifestSha256 !== marker.manifestSha256 ||
        result.conclusion !== "success"
      ) {
        throw new Error("Durable smoke receipt is not correlated to its filename and candidate")
      }
      smokeFiles.push({ name: descriptor.name, bytes, result })
    }
    byName.set(descriptor.name, { ...descriptor, bytes, sha256: digest })
  }
  validateDurableSmokeReceipts({ marker, smokeFiles })
  validateAuditPhaseAssets({ marker, auditFiles })
  return { byName, auditFiles }
}

function validateDurableSmokeReceipts({ marker, smokeFiles }) {
  if (smokeFiles.length !== marker.smoke.receiptAssets.length) {
    throw new Error("Durable smoke receipt set is incomplete")
  }
  const selected = smokeFiles.filter(
    ({ result }) =>
      result.workflowRunId === marker.smoke.workflowRunId &&
      result.runAttempt === marker.smoke.runAttempt,
  )
  if (selected.length !== marker.smoke.requiredLanes.length) {
    throw new Error("Durable smoke receipt set does not contain one exact selected lane set")
  }
  let aggregate
  try {
    aggregate = aggregateSmokeResults(
      selected.map(({ bytes }) => bytes),
      {
        version: marker.version,
        commitSha: marker.commitSha,
        manifestSha256: marker.manifestSha256,
        workflowRunId: marker.smoke.workflowRunId,
        runAttempt: marker.smoke.runAttempt,
      },
    )
  } catch (error) {
    throw new Error("Durable smoke receipts do not form the exact selected lane aggregate", {
      cause: error,
    })
  }
  if (sha256(canonicalAggregateSmokeResultBytes(aggregate)) !== marker.smoke.aggregateSha256) {
    throw new Error("Durable smoke receipt aggregate digest conflicts with the Release marker")
  }
}

function validateAuditPhaseAssets({ marker, auditFiles }) {
  if (marker.phase === "AUDIT_VERIFIED") {
    validatePublicationAuditAssets(auditFiles, { marker })
    return
  }
  const canonical = auditFiles.find(({ name }) => name === "audit-result.json")
  const attempts = auditFiles.filter(({ name }) => name !== "audit-result.json")
  const results = attempts.map((file) => ({ file, result: parseCanonicalAuditBytes(file.bytes) }))
  if (marker.phase === "SMOKES_COMPLETE") {
    if (auditFiles.length !== 0) throw new Error("Smoke-complete draft contains audit evidence")
    return
  }
  if (marker.phase === "AUDIT_RETRYABLE") {
    if (canonical !== undefined) throw new Error("Retryable audit cannot have a canonical result")
    const current = results.find(({ file }) => file.name === marker.audit.attemptAssetName)
    if (
      current === undefined ||
      current.result.conclusion !== "failure" ||
      sha256(current.file.bytes) !== marker.audit.attemptSha256
    ) {
      throw new Error("Retryable audit attempt evidence conflicts with its marker")
    }
  }
  let currentCount = 0
  for (const entry of results) {
    if (entry.result.workflowRunId === marker.audit.workflowRunId) currentCount += 1
    else if (entry.result.conclusion !== "failure") {
      throw new Error("Historical audit attempt is not a genuine failure")
    }
  }
  if (currentCount > 1) throw new Error("Current audit dispatch has duplicate attempt evidence")
  if (canonical !== undefined) {
    const canonicalResult = parseCanonicalAuditBytes(canonical.bytes)
    const current = results.find(
      ({ result }) =>
        result.workflowRunId === canonicalResult.workflowRunId &&
        result.runAttempt === canonicalResult.runAttempt,
    )
    if (
      marker.phase !== "AUDIT_DISPATCHED" ||
      canonicalResult.workflowRunId !== marker.audit.workflowRunId ||
      current === undefined ||
      !current.file.bytes.equals(canonical.bytes)
    ) {
      throw new Error("Premarker canonical audit result is not byte-identical to its attempt")
    }
  }
}

function assertExactAuditAsset(observed, name, bytes, { requiredBeforeCanonical = false } = {}) {
  const asset = observed.byName.get(name)
  if (asset === undefined) {
    throw new Error(
      requiredBeforeCanonical
        ? "Successful audit attempt must already be attached before canonicalization"
        : `Required audit receipt ${name} is missing`,
    )
  }
  if (!asset.bytes.equals(bytes) || asset.sha256 !== sha256(bytes)) {
    throw new Error(`Audit receipt ${name} conflicts with canonical bytes`)
  }
}

function assertRecordedResult(marker, dispatch, result, attemptName, digest) {
  const expectedPhase = result.conclusion === "success" ? "AUDIT_VERIFIED" : "AUDIT_RETRYABLE"
  if (
    marker.phase !== expectedPhase ||
    !sameDispatch(marker.audit, dispatch) ||
    marker.audit.runAttempt !== result.runAttempt ||
    marker.audit.attemptAssetName !== attemptName ||
    marker.audit.attemptSha256 !== digest ||
    marker.audit.conclusion !== result.conclusion ||
    (result.conclusion === "success"
      ? marker.audit.canonicalSha256 !== digest
      : marker.audit.canonicalSha256 !== null)
  ) {
    throw new Error("Recorded audit result conflicts with the exact receipt")
  }
}

function releaseEffects(value) {
  if (!isPlainObject(value)) throw new TypeError("Audit Release effects are invalid")
  const reader = dataField(value, "reader", "Audit Release reader")
  const writer = dataField(value, "writer", "Audit Release writer")
  return Object.freeze({
    reader: bindMethods(
      reader,
      [
        "getRef",
        "getGitTag",
        "listReleases",
        "getRelease",
        "listReleaseAssets",
        "downloadReleaseAsset",
      ],
      "Audit Release reader",
    ),
    writer: bindMethods(
      writer,
      ["updateDraftReleaseIfCurrent", "uploadAssetIfAbsentAndEqual"],
      "Audit Release writer",
    ),
  })
}

async function verifyAnnotatedCandidateTag(reader, candidate) {
  const tag = `v${candidate.version}`
  const ref = await readValue(reader.getRef({ ref: `tags/${tag}` }), "ref")
  if (
    !isRecord(ref.object) ||
    ref.object.type !== "tag" ||
    typeof ref.object.sha !== "string" ||
    !SHA_PATTERN.test(ref.object.sha)
  ) {
    throw new Error("Audit candidate must retain one annotated tag")
  }
  const annotated = await readValue(reader.getGitTag({ tagSha: ref.object.sha }), "git-tag")
  if (
    annotated.tag !== tag ||
    !isRecord(annotated.object) ||
    annotated.object.type !== "commit" ||
    annotated.object.sha !== candidate.commitSha
  ) {
    throw new Error("Audit candidate tag no longer peels to the exact commit")
  }
}

async function requireDraftRelease(reader, candidate) {
  const releases = await readValue(reader.listReleases({}), "releases")
  if (!Array.isArray(releases)) throw new Error("Managed Release list is malformed")
  const matches = releases.filter((release) => release?.tag_name === `v${candidate.version}`)
  if (matches.length !== 1) throw new Error("Managed audit draft is missing or ambiguous")
  const release = await readManagedRelease(reader, positiveId(matches[0].id, "Release ID"))
  if (
    release.tag_name !== `v${candidate.version}` ||
    release.name !== `Dawn v${candidate.version}` ||
    typeof release.body !== "string" ||
    release.draft !== true ||
    release.immutable !== false
  ) {
    throw new Error("Managed audit Release is not the exact mutable candidate draft")
  }
  return release
}

async function readManagedRelease(reader, releaseId) {
  const release = await readValue(reader.getRelease({ releaseId }), "release")
  if (!isRecord(release) || release.id !== releaseId) {
    throw new Error("Managed audit Release response is malformed")
  }
  return release
}

async function readValue(promise, operation) {
  const envelope = snapshotJson(await promise)
  if (
    !hasExactFields(envelope, ["status", "operation", "httpStatus", "code", "value"]) ||
    envelope.status !== "PRESENT" ||
    envelope.operation !== operation ||
    !Number.isInteger(envelope.httpStatus) ||
    envelope.httpStatus < 200 ||
    envelope.httpStatus >= 300 ||
    envelope.code !== null
  ) {
    throw new Error(`GitHub ${operation} observation is not exact`)
  }
  return envelope.value
}

async function readBinary(promise, operation) {
  const envelope = snapshotJson(await promise)
  if (
    !hasExactFields(envelope, ["status", "operation", "httpStatus", "code", "contentBase64"]) ||
    envelope.status !== "PRESENT" ||
    envelope.operation !== operation ||
    envelope.httpStatus !== 200 ||
    envelope.code !== null ||
    typeof envelope.contentBase64 !== "string"
  ) {
    throw new Error(`GitHub ${operation} bytes are not exact`)
  }
  const bytes = Buffer.from(envelope.contentBase64, "base64")
  if (bytes.toString("base64") !== envelope.contentBase64) {
    throw new Error(`GitHub ${operation} bytes are not canonical base64`)
  }
  return bytes
}

function parseCanonicalAuditBytes(bytes) {
  let value
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw new TypeError("Audit result JSON is malformed", { cause: error })
  }
  const result = parseAuditResult(value)
  if (!Buffer.from(bytes).equals(canonicalAuditResultBytes(result))) {
    throw new TypeError("Audit result bytes are not canonical")
  }
  return result
}

function validateDispatch(value) {
  const receipt = snapshotJson(value)
  if (!hasExactFields(receipt, DISPATCH_FIELDS) || receipt.workflow !== WORKFLOW) {
    throw new TypeError("Audit dispatch identity is malformed")
  }
  const id = positiveId(receipt.workflowRunId, "Audit dispatch workflow run ID")
  if (
    receipt.runUrl !== `https://api.github.com/repos/${REPOSITORY}/actions/runs/${id}` ||
    receipt.htmlUrl !== `https://github.com/${REPOSITORY}/actions/runs/${id}`
  ) {
    throw new TypeError("Audit dispatch receipt URLs do not match the trusted repository")
  }
  return deepFreeze(receipt)
}

function dispatchMarker(dispatch) {
  return {
    workflow: dispatch.workflow,
    workflowRunId: dispatch.workflowRunId,
    runUrl: dispatch.runUrl,
    htmlUrl: dispatch.htmlUrl,
    runAttempt: null,
    attemptAssetName: null,
    attemptSha256: null,
    canonicalSha256: null,
    conclusion: null,
  }
}

function sameDispatch(marker, dispatch) {
  return ["workflow", "workflowRunId", "runUrl", "htmlUrl"].every(
    (field) => marker?.[field] === dispatch[field],
  )
}

function assertMarkerIdentity(marker, candidate) {
  if (
    marker.version !== candidate.version ||
    marker.commitSha !== candidate.commitSha ||
    marker.tag !== `v${candidate.version}` ||
    marker.attestationSet?.repository !== REPOSITORY ||
    !SHA256_PATTERN.test(marker.manifestSha256)
  ) {
    throw new Error("Audit draft marker conflicts with the exact candidate")
  }
}

function validateCandidate(value) {
  if (
    !hasExactFields(value, CANDIDATE_FIELDS) ||
    typeof value.version !== "string" ||
    !isExactSemver(value.version) ||
    parseSemver(value.version).build.length !== 0 ||
    !SHA_PATTERN.test(value.commitSha) ||
    value.ciWorkflow !== "CI" ||
    value.ciCheck !== "validate" ||
    value.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new TypeError("Audit candidate identity is invalid")
  }
  return deepFreeze(value)
}

function transitionResult(release, marker, status) {
  return deepFreeze({
    releaseId: positiveId(release.id, "Release ID"),
    phase: marker.phase,
    status,
    bodySha256: releaseBodySha256(release.body),
  })
}

function bindMethods(value, methods, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  const result = Object.create(null)
  for (const method of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(value, method)
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      throw new TypeError(`${label} method ${method} is invalid`)
    }
    result[method] = descriptor.value.bind(value)
  }
  return Object.freeze(result)
}

function dataField(value, field, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, field)
  if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
    throw new TypeError(`${label} is invalid`)
  }
  return descriptor.value
}

function hasExactFields(value, fields) {
  return (
    isRecord(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  )
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isPlainObject(value) {
  return isRecord(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function positiveId(value, label) {
  if (!isPositiveId(value)) throw new TypeError(`${label} is invalid`)
  return value
}

function isPositiveId(value) {
  return Number.isSafeInteger(value) && value > 0
}

function assertPositiveId(value, label) {
  positiveId(value, label)
}

function assertInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid`)
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
}

function monotonicAuditClock(now) {
  if (typeof now !== "function") throw new TypeError("Audit poll clock is invalid")
  let previous = null
  return () => {
    const value = now()
    if (!Number.isSafeInteger(value) || value < 0 || (previous !== null && value < previous)) {
      throw new TypeError("Audit poll clock is invalid")
    }
    previous = value
    return value
  }
}

function auditTimeRemaining(deadline, clock) {
  return Math.max(0, deadline - clock())
}

function assertAuditTimeRemaining(deadline, clock) {
  if (auditTimeRemaining(deadline, clock) <= 0) throw new AuditWaitDeadlineError()
}

function withinAuditDeadline(promise, deadline, clock) {
  const remaining = auditTimeRemaining(deadline, clock)
  if (remaining <= 0) return Promise.reject(new AuditWaitDeadlineError())
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new AuditWaitDeadlineError()), remaining)
    }),
  ]).finally(() => clearTimeout(timer))
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
