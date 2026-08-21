import { createHash } from "node:crypto"
import { TextDecoder } from "node:util"

import { validateAuditExpectation, validateAuditReceipt } from "./audit-evidence-schema.mjs"
import {
  isEvidenceSha,
  isEvidenceTimestamp,
  validateDependabotExpectation,
  validateNormalizedDependabotAlert,
} from "./dependabot-evidence-schema.mjs"
import { canonicalJsonBytes, EvidenceError } from "./github-evidence.mjs"
import { verifyPublicationSnapshot } from "./publication-containment.mjs"

export { validateAuditReceipt }

function fail(code) {
  throw new EvidenceError(code)
}

export function validateReconciliationFileInputs({
  auditExpectationFixtureBytes,
  auditReceiptBytes,
  baselineReceiptBytes,
  dependabotIdentitiesFixtureBytes,
  expectedReviewedBaseSha,
}) {
  const auditExpectation = validateAuditExpectation(
    parseEvidenceJsonBytes(auditExpectationFixtureBytes),
  )
  const audit = validateAuditReceipt(parseEvidenceJsonBytes(auditReceiptBytes))
  if (!canonicalJsonBytes(audit).equals(auditReceiptBytes)) fail("INVALID_AUDIT_RECEIPT")
  for (const mode of ["full", "production"]) {
    if (
      JSON.stringify(audit[mode].records) !== JSON.stringify(auditExpectation[mode].records) ||
      audit[mode].muted.length !== 0
    ) {
      fail("AUDIT_EXPECTATION_MISMATCH")
    }
  }
  const dependabotIdentities = validateDependabotExpectation(
    parseEvidenceJsonBytes(dependabotIdentitiesFixtureBytes),
  )
  if (dependabotIdentities.defaultSha !== expectedReviewedBaseSha) {
    fail("DEPENDABOT_BASELINE_PROVENANCE_MISMATCH")
  }
  const baselineReceipt = validateBaselineReceiptForReconciliation(
    parseEvidenceJsonBytes(baselineReceiptBytes),
    { dependabotIdentities, expectedReviewedBaseSha },
  )
  if (!canonicalJsonBytes(baselineReceipt).equals(baselineReceiptBytes)) {
    fail("INVALID_BASELINE_RECEIPT")
  }
  const digests = {
    auditExpectationFixtureSha256: sha256(auditExpectationFixtureBytes),
    auditReceiptSha256: sha256(auditReceiptBytes),
    baselineReceiptSha256: sha256(baselineReceiptBytes),
    dependabotIdentitiesFixtureSha256: sha256(dependabotIdentitiesFixtureBytes),
  }
  if (digests.auditReceiptSha256 !== digest(audit)) fail("AUDIT_RECEIPT_DIGEST_MISMATCH")
  return { audit, baselineReceipt, dependabotIdentities, digests }
}

export function createReconciliationReceipt({
  completedAtMilliseconds,
  fileInputs,
  fixed,
  mergedAt,
  observationHead,
  openA,
  openB,
  prNumber,
  publicationAfter,
  publicationBefore,
  repository,
  reviewedBaseSha,
  reviewedHeadSha,
  mergeSha,
  startedAtMilliseconds,
  verificationRuns,
}) {
  const receipt = {
    audit: {
      digest: fileInputs.digests.auditReceiptSha256,
      evidence: fileInputs.audit,
    },
    dependabot: { fixed, open: openA },
    digests: {
      inputs: fileInputs.digests,
      outputs: {
        fixedAlertsSha256: digest(fixed),
        openSnapshotASha256: digest(openA),
        openSnapshotBSha256: digest(openB),
        publicationAfterSha256: digest(publicationAfter),
        publicationBeforeSha256: digest(publicationBefore),
      },
    },
    kind: "dependency-security-reconciliation",
    observation: {
      completedAt: formatTimestampMilliseconds(completedAtMilliseconds),
      startedAt: formatTimestampMilliseconds(startedAtMilliseconds),
    },
    observationHead,
    pr: {
      mergeParentShas: [reviewedBaseSha, reviewedHeadSha],
      mergeSha,
      mergedAt,
      number: prNumber,
      reviewedBaseSha,
      reviewedHeadSha,
    },
    publication: publicationAfter,
    repository,
    schemaVersion: 1,
    verificationRuns,
  }
  if (canonicalJsonBytes(receipt).byteLength > 32 * 1024) {
    fail("INVALID_RECONCILIATION_RECEIPT")
  }
  return validateReconciliationReceipt(receipt)
}

function parseEvidenceJsonBytes(value) {
  if (!Buffer.isBuffer(value) || value.byteLength === 0 || value.byteLength > 1024 * 1024) {
    fail("INVALID_RECONCILIATION_INPUT")
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value))
  } catch {
    fail("INVALID_RECONCILIATION_INPUT")
  }
}

function validateBaselineReceiptForReconciliation(
  value,
  { dependabotIdentities, expectedReviewedBaseSha },
) {
  const receipt = safeClone(value)
  assertExactKeys(receipt, [
    "capturedAt",
    "dependabot",
    "kind",
    "publication",
    "repository",
    "schemaVersion",
    "sourceSha",
  ])
  if (
    receipt.kind !== "dependency-security-baseline" ||
    receipt.repository !== "cacheplane/dawnai" ||
    receipt.schemaVersion !== 1 ||
    !isEvidenceTimestamp(receipt.capturedAt) ||
    !isEvidenceSha(receipt.sourceSha)
  ) {
    fail("INVALID_BASELINE_RECEIPT")
  }
  assertExactKeys(receipt.dependabot, ["defaultSha", "open"])
  if (
    receipt.dependabot.defaultSha !== expectedReviewedBaseSha ||
    JSON.stringify(receipt.dependabot.open) !== JSON.stringify(dependabotIdentities.open)
  ) {
    fail("INVALID_BASELINE_RECEIPT")
  }
  const publication = verifyPublicationSnapshot(receipt.publication, {
    expectedDefaultSha: expectedReviewedBaseSha,
  })
  if (publication.sourceSha !== receipt.sourceSha) fail("INVALID_BASELINE_RECEIPT")
  return {
    capturedAt: receipt.capturedAt,
    dependabot: {
      defaultSha: expectedReviewedBaseSha,
      open: dependabotIdentities.open,
    },
    kind: "dependency-security-baseline",
    publication,
    repository: "cacheplane/dawnai",
    schemaVersion: 1,
    sourceSha: receipt.sourceSha,
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function digest(value) {
  return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex")
}

function formatTimestampMilliseconds(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    fail("INVALID_RECONCILIATION_RECEIPT")
  }
  try {
    return new Date(value).toISOString().replace(/\.[0-9]{3}Z$/u, "Z")
  } catch {
    fail("INVALID_RECONCILIATION_RECEIPT")
  }
}

export function validateReconciliationReceipt(value) {
  try {
    return validateReconciliationReceiptValue(value)
  } catch {
    fail("INVALID_RECONCILIATION_RECEIPT")
  }
}

function validateReconciliationReceiptValue(value) {
  const receipt = safeClone(value)
  assertExactKeys(receipt, [
    "audit",
    "dependabot",
    "digests",
    "kind",
    "observation",
    "observationHead",
    "pr",
    "publication",
    "repository",
    "schemaVersion",
    "verificationRuns",
  ])
  if (
    receipt.kind !== "dependency-security-reconciliation" ||
    receipt.repository !== "cacheplane/dawnai" ||
    receipt.schemaVersion !== 1 ||
    !isEvidenceSha(receipt.observationHead)
  ) {
    fail("INVALID_RECONCILIATION_RECEIPT")
  }
  assertExactKeys(receipt.observation, ["completedAt", "startedAt"])
  if (
    !isEvidenceTimestamp(receipt.observation.startedAt) ||
    !isEvidenceTimestamp(receipt.observation.completedAt)
  ) {
    fail("INVALID_RECONCILIATION_RECEIPT")
  }
  assertExactKeys(receipt.pr, [
    "mergeParentShas",
    "mergeSha",
    "mergedAt",
    "number",
    "reviewedBaseSha",
    "reviewedHeadSha",
  ])
  if (
    !isEvidenceSha(receipt.pr.mergeSha) ||
    !isEvidenceSha(receipt.pr.reviewedBaseSha) ||
    !isEvidenceSha(receipt.pr.reviewedHeadSha) ||
    !Array.isArray(receipt.pr.mergeParentShas) ||
    receipt.pr.mergeParentShas.length !== 2 ||
    receipt.pr.mergeParentShas[0] !== receipt.pr.reviewedBaseSha ||
    receipt.pr.mergeParentShas[1] !== receipt.pr.reviewedHeadSha ||
    !Number.isSafeInteger(receipt.pr.number) ||
    receipt.pr.number < 1 ||
    !isEvidenceTimestamp(receipt.pr.mergedAt) ||
    Date.parse(receipt.observation.startedAt) < Date.parse(receipt.pr.mergedAt) ||
    Date.parse(receipt.observation.completedAt) < Date.parse(receipt.observation.startedAt)
  ) {
    fail("INVALID_RECONCILIATION_RECEIPT")
  }
  assertExactKeys(receipt.audit, ["digest", "evidence"])
  const audit = validateAuditReceipt(receipt.audit.evidence)
  if (!isDigest(receipt.audit.digest) || receipt.audit.digest !== digest(audit)) {
    fail("INVALID_RECONCILIATION_RECEIPT")
  }
  assertExactKeys(receipt.digests, ["inputs", "outputs"])
  assertExactKeys(receipt.digests.inputs, [
    "auditExpectationFixtureSha256",
    "auditReceiptSha256",
    "baselineReceiptSha256",
    "dependabotIdentitiesFixtureSha256",
  ])
  assertExactKeys(receipt.digests.outputs, [
    "fixedAlertsSha256",
    "openSnapshotASha256",
    "openSnapshotBSha256",
    "publicationAfterSha256",
    "publicationBeforeSha256",
  ])
  if (
    !Object.values(receipt.digests.inputs).every(isDigest) ||
    !Object.values(receipt.digests.outputs).every(isDigest) ||
    receipt.digests.inputs.auditReceiptSha256 !== receipt.audit.digest
  ) {
    fail("INVALID_RECONCILIATION_RECEIPT")
  }
  assertExactKeys(receipt.dependabot, ["fixed", "open"])
  const fixed = validateReceiptAlerts(receipt.dependabot.fixed, "fixed", receipt.pr.mergedAt)
  const open = validateReceiptAlerts(receipt.dependabot.open, "open", receipt.pr.mergedAt)
  const numbers = [...fixed, ...open].map((alert) => alert.number)
  if (new Set(numbers).size !== numbers.length) fail("INVALID_RECONCILIATION_RECEIPT")
  const publication = verifyPublicationSnapshot(receipt.publication, {
    expectedDefaultSha: receipt.observationHead,
  })
  if (publication.sourceSha !== receipt.observationHead) {
    fail("INVALID_RECONCILIATION_RECEIPT")
  }
  const expectedOutputDigests = {
    fixedAlertsSha256: digest(fixed),
    openSnapshotASha256: digest(open),
    openSnapshotBSha256: digest(open),
    publicationAfterSha256: digest(publication),
    publicationBeforeSha256: digest(publication),
  }
  if (JSON.stringify(receipt.digests.outputs) !== JSON.stringify(expectedOutputDigests)) {
    fail("INVALID_RECONCILIATION_RECEIPT")
  }
  const verificationRuns = validateVerificationRunReceipt(
    receipt.verificationRuns,
    receipt.pr.mergeSha,
    receipt.observationHead,
  )
  return {
    audit: { digest: receipt.audit.digest, evidence: audit },
    dependabot: { fixed, open },
    digests: receipt.digests,
    kind: "dependency-security-reconciliation",
    observation: receipt.observation,
    observationHead: receipt.observationHead,
    pr: receipt.pr,
    publication,
    repository: "cacheplane/dawnai",
    schemaVersion: 1,
    verificationRuns,
  }
}

function validateVerificationRunReceipt(value, mergeSha, observationHead) {
  if (!Array.isArray(value)) fail("INVALID_RECONCILIATION_RECEIPT")
  const workflowPaths = [
    ".github/workflows/ci.yml",
    ".github/workflows/codeql.yml",
    ".github/workflows/scorecard.yml",
  ]
  const heads = [...new Set([mergeSha, observationHead])].sort(compareText)
  const expectedTuples = heads.flatMap((headSha) =>
    workflowPaths.map((workflowPath) => `${headSha}\0${workflowPath}`),
  )
  const runIds = new Set()
  const runs = value.map((run) => {
    assertExactKeys(run, [
      "conclusion",
      "event",
      "headBranch",
      "headSha",
      "runAttempt",
      "runId",
      "status",
      "workflowPath",
    ])
    if (
      run.conclusion !== "success" ||
      run.event !== "push" ||
      run.headBranch !== "main" ||
      !isEvidenceSha(run.headSha) ||
      !Number.isSafeInteger(run.runAttempt) ||
      run.runAttempt < 1 ||
      !Number.isSafeInteger(run.runId) ||
      run.runId < 1 ||
      runIds.has(run.runId) ||
      run.status !== "completed" ||
      !workflowPaths.includes(run.workflowPath)
    ) {
      fail("INVALID_RECONCILIATION_RECEIPT")
    }
    runIds.add(run.runId)
    return run
  })
  if (
    JSON.stringify(runs.map((run) => `${run.headSha}\0${run.workflowPath}`)) !==
    JSON.stringify(expectedTuples)
  ) {
    fail("INVALID_RECONCILIATION_RECEIPT")
  }
  return runs
}

function validateReceiptAlerts(value, expectedState, mergedAt) {
  if (!Array.isArray(value) || value.length === 0) fail("INVALID_RECONCILIATION_RECEIPT")
  const alerts = value.map(validateNormalizedDependabotAlert)
  const numbers = alerts.map((alert) => alert.number)
  if (
    new Set(numbers).size !== numbers.length ||
    numbers.some((number, index) => index > 0 && number <= numbers[index - 1]) ||
    alerts.some(
      (alert) =>
        alert.state !== expectedState ||
        alert.dismissal !== null ||
        alert.autoDismissedAt !== null ||
        (expectedState === "open" && alert.fixedAt !== null) ||
        (expectedState === "fixed" &&
          (alert.fixedAt === null || Date.parse(alert.fixedAt) < Date.parse(mergedAt))),
    )
  ) {
    fail("INVALID_RECONCILIATION_RECEIPT")
  }
  return alerts
}

function isDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value)
}

function safeClone(value) {
  try {
    return JSON.parse(canonicalJsonBytes(value).toString("utf8"))
  } catch {
    fail("INVALID_DEPENDABOT_VALUE")
  }
}

function assertExactKeys(value, expected) {
  if (!isRecord(value)) fail("INVALID_DEPENDABOT_FIXTURE")
  const actual = Object.keys(value).sort(compareText)
  const wanted = [...expected].sort(compareText)
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail("INVALID_DEPENDABOT_FIXTURE")
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
