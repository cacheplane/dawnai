import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { RELEASE_PAYLOAD_LIMITS } from "../limits.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER, canonicalManifestBytes } from "../manifest.mjs"
import {
  canonicalBaseAssetSet,
  canonicalReleaseBody,
  escrowCandidate,
  parseAttestationSet,
  parsePublicationState,
  parseReleaseMarker,
  publishConsolidatedRelease,
  reconcileNpmEvidence,
  reconcileSmokeEvidence,
  releaseBodySha256,
  validatePublicationAuditAssets,
} from "../metadata.mjs"
import { createReleaseRecord, releaseRecordSha256 } from "../release-record.mjs"

const VERSION = "0.8.22"
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
const CANDIDATE = Object.freeze({
  version: VERSION,
  commitSha: COMMIT_SHA,
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})
const REPOSITORY = "cacheplane/dawnai"
const SMOKE_RUN = Object.freeze({ workflowRunId: 200, runAttempt: 1 })
const SMOKE_LANES = Object.freeze(["published-harness", "runtime-targets", "scaffold", "storage"])

test("release bodies contain one canonical exact marker and reject phase-invalid or noncanonical markers", () => {
  const fixture = releaseFixture()
  const marker = escrowMarker(fixture)
  const body = canonicalReleaseBody({ marker, manifest: fixture.manifest })

  assert.deepEqual(parseReleaseMarker(body), marker)
  assert.match(body, /^# Dawn v0\.8\.22/mu)
  assert.equal(releaseBodySha256(body), sha256(Buffer.from(body)))
  assert.equal(Object.isFrozen(parseReleaseMarker(body)), true)

  assert.throws(() => parseReleaseMarker(`${body}\n${body}`), /exactly one|duplicate/iu)
  assert.throws(
    () => parseReleaseMarker(body.replace('"revision":2', '"revision":2, "extra":true')),
    /canonical|schema|field/iu,
  )
  assert.throws(
    () =>
      canonicalReleaseBody({
        marker: { ...marker, phase: "NPM_COMPLETE", npmEvidenceSha256: null },
        manifest: fixture.manifest,
      }),
    /npm|phase/iu,
  )
  assert.throws(
    () =>
      canonicalReleaseBody({
        marker: { ...marker, phase: "AUDIT_COMPLETE" },
        manifest: fixture.manifest,
      }),
    /phase/iu,
  )

  const foreignRepositoryBody = body.replace(
    '"repository":"cacheplane/dawnai"',
    '"repository":"fork/dawnai"',
  )
  assert.throws(
    () => parseReleaseMarker(foreignRepositoryBody),
    /attestation|repository|identity/iu,
  )
  assert.throws(
    () =>
      canonicalReleaseBody({
        marker: {
          ...marker,
          attestationSet: { ...marker.attestationSet, repository: "fork/dawnai" },
        },
        manifest: fixture.manifest,
      }),
    /attestation|repository|identity/iu,
  )
})

test("canonical marker updates require revision-by-one legal phase transitions", () => {
  const fixture = releaseFixture()
  const attaching = attachingMarker(fixture)
  const escrowed = escrowMarker(fixture)

  assert.doesNotThrow(() =>
    canonicalReleaseBody({
      marker: escrowed,
      manifest: fixture.manifest,
      previousMarker: attaching,
    }),
  )

  assert.throws(
    () =>
      canonicalReleaseBody({
        marker: { ...attaching, revision: 3 },
        manifest: fixture.manifest,
        previousMarker: escrowed,
      }),
    /backward|phase|transition/iu,
  )
  assert.throws(
    () =>
      canonicalReleaseBody({
        marker: { ...escrowed, revision: 4 },
        manifest: fixture.manifest,
        previousMarker: attaching,
      }),
    /revision|transition/iu,
  )
})

test("attestation metadata binds one exact tag run to manifest plus 21 ordered tarballs", () => {
  const fixture = releaseFixture()
  const parsed = parseAttestationSet(fixture.attestationSet, {
    candidate: CANDIDATE,
    manifest: fixture.manifest,
    repository: REPOSITORY,
  })
  assert.equal(parsed.subjects.length, 22)
  assert.equal(parsed.subjects[0].subjectName, "manifest.json")
  assert.deepEqual(
    parsed.subjects.slice(1).map((subject) => subject.subjectName),
    fixture.manifest.packageOrder.map((name) => packageFilename(name)),
  )
  assertRecursivelyFrozen(parsed)

  assert.throws(
    () =>
      parseAttestationSet(
        { ...fixture.attestationSet, subjects: parsed.subjects.slice(1) },
        {
          candidate: CANDIDATE,
          manifest: fixture.manifest,
          repository: REPOSITORY,
        },
      ),
    /22|subject|order/iu,
  )
  assert.throws(
    () =>
      parseAttestationSet(
        {
          ...fixture.attestationSet,
          sourceRef: "refs/heads/main",
        },
        { candidate: CANDIDATE, manifest: fixture.manifest, repository: REPOSITORY },
      ),
    /source|tag|identity/iu,
  )
})

test("canonical base escrow is exactly 45 digest-bound assets and excludes attestation metadata", () => {
  const fixture = releaseFixture()
  const base = canonicalBaseAssetSet({
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: fixture.attestationSet,
    bundles: fixture.bundles,
  })

  assert.equal(base.assets.length, 45)
  assert.deepEqual(
    base.assets.slice(0, 3).map((asset) => asset.name),
    ["release-record.json", "manifest.json", fixture.manifest.packages[0].filename],
  )
  assert.equal(
    base.assets.some((asset) => asset.name === "attestation-set.json"),
    false,
  )
  assert.match(base.sha256, /^[0-9a-f]{64}$/u)
  assertRecursivelyFrozen(base)

  const corrupt = fixture.bundles.map((bundle, index) =>
    index === 5 ? { ...bundle, bytes: Buffer.from("different") } : bundle,
  )
  assert.throws(
    () =>
      canonicalBaseAssetSet({
        record: fixture.record,
        artifact: fixture.artifact,
        attestationSet: fixture.attestationSet,
        bundles: corrupt,
      }),
    /bundle|digest/iu,
  )
})

test("escrow invokes the bounded verifier for all 22 bundles before any Release mutation", async () => {
  const fixture = releaseFixture()
  const remote = inMemoryGitHub()
  let verificationInput
  const attestations = Object.freeze({
    async verify(input) {
      verificationInput = input
      return { status: "INVALID", subjects: [] }
    },
  })

  await assert.rejects(
    escrowCandidate({
      candidate: CANDIDATE,
      record: fixture.record,
      artifact: fixture.artifact,
      attestationSet: fixture.attestationSet,
      bundles: fixture.bundles,
      publicationState: publicationState(fixture),
      attestations,
      github: remote.github,
    }),
    /attestation|verif/iu,
  )

  assert.equal(verificationInput.source, "escrow")
  assert.deepEqual(verificationInput.record, fixture.record)
  assert.equal(verificationInput.subjects.length, 22)
  assert.equal(verificationInput.files.length, 22)
  assert.equal(verificationInput.bundles.length, 22)
  assert.deepEqual(
    verificationInput.files.map(({ name }) => name),
    verificationInput.subjects.map(({ name }) => name),
  )
  assert.deepEqual(
    verificationInput.bundles.map(({ name }) => name),
    fixture.attestationSet.subjects.map(({ bundleName }) => bundleName),
  )
  assert.equal(remote.release, null)
  assert.equal(remote.uploadCount, 0)
  assert.equal(remote.updateCount, 0)

  const alternateRepository = inMemoryGitHub()
  await assert.rejects(
    escrowCandidate({
      candidate: CANDIDATE,
      record: fixture.record,
      artifact: fixture.artifact,
      attestationSet: { ...fixture.attestationSet, repository: "fork/dawnai" },
      bundles: fixture.bundles,
      publicationState: publicationState(fixture),
      attestations: verifiedAttestations(fixture),
      github: alternateRepository.github,
    }),
    /attestation|repository|identity/iu,
  )
  assert.equal(alternateRepository.release, null)
  assert.equal(alternateRepository.uploadCount + alternateRepository.updateCount, 0)
})

test("publication state proves all job attempts and exact package absence before escrow", () => {
  const fixture = releaseFixture()
  const state = publicationState(fixture)
  const parsed = parsePublicationState(state, {
    candidate: CANDIDATE,
    inventory: { packages: fixture.manifest.packages.map(({ name }) => ({ name })) },
  })
  assertRecursivelyFrozen(parsed)

  const missingAttempt = structuredClone(state)
  missingAttempt.candidateRuns[0].runAttempt = 3
  assert.throws(
    () =>
      parsePublicationState(missingAttempt, {
        candidate: CANDIDATE,
        inventory: { packages: fixture.manifest.packages.map(({ name }) => ({ name })) },
      }),
    /attempt|coverage/iu,
  )

  const started = structuredClone(state)
  started.candidateRuns[0].jobs[0].startedAt = "2026-08-24T00:00:00Z"
  assert.throws(
    () =>
      parsePublicationState(started, {
        candidate: CANDIDATE,
        inventory: { packages: fixture.manifest.packages.map(({ name }) => ({ name })) },
      }),
    /publish|started/iu,
  )

  const skipped = structuredClone(state)
  skipped.candidateRuns[0].jobs[0] = {
    ...skipped.candidateRuns[0].jobs[0],
    status: "completed",
    conclusion: "skipped",
    startedAt: "2026-08-24T00:00:00Z",
    completedAt: "2026-08-24T00:00:01Z",
  }
  assert.doesNotThrow(() =>
    parsePublicationState(skipped, {
      candidate: CANDIDATE,
      inventory: { packages: fixture.manifest.packages.map(({ name }) => ({ name })) },
    }),
  )

  for (const mutate of [
    (candidate) => {
      candidate.candidateRuns[0].jobs = candidate.candidateRuns[0].jobs.filter(
        (job) => !(job.name === "publish-npm" && job.runAttempt === 2),
      )
    },
    (candidate) => {
      candidate.candidateRuns[0].jobs.push({
        ...candidate.candidateRuns[0].jobs.find(
          (job) => job.name === "publish-npm" && job.runAttempt === 2,
        ),
        id: 4,
      })
    },
    (candidate) => {
      candidate.candidateRuns[0].jobs[0] = {
        ...candidate.candidateRuns[0].jobs[0],
        status: "completed",
        conclusion: "skipped",
        startedAt: "2026-08-24T00:00:00Z",
        completedAt: null,
      }
    },
  ]) {
    const bypass = structuredClone(state)
    mutate(bypass)
    assert.throws(
      () =>
        parsePublicationState(bypass, {
          candidate: CANDIDATE,
          inventory: { packages: fixture.manifest.packages.map(({ name }) => ({ name })) },
        }),
      /publish|job|attempt|skipped/iu,
    )
  }

  const accessor = structuredClone(state)
  Object.defineProperty(accessor, "tag", { enumerable: true, get: () => `v${VERSION}` })
  assert.throws(
    () =>
      parsePublicationState(accessor, {
        candidate: CANDIDATE,
        inventory: { packages: fixture.manifest.packages.map(({ name }) => ({ name })) },
      }),
    /snapshot|JSON|accessor|field/iu,
  )
})

test("publication audit history has independent count and aggregate byte bounds", () => {
  const fixture = releaseFixture()
  const auditResult = {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: fixture.record.manifestSha256,
    workflowRunId: 300,
    runAttempt: 1,
    startedAt: "2026-08-24T01:00:00Z",
    finishedAt: "2026-08-24T01:01:00Z",
    checks: [{ name: "published-artifacts", conclusion: "success", detail: "verified" }],
    conclusion: "success",
  }
  const auditBytes = Buffer.from(`${JSON.stringify(canonicalize(auditResult), null, 2)}\n`)
  const auditDigest = sha256(auditBytes)
  const marker = {
    ...escrowMarker(fixture),
    revision: 7,
    phase: "AUDIT_VERIFIED",
    npmEvidenceSha256: "4".repeat(64),
    smokeAggregateSha256: "5".repeat(64),
    audit: {
      workflow: ".github/workflows/published-artifact-verify.yml",
      workflowRunId: 300,
      runUrl: "https://api.github.com/repos/cacheplane/dawnai/actions/runs/300",
      htmlUrl: "https://github.com/cacheplane/dawnai/actions/runs/300",
      runAttempt: 1,
      attemptAssetName: "audit-attempt-300-1.json",
      attemptSha256: auditDigest,
      canonicalSha256: auditDigest,
      conclusion: "success",
    },
  }

  assert.throws(
    () =>
      validatePublicationAuditAssets(
        Array.from({ length: 130 }, (_unused, index) => ({
          name: `audit-attempt-${index + 1}-1.json`,
          bytes: Buffer.from("{}"),
        })),
        { marker },
      ),
    /count|bound/iu,
  )
  assert.throws(
    () =>
      validatePublicationAuditAssets(
        Array.from({ length: 17 }, (_unused, index) => ({
          name: `audit-attempt-${index + 1}-1.json`,
          bytes: Buffer.alloc(RELEASE_PAYLOAD_LIMITS.auditReceiptBytes),
        })),
        { marker },
      ),
    /cumulative|byte|limit/iu,
  )
})

test("escrow creates one resumable 45-asset draft and advances its marker only after exact re-read", async () => {
  const fixture = releaseFixture()
  const remote = inMemoryGitHub()
  const input = {
    candidate: CANDIDATE,
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: fixture.attestationSet,
    bundles: fixture.bundles,
    publicationState: publicationState(fixture),
    attestations: verifiedAttestations(fixture),
    github: remote.github,
  }

  remote.failAfterUploads = 10
  await assert.rejects(escrowCandidate(input), /injected runner loss/iu)
  assert.equal(parseReleaseMarker(remote.release.body).phase, "ATTACHING")
  assert.equal(remote.assets.size, 10)

  remote.failAfterUploads = null
  const result = await escrowCandidate({
    ...input,
    publicationState: publicationState(fixture),
  })
  assert.deepEqual(result, {
    releaseId: 7,
    phase: "ESCROWED",
    status: "escrowed",
    assetCount: 45,
    bodySha256: releaseBodySha256(remote.release.body),
  })
  assert.equal(remote.assets.size, 45)
  assert.equal(parseReleaseMarker(remote.release.body).phase, "ESCROWED")
  assert.equal(remote.uploadCount, 45)

  const repeated = await escrowCandidate({
    ...input,
    publicationState: publicationState(fixture),
  })
  assert.equal(repeated.status, "unchanged")
  assert.equal(remote.uploadCount, 45)
})

test("escrow adopts one different valid concurrent Release bundle and binds its signed replay run", async () => {
  const fixture = releaseFixture({ attestationRunId: 15, attestationRunAttempt: 3 })
  const competing = releaseFixture({
    bundleText: "concurrent-valid-bundle",
    attestationRunId: 14,
    attestationRunAttempt: 2,
  })
  const remote = inMemoryGitHub()
  remote.beforeFirstBundleUpload = ({ name }) => {
    const winner = competing.bundles.find((bundle) => bundle.name === name)
    remote.addAsset(name, winner.bytes)
  }

  const result = await escrowCandidate({
    candidate: CANDIDATE,
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: fixture.attestationSet,
    bundles: fixture.bundles,
    publicationState: publicationState(fixture, {
      runs: [
        { runId: 14, runAttempt: 2 },
        { runId: 15, runAttempt: 3 },
      ],
    }),
    attestations: verifiedAttestations(fixture),
    github: remote.github,
  })

  assert.equal(result.status, "escrowed")
  const marker = parseReleaseMarker(remote.release.body)
  assert.equal(marker.phase, "ESCROWED")
  assert.equal(marker.attestationSet.workflowRunId, 14)
  assert.equal(marker.attestationSet.runAttempt, 2)
  assert.ok(
    marker.attestationSet.subjects.every(
      (subject) => subject.bundleSha256 === competing.attestationSet.subjects[0].bundleSha256,
    ),
  )
  for (const subject of marker.attestationSet.subjects) {
    assert.deepEqual(remote.assets.get(subject.bundleName).bytes, competing.bundles[0].bytes)
  }
})

test("escrow rejects a cryptographically valid anchor from a non-enumerated Actions run", async () => {
  const fixture = releaseFixture()
  const unrelated = releaseFixture({
    bundleText: "unrelated-valid-bundle",
    attestationRunId: 999,
    attestationRunAttempt: 1,
  })
  const remote = inMemoryGitHub()
  remote.beforeFirstBundleUpload = ({ name }) => {
    const winner = unrelated.bundles.find((bundle) => bundle.name === name)
    remote.addAsset(name, winner.bytes)
  }

  await assert.rejects(
    escrowCandidate({
      candidate: CANDIDATE,
      record: fixture.record,
      artifact: fixture.artifact,
      attestationSet: fixture.attestationSet,
      bundles: fixture.bundles,
      publicationState: publicationState(fixture),
      attestations: verifiedAttestations(fixture),
      github: remote.github,
    }),
    /attestation.*run.*enumerated|authorized.*run/iu,
  )
  assert.equal(parseReleaseMarker(remote.release.body).phase, "ATTACHING")
})

test("escrow revalidates the annotated candidate tag before a no-op", async () => {
  const fixture = releaseFixture()
  const remote = inMemoryGitHub()
  const input = {
    candidate: CANDIDATE,
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: fixture.attestationSet,
    bundles: fixture.bundles,
    publicationState: publicationState(fixture),
    attestations: verifiedAttestations(fixture),
    github: remote.github,
  }
  await escrowCandidate(input)
  const mutationCount = remote.uploadCount + remote.updateCount
  remote.tagTargetSha = "f".repeat(40)

  await assert.rejects(escrowCandidate(input), /annotated|tag|target|commit/iu)
  assert.equal(remote.uploadCount + remote.updateCount, mutationCount)
})

test("escrow rejects an off-target or prerelease managed draft before further mutation", async () => {
  const fixture = releaseFixture()
  const remote = inMemoryGitHub()
  const input = {
    candidate: CANDIDATE,
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: fixture.attestationSet,
    bundles: fixture.bundles,
    publicationState: publicationState(fixture),
    attestations: verifiedAttestations(fixture),
    github: remote.github,
  }
  await escrowCandidate(input)
  const mutationCount = remote.uploadCount + remote.updateCount

  remote.release.target_commitish = "release-controller-temp"
  await assert.rejects(escrowCandidate(input), /mutable|target|managed Release/iu)
  assert.equal(remote.uploadCount + remote.updateCount, mutationCount)

  remote.release.target_commitish = "main"
  remote.release.prerelease = true
  await assert.rejects(escrowCandidate(input), /mutable|prerelease|managed Release/iu)
  assert.equal(remote.uploadCount + remote.updateCount, mutationCount)
})

test("npm and smoke reconciliation are separate one-transition body compare-and-swaps", async () => {
  const fixture = releaseFixture()
  const remote = inMemoryGitHub()
  await escrowCandidate({
    candidate: CANDIDATE,
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: fixture.attestationSet,
    bundles: fixture.bundles,
    publicationState: publicationState(fixture),
    attestations: verifiedAttestations(fixture),
    github: remote.github,
  })
  const npmEvidence = completeNpmEvidence(fixture)
  const npmResult = await reconcileNpmEvidence({
    candidate: CANDIDATE,
    record: fixture.record,
    manifest: fixture.manifest,
    npmEvidence,
    github: remote.github,
  })
  assert.equal(npmResult.phase, "NPM_COMPLETE")
  assert.equal(parseReleaseMarker(remote.release.body).phase, "NPM_COMPLETE")

  const smokeResults = completeSmokeResults(fixture)
  const smokeResult = await reconcileSmokeEvidence({
    candidate: CANDIDATE,
    record: fixture.record,
    manifest: fixture.manifest,
    npmEvidence,
    smokeResults,
    requiredLanes: SMOKE_LANES,
    ...SMOKE_RUN,
    github: remote.github,
  })
  assert.equal(smokeResult.phase, "SMOKES_COMPLETE")
  const marker = parseReleaseMarker(remote.release.body)
  assert.equal(marker.phase, "SMOKES_COMPLETE")
  assert.match(marker.npmEvidenceSha256, /^[0-9a-f]{64}$/u)
  assert.match(marker.smokeAggregateSha256, /^[0-9a-f]{64}$/u)
  assert.equal(remote.updateCount, 3)
})

test("smoke reconciliation rejects replayed, mixed, incomplete, failed, or foreign receipts with zero mutation", async () => {
  const fixture = releaseFixture()
  const remote = inMemoryGitHub()
  await escrowCandidate({
    candidate: CANDIDATE,
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: fixture.attestationSet,
    bundles: fixture.bundles,
    publicationState: publicationState(fixture),
    attestations: verifiedAttestations(fixture),
    github: remote.github,
  })
  const npmEvidence = completeNpmEvidence(fixture)
  await reconcileNpmEvidence({
    candidate: CANDIDATE,
    record: fixture.record,
    manifest: fixture.manifest,
    npmEvidence,
    github: remote.github,
  })
  const valid = completeSmokeResults(fixture)
  const cases = [
    [
      valid.map((receipt, index) => (index === 0 ? { ...receipt, workflowRunId: 199 } : receipt)),
      /workflow run|correlat/iu,
    ],
    [
      valid.map((receipt, index) => (index === 0 ? { ...receipt, runAttempt: 2 } : receipt)),
      /run attempt|correlat/iu,
    ],
    [valid.slice(1), /missing.*published-harness/iu],
    [[valid[0], ...valid], /duplicate.*published-harness/iu],
    [
      [{ ...valid[0], lane: "foreign" }, ...valid.slice(1)],
      /unexpected.*foreign|missing.*published/iu,
    ],
    [
      valid.map((receipt, index) =>
        index === 0
          ? {
              ...receipt,
              checks: [{ name: "exact-install", conclusion: "failure", detail: "failed" }],
              conclusion: "failure",
            }
          : receipt,
      ),
      /smoke.*success|conclusion/iu,
    ],
    [
      valid.map((receipt, index) =>
        index === 0 ? { ...receipt, commitSha: "f".repeat(40) } : receipt,
      ),
      /identity|commit/iu,
    ],
    [
      valid.map((receipt, index) =>
        index === 0 ? { ...receipt, manifestSha256: "e".repeat(64) } : receipt,
      ),
      /identity|manifest/iu,
    ],
  ]
  const updates = remote.updateCount

  for (const [smokeResults, expected] of cases) {
    await assert.rejects(
      reconcileSmokeEvidence({
        candidate: CANDIDATE,
        record: fixture.record,
        manifest: fixture.manifest,
        npmEvidence,
        smokeResults,
        requiredLanes: SMOKE_LANES,
        ...SMOKE_RUN,
        github: remote.github,
      }),
      expected,
    )
    assert.equal(remote.updateCount, updates)
  }
})

test("npm reconciliation rejects skeletal evidence before mutating the Release", async () => {
  const fixture = releaseFixture()
  const remote = inMemoryGitHub()
  await escrowCandidate({
    candidate: CANDIDATE,
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: fixture.attestationSet,
    bundles: fixture.bundles,
    publicationState: publicationState(fixture),
    attestations: verifiedAttestations(fixture),
    github: remote.github,
  })
  const updates = remote.updateCount

  await assert.rejects(
    reconcileNpmEvidence({
      candidate: CANDIDATE,
      record: fixture.record,
      manifest: fixture.manifest,
      npmEvidence: {
        schemaVersion: 1,
        version: VERSION,
        commitSha: COMMIT_SHA,
        manifestSha256: fixture.record.manifestSha256,
        complete: true,
      },
      github: remote.github,
    }),
    /npm evidence|package|receipt/iu,
  )
  assert.equal(remote.updateCount, updates)
})

test("npm reconciliation binds every package receipt to the sealed manifest", async () => {
  const fixture = releaseFixture()
  const remote = inMemoryGitHub()
  await escrowCandidate({
    candidate: CANDIDATE,
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: fixture.attestationSet,
    bundles: fixture.bundles,
    publicationState: publicationState(fixture),
    attestations: verifiedAttestations(fixture),
    github: remote.github,
  })
  const forged = structuredClone(completeNpmEvidence(fixture))
  forged.packages[0].size += 1
  forged.packages[0].tarballSha256 = "f".repeat(64)
  forged.packages[0].tarballSha512 = "e".repeat(128)
  forged.packages[0].integrity = `sha512-${Buffer.from(forged.packages[0].tarballSha512, "hex").toString("base64")}`
  const updates = remote.updateCount

  await assert.rejects(
    reconcileNpmEvidence({
      candidate: CANDIDATE,
      record: fixture.record,
      manifest: fixture.manifest,
      npmEvidence: forged,
      github: remote.github,
    }),
    /npm evidence|manifest|package/iu,
  )
  assert.equal(remote.updateCount, updates)
})

test("reconciliation rejects a foreign embedded attestation repository with zero mutation", async () => {
  const fixture = releaseFixture()
  const remote = inMemoryGitHub()
  await escrowCandidate({
    candidate: CANDIDATE,
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: fixture.attestationSet,
    bundles: fixture.bundles,
    publicationState: publicationState(fixture),
    attestations: verifiedAttestations(fixture),
    github: remote.github,
  })
  remote.release.body = remote.release.body.replace(
    '"repository":"cacheplane/dawnai"',
    '"repository":"fork/dawnai"',
  )
  const updates = remote.updateCount

  await assert.rejects(
    reconcileNpmEvidence({
      candidate: CANDIDATE,
      record: fixture.record,
      manifest: fixture.manifest,
      npmEvidence: completeNpmEvidence(fixture),
      github: remote.github,
    }),
    /attestation|repository|identity/iu,
  )
  assert.equal(remote.updateCount, updates)
})

test("consolidated publication accepts only attached canonical audit bytes and preserves metadata", async () => {
  const fixture = releaseFixture()
  const remote = inMemoryGitHub()
  await escrowCandidate({
    candidate: CANDIDATE,
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: fixture.attestationSet,
    bundles: fixture.bundles,
    publicationState: publicationState(fixture),
    attestations: verifiedAttestations(fixture),
    github: remote.github,
  })
  const npmEvidence = completeNpmEvidence(fixture)
  await reconcileNpmEvidence({
    candidate: CANDIDATE,
    record: fixture.record,
    manifest: fixture.manifest,
    npmEvidence,
    github: remote.github,
  })
  await reconcileSmokeEvidence({
    candidate: CANDIDATE,
    record: fixture.record,
    manifest: fixture.manifest,
    npmEvidence,
    smokeResults: completeSmokeResults(fixture),
    requiredLanes: SMOKE_LANES,
    ...SMOKE_RUN,
    github: remote.github,
  })
  const auditResult = {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: fixture.record.manifestSha256,
    workflowRunId: 300,
    runAttempt: 1,
    startedAt: "2026-08-24T01:00:00Z",
    finishedAt: "2026-08-24T01:01:00Z",
    checks: [{ name: "published-artifacts", conclusion: "success", detail: "verified" }],
    conclusion: "success",
  }
  const auditBytes = Buffer.from(`${JSON.stringify(canonicalize(auditResult), null, 2)}\n`)
  const auditDigest = sha256(auditBytes)
  const currentMarker = parseReleaseMarker(remote.release.body)
  const verified = {
    ...currentMarker,
    revision: currentMarker.revision + 1,
    phase: "AUDIT_VERIFIED",
    audit: {
      workflow: ".github/workflows/published-artifact-verify.yml",
      workflowRunId: 300,
      runUrl: "https://api.github.com/repos/cacheplane/dawnai/actions/runs/300",
      htmlUrl: "https://github.com/cacheplane/dawnai/actions/runs/300",
      runAttempt: 1,
      attemptAssetName: "audit-attempt-300-1.json",
      attemptSha256: auditDigest,
      canonicalSha256: auditDigest,
      conclusion: "success",
    },
  }
  remote.release.body = canonicalReleaseBody({ marker: verified, manifest: null })
  remote.addAsset("audit-attempt-300-1.json", auditBytes)
  remote.addAsset("audit-result.json", auditBytes)
  const bodyBefore = remote.release.body

  for (let index = 0; index < 128; index += 1) {
    remote.addAsset(`audit-attempt-${index + 1_000}-1.json`, Buffer.from("{}"))
  }
  const downloadsBeforePreflight = remote.downloadCount
  await assert.rejects(
    publishConsolidatedRelease({
      candidate: CANDIDATE,
      record: fixture.record,
      auditResult,
      github: remote.github,
    }),
    /audit|count|bound/iu,
  )
  assert.equal(remote.downloadCount, downloadsBeforePreflight)
  for (let index = 0; index < 128; index += 1) {
    remote.assets.delete(`audit-attempt-${index + 1_000}-1.json`)
  }

  remote.addAsset(
    "audit-attempt-299-1.json",
    Buffer.alloc(RELEASE_PAYLOAD_LIMITS.auditReceiptBytes + 1),
  )
  await assert.rejects(
    publishConsolidatedRelease({
      candidate: CANDIDATE,
      record: fixture.record,
      auditResult,
      github: remote.github,
    }),
    /audit|size|byte|limit/iu,
  )
  assert.equal(remote.downloadCount, downloadsBeforePreflight)
  remote.assets.delete("audit-attempt-299-1.json")

  remote.release.body = bodyBefore.replace(
    '"repository":"cacheplane/dawnai"',
    '"repository":"fork/dawnai"',
  )
  await assert.rejects(
    publishConsolidatedRelease({
      candidate: CANDIDATE,
      record: fixture.record,
      auditResult,
      github: remote.github,
    }),
    /attestation|repository|identity/iu,
  )
  assert.equal(remote.publishCount, 0)
  remote.release.body = bodyBefore

  const historicalSuccess = {
    ...auditResult,
    workflowRunId: 299,
    checks: [{ name: "published-artifacts", conclusion: "success", detail: "unexpected" }],
  }
  remote.addAsset(
    "audit-attempt-299-1.json",
    Buffer.from(`${JSON.stringify(canonicalize(historicalSuccess), null, 2)}\n`),
  )
  await assert.rejects(
    publishConsolidatedRelease({
      candidate: CANDIDATE,
      record: fixture.record,
      auditResult,
      github: remote.github,
    }),
    /audit|historical|failure|receipt/iu,
  )
  assert.equal(remote.publishCount, 0)
  remote.assets.delete("audit-attempt-299-1.json")

  const historicalFailure = {
    ...auditResult,
    workflowRunId: 299,
    checks: [{ name: "published-artifacts", conclusion: "failure", detail: "failed" }],
    conclusion: "failure",
  }
  remote.addAsset(
    "audit-attempt-299-1.json",
    Buffer.from(`${JSON.stringify(canonicalize(historicalFailure), null, 2)}\n`),
  )

  const manifestAsset = remote.assets.get("manifest.json")
  const manifestBytes = manifestAsset.bytes
  manifestAsset.bytes = Buffer.from("corrupt manifest")
  await assert.rejects(
    publishConsolidatedRelease({
      candidate: CANDIDATE,
      record: fixture.record,
      auditResult,
      github: remote.github,
    }),
    /base|manifest|digest|asset/iu,
  )
  manifestAsset.bytes = manifestBytes

  const result = await publishConsolidatedRelease({
    candidate: CANDIDATE,
    record: fixture.record,
    auditResult,
    github: remote.github,
  })
  assert.deepEqual(result, {
    releaseId: 7,
    phase: "AUDIT_COMPLETE",
    status: "published",
    immutable: true,
    bodySha256: releaseBodySha256(bodyBefore),
  })
  assert.equal(remote.release.body, bodyBefore)
  assert.equal(remote.release.draft, false)
  assert.equal(remote.release.immutable, true)
  assert.equal(remote.publishCount, 1)
})

function releaseFixture({
  bundleText = "multi-subject-bundle",
  attestationRunId = 100,
  attestationRunAttempt = 2,
} = {}) {
  const fileBytes = new Map()
  const packages = CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => {
    const filename = packageFilename(name)
    const bytes = Buffer.from(`package:${name}:${VERSION}`, "utf8")
    fileBytes.set(filename, bytes)
    const sha512 = createHash("sha512").update(bytes).digest("hex")
    return {
      name,
      version: VERSION,
      filename,
      size: bytes.length,
      sha256: sha256(bytes),
      sha512,
      npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
      access: "public",
    }
  })
  const manifest = {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    ci: { workflow: "CI", runId: 10, runAttempt: 1 },
    artifact: {
      name: `release-v${VERSION}-${COMMIT_SHA.slice(0, 12)}`,
      prepareRunId: 11,
      prepareRunAttempt: 1,
    },
    packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
    packages,
  }
  const manifestBytes = canonicalManifestBytes(manifest)
  fileBytes.set("manifest.json", manifestBytes)
  const record = createReleaseRecord({
    candidate: CANDIDATE,
    manifestSha256: sha256(manifestBytes),
    artifact: { name: manifest.artifact.name },
    artifactUpload: { id: "12", digest: `sha256:${"a".repeat(64)}` },
    prepareRun: { id: 11, attempt: 1 },
  })
  const subjectFiles = [
    { name: "manifest.json", bytes: manifestBytes },
    ...packages.map((pkg) => ({ name: pkg.filename, bytes: fileBytes.get(pkg.filename) })),
  ]
  const bundleBytes = attestationBundleBytes(subjectFiles, {
    runId: attestationRunId,
    runAttempt: attestationRunAttempt,
    signature: bundleText,
  })
  const bundles = subjectFiles.map(({ name }) => ({
    name: `${name}.intoto.jsonl`,
    bytes: Buffer.from(bundleBytes),
  }))
  const attestationSet = {
    repository: REPOSITORY,
    workflow: ".github/workflows/release.yml",
    sourceRef: `refs/tags/v${VERSION}`,
    commitSha: COMMIT_SHA,
    workflowRunId: attestationRunId,
    runAttempt: attestationRunAttempt,
    subjects: subjectFiles.map((file, index) => ({
      subjectName: file.name,
      subjectSha256: sha256(file.bytes),
      bundleName: bundles[index].name,
      bundleSha256: sha256(bundles[index].bytes),
    })),
  }
  return {
    manifest,
    record,
    attestationSet,
    bundles,
    artifact: { manifest, files: subjectFiles },
  }
}

function attestationBundleBytes(subjectFiles, { runId, runAttempt, signature }) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: subjectFiles.map((file) => ({
      name: file.name,
      digest: { sha256: sha256(file.bytes) },
    })),
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      runDetails: {
        metadata: {
          invocationId: `https://github.com/cacheplane/dawnai/actions/runs/${runId}/attempts/${runAttempt}`,
        },
      },
    },
  }
  return Buffer.from(
    JSON.stringify({
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
        signatures: [{ sig: Buffer.from(signature, "utf8").toString("base64") }],
      },
      verificationMaterial: {},
    }),
    "utf8",
  )
}

function escrowMarker(fixture) {
  const base = canonicalBaseAssetSet({
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: fixture.attestationSet,
    bundles: fixture.bundles,
  })
  return {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 2,
    phase: "ESCROWED",
    version: VERSION,
    commitSha: COMMIT_SHA,
    tag: `v${VERSION}`,
    manifestSha256: sha256(canonicalManifestBytes(fixture.manifest)),
    releaseRecordSha256: releaseRecordSha256(fixture.record),
    baseAssetSetSha256: base.sha256,
    attestationSet: fixture.attestationSet,
    npmEvidenceSha256: null,
    smokeAggregateSha256: null,
    audit: null,
    abandonmentSha256: null,
  }
}

function attachingMarker(fixture) {
  const marker = escrowMarker(fixture)
  return {
    ...marker,
    revision: 1,
    phase: "ATTACHING",
    baseAssetSetSha256: null,
    attestationSet: null,
  }
}

function publicationState(
  fixture,
  {
    runs = [
      {
        runId: fixture.attestationSet.workflowRunId,
        runAttempt: fixture.attestationSet.runAttempt,
      },
    ],
  } = {},
) {
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    tag: `v${VERSION}`,
    observedAt: "2026-08-24T00:00:00Z",
    candidateRuns: runs.map(({ runId, runAttempt }) => ({
      runId,
      runAttempt,
      headSha: COMMIT_SHA,
      headBranch: `v${VERSION}`,
      workflowPath: ".github/workflows/release.yml",
      event: "workflow_dispatch",
      jobs: Array.from({ length: runAttempt }, (_unused, index) => index + 1).flatMap((attempt) => {
        const publisher = {
          id: attempt * 3 - 1,
          runAttempt: attempt,
          name: "publish-npm",
          status: "queued",
          conclusion: null,
          startedAt: null,
          completedAt: null,
        }
        if (attempt !== runAttempt) return [publisher]
        return [
          {
            id: attempt * 3 - 2,
            runAttempt: attempt,
            name: "prepare",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-08-24T00:01:00Z",
            completedAt: "2026-08-24T00:02:00Z",
          },
          publisher,
        ]
      }),
    })),
    registryMutationReceipts: [],
    packages: fixture.manifest.packages.map(({ name }) => ({
      name,
      version: VERSION,
      status: "ABSENT",
      httpStatus: 404,
      observedAt: "2026-08-24T00:00:00Z",
    })),
  }
}

function packageFilename(name) {
  return `${name.replace(/^@/u, "").replace("/", "-")}-${VERSION}.tgz`
}

function verifiedAttestations(fixture) {
  return Object.freeze({
    async verify({ source, record, subjects, files, bundles }) {
      assert.equal(source, "escrow")
      assert.deepEqual(record, fixture.record)
      assert.equal(files.length, 22)
      assert.equal(bundles.length, 22)
      return { status: "VERIFIED", subjects }
    },
  })
}

function completeNpmEvidence(fixture) {
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: fixture.record.manifestSha256,
    complete: true,
    status: "NPM_COMPLETE",
    packages: fixture.manifest.packages.map((pkg) => ({
      name: pkg.name,
      version: VERSION,
      status: "present",
      size: pkg.size,
      tarballSha256: pkg.sha256,
      tarballSha512: pkg.sha512,
      integrity: pkg.npmIntegrity,
      latest: { status: "present", version: VERSION },
      signature: {
        status: "valid",
        verifier: "npm-audit-signatures@11.17.0",
      },
      provenance: {
        predicateType: "https://slsa.dev/provenance/v1",
        workflow: ".github/workflows/release.yml",
        commitSha: COMMIT_SHA,
        repository: "https://github.com/cacheplane/dawnai",
        ref: `refs/tags/v${VERSION}`,
      },
    })),
  }
}

function completeSmokeResults(fixture) {
  return SMOKE_LANES.map((lane) => ({
    schemaVersion: 1,
    lane,
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: fixture.record.manifestSha256,
    ...SMOKE_RUN,
    startedAt: "2026-08-24T00:10:00.000Z",
    finishedAt: "2026-08-24T00:11:00.000Z",
    checks: [{ name: "exact-install", conclusion: "success", detail: "verified" }],
    conclusion: "success",
  }))
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function inMemoryGitHub() {
  const remote = {
    release: null,
    assets: new Map(),
    nextAssetId: 1,
    uploadCount: 0,
    updateCount: 0,
    publishCount: 0,
    failAfterUploads: null,
    beforeFirstBundleUpload: null,
    tagObjectType: "tag",
    tagObjectSha: "a".repeat(40),
    tagTargetSha: COMMIT_SHA,
    tagReadCount: 0,
    downloadCount: 0,
  }
  const reader = Object.freeze({
    async getRef() {
      remote.tagReadCount += 1
      return present("ref", {
        object: { type: remote.tagObjectType, sha: remote.tagObjectSha },
      })
    },
    async getGitTag() {
      remote.tagReadCount += 1
      return present("git-tag", {
        tag: `v${VERSION}`,
        object: { type: "commit", sha: remote.tagTargetSha },
      })
    },
    async listReleases() {
      return present(
        "releases",
        remote.release === null ? [] : [{ id: 7, tag_name: `v${VERSION}` }],
      )
    },
    async getRelease() {
      assert.ok(remote.release)
      return present("release", { ...remote.release })
    },
    async listReleaseAssets() {
      return present(
        "release-assets",
        [...remote.assets].map(([name, asset]) => ({
          id: asset.id,
          name,
          size: asset.bytes.byteLength,
        })),
      )
    },
    async downloadReleaseAsset({ assetId }) {
      remote.downloadCount += 1
      const asset = [...remote.assets.values()].find((entry) => entry.id === assetId)
      assert.ok(asset)
      return {
        status: "PRESENT",
        operation: "release-asset-download",
        httpStatus: 200,
        code: null,
        contentBase64: asset.bytes.toString("base64"),
      }
    },
  })
  const writer = Object.freeze({
    async createDraftRelease({ tag, title, body }) {
      if (remote.release === null) {
        remote.release = {
          id: 7,
          tag_name: tag,
          target_commitish: "main",
          prerelease: false,
          name: title,
          body,
          draft: true,
          immutable: false,
        }
        return { releaseId: 7, status: "created", bodySha256: releaseBodySha256(body) }
      }
      return {
        releaseId: 7,
        status: "existing",
        bodySha256: releaseBodySha256(remote.release.body),
      }
    },
    async updateDraftReleaseIfCurrent({ expectedBodySha256, title, body }) {
      assert.equal(releaseBodySha256(remote.release.body), expectedBodySha256)
      remote.release.name = title
      remote.release.body = body
      remote.updateCount += 1
      return { releaseId: 7, status: "updated", bodySha256: releaseBodySha256(body) }
    },
    async uploadAssetIfAbsentAndEqual({ name, bytes, sha256: digest }) {
      if (name.endsWith(".intoto.jsonl") && remote.beforeFirstBundleUpload !== null) {
        const hook = remote.beforeFirstBundleUpload
        remote.beforeFirstBundleUpload = null
        hook({ name, bytes: Buffer.from(bytes), sha256: digest })
      }
      const existing = remote.assets.get(name)
      if (existing !== undefined) {
        assert.equal(sha256(existing.bytes), digest)
        return { assetId: existing.id, status: "existing", sha256: digest }
      }
      if (remote.failAfterUploads !== null && remote.uploadCount >= remote.failAfterUploads) {
        throw new Error("injected runner loss")
      }
      const asset = { id: remote.nextAssetId, bytes: Buffer.from(bytes) }
      remote.nextAssetId += 1
      remote.assets.set(name, asset)
      remote.uploadCount += 1
      return { assetId: asset.id, status: "uploaded", sha256: digest }
    },
    async publishReleaseIfCurrent({ expectedBodySha256, assets }) {
      assert.equal(releaseBodySha256(remote.release.body), expectedBodySha256)
      assert.equal(assets.length, remote.assets.size)
      remote.release.draft = false
      remote.release.immutable = true
      remote.publishCount += 1
      return { releaseId: 7, status: "published", immutable: true }
    },
    async dispatchWorkflowAtRef() {
      throw new Error("not used")
    },
  })
  remote.github = Object.freeze({ reader, writer })
  remote.addAsset = (name, bytes) => {
    remote.assets.set(name, { id: remote.nextAssetId, bytes: Buffer.from(bytes) })
    remote.nextAssetId += 1
  }
  return remote
}

function present(operation, value) {
  return { status: "PRESENT", operation, httpStatus: 200, code: null, value }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function assertRecursivelyFrozen(value) {
  if (value === null || typeof value !== "object") return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertRecursivelyFrozen(child)
}
