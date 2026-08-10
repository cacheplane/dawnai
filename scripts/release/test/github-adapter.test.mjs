import assert from "node:assert/strict"
import test from "node:test"

import { createGitHubReader } from "../adapters/github.mjs"

const OWNER = "dawn-ai"
const REPO = "dawn"
const TOKEN = "github_secret_token"
const SHA = "0123456789abcdef0123456789abcdef01234567"
const BASE = "https://api.github.com/repos/dawn-ai/dawn"
const ALLOWED_METHODS = [
  "downloadActionsArtifact",
  "downloadReleaseAsset",
  "getActionsPermissions",
  "getActionsRun",
  "getAttestations",
  "getBranchProtection",
  "getCommitCheckRuns",
  "getRef",
  "getReleaseByTag",
  "getWorkflow",
  "getWorkflowPermissions",
  "listActionsArtifacts",
  "listEnvironments",
  "listReleaseAssets",
  "listTagRefs",
  "listWorkflowRuns",
]

test("createGitHubReader exposes only named read operations and exact GET endpoints", async () => {
  const { fetchImpl, calls } = recordingFetch([
    jsonResponse({ check_runs: [] }),
    jsonResponse({ ref: "refs/tags/v0.8.21", object: { sha: SHA } }),
    jsonResponse({ id: 7, tag_name: "v0.8.21" }),
    jsonResponse({ id: 9, head_sha: SHA }),
    jsonResponse({ attestations: [] }),
    jsonResponse({ id: 12, path: ".github/workflows/release.yml" }),
    jsonResponse({ enabled_repositories: "all" }),
    jsonResponse({ default_workflow_permissions: "read", can_approve_pull_request_reviews: false }),
    jsonResponse({ required_status_checks: {} }),
  ])
  const github = createGitHubReader({ owner: OWNER, repo: REPO, token: TOKEN, fetchImpl })

  assert.deepEqual(Object.keys(github).sort(), ALLOWED_METHODS)
  await github.getCommitCheckRuns({ commitSha: SHA })
  await github.getRef({ ref: "tags/v0.8.21" })
  await github.getReleaseByTag({ tag: "v0.8.21" })
  await github.getActionsRun({ runId: 9 })
  await github.getAttestations({ subjectDigest: `sha256:${"a".repeat(64)}` })
  await github.getWorkflow({ workflow: "release.yml" })
  await github.getActionsPermissions()
  await github.getWorkflowPermissions()
  await github.getBranchProtection({ branch: "release/0.8" })

  assert.deepEqual(
    calls.map(({ url, init }) => ({
      url,
      method: init.method,
      redirect: init.redirect,
      accept: init.headers.Accept,
      version: init.headers["X-GitHub-Api-Version"],
      authorization: init.headers.Authorization,
    })),
    [
      `${BASE}/commits/${SHA}/check-runs?per_page=100`,
      `${BASE}/git/ref/tags%2Fv0.8.21`,
      `${BASE}/releases/tags/v0.8.21`,
      `${BASE}/actions/runs/9`,
      `${BASE}/attestations/sha256%3A${"a".repeat(64)}?per_page=100`,
      `${BASE}/actions/workflows/release.yml`,
      `${BASE}/actions/permissions`,
      `${BASE}/actions/permissions/workflow`,
      `${BASE}/branches/release%2F0.8/protection`,
    ].map((url) => ({
      url,
      method: "GET",
      redirect: "manual",
      accept: "application/vnd.github+json",
      version: "2022-11-28",
      authorization: `Bearer ${TOKEN}`,
    })),
  )
})

test("GitHub list methods follow same-origin pagination and return stable records", async () => {
  const nextTags = `${BASE}/git/matching-refs/tags/?per_page=100&page=2`
  const nextArtifacts = `${BASE}/actions/artifacts?per_page=100&name=release-evidence&page=2`
  const { fetchImpl, calls } = recordingFetch([
    jsonResponse([{ ref: "refs/tags/v2" }], 200, linkHeader(nextTags)),
    jsonResponse([{ ref: "refs/tags/v1" }]),
    jsonResponse({ artifacts: [{ id: 20, name: "z" }] }, 200, linkHeader(nextArtifacts)),
    jsonResponse({ artifacts: [{ id: 10, name: "a" }] }),
    jsonResponse([
      { id: 2, name: "z.tgz" },
      { id: 1, name: "a.tgz" },
    ]),
    jsonResponse({ workflow_runs: [{ id: 4 }, { id: 3 }] }),
    jsonResponse({ environments: [{ name: "release" }, { name: "audit" }] }),
  ])
  const github = createGitHubReader({ owner: OWNER, repo: REPO, fetchImpl })

  assert.deepEqual((await github.listTagRefs()).value, [
    { ref: "refs/tags/v1" },
    { ref: "refs/tags/v2" },
  ])
  assert.deepEqual((await github.listActionsArtifacts({ name: "release-evidence" })).value, [
    { id: 10, name: "a" },
    { id: 20, name: "z" },
  ])
  assert.deepEqual((await github.listReleaseAssets({ releaseId: 7 })).value, [
    { id: 1, name: "a.tgz" },
    { id: 2, name: "z.tgz" },
  ])
  assert.deepEqual(
    (await github.listWorkflowRuns({ workflow: "release.yml", commitSha: SHA })).value,
    [{ id: 3 }, { id: 4 }],
  )
  assert.deepEqual((await github.listEnvironments()).value, [
    { name: "audit" },
    { name: "release" },
  ])
  assert.deepEqual(
    calls.map(({ url, init }) => [url, init.method]),
    [
      [`${BASE}/git/matching-refs/tags/?per_page=100`, "GET"],
      [nextTags, "GET"],
      [`${BASE}/actions/artifacts?per_page=100&name=release-evidence`, "GET"],
      [nextArtifacts, "GET"],
      [`${BASE}/releases/7/assets?per_page=100`, "GET"],
      [`${BASE}/actions/workflows/release.yml/runs?head_sha=${SHA}&per_page=100`, "GET"],
      [`${BASE}/environments?per_page=100`, "GET"],
    ],
  )
})

test("GitHub download methods return JSON-safe base64 without exposing response clients", async () => {
  const { fetchImpl, calls } = recordingFetch([
    binaryResponse(new Uint8Array([0, 255])),
    binaryResponse(new Uint8Array([1, 2, 3])),
  ])
  const github = createGitHubReader({ owner: OWNER, repo: REPO, token: TOKEN, fetchImpl })

  assert.deepEqual(await github.downloadReleaseAsset({ assetId: 7 }), {
    status: "PRESENT",
    operation: "release-asset-download",
    httpStatus: 200,
    code: null,
    contentBase64: "AP8=",
  })
  assert.deepEqual(await github.downloadActionsArtifact({ artifactId: 8 }), {
    status: "PRESENT",
    operation: "actions-artifact-download",
    httpStatus: 200,
    code: null,
    contentBase64: "AQID",
  })
  assert.deepEqual(
    calls.map(({ url, init }) => [url, init.method, init.headers.Accept]),
    [
      [`${BASE}/releases/assets/7`, "GET", "application/octet-stream"],
      [`${BASE}/actions/artifacts/8/zip`, "GET", "application/octet-stream"],
    ],
  )
})

test("GitHub downloads follow one approved signed redirect without forwarding API credentials", async () => {
  const releaseLocation =
    "https://release-assets.githubusercontent.com/github-production-release-asset/1/asset.zip?sig=release"
  const actionsLocation =
    "https://productionresultssa0.blob.core.windows.net/actions-results/run/artifact.zip?sig=actions"
  const { fetchImpl, calls } = recordingFetch([
    redirectResponse(releaseLocation),
    binaryResponse(new Uint8Array([1, 2])),
    redirectResponse(actionsLocation),
    binaryResponse(new Uint8Array([3, 4])),
  ])
  const github = createGitHubReader({ owner: OWNER, repo: REPO, token: TOKEN, fetchImpl })

  assert.equal((await github.downloadReleaseAsset({ assetId: 7 })).contentBase64, "AQI=")
  assert.equal((await github.downloadActionsArtifact({ artifactId: 8 })).contentBase64, "AwQ=")
  assert.deepEqual(
    calls.map(({ url, init }) => ({ url, headers: init.headers, redirect: init.redirect })),
    [
      {
        url: `${BASE}/releases/assets/7`,
        headers: {
          Accept: "application/octet-stream",
          Authorization: `Bearer ${TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "manual",
      },
      { url: releaseLocation, headers: {}, redirect: "manual" },
      {
        url: `${BASE}/actions/artifacts/8/zip`,
        headers: {
          Accept: "application/octet-stream",
          Authorization: `Bearer ${TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "manual",
      },
      { url: actionsLocation, headers: {}, redirect: "manual" },
    ],
  )
})

test("GitHub downloads reject unsafe destinations and a second redirect", async () => {
  const unsafeLocations = [
    "http://release-assets.githubusercontent.com/asset.zip",
    "https://user:secret@release-assets.githubusercontent.com/asset.zip",
    "https://release-assets.githubusercontent.com/asset.zip#fragment",
    "https://127.0.0.1/asset.zip",
    "https://release-assets.githubusercontent.com.evil.test/asset.zip",
    "https://github.com/asset.zip",
    "https://productionresultssa0.blob.core.windows.net.evil.test/asset.zip",
  ]

  for (const location of unsafeLocations) {
    const recording = recordingFetch([redirectResponse(location)])
    const result = await createGitHubReader({
      owner: OWNER,
      repo: REPO,
      token: TOKEN,
      fetchImpl: recording.fetchImpl,
    }).downloadReleaseAsset({ assetId: 7 })
    assert.equal(result.status, "ERROR")
    assert.equal(result.code, "UNSAFE_DOWNLOAD_URL")
    assert.equal(recording.calls.length, 1)
    assert.doesNotMatch(JSON.stringify(result), /secret|evil/iu)
  }

  const secondRedirect = recordingFetch([
    redirectResponse("https://release-assets.githubusercontent.com/asset.zip?sig=1"),
    redirectResponse("https://release-assets.githubusercontent.com/asset.zip?sig=2"),
  ])
  assert.deepEqual(
    await createGitHubReader({
      owner: OWNER,
      repo: REPO,
      token: TOKEN,
      fetchImpl: secondRedirect.fetchImpl,
    }).downloadReleaseAsset({ assetId: 7 }),
    {
      status: "ERROR",
      operation: "release-asset-download",
      httpStatus: 302,
      code: "REDIRECT",
    },
  )
})

test("GitHub download redirect hops share one deadline and one byte budget", async () => {
  const location = "https://release-assets.githubusercontent.com/asset.zip?sig=1"
  let calls = 0
  const timeout = createGitHubReader({
    owner: OWNER,
    repo: REPO,
    timeoutMs: 10,
    fetchImpl: async (_url, init) => {
      calls += 1
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 8))
        return redirectResponse(location)
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("", "AbortError")), {
          once: true,
        })
      })
    },
  })
  assert.equal((await timeout.downloadReleaseAsset({ assetId: 7 })).code, "TIMEOUT")

  const oversized = createGitHubReader({
    owner: OWNER,
    repo: REPO,
    maxResponseBytes: 4,
    fetchImpl: recordingFetch([
      redirectResponse(location),
      binaryResponse(new Uint8Array([1, 2, 3, 4, 5])),
    ]).fetchImpl,
  })
  assert.equal((await oversized.downloadReleaseAsset({ assetId: 7 })).code, "OPERATION_TOO_LARGE")
})

test("GitHub canonicalization rejects unsafe remote keys without prototype mutation or secrets", async () => {
  const fixtures = [
    `{"${TOKEN}":"value"}`,
    '{"__proto__":{"polluted":true}}',
    '{"constructor":{"prototype":{"polluted":true}}}',
    '{"nested":{"prototype":{"polluted":true}}}',
  ]
  for (const fixture of fixtures) {
    const result = await createGitHubReader({
      owner: OWNER,
      repo: REPO,
      token: TOKEN,
      fetchImpl: async () => jsonResponse(JSON.parse(fixture)),
    }).getRef({ ref: "tags/v0.8.21" })
    assert.deepEqual(result, {
      status: "ERROR",
      operation: "ref",
      httpStatus: 200,
      code: "UNSAFE_RESPONSE_KEY",
    })
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN, "u"))
    assert.equal(Object.prototype.polluted, undefined)
  }
})

test("GitHub distinguishes exact absence from auth, rate, network, parse, and server failures", async () => {
  const cases = [
    {
      response: jsonResponse({ message: "not found" }, 404),
      status: "AMBIGUOUS",
      code: "NOT_FOUND_OR_HIDDEN",
      httpStatus: 404,
    },
    {
      response: jsonResponse({ message: TOKEN }, 401),
      status: "AMBIGUOUS",
      code: "UNAUTHORIZED",
      httpStatus: 401,
    },
    {
      response: jsonResponse({ message: TOKEN }, 403),
      status: "AMBIGUOUS",
      code: "FORBIDDEN",
      httpStatus: 403,
    },
    {
      response: jsonResponse({ message: TOKEN }, 403, { "x-ratelimit-remaining": "0" }),
      status: "AMBIGUOUS",
      code: "RATE_LIMITED",
      httpStatus: 403,
    },
    {
      response: jsonResponse({ message: TOKEN }, 429),
      status: "AMBIGUOUS",
      code: "RATE_LIMITED",
      httpStatus: 429,
    },
    {
      response: jsonResponse({ message: TOKEN }, 503),
      status: "AMBIGUOUS",
      code: "SERVER_ERROR",
      httpStatus: 503,
    },
    {
      response: new Response("{", { headers: { "content-type": "application/json" } }),
      status: "ERROR",
      code: "MALFORMED_JSON",
      httpStatus: 200,
    },
    {
      response: new Response("{}", { headers: { "content-type": "text/html" } }),
      status: "ERROR",
      code: "UNEXPECTED_CONTENT_TYPE",
      httpStatus: 200,
    },
  ]

  for (const row of cases) {
    const github = createGitHubReader({
      owner: OWNER,
      repo: REPO,
      token: TOKEN,
      fetchImpl: async () => row.response,
    })
    const result = await github.getRef({ ref: "tags/v0.8.21" })
    assert.deepEqual(result, {
      status: row.status,
      operation: "ref",
      httpStatus: row.httpStatus,
      code: row.code,
    })
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN, "u"))
  }

  for (const error of [new DOMException(TOKEN, "AbortError"), new Error(`Bearer ${TOKEN}`)]) {
    const github = createGitHubReader({
      owner: OWNER,
      repo: REPO,
      token: TOKEN,
      fetchImpl: async () => {
        throw error
      },
    })
    const result = await github.getRef({ ref: "tags/v0.8.21" })
    assert.equal(result.status, "AMBIGUOUS")
    assert.equal(result.httpStatus, null)
    assert.equal(result.code, error.name === "AbortError" ? "ABORTED" : "NETWORK_ERROR")
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN, "u"))
  }
})

test("GitHub raw 404 stays ambiguous for every named resource family", async () => {
  const calls = [
    (github) => github.getRef({ ref: "tags/v0.8.21" }),
    (github) => github.getReleaseByTag({ tag: "v0.8.21" }),
    (github) => github.listReleaseAssets({ releaseId: 7 }),
    (github) => github.downloadReleaseAsset({ assetId: 7 }),
    (github) => github.getWorkflow({ workflow: "release.yml" }),
    (github) => github.getActionsRun({ runId: 9 }),
    (github) => github.getActionsPermissions(),
    (github) => github.getWorkflowPermissions(),
    (github) => github.getBranchProtection({ branch: "main" }),
  ]

  for (const call of calls) {
    const github = createGitHubReader({
      owner: OWNER,
      repo: REPO,
      token: TOKEN,
      fetchImpl: async () => jsonResponse({ message: "resource hidden by authorization" }, 404),
    })
    const result = await call(github)
    assert.equal(result.status, "AMBIGUOUS")
    assert.equal(result.httpStatus, 404)
    assert.equal(result.code, "NOT_FOUND_OR_HIDDEN")
    assert.doesNotMatch(
      JSON.stringify(result),
      /resource hidden by authorization|github_secret_token/iu,
    )
  }
})

test("GitHub rejects malformed JSON shapes and unsafe pagination", async () => {
  const malformed = createGitHubReader({
    owner: OWNER,
    repo: REPO,
    fetchImpl: async () => jsonResponse({ check_runs: "not-an-array" }),
  })
  assert.deepEqual(await malformed.getCommitCheckRuns({ commitSha: SHA }), {
    status: "ERROR",
    operation: "commit-check-runs",
    httpStatus: 200,
    code: "MALFORMED_SCHEMA",
  })

  for (const unsafeUrl of [
    "https://evil.example/next",
    `https://user:secret@api.github.com/repos/${OWNER}/${REPO}/next`,
    `https://api.github.com/repos/${OWNER}/${REPO}-lookalike/next`,
    `${BASE}/actions/artifacts?per_page=100&page=2`,
  ]) {
    const unsafe = createGitHubReader({
      owner: OWNER,
      repo: REPO,
      fetchImpl: async () => jsonResponse([], 200, linkHeader(unsafeUrl)),
    })
    assert.deepEqual(await unsafe.listTagRefs(), {
      status: "ERROR",
      operation: "tag-refs",
      httpStatus: 200,
      code: "UNSAFE_PAGINATION_URL",
    })
  }
})

test("GitHub rejects malformed or ambiguous Link headers instead of truncating lists", async () => {
  const next = `${BASE}/git/matching-refs/tags/?per_page=100&page=2`
  const malformedLinks = [
    `<${next}>; rel="next`,
    `<${next}>; rel="next"; broken`,
    `<${next}>; rel="next"; rel="prev"`,
    `<${next}>; rel="next next"`,
    `<${next}>; rel="next prev"`,
    `<${next}>; rel="next", <${next}>; rel="next"`,
    `garbage, <${next}>; rel="next"`,
  ]

  for (const link of malformedLinks) {
    const recording = recordingFetch([jsonResponse([{ ref: "refs/tags/v1" }], 200, { link })])
    const result = await createGitHubReader({
      owner: OWNER,
      repo: REPO,
      fetchImpl: recording.fetchImpl,
    }).listTagRefs()

    assert.deepEqual(result, {
      status: "ERROR",
      operation: "tag-refs",
      httpStatus: 200,
      code: "MALFORMED_LINK_HEADER",
    })
    assert.equal(recording.calls.length, 1)
  }

  const previousOnly = createGitHubReader({
    owner: OWNER,
    repo: REPO,
    fetchImpl: async () =>
      jsonResponse([{ ref: "refs/tags/v1" }], 200, {
        link: `<${next}>; rel="prev"; type="application/json"`,
      }),
  })
  assert.deepEqual((await previousOnly.listTagRefs()).value, [{ ref: "refs/tags/v1" }])
})

test("GitHub pagination preserves exact endpoint and fixed filters", async () => {
  const mutations = [
    `${BASE}/actions/workflows/release.yml/runs?head_sha=${"f".repeat(40)}&per_page=100&page=2`,
    `${BASE}/actions/workflows/release.yml/runs?head_sha=${SHA}&status=success&per_page=100&page=2`,
    `${BASE}/actions/workflows/other.yml/runs?head_sha=${SHA}&per_page=100&page=2`,
    `${BASE}/actions/workflows/release.yml/runs?head_sha=${SHA}&per_page=100&after=cursor_123`,
  ]

  for (const next of mutations) {
    const github = createGitHubReader({
      owner: OWNER,
      repo: REPO,
      fetchImpl: async () => jsonResponse({ workflow_runs: [] }, 200, linkHeader(next)),
    })

    assert.deepEqual(await github.listWorkflowRuns({ workflow: "release.yml", commitSha: SHA }), {
      status: "ERROR",
      operation: "workflow-runs",
      httpStatus: 200,
      code: "UNSAFE_PAGINATION_URL",
    })
  }
})

test("GitHub pagination enforces total page and record limits", async () => {
  const next = `${BASE}/git/matching-refs/tags/?per_page=100&page=2`
  const pageLimited = createGitHubReader({
    owner: OWNER,
    repo: REPO,
    maxPages: 1,
    fetchImpl: async () => jsonResponse([{ ref: "refs/tags/v1" }], 200, linkHeader(next)),
  })
  assert.deepEqual(await pageLimited.listTagRefs(), {
    status: "ERROR",
    operation: "tag-refs",
    httpStatus: 200,
    code: "PAGE_LIMIT_EXCEEDED",
  })

  const recordLimited = createGitHubReader({
    owner: OWNER,
    repo: REPO,
    maxRecords: 1,
    fetchImpl: async () => jsonResponse([{ ref: "refs/tags/v1" }, { ref: "refs/tags/v2" }]),
  })
  assert.deepEqual(await recordLimited.listTagRefs(), {
    status: "ERROR",
    operation: "tag-refs",
    httpStatus: 200,
    code: "RECORD_LIMIT_EXCEEDED",
  })
})

test("GitHub pagination shares one cumulative byte and wall-clock budget", async () => {
  const next = `${BASE}/git/matching-refs/tags/?per_page=100&page=2`
  const note = "x".repeat(45)
  const bytes = recordingFetch([
    jsonResponse([{ ref: "refs/tags/v1", note }], 200, linkHeader(next)),
    jsonResponse([{ ref: "refs/tags/v2", note }]),
  ])
  const byteLimited = createGitHubReader({
    owner: OWNER,
    repo: REPO,
    maxResponseBytes: 100,
    fetchImpl: bytes.fetchImpl,
  })
  assert.deepEqual(await byteLimited.listTagRefs(), {
    status: "ERROR",
    operation: "tag-refs",
    httpStatus: 200,
    code: "OPERATION_TOO_LARGE",
  })
  assert.equal(bytes.calls.length, 2)

  let calls = 0
  let now = 1_000
  const timeout = createGitHubReader({
    owner: OWNER,
    repo: REPO,
    timeoutMs: 12,
    now: () => now,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        now += 12
        return jsonResponse([{ ref: "refs/tags/v1" }], 200, linkHeader(next))
      }
      return jsonResponse([{ ref: "refs/tags/v2" }])
    },
  })
  assert.deepEqual(await timeout.listTagRefs(), {
    status: "AMBIGUOUS",
    operation: "tag-refs",
    httpStatus: null,
    code: "TIMEOUT",
  })
  assert.equal(calls, 1, "an expired operation deadline must prevent the next page request")
})

test("GitHub attestations paginate completely and sort independent of page order", async () => {
  const digest = `sha256:${"a".repeat(64)}`
  const endpoint = `${BASE}/attestations/${encodeURIComponent(digest)}?per_page=100`
  const secondPage = `${endpoint}&after=eyJhdHRlc3RhdGlvbl9pZCI6MTIzNDU2fQ`
  const first = { id: 1, bundle: { mediaType: "application/example+a" } }
  const second = { id: 2, bundle: { mediaType: "application/example+b" } }

  const forward = recordingFetch([
    jsonResponse({ attestations: [second] }, 200, linkHeader(secondPage)),
    jsonResponse({ attestations: [first] }),
  ])
  const reversed = recordingFetch([
    jsonResponse({ attestations: [first] }, 200, linkHeader(secondPage)),
    jsonResponse({ attestations: [second] }),
  ])

  const forwardResult = await createGitHubReader({
    owner: OWNER,
    repo: REPO,
    fetchImpl: forward.fetchImpl,
  }).getAttestations({ subjectDigest: digest })
  const reversedResult = await createGitHubReader({
    owner: OWNER,
    repo: REPO,
    fetchImpl: reversed.fetchImpl,
  }).getAttestations({ subjectDigest: digest })

  assert.deepEqual(forwardResult.value, [first, second])
  assert.deepEqual(reversedResult.value, forwardResult.value)
  assert.deepEqual(
    forward.calls.map(({ url }) => url),
    [endpoint, secondPage],
  )
})

test("GitHub attestation pagination accepts one bounded before or after cursor only", async () => {
  const digest = `sha256:${"a".repeat(64)}`
  const endpoint = `${BASE}/attestations/${encodeURIComponent(digest)}?per_page=100`

  for (const cursorQuery of ["before=cursor_123", "after=cursor-456_abC.789~xyz"]) {
    const next = `${endpoint}&${cursorQuery}`
    const recording = recordingFetch([
      jsonResponse({ attestations: [{ id: 2 }] }, 200, linkHeader(next)),
      jsonResponse({ attestations: [{ id: 1 }] }),
    ])

    const result = await createGitHubReader({
      owner: OWNER,
      repo: REPO,
      fetchImpl: recording.fetchImpl,
    }).getAttestations({ subjectDigest: digest })

    assert.deepEqual(result.value, [{ id: 1 }, { id: 2 }])
    assert.deepEqual(
      recording.calls.map(({ url }) => url),
      [endpoint, next],
    )
  }
})

test("GitHub attestation pagination rejects duplicate, mixed, and malformed cursors", async () => {
  const digest = `sha256:${"a".repeat(64)}`
  const endpoint = `${BASE}/attestations/${encodeURIComponent(digest)}?per_page=100`
  const unsafeQueries = [
    "after=cursor_1&after=cursor_2",
    "before=cursor_1&before=cursor_2",
    "before=cursor_1&after=cursor_2",
    "page=2&after=cursor_1",
    "after=cursor%20with%20spaces",
    "after=cursor_1#fragment",
    `after=${"a".repeat(513)}`,
  ]

  for (const query of unsafeQueries) {
    const github = createGitHubReader({
      owner: OWNER,
      repo: REPO,
      fetchImpl: async () =>
        jsonResponse({ attestations: [] }, 200, linkHeader(`${endpoint}&${query}`)),
    })

    assert.deepEqual(await github.getAttestations({ subjectDigest: digest }), {
      status: "ERROR",
      operation: "attestations",
      httpStatus: 200,
      code: "UNSAFE_PAGINATION_URL",
    })
  }
})

test("GitHub attestation pagination rejects another subject endpoint", async () => {
  const digest = `sha256:${"a".repeat(64)}`
  const otherDigest = `sha256:${"b".repeat(64)}`
  const github = createGitHubReader({
    owner: OWNER,
    repo: REPO,
    fetchImpl: async () =>
      jsonResponse(
        { attestations: [] },
        200,
        linkHeader(`${BASE}/attestations/${encodeURIComponent(otherDigest)}?per_page=100&page=2`),
      ),
  })

  assert.deepEqual(await github.getAttestations({ subjectDigest: digest }), {
    status: "ERROR",
    operation: "attestations",
    httpStatus: 200,
    code: "UNSAFE_PAGINATION_URL",
  })
})

test("GitHub validates repository identity and every dynamic argument before fetching", () => {
  for (const identity of [
    { owner: "", repo: REPO },
    { owner: "../dawn-ai", repo: REPO },
    { owner: OWNER, repo: "dawn/repo" },
    { owner: OWNER, repo: "--help" },
  ]) {
    assert.throws(
      () => createGitHubReader({ ...identity, fetchImpl: assert.fail }),
      /owner|repository/u,
    )
  }
  assert.throws(
    () =>
      createGitHubReader({ owner: OWNER, repo: REPO, token: "bad\ntoken", fetchImpl: assert.fail }),
    /token/u,
  )

  const github = createGitHubReader({ owner: OWNER, repo: REPO, fetchImpl: assert.fail })
  assert.throws(() => github.getCommitCheckRuns({ commitSha: "main" }), /commit SHA/u)
  assert.throws(() => github.getRef({ ref: "--help" }), /ref/u)
  assert.throws(() => github.getReleaseByTag({ tag: "refs/tags/v1" }), /tag/u)
  assert.throws(() => github.getActionsRun({ runId: 0 }), /ID/u)
  assert.throws(() => github.listReleaseAssets({ releaseId: 1.5 }), /ID/u)
  assert.throws(() => github.listActionsArtifacts({ name: "release evidence" }), /name/u)
  assert.throws(() => github.getWorkflow({ workflow: "../release.yml" }), /workflow/u)
  assert.throws(() => github.getAttestations({ subjectDigest: "sha256:nope" }), /digest/u)
  assert.throws(() => github.getBranchProtection({ branch: "../main" }), /branch/u)
})

test("GitHub rejects oversized identity and operation inputs before parsing or fetching", () => {
  for (const identity of [
    { owner: "o".repeat(1_000), repo: REPO },
    { owner: OWNER, repo: "r".repeat(1_000) },
  ]) {
    assert.throws(
      () => createGitHubReader({ ...identity, fetchImpl: assert.fail }),
      stableInputTooLong,
    )
  }
  const github = createGitHubReader({ owner: OWNER, repo: REPO, fetchImpl: assert.fail })
  for (const invoke of [
    () => github.getRef({ ref: `r${"a".repeat(2_000)}` }),
    () => github.getReleaseByTag({ tag: `v${"a".repeat(2_000)}` }),
    () => github.listActionsArtifacts({ name: `a${"a".repeat(2_000)}` }),
    () => github.getWorkflow({ workflow: `w${"a".repeat(2_000)}` }),
    () => github.getActionsRun({ runId: "1".repeat(100) }),
    () => github.getAttestations({ subjectDigest: `sha256:${"a".repeat(2_000)}` }),
  ]) {
    assert.throws(invoke, stableInputTooLong)
  }
})

test("GitHub validation errors never echo control characters", () => {
  assert.throws(
    () => createGitHubReader({ owner: "dawn\nforged", repo: REPO, fetchImpl: assert.fail }),
    errorWithoutControls,
  )
  const github = createGitHubReader({ owner: OWNER, repo: REPO, fetchImpl: assert.fail })
  for (const invoke of [
    () => github.getRef({ ref: "tags/v1\nforged" }),
    () => github.getActionsRun({ runId: "1\rforged" }),
    () => github.getAttestations({ subjectDigest: "sha256:a\nforged" }),
  ]) {
    assert.throws(invoke, errorWithoutControls)
  }
})

test("GitHub applies bounded deadlines, response limits, and numeric status validation", async () => {
  const timeout = createGitHubReader({
    owner: OWNER,
    repo: REPO,
    timeoutMs: 5,
    fetchImpl: async (_url, init) => {
      if (!(init.signal instanceof AbortSignal)) {
        throw new Error("missing bounded signal")
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("github_secret_token", "AbortError")),
          { once: true },
        )
      })
    },
  })
  assert.deepEqual(await timeout.getRef({ ref: "tags/v0.8.21" }), {
    status: "AMBIGUOUS",
    operation: "ref",
    httpStatus: null,
    code: "TIMEOUT",
  })

  const oversized = createGitHubReader({
    owner: OWNER,
    repo: REPO,
    maxResponseBytes: 4,
    fetchImpl: async () => jsonResponse({ ref: "refs/tags/v0.8.21" }),
  })
  assert.deepEqual(await oversized.getRef({ ref: "tags/v0.8.21" }), {
    status: "ERROR",
    operation: "ref",
    httpStatus: 200,
    code: "RESPONSE_TOO_LARGE",
  })

  for (const response of [
    responseLike({ status: 99, ok: true, body: "{}" }),
    responseLike({ status: 600, ok: true, body: "{}" }),
  ]) {
    const result = await createGitHubReader({
      owner: OWNER,
      repo: REPO,
      fetchImpl: async () => response,
    }).getRef({ ref: "tags/v0.8.21" })
    assert.equal(result.status, "ERROR")
    assert.equal(result.code, "MALFORMED_RESPONSE")
  }

  const concealed = createGitHubReader({
    owner: OWNER,
    repo: REPO,
    fetchImpl: async () =>
      responseLike({
        status: 404,
        ok: true,
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
  })
  assert.equal((await concealed.getRef({ ref: "tags/v0.8.21" })).status, "AMBIGUOUS")
})

test("GitHub normalized lists have a canonical total order after primary-key ties", async () => {
  const pairs = [
    [
      (github) => github.getCommitCheckRuns({ commitSha: SHA }),
      (items) => ({ check_runs: items }),
      [
        { id: 1, name: "ci", conclusion: "success" },
        { id: 1, name: "ci", conclusion: "failure" },
      ],
    ],
    [
      (github) => github.listTagRefs(),
      (items) => items,
      [
        { ref: "refs/tags/v1", object: { sha: "b" } },
        { ref: "refs/tags/v1", object: { sha: "a" } },
      ],
    ],
    [
      (github) => github.listReleaseAssets({ releaseId: 7 }),
      (items) => items,
      [
        { id: 1, name: "asset", size: 2 },
        { id: 1, name: "asset", size: 1 },
      ],
    ],
    [
      (github) => github.listActionsArtifacts({ name: "evidence" }),
      (items) => ({ artifacts: items }),
      [
        { id: 1, name: "evidence", size_in_bytes: 2 },
        { id: 1, name: "evidence", size_in_bytes: 1 },
      ],
    ],
    [
      (github) => github.listWorkflowRuns({ workflow: "release.yml", commitSha: SHA }),
      (items) => ({ workflow_runs: items }),
      [
        { id: 1, name: "release", run_attempt: 2 },
        { id: 1, name: "release", run_attempt: 1 },
      ],
    ],
    [
      (github) => github.getAttestations({ subjectDigest: `sha256:${"a".repeat(64)}` }),
      (items) => ({ attestations: items }),
      [
        { id: 1, bundle: { mediaType: "z" } },
        { id: 1, bundle: { mediaType: "a" } },
      ],
    ],
    [
      (github) => github.listEnvironments(),
      (items) => ({ environments: items }),
      [
        { name: "release", protection_rules: [{ type: "z" }] },
        { name: "release", protection_rules: [{ type: "a" }] },
      ],
    ],
  ]

  for (const [observe, responseBody, items] of pairs) {
    const forward = createGitHubReader({
      owner: OWNER,
      repo: REPO,
      fetchImpl: async () => jsonResponse(responseBody(items)),
    })
    const reversed = createGitHubReader({
      owner: OWNER,
      repo: REPO,
      fetchImpl: async () => jsonResponse(responseBody([...items].reverse())),
    })
    assert.equal(JSON.stringify(await observe(forward)), JSON.stringify(await observe(reversed)))
  }
})

function recordingFetch(responses) {
  const calls = []
  return {
    calls,
    async fetchImpl(url, init) {
      calls.push({ url: String(url), init })
      const response = responses.shift()
      assert.ok(response, `Unexpected request for ${String(url)}`)
      return response
    },
  }
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function binaryResponse(bytes, status = 200) {
  return new Response(bytes, {
    status,
    headers: { "content-type": "application/octet-stream" },
  })
}

function redirectResponse(location, status = 302) {
  return new Response(null, { status, headers: { location } })
}

function linkHeader(next) {
  return { link: `<${next}>; rel="next"` }
}

function responseLike({ status, ok, body, headers = { "content-type": "application/json" } }) {
  const bytes = new TextEncoder().encode(body)
  return {
    status,
    ok,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}

function stableInputTooLong(error) {
  return error?.code === "INPUT_TOO_LONG" && !error.message.includes("a".repeat(100))
}

function errorWithoutControls(error) {
  return ![...(error?.message ?? "")].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127
  })
}
