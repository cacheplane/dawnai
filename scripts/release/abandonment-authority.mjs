import { snapshotJson } from "./adapter-normalize.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "./manifest.mjs"
import { validateAllAttemptJobs } from "./metadata.mjs"
import { isExactSemver, parseSemver } from "./semver.mjs"

const REPOSITORY = "cacheplane/dawnai"
const WORKFLOW = "release.yml"
const ENVIRONMENT = "release-abandonment"
const MINIMUM_OBSERVATION_GAP_MS = 60_000
const MAX_MANAGED_RUNS = 128
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u
const PACKAGE_NAMES = Object.freeze([...CANONICAL_RELEASE_PACKAGE_ORDER].sort(compareText))

export async function captureFreshAbandonmentEvidence({
  candidate,
  packageNames,
  environment,
  github,
  npm,
  now = Date.now,
  wait = defaultWait,
}) {
  const identity = normalizeCandidate(candidate)
  assertCanonicalPackageNames(packageNames)
  const context = normalizeEnvironment(environment, identity)
  if (typeof now !== "function" || typeof wait !== "function") {
    throw new TypeError("Abandonment authority clock is invalid")
  }
  const getActionsRunAttempt = bindMethod(
    github,
    "getActionsRunAttempt",
    "GitHub abandonment reader",
  )
  const getWorkflowRunApprovals = bindMethod(
    github,
    "getWorkflowRunApprovals",
    "GitHub abandonment reader",
  )
  const listWorkflowRuns = bindMethod(github, "listWorkflowRuns", "GitHub abandonment reader")
  const listActionsRunJobs = bindMethod(github, "listActionsRunJobs", "GitHub abandonment reader")
  const observePackageVersion = bindMethod(npm, "observePackageVersion", "npm abandonment reader")

  const currentRun = normalizeCurrentRun(
    presentValue(
      await getActionsRunAttempt({ runId: context.workflowRunId, attempt: context.runAttempt }),
      "actions-run-attempt",
    ),
    { identity, context },
  )
  const approvalHistory = presentValue(
    await getWorkflowRunApprovals({ runId: context.workflowRunId }),
    "workflow-run-approvals",
  )
  const approval = normalizeApproval(approvalHistory, { context, observedAt: timestamp(now()) })
  if (
    approval.reviewerId === context.actorId ||
    approval.reviewer.toLowerCase() === context.actor.toLowerCase()
  ) {
    throw new Error("Abandonment approval must be independent from the workflow actor")
  }

  const first = await observeRegistryAbsence({
    identity,
    packageNames,
    observePackageVersion,
    context,
    now,
  })
  await wait(MINIMUM_OBSERVATION_GAP_MS)
  if (now() - Date.parse(first.observedAt) < MINIMUM_OBSERVATION_GAP_MS) {
    throw new Error("Abandonment registry observations are not separated by sixty seconds")
  }
  const second = await observeRegistryAbsence({
    identity,
    packageNames,
    observePackageVersion,
    context,
    now,
  })
  if (Date.parse(second.observedAt) - Date.parse(first.observedAt) < MINIMUM_OBSERVATION_GAP_MS) {
    throw new Error("Abandonment registry observations are not separated by sixty seconds")
  }

  const actionsHistory = await captureActionsHistory({
    identity,
    context,
    currentRun,
    listWorkflowRuns,
    listActionsRunJobs,
    now,
  })
  const recordedAt = timestamp(now())
  return deepFreeze({
    actionsHistory,
    observations: [first, second],
    approval: {
      ...approval,
      actor: context.actor,
      actorId: context.actorId,
      recordedAt,
    },
  })
}

async function observeRegistryAbsence({
  identity,
  packageNames,
  observePackageVersion,
  context,
  now,
}) {
  const packages = []
  for (const name of packageNames) {
    const result = snapshotJson(await observePackageVersion({ name, version: identity.version }))
    if (
      !isRecord(result) ||
      result.status !== "ABSENT" ||
      result.operation !== "package-version" ||
      result.httpStatus !== 404 ||
      result.code !== "E404"
    ) {
      throw new Error("Abandonment registry absence evidence is incomplete or ambiguous")
    }
    packages.push({
      name,
      version: identity.version,
      status: "ABSENT",
      httpStatus: 404,
      code: "E404",
    })
  }
  return deepFreeze({
    workflowRunId: context.workflowRunId,
    runAttempt: context.runAttempt,
    observedAt: timestamp(now()),
    packages,
  })
}

async function captureActionsHistory({
  identity,
  context,
  currentRun,
  listWorkflowRuns,
  listActionsRunJobs,
  now,
}) {
  const runs = snapshotJson(
    presentValue(
      await listWorkflowRuns({ workflow: WORKFLOW, commitSha: identity.commitSha }),
      "workflow-runs",
    ),
  )
  if (!Array.isArray(runs) || runs.length === 0 || runs.length > MAX_MANAGED_RUNS) {
    throw new Error("Abandonment Actions history is missing or unbounded")
  }
  const ids = new Set()
  let currentMatches = 0
  for (const run of runs) {
    if (
      !isRecord(run) ||
      !isPositiveInteger(run.id) ||
      !isPositiveInteger(run.run_attempt) ||
      run.head_sha !== identity.commitSha ||
      ids.has(run.id)
    ) {
      throw new Error("Abandonment Actions history contains an invalid managed run")
    }
    ids.add(run.id)
    if (run.id === currentRun.id && run.run_attempt === currentRun.run_attempt) {
      currentMatches += 1
    }
    const jobs = snapshotJson(
      presentValue(await listActionsRunJobs({ runId: run.id }), "actions-run-jobs"),
    )
    if (!Array.isArray(jobs) || jobs.length === 0 || jobs.length > 10_000) {
      throw new Error("Abandonment Actions job history is malformed or unbounded")
    }
    validateAllAttemptJobs(jobs, run.run_attempt)
  }
  if (currentMatches !== 1) {
    throw new Error("Abandonment authorizing run is absent from exact Actions history")
  }
  return deepFreeze({
    workflowRunId: context.workflowRunId,
    runAttempt: context.runAttempt,
    observedAt: timestamp(now()),
    publishJobStarted: false,
    registryMutationStarted: false,
  })
}

function normalizeCurrentRun(value, { identity, context }) {
  const run = snapshotJson(value)
  if (
    !isRecord(run) ||
    run.id !== context.workflowRunId ||
    run.run_attempt !== context.runAttempt ||
    run.run_attempt !== 1 ||
    run.event !== "workflow_dispatch" ||
    run.head_sha !== identity.commitSha ||
    !isRecord(run.actor) ||
    run.actor.id !== context.actorId ||
    run.actor.login !== context.actor
  ) {
    throw new Error("Abandonment authorizing run does not match the exact candidate environment")
  }
  return run
}

function normalizeApproval(value, { context, observedAt }) {
  const history = snapshotJson(value)
  if (!Array.isArray(history) || history.length !== 1) {
    throw new Error("Abandonment approval history must contain one exact approval")
  }
  const review = history[0]
  if (
    !isRecord(review) ||
    review.state !== "approved" ||
    !Array.isArray(review.environments) ||
    review.environments.length !== 1 ||
    !isRecord(review.environments[0]) ||
    !isPositiveInteger(review.environments[0].id) ||
    review.environments[0].name !== ENVIRONMENT ||
    !isRecord(review.user) ||
    !isPositiveInteger(review.user.id) ||
    typeof review.user.login !== "string" ||
    review.user.login.length === 0
  ) {
    throw new Error("Abandonment approval history does not prove the protected environment")
  }
  return {
    environment: ENVIRONMENT,
    environmentId: review.environments[0].id,
    reviewerId: review.user.id,
    reviewer: review.user.login,
    state: "approved",
    observedAt,
    workflowRunId: context.workflowRunId,
    runAttempt: context.runAttempt,
  }
}

function normalizeCandidate(value) {
  const candidate = snapshotJson(value)
  if (
    !isRecord(candidate) ||
    !isReleaseVersion(candidate.version) ||
    !SHA_PATTERN.test(candidate.commitSha) ||
    candidate.ciWorkflow !== "CI" ||
    candidate.ciCheck !== "validate" ||
    candidate.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new TypeError("Abandonment candidate is invalid")
  }
  return deepFreeze(candidate)
}

function normalizeEnvironment(value, candidate) {
  if (!isRecord(value)) throw new TypeError("Abandonment authority environment is invalid")
  const expected = {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REF: `refs/tags/v${candidate.version}`,
    GITHUB_SHA: candidate.commitSha,
  }
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (dataString(value, name) !== expectedValue) {
      throw new Error("Abandonment authority environment does not match the candidate")
    }
  }
  const runId = dataString(value, "GITHUB_RUN_ID")
  const actor = dataString(value, "GITHUB_ACTOR")
  const actorId = dataString(value, "GITHUB_ACTOR_ID")
  if (
    !POSITIVE_INTEGER_PATTERN.test(runId) ||
    !POSITIVE_INTEGER_PATTERN.test(actorId) ||
    !Number.isSafeInteger(Number(runId)) ||
    !Number.isSafeInteger(Number(actorId)) ||
    actor.length === 0
  ) {
    throw new Error("Abandonment authority run environment is invalid")
  }
  return deepFreeze({
    workflowRunId: Number(runId),
    runAttempt: 1,
    actor,
    actorId: Number(actorId),
  })
}

function presentValue(value, operation) {
  const result = snapshotJson(value)
  if (
    !isRecord(result) ||
    result.status !== "PRESENT" ||
    result.operation !== operation ||
    result.httpStatus !== 200 ||
    result.code !== null ||
    !Object.hasOwn(result, "value")
  ) {
    throw new Error(`Abandonment ${operation} evidence is unavailable or ambiguous`)
  }
  return result.value
}

function assertCanonicalPackageNames(value) {
  const names = snapshotJson(value)
  if (
    !Array.isArray(names) ||
    names.length !== PACKAGE_NAMES.length ||
    !names.every((name, index) => name === PACKAGE_NAMES[index])
  ) {
    throw new TypeError("Abandonment package inventory is invalid")
  }
}

function dataString(value, name) {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string"
  ) {
    throw new TypeError("Abandonment authority environment is invalid")
  }
  return descriptor.value
}

function bindMethod(value, method, label) {
  if (!isRecord(value)) throw new TypeError(`${label} is invalid`)
  const descriptor = Object.getOwnPropertyDescriptor(value, method)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    throw new TypeError(`${label} method ${method} is invalid`)
  }
  return descriptor.value.bind(value)
}

function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Abandonment authority clock is invalid")
  }
  return new Date(value).toISOString()
}

function isReleaseVersion(value) {
  return typeof value === "string" && isExactSemver(value) && parseSemver(value).build.length === 0
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function defaultWait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
