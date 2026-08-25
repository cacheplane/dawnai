import path from "node:path"
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
const OPTION_FIELDS = Object.freeze(["report", "root", "environment", "readInventory"])

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
