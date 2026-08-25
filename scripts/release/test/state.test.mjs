import assert from "node:assert/strict"
import test from "node:test"

import { analyzeObservedRelease } from "../state.mjs"
import { candidate, observationForMarker } from "./support/marker-observation.mjs"

const CASES = [
  {
    phase: "ESCROWING",
    options: { npmComplete: false, smokesComplete: false, partialBase: true },
    state: "ARTIFACTS_ATTESTED",
  },
  {
    phase: "ESCROWED",
    options: { npmComplete: false, smokesComplete: false },
    state: "CANDIDATE_ESCROWED",
  },
  {
    phase: "ESCROWED",
    options: { npmComplete: true, smokesComplete: false },
    state: "NPM_COMPLETE",
  },
  {
    phase: "NPM_COMPLETE",
    options: { npmComplete: true, smokesComplete: false },
    state: "RELEASE_DRAFT_COMPLETE",
  },
  { phase: "SMOKES_COMPLETE", options: {}, state: "SMOKES_COMPLETE" },
  { phase: "AUDIT_DISPATCHED", options: {}, state: "AUDIT_DISPATCHED" },
  { phase: "AUDIT_RETRYABLE", options: {}, state: "AUDIT_RETRYABLE" },
  { phase: "AUDIT_VERIFIED", options: {}, state: "AUDIT_VERIFIED" },
  {
    phase: "AUDIT_VERIFIED",
    options: { releaseStatus: "published" },
    state: "AUDIT_COMPLETE",
  },
  {
    phase: "ABANDONED_PREPUBLICATION",
    options: { partialBase: true },
    state: "ABANDONED_PREPUBLICATION",
  },
]

for (const row of CASES) {
  test(`${row.phase} classifies as ${row.state}`, () => {
    const result = analyzeObservedRelease(
      candidate(),
      observationForMarker({ phase: row.phase, ...row.options }),
    )

    assert.equal(result.state, row.state)
    assert.deepEqual(result.conflicts, [])
  })
}
