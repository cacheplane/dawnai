import assert from "node:assert/strict"
import test from "node:test"

import { captureFreshAbandonmentEvidence } from "../abandonment-authority.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"

const VERSION = "0.8.22"
const COMMIT_SHA = "a".repeat(40)
const RUN_ID = 700
const PACKAGE_NAMES = [...CANONICAL_RELEASE_PACKAGE_ORDER].sort(compareText)

test("captures only observable protected approval, locked Actions history, and two separated E404 snapshots", async () => {
  const fixture = authorityFixture()

  const result = await captureFreshAbandonmentEvidence(fixture.input)

  assert.deepEqual(result.approval, {
    environment: "release-abandonment",
    environmentId: 161_088_068,
    reviewerId: 9_001,
    reviewer: "release-reviewer",
    state: "approved",
    observedAt: "2026-08-25T12:00:00.000Z",
    workflowRunId: RUN_ID,
    runAttempt: 1,
    actor: "release-operator",
    actorId: 7_001,
    recordedAt: "2026-08-25T12:01:00.000Z",
  })
  assert.deepEqual(result.actionsHistory, {
    workflowRunId: RUN_ID,
    runAttempt: 1,
    observedAt: "2026-08-25T12:01:00.000Z",
    publishJobStarted: false,
    registryMutationStarted: false,
  })
  assert.equal(result.observations.length, 2)
  assert.equal(result.observations[0].workflowRunId, RUN_ID)
  assert.equal(result.observations[1].workflowRunId, RUN_ID)
  assert.equal(
    Date.parse(result.observations[1].observedAt) - Date.parse(result.observations[0].observedAt),
    60_000,
  )
  assert.deepEqual(
    result.observations.map(({ packages }) => packages),
    [0, 1].map(() =>
      PACKAGE_NAMES.map((name) => ({
        name,
        version: VERSION,
        status: "ABSENT",
        httpStatus: 404,
        code: "E404",
      })),
    ),
  )
  assert.deepEqual(fixture.waits, [60_000])
  assert.equal(fixture.npmCalls.length, 42)
  assert.ok(Object.isFrozen(result))
})

test("rejects approval history that is missing, ambiguous, self-approved, or for another environment", async (t) => {
  const cases = [
    ["missing", () => []],
    [
      "ambiguous",
      (fixture) => [
        fixture.approval(),
        fixture.approval({ user: { id: 9_002, login: "second-reviewer" } }),
      ],
    ],
    [
      "self-approved",
      (fixture) => [fixture.approval({ user: { id: 9_001, login: "release-operator" } })],
    ],
    [
      "wrong environment",
      (fixture) => [
        fixture.approval({
          environments: [{ id: 161_088_068, name: "production" }],
        }),
      ],
    ],
  ]

  for (const [name, approvals] of cases) {
    await t.test(name, async () => {
      const fixture = authorityFixture()
      fixture.setApprovals(approvals(fixture))
      await assert.rejects(captureFreshAbandonmentEvidence(fixture.input), /approval/iu)
      assert.equal(fixture.npmCalls.length, 0)
    })
  }
})

test("rejects a reviewer whose stable GitHub identity is the workflow actor under another login", async () => {
  const fixture = authorityFixture()
  fixture.setApprovals([
    fixture.approval({ user: { id: 7_001, login: "renamed-release-operator" } }),
  ])

  await assert.rejects(captureFreshAbandonmentEvidence(fixture.input), /approval|independent/iu)
  assert.equal(fixture.npmCalls.length, 0)
})

test("records approval observedAt only after the approval-history response is received", async () => {
  const fixture = authorityFixture({ approvalReadAdvanceMs: 1_000 })

  const result = await captureFreshAbandonmentEvidence(fixture.input)

  assert.equal(result.approval.observedAt, "2026-08-25T12:00:01.000Z")
  assert.equal(result.observations[0].observedAt, "2026-08-25T12:00:01.000Z")
})

test("rejects any non-E404 registry result and never records a partial second observation", async () => {
  const fixture = authorityFixture()
  fixture.setNpmResult(25, {
    status: "AMBIGUOUS",
    operation: "package-version",
    httpStatus: 503,
    code: "HTTP_503",
  })

  await assert.rejects(captureFreshAbandonmentEvidence(fixture.input), /registry|absence/iu)
  assert.equal(fixture.npmCalls.length, 26)
})

test("rejects an early wait return instead of weakening the sixty-second boundary", async () => {
  const fixture = authorityFixture({ waitAdvanceMs: 59_999 })

  await assert.rejects(captureFreshAbandonmentEvidence(fixture.input), /separated|sixty/iu)
  assert.deepEqual(fixture.waits, [60_000])
  assert.equal(fixture.npmCalls.length, 21)
})

test("re-reads all candidate workflow jobs after the second registry snapshot and blocks a started publisher", async () => {
  const fixture = authorityFixture({
    publishJobs: [
      {
        id: 901,
        name: "publish-npm",
        runAttempt: 1,
        status: "completed",
        conclusion: "skipped",
        startedAt: "2026-08-25T12:00:30.000Z",
        completedAt: "2026-08-25T12:00:31.000Z",
      },
    ],
  })

  await assert.rejects(
    captureFreshAbandonmentEvidence(fixture.input),
    /publish|registry mutation/iu,
  )
  assert.equal(fixture.npmCalls.length, 42)
  assert.equal(fixture.actionsJobReads, 1)
})

test("rejects incomplete normalized job-attempt coverage for any candidate workflow run", async () => {
  const fixture = authorityFixture()
  fixture.setWorkflowRuns([
    fixture.run,
    {
      id: 701,
      run_attempt: 2,
      event: "workflow_dispatch",
      head_sha: COMMIT_SHA,
      actor: { id: 7_002, login: "earlier-operator" },
    },
  ])

  await assert.rejects(captureFreshAbandonmentEvidence(fixture.input), /attempt|history/iu)
  assert.equal(fixture.npmCalls.length, 42)
})

test("rejects missing, duplicate, or unstably ordered normalized job identities", async (t) => {
  const cases = [
    ["missing", []],
    ["duplicate", [normalizedJob({ id: 901 }), normalizedJob({ id: 901, name: "other" })]],
    ["unstable", [normalizedJob({ id: 902 }), normalizedJob({ id: 901 })]],
  ]

  for (const [name, publishJobs] of cases) {
    await t.test(name, async () => {
      const fixture = authorityFixture({ publishJobs })
      await assert.rejects(captureFreshAbandonmentEvidence(fixture.input), /job|history/iu)
      assert.equal(fixture.npmCalls.length, 42)
    })
  }
})

test("binds the authorizing run, attempt, actor, tag ref, and candidate SHA exactly", async (t) => {
  const cases = [
    ["run", { GITHUB_RUN_ID: "701" }],
    ["attempt", { GITHUB_RUN_ATTEMPT: "2" }],
    ["actor", { GITHUB_ACTOR: "other-operator" }],
    ["actor ID", { GITHUB_ACTOR_ID: "7002" }],
    ["ref", { GITHUB_REF: "refs/heads/main" }],
    ["sha", { GITHUB_SHA: "b".repeat(40) }],
  ]

  for (const [name, environment] of cases) {
    await t.test(name, async () => {
      const fixture = authorityFixture({ environment })
      await assert.rejects(
        captureFreshAbandonmentEvidence(fixture.input),
        /run|candidate|environment/iu,
      )
      assert.equal(fixture.npmCalls.length, 0)
    })
  }
})

function authorityFixture({
  environment = {},
  approvalReadAdvanceMs = 0,
  waitAdvanceMs = 60_000,
  publishJobs = [
    {
      id: 900,
      name: "publish-npm",
      runAttempt: 1,
      status: "completed",
      conclusion: "skipped",
      startedAt: null,
      completedAt: null,
    },
  ],
} = {}) {
  let nowMs = Date.parse("2026-08-25T12:00:00.000Z")
  let approvals = [approval()]
  let workflowRuns
  const npmResults = new Map()
  const waits = []
  const npmCalls = []
  let actionsJobReads = 0
  const run = {
    id: RUN_ID,
    run_attempt: 1,
    event: "workflow_dispatch",
    head_sha: COMMIT_SHA,
    actor: { id: 7_001, login: "release-operator" },
  }
  workflowRuns = [run]
  const input = {
    candidate: {
      version: VERSION,
      commitSha: COMMIT_SHA,
      ciWorkflow: "CI",
      ciCheck: "validate",
      publisherWorkflow: ".github/workflows/release.yml",
    },
    packageNames: PACKAGE_NAMES,
    environment: {
      GITHUB_REPOSITORY: "cacheplane/dawnai",
      GITHUB_RUN_ID: String(RUN_ID),
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_ACTOR: "release-operator",
      GITHUB_ACTOR_ID: "7001",
      GITHUB_REF: `refs/tags/v${VERSION}`,
      GITHUB_SHA: COMMIT_SHA,
      ...environment,
    },
    now: () => nowMs,
    wait: async (milliseconds) => {
      waits.push(milliseconds)
      nowMs += waitAdvanceMs
    },
    github: {
      async getActionsRunAttempt() {
        return present("actions-run-attempt", run)
      },
      async getWorkflowRunApprovals() {
        nowMs += approvalReadAdvanceMs
        return present("workflow-run-approvals", approvals)
      },
      async listWorkflowRuns() {
        return present("workflow-runs", workflowRuns)
      },
      async listActionsRunJobs() {
        actionsJobReads += 1
        return present("actions-run-jobs", publishJobs)
      },
    },
    npm: {
      async observePackageVersion(args) {
        npmCalls.push(args)
        const result = npmResults.get(npmCalls.length - 1)
        return (
          result ?? {
            status: "ABSENT",
            operation: "package-version",
            httpStatus: 404,
            code: "E404",
          }
        )
      },
    },
  }
  return {
    input,
    waits,
    npmCalls,
    approval,
    run,
    setApprovals(value) {
      approvals = value
    },
    setWorkflowRuns(value) {
      workflowRuns = value
    },
    setNpmResult(index, value) {
      npmResults.set(index, value)
    },
    get actionsJobReads() {
      return actionsJobReads
    },
  }
}

function approval(overrides = {}) {
  return {
    state: "approved",
    comment: "Abandon deterministically defective candidate",
    environments: [{ id: 161_088_068, name: "release-abandonment" }],
    user: { id: 9_001, login: "release-reviewer" },
    ...overrides,
  }
}

function normalizedJob(overrides = {}) {
  return {
    id: 900,
    runAttempt: 1,
    name: "prepare",
    status: "completed",
    conclusion: "success",
    startedAt: "2026-08-25T11:58:00.000Z",
    completedAt: "2026-08-25T11:59:00.000Z",
    ...overrides,
  }
}

function present(operation, value) {
  return { status: "PRESENT", operation, httpStatus: 200, code: null, value }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
