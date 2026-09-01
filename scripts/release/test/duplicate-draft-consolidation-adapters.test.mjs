import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  createDuplicateDraftConsolidationAdapters,
  createExactDuplicateDeleteEffect,
} from "../duplicate-draft-consolidation-adapters.mjs"

const REPOSITORY = "cacheplane/dawnai"
const API_ORIGIN = "https://api.github.com"
const BASE = `${API_ORIGIN}/repos/${REPOSITORY}`
const SURVIVOR = "379991871"
const DUPLICATES = Object.freeze(["379982100", "379986168"])
const TOKEN = "github_test_token_123456789"
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567"
const TAG_OBJECT_SHA = "123456789abcdef0123456789abcdef012345678"
const USER_AGENT = "dawn-duplicate-draft-consolidation/1"
const NOW = "2026-09-01T12:34:56.789Z"

test("composition resolves an injected token in memory and sends it only in trusted headers", async () => {
  const recording = recordingFetch([
    jsonResponse({
      id: 1_210_070_282,
      full_name: REPOSITORY,
      default_branch: "main",
    }),
  ])
  const commandCalls = []
  const adapters = await createAdapters({
    token: TOKEN,
    fetchImpl: recording.fetchImpl,
    run: commandRunner(commandCalls),
  })

  assert.deepEqual(await adapters.github.getRepository(), {
    name: REPOSITORY,
    id: "1210070282",
    defaultBranch: "main",
  })
  assert.equal(
    commandCalls.some(([command, args]) => command === "gh" && args[0] === "auth"),
    false,
  )
  assert.equal(recording.calls.length, 1)
  assert.deepEqual(recording.calls[0].init.headers, githubHeaders())
  assert.equal(recording.calls[0].url, `${BASE}`)
  assert.equal(JSON.stringify(adapters).includes(TOKEN), false)
  assert.deepEqual(Object.keys(adapters).sort(), [
    "attestations",
    "github",
    "local",
    "npm",
    "writer",
  ])
})

test("composition resolves safe environment credentials before gh auth token", async () => {
  for (const [name, value] of [
    ["GH_TOKEN", "gh_environment_token"],
    ["GITHUB_TOKEN", "github_environment_token"],
  ]) {
    const recording = recordingFetch([
      jsonResponse({ id: 1_210_070_282, full_name: REPOSITORY, default_branch: "main" }),
    ])
    const calls = []
    const adapters = await createAdapters({
      token: undefined,
      environment: { HOME: "/home/release", PATH: "/tools", [name]: value },
      fetchImpl: recording.fetchImpl,
      run: commandRunner(calls),
    })

    await adapters.github.getRepository()
    assert.equal(
      calls.some(([command, args]) => command === "gh" && args[0] === "auth"),
      false,
    )
    assert.equal(recording.calls[0].init.headers.Authorization, `Bearer ${value}`)
    assert.equal(JSON.stringify(calls).includes(value), false)
    assert.equal(JSON.stringify(adapters).includes(value), false)
  }
})

test("composition falls back to one bounded non-shell gh auth token command", async () => {
  const calls = []
  const recording = recordingFetch([
    jsonResponse({ id: 1_210_070_282, full_name: REPOSITORY, default_branch: "main" }),
  ])
  const adapters = await createAdapters({
    token: undefined,
    environment: {
      HOME: "/home/release",
      PATH: "/tools",
      NODE_OPTIONS: "--require /tmp/unsafe.cjs",
      UNRELATED_SECRET: "must-not-leak",
    },
    fetchImpl: recording.fetchImpl,
    run: commandRunner(calls, { authToken: TOKEN }),
  })

  await adapters.github.getRepository()
  assert.deepEqual(calls[0], [
    "gh",
    ["auth", "token"],
    {
      cwd: "/workspace",
      env: { HOME: "/home/release", PATH: "/tools", NO_COLOR: "1" },
    },
  ])
  assert.equal(calls[0][2].shell, undefined)
  assert.equal(JSON.stringify(calls).includes(TOKEN), false)
  assert.equal(JSON.stringify(calls).includes("must-not-leak"), false)
  assert.equal(JSON.stringify(calls).includes("unsafe"), false)
  assert.equal(recording.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`)
})

test("token inputs and command output are strictly bounded and never echoed in errors", async () => {
  for (const token of [null, 42, "", "bad\ntoken", "bad\u0000token", "x".repeat(4_097)]) {
    await assert.rejects(
      createAdapters({ token, fetchImpl: assert.fail, run: assert.fail }),
      (error) => typeof token !== "string" || token.length === 0 || !String(error).includes(token),
    )
  }

  for (const stdout of ["", "bad\ntoken\n", `${"x".repeat(4_097)}\n`]) {
    await assert.rejects(
      createAdapters({
        token: undefined,
        fetchImpl: assert.fail,
        run: async () => ({ exitCode: 0, stdout, stderr: TOKEN }),
      }),
      (error) =>
        (stdout.length === 0 || !String(error).includes(stdout)) && !String(error).includes(TOKEN),
    )
  }

  const source = await readFile(
    new URL("../duplicate-draft-consolidation-adapters.mjs", import.meta.url),
    "utf8",
  )
  assert.equal(source.includes(TOKEN), false)
})

test("options and dependencies are exact descriptor-safe snapshots", async () => {
  let invoked = 0
  const accessor = {}
  Object.defineProperty(accessor, "token", {
    enumerable: true,
    get() {
      invoked += 1
      return TOKEN
    },
  })
  await assert.rejects(
    createDuplicateDraftConsolidationAdapters(accessor),
    /accessor|descriptor|option|unsafe/iu,
  )
  assert.equal(invoked, 0)

  const dependencyAccessor = {}
  Object.defineProperty(dependencyAccessor, "fetchImpl", {
    enumerable: true,
    get() {
      invoked += 1
      return assert.fail
    },
  })
  await assert.rejects(
    createDuplicateDraftConsolidationAdapters({
      cwd: "/workspace",
      token: TOKEN,
      dependencies: dependencyAccessor,
    }),
    /dependenc|accessor|descriptor|unsafe/iu,
  )
  assert.equal(invoked, 0)

  for (const value of [
    { cwd: "/workspace", token: TOKEN, extra: true },
    Object.assign(Object.create({ inherited: true }), { cwd: "/workspace", token: TOKEN }),
    Object.assign({ cwd: "/workspace", token: TOKEN }, { [Symbol("hidden")]: true }),
  ]) {
    await assert.rejects(createDuplicateDraftConsolidationAdapters(value))
  }

  const hidden = { cwd: "/workspace", token: TOKEN }
  Object.defineProperty(hidden, "extra", { value: true })
  await assert.rejects(createDuplicateDraftConsolidationAdapters(hidden))

  const proxy = new Proxy(
    { cwd: "/workspace", token: TOKEN },
    {
      ownKeys() {
        invoked += 1
        return ["cwd", "token"]
      },
    },
  )
  await assert.rejects(createDuplicateDraftConsolidationAdapters(proxy), /proxy|unsafe|option/iu)
  assert.equal(invoked, 0)

  await assert.rejects(
    createDuplicateDraftConsolidationAdapters({
      cwd: "/workspace",
      token: TOKEN,
      dependencies: { fetchImpl: undefined },
    }),
    /dependenc|fetch|function|invalid/iu,
  )
  for (const dependencies of [null, undefined]) {
    await assert.rejects(
      createDuplicateDraftConsolidationAdapters({
        cwd: "/workspace",
        token: TOKEN,
        dependencies,
      }),
      /dependenc|plain object|invalid/iu,
    )
  }
})

test("tokens reject whitespace even when it is not an HTTP control character", async () => {
  for (const token of ["bad token", " leading", "trailing ", "bad\u00a0token"]) {
    await assert.rejects(
      createAdapters({ token, fetchImpl: assert.fail, run: assert.fail }),
      /token|invalid/iu,
    )
  }
})

test("composition delegates to the required factories with fixed bounded identities", async () => {
  const calls = []
  const github = githubBoundary()
  const npm = { observePackageVersion: async (input) => input }
  const attestations = { verify: async (input) => input }
  const owner = { git: { headSha: async () => HEAD_SHA } }
  const adapters = await createDuplicateDraftConsolidationAdapters({
    cwd: "/workspace",
    token: TOKEN,
    environment: { HOME: "/home/release", PATH: "/tools" },
    dependencies: {
      fetchImpl: assert.fail,
      run: commandRunner([]),
      now: () => NOW,
      createGitHubReader(options) {
        calls.push(["github", options])
        return github
      },
      createOwnerPreflightAdapters(options) {
        calls.push(["owner", options])
        return owner
      },
      createNpmReader(options) {
        calls.push(["npm", options])
        return npm
      },
      createCliAttestationVerifier(options) {
        calls.push(["attestations", options])
        return attestations
      },
    },
  })

  assert.deepEqual(Object.keys(calls[0][1]).sort(), [
    "apiOrigin",
    "fetchImpl",
    "maxPages",
    "maxRecords",
    "now",
    "owner",
    "repo",
    "token",
  ])
  assert.equal(calls[0][1].owner, "cacheplane")
  assert.equal(calls[0][1].repo, "dawnai")
  assert.equal(calls[0][1].apiOrigin, API_ORIGIN)
  assert.equal(calls[0][1].maxPages, 100)
  assert.equal(calls[0][1].maxRecords, 10_000)
  assert.equal(calls[1][0], "owner")
  assert.deepEqual(Object.keys(calls[1][1]).sort(), ["cwd", "environment", "run"])
  assert.equal(calls[2][0], "npm")
  assert.deepEqual(Object.keys(calls[2][1]).sort(), ["fetchImpl"])
  assert.equal(calls[3][0], "attestations")
  assert.deepEqual(Object.keys(calls[3][1]).sort(), ["repository", "runGh", "token"])
  assert.notEqual(adapters.github.listReleases, github.listReleases)
  assert.notEqual(adapters.npm.observePackageVersion, npm.observePackageVersion)
  assert.notEqual(adapters.attestations.verify, attestations.verify)
})

test("GitHub reads use exact trusted endpoints, headers, pagination, and normalized evidence", async () => {
  const secondReleasePage = `${BASE}/releases?per_page=100&page=2`
  const recording = recordingFetch([
    jsonResponse({ id: 1_210_070_282, full_name: REPOSITORY, default_branch: "main" }),
    jsonResponse({ id: 61_436, login: "blove" }),
    jsonResponse({ ref: "refs/heads/main", object: { type: "commit", sha: HEAD_SHA } }),
    jsonResponse({ id: 12_345, path: ".github/workflows/release.yml", state: "disabled_manually" }),
    jsonResponse({ total_count: 1, workflow_runs: [workflowRun()] }),
    jsonResponse({ ref: "refs/tags/v0.8.22", object: { type: "tag", sha: TAG_OBJECT_SHA } }),
    jsonResponse({
      sha: TAG_OBJECT_SHA,
      tag: "v0.8.22",
      object: { type: "commit", sha: HEAD_SHA },
    }),
    jsonResponse([{ id: 2, name: "second" }], 200, { Link: `<${secondReleasePage}>; rel="next"` }),
    jsonResponse([{ id: 1, name: "first" }]),
    jsonResponse({ id: Number(SURVIVOR), draft: true }),
    jsonResponse([{ id: 91, name: "manifest.json" }]),
    binaryResponse(Buffer.from("asset")),
  ])
  const adapters = await createAdapters({
    fetchImpl: recording.fetchImpl,
    run: commandRunner([]),
  })

  assert.deepEqual(await adapters.github.getRepository(), {
    name: REPOSITORY,
    id: "1210070282",
    defaultBranch: "main",
  })
  assert.deepEqual(await adapters.github.getAuthenticatedUser(), { login: "blove", id: "61436" })
  assert.equal(await adapters.github.getDefaultBranchSha(), HEAD_SHA)
  assert.deepEqual(await adapters.github.getWorkflowState(), {
    workflowId: "12345",
    path: ".github/workflows/release.yml",
    state: "disabled_manually",
  })
  assert.deepEqual(await adapters.github.listNonterminalWorkflowRuns(), [normalizedWorkflowRun()])
  assert.deepEqual(await adapters.github.getAnnotatedTag({ name: "v0.8.22" }), {
    name: "v0.8.22",
    objectSha: TAG_OBJECT_SHA,
    targetSha: HEAD_SHA,
    objectType: "tag",
    observedAt: NOW,
  })
  assert.deepEqual((await adapters.github.listReleases()).value, [
    { id: 1, name: "first" },
    { id: 2, name: "second" },
  ])
  assert.equal(
    (await adapters.github.getRelease({ releaseId: SURVIVOR })).value.id,
    Number(SURVIVOR),
  )
  assert.equal((await adapters.github.listReleaseAssets({ releaseId: SURVIVOR })).value[0].id, 91)
  assert.equal(
    Buffer.from(
      (await adapters.github.downloadReleaseAsset({ assetId: "91", maximumBytes: 5 }))
        .contentBase64,
      "base64",
    ).toString(),
    "asset",
  )

  assert.deepEqual(
    recording.calls.map(({ url }) => url),
    [
      BASE,
      `${API_ORIGIN}/user`,
      `${BASE}/git/ref/heads%2Fmain`,
      `${BASE}/actions/workflows/release.yml`,
      `${BASE}/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?per_page=100&page=1`,
      `${BASE}/git/ref/tags%2Fv0.8.22`,
      `${BASE}/git/tags/${TAG_OBJECT_SHA}`,
      `${BASE}/releases?per_page=100`,
      secondReleasePage,
      `${BASE}/releases/${SURVIVOR}`,
      `${BASE}/releases/${SURVIVOR}/assets?per_page=100`,
      `${BASE}/releases/assets/91`,
    ],
  )
  for (const { init } of recording.calls) {
    assert.equal(init.redirect, "manual")
    assert.equal(init.headers["User-Agent"], USER_AGENT)
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`)
    assert.equal(
      init.headers.Accept,
      init.method === "GET" && init.headers.Accept === "application/octet-stream"
        ? "application/octet-stream"
        : "application/vnd.github+json",
    )
    assert.equal(init.headers["X-GitHub-Api-Version"], "2022-11-28")
  }
})

test("release and asset readers reject duplicate numeric identities across pages", async () => {
  for (const [method, firstUrl, secondUrl, invoke, code] of [
    [
      "release",
      `${BASE}/releases?per_page=100`,
      `${BASE}/releases?per_page=100&page=2`,
      (github) => github.listReleases(),
      "DUPLICATE_RELEASE_ID",
    ],
    [
      "asset",
      `${BASE}/releases/${SURVIVOR}/assets?per_page=100`,
      `${BASE}/releases/${SURVIVOR}/assets?per_page=100&page=2`,
      (github) => github.listReleaseAssets({ releaseId: SURVIVOR }),
      "DUPLICATE_ASSET_ID",
    ],
  ]) {
    const recording = recordingFetch([
      jsonResponse([{ id: 7, name: `${method}-one` }], 200, { Link: `<${secondUrl}>; rel="next"` }),
      jsonResponse([{ id: 7, name: `${method}-two` }]),
    ])
    const adapters = await createAdapters({
      fetchImpl: recording.fetchImpl,
      run: commandRunner([]),
    })
    assert.deepEqual(await invoke(adapters.github), {
      status: "ERROR",
      operation: method === "release" ? "releases" : "release-assets",
      httpStatus: 200,
      code,
    })
    assert.deepEqual(
      recording.calls.map(({ url }) => url),
      [firstUrl, secondUrl],
    )
  }
})

test("GitHub reader preserves fail-closed pagination and transport classifications", async () => {
  const unsafeNext = [
    `https://evil.example/repos/cacheplane/dawnai/releases?per_page=100&page=2`,
    `${BASE}/issues?per_page=100&page=2`,
    `${BASE}/releases?per_page=100&page=2&extra=true`,
  ]
  for (const next of unsafeNext) {
    const adapters = await createAdapters({
      fetchImpl: async () => jsonResponse([], 200, { Link: `<${next}>; rel="next"` }),
      run: commandRunner([]),
    })
    assert.equal((await adapters.github.listReleases()).code, "UNSAFE_PAGINATION_URL")
  }

  const repeated = `${BASE}/releases?per_page=100&page=2`
  const adapters = await createAdapters({
    fetchImpl: async () => jsonResponse([], 200, { Link: `<${repeated}>; rel="next"` }),
    run: commandRunner([]),
  })
  assert.equal((await adapters.github.listReleases()).code, "PAGINATION_LOOP")

  for (const response of [
    jsonResponse({ message: "forbidden" }, 403),
    jsonResponse({ message: "rate limited" }, 429),
    jsonResponse({ message: "server" }, 503),
    new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
    new Response(null, { status: 302, headers: { location: `${BASE}/releases` } }),
  ]) {
    const reader = await createAdapters({ fetchImpl: async () => response, run: commandRunner([]) })
    assert.notEqual((await reader.github.listReleases()).status, "PRESENT")
  }
})

test("workflow-run enumeration rejects unstable totals, duplicate IDs, and bounds", async () => {
  const page = Array.from({ length: 100 }, (_unused, index) => workflowRun(index + 1))
  const next = `${BASE}/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?per_page=100&page=2`
  for (const responses of [
    [
      jsonResponse({ total_count: 101, workflow_runs: page }, 200, {
        Link: `<${next}>; rel="next"`,
      }),
      jsonResponse({ total_count: 102, workflow_runs: [workflowRun(101)] }),
    ],
    [
      jsonResponse({ total_count: 101, workflow_runs: page }, 200, {
        Link: `<${next}>; rel="next"`,
      }),
      jsonResponse({ total_count: 101, workflow_runs: [workflowRun(1)] }),
    ],
    [jsonResponse({ total_count: 10_001, workflow_runs: [] })],
  ]) {
    const recording = recordingFetch(responses)
    const adapters = await createAdapters({
      fetchImpl: recording.fetchImpl,
      run: commandRunner([]),
    })
    await assert.rejects(
      adapters.github.listNonterminalWorkflowRuns(),
      /total|duplicate|record|bound/iu,
    )
  }
})

test("workflow-run enumeration requires one exact trusted Link next relation", async () => {
  const page = Array.from({ length: 100 }, (_unused, index) => workflowRun(index + 1))
  const endpoint = `${BASE}/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?per_page=100&page=2`
  for (const link of [
    null,
    `<https://evil.example/repos/cacheplane/dawnai/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?per_page=100&page=2>; rel="next"`,
    `<${BASE}/issues?per_page=100&page=2>; rel="next"`,
    `<${endpoint}&extra=true>; rel="next"`,
    `<${endpoint}>; rel="next prev"`,
    `<${endpoint}>; rel="next", <${endpoint}>; rel="next"`,
    `<${endpoint}>; rel="next", malformed`,
  ]) {
    const first = jsonResponse(
      { total_count: 101, workflow_runs: page },
      200,
      link === null ? {} : { Link: link },
    )
    const adapters = await createAdapters({
      fetchImpl: recordingFetch([first]).fetchImpl,
      run: commandRunner([]),
    })
    await assert.rejects(
      adapters.github.listNonterminalWorkflowRuns(),
      /Link|pagination|next|trusted|URL/iu,
    )
  }
})

test("local Git reads use exact argv arrays and reject detached, dirty, or malformed output", async () => {
  const calls = []
  const adapters = await createAdapters({ fetchImpl: assert.fail, run: commandRunner(calls) })
  assert.deepEqual(await adapters.local.readState(), {
    headSha: HEAD_SHA,
    branch: "main",
    porcelainStatus: "",
    originMainSha: HEAD_SHA,
  })
  assert.deepEqual(
    calls.map(([command, args]) => [command, args]),
    [
      ["git", ["rev-parse", "--verify", "HEAD^{commit}"]],
      ["git", ["symbolic-ref", "--quiet", "--short", "HEAD"]],
      ["git", ["status", "--porcelain=v1", "--untracked-files=all"]],
      ["git", ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]],
    ],
  )
  for (const [, , options] of calls) {
    assert.equal(options.cwd, "/workspace")
    assert.equal(options.shell, undefined)
    assert.equal(options.env.GH_TOKEN, undefined)
  }

  for (const overrides of [
    { branch: "" },
    { branch: "main\nforged" },
    { status: "?? secret.txt\n" },
    { originMainSha: HEAD_SHA.toUpperCase() },
  ]) {
    const invalid = await createAdapters({
      fetchImpl: assert.fail,
      run: commandRunner([], overrides),
    })
    await assert.rejects(invalid.local.readState(), /branch|clean|status|SHA|malformed/iu)
  }
})

test("npm and attestation operations delegate through owned narrow wrappers", async () => {
  const npmResult = {
    status: "ABSENT",
    operation: "package-version",
    httpStatus: 404,
    code: "E404",
  }
  const attestationResult = {
    status: "VERIFIED",
    subjects: [{ name: "manifest.json", sha256: "a".repeat(64) }],
  }
  const calls = []
  const adapters = await createDuplicateDraftConsolidationAdapters({
    cwd: "/workspace",
    token: TOKEN,
    dependencies: {
      fetchImpl: assert.fail,
      run: commandRunner([]),
      createNpmReader() {
        return {
          async observePackageVersion(input) {
            calls.push(["npm", input])
            return npmResult
          },
        }
      },
      createCliAttestationVerifier() {
        return {
          async verify(input) {
            calls.push(["attestations", input])
            return attestationResult
          },
        }
      },
    },
  })
  const npmInput = { name: "@dawn-ai/sdk", version: "0.8.22" }
  const attestationInput = { source: "escrow", record: {}, subjects: [], files: [], bundles: [] }
  const observedNpm = await adapters.npm.observePackageVersion(npmInput)
  const observedAttestations = await adapters.attestations.verify(attestationInput)
  assert.deepEqual(observedNpm, npmResult)
  assert.deepEqual(observedAttestations, attestationResult)
  assert.notEqual(observedNpm, npmResult)
  assert.notEqual(observedAttestations, attestationResult)
  assert.equal(deeplyFrozen(observedNpm), true)
  assert.equal(deeplyFrozen(observedAttestations), true)
  assert.deepEqual(calls, [
    ["npm", npmInput],
    ["attestations", attestationInput],
  ])
  assert.deepEqual(Object.keys(adapters.npm), ["observePackageVersion"])
  assert.deepEqual(Object.keys(adapters.attestations), ["verify"])
})

test("delegated npm and attestation results reject hostile mutable evidence", async () => {
  let invoked = 0
  const npmAccessor = {}
  Object.defineProperty(npmAccessor, "status", {
    enumerable: true,
    get() {
      invoked += 1
      return "ABSENT"
    },
  })
  const attestationAccessor = {}
  Object.defineProperty(attestationAccessor, "status", {
    enumerable: true,
    get() {
      invoked += 1
      return "VERIFIED"
    },
  })
  const adapters = await createDuplicateDraftConsolidationAdapters({
    cwd: "/workspace",
    token: TOKEN,
    dependencies: {
      fetchImpl: assert.fail,
      run: commandRunner([]),
      createNpmReader: () => ({ observePackageVersion: async () => npmAccessor }),
      createCliAttestationVerifier: () => ({ verify: async () => attestationAccessor }),
    },
  })
  assert.deepEqual(await adapters.npm.observePackageVersion({}), {
    status: "ERROR",
    operation: "malformed-envelope",
    httpStatus: null,
    code: "MALFORMED_ENVELOPE",
  })
  await assert.rejects(adapters.attestations.verify({}), /attestation|evidence|malformed/iu)
  assert.equal(invoked, 0)

  for (const result of [
    { status: "VERIFIED", subjects: [], extra: true },
    { status: "VERIFIED", subjects: [{ name: "manifest.json", sha256: "A".repeat(64) }] },
    new Proxy({ status: "INVALID", subjects: [] }, {}),
  ]) {
    const hostile = await createDuplicateDraftConsolidationAdapters({
      cwd: "/workspace",
      token: TOKEN,
      dependencies: {
        fetchImpl: assert.fail,
        run: commandRunner([]),
        createCliAttestationVerifier: () => ({ verify: async () => result }),
      },
    })
    await assert.rejects(hostile.attestations.verify({}), /attestation|evidence|malformed/iu)
  }
})

test("delete boundary rejects every non-approved construction or call before fetch", async () => {
  const invalidConstructions = [
    { repository: "cacheplane/other" },
    { apiOrigin: "http://api.github.com" },
    { apiOrigin: "https://evil.example" },
    { survivorId: DUPLICATES[0] },
    { duplicateIds: [...DUPLICATES].reverse() },
    { duplicateIds: [DUPLICATES[0]] },
    { duplicateIds: [...DUPLICATES, "1"] },
    { duplicateIds: [DUPLICATES[0], DUPLICATES[0]] },
    { duplicateIds: [DUPLICATES[0], SURVIVOR] },
    { token: "bad\ntoken" },
  ]
  for (const override of invalidConstructions) {
    const fetchCalls = []
    assert.throws(
      () => createWriter({ ...override, fetchImpl: (...args) => fetchCalls.push(args) }),
      /approved|duplicate|survivor|repository|origin|token|invalid/iu,
    )
    assert.equal(fetchCalls.length, 0)
  }

  const fetchCalls = []
  const writer = createWriter({ fetchImpl: (...args) => fetchCalls.push(args) })
  await assert.rejects(
    () => writer.deleteDuplicate({ releaseId: "379991871" }),
    /survivor|approved duplicate/iu,
  )
  assert.equal(fetchCalls.length, 0)
  for (const releaseId of [379982100, "0379982100", "+379982100", "379982100 ", "1", null]) {
    await assert.rejects(
      () => writer.deleteDuplicate({ releaseId }),
      /canonical|approved|duplicate|invalid/iu,
    )
    assert.equal(fetchCalls.length, 0)
  }
  await assert.rejects(
    () => writer.deleteDuplicate({ releaseId: DUPLICATES[0], extra: true }),
    /field|option|invalid/iu,
  )
  assert.equal(fetchCalls.length, 0)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => writer.deleteDuplicate({ releaseId: DUPLICATES[0], signal: controller.signal }),
    /abort/iu,
  )
  assert.equal(fetchCalls.length, 0)
})

test("delete performs exactly one bodyless non-redirected DELETE and classifies actual 204", async () => {
  const calls = []
  const writer = createWriter({
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { status: 204, ok: false, headers: new Headers(), body: null }
    },
  })
  assert.deepEqual(await writer.deleteDuplicate({ releaseId: DUPLICATES[0] }), {
    classification: "confirmed-204",
    httpStatus: 204,
    observedAt: NOW,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${BASE}/releases/${DUPLICATES[0]}`)
  assert.equal(calls[0].init.method, "DELETE")
  assert.equal(calls[0].init.redirect, "manual")
  assert.equal(Object.hasOwn(calls[0].init, "body"), false)
  assert.deepEqual(calls[0].init.headers, githubHeaders())
  assert.equal(calls[0].init.signal instanceof AbortSignal, true)
})

test("delete classifies received 404 and cancels any response body", async () => {
  let cancelled = 0
  const writer = createWriter({
    fetchImpl: async () => ({
      status: 404,
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        cancel: async () => {
          cancelled += 1
        },
      },
    }),
  })
  assert.deepEqual(await writer.deleteDuplicate({ releaseId: DUPLICATES[1] }), {
    classification: "response-404-ambiguous",
    httpStatus: 404,
    observedAt: NOW,
  })
  assert.equal(cancelled, 1)
})

test("delete cancels bodies on 204 and hard HTTP failure responses", async () => {
  for (const status of [204, 500]) {
    let cancelled = 0
    const writer = createWriter({
      fetchImpl: async () => ({
        status,
        headers: new Headers(),
        body: {
          cancel: async () => {
            cancelled += 1
          },
        },
      }),
    })
    if (status === 204) {
      assert.equal((await writer.deleteDuplicate({ releaseId: DUPLICATES[0] })).httpStatus, 204)
    } else {
      await assert.rejects(writer.deleteDuplicate({ releaseId: DUPLICATES[0] }), /HTTP 500/iu)
    }
    assert.equal(cancelled, 1)
  }
})

test("delete classifies timeout, caller abort after send, and transport loss as ambiguous", async () => {
  const timeout = createWriter({ fetchImpl: async () => new Promise(() => {}), timeoutMs: 5 })
  assert.deepEqual(await timeout.deleteDuplicate({ releaseId: DUPLICATES[0] }), {
    classification: "transport-ambiguous",
    httpStatus: null,
    observedAt: NOW,
  })

  const controller = new AbortController()
  let sent = false
  const aborted = createWriter({
    fetchImpl: async (_url, init) => {
      sent = true
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        )
      })
    },
  })
  const pending = aborted.deleteDuplicate({ releaseId: DUPLICATES[0], signal: controller.signal })
  assert.equal(sent, true)
  controller.abort()
  assert.equal((await pending).classification, "transport-ambiguous")

  const lost = createWriter({
    fetchImpl: async () => {
      throw new Error(`${TOKEN} socket lost`)
    },
  })
  const outcome = await lost.deleteDuplicate({ releaseId: DUPLICATES[1] })
  assert.deepEqual(outcome, {
    classification: "transport-ambiguous",
    httpStatus: null,
    observedAt: NOW,
  })
  assert.equal(JSON.stringify(outcome).includes(TOKEN), false)
})

test("delete fails closed on explicit HTTP failures, redirects, and malformed responses", async () => {
  for (const response of [
    { status: 403, ok: false, headers: new Headers(), body: null },
    { status: 429, ok: false, headers: new Headers(), body: null },
    { status: 500, ok: false, headers: new Headers(), body: null },
    {
      status: 302,
      ok: false,
      headers: new Headers({ location: `${BASE}/releases/1` }),
      body: null,
    },
    { status: "204", ok: true, headers: new Headers(), body: null },
    null,
  ]) {
    const writer = createWriter({ fetchImpl: async () => response })
    await assert.rejects(
      () => writer.deleteDuplicate({ releaseId: DUPLICATES[0] }),
      /HTTP|response|malformed|redirect|failed/iu,
    )
  }
})

test("delete outcomes require a canonical clock value", async () => {
  for (const now of [
    () => "2026-09-01T12:34:56Z",
    () => "invalid",
    () => 0,
    () => {
      throw new Error(TOKEN)
    },
  ]) {
    const writer = createWriter({
      fetchImpl: async () => ({ status: 204, headers: new Headers(), body: null }),
      now,
    })
    await assert.rejects(
      () => writer.deleteDuplicate({ releaseId: DUPLICATES[0] }),
      (error) => !String(error).includes(TOKEN),
    )
  }
})

test("composition and delete writer are deeply frozen owned capability sets", async () => {
  const adapters = await createAdapters({ fetchImpl: assert.fail, run: commandRunner([]) })
  assert.equal(deeplyFrozen(adapters), true)
  assert.equal(deeplyFrozen(adapters.writer), true)
  assert.deepEqual(Object.keys(adapters.writer), ["deleteDuplicate"])
  assert.deepEqual(Object.keys(adapters.github).sort(), [
    "downloadReleaseAsset",
    "getAnnotatedTag",
    "getAuthenticatedUser",
    "getDefaultBranchSha",
    "getRelease",
    "getRepository",
    "getWorkflowState",
    "listNonterminalWorkflowRuns",
    "listReleaseAssets",
    "listReleases",
  ])
  assert.equal(JSON.stringify(adapters).includes(TOKEN), false)
  assert.equal(JSON.stringify(adapters).includes("function"), false)
})

function createAdapters(options = {}) {
  const { environment = { HOME: "/home/release", PATH: "/tools" }, fetchImpl, run } = options
  return createDuplicateDraftConsolidationAdapters({
    cwd: "/workspace",
    ...(Object.hasOwn(options, "token")
      ? options.token === undefined
        ? {}
        : { token: options.token }
      : { token: TOKEN }),
    environment,
    dependencies: {
      fetchImpl,
      run,
      now: () => NOW,
    },
  })
}

function createWriter(overrides = {}) {
  return createExactDuplicateDeleteEffect({
    repository: REPOSITORY,
    apiOrigin: API_ORIGIN,
    survivorId: SURVIVOR,
    duplicateIds: DUPLICATES,
    token: TOKEN,
    fetchImpl: async () => ({ status: 204, headers: new Headers(), body: null }),
    timeoutMs: 100,
    now: () => NOW,
    ...overrides,
  })
}

function githubBoundary() {
  return {
    getRef: async () => present("ref", {}),
    getGitTag: async () => present("git-tag", {}),
    getWorkflow: async () => present("workflow", {}),
    listReleases: async () => present("releases", []),
    getRelease: async () => present("release", {}),
    listReleaseAssets: async () => present("release-assets", []),
    downloadReleaseAsset: async () => ({
      status: "PRESENT",
      operation: "release-asset-download",
      httpStatus: 200,
      code: null,
      contentBase64: "",
    }),
  }
}

function present(operation, value) {
  return { status: "PRESENT", operation, httpStatus: 200, code: null, value }
}

function commandRunner(calls, overrides = {}) {
  return async (command, args, options) => {
    if (command === "gh" && args[0] === "auth") {
      const token = overrides.authToken ?? TOKEN
      calls.push([command, args, options])
      return { exitCode: 0, stdout: `${token}\n`, stderr: "" }
    }
    calls.push([command, args, options])
    if (args[0] === "rev-parse" && args.at(-1).startsWith("HEAD")) {
      return { exitCode: 0, stdout: `${overrides.headSha ?? HEAD_SHA}\n`, stderr: "" }
    }
    if (args[0] === "symbolic-ref") {
      return { exitCode: 0, stdout: `${overrides.branch ?? "main"}\n`, stderr: "" }
    }
    if (args[0] === "status") {
      return { exitCode: 0, stdout: overrides.status ?? "", stderr: "" }
    }
    if (args[0] === "rev-parse" && args.at(-1).startsWith("refs/remotes/origin/main")) {
      return { exitCode: 0, stdout: `${overrides.originMainSha ?? HEAD_SHA}\n`, stderr: "" }
    }
    throw new Error(`Unexpected command ${command}`)
  }
}

function recordingFetch(responses) {
  const calls = []
  let index = 0
  return {
    calls,
    async fetchImpl(url, init) {
      calls.push({ url, init })
      const response = responses[index]
      index += 1
      if (response === undefined) throw new Error(`Unexpected fetch ${url}`)
      return response
    },
  }
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function binaryResponse(value, status = 200) {
  return new Response(value, {
    status,
    headers: { "content-type": "application/octet-stream" },
  })
}

function githubHeaders() {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  }
}

function workflowRun(id = 41) {
  return {
    id,
    run_attempt: 2,
    status: "queued",
    event: "workflow_dispatch",
    head_sha: HEAD_SHA,
    head_branch: "main",
  }
}

function normalizedWorkflowRun(id = "41") {
  return {
    id,
    runAttempt: 2,
    status: "queued",
    event: "workflow_dispatch",
    headSha: HEAD_SHA,
    headBranch: "main",
  }
}

function deeplyFrozen(value, seen = new Set()) {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    seen.has(value)
  ) {
    return true
  }
  seen.add(value)
  if (!Object.isFrozen(value)) return false
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor !== undefined &&
      "value" in descriptor &&
      !deeplyFrozen(descriptor.value, seen)
    ) {
      return false
    }
  }
  return true
}
