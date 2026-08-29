import assert from "node:assert/strict"
import test from "node:test"

import { findReleaseConflicts } from "../state.mjs"
import { candidate, observationForMarker } from "./support/marker-observation.mjs"

test("an exact ATTACHING subset remains safely resumable", () => {
  const conflicts = findReleaseConflicts(
    candidate(),
    observationForMarker({
      phase: "ATTACHING",
      npmComplete: false,
      smokesComplete: false,
      partialBase: true,
    }),
  )

  assert.deepEqual(conflicts, [])
  assert.equal(conflicts.includes("escrow-draft-incomplete"), false)
})

test("publication before verified audit is blocked", () => {
  const conflicts = findReleaseConflicts(
    candidate(),
    observationForMarker({ phase: "SMOKES_COMPLETE", releaseStatus: "published" }),
  )

  assert.equal(conflicts.includes("github-release-published-before-audit"), true)
})

test("an exact immutable AUDIT_VERIFIED Release is terminal and conflict-free", () => {
  const conflicts = findReleaseConflicts(
    candidate(),
    observationForMarker({ phase: "AUDIT_VERIFIED", releaseStatus: "published" }),
  )

  assert.deepEqual(conflicts, [])
})
