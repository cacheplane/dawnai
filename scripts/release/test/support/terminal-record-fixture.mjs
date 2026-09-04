import { createHash } from "node:crypto"

import { baseAssetNamespaceFromMarker } from "../../duplicate-draft-recovery.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../../manifest.mjs"

export const VERSION = "0.8.22"
export const COMMIT_SHA = "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8"
export const TAG_OBJECT_SHA = "3".repeat(40)
export const REVIEWED_COMMIT = "4".repeat(40)
const SHA256_A = "a".repeat(64)
const SHA256_B = "b".repeat(64)
const SHA256_C = "c".repeat(64)

export function attestationSet() {
  return {
    repository: "cacheplane/dawnai",
    workflow: ".github/workflows/release.yml",
    sourceRef: `refs/tags/v${VERSION}`,
    commitSha: COMMIT_SHA,
    workflowRunId: 33418085547,
    runAttempt: 1,
    subjects: [
      {
        subjectName: "manifest.json",
        subjectSha256: SHA256_A,
        bundleName: "manifest.json.intoto.jsonl",
        bundleSha256: SHA256_B,
      },
      ...[...CANONICAL_RELEASE_PACKAGE_ORDER].sort().map((name) => ({
        subjectName: `${name.replace("@", "").replace("/", "-")}-${VERSION}.tgz`,
        subjectSha256: SHA256_A,
        bundleName: `${name.replace("@", "").replace("/", "-")}-${VERSION}.tgz.intoto.jsonl`,
        bundleSha256: SHA256_B,
      })),
    ],
  }
}

/**
 * The 45-member base-asset namespace this marker describes, in the exact order
 * the controller hashes it, and that order-dependent digest. Both are derived
 * from the marker rather than fixed, so the fixture stays self-consistent: the
 * terminal capture command re-derives `baseAssetSetSha256` from the live assets
 * and would reject a marker whose digest did not describe them.
 */
export function baseAssetNamespace() {
  return baseAssetNamespaceFromMarker({
    manifestSha256: SHA256_A,
    releaseRecordSha256: SHA256_B,
    attestationSet: attestationSet(),
  })
}

export function baseAssetSetSha256() {
  const namespace = baseAssetNamespace().map(({ name, sha256 }) => ({ name, sha256 }))
  return createHash("sha256")
    .update(`${JSON.stringify(namespace)}\n`, "utf8")
    .digest("hex")
}

export function predecessorMarker() {
  return {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 2,
    phase: "ESCROWED",
    version: VERSION,
    commitSha: COMMIT_SHA,
    tag: `v${VERSION}`,
    manifestSha256: SHA256_A,
    releaseRecordSha256: SHA256_B,
    baseAssetSetSha256: baseAssetSetSha256(),
    attestationSet: attestationSet(),
    npmEvidenceSha256: null,
    smoke: null,
    audit: null,
    abandonmentSha256: null,
  }
}

export function npmObservation(observedAt) {
  return {
    observedAt,
    packages: [...CANONICAL_RELEASE_PACKAGE_ORDER].sort().map((name) => ({
      name,
      version: VERSION,
      status: "ABSENT",
      httpStatus: 404,
      code: "E404",
    })),
  }
}

function escrowAssets() {
  // Exactly the namespace the marker's digest covers, so the live assets the
  // capture command reads back agree with `baseAssetSetSha256` by construction.
  return baseAssetNamespace().map(({ name, sha256 }, index) => ({
    id: 1000 + index,
    name,
    sha256,
  }))
}

export function record(overrides = {}) {
  const base = {
    schemaVersion: 1,
    kind: "abandoned-prepublication",
    version: VERSION,
    commitSha: COMMIT_SHA,
    tag: { name: `v${VERSION}`, objectSha: TAG_OBJECT_SHA, commitSha: COMMIT_SHA },
    reason: "The tag-era release workflow cannot observe draft Releases; superseded by 0.8.23.",
    predecessor: {
      state: "CANDIDATE_ESCROWED",
      releaseId: 379991871,
      releaseStatus: "draft",
      bodySha256: SHA256_A,
      marker: predecessorMarker(),
      artifact: {
        manifestSha256: SHA256_A,
        releaseRecordSha256: SHA256_B,
        baseAssetSetSha256: baseAssetSetSha256(),
        attestationSet: attestationSet(),
      },
    },
    evidence: {
      escrowAssets: escrowAssets(),
      npm: {
        observations: [
          npmObservation("2026-09-03T18:00:00.000Z"),
          npmObservation("2026-09-03T18:01:05.000Z"),
        ],
      },
      releaseRuns: [
        {
          workflowRunId: 33418085547,
          runAttempt: 1,
          status: "completed",
          publishJobStarted: false,
        },
      ],
      duplicateRecovery: {
        duplicates: [
          { releaseId: 379982100, receiptAssetId: 542241526, receiptSha256: SHA256_B },
          { releaseId: 379986168, receiptAssetId: 542244137, receiptSha256: SHA256_C },
        ],
        finalAuthorizationReceiptSha256: SHA256_A,
      },
    },
    authority: {
      mode: "operator-recovery",
      operator: "blove",
      capturedAt: "2026-09-03T18:02:00.000Z",
      reviewedCommit: REVIEWED_COMMIT,
    },
  }
  return { ...base, ...overrides }
}
