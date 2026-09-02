import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  canonicalRecoveryNotice,
  canonicalRecoveryReceipt,
  classifyDuplicateDraft,
  DUPLICATE_DRAFT_RECOVERY_POLICY,
  originalBodyAssetName,
  recoveryReceiptAssetName,
} from "../duplicate-draft-recovery.mjs"

const POLICY = {
  repository: "cacheplane/dawnai",
  version: "0.8.22",
  candidateSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
  canonicalReleaseId: 379991871,
  duplicates: [
    { releaseId: 379982100, tagName: "untagged-a13939767dd2419ade01" },
    { releaseId: 379986168, tagName: "untagged-20706099efa3c38335a8" },
  ],
}

const BODY_SHA256 = createHash("sha256").update("canonical body\n", "utf8").digest("hex")
const BASE_ASSET_SET_SHA256 = "1".repeat(64)
const ORIGINAL_BODY = "canonical body\n"
const ORIGINAL_MARKER = {
  schemaVersion: 1,
  phase: "ESCROWED",
  version: POLICY.version,
  commitSha: POLICY.candidateSha,
  tag: `v${POLICY.version}`,
}
const ORIGINAL_ASSETS = Array.from({ length: 45 }, (_, index) => ({
  id: 101 + index,
  name: `asset-${String(index + 1).padStart(2, "0")}.json`,
  sha256: "0123456789abcdef"[index % 16].repeat(64),
}))

function expectedFor(releaseId = POLICY.duplicates[0].releaseId) {
  const duplicate = POLICY.duplicates.find((item) => item.releaseId === releaseId)
  assert.ok(duplicate)
  const recoveryReceipt = {
    repository: POLICY.repository,
    version: POLICY.version,
    candidateSha: POLICY.candidateSha,
    recoveryCommit: POLICY.candidateSha,
    canonicalReleaseId: POLICY.canonicalReleaseId,
    duplicateReleaseId: releaseId,
    originalBodySha256: BODY_SHA256,
    baseAssetSetSha256: BASE_ASSET_SET_SHA256,
    archiveAsset: {
      name: originalBodyAssetName(releaseId, BODY_SHA256),
      sha256: BODY_SHA256,
    },
  }
  const receiptBytes = canonicalRecoveryReceipt(recoveryReceipt)
  const receiptSha256 = createHash("sha256").update(receiptBytes).digest("hex")
  return {
    releaseId,
    tagName: duplicate.tagName,
    canonicalBody: ORIGINAL_BODY,
    canonicalMarker: ORIGINAL_MARKER,
    originalBodySha256: BODY_SHA256,
    originalAssets: ORIGINAL_ASSETS,
    recoveryReceipt,
    recoveryNotice: canonicalRecoveryNotice({
      repository: POLICY.repository,
      version: POLICY.version,
      canonicalReleaseId: POLICY.canonicalReleaseId,
      duplicateReleaseId: releaseId,
      originalBodySha256: BODY_SHA256,
      archiveAssetName: originalBodyAssetName(releaseId, BODY_SHA256),
      receiptAssetName: recoveryReceiptAssetName(releaseId),
      receiptSha256,
    }),
  }
}

function snapshot(overrides = {}) {
  const expected = expectedFor()
  const evidenceAssets = overrides.evidenceAssets ?? []
  const canonicalReceiptBytes = canonicalRecoveryReceipt(expected.recoveryReceipt)
  const receiptBytes = overrides.receiptBytes ?? canonicalReceiptBytes.toString("utf8")
  const receiptSha256 =
    overrides.receiptSha256 ?? createHash("sha256").update(canonicalReceiptBytes).digest("hex")
  const evidence = evidenceAssets.map((kind) => ({
    id: kind === "body" ? 201 : 202,
    name:
      kind === "body"
        ? originalBodyAssetName(expected.releaseId, expected.originalBodySha256)
        : recoveryReceiptAssetName(expected.releaseId),
    sha256: kind === "body" ? expected.originalBodySha256 : receiptSha256,
    ...(kind === "receipt" ? { bytes: receiptBytes } : {}),
  }))
  return {
    releaseId: expected.releaseId,
    tagName: expected.tagName,
    body: overrides.quarantined ? expected.recoveryNotice : expected.canonicalBody,
    marker: overrides.quarantined ? null : expected.canonicalMarker,
    assets: [...expected.originalAssets, ...evidence],
    evidenceAssets,
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key]) => key !== "quarantined" && key !== "receiptSha256" && key !== "receiptBytes",
      ),
    ),
  }
}

test("exports the exact frozen duplicate draft recovery policy", () => {
  assert.deepEqual(DUPLICATE_DRAFT_RECOVERY_POLICY, POLICY)
  assert.equal(Object.isFrozen(DUPLICATE_DRAFT_RECOVERY_POLICY), true)
  assert.equal(Object.isFrozen(DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates), true)
  assert.equal(Object.isFrozen(DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates[0]), true)
  assert.throws(() => {
    DUPLICATE_DRAFT_RECOVERY_POLICY.version = "0.8.23"
  }, TypeError)
})

test("classifies each exact resumable duplicate state", () => {
  const expected = expectedFor()
  assert.equal(classifyDuplicateDraft(snapshot({ evidenceAssets: [] }), expected), "untouched")
  assert.equal(
    classifyDuplicateDraft(snapshot({ evidenceAssets: ["body"] }), expected),
    "body-archived",
  )
  assert.equal(
    classifyDuplicateDraft(snapshot({ evidenceAssets: ["body", "receipt"] }), expected),
    "receipt-archived",
  )
  assert.equal(
    classifyDuplicateDraft(
      snapshot({ quarantined: true, evidenceAssets: ["body", "receipt"] }),
      expected,
    ),
    "quarantined",
  )
})

test("rejects identity, marker, body, asset, and evidence conflicts", () => {
  const expected = expectedFor()
  const cases = [
    ["wrong Release ID", { releaseId: POLICY.canonicalReleaseId }],
    ["exact candidate tag", { tagName: `v${POLICY.version}` }],
    ["changed original asset", { assets: [{ ...ORIGINAL_ASSETS[0], sha256: "e".repeat(64) }] }],
    [
      "extra asset",
      { assets: [...snapshot().assets, { id: 999, name: "extra.txt", sha256: "f".repeat(64) }] },
    ],
    ["noncanonical marker", { marker: { ...ORIGINAL_MARKER, phase: "ATTACHING" } }],
    ["malformed notice", { quarantined: true, body: "recovery\n" }],
    ["receipt without body archive", { evidenceAssets: ["receipt"] }],
    ["unknown evidence combination", { evidenceAssets: ["body", "body"] }],
  ]
  for (const [name, changes] of cases) {
    assert.throws(() => classifyDuplicateDraft(snapshot(changes), expected), undefined, name)
  }
})

test("does not allow caller expectations to collude on a non-policy opaque tag", () => {
  const expected = expectedFor()
  const colludingExpected = { ...expected, tagName: "untagged-operator-invented" }
  assert.throws(() =>
    classifyDuplicateDraft(snapshot({ tagName: colludingExpected.tagName }), colludingExpected),
  )
})

test("rejects a receipt asset whose digest is not the canonical derived receipt", () => {
  const expected = expectedFor()
  assert.throws(() =>
    classifyDuplicateDraft(
      snapshot({ evidenceAssets: ["body", "receipt"], receiptSha256: "e".repeat(64) }),
      expected,
    ),
  )
})

test("rejects a receipt asset whose bytes do not equal its canonical digest", () => {
  const expected = expectedFor()
  assert.throws(() =>
    classifyDuplicateDraft(
      snapshot({ evidenceAssets: ["body", "receipt"], receiptBytes: "tampered receipt\n" }),
      expected,
    ),
  )
})

test("rejects canonical-looking notices with an invalid schema, type, or duplicate identity", () => {
  const expected = expectedFor()
  const notice = JSON.parse(expected.recoveryNotice)
  for (const change of [
    { schemaVersion: 2 },
    { type: "RECOVERY" },
    { duplicateReleaseId: POLICY.duplicates[1].releaseId },
  ]) {
    const malformedExpected = {
      ...expected,
      recoveryNotice: `${JSON.stringify({ ...notice, ...change })}\n`,
    }
    assert.throws(() =>
      classifyDuplicateDraft(
        snapshot({
          quarantined: true,
          evidenceAssets: ["body", "receipt"],
          body: malformedExpected.recoveryNotice,
        }),
        malformedExpected,
      ),
    )
  }
})

test("derives bounded candidate-specific evidence asset names", () => {
  const bodyName = originalBodyAssetName(POLICY.duplicates[0].releaseId, BODY_SHA256)
  const receiptName = recoveryReceiptAssetName(POLICY.duplicates[0].releaseId)
  assert.match(bodyName, /^dawn-v0\.8\.22-duplicate-379982100-original-body-[0-9a-f]{64}\.txt$/u)
  assert.equal(receiptName, "dawn-v0.8.22-duplicate-379982100-recovery-receipt.json")
  assert.ok(Buffer.byteLength(bodyName, "ascii") <= 255)
  assert.ok(Buffer.byteLength(receiptName, "ascii") <= 255)
  assert.throws(() => originalBodyAssetName(POLICY.canonicalReleaseId, BODY_SHA256))
  assert.throws(() => originalBodyAssetName(POLICY.duplicates[0].releaseId, "A".repeat(64)))
})

test("creates canonical newline-terminated receipt and notice bytes", () => {
  const releaseId = POLICY.duplicates[0].releaseId
  const archiveAssetName = originalBodyAssetName(releaseId, BODY_SHA256)
  const receiptAssetName = recoveryReceiptAssetName(releaseId)
  const receipt = canonicalRecoveryReceipt({
    repository: POLICY.repository,
    version: POLICY.version,
    candidateSha: POLICY.candidateSha,
    recoveryCommit: POLICY.candidateSha,
    canonicalReleaseId: POLICY.canonicalReleaseId,
    duplicateReleaseId: releaseId,
    originalBodySha256: BODY_SHA256,
    baseAssetSetSha256: BASE_ASSET_SET_SHA256,
    archiveAsset: { name: archiveAssetName, sha256: BODY_SHA256 },
  })
  assert.ok(Buffer.isBuffer(receipt))
  assert.equal(receipt.toString("utf8").endsWith("\n"), true)
  assert.deepEqual(JSON.parse(receipt), {
    schemaVersion: 1,
    repository: POLICY.repository,
    version: POLICY.version,
    candidateSha: POLICY.candidateSha,
    recoveryCommit: POLICY.candidateSha,
    canonicalReleaseId: POLICY.canonicalReleaseId,
    duplicateReleaseId: releaseId,
    originalBodySha256: BODY_SHA256,
    baseAssetSetSha256: "1".repeat(64),
    archiveAsset: { name: archiveAssetName, sha256: BODY_SHA256 },
  })

  const notice = canonicalRecoveryNotice({
    repository: POLICY.repository,
    version: POLICY.version,
    canonicalReleaseId: POLICY.canonicalReleaseId,
    duplicateReleaseId: releaseId,
    originalBodySha256: BODY_SHA256,
    archiveAssetName,
    receiptAssetName,
    receiptSha256: createHash("sha256")
      .update(canonicalRecoveryReceipt(expectedFor(releaseId).recoveryReceipt))
      .digest("hex"),
  })
  assert.equal(typeof notice, "string")
  assert.equal(notice.endsWith("\n"), true)
  assert.equal(notice.includes("DAWN_RELEASE_CONTROLLER_MARKER"), false)
  assert.match(notice, /379991871/u)
  assert.match(notice, /379982100/u)
})

test("rejects malformed canonical receipt and notice inputs", () => {
  assert.throws(() => canonicalRecoveryReceipt({}), undefined)
  assert.throws(
    () =>
      canonicalRecoveryNotice({
        repository: POLICY.repository,
        version: POLICY.version,
        canonicalReleaseId: POLICY.canonicalReleaseId,
        duplicateReleaseId: POLICY.duplicates[0].releaseId,
        originalBodySha256: BODY_SHA256,
        archiveAssetName: "bad asset name",
        receiptAssetName: recoveryReceiptAssetName(POLICY.duplicates[0].releaseId),
        receiptSha256: "b".repeat(64),
      }),
    undefined,
  )
  assert.throws(
    () =>
      canonicalRecoveryNotice({
        repository: POLICY.repository,
        version: POLICY.version,
        canonicalReleaseId: POLICY.canonicalReleaseId,
        duplicateReleaseId: POLICY.duplicates[0].releaseId,
        originalBodySha256: BODY_SHA256,
        archiveAssetName: `${originalBodyAssetName(POLICY.duplicates[0].releaseId, BODY_SHA256)}\n<!-- DAWN_RELEASE_CONTROLLER_MARKER`,
        receiptAssetName: recoveryReceiptAssetName(POLICY.duplicates[0].releaseId),
        receiptSha256: "b".repeat(64),
      }),
    undefined,
  )
})
