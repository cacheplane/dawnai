#!/usr/bin/env node

import { randomUUID as defaultRandomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import * as defaultFileSystem from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"

import { snapshotJson } from "./adapter-normalize.mjs"
import { assertValidReleaseInventory, readReleaseInventory } from "./inventory.mjs"
import { snapshotPlannerInput } from "./observation-schema.mjs"
import { planRelease } from "./planner.mjs"
import { isExactSemver, parseSemver } from "./semver.mjs"

const ROOT_FIELDS = Object.freeze([
  "schemaVersion",
  "candidate",
  "inventory",
  "ciReceipt",
  "prepareRun",
  "preparationAuthority",
  "sourceRef",
])
const REPORT_FIELDS = Object.freeze([
  "schemaVersion",
  "candidate",
  "before",
  "transition",
  "after",
  "diagnostics",
])
const BEFORE_FIELDS = Object.freeze(["observation", "plan"])
const TRANSITION_FIELDS = Object.freeze(["name", "status", "result", "error"])
const CANDIDATE_FIELDS = Object.freeze([
  "version",
  "commitSha",
  "ciWorkflow",
  "ciCheck",
  "publisherWorkflow",
])
const CI_FIELDS = Object.freeze([
  "status",
  "retryable",
  "commitSha",
  "workflow",
  "check",
  "runId",
  "runAttempt",
])
const RUN_FIELDS = Object.freeze(["id", "attempt"])
const AUTHORITY_FIELDS = Object.freeze(["state", "releaseRecord", "npm"])
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const MAX_CANONICAL_BYTES = 256 * 1024
const MAX_ROOT_BYTES = 4_096
const MAX_PATH_BYTES = 4_096
const MAX_REPORT_BYTES = 1024 * 1024
const OPTION_FIELDS = Object.freeze(["report", "root", "environment", "readInventory"])
const CLI_FIELDS = Object.freeze(["--report", "--root", "--output"])
const CLI_RUNTIME_FIELDS = Object.freeze([
  "environment",
  "fileSystem",
  "readInventory",
  "randomUUID",
])

export async function createPreparationHandoff(options) {
  validateOptions(options)
  const report = snapshotJson(option(options, "report"))
  const root = option(options, "root")
  const environment = option(options, "environment")
  const readInventory = optionalOption(options, "readInventory") ?? readReleaseInventory
  if (
    typeof root !== "string" ||
    Buffer.byteLength(root, "utf8") > MAX_ROOT_BYTES ||
    !path.isAbsolute(root) ||
    hasControlCharacters(root)
  ) {
    throw new TypeError("Preparation handoff root must be absolute")
  }
  if (typeof readInventory !== "function") {
    throw new TypeError("Preparation handoff inventory reader must be a function")
  }

  validateProductionReportEnvelope(report)

  const plannerInput = snapshotPlannerInput({
    candidate: report.candidate,
    observation: report.before?.observation,
    mode: "controller",
  })
  const plan = planRelease(plannerInput)
  if (
    plan.state !== "CANDIDATE_TAGGED" ||
    plan.disposition !== "would-transition" ||
    plan.nextTransition !== "prepare-artifacts"
  ) {
    throw new Error("Preparation handoff requires the candidate-tagged preparation transition")
  }
  if (!isDeepStrictEqual(report.before.plan, plan)) {
    throw new Error("Preparation handoff stored plan does not match the recomputed production plan")
  }
  const candidate = plannerInput.candidate
  const ci = plannerInput.observation.ci
  const environmentSnapshot = snapshotEnvironment(environment)
  validateEnvironment(environmentSnapshot, candidate)
  const prepareRun = {
    id: positiveEnvironmentInteger(environmentSnapshot.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
    attempt: positiveEnvironmentInteger(
      environmentSnapshot.GITHUB_RUN_ATTEMPT,
      "GITHUB_RUN_ATTEMPT",
    ),
  }
  if (prepareRun.id === ci.workflowRunId) {
    throw new Error("Preparation and CI workflow run identities must be distinct")
  }
  const inventory = snapshotJson(await readInventory({ root, ref: candidate.commitSha }))
  const validInventory = assertValidReleaseInventory(inventory)
  const observedPackages = plannerInput.observation.inventory.packages
    .map((pkg) => pkg.name)
    .sort(compareText)
  if (!arraysEqual(validInventory.packages, observedPackages)) {
    throw new Error("Preparation immutable inventory package set does not match the observation")
  }

  return parsePreparationHandoff({
    schemaVersion: 1,
    candidate,
    inventory,
    ciReceipt: {
      status: ci.status,
      retryable: false,
      commitSha: ci.commitSha,
      workflow: ci.workflow,
      check: ci.check,
      runId: ci.workflowRunId,
      runAttempt: ci.runAttempt,
    },
    prepareRun,
    preparationAuthority: {
      state: plan.state,
      releaseRecord: "absent",
      npm: "absent",
    },
    sourceRef: environmentSnapshot.GITHUB_REF,
  })
}

function validateProductionReportEnvelope(report) {
  assertRecord(report, "Production observation report")
  assertExactFields(report, REPORT_FIELDS, "Production observation report")
  if (report.schemaVersion !== 1) {
    throw new TypeError("Production observation report schemaVersion must be 1")
  }
  assertRecord(report.before, "Production observation report before snapshot")
  assertExactFields(report.before, BEFORE_FIELDS, "Production observation report before snapshot")
  assertRecord(report.transition, "Production observation report transition")
  assertExactFields(
    report.transition,
    TRANSITION_FIELDS,
    "Production observation report transition",
  )
  if (
    report.transition.name !== "prepare-artifacts" ||
    report.transition.status !== "dry-run" ||
    report.transition.result !== null ||
    report.transition.error !== null ||
    report.after !== null
  ) {
    throw new Error("Production observation report is not the exact dry preparation transition")
  }
  if (!Array.isArray(report.diagnostics) || report.diagnostics.length !== 0) {
    throw new Error("Production observation report contains diagnostics")
  }
}

function validateEnvironment(environment, candidate) {
  const expected = {
    GITHUB_REPOSITORY: "cacheplane/dawnai",
    GITHUB_REF: `refs/tags/v${candidate.version}`,
    GITHUB_SHA: candidate.commitSha,
    GITHUB_WORKFLOW_REF: `cacheplane/dawnai/.github/workflows/release.yml@refs/tags/v${candidate.version}`,
  }
  for (const [name, value] of Object.entries(expected)) {
    if (environment[name] !== value) {
      throw new Error(`Preparation handoff environment ${name} does not match the candidate`)
    }
  }
}

export function parsePreparationHandoff(value) {
  const { decoded, inputBytes } = parseInput(value)
  const handoff = snapshotJson(decoded)
  assertNoUnsafeFields(handoff, "Preparation handoff")
  assertRecord(handoff, "Preparation handoff")
  assertExactFields(handoff, ROOT_FIELDS, "Preparation handoff")
  if (handoff.schemaVersion !== 1) {
    throw new TypeError("Preparation handoff schemaVersion must be 1")
  }
  validateCandidate(handoff.candidate)
  validateInventory(handoff.inventory, handoff.candidate)
  validateCiReceipt(handoff.ciReceipt, handoff.candidate)
  validatePrepareRun(handoff.prepareRun)
  if (handoff.ciReceipt.runId === handoff.prepareRun.id) {
    throw new Error("Preparation and CI workflow run identities must be distinct")
  }
  validateAuthority(handoff.preparationAuthority)
  if (handoff.sourceRef !== `refs/tags/v${handoff.candidate.version}`) {
    throw new Error("Preparation handoff source ref does not match the candidate tag")
  }
  const canonicalBytes = encodeCanonical(handoff)
  if (inputBytes !== null && !inputBytes.equals(canonicalBytes)) {
    throw new Error("Preparation handoff bytes must be canonical")
  }
  return deepFreeze(handoff)
}

export function canonicalPreparationHandoffBytes(value) {
  return encodeCanonical(parsePreparationHandoff(value))
}

export function parsePreparationHandoffCliArguments(argv) {
  let values
  try {
    values = snapshotJson(argv)
  } catch {
    throw new TypeError("Preparation handoff CLI arguments are invalid")
  }
  if (!Array.isArray(values) || values.length !== CLI_FIELDS.length * 2) {
    throw new TypeError("Preparation handoff CLI requires exactly three path flags")
  }
  const parsed = new Map()
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index]
    const value = values[index + 1]
    if (
      !CLI_FIELDS.includes(flag) ||
      parsed.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
      hasControlCharacters(value) ||
      !path.isAbsolute(value) ||
      path.resolve(value) !== value
    ) {
      throw new TypeError("Preparation handoff CLI flag or path is invalid")
    }
    parsed.set(flag, value)
  }
  if (CLI_FIELDS.some((flag) => !parsed.has(flag))) {
    throw new TypeError("Preparation handoff CLI flags are incomplete")
  }
  const report = parsed.get("--report")
  const root = parsed.get("--root")
  const output = parsed.get("--output")
  if (report === output) {
    throw new TypeError("Preparation handoff CLI report and output paths must be distinct")
  }
  return Object.freeze({ report, root, output })
}

export async function runPreparationHandoffCli(argv, runtime = {}) {
  validateCliRuntime(runtime)
  const options = parsePreparationHandoffCliArguments(argv)
  const fileSystem = cliRuntimeOption(runtime, "fileSystem") ?? defaultFileSystem
  const environment = cliRuntimeOption(runtime, "environment") ?? process.env
  const readInventory = cliRuntimeOption(runtime, "readInventory") ?? readReleaseInventory
  const randomUUID = cliRuntimeOption(runtime, "randomUUID") ?? defaultRandomUUID
  const reportBytes = await readBoundedRegularFile(
    fileSystem,
    options.report,
    MAX_REPORT_BYTES,
    "production report",
  )
  let report
  try {
    report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reportBytes))
  } catch {
    throw new TypeError("Preparation handoff production report is not valid UTF-8 JSON")
  }
  const handoff = await createPreparationHandoff({
    report,
    root: options.root,
    environment,
    readInventory,
  })
  await writeCanonicalPreparationHandoff(options.output, handoff, {
    fileSystem,
    randomUUID,
  })
  return handoff
}

export async function writeCanonicalPreparationHandoff(target, value, runtime = {}) {
  validateCliRuntime(runtime, ["fileSystem", "randomUUID"])
  const bytes = canonicalPreparationHandoffBytes(value)
  const fileSystem = cliRuntimeOption(runtime, "fileSystem") ?? defaultFileSystem
  const randomUUID = cliRuntimeOption(runtime, "randomUUID") ?? defaultRandomUUID
  const operations = fileSystemOperations(fileSystem, ["link", "lstat", "open", "unlink"])
  if (
    typeof target !== "string" ||
    !path.isAbsolute(target) ||
    path.resolve(target) !== target ||
    path.basename(target).length === 0 ||
    Buffer.byteLength(target, "utf8") > MAX_PATH_BYTES ||
    hasControlCharacters(target) ||
    typeof randomUUID !== "function"
  ) {
    throw new TypeError("Preparation handoff output path or runtime is invalid")
  }
  const identifier = randomUUID()
  if (typeof identifier !== "string" || !/^[0-9a-f-]{36}$/u.test(identifier)) {
    throw new TypeError("Preparation handoff temporary identity is invalid")
  }
  const directory = path.dirname(target)
  const guard = await openOutputDirectory(operations, directory)
  const temporary = path.join(directory, `.${path.basename(target)}.${identifier}.tmp`)
  let temporaryCreated = false
  let linkedIdentity = null
  let primaryError = null
  try {
    await assertOutputDirectoryCurrent(operations, directory, guard.identity)
    const handle = await operations.open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    )
    temporaryCreated = true
    try {
      await handle.writeFile(bytes)
      await handle.sync()
      linkedIdentity = await handle.stat({ bigint: true })
      if (
        !linkedIdentity.isFile() ||
        linkedIdentity.nlink !== 1n ||
        linkedIdentity.size !== BigInt(bytes.byteLength)
      ) {
        throw new Error("Preparation handoff temporary output was not durably written")
      }
    } finally {
      await handle.close()
    }
    await assertOutputDirectoryCurrent(operations, directory, guard.identity)
    try {
      await operations.link(temporary, target)
      await assertLinkedOutput(operations, target, linkedIdentity, false)
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const existing = await readBoundedRegularFile(
        operations,
        target,
        MAX_CANONICAL_BYTES,
        "existing output",
      )
      if (!existing.equals(bytes)) {
        throw new Error("Existing preparation handoff output conflicts with canonical bytes")
      }
      linkedIdentity = null
    }
    await guard.handle.sync()
    await assertOutputDirectoryCurrent(operations, directory, guard.identity)
  } catch (error) {
    primaryError = error
  }
  let cleanupError = null
  if (temporaryCreated) {
    try {
      await operations.unlink(temporary)
      await guard.handle.sync()
    } catch (error) {
      cleanupError = error
    }
  }
  if (primaryError === null && cleanupError === null) {
    try {
      await assertOutputDirectoryCurrent(operations, directory, guard.identity)
      if (linkedIdentity === null) {
        const existing = await readBoundedRegularFile(
          operations,
          target,
          MAX_CANONICAL_BYTES,
          "existing output",
        )
        if (!existing.equals(bytes)) {
          throw new Error("Existing preparation handoff output changed after replay")
        }
      } else {
        await assertLinkedOutput(operations, target, linkedIdentity, true)
      }
    } catch (error) {
      primaryError = error
    }
  }
  let closeError = null
  try {
    await guard.handle.close()
  } catch (error) {
    closeError = error
  }
  const secondary = [cleanupError, closeError].filter((error) => error !== null)
  if (primaryError !== null && secondary.length > 0) {
    throw new AggregateError(
      [primaryError, ...secondary],
      "Preparation handoff write and cleanup both failed",
    )
  }
  if (primaryError !== null) throw primaryError
  if (secondary.length > 1) {
    throw new AggregateError(secondary, "Preparation handoff cleanup failed")
  }
  if (secondary.length === 1) throw secondary[0]
  return Buffer.from(bytes)
}

function validateCliRuntime(runtime, allowedFields = CLI_RUNTIME_FIELDS) {
  if (
    runtime === null ||
    typeof runtime !== "object" ||
    Array.isArray(runtime) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(runtime))
  ) {
    throw new TypeError("Preparation handoff CLI runtime is invalid")
  }
  for (const key of Reflect.ownKeys(runtime)) {
    const descriptor =
      typeof key === "string" ? Object.getOwnPropertyDescriptor(runtime, key) : undefined
    if (
      typeof key !== "string" ||
      !allowedFields.includes(key) ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError("Preparation handoff CLI runtime contains an unsafe field")
    }
  }
}

function cliRuntimeOption(runtime, name) {
  const descriptor = Object.getOwnPropertyDescriptor(runtime, name)
  if (descriptor === undefined) return undefined
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError(`Preparation handoff CLI runtime ${name} is invalid`)
  }
  return descriptor.value
}

function fileSystemOperations(fileSystem, methods) {
  if (fileSystem === null || (typeof fileSystem !== "object" && typeof fileSystem !== "function")) {
    throw new TypeError("Preparation handoff filesystem is invalid")
  }
  const operations = Object.create(null)
  for (const method of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(fileSystem, method)
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      throw new TypeError(`Preparation handoff filesystem must expose ${method}`)
    }
    operations[method] = descriptor.value.bind(fileSystem)
  }
  return Object.freeze(operations)
}

async function readBoundedRegularFile(fileSystem, filePath, maximumBytes, label) {
  const operations = fileSystemOperations(fileSystem, ["lstat", "open"])
  if (
    typeof filePath !== "string" ||
    !path.isAbsolute(filePath) ||
    path.resolve(filePath) !== filePath ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    !Number.isInteger(fsConstants.O_NOFOLLOW)
  ) {
    throw new TypeError(`Preparation handoff ${label} path or bound is invalid`)
  }
  let handle
  try {
    handle = await operations.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    if (["ELOOP", "ENOTDIR"].includes(error?.code)) {
      throw new TypeError(`Preparation handoff ${label} must be one bounded regular file`, {
        cause: error,
      })
    }
    throw error
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.nlink < 1n ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes) ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new TypeError(`Preparation handoff ${label} must be one bounded regular file`)
    }
    const bytes = Buffer.allocUnsafe(Number(before.size))
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const current = await operations.lstat(filePath, { bigint: true })
    if (
      offset !== bytes.byteLength ||
      !sameFileIdentity(before, after) ||
      current.isSymbolicLink() ||
      !sameFileIdentity(after, current)
    ) {
      throw new Error(`Preparation handoff ${label} changed while it was read`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function openOutputDirectory(fileSystem, directory) {
  const operations = fileSystemOperations(fileSystem, ["lstat", "open"])
  if (!Number.isInteger(fsConstants.O_DIRECTORY) || !Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new TypeError("Preparation handoff output-directory containment is unavailable")
  }
  let handle
  try {
    handle = await operations.open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    )
  } catch (error) {
    if (["ELOOP", "ENOTDIR"].includes(error?.code)) {
      throw new TypeError("Preparation handoff output parent must be one regular directory", {
        cause: error,
      })
    }
    throw error
  }
  try {
    const identity = await handle.stat({ bigint: true })
    if (!identity.isDirectory()) {
      throw new TypeError("Preparation handoff output parent must be one regular directory")
    }
    await assertOutputDirectoryCurrent(operations, directory, identity)
    return { handle, identity }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function assertOutputDirectoryCurrent(fileSystem, directory, expected) {
  const operations = fileSystemOperations(fileSystem, ["lstat"])
  const actual = await operations.lstat(directory, { bigint: true })
  if (
    !actual.isDirectory() ||
    actual.isSymbolicLink() ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new Error("Preparation handoff output parent changed during containment")
  }
}

async function assertLinkedOutput(fileSystem, target, expected, temporaryUnlinked) {
  const operations = fileSystemOperations(fileSystem, ["lstat"])
  const actual = await operations.lstat(target, { bigint: true })
  if (
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size ||
    (temporaryUnlinked ? actual.nlink !== 1n : actual.nlink < 2n)
  ) {
    throw new Error("Preparation handoff output changed during containment")
  }
}

function sameFileIdentity(before, after) {
  return (
    after.isFile() &&
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.size === before.size &&
    after.nlink === before.nlink &&
    after.mtimeNs === before.mtimeNs &&
    after.ctimeNs === before.ctimeNs
  )
}

function validateCandidate(candidate) {
  assertRecord(candidate, "Preparation handoff candidate")
  assertExactFields(candidate, CANDIDATE_FIELDS, "Preparation handoff candidate")
  if (
    !isExactSemver(candidate.version) ||
    parseSemver(candidate.version).build.length > 0 ||
    typeof candidate.commitSha !== "string" ||
    !SHA_PATTERN.test(candidate.commitSha) ||
    candidate.ciWorkflow !== "CI" ||
    candidate.ciCheck !== "validate" ||
    candidate.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new TypeError("Preparation handoff candidate identity is invalid")
  }
}

function validateInventory(inventory, candidate) {
  assertRecord(inventory, "Preparation handoff inventory")
  assertExactFields(inventory, ["fixedGroups", "workspacePackages"], "Preparation inventory")
  const validated = assertValidReleaseInventory(inventory)
  if (validated.version !== candidate.version) {
    throw new Error("Preparation inventory version does not match the candidate")
  }
}

function validateCiReceipt(ci, candidate) {
  assertRecord(ci, "Preparation handoff CI receipt")
  assertExactFields(ci, CI_FIELDS, "Preparation handoff CI receipt")
  if (
    ci.status !== "success" ||
    ci.retryable !== false ||
    ci.commitSha !== candidate.commitSha ||
    ci.workflow !== candidate.ciWorkflow ||
    ci.check !== candidate.ciCheck ||
    !isPositiveInteger(ci.runId) ||
    !isPositiveInteger(ci.runAttempt)
  ) {
    throw new Error("Preparation handoff CI receipt is invalid")
  }
}

function validatePrepareRun(run) {
  assertRecord(run, "Preparation handoff prepare run")
  assertExactFields(run, RUN_FIELDS, "Preparation handoff prepare run")
  if (!isPositiveInteger(run.id) || !isPositiveInteger(run.attempt)) {
    throw new TypeError("Preparation handoff run identity is invalid")
  }
}

function validateAuthority(authority) {
  assertRecord(authority, "Preparation handoff authority")
  assertExactFields(authority, AUTHORITY_FIELDS, "Preparation handoff authority")
  if (
    authority.state !== "CANDIDATE_TAGGED" ||
    authority.releaseRecord !== "absent" ||
    authority.npm !== "absent"
  ) {
    throw new Error("Preparation handoff authority is invalid")
  }
}

function snapshotEnvironment(environment) {
  if (environment === null || typeof environment !== "object") {
    throw new TypeError("Preparation handoff environment is invalid")
  }
  const output = Object.create(null)
  for (const name of [
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_WORKFLOW_REF",
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(environment, name)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      throw new TypeError(`Preparation handoff environment ${name} is invalid`)
    }
    output[name] = descriptor.value
  }
  return Object.freeze(output)
}

function positiveEnvironmentInteger(value, name) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(`Preparation handoff environment ${name} is invalid`)
  }
  const parsed = Number(value)
  if (!isPositiveInteger(parsed) || String(parsed) !== value) {
    throw new TypeError(`Preparation handoff environment ${name} is invalid`)
  }
  return parsed
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127
  })
}

function option(options, name) {
  const value = optionalOption(options, name)
  if (value === undefined) throw new TypeError(`Preparation handoff option ${name} is required`)
  return value
}

function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Preparation handoff options are invalid")
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new TypeError("Preparation handoff options must use a plain prototype")
  }
  for (const key of Reflect.ownKeys(options)) {
    const descriptor =
      typeof key === "string" ? Object.getOwnPropertyDescriptor(options, key) : undefined
    if (
      typeof key !== "string" ||
      !OPTION_FIELDS.includes(key) ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError("Preparation handoff options contain an unknown or unsafe field")
    }
  }
}

function optionalOption(options, name) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Preparation handoff options are invalid")
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, name)
  if (descriptor === undefined) return undefined
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError(`Preparation handoff option ${name} is invalid`)
  }
  return descriptor.value
}

function parseInput(value) {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) {
    return { decoded: value, inputBytes: null }
  }
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value)
  if (bytes.length < 1 || bytes.length > MAX_CANONICAL_BYTES) {
    throw new Error(`Preparation handoff exceeds its ${MAX_CANONICAL_BYTES}-byte limit`)
  }
  let source
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw new TypeError("Preparation handoff bytes must be valid UTF-8", { cause: error })
  }
  try {
    return { decoded: JSON.parse(source), inputBytes: bytes }
  } catch (error) {
    throw new TypeError("Preparation handoff must contain valid JSON", { cause: error })
  }
}

function assertRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  const actual = Object.keys(value).sort(compareText)
  const expected = [...fields].sort(compareText)
  if (!arraysEqual(actual, expected)) {
    throw new TypeError(`${label} fields must be exact`)
  }
}

function assertNoUnsafeFields(value, label) {
  if (Array.isArray(value)) {
    for (const child of value) assertNoUnsafeFields(child, label)
    return
  }
  if (value === null || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      throw new TypeError(`${label} contains an unsafe prototype field`)
    }
    assertNoUnsafeFields(child, label)
  }
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
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

function encodeCanonical(value) {
  const bytes = Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`, "utf8")
  if (bytes.length < 1 || bytes.length > MAX_CANONICAL_BYTES) {
    throw new Error(`Preparation handoff exceeds its ${MAX_CANONICAL_BYTES}-byte limit`)
  }
  return bytes
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

const executedPath =
  process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href
if (executedPath === import.meta.url) {
  try {
    await runPreparationHandoffCli(process.argv.slice(2))
  } catch {
    process.stderr.write("Preparation handoff failed\n")
    process.exitCode = 1
  }
}
