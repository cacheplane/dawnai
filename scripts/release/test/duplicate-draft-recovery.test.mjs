import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import {
  applyDuplicateDraftRecovery,
  canonicalDuplicateDraftEvidence,
  canonicalRecoveryNotice,
  canonicalRecoveryReceipt,
  captureDuplicateDraftRecoveryEvidence,
  classifyDuplicateDraft,
  DUPLICATE_DRAFT_RECOVERY_POLICY,
  MAX_ARCHIVE_ASSET_BYTES,
  originalBodyAssetName,
  parseDuplicateDraftEvidence,
  recoveryReceiptAssetName,
  verifyDuplicateDraftEvidence,
} from "../duplicate-draft-recovery.mjs"
import {
  createDuplicateDraftRecoveryReader,
  createDuplicateDraftRecoveryWriter,
  DuplicateDraftRecoveryReadError,
} from "../duplicate-draft-recovery-adapters.mjs"
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
const CANONICAL_OPAQUE_TAG = "untagged-be0ff4bee4ba43b521a9"
const RELEASE_TITLE = "Dawn v0.8.22"
const GITHUB_BASE = "https://api.github.com/repos/cacheplane/dawnai"
// Escape before interpolating into a RegExp: an unescaped "." in the hostname
// would let these matchers accept more hosts than the exact API origin.
const GITHUB_BASE_PATTERN = GITHUB_BASE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

const ORIGINAL_ASSETS = Array.from({ length: 45 }, (_, index) => ({
  id: 101 + index,
  name: `asset-${String(index + 1).padStart(2, "0")}.json`,
  sha256: "0123456789abcdef"[index % 16].repeat(64),
  size: index + 1,
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
  const duplicateIndex = POLICY.duplicates.findIndex(
    (duplicate) => duplicate.releaseId === releaseId,
  )
  const idOffset = (duplicateIndex + 1) * 1_000
  const duplicateOriginalAssets = expected.originalAssets.map((asset) => ({
    ...asset,
    id: asset.id + idOffset,
  }))
  const evidenceAssets = overrides.evidenceAssets ?? []
  const canonicalReceiptBytes = canonicalRecoveryReceipt(expected.recoveryReceipt)
  const receiptBytes = overrides.receiptBytes ?? canonicalReceiptBytes.toString("utf8")
  const receiptSha256 =
    overrides.receiptSha256 ?? createHash("sha256").update(canonicalReceiptBytes).digest("hex")
  const evidence = evidenceAssets.map((kind) => ({
    id: idOffset + (kind === "body" ? 901 : 902),
    name:
      kind === "body"
        ? originalBodyAssetName(expected.releaseId, expected.originalBodySha256)
        : recoveryReceiptAssetName(expected.releaseId),
    sha256: kind === "body" ? expected.originalBodySha256 : receiptSha256,
    size:
      kind === "body"
        ? Buffer.byteLength(expected.canonicalBody, "utf8")
        : Buffer.byteLength(receiptBytes, "utf8"),
    ...(kind === "receipt" ? { bytes: receiptBytes } : {}),
  }))
  return {
    releaseId: expected.releaseId,
    tagName: expected.tagName,
    title: RELEASE_TITLE,
    targetCommitish: "main",
    draft: true,
    prerelease: false,
    immutable: false,
    body: overrides.quarantined ? expected.recoveryNotice : expected.canonicalBody,
    marker: overrides.quarantined ? null : expected.canonicalMarker,
    assets: [...duplicateOriginalAssets, ...evidence],
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

test("compares original asset namespaces without conflating cross-Release asset IDs", () => {
  const expected = expectedFor()
  const duplicate = snapshot()

  assert.notEqual(duplicate.assets[0].id, expected.originalAssets[0].id)
  assert.equal(classifyDuplicateDraft(duplicate, expected), "untouched")

  const observation = recoveryObservation()
  const evidence = parseDuplicateDraftEvidence(canonicalDuplicateDraftEvidence(observation))
  assert.equal(
    evidence.releases.duplicates[0].assets[0].id,
    observation.releases.duplicates[0].assets[0].id,
  )
  assert.notEqual(
    evidence.releases.duplicates[0].assets[0].id,
    evidence.releases.canonical.assets[0].id,
  )
})

test("rejects duplicate asset IDs and name collisions within each observed Release", () => {
  const expected = expectedFor()
  for (const field of ["id", "name"]) {
    const conflicting = snapshot()
    conflicting.assets[1][field] = conflicting.assets[0][field]
    assert.throws(() => classifyDuplicateDraft(conflicting, expected), /asset|unique/iu)

    const observation = recoveryObservation()
    observation.releases.duplicates[0].assets[1][field] =
      observation.releases.duplicates[0].assets[0][field]
    assert.throws(() => canonicalDuplicateDraftEvidence(observation), /asset|unique/iu)
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

const RECOVERY_NOW = Date.parse("2026-09-01T00:10:00.000Z")
const RECOVERY_CAPTURED_AT = "2026-09-01T00:00:00.000Z"
const REVIEWED_HEAD_SHA = "1".repeat(40)
const REVIEWED_TREE_SHA = "2".repeat(40)
const MERGE_COMMIT_SHA = "3".repeat(40)
const TAG_OBJECT_SHA = "4".repeat(40)

test("apply requires the exact non-atomic edit-freeze acknowledgement before writer construction", async () => {
  let writerConstructions = 0

  await assert.rejects(
    applyDuplicateDraftRecovery({
      evidence: recoveryObservation(),
      concurrencyAcknowledgement: { acknowledged: false },
      reader: Object.freeze({}),
      createWriter() {
        writerConstructions += 1
        return Object.freeze({})
      },
      observer: async () => ({}),
      now: () => RECOVERY_NOW,
    }),
    /acknowledgement/iu,
  )
  assert.equal(writerConstructions, 0)
})

const FINAL_RECOVERY_OBSERVATION = Object.freeze({
  state: "CANDIDATE_ESCROWED",
  disposition: "would-transition",
  nextTransition: "publish-npm-packages",
  conflicts: Object.freeze([]),
  diagnostics: Object.freeze([]),
  releaseId: POLICY.canonicalReleaseId,
})

function concurrencyAcknowledgement() {
  return Object.freeze({
    acknowledged: true,
    atomic: false,
    mode: "operator-freeze-compare-before-write-v1",
    releaseIds: Object.freeze(POLICY.duplicates.map(({ releaseId }) => releaseId)),
  })
}

function createApplyHarness({
  states = ["untouched", "untouched"],
  writerFailure,
  malformedQuarantineReceipt = false,
  uploadStatus = "uploaded",
  uploadReceiptTransform = (receipt) => Object.freeze(receipt),
  quarantineReceiptTransform = (receipt) => Object.freeze(receipt),
  writerTransform = (writer) => Object.freeze(writer),
  fenceTimes = ["2026-09-01T00:10:00.000Z", "2026-09-01T00:10:00.000Z"],
  drift,
  fourthCandidate = false,
  finalObservation = FINAL_RECOVERY_OBSERVATION,
  clock = () => RECOVERY_NOW,
} = {}) {
  const liveStates = [...states]
  const events = []
  let authorizationCount = 0
  let writerConstructions = 0
  let mutationCount = 0

  function observation() {
    const current = structuredClone(
      recoveryObservation({
        states: liveStates,
        capturedAt: new Date(RECOVERY_NOW).toISOString(),
      }),
    )
    drift?.(current, authorizationCount)
    return current
  }

  const reader = Object.freeze({
    async readReviewedMergeAuthority() {
      authorizationCount += 1
      events.push(["authorize", authorizationCount, [...liveStates]])
      return observation().reviewedAuthority
    },
    async readRepositoryState() {
      return observation().repository
    },
    async readCandidateTag() {
      return observation().candidate
    },
    async readWorkflowState() {
      return observation().workflow
    },
    async readImmutableReleases() {
      return observation().immutableReleases
    },
    async readReleaseRuns() {
      const current = observation()
      return { runs: current.releaseRuns, candidateRuns: current.releaseRuns }
    },
    async readCandidatePublishJobs() {
      assert.fail("no candidate workflow jobs should be read without candidate runs")
    },
    async readNpmAbsence(name) {
      return observation().npm.packages.find((pkg) => pkg.name === name)
    },
    async readReleaseSnapshot(releaseId) {
      const current = observation()
      return releaseId === POLICY.canonicalReleaseId
        ? current.releases.canonical
        : current.releases.duplicates.find((release) => release.releaseId === releaseId)
    },
    async listCandidateReleases() {
      const current = observation()
      const releases = [
        releaseSummary(current.releases.canonical),
        ...current.releases.duplicates.map(releaseSummary),
      ]
      if (fourthCandidate) {
        releases.push({
          ...releaseSummary(current.releases.duplicates[0]),
          releaseId: 379999999,
          tagName: "untagged-fourth-candidate",
        })
      }
      return releases
    },
  })

  function createWriter() {
    writerConstructions += 1
    events.push(["writer-created", authorizationCount])
    return writerTransform({
      async uploadEvidenceAssetIfAbsentAndEqual(input) {
        mutationCount += 1
        const duplicateIndex = POLICY.duplicates.findIndex(
          ({ releaseId }) => releaseId === input.expectedSnapshot.releaseId,
        )
        assert.notEqual(duplicateIndex, -1)
        const isBody =
          input.name === input.expectedSnapshot.assets.at(45)?.name ||
          input.name.includes("-original-body-")
        const expectedState = isBody ? "untouched" : "body-archived"
        assert.equal(liveStates[duplicateIndex], expectedState)
        assert.equal(input.expectedTagObjectSha, TAG_OBJECT_SHA)
        events.push([
          "mutate",
          mutationCount,
          isBody ? "archive-body" : "archive-receipt",
          input.expectedSnapshot.releaseId,
          authorizationCount,
        ])
        liveStates[duplicateIndex] = isBody ? "body-archived" : "receipt-archived"
        const uploadFailure = writerFailure?.(mutationCount, "upload")
        if (uploadFailure) {
          throw uploadFailure === true ? new Error("simulated writer failure") : uploadFailure
        }
        return uploadReceiptTransform({
          releaseId: input.expectedSnapshot.releaseId,
          assetId: recoverySnapshotForState(
            input.expectedSnapshot.releaseId,
            liveStates[duplicateIndex],
          ).assets.at(-1).id,
          name: input.name,
          status: typeof uploadStatus === "function" ? uploadStatus(isBody) : uploadStatus,
          sha256: input.sha256,
        })
      },
      async quarantineDuplicateBodyIfCurrent(input) {
        mutationCount += 1
        const duplicateIndex = POLICY.duplicates.findIndex(
          ({ releaseId }) => releaseId === input.expectedSnapshot.releaseId,
        )
        assert.equal(liveStates[duplicateIndex], "receipt-archived")
        assert.equal(input.expectedTagObjectSha, TAG_OBJECT_SHA)
        events.push([
          "mutate",
          mutationCount,
          "quarantine",
          input.expectedSnapshot.releaseId,
          authorizationCount,
        ])
        liveStates[duplicateIndex] = "quarantined"
        const quarantineFailure = writerFailure?.(mutationCount, "quarantine")
        if (quarantineFailure) {
          throw quarantineFailure === true
            ? new Error("simulated writer failure")
            : quarantineFailure
        }
        if (malformedQuarantineReceipt) return Object.freeze({ outcome: "performed" })
        return quarantineReceiptTransform({
          atomic: false,
          releaseId: input.expectedSnapshot.releaseId,
          outcome: "performed",
          preWriteFence: Object.freeze({
            observedAt: fenceTimes[0],
            projectionSha256: "a".repeat(64),
            tagObjectSha: TAG_OBJECT_SHA,
          }),
          postWriteFence: Object.freeze({
            observedAt: fenceTimes[1],
            projectionSha256: "b".repeat(64),
            tagObjectSha: TAG_OBJECT_SHA,
          }),
        })
      },
    })
  }

  const observer = async (input) => {
    events.push(["observe", structuredClone(input)])
    return finalObservation
  }
  const evidence = parseDuplicateDraftEvidence(
    canonicalDuplicateDraftEvidence(recoveryObservation({ states })),
  )
  return {
    evidence,
    reader,
    createWriter,
    observer,
    now: clock,
    events,
    liveStates,
    get writerConstructions() {
      return writerConstructions
    },
    get mutationCount() {
      return mutationCount
    },
  }
}

async function runApply(harness, overrides = {}) {
  return applyDuplicateDraftRecovery({
    evidence: harness.evidence,
    concurrencyAcknowledgement: concurrencyAcknowledgement(),
    reader: harness.reader,
    createWriter: harness.createWriter,
    observer: harness.observer,
    now: harness.now,
    ...overrides,
  })
}

test("apply converges every resumable state in ID order with fresh authorization before each mutation", async () => {
  for (const states of [
    ["untouched", "untouched"],
    ["body-archived", "untouched"],
    ["receipt-archived", "body-archived"],
    ["quarantined", "quarantined"],
  ]) {
    const harness = createApplyHarness({ states })
    const receipt = await runApply(harness)
    assert.deepEqual(harness.liveStates, ["quarantined", "quarantined"])
    if (states.every((state) => state === "quarantined")) {
      // Byte-identical replay is a no-op: no writer is constructed and no
      // mutation is issued, and every duplicate is reported as preexisting.
      assert.equal(harness.writerConstructions, 0)
      assert.equal(harness.mutationCount, 0)
      assert.deepEqual(
        receipt.duplicates.map(({ outcome }) => outcome),
        ["preexisting-quarantined", "preexisting-quarantined"],
      )
      assert.deepEqual(
        receipt.duplicates.map(({ priorFenceObservations }) => priorFenceObservations),
        [null, null],
      )
    }
    assert.equal(receipt.atomic, false)
    assert.deepEqual(receipt.concurrencyAcknowledgement, concurrencyAcknowledgement())
    assert.equal(Object.isFrozen(receipt), true)
    assert.equal(Object.isFrozen(receipt.duplicates), true)
    const mutations = harness.events.filter(([kind]) => kind === "mutate")
    for (const mutation of mutations) {
      const eventIndex = harness.events.indexOf(mutation)
      const precedingAuthorization = harness.events
        .slice(0, eventIndex)
        .findLast(([kind]) => kind === "authorize")
      assert.equal(mutation[4], precedingAuthorization[1])
      assert.equal(
        harness.events
          .slice(harness.events.indexOf(precedingAuthorization) + 1, eventIndex)
          .some(([kind]) => kind === "mutate"),
        false,
      )
    }
    const secondStart = mutations.findIndex((event) => event[3] === POLICY.duplicates[1].releaseId)
    if (secondStart !== -1) {
      assert.equal(harness.liveStates[0], "quarantined")
      assert.equal(
        harness.events
          .slice(0, harness.events.indexOf(mutations[secondStart]))
          .some((event) => event[0] === "authorize" && event[2][0] === "quarantined"),
        true,
      )
    }
  }
})

test("apply validates the exact injected existing receipt union and reauthorizes", async () => {
  // The production Task 4 writer rejects an asset that appears after capture as
  // expectedSnapshot drift. This seam isolates Task 5's receipt-union contract;
  // the real Task 4 composition below exercises a reachable transition.
  const statuses = []
  const harness = createApplyHarness({
    states: ["untouched", "quarantined"],
    uploadStatus(isBody) {
      statuses.push(isBody ? "body" : "receipt")
      return "existing"
    },
  })

  const receipt = await runApply(harness)
  assert.deepEqual(statuses, ["body", "receipt"])
  assert.deepEqual(harness.liveStates, ["quarantined", "quarantined"])
  assert.equal(receipt.duplicates[0].outcome, "performed")
  assert.equal(harness.events.filter(([kind]) => kind === "authorize").length, 5)
})

test("apply composes with the real Task 4 writer over an in-memory quarantine transition", async () => {
  const releaseId = POLICY.duplicates[0].releaseId
  const harness = createApplyHarness({ states: ["receipt-archived", "quarantined"] })
  const calls = []

  function currentSnapshot() {
    return recoverySnapshotForState(releaseId, harness.liveStates[0])
  }

  function rawRelease() {
    const current = currentSnapshot()
    return {
      id: releaseId,
      tag_name: current.tagName,
      name: "Dawn v0.8.22",
      body: current.body,
      draft: true,
      prerelease: false,
      immutable: false,
      target_commitish: "main",
    }
  }

  function evidenceBytes(asset) {
    if (asset.name.includes("-original-body-")) return Buffer.from(ORIGINAL_BODY, "utf8")
    if (asset.name === recoveryReceiptAssetName(releaseId)) return Buffer.from(asset.bytes, "utf8")
    return Buffer.from("x")
  }

  const fetchImpl = async (url, init) => {
    calls.push([url, init.method])
    if (url === `${GITHUB_BASE}/git/ref/tags%2Fv0.8.22`) {
      return jsonResponse({
        ref: "refs/tags/v0.8.22",
        object: { type: "tag", sha: TAG_OBJECT_SHA },
      })
    }
    if (url === `${GITHUB_BASE}/git/tags/${TAG_OBJECT_SHA}`) {
      return jsonResponse({
        sha: TAG_OBJECT_SHA,
        tag: "v0.8.22",
        object: { type: "commit", sha: POLICY.candidateSha },
      })
    }
    if (url === `${GITHUB_BASE}/releases/${releaseId}/assets?per_page=100`) {
      return jsonResponse(
        currentSnapshot().assets.map((asset) => ({
          id: asset.id,
          name: asset.name,
          digest: `sha256:${asset.sha256}`,
          size: asset.size,
        })),
      )
    }
    const download = new RegExp(`^${GITHUB_BASE_PATTERN}/releases/assets/(\\d+)$`, "u").exec(url)
    if (download !== null) {
      const asset = currentSnapshot().assets.find(({ id }) => id === Number(download[1]))
      assert.ok(asset)
      return new Response(evidenceBytes(asset), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      })
    }
    if (url === `${GITHUB_BASE}/releases/${releaseId}` && init.method === "GET") {
      return jsonResponse(rawRelease())
    }
    if (url === `${GITHUB_BASE}/releases/${releaseId}` && init.method === "PATCH") {
      assert.deepEqual(JSON.parse(init.body), {
        body: harness.evidence.releases.duplicates[0].noticeBytes,
      })
      harness.liveStates[0] = "quarantined"
      return jsonResponse(rawRelease())
    }
    assert.fail(`unexpected in-memory Task 4 URL ${url}`)
  }

  const receipt = await runApply(harness, {
    createWriter: () =>
      createDuplicateDraftRecoveryWriter({
        token: "task-4-seam-token",
        fetchImpl,
        now: () => RECOVERY_NOW,
      }),
  })

  assert.deepEqual(harness.liveStates, ["quarantined", "quarantined"])
  assert.equal(receipt.duplicates[0].outcome, "performed")
  assert.deepEqual(
    calls.filter(([, method]) => method !== "GET"),
    [[`${GITHUB_BASE}/releases/${releaseId}`, "PATCH"]],
  )
})

test("apply rejects stale or regressing authorization clocks before writer construction", async () => {
  const delayedTimes = [
    Date.parse("2026-09-01T00:00:00.000Z"),
    Date.parse("2026-09-01T00:00:01.000Z"),
    Date.parse("2026-09-01T00:15:01.001Z"),
  ]
  const delayed = createApplyHarness({ clock: () => delayedTimes.shift() })
  await assert.rejects(runApply(delayed), /expired|fresh/iu)
  assert.equal(delayed.writerConstructions, 0)
  assert.equal(delayed.mutationCount, 0)

  const regressionTimes = [
    Date.parse("2026-09-01T00:00:00.000Z"),
    Date.parse("2026-09-01T00:00:01.000Z"),
    Date.parse("2026-09-01T00:00:00.999Z"),
  ]
  const regressing = createApplyHarness({ clock: () => regressionTimes.shift() })
  await assert.rejects(runApply(regressing), /regress|ordering/iu)
  assert.equal(regressing.writerConstructions, 0)
  assert.equal(regressing.mutationCount, 0)

  const constructionDelayTimes = [
    Date.parse("2026-09-01T00:00:00.000Z"),
    Date.parse("2026-09-01T00:00:01.000Z"),
    Date.parse("2026-09-01T00:00:02.000Z"),
    Date.parse("2026-09-01T00:15:01.001Z"),
  ]
  const constructionDelay = createApplyHarness({
    clock: () => constructionDelayTimes.shift(),
  })
  await assert.rejects(runApply(constructionDelay), /expired|fresh/iu)
  assert.equal(constructionDelay.writerConstructions, 1)
  assert.equal(constructionDelay.mutationCount, 0)
})

test("apply advances chronology through a validated quarantine post-write fence", async () => {
  const harness = createApplyHarness({
    states: ["receipt-archived", "untouched"],
    fenceTimes: ["2026-09-01T00:10:00.000Z", "2026-09-01T00:10:05.000Z"],
  })

  await assert.rejects(runApply(harness), /timeline regressed/iu)
  assert.equal(harness.mutationCount, 1)
  assert.deepEqual(harness.liveStates, ["quarantined", "untouched"])
  assert.equal(
    harness.events.some(
      (event) => event[0] === "mutate" && event[3] === POLICY.duplicates[1].releaseId,
    ),
    false,
  )
})

test("apply resumes an expired partial run without restoring a live marker or inventing prior fences", async () => {
  const later = Date.parse("2026-09-01T00:20:00.000Z")
  for (let failurePoint = 1; failurePoint <= 6; failurePoint += 1) {
    const first = createApplyHarness({
      writerFailure: (mutationCount) => mutationCount === failurePoint,
    })
    await assert.rejects(runApply(first), /writer failure/iu)
    assert.throws(
      () =>
        verifyDuplicateDraftEvidence({
          evidence: first.evidence,
          current: recoveryObservation({ states: first.liveStates }),
          now: () => later,
        }),
      /expired/iu,
    )

    const resumed = createApplyHarness({
      states: first.liveStates,
      fenceTimes: [new Date(later).toISOString(), new Date(later).toISOString()],
    })
    resumed.now = () => later
    resumed.evidence = parseDuplicateDraftEvidence(
      canonicalDuplicateDraftEvidence(
        recoveryObservation({
          states: first.liveStates,
          capturedAt: new Date(later).toISOString(),
        }),
      ),
    )
    const receipt = await runApply(resumed)
    assert.deepEqual(resumed.liveStates, ["quarantined", "quarantined"])
    for (const [index, priorState] of first.liveStates.entries()) {
      if (priorState !== "quarantined") continue
      assert.equal(receipt.duplicates[index].outcome, "preexisting-quarantined")
      assert.equal(receipt.duplicates[index].priorFenceObservations, null)
      assert.match(receipt.duplicates[index].projectionSha256, /^[0-9a-f]{64}$/u)
    }
  }
})

test("preexisting quarantine hashes the same complete projection as writer fences", async () => {
  const harness = createApplyHarness({ states: ["quarantined", "quarantined"] })
  const receipt = await runApply(harness)
  const snapshot = recoverySnapshotForState(POLICY.duplicates[0].releaseId, "quarantined")
  const writerProjection = {
    releaseId: snapshot.releaseId,
    tagName: snapshot.tagName,
    title: snapshot.title,
    targetCommitish: snapshot.targetCommitish,
    draft: snapshot.draft,
    prerelease: snapshot.prerelease,
    immutable: snapshot.immutable,
    body: snapshot.body,
    assets: snapshot.assets.map(({ id, name, sha256, size }) => ({ id, name, sha256, size })),
  }
  const expectedSha256 = createHash("sha256")
    .update(JSON.stringify(canonicalize(writerProjection)), "utf8")
    .digest("hex")

  assert.equal(receipt.duplicates[0].projectionSha256, expectedSha256)
})

test("apply rejects malformed acknowledgements before reads, writer construction, or mutation", async () => {
  const accessor = {}
  let accessed = false
  Object.defineProperty(accessor, "acknowledged", {
    enumerable: true,
    get() {
      accessed = true
      return true
    },
  })
  const revoked = Proxy.revocable(concurrencyAcknowledgement(), {})
  revoked.revoke()
  const liveProxy = new Proxy(concurrencyAcknowledgement(), {})
  const nestedProxy = Object.freeze({
    ...concurrencyAcknowledgement(),
    releaseIds: new Proxy(concurrencyAcknowledgement().releaseIds, {}),
  })
  const cases = [
    undefined,
    Object.freeze({ acknowledged: false }),
    Object.freeze({ ...concurrencyAcknowledgement(), extra: true }),
    Object.freeze({
      ...concurrencyAcknowledgement(),
      releaseIds: Object.freeze([379986168, 379982100]),
    }),
    accessor,
    liveProxy,
    nestedProxy,
    revoked.proxy,
  ]
  for (const acknowledgement of cases) {
    const harness = createApplyHarness()
    await assert.rejects(
      runApply(harness, { concurrencyAcknowledgement: acknowledgement }),
      /acknowledgement/iu,
    )
    assert.equal(harness.writerConstructions, 0)
    assert.equal(harness.events.length, 0)
  }
  assert.equal(accessed, false)
})

test("apply rejects mutable, expanded, wrong, credential-bearing, or proxied Task 4 upload receipts", async () => {
  const cases = [
    (receipt) => receipt,
    (receipt) => Object.freeze({ ...receipt, extra: true }),
    (receipt) => Object.freeze({ ...receipt, status: "wrong" }),
    (receipt) => Object.freeze({ ...receipt, status: "secret-token" }),
    (receipt) => new Proxy(Object.freeze(receipt), {}),
  ]
  for (const uploadReceiptTransform of cases) {
    const harness = createApplyHarness({ uploadReceiptTransform })
    await assert.rejects(runApply(harness), /receipt|proxy/iu)
    assert.equal(harness.mutationCount, 1)
    assert.deepEqual(harness.liveStates, ["body-archived", "untouched"])
  }
})

test("apply rejects proxied writer, quarantine receipt, and observer objects", async () => {
  const writerProxy = createApplyHarness({
    writerTransform(writer) {
      return new Proxy(Object.freeze(writer), {})
    },
  })
  await assert.rejects(runApply(writerProxy), /writer|proxy/iu)
  assert.equal(writerProxy.mutationCount, 0)

  const receiptProxy = createApplyHarness({
    states: ["receipt-archived", "untouched"],
    quarantineReceiptTransform(receipt) {
      return new Proxy(Object.freeze(receipt), {})
    },
  })
  await assert.rejects(runApply(receiptProxy), /receipt|proxy/iu)
  assert.equal(receiptProxy.mutationCount, 1)
  assert.deepEqual(receiptProxy.liveStates, ["quarantined", "untouched"])

  const observerProxy = createApplyHarness({
    states: ["quarantined", "quarantined"],
    finalObservation: new Proxy(FINAL_RECOVERY_OBSERVATION, {}),
  })
  await assert.rejects(runApply(observerProxy), /authorization|proxy/iu)
  assert.equal(observerProxy.mutationCount, 0)
})

test("apply fails closed on stale evidence and adversarial live authorization drift", async () => {
  const stale = createApplyHarness()
  stale.evidence = parseDuplicateDraftEvidence(
    canonicalDuplicateDraftEvidence(
      recoveryObservation({ capturedAt: "2026-08-31T23:44:59.999Z" }),
    ),
  )
  await assert.rejects(runApply(stale), /expired/iu)
  assert.equal(stale.writerConstructions, 0)

  const drifts = [
    (current) => {
      current.repository.mainSha = "5".repeat(40)
    },
    (current) => {
      current.workflow.state = "active"
    },
    (current) => {
      current.candidate.tagObjectSha = "5".repeat(40)
    },
    (current) => {
      current.npm.packages[0].status = "present"
    },
    (current) => {
      current.releases.canonical.body += "drift"
    },
    (current) => {
      current.releases.canonical.assets[0].sha256 = "5".repeat(64)
    },
  ]
  for (const drift of drifts) {
    const harness = createApplyHarness({ drift })
    await assert.rejects(runApply(harness))
    assert.equal(harness.writerConstructions, 0)
    assert.equal(harness.mutationCount, 0)
  }

  const newRun = createApplyHarness({
    drift(current) {
      current.releaseRuns.push({
        id: 701,
        runAttempt: 1,
        status: "in_progress",
        conclusion: null,
        headSha: POLICY.candidateSha,
        createdAt: "2026-09-01T00:00:00Z",
        startedAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-01T00:00:01Z",
      })
    },
  })
  await assert.rejects(runApply(newRun), /nonterminal/iu)
  assert.equal(newRun.writerConstructions, 0)

  const fourth = createApplyHarness({ fourthCandidate: true })
  await assert.rejects(runApply(fourth), /inventory/iu)
  assert.equal(fourth.writerConstructions, 0)
})

test("apply rejects partial, quarantined, and asset-size projection drift before mutation", async () => {
  const cases = [
    {
      states: ["body-archived", "untouched"],
      drift(current) {
        current.releases.duplicates[0].title = "Dawn v0.8.22 changed"
      },
    },
    {
      states: ["quarantined", "quarantined"],
      drift(current) {
        current.releases.duplicates[0].title = "Dawn v0.8.22 changed"
      },
    },
    {
      states: ["body-archived", "untouched"],
      drift(current) {
        current.releases.duplicates[0].assets[0].size += 1
      },
    },
  ]
  for (const { states, drift } of cases) {
    const harness = createApplyHarness({ states, drift })
    await assert.rejects(runApply(harness), /Release|state|drift|exact/iu)
    assert.equal(harness.writerConstructions, 0)
    assert.equal(harness.mutationCount, 0)
  }
})

test("apply never retries failed, ambiguous, or malformed writer outcomes and never starts the next mutation", async () => {
  const cases = [
    {
      code: "WRITE_TIMEOUT",
      message: "GitHub recovery response timed out",
      stage: "upload",
      states: ["untouched", "untouched"],
    },
    {
      code: "WRITE_TRANSPORT_UNAVAILABLE",
      message: "GitHub recovery transport rejected",
      stage: "upload",
      states: ["untouched", "untouched"],
    },
    {
      code: "WRITE_HTTP_RETRYABLE",
      message: "GitHub recovery returned retryable status 503",
      stage: "upload",
      states: ["untouched", "untouched"],
    },
    {
      code: "MUTATION_OUTCOME_AMBIGUOUS",
      message: "GitHub recovery mutation outcome is ambiguous",
      stage: "upload",
      states: ["untouched", "untouched"],
    },
    {
      code: "POST_WRITE_PROJECTION_DRIFT",
      message: "Quarantine title changed after body-only PATCH",
      stage: "quarantine",
      states: ["receipt-archived", "untouched"],
    },
  ]
  for (const item of cases) {
    const failure = Object.assign(new Error(item.message), { code: item.code })
    const harness = createApplyHarness({
      states: item.states,
      writerFailure: (count, stage) => (count === 1 && stage === item.stage ? failure : null),
    })
    await assert.rejects(
      runApply(harness),
      (error) => error === failure && error.code === item.code && error.message === item.message,
    )
    assert.equal(harness.mutationCount, 1)
    assert.equal(harness.events.filter(([kind]) => kind === "mutate").length, 1)
    assert.equal(harness.liveStates[1], "untouched")
  }

  const malformed = createApplyHarness({
    states: ["receipt-archived", "untouched"],
    malformedQuarantineReceipt: true,
  })
  await assert.rejects(runApply(malformed), /receipt/iu)
  assert.equal(malformed.mutationCount, 1)
  assert.deepEqual(malformed.liveStates, ["quarantined", "untouched"])
})

test("apply validates the truthful fence and final receipt timeline while passing projection hashes through", async () => {
  const invalidFences = [
    ["2026-08-31T23:59:59.999Z", "2026-09-01T00:10:00.000Z"],
    ["2026-09-01T00:09:59.999Z", "2026-09-01T00:10:00.000Z"],
    ["2026-09-01T00:10:01.000Z", "2026-09-01T00:10:00.000Z"],
    ["2026-09-01T00:10:00.000Z", "2026-09-01T00:10:00.001Z"],
  ]
  for (const fenceTimes of invalidFences) {
    const harness = createApplyHarness({
      states: ["receipt-archived", "quarantined"],
      fenceTimes,
    })
    await assert.rejects(runApply(harness), /fence|timeline|ordering/iu)
    assert.equal(harness.mutationCount, 1)
    assert.equal(harness.liveStates[1], "quarantined")
  }

  const finalRegressionTimes = Array.from({ length: 5 }, () => RECOVERY_NOW)
  finalRegressionTimes.push(Date.parse("2026-09-01T00:09:59.999Z"))
  const finalRegression = createApplyHarness({
    states: ["quarantined", "quarantined"],
    clock: () => finalRegressionTimes.shift(),
  })
  await assert.rejects(runApply(finalRegression), /regress|timeline|ordering/iu)

  const trustedHashes = createApplyHarness({
    states: ["receipt-archived", "quarantined"],
    quarantineReceiptTransform(receipt) {
      return Object.freeze({
        ...receipt,
        preWriteFence: Object.freeze({
          ...receipt.preWriteFence,
          projectionSha256: "c".repeat(64),
        }),
        postWriteFence: Object.freeze({
          ...receipt.postWriteFence,
          projectionSha256: "d".repeat(64),
        }),
      })
    },
  })
  const receipt = await runApply(trustedHashes)
  assert.equal(receipt.duplicates[0].preWriteFence.projectionSha256, "c".repeat(64))
  assert.equal(receipt.duplicates[0].postWriteFence.projectionSha256, "d".repeat(64))
})

test("apply requires the exact injected production observer result for the exact candidate", async () => {
  const bad = createApplyHarness({
    states: ["quarantined", "quarantined"],
    finalObservation: { ...FINAL_RECOVERY_OBSERVATION, diagnostics: ["drift"] },
  })
  await assert.rejects(runApply(bad), /final authorization/iu)

  const good = createApplyHarness({ states: ["quarantined", "quarantined"] })
  const receipt = await runApply(good)
  const observeEvent = good.events.find(([kind]) => kind === "observe")
  assert.deepEqual(observeEvent[1], {
    candidate: { version: POLICY.version, commitSha: POLICY.candidateSha },
  })
  assert.deepEqual(receipt.finalAuthorization, FINAL_RECOVERY_OBSERVATION)
})

function recoveryObservation({
  states = ["untouched", "untouched"],
  capturedAt = RECOVERY_CAPTURED_AT,
} = {}) {
  return {
    capturedAt,
    reviewedAuthority: {
      mergeCommitSha: MERGE_COMMIT_SHA,
      mergeTreeSha: REVIEWED_TREE_SHA,
      pullRequestNumber: 789,
      reviewedHeadSha: REVIEWED_HEAD_SHA,
      reviewedTreeSha: REVIEWED_TREE_SHA,
      validateRunId: 987654321,
    },
    repository: { id: 1210070282, nameWithOwner: POLICY.repository, mainSha: MERGE_COMMIT_SHA },
    workflow: { id: 260503756, state: "disabled_manually" },
    immutableReleases: { enabled: true },
    candidate: {
      version: POLICY.version,
      commitSha: POLICY.candidateSha,
      tagObjectSha: TAG_OBJECT_SHA,
    },
    npm: {
      packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => ({
        name,
        version: POLICY.version,
        status: "absent",
      })),
    },
    releaseRuns: [],
    releases: {
      canonical: {
        releaseId: POLICY.canonicalReleaseId,
        tagName: CANONICAL_OPAQUE_TAG,
        title: RELEASE_TITLE,
        targetCommitish: "main",
        draft: true,
        prerelease: false,
        immutable: false,
        body: ORIGINAL_BODY,
        marker: ORIGINAL_MARKER,
        assets: ORIGINAL_ASSETS,
      },
      duplicates: POLICY.duplicates.map((duplicate, index) =>
        recoverySnapshotForState(duplicate.releaseId, states[index]),
      ),
    },
  }
}

function captureReader({
  states = ["untouched", "untouched"],
  canonicalBody = null,
  candidateRuns = [
    {
      id: 700,
      runAttempt: 1,
      status: "completed",
      conclusion: "failure",
      headSha: POLICY.candidateSha,
      createdAt: RECOVERY_CAPTURED_AT,
      startedAt: RECOVERY_CAPTURED_AT,
      updatedAt: RECOVERY_CAPTURED_AT,
    },
  ],
  runs = candidateRuns,
  jobs = null,
  candidateReleases,
} = {}) {
  const observation = recoveryObservation({ states })
  const calls = []
  const reader = {
    async readReviewedMergeAuthority(reviewedCommit) {
      calls.push(["readReviewedMergeAuthority", reviewedCommit])
      return observation.reviewedAuthority
    },
    async readRepositoryState() {
      calls.push(["readRepositoryState"])
      return observation.repository
    },
    async readCandidateTag() {
      calls.push(["readCandidateTag"])
      return observation.candidate
    },
    async readWorkflowState() {
      calls.push(["readWorkflowState"])
      return observation.workflow
    },
    async readImmutableReleases() {
      calls.push(["readImmutableReleases"])
      return observation.immutableReleases
    },
    async readReleaseRuns() {
      calls.push(["readReleaseRuns"])
      return { runs, candidateRuns }
    },
    async readCandidatePublishJobs(runId, runAttempt) {
      calls.push(["readCandidatePublishJobs", runId, runAttempt])
      return jobs === null
        ? Array.from({ length: runAttempt }, (_, index) => ({
            id: runId * 10 + index + 1,
            runId,
            runAttempt: index + 1,
            name: "publish-npm",
            status: "completed",
            conclusion: "skipped",
            startedAt: "2026-08-27T20:27:31Z",
            completedAt: "2026-08-27T20:27:30Z",
          }))
        : typeof jobs === "function"
          ? jobs(runId, runAttempt)
          : jobs
    },
    async readNpmAbsence(name) {
      calls.push(["readNpmAbsence", name])
      return observation.npm.packages.find((pkg) => pkg.name === name)
    },
    async readReleaseSnapshot(releaseId, options) {
      calls.push(["readReleaseSnapshot", releaseId, options])
      if (releaseId === POLICY.canonicalReleaseId) {
        return canonicalBody === null
          ? observation.releases.canonical
          : { ...observation.releases.canonical, body: canonicalBody }
      }
      return observation.releases.duplicates.find((release) => release.releaseId === releaseId)
    },
    async listCandidateReleases() {
      calls.push(["listCandidateReleases"])
      return (
        candidateReleases ?? [
          releaseSummary(observation.releases.canonical),
          ...observation.releases.duplicates.map(releaseSummary),
        ]
      )
    },
  }
  return { reader: Object.freeze(reader), calls }
}

function releaseSummary(release) {
  return {
    releaseId: release.releaseId,
    tagName: release.tagName,
    title: release.title,
    draft: release.draft,
    prerelease: release.prerelease,
    immutable: release.immutable,
    targetCommitish: release.targetCommitish,
    marker: release.marker,
  }
}

test("captures canonical frozen evidence through only the read boundary", async () => {
  for (const states of [
    ["untouched", "untouched"],
    ["body-archived", "receipt-archived"],
    ["quarantined", "quarantined"],
  ]) {
    const { reader, calls } = captureReader({ states })
    const evidence = await captureDuplicateDraftRecoveryEvidence({
      reviewedCommit: MERGE_COMMIT_SHA,
      reader,
      now: () => Date.parse(RECOVERY_CAPTURED_AT),
    })

    assert.equal(Object.isFrozen(evidence), true)
    assert.equal(evidence.releases.canonical.tagName, CANONICAL_OPAQUE_TAG)
    assert.deepEqual(
      evidence.releases.duplicates.map((duplicate) => duplicate.state),
      states,
    )
    assert.deepEqual(
      calls.filter(([name]) => name === "readNpmAbsence").map(([, packageName]) => packageName),
      CANONICAL_RELEASE_PACKAGE_ORDER,
    )
    assert.deepEqual(
      calls.filter(([name]) => name === "readCandidatePublishJobs"),
      [["readCandidatePublishJobs", 700, 1]],
    )
    assert.equal(
      calls.some(([name]) => /write|upload|patch|delete/iu.test(name)),
      false,
    )
  }
})

test("capture rejects a canonical body larger than the recovery archive asset limit", async () => {
  // The canonical body becomes each duplicate's archive asset, so an oversized
  // body must fail at capture rather than part-way through a frozen window.
  const { reader } = captureReader({ canonicalBody: "x".repeat(MAX_ARCHIVE_ASSET_BYTES + 1) })
  await assert.rejects(
    captureDuplicateDraftRecoveryEvidence({
      reviewedCommit: MERGE_COMMIT_SHA,
      reader: Object.freeze({ ...reader }),
      now: () => Date.parse(RECOVERY_CAPTURED_AT),
    }),
    (error) => error.code === "CANONICAL_BODY_OVER_ARCHIVE_LIMIT",
  )
})

test("capture rejects canonical and partial duplicate title drift", async () => {
  for (const { states, releaseId } of [
    { states: ["untouched", "untouched"], releaseId: POLICY.canonicalReleaseId },
    { states: ["body-archived", "untouched"], releaseId: POLICY.duplicates[0].releaseId },
  ]) {
    const { reader: baseReader } = captureReader({ states })
    const reader = Object.freeze({
      ...baseReader,
      async readReleaseSnapshot(observedReleaseId, options) {
        const release = structuredClone(
          await baseReader.readReleaseSnapshot(observedReleaseId, options),
        )
        if (observedReleaseId === releaseId) release.title = "Dawn v0.8.22 changed"
        return release
      },
    })
    await assert.rejects(
      captureDuplicateDraftRecoveryEvidence({
        reviewedCommit: MERGE_COMMIT_SHA,
        reader,
        now: () => Date.parse(RECOVERY_CAPTURED_AT),
      }),
      /Release|evidence|exact|conflict/iu,
    )
  }
})

test("adapter canonical and duplicate snapshots compose directly into capture", async () => {
  const tags = new Map([
    [POLICY.canonicalReleaseId, CANONICAL_OPAQUE_TAG],
    ...POLICY.duplicates.map(({ releaseId, tagName }) => [releaseId, tagName]),
  ])
  const adapter = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${MERGE_COMMIT_SHA}\n`,
    fetchImpl: async (url) => {
      const match = new RegExp(
        `^${GITHUB_BASE_PATTERN}/releases/(\\d+)(/assets\\?per_page=100)?$`,
        "u",
      ).exec(url)
      assert.ok(match, `unexpected URL ${url}`)
      const releaseId = Number(match[1])
      assert.equal(tags.has(releaseId), true)
      if (match[2] !== undefined) {
        return jsonResponse(
          ORIGINAL_ASSETS.map((asset, index) => ({
            id: releaseId * 100 + index,
            name: asset.name,
            digest: `sha256:${asset.sha256}`,
            size: 1,
          })),
        )
      }
      return jsonResponse({
        id: releaseId,
        tag_name: tags.get(releaseId),
        name: RELEASE_TITLE,
        body: ORIGINAL_BODY,
        draft: true,
        prerelease: false,
        immutable: false,
        target_commitish: "main",
      })
    },
  })
  const { reader: fixtureReader } = captureReader()
  const reader = Object.freeze({
    ...fixtureReader,
    readReleaseSnapshot: adapter.readReleaseSnapshot,
  })

  const evidence = await captureDuplicateDraftRecoveryEvidence({
    reviewedCommit: MERGE_COMMIT_SHA,
    reader,
    now: () => Date.parse(RECOVERY_CAPTURED_AT),
  })
  assert.equal(Object.hasOwn(evidence.releases.canonical, "evidenceAssets"), false)
  assert.deepEqual(
    evidence.releases.duplicates.map(({ evidenceAssets }) => evidenceAssets),
    [[], []],
  )
})

test("capture rejects a writer-bearing dependency before any read", async () => {
  const { reader: exactReader, calls } = captureReader()
  const reader = Object.freeze({ ...exactReader, writer: Object.freeze({}) })
  await assert.rejects(
    captureDuplicateDraftRecoveryEvidence({
      reviewedCommit: MERGE_COMMIT_SHA,
      reader,
      now: () => Date.parse(RECOVERY_CAPTURED_AT),
    }),
    (error) => error.code === "CAPTURE_READER_SURFACE_INVALID",
  )
  assert.deepEqual(calls, [])
})

test("capture rejects hidden, symbolic, accessor, inherited, and unfrozen capabilities", async () => {
  const { reader: exactReader } = captureReader()
  const cases = []

  const hidden = { ...exactReader }
  Object.defineProperty(hidden, "writer", { value: () => {}, enumerable: false })
  cases.push(Object.freeze(hidden))

  const symbolic = { ...exactReader, [Symbol("writer")]: () => {} }
  cases.push(Object.freeze(symbolic))

  const accessor = { ...exactReader }
  Object.defineProperty(accessor, "readRepositoryState", {
    enumerable: true,
    get: () => exactReader.readRepositoryState,
  })
  cases.push(Object.freeze(accessor))

  cases.push(Object.freeze(Object.assign(Object.create({ writer: () => {} }), exactReader)))
  cases.push({ ...exactReader })
  const revoked = Proxy.revocable(exactReader, {})
  revoked.revoke()
  cases.push(revoked.proxy)

  for (const reader of cases) {
    await assert.rejects(
      captureDuplicateDraftRecoveryEvidence({
        reviewedCommit: MERGE_COMMIT_SHA,
        reader,
        now: () => Date.parse(RECOVERY_CAPTURED_AT),
      }),
      (error) => error.code === "CAPTURE_READER_SURFACE_INVALID",
    )
  }
})

test("capture preserves only allowlisted adapter diagnostics without remote details", async () => {
  const remoteDetail = "secret-token https://evil.example/remote-body"
  for (const { method, readCode, captureCode } of [
    {
      method: "readReviewedMergeAuthority",
      readCode: "PAGINATION_DRIFT",
      captureCode: "READ_PAGINATION_DRIFT",
    },
    {
      method: "readWorkflowState",
      readCode: "RELEASE_WORKFLOW_CONFLICT",
      captureCode: "READ_RELEASE_WORKFLOW_CONFLICT",
    },
    {
      method: "readReleaseRuns",
      readCode: "RELEASE_RUNS_UNAVAILABLE",
      captureCode: "READ_RELEASE_RUNS_UNAVAILABLE",
    },
  ]) {
    const { reader: baseReader } = captureReader()
    const reader = Object.freeze({
      ...baseReader,
      [method]: async () => {
        throw new DuplicateDraftRecoveryReadError(readCode, remoteDetail)
      },
    })
    await assert.rejects(
      captureDuplicateDraftRecoveryEvidence({
        reviewedCommit: MERGE_COMMIT_SHA,
        reader,
        now: () => Date.parse(RECOVERY_CAPTURED_AT),
      }),
      (error) => {
        assert.equal(error.code, captureCode)
        assert.equal(error.message, `Recovery capture read ${method} failed`)
        assert.equal(JSON.stringify(error).includes(remoteDetail), false)
        assert.equal(error.message.includes("secret-token"), false)
        assert.equal(error.message.includes("evil.example"), false)
        return true
      },
    )
  }

  const { reader: baseReader } = captureReader()
  const reader = Object.freeze({
    ...baseReader,
    readWorkflowState: async () => {
      throw new DuplicateDraftRecoveryReadError("UNREVIEWED_REMOTE_CODE", remoteDetail)
    },
  })
  await assert.rejects(
    captureDuplicateDraftRecoveryEvidence({
      reviewedCommit: MERGE_COMMIT_SHA,
      reader,
      now: () => Date.parse(RECOVERY_CAPTURED_AT),
    }),
    (error) =>
      error.code === "WORKFLOW_STATE_UNAVAILABLE" && !error.message.includes("secret-token"),
  )
})

test("capture checks jobs for every observed candidate run and rejects started publish-npm", async () => {
  const candidateRuns = [
    {
      id: 700,
      runAttempt: 1,
      status: "completed",
      conclusion: "failure",
      headSha: POLICY.candidateSha,
      createdAt: RECOVERY_CAPTURED_AT,
      startedAt: RECOVERY_CAPTURED_AT,
      updatedAt: RECOVERY_CAPTURED_AT,
    },
    {
      id: 800,
      runAttempt: 2,
      status: "completed",
      conclusion: "success",
      headSha: POLICY.candidateSha,
      createdAt: RECOVERY_CAPTURED_AT,
      startedAt: RECOVERY_CAPTURED_AT,
      updatedAt: RECOVERY_CAPTURED_AT,
    },
  ]
  const { reader, calls } = captureReader({
    candidateRuns,
    jobs: (runId, currentAttempt) =>
      Array.from({ length: currentAttempt }, (_, index) => {
        const runAttempt = index + 1
        const startedEarlierAttempt = currentAttempt === 2 && runAttempt === 1
        return {
          id: runId * 10 + runAttempt,
          runId,
          runAttempt,
          name: "publish-npm",
          status: "completed",
          conclusion: startedEarlierAttempt ? "failure" : "skipped",
          startedAt: "2026-08-27T20:27:31Z",
          completedAt: startedEarlierAttempt ? RECOVERY_CAPTURED_AT : "2026-08-27T20:27:30Z",
        }
      }),
  })
  await assert.rejects(
    captureDuplicateDraftRecoveryEvidence({
      reviewedCommit: MERGE_COMMIT_SHA,
      reader,
      now: () => Date.parse(RECOVERY_CAPTURED_AT),
    }),
    (error) => error.code === "CANDIDATE_PUBLISH_JOB_STARTED",
  )
  assert.deepEqual(
    calls.filter(([name]) => name === "readCandidatePublishJobs"),
    [
      ["readCandidatePublishJobs", 700, 1],
      ["readCandidatePublishJobs", 800, 2],
    ],
  )
})

test("capture treats completed publish jobs without start timestamps as malformed", async () => {
  const { reader } = captureReader({
    jobs: [
      {
        id: 702,
        runId: 700,
        runAttempt: 1,
        name: "publish-npm",
        status: "completed",
        conclusion: "success",
        startedAt: null,
        completedAt: RECOVERY_CAPTURED_AT,
      },
    ],
  })
  await assert.rejects(
    captureDuplicateDraftRecoveryEvidence({
      reviewedCommit: MERGE_COMMIT_SHA,
      reader,
      now: () => Date.parse(RECOVERY_CAPTURED_AT),
    }),
    (error) => error.code === "CANDIDATE_JOBS_MALFORMED",
  )
})

test("capture accepts skipped scheduler timestamps and blocks publishers that may have executed", async () => {
  for (const [startedAt, completedAt] of [
    ["2026-08-27T20:27:31Z", "2026-08-27T20:27:30Z"],
    ["2026-08-27T20:27:31Z", "2026-08-27T20:27:31Z"],
  ]) {
    const { reader } = captureReader({
      jobs: [
        {
          id: 701,
          runId: 700,
          runAttempt: 1,
          name: "publish-npm",
          status: "completed",
          conclusion: "skipped",
          startedAt,
          completedAt,
        },
      ],
    })
    await captureDuplicateDraftRecoveryEvidence({
      reviewedCommit: MERGE_COMMIT_SHA,
      reader,
      now: () => Date.parse(RECOVERY_CAPTURED_AT),
    })
  }

  for (const job of [
    {
      status: "in_progress",
      conclusion: null,
      startedAt: RECOVERY_CAPTURED_AT,
      completedAt: null,
    },
    ...["cancelled", "success", "failure"].map((conclusion) => ({
      status: "completed",
      conclusion,
      startedAt: RECOVERY_CAPTURED_AT,
      completedAt: RECOVERY_CAPTURED_AT,
    })),
  ]) {
    const { reader } = captureReader({
      jobs: [
        {
          id: 701,
          runId: 700,
          runAttempt: 1,
          name: "publish-npm",
          ...job,
        },
      ],
    })
    await assert.rejects(
      captureDuplicateDraftRecoveryEvidence({
        reviewedCommit: MERGE_COMMIT_SHA,
        reader,
        now: () => Date.parse(RECOVERY_CAPTURED_AT),
      }),
      (error) => error.code === "CANDIDATE_PUBLISH_JOB_STARTED",
    )
  }
})

test("capture composes all five sanitized terminal runs with skipped publishers", async () => {
  const publishers = [
    [33348528971, "2026-08-31T01:55:53Z", "2026-08-31T01:55:53Z"],
    [33349661741, "2026-08-31T02:07:47Z", "2026-08-31T02:07:46Z"],
    [33406670822, "2026-08-31T15:08:27Z", "2026-08-31T15:08:27Z"],
    [33410175329, "2026-08-31T15:45:12Z", "2026-08-31T15:45:12Z"],
    [33418085547, "2026-08-31T17:20:32Z", "2026-08-31T17:20:31Z"],
  ]
  const candidateRuns = publishers.map(([id]) => ({
    id,
    runAttempt: 1,
    status: "completed",
    conclusion: "failure",
    headSha: POLICY.candidateSha,
    createdAt: RECOVERY_CAPTURED_AT,
    startedAt: RECOVERY_CAPTURED_AT,
    updatedAt: RECOVERY_CAPTURED_AT,
  }))
  const { reader, calls } = captureReader({
    candidateRuns,
    jobs: (runId) => {
      const [, startedAt, completedAt] = publishers.find(([id]) => id === runId)
      return [
        {
          id: runId * 10,
          runId,
          runAttempt: 1,
          name: "publish-npm",
          status: "completed",
          conclusion: "skipped",
          startedAt,
          completedAt,
        },
      ]
    },
  })

  await captureDuplicateDraftRecoveryEvidence({
    reviewedCommit: MERGE_COMMIT_SHA,
    reader,
    now: () => Date.parse(RECOVERY_CAPTURED_AT),
  })
  assert.deepEqual(
    calls.filter(([method]) => method === "readCandidatePublishJobs"),
    publishers.map(([id]) => ["readCandidatePublishJobs", id, 1]),
  )
})

test("capture requires calendar-valid run and job timestamps while accepting canonical boundaries", async () => {
  for (const timestamp of [
    "2026-02-31T00:00:00Z",
    "2025-02-29T12:00:00.000Z",
    "2026-01-01T24:00:00Z",
  ]) {
    const { reader } = captureReader({
      candidateRuns: [
        {
          id: 700,
          runAttempt: 1,
          status: "completed",
          conclusion: "failure",
          headSha: POLICY.candidateSha,
          createdAt: timestamp,
          startedAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    })
    await assert.rejects(
      captureDuplicateDraftRecoveryEvidence({
        reviewedCommit: MERGE_COMMIT_SHA,
        reader,
        now: () => Date.parse(RECOVERY_CAPTURED_AT),
      }),
      (error) => error.code === "RELEASE_RUNS_MALFORMED",
    )

    const { reader: jobReader } = captureReader({
      jobs: [
        {
          id: 701,
          runId: 700,
          runAttempt: 1,
          name: "publish-npm",
          status: "completed",
          conclusion: "failure",
          startedAt: timestamp,
          completedAt: timestamp,
        },
      ],
    })
    await assert.rejects(
      captureDuplicateDraftRecoveryEvidence({
        reviewedCommit: MERGE_COMMIT_SHA,
        reader: jobReader,
        now: () => Date.parse(RECOVERY_CAPTURED_AT),
      }),
      (error) => error.code === "CANDIDATE_JOBS_MALFORMED",
    )
  }

  const boundaryRun = {
    id: 700,
    runAttempt: 1,
    status: "completed",
    conclusion: "failure",
    headSha: POLICY.candidateSha,
    createdAt: "2024-02-29T23:59:59Z",
    startedAt: "2024-02-29T23:59:59.001Z",
    updatedAt: "2024-02-29T23:59:59.123Z",
  }
  const { reader } = captureReader({
    candidateRuns: [boundaryRun],
    jobs: [
      {
        id: 701,
        runId: 700,
        runAttempt: 1,
        name: "publish-npm",
        status: "completed",
        conclusion: "skipped",
        startedAt: "2026-08-27T20:27:31Z",
        completedAt: "2026-08-27T20:27:30Z",
      },
    ],
  })
  const evidence = await captureDuplicateDraftRecoveryEvidence({
    reviewedCommit: MERGE_COMMIT_SHA,
    reader,
    now: () => Date.parse(RECOVERY_CAPTURED_AT),
  })
  assert.deepEqual(evidence.releaseRuns, [])
})

test("capture requires exact run identity, attempt coverage, and one publisher per attempt", async () => {
  const candidateRuns = [
    {
      id: 800,
      runAttempt: 2,
      status: "completed",
      conclusion: "failure",
      headSha: POLICY.candidateSha,
      createdAt: RECOVERY_CAPTURED_AT,
      startedAt: RECOVERY_CAPTURED_AT,
      updatedAt: RECOVERY_CAPTURED_AT,
    },
  ]
  const attemptOne = {
    id: 801,
    runId: 800,
    runAttempt: 1,
    name: "publish-npm",
    status: "completed",
    conclusion: "skipped",
    startedAt: "2026-08-27T20:27:31Z",
    completedAt: "2026-08-27T20:27:30Z",
  }
  const attemptTwo = { ...attemptOne, id: 802, runAttempt: 2 }
  for (const jobs of [
    [{ ...attemptOne, runId: 900 }, attemptTwo],
    [attemptTwo],
    [
      {
        ...attemptOne,
        name: "prepare",
        status: "completed",
        conclusion: "success",
        startedAt: RECOVERY_CAPTURED_AT,
        completedAt: RECOVERY_CAPTURED_AT,
      },
      attemptTwo,
    ],
    [attemptOne, attemptTwo, { ...attemptTwo, id: 803 }],
    [attemptOne, attemptTwo, { ...attemptTwo, id: 804, runAttempt: 3 }],
    [attemptOne, { ...attemptTwo, id: attemptOne.id }],
  ]) {
    const { reader } = captureReader({ candidateRuns, jobs })
    await assert.rejects(
      captureDuplicateDraftRecoveryEvidence({
        reviewedCommit: MERGE_COMMIT_SHA,
        reader,
        now: () => Date.parse(RECOVERY_CAPTURED_AT),
      }),
      (error) => error.code === "CANDIDATE_JOBS_MALFORMED",
    )
  }

  const { reader, calls } = captureReader({ candidateRuns, jobs: [attemptOne, attemptTwo] })
  await captureDuplicateDraftRecoveryEvidence({
    reviewedCommit: MERGE_COMMIT_SHA,
    reader,
    now: () => Date.parse(RECOVERY_CAPTURED_AT),
  })
  assert.deepEqual(
    calls.filter(([name]) => name === "readCandidatePublishJobs"),
    [["readCandidatePublishJobs", 800, 2]],
  )
})

test("capture reconciles the exhaustive and candidate-filtered workflow run sets", async () => {
  const candidateRun = {
    id: 700,
    runAttempt: 1,
    status: "completed",
    conclusion: "failure",
    headSha: POLICY.candidateSha,
    createdAt: RECOVERY_CAPTURED_AT,
    startedAt: RECOVERY_CAPTURED_AT,
    updatedAt: RECOVERY_CAPTURED_AT,
  }
  for (const overrides of [
    { runs: [candidateRun], candidateRuns: [] },
    { runs: [], candidateRuns: [candidateRun] },
    {
      runs: [candidateRun],
      candidateRuns: [{ ...candidateRun, conclusion: "success" }],
    },
  ]) {
    const { reader, calls } = captureReader(overrides)
    await assert.rejects(
      captureDuplicateDraftRecoveryEvidence({
        reviewedCommit: MERGE_COMMIT_SHA,
        reader,
        now: () => Date.parse(RECOVERY_CAPTURED_AT),
      }),
      (error) => error.code === "RELEASE_RUNS_MALFORMED",
    )
    assert.deepEqual(
      calls.filter(([name]) => name === "readCandidatePublishJobs"),
      [],
    )
  }
})

test("capture refuses non-draft and immutable fourth marker-backed candidate Releases", async () => {
  const observation = recoveryObservation()
  for (const state of [
    { draft: false, immutable: false },
    { draft: true, immutable: true },
  ]) {
    const releases = [
      releaseSummary(observation.releases.canonical),
      ...observation.releases.duplicates.map(releaseSummary),
      {
        ...releaseSummary(observation.releases.canonical),
        ...state,
        releaseId: 400000000,
        tagName: "untagged-fourth-candidate",
        marker: { ...ORIGINAL_MARKER, commitSha: "e".repeat(40) },
      },
    ]
    const { reader } = captureReader({ candidateReleases: releases })
    await assert.rejects(
      captureDuplicateDraftRecoveryEvidence({
        reviewedCommit: MERGE_COMMIT_SHA,
        reader,
        now: () => Date.parse(RECOVERY_CAPTURED_AT),
      }),
      (error) => error.code === "CANDIDATE_RELEASE_INVENTORY_CONFLICT",
    )
  }
})

test("capture and evidence reject exact-tag or arbitrary canonical raw tag names", async () => {
  for (const tagName of [`v${POLICY.version}`, "untagged-arbitrary-canonical"]) {
    const observation = recoveryObservation()
    observation.releases.canonical.tagName = tagName
    assert.throws(() => canonicalDuplicateDraftEvidence(observation), /canonical Release/iu)

    const { reader: exactReader } = captureReader({
      candidateReleases: [
        { ...releaseSummary(observation.releases.canonical), tagName },
        ...observation.releases.duplicates.map(releaseSummary),
      ],
    })
    const reader = Object.freeze({
      ...exactReader,
      readReleaseSnapshot: async (releaseId) =>
        releaseId === POLICY.canonicalReleaseId
          ? observation.releases.canonical
          : observation.releases.duplicates.find((release) => release.releaseId === releaseId),
    })
    await assert.rejects(
      captureDuplicateDraftRecoveryEvidence({
        reviewedCommit: MERGE_COMMIT_SHA,
        reader,
        now: () => Date.parse(RECOVERY_CAPTURED_AT),
      }),
      (error) => typeof error.code === "string",
    )
  }
})

test("canonical evidence pins the exact numeric GitHub repository identity", () => {
  for (const id of ["1210070282", 1210070281, 424242]) {
    const observation = recoveryObservation()
    observation.repository.id = id
    assert.throws(() => canonicalDuplicateDraftEvidence(observation), /repository identity/iu)
  }
})

function recoverySnapshotForState(releaseId, state) {
  if (state === "untouched") return snapshot({}, releaseId)
  if (state === "body-archived") return snapshot({ evidenceAssets: ["body"] }, releaseId)
  const expected = expectedFor(releaseId)
  const recoveryReceipt = { ...expected.recoveryReceipt, recoveryCommit: MERGE_COMMIT_SHA }
  const receiptBytes = canonicalRecoveryReceipt(recoveryReceipt).toString("utf8")
  const receiptSha256 = createHash("sha256").update(receiptBytes, "utf8").digest("hex")
  if (state === "receipt-archived") {
    return snapshot({ evidenceAssets: ["body", "receipt"], receiptBytes, receiptSha256 }, releaseId)
  }
  if (state === "quarantined") {
    return snapshot(
      {
        quarantined: true,
        evidenceAssets: ["body", "receipt"],
        receiptBytes,
        receiptSha256,
        body: canonicalRecoveryNotice({
          repository: POLICY.repository,
          version: POLICY.version,
          canonicalReleaseId: POLICY.canonicalReleaseId,
          duplicateReleaseId: releaseId,
          originalBodySha256: BODY_SHA256,
          archiveAssetName: originalBodyAssetName(releaseId, BODY_SHA256),
          receiptAssetName: recoveryReceiptAssetName(releaseId),
          receiptSha256,
        }),
      },
      releaseId,
    )
  }
  throw new TypeError(`Unknown recovery test state: ${state}`)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

test("seals exact canonical duplicate-draft evidence with derived recovery state", () => {
  const observation = recoveryObservation({ states: ["untouched", "receipt-archived"] })
  const bytes = canonicalDuplicateDraftEvidence(observation)
  const evidence = parseDuplicateDraftEvidence(bytes)

  assert.equal(bytes.toString("utf8"), `${JSON.stringify(canonicalize(evidence))}\n`)
  assert.deepEqual(bytes, canonicalDuplicateDraftEvidence(reverseObjectOrder(observation)))
  assert.deepEqual(Object.keys(evidence), [
    "schemaVersion",
    "capturedAt",
    "reviewedAuthority",
    "repository",
    "workflow",
    "immutableReleases",
    "candidate",
    "npm",
    "releaseRuns",
    "releases",
  ])
  assert.equal(evidence.schemaVersion, 1)
  assert.equal(evidence.capturedAt, RECOVERY_CAPTURED_AT)
  assert.deepEqual(
    evidence.npm.packages.map(({ name }) => name),
    CANONICAL_RELEASE_PACKAGE_ORDER,
  )
  assert.deepEqual(evidence.releaseRuns, [])
  assert.equal(evidence.releases.canonical.releaseId, POLICY.canonicalReleaseId)
  assert.deepEqual(
    evidence.releases.duplicates.map(({ releaseId, state, remainingTransitions }) => [
      releaseId,
      state,
      remainingTransitions,
    ]),
    [
      [
        POLICY.duplicates[0].releaseId,
        "untouched",
        ["archive-body", "archive-receipt", "quarantine"],
      ],
      [POLICY.duplicates[1].releaseId, "receipt-archived", ["quarantine"]],
    ],
  )
  assert.equal(
    evidence.releases.duplicates[0].originalBodySha256,
    createHash("sha256").update(ORIGINAL_BODY, "utf8").digest("hex"),
  )
  assert.equal(evidence.releases.duplicates[0].baseAssetSetSha256, BASE_ASSET_SET_SHA256)
  assert.equal(Object.isFrozen(evidence), true)
  assert.equal(Object.isFrozen(evidence.releases.duplicates[0]), true)
  assert.throws(() => {
    evidence.releases.duplicates[0].state = "quarantined"
  }, TypeError)
})

test("rejects noncanonical, unsafe, sparse, and caller-trusted duplicate evidence", () => {
  const bytes = canonicalDuplicateDraftEvidence(recoveryObservation())
  const evidence = parseDuplicateDraftEvidence(bytes)
  const noncanonical = Buffer.from(`${JSON.stringify(evidence)}\n`, "utf8")
  assert.throws(() => parseDuplicateDraftEvidence(noncanonical), /canonical/u)

  const extra = structuredClone(evidence)
  extra.repository.extra = true
  assert.throws(() => canonicalDuplicateDraftEvidence(extra), /fields/u)

  const accessor = recoveryObservation()
  let accessed = false
  Object.defineProperty(accessor.repository, "id", {
    enumerable: true,
    get() {
      accessed = true
      return 1210070282
    },
  })
  assert.throws(() => canonicalDuplicateDraftEvidence(accessor), /Invalid field|unsafe/u)
  assert.equal(accessed, false)

  const sparse = recoveryObservation()
  delete sparse.npm.packages[0]
  assert.throws(() => canonicalDuplicateDraftEvidence(sparse), /Invalid array|package/u)

  const colluding = structuredClone(evidence)
  colluding.releases.duplicates[0].state = "quarantined"
  assert.throws(() => canonicalDuplicateDraftEvidence(colluding), /state|derived/u)
})

test("verifies fresh evidence against an exact current observation and rejects time or observation drift", () => {
  const observation = recoveryObservation({ states: ["body-archived", "quarantined"] })
  const evidence = parseDuplicateDraftEvidence(canonicalDuplicateDraftEvidence(observation))
  const report = verifyDuplicateDraftEvidence({
    evidence,
    current: observation,
    now: () => RECOVERY_NOW,
  })
  assert.deepEqual(report, { schemaVersion: 1, status: "PASS" })
  assert.equal(Object.isFrozen(report), true)
  assert.deepEqual(
    verifyDuplicateDraftEvidence({
      evidence,
      current: recoveryObservation({
        states: ["body-archived", "quarantined"],
        capturedAt: evidence.capturedAt,
      }),
      now: () => RECOVERY_NOW,
    }),
    { schemaVersion: 1, status: "PASS" },
  )
  assert.throws(
    () =>
      verifyDuplicateDraftEvidence({
        evidence,
        current: recoveryObservation({ capturedAt: "2026-08-31T23:59:59.999Z" }),
        now: () => RECOVERY_NOW,
      }),
    /predates/u,
  )
  assert.deepEqual(
    verifyDuplicateDraftEvidence({
      evidence,
      current: observation,
      now: () => Date.parse("2026-09-01T00:15:00.000Z"),
    }),
    { schemaVersion: 1, status: "PASS" },
  )
  assert.throws(
    () =>
      verifyDuplicateDraftEvidence({
        evidence,
        current: recoveryObservation({ capturedAt: "2026-08-31T23:44:59.999Z" }),
        now: () => RECOVERY_NOW,
      }),
    /current.*expired|expired.*current/iu,
  )
  assert.throws(
    () =>
      verifyDuplicateDraftEvidence({
        evidence,
        current: recoveryObservation({ capturedAt: "2026-09-01T00:10:00.001Z" }),
        now: () => RECOVERY_NOW,
      }),
    /current.*future|future.*current/iu,
  )

  assert.throws(
    () =>
      verifyDuplicateDraftEvidence({
        evidence,
        current: observation,
        now: () => Date.parse("2026-09-01T00:15:00.001Z"),
      }),
    /expired/u,
  )
  assert.throws(
    () =>
      verifyDuplicateDraftEvidence({
        evidence,
        current: observation,
        now: () => Date.parse("2026-08-31T23:59:59.999Z"),
      }),
    /future/u,
  )
  const drifted = recoveryObservation({ states: ["receipt-archived", "quarantined"] })
  assert.throws(
    () => verifyDuplicateDraftEvidence({ evidence, current: drifted, now: () => RECOVERY_NOW }),
    /drift/u,
  )
})

test("retains immutable expired partial-state evidence while allowing a distinct fresh superseding value", () => {
  const expired = parseDuplicateDraftEvidence(
    canonicalDuplicateDraftEvidence(
      recoveryObservation({
        states: ["body-archived", "untouched"],
        capturedAt: "2026-08-31T23:44:59.999Z",
      }),
    ),
  )
  assert.equal(Object.isFrozen(expired), true)
  assert.equal(expired.releases.duplicates[0].state, "body-archived")
  assert.throws(() => {
    expired.releases.duplicates[0].remainingTransitions.pop()
  }, TypeError)
  assert.throws(
    () =>
      verifyDuplicateDraftEvidence({
        evidence: expired,
        current: recoveryObservation({
          states: ["body-archived", "untouched"],
          capturedAt: expired.capturedAt,
        }),
        now: () => RECOVERY_NOW,
      }),
    /expired/u,
  )

  const superseding = canonicalDuplicateDraftEvidence(
    recoveryObservation({ states: ["receipt-archived", "untouched"] }),
  )
  assert.notDeepEqual(superseding, canonicalDuplicateDraftEvidence({ ...expired }))
  const writeOnceValues = new Map([
    ["duplicate-draft-evidence-20260831T234459999Z.json", expired],
    ["duplicate-draft-evidence-20260901T000000000Z.json", parseDuplicateDraftEvidence(superseding)],
  ])
  assert.equal(writeOnceValues.size, 2)
  assert.equal(writeOnceValues.get("duplicate-draft-evidence-20260831T234459999Z.json"), expired)
})

test("rejects arbitrary bytes on original and body-archive assets before sealing evidence", () => {
  const bodyArchive = recoveryObservation({ states: ["body-archived", "untouched"] })
  bodyArchive.releases.duplicates[0].assets.at(-1).bytes = "body archive secret"
  assert.throws(() => canonicalDuplicateDraftEvidence(bodyArchive), /asset|field/u)

  const originalAsset = recoveryObservation()
  originalAsset.releases.duplicates[0].assets[0] = {
    ...originalAsset.releases.duplicates[0].assets[0],
    bytes: "original asset secret",
  }
  assert.throws(() => canonicalDuplicateDraftEvidence(originalAsset), /asset|field/u)

  const evidence = parseDuplicateDraftEvidence(
    canonicalDuplicateDraftEvidence(
      recoveryObservation({ states: ["body-archived", "untouched"] }),
    ),
  )
  assert.equal(
    evidence.releases.duplicates[0].assets.some((asset) => Object.hasOwn(asset, "bytes")),
    false,
  )
})

function reverseObjectOrder(value) {
  if (Array.isArray(value)) return value.map(reverseObjectOrder)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseObjectOrder(item)]),
    )
  }
  return value
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}
