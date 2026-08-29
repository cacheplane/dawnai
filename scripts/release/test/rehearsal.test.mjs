import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { createNpmReader } from "../adapters/npm.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER, canonicalManifestBytes } from "../manifest.mjs"
import {
  canonicalBaseAssetSet,
  escrowCandidate,
  parseReleaseMarker,
  parseSmokeReleaseAssetName,
} from "../metadata.mjs"
import { validateProductionAuditRun } from "../observe.mjs"
import { createReleaseRecord } from "../release-record.mjs"
import { canonicalAuditResultBytes } from "../terminal-records.mjs"
import { createFaultHarness, executeReleaseRehearsal } from "./support/fault-harness.mjs"
import { startFaultProxy } from "./support/fault-proxy.mjs"
import {
  createCandidateRepositoryFixture,
  createExactCandidateCommandRunner,
  createOrderedFaultGate,
  createRehearsalDurableState,
  FIXED_GROUP_REHEARSAL_FAULTS,
  parseReleaseRehearsalArguments,
  RehearsalCrashError,
  resumeFixedGroupEvidence,
  runReleaseRehearsal,
  verifyExpiredActionsEscrowFallback,
} from "./support/release-rehearsal.mjs"
import { createRehearsalGitHub } from "./support/release-rehearsal-github.mjs"

const THREE_PACKAGE_FIXTURE = fileURLToPath(new URL("./fixtures/fault-workspace", import.meta.url))
const execFileAsync = promisify(execFile)

test("full release rehearsal defaults to the canonical fixed group", async () => {
  assert.deepEqual(parseReleaseRehearsalArguments(["--all-faults"]), {
    inventory: "fixed-group",
    allFaults: true,
    inject: null,
    resume: true,
  })

  const calls = []
  const result = await runReleaseRehearsal(["--all-faults"], {
    async runFixedGroup(options) {
      calls.push(options)
      return { status: "verified" }
    },
  })
  assert.deepEqual(calls, [
    {
      inventory: "fixed-group",
      allFaults: true,
      inject: null,
      resume: true,
    },
  ])
  assert.deepEqual(result, { status: "verified" })
})

test("the three-package fixture cannot claim full release-transition coverage", () => {
  assert.throws(
    () => parseReleaseRehearsalArguments(["--fixture", "three-package", "--all-faults"]),
    /three-package.*Git.*registry.*fixed-group.*45-asset/iu,
  )
})

test("the executable rehearsal entrypoint applies the same full-coverage boundary", async () => {
  await assert.rejects(
    executeReleaseRehearsal(["--", "--fixture", "three-package", "--all-faults"]),
    /three-package.*Git.*registry.*fixed-group.*45-asset/iu,
  )
})

test("one fixed-group crash point requires explicit automatic resume", () => {
  assert.deepEqual(
    parseReleaseRehearsalArguments([
      "--inventory",
      "fixed-group",
      "--inject",
      "after-publish:11",
      "--resume",
    ]),
    {
      inventory: "fixed-group",
      allFaults: false,
      inject: "after-publish:11",
      resume: true,
    },
  )

  for (const argv of [
    ["--inventory", "fixed-group", "--inject", "after-publish:11"],
    ["--inventory", "fixed-group", "--inject", "after-publish:0", "--resume"],
    ["--inventory", "fixed-group", "--inject", "after-publish:22", "--resume"],
    ["--inventory", "fixed-group", "--all-faults", "--inject", "after-publish:11"],
    ["--inventory", "fixed-group", "--resume"],
    ["--inventory", "other", "--all-faults"],
    ["--all-faults", "--unknown"],
  ]) {
    assert.throws(() => parseReleaseRehearsalArguments(argv), /rehears|argument|fault|resume/iu)
  }
})

test("fixed-group fault inventory covers every durable external transition in order", () => {
  const required = [
    "tag",
    "prepare",
    "attest",
    "draft-create",
    "escrow-asset:1",
    "escrow-asset:23",
    "escrow-asset:45",
    "publish:1",
    "publish:11",
    "publish:21",
    "registry-convergence",
    "reconcile-npm",
    "smoke-result:metadata",
    "smoke-result:published-harness",
    "smoke-result:runtime-targets",
    "smoke-result:scaffold",
    "smoke-result:storage",
    "reconcile-smokes",
    "audit-dispatch",
    "audit-dispatch-receipt",
    "audit-dispatched-cas",
    "failed-audit-attempt",
    "audit-retryable-cas",
    "retry-audit-dispatch",
    "retry-audit-dispatch-receipt",
    "retry-audit-dispatched-cas",
    "successful-audit-attempt",
    "canonical-audit-success",
    "audit-verified-cas",
    "release-publication",
    "immutable-reread",
  ]
  assert.deepEqual(
    FIXED_GROUP_REHEARSAL_FAULTS,
    required.flatMap((transition) => [`before-${transition}`, `after-${transition}`]),
  )
  assert.equal(new Set(FIXED_GROUP_REHEARSAL_FAULTS).size, FIXED_GROUP_REHEARSAL_FAULTS.length)
})

test("ordered crash gate distinguishes pre-mutation and accepted-mutation runner loss", async () => {
  const gate = createOrderedFaultGate(["before-tag", "after-tag"])
  let externalMutations = 0
  const attempt = () =>
    gate.around("tag", async () => {
      if (externalMutations === 0) externalMutations += 1
      return { status: "present" }
    })

  await assert.rejects(attempt(), (error) => {
    assert.equal(error instanceof RehearsalCrashError, true)
    assert.equal(error.point, "before-tag")
    return true
  })
  assert.equal(externalMutations, 0)

  await assert.rejects(attempt(), (error) => {
    assert.equal(error instanceof RehearsalCrashError, true)
    assert.equal(error.point, "after-tag")
    return true
  })
  assert.equal(externalMutations, 1)

  assert.deepEqual(await attempt(), { status: "present" })
  assert.equal(externalMutations, 1)
  assert.deepEqual(gate.snapshot(), {
    injected: ["before-tag", "after-tag"],
    remaining: [],
  })
})

test("canonical candidate checkout rejects a dirty or drifted source tree", async (t) => {
  const fixture = await createSourceRepositoryFixture(t)
  await writeFile(join(fixture.sourceRoot, "candidate.txt"), "uncommitted drift\n")

  await assert.rejects(
    createCandidateRepositoryFixture({
      sourceRoot: fixture.sourceRoot,
      runtime: fixture.runtime,
    }),
    /source.*clean|dirty|drift/iu,
  )
})

test("preparation commands are confined to the exact clean candidate checkout", async (t) => {
  const fixture = await createSourceRepositoryFixture(t)
  await runGit(fixture.sourceRoot, ["switch", "-c", "release-candidate"])
  await writeFile(join(fixture.sourceRoot, "candidate.txt"), "release candidate\n")
  await runGit(fixture.sourceRoot, ["add", "candidate.txt"])
  await runGit(fixture.sourceRoot, ["commit", "-m", "release candidate"])
  const candidate = await createCandidateRepositoryFixture({
    sourceRoot: fixture.sourceRoot,
    runtime: fixture.runtime,
  })
  assert.notEqual(candidate.workingDirectory, fixture.sourceRoot)
  assert.equal(
    (await runGit(candidate.workingDirectory, ["rev-parse", "HEAD"])).trim(),
    candidate.commitSha,
  )
  assert.equal(
    (await runGit(candidate.workingDirectory, ["rev-parse", "refs/remotes/origin/main"])).trim(),
    candidate.commitSha,
  )
  assert.equal(
    (
      await runGit(candidate.workingDirectory, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ])
    ).trim(),
    "",
  )

  const calls = []
  const run = createExactCandidateCommandRunner({
    root: candidate.workingDirectory,
    async run(command, args, options) {
      calls.push({ command, args, cwd: options.cwd })
      return { exitCode: 0, stdout: "", stderr: "" }
    },
  })
  await run("pnpm", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: candidate.workingDirectory,
  })
  await assert.rejects(
    run("pnpm", ["build"], { cwd: fixture.sourceRoot }),
    /exact candidate checkout/iu,
  )
  assert.deepEqual(calls, [
    {
      command: "pnpm",
      args: ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
      cwd: candidate.workingDirectory,
    },
  ])
})

test("lost audit dispatch responses create an orphan but resume only from a new direct receipt", async () => {
  const gate = createOrderedFaultGate(["before-audit-dispatch", "after-audit-dispatch"])
  const remote = createRehearsalGitHub({
    candidate: {
      version: "0.8.22",
      commitSha: "a".repeat(40),
      ciWorkflow: "CI",
      ciCheck: "validate",
      publisherWorkflow: ".github/workflows/release.yml",
    },
    gate,
  })

  await assert.rejects(
    remote.actionsWriter.dispatchWorkflowAtRef(auditDispatchInput("0.8.22", "a".repeat(40))),
    (error) => error.point === "before-audit-dispatch",
  )
  assert.deepEqual(remote.snapshot().dispatchedRunIds, [])

  await assert.rejects(
    remote.actionsWriter.dispatchWorkflowAtRef(auditDispatchInput("0.8.22", "a".repeat(40))),
    (error) => error.point === "after-audit-dispatch",
  )
  assert.deepEqual(remote.snapshot().dispatchedRunIds, [501])

  const receipt = await remote.actionsWriter.dispatchWorkflowAtRef(
    auditDispatchInput("0.8.22", "a".repeat(40)),
  )
  assert.equal(receipt.workflowRunId, 502)
  assert.deepEqual(remote.snapshot().dispatchedRunIds, [501, 502])
  assert.equal(Object.hasOwn(remote.actionsWriter, "listWorkflowRuns"), false)
})

test("dispatched rehearsal audits expose the exact pending verify-job boundary", async () => {
  const candidate = {
    version: "0.8.22",
    commitSha: "a".repeat(40),
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  }
  const remote = createRehearsalGitHub({
    candidate,
    gate: createOrderedFaultGate([]),
  })
  const receipt = await remote.actionsWriter.dispatchWorkflowAtRef(
    auditDispatchInput(candidate.version, candidate.commitSha),
  )
  const [run, jobs] = await Promise.all([
    remote.releaseGitHub.reader.getActionsRun({ runId: receipt.workflowRunId }),
    remote.releaseGitHub.reader.listActionsRunJobs({ runId: receipt.workflowRunId }),
  ])

  assert.deepEqual(
    validateProductionAuditRun({
      value: run.value,
      jobs: jobs.value,
      candidate,
      marker: { audit: { workflowRunId: receipt.workflowRunId, runAttempt: null } },
    }),
    { status: "in_progress", conclusion: null, runAttempt: 1 },
  )
  const [verifyJob] = jobs.value
  for (const [name, value, jobHistory, code] of [
    ["empty", run.value, [], "RELEASE_AUDIT_RUN_IDENTITY_MISMATCH"],
    [
      "gapped",
      { ...run.value, run_attempt: 2 },
      [{ ...verifyJob, runAttempt: 2 }],
      "RELEASE_AUDIT_JOB_ATTEMPT_COVERAGE_INCOMPLETE",
    ],
    ["duplicate", run.value, [verifyJob, { ...verifyJob }], "RELEASE_AUDIT_JOB_IDENTITY_MISMATCH"],
    [
      "wrong-name",
      run.value,
      [{ ...verifyJob, name: "audit" }],
      "RELEASE_AUDIT_VERIFY_JOB_IDENTITY_MISMATCH",
    ],
  ]) {
    assert.throws(
      () =>
        validateProductionAuditRun({
          value,
          jobs: jobHistory,
          candidate,
          marker: { audit: { workflowRunId: receipt.workflowRunId, runAttempt: null } },
        }),
      (error) => error?.code === code,
      `${name} audit job history must fail closed`,
    )
  }
})

test("a canonical independent-auditor result atomically completes its exact run attempt", async () => {
  const candidate = {
    version: "0.8.22",
    commitSha: "a".repeat(40),
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  }
  const remote = createRehearsalGitHub({
    candidate,
    gate: createOrderedFaultGate([]),
  })
  const receipt = await remote.actionsWriter.dispatchWorkflowAtRef(
    auditDispatchInput(candidate.version, candidate.commitSha),
  )
  const result = {
    schemaVersion: 1,
    version: candidate.version,
    commitSha: candidate.commitSha,
    manifestSha256: "b".repeat(64),
    workflowRunId: receipt.workflowRunId,
    runAttempt: 1,
    startedAt: "2026-08-25T01:00:00.000Z",
    finishedAt: "2026-08-25T01:01:00.000Z",
    checks: [
      {
        name: "immutable-inventory",
        conclusion: "failure",
        detail: "Independent audit check failed (IMMUTABLE_INVENTORY_INVALID).",
      },
    ],
    conclusion: "failure",
  }
  const bytes = canonicalAuditResultBytes(result)

  await remote.recordIndependentAuditResult({
    workflowRunId: receipt.workflowRunId,
    result,
    bytes,
  })
  const [run, jobs, artifacts] = await Promise.all([
    remote.releaseGitHub.reader.getActionsRunAttempt({
      runId: receipt.workflowRunId,
      attempt: 1,
    }),
    remote.releaseGitHub.reader.listActionsRunJobs({ runId: receipt.workflowRunId }),
    remote.releaseGitHub.reader.listActionsRunArtifacts({ runId: receipt.workflowRunId }),
  ])

  assert.deepEqual(
    validateProductionAuditRun({
      value: run.value,
      jobs: jobs.value,
      candidate,
      marker: { audit: { workflowRunId: receipt.workflowRunId, runAttempt: 1 } },
    }),
    { status: "completed", conclusion: "failure", runAttempt: 1 },
  )
  assert.equal(artifacts.value.length, 1)
  const download = await remote.releaseGitHub.reader.downloadActionsArtifact({
    artifactId: artifacts.value[0].id,
  })
  assert.equal(Buffer.from(download.contentBase64, "base64").includes(bytes), true)
  await assert.rejects(
    remote.recordIndependentAuditResult({
      workflowRunId: receipt.workflowRunId,
      result: { ...result, manifestSha256: "c".repeat(64) },
      bytes: canonicalAuditResultBytes({ ...result, manifestSha256: "c".repeat(64) }),
    }),
    /conflict|identity/iu,
  )
})

test("real escrow transition resumes draft creation and selected 45-asset crash points", async () => {
  const fixture = fixedGroupArtifactFixture()
  const faults = [
    "before-draft-create",
    "after-draft-create",
    "before-escrow-asset:1",
    "after-escrow-asset:1",
    "before-escrow-asset:23",
    "after-escrow-asset:23",
    "before-escrow-asset:45",
    "after-escrow-asset:45",
  ]
  const gate = createOrderedFaultGate(faults)
  const base = canonicalBaseAssetSet(fixture)
  const remote = createRehearsalGitHub({
    candidate: fixture.candidate,
    gate,
    baseAssetNames: base.assets.map(({ name }) => name),
  })
  let result
  for (let attempt = 0; attempt <= faults.length; attempt += 1) {
    try {
      result = await escrowCandidate({
        ...fixture,
        publicationState: absentPublicationState(fixture),
        attestations: {
          async verify({ subjects }) {
            return { status: "VERIFIED", subjects }
          },
        },
        github: remote.releaseGitHub,
      })
      break
    } catch (error) {
      if (!(error instanceof RehearsalCrashError)) throw error
    }
  }

  assert.equal(result.phase, "ESCROWED")
  assert.equal(result.assetCount, 45)
  const snapshot = remote.snapshot()
  assert.equal(snapshot.assets.length, 45)
  assert.equal(parseReleaseMarker(snapshot.release.body).phase, "ESCROWED")
  assert.deepEqual(gate.snapshot().remaining, [])
})

test("expired exact Actions artifacts recover only from the attested 45-asset draft escrow", async () => {
  const fixture = fixedGroupArtifactFixture()
  const gate = createOrderedFaultGate([])
  const base = canonicalBaseAssetSet(fixture)
  const remote = createRehearsalGitHub({
    candidate: fixture.candidate,
    gate,
    baseAssetNames: base.assets.map(({ name }) => name),
  })
  await escrowCandidate({
    ...fixture,
    publicationState: absentPublicationState(fixture),
    attestations: {
      async verify({ subjects }) {
        return { status: "VERIFIED", subjects }
      },
    },
    github: remote.releaseGitHub,
  })

  const result = await verifyExpiredActionsEscrowFallback({
    record: fixture.record,
    remote,
  })
  assert.deepEqual(result, {
    source: "escrow",
    fileCount: 22,
    actionsExpired: true,
  })
})

test("real reconciliation, audit retry, publication, and immutable replay survive every crash", async () => {
  const fixture = fixedGroupArtifactFixture()
  const faults = FIXED_GROUP_REHEARSAL_FAULTS.slice(
    FIXED_GROUP_REHEARSAL_FAULTS.indexOf("before-reconcile-npm"),
  )
  const gate = createOrderedFaultGate(faults)
  const base = canonicalBaseAssetSet(fixture)
  const remote = createRehearsalGitHub({
    candidate: fixture.candidate,
    gate,
    baseAssetNames: base.assets.map(({ name }) => name),
  })
  await escrowCandidate({
    ...fixture,
    publicationState: absentPublicationState(fixture),
    attestations: {
      async verify({ subjects }) {
        return { status: "VERIFIED", subjects }
      },
    },
    github: remote.releaseGitHub,
  })
  const durable = createRehearsalDurableState()
  let result
  for (let attempt = 0; attempt <= faults.length; attempt += 1) {
    try {
      result = await resumeFixedGroupEvidence({
        candidate: fixture.candidate,
        record: fixture.record,
        manifest: fixture.artifact.manifest,
        npmEvidence: completeNpmEvidence(fixture),
        gate,
        remote,
        durable,
      })
      if (result.status === "AUDIT_COMPLETE") break
    } catch (error) {
      if (!(error instanceof RehearsalCrashError)) throw error
    }
  }

  assert.equal(result.status, "AUDIT_COMPLETE")
  assert.equal(result.immutable, true)
  assert.deepEqual(gate.snapshot().remaining, [])
  const snapshot = remote.snapshot()
  assert.deepEqual(snapshot.dispatchedRunIds, [501, 502, 503, 504, 505, 506])
  assert.equal(snapshot.release.draft, false)
  assert.equal(snapshot.release.immutable, true)
  const baseNames = new Set(base.assets.map(({ name }) => name))
  assert.equal(snapshot.assets.filter(({ name }) => baseNames.has(name)).length, 45)
  assert.equal(
    snapshot.assets.filter(({ name }) => parseSmokeReleaseAssetName(name) !== null).length,
    5,
  )
  assert.equal(snapshot.assets.length, 53)
  assert.deepEqual(
    snapshot.assets
      .map(({ name }) => name)
      .filter((name) => name.startsWith("audit-attempt-") || name === "audit-result.json"),
    ["audit-attempt-503-1.json", "audit-attempt-506-1.json", "audit-result.json"],
  )

  const replay = await resumeFixedGroupEvidence({
    candidate: fixture.candidate,
    record: fixture.record,
    manifest: fixture.artifact.manifest,
    npmEvidence: completeNpmEvidence(fixture),
    gate,
    remote,
    durable,
  })
  assert.equal(replay.status, "AUDIT_COMPLETE")
  assert.equal(replay.mutations, 0)
})

test("registry harness packs without publishing and exposes one bounded real publish primitive", async (t) => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), "dawn-rehearsal-outside-")))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const harness = await createFaultHarness({ fixtureDirectory: THREE_PACKAGE_FIXTURE })
  t.after(() => harness.close())

  const packed = await harness.packFixtureTarballs()
  assert.equal(packed.length, 3)
  const registryOrigin = new URL(harness.registry.url).origin
  const reader = createNpmReader({
    registryUrl: harness.registry.url,
    trustedRegistryOrigins: [registryOrigin],
    fetchImpl(url, options) {
      const target = new URL(url)
      assert.equal(target.origin, registryOrigin)
      return fetch(new URL(`${target.pathname}${target.search}`, harness.proxy.url), options)
    },
  })
  harness.proxy.setMode("exact-version-e404")
  assert.equal(
    (await reader.observePackageVersion({ name: packed[0].name, version: packed[0].version }))
      .status,
    "ABSENT",
  )

  harness.proxy.reset()
  await harness.publishPreparedTarball({ tarballPath: packed[0].tarballPath })
  const present = await reader.observePackageVersion({
    name: packed[0].name,
    version: packed[0].version,
  })
  assert.equal(present.status, "PRESENT")
  const downloaded = Buffer.from(await (await fetch(present.package.tarballUrl)).arrayBuffer())
  assert.equal(downloaded.equals(await readFile(packed[0].tarballPath)), true)

  const untrustedTarball = join(outside, "outside.tgz")
  await writeFile(untrustedTarball, "not trusted")
  await assert.rejects(
    harness.publishPreparedTarball({ tarballPath: untrustedTarball }),
    /allowed.*root|tarball.*root/iu,
  )
})

test("fault proxy preserves a canonical release tarball larger than the small fixture", async (t) => {
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61)
  const upstream = createServer((_request, response) => {
    response.writeHead(200, {
      "content-length": String(bytes.length),
      "content-type": "application/octet-stream",
    })
    response.end(bytes)
  })
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  t.after(
    () =>
      new Promise((resolve) => {
        upstream.close(resolve)
        upstream.closeAllConnections()
      }),
  )
  const address = upstream.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, "object")
  const proxy = await startFaultProxy({
    upstreamUrl: `http://127.0.0.1:${address.port}/`,
  })
  t.after(() => proxy.close())

  const response = await fetch(new URL("canonical-package.tgz", proxy.url))
  assert.equal(response.status, 200)
  assert.equal(Buffer.from(await response.arrayBuffer()).equals(bytes), true)
})

function auditDispatchInput(version, commitSha) {
  return {
    workflow: ".github/workflows/published-artifact-verify.yml",
    ref: `v${version}`,
    inputs: {
      version,
      commitSha,
      manifestSha256: "b".repeat(64),
    },
  }
}

function fixedGroupArtifactFixture() {
  const version = "0.8.22"
  const commitSha = "a".repeat(40)
  const candidate = {
    version,
    commitSha,
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  }
  const files = []
  const packages = CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => {
    const bytes = Buffer.from(`packed:${name}`)
    const sha512 = hash("sha512", bytes)
    const filename = `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`
    files.push({ name: filename, bytes })
    return {
      name,
      version,
      filename,
      size: bytes.byteLength,
      sha256: hash("sha256", bytes),
      sha512,
      npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
      access: "public",
    }
  })
  const manifest = {
    schemaVersion: 1,
    version,
    commitSha,
    ci: { workflow: "CI", runId: 10, runAttempt: 1 },
    artifact: {
      name: `release-v${version}-${commitSha.slice(0, 12)}`,
      prepareRunId: 11,
      prepareRunAttempt: 1,
    },
    packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
    packages,
  }
  files.unshift({ name: "manifest.json", bytes: canonicalManifestBytes(manifest) })
  const record = createReleaseRecord({
    candidate,
    manifestSha256: hash("sha256", canonicalManifestBytes(manifest)),
    artifact: { name: manifest.artifact.name },
    artifactUpload: { id: "12", digest: `sha256:${"b".repeat(64)}` },
    prepareRun: { id: 11, attempt: 1 },
  })
  const multiSubjectBundle = testMultiSubjectBundle({ candidate, files })
  const bundles = files.map(({ name }) => ({
    name: `${name}.intoto.jsonl`,
    bytes: multiSubjectBundle,
  }))
  const attestationSet = {
    repository: "cacheplane/dawnai",
    workflow: ".github/workflows/release.yml",
    sourceRef: `refs/tags/v${version}`,
    commitSha,
    workflowRunId: 13,
    runAttempt: 1,
    subjects: files.map((file, index) => ({
      subjectName: file.name,
      subjectSha256: hash("sha256", file.bytes),
      bundleName: bundles[index].name,
      bundleSha256: hash("sha256", bundles[index].bytes),
    })),
  }
  return {
    candidate,
    record,
    artifact: { manifest, files },
    attestationSet,
    bundles,
  }
}

function absentPublicationState(fixture) {
  return {
    schemaVersion: 1,
    version: fixture.candidate.version,
    commitSha: fixture.candidate.commitSha,
    tag: `v${fixture.candidate.version}`,
    observedAt: "2026-08-25T00:00:00Z",
    candidateRuns: [
      {
        runId: fixture.attestationSet.workflowRunId,
        runAttempt: fixture.attestationSet.runAttempt,
        headSha: fixture.candidate.commitSha,
        headBranch: `v${fixture.candidate.version}`,
        workflowPath: fixture.candidate.publisherWorkflow,
        event: "workflow_dispatch",
        jobs: [
          {
            id: 1,
            runAttempt: 1,
            name: "publish-npm",
            status: "completed",
            conclusion: "skipped",
            startedAt: "2026-08-25T00:00:00Z",
            completedAt: "2026-08-25T00:00:01Z",
          },
        ],
      },
    ],
    registryMutationReceipts: [],
    packages: fixture.artifact.manifest.packages.map(({ name }) => ({
      name,
      version: fixture.candidate.version,
      status: "ABSENT",
      httpStatus: 404,
      observedAt: "2026-08-25T00:00:00Z",
    })),
  }
}

function completeNpmEvidence(fixture) {
  return {
    schemaVersion: 1,
    version: fixture.candidate.version,
    commitSha: fixture.candidate.commitSha,
    manifestSha256: fixture.record.manifestSha256,
    complete: true,
    status: "NPM_COMPLETE",
    packages: fixture.artifact.manifest.packages.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      status: "present",
      size: pkg.size,
      tarballSha256: pkg.sha256,
      tarballSha512: pkg.sha512,
      integrity: pkg.npmIntegrity,
      latest: { status: "present", version: pkg.version },
      signature: { status: "valid", verifier: "npm-audit-signatures@11.17.0" },
      provenance: {
        predicateType: "https://slsa.dev/provenance/v1",
        workflow: ".github/workflows/release.yml",
        commitSha: fixture.candidate.commitSha,
        repository: "https://github.com/cacheplane/dawnai",
        ref: `refs/tags/v${fixture.candidate.version}`,
      },
    })),
  }
}

async function createSourceRepositoryFixture(t) {
  const sourceRoot = await realpath(await mkdtemp(join(tmpdir(), "dawn-rehearsal-source-")))
  const runtime = await realpath(await mkdtemp(join(tmpdir(), "dawn-rehearsal-runtime-")))
  t.after(async () => {
    await Promise.all([
      rm(sourceRoot, { recursive: true, force: true }),
      rm(runtime, { recursive: true, force: true }),
    ])
  })
  await runGit(sourceRoot, ["init", "--initial-branch=main"])
  await runGit(sourceRoot, ["config", "user.name", "Release Rehearsal Test"])
  await runGit(sourceRoot, ["config", "user.email", "release-rehearsal-test@example.invalid"])
  await writeFile(join(sourceRoot, "candidate.txt"), "committed candidate\n")
  await runGit(sourceRoot, ["add", "candidate.txt"])
  await runGit(sourceRoot, ["commit", "-m", "candidate"])
  return { sourceRoot, runtime }
}

async function runGit(cwd, args) {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  })
  return result.stdout
}

function hash(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest("hex")
}

function testMultiSubjectBundle({ candidate, files }) {
  const repository = "https://github.com/cacheplane/dawnai"
  const ref = `refs/tags/v${candidate.version}`
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: files.map(({ name, bytes }) => ({
      name,
      digest: { sha256: hash("sha256", bytes) },
    })),
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: { ref, repository, path: candidate.publisherWorkflow },
        },
        internalParameters: { github: { event_name: "workflow_dispatch" } },
        resolvedDependencies: [
          { uri: `git+${repository}@${ref}`, digest: { gitCommit: candidate.commitSha } },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: {
          invocationId: "https://github.com/cacheplane/dawnai/actions/runs/13/attempts/1",
        },
      },
    },
  }
  return Buffer.from(
    `${JSON.stringify({
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {
        certificate: { rawBytes: "fixture" },
        tlogEntries: [{}],
        timestampVerificationData: { rfc3161Timestamps: [] },
      },
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        payloadType: "application/vnd.in-toto+json",
        signatures: [{ sig: "verified-by-github", keyid: "" }],
      },
    })}\n`,
  )
}
