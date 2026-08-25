import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { runReleaseCli } from "../cli.mjs"
import { runReleaseController } from "../controller.mjs"
import {
  CANONICAL_RELEASE_PACKAGE_ORDER,
  canonicalManifestBytes,
  manifestSha256,
} from "../manifest.mjs"
import { parseAttestationSet, parsePublicationState } from "../metadata.mjs"
import { canonicalReleaseRecordBytes, parseReleaseRecord } from "../release-record.mjs"
import {
  candidate as markerCandidate,
  observationForMarker,
} from "./support/marker-observation.mjs"

const CANDIDATE = Object.freeze({
  version: "0.8.22",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})

const PLAN_CASES = [
  ["NO_CANDIDATE", "noop", null],
  ["SUPERSEDED_NOOP", "audit-only", null],
  ["CANDIDATE_VALIDATED", "would-transition", "create-candidate-tag"],
  ["CANDIDATE_TAGGED", "would-transition", "prepare-artifacts"],
  ["ARTIFACTS_PREPARED", "would-transition", "attest-artifacts"],
  ["ARTIFACTS_ATTESTED", "would-transition", "escrow-candidate"],
  ["CANDIDATE_ESCROWED", "would-transition", "publish-npm-packages"],
  ["NPM_PARTIAL", "would-transition", "resume-npm-publish"],
  ["NPM_COMPLETE", "would-transition", "reconcile-npm-evidence"],
  ["RELEASE_DRAFT_COMPLETE", "would-transition", "run-release-smokes"],
  ["SMOKES_COMPLETE", "would-transition", "dispatch-release-audit"],
  ["AUDIT_DISPATCHED", "would-transition", "complete-release-audit"],
  ["AUDIT_RETRYABLE", "would-transition", "dispatch-release-audit"],
  ["AUDIT_VERIFIED", "would-transition", "publish-github-release"],
  ["AUDIT_COMPLETE", "noop", null],
  ["ABANDONED_PREPUBLICATION", "noop", null],
]

for (const [state, disposition, transition] of PLAN_CASES) {
  test(`controller executes at most one planned transition for ${state}`, async () => {
    const observations = [
      { sequence: 1, state },
      { sequence: 2, state: `${state}_AFTER` },
    ]
    const calls = []
    const reports = []
    const effects = Object.create(null)
    if (transition !== null) {
      effects[transition] = async (input) => {
        calls.push([transition, input.observation.sequence])
        return { receipt: transition }
      }
    }

    const result = await runReleaseController({
      candidate: state === "NO_CANDIDATE" ? null : CANDIDATE,
      dryRun: false,
      observer: observer(observations),
      planner: plannerFor({ state, disposition, transition }),
      effects,
      reporter: reporter(reports),
    })

    assert.deepEqual(
      calls,
      transition === null ? [] : [[transition, 1]],
      "a controller run may execute only the selected transition once",
    )
    assert.equal(result.before.plan.state, state)
    assert.equal(result.transition.name, transition)
    assert.equal(result.transition.status, transition === null ? "not-required" : "completed")
    assert.equal(result.after === null, transition === null)
    assert.equal(reports.length, 1)
    assert.deepEqual(reports[0], result)
    assertRecursivelyFrozen(result)
  })
}

test("controller dry-run reports the plan without resolving or executing write effects", async () => {
  let selectedReads = 0
  const effects = Object.create(null)
  Object.defineProperty(effects, "prepare-artifacts", {
    enumerable: true,
    get() {
      selectedReads += 1
      assert.fail("dry-run must not resolve a write effect")
    },
  })
  const reports = []
  const result = await runReleaseController({
    candidate: CANDIDATE,
    dryRun: true,
    observer: observer([{ sequence: 1 }]),
    planner: plannerFor({
      state: "CANDIDATE_TAGGED",
      disposition: "would-transition",
      transition: "prepare-artifacts",
    }),
    effects,
    reporter: reporter(reports),
  })
  assert.equal(selectedReads, 0)
  assert.equal(result.transition.status, "dry-run")
  assert.equal(result.after, null)
  assert.equal(reports.length, 1)
})

test("blocked plans emit one report and never inspect any mutation effect", async () => {
  const effects = new Proxy(
    {},
    {
      get() {
        assert.fail("blocked plans must not inspect write effects")
      },
      getOwnPropertyDescriptor() {
        assert.fail("blocked plans must not inspect write effects")
      },
    },
  )
  const reports = []
  const result = await runReleaseController({
    candidate: CANDIDATE,
    dryRun: false,
    observer: observer([{ sequence: 1 }]),
    planner: plannerFor({ state: "CANDIDATE_TAGGED", disposition: "blocked", transition: null }),
    effects,
    reporter: reporter(reports),
  })
  assert.equal(result.transition.status, "blocked")
  assert.equal(reports.length, 1)
})

test("controller resolves only the selected named effect and never cascades into another transition", async () => {
  const calls = []
  const effects = Object.create(null)
  effects["prepare-artifacts"] = async () => {
    calls.push("prepare-artifacts")
    return { suggestedNextTransition: "publish-github-release" }
  }
  Object.defineProperty(effects, "publish-github-release", {
    enumerable: true,
    get() {
      assert.fail("one run must never cascade from preparation to publication")
    },
  })
  const result = await runReleaseController({
    candidate: CANDIDATE,
    dryRun: false,
    observer: observer([{ sequence: 1 }, { sequence: 2 }]),
    planner: plannerFor({
      state: "CANDIDATE_TAGGED",
      disposition: "would-transition",
      transition: "prepare-artifacts",
    }),
    effects,
    reporter: reporter([]),
  })
  assert.deepEqual(calls, ["prepare-artifacts"])
  assert.equal(result.transition.status, "completed")
})

test("controller passes deeply frozen candidate, observation, and plan snapshots to effects", async () => {
  const mutableCandidate = structuredClone(CANDIDATE)
  const mutableObservation = { nested: { value: "before" } }
  const result = await runReleaseController({
    candidate: mutableCandidate,
    dryRun: false,
    observer: observer([mutableObservation, { nested: { value: "after" } }]),
    planner: plannerFor({
      state: "CANDIDATE_TAGGED",
      disposition: "would-transition",
      transition: "prepare-artifacts",
    }),
    effects: {
      async "prepare-artifacts"(input) {
        assertRecursivelyFrozen(input.candidate)
        assertRecursivelyFrozen(input.observation)
        assertRecursivelyFrozen(input.plan)
        assert.throws(() => {
          input.observation.nested.value = "mutated"
        }, TypeError)
        return { accepted: true }
      },
    },
    reporter: reporter([]),
  })
  mutableCandidate.version = "9.9.9"
  mutableObservation.nested.value = "outside mutation"
  assert.equal(result.candidate.version, CANDIDATE.version)
  assert.equal(result.before.observation.nested.value, "before")
})

test("missing or accessor-based selected effects fail closed after emitting a report", async () => {
  for (const effects of [
    Object.freeze({}),
    Object.defineProperty({}, "prepare-artifacts", {
      enumerable: true,
      get() {
        assert.fail("selected effect accessors must not execute")
      },
    }),
  ]) {
    const reports = []
    await assert.rejects(
      runReleaseController({
        candidate: CANDIDATE,
        dryRun: false,
        observer: observer([{ sequence: 1 }]),
        planner: plannerFor({
          state: "CANDIDATE_TAGGED",
          disposition: "would-transition",
          transition: "prepare-artifacts",
        }),
        effects,
        reporter: reporter(reports),
      }),
      (error) => {
        assert.equal(error.code, "RELEASE_EFFECT_UNAVAILABLE")
        assert.equal(error.report.transition.status, "configuration-error")
        return true
      },
    )
    assert.equal(reports.length, 1)
  }
})

test("retryable transition failures re-observe, emit a secret-free report, and remain failures", async () => {
  const reports = []
  let observations = 0
  await assert.rejects(
    runReleaseController({
      candidate: CANDIDATE,
      dryRun: false,
      observer: {
        async observe() {
          observations += 1
          return { sequence: observations }
        },
      },
      planner: plannerFor({
        state: "AUDIT_DISPATCHED",
        disposition: "would-transition",
        transition: "complete-release-audit",
      }),
      effects: {
        async "complete-release-audit"() {
          throw Object.assign(new Error("token=do-not-report"), {
            code: "AUDIT_PENDING",
            retryable: true,
          })
        },
      },
      reporter: reporter(reports),
    }),
    (error) => {
      assert.equal(error.code, "AUDIT_PENDING")
      assert.equal(error.report.transition.status, "retryable-error")
      assert.equal(JSON.stringify(error.report).includes("do-not-report"), false)
      return true
    },
  )
  assert.equal(observations, 2)
  assert.equal(reports.length, 1)
})

test("fatal transition failures also re-observe and emit exactly one classified report", async () => {
  const reports = []
  await assert.rejects(
    runReleaseController({
      candidate: CANDIDATE,
      dryRun: false,
      observer: observer([{ sequence: 1 }, { sequence: 2 }]),
      planner: plannerFor({
        state: "AUDIT_VERIFIED",
        disposition: "would-transition",
        transition: "publish-github-release",
      }),
      effects: {
        async "publish-github-release"() {
          throw Object.assign(new Error("immutable publication conflict"), {
            code: "RELEASE_CONFLICT",
          })
        },
      },
      reporter: reporter(reports),
    }),
    (error) => {
      assert.equal(error.report.transition.status, "fatal-error")
      return true
    },
  )
  assert.equal(reports.length, 1)
})

test("a fatal re-observation error dominates an otherwise retryable transition error", async () => {
  const reports = []
  let reads = 0
  await assert.rejects(
    runReleaseController({
      candidate: CANDIDATE,
      observer: {
        async observe() {
          reads += 1
          if (reads === 1) return { sequence: reads }
          throw Object.assign(new Error("authorization failed"), { code: "GITHUB_AUTH_FAILED" })
        },
      },
      planner: plannerFor({
        state: "AUDIT_DISPATCHED",
        disposition: "would-transition",
        transition: "complete-release-audit",
      }),
      effects: {
        async "complete-release-audit"() {
          throw Object.assign(new Error("pending"), { code: "AUDIT_PENDING", retryable: true })
        },
      },
      reporter: reporter(reports),
    }),
    (error) => {
      assert.equal(error.code, "GITHUB_AUTH_FAILED")
      assert.equal(error.report.transition.status, "fatal-error")
      assert.equal(error.report.transition.error.reobservationCode, "GITHUB_AUTH_FAILED")
      return true
    },
  )
  assert.equal(reports.length, 1)
})

test("the default planner integrates a smoke-complete observation with only audit dispatch", async () => {
  const calls = []
  const before = observationForMarker({ phase: "SMOKES_COMPLETE" })
  const after = observationForMarker({ phase: "AUDIT_DISPATCHED" })
  const result = await runReleaseController({
    candidate: markerCandidate(),
    dryRun: false,
    observer: observer([before, after]),
    effects: {
      async "dispatch-release-audit"() {
        calls.push("dispatch-release-audit")
        return { workflowRunId: 500 }
      },
    },
    reporter: reporter([]),
  })
  assert.deepEqual(calls, ["dispatch-release-audit"])
  assert.equal(result.before.plan.nextTransition, "dispatch-release-audit")
  assert.equal(result.after.plan.state, "AUDIT_DISPATCHED")
})

test("record-artifact routes exact action outputs into one canonical release record", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-release-cli-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const paths = {
    candidate: join(directory, "candidate.json"),
    manifest: join(directory, "manifest.json"),
    upload: join(directory, "upload.json"),
    output: join(directory, "release-record.json"),
  }
  const manifest = sealedManifest()
  await writeFile(paths.candidate, `${JSON.stringify(CANDIDATE)}\n`)
  await writeFile(paths.manifest, canonicalManifestBytes(manifest))
  await writeFile(
    paths.upload,
    `${JSON.stringify({
      artifactId: "9001",
      artifactUrl: "https://github.com/cacheplane/dawnai/actions/runs/7001/artifacts/9001",
      artifactDigest: "a".repeat(64),
    })}\n`,
  )
  const imports = []
  const result = await runReleaseCli(
    [
      "record-artifact",
      "--candidate",
      paths.candidate,
      "--manifest",
      paths.manifest,
      "--artifact-upload-result",
      paths.upload,
      "--output",
      paths.output,
    ],
    {
      cwd: directory,
      importModule: async (specifier) => {
        imports.push(specifier)
        return import(specifier)
      },
    },
  )
  const record = parseReleaseRecord(await readFile(paths.output))
  assert.deepEqual(result, record)
  assert.deepEqual(record.actionsArtifact, {
    id: "9001",
    name: `release-v${CANDIDATE.version}-${CANDIDATE.commitSha.slice(0, 12)}`,
    serviceDigest: `sha256:${"a".repeat(64)}`,
    prepareRunId: "7001",
    prepareRunAttempt: 2,
  })
  assert.deepEqual(
    imports.map((specifier) => new URL(specifier).pathname.split("/").at(-1)),
    ["manifest.mjs", "release-record.mjs"],
  )
})

test("tag route creates and pushes only the exact candidate annotated tag", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-release-tag-cli-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const candidatePath = join(directory, "candidate.json")
  await writeFile(candidatePath, JSON.stringify(CANDIDATE))
  const calls = []
  const imports = []
  const result = await runReleaseCli(["tag", "--candidate", candidatePath], {
    cwd: directory,
    importModule: async (specifier) => {
      imports.push(specifier)
      return {
        createCandidateTagWriter({ root }) {
          assert.equal(root, directory)
          return {
            async createAnnotatedTag(input) {
              calls.push(["create", input])
              return { status: "created", tag: input.tag, sha: input.sha }
            },
            async pushTag(input) {
              calls.push(["push", input])
              return { status: "pushed", tag: input.tag, sha: CANDIDATE.commitSha }
            },
          }
        },
      }
    },
  })
  assert.deepEqual(calls, [
    [
      "create",
      {
        tag: `v${CANDIDATE.version}`,
        sha: CANDIDATE.commitSha,
        message: `Dawn release v${CANDIDATE.version}`,
      },
    ],
    ["push", { tag: `v${CANDIDATE.version}` }],
  ])
  assert.equal(result.tag, `v${CANDIDATE.version}`)
  assert.deepEqual(
    imports.map((specifier) => new URL(specifier).pathname.split("/").at(-1)),
    ["git-write.mjs"],
  )
})

test("prepare route supplies every authority receipt and exact tag ref without defaults", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-release-prepare-cli-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const outputDir = join(tmpdir(), `dawn-release-prepare-output-${process.pid}`)
  const inputFiles = {
    candidate: CANDIDATE,
    inventory: { status: "valid", packages: [] },
    ci: {
      status: "success",
      retryable: false,
      commitSha: CANDIDATE.commitSha,
      workflow: "CI",
      check: "validate",
      runId: 101,
      runAttempt: 1,
    },
    run: { id: 102, attempt: 2 },
    authority: { state: "CANDIDATE_TAGGED", releaseRecord: null, npm: [] },
  }
  const paths = Object.fromEntries(
    await Promise.all(
      Object.entries(inputFiles).map(async ([name, value]) => {
        const target = join(directory, `${name}.json`)
        await writeFile(target, JSON.stringify(value))
        return [name, target]
      }),
    ),
  )
  let received
  const result = await runReleaseCli(
    [
      "prepare",
      "--candidate",
      paths.candidate,
      "--inventory",
      paths.inventory,
      "--root",
      directory,
      "--output-dir",
      outputDir,
      "--ci-receipt",
      paths.ci,
      "--prepare-run",
      paths.run,
      "--preparation-authority",
      paths.authority,
      "--source-ref",
      `refs/tags/v${CANDIDATE.version}`,
    ],
    {
      cwd: directory,
      importModule: async () => ({
        async prepareReleaseArtifacts(input) {
          received = input
          return { artifactName: "exact-artifact", manifestSha256: "a".repeat(64) }
        },
      }),
    },
  )
  assert.deepEqual(result, {
    artifactName: "exact-artifact",
    manifestSha256: "a".repeat(64),
  })
  assert.deepEqual(received.candidate, inputFiles.candidate)
  assert.deepEqual(received.inventory, inputFiles.inventory)
  assert.deepEqual(received.ci, inputFiles.ci)
  assert.deepEqual(received.prepareRun, inputFiles.run)
  assert.deepEqual(received.preparationAuthority, inputFiles.authority)
  assert.equal(received.root, directory)
  assert.equal(received.outputDir, outputDir)
  assert.equal(received.sourceRef, `refs/tags/v${CANDIDATE.version}`)
  assert.equal(received.fileSystem, undefined)

  await assert.rejects(
    runReleaseCli([
      "prepare",
      "--candidate",
      paths.candidate,
      "--inventory",
      paths.inventory,
      "--root",
      directory,
      "--output-dir",
      outputDir,
      "--ci-receipt",
      paths.ci,
      "--prepare-run",
      paths.run,
      "--preparation-authority",
      paths.authority,
    ]),
    /usage|argument|source-ref/iu,
  )
})

test("record-artifact rejects missing, discoverable-name, and mismatched URL outputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-release-cli-negative-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const candidatePath = join(directory, "candidate.json")
  const manifestPath = join(directory, "manifest.json")
  await writeFile(candidatePath, JSON.stringify(CANDIDATE))
  await writeFile(manifestPath, canonicalManifestBytes(sealedManifest()))

  for (const [name, upload] of [
    ["missing-digest", { artifactId: "9001", artifactUrl: artifactUrl(9001) }],
    [
      "name-discovery",
      {
        artifactId: "9001",
        artifactUrl: artifactUrl(9001),
        artifactDigest: "a".repeat(64),
        name: "release-evidence",
      },
    ],
    [
      "wrong-url-id",
      {
        artifactId: "9001",
        artifactUrl: artifactUrl(9002),
        artifactDigest: "a".repeat(64),
      },
    ],
  ]) {
    const uploadPath = join(directory, `${name}.json`)
    const outputPath = join(directory, `${name}-record.json`)
    await writeFile(uploadPath, JSON.stringify(upload))
    await assert.rejects(
      runReleaseCli([
        "record-artifact",
        "--candidate",
        candidatePath,
        "--manifest",
        manifestPath,
        "--artifact-upload-result",
        uploadPath,
        "--output",
        outputPath,
      ]),
      /artifact|output|url|schema|field/iu,
    )
    await assert.rejects(readFile(outputPath), { code: "ENOENT" })
  }
})

test("release CLI rejects unknown, duplicate, missing, and unpaired command arguments", async () => {
  for (const argv of [
    [],
    ["unknown"],
    ["record-artifact", "--candidate"],
    ["record-artifact", "--candidate", "a", "--candidate", "b"],
    ["record-artifact", "--candidate", "a", "--unknown", "b"],
  ]) {
    await assert.rejects(runReleaseCli(argv), /usage|command|argument|flag/iu)
  }
})

test("abandon CLI derives fresh protected evidence inside each requested mutation authorization", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-release-abandon-cli-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const contextPath = join(directory, "artifact-context.json")
  const artifactContext = { predecessor: "CANDIDATE_TAGGED", exact: true }
  await writeFile(contextPath, JSON.stringify(artifactContext))
  const calls = []
  const reader = Object.freeze({ kind: "reader" })
  const writer = Object.freeze({ kind: "writer" })
  const github = Object.freeze({ reader, writer })
  const npm = Object.freeze({
    async observePackageVersion() {
      assert.fail("stub authority owns this boundary")
    },
  })
  const environment = Object.freeze({
    GITHUB_TOKEN: "must-not-cross-abandonment-authority-boundary",
    GITHUB_REPOSITORY: "cacheplane/dawnai",
    GITHUB_RUN_ID: "700",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_ACTOR: "release-operator",
    GITHUB_ACTOR_ID: "7001",
    GITHUB_REF: `refs/tags/v${CANDIDATE.version}`,
    GITHUB_SHA: CANDIDATE.commitSha,
  })
  const wait = async () => assert.fail("stub authority owns this boundary")
  const now = () => Date.parse("2026-08-25T12:00:00Z")
  let captureCount = 0
  const importModule = async (specifier) => {
    const name = new URL(specifier).pathname.split("/").at(-1)
    if (name === "abandonment-authority.mjs") {
      return {
        async captureFreshAbandonmentEvidence(input) {
          captureCount += 1
          calls.push(["capture", input])
          return { authorization: captureCount }
        },
      }
    }
    if (name === "manifest.mjs") {
      return { CANONICAL_RELEASE_PACKAGE_ORDER }
    }
    assert.equal(name, "abandonment.mjs")
    return {
      async recordAbandonment(input) {
        calls.push(["record", input])
        const first = await input.authorization.readFreshAbandonmentEvidence({
          candidate: input.candidate,
        })
        const second = await input.authorization.readFreshAbandonmentEvidence({
          candidate: input.candidate,
        })
        return { phase: "ABANDONED_PREPUBLICATION", first, second }
      },
    }
  }

  const result = await runReleaseCli(
    [
      "abandon",
      "--version",
      CANDIDATE.version,
      "--commit-sha",
      CANDIDATE.commitSha,
      "--reason",
      "Candidate preparation is deterministically defective",
      "--artifact-context",
      contextPath,
    ],
    { cwd: directory, github, npm, environment, wait, now, importModule },
  )

  assert.deepEqual(result, {
    phase: "ABANDONED_PREPUBLICATION",
    first: { authorization: 1 },
    second: { authorization: 2 },
  })
  assert.deepEqual(
    calls.map(([name]) => name),
    ["record", "capture", "capture"],
  )
  assert.deepEqual(calls[0][1].candidate, CANDIDATE)
  assert.equal(calls[0][1].reason, "Candidate preparation is deterministically defective")
  assert.deepEqual(calls[0][1].artifactContext, artifactContext)
  assert.equal(calls[0][1].github, github)
  for (const [, input] of calls.slice(1)) {
    assert.deepEqual(input.candidate, CANDIDATE)
    assert.deepEqual(input.packageNames, [...CANONICAL_RELEASE_PACKAGE_ORDER].sort())
    assert.equal(input.github, reader)
    assert.equal(input.npm, npm)
    assert.equal(input.environment.GITHUB_ACTOR, "release-operator")
    assert.equal(input.environment.GITHUB_ACTOR_ID, "7001")
    assert.deepEqual(Object.keys(input.environment).sort(), [
      "GITHUB_ACTOR",
      "GITHUB_ACTOR_ID",
      "GITHUB_REF",
      "GITHUB_REPOSITORY",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_RUN_ID",
      "GITHUB_SHA",
    ])
    assert.equal(input.wait, wait)
    assert.equal(input.now, now)
  }
})

test("audit CLI routes keep dispatch, marker recording, correlation, and publication distinct", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-release-audit-cli-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const paths = {
    candidate: join(directory, "candidate.json"),
    dispatch: join(directory, "dispatch.json"),
    audit: join(directory, "audit.json"),
    record: join(directory, "record.json"),
    output: join(directory, "dispatch-output.json"),
    waitOutput: join(directory, "wait-output.json"),
  }
  const dispatchReceipt = {
    workflow: ".github/workflows/published-artifact-verify.yml",
    workflowRunId: 501,
    runUrl: "https://api.github.com/repos/cacheplane/dawnai/actions/runs/501",
    htmlUrl: "https://github.com/cacheplane/dawnai/actions/runs/501",
  }
  const audit = {
    schemaVersion: 1,
    version: CANDIDATE.version,
    commitSha: CANDIDATE.commitSha,
    manifestSha256: "a".repeat(64),
    workflowRunId: 501,
    runAttempt: 1,
    startedAt: "2026-08-24T01:00:00Z",
    finishedAt: "2026-08-24T01:01:00Z",
    checks: [{ name: "published-artifacts", conclusion: "success", detail: "verified" }],
    conclusion: "success",
  }
  await Promise.all([
    writeFile(paths.candidate, JSON.stringify(CANDIDATE)),
    writeFile(paths.dispatch, JSON.stringify(dispatchReceipt)),
    writeFile(paths.audit, JSON.stringify(audit)),
    writeFile(paths.record, JSON.stringify({ release: "record" })),
  ])
  const calls = []
  const github = { reader: { capability: "contents-read" }, writer: { capability: "scoped" } }
  const importModule = async (specifier) => {
    const name = new URL(specifier).pathname.split("/").at(-1)
    if (name === "terminal-records.mjs") {
      return {
        parseAuditResult: (value) => value,
        canonicalAuditResultBytes: (value) => Buffer.from(`${JSON.stringify(value)}\n`),
      }
    }
    if (name === "metadata.mjs") {
      return {
        async publishConsolidatedRelease(input) {
          calls.push(["publish", input])
          return { phase: "AUDIT_COMPLETE" }
        },
      }
    }
    assert.equal(name, "audit.mjs")
    return {
      async dispatchIndependentAudit(input) {
        calls.push(["dispatch", input])
        return dispatchReceipt
      },
      async recordAuditDispatch(input) {
        calls.push(["record-dispatch", input])
        return { phase: "AUDIT_DISPATCHED" }
      },
      async waitForAudit(input) {
        calls.push(["wait", input])
        return {
          status: "terminal",
          workflowRunId: 501,
          runAttempt: 1,
          conclusion: "success",
          result: audit,
        }
      },
      async recordAuditAttempt(input) {
        calls.push(["record-attempt", input])
        return { phase: "AUDIT_DISPATCHED" }
      },
      async verifyAuditSuccess(input) {
        calls.push(["verify-success", input])
        return { phase: "AUDIT_VERIFIED" }
      },
    }
  }

  await runReleaseCli(
    [
      "dispatch-audit",
      "--version",
      CANDIDATE.version,
      "--commit-sha",
      CANDIDATE.commitSha,
      "--manifest-sha256",
      "a".repeat(64),
      "--output",
      paths.output,
    ],
    { cwd: directory, github, importModule },
  )
  assert.deepEqual(JSON.parse(await readFile(paths.output, "utf8")), dispatchReceipt)
  await runReleaseCli(
    ["record-audit-dispatch", "--candidate", paths.candidate, "--dispatch-result", paths.dispatch],
    { cwd: directory, github, importModule },
  )
  const wait = async () => {}
  await runReleaseCli(
    [
      "wait-audit",
      "--candidate",
      paths.candidate,
      "--dispatch-result",
      paths.dispatch,
      "--output",
      paths.waitOutput,
    ],
    { cwd: directory, github, importModule, wait },
  )
  assert.deepEqual(JSON.parse(await readFile(paths.waitOutput, "utf8")), audit)
  await runReleaseCli(
    [
      "correlate-audit",
      "--candidate",
      paths.candidate,
      "--dispatch-result",
      paths.dispatch,
      "--audit-result",
      paths.audit,
    ],
    { cwd: directory, github, importModule },
  )
  await runReleaseCli(
    [
      "publish-release",
      "--candidate",
      paths.candidate,
      "--record",
      paths.record,
      "--audit-result",
      paths.audit,
    ],
    { cwd: directory, github, importModule },
  )

  assert.deepEqual(
    calls.map(([name]) => name),
    ["dispatch", "record-dispatch", "wait", "record-attempt", "verify-success", "publish"],
  )
  assert.equal(calls[0][1].github, github.writer)
  assert.equal(calls[1][1].github, github)
  assert.equal(calls[2][1].github, github.reader)
  assert.equal(calls[2][1].runId, dispatchReceipt.workflowRunId)
  assert.deepEqual(calls[2][1].candidate, CANDIDATE)
  assert.equal(calls[2][1].attempts, 181)
  assert.equal(calls[2][1].delayMs, 10_000)
  assert.equal(calls[2][1].delay, wait)
  assert.equal(typeof calls[2][1].now, "function")
  assert.equal(calls[3][1].github, github)
  assert.equal(calls[4][1].github, github)
  assert.equal(calls[5][1].github, github)
  assert.equal(
    calls.some(([name], index) => name === "publish" && index < calls.length - 1),
    false,
  )
})

test("wait-audit fails closed without writing a result when the exact run stays pending", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-release-audit-wait-cli-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const candidatePath = join(directory, "candidate.json")
  const dispatchPath = join(directory, "dispatch.json")
  const outputPath = join(directory, "audit.json")
  const dispatch = {
    workflow: ".github/workflows/published-artifact-verify.yml",
    workflowRunId: 777,
    runUrl: "https://api.github.com/repos/cacheplane/dawnai/actions/runs/777",
    htmlUrl: "https://github.com/cacheplane/dawnai/actions/runs/777",
  }
  await Promise.all([
    writeFile(candidatePath, JSON.stringify(CANDIDATE)),
    writeFile(dispatchPath, JSON.stringify(dispatch)),
  ])
  let calls = 0
  const github = { reader: { capability: "actions-read" }, writer: {} }
  const wait = async () => {}
  const now = () => 42
  const importModule = async () => ({
    async waitForAudit(input) {
      calls += 1
      assert.equal(input.runId, 777)
      assert.equal(input.github, github.reader)
      assert.equal(input.wait, undefined)
      assert.equal(input.delay, wait)
      assert.equal(input.now, now)
      return { status: "pending", workflowRunId: 777 }
    },
  })

  await assert.rejects(
    runReleaseCli(
      [
        "wait-audit",
        "--candidate",
        candidatePath,
        "--dispatch-result",
        dispatchPath,
        "--output",
        outputPath,
      ],
      { cwd: directory, github, importModule, wait, now },
    ),
    (error) => error?.code === "AUDIT_PENDING",
  )
  assert.equal(calls, 1)
  await assert.rejects(readFile(outputPath), (error) => error?.code === "ENOENT")
})

test("npm and smoke reconciliation CLI routes remain separate manifest-bound transitions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-release-reconcile-cli-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const smokeDirectory = join(directory, "smokes")
  await mkdir(smokeDirectory)
  const files = {
    candidate: CANDIDATE,
    record: { version: CANDIDATE.version, commitSha: CANDIDATE.commitSha },
    manifest: sealedManifest(),
    npm: { status: "NPM_COMPLETE", complete: true },
  }
  const paths = Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([name, value]) => {
        const target = join(directory, `${name}.json`)
        await writeFile(
          target,
          name === "manifest" ? canonicalManifestBytes(value) : JSON.stringify(value),
        )
        return [name, target]
      }),
    ),
  )
  await writeFile(join(smokeDirectory, "z-lane.json"), JSON.stringify({ lane: "z" }))
  await writeFile(join(smokeDirectory, "a-lane.json"), JSON.stringify({ lane: "a" }))
  const calls = []
  const github = { reader: {}, writer: {} }
  const importModule = async (specifier) => {
    const name = new URL(specifier).pathname.split("/").at(-1)
    if (name === "manifest.mjs") {
      return { parseSealedReleaseManifest: (bytes) => JSON.parse(bytes.toString("utf8")) }
    }
    assert.equal(name, "metadata.mjs")
    return {
      async reconcileNpmEvidence(input) {
        calls.push(["npm", input])
        return { phase: "NPM_COMPLETE" }
      },
      async reconcileSmokeEvidence(input) {
        calls.push(["smokes", input])
        return { phase: "SMOKES_COMPLETE" }
      },
    }
  }
  await runReleaseCli(
    [
      "reconcile-npm",
      "--candidate",
      paths.candidate,
      "--record",
      paths.record,
      "--manifest",
      paths.manifest,
      "--npm-evidence",
      paths.npm,
    ],
    { cwd: directory, github, importModule },
  )
  await runReleaseCli(
    [
      "reconcile-smokes",
      "--candidate",
      paths.candidate,
      "--record",
      paths.record,
      "--manifest",
      paths.manifest,
      "--npm-evidence",
      paths.npm,
      "--smoke-results",
      smokeDirectory,
    ],
    { cwd: directory, github, importModule },
  )
  assert.deepEqual(
    calls.map(([name]) => name),
    ["npm", "smokes"],
  )
  assert.equal(calls[0][1].github, github)
  assert.equal(calls[1][1].github, github)
  assert.deepEqual(
    calls[1][1].smokeResults.map(({ lane }) => lane),
    ["a", "z"],
  )
  assert.equal(calls[0][1].manifest.version, CANDIDATE.version)
  assert.equal(calls[1][1].manifest.version, CANDIDATE.version)
})

test("GitHub-mutating routes lazily construct the production boundary from the exact token", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-release-production-github-cli-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const candidatePath = join(directory, "candidate.json")
  const recordPath = join(directory, "record.json")
  const auditPath = join(directory, "audit.json")
  await Promise.all([
    writeFile(candidatePath, JSON.stringify(CANDIDATE)),
    writeFile(recordPath, JSON.stringify({ record: true })),
    writeFile(auditPath, JSON.stringify({ audit: true })),
  ])
  const calls = []
  const reader = Object.freeze({ kind: "reader" })
  const writer = Object.freeze({ kind: "writer" })
  const importModule = async (specifier) => {
    const name = new URL(specifier).pathname.split("/").at(-1)
    calls.push(["import", name])
    if (name === "github.mjs") {
      return {
        createGitHubReader(input) {
          calls.push(["reader", input])
          return reader
        },
      }
    }
    if (name === "github-write.mjs") {
      return {
        createGitHubWriter(input) {
          calls.push(["writer", input])
          return writer
        },
        composeGitHubEffects(input) {
          calls.push(["compose", input])
          return Object.freeze(input)
        },
      }
    }
    assert.equal(name, "metadata.mjs")
    return {
      async publishConsolidatedRelease(input) {
        calls.push(["publish", input])
        return { phase: "AUDIT_COMPLETE" }
      },
    }
  }
  await runReleaseCli(
    [
      "publish-release",
      "--candidate",
      candidatePath,
      "--record",
      recordPath,
      "--audit-result",
      auditPath,
    ],
    {
      cwd: directory,
      environment: Object.freeze({ GITHUB_TOKEN: "exact-test-token" }),
      importModule,
    },
  )
  const readerCall = calls.find(([name]) => name === "reader")[1]
  const writerCall = calls.find(([name]) => name === "writer")[1]
  assert.deepEqual(readerCall, {
    owner: "cacheplane",
    repo: "dawnai",
    token: "exact-test-token",
  })
  assert.deepEqual(writerCall, {
    owner: "cacheplane",
    repo: "dawnai",
    token: "exact-test-token",
    reader,
  })
  assert.deepEqual(
    calls.filter(([name]) => name === "import").map(([, name]) => name),
    ["github.mjs", "github-write.mjs", "metadata.mjs"],
  )
  assert.equal(calls.at(-1)[0], "publish")
  assert.deepEqual(calls.at(-1)[1].github, { reader, writer })
})

test("attestation-input writes one exact 22-subject checksum set from verified artifact bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-release-attestation-input-cli-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const artifactDirectory = join(directory, "artifact")
  await mkdir(artifactDirectory)
  const { manifest, record } = await materializeArtifactFixture(artifactDirectory)
  const recordPath = join(directory, "record.json")
  const outputPath = join(directory, "subjects.sha256")
  await writeFile(recordPath, canonicalReleaseRecordBytes(record))

  const result = await runReleaseCli([
    "attestation-input",
    "--record",
    recordPath,
    "--artifact-dir",
    artifactDirectory,
    "--output",
    outputPath,
  ])
  const lines = (await readFile(outputPath, "utf8")).trimEnd().split("\n")
  assert.equal(lines.length, 22)
  assert.deepEqual(
    lines.map((line) => line.slice(66)),
    ["manifest.json", ...manifest.packages.map(({ filename }) => filename)],
  )
  assert.equal(lines[0], `${record.manifestSha256}  manifest.json`)
  assert.deepEqual(result, {
    schemaVersion: 1,
    version: CANDIDATE.version,
    commitSha: CANDIDATE.commitSha,
    manifestSha256: record.manifestSha256,
    subjectCount: 22,
  })

  await writeFile(join(artifactDirectory, manifest.packages[4].filename), "corrupt")
  await assert.rejects(
    runReleaseCli([
      "attestation-input",
      "--record",
      recordPath,
      "--artifact-dir",
      artifactDirectory,
      "--output",
      join(directory, "corrupt.sha256"),
    ]),
    /artifact|tarball|digest|manifest|size/iu,
  )
})

test("escrow derives exact multi-subject bundles and captures fresh publication absence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-release-escrow-cli-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const artifactDirectory = join(directory, "artifact")
  await mkdir(artifactDirectory)
  const { manifest, record } = await materializeArtifactFixture(artifactDirectory)
  const paths = {
    candidate: join(directory, "candidate.json"),
    record: join(directory, "record.json"),
    bundle: join(directory, "attestation.jsonl"),
  }
  const bundle = Buffer.from('{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}\n')
  await Promise.all([
    writeFile(paths.candidate, JSON.stringify(CANDIDATE)),
    writeFile(paths.record, canonicalReleaseRecordBytes(record)),
    writeFile(paths.bundle, bundle),
  ])
  const githubCalls = []
  const github = {
    reader: {
      async listWorkflowRuns(input) {
        githubCalls.push(["runs", input])
        return presentEnvelope("workflow-runs", [
          {
            id: 701,
            run_attempt: 2,
            head_sha: CANDIDATE.commitSha,
            head_branch: `v${CANDIDATE.version}`,
            path: ".github/workflows/release.yml",
            event: "workflow_dispatch",
          },
        ])
      },
      async listActionsRunJobs(input) {
        githubCalls.push(["jobs", input])
        return presentEnvelope("actions-run-jobs", [
          {
            id: 801,
            runAttempt: 1,
            name: "tag",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-08-25T09:00:00Z",
            completedAt: "2026-08-25T09:01:00Z",
          },
          {
            id: 802,
            runAttempt: 2,
            name: "escrow",
            status: "in_progress",
            conclusion: null,
            startedAt: "2026-08-25T09:02:00Z",
            completedAt: null,
          },
          {
            id: 803,
            runAttempt: 2,
            name: "publish-npm",
            status: "queued",
            conclusion: null,
            startedAt: null,
            completedAt: null,
          },
        ])
      },
    },
    writer: {},
  }
  const npmCalls = []
  const npm = {
    async observePackageVersion(input) {
      npmCalls.push(input)
      return { status: "ABSENT", operation: "package-version", httpStatus: 404, code: "E404" }
    },
  }
  const attestations = {
    async verify() {
      assert.fail("the route delegates bundle verification to escrowCandidate")
    },
  }
  let received
  const importModule = async (specifier) => {
    const name = new URL(specifier).pathname.split("/").at(-1)
    if (name !== "metadata.mjs") return import(specifier)
    return {
      async escrowCandidate(input) {
        received = input
        return { phase: "ESCROWED", status: "escrowed" }
      },
    }
  }
  const result = await runReleaseCli(
    [
      "escrow",
      "--candidate",
      paths.candidate,
      "--record",
      paths.record,
      "--artifact-dir",
      artifactDirectory,
      "--attestation-bundle",
      paths.bundle,
    ],
    {
      cwd: directory,
      github,
      npm,
      attestations,
      now: () => Date.parse("2026-08-25T09:03:00Z"),
      environment: Object.freeze({
        GITHUB_TOKEN: "token",
        GITHUB_REPOSITORY: "cacheplane/dawnai",
        GITHUB_REF: `refs/tags/v${CANDIDATE.version}`,
        GITHUB_SHA: CANDIDATE.commitSha,
        GITHUB_RUN_ID: "701",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_WORKFLOW_REF: `cacheplane/dawnai/.github/workflows/release.yml@refs/tags/v${CANDIDATE.version}`,
      }),
      importModule,
    },
  )
  assert.deepEqual(result, { phase: "ESCROWED", status: "escrowed" })
  assert.deepEqual(
    npmCalls.map(({ name }) => name),
    [...CANONICAL_RELEASE_PACKAGE_ORDER],
  )
  assert.deepEqual(githubCalls, [
    ["runs", { workflow: "release.yml", commitSha: CANDIDATE.commitSha }],
    ["jobs", { runId: 701 }],
  ])
  assert.equal(received.attestationSet.subjects.length, 22)
  assert.deepEqual(
    received.attestationSet.subjects.map(({ subjectName }) => subjectName),
    ["manifest.json", ...manifest.packages.map(({ filename }) => filename)],
  )
  assert.equal(
    new Set(received.attestationSet.subjects.map(({ bundleSha256 }) => bundleSha256)).size,
    1,
  )
  assert.equal(received.bundles.length, 22)
  assert.equal(
    received.bundles.every(({ bytes }) => Buffer.from(bytes).equals(bundle)),
    true,
  )
  assert.equal(received.publicationState.packages.length, 21)
  assert.equal(received.publicationState.candidateRuns[0].jobs[2].startedAt, null)
  assert.deepEqual(
    parseAttestationSet(received.attestationSet, {
      candidate: CANDIDATE,
      manifest,
      repository: "cacheplane/dawnai",
    }),
    received.attestationSet,
  )
  assert.equal(
    JSON.stringify(
      parsePublicationState(received.publicationState, {
        candidate: CANDIDATE,
        inventory: { packages: manifest.packages.map(({ name }) => ({ name })) },
      }),
    ),
    JSON.stringify(received.publicationState),
  )
  assert.equal(received.github, github)
  assert.equal(received.attestations, attestations)
})

function observer(values) {
  let index = 0
  return Object.freeze({
    async observe() {
      assert.ok(index < values.length, "observer called more than the bounded contract")
      const value = values[index]
      index += 1
      return structuredClone(value)
    },
  })
}

function plannerFor({ state, disposition, transition }) {
  return Object.freeze({
    plan({ observation }) {
      return {
        state: observation.state ?? state,
        disposition,
        nextTransition: transition,
        reasons: ["fixture"],
        conflicts: disposition === "blocked" ? ["fixture-conflict"] : [],
        proposedMutations:
          transition === null
            ? []
            : [{ type: transition, version: CANDIDATE.version, commitSha: CANDIDATE.commitSha }],
      }
    },
  })
}

function reporter(reports) {
  return Object.freeze({
    async write(report) {
      reports.push(report)
    },
  })
}

function sealedManifest() {
  return {
    schemaVersion: 1,
    version: CANDIDATE.version,
    commitSha: CANDIDATE.commitSha,
    ci: { workflow: "CI", runId: 6001, runAttempt: 1 },
    artifact: {
      name: `release-v${CANDIDATE.version}-${CANDIDATE.commitSha.slice(0, 12)}`,
      prepareRunId: 7001,
      prepareRunAttempt: 2,
    },
    packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
    packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name, index) => {
      const filename = `${name.replace(/^@/u, "").replace("/", "-")}-${CANDIDATE.version}.tgz`
      const sha512 = (index + 1).toString(16).padStart(128, "0")
      return {
        name,
        version: CANDIDATE.version,
        filename,
        size: index + 1,
        sha256: (index + 1).toString(16).padStart(64, "0"),
        sha512,
        npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
        access: "public",
      }
    }),
  }
}

async function materializeArtifactFixture(directory) {
  const manifest = sealedManifest()
  for (const pkg of manifest.packages) {
    const bytes = Buffer.from(`artifact:${pkg.name}`, "utf8")
    pkg.size = bytes.length
    pkg.sha256 = digest(bytes, "sha256")
    pkg.sha512 = digest(bytes, "sha512")
    pkg.npmIntegrity = `sha512-${Buffer.from(pkg.sha512, "hex").toString("base64")}`
    await writeFile(join(directory, pkg.filename), bytes)
  }
  await writeFile(join(directory, "manifest.json"), canonicalManifestBytes(manifest))
  return {
    manifest,
    record: {
      schemaVersion: 1,
      version: CANDIDATE.version,
      commitSha: CANDIDATE.commitSha,
      tag: `v${CANDIDATE.version}`,
      manifestSha256: manifestSha256(manifest),
      actionsArtifact: {
        id: "9001",
        name: `release-v${CANDIDATE.version}-${CANDIDATE.commitSha.slice(0, 12)}`,
        serviceDigest: `sha256:${"a".repeat(64)}`,
        prepareRunId: "7001",
        prepareRunAttempt: 2,
      },
    },
  }
}

function digest(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest("hex")
}

function artifactUrl(artifactId) {
  return `https://github.com/cacheplane/dawnai/actions/runs/7001/artifacts/${artifactId}`
}

function presentEnvelope(operation, value) {
  return { status: "PRESENT", operation, httpStatus: 200, code: null, value }
}

function assertRecursivelyFrozen(value) {
  if (value === null || typeof value !== "object") return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertRecursivelyFrozen(child)
}
