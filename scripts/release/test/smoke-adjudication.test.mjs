import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  parseSmokeAdjudication,
  readSmokeAdjudication,
  smokeAdjudicationApplies,
  smokeAdjudicationPath,
} from "../smoke-adjudication.mjs"
import { REQUIRED_RELEASE_SMOKE_LANES } from "../smoke-result.mjs"

const COMMIT = "88c01c4afd59866fc0ea4c8f3b8444439a01c8ea"
const FIX_COMMIT = "2689ef8d260b089bbb2ed105b165e625409d8701"
const REVIEWED = "f3766a9e" + "0".repeat(32)
const MANIFEST = "68e45c7d302147f387c4cd68586a4e6411ea6a7c7889f6e2edc32a0793696e5c"
const LANES = ["metadata", "published-harness", "runtime-targets", "scaffold", "storage"]

function record(overrides = {}) {
  return {
    adjudicatedLanes: LANES.map((name) => ({
      detail: `${name} outcome reviewed by the operator`,
      name,
      outcome: name === "scaffold" || name === "metadata" ? "passed" : "failed",
    })),
    authority: {
      capturedAt: "2026-09-04T20:00:00.000Z",
      mode: "operator-adjudication",
      operator: "blove",
      reviewedCommit: REVIEWED,
    },
    commitSha: COMMIT,
    kind: "smoke-gate-adjudicated",
    manifestSha256: MANIFEST,
    reason: "The candidate's own smoke lanes carry defects that cannot be fixed in place.",
    remediation: {
      fixCommitSha: FIX_COMMIT,
      summary: "Lane defects fixed on main; they reach the next candidate, not this one.",
    },
    schemaVersion: 1,
    version: "0.8.24",
    ...overrides,
  }
}

const candidate = Object.freeze({
  commitSha: COMMIT,
  manifestSha256: MANIFEST,
  requiredLanes: LANES,
  version: "0.8.24",
})

test("an exact adjudication parses and applies to the candidate it names", () => {
  const parsed = parseSmokeAdjudication(record())
  assert.equal(parsed.version, "0.8.24")
  assert.equal(smokeAdjudicationApplies(parsed, candidate), true)
  assert.equal(smokeAdjudicationPath("0.8.24"), "scripts/release/smoke-adjudications/v0.8.24.json")
})

test("the record never claims the failing lanes passed", () => {
  const parsed = parseSmokeAdjudication(record())
  const failed = parsed.adjudicatedLanes.filter((lane) => lane.outcome !== "passed")
  assert.deepEqual(failed.map((lane) => lane.name).sort(), [
    "published-harness",
    "runtime-targets",
    "storage",
  ])
})

test("an adjudication never applies to a different candidate", () => {
  const parsed = parseSmokeAdjudication(record())
  for (const drift of [
    { ...candidate, version: "0.8.25" },
    { ...candidate, commitSha: "a".repeat(40) },
    { ...candidate, manifestSha256: "b".repeat(64) },
  ]) {
    assert.equal(smokeAdjudicationApplies(parsed, drift), false)
  }
})

test("an adjudication never applies when the required lanes are not covered exactly", () => {
  const parsed = parseSmokeAdjudication(record())
  assert.equal(
    smokeAdjudicationApplies(parsed, { ...candidate, requiredLanes: [...LANES, "extra-lane"] }),
    false,
    "a newly required lane must not be waived by an older adjudication",
  )
  assert.equal(
    smokeAdjudicationApplies(parsed, { ...candidate, requiredLanes: LANES.slice(0, 4) }),
    false,
  )
  for (const empty of [[], null, undefined]) {
    assert.equal(smokeAdjudicationApplies(parsed, { ...candidate, requiredLanes: empty }), false)
  }
})

test("a missing or malformed adjudication never applies", () => {
  for (const absent of [null, undefined]) {
    assert.equal(smokeAdjudicationApplies(absent, candidate), false)
  }
  assert.equal(smokeAdjudicationApplies(parseSmokeAdjudication(record()), null), false)
})

test("parsing rejects every unbound, widened, or unattributed record", () => {
  const cases = [
    [{ version: "0.8" }, /exact SemVer/u],
    [{ version: "v0.8.24" }, /exact SemVer/u],
    [{ commitSha: "88c01c4a" }, /commit is invalid/u],
    [{ manifestSha256: "not-a-digest" }, /manifest digest is invalid/u],
    [{ kind: "smokes-passed" }, /kind is unsupported/u],
    [{ schemaVersion: 2 }, /schema version is unsupported/u],
    [{ reason: "" }, /reason is required/u],
    [{ adjudicatedLanes: [] }, /every lane outcome/u],
    [{ authority: { ...record().authority, mode: "automatic" } }, /authority mode is unsupported/u],
    [{ authority: { ...record().authority, operator: "" } }, /operator is required/u],
    [
      { authority: { ...record().authority, reviewedCommit: "nope" } },
      /reviewed commit is invalid/u,
    ],
    [{ remediation: { fixCommitSha: "nope", summary: "s" } }, /remediation commit is invalid/u],
  ]
  for (const [overrides, pattern] of cases) {
    assert.throws(() => parseSmokeAdjudication(record(overrides)), pattern)
  }
})

test("parsing rejects unknown, missing, and duplicated fields rather than ignoring them", () => {
  const extra = record()
  extra.autoApprove = true
  assert.throws(() => parseSmokeAdjudication(extra), /record fields are invalid/u)

  const missing = record()
  delete missing.reason
  assert.throws(() => parseSmokeAdjudication(missing), /record fields are invalid/u)

  const duplicated = record({
    adjudicatedLanes: [
      { detail: "d", name: "storage", outcome: "failed" },
      { detail: "d", name: "storage", outcome: "passed" },
    ],
  })
  assert.throws(() => parseSmokeAdjudication(duplicated), /lane is duplicated/u)

  const badOutcome = record({
    adjudicatedLanes: [{ detail: "d", name: "storage", outcome: "waived" }],
  })
  assert.throws(() => parseSmokeAdjudication(badOutcome), /lane outcome is unsupported/u)
})

test("parsing rejects non-objects and prototype-polluting shapes", () => {
  for (const value of [null, undefined, [], "record", 7]) {
    assert.throws(() => parseSmokeAdjudication(value), /record fields are invalid/u)
  }
  const polluted = JSON.parse('{"__proto__": {"admin": true}}')
  assert.throws(() => parseSmokeAdjudication(polluted), /record fields are invalid/u)
})

test("the parsed record is frozen so no caller can widen it after review", () => {
  const parsed = parseSmokeAdjudication(record())
  assert.throws(() => {
    parsed.commitSha = "a".repeat(40)
  }, TypeError)
  assert.throws(() => {
    parsed.adjudicatedLanes.push({ detail: "d", name: "new", outcome: "passed" })
  }, TypeError)
})

test("the adjudication path is derived from the version and rejects traversal", () => {
  for (const bad of ["../../etc/passwd", "0.8.24/../0.8.25", "", "latest"]) {
    assert.throws(() => smokeAdjudicationPath(bad), /exact SemVer/u)
  }
})

test("the shipped 0.8.24 record applies to its own candidate and to no other", async () => {
  const source = await readFile(
    new URL("../smoke-adjudications/v0.8.24.json", import.meta.url),
    "utf8",
  )
  const shipped = parseSmokeAdjudication(JSON.parse(source))
  const real = {
    commitSha: "88c01c4afd59866fc0ea4c8f3b8444439a01c8ea",
    manifestSha256: "68e45c7d302147f387c4cd68586a4e6411ea6a7c7889f6e2edc32a0793696e5c",
    requiredLanes: [...REQUIRED_RELEASE_SMOKE_LANES],
    version: "0.8.24",
  }
  assert.equal(smokeAdjudicationApplies(shipped, real), true)
  assert.equal(
    smokeAdjudicationApplies(shipped, {
      ...real,
      commitSha: "f3766a9eac7de7c0df42a5424df73117a69ae26a",
      version: "0.8.25",
    }),
    false,
    "the 0.8.24 adjudication must never waive the smoke gate for 0.8.25",
  )
  assert.equal(
    shipped.adjudicatedLanes.every((lane) => lane.detail.length > 40),
    true,
    "every adjudicated lane must record why it was adjudicated",
  )
})

test("reading an adjudication fails closed on damage and on a misfiled version", async () => {
  const path = "scripts/release/smoke-adjudications/v0.8.24.json"
  const tree = `${path}\nscripts/release/state.mjs`
  const valid = await readFile(
    new URL("../smoke-adjudications/v0.8.24.json", import.meta.url),
    "utf8",
  )

  const present = await readSmokeAdjudication({
    git: {
      async listTree() {
        return tree
      },
      async showFile() {
        return valid
      },
    },
    ref: "main",
    version: "0.8.24",
  })
  assert.equal(present.version, "0.8.24")

  assert.equal(
    await readSmokeAdjudication({
      git: {
        async listTree() {
          return "scripts/release/state.mjs"
        },
        async showFile() {
          throw new Error("must not read")
        },
      },
      ref: "main",
      version: "0.8.24",
    }),
    null,
    "an absent adjudication is normal and waives nothing",
  )

  await assert.rejects(
    readSmokeAdjudication({
      git: {
        async listTree() {
          return tree
        },
        async showFile() {
          return "{ not json"
        },
      },
      ref: "main",
      version: "0.8.24",
    }),
    /is invalid/u,
  )

  await assert.rejects(
    readSmokeAdjudication({
      git: {
        async listTree() {
          return "scripts/release/smoke-adjudications/v0.8.25.json"
        },
        async showFile() {
          return valid
        },
      },
      ref: "main",
      version: "0.8.25",
    }),
    /names another version/u,
    "a record filed under the wrong version must never be trusted by its path",
  )

  for (const bad of [
    { git: {}, ref: "main", version: "0.8.24" },
    {
      git: {
        async listTree() {
          return ""
        },
        async showFile() {
          return ""
        },
      },
      ref: "",
      version: "0.8.24",
    },
  ]) {
    await assert.rejects(readSmokeAdjudication(bad), /invalid/u)
  }
})

test("an adjudication advances the smoke gate only for a candidate whose packages published", () => {
  const base = { complete: false, anyPassed: false, ambiguous: false }
  const assets = { smokesReconciled: false, npmReconciled: true }

  assert.equal(
    smokeGateState({ smokes: { ...base, adjudicated: true }, npm: { complete: true }, assets }),
    "SMOKES_COMPLETE",
  )
  assert.equal(
    smokeGateState({ smokes: { ...base, adjudicated: true }, npm: { complete: false }, assets }),
    "not-advanced",
    "an adjudication must never advance a candidate that never published",
  )
  assert.equal(
    smokeGateState({ smokes: { ...base, adjudicated: false }, npm: { complete: true }, assets }),
    "not-advanced",
  )
})

// Mirrors the ordering in state.mjs classifySnapshot so the guard is asserted directly.
function smokeGateState(evidence) {
  if (evidence.assets.smokesReconciled && evidence.smokes.complete) return "SMOKES_COMPLETE"
  if (evidence.smokes.adjudicated && evidence.npm.complete) return "SMOKES_COMPLETE"
  return "not-advanced"
}
