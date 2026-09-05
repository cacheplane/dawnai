import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { createGitHubReader } from "../adapters/github.mjs"
import { canonicalPolicyBytes, hashVerifierClosure } from "../recovery/policy.mjs"
import { canonicalRecoveryBytes } from "../recovery/schema.mjs"

const authority = await import("../recovery/authority.mjs").catch(() => ({}))
const sha = "a".repeat(40),
  mainSha = "b".repeat(40),
  candidateSha = "c".repeat(40)
const digest = "d".repeat(64),
  fenceDigest = "f".repeat(64)
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const candidate = {
  repository: "example/dawn",
  repositoryId: "1",
  version: "0.8.24",
  candidateSha,
  tag: "v0.8.24",
  tagObjectSha: "e".repeat(40),
  releaseId: "2",
  manifestSha256: digest,
  releaseRecordSha256: digest,
}
const ok = (value) => ({
  status: "PRESENT",
  operation: "fixture-read",
  code: null,
  httpStatus: 200,
  value,
})
async function fixture() {
  const calls = []
  let time = 1000
  const policy = JSON.parse(await readFile(new URL("../recovery/policy.json", import.meta.url)))
  policy.status = "ADMITTED"
  policy.fence.contracts = [fenceDigest]
  policy.verifierClosure.sha256 = await hashVerifierClosure(
    { controllerSha: sha, inputs: policy.verifierClosure.inputs },
    async ({ path }) => `fixture:${path}\n`,
  )
  const policyText = canonicalPolicyBytes(policy).toString()
  const intent = {
    schemaVersion: 2,
    kind: "recovery-adoption-intent",
    candidate,
    policySha256: hash(policyText),
    legacyBodySha256: digest,
    legacyPhase: "NPM_COMPLETE",
    operations: ["adopt", "audit", "finalize", "publish", "verify"],
  }
  const context = {
    defaultBranch: "main",
    sha,
    ref: "refs/heads/main",
    workflow: ".github/workflows/release-postpublication.yml",
    runId: "50",
    runAttempt: "1",
    jobId: "51",
    repository: candidate.repository,
    repositoryId: candidate.repositoryId,
  }
  const request = {
    candidate,
    expectedControllerSha: sha,
    intentPath: "scripts/release/recovery-adoptions/example.json",
    legacyBodySha256: digest,
    operation: "adopt",
  }
  const run = {
    id: 50,
    run_attempt: 1,
    head_sha: sha,
    head_branch: "main",
    event: "workflow_dispatch",
    path: context.workflow,
    workflow_id: 5,
    status: "in_progress",
    repository: { id: 1, full_name: candidate.repository, default_branch: null },
  }
  const ciRun = {
    id: 60,
    run_attempt: 1,
    head_sha: sha,
    head_branch: "main",
    event: "push",
    path: ".github/workflows/ci.yml",
    workflow_id: 6,
    check_suite_id: 70,
    status: "completed",
    conclusion: "success",
    repository: run.repository,
  }
  const jobs = [
    {
      id: 51,
      runAttempt: 1,
      name: "adopt",
      status: "in_progress",
      conclusion: null,
      startedAt: null,
      completedAt: null,
    },
  ]
  const ciJobs = policy.ci.checks.map((name, i) => ({
    id: 80 + i,
    runAttempt: 1,
    name,
    status: "completed",
    conclusion: "success",
    startedAt: null,
    completedAt: null,
  }))
  const checks = policy.ci.checks.map((name, index) => ({
    id: 80 + index,
    name,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    check_suite: { id: 70 },
    app: { slug: "github-actions" },
  }))
  const fence = {
    contractSha256: fenceDigest,
    candidate,
    executor: {
      controllerSha: sha,
      verifierClosureSha256: policy.verifierClosure.sha256,
      workflow: context.workflow,
      runId: "50",
      runAttempt: "1",
      jobId: "51",
    },
    observedAt: 1000,
    expiresAt: 31000,
    concurrencyGroup: "dawn-release-controller",
    cancelInProgress: false,
    writers: [
      {
        workflow: ".github/workflows/release.yml",
        sourceSha: candidateSha,
        protection: "mutation-authority-revoked",
        proofSha256: fenceDigest,
        activeRuns: [],
      },
    ],
    inventoryComplete: true,
  }
  const state = {
    policyText,
    intentText: canonicalRecoveryBytes(intent).toString(),
    context,
    run,
    ciRun,
    jobs,
    ciJobs,
    checks,
    fence,
    ancestor: true,
  }
  const record = (name, fn) => async (args) => {
    calls.push({ name, args })
    return fn(args)
  }
  const git = {
    showFile: record("showFile", ({ ref, path }) => {
      assert.equal(ref, sha)
      if (path === "scripts/release/recovery/policy.json") return state.policyText
      if (path === request.intentPath) {
        if (state.intentText === null) throw new Error("missing intent")
        return state.intentText
      }
      return `fixture:${path}\n`
    }),
    isAncestor: record("isAncestor", () => state.ancestor),
  }
  const github = {
    getRef: record("getRef", () =>
      ok({ ref: "refs/heads/main", object: { type: "commit", sha: mainSha } }),
    ),
    getActionsRunAttempt: record("getActionsRunAttempt", ({ runId }) =>
      ok(runId === "50" ? state.run : state.ciRun),
    ),
    getWorkflow: record("getWorkflow", ({ workflow }) => {
      assert.ok(!workflow.includes("/"))
      return ok({
        id: workflow === context.workflow.split("/").at(-1) ? 5 : 6,
        path: `.github/workflows/${workflow}`,
        state: "active",
      })
    }),
    listActionsRunJobs: record("listActionsRunJobs", ({ runId }) =>
      ok(runId === "50" ? state.jobs : state.ciJobs),
    ),
    listWorkflowRuns: record("listWorkflowRuns", () => ok([state.ciRun])),
    getCommitCheckRuns: record("getCommitCheckRuns", () => ok(state.checks)),
  }
  const dependencies = {
    git,
    github,
    readInvocation: record("readInvocation", () => state.context),
    observeLegacyFence: record("observeLegacyFence", () => state.fence),
    now: () => time,
    sleep: async (ms) => {
      time += ms
    },
  }
  return {
    state,
    request,
    dependencies,
    calls,
    advance: (ms) => {
      time += ms
    },
  }
}

test("capture binds immutable intent and exact actual controller to independently observed main CI", async () => {
  assert.equal(typeof authority.captureRecoveryAuthority, "function")
  const f = await fixture()
  const facts = await authority.captureRecoveryAuthority(f.request, f.dependencies)
  assert.equal(facts.executor.controllerSha, sha)
  assert.notEqual(facts.executor.controllerSha, facts.candidate.candidateSha)
  assert.deepEqual(facts.capability, {
    schemaVersion: 2,
    policySha256: hash(f.state.policyText),
    controllerSha: sha,
    verifierClosureSha256: f.state.fence.executor.verifierClosureSha256,
    workflow: f.state.context.workflow,
    admission: "reviewed-main-ci",
  })
  assert.equal(facts.authority.intentSha256, hash(f.state.intentText))
  assert.equal(facts.authority.reviewedControllerSha, sha)
  assert.ok(
    f.calls.some(
      (x) => x.name === "isAncestor" && x.args.ancestor === sha && x.args.descendant === mainSha,
    ),
  )
  assert.ok(f.calls.every((x) => !/write|disable|enable|dispatch/i.test(x.name)))
})

test("arbitrary controller SHA and wrong invocation identity fail before git or GitHub reads", async () => {
  for (const mutate of [
    (f) => {
      f.request.expectedControllerSha = candidateSha
    },
    (f) => {
      f.state.context.ref = "refs/tags/v0.8.24"
    },
    (f) => {
      f.state.context.repository = "other/dawn"
    },
  ]) {
    const f = await fixture()
    mutate(f)
    await assert.rejects(() => authority.captureRecoveryAuthority(f.request, f.dependencies))
    assert.deepEqual(
      f.calls.map((x) => x.name),
      ["readInvocation"],
    )
  }
})

test("missing, malformed, noncanonical, mismatched and unsupported adoption intents block", async () => {
  for (const mutate of [
    (f) => {
      f.state.intentText = null
    },
    (f) => {
      f.state.intentText = "{}\n"
    },
    (f) => {
      f.state.intentText += " "
    },
    (f) => {
      f.state.intentText = f.state.intentText.replace('"releaseId":"2"', '"releaseId":"3"')
    },
    (f) => {
      f.state.intentText = f.state.intentText.replace('"schemaVersion":2', '"schemaVersion":9')
    },
    (f) => {
      f.request.legacyBodySha256 = "0".repeat(64)
    },
  ]) {
    const f = await fixture()
    mutate(f)
    await assert.rejects(() => authority.captureRecoveryAuthority(f.request, f.dependencies))
  }
})

test("actual API SHA, repository, run attempt and job provenance cannot be supplied by caller", async () => {
  for (const mutate of [
    (f) => {
      f.state.run.head_sha = candidateSha
    },
    (f) => {
      f.state.run.repository.id = 9
    },
    (f) => {
      f.state.run.run_attempt = 2
    },
    (f) => {
      f.state.jobs[0].id = 52
    },
    (f) => {
      f.state.run.head_branch = "feature"
    },
  ]) {
    const f = await fixture()
    mutate(f)
    await assert.rejects(() => authority.captureRecoveryAuthority(f.request, f.dependencies))
  }
})

test("unmerged controller and missing, failed, skipped, unrelated or uncorrelated required CI block", async () => {
  for (const mutate of [
    (f) => {
      f.state.ancestor = false
    },
    (f) => {
      f.state.checks.pop()
    },
    (f) => {
      f.state.checks[0].conclusion = "failure"
    },
    (f) => {
      f.state.ciJobs[1].conclusion = "skipped"
    },
    (f) => {
      f.state.ciRun.head_sha = candidateSha
    },
    (f) => {
      f.state.checks[0].check_suite.id = 71
    },
    (f) => {
      f.state.ciRun.conclusion = "failure"
    },
    (f) => {
      f.state.ciJobs[0].runAttempt = 2
    },
    (f) => {
      f.state.ciJobs[0].id = 999
    },
  ]) {
    const f = await fixture()
    mutate(f)
    await assert.rejects(() => authority.captureRecoveryAuthority(f.request, f.dependencies))
  }
})

test("dormant, unknown or changed policy and verifier code block authority", async () => {
  for (const mutate of [
    (p) => {
      p.status = "DORMANT"
    },
    (p) => {
      p.schemaVersion = 3
    },
    (p) => {
      p.approved = true
    },
    (p) => {
      p.verifierClosure.sha256 = digest
    },
  ]) {
    const f = await fixture()
    const p = JSON.parse(f.state.policyText)
    mutate(p)
    f.state.policyText = canonicalPolicyBytes(p).toString()
    await assert.rejects(() => authority.captureRecoveryAuthority(f.request, f.dependencies))
  }
})

test("each write eligibility capture including resume needs a fresh complete approved legacy fence", async () => {
  for (const operation of ["adopt", "verify", "audit", "finalize", "publish"]) {
    const f = await fixture()
    f.request.operation = operation
    await authority.captureRecoveryAuthority(f.request, f.dependencies)
    f.advance(31000)
    await assert.rejects(
      () => authority.captureRecoveryAuthority(f.request, f.dependencies),
      /fence|fresh|expired/i,
    )
  }
  for (const mutate of [
    (f) => {
      f.state.fence = null
    },
    (f) => {
      f.state.fence.inventoryComplete = false
    },
    (f) => {
      f.state.fence.writers = []
    },
    (f) => {
      f.state.fence.contractSha256 = digest
    },
    (f) => {
      f.state.fence.writers[0].activeRuns = ["90"]
    },
    (f) => {
      f.state.fence.writers[0].protection = "workflow-disabled"
    },
    (f) => {
      f.state.fence.executor.controllerSha = candidateSha
    },
    (f) => {
      f.state.fence.expiresAt = 9999999
    },
  ]) {
    const f = await fixture()
    mutate(f)
    await assert.rejects(() => authority.captureRecoveryAuthority(f.request, f.dependencies))
  }
})

test("untrusted request and dependency accessors/proxies never execute", async () => {
  const f = await fixture()
  let touched = false
  for (const input of [
    {
      get candidate() {
        touched = true
        return candidate
      },
    },
    new Proxy(
      {},
      {
        ownKeys() {
          touched = true
          return []
        },
      },
    ),
  ]) {
    await assert.rejects(() => authority.captureRecoveryAuthority(input, f.dependencies))
  }
  const deps = {
    ...f.dependencies,
    get github() {
      touched = true
      return f.dependencies.github
    },
  }
  await assert.rejects(() => authority.captureRecoveryAuthority(f.request, deps))
  assert.equal(touched, false)
})

test("current resume eligibility is independent of the historical adoption intent", async () => {
  const f = await fixture()
  f.state.intentText = null
  const result = await authority.captureRecoveryEligibility(
    { candidate, expectedControllerSha: sha },
    f.dependencies,
  )
  assert.equal(result.capability.admission, "reviewed-main-ci")
  assert.equal(Object.hasOwn(result, "authority"), false)
  assert.ok(!f.calls.some((x) => x.name === "showFile" && x.args.path === f.request.intentPath))
  f.advance(31000)
  await assert.rejects(
    () =>
      authority.captureRecoveryEligibility(
        { candidate, expectedControllerSha: sha },
        f.dependencies,
      ),
    /fence|fresh|expired/i,
  )
})

test("real GitHub read adapter projects workflow filenames and normalized all-attempt jobs", async () => {
  const f = await fixture()
  const urls = []
  const rawJobs = (jobs) =>
    jobs.map((job) => ({
      id: job.id,
      run_attempt: job.runAttempt,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      started_at: job.startedAt,
      completed_at: job.completedAt,
    }))
  f.dependencies.github = createGitHubReader({
    owner: "example",
    repo: "dawn",
    repositoryId: "1",
    fetchImpl: async (url) => {
      const path = new URL(url).pathname
      urls.push(path)
      let value
      if (path.endsWith("/git/ref/heads%2Fmain"))
        value = { ref: "refs/heads/main", object: { type: "commit", sha: mainSha } }
      else if (path.endsWith("/actions/runs/50/attempts/1")) value = f.state.run
      else if (path.endsWith("/actions/runs/60/attempts/1")) value = f.state.ciRun
      else if (path.endsWith("/actions/runs/50/jobs"))
        value = { total_count: f.state.jobs.length, jobs: rawJobs(f.state.jobs) }
      else if (path.endsWith("/actions/runs/60/jobs"))
        value = { total_count: f.state.ciJobs.length, jobs: rawJobs(f.state.ciJobs) }
      else if (path.endsWith("/actions/workflows/ci.yml/runs"))
        value = { total_count: 1, workflow_runs: [f.state.ciRun] }
      else if (path.endsWith("/actions/workflows/ci.yml"))
        value = { id: 6, path: ".github/workflows/ci.yml", state: "active" }
      else if (path.endsWith("/actions/workflows/release-postpublication.yml"))
        value = { id: 5, path: ".github/workflows/release-postpublication.yml", state: "active" }
      else if (path.endsWith(`/commits/${sha}/check-runs`))
        value = {
          total_count: f.state.checks.length,
          check_runs: f.state.checks.map((check, index) => ({ id: 100 + index, ...check })),
        }
      else throw new Error(`Unexpected API read ${path}`)
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  const result = await authority.captureRecoveryAuthority(f.request, f.dependencies)
  assert.equal(result.executor.jobId, "51")
  assert.ok(urls.includes("/repos/example/dawn/actions/workflows/ci.yml/runs"))
})

test("invocation and fence observation deadlines cannot hang or grant late authority", async () => {
  for (const name of ["readInvocation", "observeLegacyFence"]) {
    const f = await fixture()
    let entered = false,
      timer,
      finish
    f.dependencies[name] = () => {
      entered = true
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    f.dependencies.setTimer = (callback) => {
      timer = callback
      return 1
    }
    f.dependencies.clearTimer = () => {
      timer = null
    }
    const pending = authority.captureRecoveryAuthority(f.request, f.dependencies)
    for (let i = 0; i < 1000 && !entered; i++) await Promise.resolve()
    assert.equal(entered, true)
    assert.equal(typeof timer, "function")
    f.advance(15000)
    timer()
    await assert.rejects(pending, /unavailable|timeout/i)
    finish(name === "readInvocation" ? f.state.context : f.state.fence)
  }
})

test("verified facts are deeply immutable and backward clocks cannot extend eligibility", async () => {
  const f = await fixture()
  const facts = await authority.captureRecoveryAuthority(f.request, f.dependencies)
  assert.ok(
    Object.isFrozen(facts) &&
      Object.isFrozen(facts.capability) &&
      Object.isFrozen(facts.authority.intent.candidate),
  )
  assert.throws(() => {
    facts.capability.controllerSha = candidateSha
  })
  const bad = await fixture()
  let reads = 0
  bad.dependencies.now = () => (++reads === 1 ? 1000 : 999)
  await assert.rejects(
    () => authority.captureRecoveryAuthority(bad.request, bad.dependencies),
    /clock/i,
  )
})

test("independent auditors cannot acquire writer authority or mutable eligibility", async () => {
  for (const operation of ["adopt", "audit", "finalize", "publish", "verify"]) {
    const f = await fixture()
    f.request.operation = operation
    f.state.context.workflow = ".github/workflows/release-postpublication-audit.yml"
    f.state.run.path = f.state.context.workflow
    f.state.fence.executor.workflow = f.state.context.workflow
    await assert.rejects(
      () => authority.captureRecoveryAuthority(f.request, f.dependencies),
      /writer|workflow/i,
    )
    await assert.rejects(
      () =>
        authority.captureRecoveryEligibility(
          { candidate, expectedControllerSha: sha },
          f.dependencies,
        ),
      /writer|workflow/i,
    )
    assert.ok(!f.calls.some((call) => call.name === "observeLegacyFence"))
  }
})
