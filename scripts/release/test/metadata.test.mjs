import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
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
    () => parseReleaseMarker(body.replace('"revision":1', '"revision":1, "extra":true')),
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
})

test("canonical marker updates require revision-by-one legal phase transitions", () => {
  const fixture = releaseFixture()
  const escrowing = escrowMarker(fixture)
  const escrowed = { ...escrowing, revision: 2, phase: "ESCROWED" }

  assert.doesNotThrow(() =>
    canonicalReleaseBody({
      marker: escrowed,
      manifest: fixture.manifest,
      previousMarker: escrowing,
    }),
  )
  assert.throws(
    () =>
      canonicalReleaseBody({
        marker: { ...escrowing, revision: 3 },
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
        previousMarker: escrowing,
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
    github: remote.github,
  }

  remote.failAfterUploads = 10
  await assert.rejects(escrowCandidate(input), /injected runner loss/iu)
  assert.equal(parseReleaseMarker(remote.release.body).phase, "ESCROWING")
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
    github: remote.github,
  })
  const npmEvidence = {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: fixture.record.manifestSha256,
    complete: true,
  }
  const npmResult = await reconcileNpmEvidence({
    candidate: CANDIDATE,
    record: fixture.record,
    npmEvidence,
    github: remote.github,
  })
  assert.equal(npmResult.phase, "NPM_COMPLETE")
  assert.equal(parseReleaseMarker(remote.release.body).phase, "NPM_COMPLETE")

  const smokeResults = [
    {
      name: "published-install",
      status: "passed",
      version: VERSION,
      commitSha: COMMIT_SHA,
      manifestSha256: fixture.record.manifestSha256,
      workflowRunId: 200,
      runAttempt: 1,
    },
  ]
  const smokeResult = await reconcileSmokeEvidence({
    candidate: CANDIDATE,
    record: fixture.record,
    npmEvidence,
    smokeResults,
    github: remote.github,
  })
  assert.equal(smokeResult.phase, "SMOKES_COMPLETE")
  const marker = parseReleaseMarker(remote.release.body)
  assert.equal(marker.phase, "SMOKES_COMPLETE")
  assert.match(marker.npmEvidenceSha256, /^[0-9a-f]{64}$/u)
  assert.match(marker.smokeAggregateSha256, /^[0-9a-f]{64}$/u)
  assert.equal(remote.updateCount, 3)
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
    github: remote.github,
  })
  const npmEvidence = {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: fixture.record.manifestSha256,
    complete: true,
  }
  await reconcileNpmEvidence({
    candidate: CANDIDATE,
    record: fixture.record,
    npmEvidence,
    github: remote.github,
  })
  await reconcileSmokeEvidence({
    candidate: CANDIDATE,
    record: fixture.record,
    npmEvidence,
    smokeResults: [
      {
        name: "published-install",
        status: "passed",
        version: VERSION,
        commitSha: COMMIT_SHA,
        manifestSha256: fixture.record.manifestSha256,
        workflowRunId: 200,
        runAttempt: 1,
      },
    ],
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

function releaseFixture() {
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
  const bundles = subjectFiles.map(({ name }) => ({
    name: `${name}.intoto.jsonl`,
    bytes: Buffer.from(`bundle:${name}`, "utf8"),
  }))
  const attestationSet = {
    repository: REPOSITORY,
    workflow: ".github/workflows/release.yml",
    sourceRef: `refs/tags/v${VERSION}`,
    commitSha: COMMIT_SHA,
    workflowRunId: 13,
    runAttempt: 1,
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
    revision: 1,
    phase: "ESCROWING",
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

function publicationState(fixture) {
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    tag: `v${VERSION}`,
    observedAt: "2026-08-24T00:00:00Z",
    candidateRuns: [
      {
        runId: 100,
        runAttempt: 2,
        headSha: COMMIT_SHA,
        headBranch: `v${VERSION}`,
        jobs: [
          {
            id: 1,
            runAttempt: 1,
            name: "publish-npm",
            status: "queued",
            conclusion: null,
            startedAt: null,
            completedAt: null,
          },
          {
            id: 2,
            runAttempt: 2,
            name: "prepare",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-08-24T00:01:00Z",
            completedAt: "2026-08-24T00:02:00Z",
          },
        ],
      },
    ],
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
  }
  const reader = Object.freeze({
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
        [...remote.assets].map(([name, asset]) => ({ id: asset.id, name })),
      )
    },
    async downloadReleaseAsset({ assetId }) {
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
