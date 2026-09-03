#!/usr/bin/env node

import { randomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import * as defaultFileSystem from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { normalizeAdapterEnvelope, snapshotJson } from "./adapter-normalize.mjs"
import { createGitReader } from "./adapters/git.mjs"
import { createGitHubReader } from "./adapters/github.mjs"
import { createNpmReader } from "./adapters/npm.mjs"
import { createCliAttestationVerifier } from "./artifact-store.mjs"
import { readBoundedFixture } from "./fixture-io.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "./limits.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "./manifest.mjs"
import {
  canonicalReleaseBody,
  isManagedReleaseForTag,
  MAX_AUDIT_ATTEMPTS,
  parseReleaseMarker,
} from "./metadata.mjs"
import { createNpmAuditVerifier } from "./npm-audit.mjs"
import {
  createProductionInventoryReader,
  observeProductionCandidate,
  validateProductionAuditRun,
} from "./observe.mjs"
import { planRelease as productionPlanRelease } from "./planner.mjs"
import { createReleasePreparationRunner } from "./process-runner.mjs"
import { isExactSemver, parseSemver } from "./semver.mjs"
import { REQUIRED_RELEASE_SMOKE_LANES } from "./smoke-result.mjs"
import { canonicalAuditResultBytes, parseAuditResult } from "./terminal-records.mjs"

const REPOSITORY = "cacheplane/dawnai"
const WORKFLOW = ".github/workflows/published-artifact-verify.yml"
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u
const MAX_PATH_BYTES = 4_096
const MAX_POLL_ATTEMPTS = 1_000
const MAX_POLL_DELAY_MS = 60_000
const MAX_POLL_TIMEOUT_MS = 30 * 60 * 1_000
const DEFAULT_POLL_ATTEMPTS = 150
const DEFAULT_POLL_DELAY_MS = 2_000
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1_000
const ARGUMENTS = new Map([
  ["--version", "version"],
  ["--commit-sha", "commitSha"],
  ["--manifest-sha256", "manifestSha256"],
  ["--result", "result"],
])

export function parseIndependentAuditArgs(argv) {
  let argumentsSnapshot
  try {
    argumentsSnapshot = snapshotJson(argv)
  } catch {
    throw new TypeError("Independent audit arguments must be a descriptor-safe array")
  }
  if (!Array.isArray(argumentsSnapshot)) {
    throw new TypeError("Independent audit arguments must be an array")
  }
  const values = Object.create(null)
  const seen = new Set()
  for (let index = 0; index < argumentsSnapshot.length; index += 1) {
    const argument = argumentsSnapshot[index]
    if (typeof argument !== "string") throw new TypeError("Independent audit argument is invalid")
    const separator = argument.indexOf("=")
    const flag = separator === -1 ? argument : argument.slice(0, separator)
    const field = ARGUMENTS.get(flag)
    if (field === undefined) throw new TypeError(`Unknown independent audit argument ${flag}`)
    if (seen.has(field)) throw new TypeError(`Duplicate independent audit argument ${flag}`)
    seen.add(field)
    const value = separator === -1 ? argumentsSnapshot[++index] : argument.slice(separator + 1)
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new TypeError(`${flag} requires a value`)
    }
    values[field] = value
  }
  if (seen.size !== ARGUMENTS.size) {
    throw new TypeError("Independent audit requires exactly four arguments")
  }
  if (!isReleaseVersion(values.version)) {
    throw new TypeError("--version must be an exact release SemVer")
  }
  if (!SHA_PATTERN.test(values.commitSha)) {
    throw new TypeError("--commit-sha must be a lowercase commit SHA")
  }
  if (!SHA256_PATTERN.test(values.manifestSha256)) {
    throw new TypeError("--manifest-sha256 must be a lowercase SHA256 digest")
  }
  if (values.result.includes("\0") || Buffer.byteLength(values.result, "utf8") > MAX_PATH_BYTES) {
    throw new TypeError("--result path is invalid")
  }
  return deepFreeze({
    version: values.version,
    commitSha: values.commitSha,
    manifestSha256: values.manifestSha256,
    result: values.result,
  })
}

export function parseIndependentAuditEnvironment(environment, options) {
  let identity
  try {
    identity = snapshotJson(options)
  } catch {
    throw new TypeError("Independent audit options are invalid")
  }
  assertOptions(identity)
  if (environment === null || Array.isArray(environment) || typeof environment !== "object") {
    throw new TypeError("Independent audit environment is invalid")
  }
  const expectedRef = `refs/tags/v${identity.version}`
  const expectedWorkflowRef = `${REPOSITORY}/${WORKFLOW}@${expectedRef}`
  const values = Object.fromEntries(
    [
      "GITHUB_REPOSITORY",
      "GITHUB_EVENT_NAME",
      "GITHUB_WORKFLOW_REF",
      "GITHUB_REF",
      "GITHUB_SHA",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
    ].map((name) => [name, environmentString(environment, name)]),
  )
  if (
    values.GITHUB_REPOSITORY !== REPOSITORY ||
    values.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    values.GITHUB_WORKFLOW_REF !== expectedWorkflowRef ||
    values.GITHUB_REF !== expectedRef ||
    values.GITHUB_SHA !== identity.commitSha
  ) {
    throw new TypeError("Independent audit GitHub invocation identity is invalid")
  }
  const workflowRunId = positiveEnvironmentId(values.GITHUB_RUN_ID, "GITHUB_RUN_ID")
  const runAttempt = positiveEnvironmentId(values.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT")
  return deepFreeze({
    repository: REPOSITORY,
    workflow: WORKFLOW,
    ref: expectedRef,
    commitSha: identity.commitSha,
    workflowRunId,
    runAttempt,
  })
}

export async function runIndependentAudit(argv, overrides = {}) {
  const options = parseIndependentAuditArgs(argv)
  const environment = overrides.environment ?? process.env
  const invocation = parseIndependentAuditEnvironment(environment, options)
  const dependencies = normalizeExecutionDependencies(overrides)
  const candidate = deepFreeze({
    version: options.version,
    commitSha: options.commitSha,
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  })
  const startedAt = timestamp(dependencies.now)
  const checks = []
  let executionError = null

  try {
    const runtime = normalizeRuntime(
      await dependencies.createRuntime({
        root: dependencies.cwd,
        environment,
        candidate,
        invocation,
      }),
    )
    const releaseMarker = await auditCheck(
      checks,
      "release-dispatch-marker",
      "The draft Release records this exact independent audit dispatch.",
      () =>
        waitForDispatchMarker({
          candidate,
          manifestSha256: options.manifestSha256,
          invocation,
          github: runtime.github,
          attempts: dependencies.pollAttempts,
          delayMs: dependencies.pollDelayMs,
          timeoutMs: dependencies.pollTimeoutMs,
          delay: dependencies.delay,
          clock: dependencies.clock,
          setTimer: dependencies.setTimer,
          clearTimer: dependencies.clearTimer,
        }),
    )
    await auditCheck(
      checks,
      "workflow-run-attempt",
      "The current GitHub run and attempt match the dispatched tag audit.",
      () =>
        readExactWorkflowAttempt({
          candidate,
          marker: releaseMarker,
          invocation,
          github: runtime.github,
        }),
    )
    const immutableInventory = await auditCheck(
      checks,
      "immutable-inventory",
      "The fixed release inventory was read from the immutable candidate commit.",
      async () =>
        validateImmutableInventory(
          await runtime.inventory.read({ ref: candidate.commitSha }),
          candidate,
        ),
    )
    const pinnedGitHub = pinAuditRunAttempt(runtime.github, { invocation })
    const observed = await auditCheck(
      checks,
      "production-observation",
      "The production observer verified the durable candidate evidence without diagnostics.",
      async () => {
        const result = snapshotJson(
          await runtime.observeProductionCandidate({
            candidate,
            inventory: immutableInventory,
            marker: runtime.controllerMarker,
            git: runtime.git,
            github: pinnedGitHub,
            npm: runtime.npm,
            npmAuditFactory: runtime.npmAuditFactory,
            attestations: runtime.attestations,
            // The audit job checks out the exact candidate tag, which predates any terminal
            // record on main; TERMINAL_RECORD_PUBLISHED_VERSION therefore cannot fire here.
            // Known limitation: this path never observes a record for the version it audits.
            terminalRecordRef: candidate.commitSha,
          }),
        )
        if (
          !isRecord(result) ||
          !hasExactFields(result, ["observation", "diagnostics"]) ||
          !Array.isArray(result.diagnostics) ||
          result.diagnostics.length !== 0
        ) {
          throw auditFailure("PRODUCTION_OBSERVATION_DIAGNOSTICS")
        }
        assertObservedAuditIdentity({
          observation: result.observation,
          candidate,
          manifestSha256: options.manifestSha256,
          invocation,
        })
        return result.observation
      },
    )
    await auditCheck(
      checks,
      "production-plan",
      "The production planner permits only completion of this release audit.",
      async () => {
        const plan = snapshotJson(
          await runtime.planRelease({ candidate, observation: observed, mode: "controller" }),
        )
        if (
          !isRecord(plan) ||
          plan.state !== "AUDIT_DISPATCHED" ||
          plan.disposition !== "would-transition" ||
          plan.nextTransition !== "complete-release-audit" ||
          !Array.isArray(plan.conflicts) ||
          plan.conflicts.length !== 0 ||
          !Array.isArray(plan.proposedMutations) ||
          plan.proposedMutations.length !== 1 ||
          !hasExactFields(plan.proposedMutations[0], ["type", "version", "commitSha"]) ||
          plan.proposedMutations[0].type !== "complete-release-audit" ||
          plan.proposedMutations[0].version !== candidate.version ||
          plan.proposedMutations[0].commitSha !== candidate.commitSha
        ) {
          throw auditFailure("PRODUCTION_PLAN_NOT_AUDIT_DISPATCHED")
        }
      },
    )
  } catch (error) {
    executionError = normalizeAuditError(error)
    if (!checks.some((check) => check.conclusion === "failure")) {
      checks.push(failedCheck("independent-audit", executionError.code))
    }
  }

  const result = parseAuditResult({
    schemaVersion: 1,
    version: candidate.version,
    commitSha: candidate.commitSha,
    manifestSha256: options.manifestSha256,
    workflowRunId: invocation.workflowRunId,
    runAttempt: invocation.runAttempt,
    startedAt,
    finishedAt: timestamp(dependencies.now),
    checks,
    conclusion: executionError === null ? "success" : "failure",
  })
  await dependencies.writeResult(path.resolve(dependencies.cwd, options.result), result)
  if (executionError !== null) throw executionError
  return result
}

async function waitForDispatchMarker({
  candidate,
  manifestSha256,
  invocation,
  github,
  attempts,
  delayMs,
  timeoutMs,
  delay,
  clock,
  setTimer,
  clearTimer,
}) {
  const deadline = boundedDeadline(clock, timeoutMs)
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const envelope = normalizeAdapterEnvelope(
      await withinDeadline(
        Promise.resolve().then(() => github.getReleaseByTag({ tag: `v${candidate.version}` })),
        deadline,
        clock,
        setTimer,
        clearTimer,
      ),
      { source: "github", operation: "release", payloadKey: "value" },
    )
    if (envelope.status === "PRESENT") {
      const marker = parseDispatchRelease(envelope.value, candidate, manifestSha256)
      if (
        marker.phase === "AUDIT_DISPATCHED" &&
        marker.audit.workflowRunId === invocation.workflowRunId &&
        marker.audit.runAttempt === null
      ) {
        return marker
      }
    } else if (!(envelope.status === "AMBIGUOUS" && envelope.httpStatus === 404)) {
      throw auditFailure("RELEASE_DISPATCH_READ_AMBIGUOUS")
    }
    if (attempt < attempts) {
      const remaining = deadline - monotonicTime(clock)
      if (remaining <= 0) break
      await withinDeadline(
        Promise.resolve().then(() => delay(Math.min(delayMs, remaining))),
        deadline,
        clock,
        setTimer,
        clearTimer,
      )
    }
  }
  throw auditFailure("AUDIT_DISPATCH_MARKER_TIMEOUT")
}

function parseDispatchRelease(value, candidate, manifestSha256) {
  const release = snapshotJson(value)
  if (
    !isRecord(release) ||
    !isPositiveInteger(release.id) ||
    release.name !== `Dawn v${candidate.version}` ||
    !isManagedReleaseForTag(release, `v${candidate.version}`) ||
    release.target_commitish !== "main" ||
    release.draft !== true ||
    release.immutable !== false ||
    release.prerelease !== false ||
    typeof release.body !== "string"
  ) {
    throw auditFailure("RELEASE_DISPATCH_IDENTITY_INVALID")
  }
  const marker = parseReleaseMarker(release.body)
  if (
    marker.version !== candidate.version ||
    marker.commitSha !== candidate.commitSha ||
    marker.tag !== `v${candidate.version}` ||
    marker.manifestSha256 !== manifestSha256 ||
    (!["SMOKES_COMPLETE", "AUDIT_DISPATCHED", "AUDIT_RETRYABLE"].includes(marker.phase) &&
      marker.phase !== "AUDIT_VERIFIED") ||
    release.body !== canonicalReleaseBody({ marker, manifest: null })
  ) {
    throw auditFailure("RELEASE_DISPATCH_MARKER_INVALID")
  }
  return marker
}

async function readExactWorkflowAttempt({ candidate, marker, invocation, github }) {
  const [runEnvelope, jobsEnvelope] = await Promise.all([
    github.getActionsRunAttempt({
      runId: invocation.workflowRunId,
      attempt: invocation.runAttempt,
    }),
    github.listActionsRunJobs({ runId: invocation.workflowRunId }),
  ])
  const run = normalizeAdapterEnvelope(runEnvelope, {
    source: "github",
    operation: "actions-run-attempt",
    payloadKey: "value",
  })
  const jobs = normalizeAdapterEnvelope(jobsEnvelope, {
    source: "github",
    operation: "actions-run-jobs",
    payloadKey: "value",
  })
  if (run.status !== "PRESENT" || jobs.status !== "PRESENT" || !Array.isArray(jobs.value)) {
    throw auditFailure("AUDIT_RUN_ATTEMPT_READ_AMBIGUOUS")
  }
  if (run.value.run_attempt !== invocation.runAttempt) {
    throw auditFailure("AUDIT_RUN_ATTEMPT_IDENTITY_MISMATCH")
  }
  validateProductionAuditRun({
    value: run.value,
    jobs: jobs.value.filter((job) => job?.runAttempt <= invocation.runAttempt),
    candidate,
    marker,
  })
  return deepFreeze({ runEnvelope: run, jobsEnvelope: jobs })
}

function validateImmutableInventory(value, candidate) {
  const inventory = snapshotJson(value)
  const expectedNames = [...CANONICAL_RELEASE_PACKAGE_ORDER].sort(compareText)
  if (
    !hasExactFields(inventory, ["status", "packages"]) ||
    inventory.status !== "valid" ||
    !Array.isArray(inventory.packages) ||
    inventory.packages.length !== expectedNames.length
  ) {
    throw auditFailure("IMMUTABLE_INVENTORY_INVALID")
  }
  const names = []
  for (const pkg of inventory.packages) {
    if (
      !hasExactFields(pkg, ["name", "version"]) ||
      typeof pkg.name !== "string" ||
      pkg.version !== candidate.version
    ) {
      throw auditFailure("IMMUTABLE_INVENTORY_INVALID")
    }
    names.push(pkg.name)
  }
  if (!arraysEqual(names, expectedNames)) {
    throw auditFailure("IMMUTABLE_INVENTORY_INVALID")
  }
  return deepFreeze(inventory)
}

function assertObservedAuditIdentity({ observation, candidate, manifestSha256, invocation }) {
  if (!isRecord(observation)) throw auditFailure("PRODUCTION_OBSERVATION_INVALID")
  const release = observation.release
  const marker = release?.marker
  const audit = observation.audit
  if (
    observation.tag?.status !== "present" ||
    observation.tag?.commitSha !== candidate.commitSha ||
    release?.status !== "draft" ||
    release?.tag !== `v${candidate.version}` ||
    release?.commitSha !== candidate.commitSha ||
    release?.immutable !== false ||
    marker?.phase !== "AUDIT_DISPATCHED" ||
    marker?.manifestSha256 !== manifestSha256 ||
    marker?.version !== candidate.version ||
    marker?.commitSha !== candidate.commitSha ||
    marker?.tag !== `v${candidate.version}` ||
    marker?.audit?.workflow !== WORKFLOW ||
    marker?.audit?.workflowRunId !== invocation.workflowRunId ||
    marker?.audit?.runAttempt !== null ||
    audit?.status !== "dispatched" ||
    audit?.version !== candidate.version ||
    audit?.commitSha !== candidate.commitSha ||
    audit?.manifestSha256 !== manifestSha256 ||
    audit?.workflowRunId !== invocation.workflowRunId ||
    audit?.runAttempt !== invocation.runAttempt ||
    audit?.conclusion !== null ||
    !arraysEqual(observation.requiredSmokeLanes, REQUIRED_RELEASE_SMOKE_LANES) ||
    !Array.isArray(observation.smokes) ||
    observation.smokes.length !== REQUIRED_RELEASE_SMOKE_LANES.length ||
    observation.smokes.some(
      (smoke, index) =>
        smoke?.name !== REQUIRED_RELEASE_SMOKE_LANES[index] ||
        smoke.status !== "passed" ||
        smoke.version !== candidate.version ||
        smoke.commitSha !== candidate.commitSha ||
        smoke.manifestSha256 !== manifestSha256 ||
        !isPositiveInteger(smoke.workflowRunId) ||
        !isPositiveInteger(smoke.runAttempt),
    )
  ) {
    throw auditFailure("PRODUCTION_OBSERVATION_IDENTITY_MISMATCH")
  }
}

function pinAuditRunAttempt(github, { invocation }) {
  const pinned = Object.create(null)
  for (const key of Reflect.ownKeys(github)) {
    if (typeof key !== "string") throw new TypeError("Independent audit GitHub reader is invalid")
    const descriptor = Object.getOwnPropertyDescriptor(github, key)
    if (descriptor?.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError("Independent audit GitHub reader is invalid")
    }
    pinned[key] =
      typeof descriptor.value === "function" ? descriptor.value.bind(github) : descriptor.value
  }
  pinned.getActionsRun = async ({ runId }) => {
    if (String(runId) === String(invocation.workflowRunId)) {
      const exact = normalizeAdapterEnvelope(
        await github.getActionsRunAttempt({
          runId: invocation.workflowRunId,
          attempt: invocation.runAttempt,
        }),
        { source: "github", operation: "actions-run-attempt", payloadKey: "value" },
      )
      return { ...exact, operation: "actions-run" }
    }
    if (typeof github.getActionsRun !== "function") {
      throw auditFailure("GITHUB_READER_METHOD_UNAVAILABLE")
    }
    return github.getActionsRun({ runId })
  }
  if (typeof github.listActionsRunJobs === "function") {
    pinned.listActionsRunJobs = async ({ runId }) => {
      const value = await github.listActionsRunJobs({ runId })
      if (String(runId) !== String(invocation.workflowRunId)) return value
      const envelope = normalizeAdapterEnvelope(value, {
        source: "github",
        operation: "actions-run-jobs",
        payloadKey: "value",
      })
      if (envelope.status !== "PRESENT" || !Array.isArray(envelope.value)) return envelope
      return {
        ...envelope,
        value: envelope.value.filter((job) => job?.runAttempt <= invocation.runAttempt),
      }
    }
  }
  return Object.freeze(pinned)
}

async function auditCheck(checks, name, successDetail, operation) {
  try {
    const value = await operation()
    checks.push({ name, conclusion: "success", detail: successDetail })
    return value
  } catch (error) {
    const failure = normalizeAuditError(error)
    checks.push(failedCheck(name, failure.code))
    throw failure
  }
}

function failedCheck(name, code) {
  return {
    name,
    conclusion: "failure",
    detail: `Independent audit check failed (${safeAuditCode(code)}).`,
  }
}

function normalizeAuditError(error) {
  if (error instanceof IndependentAuditError) return error
  return auditFailure("INDEPENDENT_AUDIT_FAILED")
}

class IndependentAuditError extends Error {
  constructor(code) {
    super(`Independent audit failed (${code})`)
    this.name = "IndependentAuditError"
    this.code = code
  }
}

function auditFailure(code) {
  return new IndependentAuditError(safeAuditCode(code))
}

function safeAuditCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(value)
    ? value
    : "INDEPENDENT_AUDIT_FAILED"
}

function normalizeExecutionDependencies(overrides) {
  if (overrides === null || Array.isArray(overrides) || typeof overrides !== "object") {
    throw new TypeError("Independent audit dependencies are invalid")
  }
  const cwd = overrides.cwd ?? process.cwd()
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0")) {
    throw new TypeError("Independent audit root is invalid")
  }
  const dependencies = {
    cwd,
    createRuntime: overrides.createRuntime ?? createDefaultRuntime,
    now: overrides.now ?? (() => new Date()),
    clock: overrides.clock ?? Date.now,
    delay: overrides.delay ?? defaultDelay,
    setTimer: overrides.setTimer ?? setTimeout,
    clearTimer: overrides.clearTimer ?? clearTimeout,
    pollAttempts: overrides.pollAttempts ?? DEFAULT_POLL_ATTEMPTS,
    pollDelayMs: overrides.pollDelayMs ?? DEFAULT_POLL_DELAY_MS,
    pollTimeoutMs: overrides.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    writeResult:
      overrides.writeResult ??
      ((resultPath, result) => writeCanonicalAuditResult(resultPath, result)),
  }
  for (const name of [
    "createRuntime",
    "now",
    "clock",
    "delay",
    "setTimer",
    "clearTimer",
    "writeResult",
  ]) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`Independent audit dependency ${name} is invalid`)
    }
  }
  assertBoundedInteger(
    dependencies.pollAttempts,
    1,
    MAX_POLL_ATTEMPTS,
    "Independent audit poll attempts",
  )
  assertBoundedInteger(
    dependencies.pollDelayMs,
    0,
    MAX_POLL_DELAY_MS,
    "Independent audit poll delay",
  )
  assertBoundedInteger(
    dependencies.pollTimeoutMs,
    1,
    MAX_POLL_TIMEOUT_MS,
    "Independent audit poll timeout",
  )
  return Object.freeze(dependencies)
}

function normalizeRuntime(value) {
  if (!isRecord(value)) throw new TypeError("Independent audit runtime is invalid")
  requiredMethod(value.inventory, "read", "inventory reader")
  for (const method of ["getReleaseByTag", "getActionsRunAttempt", "listActionsRunJobs"]) {
    requiredMethod(value.github, method, "GitHub reader")
  }
  requiredMethod(value, "observeProductionCandidate", "production observer")
  const plan = value.planRelease ?? productionPlanRelease
  if (typeof plan !== "function") throw new TypeError("Independent audit planner is invalid")
  return Object.freeze({ ...value, planRelease: plan })
}

async function createDefaultRuntime(input) {
  return createIndependentAuditRuntime(input)
}

export async function createIndependentAuditRuntime(input, overrides = {}) {
  if (!isRecord(input) || !isRecord(overrides)) {
    throw new TypeError("Independent audit runtime inputs are invalid")
  }
  const { root, environment, candidate, invocation } = input
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    !isCandidate(candidate) ||
    !isInvocation(invocation, candidate)
  ) {
    throw new TypeError("Independent audit runtime identity is invalid")
  }
  const token = environmentString(environment, "GITHUB_TOKEN")
  const repositoryId = environmentString(environment, "GITHUB_REPOSITORY_ID")
  if (token.length > 4_096 || /[\r\n]/u.test(token)) {
    throw new TypeError("Independent audit GitHub token is invalid")
  }
  const dependencies = {
    createGitReader: overrides.createGitReader ?? createGitReader,
    createGitHubReader: overrides.createGitHubReader ?? createGitHubReader,
    createNpmReader: overrides.createNpmReader ?? createNpmReader,
    createAttestationVerifier: overrides.createAttestationVerifier ?? createCliAttestationVerifier,
    createInventoryReader: overrides.createInventoryReader ?? createProductionInventoryReader,
    readControllerMarker: overrides.readControllerMarker ?? defaultReadControllerMarker,
    observeProductionCandidate: overrides.observeProductionCandidate ?? observeProductionCandidate,
    planRelease: overrides.planRelease ?? productionPlanRelease,
    createRunner: overrides.createRunner ?? createReleasePreparationRunner,
    createNpmAuditVerifier: overrides.createNpmAuditVerifier ?? createNpmAuditVerifier,
    fileSystem: overrides.fileSystem ?? defaultFileSystem,
  }
  for (const name of [
    "createGitReader",
    "createGitHubReader",
    "createNpmReader",
    "createAttestationVerifier",
    "createInventoryReader",
    "readControllerMarker",
    "observeProductionCandidate",
    "planRelease",
    "createRunner",
    "createNpmAuditVerifier",
  ]) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`Independent audit runtime dependency ${name} is invalid`)
    }
  }

  const git = dependencies.createGitReader({ root })
  const github = dependencies.createGitHubReader({
    owner: "cacheplane",
    repo: "dawnai",
    repositoryId,
    token,
    maxResponseBytes: RELEASE_PAYLOAD_LIMITS.actionsArchiveBytes,
  })
  const npm = dependencies.createNpmReader({
    maxResponseBytes: RELEASE_PAYLOAD_LIMITS.tarballBytes,
  })
  const attestations = dependencies.createAttestationVerifier({
    repository: REPOSITORY,
    token,
    fileSystem: dependencies.fileSystem,
  })
  const inventory = dependencies.createInventoryReader({ root, git })
  const controllerMarker = await dependencies.readControllerMarker({
    root,
    fileSystem: dependencies.fileSystem,
  })
  const npmAuditFactory = Object.freeze({
    create() {
      return dependencies.createNpmAuditVerifier({
        runNpm: dependencies.createRunner(),
        environment,
        signal: new AbortController().signal,
      })
    },
  })
  return Object.freeze({
    git,
    github,
    npm,
    npmAuditFactory,
    attestations,
    inventory,
    controllerMarker,
    observeProductionCandidate: dependencies.observeProductionCandidate,
    planRelease: dependencies.planRelease,
  })
}

async function defaultReadControllerMarker({ root }) {
  const source = await readBoundedFixture(
    path.join(root, "scripts/release/controller-schema.json"),
    {
      root,
      maxBytes: 64 * 1024,
    },
  )
  try {
    return JSON.parse(source)
  } catch {
    throw new TypeError("Independent audit controller marker is invalid")
  }
}

export async function writeCanonicalAuditResult(resultPath, value, overrides = {}) {
  if (
    typeof resultPath !== "string" ||
    resultPath.length === 0 ||
    !path.isAbsolute(resultPath) ||
    resultPath.includes("\0") ||
    Buffer.byteLength(resultPath, "utf8") > MAX_PATH_BYTES
  ) {
    throw new TypeError("Independent audit result path is invalid")
  }
  const bytes = canonicalAuditResultBytes(value)
  const fileSystem = { ...defaultFileSystem, ...overrides }
  const directory = path.dirname(resultPath)
  await fileSystem.mkdir(directory, { recursive: true })
  const directoryGuard = await openResultDirectory(fileSystem, directory)
  const temporary = path.join(
    directory,
    `.${path.basename(resultPath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let temporaryCreated = false
  let primaryError = null
  try {
    await assertResultDirectoryCurrent(fileSystem, directory, directoryGuard.identity)
    const handle = await fileSystem.open(
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
    } finally {
      await handle.close()
    }
    await assertResultDirectoryCurrent(fileSystem, directory, directoryGuard.identity)
    try {
      await fileSystem.link(temporary, resultPath)
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const existing = await readExistingResult(
        fileSystem,
        resultPath,
        RELEASE_PAYLOAD_LIMITS.auditReceiptBytes,
      )
      if (!existing.equals(bytes)) {
        throw new Error("Existing independent audit result conflicts with canonical bytes")
      }
    }
    await directoryGuard.handle.sync()
    await assertResultDirectoryCurrent(fileSystem, directory, directoryGuard.identity)
  } catch (error) {
    primaryError = error
  }
  let cleanupError = null
  if (temporaryCreated) {
    try {
      await fileSystem.unlink(temporary)
    } catch (error) {
      cleanupError = error
    }
  }
  let directoryCloseError = null
  try {
    await directoryGuard.handle.close()
  } catch (error) {
    directoryCloseError = error
  }
  const secondaryErrors = [cleanupError, directoryCloseError].filter((error) => error !== null)
  if (primaryError !== null && secondaryErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...secondaryErrors],
      "Independent audit result write and cleanup both failed",
    )
  }
  if (secondaryErrors.length > 1) {
    throw new AggregateError(secondaryErrors, "Independent audit result cleanup failed")
  }
  if (primaryError !== null) throw primaryError
  if (secondaryErrors.length === 1) throw secondaryErrors[0]
  return Buffer.from(bytes)
}

async function openResultDirectory(fileSystem, directory) {
  const before = await fileSystem.lstat(directory, { bigint: true })
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("Independent audit result directory is unsafe")
  }
  const handle = await fileSystem.open(
    directory,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
  )
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isDirectory() || before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error("Independent audit result directory changed while it was opened")
    }
    return { handle, identity: { dev: opened.dev, ino: opened.ino } }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function assertResultDirectoryCurrent(fileSystem, directory, identity) {
  const current = await fileSystem.lstat(directory, { bigint: true })
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  ) {
    throw new Error("Independent audit result directory changed during the write")
  }
}

async function readExistingResult(fileSystem, resultPath, expectedMaximum) {
  const handle = await fileSystem.open(
    resultPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  )
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size < 1n || before.size > BigInt(expectedMaximum)) {
      throw new Error("Existing independent audit result is not a bounded regular file")
    }
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      if (before[field] !== after[field]) {
        throw new Error("Existing independent audit result changed while it was read")
      }
    }
    return Buffer.from(bytes)
  } finally {
    await handle.close()
  }
}

function boundedDeadline(clock, timeoutMs) {
  const now = monotonicTime(clock)
  const deadline = now + timeoutMs
  if (!Number.isSafeInteger(deadline)) throw new TypeError("Independent audit deadline is invalid")
  return deadline
}

async function withinDeadline(promise, deadline, clock, setTimer, clearTimer) {
  const remaining = deadline - monotonicTime(clock)
  if (remaining <= 0) throw auditFailure("AUDIT_DISPATCH_MARKER_TIMEOUT")
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimer(() => reject(auditFailure("AUDIT_DISPATCH_MARKER_TIMEOUT")), remaining)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimer(timer)
  }
}

function monotonicTime(clock) {
  const value = clock()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Independent audit clock is invalid")
  }
  return value
}

function timestamp(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError("Independent audit clock is invalid")
  return date.toISOString()
}

function defaultDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function requiredMethod(value, name, label) {
  if (typeof value?.[name] !== "function") {
    throw new TypeError(`Independent audit ${label} method ${name} is invalid`)
  }
}

function assertBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid`)
  }
}

function hasExactFields(value, fields) {
  return (
    isRecord(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  )
}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object"
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function isCandidate(value) {
  return (
    hasExactFields(value, ["version", "commitSha", "ciWorkflow", "ciCheck", "publisherWorkflow"]) &&
    isReleaseVersion(value.version) &&
    SHA_PATTERN.test(value.commitSha) &&
    value.ciWorkflow === "CI" &&
    value.ciCheck === "validate" &&
    value.publisherWorkflow === ".github/workflows/release.yml"
  )
}

function isInvocation(value, candidate) {
  return (
    hasExactFields(value, [
      "repository",
      "workflow",
      "ref",
      "commitSha",
      "workflowRunId",
      "runAttempt",
    ]) &&
    value.repository === REPOSITORY &&
    value.workflow === WORKFLOW &&
    value.ref === `refs/tags/v${candidate.version}` &&
    value.commitSha === candidate.commitSha &&
    isPositiveInteger(value.workflowRunId) &&
    isPositiveInteger(value.runAttempt) &&
    value.runAttempt <= MAX_AUDIT_ATTEMPTS
  )
}

function arraysEqual(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runIndependentAudit(process.argv.slice(2)).catch(() => {
    process.stderr.write("Independent release audit failed\n")
    process.exitCode = 1
  })
}

function assertOptions(value) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).length !== 4 ||
    !["version", "commitSha", "manifestSha256", "result"].every((field) =>
      Object.hasOwn(value, field),
    ) ||
    !isReleaseVersion(value.version) ||
    !SHA_PATTERN.test(value.commitSha) ||
    !SHA256_PATTERN.test(value.manifestSha256) ||
    typeof value.result !== "string" ||
    value.result.length === 0
  ) {
    throw new TypeError("Independent audit options are invalid")
  }
}

function environmentString(environment, name) {
  const descriptor = Object.getOwnPropertyDescriptor(environment, name)
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    descriptor.value.length === 0
  ) {
    throw new TypeError(`Independent audit environment ${name} is invalid`)
  }
  return descriptor.value
}

function positiveEnvironmentId(value, name) {
  if (!POSITIVE_DECIMAL_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a canonical positive integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${name} must be a canonical positive integer`)
  }
  return parsed
}

function isReleaseVersion(value) {
  return typeof value === "string" && isExactSemver(value) && parseSemver(value).build.length === 0
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
