import assert from "node:assert/strict"
import test from "node:test"

import { correlateReleaseEvidence } from "../evidence.mjs"
import { findObservationSchemaConflicts } from "../observation-schema.mjs"
import { planRelease } from "../planner.mjs"
import { observationForMarker } from "./support/marker-observation.mjs"

test("marker-driven observations require the exact Release schema", () => {
  const observation = observationForMarker({ phase: "NPM_COMPLETE", smokesComplete: false })

  assert.deepEqual(findObservationSchemaConflicts(observation), [])
  assert.deepEqual(Object.keys(observation.release).sort(), [
    "assets",
    "bodySha256",
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

test("attested abandonment requires the exact retained 45-asset base", () => {
  const observation = observationForMarker({
    phase: "ABANDONED_PREPUBLICATION",
    partialBase: true,
  })
  observation.release.assets = observation.release.assets.filter(
    (asset) => asset.name === "abandonment.json",
  )

  assert.ok(
    findObservationSchemaConflicts(observation).includes("abandonment-verifiable-base-incomplete"),
  )
})

test("a corrupt attested abandonment marker cannot fall back to the early tombstone shape", () => {
  const observation = observationForMarker({ phase: "ABANDONED_PREPUBLICATION" })
  observation.release.marker.baseAssetSetSha256 = "0".repeat(64)
  observation.release.assets = observation.release.assets.filter(
    (asset) => asset.name === "abandonment.json",
  )
  observation.escrow = { status: "absent", manifestSha256: null, assets: [] }

  const conflicts = findObservationSchemaConflicts(observation)
  assert.ok(conflicts.includes("abandonment-verifiable-base-invalid"))
  assert.ok(conflicts.includes("abandonment-verifiable-base-incomplete"))
  assert.equal(planRelease({ candidate: candidate(), observation }).disposition, "blocked")
})

test("attested abandonment still binds its marker to the observed artifact context", () => {
  const observation = observationForMarker({ phase: "ABANDONED_PREPUBLICATION" })
  const changedManifestSha256 = "9".repeat(64)
  observation.artifacts.manifestSha256 = changedManifestSha256
  observation.artifacts.manifestAsset.sha256 = changedManifestSha256
  const manifestAttestation = observation.artifacts.attestations.find(
    (entry) => entry.subjectName === "manifest.json",
  )
  manifestAttestation.subjectSha256 = changedManifestSha256
  observation.smokes[0].manifestSha256 = changedManifestSha256
  observation.escrow = { status: "absent", manifestSha256: null, assets: [] }

  const conflicts = findObservationSchemaConflicts(observation)
  assert.ok(conflicts.includes("observation-schema-invalid"))
  assert.equal(planRelease({ candidate: candidate(), observation }).disposition, "blocked")
})

test("immutable Git inventory may omit artifact digests before any preparation signal", () => {
  const observation = unpreparedObservation()

  assert.deepEqual(findObservationSchemaConflicts(observation), [])
  assert.deepEqual(correlateReleaseEvidence(candidate(), observation).artifact.immutableAssets, [])
})

for (const [name, mutate] of [
  ["artifact ambiguity", (observation) => (observation.artifacts.status = "ambiguous")],
  ["registry mutation", (observation) => (observation.registry.mutationStarted = true)],
  [
    "managed Release",
    (observation) => {
      const active = observationForMarker({ phase: "ESCROWED", npmComplete: false })
      observation.release = active.release
    },
  ],
]) {
  test(`missing artifact digests fail closed after ${name}`, () => {
    const observation = unpreparedObservation()
    mutate(observation)

    assert.ok(
      findObservationSchemaConflicts(observation).includes("inventory-artifact-digests-missing"),
    )
  })
}

function unpreparedObservation() {
  const observation = observationForMarker({ phase: "ESCROWED", npmComplete: false })
  observation.inventory.packages = observation.inventory.packages.map((pkg) => ({
    ...pkg,
    tarballSha256: null,
    attestationSha256: null,
    integrity: null,
  }))
  observation.artifacts = {
    status: "absent",
    manifestVersion: null,
    manifestCommitSha: null,
    manifestSha256: null,
    files: observation.inventory.packages.map((pkg) => ({
      name: pkg.name,
      status: "pending",
      assetName: pkg.filename,
      sha256: null,
      integrity: null,
    })),
    manifestAsset: { name: "manifest.json", sha256: null },
    releaseRecordAsset: { name: "release-record.json", sha256: null },
    manifestAttestationAsset: { name: "manifest.json.intoto.jsonl", sha256: null },
    attestations: [
      ...observation.inventory.packages.map((pkg) => ({
        name: pkg.attestationFilename,
        status: "pending",
        sha256: null,
        subjectName: pkg.filename,
        subjectSha256: null,
      })),
      {
        name: "manifest.json.intoto.jsonl",
        status: "pending",
        sha256: null,
        subjectName: "manifest.json",
        subjectSha256: null,
      },
    ],
  }
  observation.escrow = { status: "absent", manifestSha256: null, assets: [] }
  observation.release = {
    status: "absent",
    tag: null,
    commitSha: null,
    immutable: null,
    bodySha256: null,
    marker: null,
    assets: [],
  }
  observation.registry = {
    publishJobStarted: false,
    mutationStarted: false,
    packages: observation.inventory.packages.map((pkg) => ({
      name: pkg.name,
      status: "e404",
      version: null,
      tarballSha256: null,
      integrity: null,
      latest: { status: "e404", version: null },
      signature: { status: "missing" },
      provenance: null,
    })),
  }
  observation.smokes = observation.smokes.map((smoke) => ({
    ...smoke,
    status: "pending",
    manifestSha256: null,
    workflowRunId: null,
    runAttempt: null,
  }))
  observation.audit = {
    status: "none",
    version: null,
    commitSha: null,
    manifestSha256: null,
    workflowRunId: null,
    runAttempt: null,
    conclusion: null,
  }
  observation.abandonment = { requested: false, recorded: false, predecessor: null }
  return observation
}

function candidate() {
  return {
    version: "0.8.22",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  }
}
