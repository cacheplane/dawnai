import assert from "node:assert/strict"
import test from "node:test"

import { correlateReleaseEvidence } from "../evidence.mjs"
import { AUDIT_SHA256, candidate, observationForMarker } from "./support/marker-observation.mjs"

test("ESCROWING is a resumable exact subset and not a completed escrow", () => {
  const evidence = correlateReleaseEvidence(
    candidate(),
    observationForMarker({
      phase: "ESCROWING",
      npmComplete: false,
      smokesComplete: false,
      partialBase: true,
    }),
  )

  assert.equal(evidence.assets.markerPhase, "ESCROWING")
  assert.equal(evidence.assets.escrowResumable, true)
  assert.equal(evidence.assets.escrowComplete, false)
  assert.equal(evidence.assets.draftExact, false)
  assert.equal(Object.hasOwn(evidence.assets, "metadataComplete"), false)
  assert.deepEqual(evidence.conflicts, [])
})

test("AUDIT_VERIFIED correlates the immutable base and exact audit receipts", () => {
  const evidence = correlateReleaseEvidence(
    candidate(),
    observationForMarker({ phase: "AUDIT_VERIFIED" }),
  )

  assert.equal(evidence.assets.escrowComplete, true)
  assert.equal(evidence.assets.auditVerified, true)
  assert.equal(evidence.assets.publishedExact, false)
  assert.equal(evidence.audit.complete, true)
  assert.deepEqual(evidence.conflicts, [])
})

test("audit-result bytes must match the marker canonical digest", () => {
  const observation = observationForMarker({ phase: "AUDIT_VERIFIED" })
  const canonical = observation.release.assets.find(({ name }) => name === "audit-result.json")
  assert.equal(canonical.sha256, AUDIT_SHA256)
  canonical.sha256 = "8".repeat(64)

  const evidence = correlateReleaseEvidence(candidate(), observation)
  assert.equal(evidence.assets.auditVerified, false)
  assert.equal(evidence.conflicts.includes("github-audit-result-bytes-mismatch"), true)
})

test("abandonment permits a matching partial base without classifying escrow complete", () => {
  const evidence = correlateReleaseEvidence(
    candidate(),
    observationForMarker({
      phase: "ABANDONED_PREPUBLICATION",
      partialBase: true,
    }),
  )

  assert.equal(evidence.assets.markerPhase, "ABANDONED_PREPUBLICATION")
  assert.equal(evidence.assets.escrowComplete, false)
  assert.equal(evidence.assets.draftExact, false)
  assert.deepEqual(evidence.conflicts, [])
})
