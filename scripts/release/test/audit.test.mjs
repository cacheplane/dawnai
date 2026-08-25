import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  correlateAuditResult,
  dispatchIndependentAudit,
  recordAuditAttempt,
  recordAuditDispatch,
  verifyAuditSuccess,
  waitForAudit,
} from "../audit.mjs"
import { canonicalReleaseBody, parseReleaseMarker, releaseBodySha256 } from "../metadata.mjs"
import { canonicalSmokeResultBytes } from "../smoke-result.mjs"
import { canonicalAuditResultBytes } from "../terminal-records.mjs"
import { SMOKE_LANES, smokeDescriptor } from "./support/marker-observation.mjs"

const VERSION = "0.8.22"
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
const MANIFEST_SHA256 = sha256(Buffer.from("manifest"))
const WORKFLOW = ".github/workflows/published-artifact-verify.yml"
const REPOSITORY = "cacheplane/dawnai"
const CANDIDATE = Object.freeze({
  version: VERSION,
  commitSha: COMMIT_SHA,
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})

test("independent dispatch uses the exact tag workflow and direct run receipt", async () => {
  const calls = []
  const github = Object.freeze({
    async dispatchWorkflowAtRef(input) {
      calls.push(input)
      return directReceipt(501)
    },
    async listWorkflowRuns() {
      assert.fail("dispatch must never guess by listing runs")
    },
  })

  assert.deepEqual(
    await dispatchIndependentAudit({
      candidate: CANDIDATE,
      manifestSha256: MANIFEST_SHA256,
      github,
    }),
    dispatch(501),
  )
  assert.deepEqual(calls, [
    {
      workflow: WORKFLOW,
      ref: `v${VERSION}`,
      inputs: {
        version: VERSION,
        commitSha: COMMIT_SHA,
        manifestSha256: MANIFEST_SHA256,
      },
    },
  ])
  assert.equal(Object.hasOwn(calls[0].inputs, "return_run_details"), false)

  await assert.rejects(
    dispatchIndependentAudit({
      candidate: CANDIDATE,
      manifestSha256: MANIFEST_SHA256,
      github: {
        async dispatchWorkflowAtRef() {
          return { ...directReceipt(501), htmlUrl: "https://github.com/fork/dawn/actions/runs/501" }
        },
      },
    }),
    /dispatch|receipt|url|repository/iu,
  )
})

test("dispatch recording CASes only an exact mutable SMOKES_COMPLETE draft", async () => {
  const remote = auditRemote()
  const before = remote.baseSnapshot()
  const recorded = await recordAuditDispatch({
    candidate: CANDIDATE,
    dispatch: dispatch(501),
    github: remote.releaseGitHub,
  })

  assert.equal(recorded.phase, "AUDIT_DISPATCHED")
  assert.equal(recorded.status, "updated")
  assert.deepEqual(parseReleaseMarker(remote.release.body).audit, auditMarker(dispatch(501)))
  assert.deepEqual(remote.baseSnapshot(), before)
  assert.equal(remote.publishCount, 0)

  const updates = remote.updateCount
  assert.equal(
    (
      await recordAuditDispatch({
        candidate: CANDIDATE,
        dispatch: dispatch(501),
        github: remote.releaseGitHub,
      })
    ).status,
    "unchanged",
  )
  assert.equal(remote.updateCount, updates)

  await assert.rejects(
    recordAuditDispatch({
      candidate: CANDIDATE,
      dispatch: dispatch(502),
      github: remote.releaseGitHub,
    }),
    /dispatch|phase|conflict/iu,
  )
})

test("a failed audit is attempt-scoped, retryable, idempotent, and preserves base escrow", async () => {
  const remote = auditRemote()
  await recordAuditDispatch({
    candidate: CANDIDATE,
    dispatch: dispatch(501),
    github: remote.releaseGitHub,
  })
  const result = auditResult({ workflowRunId: 501, conclusion: "failure" })
  const before = remote.baseSnapshot()

  const recorded = await recordAuditAttempt({
    candidate: CANDIDATE,
    dispatch: dispatch(501),
    result,
    github: remote.releaseGitHub,
  })
  assert.equal(recorded.phase, "AUDIT_RETRYABLE")
  assert.equal(recorded.status, "updated")
  assert.equal(remote.assets.has("audit-attempt-501-1.json"), true)
  assert.equal(remote.assets.has("audit-result.json"), false)
  assert.deepEqual(remote.baseSnapshot(), before)
  assert.equal(remote.publishCount, 0)

  const mutations = [remote.uploadCount, remote.updateCount]
  assert.equal(
    (
      await recordAuditAttempt({
        candidate: CANDIDATE,
        dispatch: dispatch(501),
        result,
        github: remote.releaseGitHub,
      })
    ).status,
    "unchanged",
  )
  assert.deepEqual([remote.uploadCount, remote.updateCount], mutations)

  await recordAuditDispatch({
    candidate: CANDIDATE,
    dispatch: dispatch(502),
    github: remote.releaseGitHub,
  })
  const marker = parseReleaseMarker(remote.release.body)
  assert.equal(marker.phase, "AUDIT_DISPATCHED")
  assert.equal(marker.audit.workflowRunId, 502)
  assert.equal(remote.assets.has("audit-attempt-501-1.json"), true)
})

test("an audit retry rejects every previously recorded workflow run ID", async () => {
  const remote = auditRemote()
  await recordAuditDispatch({
    candidate: CANDIDATE,
    dispatch: dispatch(501),
    github: remote.releaseGitHub,
  })
  await recordAuditAttempt({
    candidate: CANDIDATE,
    dispatch: dispatch(501),
    result: auditResult({ workflowRunId: 501, conclusion: "failure" }),
    github: remote.releaseGitHub,
  })
  await recordAuditDispatch({
    candidate: CANDIDATE,
    dispatch: dispatch(502),
    github: remote.releaseGitHub,
  })
  await recordAuditAttempt({
    candidate: CANDIDATE,
    dispatch: dispatch(502),
    result: auditResult({ workflowRunId: 502, conclusion: "failure" }),
    github: remote.releaseGitHub,
  })

  const updates = remote.updateCount
  await assert.rejects(
    recordAuditDispatch({
      candidate: CANDIDATE,
      dispatch: dispatch(501),
      github: remote.releaseGitHub,
    }),
    /new|historical|previous|replay|workflow run/iu,
  )
  const marker = parseReleaseMarker(remote.release.body)
  assert.equal(marker.phase, "AUDIT_RETRYABLE")
  assert.equal(marker.audit.workflowRunId, 502)
  assert.equal(remote.updateCount, updates)
})

test("successful audit writes attempt then byte-identical canonical receipt before marker CAS", async () => {
  const remote = auditRemote()
  await recordAuditDispatch({
    candidate: CANDIDATE,
    dispatch: dispatch(501),
    github: remote.releaseGitHub,
  })
  const result = auditResult({ workflowRunId: 501 })
  const bytes = canonicalAuditResultBytes(result)

  const attempted = await recordAuditAttempt({
    candidate: CANDIDATE,
    dispatch: dispatch(501),
    result,
    github: remote.releaseGitHub,
  })
  assert.equal(attempted.phase, "AUDIT_DISPATCHED")
  assert.equal(remote.assets.has("audit-attempt-501-1.json"), true)
  assert.equal(remote.assets.has("audit-result.json"), false)

  const verified = await verifyAuditSuccess({
    candidate: CANDIDATE,
    dispatch: dispatch(501),
    result,
    github: remote.releaseGitHub,
  })
  assert.equal(verified.phase, "AUDIT_VERIFIED")
  assert.equal(verified.status, "updated")
  assert.deepEqual(remote.assets.get("audit-attempt-501-1.json").bytes, bytes)
  assert.deepEqual(remote.assets.get("audit-result.json").bytes, bytes)
  assert.deepEqual(parseReleaseMarker(remote.release.body).audit, {
    ...auditMarker(dispatch(501)),
    runAttempt: 1,
    attemptAssetName: "audit-attempt-501-1.json",
    attemptSha256: sha256(bytes),
    canonicalSha256: sha256(bytes),
    conclusion: "success",
  })
  assert.equal(remote.publishCount, 0)

  const mutations = [remote.uploadCount, remote.updateCount]
  assert.equal(
    (
      await verifyAuditSuccess({
        candidate: CANDIDATE,
        dispatch: dispatch(501),
        result,
        github: remote.releaseGitHub,
      })
    ).status,
    "unchanged",
  )
  assert.deepEqual([remote.uploadCount, remote.updateCount], mutations)
})

test("audit writers resume runner loss after attempt, canonical, and marker mutations", async () => {
  for (const failurePoint of ["attempt", "canonical", "marker"]) {
    const remote = auditRemote()
    await recordAuditDispatch({
      candidate: CANDIDATE,
      dispatch: dispatch(501),
      github: remote.releaseGitHub,
    })
    const result = auditResult({ workflowRunId: 501 })
    if (failurePoint === "attempt") remote.throwAfterUploadName = "audit-attempt-501-1.json"
    if (failurePoint === "attempt") {
      await assert.rejects(
        recordAuditAttempt({
          candidate: CANDIDATE,
          dispatch: dispatch(501),
          result,
          github: remote.releaseGitHub,
        }),
        /runner loss/iu,
      )
    } else {
      await recordAuditAttempt({
        candidate: CANDIDATE,
        dispatch: dispatch(501),
        result,
        github: remote.releaseGitHub,
      })
    }
    remote.throwAfterUploadName = null
    await recordAuditAttempt({
      candidate: CANDIDATE,
      dispatch: dispatch(501),
      result,
      github: remote.releaseGitHub,
    })

    if (failurePoint === "canonical") remote.throwAfterUploadName = "audit-result.json"
    if (failurePoint === "marker") remote.throwAfterUpdate = true
    if (failurePoint !== "attempt") {
      await assert.rejects(
        verifyAuditSuccess({
          candidate: CANDIDATE,
          dispatch: dispatch(501),
          result,
          github: remote.releaseGitHub,
        }),
        /runner loss/iu,
      )
    }
    remote.throwAfterUploadName = null
    remote.throwAfterUpdate = false
    const recovered = await verifyAuditSuccess({
      candidate: CANDIDATE,
      dispatch: dispatch(501),
      result,
      github: remote.releaseGitHub,
    })
    assert.equal(recovered.phase, "AUDIT_VERIFIED")
  }
})

test("same-name different bytes and unexpected terminal evidence are hard conflicts", async () => {
  const remote = auditRemote()
  await recordAuditDispatch({
    candidate: CANDIDATE,
    dispatch: dispatch(501),
    github: remote.releaseGitHub,
  })
  remote.addAsset("audit-attempt-501-1.json", Buffer.from("different"))
  await assert.rejects(
    recordAuditAttempt({
      candidate: CANDIDATE,
      dispatch: dispatch(501),
      result: auditResult({ workflowRunId: 501 }),
      github: remote.releaseGitHub,
    }),
    /audit|receipt|canonical|json|conflict|digest/iu,
  )

  const unexpected = auditRemote()
  unexpected.addAsset("abandonment.json", Buffer.from("{}"))
  await assert.rejects(
    recordAuditDispatch({
      candidate: CANDIDATE,
      dispatch: dispatch(501),
      github: unexpected.releaseGitHub,
    }),
    /asset|namespace|abandon/iu,
  )
  assert.equal(unexpected.updateCount, 0)
})

test("waitForAudit polls the exact run and returns only its one canonical result artifact", async () => {
  const result = auditResult({ workflowRunId: 501, runAttempt: 2 })
  const remote = actionsRemote({ result, statuses: ["in_progress", "completed"] })
  let delays = 0
  const observed = await waitForAudit({
    runId: 501,
    candidate: CANDIDATE,
    github: remote.github,
    attempts: 3,
    delayMs: 1,
    delay: async () => {
      delays += 1
    },
  })
  assert.equal(observed.status, "terminal")
  assert.deepEqual(observed.result, result)
  assert.equal(delays, 1)
  assert.deepEqual(remote.calls, [
    ["getActionsRun", 501],
    ["getActionsRun", 501],
    ["listActionsRunArtifacts", 501],
    ["getActionsArtifact", 801],
    ["downloadActionsArtifact", 801],
  ])

  const pending = actionsRemote({ result, statuses: ["queued", "in_progress"] })
  assert.deepEqual(
    await waitForAudit({
      runId: 501,
      candidate: CANDIDATE,
      github: pending.github,
      attempts: 2,
      delayMs: 0,
      delay: async () => {},
    }),
    { status: "pending", workflowRunId: 501 },
  )
})

test("waitForAudit treats requested and waiting runs as bounded nonterminal states", async () => {
  const result = auditResult({ workflowRunId: 501, conclusion: "failure" })
  const remote = actionsRemote({
    result,
    statuses: ["requested", "waiting", "completed"],
    terminalConclusion: "cancelled",
  })
  const observed = await waitForAudit({
    runId: 501,
    candidate: CANDIDATE,
    github: remote.github,
    attempts: 3,
    delayMs: 0,
    delay: async () => {},
  })
  assert.equal(observed.status, "terminal")
  assert.equal(observed.result.conclusion, "failure")
})

test("waitForAudit rejects missing, duplicate, cross-run, wrong-attempt, and noncanonical results", async () => {
  const cases = [
    { mutate: (remote) => remote.artifacts.splice(0), pattern: /missing|exactly one|artifact/iu },
    {
      mutate: (remote) => remote.artifacts.push({ ...remote.artifacts[0], id: 802 }),
      pattern: /duplicate|exactly one|artifact/iu,
    },
    {
      mutate: (remote) => {
        remote.artifacts[0].workflow_run.id = 999
      },
      pattern: /run|correlat|artifact/iu,
    },
    {
      mutate: (remote) => {
        remote.artifacts[0].workflow_run.head_sha = "f".repeat(40)
      },
      pattern: /run|correlat|artifact|commit/iu,
    },
    {
      mutate: (remote) => {
        remote.artifacts[0].workflow_run.head_branch = "v0.8.23"
      },
      pattern: /run|correlat|artifact|ref|tag/iu,
    },
    {
      result: auditResult({ workflowRunId: 501, runAttempt: 2 }),
      runAttempt: 1,
      pattern: /attempt|name|correlat/iu,
    },
    {
      mutate: (remote) => {
        remote.zip = zip([{ name: "audit-result.json", bytes: Buffer.from("{}") }])
      },
      pattern: /audit|schema|canonical|result/iu,
    },
  ]
  for (const fixture of cases) {
    const remote = actionsRemote({
      result: fixture.result ?? auditResult({ workflowRunId: 501 }),
      statuses: ["completed"],
      runAttempt: fixture.runAttempt,
    })
    fixture.mutate?.(remote)
    await assert.rejects(
      waitForAudit({
        runId: 501,
        candidate: CANDIDATE,
        github: remote.github,
        attempts: 1,
        delayMs: 0,
        delay: async () => {},
      }),
      fixture.pattern,
    )
  }

  const malformedRef = actionsRemote({
    result: auditResult({ workflowRunId: 501 }),
    statuses: ["completed"],
  })
  malformedRef.headBranch = `v${VERSION}evil`
  await assert.rejects(
    waitForAudit({
      runId: 501,
      candidate: CANDIDATE,
      github: malformedRef.github,
      attempts: 1,
      delayMs: 0,
      delay: async () => {},
    }),
    /run|identity|branch|tag/iu,
  )

  const coherentWrongCandidate = actionsRemote({
    result: auditResult({ workflowRunId: 501 }),
    statuses: ["completed"],
  })
  coherentWrongCandidate.headSha = "f".repeat(40)
  coherentWrongCandidate.headBranch = "v0.8.23"
  coherentWrongCandidate.artifacts[0].workflow_run.head_sha = coherentWrongCandidate.headSha
  coherentWrongCandidate.artifacts[0].workflow_run.head_branch = coherentWrongCandidate.headBranch
  await assert.rejects(
    waitForAudit({
      runId: 501,
      candidate: CANDIDATE,
      github: coherentWrongCandidate.github,
      attempts: 1,
      delayMs: 0,
      delay: async () => {},
    }),
    /candidate|commit|ref|run|tag/iu,
  )
})

test("waitForAudit enforces one aggregate thirty-minute deadline", async () => {
  const result = auditResult({ workflowRunId: 501 })
  const remote = actionsRemote({
    result,
    statuses: Array.from({ length: 1_000 }, () => "queued"),
  })
  let currentTime = 0
  const delays = []
  const observed = await waitForAudit({
    runId: 501,
    candidate: CANDIDATE,
    github: remote.github,
    attempts: 1_000,
    delayMs: 300_000,
    delay: async (milliseconds) => {
      delays.push(milliseconds)
      currentTime += milliseconds
    },
    now: () => currentTime,
  })

  assert.deepEqual(observed, { status: "pending", workflowRunId: 501 })
  assert.equal(currentTime, 30 * 60 * 1_000)
  assert.deepEqual(
    delays,
    Array.from({ length: 6 }, () => 300_000),
  )
  assert.equal(remote.calls.filter(([method]) => method === "getActionsRun").length, 6)
})

test("waitForAudit returns pending within its deadline when an Actions read stalls", async () => {
  const github = Object.freeze({
    async getActionsRun() {
      return new Promise(() => {})
    },
    async listActionsRunArtifacts() {
      assert.fail("a stalled run read cannot advance to artifacts")
    },
    async getActionsArtifact() {
      assert.fail("a stalled run read cannot advance to artifact metadata")
    },
    async downloadActionsArtifact() {
      assert.fail("a stalled run read cannot advance to artifact bytes")
    },
  })
  const startedAt = Date.now()
  const observed = await waitForAudit({
    runId: 501,
    candidate: CANDIDATE,
    github,
    attempts: 1,
    delayMs: 0,
    delay: async () => {},
    timeoutMs: 20,
  })

  assert.deepEqual(observed, { status: "pending", workflowRunId: 501 })
  assert.ok(Date.now() - startedAt < 500)
})

test("correlation binds dispatch, candidate, manifest, run identity, and aggregate conclusion", () => {
  const result = auditResult({ workflowRunId: 501 })
  assert.deepEqual(
    correlateAuditResult({
      dispatch: dispatch(501),
      result,
      candidate: CANDIDATE,
      manifestSha256: MANIFEST_SHA256,
    }),
    result,
  )
  for (const changed of [
    { ...result, version: "0.8.23" },
    { ...result, commitSha: "f".repeat(40) },
    { ...result, manifestSha256: "f".repeat(64) },
    { ...result, workflowRunId: 999 },
  ]) {
    assert.throws(
      () =>
        correlateAuditResult({
          dispatch: dispatch(501),
          result: changed,
          candidate: CANDIDATE,
          manifestSha256: MANIFEST_SHA256,
        }),
      /audit|candidate|dispatch|correlat/iu,
    )
  }
  assert.throws(
    () =>
      correlateAuditResult({
        dispatch: dispatch(501),
        result: {
          ...result,
          checks: [{ name: "published-artifacts", conclusion: "failure", detail: "failed" }],
        },
        candidate: CANDIDATE,
        manifestSha256: MANIFEST_SHA256,
      }),
    /conclusion|check|audit/iu,
  )
})

function auditRemote() {
  const fixture = baseFixture()
  const remote = {
    release: {
      id: 7,
      tag_name: `v${VERSION}`,
      target_commitish: "main",
      prerelease: false,
      name: `Dawn v${VERSION}`,
      body: canonicalReleaseBody({ marker: fixture.marker, manifest: null }),
      draft: true,
      immutable: false,
    },
    assets: new Map(),
    nextAssetId: 100,
    updateCount: 0,
    uploadCount: 0,
    publishCount: 0,
    throwAfterUploadName: null,
    throwAfterUpdate: false,
  }
  for (const asset of fixture.assets) remote.addAsset?.(asset.name, asset.bytes)
  for (const asset of fixture.assets) {
    remote.assets.set(asset.name, { id: remote.nextAssetId, bytes: Buffer.from(asset.bytes) })
    remote.nextAssetId += 1
  }
  remote.addAsset = (name, bytes) => {
    remote.assets.set(name, { id: remote.nextAssetId, bytes: Buffer.from(bytes) })
    remote.nextAssetId += 1
  }
  remote.baseSnapshot = () =>
    fixture.assets.map(({ name }) => ({ name, bytes: Buffer.from(remote.assets.get(name).bytes) }))

  const reader = Object.freeze({
    async getRef() {
      return present("ref", { object: { type: "tag", sha: "a".repeat(40) } })
    },
    async getGitTag() {
      return present("git-tag", {
        tag: `v${VERSION}`,
        object: { type: "commit", sha: COMMIT_SHA },
      })
    },
    async listReleases() {
      return present("releases", [{ id: 7, tag_name: `v${VERSION}` }])
    },
    async getRelease() {
      return present("release", { ...remote.release })
    },
    async listReleaseAssets() {
      return present(
        "release-assets",
        [...remote.assets].map(([name, asset]) => ({
          id: asset.id,
          name,
          size: asset.bytes.byteLength,
        })),
      )
    },
    async downloadReleaseAsset({ assetId }) {
      const asset = [...remote.assets.values()].find((entry) => entry.id === assetId)
      assert.ok(asset)
      return {
        status: "PRESENT",
        operation: "release-asset-download",
        httpStatus: 200,
        code: null,
        contentBase64: asset.bytes.toString("base64"),
      }
    },
  })
  const writer = Object.freeze({
    async updateDraftReleaseIfCurrent({ expectedBodySha256, title, body }) {
      assert.equal(releaseBodySha256(remote.release.body), expectedBodySha256)
      remote.release.name = title
      remote.release.body = body
      remote.updateCount += 1
      if (remote.throwAfterUpdate) throw new Error("injected runner loss after marker mutation")
      return { releaseId: 7, status: "updated", bodySha256: releaseBodySha256(body) }
    },
    async uploadAssetIfAbsentAndEqual({ name, bytes, sha256: digest }) {
      const existing = remote.assets.get(name)
      if (existing !== undefined) {
        assert.equal(sha256(existing.bytes), digest, `conflicting ${name}`)
        return { assetId: existing.id, status: "existing", sha256: digest }
      }
      remote.addAsset(name, bytes)
      remote.uploadCount += 1
      if (remote.throwAfterUploadName === name) {
        throw new Error(`injected runner loss after ${name} upload`)
      }
      return { assetId: remote.assets.get(name).id, status: "uploaded", sha256: digest }
    },
    async publishReleaseIfCurrent() {
      remote.publishCount += 1
      assert.fail("audit code must not publish")
    },
  })
  remote.releaseGitHub = Object.freeze({ reader, writer })
  return remote
}

function baseFixture() {
  const manifest = { name: "manifest.json", bytes: Buffer.from("manifest") }
  const tarballs = Array.from({ length: 21 }, (_unused, index) => ({
    name: `dawn-ai-package-${String(index + 1).padStart(2, "0")}-${VERSION}.tgz`,
    bytes: Buffer.from(`tarball-${index + 1}`),
  }))
  const subjects = [manifest, ...tarballs]
  const bundles = subjects.map((subject) => ({
    name: `${subject.name}.intoto.jsonl`,
    bytes: Buffer.from("one-exact-multi-subject-bundle"),
  }))
  const record = { name: "release-record.json", bytes: Buffer.from("record") }
  const baseAssets = [record, ...subjects, ...bundles]
  const described = baseAssets.map((asset) => ({ name: asset.name, sha256: sha256(asset.bytes) }))
  const attestationSet = {
    repository: REPOSITORY,
    workflow: ".github/workflows/release.yml",
    sourceRef: `refs/tags/v${VERSION}`,
    commitSha: COMMIT_SHA,
    workflowRunId: 300,
    runAttempt: 1,
    subjects: subjects.map((subject, index) => ({
      subjectName: subject.name,
      subjectSha256: sha256(subject.bytes),
      bundleName: bundles[index].name,
      bundleSha256: sha256(bundles[index].bytes),
    })),
  }
  const smokeAssets = SMOKE_LANES.map((lane) => ({
    name: `smoke-result-${lane}-400-1.json`,
    bytes: canonicalSmokeResultBytes({
      schemaVersion: 1,
      lane,
      version: VERSION,
      commitSha: COMMIT_SHA,
      manifestSha256: sha256(manifest.bytes),
      workflowRunId: 400,
      runAttempt: 1,
      startedAt: "2026-08-24T00:10:00.000Z",
      finishedAt: "2026-08-24T00:11:00.000Z",
      checks: [{ name: "published-artifacts", conclusion: "success", detail: "verified" }],
      conclusion: "success",
    }),
  }))
  const marker = {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 4,
    phase: "SMOKES_COMPLETE",
    version: VERSION,
    commitSha: COMMIT_SHA,
    tag: `v${VERSION}`,
    manifestSha256: sha256(manifest.bytes),
    releaseRecordSha256: sha256(record.bytes),
    baseAssetSetSha256: sha256(Buffer.from(`${JSON.stringify(described)}\n`)),
    attestationSet,
    npmEvidenceSha256: "e".repeat(64),
    smoke: smokeDescriptor({
      releaseAssetIdStart: 145,
      receiptSha256s: smokeAssets.map((asset) => sha256(asset.bytes)),
    }),
    audit: null,
    abandonmentSha256: null,
  }
  return { marker, assets: [...baseAssets, ...smokeAssets] }
}

function actionsRemote({
  result,
  statuses,
  runAttempt = result.runAttempt,
  terminalConclusion = result.conclusion,
}) {
  const remote = {
    calls: [],
    statuses: [...statuses],
    artifacts: [
      {
        id: 801,
        name: `audit-result-${result.workflowRunId}-${runAttempt}`,
        expired: false,
        workflow_run: {
          id: result.workflowRunId,
          head_branch: `v${VERSION}`,
          head_sha: COMMIT_SHA,
        },
      },
    ],
    zip: zip([{ name: "audit-result.json", bytes: canonicalAuditResultBytes(result) }]),
    headBranch: `v${VERSION}`,
    headSha: COMMIT_SHA,
  }
  remote.github = Object.freeze({
    async getActionsRun({ runId }) {
      remote.calls.push(["getActionsRun", runId])
      const status = remote.statuses.shift() ?? "completed"
      return present("actions-run", {
        id: runId,
        run_attempt: runAttempt,
        status,
        conclusion: status === "completed" ? terminalConclusion : null,
        event: "workflow_dispatch",
        path: WORKFLOW,
        head_sha: remote.headSha,
        head_branch: remote.headBranch,
      })
    },
    async listActionsRunArtifacts({ runId }) {
      remote.calls.push(["listActionsRunArtifacts", runId])
      return present("actions-run-artifacts", remote.artifacts)
    },
    async getActionsArtifact({ artifactId }) {
      remote.calls.push(["getActionsArtifact", artifactId])
      const artifact = remote.artifacts.find(({ id }) => id === artifactId)
      return present("actions-artifact", artifact)
    },
    async downloadActionsArtifact({ artifactId }) {
      remote.calls.push(["downloadActionsArtifact", artifactId])
      return {
        status: "PRESENT",
        operation: "actions-artifact-download",
        httpStatus: 200,
        code: null,
        contentBase64: remote.zip.toString("base64"),
      }
    },
  })
  return remote
}

function auditResult({ workflowRunId, runAttempt = 1, conclusion = "success" }) {
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: MANIFEST_SHA256,
    workflowRunId,
    runAttempt,
    startedAt: "2026-08-24T01:00:00Z",
    finishedAt: "2026-08-24T01:01:00Z",
    checks: [
      {
        name: "published-artifacts",
        conclusion,
        detail: conclusion === "success" ? "verified" : "failed",
      },
    ],
    conclusion,
  }
}

function auditMarker(value) {
  return {
    workflow: WORKFLOW,
    workflowRunId: value.workflowRunId,
    runUrl: value.runUrl,
    htmlUrl: value.htmlUrl,
    runAttempt: null,
    attemptAssetName: null,
    attemptSha256: null,
    canonicalSha256: null,
    conclusion: null,
  }
}

function dispatch(workflowRunId) {
  return { workflow: WORKFLOW, ...directReceipt(workflowRunId) }
}

function directReceipt(workflowRunId) {
  return {
    workflowRunId,
    runUrl: `https://api.github.com/repos/${REPOSITORY}/actions/runs/${workflowRunId}`,
    htmlUrl: `https://github.com/${REPOSITORY}/actions/runs/${workflowRunId}`,
  }
}

function present(operation, value) {
  return { status: "PRESENT", operation, httpStatus: 200, code: null, value }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function zip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const bytes = Buffer.from(file.bytes)
    const local = Buffer.alloc(30 + name.length + bytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    bytes.copy(local, 30 + name.length)
    locals.push(local)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(bytes.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length
  }
  const centralOffset = offset
  const centralSize = centrals.reduce((total, entry) => total + entry.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}
