import assert from "node:assert/strict"
import test from "node:test"

import { findObservationSchemaConflicts } from "../observation-schema.mjs"
import { observationForMarker } from "./support/marker-observation.mjs"

test("marker-driven observations require the exact Release schema", () => {
  const observation = observationForMarker({ phase: "NPM_COMPLETE", smokesComplete: false })

  assert.deepEqual(findObservationSchemaConflicts(observation), [])
  assert.deepEqual(Object.keys(observation.release).sort(), [
    "assets",
    "commitSha",
    "immutable",
    "marker",
    "status",
    "tag",
  ])

  observation.release.metadataReconciled = true
  assert.deepEqual(findObservationSchemaConflicts(observation), ["observation-schema-invalid"])
})

test("marker artifact correlation rejects a changed attestation subject", () => {
  const observation = observationForMarker({ phase: "ESCROWED", npmComplete: false })
  observation.release.marker.attestationSet.subjects[1].subjectSha256 = "9".repeat(64)

  assert.deepEqual(findObservationSchemaConflicts(observation), ["observation-schema-invalid"])
})

test("published observations are valid only for an immutable audited Release", () => {
  const verified = observationForMarker({
    phase: "AUDIT_VERIFIED",
    releaseStatus: "published",
  })
  assert.deepEqual(findObservationSchemaConflicts(verified), [])

  verified.release.immutable = false
  assert.deepEqual(findObservationSchemaConflicts(verified), ["github-release-not-immutable"])
})
