import assert from "node:assert/strict"
import test from "node:test"

import {
  canonicalReleaseRecordBytes,
  createReleaseRecord,
  parseReleaseRecord,
  releaseRecordSha256,
} from "../release-record.mjs"

const VERSION = "0.8.22"
const SHA = "a".repeat(40)
const MANIFEST_SHA = "b".repeat(64)
const SERVICE_DIGEST = `sha256:${"c".repeat(64)}`
const CANDIDATE = Object.freeze({
  version: VERSION,
  commitSha: SHA,
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})

test("createReleaseRecord binds the candidate to the exact artifact upload receipt and run", () => {
  const record = createReleaseRecord({
    candidate: CANDIDATE,
    manifestSha256: MANIFEST_SHA,
    artifactUpload: {
      id: "12345678901234567890",
      name: `release-v${VERSION}-${SHA.slice(0, 12)}`,
      serviceDigest: SERVICE_DIGEST,
    },
    prepareRun: { id: "987654321", attempt: 2 },
  })

  assert.deepEqual(record, releaseRecord())
  assertRecursivelyFrozen(record)
  assert.match(releaseRecordSha256(record), /^[0-9a-f]{64}$/u)
  assert.equal(canonicalReleaseRecordBytes(record).at(-1), 10)
})

test("createReleaseRecord canonicalizes the upload action's bare SHA-256 digest", () => {
  const record = createReleaseRecord({
    candidate: CANDIDATE,
    manifestSha256: MANIFEST_SHA,
    artifactUpload: {
      id: "12345678901234567890",
      name: `release-v${VERSION}-${SHA.slice(0, 12)}`,
      serviceDigest: "C".repeat(64),
    },
    prepareRun: { id: "987654321", attempt: 2 },
  })

  assert.equal(record.actionsArtifact.serviceDigest, SERVICE_DIGEST)
  const persisted = releaseRecord()
  persisted.actionsArtifact.serviceDigest = "c".repeat(64)
  assert.throws(() => parseReleaseRecord(persisted), /service digest/u)
})

test("release records are exact-key, accessor-safe snapshots", () => {
  const extra = releaseRecord()
  extra.extra = true
  assert.throws(() => parseReleaseRecord(extra), /unknown field extra/u)

  const accessor = releaseRecord()
  let reads = 0
  Object.defineProperty(accessor.actionsArtifact, "name", {
    enumerable: true,
    get() {
      reads += 1
      return `release-v${VERSION}-${SHA.slice(0, 12)}`
    },
  })
  assert.throws(() => parseReleaseRecord(accessor), /snapshot/u)
  assert.equal(reads, 0)

  const hidden = releaseRecord()
  Object.defineProperty(hidden, "extra", { value: true })
  assert.throws(() => parseReleaseRecord(hidden), /snapshot|unknown field/u)

  const symbol = releaseRecord()
  symbol[Symbol("extra")] = true
  assert.throws(() => parseReleaseRecord(symbol), /snapshot|symbol/u)
})

test("release records reject malformed or mismatched identities", () => {
  const cases = [
    ["version", (value) => (value.version = "^0.8.22")],
    ["tag", (value) => (value.tag = "v0.8.23")],
    ["SHA", (value) => (value.commitSha = "A".repeat(40))],
    ["manifest", (value) => (value.manifestSha256 = "nope")],
    ["artifact ID", (value) => (value.actionsArtifact.id = 123)],
    ["artifact name", (value) => (value.actionsArtifact.name = "release-by-name")],
    ["service digest", (value) => (value.actionsArtifact.serviceDigest = "c".repeat(64))],
    [
      "service digest",
      (value) => (value.actionsArtifact.serviceDigest = `sha256:${"C".repeat(64)}`),
    ],
    ["run ID", (value) => (value.actionsArtifact.prepareRunId = "0")],
    ["run attempt", (value) => (value.actionsArtifact.prepareRunAttempt = 0)],
  ]
  for (const [label, mutate] of cases) {
    const value = releaseRecord()
    mutate(value)
    assert.throws(() => parseReleaseRecord(value), new RegExp(label, "iu"))
  }
})

test("createReleaseRecord never infers an Actions artifact from its name", () => {
  for (const artifactUpload of [
    undefined,
    { name: `release-v${VERSION}-${SHA.slice(0, 12)}` },
    {
      id: "123",
      name: `release-v${VERSION}-${SHA.slice(0, 12)}`,
      serviceDigest: undefined,
    },
  ]) {
    assert.throws(
      () =>
        createReleaseRecord({
          candidate: CANDIDATE,
          manifestSha256: MANIFEST_SHA,
          artifactUpload,
          prepareRun: { id: "987", attempt: 1 },
        }),
      /upload receipt|service digest/iu,
    )
  }
})

function releaseRecord() {
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: SHA,
    tag: `v${VERSION}`,
    manifestSha256: MANIFEST_SHA,
    actionsArtifact: {
      id: "12345678901234567890",
      name: `release-v${VERSION}-${SHA.slice(0, 12)}`,
      serviceDigest: SERVICE_DIGEST,
      prepareRunId: "987654321",
      prepareRunAttempt: 2,
    },
  }
}

function assertRecursivelyFrozen(value) {
  if (value === null || typeof value !== "object") return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertRecursivelyFrozen(child)
}
