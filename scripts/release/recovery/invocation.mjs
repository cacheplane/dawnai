// Trusted read boundaries: environment supplies lookup hints, never numeric job proof.
import { classifyGitHubResponse } from "../adapters/github.mjs"
import { createHttpGet } from "../adapters/http.mjs"
import { RECOVERY_RETRY, recoveryMethods, runRecoveryRead } from "./policy.mjs"
import { snapshotRecoveryData } from "./schema.mjs"

const OWNER_WORKFLOW = ".github/workflows/release-postpublication.yml"
const AUDIT_WORKFLOW = ".github/workflows/release-postpublication-audit.yml"
const OWNER_JOBS = new Set([
  "recovery-admit",
  "recovery-adopt",
  "recovery-metadata",
  "recovery-published-harness",
  "recovery-runtime-targets",
  "recovery-scaffold",
  "recovery-storage",
  "recovery-evidence",
  "recovery-dispatch-audit",
  "recovery-audit-evidence",
  "recovery-finalize",
  "recovery-publish",
  "recovery-report",
])
function requireThat(value, message) {
  if (!value) throw new TypeError(`Recovery read blocked: ${message}`)
}
export function recoveryId(value) {
  requireThat(
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ||
      (typeof value === "string" && /^[1-9][0-9]{0,31}$/u.test(value)),
    "canonical positive ID required",
  )
  return String(value)
}
function repositoryIdentity(value, repository, repositoryId) {
  requireThat(
    value && value.full_name === repository && recoveryId(value.id) === repositoryId,
    "repository identity mismatch",
  )
}
// One deadline includes all nested reads. Each bounded HTTP request sees the caller's signal.
export function recoveryReadBudget(
  { signal, timeoutMs = RECOVERY_RETRY.readTimeoutMs } = {},
  now = Date.now,
  maximumMs = RECOVERY_RETRY.fenceFreshnessMs,
) {
  requireThat(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000,
    "bounded timeout required",
  )
  const started = now()
  requireThat(Number.isSafeInteger(started) && started >= 0, "clock required")
  const deadline = started + Math.min(timeoutMs, maximumMs)
  let previous = started
  const options = () => {
    const at = now()
    requireThat(
      Number.isSafeInteger(at) && at >= previous && at < deadline && signal?.aborted !== true,
      "read deadline or cancellation",
    )
    previous = at
    return { ...(signal ? { signal } : {}), timeoutMs: deadline - at }
  }
  return { started, deadline, options }
}
export function createRecoveryInvocationReader({
  env,
  github,
  expectedJobName,
  now = Date.now,
  sleep = recoverySleep,
}) {
  requireThat(
    OWNER_JOBS.has(expectedJobName) || expectedJobName === "recovery-audit",
    "permitted recovery job display name required",
  )
  const workflow = expectedJobName === "recovery-audit" ? AUDIT_WORKFLOW : OWNER_WORKFLOW
  // Snapshot only explicit identity hints; never capture token-bearing process.env wholesale.
  const hints = Object.fromEntries(
    [
      "GITHUB_SHA",
      "GITHUB_REF",
      "GITHUB_REPOSITORY",
      "GITHUB_REPOSITORY_ID",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_WORKFLOW_REF",
    ].map((key) => [key, env[key]]),
  )
  const context = snapshotRecoveryData(hints, 16384)
  const reads = recoveryMethods(github, [
    "getRepository",
    "getActionsRunAttempt",
    "getWorkflowById",
    "listActionsRunJobsComplete",
  ])
  return {
    async readInvocation(_request = {}, options = {}) {
      const budget = recoveryReadBudget(options, now)
      const read = async (name, args = {}) => {
        const result = await runRecoveryAdapterRead(
          budget,
          (options) => reads[name](args, options),
          { now, sleep },
        )
        budget.options()
        requireThat(result.status === "PRESENT", `${name} unavailable`)
        return snapshotRecoveryData(result.value, 4 * 1024 * 1024)
      }
      const runId = recoveryId(context.GITHUB_RUN_ID),
        runAttempt = recoveryId(context.GITHUB_RUN_ATTEMPT),
        repositoryId = recoveryId(context.GITHUB_REPOSITORY_ID)
      const repository = context.GITHUB_REPOSITORY
      requireThat(
        typeof repository === "string" && /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(repository),
        "repository hint required",
      )
      requireThat(
        typeof context.GITHUB_SHA === "string" && /^[a-f0-9]{40}$/u.test(context.GITHUB_SHA),
        "SHA hint required",
      )
      const repo = await read("getRepository")
      repositoryIdentity(repo, repository, repositoryId)
      requireThat(
        repo.default_branch === "main" && context.GITHUB_REF === "refs/heads/main",
        "default branch/ref mismatch",
      )
      requireThat(
        context.GITHUB_WORKFLOW_REF === `${repository}/${workflow}@refs/heads/main`,
        "workflow ref mismatch",
      )
      const run = await read("getActionsRunAttempt", { runId, attempt: runAttempt })
      repositoryIdentity(run.repository, repository, repositoryId)
      requireThat(
        recoveryId(run.id) === runId &&
          recoveryId(run.run_attempt) === runAttempt &&
          run.head_sha === context.GITHUB_SHA &&
          run.head_branch === repo.default_branch &&
          run.path === workflow &&
          run.event === "workflow_dispatch" &&
          run.status === "in_progress",
        "run identity mismatch",
      )
      const workflowId = recoveryId(run.workflow_id)
      const actualWorkflow = await read("getWorkflowById", { workflowId })
      requireThat(
        recoveryId(actualWorkflow.id) === workflowId &&
          actualWorkflow.path === workflow &&
          actualWorkflow.state === "active",
        "workflow identity mismatch",
      )
      const jobs = await read("listActionsRunJobsComplete", { runId })
      requireThat(Array.isArray(jobs), "complete jobs required")
      const matches = jobs.filter(
        (job) =>
          recoveryId(job.runAttempt) === runAttempt &&
          job.name === expectedJobName &&
          job.status === "in_progress",
      )
      requireThat(matches.length === 1, "exact current executing job required")
      const job = matches[0]
      requireThat(
        recoveryId(job.run_id) === runId && job.head_sha === context.GITHUB_SHA,
        "job source identity mismatch",
      )
      return {
        sha: context.GITHUB_SHA,
        ref: context.GITHUB_REF,
        workflow,
        runId,
        runAttempt,
        jobId: recoveryId(job.id),
        repository,
        repositoryId,
        defaultBranch: repo.default_branch,
      }
    },
  }
}

// Expects a separately provisioned Administration(read) credential, confined to these GETs.
// Deliberately do not return the generic GitHub reader or any HTTP primitive.
export function createRecoveryImmutablePolicyReader({
  owner,
  repo,
  repositoryId,
  token,
  fetchImpl = fetch,
  timeoutMs = RECOVERY_RETRY.readTimeoutMs,
  maxResponseBytes = 65536,
  now = Date.now,
  sleep = recoverySleep,
}) {
  requireThat(
    typeof owner === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(owner) &&
      typeof repo === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(repo),
    "repository required",
  )
  const expectedId = recoveryId(repositoryId),
    repository = `${owner}/${repo}`
  requireThat(
    typeof token === "string" &&
      token.length > 0 &&
      Buffer.byteLength(token) <= 4096 &&
      !/[\r\n]/u.test(token),
    "separate policy read credential required",
  )
  const http = createHttpGet({ fetchImpl, timeoutMs, maxResponseBytes })
  const base = `https://api.github.com/repos/${owner}/${repo}`
  return {
    async observeImmutableReleasePolicy({ candidate }, options = {}) {
      requireThat(
        candidate.repository === repository && candidate.repositoryId === expectedId,
        "candidate repository mismatch",
      )
      const budget = recoveryReadBudget(
        { ...options, timeoutMs: Math.min(options.timeoutMs ?? timeoutMs, timeoutMs) },
        now,
      )
      const get = async (suffix) => {
        const result = await runRecoveryAdapterRead(
          budget,
          async (readOptions) => {
            const response = await http.getJson({
              url: `${base}${suffix}`,
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2026-03-10",
              },
              ...readOptions,
            })
            const classified = classifyGitHubResponse(response, "immutable-policy")
            return classified.status === "PRESENT" && response.httpStatus === 200
              ? { ...classified, value: response.body }
              : {
                  ...classified,
                  ...(classified.status === "PRESENT"
                    ? { status: "ERROR", code: "UNEXPECTED_STATUS" }
                    : {}),
                }
          },
          { now, sleep },
        )
        budget.options()
        requireThat(result.status === "PRESENT", "immutable policy read unavailable")
        return result.value
      }
      repositoryIdentity(await get(""), repository, expectedId)
      const policy = await get("/immutable-releases")
      requireThat(
        policy &&
          typeof policy === "object" &&
          !Array.isArray(policy) &&
          Object.keys(policy).sort().join(" ") === "enabled enforced_by_owner" &&
          policy.enabled === true &&
          typeof policy.enforced_by_owner === "boolean",
        "immutable release policy not enabled",
      )
      return { repository, enabled: true }
    },
  }
}

export const recoverySleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))
// Keep settled transport retries inside the original observation window. An aborted
// or unsettled request is never retried; the shared policy owns this classification.
export async function runRecoveryAdapterRead(budget, operation, dependencies) {
  const result = await runRecoveryRead(
    { phaseDeadline: budget.deadline, responseBytes: 8 * 1024 * 1024 },
    async (internal) => {
      const caller = budget.options()
      const signal = caller.signal
        ? AbortSignal.any([caller.signal, internal.signal])
        : internal.signal
      return operation({ signal, timeoutMs: Math.min(caller.timeoutMs, internal.timeoutMs) })
    },
    dependencies,
  )
  budget.options()
  return result
}
