import assert from "node:assert/strict"
import test from "node:test"

import { createOwnerPreflightAdapters } from "../preflight-owner-adapters.mjs"

const REPOSITORY = "cacheplane/dawnai"
const WORKFLOW_PATH = ".github/workflows/release.yml"
const SHA = "0123456789abcdef0123456789abcdef01234567"
const TAG_SHA = "123456789abcdef0123456789abcdef012345678"
const BLOB_SHA = "23456789abcdef0123456789abcdef0123456789"
const WORKFLOW_BYTES = Buffer.from(
  `name: Release\r\non:\n  workflow_dispatch:\n# ${"exact-workflow-bytes-".repeat(6)}\n`,
  "utf8",
)
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024

test("owner adapters execute only exact argv-based read commands", async () => {
  const calls = []
  const adapters = createOwnerPreflightAdapters({
    cwd: "/workspace",
    environment: {
      HOME: "/home/runner",
      PATH: "/tools",
      GH_TOKEN: "preferred-token",
      GITHUB_TOKEN: "fallback-token",
      NODE_OPTIONS: "--require /tmp/unsafe.cjs",
      BASH_ENV: "/tmp/unsafe.sh",
    },
    readFile: async (path) => Buffer.from(path),
    run: fixtureRunner(calls),
  })

  assert.equal(await adapters.git.headSha(), SHA)
  assert.equal(await adapters.npm.version(), "11.17.0")
  assert.deepEqual(await adapters.npm.trustList("@dawn-ai/sdk"), {
    status: "present",
    value: {
      id: "trust-1",
      type: "github",
      file: "release.yml",
      repository: REPOSITORY,
      permissions: ["createPackage"],
    },
  })
  assert.equal(await adapters.github.version(), "2.95.0")
  assert.equal((await adapters.github.getRepository(REPOSITORY)).httpStatus, 200)
  assert.equal((await adapters.github.getWorkflow(WORKFLOW_PATH)).httpStatus, 200)
  assert.equal((await adapters.github.getEnvironment("release-abandonment")).httpStatus, 200)
  assert.deepEqual(await adapters.github.getImmutableReleases(REPOSITORY), {
    status: "absent",
    httpStatus: 404,
    value: null,
  })
  assert.deepEqual(await adapters.github.getDefaultBranchRef(REPOSITORY, "main"), {
    status: "present",
    httpStatus: 200,
    value: { ref: "refs/heads/main", object: { type: "commit", sha: SHA } },
  })
  assert.deepEqual(await adapters.github.listManagedCandidateRefs(REPOSITORY), {
    status: "present",
    httpStatus: 200,
    value: [
      { ref: "refs/tags/v0.8.22", object: { type: "tag", sha: TAG_SHA } },
      { ref: "refs/tags/v0.8.23", object: { type: "commit", sha: SHA } },
    ],
  })
  assert.deepEqual(await adapters.github.getAnnotatedTag(REPOSITORY, TAG_SHA), {
    status: "present",
    httpStatus: 200,
    value: { sha: TAG_SHA, object: { type: "commit", sha: SHA } },
  })
  assert.deepEqual(await adapters.github.getWorkflowContent(REPOSITORY, WORKFLOW_PATH, SHA), {
    status: "present",
    httpStatus: 200,
    value: {
      path: WORKFLOW_PATH,
      sha: BLOB_SHA,
      contentBase64: WORKFLOW_BYTES.toString("base64"),
    },
  })
  assert.deepEqual(await adapters.github.listReleaseRuns(REPOSITORY, WORKFLOW_PATH, "queued"), {
    status: "present",
    httpStatus: 200,
    value: [
      {
        id: 41,
        runAttempt: 2,
        status: "queued",
        event: "workflow_dispatch",
        headSha: SHA,
        headBranch: "v0.8.22",
      },
    ],
  })
  assert.equal(
    await adapters.files.read("scripts/release/controller-schema.json"),
    "scripts/release/controller-schema.json",
  )

  assert.deepEqual(
    calls.map(([command, args]) => [command, args]),
    [
      ["git", ["rev-parse", "--verify", "HEAD^{commit}"]],
      ["npm", ["--version"]],
      ["npm", ["trust", "list", "@dawn-ai/sdk", "--json"]],
      ["gh", ["--version"]],
      ["gh", apiArgs("repos/cacheplane/dawnai")],
      ["gh", apiArgs("repos/cacheplane/dawnai/actions/workflows/release.yml")],
      ["gh", apiArgs("repos/cacheplane/dawnai/environments/release-abandonment")],
      ["gh", apiArgs("repos/cacheplane/dawnai/immutable-releases")],
      ["gh", apiArgs("repos/cacheplane/dawnai/git/ref/heads/main")],
      ["gh", paginatedApiArgs("repos/cacheplane/dawnai/git/matching-refs/tags/v?per_page=100")],
      ["gh", apiArgs(`repos/cacheplane/dawnai/git/tags/${TAG_SHA}`)],
      ["gh", apiArgs(`repos/cacheplane/dawnai/contents/.github/workflows/release.yml?ref=${SHA}`)],
      [
        "gh",
        paginatedApiArgs(
          "repos/cacheplane/dawnai/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?status=queued&per_page=100",
        ),
      ],
    ],
  )
  for (const [command, , options] of calls) {
    assert.equal(options.cwd, "/workspace")
    assert.equal(options.shell, undefined)
    assert.deepEqual(options.env, {
      HOME: "/home/runner",
      PATH: "/tools",
      NO_COLOR: "1",
      ...(command === "gh" ? { GH_TOKEN: "preferred-token" } : {}),
    })
  }
  assert.equal(JSON.stringify(calls).includes("fallback-token"), false)
  assert.equal(JSON.stringify(calls).includes("unsafe"), false)
})

test("owner adapters fall back to GITHUB_TOKEN without forwarding its original name", async () => {
  const calls = []
  const adapters = createOwnerPreflightAdapters({
    cwd: "/workspace",
    environment: { HOME: "/home/runner", PATH: "/tools", GITHUB_TOKEN: "fallback-token" },
    readFile: async () => "fixture",
    run: async (command, args, options) => {
      calls.push([command, args, options])
      return { exitCode: 0, stdout: "gh version 2.95.0 (2026-06-17)\n", stderr: "" }
    },
  })

  assert.equal(await adapters.github.version(), "2.95.0")
  assert.equal(calls[0][2].env.GH_TOKEN, "fallback-token")
  assert.equal(calls[0][2].env.GITHUB_TOKEN, undefined)
})

test("owner adapters validate every ref-aware argument before executing a command", async () => {
  const calls = []
  const adapters = createOwnerPreflightAdapters({
    cwd: "/workspace",
    environment: { HOME: "/home/runner", PATH: "/tools" },
    readFile: async () => "fixture",
    run: async (...args) => {
      calls.push(args)
      throw new Error("must not execute")
    },
  })

  const invalidCalls = [
    () => adapters.github.getDefaultBranchRef("invalid", "main"),
    () => adapters.github.getDefaultBranchRef(REPOSITORY, "develop"),
    () => adapters.github.getDefaultBranchRef(REPOSITORY, "main; echo unsafe"),
    () => adapters.github.listManagedCandidateRefs("../repo"),
    () => adapters.github.getAnnotatedTag(REPOSITORY, SHA.toUpperCase()),
    () => adapters.github.getAnnotatedTag(REPOSITORY, "abc"),
    () => adapters.github.getWorkflowContent(REPOSITORY, "release.yml", SHA),
    () => adapters.github.getWorkflowContent(REPOSITORY, WORKFLOW_PATH, `${SHA}?unsafe=1`),
    () => adapters.github.listReleaseRuns(REPOSITORY, "release.yml", "queued"),
    () => adapters.github.listReleaseRuns(REPOSITORY, WORKFLOW_PATH, "completed"),
    () => adapters.github.listReleaseRuns(REPOSITORY, WORKFLOW_PATH, "queued&per_page=1"),
  ]
  for (const invoke of invalidCalls) await assert.rejects(invoke, /invalid/iu)
  assert.deepEqual(calls, [])
})

test("owner adapters accept exactly the five nonterminal release run statuses", async () => {
  const calls = []
  const adapters = createOwnerPreflightAdapters({
    cwd: "/workspace",
    environment: { HOME: "/home/runner", PATH: "/tools" },
    readFile: async () => "fixture",
    run: async (command, args, options) => {
      calls.push([command, args, options])
      return { exitCode: 0, stdout: '[{"total_count":0,"workflow_runs":[]}]\n', stderr: "" }
    },
  })

  for (const status of ["in_progress", "pending", "queued", "requested", "waiting"]) {
    assert.deepEqual(await adapters.github.listReleaseRuns(REPOSITORY, WORKFLOW_PATH, status), {
      status: "present",
      httpStatus: 200,
      value: [],
    })
  }
  assert.deepEqual(
    calls.map(([, args]) => args.at(-1)),
    ["in_progress", "pending", "queued", "requested", "waiting"].map(
      (status) =>
        `repos/${REPOSITORY}/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?status=${status}&per_page=100`,
    ),
  )
})

test("owner adapters require an exact unique default-branch commit ref", async (t) => {
  const valid = {
    ref: "refs/heads/main",
    node_id: "REF_node",
    url: "https://api.github.test/ref",
    object: { type: "commit", sha: SHA, url: "https://api.github.test/commit" },
  }
  const malformed = [
    ["array identity", [valid]],
    ["wrong ref", { ...valid, ref: "refs/heads/develop" }],
    ["missing object", { ref: "refs/heads/main" }],
    ["wrong object type", { ...valid, object: { type: "tag", sha: SHA } }],
    ["uppercase SHA", { ...valid, object: { type: "commit", sha: SHA.toUpperCase() } }],
    ["extra object identity", { ...valid, object: [valid.object, valid.object] }],
  ]
  for (const [name, value] of malformed) {
    await t.test(name, async () => {
      const adapters = adaptersReturningHttp(value)
      await assert.rejects(
        adapters.github.getDefaultBranchRef(REPOSITORY, "main"),
        /default branch ref|GitHub/iu,
      )
    })
  }
})

test("owner adapters normalize and sort complete managed tag refs", async () => {
  const pages = [[managedRef(2, "tag"), managedRef(0, "commit")], [managedRef(1, "tag")]]
  const adapters = adaptersReturningPages(pages)

  assert.deepEqual(await adapters.github.listManagedCandidateRefs(REPOSITORY), {
    status: "present",
    httpStatus: 200,
    value: [managedRef(0, "commit"), managedRef(1, "tag"), managedRef(2, "tag")],
  })
})

test("owner adapters accept the exact managed-ref pagination and record bounds", async () => {
  const pages = Array.from({ length: 100 }, (_unused, pageIndex) =>
    Array.from({ length: 100 }, (_entry, recordIndex) =>
      managedRef(pageIndex * 100 + recordIndex, recordIndex % 2 === 0 ? "commit" : "tag"),
    ),
  )
  const stdout = JSON.stringify(pages)
  assert.ok(Buffer.byteLength(stdout, "utf8") <= MAX_COMMAND_OUTPUT_BYTES)
  const adapters = adaptersReturningRawPages(stdout)

  const result = await adapters.github.listManagedCandidateRefs(REPOSITORY)
  assert.equal(result.value.length, 10_000)
  assert.deepEqual(result.value[0], managedRef(0, "commit"))
  assert.deepEqual(result.value.at(-1), managedRef(9_999, "tag"))
})

test("owner adapters reject managed refs above either complete-read bound", async () => {
  const excessivePages = Array.from({ length: 101 }, () => [])
  await assert.rejects(
    adaptersReturningPages(excessivePages).github.listManagedCandidateRefs(REPOSITORY),
    /managed candidate refs|page bound/iu,
  )

  const excessiveRecords = [Array.from({ length: 10_001 }, (_unused, index) => managedRef(index))]
  const stdout = JSON.stringify(excessiveRecords)
  assert.ok(Buffer.byteLength(stdout, "utf8") <= MAX_COMMAND_OUTPUT_BYTES)
  await assert.rejects(
    adaptersReturningRawPages(stdout).github.listManagedCandidateRefs(REPOSITORY),
    /managed candidate refs|record bound/iu,
  )
})

test("owner adapters reject malformed or duplicate managed tag evidence without filtering", async (t) => {
  const malformed = [
    ["outer object", { page: [] }],
    ["non-array page", [[], { ref: "unexpected" }]],
    ["non-object record", [[null]]],
    ["wrong prefix", [[managedRef(0), { ...managedRef(1), ref: "refs/heads/v0.0.00001" }]]],
    ["invalid ref", [[{ ...managedRef(0), ref: "refs/tags/vbad..ref" }]]],
    ["whitespace ref", [[{ ...managedRef(0), ref: "refs/tags/vbad ref" }]]],
    ["control ref", [[{ ...managedRef(0), ref: "refs/tags/vbad\u0001ref" }]]],
    ["wrong object type", [[managedRef(0, "blob")]]],
    ["malformed SHA", [[{ ...managedRef(0), object: { type: "tag", sha: SHA.toUpperCase() } }]]],
    ["duplicate ref", [[managedRef(0)], [managedRef(0, "commit")]]],
  ]
  for (const [name, pages] of malformed) {
    await t.test(name, async () => {
      await assert.rejects(
        adaptersReturningPages(pages).github.listManagedCandidateRefs(REPOSITORY),
        /managed candidate refs|GitHub/iu,
      )
    })
  }
})

test("owner adapters require an annotated tag object that peels directly to one commit", async (t) => {
  const valid = {
    sha: TAG_SHA,
    tag: "v0.8.22",
    object: { type: "commit", sha: SHA, url: "https://api.github.test/commit" },
  }
  assert.deepEqual(await adaptersReturningHttp(valid).github.getAnnotatedTag(REPOSITORY, TAG_SHA), {
    status: "present",
    httpStatus: 200,
    value: { sha: TAG_SHA, object: { type: "commit", sha: SHA } },
  })

  const malformed = [
    ["wrong requested identity", { ...valid, sha: SHA }],
    ["missing requested identity", { object: valid.object }],
    ["nested tag", { ...valid, object: { type: "tag", sha: SHA } }],
    ["wrong peeled type", { ...valid, object: { type: "blob", sha: SHA } }],
    ["malformed peeled SHA", { ...valid, object: { type: "commit", sha: "abc" } }],
    ["ambiguous object", { ...valid, object: [valid.object] }],
  ]
  for (const [name, value] of malformed) {
    await t.test(name, async () => {
      await assert.rejects(
        adaptersReturningHttp(value).github.getAnnotatedTag(REPOSITORY, TAG_SHA),
        /annotated tag|GitHub/iu,
      )
    })
  }
})

test("owner adapters preserve exact canonical workflow bytes and exact 404 absence", async () => {
  const value = workflowContent()
  const adapters = adaptersReturningHttp(value)
  assert.deepEqual(await adapters.github.getWorkflowContent(REPOSITORY, WORKFLOW_PATH, SHA), {
    status: "present",
    httpStatus: 200,
    value: {
      path: WORKFLOW_PATH,
      sha: BLOB_SHA,
      contentBase64: WORKFLOW_BYTES.toString("base64"),
    },
  })

  const canonical = WORKFLOW_BYTES.toString("base64")
  assert.ok(canonical.length > 120)
  const wrappedBase64 = wrappedBase64At(canonical, 60)
  const wrappedLines = wrappedBase64.split("\n")
  assert.equal(wrappedLines.at(-1), "")
  assert.ok(wrappedLines.slice(0, -2).every((line) => line.length === 60))
  assert.ok(wrappedLines.at(-2).length > 0 && wrappedLines.at(-2).length <= 60)
  const wrapped = adaptersReturningHttp(workflowContent({ content: wrappedBase64 }))
  const wrappedResult = await wrapped.github.getWorkflowContent(REPOSITORY, WORKFLOW_PATH, SHA)
  assert.deepEqual(wrappedResult, {
    status: "present",
    httpStatus: 200,
    value: {
      path: WORKFLOW_PATH,
      sha: BLOB_SHA,
      contentBase64: WORKFLOW_BYTES.toString("base64"),
    },
  })
  assert.deepEqual(Buffer.from(wrappedResult.value.contentBase64, "base64"), WORKFLOW_BYTES)

  const absent = adaptersReturningHttp({ message: "Not Found" }, { status: 404, exitCode: 1 })
  assert.deepEqual(await absent.github.getWorkflowContent(REPOSITORY, WORKFLOW_PATH, SHA), {
    status: "absent",
    httpStatus: 404,
    value: null,
  })
})

test("owner adapters reject truncated, ambiguous, or noncanonical workflow content", async (t) => {
  const canonical = WORKFLOW_BYTES.toString("base64")
  const malformed = [
    ["array identity", [workflowContent()]],
    ["directory", workflowContent({ type: "dir" })],
    ["wrong encoding", workflowContent({ encoding: "none" })],
    ["wrong path", workflowContent({ path: ".github/workflows/other.yml" })],
    ["wrong name", workflowContent({ name: "other.yml" })],
    ["malformed blob SHA", workflowContent({ sha: BLOB_SHA.toUpperCase() })],
    ["missing content", workflowContent({ content: undefined })],
    ["empty content", workflowContent({ content: "", size: 0 })],
    [
      "noncanonical whitespace",
      workflowContent({ content: `${canonical.slice(0, 4)}\n${canonical.slice(4)}\n` }),
    ],
    ["59-column wrapping", workflowContent({ content: wrappedBase64At(canonical, 59) })],
    ["61-column wrapping", workflowContent({ content: wrappedBase64At(canonical, 61) })],
    ["malformed base64", workflowContent({ content: "not-base64!" })],
    ["size mismatch", workflowContent({ size: WORKFLOW_BYTES.length + 1 })],
    ["oversized", workflowContent({ size: 2 * 1024 * 1024 + 1 })],
    ["truncated", workflowContent({ truncated: true })],
    ["ambiguous truncation", workflowContent({ truncated: "false" })],
  ]
  for (const [name, value] of malformed) {
    await t.test(name, async () => {
      await assert.rejects(
        adaptersReturningHttp(value).github.getWorkflowContent(REPOSITORY, WORKFLOW_PATH, SHA),
        /workflow content|GitHub/iu,
      )
    })
  }
})

test("owner adapters normalize and sort exact release run identities", async () => {
  const pages = [
    runPage([releaseRun(30, "queued", { run_attempt: 2 })], 3),
    runPage([releaseRun(3), releaseRun(20)], 3),
  ]
  const adapters = adaptersReturningPages(pages)

  assert.deepEqual(await adapters.github.listReleaseRuns(REPOSITORY, WORKFLOW_PATH, "queued"), {
    status: "present",
    httpStatus: 200,
    value: [normalizedRun(3), normalizedRun(20), normalizedRun(30, { runAttempt: 2 })],
  })
})

test("owner adapters accept the exact release-run pagination and record bounds", async () => {
  const pages = Array.from({ length: 100 }, (_unused, pageIndex) =>
    runPage(
      Array.from({ length: 100 }, (_entry, recordIndex) =>
        releaseRun(pageIndex * 100 + recordIndex + 1),
      ),
      10_000,
    ),
  )
  const stdout = JSON.stringify(pages)
  assert.ok(Buffer.byteLength(stdout, "utf8") <= MAX_COMMAND_OUTPUT_BYTES)
  const adapters = adaptersReturningRawPages(stdout)

  const result = await adapters.github.listReleaseRuns(REPOSITORY, WORKFLOW_PATH, "queued")
  assert.equal(result.value.length, 10_000)
  assert.deepEqual(result.value[0], normalizedRun(1))
  assert.deepEqual(result.value.at(-1), normalizedRun(10_000))
})

test("owner adapters reject release runs above either complete-read bound", async () => {
  const excessivePages = Array.from({ length: 101 }, () => runPage([], 0))
  await assert.rejects(
    adaptersReturningPages(excessivePages).github.listReleaseRuns(
      REPOSITORY,
      WORKFLOW_PATH,
      "queued",
    ),
    /release runs|page bound/iu,
  )

  const excessiveRecords = [
    runPage(
      Array.from({ length: 10_001 }, (_unused, index) => releaseRun(index + 1)),
      10_001,
    ),
  ]
  const stdout = JSON.stringify(excessiveRecords)
  assert.ok(Buffer.byteLength(stdout, "utf8") <= MAX_COMMAND_OUTPUT_BYTES)
  await assert.rejects(
    adaptersReturningRawPages(stdout).github.listReleaseRuns(REPOSITORY, WORKFLOW_PATH, "queued"),
    /release runs|record bound/iu,
  )
})

test("owner adapters reject malformed, incomplete, mismatched, or duplicate run evidence", async (t) => {
  const tooLong = "x".repeat(1_025)
  const malformed = [
    ["outer object", { workflow_runs: [] }],
    ["array page", [[]]],
    ["extra page field", [{ ...runPage([], 0), extra: true }]],
    ["invalid total", [runPage([], -1)]],
    ["inconsistent total", [runPage([], 0), runPage([], 1)]],
    ["incomplete total", [runPage([], 1)]],
    ["non-object record", [runPage([null], 1)]],
    ["invalid ID", [runPage([releaseRun(0)], 1)]],
    ["invalid attempt", [runPage([releaseRun(1, "queued", { run_attempt: 0 })], 1)]],
    ["mismatched status", [runPage([releaseRun(1, "waiting")], 1)]],
    ["malformed SHA", [runPage([releaseRun(1, "queued", { head_sha: "abc" })], 1)]],
    ["empty event", [runPage([releaseRun(1, "queued", { event: "" })], 1)]],
    ["oversized branch", [runPage([releaseRun(1, "queued", { head_branch: tooLong })], 1)]],
    ["duplicate identity", [runPage([releaseRun(1), releaseRun(1)], 2)]],
    [
      "duplicate run ID across attempts",
      [runPage([releaseRun(1), releaseRun(1, "queued", { run_attempt: 2 })], 2)],
    ],
  ]
  for (const [name, pages] of malformed) {
    await t.test(name, async () => {
      await assert.rejects(
        adaptersReturningPages(pages).github.listReleaseRuns(REPOSITORY, WORKFLOW_PATH, "queued"),
        /release runs|GitHub/iu,
      )
    })
  }
})

test("owner adapters normalize npm auth and GitHub auth/absence without leaking messages", async () => {
  const adapters = createOwnerPreflightAdapters({
    cwd: "/workspace",
    environment: { HOME: "/home/runner", PATH: "/tools", GH_TOKEN: "secret-token" },
    readFile: async () => "fixture",
    run: async (command, args) => {
      if (command === "npm" && args[0] === "trust") {
        return {
          exitCode: 1,
          stdout: '{"error":{"code":"E401","summary":"token=secret-token"}}\n',
          stderr: "npm auth token=secret-token",
        }
      }
      if (command === "gh" && args.includes("--paginate")) {
        return {
          exitCode: 1,
          stdout: '{"message":"credential secret-token"}\n',
          stderr: "gh: credential secret-token (HTTP 403)",
        }
      }
      if (command === "gh") {
        return {
          exitCode: 1,
          stdout: httpResponse(403, { message: "credential secret-token" }),
          stderr: "gh: credential secret-token (HTTP 403)",
        }
      }
      throw new Error("unexpected command")
    },
  })

  assert.deepEqual(await adapters.npm.trustList("@dawn-ai/sdk"), {
    status: "unavailable",
    code: "E401",
  })
  const githubResults = [
    await adapters.github.getRepository(REPOSITORY),
    await adapters.github.getDefaultBranchRef(REPOSITORY, "main"),
    await adapters.github.listManagedCandidateRefs(REPOSITORY),
    await adapters.github.getAnnotatedTag(REPOSITORY, TAG_SHA),
    await adapters.github.getWorkflowContent(REPOSITORY, WORKFLOW_PATH, SHA),
    await adapters.github.listReleaseRuns(REPOSITORY, WORKFLOW_PATH, "queued"),
  ]
  for (const result of githubResults) {
    assert.equal(result.status, "unavailable")
    assert.equal(JSON.stringify(result).includes("secret-token"), false)
  }
})

test("owner adapters redact thrown command failures for ref-aware reads", async () => {
  const adapters = createOwnerPreflightAdapters({
    cwd: "/workspace",
    environment: { HOME: "/home/runner", PATH: "/tools", GH_TOKEN: "secret-token" },
    readFile: async () => "fixture",
    run: async () => {
      throw new Error("network failure for secret-token")
    },
  })

  for (const invoke of [
    () => adapters.github.getDefaultBranchRef(REPOSITORY, "main"),
    () => adapters.github.listManagedCandidateRefs(REPOSITORY),
    () => adapters.github.getAnnotatedTag(REPOSITORY, TAG_SHA),
    () => adapters.github.getWorkflowContent(REPOSITORY, WORKFLOW_PATH, SHA),
    () => adapters.github.listReleaseRuns(REPOSITORY, WORKFLOW_PATH, "queued"),
  ]) {
    const result = await invoke()
    assert.deepEqual(result, { status: "unavailable", httpStatus: null, value: null })
    assert.equal(JSON.stringify(result).includes("secret-token"), false)
  }
})

test("owner adapters reject malformed successful tool output without leaking it", async () => {
  const adapters = createOwnerPreflightAdapters({
    cwd: "/workspace",
    environment: { HOME: "/home/runner", PATH: "/tools" },
    readFile: async () => "fixture",
    run: async (command, args) => {
      if (command === "npm" && args[0] === "trust") {
        return { exitCode: 0, stdout: "not-json", stderr: "" }
      }
      return { exitCode: 0, stdout: "malformed-secret-output", stderr: "" }
    },
  })
  await assert.rejects(adapters.npm.trustList("@dawn-ai/sdk"), /npm trust|JSON/iu)
  await assert.rejects(adapters.github.getRepository(REPOSITORY), /GitHub|HTTP/iu)
  for (const invoke of [
    () => adapters.github.getDefaultBranchRef(REPOSITORY, "main"),
    () => adapters.github.listManagedCandidateRefs(REPOSITORY),
    () => adapters.github.getAnnotatedTag(REPOSITORY, TAG_SHA),
    () => adapters.github.getWorkflowContent(REPOSITORY, WORKFLOW_PATH, SHA),
    () => adapters.github.listReleaseRuns(REPOSITORY, WORKFLOW_PATH, "queued"),
  ]) {
    await assert.rejects(invoke, (error) => {
      assert.equal(String(error).includes("malformed-secret-output"), false)
      assert.equal(String(error.cause).includes("malformed-secret-output"), false)
      return true
    })
  }
})

function fixtureRunner(calls) {
  return async (command, args, options) => {
    calls.push([command, args, options])
    if (command === "git") return { exitCode: 0, stdout: `${SHA}\n`, stderr: "" }
    if (command === "npm" && args[0] === "--version") {
      return { exitCode: 0, stdout: "11.17.0\n", stderr: "" }
    }
    if (command === "npm") {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          id: "trust-1",
          type: "github",
          file: "release.yml",
          repository: REPOSITORY,
          permissions: ["createPackage"],
        })}\n`,
        stderr: "",
      }
    }
    if (args[0] === "--version") {
      return { exitCode: 0, stdout: "gh version 2.95.0 (2026-06-17)\n", stderr: "" }
    }
    const endpoint = args.at(-1)
    if (endpoint.endsWith("immutable-releases")) {
      return { exitCode: 1, stdout: httpResponse(404, { message: "Not Found" }), stderr: "" }
    }
    if (endpoint.includes("git/matching-refs")) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify([
          [
            {
              ref: "refs/tags/v0.8.23",
              object: { type: "commit", sha: SHA },
            },
          ],
          [
            {
              ref: "refs/tags/v0.8.22",
              object: { type: "tag", sha: TAG_SHA },
            },
          ],
        ])}\n`,
        stderr: "",
      }
    }
    if (endpoint.includes("/runs?")) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify([
          runPage(
            [
              releaseRun(41, "queued", {
                run_attempt: 2,
                event: "workflow_dispatch",
                head_branch: "v0.8.22",
                head_sha: SHA,
              }),
            ],
            1,
          ),
        ])}\n`,
        stderr: "",
      }
    }
    if (endpoint.endsWith("git/ref/heads/main")) {
      return {
        exitCode: 0,
        stdout: httpResponse(200, {
          ref: "refs/heads/main",
          object: { type: "commit", sha: SHA },
        }),
        stderr: "",
      }
    }
    if (endpoint.includes("/git/tags/")) {
      return {
        exitCode: 0,
        stdout: httpResponse(200, {
          sha: TAG_SHA,
          object: { type: "commit", sha: SHA },
        }),
        stderr: "",
      }
    }
    if (endpoint.includes("/contents/")) {
      return { exitCode: 0, stdout: httpResponse(200, workflowContent()), stderr: "" }
    }
    if (endpoint.includes("actions/workflows")) {
      return {
        exitCode: 0,
        stdout: httpResponse(200, {
          id: 1,
          path: WORKFLOW_PATH,
          state: "disabled_manually",
        }),
        stderr: "",
      }
    }
    if (endpoint.includes("environments")) {
      return {
        exitCode: 0,
        stdout: httpResponse(200, { name: "release-abandonment", protection_rules: [] }),
        stderr: "",
      }
    }
    return {
      exitCode: 0,
      stdout: httpResponse(200, {
        id: 123,
        full_name: REPOSITORY,
        default_branch: "main",
        permissions: { admin: true },
      }),
      stderr: "",
    }
  }
}

function adaptersReturningHttp(value, { status = 200, exitCode = 0 } = {}) {
  return createOwnerPreflightAdapters({
    cwd: "/workspace",
    environment: { HOME: "/home/runner", PATH: "/tools" },
    readFile: async () => "fixture",
    run: async () => ({
      exitCode,
      stdout: httpResponse(status, value),
      stderr: "",
    }),
  })
}

function adaptersReturningPages(pages) {
  return adaptersReturningRawPages(JSON.stringify(pages))
}

function adaptersReturningRawPages(stdout) {
  return createOwnerPreflightAdapters({
    cwd: "/workspace",
    environment: { HOME: "/home/runner", PATH: "/tools" },
    readFile: async () => "fixture",
    run: async () => ({ exitCode: 0, stdout, stderr: "" }),
  })
}

function managedRef(index, type = "tag") {
  return {
    ref: `refs/tags/v0.0.${String(index).padStart(5, "0")}`,
    object: { type, sha: hexSha(index + 1) },
  }
}

function releaseRun(id, status = "queued", overrides = {}) {
  return {
    id,
    run_attempt: 1,
    status,
    event: "p",
    head_sha: hexSha(id),
    head_branch: "v",
    ...overrides,
  }
}

function normalizedRun(id, overrides = {}) {
  return {
    id,
    runAttempt: 1,
    status: "queued",
    event: "p",
    headSha: hexSha(id),
    headBranch: "v",
    ...overrides,
  }
}

function runPage(workflowRuns, totalCount) {
  return { total_count: totalCount, workflow_runs: workflowRuns }
}

function workflowContent(overrides = {}) {
  const value = {
    type: "file",
    encoding: "base64",
    size: WORKFLOW_BYTES.length,
    name: "release.yml",
    path: WORKFLOW_PATH,
    sha: BLOB_SHA,
    content: WORKFLOW_BYTES.toString("base64"),
  }
  for (const [name, override] of Object.entries(overrides)) {
    if (override === undefined) delete value[name]
    else value[name] = override
  }
  return value
}

function hexSha(value) {
  return value.toString(16).padStart(40, "0")
}

function wrappedBase64At(value, width) {
  const lines = []
  for (let offset = 0; offset < value.length; offset += width) {
    lines.push(value.slice(offset, offset + width))
  }
  return `${lines.join("\n")}\n`
}

function apiArgs(endpoint) {
  return [
    "api",
    "--include",
    "--method",
    "GET",
    "--header",
    "Accept: application/vnd.github+json",
    "--header",
    "X-GitHub-Api-Version: 2026-03-10",
    endpoint,
  ]
}

function paginatedApiArgs(endpoint) {
  return [
    "api",
    "--paginate",
    "--slurp",
    "--method",
    "GET",
    "--header",
    "Accept: application/vnd.github+json",
    "--header",
    "X-GitHub-Api-Version: 2026-03-10",
    endpoint,
  ]
}

function httpResponse(status, body) {
  return `HTTP/2.0 ${status} status\ncontent-type: application/json\n\n${JSON.stringify(body)}\n`
}
