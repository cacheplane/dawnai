import assert from "node:assert/strict"
import test from "node:test"
import * as subject from "../recovery/invocation.mjs"

const sha = "a".repeat(40)
function fixture() {
  const env = {
    GITHUB_SHA: sha,
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "example/recovery",
    GITHUB_REPOSITORY_ID: "42",
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_WORKFLOW_REF:
      "example/recovery/.github/workflows/release-postpublication.yml@refs/heads/main",
    GITHUB_JOB: "symbolic_job",
  }
  const values = {
    getRepository: { id: 42, full_name: "example/recovery", default_branch: "main" },
    getActionsRunAttempt: {
      id: 100,
      run_attempt: 2,
      head_sha: sha,
      head_branch: "main",
      path: ".github/workflows/release-postpublication.yml",
      event: "workflow_dispatch",
      status: "in_progress",
      workflow_id: 9,
      repository: { id: 42, full_name: "example/recovery" },
    },
    getWorkflowById: {
      id: 9,
      path: ".github/workflows/release-postpublication.yml",
      state: "active",
    },
    listActionsRunJobsComplete: [
      {
        id: 77,
        run_id: 100,
        runAttempt: 2,
        head_sha: sha,
        name: "recovery-admit",
        status: "in_progress",
      },
    ],
  }
  const calls = []
  const github = Object.fromEntries(
    Object.keys(values).map((name) => [
      name,
      async (args, options) => {
        calls.push({ name, args, options })
        return { status: "PRESENT", value: values[name] }
      },
    ]),
  )
  return { env, values, calls, github }
}
test("trusted invocation binds repository/run/workflow and numeric current job independently", async () => {
  const f = fixture()
  assert.equal(typeof subject.createRecoveryInvocationReader, "function")
  const reader = subject.createRecoveryInvocationReader({
    env: f.env,
    github: f.github,
    expectedJobName: "recovery-admit",
  })
  assert.deepEqual(await reader.readInvocation({}), {
    sha,
    ref: "refs/heads/main",
    workflow: ".github/workflows/release-postpublication.yml",
    runId: "100",
    runAttempt: "2",
    jobId: "77",
    repository: "example/recovery",
    repositoryId: "42",
    defaultBranch: "main",
  })
})
for (const [name, damage] of Object.entries({
  "repository mismatch": (f) => {
    f.values.getRepository.id = 43
  },
  "branch mismatch": (f) => {
    f.values.getRepository.default_branch = "other"
  },
  "run mismatch": (f) => {
    f.values.getActionsRunAttempt.id = 101
  },
  "attempt mismatch": (f) => {
    f.values.getActionsRunAttempt.run_attempt = 1
  },
  "workflow mismatch": (f) => {
    f.values.getWorkflowById.path = ".github/workflows/evil.yml"
  },
  "SHA mismatch": (f) => {
    f.values.getActionsRunAttempt.head_sha = "b".repeat(40)
  },
  "missing job": (f) => {
    f.values.listActionsRunJobsComplete = []
  },
  "duplicate current job": (f) => {
    f.values.listActionsRunJobsComplete.push({ ...f.values.listActionsRunJobsComplete[0], id: 78 })
  },
  "symbolic job proof": (f) => {
    f.values.listActionsRunJobsComplete[0].id = "symbolic_job"
  },
  "old attempt job": (f) => {
    f.values.listActionsRunJobsComplete[0].runAttempt = 1
  },
  "wrong run job": (f) => {
    f.values.listActionsRunJobsComplete[0].run_id = 101
  },
  "workflow ref mismatch": (f) => {
    f.env.GITHUB_WORKFLOW_REF += "bad"
  },
  "noncanonical ID": (f) => {
    f.env.GITHUB_RUN_ID = "0100"
  },
}))
  test(`invocation blocks ${name}`, async () => {
    const f = fixture()
    damage(f)
    await assert.rejects(async () =>
      subject
        .createRecoveryInvocationReader({
          env: f.env,
          github: f.github,
          expectedJobName: "recovery-admit",
        })
        .readInvocation({}),
    )
  })
test("invocation rejects arbitrary job display name and propagates cancellation", async () => {
  const f = fixture()
  assert.throws(() =>
    subject.createRecoveryInvocationReader({
      env: f.env,
      github: f.github,
      expectedJobName: "publish",
    }),
  )
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(() =>
    subject
      .createRecoveryInvocationReader({
        env: f.env,
        github: f.github,
        expectedJobName: "recovery-admit",
      })
      .readInvocation({}, { signal: abort.signal, timeoutMs: 100 }),
  )
  assert.equal(f.calls.length, 0)
})

test("immutable policy credential is confined to fresh identity and immutable-release GETs", async () => {
  const calls = []
  const responses = [
    { id: 42, full_name: "example/recovery" },
    { enabled: true, enforced_by_owner: false },
  ]
  const reader = subject.createRecoveryImmutablePolicyReader({
    owner: "example",
    repo: "recovery",
    repositoryId: "42",
    token: "separate-secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return Response.json(responses.shift())
    },
  })
  assert.deepEqual(Object.keys(reader), ["observeImmutableReleasePolicy"])
  assert.deepEqual(
    await reader.observeImmutableReleasePolicy({
      candidate: { repository: "example/recovery", repositoryId: "42" },
    }),
    { repository: "example/recovery", enabled: true },
  )
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      "https://api.github.com/repos/example/recovery",
      "https://api.github.com/repos/example/recovery/immutable-releases",
    ],
  )
  assert.ok(
    calls.every(
      (c) =>
        c.init.method === "GET" &&
        c.init.headers.Authorization === "Bearer separate-secret" &&
        c.init.headers["X-GitHub-Api-Version"] === "2026-03-10",
    ),
  )
})
for (const [name, body, status] of [
  ["disabled", { enabled: false, enforced_by_owner: false }, 200],
  ["missing", {}, 404],
  ["denied", {}, 403],
  ["malformed", { enabled: "true" }, 200],
  ["extra fields", { enabled: true, unsafe: true }, 200],
])
  test(`immutable proof blocks ${name}`, async () => {
    let calls = 0
    const reader = subject.createRecoveryImmutablePolicyReader({
      owner: "example",
      repo: "recovery",
      repositoryId: "42",
      token: "separate-secret",
      fetchImpl: async () =>
        ++calls === 1
          ? Response.json({ id: 42, full_name: "example/recovery" })
          : Response.json(body, { status }),
    })
    await assert.rejects(() =>
      reader.observeImmutableReleasePolicy({
        candidate: { repository: "example/recovery", repositoryId: "42" },
      }),
    )
  })
test("complete jobs preserve source/run identity required by invocation", async () => {
  const { createGitHubReader } = await import("../adapters/github.mjs")
  const job = {
    id: 77,
    run_id: 100,
    run_attempt: 1,
    head_sha: sha,
    name: "recovery-admit",
    status: "in_progress",
    conclusion: null,
    started_at: "2026-09-05T00:00:00Z",
    completed_at: null,
  }
  const github = createGitHubReader({
    owner: "example",
    repo: "recovery",
    fetchImpl: async () => Response.json({ total_count: 1, jobs: [job] }),
  })
  const result = await github.listActionsRunJobsComplete({ runId: "100" })
  assert.equal(result.status, "PRESENT")
  assert.equal(result.value[0].run_id, 100)
  assert.equal(result.value[0].head_sha, sha)
})

test("immutable policy validates documented enforced_by_owner response", async () => {
  for (const enforced of [true, false, "false"]) {
    let calls = 0
    const reader = subject.createRecoveryImmutablePolicyReader({
      owner: "example",
      repo: "recovery",
      repositoryId: "42",
      token: "separate-secret",
      fetchImpl: async () =>
        Response.json(
          ++calls === 1
            ? { id: 42, full_name: "example/recovery" }
            : { enabled: true, enforced_by_owner: enforced },
        ),
    })
    const read = () =>
      reader.observeImmutableReleasePolicy({
        candidate: { repository: "example/recovery", repositoryId: "42" },
      })
    if (typeof enforced === "boolean") assert.equal((await read()).enabled, true)
    else await assert.rejects(read)
  }
})

test("invocation retries only settled transient reads inside the original callback deadline", async () => {
  for (const code of ["SERVER_ERROR", "TIMEOUT"]) {
    const f = fixture()
    let attempts = 0,
      clock = 1000
    const sleeps = [],
      original = f.github.getRepository
    f.github.getRepository = async (...args) =>
      ++attempts === 1 ? { status: "AMBIGUOUS", httpStatus: 503, code } : original(...args)
    const reader = subject.createRecoveryInvocationReader({
      env: f.env,
      github: f.github,
      expectedJobName: "recovery-admit",
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
    })
    if (code === "SERVER_ERROR") {
      assert.equal((await reader.readInvocation({}, { timeoutMs: 5000 })).jobId, "77")
      assert.deepEqual(sleeps, [1000])
      assert.equal(attempts, 2)
    } else {
      await assert.rejects(() => reader.readInvocation({}, { timeoutMs: 5000 }))
      assert.equal(attempts, 1)
      assert.deepEqual(sleeps, [])
    }
  }
})

test("separate policy observer reuses settled GitHub retry classification", async () => {
  const statuses = [503, 200, 200],
    calls = [],
    sleeps = []
  let clock = 1000
  const reader = subject.createRecoveryImmutablePolicyReader({
    owner: "example",
    repo: "recovery",
    repositoryId: "42",
    token: "isolated",
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    fetchImpl: async (url) => {
      calls.push(url)
      const status = statuses.shift()
      return Response.json(
        status === 503
          ? {}
          : url.endsWith("/immutable-releases")
            ? { enabled: true, enforced_by_owner: false }
            : { id: 42, full_name: "example/recovery" },
        { status },
      )
    },
  })
  assert.equal(
    (
      await reader.observeImmutableReleasePolicy(
        { candidate: { repository: "example/recovery", repositoryId: "42" } },
        { timeoutMs: 5000 },
      )
    ).enabled,
    true,
  )
  assert.deepEqual(sleeps, [1000])
  assert.equal(calls.length, 3)
})
