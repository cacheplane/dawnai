import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { createHash } from "node:crypto"
import * as nodeFileSystem from "node:fs/promises"
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import {
  abandonedReleaseBody,
  applyTerminalRecord,
  captureTerminalRecord,
  classifyAbandonmentState,
  createTerminalRecoveryReader,
  FINAL_AUTHORIZATION_RECEIPT_SHA256,
  NPM_SWEEP_MARGIN_MS,
  parseAbandonCliArguments,
  runAbandonCli,
  sha256,
  TERMINAL_RECOVERY_POLICY,
  TerminalRecoveryError,
} from "../abandon-v0.8.22-candidate.mjs"
import {
  canonicalRecoveryNotice,
  canonicalRecoveryReceipt,
  originalBodyAssetName,
  recoveryReceiptAssetName,
} from "../duplicate-draft-recovery.mjs"
import {
  sha256 as adapterSha256,
  createDuplicateDraftRecoveryReader,
} from "../duplicate-draft-recovery-adapters.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import { canonicalReleaseBody, parseReleaseMarker, releaseBodySha256 } from "../metadata.mjs"
import {
  RecoveryInputError,
  RecoveryOutputCleanupUncertainError,
} from "../recover-v0.8.22-duplicate-drafts.mjs"
import {
  canonicalTerminalRecordBytes,
  MAX_TERMINAL_RECORD_BYTES,
  parseOperatorRecoveryRecord,
  terminalRecordPath,
} from "../terminal-record-store.mjs"
import {
  predecessorMarker,
  sealedManifest,
  sealedManifestBytes,
  sealedMarker,
  sealedRecord,
  TAG_OBJECT_SHA,
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

/**
 * The real ESCROWED body: rendered WITH the sealed manifest, so its package
 * table is the three-column form production wrote. Rebuilding it from the
 * marker alone produces different bytes, which is exactly the defect the apply
 * path must not have.
 */
function escrowBody() {
  return canonicalReleaseBody({ marker: sealedMarker(), manifest: sealedManifest() })
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
  const base = sealedRecord()
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
  prerelease = false,
  tagName = CANONICAL_TAG_NAME,
  observedAt = ["2026-09-03T18:00:00.000Z", "2026-09-03T18:01:05.000Z"],
} = {}) {
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
        prerelease,
        targetCommitish: "main",
        tagName,
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
    async readCanonicalManifest({ escrowAssets } = {}) {
      const manifest = escrowAssets?.find(({ name }) => name === "manifest.json")
      assert.ok(manifest, "the manifest asset is addressed from the record's escrow assets")
      assert.equal(manifest.sha256, sealedMarker().manifestSha256)
      return sealedManifestBytes()
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
  assert.deepEqual(parsed.predecessor.artifact.attestationSet, sealedMarker().attestationSet)
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
function duplicateFixture(
  releaseId,
  tagName,
  {
    receiptDigestDrift = false,
    receiptBoundTo = releaseId,
    receiptBaseAssetSetSha256 = null,
    receiptOriginalBodySha256 = null,
  } = {},
) {
  const originalBody = escrowBody()
  const originalBodySha256 = sha256Hex(Buffer.from(originalBody, "utf8"))
  const receiptBodySha256 = receiptOriginalBodySha256 ?? originalBodySha256
  const archiveName = originalBodyAssetName(releaseId, originalBodySha256)
  const receiptName = recoveryReceiptAssetName(releaseId)
  // The real duplicate-draft recovery wrote a canonical receipt onto each
  // quarantined draft; `receiptBoundTo` lets a test serve a well-formed receipt
  // that names the OTHER duplicate, which only a binding check can catch.
  const receiptBytes = canonicalRecoveryReceipt({
    repository: TERMINAL_RECOVERY_POLICY.repository,
    version: TERMINAL_RECOVERY_POLICY.version,
    candidateSha: TERMINAL_RECOVERY_POLICY.candidateSha,
    recoveryCommit: REVIEWED,
    canonicalReleaseId: TERMINAL_RECOVERY_POLICY.canonicalReleaseId,
    duplicateReleaseId: receiptBoundTo,
    originalBodySha256: receiptBodySha256,
    baseAssetSetSha256: receiptBaseAssetSetSha256 ?? sealedMarker().baseAssetSetSha256,
    archiveAsset: {
      name: originalBodyAssetName(receiptBoundTo, receiptBodySha256),
      sha256: receiptBodySha256,
    },
  })
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

test("the live reader binds each duplicate's receipt to this candidate", async () => {
  // A well-formed canonical receipt that names the OTHER quarantined duplicate
  // is only caught by parsing the receipt and binding it to the draft it sits
  // on; digest and byte checks alone accept it.
  const [first, second] = TERMINAL_RECOVERY_POLICY.duplicates
  const fixtures = [
    duplicateFixture(first.releaseId, first.tagName, { receiptBoundTo: second.releaseId }),
    duplicateFixture(second.releaseId, second.tagName),
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
    /receipt is not bound to this candidate/iu,
  )
})

test("capture refuses a prereleased draft and a foreign tag name", async () => {
  const now = () => Date.parse("2026-09-03T18:02:00.000Z")
  await assert.rejects(
    captureTerminalRecord({
      reviewedCommit: REVIEWED,
      reason: REASON,
      reader: fakeReader({ prerelease: true }),
      now,
      wait: async () => {},
    }),
    /mutable draft/iu,
  )
  await assert.rejects(
    captureTerminalRecord({
      reviewedCommit: REVIEWED,
      reason: REASON,
      reader: fakeReader({ tagName: "v0.8.22" }),
      now,
      wait: async () => {},
    }),
    /tag name/iu,
  )
})

test("capture waits a margin above the sixty second sweep gap", async () => {
  const waits = []
  await captureTerminalRecord({
    reviewedCommit: REVIEWED,
    reason: REASON,
    reader: fakeReader(),
    now: () => Date.parse("2026-09-03T18:02:00.000Z"),
    wait: async (ms) => {
      waits.push(ms)
    },
  })
  assert.deepEqual(waits, [60_000 + NPM_SWEEP_MARGIN_MS])
  assert.ok(NPM_SWEEP_MARGIN_MS > 0)
})

test("classifyAbandonmentState refuses duplicate asset names", () => {
  const value = boundRecord()
  const digest = sha256(canonicalTerminalRecordBytes(value))
  const base = value.evidence.escrowAssets
  // Forty-five entries, one of them listed twice: every per-asset check still
  // passes and the count is exact, so only a uniqueness check catches it.
  const repeated = [...base.slice(0, TERMINAL_RECOVERY_POLICY.baseAssetCount - 1), base[0]]
  assert.equal(repeated.length, TERMINAL_RECOVERY_POLICY.baseAssetCount)
  assert.throws(
    () =>
      classifyAbandonmentState({
        record: value,
        recordSha256: digest,
        snapshot: { name: "Dawn v0.8.22", body: escrowBody(), assets: repeated },
      }),
    /repeats an asset/iu,
  )
})

test("abandonedReleaseBody carries the record as its tombstone and classifies as abandoned", () => {
  const bytes = canonicalTerminalRecordBytes(boundRecord())
  const digest = sha256(bytes)
  const record = parseOperatorRecoveryRecord(bytes)
  const body = abandonedReleaseBody(record, digest)
  const marker = parseReleaseMarker(body)
  assert.equal(marker.phase, "ABANDONED_PREPUBLICATION")
  assert.equal(marker.abandonmentSha256, digest)
  assert.equal(marker.revision, record.predecessor.marker.revision + 1)
  assert.equal(
    classifyAbandonmentState({
      record,
      recordSha256: digest,
      snapshot: {
        name: TERMINAL_RECOVERY_POLICY.abandonedTitle,
        body,
        assets: [
          ...record.evidence.escrowAssets,
          { id: 777, name: "abandonment.json", sha256: digest },
        ],
      },
    }),
    "abandoned",
  )
})

test("the abandoned state requires the exact abandonment body, not merely its marker", () => {
  const bytes = canonicalTerminalRecordBytes(boundRecord())
  const digest = sha256(bytes)
  const record = parseOperatorRecoveryRecord(bytes)
  // A body whose marker and tombstone digest still parse correctly but whose
  // bytes carry appended text must never be accepted as the stamp Dawn wrote.
  const tampered = `${abandonedReleaseBody(record, digest)}trailing operator note\n`
  assert.equal(parseReleaseMarker(tampered).abandonmentSha256, digest)
  assert.throws(
    () =>
      classifyAbandonmentState({
        record,
        recordSha256: digest,
        snapshot: {
          name: TERMINAL_RECOVERY_POLICY.abandonedTitle,
          body: tampered,
          assets: [
            ...record.evidence.escrowAssets,
            { id: 777, name: "abandonment.json", sha256: digest },
          ],
        },
      }),
    /conflict/iu,
  )
})

test("the command's sha256 is the recovery adapters' own digest helper", () => {
  assert.equal(sha256, adapterSha256)
})

const APPLY_NOW = Date.parse("2026-09-03T19:00:05.000Z")
const APPLY_SWEEPS = ["2026-09-03T18:59:00.000Z", "2026-09-03T19:00:05.000Z"]

function terminalObservation() {
  return {
    state: "ABANDONED_PREPUBLICATION",
    disposition: "noop",
    nextTransition: null,
    conflicts: [],
    diagnostics: [],
  }
}

function stampingWriter(calls, snapshotRef) {
  return {
    async uploadTombstoneIfAbsentAndEqual(input) {
      calls.push(["upload", input.sha256, input.expectedSnapshot.assets.length])
      snapshotRef.assets = [
        ...snapshotRef.assets,
        { id: 777, name: "abandonment.json", sha256: input.sha256, size: input.bytes.byteLength },
      ]
      return {
        releaseId: TERMINAL_RECOVERY_POLICY.canonicalReleaseId,
        assetId: 777,
        name: "abandonment.json",
        status: "uploaded",
        sha256: input.sha256,
      }
    },
    async abandonCandidateIfCurrent(input) {
      calls.push(["patch", input.expectedName, input.expectedSnapshot.assets.at(-1).name])
      snapshotRef.name = input.expectedName
      snapshotRef.body = input.expectedBody
      return {
        atomic: false,
        releaseId: TERMINAL_RECOVERY_POLICY.canonicalReleaseId,
        outcome: "performed",
        preWriteFence: { observedAt: "2026-09-03T19:00:00.000Z", projectionSha256: "1".repeat(64) },
        postWriteFence: {
          observedAt: "2026-09-03T19:00:01.000Z",
          projectionSha256: "2".repeat(64),
        },
      }
    },
  }
}

function applyFixture({ state = "escrowed", record: overrides = {} } = {}) {
  const value = { ...boundRecord(), ...overrides }
  const bytes = canonicalTerminalRecordBytes(value)
  const digest = sha256(bytes)
  const record = parseOperatorRecoveryRecord(bytes)
  const snapshot = {
    releaseId: TERMINAL_RECOVERY_POLICY.canonicalReleaseId,
    tagName: CANONICAL_TAG_NAME,
    name: "Dawn v0.8.22",
    targetCommitish: "main",
    draft: true,
    prerelease: false,
    immutable: false,
    body: escrowBody(),
    assets: record.evidence.escrowAssets.map((asset, index) => ({ ...asset, size: index + 1 })),
  }
  if (state !== "escrowed") {
    snapshot.assets = [
      ...snapshot.assets,
      { id: 777, name: "abandonment.json", sha256: digest, size: bytes.byteLength },
    ]
  }
  if (state === "abandoned") {
    snapshot.name = TERMINAL_RECOVERY_POLICY.abandonedTitle
    snapshot.body = abandonedReleaseBody(record, digest)
  }
  const reader = {
    ...fakeReader({ observedAt: APPLY_SWEEPS }),
    async readCanonicalSnapshot() {
      return snapshot
    },
  }
  return { record, bytes, digest, snapshot, reader }
}

test("apply walks escrowed to abandoned with compare-before-write and a terminal observer", async () => {
  const { record, bytes, digest, snapshot, reader } = applyFixture()
  const calls = []
  const receipt = await applyTerminalRecord({
    recordBytes: bytes,
    reviewedCommit: REVIEWED,
    reader,
    createWriter: () => stampingWriter(calls, snapshot),
    observer: async ({ candidate }) => {
      assert.deepEqual(candidate, {
        version: TERMINAL_RECOVERY_POLICY.version,
        commitSha: TERMINAL_RECOVERY_POLICY.candidateSha,
      })
      return terminalObservation()
    },
    now: () => APPLY_NOW,
    wait: async () => {},
  })
  assert.deepEqual(calls, [
    ["upload", digest, TERMINAL_RECOVERY_POLICY.baseAssetCount],
    ["patch", TERMINAL_RECOVERY_POLICY.abandonedTitle, "abandonment.json"],
  ])
  assert.equal(receipt.outcome, "performed")
  assert.equal(receipt.atomic, false)
  assert.equal(receipt.record.sha256, record.sha256)
  assert.equal(receipt.record.path, terminalRecordPath("0.8.22"))
  assert.equal(receipt.record.reviewedCommit, REVIEWED)
  assert.deepEqual(
    receipt.transitions.map(({ name }) => name),
    ["upload-tombstone", "stamp-body"],
  )
  assert.equal(receipt.finalObservation.state, "ABANDONED_PREPUBLICATION")
  assert.equal(snapshot.name, TERMINAL_RECOVERY_POLICY.abandonedTitle)
  assert.equal(snapshot.body, abandonedReleaseBody(record, digest))
})

test("apply resumes from asset-uploaded and performs only the stamp", async () => {
  const { bytes, snapshot, reader } = applyFixture({ state: "asset-uploaded" })
  const calls = []
  const receipt = await applyTerminalRecord({
    recordBytes: bytes,
    reviewedCommit: REVIEWED,
    reader,
    createWriter: () => stampingWriter(calls, snapshot),
    observer: async () => terminalObservation(),
    now: () => APPLY_NOW,
    wait: async () => {},
  })
  assert.deepEqual(
    calls.map(([name]) => name),
    ["patch"],
  )
  assert.equal(receipt.outcome, "performed")
})

test("apply on an already abandoned draft performs nothing and reports preexisting", async () => {
  const { bytes, snapshot, reader } = applyFixture({ state: "abandoned" })
  const calls = []
  const receipt = await applyTerminalRecord({
    recordBytes: bytes,
    reviewedCommit: REVIEWED,
    reader,
    createWriter: () => stampingWriter(calls, snapshot),
    observer: async () => terminalObservation(),
    now: () => APPLY_NOW,
    wait: async () => {},
  })
  assert.deepEqual(calls, [])
  assert.equal(receipt.outcome, "preexisting-abandoned")
  assert.deepEqual(receipt.transitions, [])
})

test("apply refuses evidence drift, a foreign authority, and a non-terminal observation", async () => {
  const drifted = applyFixture()
  drifted.reader.readNpmSweep = async () => ({
    observedAt: APPLY_SWEEPS[0],
    packages: boundRecord().evidence.npm.observations[0].packages.map((pkg, index) =>
      index === 0 ? { ...pkg, status: "PRESENT", httpStatus: 200, code: null } : pkg,
    ),
  })
  await assert.rejects(
    applyTerminalRecord({
      recordBytes: drifted.bytes,
      reviewedCommit: REVIEWED,
      reader: drifted.reader,
      createWriter: () => stampingWriter([], drifted.snapshot),
      observer: async () => ({}),
      now: () => APPLY_NOW,
      wait: async () => {},
    }),
    /absent/iu,
  )

  const runs = applyFixture()
  runs.reader.readReleaseRuns = async () => [
    { workflowRunId: 99, runAttempt: 1, status: "completed", publishJobStarted: false },
  ]
  await assert.rejects(
    applyTerminalRecord({
      recordBytes: runs.bytes,
      reviewedCommit: REVIEWED,
      reader: runs.reader,
      createWriter: () => stampingWriter([], runs.snapshot),
      observer: async () => ({}),
      now: () => APPLY_NOW,
      wait: async () => {},
    }),
    /fresh evidence does not match/iu,
  )

  const foreign = applyFixture()
  foreign.reader.readReviewedMergeAuthority = async () => ({ mergeCommitSha: "9".repeat(40) })
  await assert.rejects(
    applyTerminalRecord({
      recordBytes: foreign.bytes,
      reviewedCommit: REVIEWED,
      reader: foreign.reader,
      createWriter: () => stampingWriter([], foreign.snapshot),
      observer: async () => ({}),
      now: () => APPLY_NOW,
      wait: async () => {},
    }),
    /merge authority/iu,
  )

  for (const observation of [
    { ...terminalObservation(), state: "CANDIDATE_ESCROWED", disposition: "would-transition" },
    { ...terminalObservation(), disposition: "audit-only" },
    { ...terminalObservation(), conflicts: [{ code: "X" }] },
    { ...terminalObservation(), diagnostics: ["x"] },
  ]) {
    const fixture = applyFixture({ state: "abandoned" })
    await assert.rejects(
      applyTerminalRecord({
        recordBytes: fixture.bytes,
        reviewedCommit: REVIEWED,
        reader: fixture.reader,
        createWriter: () => stampingWriter([], fixture.snapshot),
        observer: async () => observation,
        now: () => APPLY_NOW,
        wait: async () => {},
      }),
      /not terminal/iu,
    )
  }
})

test("apply refuses a record whose escrow body cannot be reconstructed from its marker", async () => {
  // The escrow body is not stored, only its digest. A rerun against an already
  // stamped draft rebuilds that body from the record's predecessor marker, so
  // the rebuild must be proven to hash to the recorded digest.
  const fixture = applyFixture({
    state: "abandoned",
    record: { predecessor: { ...boundRecord().predecessor, bodySha256: "e".repeat(64) } },
  })
  await assert.rejects(
    applyTerminalRecord({
      recordBytes: fixture.bytes,
      reviewedCommit: REVIEWED,
      reader: fixture.reader,
      createWriter: () => stampingWriter([], fixture.snapshot),
      observer: async () => terminalObservation(),
      now: () => APPLY_NOW,
      wait: async () => {},
    }),
    /escrow body/iu,
  )
})

test("apply refuses a draft that is not abandoned after its own writes", async () => {
  const { bytes, snapshot, reader } = applyFixture()
  const inertWriter = {
    async uploadTombstoneIfAbsentAndEqual(input) {
      snapshot.assets = [
        ...snapshot.assets,
        { id: 777, name: "abandonment.json", sha256: input.sha256, size: input.bytes.byteLength },
      ]
      return { assetId: 777, name: "abandonment.json", status: "uploaded", sha256: input.sha256 }
    },
    // A writer that reports success without stamping must not be believed.
    async abandonCandidateIfCurrent() {
      return { atomic: false, outcome: "performed" }
    },
  }
  await assert.rejects(
    applyTerminalRecord({
      recordBytes: bytes,
      reviewedCommit: REVIEWED,
      reader,
      createWriter: () => inertWriter,
      observer: async () => terminalObservation(),
      now: () => APPLY_NOW,
      wait: async () => {},
    }),
    /not abandoned after apply/iu,
  )
})

const execFile = promisify(execFileCallback)
const REVIEWED_COMMITS = new Map()

function sink() {
  return {
    text: "",
    write(value) {
      this.text += value
      return true
    },
  }
}

function headCommit(root) {
  const commit = REVIEWED_COMMITS.get(root)
  assert.match(commit, /^[0-9a-f]{40}$/u)
  return commit
}

async function createPrivateRepository(t, { ignored = true, recordBytes = null } = {}) {
  const created = await mkdtemp(path.join(os.tmpdir(), "dawn-terminal-cli-"))
  const root = await realpath(created)
  t.after(async () => {
    const { rm } = await import("node:fs/promises")
    await rm(root, { recursive: true, force: true })
  })
  await execFile("git", ["init", "--quiet", root])
  await writeFile(path.join(root, ".gitignore"), ignored ? ".dawn/\n" : "elsewhere/\n")
  await mkdir(path.join(root, ".dawn/release-recovery"), { recursive: true, mode: 0o700 })
  await execFile("git", ["-C", root, "add", ".gitignore"])
  if (recordBytes !== null) {
    await mkdir(path.dirname(path.join(root, RECORD_PATH)), { recursive: true })
    await writeFile(path.join(root, RECORD_PATH), recordBytes)
    await execFile("git", ["-C", root, "add", RECORD_PATH])
  }
  await execFile("git", [
    "-C",
    root,
    "-c",
    "user.name=Recovery Test",
    "-c",
    "user.email=recovery@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ])
  const { stdout } = await execFile("git", ["-C", root, "rev-parse", "HEAD"])
  REVIEWED_COMMITS.set(root, stdout.trim())
  return root
}

/** The apply path proves its own authority, so the CLI's reader must answer it. */
function cliReader({ mergeCommitSha = null } = {}) {
  return Object.freeze({
    kind: "reader",
    async readReviewedMergeAuthority(sha) {
      return {
        mergeCommitSha: mergeCommitSha ?? sha,
        reviewedHeadSha: "5".repeat(40),
        pullRequestNumber: 600,
      }
    },
  })
}

function captureArgv(root) {
  return [
    "capture",
    "--reviewed-commit",
    headCommit(root),
    "--reason",
    REASON,
    "--output",
    CAPTURE_PATH,
  ]
}

function applyArgv(root) {
  return [
    "apply",
    "--record",
    RECORD_PATH,
    "--reviewed-commit",
    headCommit(root),
    FLAG,
    "--output",
    APPLY_PATH,
  ]
}

test("the runner captures a record durably at mode 0600 and only after validation", async (t) => {
  const root = await createPrivateRepository(t)
  const bytes = canonicalTerminalRecordBytes(boundRecord())
  const calls = []
  const stdout = sink()
  const stderr = sink()
  const result = await runAbandonCli({
    argv: captureArgv(root),
    cwd: root,
    environment: { GITHUB_TOKEN: "capture-token" },
    stdout,
    stderr,
    dependencies: {
      randomUUID: () => "12345678-1234-1234-9234-123456789abc",
      createReader(input) {
        calls.push(["reader", input.root, input.token])
        return Object.freeze({ kind: "reader" })
      },
      async captureTerminalRecord(input) {
        calls.push(["capture", input.reviewedCommit, input.reason, input.reader.kind])
        return bytes
      },
    },
  })

  assert.equal(result, 0)
  assert.equal(stdout.text, "Terminal record captured.\n")
  assert.equal(stderr.text, "")
  assert.deepEqual(calls, [
    ["reader", root, "capture-token"],
    ["capture", headCommit(root), REASON, "reader"],
  ])
  const output = path.join(root, CAPTURE_PATH)
  assert.deepEqual(await readFile(output), bytes)
  assert.equal((await lstat(output)).mode & 0o777, 0o600)
})

test("the runner refuses an unignored private path and a foreign output path", async (t) => {
  const root = await createPrivateRepository(t, { ignored: false })
  const stderr = sink()
  const result = await runAbandonCli({
    argv: captureArgv(root),
    cwd: root,
    environment: { GITHUB_TOKEN: "capture-token" },
    stdout: sink(),
    stderr,
    dependencies: {
      createReader: () => Object.freeze({ kind: "reader" }),
      captureTerminalRecord: async () => canonicalTerminalRecordBytes(boundRecord()),
    },
  })
  assert.equal(result, 1)
  assert.equal(stderr.text, "Terminal recovery failed.\n")
  await assert.rejects(readFile(path.join(root, CAPTURE_PATH)))

  const outside = await createPrivateRepository(t)
  const stderrTwo = sink()
  assert.equal(
    await runAbandonCli({
      argv: [
        "capture",
        "--reviewed-commit",
        headCommit(outside),
        "--reason",
        REASON,
        "--output",
        "scripts/x.json",
      ],
      cwd: outside,
      environment: { GITHUB_TOKEN: "capture-token" },
      stdout: sink(),
      stderr: stderrTwo,
      dependencies: {},
    }),
    2,
  )
  assert.equal(stderrTwo.text, "Invalid terminal recovery input.\n")
})

test("the runner refuses to write a record carrying the configured credential", async (t) => {
  const root = await createPrivateRepository(t)
  const leaked = Buffer.from(
    `${JSON.stringify({ leaked: "capture-token", schemaVersion: 1 })}\n`,
    "utf8",
  )
  const result = await runAbandonCli({
    argv: captureArgv(root),
    cwd: root,
    environment: { GITHUB_TOKEN: "capture-token" },
    stdout: sink(),
    stderr: sink(),
    dependencies: {
      createReader: () => Object.freeze({ kind: "reader" }),
      captureTerminalRecord: async () => leaked,
    },
  })
  assert.equal(result, 1)
  await assert.rejects(readFile(path.join(root, CAPTURE_PATH)))
})

test("the runner maps an uncertain cleanup onto exit 3", async (t) => {
  const root = await createPrivateRepository(t)
  const stderr = sink()
  const result = await runAbandonCli({
    argv: captureArgv(root),
    cwd: root,
    environment: { GITHUB_TOKEN: "capture-token" },
    stdout: sink(),
    stderr,
    dependencies: {
      createReader: () => Object.freeze({ kind: "reader" }),
      captureTerminalRecord: async () => {
        throw new RecoveryOutputCleanupUncertainError()
      },
    },
  })
  assert.equal(result, 3)
  assert.equal(stderr.text, "Terminal recovery output cleanup uncertain.\n")
})

test("the runner applies the reviewed record and writes a canonical receipt", async (t) => {
  const bytes = canonicalTerminalRecordBytes(boundRecord())
  const root = await createPrivateRepository(t, { recordBytes: bytes })
  const calls = []
  const stdout = sink()
  const receiptValue = {
    schemaVersion: 1,
    outcome: "performed",
    atomic: false,
    record: { path: RECORD_PATH, sha256: sha256(bytes), reviewedCommit: headCommit(root) },
  }
  const result = await runAbandonCli({
    argv: applyArgv(root),
    cwd: root,
    environment: { GITHUB_TOKEN: "apply-token" },
    stdout,
    stderr: sink(),
    dependencies: {
      randomUUID: () => "12345678-1234-1234-9234-123456789abc",
      createReader: () => cliReader(),
      createWriter: (input) => {
        calls.push(["writer", input.token])
        return Object.freeze({ kind: "writer" })
      },
      createObserver: (input) => {
        calls.push(["observer", input.root, input.terminalRecordRef])
        return async () => terminalObservation()
      },
      async applyTerminalRecord(input) {
        calls.push([
          "apply",
          input.reviewedCommit,
          input.reader.kind,
          input.recordBytes.equals(bytes),
        ])
        assert.equal(input.createWriter().kind, "writer")
        return receiptValue
      },
    },
  })

  assert.equal(result, 0)
  assert.equal(stdout.text, "Terminal recovery applied.\n")
  assert.deepEqual(calls, [
    ["observer", root, headCommit(root)],
    ["apply", headCommit(root), "reader", true],
    ["writer", "apply-token"],
  ])
  const written = await readFile(path.join(root, APPLY_PATH))
  assert.equal(
    written.toString("utf8"),
    `${JSON.stringify({
      atomic: false,
      outcome: "performed",
      record: {
        path: RECORD_PATH,
        reviewedCommit: headCommit(root),
        sha256: sha256(bytes),
      },
      schemaVersion: 1,
    })}\n`,
  )
  assert.equal((await lstat(path.join(root, APPLY_PATH))).mode & 0o777, 0o600)
})

test("the runner refuses a record that differs from the reviewed commit", async (t) => {
  const bytes = canonicalTerminalRecordBytes(boundRecord())
  const root = await createPrivateRepository(t, { recordBytes: bytes })
  await writeFile(
    path.join(root, RECORD_PATH),
    canonicalTerminalRecordBytes({ ...boundRecord(), reason: "other" }),
  )
  const stderr = sink()
  const applied = []
  const result = await runAbandonCli({
    argv: applyArgv(root),
    cwd: root,
    environment: { GITHUB_TOKEN: "apply-token" },
    stdout: sink(),
    stderr,
    dependencies: {
      createReader: () => cliReader(),
      createWriter: () => Object.freeze({ kind: "writer" }),
      createObserver: () => async () => terminalObservation(),
      applyTerminalRecord: async () => {
        applied.push("apply")
        return { schemaVersion: 1, outcome: "performed" }
      },
    },
  })
  assert.equal(result, 1)
  assert.deepEqual(applied, [], "the drifted record is never applied")
  assert.equal(stderr.text, "Terminal recovery failed. (code: RECORD_DISK_GIT_MISMATCH)\n")
  await assert.rejects(readFile(path.join(root, APPLY_PATH)))
})

test("the runner refuses to apply when the reviewed commit is not HEAD", async (t) => {
  // The reviewed commit is a real ancestor that still carries the identical
  // record, so every other apply check passes: only the HEAD fence refuses.
  const bytes = canonicalTerminalRecordBytes(boundRecord())
  const root = await createPrivateRepository(t, { recordBytes: bytes })
  const reviewed = headCommit(root)
  await execFile("git", [
    "-C",
    root,
    "-c",
    "user.name=Recovery Test",
    "-c",
    "user.email=recovery@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "later work",
  ])
  const applied = []
  const result = await runAbandonCli({
    argv: [
      "apply",
      "--record",
      RECORD_PATH,
      "--reviewed-commit",
      reviewed,
      FLAG,
      "--output",
      APPLY_PATH,
    ],
    cwd: root,
    environment: { GITHUB_TOKEN: "apply-token" },
    stdout: sink(),
    stderr: sink(),
    dependencies: {
      createReader: () => cliReader(),
      createWriter: () => Object.freeze({ kind: "writer" }),
      createObserver: () => async () => terminalObservation(),
      applyTerminalRecord: async () => {
        applied.push("apply")
        return { schemaVersion: 1, outcome: "performed" }
      },
    },
  })
  assert.equal(result, 1)
  assert.deepEqual(applied, [], "apply never runs off the reviewed commit")
  await assert.rejects(readFile(path.join(root, APPLY_PATH)))
})

test("the runner refuses a receipt carrying the configured credential", async (t) => {
  const bytes = canonicalTerminalRecordBytes(boundRecord())
  const root = await createPrivateRepository(t, { recordBytes: bytes })
  const stderr = sink()
  const result = await runAbandonCli({
    argv: applyArgv(root),
    cwd: root,
    environment: { GITHUB_TOKEN: "apply-token" },
    stdout: sink(),
    stderr,
    dependencies: {
      createReader: () => cliReader(),
      createWriter: () => Object.freeze({ kind: "writer" }),
      createObserver: () => async () => terminalObservation(),
      applyTerminalRecord: async () => ({ schemaVersion: 1, note: "apply-token" }),
    },
  })
  assert.equal(result, 1)
  // The apply already stamped the draft, so a refused receipt is a
  // post-mutation failure, not an inert one.
  assert.equal(
    stderr.text,
    "Terminal recovery failed after mutation; re-run apply to classify and finish. (code: OUTPUT_CREDENTIAL_LEAK)\n",
  )
  await assert.rejects(readFile(path.join(root, APPLY_PATH)))
  assert.ok(MAX_TERMINAL_RECORD_BYTES > 0)
})

test("the runner refuses to apply against a foreign reviewed merge authority", async (t) => {
  const bytes = canonicalTerminalRecordBytes(boundRecord())
  const root = await createPrivateRepository(t, { recordBytes: bytes })
  const applied = []
  const result = await runAbandonCli({
    argv: applyArgv(root),
    cwd: root,
    environment: { GITHUB_TOKEN: "apply-token" },
    stdout: sink(),
    stderr: sink(),
    dependencies: {
      createReader: () => cliReader({ mergeCommitSha: "c".repeat(40) }),
      createWriter: () => Object.freeze({ kind: "writer" }),
      createObserver: () => async () => terminalObservation(),
      applyTerminalRecord: async () => {
        applied.push("apply")
        return { schemaVersion: 1, outcome: "performed" }
      },
    },
  })
  assert.equal(result, 1)
  assert.deepEqual(applied, [], "apply never runs without proven merge authority")
  await assert.rejects(readFile(path.join(root, APPLY_PATH)))
})

test("the reconstructed escrow body is the manifest-rendered body, not the marker-only one", () => {
  // Guards the shape of the fixture itself: if these two ever agreed, the
  // reconstruction test below would prove nothing.
  assert.notEqual(escrowBody(), canonicalReleaseBody({ marker: sealedMarker(), manifest: null }))
  assert.ok(escrowBody().includes("| Package | Tarball | SHA-256 |"))
})

test("apply reruns against an abandoned draft by rebuilding the body from the manifest asset", async () => {
  const { bytes, snapshot, reader } = applyFixture({ state: "abandoned" })
  const manifestReads = []
  reader.readCanonicalManifest = async ({ escrowAssets }) => {
    manifestReads.push(escrowAssets.find(({ name }) => name === "manifest.json"))
    return sealedManifestBytes()
  }
  const calls = []
  const receipt = await applyTerminalRecord({
    recordBytes: bytes,
    reviewedCommit: REVIEWED,
    reader,
    createWriter: () => stampingWriter(calls, snapshot),
    observer: async () => terminalObservation(),
    now: () => APPLY_NOW,
    wait: async () => {},
  })
  assert.equal(receipt.outcome, "preexisting-abandoned")
  assert.deepEqual(calls, [], "a rerun on an abandoned draft writes nothing")
  assert.equal(manifestReads.length, 1)
  assert.equal(manifestReads[0].sha256, sealedMarker().manifestSha256)
})

test("apply refuses a manifest asset that is not the one the record sealed", async () => {
  const { bytes, snapshot, reader } = applyFixture({ state: "abandoned" })
  // Well-formed, parseable, candidate-consistent — but a different manifest, so
  // the body it renders cannot hash to the recorded escrow body digest.
  reader.readCanonicalManifest = async () => {
    const other = sealedManifest()
    return Buffer.from(
      `${JSON.stringify({ ...other, packages: other.packages.slice().reverse() })}\n`,
      "utf8",
    )
  }
  await assert.rejects(
    applyTerminalRecord({
      recordBytes: bytes,
      reviewedCommit: REVIEWED,
      reader,
      createWriter: () => stampingWriter([], snapshot),
      observer: async () => terminalObservation(),
      now: () => APPLY_NOW,
      wait: async () => {},
    }),
    { name: "TerminalRecoveryError", code: "ESCROW_BODY_IRREPRODUCIBLE" },
  )
})

test("the live reader addresses the manifest asset by the record's id and digest", async () => {
  const downloads = []
  const reader = createTerminalRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED}\n`,
    dependencies: {
      createDuplicateReader: () => ({}),
      createTerminalWriter: () => ({
        async readCanonicalSnapshot() {},
        async downloadCanonicalAsset(input) {
          downloads.push(input)
          return sealedManifestBytes()
        },
      }),
    },
  })
  const escrowAssets = boundRecord().evidence.escrowAssets
  const manifest = escrowAssets.find(({ name }) => name === "manifest.json")

  assert.deepEqual(await reader.readCanonicalManifest({ escrowAssets }), sealedManifestBytes())
  assert.equal(downloads.length, 1)
  assert.equal(downloads[0].assetId, manifest.id)
  assert.equal(downloads[0].expectedSha256, manifest.sha256)

  for (const assets of [
    escrowAssets.filter(({ name }) => name !== "manifest.json"),
    [...escrowAssets, { id: 1, name: "manifest.json", sha256: "f".repeat(64) }],
    undefined,
  ]) {
    await assert.rejects(reader.readCanonicalManifest({ escrowAssets: assets }), {
      code: "MANIFEST_ASSET_MISSING",
    })
  }
  assert.equal(downloads.length, 1, "no download is attempted without exactly one manifest asset")
})

test("the receipt records the apply run's own authority alongside the capture commit", async () => {
  const APPLY_COMMIT = "7".repeat(40)
  assert.notEqual(APPLY_COMMIT, REVIEWED)
  const { record, bytes, snapshot, reader } = applyFixture()
  const receipt = await applyTerminalRecord({
    recordBytes: bytes,
    reviewedCommit: APPLY_COMMIT,
    reader,
    createWriter: () => stampingWriter([], snapshot),
    observer: async () => terminalObservation(),
    now: () => APPLY_NOW,
    wait: async () => {},
  })
  assert.deepEqual(receipt.authority, { reviewedCommit: APPLY_COMMIT, operator: "blove" })
  assert.equal(receipt.record.reviewedCommit, record.authority.reviewedCommit)
  assert.equal(receipt.record.reviewedCommit, REVIEWED)
})

test("the live reader rejects a receipt foreign in any single bound field", async () => {
  const [first, second] = TERMINAL_RECOVERY_POLICY.duplicates
  const cases = [
    ["duplicateReleaseId", { receiptBoundTo: second.releaseId }],
    ["originalBodySha256", { receiptOriginalBodySha256: "a".repeat(64) }],
    ["baseAssetSetSha256", { receiptBaseAssetSetSha256: "b".repeat(64) }],
  ]
  for (const [field, overrides] of cases) {
    const fixtures = [
      duplicateFixture(first.releaseId, first.tagName, overrides),
      duplicateFixture(second.releaseId, second.tagName),
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
      { code: "DUPLICATE_RECEIPT_UNBOUND" },
      field,
    )
  }
})

test("the runner names a failure that left production changed", async (t) => {
  const bytes = canonicalTerminalRecordBytes(boundRecord())
  const root = await createPrivateRepository(t, { recordBytes: bytes })
  const stderr = sink()
  const failure = new TerminalRecoveryError(
    "NOT_ABANDONED_AFTER_APPLY",
    "Terminal recovery conflict: draft is not abandoned after apply",
  )
  Object.defineProperty(failure, "mutated", { value: true, enumerable: false })
  const result = await runAbandonCli({
    argv: applyArgv(root),
    cwd: root,
    environment: { GITHUB_TOKEN: "apply-token" },
    stdout: sink(),
    stderr,
    dependencies: {
      createReader: () => cliReader(),
      createWriter: () => Object.freeze({ kind: "writer" }),
      createObserver: () => async () => terminalObservation(),
      applyTerminalRecord: async () => {
        throw failure
      },
    },
  })
  assert.equal(result, 1)
  assert.equal(
    stderr.text,
    "Terminal recovery failed after mutation; re-run apply to classify and finish. (code: NOT_ABANDONED_AFTER_APPLY)\n",
  )
})

test("apply marks a post-write failure as mutated and an ambiguous first write too", async () => {
  const inert = applyFixture()
  await assert.rejects(
    applyTerminalRecord({
      recordBytes: inert.bytes,
      reviewedCommit: REVIEWED,
      reader: inert.reader,
      createWriter: () => ({
        async uploadTombstoneIfAbsentAndEqual(input) {
          inert.snapshot.assets = [
            ...inert.snapshot.assets,
            {
              id: 777,
              name: "abandonment.json",
              sha256: input.sha256,
              size: input.bytes.byteLength,
            },
          ]
          return {
            assetId: 777,
            name: "abandonment.json",
            status: "uploaded",
            sha256: input.sha256,
          }
        },
        async abandonCandidateIfCurrent() {
          return { atomic: false, outcome: "performed" }
        },
      }),
      observer: async () => terminalObservation(),
      now: () => APPLY_NOW,
      wait: async () => {},
    }),
    (error) => error.mutated === true && error.code === "NOT_ABANDONED_AFTER_APPLY",
  )

  const ambiguous = applyFixture()
  await assert.rejects(
    applyTerminalRecord({
      recordBytes: ambiguous.bytes,
      reviewedCommit: REVIEWED,
      reader: ambiguous.reader,
      createWriter: () => ({
        async uploadTombstoneIfAbsentAndEqual() {
          throw Object.assign(new Error("ambiguous"), { code: "MUTATION_OUTCOME_AMBIGUOUS" })
        },
      }),
      observer: async () => terminalObservation(),
      now: () => APPLY_NOW,
      wait: async () => {},
    }),
    // No transition was recorded, but the request went out: the operator must
    // still be told production may have changed.
    (error) => error.mutated === true,
  )
})

/** Apply-command dependencies that succeed, so a test can fail one later step. */
function successfulApplyDependencies(extra = {}) {
  return {
    createReader: () => cliReader(),
    createWriter: () => Object.freeze({ kind: "writer" }),
    createObserver: () => async () => terminalObservation(),
    applyTerminalRecord: async () => ({ schemaVersion: 1, outcome: "performed" }),
    ...extra,
  }
}

test("the runner reports a post-apply output-policy failure as a post-mutation failure", async (t) => {
  const bytes = canonicalTerminalRecordBytes(boundRecord())
  const root = await createPrivateRepository(t, { recordBytes: bytes })
  const stderr = sink()
  // The apply lands, then the ignore-policy re-check that guards the commit
  // fails: production is changed even though nothing was written locally.
  let checkIgnores = 0
  const result = await runAbandonCli({
    argv: applyArgv(root),
    cwd: root,
    environment: { GITHUB_TOKEN: "apply-token" },
    stdout: sink(),
    stderr,
    dependencies: successfulApplyDependencies({
      async runGit(command, args, options) {
        if (args.includes("check-ignore")) {
          checkIgnores += 1
          if (checkIgnores === 2) throw new Error("ignore check unavailable")
        }
        const { execFile: run } = await import("node:child_process")
        return await new Promise((resolve, reject) => {
          run(command, args, options, (error, stdout) =>
            error === null ? resolve(stdout) : reject(error),
          )
        })
      },
    }),
  })

  assert.equal(result, 1)
  assert.equal(
    stderr.text,
    "Terminal recovery failed after mutation; re-run apply to classify and finish.\n",
  )
  await assert.rejects(readFile(path.join(root, APPLY_PATH)))
})

test("a post-apply cleanup-uncertain failure still exits 3 and names the mutation", async (t) => {
  const bytes = canonicalTerminalRecordBytes(boundRecord())
  const root = await createPrivateRepository(t, { recordBytes: bytes })
  const stderr = sink()
  const result = await runAbandonCli({
    argv: applyArgv(root),
    cwd: root,
    environment: { GITHUB_TOKEN: "apply-token" },
    stdout: sink(),
    stderr,
    dependencies: successfulApplyDependencies({
      // The receipt is linked into place and then every cleanup unlink fails,
      // so the local output outcome is genuinely uncertain.
      fileSystem: {
        ...nodeFileSystem,
        unlink: async () => {
          throw Object.assign(new Error("unlink unavailable"), { code: "EIO" })
        },
      },
    }),
  })

  assert.equal(result, 3, "an uncertain local cleanup still owns the exit code")
  assert.equal(
    stderr.text,
    "Terminal recovery failed after mutation; re-run apply to classify and finish.\n",
  )
})

test("a non-terminal final observation after the stamp tells the operator to escalate", async (t) => {
  const bytes = canonicalTerminalRecordBytes(boundRecord())
  const root = await createPrivateRepository(t, { recordBytes: bytes })
  const stderr = sink()
  const failure = new TerminalRecoveryError(
    "FINAL_OBSERVATION_NOT_TERMINAL",
    "Final observation is not terminal for the candidate",
  )
  Object.defineProperty(failure, "mutated", { value: true, enumerable: false })
  const result = await runAbandonCli({
    argv: applyArgv(root),
    cwd: root,
    environment: { GITHUB_TOKEN: "apply-token" },
    stdout: sink(),
    stderr,
    dependencies: successfulApplyDependencies({
      applyTerminalRecord: async () => {
        throw failure
      },
    }),
  })

  assert.equal(result, 1)
  assert.equal(
    stderr.text,
    "Terminal recovery stamped the draft but the final observation is not terminal; keep the freeze, preserve the receipt path, and escalate — do not re-run apply. (code: FINAL_OBSERVATION_NOT_TERMINAL)\n",
  )
})
