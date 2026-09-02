import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { createDuplicateDraftRecoveryReader } from "../duplicate-draft-recovery-adapters.mjs"

const EXPECTED_METHODS = [
  "listCandidateReleases",
  "readCandidatePublishJobs",
  "readCandidateTag",
  "readImmutableReleases",
  "readNpmAbsence",
  "readReleaseRuns",
  "readReleaseSnapshot",
  "readRepositoryState",
  "readReviewedMergeAuthority",
  "readWorkflowState",
]
const REVIEWED_COMMIT = "a".repeat(40)
const REVIEWED_HEAD = "b".repeat(40)
const TREE = "c".repeat(40)
const TAG_OBJECT = "d".repeat(40)
const CANDIDATE_SHA = "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8"
const BASE = "https://api.github.com/repos/cacheplane/dawnai"

test("recovery reader exposes only the exact frozen read surface", () => {
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => assert.fail("construction must not execute commands"),
    fetchImpl: async () => assert.fail("construction must not access the network"),
  })

  assert.deepEqual(Object.keys(reader).sort(), EXPECTED_METHODS)
  assert.equal(Object.isFrozen(reader), true)
  assert.equal(
    Object.values(reader).every((method) => typeof method === "function"),
    true,
  )
})

test("reviewed authority reads exact routes and proves local, remote, PR, trees, and CI", async () => {
  const calls = []
  const runCalls = []
  const fetchImpl = routingFetch(calls, (url) => {
    if (url === `${BASE}`) return repositoryResponse()
    if (url === `${BASE}/git/ref/heads%2Fmain`) return jsonResponse(mainRef(REVIEWED_COMMIT))
    if (url === `${BASE}/commits/${REVIEWED_COMMIT}/pulls?per_page=2`) {
      return jsonResponse([reviewedPull()])
    }
    if (url === `${BASE}/git/commits/${REVIEWED_COMMIT}`) {
      return jsonResponse({ sha: REVIEWED_COMMIT, tree: { sha: TREE } })
    }
    if (url === `${BASE}/git/commits/${REVIEWED_HEAD}`) {
      return jsonResponse({ sha: REVIEWED_HEAD, tree: { sha: TREE } })
    }
    if (url === `${BASE}/commits/${REVIEWED_HEAD}/check-runs?per_page=100`) {
      return jsonResponse({
        total_count: 1,
        check_runs: [
          {
            id: 98,
            name: "validate",
            head_sha: REVIEWED_HEAD,
            status: "completed",
            conclusion: "success",
            check_suite: { id: 77 },
          },
        ],
      })
    }
    if (url === `${BASE}/actions/workflows/ci.yml/runs?head_sha=${REVIEWED_HEAD}&per_page=100`) {
      return jsonResponse({
        total_count: 1,
        workflow_runs: [
          {
            id: 987654321,
            run_attempt: 1,
            name: "CI",
            path: ".github/workflows/ci.yml",
            head_sha: REVIEWED_HEAD,
            head_branch: "reviewed-recovery",
            event: "pull_request",
            check_suite_id: 77,
            status: "completed",
            conclusion: "success",
          },
        ],
      })
    }
    assert.fail(`unexpected URL ${url}`)
  })
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    fetchImpl,
    token: "secret-token",
    run: async (command, args, options) => {
      runCalls.push([command, args, options])
      return `${REVIEWED_COMMIT}\n`
    },
  })

  assert.deepEqual(await reader.readReviewedMergeAuthority(REVIEWED_COMMIT), {
    mergeCommitSha: REVIEWED_COMMIT,
    mergeTreeSha: TREE,
    pullRequestNumber: 789,
    reviewedHeadSha: REVIEWED_HEAD,
    reviewedTreeSha: TREE,
    validateRunId: 987654321,
  })
  assert.deepEqual(
    runCalls.map(([command, args]) => [command, args]),
    [["git", ["rev-list", "--first-parent", "--max-count=1", "HEAD"]]],
  )
  assert.equal(calls.length, 7)
  assert.equal(
    calls.every(({ init }) => init.method === "GET" && init.redirect === "manual"),
    true,
  )
  assert.equal(
    calls.every(({ init }) => init.headers.Authorization === "Bearer secret-token"),
    true,
  )
})

test("reviewed authority rejects ambiguity, later main, unmerged PRs, tree drift, and failed CI", async (t) => {
  const cases = [
    ["multiple PRs", { pulls: [reviewedPull(), { ...reviewedPull(), number: 790 }] }],
    ["non-merged PR", { pulls: [{ ...reviewedPull(), merged_at: null }] }],
    [
      "wrong base",
      { pulls: [{ ...reviewedPull(), base: { ...reviewedPull().base, ref: "dev" } }] },
    ],
    ["later main", { mainSha: "e".repeat(40) }],
    ["unequal trees", { headTree: "e".repeat(40) }],
    ["failed validate", { checkConclusion: "failure" }],
  ]
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const reader = reviewedReader(overrides)
      await assert.rejects(
        reader.readReviewedMergeAuthority(REVIEWED_COMMIT),
        (error) =>
          typeof error.code === "string" &&
          !JSON.stringify(error).includes("secret-token") &&
          !error.message.includes("remote body"),
      )
    })
  }
})

test("production reads bind repository, workflow, immutable setting, annotated tag, runs, and jobs", async () => {
  const calls = []
  const fetchImpl = routingFetch(calls, (url) => {
    if (url === BASE) return repositoryResponse()
    if (url === `${BASE}/git/ref/heads%2Fmain`) return jsonResponse(mainRef(REVIEWED_COMMIT))
    if (url === `${BASE}/actions/workflows/260503756`) {
      return jsonResponse({
        id: 260503756,
        path: ".github/workflows/release.yml",
        state: "disabled_manually",
      })
    }
    if (url === `${BASE}/immutable-releases`) return jsonResponse({ enabled: true })
    if (url === `${BASE}/git/ref/tags%2Fv0.8.22`) {
      return jsonResponse({
        ref: "refs/tags/v0.8.22",
        object: { type: "tag", sha: TAG_OBJECT },
      })
    }
    if (url === `${BASE}/git/tags/${TAG_OBJECT}`) {
      return jsonResponse({
        sha: TAG_OBJECT,
        tag: "v0.8.22",
        object: { type: "commit", sha: CANDIDATE_SHA },
      })
    }
    if (url === `${BASE}/actions/workflows/260503756/runs?per_page=100`) {
      return jsonResponse({ total_count: 1, workflow_runs: [releaseRun(10)] })
    }
    if (url === `${BASE}/actions/runs/10/jobs?filter=all&per_page=100`) {
      return jsonResponse({ total_count: 1, jobs: [job(11, "prepare")] })
    }
    assert.fail(`unexpected URL ${url}`)
  })
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    fetchImpl,
    run: async () => `${REVIEWED_COMMIT}\n`,
  })

  assert.deepEqual(await reader.readRepositoryState(), {
    id: 1210070282,
    nameWithOwner: "cacheplane/dawnai",
    mainSha: REVIEWED_COMMIT,
  })
  assert.deepEqual(await reader.readWorkflowState(), {
    id: 260503756,
    state: "disabled_manually",
  })
  assert.deepEqual(await reader.readImmutableReleases(), { enabled: true })
  assert.deepEqual(await reader.readCandidateTag(), {
    version: "0.8.22",
    commitSha: CANDIDATE_SHA,
    tagObjectSha: TAG_OBJECT,
  })
  assert.deepEqual(await reader.readReleaseRuns(), {
    runs: [
      {
        id: 10,
        runAttempt: 1,
        status: "completed",
        conclusion: "success",
        headSha: CANDIDATE_SHA,
        createdAt: "2026-09-01T00:00:00Z",
        startedAt: "2026-09-01T00:00:01Z",
        updatedAt: "2026-09-01T00:01:00Z",
      },
    ],
    candidateRuns: [
      {
        id: 10,
        runAttempt: 1,
        status: "completed",
        conclusion: "success",
        headSha: CANDIDATE_SHA,
        createdAt: "2026-09-01T00:00:00Z",
        startedAt: "2026-09-01T00:00:01Z",
        updatedAt: "2026-09-01T00:01:00Z",
      },
    ],
  })
  assert.equal((await reader.readCandidatePublishJobs(10))[0].name, "prepare")
  assert.equal(
    calls.filter(({ url }) => url.includes("/actions/workflows/260503756/runs?")).length,
    1,
  )
})

test("repository reads reject string or drifted numeric IDs", async () => {
  for (const id of ["1210070282", 1210070281]) {
    const reader = createDuplicateDraftRecoveryReader({
      root: "/workspace",
      run: async () => `${REVIEWED_COMMIT}\n`,
      fetchImpl: async (url) => {
        if (url === BASE) {
          return jsonResponse({
            id,
            name: "dawnai",
            full_name: "cacheplane/dawnai",
            default_branch: "main",
            owner: { login: "cacheplane" },
          })
        }
        if (url === `${BASE}/git/ref/heads%2Fmain`) {
          return jsonResponse(mainRef(REVIEWED_COMMIT))
        }
        assert.fail(`unexpected URL ${url}`)
      },
    })
    await assert.rejects(
      reader.readRepositoryState(),
      (error) => error.code === "REPOSITORY_IDENTITY_CONFLICT",
    )
  }
})

test("Release and job observations reject malformed rows and incoherent terminal state", async () => {
  const malformedReleaseReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async () => jsonResponse([{ id: 99 }]),
  })
  await assert.rejects(
    malformedReleaseReader.listCandidateReleases(),
    (error) => error.code === "RELEASE_LIST_MALFORMED",
  )

  const malformedJobReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async () =>
      jsonResponse({
        total_count: 1,
        jobs: [{ ...job(11, "publish-npm"), started_at: null }],
      }),
  })
  await assert.rejects(
    malformedJobReader.readCandidatePublishJobs(10),
    (error) => error.code === "CANDIDATE_JOBS_MALFORMED",
  )

  const malformedRunReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async () =>
      jsonResponse({
        total_count: 1,
        workflow_runs: [{ ...releaseRun(10), run_started_at: null }],
      }),
  })
  await assert.rejects(
    malformedRunReader.readReleaseRuns(),
    (error) => error.code === "RELEASE_RUNS_MALFORMED",
  )
})

test("npm absence performs exact-version E404 plus package metadata confirmation", async () => {
  const calls = []
  const packageName = "@dawn-ai/sdk"
  const encoded = encodeURIComponent(packageName)
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: routingFetch(calls, (url) => {
      if (url === `https://registry.npmjs.org/${encoded}/0.8.22`) {
        return jsonResponse({ code: "E404", message: "secret remote body" }, 404)
      }
      if (url === `https://registry.npmjs.org/${encoded}`) {
        return jsonResponse({
          name: packageName,
          versions: { "0.8.21": packageVersion(packageName) },
        })
      }
      assert.fail(`unexpected URL ${url}`)
    }),
  })

  assert.deepEqual(await reader.readNpmAbsence(packageName), {
    name: packageName,
    version: "0.8.22",
    status: "absent",
  })
  assert.deepEqual(
    calls.map(({ url }) => url),
    [`https://registry.npmjs.org/${encoded}/0.8.22`, `https://registry.npmjs.org/${encoded}`],
  )
})

test("release snapshots read complete assets and required recovery bytes through safe redirects", async () => {
  const calls = []
  const releaseId = 379982100
  const originalBody = "canonical body\n"
  const archiveBytes = Buffer.from(originalBody)
  const archiveSha = sha256(archiveBytes)
  const archiveName = `dawn-v0.8.22-duplicate-${releaseId}-original-body-${archiveSha}.txt`
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: routingFetch(calls, (url) => {
      if (url === `${BASE}/releases/${releaseId}`) {
        return jsonResponse(releaseFixture({ releaseId, body: originalBody }))
      }
      if (url === `${BASE}/releases/${releaseId}/assets?per_page=100`) {
        return jsonResponse([
          asset(1, "base.tgz", Buffer.from("base")),
          asset(2, archiveName, archiveBytes),
        ])
      }
      if (url === `${BASE}/releases/assets/2`) {
        return binaryResponse(new Uint8Array(), 302, {
          location: "https://objects.githubusercontent.com/recovery-archive",
        })
      }
      if (url === "https://objects.githubusercontent.com/recovery-archive") {
        return binaryResponse(archiveBytes)
      }
      assert.fail(`unexpected URL ${url}`)
    }),
  })

  const snapshot = await reader.readReleaseSnapshot(releaseId, {
    expectedOriginalBody: originalBody,
  })
  assert.deepEqual(snapshot.evidenceAssets, ["body"])
  assert.equal(snapshot.assets[1].sha256, archiveSha)
  assert.equal(Object.hasOwn(snapshot.assets[1], "bytes"), false)
})

test("release snapshots reject duplicate asset IDs and name collisions", async () => {
  for (const field of ["id", "name"]) {
    const first = asset(1, "first.tgz", Buffer.from("first"))
    const second = asset(2, "second.tgz", Buffer.from("second"))
    second[field] = first[field]
    const reader = createDuplicateDraftRecoveryReader({
      root: "/workspace",
      run: async () => `${REVIEWED_COMMIT}\n`,
      fetchImpl: async (url) => {
        if (url === `${BASE}/releases/379982100`) {
          return jsonResponse(releaseFixture({ releaseId: 379982100, body: "canonical body\n" }))
        }
        if (url === `${BASE}/releases/379982100/assets?per_page=100`) {
          return jsonResponse([first, second])
        }
        assert.fail(`unexpected URL ${url}`)
      },
    })
    await assert.rejects(
      reader.readReleaseSnapshot(379982100, { expectedOriginalBody: "canonical body\n" }),
      (error) => error.code === "RELEASE_ASSETS_MALFORMED",
    )
  }
})

test("candidate Release listing rejects unsafe pagination and does not expose remote bodies in errors", async () => {
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    token: "secret-token",
    fetchImpl: async () =>
      jsonResponse([{ id: 1, body: "secret remote body" }], 200, {
        link: '<https://evil.example/releases?page=2>; rel="next"',
      }),
  })

  await assert.rejects(reader.listCandidateReleases(), (error) => {
    assert.equal(error.message.includes("secret-token"), false)
    assert.equal(error.message.includes("secret remote body"), false)
    return true
  })
})

test("Release workflow runs reject unsafe or incomplete pagination", async () => {
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) => {
      if (url.includes(`head_sha=${CANDIDATE_SHA}`)) {
        return jsonResponse({ total_count: 0, workflow_runs: [] })
      }
      return jsonResponse(
        {
          total_count: 101,
          workflow_runs: Array.from({ length: 100 }, (_, index) => releaseRun(index + 1)),
        },
        200,
        {
          link: `<https://evil.example/repos/cacheplane/dawnai/actions/workflows/260503756/runs?per_page=100&page=2>; rel="next"`,
        },
      )
    },
  })

  await assert.rejects(
    reader.readReleaseRuns(),
    (error) => error.code === "PAGINATION_DRIFT" && !error.message.includes("evil.example"),
  )
})

test("recovery pagination rejects same-origin page jumps and total-count drift", async () => {
  const jumpReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) =>
      url.endsWith("page=3")
        ? jsonResponse([])
        : jsonResponse(
            Array.from({ length: 100 }, (_, index) => releaseRow(index + 1)),
            200,
            { link: `<${BASE}/releases?per_page=100&page=3>; rel="next"` },
          ),
  })
  await assert.rejects(
    jumpReader.listCandidateReleases(),
    (error) => error.code === "PAGINATION_DRIFT",
  )

  const totalsReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) =>
      url.endsWith("page=2")
        ? jsonResponse({ total_count: 102, jobs: [job(101, "publish-npm")] })
        : jsonResponse(
            {
              total_count: 101,
              jobs: Array.from({ length: 100 }, (_, index) => job(index + 1, "prepare")),
            },
            200,
            { link: `<${BASE}/actions/runs/10/jobs?filter=all&per_page=100&page=2>; rel="next"` },
          ),
  })
  await assert.rejects(
    totalsReader.readCandidatePublishJobs(10),
    (error) => error.code === "PAGINATION_DRIFT",
  )
})

test("recovery pagination exhausts hidden Release, asset, and job pages", async () => {
  const releaseReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) =>
      url.endsWith("page=2")
        ? jsonResponse([
            releaseRow(400000000, {
              tag_name: "v0.8.22",
              draft: false,
              immutable: true,
            }),
          ])
        : jsonResponse(
            Array.from({ length: 100 }, (_, index) => releaseRow(index + 1)),
            200,
            { link: `<${BASE}/releases?per_page=100&page=2>; rel="next"` },
          ),
  })
  assert.deepEqual(
    (await releaseReader.listCandidateReleases()).map(({ releaseId }) => releaseId),
    [400000000],
  )

  const releaseId = 379982100
  const assetReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) => {
      if (url === `${BASE}/releases/${releaseId}`) {
        return jsonResponse(releaseFixture({ releaseId, body: "canonical body\n" }))
      }
      if (url.endsWith("page=2")) {
        return jsonResponse([asset(101, "hidden.tgz", Buffer.from("hidden"))])
      }
      return jsonResponse(
        Array.from({ length: 100 }, (_, index) =>
          asset(index + 1, `base-${index + 1}.tgz`, Buffer.from(`base-${index + 1}`)),
        ),
        200,
        { link: `<${BASE}/releases/${releaseId}/assets?per_page=100&page=2>; rel="next"` },
      )
    },
  })
  assert.equal(
    (await assetReader.readReleaseSnapshot(releaseId, { expectedOriginalBody: "canonical body\n" }))
      .assets.length,
    101,
  )

  const jobReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) =>
      url.endsWith("page=2")
        ? jsonResponse({ total_count: 101, jobs: [job(101, "publish-npm")] })
        : jsonResponse(
            {
              total_count: 101,
              jobs: Array.from({ length: 100 }, (_, index) => job(index + 1, "prepare")),
            },
            200,
            { link: `<${BASE}/actions/runs/10/jobs?filter=all&per_page=100&page=2>; rel="next"` },
          ),
  })
  assert.equal((await jobReader.readCandidatePublishJobs(10)).at(-1).name, "publish-npm")
})

test("recovery pagination enforces one cumulative response-byte budget", async () => {
  const pages = [
    Array.from({ length: 100 }, (_, index) => releaseRow(index + 1)),
    Array.from({ length: 100 }, (_, index) => releaseRow(index + 101)),
  ]
  const pageBytes = Buffer.byteLength(JSON.stringify(pages[0]))
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    maxResponseBytes: pageBytes + 100,
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) =>
      url.endsWith("page=2")
        ? jsonResponse(pages[1])
        : jsonResponse(pages[0], 200, {
            link: `<${BASE}/releases?per_page=100&page=2>; rel="next"`,
          }),
  })
  await assert.rejects(reader.listCandidateReleases(), (error) => /LIMIT|LARGE/u.test(error.code))
})

test("recovery pagination enforces one cumulative operation deadline", async () => {
  const clock = [0, 0, 10]
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    timeoutMs: 10,
    now: () => clock.shift() ?? 10,
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async () =>
      jsonResponse(
        Array.from({ length: 100 }, (_, index) => releaseRow(index + 1)),
        200,
        { link: `<${BASE}/releases?per_page=100&page=2>; rel="next"` },
      ),
  })
  await assert.rejects(
    reader.listCandidateReleases(),
    (error) => error.code === "RELEASE_LIST_UNAVAILABLE",
  )
})

function reviewedReader({
  pulls = [reviewedPull()],
  mainSha = REVIEWED_COMMIT,
  headTree = TREE,
  checkConclusion = "success",
} = {}) {
  return createDuplicateDraftRecoveryReader({
    root: "/workspace",
    token: "secret-token",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) => {
      if (url === BASE) return repositoryResponse()
      if (url === `${BASE}/git/ref/heads%2Fmain`) return jsonResponse(mainRef(mainSha))
      if (url === `${BASE}/commits/${REVIEWED_COMMIT}/pulls?per_page=2`) {
        return jsonResponse(pulls)
      }
      if (url === `${BASE}/git/commits/${REVIEWED_COMMIT}`) {
        return jsonResponse({ sha: REVIEWED_COMMIT, tree: { sha: TREE } })
      }
      if (url === `${BASE}/git/commits/${REVIEWED_HEAD}`) {
        return jsonResponse({ sha: REVIEWED_HEAD, tree: { sha: headTree } })
      }
      if (url === `${BASE}/commits/${REVIEWED_HEAD}/check-runs?per_page=100`) {
        return jsonResponse({
          total_count: 1,
          check_runs: [
            {
              id: 1,
              name: "validate",
              head_sha: REVIEWED_HEAD,
              status: "completed",
              conclusion: checkConclusion,
              check_suite: { id: 77 },
            },
          ],
        })
      }
      if (url === `${BASE}/actions/workflows/ci.yml/runs?head_sha=${REVIEWED_HEAD}&per_page=100`) {
        return jsonResponse({
          total_count: 1,
          workflow_runs: [
            {
              id: 2,
              run_attempt: 1,
              name: "CI",
              path: ".github/workflows/ci.yml",
              head_sha: REVIEWED_HEAD,
              head_branch: "reviewed-recovery",
              event: "pull_request",
              check_suite_id: 77,
              status: "completed",
              conclusion: checkConclusion,
            },
          ],
        })
      }
      assert.fail(`unexpected URL ${url}`)
    },
  })
}

function reviewedPull() {
  return {
    number: 789,
    state: "closed",
    merged_at: "2026-09-01T00:00:00Z",
    merge_commit_sha: REVIEWED_COMMIT,
    base: {
      ref: "main",
      repo: { id: 1210070282, full_name: "cacheplane/dawnai" },
    },
    head: { sha: REVIEWED_HEAD },
  }
}

function repositoryResponse() {
  return jsonResponse({
    id: 1210070282,
    name: "dawnai",
    full_name: "cacheplane/dawnai",
    default_branch: "main",
    owner: { login: "cacheplane" },
  })
}

function mainRef(sha) {
  return { ref: "refs/heads/main", object: { type: "commit", sha } }
}

function releaseRun(id) {
  return {
    id,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    head_sha: CANDIDATE_SHA,
    path: ".github/workflows/release.yml",
    created_at: "2026-09-01T00:00:00Z",
    run_started_at: "2026-09-01T00:00:01Z",
    updated_at: "2026-09-01T00:01:00Z",
  }
}

function job(id, name) {
  return {
    id,
    run_attempt: 1,
    name,
    status: "completed",
    conclusion: "success",
    started_at: "2026-09-01T00:00:00Z",
    completed_at: "2026-09-01T00:01:00Z",
  }
}

function packageVersion(name) {
  return { name, version: "0.8.21" }
}

function releaseFixture({ releaseId, body }) {
  return {
    id: releaseId,
    tag_name: "untagged-a13939767dd2419ade01",
    body,
    draft: true,
    prerelease: false,
    immutable: false,
    target_commitish: "main",
  }
}

function releaseRow(id, overrides = {}) {
  return {
    id,
    tag_name: `untagged-unrelated-${id}`,
    body: null,
    draft: true,
    prerelease: false,
    immutable: false,
    target_commitish: "main",
    ...overrides,
  }
}

function asset(id, name, bytes) {
  return {
    id,
    name,
    digest: `sha256:${sha256(bytes)}`,
    size: bytes.byteLength,
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function routingFetch(calls, route) {
  return async (url, init) => {
    calls.push({ url, init })
    return route(url, init)
  }
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function binaryResponse(value, status = 200, headers = {}) {
  return new Response(value, {
    status,
    headers: { "content-type": "application/octet-stream", ...headers },
  })
}
