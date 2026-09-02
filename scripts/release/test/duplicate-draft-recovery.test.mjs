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
import { CANONICAL_RELEASE_PACKAGE_ORDER, canonicalManifestBytes } from "../manifest.mjs"
import { canonicalReleaseBody, parseReleaseMarker } from "../metadata.mjs"

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

const ORIGINAL_ASSETS = Array.from({ length: 45 }, (_, index) => ({
  id: 101 + index,
  name: `asset-${String(index + 1).padStart(2, "0")}.json`,
  sha256: "0123456789abcdef"[index % 16].repeat(64),
}))
const BASE_ASSET_SET_SHA256 = assetSetSha256(ORIGINAL_ASSETS)
const MANIFEST = createManifest()
const ORIGINAL_MARKER = createEscrowedMarker(MANIFEST)
const ORIGINAL_BODY = canonicalReleaseBody({ marker: ORIGINAL_MARKER, manifest: MANIFEST })
const BODY_SHA256 = createHash("sha256").update(ORIGINAL_BODY, "utf8").digest("hex")

function createManifest() {
  const packages = CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => {
    const filename = `${name.startsWith("@") ? name.slice(1).replaceAll("/", "-") : name}-${POLICY.version}.tgz`
    const bytes = Buffer.from(`package:${name}`, "utf8")
    const sha512 = createHash("sha512").update(bytes).digest("hex")
    return {
      name,
      version: POLICY.version,
      filename,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha512,
      npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
      access: "public",
    }
  })
  return {
    schemaVersion: 1,
    version: POLICY.version,
    commitSha: POLICY.candidateSha,
    ci: { workflow: "CI", runId: 1, runAttempt: 1 },
    artifact: {
      name: `release-v${POLICY.version}-${POLICY.candidateSha.slice(0, 12)}`,
      prepareRunId: 2,
      prepareRunAttempt: 1,
    },
    packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
    packages,
  }
}

function createEscrowedMarker(manifest) {
  const subjects = [
    {
      name: "manifest.json",
      sha256: createHash("sha256").update(canonicalManifestBytes(manifest)).digest("hex"),
    },
    ...manifest.packages.map((pkg) => ({ name: pkg.filename, sha256: pkg.sha256 })),
  ]
  return {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 2,
    phase: "ESCROWED",
    version: POLICY.version,
    commitSha: POLICY.candidateSha,
    tag: `v${POLICY.version}`,
    manifestSha256: createHash("sha256").update(canonicalManifestBytes(manifest)).digest("hex"),
    releaseRecordSha256: "e".repeat(64),
    baseAssetSetSha256: assetSetSha256(ORIGINAL_ASSETS),
    attestationSet: {
      repository: POLICY.repository,
      workflow: ".github/workflows/release.yml",
      sourceRef: `refs/tags/v${POLICY.version}`,
      commitSha: POLICY.candidateSha,
      workflowRunId: 3,
      runAttempt: 1,
      subjects: subjects.map(({ name, sha256 }) => ({
        subjectName: name,
        subjectSha256: sha256,
        bundleName: `${name}.intoto.jsonl`,
        bundleSha256: "f".repeat(64),
      })),
    },
    npmEvidenceSha256: null,
    smoke: null,
    audit: null,
    abandonmentSha256: null,
  }
}

function assetSetSha256(assets) {
  return createHash("sha256")
    .update(`${JSON.stringify(assets.map(({ name, sha256 }) => ({ name, sha256 })))}\n`, "utf8")
    .digest("hex")
}

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
    canonicalMarker: parseReleaseMarker(ORIGINAL_BODY),
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

function snapshot(overrides = {}, releaseId = POLICY.duplicates[0].releaseId) {
  const expected = expectedFor(releaseId)
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
  for (const duplicate of POLICY.duplicates) {
    const expected = expectedFor(duplicate.releaseId)
    assert.equal(
      classifyDuplicateDraft(snapshot({ evidenceAssets: [] }, duplicate.releaseId), expected),
      "untouched",
    )
    assert.equal(
      classifyDuplicateDraft(snapshot({ evidenceAssets: ["body"] }, duplicate.releaseId), expected),
      "body-archived",
    )
    assert.equal(
      classifyDuplicateDraft(
        snapshot({ evidenceAssets: ["body", "receipt"] }, duplicate.releaseId),
        expected,
      ),
      "receipt-archived",
    )
    assert.equal(
      classifyDuplicateDraft(
        snapshot({ quarantined: true, evidenceAssets: ["body", "receipt"] }, duplicate.releaseId),
        expected,
      ),
      "quarantined",
    )
  }
})

test("rejects identity, marker, body, asset, and evidence conflicts", () => {
  const expected = expectedFor()
  const cases = [
    ["wrong Release ID", { releaseId: POLICY.canonicalReleaseId }],
    ["exact candidate tag", { tagName: `v${POLICY.version}` }],
    [
      "changed original asset",
      (() => {
        const assets = structuredClone(snapshot().assets)
        assets[0].sha256 = "e".repeat(64)
        return { assets }
      })(),
    ],
    [
      "extra asset",
      { assets: [...snapshot().assets, { id: 999, name: "extra.txt", sha256: "f".repeat(64) }] },
    ],
    ["noncanonical marker", { marker: { ...ORIGINAL_MARKER, phase: "ATTACHING" } }],
    [
      "malformed notice",
      { quarantined: true, evidenceAssets: ["body", "receipt"], body: "recovery\n" },
    ],
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

test("rejects receipt bytes for another duplicate under this duplicate's receipt name", () => {
  const expected = expectedFor()
  const otherReceipt = expectedFor(POLICY.duplicates[1].releaseId).recoveryReceipt
  const otherBytes = canonicalRecoveryReceipt(otherReceipt)
  assert.throws(() =>
    classifyDuplicateDraft(
      snapshot({
        evidenceAssets: ["body", "receipt"],
        receiptBytes: otherBytes.toString("utf8"),
        receiptSha256: createHash("sha256").update(otherBytes).digest("hex"),
      }),
      { ...expected, recoveryReceipt: otherReceipt },
    ),
  )
})

test("rejects receipt bytes for a different original body under this duplicate's receipt name", () => {
  const expected = expectedFor()
  const wrongBodySha256 = "e".repeat(64)
  const wrongReceipt = {
    ...expected.recoveryReceipt,
    originalBodySha256: wrongBodySha256,
    archiveAsset: {
      name: originalBodyAssetName(expected.releaseId, wrongBodySha256),
      sha256: wrongBodySha256,
    },
  }
  const wrongBytes = canonicalRecoveryReceipt(wrongReceipt)
  assert.throws(() =>
    classifyDuplicateDraft(
      snapshot({
        evidenceAssets: ["body", "receipt"],
        receiptBytes: wrongBytes.toString("utf8"),
        receiptSha256: createHash("sha256").update(wrongBytes).digest("hex"),
      }),
      { ...expected, recoveryReceipt: wrongReceipt },
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

test("rejects a quarantine notice that points at a wrong-body archive", () => {
  const expected = expectedFor()
  const wrongBodySha256 = "e".repeat(64)
  const wrongNotice = canonicalRecoveryNotice({
    repository: POLICY.repository,
    version: POLICY.version,
    canonicalReleaseId: POLICY.canonicalReleaseId,
    duplicateReleaseId: expected.releaseId,
    originalBodySha256: wrongBodySha256,
    archiveAssetName: originalBodyAssetName(expected.releaseId, wrongBodySha256),
    receiptAssetName: recoveryReceiptAssetName(expected.releaseId),
    receiptSha256: createHash("sha256")
      .update(canonicalRecoveryReceipt(expected.recoveryReceipt))
      .digest("hex"),
  })
  assert.throws(() =>
    classifyDuplicateDraft(
      snapshot({
        quarantined: true,
        evidenceAssets: ["body", "receipt"],
        body: wrongNotice,
      }),
      { ...expected, recoveryNotice: wrongNotice },
    ),
  )
})

test("rejects a detached body and marker pair that is not a canonical Dawn body", () => {
  const expected = expectedFor()
  const detachedBody = "detached operator body\n"
  const detachedBodySha256 = createHash("sha256").update(detachedBody, "utf8").digest("hex")
  const detachedReceipt = {
    ...expected.recoveryReceipt,
    originalBodySha256: detachedBodySha256,
    archiveAsset: {
      name: originalBodyAssetName(expected.releaseId, detachedBodySha256),
      sha256: detachedBodySha256,
    },
  }
  assert.throws(() =>
    classifyDuplicateDraft(snapshot({ body: detachedBody }), {
      ...expected,
      canonicalBody: detachedBody,
      originalBodySha256: detachedBodySha256,
      recoveryReceipt: detachedReceipt,
    }),
  )
})

test("rejects an arbitrary base-asset digest even in an otherwise valid canonical body", () => {
  const expected = expectedFor()
  const arbitraryDigest = "1".repeat(64)
  const marker = { ...expected.canonicalMarker, baseAssetSetSha256: arbitraryDigest }
  const body = canonicalReleaseBody({ marker, manifest: MANIFEST })
  const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex")
  const recoveryReceipt = {
    ...expected.recoveryReceipt,
    originalBodySha256: bodySha256,
    baseAssetSetSha256: arbitraryDigest,
    archiveAsset: {
      name: originalBodyAssetName(expected.releaseId, bodySha256),
      sha256: bodySha256,
    },
  }
  assert.throws(() =>
    classifyDuplicateDraft(snapshot({ body, marker }), {
      ...expected,
      canonicalBody: body,
      canonicalMarker: marker,
      originalBodySha256: bodySha256,
      recoveryReceipt,
    }),
  )
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
  assert.equal(
    receipt.toString("utf8"),
    `{"archiveAsset":{"name":"${archiveAssetName}","sha256":"${BODY_SHA256}"},"baseAssetSetSha256":"${BASE_ASSET_SET_SHA256}","candidateSha":"${POLICY.candidateSha}","canonicalReleaseId":${POLICY.canonicalReleaseId},"duplicateReleaseId":${releaseId},"originalBodySha256":"${BODY_SHA256}","recoveryCommit":"${POLICY.candidateSha}","repository":"${POLICY.repository}","schemaVersion":1,"version":"${POLICY.version}"}\n`,
  )
  assert.deepEqual(JSON.parse(receipt), {
    schemaVersion: 1,
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
  assert.equal(
    notice,
    `{"archiveAssetName":"${archiveAssetName}","candidateSha":"${POLICY.candidateSha}","canonicalReleaseId":${POLICY.canonicalReleaseId},"duplicateReleaseId":${releaseId},"originalBodySha256":"${BODY_SHA256}","receiptAssetName":"${receiptAssetName}","receiptSha256":"${createHash(
      "sha256",
    )
      .update(canonicalRecoveryReceipt(expectedFor(releaseId).recoveryReceipt))
      .digest(
        "hex",
      )}","repository":"${POLICY.repository}","schemaVersion":1,"type":"DAWN_DUPLICATE_DRAFT_RECOVERY","version":"${POLICY.version}"}\n`,
  )
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
