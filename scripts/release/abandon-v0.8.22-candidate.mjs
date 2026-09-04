#!/usr/bin/env node
// scripts/release/abandon-v0.8.22-candidate.mjs
//
// One-time, candidate-pinned operator command that records the terminal
// recovery of the disabled-era v0.8.22 candidate. `capture` produces the
// git-resident terminal record; `apply` (a later change) stamps the canonical
// draft to match a record that a reviewed pull request has already merged.
// Delete this file in the cleanup pull request after v0.8.23 is terminal.

import { createHash } from "node:crypto"

import { canonicalAbandonmentReleaseBody } from "./abandonment.mjs"
import {
  assetSetSha256,
  baseAssetNamespaceFromMarker,
  DUPLICATE_DRAFT_RECOVERY_POLICY,
  sameAssetSet,
} from "./duplicate-draft-recovery.mjs"
import { createDuplicateDraftRecoveryReader } from "./duplicate-draft-recovery-adapters.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "./manifest.mjs"
import { abandonmentReleaseMarker, parseReleaseMarker, releaseBodySha256 } from "./metadata.mjs"
import {
  ACKNOWLEDGEMENT_FLAG,
  normalizePrivatePath,
  RecoveryInputError,
} from "./recover-v0.8.22-duplicate-drafts.mjs"
import {
  canonicalTerminalRecordBytes,
  parseOperatorRecoveryRecord,
  terminalRecordPath,
} from "./terminal-record-store.mjs"
import { createTerminalRecoveryWriter } from "./terminal-recovery-adapters.mjs"

export const TERMINAL_RECOVERY_POLICY = Object.freeze({
  repository: DUPLICATE_DRAFT_RECOVERY_POLICY.repository,
  version: DUPLICATE_DRAFT_RECOVERY_POLICY.version,
  candidateSha: DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha,
  canonicalReleaseId: DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId,
  duplicates: DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates,
  escrowTitle: "Dawn v0.8.22",
  abandonedTitle: "Dawn v0.8.22 (abandoned before publication)",
  baseAssetCount: 45,
})

/**
 * SHA-256 of `.dawn/release-recovery/v0.8.22-apply-01.json`, the attempt-01
 * final-authorization receipt of the duplicate-draft recovery, as recorded in
 * the operator ledger on 2026-09-03. It is a constant of this pinned recovery:
 * the receipt is not a Release asset, so it cannot be re-derived from GitHub,
 * and pinning it here keeps a mistyped or substituted digest out of the record.
 */
export const FINAL_AUTHORIZATION_RECEIPT_SHA256 =
  "6bc224470f1240193b3bb65cb3d21d340d548d9279556e360b611f7a1f3c0875"

const TOMBSTONE_ASSET_NAME = "abandonment.json"
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const MAX_REASON_BYTES = 4_096
const MAX_ARGUMENT_BYTES = 4_096
const MAX_ARGUMENTS = 8
const NPM_SWEEP_GAP_MS = 60_000
const PACKAGE_NAMES = Object.freeze([...CANONICAL_RELEASE_PACKAGE_ORDER].sort())
const READER_METHODS = Object.freeze([
  "readReviewedMergeAuthority",
  "readOperatorLogin",
  "readCandidateTag",
  "readCanonicalSnapshot",
  "readNpmSweep",
  "readReleaseRuns",
  "readDuplicateRecoveryReceipts",
])

export function parseAbandonCliArguments(argv) {
  const values = snapshotArgumentArray(argv)
  if (
    values.length === 7 &&
    values[0] === "capture" &&
    values[1] === "--reviewed-commit" &&
    SHA_PATTERN.test(values[2]) &&
    values[3] === "--reason" &&
    isReason(values[4]) &&
    values[5] === "--output"
  ) {
    return Object.freeze({
      command: "capture",
      reviewedCommit: values[2],
      reason: values[4],
      output: normalizePrivatePath(values[6]),
    })
  }
  if (
    values.length === 8 &&
    values[0] === "apply" &&
    values[1] === "--record" &&
    values[2] === terminalRecordPath(TERMINAL_RECOVERY_POLICY.version) &&
    values[3] === "--reviewed-commit" &&
    SHA_PATTERN.test(values[4]) &&
    values[5] === ACKNOWLEDGEMENT_FLAG &&
    values[6] === "--output"
  ) {
    return Object.freeze({
      command: "apply",
      record: values[2],
      reviewedCommit: values[4],
      output: normalizePrivatePath(values[7]),
    })
  }
  throw new RecoveryInputError()
}

/**
 * Copy `argv` onto exactly its own bounded, control-character-free string
 * elements. Mirrors the duplicate-draft command's argument snapshot: an
 * inherited or accessor-backed index is never read as an argument.
 */
function snapshotArgumentArray(value) {
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) throw new RecoveryInputError()
  const output = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length === 0 ||
      Buffer.byteLength(descriptor.value, "utf8") > MAX_ARGUMENT_BYTES ||
      hasControlCharacters(descriptor.value)
    ) {
      throw new RecoveryInputError()
    }
    output.push(descriptor.value)
  }
  return Object.freeze(output)
}

/** The abandonment reason is bounded plain text, exactly as the record store demands. */
function isReason(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !hasControlCharacters(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_REASON_BYTES
  )
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127
  })
}

/**
 * Read-only capture: every read is fresh, the candidate draft must be exactly
 * the escrowed canonical identity, npm must be absent on two sweeps at least
 * sixty seconds apart, and no publish-npm job may ever have started.
 */
export async function captureTerminalRecord({
  reviewedCommit,
  reason,
  reader,
  now = Date.now,
  wait = defaultWait,
}) {
  if (!SHA_PATTERN.test(reviewedCommit)) throw new TypeError("Reviewed commit is invalid")
  if (!isReason(reason)) throw new TypeError("Abandonment reason is invalid")
  assertReader(reader)
  const policy = TERMINAL_RECOVERY_POLICY

  const authority = await reader.readReviewedMergeAuthority(reviewedCommit)
  if (authority?.mergeCommitSha !== reviewedCommit) {
    throw new Error("Reviewed merge authority is not exact")
  }
  const operator = await reader.readOperatorLogin()
  const tag = await reader.readCandidateTag()
  if (
    tag?.name !== `v${policy.version}` ||
    !SHA_PATTERN.test(tag?.objectSha) ||
    tag?.commitSha !== policy.candidateSha
  ) {
    throw new Error("Candidate tag identity is not exact")
  }

  const snapshot = await reader.readCanonicalSnapshot()
  if (snapshot?.releaseId !== policy.canonicalReleaseId) {
    throw new Error("Canonical draft identity is not exact")
  }
  if (snapshot.name !== policy.escrowTitle) {
    throw new Error("Canonical draft title is not the escrow title")
  }
  if (
    snapshot.draft !== true ||
    snapshot.immutable !== false ||
    snapshot.targetCommitish !== "main"
  ) {
    throw new Error("Canonical draft is not a mutable draft on main")
  }
  const marker = parseMarkerOrThrow(snapshot.body)
  if (
    marker.phase !== "ESCROWED" ||
    marker.version !== policy.version ||
    marker.commitSha !== policy.candidateSha ||
    marker.attestationSet === null
  ) {
    throw new Error("Canonical draft body is not the escrow marker")
  }
  const assets = normalizeAssets(snapshot.assets)
  if (assets.some(({ name }) => name === TOMBSTONE_ASSET_NAME)) {
    throw new Error("Canonical draft already carries an abandonment tombstone")
  }
  if (assets.length !== policy.baseAssetCount) {
    throw new Error("Canonical draft does not carry exactly the 45 base assets")
  }
  // The marker's own base-asset digest must be self-consistent AND describe the
  // assets the draft actually carries. Its order comes from the attestation
  // subjects, never from GitHub's listing order, so it is derived from the
  // marker and compared as a set — the same recipe the duplicate-draft recovery
  // uses on the quarantined drafts.
  const expectedBaseAssets = baseAssetNamespaceFromMarker(marker)
  if (
    expectedBaseAssets === null ||
    expectedBaseAssets.length !== policy.baseAssetCount ||
    assetSetSha256(expectedBaseAssets) !== marker.baseAssetSetSha256 ||
    !sameAssetSet(expectedBaseAssets, assets)
  ) {
    throw new Error("Canonical draft assets are not the marker's base asset set")
  }

  const firstSweep = normalizeSweep(await reader.readNpmSweep(), policy.version)
  await wait(NPM_SWEEP_GAP_MS)
  const secondSweep = normalizeSweep(await reader.readNpmSweep(), policy.version)
  if (Date.parse(secondSweep.observedAt) - Date.parse(firstSweep.observedAt) < NPM_SWEEP_GAP_MS) {
    throw new Error("npm sweeps are not sixty seconds apart")
  }
  const releaseRuns = normalizeRuns(await reader.readReleaseRuns())
  // The duplicates are read AFTER the canonical draft on purpose: verifying
  // each duplicate's archived original-body asset needs the canonical body.
  const duplicateRecovery = normalizeDuplicateRecovery(
    await reader.readDuplicateRecoveryReceipts({ expectedOriginalBody: snapshot.body }),
    policy,
  )

  // The capture clock is read AFTER both sweeps so `capturedAt` can never
  // precede its own evidence, which the record store rejects.
  const capturedAt = new Date(now()).toISOString()
  const record = {
    schemaVersion: 1,
    kind: "abandoned-prepublication",
    version: policy.version,
    commitSha: policy.candidateSha,
    tag: { name: tag.name, objectSha: tag.objectSha, commitSha: tag.commitSha },
    reason,
    predecessor: {
      state: "CANDIDATE_ESCROWED",
      releaseId: policy.canonicalReleaseId,
      releaseStatus: "draft",
      bodySha256: releaseBodySha256(snapshot.body),
      marker,
      artifact: {
        manifestSha256: marker.manifestSha256,
        releaseRecordSha256: marker.releaseRecordSha256,
        baseAssetSetSha256: marker.baseAssetSetSha256,
        attestationSet: marker.attestationSet,
      },
    },
    evidence: {
      escrowAssets: assets,
      npm: { observations: [firstSweep, secondSweep] },
      releaseRuns,
      duplicateRecovery,
    },
    authority: { mode: "operator-recovery", operator, capturedAt, reviewedCommit },
  }
  const bytes = canonicalTerminalRecordBytes(record)
  parseOperatorRecoveryRecord(bytes)
  return bytes
}

/** Classify the live draft into exactly one ladder state or throw a conflict. */
export function classifyAbandonmentState({ record, recordSha256, snapshot }) {
  const policy = TERMINAL_RECOVERY_POLICY
  if (!SHA256_PATTERN.test(recordSha256)) throw new TypeError("Terminal record digest is invalid")
  const assets = normalizeAssets(snapshot.assets)
  const base = assets.filter((asset) => asset.name !== TOMBSTONE_ASSET_NAME)
  const tombstones = assets.filter((asset) => asset.name === TOMBSTONE_ASSET_NAME)
  const expectedBase = new Map(record.evidence.escrowAssets.map((asset) => [asset.name, asset]))
  const baseExact =
    base.length === policy.baseAssetCount &&
    base.every(
      (asset) =>
        expectedBase.get(asset.name)?.sha256 === asset.sha256 &&
        expectedBase.get(asset.name)?.id === asset.id,
    )
  if (!baseExact) throw new Error("Terminal recovery conflict: base assets changed")
  if (tombstones.length > 1) {
    throw new Error("Terminal recovery conflict: duplicate tombstone assets")
  }
  const tombstoneExact = tombstones.length === 1 && tombstones[0].sha256 === recordSha256
  if (tombstones.length === 1 && !tombstoneExact) {
    throw new Error("Terminal recovery conflict: foreign tombstone asset")
  }
  const bodySha = releaseBodySha256(snapshot.body)
  if (bodySha === record.predecessor.bodySha256 && snapshot.name === policy.escrowTitle) {
    return tombstoneExact ? "asset-uploaded" : "escrowed"
  }
  if (tombstoneExact && snapshot.name === policy.abandonedTitle) {
    const marker = parseMarkerOrThrow(snapshot.body)
    if (marker.phase === "ABANDONED_PREPUBLICATION" && marker.abandonmentSha256 === recordSha256) {
      return "abandoned"
    }
  }
  throw new Error("Terminal recovery conflict: unrecognized draft state")
}

/** The exact canonical body the abandonment stamp writes for `record`. */
export function abandonedReleaseBody(record, recordSha256) {
  const marker = abandonmentReleaseMarker({
    candidate: { version: record.version, commitSha: record.commitSha },
    artifact: record.predecessor.artifact,
    abandonmentSha256: recordSha256,
    previousMarker: record.predecessor.marker,
  })
  const { sha256: _digest, ...tombstone } = record
  return canonicalAbandonmentReleaseBody({
    marker,
    tombstone,
    previousMarker: record.predecessor.marker,
  })
}

/**
 * The live reader for the terminal recovery.
 *
 * The canonical draft is read ONLY through the title-tolerant terminal writer:
 * the duplicate-draft reader pins the escrow title, so once the draft is
 * stamped that reader can no longer see it at all. Every other read — the
 * reviewed merge authority, the annotated tag, the Release runs and their
 * publish jobs, npm absence, and the two duplicates' receipt assets — comes
 * from the duplicate reader unchanged.
 */
export function createTerminalRecoveryReader({
  root,
  token,
  run,
  now = Date.now,
  dependencies = {},
} = {}) {
  const createDuplicateReader =
    dependencies.createDuplicateReader ?? createDuplicateDraftRecoveryReader
  const createTerminalWriter = dependencies.createTerminalWriter ?? createTerminalRecoveryWriter
  const base = createDuplicateReader({ root, token, run })
  const writer = createTerminalWriter({ token })

  return Object.freeze({
    readReviewedMergeAuthority(reviewedCommit) {
      return base.readReviewedMergeAuthority(reviewedCommit)
    },

    readCanonicalSnapshot() {
      return writer.readCanonicalSnapshot()
    },

    readOperatorLogin() {
      return base.readAuthenticatedLogin()
    },

    async readCandidateTag() {
      const tag = await base.readCandidateTag()
      return Object.freeze({
        name: `v${tag.version}`,
        objectSha: tag.tagObjectSha,
        commitSha: tag.commitSha,
      })
    },

    async readNpmSweep() {
      // `readNpmAbsence` fails closed unless the registry answered exactly
      // HTTP 404 / E404 for that name@version, so the recorded status fields
      // are the constants that read proved rather than a re-derived guess.
      const packages = []
      for (const name of PACKAGE_NAMES) {
        const absence = await base.readNpmAbsence(name)
        if (absence?.status !== "absent" || absence.version !== TERMINAL_RECOVERY_POLICY.version) {
          throw new Error(`npm package ${name} is not absent`)
        }
        packages.push({
          name,
          version: TERMINAL_RECOVERY_POLICY.version,
          status: "ABSENT",
          httpStatus: 404,
          code: "E404",
        })
      }
      return { observedAt: new Date(now()).toISOString(), packages }
    },

    async readReleaseRuns() {
      const { candidateRuns } = await base.readReleaseRuns()
      const runs = []
      for (const candidateRun of candidateRuns) {
        const jobs = await base.readCandidatePublishJobs(candidateRun.id, candidateRun.runAttempt)
        // `normalizeCandidateJobs` already refuses a listing that does not carry
        // exactly one publish-npm job per attempt; this loop re-proves it rather
        // than trusting that invariant from a distance.
        // Jobs cover every attempt of the run, and the runbook's verifier walks
        // them attempt by attempt: each attempt must carry exactly one
        // publish-npm job, and the run counts as having started publishing
        // unless every one of those jobs never started.
        let publishJobStarted = false
        for (let attempt = 1; attempt <= candidateRun.runAttempt; attempt += 1) {
          const publishers = jobs.filter(
            (job) => job.runAttempt === attempt && job.name === "publish-npm",
          )
          if (publishers.length !== 1) {
            throw new Error(
              `Candidate run ${candidateRun.id} attempt ${attempt} publish-npm job coverage is not exact`,
            )
          }
          if (!publishJobNeverStarted(publishers[0])) publishJobStarted = true
        }
        runs.push({
          workflowRunId: candidateRun.id,
          runAttempt: candidateRun.runAttempt,
          status: candidateRun.status,
          publishJobStarted,
        })
      }
      return runs
    },

    /**
     * Read both quarantined duplicates' recovery receipts.
     *
     * `expectedOriginalBody` is the canonical draft's live escrow body, which
     * each duplicate archived before it was quarantined. The duplicate reader
     * REQUIRES it: without it every recovery evidence asset on those drafts is
     * rejected as `RECOVERY_ASSET_UNEXPECTED`. With it, the reader downloads the
     * archive and proves it is byte-identical to that body, and returns the
     * receipt's own verified bytes and digest.
     */
    async readDuplicateRecoveryReceipts({ expectedOriginalBody } = {}) {
      if (typeof expectedOriginalBody !== "string" || expectedOriginalBody.length === 0) {
        throw new Error("Duplicate recovery receipts require the archived original body")
      }
      const duplicates = []
      for (const duplicate of TERMINAL_RECOVERY_POLICY.duplicates) {
        const snapshot = await base.readReleaseSnapshot(duplicate.releaseId, {
          expectedOriginalBody,
        })
        // The snapshot appends its evidence assets after the base assets in
        // `evidenceAssets` order, so the receipt is addressed by kind rather
        // than by rescanning names the reader has already classified.
        const kinds = snapshot.evidenceAssets
        if (!Array.isArray(kinds) || JSON.stringify(kinds) !== '["body","receipt"]') {
          throw new Error(
            `Duplicate ${duplicate.releaseId} does not carry exactly its archive and receipt`,
          )
        }
        const receipt =
          snapshot.assets[snapshot.assets.length - kinds.length + kinds.indexOf("receipt")]
        if (receipt === undefined) {
          throw new Error(`Duplicate ${duplicate.releaseId} has no recovery receipt asset`)
        }
        duplicates.push({
          releaseId: duplicate.releaseId,
          receiptAssetId: receipt.id,
          receiptSha256: receipt.sha256,
        })
      }
      return {
        duplicates,
        finalAuthorizationReceiptSha256: FINAL_AUTHORIZATION_RECEIPT_SHA256,
      }
    },
  })
}

/**
 * A publish-npm job never ran iff it is still queued and unstarted, or it
 * completed as skipped. This is the runbook verifier's exact predicate
 * (docs/superpowers/runbooks/2026-08-09-release-integrity-cutover.md).
 *
 * A null `startedAt` is NOT the test: GitHub stamps `started_at` on a skipped
 * job, and the duplicate reader's own job coherence check requires a
 * `started_at` on every completed job — so all five real v0.8.22 candidate
 * runs, whose publish-npm jobs are completed/skipped, would read as started.
 */
function publishJobNeverStarted(job) {
  return (
    (job.status === "queued" && job.conclusion === null && job.startedAt === null) ||
    (job.status === "completed" && job.conclusion === "skipped")
  )
}

function parseMarkerOrThrow(body) {
  if (typeof body !== "string") throw new Error("Canonical draft body is missing")
  return parseReleaseMarker(body)
}

function normalizeAssets(value) {
  if (!Array.isArray(value)) throw new Error("Release asset inventory is invalid")
  return value.map((asset) => {
    if (
      !Number.isSafeInteger(asset?.id) ||
      typeof asset?.name !== "string" ||
      !SHA256_PATTERN.test(asset?.sha256)
    ) {
      throw new Error("Release asset is invalid")
    }
    return { id: asset.id, name: asset.name, sha256: asset.sha256 }
  })
}

function normalizeSweep(value, version) {
  if (!Array.isArray(value?.packages) || typeof value?.observedAt !== "string") {
    throw new Error("npm sweep is invalid")
  }
  const packages = value.packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    status: pkg.status,
    httpStatus: pkg.httpStatus,
    code: pkg.code,
  }))
  const names = packages.map((pkg) => pkg.name)
  if (JSON.stringify(names) !== JSON.stringify(PACKAGE_NAMES)) {
    throw new Error("npm sweep package inventory is not canonical")
  }
  for (const pkg of packages) {
    if (
      pkg.version !== version ||
      pkg.status !== "ABSENT" ||
      pkg.httpStatus !== 404 ||
      pkg.code !== "E404"
    ) {
      throw new Error(`npm package ${pkg.name}@${version} is not absent`)
    }
  }
  return { observedAt: value.observedAt, packages }
}

function normalizeRuns(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Release run inventory is invalid")
  }
  return value.map((run) => {
    if (run?.status !== "completed" || run?.publishJobStarted !== false) {
      throw new Error("A candidate Release run is nonterminal or started publishing")
    }
    return {
      workflowRunId: run.workflowRunId,
      runAttempt: run.runAttempt,
      status: "completed",
      publishJobStarted: false,
    }
  })
}

function normalizeDuplicateRecovery(value, policy) {
  const duplicates = value?.duplicates
  if (!Array.isArray(duplicates) || duplicates.length !== 2) {
    throw new Error("Duplicate recovery receipts are invalid")
  }
  for (const [index, duplicate] of duplicates.entries()) {
    if (duplicate?.releaseId !== policy.duplicates[index].releaseId) {
      throw new Error("Duplicate recovery receipt order is not exact")
    }
  }
  if (value.finalAuthorizationReceiptSha256 !== FINAL_AUTHORIZATION_RECEIPT_SHA256) {
    throw new Error("Final authorization receipt digest is not the pinned digest")
  }
  return {
    duplicates: duplicates.map((duplicate) => ({
      releaseId: duplicate.releaseId,
      receiptAssetId: duplicate.receiptAssetId,
      receiptSha256: duplicate.receiptSha256,
    })),
    finalAuthorizationReceiptSha256: FINAL_AUTHORIZATION_RECEIPT_SHA256,
  }
}

function assertReader(reader) {
  for (const method of READER_METHODS) {
    if (typeof reader?.[method] !== "function") {
      throw new TypeError(`Terminal recovery reader lacks ${method}`)
    }
  }
}

function defaultWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}
