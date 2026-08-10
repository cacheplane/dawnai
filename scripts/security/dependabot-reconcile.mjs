import { createHash } from "node:crypto"
import { readBoundedFixture } from "../release/fixture-io.mjs"
import { canonicalJsonBytes, EvidenceError } from "./github-evidence.mjs"
import { verifyPublicationSnapshot } from "./publication-containment.mjs"

const GHSA_PATTERN = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/u
const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u

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

export function validateDependabotExpectation(value) {
  const fixture = safeClone(value)
  assertExactKeys(fixture, ["defaultSha", "open", "repository", "schemaVersion"])
  if (
    fixture.schemaVersion !== 1 ||
    fixture.repository !== "cacheplane/dawnai" ||
    typeof fixture.defaultSha !== "string" ||
    !SHA_PATTERN.test(fixture.defaultSha) ||
    !Array.isArray(fixture.open) ||
    fixture.open.length === 0
  ) {
    fail("INVALID_DEPENDABOT_FIXTURE")
  }
  const open = fixture.open.map(validateNormalizedAlert)
  const numbers = open.map((alert) => alert.number)
  if (
    new Set(numbers).size !== numbers.length ||
    numbers.some((number, index) => index > 0 && number <= numbers[index - 1]) ||
    open.some(
      (alert) =>
        alert.state !== "open" ||
        alert.fixedAt !== null ||
        alert.dismissal !== null ||
        alert.autoDismissedAt !== null,
    )
  ) {
    fail("INVALID_DEPENDABOT_FIXTURE")
  }
  return {
    defaultSha: fixture.defaultSha,
    open,
    repository: fixture.repository,
    schemaVersion: 1,
  }
}

export function normalizeDependabotAlert(value) {
  const alert = safeClone(value)
  if (
    !isRecord(alert) ||
    !Number.isSafeInteger(alert.number) ||
    alert.number < 1 ||
    !["auto_dismissed", "dismissed", "fixed", "open"].includes(alert.state) ||
    !isRecord(alert.dependency) ||
    !isRecord(alert.dependency.package) ||
    alert.dependency.package.ecosystem !== "npm" ||
    typeof alert.dependency.package.name !== "string" ||
    !PACKAGE_PATTERN.test(alert.dependency.package.name) ||
    typeof alert.dependency.manifest_path !== "string" ||
    !isSafeManifest(alert.dependency.manifest_path) ||
    !["direct", "transitive"].includes(alert.dependency.relationship) ||
    !["development", "runtime"].includes(alert.dependency.scope) ||
    !isRecord(alert.security_advisory) ||
    typeof alert.security_advisory.ghsa_id !== "string" ||
    !GHSA_PATTERN.test(alert.security_advisory.ghsa_id) ||
    !["critical", "high", "low", "medium"].includes(alert.security_advisory.severity) ||
    !isTimestamp(alert.created_at) ||
    !isTimestamp(alert.updated_at)
  ) {
    fail("INVALID_DEPENDABOT_ALERT")
  }
  const fixedAt = nullableTimestamp(alert.fixed_at)
  const autoDismissedAt = nullableTimestamp(alert.auto_dismissed_at)
  const dismissal = normalizeDismissal(alert)
  if (
    (alert.state === "open" &&
      (fixedAt !== null || dismissal !== null || autoDismissedAt !== null)) ||
    (alert.state === "fixed" && (fixedAt === null || dismissal !== null)) ||
    (alert.state === "dismissed" && dismissal === null) ||
    (alert.state === "auto_dismissed" && autoDismissedAt === null)
  ) {
    fail("INVALID_DEPENDABOT_ALERT")
  }
  return {
    autoDismissedAt,
    createdAt: alert.created_at,
    dismissal,
    ecosystem: "npm",
    fixedAt,
    ghsa: alert.security_advisory.ghsa_id,
    manifest: alert.dependency.manifest_path,
    number: alert.number,
    package: alert.dependency.package.name,
    relationship: alert.dependency.relationship,
    scope: alert.dependency.scope,
    severity: alert.security_advisory.severity,
    state: alert.state,
    updatedAt: alert.updated_at,
  }
}

function normalizeDismissal(alert) {
  const values = [
    alert.dismissed_at,
    alert.dismissed_by,
    alert.dismissed_comment,
    alert.dismissed_reason,
  ]
  if (values.every((value) => value === null)) return null
  if (
    !isTimestamp(alert.dismissed_at) ||
    !isRecord(alert.dismissed_by) ||
    typeof alert.dismissed_by.login !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(alert.dismissed_by.login) ||
    typeof alert.dismissed_comment !== "string" ||
    Buffer.byteLength(alert.dismissed_comment, "utf8") > 4096 ||
    typeof alert.dismissed_reason !== "string" ||
    !/^[a-z_]{1,64}$/u.test(alert.dismissed_reason)
  ) {
    fail("INVALID_DEPENDABOT_ALERT")
  }
  return {
    at: alert.dismissed_at,
    by: alert.dismissed_by.login,
    comment: alert.dismissed_comment,
    reason: alert.dismissed_reason,
  }
}

export async function readDependabotOpen({ expectedNumbers, fixture, github }) {
  const expectedFixture = validateDependabotExpectation(fixture)
  const numbers = validateNumberSet(expectedNumbers)
  if (JSON.stringify(numbers) !== JSON.stringify(expectedFixture.open.map((alert) => alert.number))) {
    fail("DEPENDABOT_EXPECTED_SET_MISMATCH")
  }
  if (github === null || typeof github !== "object" || typeof github.list !== "function") {
    fail("INVALID_DEPENDABOT_READER")
  }
  const rawAlerts = await github.list("dependabot/alerts?state=open&per_page=100", {
    cursorOnly: true,
    uniqueKey: "number",
  })
  const alerts = rawAlerts.map(normalizeDependabotAlert).sort((left, right) => left.number - right.number)
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
  auditReceipt,
  auditReceiptDigest,
  baselineFixture,
  expectedFixedNumbers,
  expectedMergeSha,
  expectedOpenNumbers,
  expectedReviewedBaseSha,
  expectedReviewedHeadSha,
  github,
  intervalMs = 15_000,
  maxAttempts = 61,
  now = Date.now,
  prNumber,
  publication,
  repo,
  sleep = defaultSleep,
  timeoutMs = 15 * 60_000,
}) {
  if (
    repo !== "cacheplane/dawnai" ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    !isSha(expectedReviewedBaseSha) ||
    !isSha(expectedReviewedHeadSha) ||
    !isSha(expectedMergeSha) ||
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
    typeof github.list !== "function"
  ) {
    fail("INVALID_RECONCILIATION_REQUEST")
  }
  const baseline = validateDependabotExpectation(baselineFixture)
  const fixedNumbers = validateNumberSet(expectedFixedNumbers)
  const openNumbers = validateNumberSet(expectedOpenNumbers)
  if (new Set([...fixedNumbers, ...openNumbers]).size !== fixedNumbers.length + openNumbers.length) {
    fail("OVERLAPPING_DEPENDABOT_EXPECTATIONS")
  }
  const combined = [...fixedNumbers, ...openNumbers].sort((left, right) => left - right)
  if (JSON.stringify(combined) !== JSON.stringify(baseline.open.map((alert) => alert.number))) {
    fail("DEPENDABOT_BASELINE_SET_MISMATCH")
  }
  const normalizedAudit = validateAuditReceipt(auditReceipt)
  if (
    typeof auditReceiptDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(auditReceiptDigest) ||
    auditReceiptDigest !== digest(normalizedAudit)
  ) {
    fail("AUDIT_RECEIPT_DIGEST_MISMATCH")
  }
  const normalizedPublication = verifyPublicationSnapshot(publication, {
    expectedDefaultSha: expectedMergeSha,
  })
  const started = now()
  const deadline = started + timeoutMs
  assertBeforeDeadline(now, deadline)

  const pull = await github.object(`pulls/${prNumber}`)
  assertBeforeDeadline(now, deadline)
  const mergedAt = validatePull(pull, {
    expectedMergeSha,
    expectedReviewedBaseSha,
    expectedReviewedHeadSha,
    prNumber,
  })
  const mergeCommit = await github.object(`commits/${expectedMergeSha}`)
  assertBeforeDeadline(now, deadline)
  validateMergeCommit(mergeCommit, {
    expectedMergeSha,
    expectedReviewedBaseSha,
    expectedReviewedHeadSha,
  })

  const baselineByNumber = new Map(baseline.open.map((alert) => [alert.number, alert]))
  let finalOpen = null
  let finalFixed = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    assertBeforeDeadline(now, deadline)
    const headBefore = await github.object("commits/main")
    assertBeforeDeadline(now, deadline)
    if (headBefore.sha !== expectedMergeSha) fail("DEFAULT_HEAD_MISMATCH")
    const openAResult = await readReconciliationOpen({
      baselineByNumber,
      expectedFixedNumbers: fixedNumbers,
      expectedOpenNumbers: openNumbers,
      github,
    })
    const fixedResult = await readReconciliationFixed({
      baselineByNumber,
      expectedFixedNumbers: fixedNumbers,
      github,
      mergedAt,
    })
    assertBeforeDeadline(now, deadline)
    if (openAResult.ready && fixedResult.ready) {
      const openBResult = await readReconciliationOpen({
        baselineByNumber,
        expectedFixedNumbers: fixedNumbers,
        expectedOpenNumbers: openNumbers,
        github,
      })
      const headAfter = await github.object("commits/main")
      assertBeforeDeadline(now, deadline)
      if (headAfter.sha !== expectedMergeSha || headAfter.sha !== headBefore.sha) {
        fail("DEFAULT_HEAD_DRIFT")
      }
      if (
        !openBResult.ready ||
        JSON.stringify(openAResult.open) !== JSON.stringify(openBResult.open)
      ) {
        fail("DEPENDABOT_OPEN_SNAPSHOT_DRIFT")
      }
      finalOpen = openAResult.open
      finalFixed = fixedResult.fixed
      break
    }
    if (attempt === maxAttempts) fail("DEPENDABOT_RECONCILIATION_ATTEMPT_LIMIT")
    const remaining = deadline - now()
    if (remaining <= intervalMs) fail("DEPENDABOT_RECONCILIATION_TIMEOUT")
    await sleep(intervalMs)
    assertBeforeDeadline(now, deadline)
  }
  if (finalOpen === null || finalFixed === null) fail("DEPENDABOT_RECONCILIATION_TIMEOUT")
  const capturedAt = new Date(now()).toISOString()
  const receipt = {
    audit: { digest: auditReceiptDigest, evidence: normalizedAudit },
    capturedAt,
    dependabot: { fixed: finalFixed, open: finalOpen },
    kind: "dependency-security-reconciliation",
    observationHead: expectedMergeSha,
    pr: {
      mergeSha: expectedMergeSha,
      mergedAt,
      number: prNumber,
      reviewedBaseSha: expectedReviewedBaseSha,
      reviewedHeadSha: expectedReviewedHeadSha,
    },
    publication: normalizedPublication,
    repository: repo,
    schemaVersion: 1,
  }
  return safeClone(receipt)
}

async function readReconciliationOpen({
  baselineByNumber,
  expectedFixedNumbers,
  expectedOpenNumbers,
  github,
}) {
  const raw = await github.list("dependabot/alerts?state=open&per_page=100", {
    cursorOnly: true,
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
  const permittedPending = [...expectedOpenNumbers, ...expectedFixedNumbers].sort(
    (left, right) => left - right,
  )
  const ready = JSON.stringify(actual) === JSON.stringify(expectedOpenNumbers)
  if (!ready && JSON.stringify(actual) !== JSON.stringify(permittedPending)) {
    fail("DEPENDABOT_OPEN_SET_MISMATCH")
  }
  return { open, ready }
}

async function readReconciliationFixed({
  baselineByNumber,
  expectedFixedNumbers,
  github,
  mergedAt,
}) {
  const fixed = []
  let ready = true
  for (const number of expectedFixedNumbers) {
    const alert = normalizeDependabotAlert(await github.object(`dependabot/alerts/${number}`))
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
    !isTimestamp(pull.merged_at) ||
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

export function validateAuditReceipt(value) {
  const receipt = safeClone(value)
  assertExactKeys(receipt, ["full", "kind", "production", "schemaVersion"])
  if (receipt.kind !== "pnpm-audit" || receipt.schemaVersion !== 1) {
    fail("INVALID_AUDIT_RECEIPT")
  }
  return {
    full: validateAuditMode(receipt.full),
    kind: "pnpm-audit",
    production: validateAuditMode(receipt.production),
    schemaVersion: 1,
  }
}

function validateAuditMode(value) {
  if (!isRecord(value)) fail("INVALID_AUDIT_RECEIPT")
  assertExactKeys(value, [
    "exitCode",
    "muted",
    "records",
    "severityTotals",
    "status",
  ])
  if (!Array.isArray(value.muted) || value.muted.length !== 0 || !Array.isArray(value.records)) {
    fail("INVALID_AUDIT_RECEIPT")
  }
  const records = value.records.map((record) => {
    if (!isRecord(record)) fail("INVALID_AUDIT_RECEIPT")
    assertExactKeys(record, ["ghsa", "package", "severity", "version"])
    if (
      typeof record.ghsa !== "string" ||
      !GHSA_PATTERN.test(record.ghsa) ||
      typeof record.package !== "string" ||
      !PACKAGE_PATTERN.test(record.package) ||
      typeof record.version !== "string" ||
      !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u.test(record.version) ||
      !["critical", "high", "info", "low", "moderate"].includes(record.severity)
    ) {
      fail("INVALID_AUDIT_RECEIPT")
    }
    return record
  })
  const identities = records.map((record) => JSON.stringify(record))
  if (new Set(identities).size !== identities.length) fail("INVALID_AUDIT_RECEIPT")
  const totals = { critical: 0, high: 0, info: 0, low: 0, moderate: 0 }
  for (const record of records) totals[record.severity] += 1
  if (
    !isRecord(value.severityTotals) ||
    JSON.stringify(value.severityTotals) !== JSON.stringify(totals) ||
    (records.length === 0 && (value.exitCode !== 0 || value.status !== "clean")) ||
    (records.length > 0 && (value.exitCode !== 1 || value.status !== "findings"))
  ) {
    fail("INVALID_AUDIT_RECEIPT")
  }
  return {
    exitCode: value.exitCode,
    muted: [],
    records,
    severityTotals: totals,
    status: value.status,
  }
}

function digest(value) {
  return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex")
}

function assertBeforeDeadline(now, deadline) {
  if (now() >= deadline) fail("DEPENDABOT_RECONCILIATION_TIMEOUT")
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

function validateNormalizedAlert(value) {
  if (!isRecord(value)) fail("INVALID_DEPENDABOT_FIXTURE")
  assertExactKeys(value, [
    "autoDismissedAt",
    "createdAt",
    "dismissal",
    "ecosystem",
    "fixedAt",
    "ghsa",
    "manifest",
    "number",
    "package",
    "relationship",
    "scope",
    "severity",
    "state",
    "updatedAt",
  ])
  const raw = {
    auto_dismissed_at: value.autoDismissedAt,
    created_at: value.createdAt,
    dependency: {
      manifest_path: value.manifest,
      package: { ecosystem: value.ecosystem, name: value.package },
      relationship: value.relationship,
      scope: value.scope,
    },
    dismissed_at: value.dismissal?.at ?? null,
    dismissed_by: value.dismissal === null ? null : { login: value.dismissal?.by },
    dismissed_comment: value.dismissal?.comment ?? null,
    dismissed_reason: value.dismissal?.reason ?? null,
    fixed_at: value.fixedAt,
    number: value.number,
    security_advisory: { ghsa_id: value.ghsa, severity: value.severity },
    state: value.state,
    updated_at: value.updatedAt,
  }
  return normalizeDependabotAlert(raw)
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

function nullableTimestamp(value) {
  if (value === null) return null
  if (!isTimestamp(value)) fail("INVALID_DEPENDABOT_ALERT")
  return value
}

function isTimestamp(value) {
  return (
    typeof value === "string" &&
    TIMESTAMP_PATTERN.test(value) &&
    new Date(value).toISOString().replace(".000Z", "Z") === value
  )
}

function isSafeManifest(value) {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  )
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value)
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
