import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Worker } from "node:worker_threads"

import { canonicalAbandonmentBytes, canonicalAbandonmentReleaseBody } from "../abandonment.mjs"
import { runReleaseCli } from "../cli.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER, canonicalManifestBytes } from "../manifest.mjs"
import { abandonmentReleaseMarker, canonicalReleaseBody } from "../metadata.mjs"
import { canonicalNpmEvidenceBytes } from "../npm-evidence.mjs"
import {
  classifyProductionEvent,
  createProductionInventoryReader,
  observeProductionCandidate,
  resolveProductionCandidate,
  validateProductionAuditRun,
} from "../observe.mjs"
import { planRelease } from "../planner.mjs"
import { canonicalReleaseRecordBytes } from "../release-record.mjs"
import {
  aggregateSmokeResults,
  canonicalAggregateSmokeResultBytes,
  canonicalSmokeResultBytes,
  REQUIRED_RELEASE_SMOKE_LANES,
} from "../smoke-result.mjs"
import { canonicalTerminalRecordBytes } from "../terminal-record-store.mjs"
import { canonicalAuditResultBytes } from "../terminal-records.mjs"
import { record as terminalRecordFixture } from "./support/terminal-record-fixture.mjs"

const VERSION = "0.8.22"
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
const PARENT_SHA = "1123456789abcdef0123456789abcdef01234567"
const TAG_SHA = "2123456789abcdef0123456789abcdef01234567"
const MARKER = Object.freeze({
  schemaVersion: 1,
  publishingOwner: "release-controller",
  epoch: "fixed-group-v1",
  npmTrustedPublisherEnvironment: null,
  abandonmentEnvironment: "release-abandonment",
})

test("production event classification distinguishes exact refs from schedules", () => {
  assert.deepEqual(classifyProductionEvent({ ref: "refs/heads/main", after: COMMIT_SHA }), {
    kind: "exact-ref",
    ref: COMMIT_SHA,
    expectedVersion: null,
  })
  assert.deepEqual(classifyProductionEvent({ schedule: "17 * * * *" }), {
    kind: "scheduled",
    ref: null,
    expectedVersion: null,
  })
  assert.deepEqual(
    classifyProductionEvent({
      inputs: { version: VERSION, commitSha: COMMIT_SHA },
    }),
    { kind: "exact-ref", ref: COMMIT_SHA, expectedVersion: VERSION },
  )
  assert.throws(
    () => classifyProductionEvent({ schedule: "17 * * * *", after: COMMIT_SHA }),
    /ambiguous/u,
  )
})

test("production candidate resolution uses the exact immutable ref or scheduled arbitration", async () => {
  const calls = []
  const exact = await resolveProductionCandidate({
    event: { ref: "refs/heads/main", after: COMMIT_SHA },
    inventory: inventoryReader(),
    git: {},
    github: {},
    marker: MARKER,
    discovery: {
      async discoverManagedCandidate(input) {
        calls.push(["exact", input.ref])
        return selection()
      },
      async discoverScheduledCandidate() {
        calls.push(["global", null])
        return selection()
      },
    },
  })
  assert.deepEqual(exact, selection())

  const scheduled = await resolveProductionCandidate({
    event: { schedule: "17 * * * *" },
    inventory: inventoryReader(),
    git: {},
    github: {},
    marker: MARKER,
    discovery: {
      async discoverManagedCandidate() {
        throw new Error("exact discovery must not run")
      },
      async discoverScheduledCandidate() {
        calls.push(["scheduled", null])
        return selection()
      },
    },
  })
  assert.deepEqual(scheduled, selection())
  assert.deepEqual(calls, [
    ["exact", COMMIT_SHA],
    ["global", null],
    ["scheduled", null],
  ])
})

test("production exact dispatch accepts a verified current-version no-candidate no-op", async () => {
  const reads = []
  const resolved = await resolveProductionCandidate({
    event: { inputs: { version: VERSION, commitSha: COMMIT_SHA } },
    inventory: {
      async read({ ref }) {
        reads.push(ref)
        return inventory()
      },
    },
    git: {},
    github: {},
    marker: MARKER,
    discovery: {
      async discoverManagedCandidate() {
        return noCandidateSelection()
      },
      async discoverScheduledCandidate() {
        return noCandidateSelection()
      },
    },
  })

  assert.deepEqual(resolved, noCandidateSelection())
  assert.deepEqual(reads, [COMMIT_SHA])
})

test("production exact no-candidate dispatch rejects inventory version drift", async () => {
  await assert.rejects(
    resolveProductionCandidate({
      event: { inputs: { version: VERSION, commitSha: COMMIT_SHA } },
      inventory: {
        async read() {
          return {
            status: "valid",
            packages: inventory().packages.map((pkg) => ({
              ...pkg,
              version: "0.8.21",
            })),
          }
        },
      },
      git: {},
      github: {},
      marker: MARKER,
      discovery: {
        async discoverManagedCandidate() {
          return noCandidateSelection()
        },
        async discoverScheduledCandidate() {
          return noCandidateSelection()
        },
      },
    }),
    /dispatch inputs do not match/u,
  )
})

test("production exact-ref resolution cannot leapfrog an older globally selected candidate", async () => {
  const newer = { ...candidate(), version: "0.8.23" }
  const older = { ...candidate(), commitSha: PARENT_SHA }
  const resolved = await resolveProductionCandidate({
    event: { ref: "refs/heads/main", after: COMMIT_SHA },
    inventory: inventoryReader(),
    git: {},
    github: {},
    marker: MARKER,
    discovery: {
      async discoverManagedCandidate() {
        return {
          candidate: newer,
          state: "CANDIDATE_VALIDATED",
          disposition: "selected",
          tag: null,
          conflicts: [],
        }
      },
      async discoverScheduledCandidate() {
        return {
          candidate: older,
          state: "CANDIDATE_TAGGED",
          disposition: "selected",
          tag: `v${VERSION}`,
          conflicts: [],
        }
      },
    },
  })

  assert.equal(resolved.candidate.version, VERSION)
  assert.equal(resolved.candidate.commitSha, PARENT_SHA)
  assert.equal(resolved.state, "CANDIDATE_TAGGED")
})

test("production candidate resolution rejects a mixed or extended discovery selection", async () => {
  await assert.rejects(
    resolveProductionCandidate({
      event: { ref: "refs/heads/main", after: COMMIT_SHA },
      inventory: inventoryReader(),
      git: {},
      github: {},
      marker: MARKER,
      discovery: {
        async discoverManagedCandidate() {
          return { ...selection(), replayCandidate: candidate() }
        },
        async discoverScheduledCandidate() {
          throw new Error("scheduled discovery must not run")
        },
      },
    }),
    /selection is malformed/u,
  )

  await assert.rejects(
    resolveProductionCandidate({
      event: { ref: "refs/heads/main", after: COMMIT_SHA },
      inventory: inventoryReader(),
      git: {},
      github: {},
      marker: MARKER,
      discovery: {
        async discoverManagedCandidate() {
          return {
            ...selection(),
            candidate: { ...candidate(), commitSha: PARENT_SHA },
          }
        },
        async discoverScheduledCandidate() {
          throw new Error("scheduled discovery must not run")
        },
      },
    }),
    /candidate identity does not match/u,
  )
})

test("production inventory reader loads and validates the immutable commit", async () => {
  const refs = []
  const reader = createProductionInventoryReader({
    root: "/repo",
    git: {},
    async readReleaseInventory({ root, ref }) {
      assert.equal(root, "/repo")
      refs.push(ref)
      return rawInventory()
    },
    assertValidReleaseInventory() {
      return {
        packages: [...CANONICAL_RELEASE_PACKAGE_ORDER].sort(),
        version: VERSION,
      }
    },
  })

  assert.deepEqual(await reader.read({ ref: COMMIT_SHA }), inventory())
  assert.deepEqual(refs, [COMMIT_SHA])
})

test("production observation proves an early tagged candidate without fabricating digests", async () => {
  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github: githubReader(),
    npm: npmReader(),
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.inventory.packages.length, 21)
  assert.ok(
    observation.inventory.packages.every(
      (pkg) =>
        pkg.tarballSha256 === null && pkg.attestationSha256 === null && pkg.integrity === null,
    ),
  )
  assert.deepEqual(observation.tag, {
    status: "present",
    commitSha: COMMIT_SHA,
  })
  assert.ok(observation.registry.packages.every((pkg) => pkg.status === "e404"))
  assert.ok(
    observation.smokes.every((smoke) => smoke.workflowRunId === null && smoke.runAttempt === null),
  )

  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })
  assert.equal(plan.state, "CANDIDATE_TAGGED")
  assert.equal(plan.disposition, "would-transition")
  assert.equal(plan.nextTransition, "prepare-artifacts")
  assert.deepEqual(plan.conflicts, [])
})

test("production observation maps adapter authorization and timeout failures to ambiguity", async () => {
  const github = githubReader({
    getRef: async () => envelope("AMBIGUOUS", "ref", null, "HTTP_403"),
    listReleases: async () => envelope("AMBIGUOUS", "releases", null, "TIMEOUT"),
  })
  const npm = npmReader({
    observePackageVersion: async () => envelope("AMBIGUOUS", "package-version", null, "HTTP_401"),
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm,
  })

  assert.equal(observation.tag.status, "ambiguous")
  assert.equal(observation.release.status, "ambiguous")
  assert.ok(observation.registry.packages.every((pkg) => pkg.status === "ambiguous"))
  assert.ok(diagnostics.some((entry) => entry.code === "HTTP_403"))
  assert.ok(diagnostics.some((entry) => entry.code === "TIMEOUT"))
  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })
  assert.equal(plan.disposition, "blocked")
  assert.ok(plan.conflicts.includes("candidate-tag-ambiguous"))
  assert.ok(plan.conflicts.includes("registry-package-ambiguous"))
})

test("production CI correlation ignores unrelated commit checks", async () => {
  const github = githubReader({
    async getCommitCheckRuns() {
      return present("commit-check-runs", [
        {
          id: 9,
          name: "lint",
          head_sha: COMMIT_SHA,
          status: "completed",
          conclusion: "success",
          check_suite: { id: 20 },
        },
        {
          id: 10,
          name: "validate",
          head_sha: COMMIT_SHA,
          status: "completed",
          conclusion: "success",
          check_suite: { id: 20 },
        },
        {
          id: 11,
          name: "validate",
          head_sha: COMMIT_SHA,
          status: "completed",
          conclusion: "success",
          check_suite: { id: 99 },
        },
      ])
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
  })

  assert.deepEqual(diagnostics, [])
  assert.deepEqual(observation.ci, {
    status: "success",
    workflow: "CI",
    check: "validate",
    commitSha: COMMIT_SHA,
    workflowRunId: 30,
    runAttempt: 1,
  })
  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })
  assert.equal(plan.disposition, "would-transition")
  assert.deepEqual(plan.conflicts, [])
})

test("production CI correlation cannot authorize a pull-request run at the candidate SHA", async () => {
  const github = githubReader({
    async getCommitCheckRuns() {
      return present("commit-check-runs", [
        {
          id: 10,
          name: "validate",
          head_sha: COMMIT_SHA,
          status: "completed",
          conclusion: "success",
          check_suite: { id: 19 },
        },
      ])
    },
    async listWorkflowRuns({ workflow }) {
      return present(
        "workflow-runs",
        workflow === "ci.yml"
          ? [
              {
                ...ciRuns()[0],
                id: 29,
                check_suite_id: 19,
                head_branch: "feature",
                event: "pull_request",
              },
            ]
          : [],
      )
    },
  })

  const { observation } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.notEqual(observation.ci.status, "success")
})

test("production CI correlation selects the exact main push when a PR suite shares its SHA", async () => {
  const github = githubReader({
    async getCommitCheckRuns() {
      return present("commit-check-runs", [
        {
          id: 9,
          name: "validate",
          head_sha: COMMIT_SHA,
          status: "completed",
          conclusion: "success",
          check_suite: { id: 19 },
        },
        {
          id: 10,
          name: "validate",
          head_sha: COMMIT_SHA,
          status: "completed",
          conclusion: "success",
          check_suite: { id: 20 },
        },
      ])
    },
    async listWorkflowRuns({ workflow }) {
      return present(
        "workflow-runs",
        workflow === "ci.yml"
          ? [
              {
                ...ciRuns()[0],
                id: 29,
                check_suite_id: 19,
                head_branch: "feature",
                event: "pull_request",
              },
              ciRuns()[0],
            ]
          : [],
      )
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.ci.status, "success")
  assert.equal(observation.ci.workflowRunId, 30)
})

test("production observation derives publication start only from exact all-attempt job evidence", async () => {
  const run = {
    id: 40,
    name: "Release",
    path: ".github/workflows/release.yml",
    head_sha: COMMIT_SHA,
    head_branch: `v${VERSION}`,
    status: "in_progress",
    conclusion: null,
    run_attempt: 1,
  }
  const pendingGithub = githubReader({
    async listWorkflowRuns({ workflow }) {
      return present("workflow-runs", workflow === "ci.yml" ? ciRuns() : [run])
    },
    async listActionsRunJobs({ runId }) {
      assert.equal(runId, run.id)
      return present("actions-run-jobs", [publisherJob({ startedAt: null })])
    },
  })
  const pending = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github: pendingGithub,
    npm: npmReader(),
  })
  assert.equal(pending.observation.registry.publishJobStarted, false)
  assert.deepEqual(pending.diagnostics, [])

  const startedGithub = githubReader({
    async listWorkflowRuns({ workflow }) {
      return present("workflow-runs", workflow === "ci.yml" ? ciRuns() : [run])
    },
    async listActionsRunJobs() {
      return present("actions-run-jobs", [publisherJob({ startedAt: "2026-08-25T10:00:00.000Z" })])
    },
  })
  const started = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github: startedGithub,
    npm: npmReader(),
  })
  assert.equal(started.observation.registry.publishJobStarted, true)
  assert.equal(started.observation.registry.mutationStarted, true)

  const mixedGithub = githubReader({
    async listWorkflowRuns({ workflow }) {
      return present(
        "workflow-runs",
        workflow === "ci.yml" ? ciRuns() : [{ ...run, head_sha: PARENT_SHA }],
      )
    },
    async listActionsRunJobs() {
      throw new Error("mixed run identity must be rejected before job discovery")
    },
  })
  const mixed = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github: mixedGithub,
    npm: npmReader(),
  })
  assert.ok(mixed.observation.registry.packages.every((pkg) => pkg.status === "ambiguous"))
  assert.ok(mixed.diagnostics.some((entry) => entry.code === "PUBLISHER_RUN_IDENTITY_MISMATCH"))
  const mixedPlan = planRelease({
    candidate: candidate(),
    observation: mixed.observation,
    mode: "controller",
  })
  assert.equal(mixedPlan.disposition, "blocked")
  assert.ok(mixedPlan.conflicts.includes("registry-package-ambiguous"))
})

test("production publication history ignores the branch coordinator and scheduler-timestamped skipped jobs", async () => {
  const tagRun = {
    id: 40,
    name: "Release",
    path: ".github/workflows/release.yml",
    head_sha: COMMIT_SHA,
    head_branch: `v${VERSION}`,
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
  }
  const coordinator = {
    ...tagRun,
    id: 39,
    head_branch: "main",
    conclusion: "success",
  }
  const github = githubReader({
    async listWorkflowRuns({ workflow }) {
      return present("workflow-runs", workflow === "ci.yml" ? ciRuns() : [coordinator, tagRun])
    },
    async listActionsRunJobs({ runId }) {
      assert.equal(runId, tagRun.id)
      return present("actions-run-jobs", [
        {
          id: 401,
          runAttempt: 1,
          name: "publish-npm",
          status: "completed",
          conclusion: "skipped",
          startedAt: "2026-08-25T10:00:00.000Z",
          completedAt: "2026-08-25T10:00:01.000Z",
        },
      ])
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.registry.publishJobStarted, false)
  assert.equal(observation.registry.mutationStarted, false)
})

test("production publication history permits only the current exact-tag detect before publish materializes", async () => {
  const currentRun = {
    id: 40,
    name: "Release",
    path: ".github/workflows/release.yml",
    head_sha: COMMIT_SHA,
    head_branch: `v${VERSION}`,
    status: "in_progress",
    conclusion: null,
    run_attempt: 1,
  }
  const github = githubReader({
    async listWorkflowRuns({ workflow }) {
      return present("workflow-runs", workflow === "ci.yml" ? ciRuns() : [currentRun])
    },
    async listActionsRunJobs({ runId }) {
      assert.equal(runId, currentRun.id)
      return present("actions-run-jobs", [
        {
          id: 401,
          runAttempt: 1,
          name: "detect",
          status: "in_progress",
          conclusion: null,
          startedAt: "2026-08-31T15:44:39.000Z",
          completedAt: null,
        },
      ])
    },
  })

  const blocked = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
  })
  assert.ok(blocked.diagnostics.some((entry) => entry.code === "PUBLISHER_JOB_HISTORY_INVALID"))

  const current = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
    currentPublisherRun: {
      runId: currentRun.id,
      runAttempt: currentRun.run_attempt,
      ref: `refs/tags/v${VERSION}`,
      sha: COMMIT_SHA,
    },
  })
  assert.deepEqual(current.diagnostics, [])
  assert.equal(current.observation.registry.publishJobStarted, false)
  assert.equal(current.observation.registry.mutationStarted, false)
})

test("production observation binds a prepared artifact to its exact run and release record", async () => {
  const prepared = preparedArtifactFixture()
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [prepared.payloadMetadata])
    },
    async listActionsRunArtifacts({ runId }) {
      assert.equal(runId, 200)
      return present("actions-run-artifacts", [prepared.payloadMetadata, prepared.recordMetadata])
    },
    async getActionsRunAttempt({ runId }) {
      assert.equal(runId, 200)
      return present("actions-run-attempt", prepareRun())
    },
    async downloadActionsArtifact({ artifactId, maximumBytes }) {
      assert.ok(maximumBytes > 0)
      assert.ok(maximumBytes <= 40 * 1024 * 1024)
      const archive =
        Number(artifactId) === prepared.payloadMetadata.id
          ? prepared.payloadArchive
          : prepared.recordArchive
      return {
        status: "PRESENT",
        operation: "actions-artifact-download",
        httpStatus: 200,
        code: null,
        contentBase64: archive.toString("base64"),
      }
    },
  })

  const { observation, diagnostics, recovery } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
    includeRecovery: true,
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.artifacts.status, "prepared")
  assert.equal(observation.artifacts.manifestSha256, prepared.record.manifestSha256)
  assert.equal(observation.artifacts.releaseRecordAsset.sha256, prepared.recordSha256)
  assert.ok(observation.inventory.packages.every((pkg) => pkg.tarballSha256 !== null))
  assert.deepEqual(recovery.candidate, candidate())
  assert.deepEqual(recovery.manifest, prepared.manifest)
  assert.deepEqual(recovery.releaseRecord, prepared.record)
  assert.equal(recovery.npmEvidence, null)
  assert.equal(recovery.auditDispatch, null)
  assert.equal(recovery.auditResult, null)
  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })
  assert.equal(plan.state, "ARTIFACTS_PREPARED")
  assert.equal(plan.nextTransition, "attest-artifacts")
  assert.deepEqual(plan.conflicts, [])
})

test("production observation binds preparation to its historical exact run attempt", async () => {
  const prepared = preparedArtifactFixture()
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [prepared.payloadMetadata])
    },
    async listActionsRunArtifacts() {
      return present("actions-run-artifacts", [prepared.payloadMetadata, prepared.recordMetadata])
    },
    async getActionsRun() {
      throw new Error("the mutable current run endpoint must not identify preparation")
    },
    async getActionsRunAttempt({ runId, attempt }) {
      assert.equal(runId, 200)
      assert.equal(attempt, 1)
      return present("actions-run-attempt", prepareRun())
    },
    async downloadActionsArtifact({ artifactId }) {
      return binary(
        "actions-artifact-download",
        Number(artifactId) === prepared.payloadMetadata.id
          ? prepared.payloadArchive
          : prepared.recordArchive,
      )
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.artifacts.status, "prepared")
})

test("production observation revalidates a sealed CI attempt after a later rerun", async () => {
  const prepared = preparedArtifactFixture()
  const github = githubReader({
    async getCommitCheckRuns() {
      return present("commit-check-runs", [
        {
          id: 11,
          name: "validate",
          head_sha: COMMIT_SHA,
          status: "completed",
          conclusion: "success",
          check_suite: { id: 21 },
        },
      ])
    },
    async listWorkflowRuns({ workflow }) {
      return present(
        "workflow-runs",
        workflow === "ci.yml" ? [{ ...ciRuns()[0], run_attempt: 2, check_suite_id: 21 }] : [],
      )
    },
    async listActionsArtifacts() {
      return present("actions-artifacts", [prepared.payloadMetadata])
    },
    async getActionsRunAttempt({ runId, attempt }) {
      if (runId === 30) {
        assert.equal(attempt, 1)
        return present("actions-run-attempt", ciRuns()[0])
      }
      assert.equal(runId, 200)
      assert.equal(attempt, 1)
      return present("actions-run-attempt", prepareRun())
    },
    async listActionsRunJobs({ runId }) {
      assert.equal(runId, 30)
      return present("actions-run-jobs", [
        {
          id: 301,
          runAttempt: 1,
          name: "validate",
          status: "completed",
          conclusion: "success",
          startedAt: "2026-08-24T00:00:00.000Z",
          completedAt: "2026-08-24T00:01:00.000Z",
        },
        {
          id: 302,
          runAttempt: 2,
          name: "validate",
          status: "completed",
          conclusion: "success",
          startedAt: "2026-08-25T00:00:00.000Z",
          completedAt: "2026-08-25T00:01:00.000Z",
        },
      ])
    },
    async listActionsRunArtifacts() {
      return present("actions-run-artifacts", [prepared.payloadMetadata, prepared.recordMetadata])
    },
    async downloadActionsArtifact({ artifactId }) {
      return binary(
        "actions-artifact-download",
        Number(artifactId) === prepared.payloadMetadata.id
          ? prepared.payloadArchive
          : prepared.recordArchive,
      )
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.ci.runAttempt, 1)
  assert.equal(observation.artifacts.status, "prepared")
})

test("production observation deliberately ignores remote attestations until exact Release escrow exists", async () => {
  const prepared = preparedArtifactFixture()
  for (const remoteCount of [0, 1, 2]) {
    let discoveryCalls = 0
    let downloadCalls = 0
    const github = githubReader({
      async listActionsArtifacts() {
        return present("actions-artifacts", [prepared.payloadMetadata])
      },
      async getActionsRunAttempt() {
        return present("actions-run-attempt", prepareRun())
      },
      async listActionsRunArtifacts() {
        return present("actions-run-artifacts", [prepared.payloadMetadata, prepared.recordMetadata])
      },
      async downloadActionsArtifact({ artifactId }) {
        return binary(
          "actions-artifact-download",
          Number(artifactId) === prepared.payloadMetadata.id
            ? prepared.payloadArchive
            : prepared.recordArchive,
        )
      },
      async getAttestations() {
        discoveryCalls += 1
        return present(
          "attestations",
          Array.from({ length: remoteCount }, (_unused, index) => ({
            id: index + 1,
          })),
        )
      },
      async downloadAttestationBundle() {
        downloadCalls += 1
        throw new Error("remote attestation transport must not be consumed")
      },
    })

    const { observation, diagnostics } = await observeProductionCandidate({
      candidate: candidate(),
      inventory: inventory(),
      marker: MARKER,
      git: gitReader(),
      github,
      npm: npmReader(),
    })

    assert.deepEqual(diagnostics, [])
    assert.equal(discoveryCalls, 0)
    assert.equal(downloadCalls, 0)
    assert.equal(observation.artifacts.status, "prepared")
    assert.ok(observation.inventory.packages.every((pkg) => pkg.attestationSha256 === null))
    const plan = planRelease({
      candidate: candidate(),
      observation,
      mode: "controller",
    })
    assert.equal(plan.state, "ARTIFACTS_PREPARED")
    assert.equal(plan.nextTransition, "attest-artifacts")
    assert.deepEqual(plan.conflicts, [])
  }
})

test("production observation permits replacement of an orphaned pre-escrow payload", async () => {
  const orphaned = preparedArtifactFixture({
    artifactId: 90,
    prepareRunId: 190,
    recordId: 91,
  })
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [orphaned.payloadMetadata])
    },
    async getActionsRunAttempt({ runId }) {
      assert.equal(runId, 190)
      return present("actions-run-attempt", prepareRun({ id: 190 }))
    },
    async listActionsRunArtifacts({ runId }) {
      assert.equal(runId, 190)
      return present("actions-run-artifacts", [orphaned.payloadMetadata])
    },
    async downloadActionsArtifact({ artifactId }) {
      assert.equal(artifactId, orphaned.payloadMetadata.id)
      return binary("actions-artifact-download", orphaned.payloadArchive)
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.artifacts.status, "absent")
  assert.ok(observation.inventory.packages.every((pkg) => pkg.tarballSha256 === null))
  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })
  assert.equal(plan.state, "CANDIDATE_TAGGED")
  assert.equal(plan.nextTransition, "prepare-artifacts")
  assert.deepEqual(plan.conflicts, [])
})

test("production observation permits replacement after an expired payload proves no handoff", async () => {
  const orphaned = preparedArtifactFixture({
    artifactId: 90,
    prepareRunId: 190,
    recordId: 91,
  })
  const expired = { ...orphaned.payloadMetadata, expired: true }
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [expired])
    },
    async listActionsRunArtifacts({ runId }) {
      assert.equal(runId, 190)
      return present("actions-run-artifacts", [expired])
    },
    async downloadActionsArtifact() {
      throw new Error("expired orphan bytes must not be downloaded")
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.artifacts.status, "absent")
  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })
  assert.equal(plan.state, "CANDIDATE_TAGGED")
  assert.equal(plan.nextTransition, "prepare-artifacts")
})

test("production observation rejects a live replacement mixed with a different expired handoff", async () => {
  const replacement = preparedArtifactFixture()
  const expiredFixture = preparedArtifactFixture({
    artifactId: 90,
    prepareRunId: 190,
    recordId: 91,
  })
  const expired = { ...expiredFixture.payloadMetadata, expired: true }
  const conflictingRecord = {
    ...expiredFixture.record,
    manifestSha256: "f".repeat(64),
  }
  const conflictingRecordBytes = canonicalReleaseRecordBytes(conflictingRecord)
  const conflictingArchive = storedZip([
    { name: "release-record.json", bytes: conflictingRecordBytes },
  ])
  const conflictingMetadata = {
    ...expiredFixture.recordMetadata,
    digest: `sha256:${digest(conflictingArchive)}`,
  }
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [expired, replacement.payloadMetadata])
    },
    async getActionsRunAttempt({ runId }) {
      return present("actions-run-attempt", prepareRun({ id: runId }))
    },
    async listActionsRunArtifacts({ runId }) {
      return present(
        "actions-run-artifacts",
        runId === 190
          ? [expired, conflictingMetadata]
          : [replacement.payloadMetadata, replacement.recordMetadata],
      )
    },
    async downloadActionsArtifact({ artifactId }) {
      const archives = new Map([
        [conflictingMetadata.id, conflictingArchive],
        [replacement.payloadMetadata.id, replacement.payloadArchive],
        [replacement.recordMetadata.id, replacement.recordArchive],
      ])
      return binary("actions-artifact-download", archives.get(Number(artifactId)))
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.equal(observation.artifacts.status, "ambiguous")
  assert.ok(diagnostics.some((entry) => entry.code === "EXPIRED_HANDOFF_CONFLICT"))
})

test("production observation never accepts a noncanonical release-record handoff name", async () => {
  const orphaned = preparedArtifactFixture()
  const disguised = {
    ...orphaned.recordMetadata,
    id: 102,
    name: "unrelated-output",
  }
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [orphaned.payloadMetadata])
    },
    async getActionsRunAttempt() {
      return present("actions-run-attempt", prepareRun())
    },
    async listActionsRunArtifacts() {
      return present("actions-run-artifacts", [orphaned.payloadMetadata, disguised])
    },
    async downloadActionsArtifact({ artifactId }) {
      assert.equal(artifactId, orphaned.payloadMetadata.id)
      return binary("actions-artifact-download", orphaned.payloadArchive)
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.artifacts.status, "absent")
})

test("production observation rejects duplicate canonical release-record handoffs", async () => {
  const prepared = preparedArtifactFixture()
  const duplicate = { ...prepared.recordMetadata, id: 102 }
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [prepared.payloadMetadata])
    },
    async getActionsRunAttempt() {
      return present("actions-run-attempt", prepareRun())
    },
    async listActionsRunArtifacts() {
      return present("actions-run-artifacts", [
        prepared.payloadMetadata,
        prepared.recordMetadata,
        duplicate,
      ])
    },
    async downloadActionsArtifact({ artifactId }) {
      assert.equal(artifactId, prepared.payloadMetadata.id)
      return binary("actions-artifact-download", prepared.payloadArchive)
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.equal(observation.artifacts.status, "ambiguous")
  assert.ok(diagnostics.some((entry) => entry.code === "RELEASE_RECORD_HANDOFF_AMBIGUOUS"))
})

test("production observation correlates one replacement handoff despite an older orphan", async () => {
  const orphaned = preparedArtifactFixture({
    artifactId: 90,
    prepareRunId: 190,
    recordId: 91,
  })
  const replacement = preparedArtifactFixture()
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [orphaned.payloadMetadata, replacement.payloadMetadata])
    },
    async getActionsRunAttempt({ runId }) {
      return present("actions-run-attempt", prepareRun({ id: runId }))
    },
    async listActionsRunArtifacts({ runId }) {
      return present(
        "actions-run-artifacts",
        runId === 190
          ? [orphaned.payloadMetadata]
          : [replacement.payloadMetadata, replacement.recordMetadata],
      )
    },
    async downloadActionsArtifact({ artifactId }) {
      const archives = new Map([
        [orphaned.payloadMetadata.id, orphaned.payloadArchive],
        [replacement.payloadMetadata.id, replacement.payloadArchive],
        [replacement.recordMetadata.id, replacement.recordArchive],
      ])
      return binary("actions-artifact-download", archives.get(Number(artifactId)))
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.artifacts.status, "prepared")
  assert.equal(observation.artifacts.releaseRecordAsset.sha256, replacement.recordSha256)
  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })
  assert.equal(plan.state, "ARTIFACTS_PREPARED")
  assert.equal(plan.nextTransition, "attest-artifacts")
})

test("production observation rejects a prepared artifact from a mixed workflow run", async () => {
  const prepared = preparedArtifactFixture()
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [prepared.payloadMetadata])
    },
    async getActionsRunAttempt() {
      return present("actions-run-attempt", {
        ...prepareRun(),
        path: ".github/workflows/ci.yml",
        head_branch: "main",
      })
    },
    async listActionsRunArtifacts() {
      throw new Error("mixed prepare-run identity must block before handoff discovery")
    },
    async downloadActionsArtifact({ artifactId }) {
      assert.equal(artifactId, prepared.payloadMetadata.id)
      return binary("actions-artifact-download", prepared.payloadArchive)
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.equal(observation.artifacts.status, "ambiguous")
  assert.ok(diagnostics.some((entry) => entry.code === "PREPARE_RUN_IDENTITY_MISMATCH"))
})

test("production observation rejects live prepared evidence from a pull-request run", async () => {
  const prepared = preparedArtifactFixture()
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [prepared.payloadMetadata])
    },
    async getActionsRunAttempt() {
      return present("actions-run-attempt", {
        ...prepareRun(),
        event: "pull_request",
      })
    },
    async listActionsRunArtifacts() {
      throw new Error("invalid prepare-run event must block before handoff discovery")
    },
    async downloadActionsArtifact({ artifactId }) {
      assert.equal(artifactId, prepared.payloadMetadata.id)
      return binary("actions-artifact-download", prepared.payloadArchive)
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.equal(observation.artifacts.status, "ambiguous")
  assert.ok(diagnostics.some((entry) => entry.code === "PREPARE_RUN_IDENTITY_MISMATCH"))
})

test("production observation rejects retained prepared evidence from a pull-request run", async () => {
  const prepared = preparedArtifactFixture()
  const expired = { ...prepared.payloadMetadata, expired: true }
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [expired])
    },
    async getActionsRunAttempt() {
      return present("actions-run-attempt", {
        ...prepareRun(),
        event: "pull_request",
      })
    },
    async listActionsRunArtifacts() {
      return present("actions-run-artifacts", [expired, prepared.recordMetadata])
    },
    async downloadActionsArtifact({ artifactId }) {
      assert.equal(artifactId, prepared.recordMetadata.id)
      return binary("actions-artifact-download", prepared.recordArchive)
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.equal(observation.artifacts.status, "ambiguous")
  assert.ok(diagnostics.some((entry) => entry.code === "PREPARE_RUN_IDENTITY_MISMATCH"))
})

test("production observation binds a prepared manifest to the exact successful CI run", async () => {
  const prepared = preparedArtifactFixture({
    ci: { workflow: "CI", runId: 31, runAttempt: 2 },
  })
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [prepared.payloadMetadata])
    },
    async getActionsRunAttempt() {
      return present("actions-run-attempt", prepareRun())
    },
    async listActionsRunArtifacts() {
      return present("actions-run-artifacts", [prepared.payloadMetadata, prepared.recordMetadata])
    },
    async downloadActionsArtifact({ artifactId }) {
      return binary(
        "actions-artifact-download",
        Number(artifactId) === prepared.payloadMetadata.id
          ? prepared.payloadArchive
          : prepared.recordArchive,
      )
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.equal(observation.artifacts.status, "ambiguous")
  assert.ok(
    diagnostics.some((entry) => entry.code === "MANIFEST_CI_IDENTITY_MISMATCH"),
    JSON.stringify(diagnostics),
  )
})

test("production observation binds retained Release manifests to the exact successful CI run", async () => {
  const escrow = attestedReleaseFixture({
    ci: { workflow: "CI", runId: 31, runAttempt: 2 },
  })
  const github = releaseFixtureReader(escrow)

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.equal(observation.release.status, "ambiguous")
  assert.ok(diagnostics.some((entry) => entry.code === "MANIFEST_CI_IDENTITY_MISMATCH"))
})

test("production observation rejects a retained manifest sealed by a pull-request CI run", async () => {
  const escrow = attestedReleaseFixture({
    ci: { workflow: "CI", runId: 31, runAttempt: 1 },
  })
  const github = releaseFixtureReader(escrow, {
    async getActionsRunAttempt({ runId, attempt }) {
      if (Number(runId) === 31 && attempt === 1) {
        return present("actions-run-attempt", {
          ...ciRuns()[0],
          id: 31,
          head_branch: "main",
          event: "pull_request",
        })
      }
      return present("actions-run-attempt", prepareRun({ id: runId }))
    },
    async listActionsRunJobs({ runId }) {
      if (Number(runId) === 31) {
        return present("actions-run-jobs", [
          {
            id: 311,
            runAttempt: 1,
            name: "validate",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-08-24T00:00:00.000Z",
            completedAt: "2026-08-24T00:01:00.000Z",
          },
        ])
      }
      return present("actions-run-jobs", [publisherJob({ startedAt: null })])
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.equal(observation.release.status, "ambiguous")
  assert.ok(
    diagnostics.some((entry) => entry.code === "MANIFEST_CI_IDENTITY_MISMATCH"),
    JSON.stringify(diagnostics),
  )
})

test("production observation partitions and binds the exact draft Release base namespace", async () => {
  const escrow = attestedReleaseFixture()
  escrow.release.tag_name = "untagged-opaque"
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [])
    },
    async listReleases() {
      return present("releases", [
        {
          id: 999,
          tag_name: "untagged-unrelated",
          draft: true,
          immutable: false,
          body: `${escrow.release.body}${escrow.release.body}`,
        },
        escrow.release,
      ])
    },
    async getRelease({ releaseId }) {
      assert.equal(releaseId, escrow.release.id)
      return present("release", escrow.release)
    },
    async listReleaseAssets({ releaseId }) {
      assert.equal(releaseId, escrow.release.id)
      return present("release-assets", escrow.assets)
    },
    async downloadReleaseAsset({ assetId }) {
      const bytes = escrow.bytesById.get(Number(assetId))
      assert.ok(bytes)
      return {
        status: "PRESENT",
        operation: "release-asset-download",
        httpStatus: 200,
        code: null,
        contentBase64: bytes.toString("base64"),
      }
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.release.status, "draft")
  assert.equal(observation.release.bodySha256, digest(Buffer.from(escrow.release.body)))
  assert.equal(observation.release.assets.length, 45)
  assert.equal(observation.escrow.status, "present")
  assert.equal(observation.artifacts.status, "attested")
  assert.ok(observation.inventory.packages.every((pkg) => pkg.attestationSha256 !== null))
  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })
  assert.equal(plan.state, "CANDIDATE_ESCROWED")
  assert.equal(plan.nextTransition, "publish-npm-packages")
  assert.deepEqual(plan.conflicts, [])
})

test("production observation fails closed on duplicate marker-backed draft Releases", async () => {
  const escrow = attestedReleaseFixture()
  escrow.release.tag_name = "untagged-opaque"
  const duplicate = { ...escrow.release, id: escrow.release.id + 1 }
  let exactReads = 0
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [])
    },
    async listReleases() {
      return present("releases", [escrow.release, duplicate])
    },
    async getRelease() {
      exactReads += 1
      throw new Error("ambiguous drafts must fail before an exact Release read")
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.equal(exactReads, 0)
  assert.equal(observation.release.status, "ambiguous")
  assert.ok(diagnostics.some((entry) => entry.code === "RELEASE_IDENTITY_AMBIGUOUS"))
})

test("production observation rejects a retained attestation winner without its exact Actions run", async () => {
  const escrow = attestedReleaseFixture()
  const github = releaseFixtureReader(escrow, {
    async getActionsRunAttempt({ runId }) {
      assert.equal(runId, escrow.marker.attestationSet.workflowRunId)
      return present("actions-run-attempt", prepareRun({ id: 999 }))
    },
    async listActionsRunJobs({ runId }) {
      assert.equal(runId, escrow.marker.attestationSet.workflowRunId)
      return present("actions-run-jobs", [publisherJob({ startedAt: null })])
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
  })

  assert.equal(observation.release.status, "ambiguous")
  assert.ok(diagnostics.some((entry) => entry.code === "RELEASE_ATTESTATION_RUN_IDENTITY_MISMATCH"))
})

test("production observation keeps exact durable escrow after attestation run retention", async () => {
  const escrow = attestedReleaseFixture()
  const github = releaseFixtureReader(escrow, {
    async getActionsRunAttempt() {
      return envelope("AMBIGUOUS", "actions-run-attempt", 404, "NOT_FOUND")
    },
    async listActionsRunJobs() {
      return envelope("AMBIGUOUS", "actions-run-jobs", 404, "NOT_FOUND")
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.release.status, "draft")
  assert.equal(observation.artifacts.status, "attested")
  assert.equal(observation.escrow.status, "present")
})

test("production observation rejects self-consistent escrow and terminal bundles without cryptographic proof", async () => {
  for (const retained of [attestedReleaseFixture(), auditedReleaseFixture()]) {
    const github = githubReader({
      async listReleases() {
        return present("releases", [retained.release])
      },
      async getRelease({ releaseId }) {
        assert.equal(releaseId, retained.release.id)
        return present("release", retained.release)
      },
      async listReleaseAssets() {
        return present("release-assets", retained.assets)
      },
      async downloadReleaseAsset({ assetId }) {
        return binary("release-asset-download", retained.bytesById.get(Number(assetId)))
      },
    })

    const { observation, diagnostics } = await observeProductionCandidate({
      candidate: candidate(),
      inventory: inventory(),
      marker: MARKER,
      git: gitReader(),
      github,
      npm: npmReader(),
      attestations: attestationVerifier([], "INVALID"),
    })

    assert.equal(observation.release.status, "ambiguous")
    assert.ok(diagnostics.some((entry) => entry.code === "RELEASE_CONTENT_INVALID"))
    assert.equal(
      planRelease({ candidate: candidate(), observation, mode: "controller" }).disposition,
      "blocked",
    )
  }
})

test("production observation rejects 128 oversized audit assets before downloading any asset", async () => {
  const audited = auditedReleaseFixture()
  const oversized = Array.from({ length: 128 }, (_, index) => ({
    id: 10_000 + index,
    name: `audit-attempt-${10_000 + index}-1.json`,
    digest: `sha256:${String(index).padStart(64, "0")}`,
    size: 1024 * 1024 + 1,
  }))
  let downloads = 0
  const github = githubReader({
    async listReleases() {
      return present("releases", [audited.release])
    },
    async getRelease({ releaseId }) {
      assert.equal(releaseId, audited.release.id)
      return present("release", audited.release)
    },
    async listReleaseAssets() {
      return present("release-assets", [...audited.assets.slice(0, 45), ...oversized])
    },
    async downloadReleaseAsset() {
      downloads += 1
      throw new Error("oversized metadata must block before download")
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.equal(downloads, 0)
  assert.equal(observation.release.status, "ambiguous")
  assert.ok(diagnostics.some((entry) => entry.code === "RELEASE_ASSET_SIZE_LIMIT_EXCEEDED"))
})

test("production observation requires the canonical main Release target", async () => {
  const escrow = attestedReleaseFixture()
  const offTarget = {
    ...escrow,
    release: { ...escrow.release, target_commitish: "release-controller-temp" },
  }
  const github = releaseFixtureReader(offTarget)

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
  })

  assert.equal(observation.release.status, "ambiguous")
  assert.ok(diagnostics.some((entry) => entry.code === "RELEASE_IDENTITY_INVALID"))
})

test("production observation uses durable escrow after exact Actions retention expiry", async () => {
  const escrow = attestedReleaseFixture()
  const prepared = preparedArtifactFixture()
  const expired = { ...prepared.payloadMetadata, expired: true }
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [expired])
    },
    async downloadActionsArtifact() {
      throw new Error("expired Actions bytes must not be downloaded")
    },
    async listReleases() {
      return present("releases", [escrow.release])
    },
    async getRelease({ releaseId }) {
      assert.equal(releaseId, escrow.release.id)
      return present("release", escrow.release)
    },
    async listReleaseAssets() {
      return present("release-assets", escrow.assets)
    },
    async downloadReleaseAsset({ assetId }) {
      return binary("release-asset-download", escrow.bytesById.get(Number(assetId)))
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.artifacts.status, "attested")
  assert.equal(observation.escrow.status, "present")
  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })
  assert.equal(plan.state, "CANDIDATE_ESCROWED")
  assert.equal(plan.nextTransition, "publish-npm-packages")
  assert.deepEqual(plan.conflicts, [])

  const unrecoverable = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github: githubReader({
      async listActionsArtifacts() {
        return present("actions-artifacts", [expired])
      },
    }),
    npm: npmReader(),
  })
  assert.ok(
    unrecoverable.diagnostics.some((entry) => entry.code === "RELEASE_RECORD_HANDOFF_AMBIGUOUS"),
  )
  assert.equal(unrecoverable.observation.artifacts.status, "ambiguous")
  assert.equal(
    planRelease({
      candidate: candidate(),
      observation: unrecoverable.observation,
      mode: "controller",
    }).disposition,
    "blocked",
  )

  const malformed = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github: githubReader({
      async listActionsArtifacts() {
        return present("actions-artifacts", [{ ...expired, workflow_run: { id: 200 } }])
      },
    }),
    npm: npmReader(),
  })
  assert.ok(
    malformed.diagnostics.some((entry) => entry.code === "ACTIONS_ARTIFACT_METADATA_INVALID"),
  )
  assert.equal(malformed.observation.artifacts.status, "ambiguous")
})

test("production observation preserves the prepared-to-attested phase boundary without synthesizing an attestation digest", async () => {
  for (const retainedNames of [
    [],
    [packageEntry(CANONICAL_RELEASE_PACKAGE_ORDER[0]).filename],
    "all",
  ]) {
    const attaching = attachingReleaseFixture(retainedNames)
    const prepared = attaching.prepared
    const github = githubReader({
      async listActionsArtifacts() {
        return present("actions-artifacts", [prepared.payloadMetadata])
      },
      async getActionsRunAttempt() {
        return present("actions-run-attempt", prepareRun())
      },
      async listActionsRunArtifacts() {
        return present("actions-run-artifacts", [prepared.payloadMetadata, prepared.recordMetadata])
      },
      async downloadActionsArtifact({ artifactId }) {
        return binary(
          "actions-artifact-download",
          Number(artifactId) === prepared.payloadMetadata.id
            ? prepared.payloadArchive
            : prepared.recordArchive,
        )
      },
      async listReleases() {
        return present("releases", [attaching.release])
      },
      async getRelease({ releaseId }) {
        assert.equal(releaseId, attaching.release.id)
        return present("release", attaching.release)
      },
      async listReleaseAssets() {
        return present("release-assets", attaching.assets)
      },
      async downloadReleaseAsset({ assetId }) {
        return binary("release-asset-download", attaching.bytesById.get(Number(assetId)))
      },
    })

    const { observation, diagnostics } = await observeProductionCandidate({
      candidate: candidate(),
      inventory: inventory(),
      marker: MARKER,
      git: gitReader(),
      github,
      npm: npmReader(),
      attestations: attestationVerifier([]),
    })

    assert.deepEqual(diagnostics, [])
    assert.equal(observation.escrow.status, "absent")
    const plan = planRelease({
      candidate: candidate(),
      observation,
      mode: "controller",
    })
    assert.deepEqual(plan.conflicts, [])
    if (retainedNames === "all") {
      assert.equal(observation.artifacts.status, "attested")
      assert.ok(observation.inventory.packages.every((pkg) => pkg.attestationSha256 !== null))
      assert.equal(plan.state, "ARTIFACTS_ATTESTED")
      assert.equal(plan.nextTransition, "escrow-candidate")
    } else {
      assert.equal(observation.artifacts.status, "prepared")
      assert.ok(observation.inventory.packages.every((pkg) => pkg.attestationSha256 === null))
      assert.equal(plan.state, "ARTIFACTS_PREPARED")
      assert.equal(plan.nextTransition, "attest-artifacts")
    }
  }
})

test("production observation accepts npm presence only through exact tarball and official audit evidence", async () => {
  const escrow = attestedReleaseFixture()
  const verified = []
  let disposed = false
  const github = githubReader({
    async listReleases() {
      return present("releases", [escrow.release])
    },
    async getRelease({ releaseId }) {
      assert.equal(releaseId, escrow.release.id)
      return present("release", escrow.release)
    },
    async listReleaseAssets() {
      return present("release-assets", escrow.assets)
    },
    async downloadReleaseAsset({ assetId }) {
      return binary("release-asset-download", escrow.bytesById.get(Number(assetId)))
    },
  })
  const entries = new Map(escrow.manifest.packages.map((pkg) => [pkg.name, pkg]))
  const npm = npmReader({
    async observePackageVersion({ name, version }) {
      const entry = entries.get(name)
      return {
        status: "PRESENT",
        operation: "package-version",
        httpStatus: 200,
        code: null,
        package: {
          name,
          version,
          tarballUrl: npmTarballUrl(name, version),
          shasum: "1".repeat(40),
          integrity: entry.npmIntegrity,
          distTags: { latest: version },
          latest: version,
        },
      }
    },
    async downloadRegistryTarball({ tarballUrl }) {
      const entry = escrow.manifest.packages.find(
        (pkg) => tarballUrl === npmTarballUrl(pkg.name, pkg.version),
      )
      assert.ok(entry)
      return {
        status: "PRESENT",
        operation: "package-tarball",
        httpStatus: 200,
        code: null,
        tarball: {
          url: tarballUrl,
          size: entry.size,
          sha1: "1".repeat(40),
          sha256: entry.sha256,
          sha512: entry.sha512,
          contentBase64: packageBytes(entry.name).toString("base64"),
        },
      }
    },
  })

  const { observation, diagnostics, recovery } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm,
    attestations: attestationVerifier([]),
    npmAuditFactory: {
      async create() {
        return {
          async verifyPackage({ entry, candidate: identity }) {
            assert.equal(identity.commitSha, COMMIT_SHA)
            verified.push(entry.name)
            return {
              status: "verified",
              signature: {
                status: "valid",
                verifier: "npm-audit-signatures@11.17.0",
              },
              provenance: {
                predicateType: "https://slsa.dev/provenance/v1",
                workflow: ".github/workflows/release.yml",
                commitSha: COMMIT_SHA,
                repository: "https://github.com/cacheplane/dawnai",
                ref: `refs/tags/v${VERSION}`,
              },
            }
          },
          async dispose() {
            disposed = true
          },
        }
      },
    },
    includeRecovery: true,
  })

  assert.deepEqual(diagnostics, [])
  assert.deepEqual(verified.sort(), [...CANONICAL_RELEASE_PACKAGE_ORDER].sort())
  assert.equal(disposed, true)
  assert.ok(observation.registry.packages.every((pkg) => pkg.status === "present"))
  assert.ok(observation.registry.packages.every((pkg) => pkg.signature.status === "valid"))
  assert.equal(recovery.npmEvidence.status, "NPM_COMPLETE")
  assert.equal(recovery.npmEvidence.packages.length, CANONICAL_RELEASE_PACKAGE_ORDER.length)
  assert.equal(recovery.npmEvidence.manifestSha256, escrow.marker.manifestSha256)
  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })
  assert.equal(plan.state, "NPM_COMPLETE")
  assert.equal(plan.nextTransition, "reconcile-npm-evidence")
  assert.deepEqual(plan.conflicts, [])
})

test("production observation rejects a marker whose npm evidence digest does not match public npm", async () => {
  const escrow = attestedReleaseFixture()
  const marker = {
    ...escrow.marker,
    revision: 3,
    phase: "NPM_COMPLETE",
    npmEvidenceSha256: "f".repeat(64),
  }
  const fixture = {
    ...escrow,
    marker,
    release: {
      ...escrow.release,
      body: canonicalReleaseBody({ marker, manifest: null }),
    },
  }
  const npmFixture = publishedNpmFixture(escrow.manifest)

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github: releaseFixtureReader(fixture),
    npm: npmFixture.npm,
    npmAuditFactory: npmFixture.npmAuditFactory,
    attestations: attestationVerifier([]),
  })

  assert.equal(observation.release.status, "ambiguous")
  assert.ok(diagnostics.some((entry) => entry.code === "NPM_EVIDENCE_DIGEST_MISMATCH"))
})

test("production observation resumes a markerless partial smoke receipt set from NPM_COMPLETE", async () => {
  const fixture = npmCompletedReleaseFixture({ smokeReceiptCount: 2 })
  const npmFixture = publishedNpmFixture(fixture.manifest)

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github: releaseFixtureReader(fixture),
    npm: npmFixture.npm,
    npmAuditFactory: npmFixture.npmAuditFactory,
    attestations: attestationVerifier([]),
  })

  assert.deepEqual(diagnostics, [])
  assert.deepEqual(
    observation.smokes.map(({ name, status, workflowRunId, runAttempt }) => ({
      name,
      status,
      workflowRunId,
      runAttempt,
    })),
    REQUIRED_RELEASE_SMOKE_LANES.map((name) => ({
      name,
      status: "pending",
      workflowRunId: null,
      runAttempt: null,
    })),
  )
  const partialNames = new Set(fixture.markerlessSmokeAssets.map((asset) => asset.name))
  assert.ok(
    observation.release.assets
      .filter((asset) => partialNames.has(asset.name))
      .every((asset) => asset.status === "matching"),
  )
  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })
  assert.equal(plan.state, "RELEASE_DRAFT_COMPLETE")
  assert.equal(plan.nextTransition, "run-release-smokes")
  assert.deepEqual(plan.conflicts, [])
})

test("production observation verifies the exact durable five-lane receipt set for SMOKES_COMPLETE", async () => {
  const fixture = smokeCompletedReleaseFixture()
  const npmFixture = publishedNpmFixture(fixture.manifest)

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github: releaseFixtureReader(fixture),
    npm: npmFixture.npm,
    npmAuditFactory: npmFixture.npmAuditFactory,
    attestations: attestationVerifier([]),
  })

  assert.deepEqual(diagnostics, [])
  assert.deepEqual(
    observation.smokes,
    REQUIRED_RELEASE_SMOKE_LANES.map((name) => ({
      name,
      status: "passed",
      version: VERSION,
      commitSha: COMMIT_SHA,
      manifestSha256: fixture.marker.manifestSha256,
      workflowRunId: fixture.marker.smoke.workflowRunId,
      runAttempt: fixture.marker.smoke.runAttempt,
    })),
  )
  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })
  assert.equal(plan.state, "SMOKES_COMPLETE")
  assert.equal(plan.nextTransition, "dispatch-release-audit")
  assert.deepEqual(plan.conflicts, [])
})

test("production observation fails closed on marker-selected smoke receipt byte, digest, or identity drift", async () => {
  const cases = [
    [
      "bytes",
      (fixture) => {
        const asset = fixture.assets.find((entry) => entry.id === 3_000)
        const bytes = Buffer.from(fixture.bytesById.get(asset.id))
        bytes[0] ^= 1
        fixture.bytesById.set(asset.id, bytes)
      },
      "SMOKE_RECEIPT_UNREADABLE",
    ],
    [
      "digest",
      (fixture) => {
        const asset = fixture.assets.find((entry) => entry.id === 3_000)
        asset.digest = `sha256:${"f".repeat(64)}`
      },
      "SMOKE_RECEIPT_SET_MISMATCH",
    ],
    [
      "identity",
      (fixture) => {
        const asset = fixture.assets.find((entry) => entry.id === 3_000)
        const bytes = canonicalSmokeResultBytes({
          schemaVersion: 1,
          lane: "metadata",
          version: VERSION,
          commitSha: COMMIT_SHA,
          manifestSha256: fixture.marker.manifestSha256,
          workflowRunId: 401,
          runAttempt: 1,
          startedAt: "2026-08-25T08:00:00.000Z",
          finishedAt: "2026-08-25T08:01:00.000Z",
          checks: [
            {
              name: "published-artifacts",
              conclusion: "success",
              detail: "exact",
            },
          ],
          conclusion: "success",
        })
        const receiptSha256 = digest(bytes)
        const smoke = {
          ...fixture.marker.smoke,
          artifacts: fixture.marker.smoke.artifacts.map((entry, index) =>
            index === 0 ? { ...entry, receiptSha256 } : entry,
          ),
          receiptAssets: fixture.marker.smoke.receiptAssets.map((entry, index) =>
            index === 0 ? { ...entry, receiptSha256 } : entry,
          ),
        }
        fixture.marker = { ...fixture.marker, smoke }
        fixture.release.body = canonicalReleaseBody({
          marker: fixture.marker,
          manifest: null,
        })
        asset.digest = `sha256:${receiptSha256}`
        asset.size = bytes.byteLength
        fixture.bytesById.set(asset.id, bytes)
      },
      "SMOKE_RECEIPT_IDENTITY_MISMATCH",
    ],
  ]
  for (const [label, mutate, expectedCode] of cases) {
    const fixture = smokeCompletedReleaseFixture()
    mutate(fixture)
    const npmFixture = publishedNpmFixture(fixture.manifest)
    const { observation, diagnostics } = await observeProductionCandidate({
      candidate: candidate(),
      inventory: inventory(),
      marker: MARKER,
      git: gitReader(),
      github: releaseFixtureReader(fixture),
      npm: npmFixture.npm,
      npmAuditFactory: npmFixture.npmAuditFactory,
      attestations: attestationVerifier([]),
    })
    assert.equal(observation.release.status, "ambiguous", label)
    assert.ok(
      diagnostics.some(({ code }) => code === expectedCode),
      label,
    )
    const plan = planRelease({
      candidate: candidate(),
      observation,
      mode: "controller",
    })
    assert.equal(plan.nextTransition, null, label)
    assert.ok(plan.conflicts.length > 0, label)
  }
})

test("production observation rejects a marker-bound smoke namespace with an extra or missing receipt", async () => {
  for (const variant of ["extra", "missing"]) {
    const fixture = smokeCompletedReleaseFixture()
    if (variant === "missing") {
      fixture.assets = fixture.assets.filter((asset) => asset.id !== 3_000)
    } else {
      const bytes = canonicalSmokeResultBytes({
        schemaVersion: 1,
        lane: "metadata",
        version: VERSION,
        commitSha: COMMIT_SHA,
        manifestSha256: fixture.marker.manifestSha256,
        workflowRunId: 401,
        runAttempt: 1,
        startedAt: "2026-08-25T09:00:00.000Z",
        finishedAt: "2026-08-25T09:01:00.000Z",
        checks: [
          {
            name: "published-artifacts",
            conclusion: "success",
            detail: "exact",
          },
        ],
        conclusion: "success",
      })
      fixture.assets.push({
        id: 3_999,
        name: "smoke-result-metadata-401-1.json",
        digest: `sha256:${digest(bytes)}`,
        size: bytes.byteLength,
      })
      fixture.bytesById.set(3_999, bytes)
    }
    const npmFixture = publishedNpmFixture(fixture.manifest)
    const { observation, diagnostics } = await observeProductionCandidate({
      candidate: candidate(),
      inventory: inventory(),
      marker: MARKER,
      git: gitReader(),
      github: releaseFixtureReader(fixture),
      npm: npmFixture.npm,
      npmAuditFactory: npmFixture.npmAuditFactory,
      attestations: attestationVerifier([]),
    })
    assert.equal(observation.release.status, "ambiguous", variant)
    assert.ok(
      diagnostics.some(({ code }) => code === "SMOKE_RECEIPT_SET_MISMATCH"),
      variant,
    )
    const plan = planRelease({
      candidate: candidate(),
      observation,
      mode: "controller",
    })
    assert.equal(plan.nextTransition, null, variant)
    assert.ok(plan.conflicts.length > 0, variant)
  }
})

test("production observation binds terminal audit assets to the exact run, attempt, jobs, and immutable Release", async () => {
  const audited = auditedReleaseFixture()
  const npmFixture = publishedNpmFixture(audited.manifest)
  const github = githubReader({
    async listReleases() {
      return present("releases", [audited.release])
    },
    async getRelease({ releaseId }) {
      assert.equal(releaseId, audited.release.id)
      return present("release", audited.release)
    },
    async listReleaseAssets() {
      return present("release-assets", audited.assets)
    },
    async downloadReleaseAsset({ assetId }) {
      return binary("release-asset-download", audited.bytesById.get(Number(assetId)))
    },
    async getActionsRunAttempt({ runId, attempt }) {
      if (runId === audited.marker.attestationSet.workflowRunId) {
        return present("actions-run-attempt", {
          ...prepareRun({ id: runId }),
          status: "completed",
          conclusion: "success",
        })
      }
      assert.equal(runId, audited.auditResult.workflowRunId)
      assert.equal(attempt, audited.auditResult.runAttempt)
      return present("actions-run-attempt", audited.run)
    },
    async listActionsRunJobs({ runId }) {
      if (runId === audited.marker.attestationSet.workflowRunId) {
        return present("actions-run-jobs", [
          {
            id: 6_001,
            runAttempt: 1,
            name: "publish-npm",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-08-25T09:00:00.000Z",
            completedAt: "2026-08-25T09:10:00.000Z",
          },
        ])
      }
      assert.equal(runId, audited.auditResult.workflowRunId)
      return present("actions-run-jobs", [
        ...audited.jobs,
        {
          id: 7_003,
          runAttempt: 3,
          name: "verify",
          status: "in_progress",
          conclusion: null,
          startedAt: "2026-08-25T11:00:00.000Z",
          completedAt: null,
        },
      ])
    },
  })

  const { observation, diagnostics, recovery } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmFixture.npm,
    npmAuditFactory: npmFixture.npmAuditFactory,
    attestations: attestationVerifier([]),
    includeRecovery: true,
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.release.status, "published")
  assert.equal(observation.release.immutable, true)
  assert.ok(observation.release.assets.every((asset) => asset.status === "matching"))
  assert.deepEqual(observation.audit, {
    status: "success",
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: audited.marker.manifestSha256,
    workflowRunId: audited.auditResult.workflowRunId,
    runAttempt: audited.auditResult.runAttempt,
    conclusion: "success",
  })
  assert.deepEqual(recovery.auditResult, audited.auditResult)
  assert.deepEqual(recovery.auditDispatch, {
    workflow: ".github/workflows/published-artifact-verify.yml",
    workflowRunId: audited.auditResult.workflowRunId,
    runUrl: `https://api.github.com/repos/cacheplane/dawnai/actions/runs/${audited.auditResult.workflowRunId}`,
    htmlUrl: `https://github.com/cacheplane/dawnai/actions/runs/${audited.auditResult.workflowRunId}`,
  })
})

test("production observation rejects a noncanonical Release body or title outside the marker", async () => {
  const audited = auditedReleaseFixture()
  for (const release of [
    { ...audited.release, body: `${audited.release.body}tampered\n` },
    { ...audited.release, name: `Dawn release ${VERSION}` },
    { ...audited.release, prerelease: true },
  ]) {
    const github = githubReader({
      async listReleases() {
        return present("releases", [release])
      },
      async getRelease({ releaseId }) {
        assert.equal(releaseId, release.id)
        return present("release", release)
      },
    })
    const { observation, diagnostics } = await observeProductionCandidate({
      candidate: candidate(),
      inventory: inventory(),
      marker: MARKER,
      git: gitReader(),
      github,
      npm: npmReader(),
    })

    assert.equal(observation.release.status, "ambiguous")
    assert.ok(
      diagnostics.some((entry) =>
        ["RELEASE_BODY_NONCANONICAL", "RELEASE_IDENTITY_INVALID"].includes(entry.code),
      ),
    )
  }
})

test("production observation rejects terminal audit run and job snapshots that disagree", async () => {
  const audited = auditedReleaseFixture()
  const jobs = audited.jobs.map((job) =>
    job.runAttempt === audited.auditResult.runAttempt
      ? { ...job, status: "in_progress", conclusion: null, completedAt: null }
      : job,
  )
  const github = githubReader({
    async listReleases() {
      return present("releases", [audited.release])
    },
    async getRelease({ releaseId }) {
      assert.equal(releaseId, audited.release.id)
      return present("release", audited.release)
    },
    async listReleaseAssets() {
      return present("release-assets", audited.assets)
    },
    async downloadReleaseAsset({ assetId }) {
      return binary("release-asset-download", audited.bytesById.get(Number(assetId)))
    },
    async getActionsRunAttempt({ runId }) {
      if (runId === audited.marker.attestationSet.workflowRunId) {
        return envelope("AMBIGUOUS", "actions-run-attempt", 404, "NOT_FOUND")
      }
      return present("actions-run-attempt", audited.run)
    },
    async listActionsRunJobs({ runId }) {
      if (runId === audited.marker.attestationSet.workflowRunId) {
        return envelope("AMBIGUOUS", "actions-run-jobs", 404, "NOT_FOUND")
      }
      return present("actions-run-jobs", jobs)
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
  })

  assert.equal(observation.release.status, "ambiguous")
  assert.ok(
    diagnostics.some((entry) =>
      [
        "RELEASE_AUDIT_JOB_TERMINAL_MISMATCH",
        "RELEASE_AUDIT_VERIFY_JOB_TERMINAL_MISMATCH",
      ].includes(entry.code),
    ),
  )
})

test("production audit validation rejects an over-limit run attempt in a bounded worker", async () => {
  const result = await validateAuditInBoundedWorker({
    value: {
      id: 77,
      run_attempt: 1_000_000_000,
      head_sha: COMMIT_SHA,
      head_branch: `v${VERSION}`,
      path: ".github/workflows/published-artifact-verify.yml",
      status: "completed",
      conclusion: "success",
    },
    jobs: [
      {
        id: 1,
        runAttempt: 1,
        name: "audit",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-08-25T10:00:00.000Z",
        completedAt: "2026-08-25T10:01:00.000Z",
      },
    ],
    candidate: candidate(),
    marker: { audit: { workflowRunId: 77, runAttempt: null } },
  })

  assert.deepEqual(result, {
    status: "rejected",
    code: "RELEASE_AUDIT_RUN_IDENTITY_MISMATCH",
  })
})

test("production audit validation requires the canonical verify job to succeed", () => {
  const audited = auditedReleaseFixture()
  const jobs = audited.jobs.map((job) =>
    job.runAttempt === audited.auditResult.runAttempt ? { ...job, conclusion: "skipped" } : job,
  )
  jobs.push({
    id: 7_003,
    runAttempt: audited.auditResult.runAttempt,
    name: "noop",
    status: "completed",
    conclusion: "success",
    startedAt: "2026-08-25T10:00:00.000Z",
    completedAt: "2026-08-25T10:01:00.000Z",
  })

  assert.throws(
    () =>
      validateProductionAuditRun({
        value: audited.run,
        jobs,
        candidate: candidate(),
        marker: audited.marker,
      }),
    (error) => error?.code === "RELEASE_AUDIT_VERIFY_JOB_TERMINAL_MISMATCH",
  )
})

test("production audit validation requires workflow dispatch and exact status vocabularies", () => {
  const audited = auditedReleaseFixture()
  for (const value of [
    { ...audited.run, event: "push" },
    Object.fromEntries(Object.entries(audited.run).filter(([key]) => key !== "event")),
    { ...audited.run, status: "mystery", conclusion: null },
    { ...audited.run, conclusion: "mystery" },
  ]) {
    assert.throws(
      () =>
        validateProductionAuditRun({
          value,
          jobs: audited.jobs,
          candidate: candidate(),
          marker: audited.marker,
        }),
      (error) => error?.code === "RELEASE_AUDIT_RUN_IDENTITY_MISMATCH",
    )
  }
})

test("production audit validation accepts a terminal non-success retry attempt", () => {
  const audited = auditedReleaseFixture()
  const value = { ...audited.run, conclusion: "timed_out" }
  const jobs = audited.jobs.map((job) =>
    job.runAttempt === audited.auditResult.runAttempt ? { ...job, conclusion: "cancelled" } : job,
  )

  assert.deepEqual(
    validateProductionAuditRun({
      value,
      jobs,
      candidate: candidate(),
      marker: audited.marker,
    }),
    { status: "completed", conclusion: "timed_out", runAttempt: 2 },
  )
})

test("production observation maps allowlisted non-success audit conclusions to a retryable receipt", async () => {
  const retryable = retryableReleaseFixture()
  const npmFixture = publishedNpmFixture(retryable.manifest)
  const github = releaseFixtureReader(retryable, {
    async getActionsRunAttempt({ runId, attempt }) {
      if (Number(runId) === retryable.marker.attestationSet.workflowRunId) {
        assert.equal(attempt, retryable.marker.attestationSet.runAttempt)
        return present("actions-run-attempt", prepareRun({ id: runId }))
      }
      assert.equal(runId, retryable.auditResult.workflowRunId)
      assert.equal(attempt, retryable.auditResult.runAttempt)
      return present("actions-run-attempt", retryable.run)
    },
    async listActionsRunJobs({ runId }) {
      return present(
        "actions-run-jobs",
        Number(runId) === retryable.marker.attestationSet.workflowRunId
          ? [publisherJob({ startedAt: null })]
          : retryable.jobs,
      )
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmFixture.npm,
    npmAuditFactory: npmFixture.npmAuditFactory,
    attestations: attestationVerifier([]),
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.release.status, "draft")
  assert.deepEqual(observation.audit, {
    status: "failed",
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: retryable.marker.manifestSha256,
    workflowRunId: retryable.auditResult.workflowRunId,
    runAttempt: retryable.auditResult.runAttempt,
    conclusion: "failure",
  })
  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })
  assert.equal(plan.state, "AUDIT_RETRYABLE")
  assert.equal(plan.nextTransition, "dispatch-release-audit")
  assert.deepEqual(plan.conflicts, [])
})

test("production observation blocks a published Release whose terminal marker is incomplete or mutable", async () => {
  const escrow = attestedReleaseFixture()
  const unsafeRelease = { ...escrow.release, draft: false, immutable: false }
  const github = githubReader({
    async listReleases() {
      return present("releases", [unsafeRelease])
    },
    async getRelease({ releaseId }) {
      assert.equal(releaseId, unsafeRelease.id)
      return present("release", unsafeRelease)
    },
    async listReleaseAssets() {
      return present("release-assets", escrow.assets)
    },
    async downloadReleaseAsset({ assetId }) {
      return binary("release-asset-download", escrow.bytesById.get(Number(assetId)))
    },
  })

  const { observation } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
  })
  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })

  assert.equal(plan.disposition, "blocked")
  assert.ok(plan.conflicts.includes("github-release-published-without-audit"))
  assert.ok(plan.conflicts.includes("github-release-not-immutable"))
})

test("production observation recognizes a protected tagged-only abandonment from its canonical durable tombstone", async () => {
  const abandoned = abandonedReleaseFixture()
  const expired = {
    ...preparedArtifactFixture().payloadMetadata,
    expired: true,
  }
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [expired])
    },
    async listReleases() {
      return present("releases", [abandoned.release])
    },
    async getRelease({ releaseId }) {
      assert.equal(releaseId, abandoned.release.id)
      return present("release", abandoned.release)
    },
    async listReleaseAssets() {
      return present("release-assets", abandoned.assets)
    },
    async downloadReleaseAsset({ assetId }) {
      assert.equal(assetId, abandoned.assets[0].id)
      return binary("release-asset-download", abandoned.bytes)
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.release.status, "draft")
  assert.deepEqual(observation.abandonment, {
    requested: true,
    recorded: true,
    predecessor: "CANDIDATE_TAGGED",
  })
  assert.ok(
    observation.inventory.packages.every(
      (pkg) =>
        pkg.tarballSha256 === null && pkg.attestationSha256 === null && pkg.integrity === null,
    ),
  )
  assert.deepEqual(observation.release.assets, [
    { name: "abandonment.json", status: "matching", sha256: abandoned.sha256 },
  ])
  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })
  assert.equal(plan.state, "ABANDONED_PREPUBLICATION")
  assert.equal(plan.disposition, "noop")
  assert.deepEqual(plan.conflicts, [])
})

test("production observation retains a prepared predecessor after exact Actions payload expiry", async () => {
  const prepared = preparedArtifactFixture()
  const abandoned = preparedAbandonedReleaseFixture(prepared)
  const expired = { ...prepared.payloadMetadata, expired: true }
  const github = githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [expired])
    },
    async listReleases() {
      return present("releases", [abandoned.release])
    },
    async getRelease({ releaseId }) {
      assert.equal(releaseId, abandoned.release.id)
      return present("release", abandoned.release)
    },
    async listReleaseAssets() {
      return present("release-assets", abandoned.assets)
    },
    async downloadReleaseAsset({ assetId }) {
      assert.equal(assetId, abandoned.assets[0].id)
      return binary("release-asset-download", abandoned.bytes)
    },
  })

  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: gitReader(),
    github,
    npm: npmReader(),
  })

  assert.deepEqual(diagnostics, [])
  assert.equal(observation.artifacts.status, "absent")
  assert.equal(observation.release.marker.manifestSha256, prepared.record.manifestSha256)
  assert.equal(observation.release.marker.releaseRecordSha256, digest(prepared.recordBytes))
  assert.deepEqual(observation.abandonment, {
    requested: true,
    recorded: true,
    predecessor: "ARTIFACTS_PREPARED",
  })
  const plan = planRelease({
    candidate: candidate(),
    observation,
    mode: "controller",
  })
  assert.equal(plan.state, "ABANDONED_PREPUBLICATION")
  assert.equal(plan.disposition, "noop")
  assert.deepEqual(plan.conflicts, [])
})

test("production observation requires complete verified escrow for attested abandonment recovery", async () => {
  for (const retainedNames of [
    [],
    ["release-record.json", "manifest.json"],
    [packageEntry(CANONICAL_RELEASE_PACKAGE_ORDER[0]).filename],
    "all",
  ]) {
    const abandoned = strongAbandonedReleaseFixture(retainedNames)
    const expired = {
      ...preparedArtifactFixture().payloadMetadata,
      expired: true,
    }
    const github = githubReader({
      async listActionsArtifacts() {
        return present("actions-artifacts", [expired])
      },
      async downloadActionsArtifact() {
        throw new Error("expired Actions bytes must not be downloaded")
      },
      async listReleases() {
        return present("releases", [abandoned.release])
      },
      async getRelease({ releaseId }) {
        assert.equal(releaseId, abandoned.release.id)
        return present("release", abandoned.release)
      },
      async listReleaseAssets() {
        return present("release-assets", abandoned.assets)
      },
      async downloadReleaseAsset({ assetId }) {
        return binary("release-asset-download", abandoned.bytesById.get(Number(assetId)))
      },
    })

    const { observation, diagnostics } = await observeProductionCandidate({
      candidate: candidate(),
      inventory: inventory(),
      marker: MARKER,
      git: gitReader(),
      github,
      npm: npmReader(),
      attestations: attestationVerifier([]),
    })

    const plan = planRelease({
      candidate: candidate(),
      observation,
      mode: "controller",
    })
    const retainedLabel = retainedNames === "all" ? "all" : retainedNames.join(",")
    if (retainedNames === "all") {
      assert.deepEqual(diagnostics, [])
      assert.deepEqual(observation.abandonment, {
        requested: true,
        recorded: true,
        predecessor: "CANDIDATE_ESCROWED",
      })
      assert.ok(observation.release.assets.every((asset) => asset.status === "matching"))
      assert.equal(observation.artifacts.status, "attested")
      assert.ok(
        observation.inventory.packages.every(
          (pkg) =>
            pkg.tarballSha256 !== null && pkg.attestationSha256 !== null && pkg.integrity !== null,
        ),
      )
      assert.equal(plan.state, "ABANDONED_PREPUBLICATION", retainedLabel)
      assert.equal(plan.disposition, "noop", `${retainedLabel}: ${plan.conflicts.join(",")}`)
      assert.deepEqual(plan.conflicts, [], retainedLabel)
    } else {
      assert.equal(observation.release.status, "ambiguous", retainedLabel)
      assert.ok(
        diagnostics.some((entry) => entry.code === "ABANDONMENT_VERIFIABLE_BASE_INCOMPLETE"),
        retainedLabel,
      )
      assert.equal(plan.disposition, "blocked", retainedLabel)
    }
  }
})

test("observe CLI resolves the immutable candidate, runs the dry one-transition controller, and writes canonical outputs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-observe-cli-"))
  try {
    const eventPath = path.join(directory, "event.json")
    const reportPath = path.join(directory, "report.json")
    const outputPath = path.join(directory, "github-output")
    await Promise.all([
      writeFile(eventPath, `${JSON.stringify({ ref: "refs/heads/main", after: COMMIT_SHA })}\n`),
      writeFile(outputPath, "existing=value\n"),
    ])
    const refs = []
    const immutableInventory = {
      async read({ ref }) {
        refs.push(ref)
        const version = ref === PARENT_SHA ? "0.8.21" : VERSION
        return {
          status: "valid",
          packages: [...CANONICAL_RELEASE_PACKAGE_ORDER].sort().map((name) => ({ name, version })),
        }
      },
    }
    const git = {
      ...gitReader(),
      async listFirstParentHistory() {
        return [COMMIT_SHA]
      },
      async firstParent() {
        return PARENT_SHA
      },
      async isAncestor() {
        return true
      },
      async listTree() {
        return "scripts/release/controller-schema.json\n"
      },
      async showFile() {
        return `${JSON.stringify(MARKER)}\n`
      },
    }

    const result = await runReleaseCli(
      ["observe", "--event", eventPath, "--report", reportPath, "--github-output", outputPath],
      {
        cwd: directory,
        git,
        inventory: immutableInventory,
        githubReader: githubReader(),
        npm: npmReader(),
        attestations: attestationVerifier([]),
        controllerMarker: MARKER,
      },
    )

    assert.equal(result.candidate.version, VERSION)
    assert.equal(result.before.plan.state, "CANDIDATE_TAGGED")
    assert.equal(result.before.plan.nextTransition, "prepare-artifacts")
    assert.equal(result.transition.status, "dry-run")
    assert.deepEqual(result.diagnostics, [])
    assert.ok(refs.includes(COMMIT_SHA))
    assert.ok(refs.includes(PARENT_SHA))
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), result)
    assert.equal(
      await readFile(outputPath, "utf8"),
      [
        "existing=value",
        `candidate_version=${VERSION}`,
        `candidate_sha=${COMMIT_SHA}`,
        "state=CANDIDATE_TAGGED",
        "disposition=would-transition",
        "next_transition=prepare-artifacts",
        "",
      ].join("\n"),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("observe CLI identifies its exact current tag attempt before downstream jobs materialize", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-observe-current-run-"))
  try {
    const eventPath = path.join(directory, "event.json")
    const reportPath = path.join(directory, "report.json")
    const outputPath = path.join(directory, "github-output")
    await Promise.all([
      writeFile(
        eventPath,
        `${JSON.stringify({ inputs: { version: VERSION, commitSha: COMMIT_SHA } })}\n`,
      ),
      writeFile(outputPath, ""),
    ])
    const dependencies = cliCandidateDependencies(directory)
    const base = githubReader()
    dependencies.githubReader = {
      ...base,
      async listWorkflowRuns(input) {
        if (input.workflow === "ci.yml") return base.listWorkflowRuns(input)
        return present("workflow-runs", [
          {
            id: 40,
            name: "Release",
            path: ".github/workflows/release.yml",
            head_sha: COMMIT_SHA,
            head_branch: `v${VERSION}`,
            status: "in_progress",
            conclusion: null,
            run_attempt: 1,
          },
        ])
      },
      async listActionsRunJobs(input) {
        if (Number(input.runId) === 40) {
          return present("actions-run-jobs", [
            {
              id: 401,
              runAttempt: 1,
              name: "detect",
              status: "in_progress",
              conclusion: null,
              startedAt: "2026-08-31T15:44:39.000Z",
              completedAt: null,
            },
          ])
        }
        return base.listActionsRunJobs(input)
      },
    }
    dependencies.environment = {
      GITHUB_REF: `refs/tags/v${VERSION}`,
      GITHUB_SHA: COMMIT_SHA,
      GITHUB_RUN_ID: "40",
      GITHUB_RUN_ATTEMPT: "1",
    }

    const result = await runReleaseCli(
      ["observe", "--event", eventPath, "--report", reportPath, "--github-output", outputPath],
      dependencies,
    )

    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.before.plan.state, "CANDIDATE_TAGGED")
    assert.equal(result.before.plan.nextTransition, "prepare-artifacts")

    for (const environment of [
      {
        GITHUB_REF: `refs/tags/v${VERSION}`,
        GITHUB_SHA: COMMIT_SHA,
        GITHUB_RUN_ATTEMPT: "1",
      },
      {
        GITHUB_REF: `refs/tags/v${VERSION}`,
        GITHUB_SHA: COMMIT_SHA,
        GITHUB_RUN_ID: "not-a-run-id",
        GITHUB_RUN_ATTEMPT: "1",
      },
    ]) {
      dependencies.environment = environment
      await rm(reportPath, { force: true })
      const blocked = await runReleaseCli(
        ["observe", "--event", eventPath, "--report", reportPath, "--github-output", outputPath],
        dependencies,
      )
      assert.ok(blocked.diagnostics.some((entry) => entry.code === "PUBLISHER_JOB_HISTORY_INVALID"))
      assert.equal(blocked.before.plan.disposition, "blocked")
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("observe CLI waits within a fixed budget for the exact main CI before authorizing tagging", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-observe-cli-ci-wait-"))
  try {
    const eventPath = path.join(directory, "event.json")
    const reportPath = path.join(directory, "report.json")
    const outputPath = path.join(directory, "github-output")
    await Promise.all([
      writeFile(eventPath, `${JSON.stringify({ ref: "refs/heads/main", after: COMMIT_SHA })}\n`),
      writeFile(outputPath, ""),
    ])
    const dependencies = cliCandidateDependencies(directory)
    let checkReads = 0
    let workflowReads = 0
    const base = githubReader()
    dependencies.githubReader = {
      ...base,
      async getCommitCheckRuns() {
        checkReads += 1
        const terminal = checkReads > 1
        return present("commit-check-runs", [
          {
            id: 10,
            name: "validate",
            head_sha: COMMIT_SHA,
            status: terminal ? "completed" : "in_progress",
            conclusion: terminal ? "success" : null,
            check_suite: { id: 20 },
          },
        ])
      },
      async listWorkflowRuns({ workflow }) {
        if (workflow !== "ci.yml") return present("workflow-runs", [])
        workflowReads += 1
        const terminal = workflowReads > 1
        return present("workflow-runs", [
          {
            ...ciRuns()[0],
            status: terminal ? "completed" : "in_progress",
            conclusion: terminal ? "success" : null,
          },
        ])
      },
    }
    const delays = []
    dependencies.wait = async (milliseconds) => delays.push(milliseconds)

    const result = await runReleaseCli(
      ["observe", "--event", eventPath, "--report", reportPath, "--github-output", outputPath],
      dependencies,
    )

    assert.equal(result.before.plan.nextTransition, "prepare-artifacts")
    assert.deepEqual(delays, [10_000])
    assert.ok(checkReads >= 3, "CI is polled to success and then independently re-observed")
    assert.ok(workflowReads >= 3, "the exact workflow/check-suite correlation is re-observed")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("observe CLI reports an authorization failure as blocked ambiguity, never as absence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-observe-cli-auth-"))
  try {
    const eventPath = path.join(directory, "event.json")
    const reportPath = path.join(directory, "report.json")
    const outputPath = path.join(directory, "github-output")
    await Promise.all([
      writeFile(eventPath, `${JSON.stringify({ ref: "refs/heads/main", after: COMMIT_SHA })}\n`),
      writeFile(outputPath, ""),
    ])
    const dependencies = cliCandidateDependencies(directory)
    dependencies.githubReader = githubReader({
      async listTagRefs() {
        return envelope("AMBIGUOUS", "tag-refs", 403, "HTTP_403")
      },
    })
    const result = await runReleaseCli(
      ["observe", "--event", eventPath, "--report", reportPath, "--github-output", outputPath],
      dependencies,
    )

    assert.equal(result.before.plan.disposition, "blocked")
    assert.ok(result.before.plan.conflicts.includes("candidate-discovery-ambiguous"))
    assert.equal(result.transition.status, "blocked")
    assert.ok(
      result.diagnostics.some(
        (entry) => entry.code === "HTTP_403" && entry.classification === "conflict",
      ),
    )
    assert.match(await readFile(outputPath, "utf8"), /disposition=blocked/u)
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), result)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("observe CLI preserves throttling as a transient discovery diagnostic", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-observe-cli-throttle-"))
  try {
    const eventPath = path.join(directory, "event.json")
    const reportPath = path.join(directory, "report.json")
    const outputPath = path.join(directory, "github-output")
    await Promise.all([
      writeFile(eventPath, `${JSON.stringify({ ref: "refs/heads/main", after: COMMIT_SHA })}\n`),
      writeFile(outputPath, ""),
    ])
    const dependencies = cliCandidateDependencies(directory)
    dependencies.githubReader = githubReader({
      async listTagRefs() {
        return envelope("AMBIGUOUS", "tag-refs", 429, "HTTP_429")
      },
    })
    const result = await runReleaseCli(
      ["observe", "--event", eventPath, "--report", reportPath, "--github-output", outputPath],
      dependencies,
    )

    assert.equal(result.before.plan.disposition, "blocked")
    assert.ok(result.before.plan.conflicts.includes("candidate-discovery-ambiguous"))
    assert.equal(result.transition.status, "blocked")
    assert.ok(
      result.diagnostics.some(
        (entry) => entry.code === "HTTP_429" && entry.classification === "transient-error",
      ),
    )
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), result)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("observe CLI rejects every overlapping event, report, and GitHub output path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-observe-cli-paths-"))
  try {
    const eventPath = path.join(directory, "event.json")
    const reportPath = path.join(directory, "report.json")
    const outputPath = path.join(directory, "github-output")
    const eventBytes = `${JSON.stringify({ ref: "refs/heads/main", after: COMMIT_SHA })}\n`
    await writeFile(eventPath, eventBytes)

    for (const [event, report, output] of [
      [eventPath, reportPath, reportPath],
      [eventPath, eventPath, outputPath],
      [eventPath, reportPath, eventPath],
    ]) {
      await assert.rejects(
        runReleaseCli(
          ["observe", "--event", event, "--report", report, "--github-output", output],
          { cwd: directory },
        ),
        /pairwise distinct/u,
      )
    }
    assert.equal(await readFile(eventPath, "utf8"), eventBytes)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("observe CLI rejects case-folded and symlink-parent output aliases", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-observe-cli-aliases-"))
  try {
    const eventPath = path.join(directory, "event.json")
    await writeFile(eventPath, `${JSON.stringify({ ref: "refs/heads/main", after: COMMIT_SHA })}\n`)
    await assert.rejects(
      runReleaseCli(
        [
          "observe",
          "--event",
          eventPath,
          "--report",
          path.join(directory, "Report.json"),
          "--github-output",
          path.join(directory, "report.json"),
        ],
        { cwd: directory },
      ),
      /pairwise distinct/u,
    )

    const realParent = path.join(directory, "real")
    const aliasParent = path.join(directory, "alias")
    await mkdir(realParent)
    await symlink(realParent, aliasParent, process.platform === "win32" ? "junction" : "dir")
    await assert.rejects(
      runReleaseCli(
        [
          "observe",
          "--event",
          eventPath,
          "--report",
          path.join(realParent, "report.json"),
          "--github-output",
          path.join(aliasParent, "report.json"),
        ],
        { cwd: directory },
      ),
      /pairwise distinct/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function candidate() {
  return {
    version: VERSION,
    commitSha: COMMIT_SHA,
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  }
}

function selection() {
  return {
    candidate: candidate(),
    state: "CANDIDATE_VALIDATED",
    disposition: "selected",
    tag: null,
    conflicts: [],
  }
}

function noCandidateSelection() {
  return {
    candidate: null,
    state: "NO_CANDIDATE",
    disposition: "noop",
    tag: null,
    conflicts: [],
  }
}

function inventory() {
  return {
    status: "valid",
    packages: [...CANONICAL_RELEASE_PACKAGE_ORDER]
      .sort()
      .map((name) => ({ name, version: VERSION })),
  }
}

function rawInventory() {
  return {
    fixedGroups: [[...CANONICAL_RELEASE_PACKAGE_ORDER]],
    workspacePackages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => ({
      name,
      version: VERSION,
      path: `packages/${name.replaceAll("/", "-")}/package.json`,
    })),
  }
}

function inventoryReader() {
  return {
    async read() {
      return inventory()
    },
  }
}

function gitReader(overrides = {}) {
  return {
    async resolveTag() {
      return COMMIT_SHA
    },
    async listTree() {
      return ""
    },
    async showFile() {
      throw new Error("showFile must not be called when no terminal record exists")
    },
    ...overrides,
  }
}

function githubReader(overrides = {}) {
  const {
    getActionsRunAttempt: getActionsRunAttemptOverride,
    listActionsRunJobs: listActionsRunJobsOverride,
    ...remainingOverrides
  } = overrides
  return {
    async getCommitCheckRuns() {
      return present("commit-check-runs", [
        {
          id: 10,
          name: "validate",
          head_sha: COMMIT_SHA,
          status: "completed",
          conclusion: "success",
          check_suite: { id: 20 },
        },
      ])
    },
    async listWorkflowRuns({ workflow }) {
      return present("workflow-runs", workflow === "ci.yml" ? ciRuns() : [])
    },
    async getRef() {
      return present("ref", {
        ref: `refs/tags/v${VERSION}`,
        object: { type: "tag", sha: TAG_SHA },
      })
    },
    async listTagRefs() {
      return present("tag-refs", [
        { ref: `refs/tags/v${VERSION}`, object: { type: "tag", sha: TAG_SHA } },
      ])
    },
    async getGitTag() {
      return present("git-tag", {
        tag: `v${VERSION}`,
        object: { type: "commit", sha: COMMIT_SHA },
      })
    },
    async listReleases() {
      return present("releases", [])
    },
    async getReleaseByTag() {
      throw new Error("an absent Release must be established by exact enumeration")
    },
    async getRelease() {
      throw new Error("an absent Release must be established by exact enumeration")
    },
    async listReleaseAssets() {
      throw new Error("an absent Release has no assets")
    },
    async downloadReleaseAsset() {
      throw new Error("an absent Release has no downloadable assets")
    },
    async listActionsArtifacts() {
      return present("actions-artifacts", [])
    },
    async listActionsRunArtifacts() {
      throw new Error("no Actions run artifacts should be listed without a payload")
    },
    async downloadActionsArtifact() {
      throw new Error("no Actions artifact should be downloaded without a payload")
    },
    async getActionsRun() {
      throw new Error("no terminal audit run should be read without an audit marker")
    },
    async getActionsRunAttempt(input) {
      if (Number(input.runId) === 30 && input.attempt === 1) {
        return present("actions-run-attempt", ciRuns()[0])
      }
      if (getActionsRunAttemptOverride !== undefined) {
        return await getActionsRunAttemptOverride(input)
      }
      if (Number(input.runId) === 200 && input.attempt === 1) {
        return present("actions-run-attempt", prepareRun())
      }
      throw new Error("no exact Actions run attempt should be read without persisted identity")
    },
    async listActionsRunJobs(input) {
      if (Number(input.runId) === 30) {
        return present("actions-run-jobs", [
          {
            id: 301,
            runAttempt: 1,
            name: "validate",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-08-24T00:00:00.000Z",
            completedAt: "2026-08-24T00:01:00.000Z",
          },
        ])
      }
      if (listActionsRunJobsOverride !== undefined) {
        return await listActionsRunJobsOverride(input)
      }
      if (Number(input.runId) === 200) {
        return present("actions-run-jobs", [publisherJob({ startedAt: null })])
      }
      throw new Error("no terminal audit jobs should be read without an audit marker")
    },
    async getAttestations() {
      return present("attestations", [])
    },
    async downloadAttestationBundle() {
      throw new Error("no attestation bundle should be downloaded without attestation metadata")
    },
    ...remainingOverrides,
  }
}

function releaseFixtureReader(fixture, overrides = {}) {
  return githubReader({
    async listActionsArtifacts() {
      return present("actions-artifacts", [])
    },
    async listReleases() {
      return present("releases", [fixture.release])
    },
    async getRelease({ releaseId }) {
      assert.equal(releaseId, fixture.release.id)
      return present("release", fixture.release)
    },
    async listReleaseAssets() {
      return present("release-assets", fixture.assets)
    },
    async downloadReleaseAsset({ assetId }) {
      const bytes = fixture.bytesById.get(Number(assetId))
      assert.ok(bytes)
      return binary("release-asset-download", bytes)
    },
    ...overrides,
  })
}

function ciRuns() {
  return [
    {
      id: 30,
      name: "CI",
      path: ".github/workflows/ci.yml",
      head_sha: COMMIT_SHA,
      head_branch: "main",
      event: "push",
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
      check_suite_id: 20,
    },
  ]
}

function publisherJob({ startedAt }) {
  return {
    id: 401,
    runAttempt: 1,
    name: "publish-npm",
    status: startedAt === null ? "queued" : "in_progress",
    conclusion: null,
    startedAt,
    completedAt: null,
  }
}

async function validateAuditInBoundedWorker(input) {
  const observeModule = new URL("../observe.mjs", import.meta.url).href
  const worker = new Worker(
    `
      const { parentPort } = require("node:worker_threads")
      import(${JSON.stringify(observeModule)}).then(({ validateProductionAuditRun }) => {
        try {
          validateProductionAuditRun(${JSON.stringify(input)})
          parentPort.postMessage({ status: "accepted", code: null })
        } catch (error) {
          parentPort.postMessage({
            status: "rejected",
            code: typeof error?.code === "string" ? error.code : "UNKNOWN",
          })
        }
      }).catch((error) => {
        parentPort.postMessage({ status: "import-error", code: error?.code ?? "UNKNOWN" })
      })
    `,
    {
      eval: true,
      resourceLimits: {
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
      },
    },
  )
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      void worker.terminate()
      callback()
    }
    const timeout = setTimeout(() => {
      finish(() => reject(new Error("audit validation worker exceeded its time bound")))
    }, 3_000)
    worker.once("message", (message) => finish(() => resolve(message)))
    worker.once("error", (error) => finish(() => reject(error)))
    worker.once("exit", (code) => {
      if (code !== 0) {
        finish(() => reject(new Error(`audit validation worker exited with code ${code}`)))
      }
    })
  })
}

function prepareRun({ id = 200 } = {}) {
  return {
    id,
    run_attempt: 1,
    head_sha: COMMIT_SHA,
    head_branch: `v${VERSION}`,
    path: ".github/workflows/release.yml",
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null,
  }
}

function npmReader(overrides = {}) {
  return {
    async observePackageVersion() {
      return envelope("ABSENT", "package-version", 404, "E404")
    },
    async downloadRegistryTarball() {
      throw new Error("an absent package must not download a tarball")
    },
    ...overrides,
  }
}

function publishedNpmFixture(manifest) {
  const entries = new Map(manifest.packages.map((pkg) => [pkg.name, pkg]))
  return {
    npm: npmReader({
      async observePackageVersion({ name, version }) {
        const entry = entries.get(name)
        return {
          status: "PRESENT",
          operation: "package-version",
          httpStatus: 200,
          code: null,
          package: {
            name,
            version,
            tarballUrl: npmTarballUrl(name, version),
            shasum: "1".repeat(40),
            integrity: entry.npmIntegrity,
            distTags: { latest: version },
            latest: version,
          },
        }
      },
      async downloadRegistryTarball({ tarballUrl }) {
        const entry = manifest.packages.find(
          (pkg) => tarballUrl === npmTarballUrl(pkg.name, pkg.version),
        )
        assert.ok(entry)
        return {
          status: "PRESENT",
          operation: "package-tarball",
          httpStatus: 200,
          code: null,
          tarball: {
            url: tarballUrl,
            size: entry.size,
            sha1: "1".repeat(40),
            sha256: entry.sha256,
            sha512: entry.sha512,
            contentBase64: packageBytes(entry.name).toString("base64"),
          },
        }
      },
    }),
    npmAuditFactory: {
      async create() {
        return {
          async verifyPackage() {
            return {
              status: "verified",
              signature: {
                status: "valid",
                verifier: "npm-audit-signatures@11.17.0",
              },
              provenance: {
                predicateType: "https://slsa.dev/provenance/v1",
                workflow: ".github/workflows/release.yml",
                commitSha: COMMIT_SHA,
                repository: "https://github.com/cacheplane/dawnai",
                ref: `refs/tags/v${VERSION}`,
              },
            }
          },
          async dispose() {},
        }
      },
    },
  }
}

function completeNpmEvidenceFixture(manifest) {
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: digest(canonicalManifestBytes(manifest)),
    complete: true,
    status: "NPM_COMPLETE",
    packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => {
      const entry = manifest.packages.find((pkg) => pkg.name === name)
      return {
        name,
        version: VERSION,
        status: "present",
        size: entry.size,
        tarballSha256: entry.sha256,
        tarballSha512: entry.sha512,
        integrity: entry.npmIntegrity,
        latest: { status: "present", version: VERSION },
        signature: {
          status: "valid",
          verifier: "npm-audit-signatures@11.17.0",
        },
        provenance: {
          predicateType: "https://slsa.dev/provenance/v1",
          workflow: ".github/workflows/release.yml",
          commitSha: COMMIT_SHA,
          repository: "https://github.com/cacheplane/dawnai",
          ref: `refs/tags/v${VERSION}`,
        },
      }
    }),
  }
}

function present(operation, value) {
  return { status: "PRESENT", operation, httpStatus: 200, code: null, value }
}

function envelope(status, operation, httpStatus, code) {
  return { status, operation, httpStatus, code }
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

function preparedArtifactFixture({
  artifactId = 100,
  prepareRunId = 200,
  recordId = 101,
  ci = { workflow: "CI", runId: 30, runAttempt: 1 },
} = {}) {
  const manifest = {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    ci,
    artifact: {
      name: `release-v${VERSION}-${COMMIT_SHA.slice(0, 12)}`,
      prepareRunId,
      prepareRunAttempt: 1,
    },
    packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
    packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => packageEntry(name)),
  }
  const manifestBytes = canonicalManifestBytes(manifest)
  const payloadArchive = storedZip([
    { name: "manifest.json", bytes: manifestBytes },
    ...manifest.packages.map((pkg) => ({
      name: pkg.filename,
      bytes: packageBytes(pkg.name),
    })),
  ])
  const payloadDigest = `sha256:${digest(payloadArchive)}`
  const record = JSON.parse(
    canonicalReleaseRecordBytes({
      schemaVersion: 1,
      version: VERSION,
      commitSha: COMMIT_SHA,
      tag: `v${VERSION}`,
      manifestSha256: digest(manifestBytes),
      actionsArtifact: {
        id: String(artifactId),
        name: manifest.artifact.name,
        serviceDigest: payloadDigest,
        prepareRunId: String(prepareRunId),
        prepareRunAttempt: 1,
      },
    }),
  )
  const recordBytes = canonicalReleaseRecordBytes(record)
  const recordArchive = storedZip([{ name: "release-record.json", bytes: recordBytes }])
  return {
    manifest,
    manifestBytes,
    record,
    recordBytes,
    recordSha256: digest(recordBytes),
    payloadArchive,
    recordArchive,
    payloadMetadata: {
      id: artifactId,
      name: manifest.artifact.name,
      digest: payloadDigest,
      expired: false,
      workflow_run: { id: prepareRunId, head_sha: COMMIT_SHA },
    },
    recordMetadata: {
      id: recordId,
      name: `release-record-v${VERSION}-${COMMIT_SHA.slice(0, 12)}`,
      digest: `sha256:${digest(recordArchive)}`,
      expired: false,
      workflow_run: { id: prepareRunId, head_sha: COMMIT_SHA },
    },
  }
}

function productionAttestationBundle(
  prepared,
  { workflowRunId = prepared.manifest.artifact.prepareRunId, runAttempt = 1 } = {},
) {
  const ref = `refs/tags/v${VERSION}`
  const repository = "https://github.com/cacheplane/dawnai"
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: "manifest.json",
        digest: { sha256: prepared.record.manifestSha256 },
      },
      ...prepared.manifest.packages.map((pkg) => ({
        name: pkg.filename,
        digest: { sha256: pkg.sha256 },
      })),
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: { ref, repository, path: ".github/workflows/release.yml" },
        },
        internalParameters: { github: { event_name: "workflow_dispatch" } },
        resolvedDependencies: [
          {
            uri: `git+${repository}@${ref}`,
            digest: { gitCommit: COMMIT_SHA },
          },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: {
          invocationId: `https://github.com/cacheplane/dawnai/actions/runs/${workflowRunId}/attempts/${runAttempt}`,
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
        payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
        payloadType: "application/vnd.in-toto+json",
        signatures: [{ sig: "verified-by-gh", keyid: "" }],
      },
    })}\n`,
    "utf8",
  )
}

function attestationVerifier(calls, status = "VERIFIED") {
  return {
    async verify(input) {
      calls.push(input)
      return { status, subjects: status === "VERIFIED" ? input.subjects : [] }
    },
  }
}

function attestedReleaseFixture({ ci } = {}) {
  const prepared = preparedArtifactFixture({
    ...(ci === undefined ? {} : { ci }),
  })
  const bundleBytes = new Map()
  const bundle = productionAttestationBundle(prepared)
  const subjects = [
    {
      subjectName: "manifest.json",
      subjectSha256: prepared.record.manifestSha256,
      bundleName: "manifest.json.intoto.jsonl",
    },
    ...prepared.manifest.packages.map((pkg) => ({
      subjectName: pkg.filename,
      subjectSha256: pkg.sha256,
      bundleName: `${pkg.filename}.intoto.jsonl`,
    })),
  ].map((subject) => {
    bundleBytes.set(subject.bundleName, bundle)
    return { ...subject, bundleSha256: digest(bundle) }
  })
  const baseEntries = [
    { name: "release-record.json", sha256: digest(prepared.recordBytes) },
    { name: "manifest.json", sha256: digest(prepared.manifestBytes) },
    ...subjects.slice(1).map((subject) => ({
      name: subject.subjectName,
      sha256: subject.subjectSha256,
    })),
    ...subjects.map((subject) => ({
      name: subject.bundleName,
      sha256: subject.bundleSha256,
    })),
  ]
  const marker = {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 2,
    phase: "ESCROWED",
    version: VERSION,
    commitSha: COMMIT_SHA,
    tag: `v${VERSION}`,
    manifestSha256: prepared.record.manifestSha256,
    releaseRecordSha256: digest(prepared.recordBytes),
    baseAssetSetSha256: digest(Buffer.from(`${JSON.stringify(baseEntries)}\n`, "utf8")),
    attestationSet: {
      repository: "cacheplane/dawnai",
      workflow: ".github/workflows/release.yml",
      sourceRef: `refs/tags/v${VERSION}`,
      commitSha: COMMIT_SHA,
      workflowRunId: 200,
      runAttempt: 1,
      subjects,
    },
    npmEvidenceSha256: null,
    smoke: null,
    audit: null,
    abandonmentSha256: null,
  }
  const body = canonicalReleaseBody({ marker, manifest: prepared.manifest })
  const bytesByName = new Map([
    ["release-record.json", prepared.recordBytes],
    ["manifest.json", prepared.manifestBytes],
    ...prepared.manifest.packages.map((pkg) => [pkg.filename, packageBytes(pkg.name)]),
    ...bundleBytes,
  ])
  const bytesById = new Map()
  const assets = baseEntries.map((entry, index) => {
    const id = 1_000 + index
    bytesById.set(id, bytesByName.get(entry.name))
    return {
      id,
      name: entry.name,
      digest: `sha256:${entry.sha256}`,
      size: bytesByName.get(entry.name).length,
    }
  })
  return {
    manifest: prepared.manifest,
    marker,
    assets,
    bytesById,
    release: {
      id: 900,
      name: `Dawn v${VERSION}`,
      tag_name: `v${VERSION}`,
      target_commitish: "main",
      draft: true,
      immutable: false,
      prerelease: false,
      body,
    },
  }
}

function attachingReleaseFixture(retainedNames = ["release-record.json", "manifest.json"]) {
  const escrow = attestedReleaseFixture()
  const prepared = preparedArtifactFixture()
  const marker = {
    ...escrow.marker,
    revision: 1,
    phase: "ATTACHING",
    baseAssetSetSha256: null,
    attestationSet: null,
  }
  const retained =
    retainedNames === "all"
      ? escrow.assets
      : escrow.assets.filter((asset) => new Set(retainedNames).has(asset.name))
  assert.equal(retained.length, retainedNames === "all" ? 45 : retainedNames.length)
  return {
    ...escrow,
    prepared,
    marker,
    assets: retained,
    release: {
      ...escrow.release,
      body: canonicalReleaseBody({ marker, manifest: escrow.manifest }),
    },
  }
}

function npmCompletedReleaseFixture({ smokeReceiptCount = 0 } = {}) {
  const escrow = attestedReleaseFixture()
  const npmEvidence = completeNpmEvidenceFixture(escrow.manifest)
  const npmEvidenceSha256 = digest(
    canonicalNpmEvidenceBytes(npmEvidence, {
      candidate: candidate(),
      manifest: escrow.manifest,
      manifestSha256: escrow.marker.manifestSha256,
    }),
  )
  const smoke = durableSmokeFixture(escrow.marker.manifestSha256)
  const markerlessSmokeAssets = smoke.assets.slice(0, smokeReceiptCount)
  const marker = {
    ...escrow.marker,
    revision: 3,
    phase: "NPM_COMPLETE",
    npmEvidenceSha256,
  }
  const bytesById = new Map(escrow.bytesById)
  for (const asset of markerlessSmokeAssets) {
    bytesById.set(asset.id, smoke.bytesById.get(asset.id))
  }
  return {
    ...escrow,
    marker,
    markerlessSmokeAssets,
    assets: [...escrow.assets, ...markerlessSmokeAssets],
    bytesById,
    release: {
      ...escrow.release,
      body: canonicalReleaseBody({ marker, manifest: null }),
    },
  }
}

function smokeCompletedReleaseFixture() {
  const escrow = attestedReleaseFixture()
  const npmEvidence = completeNpmEvidenceFixture(escrow.manifest)
  const npmEvidenceSha256 = digest(
    canonicalNpmEvidenceBytes(npmEvidence, {
      candidate: candidate(),
      manifest: escrow.manifest,
      manifestSha256: escrow.marker.manifestSha256,
    }),
  )
  const smoke = durableSmokeFixture(escrow.marker.manifestSha256)
  const marker = {
    ...escrow.marker,
    revision: 4,
    phase: "SMOKES_COMPLETE",
    npmEvidenceSha256,
    smoke: smoke.descriptor,
  }
  const bytesById = new Map(escrow.bytesById)
  for (const asset of smoke.assets) bytesById.set(asset.id, smoke.bytesById.get(asset.id))
  return {
    ...escrow,
    marker,
    assets: [...escrow.assets, ...smoke.assets],
    bytesById,
    release: {
      ...escrow.release,
      body: canonicalReleaseBody({ marker, manifest: null }),
    },
  }
}

function durableSmokeFixture(manifestSha256) {
  const workflowRunId = 400
  const runAttempt = 1
  const receiptBytes = REQUIRED_RELEASE_SMOKE_LANES.map((lane) =>
    canonicalSmokeResultBytes({
      schemaVersion: 1,
      lane,
      version: VERSION,
      commitSha: COMMIT_SHA,
      manifestSha256,
      workflowRunId,
      runAttempt,
      startedAt: "2026-08-25T08:00:00.000Z",
      finishedAt: "2026-08-25T08:01:00.000Z",
      checks: [{ name: "published-artifacts", conclusion: "success", detail: "exact" }],
      conclusion: "success",
    }),
  )
  const receipts = REQUIRED_RELEASE_SMOKE_LANES.map((lane, index) => ({
    lane,
    workflowRunId,
    runAttempt,
    releaseAssetId: 3_000 + index,
    releaseAssetName: `smoke-result-${lane}-${workflowRunId}-${runAttempt}.json`,
    receiptSha256: digest(receiptBytes[index]),
  }))
  const descriptor = {
    workflow: ".github/workflows/release.yml",
    workflowRunId,
    runAttempt,
    requiredLanes: [...REQUIRED_RELEASE_SMOKE_LANES],
    artifacts: receipts.map((receipt, index) => ({
      lane: receipt.lane,
      actionsArtifactId: String(4_000 + index),
      actionsArtifactName: `smoke-result-${receipt.lane}-${workflowRunId}-${runAttempt}`,
      actionsArtifactUrl: `https://github.com/cacheplane/dawnai/actions/runs/${workflowRunId}/artifacts/${4_000 + index}`,
      actionsArtifactServiceDigest: `sha256:${"8".repeat(64)}`,
      releaseAssetId: receipt.releaseAssetId,
      releaseAssetName: receipt.releaseAssetName,
      receiptSha256: receipt.receiptSha256,
    })),
    receiptAssets: receipts,
    aggregateSha256: digest(
      canonicalAggregateSmokeResultBytes(
        aggregateSmokeResults(receiptBytes, {
          version: VERSION,
          commitSha: COMMIT_SHA,
          manifestSha256,
          workflowRunId,
          runAttempt,
        }),
      ),
    ),
  }
  const bytesById = new Map()
  const assets = receipts.map((receipt, index) => {
    const bytes = receiptBytes[index]
    bytesById.set(receipt.releaseAssetId, bytes)
    return {
      id: receipt.releaseAssetId,
      name: receipt.releaseAssetName,
      digest: `sha256:${receipt.receiptSha256}`,
      size: bytes.byteLength,
    }
  })
  return { descriptor, assets, bytesById }
}

function auditedReleaseFixture() {
  const escrow = smokeCompletedReleaseFixture()
  const npmEvidence = completeNpmEvidenceFixture(escrow.manifest)
  const npmEvidenceSha256 = digest(
    canonicalNpmEvidenceBytes(npmEvidence, {
      candidate: candidate(),
      manifest: escrow.manifest,
      manifestSha256: escrow.marker.manifestSha256,
    }),
  )
  const auditResult = {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: escrow.marker.manifestSha256,
    workflowRunId: 700,
    runAttempt: 2,
    startedAt: "2026-08-25T10:00:00.000Z",
    finishedAt: "2026-08-25T10:01:00.000Z",
    conclusion: "success",
    checks: [{ name: "published-artifacts", conclusion: "success", detail: "exact" }],
  }
  const auditBytes = canonicalAuditResultBytes(auditResult)
  const auditSha256 = digest(auditBytes)
  const marker = {
    ...escrow.marker,
    revision: 7,
    phase: "AUDIT_VERIFIED",
    npmEvidenceSha256,
    audit: {
      workflow: ".github/workflows/published-artifact-verify.yml",
      workflowRunId: auditResult.workflowRunId,
      runUrl: `https://api.github.com/repos/cacheplane/dawnai/actions/runs/${auditResult.workflowRunId}`,
      htmlUrl: `https://github.com/cacheplane/dawnai/actions/runs/${auditResult.workflowRunId}`,
      runAttempt: auditResult.runAttempt,
      attemptAssetName: `audit-attempt-${auditResult.workflowRunId}-${auditResult.runAttempt}.json`,
      attemptSha256: auditSha256,
      canonicalSha256: auditSha256,
      conclusion: "success",
    },
  }
  const bytesById = new Map(escrow.bytesById)
  const terminal = [marker.audit.attemptAssetName, "audit-result.json"].map((name, index) => {
    const id = 2_000 + index
    bytesById.set(id, auditBytes)
    return {
      id,
      name,
      digest: `sha256:${auditSha256}`,
      size: auditBytes.length,
    }
  })
  return {
    ...escrow,
    marker,
    auditResult,
    assets: [...escrow.assets, ...terminal],
    bytesById,
    release: {
      ...escrow.release,
      draft: false,
      immutable: true,
      body: canonicalReleaseBody({ marker, manifest: null }),
    },
    run: {
      id: auditResult.workflowRunId,
      run_attempt: auditResult.runAttempt,
      head_sha: COMMIT_SHA,
      head_branch: `v${VERSION}`,
      event: "workflow_dispatch",
      path: ".github/workflows/published-artifact-verify.yml",
      status: "completed",
      conclusion: "success",
    },
    jobs: [
      {
        id: 7_001,
        runAttempt: 1,
        name: "verify",
        status: "completed",
        conclusion: "failure",
        startedAt: "2026-08-25T09:00:00.000Z",
        completedAt: "2026-08-25T09:01:00.000Z",
      },
      {
        id: 7_002,
        runAttempt: 2,
        name: "verify",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-08-25T10:00:00.000Z",
        completedAt: "2026-08-25T10:01:00.000Z",
      },
    ],
  }
}

function retryableReleaseFixture() {
  const audited = auditedReleaseFixture()
  const auditResult = {
    ...audited.auditResult,
    conclusion: "failure",
    checks: [
      {
        name: "published-artifacts",
        conclusion: "failure",
        detail: "timed out",
      },
    ],
  }
  const auditBytes = canonicalAuditResultBytes(auditResult)
  const auditSha256 = digest(auditBytes)
  const marker = {
    ...audited.marker,
    revision: 6,
    phase: "AUDIT_RETRYABLE",
    audit: {
      ...audited.marker.audit,
      attemptSha256: auditSha256,
      canonicalSha256: null,
      conclusion: "failure",
    },
  }
  const bytesById = new Map(audited.bytesById)
  bytesById.set(2_000, auditBytes)
  return {
    ...audited,
    marker,
    auditResult,
    assets: [
      ...audited.assets.filter(
        (asset) =>
          asset.name !== audited.marker.audit.attemptAssetName &&
          asset.name !== "audit-result.json",
      ),
      {
        id: 2_000,
        name: marker.audit.attemptAssetName,
        digest: `sha256:${auditSha256}`,
        size: auditBytes.length,
      },
    ],
    bytesById,
    release: {
      ...audited.release,
      draft: true,
      immutable: false,
      body: canonicalReleaseBody({ marker, manifest: null }),
    },
    run: { ...audited.run, conclusion: "timed_out" },
    jobs: audited.jobs.map((job) =>
      job.runAttempt === auditResult.runAttempt ? { ...job, conclusion: "cancelled" } : job,
    ),
  }
}

function abandonedReleaseFixture() {
  const packageNames = [...CANONICAL_RELEASE_PACKAGE_ORDER].sort()
  const packages = packageNames.map((name) => ({
    name,
    version: VERSION,
    status: "ABSENT",
    httpStatus: 404,
    code: "E404",
  }))
  const tombstone = {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    tag: `v${VERSION}`,
    predecessor: {
      state: "CANDIDATE_TAGGED",
      releaseStatus: "absent",
      releaseId: null,
      bodySha256: null,
      marker: null,
      artifact: {
        manifestSha256: null,
        releaseRecordSha256: null,
        baseAssetSetSha256: null,
        attestationSet: null,
      },
    },
    reason: "approved prepublication abandonment",
    actor: "release-owner",
    actorId: 87,
    recordedAt: "2026-08-25T10:04:00.000Z",
    approval: {
      environment: "release-abandonment",
      environmentId: 88,
      reviewerId: 89,
      reviewer: "release-reviewer",
      state: "approved",
      observedAt: "2026-08-25T10:00:00.000Z",
      workflowRunId: 101,
      runAttempt: 1,
    },
    actionsHistory: {
      workflowRunId: 101,
      runAttempt: 1,
      observedAt: "2026-08-25T10:03:30.000Z",
      publishJobStarted: false,
      registryMutationStarted: false,
    },
    observations: [
      {
        workflowRunId: 101,
        runAttempt: 1,
        observedAt: "2026-08-25T10:01:00.000Z",
        packages,
      },
      {
        workflowRunId: 101,
        runAttempt: 1,
        observedAt: "2026-08-25T10:03:00.000Z",
        packages,
      },
    ],
  }
  const bytes = canonicalAbandonmentBytes(tombstone)
  const sha256 = digest(bytes)
  const marker = abandonmentReleaseMarker({
    candidate: candidate(),
    artifact: {
      manifestSha256: null,
      releaseRecordSha256: null,
      baseAssetSetSha256: null,
      attestationSet: null,
    },
    abandonmentSha256: sha256,
  })
  return {
    marker,
    tombstone,
    bytes,
    sha256,
    assets: [
      {
        id: 3_000,
        name: "abandonment.json",
        digest: `sha256:${sha256}`,
        size: bytes.length,
      },
    ],
    release: {
      id: 901,
      name: `Dawn v${VERSION} (abandoned before publication)`,
      tag_name: `v${VERSION}`,
      target_commitish: "main",
      draft: true,
      immutable: false,
      prerelease: false,
      body: canonicalAbandonmentReleaseBody({ marker, tombstone }),
    },
  }
}

function preparedAbandonedReleaseFixture(prepared) {
  const tagged = abandonedReleaseFixture()
  const artifact = {
    manifestSha256: prepared.record.manifestSha256,
    releaseRecordSha256: digest(prepared.recordBytes),
    baseAssetSetSha256: null,
    attestationSet: null,
  }
  const tombstone = {
    ...tagged.tombstone,
    predecessor: {
      state: "ARTIFACTS_PREPARED",
      releaseStatus: "absent",
      releaseId: null,
      bodySha256: null,
      marker: null,
      artifact,
    },
  }
  const bytes = canonicalAbandonmentBytes(tombstone)
  const sha256 = digest(bytes)
  const marker = abandonmentReleaseMarker({
    candidate: candidate(),
    artifact,
    abandonmentSha256: sha256,
  })
  return {
    marker,
    tombstone,
    bytes,
    sha256,
    assets: [
      {
        id: 3_002,
        name: "abandonment.json",
        digest: `sha256:${sha256}`,
        size: bytes.length,
      },
    ],
    release: {
      id: 902,
      name: `Dawn v${VERSION} (abandoned before publication)`,
      tag_name: `v${VERSION}`,
      target_commitish: "main",
      draft: true,
      immutable: false,
      prerelease: false,
      body: canonicalAbandonmentReleaseBody({ marker, tombstone }),
    },
  }
}

function strongAbandonedReleaseFixture(retainedNames) {
  const escrow = attestedReleaseFixture()
  const tagged = abandonedReleaseFixture()
  const predecessor = {
    state: "CANDIDATE_ESCROWED",
    releaseStatus: "draft",
    releaseId: escrow.release.id,
    bodySha256: digest(Buffer.from(escrow.release.body, "utf8")),
    marker: escrow.marker,
    artifact: {
      manifestSha256: escrow.marker.manifestSha256,
      releaseRecordSha256: escrow.marker.releaseRecordSha256,
      baseAssetSetSha256: escrow.marker.baseAssetSetSha256,
      attestationSet: escrow.marker.attestationSet,
    },
  }
  const tombstone = { ...tagged.tombstone, predecessor }
  const tombstoneBytes = canonicalAbandonmentBytes(tombstone)
  const tombstoneSha256 = digest(tombstoneBytes)
  const marker = abandonmentReleaseMarker({
    candidate: candidate(),
    artifact: {
      manifestSha256: escrow.marker.manifestSha256,
      releaseRecordSha256: escrow.marker.releaseRecordSha256,
      baseAssetSetSha256: escrow.marker.baseAssetSetSha256,
      attestationSet: escrow.marker.attestationSet,
    },
    abandonmentSha256: tombstoneSha256,
    previousMarker: escrow.marker,
  })
  const retained =
    retainedNames === "all"
      ? escrow.assets
      : escrow.assets.filter((asset) => retainedNames.includes(asset.name))
  assert.equal(retained.length, retainedNames === "all" ? 45 : retainedNames.length)
  const tombstoneAsset = {
    id: 3_001,
    name: "abandonment.json",
    digest: `sha256:${tombstoneSha256}`,
    size: tombstoneBytes.length,
  }
  return {
    marker,
    assets: [...retained, tombstoneAsset],
    bytesById: new Map([...escrow.bytesById, [tombstoneAsset.id, tombstoneBytes]]),
    release: {
      id: escrow.release.id,
      name: `Dawn v${VERSION} (abandoned before publication)`,
      tag_name: `v${VERSION}`,
      target_commitish: "main",
      draft: true,
      immutable: false,
      prerelease: false,
      body: canonicalAbandonmentReleaseBody({
        marker,
        tombstone,
        previousMarker: escrow.marker,
      }),
    },
  }
}

function cliCandidateDependencies(cwd) {
  const immutableInventory = {
    async read({ ref }) {
      const version = ref === PARENT_SHA ? "0.8.21" : VERSION
      return {
        status: "valid",
        packages: [...CANONICAL_RELEASE_PACKAGE_ORDER].sort().map((name) => ({ name, version })),
      }
    },
  }
  return {
    cwd,
    git: {
      ...gitReader(),
      async listFirstParentHistory() {
        return [COMMIT_SHA]
      },
      async firstParent() {
        return PARENT_SHA
      },
      async isAncestor() {
        return true
      },
      async listTree() {
        return "scripts/release/controller-schema.json\n"
      },
      async showFile() {
        return `${JSON.stringify(MARKER)}\n`
      },
    },
    inventory: immutableInventory,
    githubReader: githubReader(),
    npm: npmReader(),
    attestations: attestationVerifier([]),
    controllerMarker: MARKER,
  }
}

function packageEntry(name) {
  const bytes = packageBytes(name)
  const sha512 = createHash("sha512").update(bytes).digest("hex")
  const stem = name.startsWith("@") ? name.slice(1).replaceAll("/", "-") : name
  return {
    name,
    version: VERSION,
    filename: `${stem}-${VERSION}.tgz`,
    size: bytes.length,
    sha256: digest(bytes),
    sha512,
    npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
    access: "public",
  }
}

function packageBytes(name) {
  return Buffer.from(`packed:${name}`, "utf8")
}

function npmTarballUrl(name, version) {
  const unscopedName = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name
  return `https://registry.npmjs.org/${name}/-/${unscopedName}-${version}.tgz`
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function storedZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const bytes = Buffer.from(file.bytes)
    const local = Buffer.alloc(30 + name.length + bytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
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
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
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

function recordFor(overrides = {}) {
  const value = terminalRecordFixture()
  const retag = (set) => ({ ...set, commitSha: COMMIT_SHA })
  return {
    ...value,
    commitSha: COMMIT_SHA,
    tag: { ...value.tag, commitSha: COMMIT_SHA },
    predecessor: {
      ...value.predecessor,
      marker: {
        ...value.predecessor.marker,
        commitSha: COMMIT_SHA,
        attestationSet: retag(value.predecessor.marker.attestationSet),
      },
      artifact: {
        ...value.predecessor.artifact,
        attestationSet: retag(value.predecessor.artifact.attestationSet),
      },
    },
    ...overrides,
  }
}

function escrowTerminalRecord(escrow, overrides = {}) {
  const base = recordFor()
  const marker = escrow.marker
  return {
    ...base,
    predecessor: {
      state: "CANDIDATE_ESCROWED",
      releaseId: escrow.release.id,
      releaseStatus: "draft",
      bodySha256: digest(Buffer.from(escrow.release.body, "utf8")),
      marker,
      artifact: {
        manifestSha256: marker.manifestSha256,
        releaseRecordSha256: marker.releaseRecordSha256,
        baseAssetSetSha256: marker.baseAssetSetSha256,
        attestationSet: marker.attestationSet,
      },
    },
    evidence: {
      ...base.evidence,
      escrowAssets: escrow.assets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        sha256: asset.digest.slice("sha256:".length),
      })),
    },
    ...overrides,
  }
}

function recordedGit(bytes) {
  return gitReader({
    async listTree({ ref }) {
      assert.equal(ref, "HEAD")
      return "package.json\nscripts/release/terminal-records/v0.8.22.json\n"
    },
    async showFile({ ref, path: filePath }) {
      assert.equal(ref, "HEAD")
      assert.equal(filePath, "scripts/release/terminal-records/v0.8.22.json")
      return bytes.toString("utf8")
    },
  })
}

function stampedTerminalDraft(escrow, value) {
  const bytes = canonicalTerminalRecordBytes(value)
  const sha256 = digest(bytes)
  const marker = abandonmentReleaseMarker({
    candidate: candidate(),
    artifact: value.predecessor.artifact,
    abandonmentSha256: sha256,
    previousMarker: value.predecessor.marker,
  })
  const tombstoneAsset = {
    id: 3_100,
    name: "abandonment.json",
    digest: `sha256:${sha256}`,
    size: bytes.length,
  }
  return {
    bytes,
    sha256,
    marker,
    assets: [...escrow.assets, tombstoneAsset],
    bytesById: new Map([...escrow.bytesById, [tombstoneAsset.id, bytes]]),
    release: {
      ...escrow.release,
      name: `Dawn v${VERSION} (abandoned before publication)`,
      body: canonicalAbandonmentReleaseBody({
        marker,
        tombstone: value,
        previousMarker: value.predecessor.marker,
      }),
    },
  }
}

function releaseReader(fixture) {
  return {
    async listReleases() {
      return present("releases", [fixture.release])
    },
    async getRelease({ releaseId }) {
      assert.equal(releaseId, fixture.release.id)
      return present("release", fixture.release)
    },
    async listReleaseAssets({ releaseId }) {
      assert.equal(releaseId, fixture.release.id)
      return present("release-assets", fixture.assets)
    },
    async downloadReleaseAsset({ assetId }) {
      const bytes = fixture.bytesById.get(Number(assetId))
      assert.ok(bytes)
      return binary("release-asset-download", bytes)
    },
  }
}

test("a committed terminal record makes the candidate terminal even when no draft is visible", async () => {
  const bytes = canonicalTerminalRecordBytes(recordFor())
  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: recordedGit(bytes),
    github: githubReader(),
    npm: npmReader(),
  })
  assert.deepEqual(diagnostics, [])
  assert.equal(observation.release.status, "absent")
  assert.deepEqual(observation.abandonment, {
    requested: true,
    recorded: true,
    predecessor: "CANDIDATE_ESCROWED",
  })
  const plan = planRelease({ candidate: candidate(), observation, mode: "controller" })
  assert.equal(plan.state, "ABANDONED_PREPUBLICATION")
  assert.equal(plan.disposition, "noop")
  assert.deepEqual(plan.conflicts, [])
})

test("a terminal record with a published package blocks with TERMINAL_RECORD_PUBLISHED_VERSION", async () => {
  const bytes = canonicalTerminalRecordBytes(recordFor())
  const npm = npmReader({
    async observePackageVersion({ name, version }) {
      if (name !== "@dawn-ai/core") return envelope("ABSENT", "package-version", 404, "E404")
      return {
        status: "PRESENT",
        operation: "package-version",
        httpStatus: 200,
        code: null,
        package: {
          name,
          version,
          tarballUrl: npmTarballUrl(name, version),
          shasum: "1".repeat(40),
          integrity: packageEntry(name).npmIntegrity,
          distTags: { latest: version },
          latest: version,
        },
      }
    },
  })
  const { observation, diagnostics } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: recordedGit(bytes),
    github: githubReader(),
    npm,
  })
  assert.ok(diagnostics.some((entry) => entry.code === "TERMINAL_RECORD_PUBLISHED_VERSION"))
  const plan = planRelease({ candidate: candidate(), observation, mode: "controller" })
  assert.equal(plan.disposition, "blocked")
})

test("a terminal record with a visible unstamped escrow draft blocks with TERMINAL_RECORD_MISMATCH", async () => {
  const escrow = attestedReleaseFixture()
  const value = escrowTerminalRecord(escrow)
  const bytes = canonicalTerminalRecordBytes(value)
  const github = githubReader(releaseReader(escrow))
  const { diagnostics, observation } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: recordedGit(bytes),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
  })
  assert.equal(observation.release.status, "draft")
  assert.equal(observation.release.marker.phase, "ESCROWED")
  assert.ok(diagnostics.some((entry) => entry.code === "TERMINAL_RECORD_MISMATCH"))
  assert.equal(observation.abandonment.recorded, false)
})

test("a terminal record with a visible stamped draft that matches is terminal with no diagnostics", async () => {
  const escrow = attestedReleaseFixture()
  const value = escrowTerminalRecord(escrow)
  const stamped = stampedTerminalDraft(escrow, value)
  const github = githubReader(releaseReader(stamped))
  const { diagnostics, observation } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: recordedGit(stamped.bytes),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
  })
  assert.deepEqual(diagnostics, [])
  assert.equal(observation.release.status, "draft")
  assert.equal(observation.release.marker.phase, "ABANDONED_PREPUBLICATION")
  assert.deepEqual(observation.abandonment, {
    requested: true,
    recorded: true,
    predecessor: "CANDIDATE_ESCROWED",
  })
  const plan = planRelease({ candidate: candidate(), observation, mode: "controller" })
  assert.equal(plan.state, "ABANDONED_PREPUBLICATION")
  assert.deepEqual(plan.conflicts, [])
})

test("a visible stamped draft whose tombstone digest differs from the committed record blocks with TERMINAL_RECORD_MISMATCH", async () => {
  const escrow = attestedReleaseFixture()
  const committed = escrowTerminalRecord(escrow)
  const other = escrowTerminalRecord(escrow, {
    reason: "a different reason for the very same abandoned candidate",
  })
  const stamped = stampedTerminalDraft(escrow, other)
  assert.notEqual(digest(canonicalTerminalRecordBytes(committed)), stamped.sha256)
  const github = githubReader(releaseReader(stamped))
  const { diagnostics, observation } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git: recordedGit(canonicalTerminalRecordBytes(committed)),
    github,
    npm: npmReader(),
    attestations: attestationVerifier([]),
  })
  assert.ok(diagnostics.some((entry) => entry.code === "TERMINAL_RECORD_MISMATCH"))
  assert.equal(observation.release.marker.phase, "ABANDONED_PREPUBLICATION")
})

test("a malformed terminal record blocks the observation with TERMINAL_RECORD_INVALID", async () => {
  const git = gitReader({
    async listTree() {
      return "scripts/release/terminal-records/v0.8.22.json\n"
    },
    async showFile() {
      return "{}\n"
    },
  })
  const { diagnostics, observation } = await observeProductionCandidate({
    candidate: candidate(),
    inventory: inventory(),
    marker: MARKER,
    git,
    github: githubReader(),
    npm: npmReader(),
  })
  assert.ok(diagnostics.some((entry) => entry.code === "TERMINAL_RECORD_INVALID"))
  assert.equal(
    planRelease({ candidate: candidate(), observation, mode: "controller" }).disposition,
    "blocked",
  )
})
