import { readBoundedFixture } from "../release/fixture-io.mjs"
import {
  isEvidenceSha,
  isEvidenceTimestamp,
  normalizeDependabotAlert,
  validateDependabotExpectation,
} from "./dependabot-evidence-schema.mjs"
import { EvidenceError } from "./github-evidence.mjs"
import { verifyPublicationSnapshot } from "./publication-containment.mjs"
import {
  createReconciliationReceipt,
  validateReconciliationFileInputs,
} from "./reconciliation-receipt.mjs"

export {
  validateAuditReceipt,
  validateReconciliationReceipt,
} from "./reconciliation-receipt.mjs"
export {
  sealReconciliationReceipt,
  validateTrustedAncestorPolicy,
} from "./reconciliation-seal.mjs"
export { normalizeDependabotAlert, validateDependabotExpectation }

function fail(code) {
  throw new EvidenceError(code)
}

export async function loadDependabotExpectation(file, { root = process.cwd() } = {}) {
  let source
  try {
    source = await readBoundedFixture(file, { maxBytes: 1024 * 1024, root })
  } catch {
    fail("INVALID_DEPENDABOT_FIXTURE")
  }
  if (source.includes("\uFFFD")) fail("INVALID_DEPENDABOT_ENCODING")
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    fail("MALFORMED_DEPENDABOT_FIXTURE")
  }
  return validateDependabotExpectation(parsed)
}

export async function readDependabotOpen({ expectedDefaultSha, expectedNumbers, fixture, github }) {
  const expectedFixture = validateDependabotExpectation(fixture)
  if (!isEvidenceSha(expectedDefaultSha) || expectedFixture.defaultSha !== expectedDefaultSha) {
    fail("DEPENDABOT_BASELINE_PROVENANCE_MISMATCH")
  }
  const numbers = validateNumberSet(expectedNumbers)
  if (
    JSON.stringify(numbers) !== JSON.stringify(expectedFixture.open.map((alert) => alert.number))
  ) {
    fail("DEPENDABOT_EXPECTED_SET_MISMATCH")
  }
  if (github === null || typeof github !== "object" || typeof github.list !== "function") {
    fail("INVALID_DEPENDABOT_READER")
  }
  const rawAlerts = await github.list("dependabot/alerts?state=open&per_page=100", {
    cursorOnly: true,
    pageLimit: 10,
    uniqueKey: "number",
  })
  const alerts = rawAlerts
    .map(normalizeDependabotAlert)
    .sort((left, right) => left.number - right.number)
  const actualNumbers = alerts.map((alert) => alert.number)
  if (JSON.stringify(actualNumbers) !== JSON.stringify(numbers)) {
    fail("DEPENDABOT_OPEN_SET_MISMATCH")
  }
  if (JSON.stringify(alerts) !== JSON.stringify(expectedFixture.open)) {
    fail("DEPENDABOT_IDENTITY_MISMATCH")
  }
  return alerts
}

export async function reconcileDependabot({
  auditExpectationFixtureBytes,
  auditReceiptBytes,
  baselineReceiptBytes,
  collectPublication,
  dependabotIdentitiesFixtureBytes,
  expectedFixedNumbers,
  expectedMergeSha,
  expectedObservationHeadSha,
  expectedOpenNumbers,
  expectedReviewedBaseSha,
  expectedReviewedHeadSha,
  github,
  intervalMs = 15_000,
  maxAttempts = 61,
  now = Date.now,
  prNumber,
  repo,
  sleep = sleepForReconciliation,
  timeoutMs = 15 * 60_000,
}) {
  if (
    repo !== "cacheplane/dawnai" ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    !isEvidenceSha(expectedReviewedBaseSha) ||
    !isEvidenceSha(expectedReviewedHeadSha) ||
    !isEvidenceSha(expectedMergeSha) ||
    !isEvidenceSha(expectedObservationHeadSha) ||
    typeof now !== "function" ||
    typeof sleep !== "function" ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > 60_000 ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 61 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30 * 60_000 ||
    github === null ||
    typeof github !== "object" ||
    typeof github.object !== "function" ||
    typeof github.list !== "function" ||
    [
      auditExpectationFixtureBytes,
      auditReceiptBytes,
      baselineReceiptBytes,
      dependabotIdentitiesFixtureBytes,
    ].some((value) => value === undefined) ||
    typeof collectPublication !== "function"
  ) {
    fail("INVALID_RECONCILIATION_REQUEST")
  }
  const fileInputs = validateReconciliationFileInputs({
    auditExpectationFixtureBytes,
    auditReceiptBytes,
    baselineReceiptBytes,
    dependabotIdentitiesFixtureBytes,
    expectedReviewedBaseSha,
  })
  const baseline = fileInputs.dependabotIdentities
  if (baseline.defaultSha !== expectedReviewedBaseSha) {
    fail("DEPENDABOT_BASELINE_PROVENANCE_MISMATCH")
  }
  const fixedNumbers = validateNumberSet(expectedFixedNumbers)
  const openNumbers = validateNumberSet(expectedOpenNumbers)
  if (
    new Set([...fixedNumbers, ...openNumbers]).size !==
    fixedNumbers.length + openNumbers.length
  ) {
    fail("OVERLAPPING_DEPENDABOT_EXPECTATIONS")
  }
  const combined = [...fixedNumbers, ...openNumbers].sort((left, right) => left - right)
  if (JSON.stringify(combined) !== JSON.stringify(baseline.open.map((alert) => alert.number))) {
    fail("DEPENDABOT_BASELINE_SET_MISMATCH")
  }
  const clock = createReconciliationClock(now, timeoutMs)
  const started = clock.started
  const deadline = clock.deadline
  clock.assertBeforeDeadline()
  const publicationBefore = verifyPublicationSnapshot(
    await collectPublication({ phase: "before" }),
    {
      expectedDefaultSha: expectedObservationHeadSha,
    },
  )
  clock.assertBeforeDeadline()

  const pull = await github.object(`pulls/${prNumber}`)
  clock.assertBeforeDeadline()
  const mergedAt = validatePull(pull, {
    expectedMergeSha,
    expectedReviewedBaseSha,
    expectedReviewedHeadSha,
    prNumber,
  })
  const mergeCommit = await github.object(`commits/${expectedMergeSha}`)
  clock.assertBeforeDeadline()
  validateMergeCommit(mergeCommit, {
    expectedMergeSha,
    expectedReviewedBaseSha,
    expectedReviewedHeadSha,
  })
  const verificationRuns = await readVerificationRuns({
    assertWithinDeadline: () => clock.assertBeforeDeadline(),
    expectedMergeSha,
    expectedObservationHeadSha,
    github,
  })
  clock.assertBeforeDeadline()

  const baselineByNumber = new Map(baseline.open.map((alert) => [alert.number, alert]))
  let finalOpen = null
  let finalOpenB = null
  let finalFixed = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    clock.assertBeforeDeadline()
    const headBefore = await github.object("commits/main")
    clock.assertBeforeDeadline()
    if (headBefore.sha !== expectedObservationHeadSha) fail("DEFAULT_HEAD_MISMATCH")
    const openAResult = await readReconciliationOpen({
      baselineByNumber,
      expectedFixedNumbers: fixedNumbers,
      expectedOpenNumbers: openNumbers,
      github,
    })
    clock.assertBeforeDeadline()
    const fixedResult = await readReconciliationFixed({
      assertWithinDeadline: () => clock.assertBeforeDeadline(),
      baselineByNumber,
      expectedFixedNumbers: fixedNumbers,
      github,
      mergedAt,
    })
    clock.assertBeforeDeadline()
    if (openAResult.ready && fixedResult.ready) {
      const openBResult = await readReconciliationOpen({
        baselineByNumber,
        expectedFixedNumbers: fixedNumbers,
        expectedOpenNumbers: openNumbers,
        github,
      })
      clock.assertBeforeDeadline()
      const headAfter = await github.object("commits/main")
      clock.assertBeforeDeadline()
      if (headAfter.sha !== expectedObservationHeadSha || headAfter.sha !== headBefore.sha) {
        fail("DEFAULT_HEAD_DRIFT")
      }
      if (
        !openBResult.ready ||
        JSON.stringify(openAResult.open) !== JSON.stringify(openBResult.open)
      ) {
        fail("DEPENDABOT_OPEN_SNAPSHOT_DRIFT")
      }
      finalOpen = openAResult.open
      finalOpenB = openBResult.open
      finalFixed = fixedResult.fixed
      break
    }
    if (attempt === maxAttempts) fail("DEPENDABOT_RECONCILIATION_ATTEMPT_LIMIT")
    const remaining = deadline - clock.sample()
    if (remaining <= intervalMs) fail("DEPENDABOT_RECONCILIATION_TIMEOUT")
    await sleep(intervalMs)
    clock.assertBeforeDeadline()
  }
  if (finalOpen === null || finalOpenB === null || finalFixed === null) {
    fail("DEPENDABOT_RECONCILIATION_TIMEOUT")
  }
  const publicationAfter = verifyPublicationSnapshot(await collectPublication({ phase: "after" }), {
    expectedDefaultSha: expectedObservationHeadSha,
  })
  clock.assertBeforeDeadline()
  if (JSON.stringify(publicationAfter) !== JSON.stringify(publicationBefore)) {
    fail("PUBLICATION_SNAPSHOT_DRIFT")
  }
  const closingHead = await github.object("commits/main")
  clock.assertBeforeDeadline()
  if (closingHead.sha !== expectedObservationHeadSha) fail("DEFAULT_HEAD_DRIFT")
  const capturedAtMs = clock.sample()
  if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs < started || capturedAtMs >= deadline) {
    fail("DEPENDABOT_RECONCILIATION_TIMEOUT")
  }
  return createReconciliationReceipt({
    completedAtMilliseconds: capturedAtMs,
    fileInputs,
    fixed: finalFixed,
    mergeSha: expectedMergeSha,
    mergedAt,
    observationHead: expectedObservationHeadSha,
    openA: finalOpen,
    openB: finalOpenB,
    prNumber,
    publicationAfter,
    publicationBefore,
    repository: repo,
    reviewedBaseSha: expectedReviewedBaseSha,
    reviewedHeadSha: expectedReviewedHeadSha,
    startedAtMilliseconds: started,
    verificationRuns,
  })
}

async function readVerificationRuns({
  assertWithinDeadline,
  expectedMergeSha,
  expectedObservationHeadSha,
  github,
}) {
  const workflowPaths = [
    ".github/workflows/ci.yml",
    ".github/workflows/codeql.yml",
    ".github/workflows/scorecard.yml",
  ]
  const heads = [...new Set([expectedMergeSha, expectedObservationHeadSha])].sort(compareText)
  const result = []
  const runIds = new Set()
  for (const headSha of heads) {
    for (const workflowPath of workflowPaths) {
      assertWithinDeadline()
      const records = await github.list(
        `actions/workflows/${encodeURIComponent(workflowPath)}/runs?head_sha=${headSha}&per_page=100`,
        { field: "workflow_runs", totalCount: true, uniqueKey: "id" },
      )
      assertWithinDeadline()
      const candidates = records.filter((run) => run.event === "push")
      if (candidates.length !== 1) fail("VERIFICATION_RUN_AMBIGUITY")
      const run = candidates[0]
      if (
        !Number.isSafeInteger(run.id) ||
        run.id < 1 ||
        runIds.has(run.id) ||
        !Number.isSafeInteger(run.run_attempt) ||
        run.run_attempt < 1 ||
        run.path !== workflowPath ||
        run.head_sha !== headSha ||
        run.head_branch !== "main" ||
        run.event !== "push" ||
        run.status !== "completed" ||
        run.conclusion !== "success"
      ) {
        fail("VERIFICATION_RUN_MISMATCH")
      }
      runIds.add(run.id)
      result.push({
        conclusion: "success",
        event: "push",
        headBranch: "main",
        headSha,
        runAttempt: run.run_attempt,
        runId: run.id,
        status: "completed",
        workflowPath,
      })
    }
  }
  return result
}

async function readReconciliationOpen({
  baselineByNumber,
  expectedFixedNumbers,
  expectedOpenNumbers,
  github,
}) {
  const raw = await github.list("dependabot/alerts?state=open&per_page=100", {
    cursorOnly: true,
    pageLimit: 10,
    uniqueKey: "number",
  })
  const open = raw.map(normalizeDependabotAlert).sort((left, right) => left.number - right.number)
  for (const alert of open) {
    const baseline = baselineByNumber.get(alert.number)
    if (baseline === undefined) fail("UNEXPECTED_DEPENDABOT_ALERT")
    if (alert.state !== "open" || JSON.stringify(alert) !== JSON.stringify(baseline)) {
      fail("DEPENDABOT_OPEN_IDENTITY_MISMATCH")
    }
  }
  const actual = open.map((alert) => alert.number)
  const permittedPending = new Set([...expectedOpenNumbers, ...expectedFixedNumbers])
  const ready = JSON.stringify(actual) === JSON.stringify(expectedOpenNumbers)
  if (
    new Set(actual).size !== actual.length ||
    expectedOpenNumbers.some((number) => !actual.includes(number)) ||
    actual.some((number) => !permittedPending.has(number))
  ) {
    fail("DEPENDABOT_OPEN_SET_MISMATCH")
  }
  return { open, ready }
}

async function readReconciliationFixed({
  assertWithinDeadline,
  baselineByNumber,
  expectedFixedNumbers,
  github,
  mergedAt,
}) {
  const fixed = []
  let ready = true
  for (const number of expectedFixedNumbers) {
    assertWithinDeadline()
    const alert = normalizeDependabotAlert(await github.object(`dependabot/alerts/${number}`))
    assertWithinDeadline()
    const baseline = baselineByNumber.get(number)
    if (baseline === undefined || !stableAlertIdentityMatches(alert, baseline)) {
      fail("DEPENDABOT_FIXED_IDENTITY_MISMATCH")
    }
    if (alert.state !== "fixed") {
      if (alert.state !== "open") fail("DEPENDABOT_FIXED_STATE_MISMATCH")
      ready = false
      continue
    }
    if (
      alert.dismissal !== null ||
      alert.autoDismissedAt !== null ||
      alert.fixedAt === null ||
      Date.parse(alert.fixedAt) < Date.parse(mergedAt)
    ) {
      fail("DEPENDABOT_FIXED_STATE_MISMATCH")
    }
    fixed.push(alert)
  }
  return { fixed, ready }
}

function stableAlertIdentityMatches(actual, baseline) {
  return [
    "number",
    "ecosystem",
    "package",
    "manifest",
    "relationship",
    "scope",
    "ghsa",
    "severity",
    "createdAt",
  ].every((key) => actual[key] === baseline[key])
}

function validatePull(pull, expected) {
  if (
    !isRecord(pull) ||
    pull.number !== expected.prNumber ||
    pull.state !== "closed" ||
    pull.merged !== true ||
    !isEvidenceTimestamp(pull.merged_at) ||
    pull.merge_commit_sha !== expected.expectedMergeSha ||
    !isRecord(pull.base) ||
    pull.base.sha !== expected.expectedReviewedBaseSha ||
    !isRecord(pull.head) ||
    pull.head.sha !== expected.expectedReviewedHeadSha
  ) {
    fail("MERGED_PR_IDENTITY_MISMATCH")
  }
  return pull.merged_at
}

function validateMergeCommit(commit, expected) {
  if (
    !isRecord(commit) ||
    commit.sha !== expected.expectedMergeSha ||
    !Array.isArray(commit.parents) ||
    commit.parents.length !== 2 ||
    !isRecord(commit.parents[0]) ||
    commit.parents[0].sha !== expected.expectedReviewedBaseSha ||
    !isRecord(commit.parents[1]) ||
    commit.parents[1].sha !== expected.expectedReviewedHeadSha
  ) {
    fail("MERGE_PARENT_MISMATCH")
  }
}

function createReconciliationClock(now, timeoutMs) {
  const maximumDate = 8_640_000_000_000_000
  let last
  const sample = () => {
    let value
    try {
      value = now()
    } catch {
      fail("DEPENDABOT_RECONCILIATION_TIMEOUT")
    }
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > maximumDate ||
      (last !== undefined && value < last)
    ) {
      fail("DEPENDABOT_RECONCILIATION_TIMEOUT")
    }
    last = value
    return value
  }
  const started = sample()
  if (started > maximumDate - timeoutMs) fail("DEPENDABOT_RECONCILIATION_TIMEOUT")
  const deadline = started + timeoutMs
  return {
    assertBeforeDeadline() {
      if (sample() >= deadline) fail("DEPENDABOT_RECONCILIATION_TIMEOUT")
    },
    deadline,
    sample,
    started,
  }
}

export function sleepForReconciliation(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function validateNumberSet(value) {
  if (!Array.isArray(value) || value.length === 0) fail("INVALID_DEPENDABOT_NUMBER_SET")
  const numbers = [...value]
  if (
    numbers.some((number) => !Number.isSafeInteger(number) || number < 1) ||
    new Set(numbers).size !== numbers.length ||
    numbers.some((number, index) => index > 0 && number <= numbers[index - 1])
  ) {
    fail("INVALID_DEPENDABOT_NUMBER_SET")
  }
  return numbers
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
