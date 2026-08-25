import { isEvidenceSha, isEvidenceTimestamp } from "./dependabot-evidence-schema.mjs"
import { canonicalJsonBytes, EvidenceError } from "./github-evidence.mjs"

const GHSA_PATTERN =
  /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/u
const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u

export const AUDIT_SEVERITIES = ["critical", "high", "info", "low", "moderate"]

function fail(code) {
  throw new EvidenceError(code)
}

export function validateAuditExpectation(value) {
  const fixture = safeClone(value, "INVALID_AUDIT_EXPECTATION")
  assertExactKeys(fixture, ["full", "production", "schemaVersion"], "INVALID_AUDIT_EXPECTATION")
  if (fixture.schemaVersion !== 1) fail("INVALID_AUDIT_EXPECTATION")
  return {
    full: validateAuditExpectationMode(fixture.full),
    production: validateAuditExpectationMode(fixture.production),
    schemaVersion: 1,
  }
}

export function validateAuditExpectationMode(value) {
  if (!isRecord(value)) fail("INVALID_AUDIT_EXPECTATION")
  assertExactKeys(value, ["muted", "records"], "INVALID_AUDIT_EXPECTATION")
  if (!Array.isArray(value.muted) || value.muted.length !== 0 || !Array.isArray(value.records)) {
    fail("INVALID_AUDIT_EXPECTATION")
  }
  const records = value.records
    .map((record) => normalizeAuditRecord(record, "INVALID_AUDIT_EXPECTATION"))
    .sort(compareAuditRecords)
  assertUniqueAuditRecords(records, "DUPLICATE_AUDIT_EXPECTATION")
  return { muted: [], records }
}

export function normalizeAuditRecord(value, code) {
  if (!isRecord(value)) fail(code)
  assertExactKeys(value, ["ghsa", "package", "severity", "version"], code)
  if (
    typeof value.package !== "string" ||
    !PACKAGE_PATTERN.test(value.package) ||
    typeof value.version !== "string" ||
    !VERSION_PATTERN.test(value.version) ||
    typeof value.ghsa !== "string" ||
    !GHSA_PATTERN.test(value.ghsa) ||
    typeof value.severity !== "string" ||
    !AUDIT_SEVERITIES.includes(value.severity)
  ) {
    fail(code)
  }
  return {
    ghsa: value.ghsa,
    package: value.package,
    severity: value.severity,
    version: value.version,
  }
}

export function validateAuditReceipt(value) {
  const receipt = safeClone(value, "INVALID_AUDIT_RECEIPT")
  assertExactKeys(
    receipt,
    ["capturedAt", "full", "kind", "lockfileSha256", "production", "schemaVersion", "sourceSha"],
    "INVALID_AUDIT_RECEIPT",
  )
  if (
    receipt.kind !== "pnpm-audit" ||
    receipt.schemaVersion !== 2 ||
    !isEvidenceTimestamp(receipt.capturedAt) ||
    !isEvidenceSha(receipt.sourceSha) ||
    typeof receipt.lockfileSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receipt.lockfileSha256)
  ) {
    fail("INVALID_AUDIT_RECEIPT")
  }
  return {
    capturedAt: receipt.capturedAt,
    full: validateAuditReceiptMode(receipt.full),
    kind: "pnpm-audit",
    lockfileSha256: receipt.lockfileSha256,
    production: validateAuditReceiptMode(receipt.production),
    schemaVersion: 2,
    sourceSha: receipt.sourceSha,
  }
}

function validateAuditReceiptMode(value) {
  if (!isRecord(value)) fail("INVALID_AUDIT_RECEIPT")
  assertExactKeys(
    value,
    ["exitCode", "muted", "records", "severityTotals", "status"],
    "INVALID_AUDIT_RECEIPT",
  )
  if (!Array.isArray(value.muted) || value.muted.length !== 0 || !Array.isArray(value.records)) {
    fail("INVALID_AUDIT_RECEIPT")
  }
  const records = value.records.map((record) =>
    normalizeAuditRecord(record, "INVALID_AUDIT_RECEIPT"),
  )
  assertUniqueAuditRecords(records, "INVALID_AUDIT_RECEIPT")
  const totals = countAuditSeverity(records)
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

export function assertUniqueAuditRecords(records, code) {
  const identities = new Set()
  for (const record of records) {
    const identity = JSON.stringify(record)
    if (identities.has(identity)) fail(code)
    identities.add(identity)
  }
}

export function countAuditSeverity(records) {
  const result = { critical: 0, high: 0, info: 0, low: 0, moderate: 0 }
  for (const record of records) result[record.severity] += 1
  return result
}

export function compareAuditRecords(left, right) {
  return compareText(JSON.stringify(left), JSON.stringify(right))
}

function safeClone(value, code) {
  try {
    return JSON.parse(canonicalJsonBytes(value).toString("utf8"))
  } catch {
    fail(code)
  }
}

function assertExactKeys(value, expected, code) {
  if (!isRecord(value)) fail(code)
  const actual = Object.keys(value).sort(compareText)
  const wanted = [...expected].sort(compareText)
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(code)
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
