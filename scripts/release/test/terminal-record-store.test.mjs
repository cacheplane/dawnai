// scripts/release/test/terminal-record-store.test.mjs
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import {
  canonicalTerminalRecordBytes,
  parseOperatorRecoveryRecord,
  readTerminalRecord,
  terminalRecordPath,
} from "../terminal-record-store.mjs"

// biome-ignore lint/suspicious/noExportsInTest: fixture builders are imported by later terminal-record tasks
export const VERSION = "0.8.22"
// biome-ignore lint/suspicious/noExportsInTest: fixture builders are imported by later terminal-record tasks
export const COMMIT_SHA = "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8"
// biome-ignore lint/suspicious/noExportsInTest: fixture builders are imported by later terminal-record tasks
export const TAG_OBJECT_SHA = "3".repeat(40)
// biome-ignore lint/suspicious/noExportsInTest: fixture builders are imported by later terminal-record tasks
export const REVIEWED_COMMIT = "4".repeat(40)
const SHA256_A = "a".repeat(64)
const SHA256_B = "b".repeat(64)
const SHA256_C = "c".repeat(64)

// biome-ignore lint/suspicious/noExportsInTest: fixture builders are imported by later terminal-record tasks
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

// biome-ignore lint/suspicious/noExportsInTest: fixture builders are imported by later terminal-record tasks
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
    baseAssetSetSha256: SHA256_C,
    attestationSet: attestationSet(),
    npmEvidenceSha256: null,
    smoke: null,
    audit: null,
    abandonmentSha256: null,
  }
}

function npmObservation(observedAt) {
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

// biome-ignore lint/suspicious/noExportsInTest: fixture builders are imported by later terminal-record tasks
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
        baseAssetSetSha256: SHA256_C,
        attestationSet: attestationSet(),
      },
    },
    evidence: {
      escrowAssets: Array.from({ length: 45 }, (_, index) => ({
        id: 1000 + index,
        name:
          index === 0
            ? "manifest.json"
            : index === 1
              ? "release-record.json"
              : index === 2
                ? "manifest.json.intoto.jsonl"
                : `pkg-${index}.tgz`,
        sha256: SHA256_A,
      })),
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

test("canonical bytes are sorted-key JSON with one trailing newline", () => {
  const bytes = canonicalTerminalRecordBytes(record())
  const text = bytes.toString("utf8")
  assert.ok(text.endsWith("}\n"))
  assert.equal(text.indexOf("\n"), text.length - 1)
  assert.deepEqual(Object.keys(JSON.parse(text)), [...Object.keys(JSON.parse(text))].sort())
})

test("parses a canonical operator-recovery record and freezes it", () => {
  const parsed = parseOperatorRecoveryRecord(canonicalTerminalRecordBytes(record()))
  assert.equal(parsed.version, VERSION)
  assert.equal(parsed.authority.mode, "operator-recovery")
  assert.ok(Object.isFrozen(parsed))
  assert.ok(Object.isFrozen(parsed.evidence.npm.observations[0]))
})

test("rejects non-canonical bytes, unknown keys, and bad digests", () => {
  const value = record()
  assert.throws(
    () => parseOperatorRecoveryRecord(Buffer.from(JSON.stringify(value), "utf8")),
    /canonical/u,
  )
  assert.throws(
    () => parseOperatorRecoveryRecord(canonicalTerminalRecordBytes({ ...value, extra: 1 })),
    /fields/u,
  )
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(
          record({ authority: { ...value.authority, reviewedCommit: "zz" } }),
        ),
      ),
    /reviewed commit/iu,
  )
  assert.throws(
    () => parseOperatorRecoveryRecord(canonicalTerminalRecordBytes(record({ kind: "other" }))),
    /kind/u,
  )
})

test("rejects npm observations that are not two absent sweeps at least sixty seconds apart", () => {
  const value = record()
  const close = {
    ...value.evidence,
    npm: {
      observations: [
        npmObservation("2026-09-03T18:00:00.000Z"),
        npmObservation("2026-09-03T18:00:30.000Z"),
      ],
    },
  }
  assert.throws(
    () => parseOperatorRecoveryRecord(canonicalTerminalRecordBytes(record({ evidence: close }))),
    /sixty/u,
  )
  const present = npmObservation("2026-09-03T18:01:05.000Z")
  present.packages[0] = { ...present.packages[0], status: "PRESENT", httpStatus: 200, code: null }
  const published = {
    ...value.evidence,
    npm: { observations: [npmObservation("2026-09-03T18:00:00.000Z"), present] },
  }
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(canonicalTerminalRecordBytes(record({ evidence: published }))),
    /absent/iu,
  )
})

test("rejects a record whose predecessor is not the escrowed canonical draft", () => {
  const value = record()
  const early = { ...value.predecessor, state: "CANDIDATE_TAGGED" }
  assert.throws(
    () => parseOperatorRecoveryRecord(canonicalTerminalRecordBytes(record({ predecessor: early }))),
    /predecessor/iu,
  )
})

test("enforces the byte cap", () => {
  const value = record({ reason: "x".repeat(600 * 1024) })
  assert.throws(() => parseOperatorRecoveryRecord(canonicalTerminalRecordBytes(value)), /byte/iu)
})

test("terminalRecordPath is exact", () => {
  assert.equal(terminalRecordPath(VERSION), "scripts/release/terminal-records/v0.8.22.json")
  assert.throws(() => terminalRecordPath("0.8"), /version/iu)
})

test("readTerminalRecord returns null when the path is absent and parses it when present", async () => {
  const bytes = canonicalTerminalRecordBytes(record())
  const absentGit = {
    async listTree() {
      return ["package.json"]
    },
    async showFile() {
      throw new Error("must not be called")
    },
  }
  assert.equal(await readTerminalRecord({ git: absentGit, ref: "HEAD", version: VERSION }), null)
  const presentGit = {
    async listTree() {
      return ["package.json", "scripts/release/terminal-records/v0.8.22.json"]
    },
    async showFile({ ref, path }) {
      assert.equal(ref, "HEAD")
      assert.equal(path, "scripts/release/terminal-records/v0.8.22.json")
      return bytes.toString("utf8")
    },
  }
  const parsed = await readTerminalRecord({ git: presentGit, ref: "HEAD", version: VERSION })
  assert.equal(parsed.version, VERSION)
  assert.equal(createHash("sha256").update(bytes).digest("hex"), parsed.sha256)
})

test("readTerminalRecord rejects a present but malformed record", async () => {
  const git = {
    async listTree() {
      return ["scripts/release/terminal-records/v0.8.22.json"]
    },
    async showFile() {
      return "{}\n"
    },
  }
  await assert.rejects(
    readTerminalRecord({ git, ref: "HEAD", version: VERSION }),
    /Terminal record/u,
  )
})
