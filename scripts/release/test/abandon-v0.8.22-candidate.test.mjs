import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  captureTerminalRecord,
  classifyAbandonmentState,
  createTerminalRecoveryReader,
  FINAL_AUTHORIZATION_RECEIPT_SHA256,
  parseAbandonCliArguments,
  TERMINAL_RECOVERY_POLICY,
} from "../abandon-v0.8.22-candidate.mjs"
import {
  canonicalRecoveryNotice,
  originalBodyAssetName,
  recoveryReceiptAssetName,
} from "../duplicate-draft-recovery.mjs"
import { createDuplicateDraftRecoveryReader } from "../duplicate-draft-recovery-adapters.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import { canonicalReleaseBody, releaseBodySha256 } from "../metadata.mjs"
import { RecoveryInputError } from "../recover-v0.8.22-duplicate-drafts.mjs"
import {
  canonicalTerminalRecordBytes,
  parseOperatorRecoveryRecord,
} from "../terminal-record-store.mjs"
import {
  attestationSet,
  predecessorMarker,
  TAG_OBJECT_SHA,
  record as terminalRecord,
} from "./support/terminal-record-fixture.mjs"
import {
  binaryResponse,
  jsonResponse,
  releaseAsset,
  routingFetch,
  sha256 as sha256Hex,
} from "./support/terminal-recovery-fetch.mjs"

const REVIEWED = "4".repeat(40)
const REASON = "The tag-era release workflow cannot observe draft Releases; superseded by 0.8.23."
const CAPTURE_PATH = ".dawn/release-recovery/v0.8.22-terminal-capture-01.json"
const APPLY_PATH = ".dawn/release-recovery/v0.8.22-terminal-apply-01.json"
const RECORD_PATH = "scripts/release/terminal-records/v0.8.22.json"
const FLAG = "--acknowledge-non-atomic-release-edit-freeze"
const CANONICAL_TAG_NAME = "untagged-be0ff4bee4ba43b521a9"

test("parses only the exact capture and apply grammars", () => {
  assert.deepEqual(
    parseAbandonCliArguments([
      "capture",
      "--reviewed-commit",
      REVIEWED,
      "--reason",
      REASON,
      "--output",
      CAPTURE_PATH,
    ]),
    { command: "capture", reviewedCommit: REVIEWED, reason: REASON, output: CAPTURE_PATH },
  )
  assert.deepEqual(
    parseAbandonCliArguments([
      "apply",
      "--record",
      RECORD_PATH,
      "--reviewed-commit",
      REVIEWED,
      FLAG,
      "--output",
      APPLY_PATH,
    ]),
    { command: "apply", record: RECORD_PATH, reviewedCommit: REVIEWED, output: APPLY_PATH },
  )
  for (const argv of [
    [],
    ["capture", "--reviewed-commit", REVIEWED, "--output", CAPTURE_PATH],
    ["apply", "--record", RECORD_PATH, "--reviewed-commit", REVIEWED, "--output", APPLY_PATH],
    ["apply", "--record", RECORD_PATH, FLAG, "--reviewed-commit", REVIEWED, "--output", APPLY_PATH],
    [
      "apply",
      "--record",
      CAPTURE_PATH,
      "--reviewed-commit",
      REVIEWED,
      FLAG,
      "--output",
      APPLY_PATH,
    ],
    ["capture", "--reviewed-commit", REVIEWED, "--reason", "", "--output", CAPTURE_PATH],
    ["capture", "--reviewed-commit", REVIEWED, "--reason", REASON, "--output", "/tmp/x.json"],
    ["capture", "--reviewed-commit", "A".repeat(40), "--reason", REASON, "--output", CAPTURE_PATH],
  ]) {
    assert.throws(() => parseAbandonCliArguments(argv), RecoveryInputError)
  }
})

function escrowBody() {
  return canonicalReleaseBody({ marker: predecessorMarker(), manifest: null })
}

function attachingBody() {
  return canonicalReleaseBody({
    marker: {
      ...predecessorMarker(),
      revision: 1,
      phase: "ATTACHING",
      baseAssetSetSha256: null,
      attestationSet: null,
    },
    manifest: null,
  })
}

/** The fixture record, bound to the escrow body the fake reader serves. */
function boundRecord() {
  const base = terminalRecord()
  return {
    ...base,
    predecessor: { ...base.predecessor, bodySha256: releaseBodySha256(escrowBody()) },
    evidence: {
      ...base.evidence,
      duplicateRecovery: {
        ...base.evidence.duplicateRecovery,
        finalAuthorizationReceiptSha256: FINAL_AUTHORIZATION_RECEIPT_SHA256,
      },
    },
  }
}

function fakeReader({
  npmPresent = false,
  releaseBody = escrowBody(),
  name = "Dawn v0.8.22",
  assets = boundRecord().evidence.escrowAssets,
} = {}) {
  const observedAt = ["2026-09-03T18:00:00.000Z", "2026-09-03T18:01:05.000Z"]
  let sweep = 0
  return {
    async readReviewedMergeAuthority(reviewedCommit) {
      return {
        mergeCommitSha: reviewedCommit,
        reviewedHeadSha: "5".repeat(40),
        pullRequestNumber: 600,
      }
    },
    async readCandidateTag() {
      return {
        name: "v0.8.22",
        objectSha: TAG_OBJECT_SHA,
        commitSha: TERMINAL_RECOVERY_POLICY.candidateSha,
      }
    },
    async readCanonicalSnapshot() {
      return {
        releaseId: TERMINAL_RECOVERY_POLICY.canonicalReleaseId,
        name,
        body: releaseBody,
        draft: true,
        immutable: false,
        prerelease: false,
        targetCommitish: "main",
        tagName: CANONICAL_TAG_NAME,
        assets,
      }
    },
    async readDuplicateRecoveryReceipts({ expectedOriginalBody }) {
      assert.equal(expectedOriginalBody, releaseBody, "the duplicates are read with the live body")
      return boundRecord().evidence.duplicateRecovery
    },
    async readReleaseRuns() {
      return boundRecord().evidence.releaseRuns
    },
    async readNpmSweep() {
      const at = observedAt[Math.min(sweep, 1)]
      sweep += 1
      const packages = boundRecord().evidence.npm.observations[0].packages
      return {
        observedAt: at,
        packages: npmPresent
          ? [
              { ...packages[0], status: "PRESENT", httpStatus: 200, code: null },
              ...packages.slice(1),
            ]
          : packages,
      }
    },
    async readOperatorLogin() {
      return "blove"
    },
  }
}

test("capture seals a canonical record from fresh reads", async () => {
  let ticks = 0
  const now = () => Date.parse("2026-09-03T18:02:00.000Z") + ticks++
  const bytes = await captureTerminalRecord({
    reviewedCommit: REVIEWED,
    reason: REASON,
    reader: fakeReader(),
    now,
    wait: async () => {},
  })
  const parsed = parseOperatorRecoveryRecord(bytes)
  assert.equal(parsed.authority.reviewedCommit, REVIEWED)
  assert.equal(parsed.authority.operator, "blove")
  assert.equal(parsed.authority.mode, "operator-recovery")
  assert.equal(parsed.predecessor.releaseId, 379991871)
  assert.equal(
    parsed.predecessor.bodySha256,
    createHash("sha256").update(escrowBody()).digest("hex"),
  )
  assert.deepEqual(parsed.predecessor.artifact.attestationSet, attestationSet())
  assert.equal(parsed.evidence.escrowAssets.length, TERMINAL_RECOVERY_POLICY.baseAssetCount)
  assert.equal(
    parsed.evidence.duplicateRecovery.finalAuthorizationReceiptSha256,
    FINAL_AUTHORIZATION_RECEIPT_SHA256,
  )
})

test("capture refuses a published package, a non-escrow body, and a foreign draft title", async () => {
  const now = () => Date.parse("2026-09-03T18:02:00.000Z")
  await assert.rejects(
    captureTerminalRecord({
      reviewedCommit: REVIEWED,
      reason: REASON,
      reader: fakeReader({ npmPresent: true }),
      now,
      wait: async () => {},
    }),
    /absent/iu,
  )
  await assert.rejects(
    captureTerminalRecord({
      reviewedCommit: REVIEWED,
      reason: REASON,
      // A well-formed marker in another phase, so capture's own phase check is
      // what fires rather than the marker parser.
      reader: fakeReader({ releaseBody: attachingBody() }),
      now,
      wait: async () => {},
    }),
    /escrow marker/iu,
  )
  await assert.rejects(
    captureTerminalRecord({
      reviewedCommit: REVIEWED,
      reason: REASON,
      reader: fakeReader({ name: "Other" }),
      now,
      wait: async () => {},
    }),
    /title/iu,
  )
})

test("capture refuses sweeps that are not sixty seconds apart", async () => {
  const reader = fakeReader()
  reader.readNpmSweep = async () => ({
    observedAt: "2026-09-03T18:00:00.000Z",
    packages: boundRecord().evidence.npm.observations[0].packages,
  })
  await assert.rejects(
    captureTerminalRecord({
      reviewedCommit: REVIEWED,
      reason: REASON,
      reader,
      now: () => Date.parse("2026-09-03T18:02:00.000Z"),
      wait: async () => {},
    }),
    /sixty seconds/iu,
  )
})

test("capture refuses base assets that do not hash to the marker's base asset set", async () => {
  const assets = boundRecord().evidence.escrowAssets.map((asset, index) =>
    index === 0 ? { ...asset, sha256: "d".repeat(64) } : asset,
  )
  await assert.rejects(
    captureTerminalRecord({
      reviewedCommit: REVIEWED,
      reason: REASON,
      reader: fakeReader({ assets }),
      now: () => Date.parse("2026-09-03T18:02:00.000Z"),
      wait: async () => {},
    }),
    /base asset set/iu,
  )
})

test("classifyAbandonmentState recognizes the three ladder states and nothing else", () => {
  const value = boundRecord()
  const bytes = canonicalTerminalRecordBytes(value)
  const digest = createHash("sha256").update(bytes).digest("hex")
  const base = value.evidence.escrowAssets
  assert.equal(
    classifyAbandonmentState({
      record: value,
      recordSha256: digest,
      snapshot: { name: "Dawn v0.8.22", body: escrowBody(), assets: base },
    }),
    "escrowed",
  )
  assert.equal(
    classifyAbandonmentState({
      record: value,
      recordSha256: digest,
      snapshot: {
        name: "Dawn v0.8.22",
        body: escrowBody(),
        assets: [...base, { id: 9, name: "abandonment.json", sha256: digest }],
      },
    }),
    "asset-uploaded",
  )
  assert.throws(
    () =>
      classifyAbandonmentState({
        record: value,
        recordSha256: digest,
        snapshot: {
          name: "Dawn v0.8.22",
          body: escrowBody(),
          assets: [...base, { id: 9, name: "abandonment.json", sha256: "f".repeat(64) }],
        },
      }),
    /conflict/iu,
  )
  assert.throws(
    () =>
      classifyAbandonmentState({
        record: value,
        recordSha256: digest,
        snapshot: { name: "Dawn v0.8.22", body: escrowBody(), assets: base.slice(1) },
      }),
    /conflict/iu,
  )
})

test("the live reader reads the canonical draft only through the terminal writer", async () => {
  const duplicateSnapshotCalls = []
  const canonicalSnapshot = {
    releaseId: TERMINAL_RECOVERY_POLICY.canonicalReleaseId,
    tagName: CANONICAL_TAG_NAME,
    name: "Dawn v0.8.22 (abandoned before publication)",
    targetCommitish: "main",
    draft: true,
    prerelease: false,
    immutable: false,
    body: escrowBody(),
    assets: [],
  }
  const npmCalls = []
  const duplicateReader = {
    async readReviewedMergeAuthority(sha) {
      return { mergeCommitSha: sha }
    },
    async readAuthenticatedLogin() {
      return "blove"
    },
    async readCandidateTag() {
      return {
        version: "0.8.22",
        commitSha: TERMINAL_RECOVERY_POLICY.candidateSha,
        tagObjectSha: TAG_OBJECT_SHA,
      }
    },
    async readReleaseRuns() {
      return {
        runs: [],
        candidateRuns: [{ id: 33418085547, runAttempt: 1, status: "completed" }],
      }
    },
    async readCandidatePublishJobs(runId, runAttempt) {
      assert.equal(runId, 33418085547)
      assert.equal(runAttempt, 1)
      // The real v0.8.22 publish-npm jobs are completed/skipped, and GitHub
      // stamps a started_at on a skipped job.
      return [
        {
          id: 1,
          runId,
          runAttempt: 1,
          name: "publish-npm",
          status: "completed",
          conclusion: "skipped",
          startedAt: "2026-09-01T12:00:00Z",
          completedAt: "2026-09-01T12:00:00Z",
        },
      ]
    },
    async readNpmAbsence(name) {
      npmCalls.push(name)
      return { name, version: "0.8.22", status: "absent" }
    },
    async readReleaseSnapshot(releaseId) {
      duplicateSnapshotCalls.push(releaseId)
      assert.fail(`the duplicate reader must not be asked for Release ${releaseId} here`)
    },
  }
  const reader = createTerminalRecoveryReader({
    root: "/repo",
    token: "t",
    run: async () => ({ stdout: "" }),
    now: () => Date.parse("2026-09-03T18:00:00.000Z"),
    dependencies: {
      createDuplicateReader: () => duplicateReader,
      createTerminalWriter: () => ({
        async readCanonicalSnapshot() {
          return canonicalSnapshot
        },
      }),
    },
  })

  assert.equal(await reader.readCanonicalSnapshot(), canonicalSnapshot)
  assert.deepEqual(await reader.readCandidateTag(), {
    name: "v0.8.22",
    objectSha: TAG_OBJECT_SHA,
    commitSha: TERMINAL_RECOVERY_POLICY.candidateSha,
  })
  assert.equal(await reader.readOperatorLogin(), "blove")
  assert.deepEqual(await reader.readReleaseRuns(), [
    { workflowRunId: 33418085547, runAttempt: 1, status: "completed", publishJobStarted: false },
  ])
  const sweep = await reader.readNpmSweep()
  assert.equal(sweep.observedAt, "2026-09-03T18:00:00.000Z")
  assert.deepEqual(
    sweep.packages.map(({ name }) => name),
    [...CANONICAL_RELEASE_PACKAGE_ORDER].sort(),
  )
  assert.deepEqual(npmCalls, [...CANONICAL_RELEASE_PACKAGE_ORDER].sort())
  assert.deepEqual(
    duplicateSnapshotCalls,
    [],
    "the canonical Release is never read through the duplicate reader",
  )
})

function publishJobsReader(jobs, { runAttempt = 1 } = {}) {
  return {
    async readReleaseRuns() {
      return { runs: [], candidateRuns: [{ id: 7, runAttempt, status: "completed" }] }
    },
    async readCandidatePublishJobs() {
      return jobs
    },
  }
}

function publishJob(overrides) {
  return {
    id: 1,
    runId: 7,
    runAttempt: 1,
    name: "publish-npm",
    status: "completed",
    conclusion: "skipped",
    startedAt: "2026-09-01T12:00:00Z",
    completedAt: "2026-09-01T12:05:00Z",
    ...overrides,
  }
}

function readerFor(duplicateReader) {
  return createTerminalRecoveryReader({
    root: "/repo",
    token: "t",
    run: async () => ({ stdout: "" }),
    dependencies: {
      createDuplicateReader: () => duplicateReader,
      createTerminalWriter: () => ({ async readCanonicalSnapshot() {} }),
    },
  })
}

test("publish-npm is never-started only when it is queued-unstarted or skipped", async () => {
  const cases = [
    // A skipped job carries a started_at, so a null-started_at test would call it started.
    [publishJob({}), false, "completed/skipped"],
    [
      publishJob({ status: "queued", conclusion: null, startedAt: null, completedAt: null }),
      false,
      "queued/null/null",
    ],
    [publishJob({ conclusion: "success" }), true, "completed/success"],
    [
      publishJob({ status: "in_progress", conclusion: null, completedAt: null }),
      true,
      "in_progress",
    ],
    [publishJob({ conclusion: "failure" }), true, "completed/failure"],
  ]
  for (const [job, publishJobStarted, label] of cases) {
    const reader = readerFor(publishJobsReader([job]))
    assert.deepEqual(
      await reader.readReleaseRuns(),
      [{ workflowRunId: 7, runAttempt: 1, status: "completed", publishJobStarted }],
      label,
    )
  }
})

test("every attempt must carry exactly one publish-npm job", async () => {
  await assert.rejects(
    readerFor(publishJobsReader([publishJob({}), publishJob({ id: 2 })])).readReleaseRuns(),
    /publish-npm job coverage is not exact/iu,
    "two publish jobs for one attempt",
  )
  await assert.rejects(
    readerFor(publishJobsReader([])).readReleaseRuns(),
    /publish-npm job coverage is not exact/iu,
    "no publish job at all",
  )
  await assert.rejects(
    readerFor(publishJobsReader([publishJob({})], { runAttempt: 2 })).readReleaseRuns(),
    /publish-npm job coverage is not exact/iu,
    "a later attempt with no publish job of its own",
  )
  // Both attempts covered, the earlier one skipped and the later one started.
  assert.deepEqual(
    await readerFor(
      publishJobsReader(
        [publishJob({}), publishJob({ id: 2, runAttempt: 2, conclusion: "success" })],
        { runAttempt: 2 },
      ),
    ).readReleaseRuns(),
    [{ workflowRunId: 7, runAttempt: 2, status: "completed", publishJobStarted: true }],
  )
})

test("the live reader refuses a present package", async () => {
  const reader = readerFor({
    async readNpmAbsence(name) {
      if (name === [...CANONICAL_RELEASE_PACKAGE_ORDER].sort()[0]) {
        return { name, version: "0.8.22", status: "present" }
      }
      return { name, version: "0.8.22", status: "absent" }
    },
  })
  await assert.rejects(reader.readNpmSweep(), /absent/iu)
})

const API_BASE = "https://api.github.com/repos/cacheplane/dawnai"
const SIGNED_HOST = "https://objects.githubusercontent.com/recovery"

/**
 * One quarantined duplicate exactly as production carries it: the recovery
 * notice as its live body, the 45 base assets, the archived original body
 * (the canonical escrow body), and the recovery receipt.
 */
function duplicateFixture(releaseId, tagName, { receiptDigestDrift = false } = {}) {
  const originalBody = escrowBody()
  const originalBodySha256 = sha256Hex(Buffer.from(originalBody, "utf8"))
  const archiveName = originalBodyAssetName(releaseId, originalBodySha256)
  const receiptName = recoveryReceiptAssetName(releaseId)
  const receiptBytes = Buffer.from(`{"releaseId":${releaseId}}\n`, "utf8")
  const receiptSha256 = sha256Hex(receiptBytes)
  const body = canonicalRecoveryNotice({
    repository: "cacheplane/dawnai",
    version: "0.8.22",
    canonicalReleaseId: TERMINAL_RECOVERY_POLICY.canonicalReleaseId,
    duplicateReleaseId: releaseId,
    originalBodySha256,
    archiveAssetName: archiveName,
    receiptAssetName: receiptName,
    receiptSha256,
  })
  const archiveBytes = Buffer.from(originalBody, "utf8")
  const base = boundRecord().evidence.escrowAssets.map((asset, index) => ({
    id: releaseId * 10 + index,
    name: asset.name,
    digest: `sha256:${asset.sha256}`,
    size: index + 1,
  }))
  const receiptRow = releaseAsset(releaseId * 10 + 200, receiptName, receiptBytes)
  return {
    releaseId,
    receiptAssetId: receiptRow.id,
    receiptSha256,
    archiveAssetId: releaseId * 10 + 100,
    release: {
      id: releaseId,
      tag_name: tagName,
      name: "Dawn v0.8.22",
      body,
      draft: true,
      prerelease: false,
      immutable: false,
      target_commitish: "main",
    },
    assets: [
      ...base,
      { ...releaseAsset(releaseId * 10 + 100, archiveName, archiveBytes) },
      // A drifted listing digest must fail the downloaded-bytes comparison.
      receiptDigestDrift ? { ...receiptRow, digest: `sha256:${"e".repeat(64)}` } : receiptRow,
    ],
    downloads: new Map([
      [releaseId * 10 + 100, archiveBytes],
      [releaseId * 10 + 200, receiptBytes],
    ]),
  }
}

function duplicateRoutingReader(fixtures, calls) {
  const byId = new Map(fixtures.map((fixture) => [fixture.releaseId, fixture]))
  const downloads = new Map()
  for (const fixture of fixtures) {
    for (const [assetId, bytes] of fixture.downloads) downloads.set(assetId, bytes)
  }
  return createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED}\n`,
    fetchImpl: routingFetch(calls, (url) => {
      for (const [releaseId, fixture] of byId) {
        if (url === `${API_BASE}/releases/${releaseId}`) return jsonResponse(fixture.release)
        if (url === `${API_BASE}/releases/${releaseId}/assets?per_page=100`) {
          return jsonResponse(fixture.assets)
        }
      }
      const download =
        /^https:\/\/api\.github\.com\/repos\/cacheplane\/dawnai\/releases\/assets\/(\d+)$/u.exec(
          url,
        )
      if (download !== null) {
        return binaryResponse(new Uint8Array(), 302, {
          location: `${SIGNED_HOST}/${download[1]}`,
        })
      }
      const signed = new RegExp(`^${SIGNED_HOST}/(\\d+)$`, "u").exec(url)
      if (signed !== null) return binaryResponse(downloads.get(Number(signed[1])))
      assert.fail(`unexpected URL ${url}`)
    }),
  })
}

test("the live reader reads both quarantined duplicates with their archived original body", async () => {
  const fixtures = TERMINAL_RECOVERY_POLICY.duplicates.map((duplicate) =>
    duplicateFixture(duplicate.releaseId, duplicate.tagName),
  )
  const calls = []
  const reader = createTerminalRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED}\n`,
    dependencies: {
      createDuplicateReader: () => duplicateRoutingReader(fixtures, calls),
      createTerminalWriter: () => ({ async readCanonicalSnapshot() {} }),
    },
  })

  assert.deepEqual(
    await reader.readDuplicateRecoveryReceipts({ expectedOriginalBody: escrowBody() }),
    {
      duplicates: fixtures.map((fixture) => ({
        releaseId: fixture.releaseId,
        receiptAssetId: fixture.receiptAssetId,
        receiptSha256: fixture.receiptSha256,
      })),
      finalAuthorizationReceiptSha256: FINAL_AUTHORIZATION_RECEIPT_SHA256,
    },
  )
  assert.equal(
    calls.some(({ url }) =>
      url.includes(`/releases/${TERMINAL_RECOVERY_POLICY.canonicalReleaseId}`),
    ),
    false,
    "the canonical Release is never read through the duplicate reader",
  )
})

test("the live reader rejects a duplicate whose receipt bytes do not match its digest", async () => {
  const fixtures = [
    duplicateFixture(
      TERMINAL_RECOVERY_POLICY.duplicates[0].releaseId,
      TERMINAL_RECOVERY_POLICY.duplicates[0].tagName,
      { receiptDigestDrift: true },
    ),
  ]
  const reader = createTerminalRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED}\n`,
    dependencies: {
      createDuplicateReader: () => duplicateRoutingReader(fixtures, []),
      createTerminalWriter: () => ({ async readCanonicalSnapshot() {} }),
    },
  })

  await assert.rejects(
    reader.readDuplicateRecoveryReceipts({ expectedOriginalBody: escrowBody() }),
    { code: "RECOVERY_ASSET_BYTES_CONFLICT" },
  )
})

test("the live reader refuses to read the duplicates without the archived original body", async () => {
  const reader = createTerminalRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED}\n`,
    dependencies: {
      createDuplicateReader: () => ({
        async readReleaseSnapshot() {
          assert.fail("no duplicate is read without the body to verify its archive against")
        },
      }),
      createTerminalWriter: () => ({ async readCanonicalSnapshot() {} }),
    },
  })

  await assert.rejects(reader.readDuplicateRecoveryReceipts({}), /original body/iu)
})
