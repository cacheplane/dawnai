// Dormant read-only admission. Dependencies are trusted read adapters, never CLI JSON.
import { createHash } from "node:crypto"
import {
  canonicalPolicyBytes,
  hashVerifierClosure,
  parseRecoveryPolicy,
  RECOVERY_POLICY_PATH,
  RECOVERY_RETRY,
  recoveryMethods,
  runRecoveryRead,
} from "./policy.mjs"
import {
  canonicalRecoveryBytes,
  parseRecovery,
  recoveryDigest,
  snapshotRecoveryData,
} from "./schema.mjs"

function requireThat(value, message) {
  if (!value) throw new TypeError(`Recovery authority blocked: ${message}`)
}
function same(a, b, message) {
  requireThat(canonicalPolicyBytes(a).equals(canonicalPolicyBytes(b)), message)
}
function exact(value, fields) {
  requireThat(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(" ") === fields.split(" ").sort().join(" "),
    "exact fields required",
  )
}
function id(value) {
  if (typeof value === "number")
    requireThat(Number.isSafeInteger(value) && value > 0, "safe API ID required")
  else
    requireThat(
      typeof value === "string" && /^[1-9][0-9]{0,31}$/u.test(value),
      "canonical API ID required",
    )
  return String(value)
}
function adapter(dependencies, name) {
  const descriptor = Object.getOwnPropertyDescriptor(dependencies, name)
  requireThat(descriptor && Object.hasOwn(descriptor, "value"), `safe ${name} adapter required`)
  return descriptor.value
}
function boundary(dependencies) {
  const callbacks = recoveryMethods(dependencies, [
    "readInvocation",
    "observeLegacyFence",
    "now",
    "sleep",
  ])
  const git = recoveryMethods(adapter(dependencies, "git"), ["showFile", "isAncestor"])
  const github = recoveryMethods(adapter(dependencies, "github"), [
    "getRef",
    "getActionsRunAttempt",
    "getWorkflow",
    "listActionsRunJobs",
    "listWorkflowRuns",
    "getCommitCheckRuns",
  ])
  const timers =
    Object.hasOwn(dependencies, "setTimer") || Object.hasOwn(dependencies, "clearTimer")
      ? recoveryMethods(dependencies, ["setTimer", "clearTimer"])
      : {}
  const readNow = callbacks.now
  let previous = -1
  const now = () => {
    const value = readNow()
    requireThat(
      Number.isSafeInteger(value) && value >= 0 && value >= previous,
      "monotonic bounded clock required",
    )
    previous = value
    return value
  }
  return { ...callbacks, ...timers, now, git, github }
}
function invocation(value, request) {
  exact(value, "sha ref workflow runId runAttempt jobId repository repositoryId defaultBranch")
  requireThat(
    /^[a-f0-9]{40}$/u.test(value.sha) && value.sha === request.expectedControllerSha,
    "actual invocation SHA must equal expected controller SHA",
  )
  requireThat(
    value.defaultBranch === "main" && value.ref === "refs/heads/main",
    "actual invocation must use main ref",
  )
  requireThat(
    value.workflow === ".github/workflows/release-postpublication.yml",
    "writer authority requires the recovery owner workflow",
  )
  same(value.repository, request.candidate.repository, "invocation repository mismatch")
  same(value.repositoryId, request.candidate.repositoryId, "invocation repository ID mismatch")
  for (const key of ["runId", "runAttempt", "jobId"])
    requireThat(id(value[key]) === value[key], "invocation IDs must be canonical strings")
}
function repository(run, candidate) {
  requireThat(
    run.repository &&
      id(run.repository.id) === candidate.repositoryId &&
      run.repository.full_name === candidate.repository,
    "API repository mismatch",
  )
  if (run.repository.default_branch !== undefined && run.repository.default_branch !== null)
    requireThat(run.repository.default_branch === "main", "default branch mismatch")
}
function apiRun(run, context, candidate) {
  repository(run, candidate)
  requireThat(
    id(run.id) === context.runId &&
      id(run.run_attempt) === context.runAttempt &&
      run.head_sha === context.sha &&
      run.head_branch === "main" &&
      run.path === context.workflow &&
      run.event === "workflow_dispatch" &&
      run.status === "in_progress",
    "actual workflow run identity mismatch",
  )
}
function apiJob(job, context) {
  return (
    id(job.id) === context.jobId &&
    id(job.runAttempt) === context.runAttempt &&
    job.status === "in_progress"
  )
}
function validateCandidate(candidate) {
  // Reuse the exact candidate schema rather than maintaining a weaker duplicate.
  parseRecovery({
    schemaVersion: 2,
    kind: "recovery-adoption-intent",
    candidate,
    policySha256: "0".repeat(64),
    legacyBodySha256: "0".repeat(64),
    legacyPhase: "NPM_COMPLETE",
    operations: ["adopt"],
  })
}
async function capture(request, dependencies) {
  request = snapshotRecoveryData(request, 16384)
  exact(request, "candidate expectedControllerSha")
  validateCandidate(request.candidate)
  requireThat(
    typeof request.expectedControllerSha === "string" &&
      /^[a-f0-9]{40}$/u.test(request.expectedControllerSha),
    "expected controller SHA required",
  )
  const deps = boundary(dependencies)
  const start = deps.now()
  requireThat(Number.isSafeInteger(start) && start >= 0, "bounded clock required")
  const phaseDeadline = start + RECOVERY_RETRY.phaseDeadlineMs
  const callbackRead = async (name, args) => {
    const result = await runRecoveryRead(
      { phaseDeadline },
      async ({ signal, timeoutMs }) => ({
        status: "PRESENT",
        value: await deps[name](args, { signal, timeoutMs }),
      }),
      deps,
    )
    requireThat(result.status === "PRESENT", `${name} unavailable`)
    return result.value
  }
  const context = snapshotRecoveryData(await callbackRead("readInvocation", {}), 16384)
  invocation(context, request)
  const read = async (name, args) => {
    const result = await runRecoveryRead({ phaseDeadline }, () => deps.github[name](args), deps)
    requireThat(
      result.status === "PRESENT" && Object.hasOwn(result, "value"),
      `${name} unavailable`,
    )
    return result.value
  }
  const gitRead = async (name, args) => {
    const result = await runRecoveryRead(
      { phaseDeadline },
      async () => ({ status: "PRESENT", value: await deps.git[name](args) }),
      deps,
    )
    requireThat(result.status === "PRESENT", `${name} unavailable`)
    return result.value
  }
  const run = await read("getActionsRunAttempt", {
    runId: context.runId,
    attempt: context.runAttempt,
  })
  apiRun(run, context, request.candidate)
  const workflow = await read("getWorkflow", { workflow: context.workflow.split("/").at(-1) })
  requireThat(
    id(workflow.id) === id(run.workflow_id) &&
      workflow.path === context.workflow &&
      workflow.state === "active",
    "API workflow mismatch",
  )
  const jobs = await read("listActionsRunJobs", { runId: context.runId })
  requireThat(
    Array.isArray(jobs) && jobs.filter((job) => apiJob(job, context)).length === 1,
    "API executing job mismatch",
  )
  const main = await read("getRef", { ref: "heads/main" })
  requireThat(
    main.ref === "refs/heads/main" &&
      main.object?.type === "commit" &&
      /^[a-f0-9]{40}$/u.test(main.object.sha),
    "main ref unavailable",
  )
  requireThat(
    (await gitRead("isAncestor", { ancestor: context.sha, descendant: main.object.sha })) === true,
    "controller is not merged on main",
  )
  const rawPolicy = await gitRead("showFile", { ref: context.sha, path: RECOVERY_POLICY_PATH })
  const policy = parseRecoveryPolicy(rawPolicy)
  requireThat(policy.status === "ADMITTED", "policy is dormant")
  const policySha256 = createHash("sha256").update(canonicalPolicyBytes(policy)).digest("hex")
  const verifierClosureSha256 = await hashVerifierClosure(
    { controllerSha: context.sha, inputs: policy.verifierClosure.inputs },
    (args) => gitRead("showFile", args),
  )
  requireThat(
    verifierClosureSha256 === policy.verifierClosure.sha256,
    "unapproved verifier closure",
  )
  const ciRuns = await read("listWorkflowRuns", {
    workflow: policy.ci.workflow.split("/").at(-1),
    commitSha: context.sha,
  })
  requireThat(Array.isArray(ciRuns), "CI runs unavailable")
  const matches = ciRuns.filter(
    (run) =>
      run.head_sha === context.sha &&
      run.head_branch === "main" &&
      run.path === policy.ci.workflow &&
      run.event === "push",
  )
  requireThat(matches.length === 1, "exact main CI run required")
  const selectedCi = matches[0]
  const ci = await read("getActionsRunAttempt", {
    runId: id(selectedCi.id),
    attempt: id(selectedCi.run_attempt),
  })
  repository(ci, request.candidate)
  for (const key of [
    "id",
    "run_attempt",
    "head_sha",
    "head_branch",
    "event",
    "path",
    "workflow_id",
    "check_suite_id",
  ])
    same(ci[key], selectedCi[key], "CI attempt identity mismatch")
  requireThat(
    ci.status === "completed" && ci.conclusion === "success",
    "successful exact-SHA main CI required",
  )
  const ciWorkflow = await read("getWorkflow", { workflow: policy.ci.workflow.split("/").at(-1) })
  requireThat(
    id(ciWorkflow.id) === id(ci.workflow_id) && ciWorkflow.path === policy.ci.workflow,
    "CI workflow identity mismatch",
  )
  const checks = await read("getCommitCheckRuns", { commitSha: context.sha })
  const ciJobs = await read("listActionsRunJobs", { runId: id(ci.id) })
  requireThat(Array.isArray(checks) && Array.isArray(ciJobs), "CI checks/jobs unavailable")
  for (const name of policy.ci.checks) {
    const matchingChecks = checks.filter(
      (check) =>
        check.name === name &&
        check.head_sha === context.sha &&
        id(check.check_suite?.id) === id(ci.check_suite_id),
    )
    const matchingJobs = ciJobs.filter(
      (job) => job.name === name && id(job.runAttempt) === id(ci.run_attempt),
    )
    requireThat(
      matchingChecks.length === 1 && matchingJobs.length === 1,
      `required CI ${name} missing or ambiguous`,
    )
    requireThat(
      id(matchingChecks[0].id) === id(matchingJobs[0].id) &&
        matchingChecks[0].app?.slug === "github-actions" &&
        matchingChecks[0].status === "completed" &&
        matchingChecks[0].conclusion === "success" &&
        matchingJobs[0].status === "completed" &&
        matchingJobs[0].conclusion === "success",
      `required CI ${name} not successful`,
    )
  }
  const executor = {
    controllerSha: context.sha,
    verifierClosureSha256,
    workflow: context.workflow,
    runId: context.runId,
    runAttempt: context.runAttempt,
    jobId: context.jobId,
  }
  const fence = snapshotRecoveryData(
    await callbackRead("observeLegacyFence", {
      candidate: request.candidate,
      executor,
      policySha256,
    }),
    128 * 1024,
  )
  validateFence(fence, request.candidate, executor, policy, deps.now())
  requireThat(deps.now() < phaseDeadline, "authority phase deadline expired")
  return {
    facts: {
      candidate: request.candidate,
      policySha256,
      executor,
      capability: {
        schemaVersion: 2,
        policySha256,
        controllerSha: context.sha,
        verifierClosureSha256,
        workflow: context.workflow,
        admission: "reviewed-main-ci",
      },
      ownership: {
        fence: "verified-exclusive",
        legacyWriters: "drained-and-rejected",
        concurrencyGroup: policy.fence.concurrencyGroup,
        candidate: request.candidate,
        controllerSha: context.sha,
      },
    },
    phaseDeadline,
    gitRead,
    fence,
    deps,
    policy,
  }
}
function validateFence(fence, candidate, executor, policy, now) {
  exact(
    fence,
    "contractSha256 candidate executor observedAt expiresAt concurrencyGroup cancelInProgress writers inventoryComplete",
  )
  same(fence.candidate, candidate, "fence candidate mismatch")
  same(fence.executor, executor, "fence executor mismatch")
  requireThat(policy.fence.contracts.includes(fence.contractSha256), "fence contract not reviewed")
  requireThat(
    Number.isSafeInteger(fence.observedAt) &&
      Number.isSafeInteger(fence.expiresAt) &&
      fence.observedAt <= now &&
      fence.expiresAt > now &&
      fence.expiresAt > fence.observedAt &&
      fence.expiresAt - fence.observedAt <= policy.retry.fenceFreshnessMs &&
      now - fence.observedAt <= policy.retry.fenceFreshnessMs,
    "fence expired or not fresh",
  )
  requireThat(
    fence.concurrencyGroup === policy.fence.concurrencyGroup &&
      fence.cancelInProgress === false &&
      fence.inventoryComplete === true,
    "complete exclusive fence required",
  )
  requireThat(
    Array.isArray(fence.writers) && fence.writers.length > 0 && fence.writers.length <= 64,
    "legacy writer inventory required",
  )
  const seen = new Set()
  for (const writer of fence.writers) {
    exact(writer, "workflow sourceSha protection proofSha256 activeRuns")
    requireThat(
      /^\.github\/workflows\/[a-z0-9_-]+\.ya?ml$/u.test(writer.workflow) &&
        /^[a-f0-9]{40}$/u.test(writer.sourceSha) &&
        /^[a-f0-9]{64}$/u.test(writer.proofSha256),
      "legacy writer proof required",
    )
    const key = `${writer.workflow}:${writer.sourceSha}`
    requireThat(!seen.has(key), "duplicate legacy writer")
    seen.add(key)
    requireThat(
      ["mutation-authority-revoked", "rejects-v2-before-mutation"].includes(writer.protection) &&
        Array.isArray(writer.activeRuns) &&
        writer.activeRuns.length === 0,
      "legacy fence revocation/rejection and drainage unproven",
    )
  }
}

// Resume eligibility deliberately does not reinterpret or reread historical adoption authority.
export async function captureRecoveryEligibility(request, dependencies) {
  const { facts } = await capture(request, dependencies)
  return immutable(facts)
}
export async function captureRecoveryAuthority(request, dependencies) {
  request = snapshotRecoveryData(request, 16384)
  exact(request, "candidate expectedControllerSha intentPath legacyBodySha256 operation")
  requireThat(
    /^scripts\/release\/recovery-adoptions\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(
      request.intentPath,
    ),
    "immutable intent path required",
  )
  requireThat(
    ["adopt", "audit", "finalize", "publish", "verify"].includes(request.operation),
    "unsupported operation",
  )
  const captured = await capture(
    { candidate: request.candidate, expectedControllerSha: request.expectedControllerSha },
    dependencies,
  )
  const { facts, gitRead } = captured
  const raw = await gitRead("showFile", {
    ref: facts.executor.controllerSha,
    path: request.intentPath,
  })
  const intent = parseRecovery(raw, {
    kind: "recovery-adoption-intent",
    candidate: request.candidate,
  })
  requireThat(
    typeof raw === "string" && canonicalRecoveryBytes(intent).equals(Buffer.from(raw)),
    "canonical immutable intent required",
  )
  same(intent.policySha256, facts.policySha256, "intent policy mismatch")
  same(intent.legacyBodySha256, request.legacyBodySha256, "legacy snapshot mismatch")
  same(
    intent.operations,
    ["adopt", "audit", "finalize", "publish", "verify"],
    "required operations missing from intent",
  )
  validateFence(
    captured.fence,
    facts.candidate,
    facts.executor,
    captured.policy,
    captured.deps.now(),
  )
  requireThat(captured.deps.now() < captured.phaseDeadline, "authority phase deadline expired")
  return immutable({
    ...facts,
    authority: {
      intent,
      intentPath: request.intentPath,
      intentSha256: recoveryDigest(intent),
      reviewedControllerSha: facts.executor.controllerSha,
    },
  })
}

function immutable(value) {
  value = snapshotRecoveryData(value)
  const freeze = (item) => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child)
      Object.freeze(item)
    }
    return item
  }
  return freeze(value)
}
