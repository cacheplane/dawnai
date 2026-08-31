import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createIndependentAuditRuntime,
  parseIndependentAuditArgs,
  parseIndependentAuditEnvironment,
  runIndependentAudit,
  writeCanonicalAuditResult,
} from "../independent-audit.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "../limits.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import { canonicalReleaseBody } from "../metadata.mjs"
import { observeDurableSmokeReceipts } from "../observe.mjs"
import {
  aggregateSmokeResults,
  canonicalAggregateSmokeResultBytes,
  canonicalSmokeResultBytes,
  REQUIRED_RELEASE_SMOKE_LANES,
} from "../smoke-result.mjs"
import { canonicalAuditResultBytes, parseAuditResult } from "../terminal-records.mjs"
import { observationForMarker } from "./support/marker-observation.mjs"

const VERSION = "0.8.22"
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
const MANIFEST_SHA256 = "a".repeat(64)

function argv(overrides = {}) {
  return [
    "--version",
    overrides.version ?? VERSION,
    "--commit-sha",
    overrides.commitSha ?? COMMIT_SHA,
    "--manifest-sha256",
    overrides.manifestSha256 ?? MANIFEST_SHA256,
    "--result",
    overrides.result ?? "audit-result.json",
  ]
}

function environment(overrides = {}) {
  return {
    GITHUB_REPOSITORY: "cacheplane/dawnai",
    GITHUB_REPOSITORY_ID: "1210070282",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: `cacheplane/dawnai/.github/workflows/published-artifact-verify.yml@refs/tags/v${VERSION}`,
    GITHUB_REF: `refs/tags/v${VERSION}`,
    GITHUB_SHA: COMMIT_SHA,
    GITHUB_RUN_ID: "500",
    GITHUB_RUN_ATTEMPT: "1",
    ...overrides,
  }
}

test("accepts only the exact independent-audit arguments and GitHub invocation identity", () => {
  const options = parseIndependentAuditArgs(argv())
  assert.deepEqual(options, {
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: MANIFEST_SHA256,
    result: "audit-result.json",
  })
  assert.deepEqual(parseIndependentAuditEnvironment(environment(), options), {
    repository: "cacheplane/dawnai",
    workflow: ".github/workflows/published-artifact-verify.yml",
    ref: `refs/tags/v${VERSION}`,
    commitSha: COMMIT_SHA,
    workflowRunId: 500,
    runAttempt: 1,
  })
})

test("rejects malformed, missing, duplicate, unknown, or mismatched invocation inputs", () => {
  const invalidArguments = [
    [],
    argv().slice(0, -2),
    [...argv(), "--extra", "value"],
    [...argv(), "--version", VERSION],
    argv({ version: `v${VERSION}` }),
    argv({ commitSha: COMMIT_SHA.toUpperCase() }),
    argv({ manifestSha256: "z".repeat(64) }),
    argv({ result: "\0unsafe" }),
  ]
  for (const input of invalidArguments) {
    assert.throws(() => parseIndependentAuditArgs(input))
  }

  const options = parseIndependentAuditArgs(argv())
  for (const invalidEnvironment of [
    environment({ GITHUB_REPOSITORY: "someone/else" }),
    environment({ GITHUB_EVENT_NAME: "push" }),
    environment({ GITHUB_WORKFLOW_REF: "cacheplane/dawnai/.github/workflows/release.yml@main" }),
    environment({ GITHUB_REF: "refs/heads/main" }),
    environment({ GITHUB_SHA: "f".repeat(40) }),
    environment({ GITHUB_RUN_ID: "0" }),
    environment({ GITHUB_RUN_ID: "01" }),
    environment({ GITHUB_RUN_ATTEMPT: "0" }),
  ]) {
    assert.throws(() => parseIndependentAuditEnvironment(invalidEnvironment, options))
  }
})

test("argument, option, and environment validation never invokes accessors", () => {
  let invoked = false
  const unsafeArguments = argv()
  Object.defineProperty(unsafeArguments, "0", {
    enumerable: true,
    get() {
      invoked = true
      throw new Error("must not run")
    },
  })
  assert.throws(() => parseIndependentAuditArgs(unsafeArguments))
  assert.equal(invoked, false)

  const unsafeEnvironment = environment()
  Object.defineProperty(unsafeEnvironment, "GITHUB_REF", {
    enumerable: true,
    get() {
      invoked = true
      throw new Error("must not run")
    },
  })
  assert.throws(() =>
    parseIndependentAuditEnvironment(unsafeEnvironment, parseIndependentAuditArgs(argv())),
  )
  assert.equal(invoked, false)

  const unsafeOptions = {
    commitSha: COMMIT_SHA,
    manifestSha256: MANIFEST_SHA256,
    result: "audit-result.json",
  }
  Object.defineProperty(unsafeOptions, "version", {
    enumerable: true,
    get() {
      invoked = true
      throw new Error("must not run")
    },
  })
  assert.throws(() => parseIndependentAuditEnvironment(environment(), unsafeOptions))
  assert.equal(invoked, false)
})

test("constructs only bounded read-only production boundaries and never a writer or recent-run selector", async () => {
  const calls = []
  const root = "/tmp/dawn-independent-audit-runtime"
  const token = "test-token-value"
  const git = { resolveTag() {} }
  const github = { getReleaseByTag() {} }
  const npm = { observePackageVersion() {} }
  const attestations = { verify() {} }
  const inventory = { read() {} }
  const observer = async () => ({})
  const planner = () => ({})
  const runner = async () => ({ stdout: "11.17.0\n" })
  const verifier = { verifyPackage() {}, dispose() {} }
  let writerCalls = 0

  const runtime = await createIndependentAuditRuntime(
    {
      root,
      environment: environment({ GITHUB_TOKEN: token }),
      candidate: releaseCandidate(),
      invocation: parseIndependentAuditEnvironment(
        environment({ GITHUB_TOKEN: token }),
        parseIndependentAuditArgs(argv()),
      ),
    },
    {
      createGitReader(input) {
        calls.push(["createGitReader", input])
        return git
      },
      createGitHubReader(input) {
        calls.push(["createGitHubReader", input])
        return github
      },
      createGitHubWriter() {
        writerCalls += 1
        throw new Error("writer must not be constructed")
      },
      createNpmReader(input) {
        calls.push(["createNpmReader", input])
        return npm
      },
      createAttestationVerifier(input) {
        calls.push(["createAttestationVerifier", input])
        return attestations
      },
      createInventoryReader(input) {
        calls.push(["createInventoryReader", input])
        return inventory
      },
      async readControllerMarker(input) {
        calls.push(["readControllerMarker", input])
        return { schemaVersion: 1 }
      },
      observeProductionCandidate: observer,
      planRelease: planner,
      createRunner() {
        calls.push(["createRunner"])
        return runner
      },
      async createNpmAuditVerifier(input) {
        calls.push(["createNpmAuditVerifier", input])
        return verifier
      },
      fileSystem: {},
    },
  )

  assert.equal(writerCalls, 0)
  assert.equal(runtime.git, git)
  assert.equal(runtime.github, github)
  assert.equal(runtime.npm, npm)
  assert.equal(runtime.attestations, attestations)
  assert.equal(runtime.inventory, inventory)
  assert.equal(runtime.observeProductionCandidate, observer)
  assert.equal(runtime.planRelease, planner)
  assert.deepEqual(
    calls.find(([name]) => name === "createGitReader"),
    ["createGitReader", { root }],
  )
  assert.deepEqual(
    calls.find(([name]) => name === "createGitHubReader"),
    [
      "createGitHubReader",
      {
        owner: "cacheplane",
        repo: "dawnai",
        repositoryId: "1210070282",
        token,
        maxResponseBytes: RELEASE_PAYLOAD_LIMITS.actionsArchiveBytes,
      },
    ],
  )
  assert.deepEqual(
    calls.find(([name]) => name === "createNpmReader"),
    ["createNpmReader", { maxResponseBytes: RELEASE_PAYLOAD_LIMITS.tarballBytes }],
  )
  assert.equal(
    calls.some(([name]) => name === "listWorkflowRuns"),
    false,
  )
  assert.equal(
    calls.some(([name]) => name === "createRunner"),
    false,
  )

  assert.equal(await runtime.npmAuditFactory.create(), verifier)
  assert.equal(calls.filter(([name]) => name === "createRunner").length, 1)
  const verifierInput = calls.find(([name]) => name === "createNpmAuditVerifier")[1]
  assert.equal(verifierInput.runNpm, runner)
  assert.equal(verifierInput.environment.GITHUB_TOKEN, token)
  assert.ok(verifierInput.signal instanceof AbortSignal)
})

test("the executor contains no Release writer or audit run discovery path", async () => {
  const source = await readFile(path.resolve("scripts/release/independent-audit.mjs"), "utf8")
  assert.equal(source.includes("github-write.mjs"), false)
  assert.equal(source.includes("createGitHubWriter"), false)
  assert.equal(source.includes("listWorkflowRuns"), false)
  assert.equal(source.includes("getActionsRunAttempt"), true)
})

test("waits for its exact dispatch marker and audits through the production observer and planner", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-independent-audit-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const resultPath = path.join(directory, "audit-result.json")
  const productionObservation = fiveLaneAuditObservation()
  const exactMarker = productionObservation.release.marker
  const previousMarker = { ...exactMarker, phase: "SMOKES_COMPLETE", audit: null }
  const wrongRunMarker = {
    ...exactMarker,
    audit: {
      ...exactMarker.audit,
      workflowRunId: 499,
      runUrl: "https://api.github.com/repos/cacheplane/dawnai/actions/runs/499",
      htmlUrl: "https://github.com/cacheplane/dawnai/actions/runs/499",
    },
  }
  const releases = [previousMarker, wrongRunMarker, exactMarker]
  const calls = []
  const delays = []
  const immutableInventory = {
    status: "valid",
    packages: [...CANONICAL_RELEASE_PACKAGE_ORDER]
      .sort()
      .map((name) => ({ name, version: VERSION })),
  }
  const runtime = {
    inventory: {
      async read(input) {
        calls.push(["inventory.read", input])
        return immutableInventory
      },
    },
    github: exactAuditGitHub({
      calls,
      async getReleaseByTag() {
        const marker = releases.shift()
        return present("release", draftRelease(marker))
      },
    }),
    git: {},
    npm: {},
    npmAuditFactory: {},
    attestations: {},
    controllerMarker: {},
    async observeProductionCandidate(input) {
      calls.push(["observeProductionCandidate", input])
      assert.deepEqual(input.inventory, immutableInventory)
      assert.notEqual(input.github, runtime.github)
      const pinned = await input.github.getActionsRun({ runId: 500 })
      assert.equal(pinned.operation, "actions-run")
      assert.equal(pinned.value.run_attempt, 1)
      return { observation: productionObservation, diagnostics: [] }
    },
  }
  const timestamps = [new Date("2026-08-25T10:00:00.000Z"), new Date("2026-08-25T10:01:00.000Z")]

  const result = await runIndependentAudit(argv({ result: resultPath }), {
    environment: environment(),
    cwd: directory,
    createRuntime: async () => runtime,
    now: () => timestamps.shift(),
    clock: () => 0,
    delay: async (milliseconds) => delays.push(milliseconds),
    pollAttempts: 3,
    pollDelayMs: 5,
    pollTimeoutMs: 1_000,
  })

  assert.equal(result.conclusion, "success")
  assert.equal(result.workflowRunId, 500)
  assert.equal(result.runAttempt, 1)
  assert.deepEqual(
    result.checks.map(({ name, conclusion }) => [name, conclusion]),
    [
      ["release-dispatch-marker", "success"],
      ["workflow-run-attempt", "success"],
      ["immutable-inventory", "success"],
      ["production-observation", "success"],
      ["production-plan", "success"],
    ],
  )
  assert.deepEqual(delays, [5, 5])
  assert.deepEqual(calls[0], ["getReleaseByTag", { tag: `v${VERSION}` }])
  assert.deepEqual(calls[1], ["getReleaseByTag", { tag: `v${VERSION}` }])
  assert.deepEqual(calls[2], ["getReleaseByTag", { tag: `v${VERSION}` }])
  assert.ok(calls.some(([name]) => name === "getActionsRunAttempt"))
  assert.ok(calls.some(([name]) => name === "listActionsRunJobs"))
  assert.deepEqual(
    calls.find(([name]) => name === "inventory.read"),
    ["inventory.read", { ref: COMMIT_SHA }],
  )
  assert.equal(calls.filter(([name]) => name === "observeProductionCandidate").length, 1)
  assert.equal(
    calls.some(([name]) => name === "listWorkflowRuns"),
    false,
  )

  const bytes = await readFile(resultPath)
  assert.deepEqual(bytes, canonicalAuditResultBytes(result))
  assert.deepEqual(parseAuditResult(JSON.parse(bytes)), result)
})

test("accepts bounded durable five-lane Release receipts after Actions retention expires", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-independent-audit-durable-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const resultPath = path.join(directory, "audit-result.json")
  const fixture = durableAuditFixture()
  const calls = []
  const downloads = []
  let actionsDownloads = 0
  const github = {
    ...exactAuditGitHub({
      calls,
      getReleaseByTag: async () =>
        present("release", draftRelease(fixture.observation.release.marker)),
    }),
    async listActionsArtifacts(input) {
      calls.push(["listActionsArtifacts", input])
      return present("actions-artifacts", [
        {
          id: 9_000,
          name: "release-prepared-v0.8.22-0123456789ab",
          size_in_bytes: 1,
          expired: true,
        },
      ])
    },
    async downloadActionsArtifact() {
      actionsDownloads += 1
      throw new Error("expired Actions bytes must not be downloaded")
    },
    async downloadReleaseAsset({ assetId, maximumBytes }) {
      const bytes = fixture.bytesById.get(Number(assetId))
      assert.ok(bytes !== undefined)
      assert.equal(maximumBytes, bytes.byteLength)
      downloads.push([assetId, maximumBytes])
      return binary("release-asset-download", bytes)
    },
  }
  const immutableInventory = {
    status: "valid",
    packages: [...CANONICAL_RELEASE_PACKAGE_ORDER]
      .sort()
      .map((name) => ({ name, version: VERSION })),
  }
  const runtime = {
    inventory: {
      async read() {
        return immutableInventory
      },
    },
    github,
    git: {},
    npm: {},
    npmAuditFactory: {},
    attestations: {},
    controllerMarker: {},
    async observeProductionCandidate(input) {
      const retained = await input.github.listActionsArtifacts({
        name: "release-prepared-v0.8.22-0123456789ab",
      })
      assert.equal(
        retained.value.every((artifact) => artifact.expired),
        true,
      )
      const diagnostics = []
      const durable = await observeDurableSmokeReceipts({
        marker: fixture.observation.release.marker,
        candidate: input.candidate,
        github: input.github,
        rawAssets: fixture.rawAssets,
        diagnostics,
      })
      assert.ok(durable !== null)
      return {
        observation: { ...fixture.observation, smokes: durable.smokes },
        diagnostics,
      }
    },
  }

  const result = await runIndependentAudit(argv({ result: resultPath }), {
    environment: environment(),
    cwd: directory,
    createRuntime: async () => runtime,
    now: fixedTimestamps(),
    clock: () => 0,
    delay: async () => {},
    pollAttempts: 1,
    pollDelayMs: 0,
    pollTimeoutMs: 100,
  })

  assert.equal(result.conclusion, "success")
  assert.equal(actionsDownloads, 0)
  assert.equal(downloads.length, REQUIRED_RELEASE_SMOKE_LANES.length)
  assert.deepEqual(fixture.observation.requiredSmokeLanes, [...REQUIRED_RELEASE_SMOKE_LANES])
  assert.deepEqual(await readFile(resultPath), canonicalAuditResultBytes(result))
})

test("a missing or wrong-run dispatch marker times out into one canonical failure receipt", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-independent-audit-timeout-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const resultPath = path.join(directory, "audit-result.json")
  const observation = fiveLaneAuditObservation()
  const wrongRunMarker = {
    ...observation.release.marker,
    audit: {
      ...observation.release.marker.audit,
      workflowRunId: 499,
      runUrl: "https://api.github.com/repos/cacheplane/dawnai/actions/runs/499",
      htmlUrl: "https://github.com/cacheplane/dawnai/actions/runs/499",
    },
  }
  const calls = []
  const runtime = auditRuntime({
    calls,
    observation,
    getReleaseByTag: async () => present("release", draftRelease(wrongRunMarker)),
  })

  await assert.rejects(
    runIndependentAudit(argv({ result: resultPath }), {
      environment: environment(),
      cwd: directory,
      createRuntime: async () => runtime,
      now: fixedTimestamps(),
      clock: () => 0,
      delay: async () => {},
      pollAttempts: 2,
      pollDelayMs: 0,
      pollTimeoutMs: 100,
    }),
    (error) => error?.code === "AUDIT_DISPATCH_MARKER_TIMEOUT",
  )

  const bytes = await readFile(resultPath)
  const result = parseAuditResult(JSON.parse(bytes))
  assert.equal(result.conclusion, "failure")
  assert.deepEqual(result.checks, [
    {
      name: "release-dispatch-marker",
      conclusion: "failure",
      detail: "Independent audit check failed (AUDIT_DISPATCH_MARKER_TIMEOUT).",
    },
  ])
  assert.deepEqual(bytes, canonicalAuditResultBytes(result))
  assert.equal(calls.filter(([name]) => name === "getReleaseByTag").length, 2)
  assert.equal(
    calls.some(([name]) => name === "getActionsRunAttempt"),
    false,
  )
})

test("an observer exception emits a bounded secret-safe failure receipt before failing the job", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-independent-audit-failure-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const resultPath = path.join(directory, "audit-result.json")
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
  const error = new Error(`observer failed with ${secret} token=super-secret`)
  error.code = "TOKEN_SUPER_SECRET"
  const runtime = auditRuntime({
    calls: [],
    observation: fiveLaneAuditObservation(),
    observeError: error,
  })

  await assert.rejects(
    runIndependentAudit(argv({ result: resultPath }), {
      environment: environment(),
      cwd: directory,
      createRuntime: async () => runtime,
      now: fixedTimestamps(),
      clock: () => 0,
      delay: async () => {},
      pollAttempts: 1,
      pollDelayMs: 0,
      pollTimeoutMs: 100,
    }),
    (failure) => failure?.code === "INDEPENDENT_AUDIT_FAILED",
  )

  const bytes = await readFile(resultPath)
  const text = bytes.toString("utf8")
  const result = parseAuditResult(JSON.parse(bytes))
  assert.equal(result.conclusion, "failure")
  assert.equal(result.checks.at(-1).name, "production-observation")
  assert.equal(
    result.checks.at(-1).detail,
    "Independent audit check failed (INDEPENDENT_AUDIT_FAILED).",
  )
  assert.equal(text.includes("TOKEN_SUPER_SECRET"), false)
  assert.equal(text.includes(secret), false)
  assert.equal(text.includes("super-secret"), false)
  assert.ok(bytes.length < 4_096)
})

test("manifest, state, and diagnostic mismatches each fail closed with a durable result", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-independent-audit-mismatch-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cases = [
    {
      name: "manifest",
      observation: {
        ...fiveLaneAuditObservation(),
        audit: { ...fiveLaneAuditObservation().audit, manifestSha256: "b".repeat(64) },
      },
      expectedCheck: "production-observation",
    },
    {
      name: "diagnostics",
      observation: fiveLaneAuditObservation(),
      diagnostics: [
        {
          source: "github",
          operation: "release-assets",
          status: "AMBIGUOUS",
          httpStatus: null,
          code: "READ_FAILED",
        },
      ],
      expectedCheck: "production-observation",
    },
    {
      name: "state",
      observation: fiveLaneAuditObservation(),
      planRelease: () => ({
        state: "SMOKES_COMPLETE",
        disposition: "would-transition",
        nextTransition: "dispatch-release-audit",
        conflicts: [],
      }),
      expectedCheck: "production-plan",
    },
  ]

  for (const entry of cases) {
    const resultPath = path.join(directory, `${entry.name}.json`)
    const runtime = auditRuntime({ calls: [], ...entry })
    await assert.rejects(
      runIndependentAudit(argv({ result: resultPath }), {
        environment: environment(),
        cwd: directory,
        createRuntime: async () => runtime,
        now: fixedTimestamps(),
        clock: () => 0,
        delay: async () => {},
        pollAttempts: 1,
        pollDelayMs: 0,
        pollTimeoutMs: 100,
      }),
    )
    const result = parseAuditResult(JSON.parse(await readFile(resultPath)))
    assert.equal(result.conclusion, "failure", entry.name)
    assert.equal(result.checks.at(-1).name, entry.expectedCheck, entry.name)
  }
})

test("canonical audit results are write-once, replayable only byte-for-byte, and never follow symlinks", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-independent-audit-write-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const resultPath = path.join(directory, "audit-result.json")
  const result = auditResult()

  await writeCanonicalAuditResult(resultPath, result)
  await writeCanonicalAuditResult(resultPath, result)
  const original = await readFile(resultPath)
  assert.deepEqual(original, canonicalAuditResultBytes(result))

  await assert.rejects(
    writeCanonicalAuditResult(resultPath, {
      ...result,
      checks: [{ name: "audit", conclusion: "failure", detail: "failed" }],
      conclusion: "failure",
    }),
    /conflicts with canonical bytes/u,
  )
  assert.deepEqual(await readFile(resultPath), original)

  const external = path.join(directory, "external.json")
  const linkedResult = path.join(directory, "linked-result.json")
  await writeFile(external, "external", { flag: "wx" })
  await symlink(external, linkedResult)
  await assert.rejects(writeCanonicalAuditResult(linkedResult, result))
  assert.equal(await readFile(external, "utf8"), "external")
})

test("audit result writes reject a symlinked parent and a parent directory replacement", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-independent-audit-parent-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const actual = path.join(directory, "actual")
  const linked = path.join(directory, "linked")
  await mkdir(actual)
  await symlink(actual, linked)
  await assert.rejects(
    writeCanonicalAuditResult(path.join(linked, "audit-result.json"), auditResult()),
    /directory/u,
  )
  await assert.rejects(readFile(path.join(actual, "audit-result.json")))

  const stable = path.join(directory, "stable")
  const moved = path.join(directory, "moved")
  await mkdir(stable)
  let replaced = false
  await assert.rejects(
    writeCanonicalAuditResult(path.join(stable, "audit-result.json"), auditResult(), {
      async link(source, target) {
        await rename(stable, moved)
        await mkdir(stable)
        replaced = true
        return link(source, target)
      },
    }),
  )
  assert.equal(replaced, true)
  await assert.rejects(readFile(path.join(stable, "audit-result.json")))
})

test("malformed invocation identity never creates a result and the executable fails without a stack", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-independent-audit-invalid-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const resultPath = path.join(directory, "audit-result.json")
  let runtimeCalls = 0
  await assert.rejects(
    runIndependentAudit(argv({ result: resultPath }), {
      environment: environment({ GITHUB_EVENT_NAME: "push" }),
      cwd: directory,
      async createRuntime() {
        runtimeCalls += 1
      },
    }),
  )
  assert.equal(runtimeCalls, 0)
  await assert.rejects(readFile(resultPath))

  const executable = path.resolve("scripts/release/independent-audit.mjs")
  const child = spawnSync(process.execPath, [executable, "--version", "not-semver"], {
    cwd: path.resolve("."),
    encoding: "utf8",
  })
  assert.equal(child.status, 1)
  assert.equal(child.stdout, "")
  assert.equal(child.stderr, "Independent release audit failed\n")
})

function fiveLaneAuditObservation() {
  const base = observationForMarker({ phase: "AUDIT_DISPATCHED" })
  return {
    ...base,
    requiredSmokeLanes: [...REQUIRED_RELEASE_SMOKE_LANES],
    smokes: REQUIRED_RELEASE_SMOKE_LANES.map((name, index) => ({
      name,
      status: "passed",
      version: VERSION,
      commitSha: COMMIT_SHA,
      manifestSha256: MANIFEST_SHA256,
      workflowRunId: 400 + index,
      runAttempt: 1,
    })),
  }
}

function durableAuditFixture() {
  const observation = fiveLaneAuditObservation()
  const workflowRunId = 400
  const runAttempt = 1
  const receiptBytes = REQUIRED_RELEASE_SMOKE_LANES.map((lane) =>
    canonicalSmokeResultBytes({
      schemaVersion: 1,
      lane,
      version: VERSION,
      commitSha: COMMIT_SHA,
      manifestSha256: MANIFEST_SHA256,
      workflowRunId,
      runAttempt,
      startedAt: "2026-08-25T08:00:00.000Z",
      finishedAt: "2026-08-25T08:01:00.000Z",
      checks: [{ name: "published-artifacts", conclusion: "success", detail: "exact" }],
      conclusion: "success",
    }),
  )
  const receiptAssets = REQUIRED_RELEASE_SMOKE_LANES.map((lane, index) => ({
    lane,
    workflowRunId,
    runAttempt,
    releaseAssetId: 3_000 + index,
    releaseAssetName: `smoke-result-${lane}-${workflowRunId}-${runAttempt}.json`,
    receiptSha256: digest(receiptBytes[index]),
  }))
  const smoke = {
    workflow: ".github/workflows/release.yml",
    workflowRunId,
    runAttempt,
    requiredLanes: [...REQUIRED_RELEASE_SMOKE_LANES],
    artifacts: receiptAssets.map((receipt, index) => ({
      lane: receipt.lane,
      actionsArtifactId: String(4_000 + index),
      actionsArtifactName: `smoke-result-${receipt.lane}-${workflowRunId}-${runAttempt}`,
      actionsArtifactUrl: `https://github.com/cacheplane/dawnai/actions/runs/${workflowRunId}/artifacts/${4_000 + index}`,
      actionsArtifactServiceDigest: `sha256:${"8".repeat(64)}`,
      releaseAssetId: receipt.releaseAssetId,
      releaseAssetName: receipt.releaseAssetName,
      receiptSha256: receipt.receiptSha256,
    })),
    receiptAssets,
    aggregateSha256: digest(
      canonicalAggregateSmokeResultBytes(
        aggregateSmokeResults(receiptBytes, {
          version: VERSION,
          commitSha: COMMIT_SHA,
          manifestSha256: MANIFEST_SHA256,
          workflowRunId,
          runAttempt,
        }),
      ),
    ),
  }
  const marker = { ...observation.release.marker, smoke }
  const rawAssets = receiptAssets.map((receipt, index) => ({
    id: receipt.releaseAssetId,
    name: receipt.releaseAssetName,
    digest: `sha256:${receipt.receiptSha256}`,
    size: receiptBytes[index].byteLength,
  }))
  const bytesById = new Map(
    rawAssets.map((asset, index) => [asset.id, Buffer.from(receiptBytes[index])]),
  )
  return {
    observation: {
      ...observation,
      release: {
        ...observation.release,
        bodySha256: digest(canonicalReleaseBody({ marker, manifest: null })),
        marker,
        assets: [
          ...observation.release.assets.filter((asset) => !asset.name.startsWith("smoke-result-")),
          ...rawAssets.map((asset) => ({
            name: asset.name,
            sha256: asset.digest.slice("sha256:".length),
            status: "matching",
          })),
        ],
      },
    },
    rawAssets,
    bytesById,
  }
}

function releaseCandidate() {
  return {
    version: VERSION,
    commitSha: COMMIT_SHA,
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  }
}

function exactAuditGitHub({ calls, getReleaseByTag }) {
  return {
    async getReleaseByTag(input) {
      calls.push(["getReleaseByTag", input])
      return getReleaseByTag(input)
    },
    async getActionsRunAttempt(input) {
      calls.push(["getActionsRunAttempt", input])
      return present("actions-run-attempt", {
        id: 500,
        run_attempt: 1,
        head_sha: COMMIT_SHA,
        head_branch: `v${VERSION}`,
        event: "workflow_dispatch",
        path: ".github/workflows/published-artifact-verify.yml",
        status: "in_progress",
        conclusion: null,
      })
    },
    async listActionsRunJobs(input) {
      calls.push(["listActionsRunJobs", input])
      return present("actions-run-jobs", [
        {
          id: 7_001,
          runAttempt: 1,
          name: "verify",
          status: "in_progress",
          conclusion: null,
          startedAt: "2026-08-25T10:00:00.000Z",
          completedAt: null,
        },
      ])
    },
  }
}

function auditRuntime({
  calls,
  observation,
  diagnostics = [],
  observeError,
  planRelease,
  getReleaseByTag = async () => present("release", draftRelease(observation.release.marker)),
}) {
  return {
    inventory: {
      async read(input) {
        calls.push(["inventory.read", input])
        return {
          status: "valid",
          packages: [...CANONICAL_RELEASE_PACKAGE_ORDER]
            .sort()
            .map((name) => ({ name, version: VERSION })),
        }
      },
    },
    github: exactAuditGitHub({ calls, getReleaseByTag }),
    git: {},
    npm: {},
    npmAuditFactory: {},
    attestations: {},
    controllerMarker: {},
    async observeProductionCandidate(input) {
      calls.push(["observeProductionCandidate", input])
      if (observeError !== undefined) throw observeError
      return { observation, diagnostics }
    },
    ...(planRelease === undefined ? {} : { planRelease }),
  }
}

function fixedTimestamps() {
  const values = [new Date("2026-08-25T10:00:00.000Z"), new Date("2026-08-25T10:01:00.000Z")]
  return () => values.shift()
}

function auditResult() {
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: MANIFEST_SHA256,
    workflowRunId: 500,
    runAttempt: 1,
    startedAt: "2026-08-25T10:00:00.000Z",
    finishedAt: "2026-08-25T10:01:00.000Z",
    checks: [{ name: "audit", conclusion: "success", detail: "verified" }],
    conclusion: "success",
  }
}

function draftRelease(marker) {
  return {
    id: 91,
    name: `Dawn v${VERSION}`,
    tag_name: "untagged-opaque",
    target_commitish: "main",
    draft: true,
    immutable: false,
    prerelease: false,
    body: canonicalReleaseBody({ marker, manifest: null }),
  }
}

function present(operation, value) {
  return { status: "PRESENT", operation, httpStatus: 200, code: null, value }
}

function binary(operation, bytes) {
  return {
    status: "PRESENT",
    operation,
    httpStatus: 200,
    code: null,
    contentBase64: Buffer.from(bytes).toString("base64"),
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}
