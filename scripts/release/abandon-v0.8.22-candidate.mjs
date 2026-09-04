#!/usr/bin/env node
// scripts/release/abandon-v0.8.22-candidate.mjs
//
// One-time, candidate-pinned operator command that records the terminal
// recovery of the disabled-era v0.8.22 candidate. `capture` produces the
// git-resident terminal record; `apply` (a later change) stamps the canonical
// draft to match a record that a reviewed pull request has already merged.
// Delete this file in the cleanup pull request after v0.8.23 is terminal.

import * as defaultFileSystem from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { canonicalAbandonmentReleaseBody } from "./abandonment.mjs"
import {
  assetSetSha256,
  baseAssetNamespaceFromMarker,
  DUPLICATE_DRAFT_RECOVERY_POLICY,
  recoveryReceiptAssetName,
  sameAssetSet,
} from "./duplicate-draft-recovery.mjs"
import {
  createDuplicateDraftRecoveryReader,
  parseCanonicalRecoveryReceipt,
  RECOVERY_MAX_ASSET_BYTES,
  sha256,
} from "./duplicate-draft-recovery-adapters.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "./manifest.mjs"
import {
  abandonmentReleaseMarker,
  canonicalReleaseBody,
  parseReleaseMarker,
  releaseBodySha256,
} from "./metadata.mjs"
import { parseProductionManifest } from "./observe.mjs"
import {
  ACKNOWLEDGEMENT_FLAG,
  assertPrivatePathBoundary,
  assertReviewedIgnorePolicy,
  assertUnusedOutput,
  createNormalProductionRecoveryObserver,
  diagnosticCodeSuffix,
  environmentToken,
  normalizePrivatePath,
  normalizeRuntime,
  RecoveryInputError,
  RecoveryOutputCleanupUncertainError,
  readBoundedPrivateFile,
  reserveExclusiveOutput,
  resolvePrivatePath,
  writeSuccessBestEffort,
} from "./recover-v0.8.22-duplicate-drafts.mjs"
import {
  canonicalTerminalRecordBytes,
  MAX_TERMINAL_RECORD_BYTES,
  parseOperatorRecoveryRecord,
  terminalRecordPath,
} from "./terminal-record-store.mjs"
import { createTerminalRecoveryWriter } from "./terminal-recovery-adapters.mjs"

export { sha256 }

/**
 * Every conflict this command raises. The name is registered in the recovery
 * CLI's `RECOVERY_ERROR_NAMES`, so `diagnosticCodeSuffix` prints the code on
 * stderr: an operator holding the edit freeze can tell "re-capture" from
 * "a write may have landed" without instrumenting the module.
 */
export class TerminalRecoveryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "TerminalRecoveryError"
    this.code = code
  }
}

function conflict(code, message) {
  throw new TerminalRecoveryError(code, message)
}

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
const CANONICAL_DRAFT_TAG_NAME = "untagged-be0ff4bee4ba43b521a9"
const MANIFEST_ASSET_NAME = "manifest.json"
/**
 * The sealed manifest is downloaded through the terminal writer's canonical
 * asset boundary, which refuses any requested maximum above its OWN asset cap
 * — so this bound is derived from that cap rather than chosen independently. An
 * independent number is not merely redundant: the first production rerun asked
 * for 1 MiB and was refused with "Canonical asset download request is invalid"
 * before any read. The real `manifest.json` asset is 11,928 bytes, so the
 * boundary's 64 KiB cap leaves better than five times headroom.
 */
const MAX_MANIFEST_ASSET_BYTES = RECOVERY_MAX_ASSET_BYTES
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const MAX_REASON_BYTES = 4_096
const MAX_ARGUMENT_BYTES = 4_096
const MAX_ARGUMENTS = 8
const NPM_SWEEP_GAP_MS = 60_000
/**
 * Waiting exactly the minimum gap loses a capture to a clock edge: the record
 * store rejects two sweeps whose recorded times round to less than sixty
 * seconds apart. The margin is small enough that the fifteen-minute evidence
 * span the store also enforces is never at risk.
 */
export const NPM_SWEEP_MARGIN_MS = 5_000
const PACKAGE_NAMES = Object.freeze([...CANONICAL_RELEASE_PACKAGE_ORDER].sort())
const READER_METHODS = Object.freeze([
  "readReviewedMergeAuthority",
  "readOperatorLogin",
  "readCandidateTag",
  "readCanonicalSnapshot",
  "readCanonicalManifest",
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
    conflict("REVIEWED_MERGE_AUTHORITY_NOT_EXACT", "Reviewed merge authority is not exact")
  }
  const operator = await reader.readOperatorLogin()
  const tag = await reader.readCandidateTag()
  if (
    tag?.name !== `v${policy.version}` ||
    !SHA_PATTERN.test(tag?.objectSha) ||
    tag?.commitSha !== policy.candidateSha
  ) {
    conflict("CANDIDATE_TAG_IDENTITY_NOT_EXACT", "Candidate tag identity is not exact")
  }

  const snapshot = await reader.readCanonicalSnapshot()
  if (snapshot?.releaseId !== policy.canonicalReleaseId) {
    conflict("CANONICAL_DRAFT_IDENTITY_NOT_EXACT", "Canonical draft identity is not exact")
  }
  if (snapshot.name !== policy.escrowTitle) {
    conflict("CANONICAL_DRAFT_TITLE_FOREIGN", "Canonical draft title is not the escrow title")
  }
  if (
    snapshot.draft !== true ||
    snapshot.prerelease !== false ||
    snapshot.immutable !== false ||
    snapshot.targetCommitish !== "main"
  ) {
    conflict("CANONICAL_DRAFT_NOT_MUTABLE", "Canonical draft is not a mutable draft on main")
  }
  // The writer's normalizer pins the tag name too, but a capture that trusted
  // it could not tell a substituted reader from the real boundary.
  if (snapshot.tagName !== CANONICAL_DRAFT_TAG_NAME) {
    conflict(
      "CANONICAL_DRAFT_TAG_NAME_FOREIGN",
      "Canonical draft tag name is not the pinned tag name",
    )
  }
  const marker = parseMarkerOrThrow(snapshot.body)
  if (
    marker.phase !== "ESCROWED" ||
    marker.version !== policy.version ||
    marker.commitSha !== policy.candidateSha ||
    marker.attestationSet === null
  ) {
    conflict("CANONICAL_DRAFT_BODY_NOT_ESCROW", "Canonical draft body is not the escrow marker")
  }
  const assets = normalizeAssets(snapshot.assets)
  if (assets.some(({ name }) => name === TOMBSTONE_ASSET_NAME)) {
    conflict(
      "TOMBSTONE_ALREADY_PRESENT",
      "Canonical draft already carries an abandonment tombstone",
    )
  }
  if (assets.length !== policy.baseAssetCount) {
    conflict(
      "BASE_ASSET_COUNT_NOT_EXACT",
      "Canonical draft does not carry exactly the 45 base assets",
    )
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
    conflict(
      "BASE_ASSET_SET_NOT_MARKER_DERIVED",
      "Canonical draft assets are not the marker's base asset set",
    )
  }

  const firstSweep = normalizeSweep(await reader.readNpmSweep(), policy.version)
  await wait(NPM_SWEEP_GAP_MS + NPM_SWEEP_MARGIN_MS)
  const secondSweep = normalizeSweep(await reader.readNpmSweep(), policy.version)
  if (Date.parse(secondSweep.observedAt) - Date.parse(firstSweep.observedAt) < NPM_SWEEP_GAP_MS) {
    conflict("NPM_SWEEP_GAP_TOO_SHORT", "npm sweeps are not sixty seconds apart")
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
  if (!baseExact) conflict("BASE_ASSETS_CHANGED", "Terminal recovery conflict: base assets changed")
  if (tombstones.length > 1) {
    conflict("DUPLICATE_TOMBSTONE_ASSETS", "Terminal recovery conflict: duplicate tombstone assets")
  }
  const tombstoneExact = tombstones.length === 1 && tombstones[0].sha256 === recordSha256
  if (tombstones.length === 1 && !tombstoneExact) {
    conflict("FOREIGN_TOMBSTONE_ASSET", "Terminal recovery conflict: foreign tombstone asset")
  }
  const bodySha = releaseBodySha256(snapshot.body)
  if (bodySha === record.predecessor.bodySha256 && snapshot.name === policy.escrowTitle) {
    return tombstoneExact ? "asset-uploaded" : "escrowed"
  }
  if (tombstoneExact && snapshot.name === policy.abandonedTitle) {
    const marker = parseMarkerOrThrow(snapshot.body)
    // The marker and digest alone would accept a body with trailing operator
    // prose appended after the stamp; the abandoned state means exactly the
    // bytes this command writes and nothing else.
    if (
      marker.phase === "ABANDONED_PREPUBLICATION" &&
      marker.abandonmentSha256 === recordSha256 &&
      snapshot.body === abandonedReleaseBody(record, recordSha256)
    ) {
      return "abandoned"
    }
  }
  return conflict("LADDER_CONFLICT", "Terminal recovery conflict: unrecognized draft state")
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

    /**
     * The sealed manifest asset of the canonical draft, by the exact ID and
     * digest the record's escrow assets name.
     *
     * The ESCROWED Release body is rendered WITH this manifest (its package
     * table is three columns, not the manifest-free two), so a rerun that has
     * to reconstruct that body cannot do so without these bytes. The download
     * goes through the same title-tolerant writer boundary as every other
     * canonical read, which refuses any asset the live draft does not list.
     */
    async readCanonicalManifest({ escrowAssets } = {}) {
      if (!Array.isArray(escrowAssets)) {
        conflict("MANIFEST_ASSET_MISSING", "Canonical manifest asset inventory is invalid")
      }
      const manifests = escrowAssets.filter(({ name }) => name === MANIFEST_ASSET_NAME)
      if (manifests.length !== 1) {
        conflict("MANIFEST_ASSET_MISSING", "Canonical draft manifest asset is not exactly one")
      }
      return writer.downloadCanonicalAsset({
        assetId: manifests[0].id,
        expectedSha256: manifests[0].sha256,
        maximumBytes: MAX_MANIFEST_ASSET_BYTES,
      })
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
          conflict("NPM_PACKAGE_PRESENT", `npm package ${name} is not absent`)
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
            conflict(
              "PUBLISH_JOB_COVERAGE_FOREIGN",
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
        conflict(
          "DUPLICATE_RECEIPTS_BODY_MISSING",
          "Duplicate recovery receipts require the archived original body",
        )
      }
      // The archived body IS the escrow marker body, so it carries the exact
      // base-asset digest each receipt must have been derived from.
      const expectedMarker = parseReleaseMarker(expectedOriginalBody)
      const expectedBodySha256 = releaseBodySha256(expectedOriginalBody)
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
          conflict(
            "DUPLICATE_EVIDENCE_SET_FOREIGN",
            `Duplicate ${duplicate.releaseId} does not carry exactly its archive and receipt`,
          )
        }
        // Evidence assets are appended in `EVIDENCE_KIND_ORDER`, and the kinds
        // are now pinned to exactly ["body", "receipt"], so the receipt is the
        // last asset by construction.
        const receipt = snapshot.assets.at(-1)
        if (
          receipt === undefined ||
          receipt.name !== recoveryReceiptAssetName(duplicate.releaseId)
        ) {
          conflict(
            "DUPLICATE_RECEIPT_MISSING",
            `Duplicate ${duplicate.releaseId} has no recovery receipt asset`,
          )
        }
        // The reader proves the receipt's bytes hash to its listed digest, but
        // not what those bytes SAY. Parse them and bind the receipt to this
        // candidate and this duplicate: a valid receipt written for the other
        // quarantined draft would otherwise pass every digest check.
        // `parseCanonicalRecoveryReceipt` already pins the repository, the
        // version, the candidate SHA, and the canonical Release ID to this
        // recovery's policy — a receipt naming any other candidate does not
        // re-canonicalize and is rejected there. What it CANNOT know is which
        // draft the receipt is sitting on, or which escrow body and base-asset
        // set this capture is reading, so those three are bound here.
        const parsed = parseCanonicalRecoveryReceipt(Buffer.from(receipt.bytes ?? "", "utf8"))
        if (
          parsed.duplicateReleaseId !== duplicate.releaseId ||
          parsed.originalBodySha256 !== expectedBodySha256 ||
          parsed.baseAssetSetSha256 !== expectedMarker.baseAssetSetSha256
        ) {
          conflict(
            "DUPLICATE_RECEIPT_UNBOUND",
            `Duplicate ${duplicate.releaseId} recovery receipt is not bound to this candidate`,
          )
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
  if (typeof body !== "string")
    conflict("CANONICAL_DRAFT_BODY_MISSING", "Canonical draft body is missing")
  return parseReleaseMarker(body)
}

function normalizeAssets(value) {
  if (!Array.isArray(value))
    conflict("RELEASE_ASSETS_INVALID", "Release asset inventory is invalid")
  const names = new Set()
  const ids = new Set()
  return value.map((asset) => {
    if (
      !Number.isSafeInteger(asset?.id) ||
      typeof asset?.name !== "string" ||
      !SHA256_PATTERN.test(asset?.sha256)
    ) {
      conflict("RELEASE_ASSET_INVALID", "Release asset is invalid")
    }
    // Names and IDs identify an asset everywhere downstream — the tombstone
    // partition, the base-asset set comparison, the ladder classification — so
    // a listing that repeats either is ambiguous, not merely redundant.
    if (names.has(asset.name) || ids.has(asset.id)) {
      conflict("RELEASE_ASSETS_REPEATED", "Release asset inventory repeats an asset")
    }
    names.add(asset.name)
    ids.add(asset.id)
    return { id: asset.id, name: asset.name, sha256: asset.sha256 }
  })
}

function normalizeSweep(value, version) {
  if (!Array.isArray(value?.packages) || typeof value?.observedAt !== "string") {
    conflict("NPM_SWEEP_INVALID", "npm sweep is invalid")
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
    conflict("NPM_SWEEP_INVENTORY_FOREIGN", "npm sweep package inventory is not canonical")
  }
  for (const pkg of packages) {
    if (
      pkg.version !== version ||
      pkg.status !== "ABSENT" ||
      pkg.httpStatus !== 404 ||
      pkg.code !== "E404"
    ) {
      conflict("NPM_PACKAGE_PRESENT", `npm package ${pkg.name}@${version} is not absent`)
    }
  }
  return { observedAt: value.observedAt, packages }
}

function normalizeRuns(value) {
  if (!Array.isArray(value) || value.length === 0) {
    conflict("RELEASE_RUNS_INVALID", "Release run inventory is invalid")
  }
  return value.map((run) => {
    if (run?.status !== "completed" || run?.publishJobStarted !== false) {
      conflict(
        "RELEASE_RUN_PUBLISHED",
        "A candidate Release run is nonterminal or started publishing",
      )
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
    conflict("DUPLICATE_RECEIPTS_INVALID", "Duplicate recovery receipts are invalid")
  }
  for (const [index, duplicate] of duplicates.entries()) {
    if (duplicate?.releaseId !== policy.duplicates[index].releaseId) {
      conflict("DUPLICATE_RECEIPT_ORDER_FOREIGN", "Duplicate recovery receipt order is not exact")
    }
  }
  if (value.finalAuthorizationReceiptSha256 !== FINAL_AUTHORIZATION_RECEIPT_SHA256) {
    conflict(
      "FINAL_AUTHORIZATION_DIGEST_FOREIGN",
      "Final authorization receipt digest is not the pinned digest",
    )
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

/**
 * Apply the merged record to the canonical draft with compare-before-write.
 *
 * Fresh evidence is re-captured and must equal the record on everything but
 * time and the operator identity; only then does the ladder perform the
 * transitions the live draft is actually missing. After the writes the draft is
 * re-read and re-classified, and the normal production observer must report the
 * candidate terminal — the receipt is never written on a guess.
 */
export async function applyTerminalRecord({
  recordBytes,
  reviewedCommit,
  reader,
  createWriter,
  observer,
  now = Date.now,
  wait = defaultWait,
}) {
  if (!SHA_PATTERN.test(reviewedCommit)) throw new TypeError("Reviewed commit is invalid")
  if (typeof createWriter !== "function" || typeof observer !== "function") {
    throw new TypeError("Apply dependencies are invalid")
  }
  assertReader(reader)
  const record = parseOperatorRecoveryRecord(recordBytes)
  const recordSha256 = record.sha256
  const policy = TERMINAL_RECOVERY_POLICY
  const startedAt = new Date(now()).toISOString()

  const authority = await reader.readReviewedMergeAuthority(reviewedCommit)
  if (authority?.mergeCommitSha !== reviewedCommit) {
    conflict("REVIEWED_MERGE_AUTHORITY_NOT_EXACT", "Reviewed merge authority is not exact")
  }

  // Fresh evidence must agree with the record on everything but time. The
  // capture path only knows how to read an escrowed draft, so a rerun after a
  // successful stamp presents it the escrow identity the record describes.
  const fresh = parseOperatorRecoveryRecord(
    await captureTerminalRecord({
      // The APPLY-time reviewed commit, never the record's capture-time one.
      // The reader authorizes a merge authority only for local HEAD, and at
      // apply time HEAD is the record pull request's merge commit — a different
      // pull request from the one the capture ran at, which no longer exists as
      // HEAD anywhere. Passing the capture-time commit refuses the whole apply
      // with REVIEWED_COMMIT_NOT_LOCAL_HEAD. This is safe because
      // `assertSameEvidence` ignores `authority` entirely: the capture-time
      // commit stays in the record and is reported in the receipt, while the
      // live reads are authorized by the commit this run is fenced to.
      reviewedCommit,
      reason: record.reason,
      reader: {
        ...readerMethods(reader),
        async readCanonicalSnapshot() {
          return escrowedViewOfSnapshot(
            await reader.readCanonicalSnapshot(),
            record,
            recordSha256,
            reader,
          )
        },
      },
      now,
      wait,
    }),
  )
  assertSameEvidence(fresh, record)

  const operator = await reader.readOperatorLogin()
  const authorityOfRun = { reviewedCommit, operator }

  const snapshot = await reader.readCanonicalSnapshot()
  let state = classifyAbandonmentState({ record, recordSha256, snapshot })
  if (state === "abandoned") {
    const finalObservation = await requireTerminal(observer, policy)
    return receipt({
      record,
      outcome: "preexisting-abandoned",
      transitions: [],
      startedAt,
      now,
      finalObservation,
      authority: authorityOfRun,
    })
  }

  const writer = createWriter()
  const transitions = []
  const expectedSnapshot = expectedWriterSnapshot(snapshot, policy)
  try {
    if (state === "escrowed") {
      const upload = await writer.uploadTombstoneIfAbsentAndEqual({
        expectedSnapshot,
        expectedTagObjectSha: record.tag.objectSha,
        bytes: recordBytes,
        sha256: recordSha256,
      })
      transitions.push({ name: "upload-tombstone", result: upload })
      expectedSnapshot.assets = [
        ...expectedSnapshot.assets,
        {
          id: upload.assetId,
          name: TOMBSTONE_ASSET_NAME,
          sha256: recordSha256,
          size: recordBytes.byteLength,
        },
      ]
      state = "asset-uploaded"
    }
    if (state === "asset-uploaded") {
      const patch = await writer.abandonCandidateIfCurrent({
        expectedSnapshot,
        expectedTagObjectSha: record.tag.objectSha,
        expectedBodySha256: record.predecessor.bodySha256,
        expectedTombstoneSha256: recordSha256,
        expectedName: policy.abandonedTitle,
        expectedBody: abandonedReleaseBody(record, recordSha256),
      })
      transitions.push({ name: "stamp-body", result: patch })
    }
    const after = await reader.readCanonicalSnapshot()
    if (classifyAbandonmentState({ record, recordSha256, snapshot: after }) !== "abandoned") {
      conflict(
        "NOT_ABANDONED_AFTER_APPLY",
        "Terminal recovery conflict: draft is not abandoned after apply",
      )
    }
    const finalObservation = await requireTerminal(observer, policy)
    return receipt({
      record,
      outcome: "performed",
      transitions,
      startedAt,
      now,
      finalObservation,
      authority: authorityOfRun,
    })
  } catch (error) {
    // Anything thrown once a write has landed — or once a write was issued
    // whose outcome cannot be proven — leaves production changed. The operator
    // must be told to re-run apply (which re-classifies the ladder) rather than
    // to re-capture, so mark the failure rather than reporting it as inert.
    throw markMutated(error, transitions.length > 0)
  }
}

/**
 * Flag a failure that leaves the canonical draft changed. `MUTATION_OUTCOME_AMBIGUOUS`
 * counts even before a transition is recorded: the writer issued the request
 * and could not prove it did not land.
 */
function markMutated(error, performed) {
  if (!performed && error?.code !== "MUTATION_OUTCOME_AMBIGUOUS") return error
  try {
    Object.defineProperty(error, "mutated", { value: true, enumerable: false })
    return error
  } catch {
    const wrapped = new TerminalRecoveryError(
      typeof error?.code === "string" ? error.code : "TERMINAL_RECOVERY_FAILED",
      "Terminal recovery failed after a production write",
    )
    wrapped.mutated = true
    wrapped.cause = error
    return wrapped
  }
}

/** Bind the reader's own methods so the evidence wrapper cannot lose `this`. */
function readerMethods(reader) {
  return Object.fromEntries(READER_METHODS.map((name) => [name, reader[name].bind(reader)]))
}

/**
 * Present the live draft as the escrowed draft the record describes, so a rerun
 * against an already-stamped draft still re-captures comparable evidence. Only
 * a draft this command has already proven abandoned is rewritten this way; any
 * other drift is a conflict raised by the classification itself.
 */
async function escrowedViewOfSnapshot(snapshot, record, recordSha256, reader) {
  const state = classifyAbandonmentState({ record, recordSha256, snapshot })
  if (state === "escrowed") return snapshot
  // Past the first rung the draft carries the tombstone the record itself
  // seals, and past the second it carries the abandonment stamp. Both are this
  // command's own writes, already proven exact by the classification, so the
  // evidence view sees the escrowed draft the record describes underneath them.
  const escrowed = {
    ...snapshot,
    assets: normalizeAssets(snapshot.assets).filter(({ name }) => name !== TOMBSTONE_ASSET_NAME),
  }
  if (state === "asset-uploaded") return escrowed
  return {
    ...escrowed,
    name: TERMINAL_RECOVERY_POLICY.escrowTitle,
    body: await escrowBodyFromRecord(record, reader),
  }
}

/**
 * The escrow body is not stored in the record, only its digest and its marker.
 *
 * That body was rendered WITH the sealed manifest — a three-column package
 * table — so rebuilding it from the marker alone produces different bytes and a
 * different digest. Fetch the manifest asset the record's escrow assets name,
 * render the body exactly as production does, and prove the rebuild is the very
 * body the record sealed; otherwise the evidence comparison would run against a
 * body nobody ever published.
 */
async function escrowBodyFromRecord(record, reader) {
  const manifestBytes = await reader.readCanonicalManifest({
    escrowAssets: record.evidence.escrowAssets,
  })
  const candidate = { version: record.version, commitSha: record.commitSha }
  let body
  try {
    // The very parser production observation renders the body with, so a
    // manifest that would not parse there cannot be used to fake a match here.
    const manifest = parseProductionManifest(manifestBytes, { candidate })
    body = canonicalReleaseBody({ marker: record.predecessor.marker, manifest })
  } catch (error) {
    throw new TerminalRecoveryError(
      "ESCROW_BODY_IRREPRODUCIBLE",
      `Terminal recovery conflict: recorded escrow body is not reproducible (${error.name})`,
    )
  }
  if (releaseBodySha256(body) !== record.predecessor.bodySha256) {
    conflict(
      "ESCROW_BODY_IRREPRODUCIBLE",
      "Terminal recovery conflict: recorded escrow body is not reproducible",
    )
  }
  return body
}

/** Exactly the nine fields the terminal writer fences on, and nothing else. */
function expectedWriterSnapshot(snapshot, policy) {
  if (snapshot?.releaseId !== policy.canonicalReleaseId) {
    conflict("CANONICAL_DRAFT_IDENTITY_NOT_EXACT", "Canonical draft identity is not exact")
  }
  return {
    releaseId: snapshot.releaseId,
    tagName: snapshot.tagName,
    name: snapshot.name,
    targetCommitish: snapshot.targetCommitish,
    draft: snapshot.draft,
    prerelease: snapshot.prerelease,
    immutable: snapshot.immutable,
    body: snapshot.body,
    assets: snapshot.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      sha256: asset.sha256,
      size: asset.size,
    })),
  }
}

/**
 * Fresh evidence equals the record except for the two things that MUST differ
 * on a later run: the capture authority (its operator, clock, and reviewed
 * commit) and the npm sweeps' own observation times. Everything else — the
 * escrow assets, the Release runs, the duplicate receipts, the predecessor, the
 * tag — is compared byte for byte in canonical form.
 */
function assertSameEvidence(fresh, record) {
  const strip = ({ authority: _authority, sha256: _digest, evidence, ...rest }) => ({
    ...rest,
    evidence: {
      ...evidence,
      npm: { observations: evidence.npm.observations.map(({ packages }) => ({ packages })) },
    },
  })
  if (JSON.stringify(strip(fresh)) !== JSON.stringify(strip(record))) {
    conflict(
      "EVIDENCE_DRIFT",
      "Terminal recovery conflict: fresh evidence does not match the record",
    )
  }
}

/** The normal production observer must call the candidate terminal, with nothing outstanding. */
async function requireTerminal(observer, policy) {
  const observed = await observer({
    candidate: { version: policy.version, commitSha: policy.candidateSha },
  })
  // Terminal states plan as disposition "noop" in planner.mjs, not "audit-only".
  if (
    observed?.state !== "ABANDONED_PREPUBLICATION" ||
    observed?.disposition !== "noop" ||
    !Array.isArray(observed?.conflicts) ||
    observed.conflicts.length !== 0 ||
    !Array.isArray(observed?.diagnostics) ||
    observed.diagnostics.length !== 0
  ) {
    conflict(
      "FINAL_OBSERVATION_NOT_TERMINAL",
      "Final observation is not terminal for the candidate",
    )
  }
  return {
    state: observed.state,
    disposition: observed.disposition,
    nextTransition: observed.nextTransition ?? null,
    conflicts: [],
    diagnostics: [],
  }
}

function receipt({ record, outcome, transitions, startedAt, now, finalObservation, authority }) {
  return {
    schemaVersion: 1,
    atomic: false,
    startedAt,
    appliedAt: new Date(now()).toISOString(),
    // `record.reviewedCommit` is the commit the RECORD was captured from;
    // `authority.reviewedCommit` is the commit this APPLY ran at. They are
    // different pull requests by design, so the receipt names both.
    authority: { reviewedCommit: authority.reviewedCommit, operator: authority.operator },
    record: {
      path: terminalRecordPath(record.version),
      sha256: record.sha256,
      reviewedCommit: record.authority.reviewedCommit,
    },
    candidate: {
      version: record.version,
      commitSha: record.commitSha,
      releaseId: record.predecessor.releaseId,
    },
    outcome,
    transitions,
    finalObservation,
  }
}

export const ABANDON_DEPENDENCY_FIELDS = Object.freeze([
  "applyTerminalRecord",
  "captureTerminalRecord",
  "createObserver",
  "createReader",
  "createWriter",
  "fileSystem",
  "randomUUID",
  "resolveRepositoryRoot",
  "runGit",
])

/**
 * The operator entry point. `capture` is read-only and writes the candidate
 * terminal record to a private path; `apply` stamps the canonical draft to
 * match a record a reviewed pull request has already merged, and writes the
 * write-once final receipt. Exit codes mirror the duplicate-draft recovery
 * command: 0 success, 2 invalid input, 3 output cleanup uncertain, 1 otherwise.
 */
export async function runAbandonCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  dependencies = {},
} = {}) {
  let reservation = null
  // Set once production may have changed, so a failure between the apply and
  // the committed receipt is reported as a post-mutation failure rather than an
  // inert one. A `preexisting-abandoned` apply performs no write of its own,
  // but "re-run apply" is still the correct instruction: the rerun
  // re-classifies the ladder and finishes.
  let mutated = false
  try {
    const options = parseAbandonCliArguments(argv)
    const runtime = normalizeRuntime({
      cwd,
      environment,
      stdout,
      stderr,
      dependencies,
      allowedDependencies: ABANDON_DEPENDENCY_FIELDS,
    })
    const root = await runtime.resolveRepositoryRoot(runtime.cwd, runtime.runGit)
    const output = resolvePrivatePath(root, options.output)
    await assertPrivatePathBoundary(runtime.fileSystem, root, output)
    await assertReviewedIgnorePolicy({
      fileSystem: runtime.fileSystem,
      root,
      reviewedCommit: options.reviewedCommit,
      relativePaths: [output.relative],
      runGit: runtime.runGit,
    })
    await assertUnusedOutput(runtime.fileSystem, output.absolute)
    reservation = await reserveExclusiveOutput(runtime, output.absolute)
    const token = environmentToken(runtime.environment)
    const reader = runtime.createReader({ root, token, run: runtime.runGit })

    if (options.command === "capture") {
      const bytes = await runtime.captureTerminalRecord({
        reviewedCommit: options.reviewedCommit,
        reason: options.reason,
        reader,
      })
      assertCredentialFreeBytes(bytes, token, "Terminal record")
      await reassertOutputPolicy(runtime, root, output, options.reviewedCommit)
      await reservation.commit(bytes, MAX_TERMINAL_RECORD_BYTES)
      reservation = null
      writeSuccessBestEffort(runtime.stdout, "Terminal record captured.\n")
      return 0
    }

    const receiptBytes = await applyReviewedRecord(runtime, root, options, reader, token)
    mutated = true
    assertCredentialFreeBytes(receiptBytes, token, "Terminal recovery receipt")
    await reassertOutputPolicy(runtime, root, output, options.reviewedCommit)
    await reservation.commit(receiptBytes, MAX_TERMINAL_RECORD_BYTES)
    reservation = null
    writeSuccessBestEffort(runtime.stdout, "Terminal recovery applied.\n")
    return 0
  } catch (error) {
    let cleanupUncertain = error instanceof RecoveryOutputCleanupUncertainError
    if (reservation !== null) {
      try {
        await reservation.abort()
      } catch (cleanupError) {
        if (cleanupError instanceof RecoveryOutputCleanupUncertainError) cleanupUncertain = true
      }
    }
    const input = error instanceof RecoveryInputError
    try {
      // What happened to PRODUCTION outranks what happened to the local output
      // file: an operator holding the freeze must be told the draft changed
      // even when the receipt could not be written. The exit code still reports
      // the local outcome, so an uncertain cleanup stays a 3.
      stderr.write(
        failureMessage(error, {
          mutated: mutated || error?.mutated === true,
          cleanupUncertain,
          input,
        }),
      )
    } catch {}
    return cleanupUncertain ? 3 : input ? 2 : 1
  }
}

/**
 * The one line an operator acts on. A non-terminal final observation after the
 * stamp gets its own sentence: the draft is already abandoned, so a rerun
 * classifies as `preexisting-abandoned` and re-runs the very observation that
 * just failed — it cannot fix anything, and repeating it wastes the freeze.
 */
function failureMessage(error, { mutated, cleanupUncertain, input }) {
  if (input) return "Invalid terminal recovery input.\n"
  if (mutated) {
    return error?.code === "FINAL_OBSERVATION_NOT_TERMINAL"
      ? `Terminal recovery stamped the draft but the final observation is not terminal; keep the freeze, preserve the receipt path, and escalate — do not re-run apply.${diagnosticCodeSuffix(error)}\n`
      : `Terminal recovery failed after mutation; re-run apply to classify and finish.${diagnosticCodeSuffix(error)}\n`
  }
  if (cleanupUncertain) return "Terminal recovery output cleanup uncertain.\n"
  return `Terminal recovery failed.${diagnosticCodeSuffix(error)}\n`
}

/**
 * The apply command: three fences, then the network write.
 *
 * 1. The checkout is exactly the reviewed merge commit, so the record on disk,
 *    the record in git, and the ref the observer reads the record at are one
 *    and the same tree.
 * 2. That commit is the merge commit of exactly one reviewed pull request.
 * 3. The record on disk is byte-identical to the record at that commit.
 *
 * Extracted so those fences visibly precede any production mutation.
 */
async function applyReviewedRecord(runtime, root, options, reader, token) {
  // The apply run happens from a clean clone checked out at the record pull
  // request's merge commit, so the record on disk, the record in git, and the
  // ref the observer reads the record at are provably one and the same tree.
  const head = await gitText(runtime, root, ["rev-parse", "HEAD"])
  if (head.trim() !== options.reviewedCommit) {
    conflict(
      "CHECKOUT_NOT_REVIEWED_COMMIT",
      "Terminal recovery checkout is not the reviewed commit",
    )
  }
  const merge = await reader.readReviewedMergeAuthority(options.reviewedCommit)
  if (merge?.mergeCommitSha !== options.reviewedCommit) {
    conflict("REVIEWED_MERGE_AUTHORITY_NOT_EXACT", "Reviewed merge authority is not exact")
  }
  const recordBytes = await readBoundedPrivateFile(
    runtime.fileSystem,
    path.join(root, options.record),
    MAX_TERMINAL_RECORD_BYTES,
    { requirePrivateMode: false },
  )
  const committed = await gitBytes(runtime, root, [
    "show",
    `${options.reviewedCommit}:${options.record}`,
  ])
  if (!committed.equals(recordBytes)) {
    conflict("RECORD_DISK_GIT_MISMATCH", "Terminal record on disk differs from the reviewed commit")
  }
  const observer = runtime.createObserver({
    root,
    token,
    fileSystem: runtime.fileSystem,
    runGit: runtime.runGit,
    terminalRecordRef: options.reviewedCommit,
  })
  const result = await runtime.applyTerminalRecord({
    recordBytes,
    reviewedCommit: options.reviewedCommit,
    reader,
    createWriter: () => runtime.createWriter({ token }),
    observer,
  })
  return Buffer.from(`${JSON.stringify(canonicalizeJson(result))}\n`, "utf8")
}

/**
 * TOCTOU guard: every await since the first boundary check is a window for the
 * output path or the reviewed ignore policy to change underneath the process,
 * so both are re-proven immediately before the commit.
 */
async function reassertOutputPolicy(runtime, root, output, reviewedCommit) {
  await assertPrivatePathBoundary(runtime.fileSystem, root, output)
  await assertReviewedIgnorePolicy({
    fileSystem: runtime.fileSystem,
    root,
    reviewedCommit,
    relativePaths: [output.relative],
    runGit: runtime.runGit,
  })
}

function assertCredentialFreeBytes(bytes, token, label) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
    conflict("OUTPUT_BYTES_INVALID", `${label} bytes are invalid`)
  }
  if (bytes.includes(Buffer.from(token, "utf8"))) {
    conflict("OUTPUT_CREDENTIAL_LEAK", `${label} contains the configured credential`)
  }
}

async function gitText(runtime, root, args) {
  const output = await runtime.runGit("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8 * 1024,
    windowsHide: true,
  })
  if (typeof output !== "string") conflict("GIT_OUTPUT_INVALID", "Recovery Git output is invalid")
  return output
}

async function gitBytes(runtime, root, args) {
  const output = await runtime.runGit("git", ["-C", root, ...args], {
    encoding: "buffer",
    timeout: 10_000,
    maxBuffer: MAX_TERMINAL_RECORD_BYTES,
    windowsHide: true,
  })
  if (Buffer.isBuffer(output)) return output
  if (typeof output === "string") return Buffer.from(output, "utf8")
  return conflict("GIT_OUTPUT_INVALID", "Recovery Git output is invalid")
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((key) => [key, canonicalizeJson(value[key])]),
    )
  }
  return value
}

const executedPath =
  process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href
if (executedPath === import.meta.url) {
  process.exitCode = await runAbandonCli({
    dependencies: {
      applyTerminalRecord,
      captureTerminalRecord,
      createObserver: createNormalProductionRecoveryObserver,
      createReader: createTerminalRecoveryReader,
      createWriter: createTerminalRecoveryWriter,
      fileSystem: defaultFileSystem,
    },
  })
}
