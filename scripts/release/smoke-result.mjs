import { randomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { link, mkdir, open, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { snapshotJson } from "./adapter-normalize.mjs"
import { isExactSemver } from "./semver.mjs"

export const SMOKE_RESULT_SCHEMA_VERSION = 1
export const REQUIRED_RELEASE_SMOKE_LANES = Object.freeze([
  "metadata",
  "published-harness",
  "runtime-targets",
  "scaffold",
  "storage",
])

const RESULT_FIELDS = [
  "schemaVersion",
  "lane",
  "version",
  "commitSha",
  "manifestSha256",
  "workflowRunId",
  "runAttempt",
  "startedAt",
  "finishedAt",
  "checks",
  "conclusion",
]
const CHECK_FIELDS = ["name", "conclusion", "detail"]
const AGGREGATE_FIELDS = [
  "schemaVersion",
  "version",
  "commitSha",
  "manifestSha256",
  "workflowRunId",
  "runAttempt",
  "lanes",
  "checks",
  "conclusion",
]
const AGGREGATE_LANE_FIELDS = [
  "lane",
  "workflowRunId",
  "runAttempt",
  "startedAt",
  "finishedAt",
  "checks",
  "conclusion",
]
const CONCLUSIONS = new Set(["success", "failure"])
const LANE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const MAX_CANONICAL_BYTES = 256 * 1024
const MAX_LANES = 64
const MAX_CHECKS_PER_LANE = 128
const MAX_AGGREGATE_CHECKS = MAX_LANES * MAX_CHECKS_PER_LANE

export function parseSmokeResult(value) {
  let inputBytes = null
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_CANONICAL_BYTES) {
      throw new Error(`smoke result exceeds its ${MAX_CANONICAL_BYTES}-byte limit`)
    }
    inputBytes = Buffer.from(value, "utf8")
  } else if (value instanceof Uint8Array) {
    inputBytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  const decoded = parseJsonBytes(inputBytes ?? value, "smoke result")
  let result
  try {
    result = snapshotJson(decoded)
  } catch (error) {
    throw new TypeError("Invalid smoke result: expected descriptor-safe JSON", {
      cause: error,
    })
  }

  assertRecord(result, "smoke result")
  assertExactFields(result, RESULT_FIELDS, "smoke result")
  assertSchemaAndIdentity(result)
  assertLane(result.lane, "lane")
  assertPositiveInteger(result.workflowRunId, "workflowRunId")
  assertPositiveInteger(result.runAttempt, "runAttempt")
  assertTimestamps(result.startedAt, result.finishedAt)
  validateChecks(result.checks, "checks")
  assertConclusion(result.conclusion, "conclusion")
  assertDerivedConclusion(result.checks, result.conclusion, "smoke result")
  assertCanonicalByteLength(result, "Smoke result")
  if (inputBytes !== null && !inputBytes.equals(canonicalBytes(result, "Smoke result"))) {
    throw new Error("Smoke result bytes must be canonical")
  }

  return deepFreeze(result)
}

function parseJsonBytes(value, label) {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) return value
  const bytes =
    typeof value === "string"
      ? Buffer.from(value, "utf8")
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (bytes.length > MAX_CANONICAL_BYTES) {
    throw new Error(`${label} exceeds its ${MAX_CANONICAL_BYTES}-byte limit`)
  }
  let source
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw new TypeError(`${label} bytes must be valid UTF-8`, { cause: error })
  }
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new TypeError(`${label} must contain valid JSON`, { cause: error })
  }
}

export function correlateSmokeResults(results, options) {
  if (!Array.isArray(results)) {
    throw new TypeError("Smoke results must be an array")
  }
  const identity = parseCorrelationOptions(options)
  const byLane = new Map()

  for (const input of results) {
    const result = parseSmokeResult(input)
    if (byLane.has(result.lane)) {
      throw new Error(`Smoke results contain duplicate lane ${result.lane}`)
    }
    if (!REQUIRED_RELEASE_SMOKE_LANES.includes(result.lane)) {
      throw new Error(`Smoke results contain unexpected lane ${result.lane}`)
    }
    if (
      result.version !== identity.version ||
      result.commitSha !== identity.commitSha ||
      result.manifestSha256 !== identity.manifestSha256
    ) {
      throw new Error(`Smoke result identity mismatch for lane ${result.lane}`)
    }
    if (result.workflowRunId !== identity.workflowRunId) {
      throw new Error(`Smoke result workflow run mismatch for lane ${result.lane}`)
    }
    if (result.runAttempt !== identity.runAttempt) {
      throw new Error(`Smoke result run attempt mismatch for lane ${result.lane}`)
    }
    byLane.set(result.lane, result)
  }

  for (const lane of REQUIRED_RELEASE_SMOKE_LANES) {
    if (!byLane.has(lane)) {
      throw new Error(`Smoke results are missing required lane ${lane}`)
    }
  }

  return deepFreeze(REQUIRED_RELEASE_SMOKE_LANES.map((lane) => byLane.get(lane)))
}

export function aggregateSmokeResults(results, options) {
  const correlated = correlateSmokeResults(results, options)
  const identity = parseCorrelationOptions(options)
  const lanes = correlated.map((result) => ({
    lane: result.lane,
    workflowRunId: result.workflowRunId,
    runAttempt: result.runAttempt,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    checks: result.checks.map((check) => ({ ...check })),
    conclusion: result.conclusion,
  }))
  const checks = correlated.flatMap((result) =>
    result.checks.map((check) => ({
      name: `${result.lane}:${check.name}`,
      conclusion: check.conclusion,
      detail: check.detail,
    })),
  )
  const aggregate = {
    schemaVersion: SMOKE_RESULT_SCHEMA_VERSION,
    version: identity.version,
    commitSha: identity.commitSha,
    manifestSha256: identity.manifestSha256,
    workflowRunId: identity.workflowRunId,
    runAttempt: identity.runAttempt,
    lanes,
    checks,
    conclusion: derivedConclusion(checks),
  }

  return validateAggregateSmokeResult(aggregate)
}

export function canonicalSmokeResultBytes(value) {
  return canonicalBytes(parseSmokeResult(value), "Smoke result")
}

export function canonicalAggregateSmokeResultBytes(value) {
  return canonicalBytes(validateAggregateSmokeResult(value), "Aggregate smoke result")
}

export async function writeCanonicalSmokeResult(path, value, overrides = {}) {
  return writeCanonicalFileNoClobber(path, canonicalSmokeResultBytes(value), overrides)
}

export async function writeCanonicalFileNoClobber(path, bytes, overrides = {}) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("Result path is required")
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_CANONICAL_BYTES) {
    throw new Error("Canonical result bytes are missing or exceed the byte limit")
  }
  const dependencies = { link, mkdir, open, unlink, ...overrides }
  const directory = dirname(path)
  await dependencies.mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let temporaryCreated = false
  let primaryError
  try {
    const handle = await dependencies.open(temporary, "wx", 0o600)
    temporaryCreated = true
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await dependencies.link(temporary, path)
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const existingHandle = await dependencies.open(
        path,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      )
      let existing
      try {
        const before = await existingHandle.stat({ bigint: true })
        if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_CANONICAL_BYTES)) {
          throw new Error("Existing smoke result is not a bounded regular file")
        }
        existing = await existingHandle.readFile()
        const after = await existingHandle.stat({ bigint: true })
        for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
          if (before[field] !== after[field]) {
            throw new Error("Existing smoke result changed while it was read")
          }
        }
      } finally {
        await existingHandle.close()
      }
      if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
        throw new Error("Existing smoke result conflicts with canonical bytes")
      }
    }
  } catch (error) {
    primaryError = error
  }
  let cleanupError
  if (temporaryCreated) {
    try {
      await dependencies.unlink(temporary)
    } catch (error) {
      cleanupError = error
    }
  }
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `Smoke result write failed and temporary cleanup failed: ${formatSmokeError(primaryError)}; ${formatSmokeError(cleanupError)}`,
    )
  }
  if (primaryError !== undefined) throw primaryError
  if (cleanupError !== undefined) throw cleanupError
  return Buffer.from(bytes)
}

export function parseSmokeLaneArgs(args) {
  if (!Array.isArray(args)) throw new TypeError("Smoke lane arguments must be an array")
  const normalized = args[0] === "--" ? args.slice(1) : args
  const parsed = {}
  const flags = new Map([
    ["--version", "version"],
    ["--commit-sha", "commitSha"],
    ["--manifest-sha256", "manifestSha256"],
    ["--manifest", "manifest"],
    ["--result", "result"],
  ])
  const seen = new Set()

  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index]
    const equalIndex = argument.indexOf("=")
    const flag = equalIndex === -1 ? argument : argument.slice(0, equalIndex)
    const field = flags.get(flag)
    if (field === undefined) throw new Error(`Unknown smoke lane argument "${argument}"`)
    if (seen.has(field)) throw new Error(`Duplicate smoke lane argument ${flag}`)
    seen.add(field)
    const value = equalIndex === -1 ? normalized[++index] : argument.slice(equalIndex + 1)
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`)
    }
    parsed[field] = value
  }

  if (!isExactSemver(parsed.version)) throw new Error("--version must be an exact SemVer")
  if (typeof parsed.commitSha !== "string" || !SHA_PATTERN.test(parsed.commitSha)) {
    throw new Error("--commit-sha must be a 40-character lowercase hexadecimal SHA")
  }
  if (typeof parsed.manifestSha256 !== "string" || !SHA256_PATTERN.test(parsed.manifestSha256)) {
    throw new Error("--manifest-sha256 must be a lowercase SHA256 digest")
  }
  if (typeof parsed.result !== "string" || parsed.result.length === 0) {
    throw new Error("--result is required")
  }
  return deepFreeze(parsed)
}

export async function executeSmokeLane(options, operation, overrides = {}) {
  if (typeof operation !== "function")
    throw new TypeError("Smoke lane operation must be a function")
  const dependencies = {
    env: process.env,
    mkdir,
    now: () => new Date(),
    writeResult: writeCanonicalSmokeResult,
    ...overrides,
  }
  if (overrides.writeResult === undefined && overrides.writeFile !== undefined) {
    dependencies.writeResult = async (path, receipt) => {
      await dependencies.mkdir(dirname(path), { recursive: true })
      await overrides.writeFile(path, canonicalSmokeResultBytes(receipt))
    }
  }
  const startedAt = clockTimestamp(dependencies.now)
  const checks = []
  const names = new Set()
  const cleanups = []
  const errors = []

  const context = {
    async check(name, successDetail, run) {
      assertCheckDefinition(name, successDetail, run, names)
      try {
        const value = await run()
        checks.push({ name, conclusion: "success", detail: successDetail })
        return value
      } catch (error) {
        checks.push({
          name,
          conclusion: "failure",
          detail: formatSmokeError(error),
        })
        throw error
      }
    },
    deferCleanup(name, successDetail, run) {
      assertCheckDefinition(name, successDetail, run, names)
      cleanups.push({ name, successDetail, run })
    },
  }

  try {
    await operation(context)
    if (checks.length === 0 && cleanups.length === 0) {
      throw new Error("Smoke lane completed without recording checks")
    }
  } catch (error) {
    errors.push(error)
    if (!checks.some((check) => check.conclusion === "failure")) {
      const name = names.has("lane") ? "execution" : "lane"
      names.add(name)
      checks.push({ name, conclusion: "failure", detail: formatSmokeError(error) })
    }
  }

  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup.run()
      checks.push({
        name: cleanup.name,
        conclusion: "success",
        detail: cleanup.successDetail,
      })
    } catch (error) {
      checks.push({
        name: cleanup.name,
        conclusion: "failure",
        detail: formatSmokeError(error),
      })
      errors.push(error)
    }
  }

  let receipt
  try {
    receipt = parseSmokeResult({
      schemaVersion: SMOKE_RESULT_SCHEMA_VERSION,
      lane: options.lane,
      version: options.version,
      commitSha: options.commitSha,
      manifestSha256: options.manifestSha256,
      workflowRunId: environmentPositiveInteger(
        options.workflowRunId ?? dependencies.env.GITHUB_RUN_ID,
        "GITHUB_RUN_ID",
      ),
      runAttempt: environmentPositiveInteger(
        options.runAttempt ?? dependencies.env.GITHUB_RUN_ATTEMPT,
        "GITHUB_RUN_ATTEMPT",
      ),
      startedAt,
      finishedAt: clockTimestamp(dependencies.now),
      checks,
      conclusion: derivedConclusion(checks),
    })
    if (typeof options.result !== "string" || options.result.length === 0) {
      throw new Error("Smoke lane result path is required")
    }
    await dependencies.writeResult(options.result, receipt)
  } catch (error) {
    errors.push(error)
  }

  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Smoke lane failed: ${errors.map(formatSmokeError).join("; ")}`,
    )
  }
  return receipt
}

function validateAggregateSmokeResult(value) {
  let aggregate
  try {
    aggregate = snapshotJson(value)
  } catch (error) {
    throw new TypeError("Invalid aggregate smoke result: expected descriptor-safe JSON", {
      cause: error,
    })
  }
  assertRecord(aggregate, "aggregate smoke result")
  assertExactFields(aggregate, AGGREGATE_FIELDS, "aggregate smoke result")
  assertSchemaAndIdentity(aggregate)
  assertPositiveInteger(aggregate.workflowRunId, "workflowRunId")
  assertPositiveInteger(aggregate.runAttempt, "runAttempt")
  if (
    !Array.isArray(aggregate.lanes) ||
    aggregate.lanes.length !== REQUIRED_RELEASE_SMOKE_LANES.length
  ) {
    throw new Error(
      `aggregate smoke result lanes must contain exactly ${REQUIRED_RELEASE_SMOKE_LANES.length} lanes`,
    )
  }
  const seen = new Set()
  let previousLane
  for (let index = 0; index < aggregate.lanes.length; index += 1) {
    const lane = aggregate.lanes[index]
    const label = `lanes[${index}]`
    assertRecord(lane, label)
    assertExactFields(lane, AGGREGATE_LANE_FIELDS, label)
    assertLane(lane.lane, `${label}.lane`)
    if (seen.has(lane.lane)) throw new Error(`aggregate smoke result duplicate lane ${lane.lane}`)
    if (previousLane !== undefined && compareStrings(previousLane, lane.lane) >= 0) {
      throw new Error("aggregate smoke result lanes must be in stable lexical order")
    }
    seen.add(lane.lane)
    previousLane = lane.lane
    assertPositiveInteger(lane.workflowRunId, `${label}.workflowRunId`)
    assertPositiveInteger(lane.runAttempt, `${label}.runAttempt`)
    if (
      lane.lane !== REQUIRED_RELEASE_SMOKE_LANES[index] ||
      lane.workflowRunId !== aggregate.workflowRunId ||
      lane.runAttempt !== aggregate.runAttempt
    ) {
      throw new Error(`${label} must match the required lane and root workflow run identity`)
    }
    assertTimestamps(lane.startedAt, lane.finishedAt, label)
    validateChecks(lane.checks, `${label}.checks`)
    assertConclusion(lane.conclusion, `${label}.conclusion`)
    assertDerivedConclusion(lane.checks, lane.conclusion, label)
  }
  validateChecks(aggregate.checks, "aggregate checks", MAX_AGGREGATE_CHECKS, 193)
  const expectedChecks = aggregate.lanes.flatMap((lane) =>
    lane.checks.map((check) => ({
      ...check,
      name: `${lane.lane}:${check.name}`,
    })),
  )
  if (JSON.stringify(aggregate.checks) !== JSON.stringify(expectedChecks)) {
    throw new Error("aggregate smoke result checks must exactly derive from lane checks")
  }
  assertConclusion(aggregate.conclusion, "aggregate conclusion")
  assertDerivedConclusion(aggregate.checks, aggregate.conclusion, "aggregate smoke result")
  assertCanonicalByteLength(aggregate, "Aggregate smoke result")
  return deepFreeze(aggregate)
}

function parseCorrelationOptions(options) {
  let value
  try {
    value = snapshotJson(options)
  } catch (error) {
    throw new TypeError("Invalid smoke correlation options", { cause: error })
  }
  assertRecord(value, "smoke correlation options")
  assertExactFields(
    value,
    ["version", "commitSha", "manifestSha256", "workflowRunId", "runAttempt"],
    "smoke correlation options",
  )
  assertIdentity(value)
  assertPositiveInteger(value.workflowRunId, "workflowRunId")
  assertPositiveInteger(value.runAttempt, "runAttempt")
  return deepFreeze(value)
}

function assertSchemaAndIdentity(value) {
  if (value.schemaVersion !== SMOKE_RESULT_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${SMOKE_RESULT_SCHEMA_VERSION}`)
  }
  assertIdentity(value)
}

function assertIdentity(value) {
  if (!isExactSemver(value.version)) throw new Error("version must be an exact SemVer")
  if (typeof value.commitSha !== "string" || !SHA_PATTERN.test(value.commitSha)) {
    throw new Error("commitSha must be a 40-character lowercase hexadecimal SHA")
  }
  if (typeof value.manifestSha256 !== "string" || !SHA256_PATTERN.test(value.manifestSha256)) {
    throw new Error("manifestSha256 must be a 64-character lowercase hexadecimal digest")
  }
}

function validateChecks(checks, label, maximum = MAX_CHECKS_PER_LANE, maximumNameLength = 128) {
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > maximum) {
    throw new Error(`${label} must contain 1 to at most ${maximum} checks`)
  }
  const names = new Set()
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index]
    const checkLabel = `${label}[${index}]`
    assertRecord(check, checkLabel)
    assertExactFields(check, CHECK_FIELDS, checkLabel)
    if (
      typeof check.name !== "string" ||
      check.name.length === 0 ||
      Buffer.byteLength(check.name, "utf8") > maximumNameLength
    ) {
      throw new Error(`${checkLabel}.name must be a non-empty bounded string`)
    }
    if (names.has(check.name)) throw new Error(`${label} contains duplicate check ${check.name}`)
    names.add(check.name)
    assertConclusion(check.conclusion, `${checkLabel}.conclusion`)
    if (typeof check.detail !== "string" || Buffer.byteLength(check.detail, "utf8") > 8_192) {
      throw new Error(`${checkLabel}.detail must be a bounded string`)
    }
  }
}

function assertDerivedConclusion(checks, conclusion, label) {
  const expected = derivedConclusion(checks)
  if (conclusion !== expected) {
    throw new Error(`${label} conclusion ${conclusion} hides a failed check`)
  }
}

function derivedConclusion(checks) {
  return checks.every((check) => check.conclusion === "success") ? "success" : "failure"
}

function assertTimestamps(startedAt, finishedAt, prefix = "") {
  assertTimestamp(startedAt, prefix ? `${prefix}.startedAt` : "startedAt")
  assertTimestamp(finishedAt, prefix ? `${prefix}.finishedAt` : "finishedAt")
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error(`${prefix ? `${prefix}.` : ""}finishedAt must not precede startedAt`)
  }
}

function assertTimestamp(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`)
  }
}

function assertLane(value, label) {
  if (typeof value !== "string" || !LANE_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase lane identifier`)
  }
}

function assertConclusion(value, label) {
  if (!CONCLUSIONS.has(value)) throw new Error(`${label} must be success or failure`)
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
}

function assertRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    const unexpected = actual.filter((field) => !expected.includes(field))
    const missing = expected.filter((field) => !actual.includes(field))
    throw new Error(
      `${label} fields must be exact${unexpected.length ? `; unexpected: ${unexpected.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`,
    )
  }
}

function canonicalBytes(value, label) {
  const bytes = Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`, "utf8")
  if (bytes.length > MAX_CANONICAL_BYTES) {
    throw new Error(`${label} exceeds its ${MAX_CANONICAL_BYTES}-byte limit`)
  }
  return bytes
}

function assertCanonicalByteLength(value, label) {
  canonicalBytes(value, label)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

function assertCheckDefinition(name, detail, run, names) {
  if (typeof name !== "string" || name.length === 0 || Buffer.byteLength(name, "utf8") > 128) {
    throw new Error("Smoke check name must be a non-empty bounded string")
  }
  if (names.has(name)) throw new Error(`Duplicate smoke check ${name}`)
  if (typeof detail !== "string" || Buffer.byteLength(detail, "utf8") > 8_192) {
    throw new Error("Smoke check detail must be a bounded string")
  }
  if (typeof run !== "function") throw new TypeError(`Smoke check ${name} must be executable`)
  names.add(name)
}

function environmentPositiveInteger(value, name) {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== String(value)) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return parsed
}

function clockTimestamp(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error("Smoke lane clock returned an invalid time")
  return date.toISOString()
}

export function formatSmokeError(error) {
  let detail
  try {
    detail = error instanceof Error ? error.message : String(error)
  } catch {
    detail = "Smoke operation failed with an unprintable error"
  }
  detail = detail
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, "$1[redacted]@")
    .replace(/\b(?:npm_[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_-]+|Bearer\s+\S+)\b/gu, "[redacted]")
  detail = replaceControlCharacters(detail)
  detail = detail.replace(/\s+/gu, " ").trim()
  return truncateUtf8(detail || "Smoke operation failed", 4_096)
}

function replaceControlCharacters(value) {
  let output = ""
  for (const character of value) {
    const code = character.codePointAt(0)
    output +=
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
        ? " "
        : character
  }
  return output
}

function truncateUtf8(value, maximumBytes) {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value
  const suffix = "…"
  const limit = maximumBytes - Buffer.byteLength(suffix, "utf8")
  let output = ""
  let length = 0
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8")
    if (length + bytes > limit) break
    output += character
    length += bytes
  }
  return `${output}${suffix}`
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
