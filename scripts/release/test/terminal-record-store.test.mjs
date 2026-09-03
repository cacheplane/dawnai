// scripts/release/test/terminal-record-store.test.mjs
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  canonicalTerminalRecordBytes,
  parseOperatorRecoveryRecord,
  readTerminalRecord,
  terminalRecordPath,
} from "../terminal-record-store.mjs"
import {
  attestationSet,
  COMMIT_SHA,
  npmObservation,
  record,
  TAG_OBJECT_SHA,
  VERSION,
} from "./support/terminal-record-fixture.mjs"

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

test("rejects npm observations that are out of order", () => {
  const value = record()
  const outOfOrder = {
    ...value.evidence,
    npm: {
      observations: [
        npmObservation("2026-09-03T18:05:00.000Z"),
        npmObservation("2026-09-03T18:00:00.000Z"),
      ],
    },
  }
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(canonicalTerminalRecordBytes(record({ evidence: outOfOrder }))),
    /out of order/iu,
  )
})

test("rejects a record whose authority captured before its second npm observation", () => {
  const value = record()
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(
          record({ authority: { ...value.authority, capturedAt: "2026-09-03T18:00:30.000Z" } }),
        ),
      ),
    /precedes its evidence/iu,
  )
})

test("rejects a record whose evidence span exceeds fifteen minutes", () => {
  const value = record()
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(
          record({ authority: { ...value.authority, capturedAt: "2026-09-03T18:20:00.000Z" } }),
        ),
      ),
    /fifteen minutes/iu,
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

test("rejects a predecessor marker that is not ESCROWED", () => {
  const value = record()
  const attaching = {
    ...value.predecessor.marker,
    phase: "ATTACHING",
    baseAssetSetSha256: null,
    attestationSet: null,
  }
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(
          record({ predecessor: { ...value.predecessor, marker: attaching } }),
        ),
      ),
    /marker/iu,
  )
})

test("rejects a predecessor artifact whose manifest digest disagrees with the marker", () => {
  const value = record()
  const artifact = { ...value.predecessor.artifact, manifestSha256: "9".repeat(64) }
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(record({ predecessor: { ...value.predecessor, artifact } })),
      ),
    /does not match its marker/iu,
  )
})

test("rejects a tag whose name, objectSha, or commitSha disagree with the record", () => {
  const value = record()
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(record({ tag: { ...value.tag, name: "v0.8.23" } })),
      ),
    /tag/iu,
  )
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(record({ tag: { ...value.tag, objectSha: "z".repeat(40) } })),
      ),
    /tag/iu,
  )
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(record({ tag: { ...value.tag, commitSha: "9".repeat(40) } })),
      ),
    /tag/iu,
  )
})

test("rejects release runs that claim a publish job started", () => {
  const value = record()
  const started = [{ ...value.evidence.releaseRuns[0], publishJobStarted: true }]
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(
          record({ evidence: { ...value.evidence, releaseRuns: started } }),
        ),
      ),
    /release run/iu,
  )
})

test("rejects a release run that has not completed", () => {
  const value = record()
  const queued = [{ ...value.evidence.releaseRuns[0], status: "queued" }]
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(
          record({ evidence: { ...value.evidence, releaseRuns: queued } }),
        ),
      ),
    /release run/iu,
  )
})

test("rejects duplicate release runs with the same workflow run and attempt", () => {
  const value = record()
  const runs = [value.evidence.releaseRuns[0], { ...value.evidence.releaseRuns[0] }]
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(
          record({ evidence: { ...value.evidence, releaseRuns: runs } }),
        ),
      ),
    /release run/iu,
  )
})

test("rejects an authority mode other than operator-recovery", () => {
  const value = record()
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(record({ authority: { ...value.authority, mode: "other" } })),
      ),
    /authority mode/iu,
  )
})

test("rejects duplicate escrow asset names", () => {
  const value = record()
  const assets = value.evidence.escrowAssets.map((asset, index) =>
    index === 1 ? { ...asset, name: value.evidence.escrowAssets[0].name } : asset,
  )
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(
          record({ evidence: { ...value.evidence, escrowAssets: assets } }),
        ),
      ),
    /escrow asset/iu,
  )
})

test("rejects an empty escrow asset name", () => {
  const value = record()
  const assets = value.evidence.escrowAssets.map((asset, index) =>
    index === 0 ? { ...asset, name: "" } : asset,
  )
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(
          record({ evidence: { ...value.evidence, escrowAssets: assets } }),
        ),
      ),
    /escrow asset/iu,
  )
})

test("rejects a reason containing control characters", () => {
  const reasonWithControlCharacter = `bad${String.fromCharCode(7)}reason`
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(record({ reason: reasonWithControlCharacter })),
      ),
    /reason/iu,
  )
})

test("rejects identical duplicate-recovery entries", () => {
  const value = record()
  const duplicates = [
    value.evidence.duplicateRecovery.duplicates[0],
    { ...value.evidence.duplicateRecovery.duplicates[0] },
  ]
  assert.throws(
    () =>
      parseOperatorRecoveryRecord(
        canonicalTerminalRecordBytes(
          record({
            evidence: {
              ...value.evidence,
              duplicateRecovery: { ...value.evidence.duplicateRecovery, duplicates },
            },
          }),
        ),
      ),
    /duplicate/iu,
  )
})

test("rejects a reason exceeding its bounded length", () => {
  const value = record({ reason: "x".repeat(5 * 1024) })
  assert.throws(() => parseOperatorRecoveryRecord(canonicalTerminalRecordBytes(value)), /reason/iu)
})

test("canonicalTerminalRecordBytes enforces the byte cap", () => {
  const value = record({ reason: "x".repeat(600 * 1024) })
  assert.throws(() => canonicalTerminalRecordBytes(value), /byte/iu)
})

test("terminalRecordPath is exact", () => {
  assert.equal(terminalRecordPath(VERSION), "scripts/release/terminal-records/v0.8.22.json")
  assert.throws(() => terminalRecordPath("0.8"), /version/iu)
})

test("readTerminalRecord returns null when the path is absent and parses it when present", async () => {
  const bytes = canonicalTerminalRecordBytes(record())
  const absentGit = {
    async listTree() {
      return "package.json\n"
    },
    async showFile() {
      throw new Error("must not be called")
    },
  }
  assert.equal(await readTerminalRecord({ git: absentGit, ref: "HEAD", version: VERSION }), null)
  const presentGit = {
    async listTree() {
      return "package.json\nscripts/release/terminal-records/v0.8.22.json\n"
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

test("readTerminalRecord rejects a tree listing that is not newline-delimited text", async () => {
  const git = {
    async listTree() {
      return ["package.json", "scripts/release/terminal-records/v0.8.22.json"]
    },
    async showFile() {
      throw new Error("must not be called")
    },
  }
  await assert.rejects(readTerminalRecord({ git, ref: "HEAD", version: VERSION }), /tree listing/iu)
})

test("readTerminalRecord rejects a present but malformed record", async () => {
  const git = {
    async listTree() {
      return "scripts/release/terminal-records/v0.8.22.json\n"
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

test("fixture identity constants line up with the record fixture", () => {
  const value = record()
  assert.equal(value.commitSha, COMMIT_SHA)
  assert.equal(value.tag.objectSha, TAG_OBJECT_SHA)
  assert.equal(
    value.predecessor.marker.attestationSet.subjects.length,
    attestationSet().subjects.length,
  )
})

test("readTerminalRecord rejects a record filed under another version's path", async () => {
  const bytes = canonicalTerminalRecordBytes(record())
  const git = {
    async listTree() {
      return "scripts/release/terminal-records/v0.8.23.json\n"
    },
    async showFile({ path }) {
      assert.equal(path, "scripts/release/terminal-records/v0.8.23.json")
      return bytes.toString("utf8")
    },
  }

  await assert.rejects(
    readTerminalRecord({ git, ref: "HEAD", version: "0.8.23" }),
    /names another version/u,
  )
})
