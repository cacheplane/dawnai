import { createHash } from "node:crypto"

import { CANONICAL_RELEASE_PACKAGE_ORDER, canonicalManifestBytes } from "../../manifest.mjs"
import { canonicalBaseAssetSet, canonicalReleaseBody } from "../../metadata.mjs"
import { createReleaseRecord, releaseRecordSha256 } from "../../release-record.mjs"

export const DUPLICATE_DRAFT_CANDIDATE = Object.freeze({
  version: "0.8.22",
  commitSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
  tag: "v0.8.22",
})
export const DUPLICATE_DRAFT_SURVIVOR_ID = "379991871"
export const DUPLICATE_DRAFT_IDS = Object.freeze(["379982100", "379986168"])

const REPOSITORY = "cacheplane/dawnai"
const AUTHOR = Object.freeze({
  login: "blove",
  id: 61436,
  node_id: "MDQ6VXNlcjYxNDM2",
})

export function createDuplicateDraftConsolidationFixture() {
  const artifact = createArtifact()
  const attestation = createAttestation(artifact)
  const base = canonicalBaseAssetSet({
    record: artifact.record,
    artifact: artifact.artifact,
    attestationSet: attestation.set,
    bundles: attestation.bundles,
  })
  const marker = {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 2,
    phase: "ESCROWED",
    version: DUPLICATE_DRAFT_CANDIDATE.version,
    commitSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
    tag: DUPLICATE_DRAFT_CANDIDATE.tag,
    manifestSha256: sha256(canonicalManifestBytes(artifact.manifest)),
    releaseRecordSha256: releaseRecordSha256(artifact.record),
    baseAssetSetSha256: base.sha256,
    attestationSet: attestation.set,
    npmEvidenceSha256: null,
    smoke: null,
    audit: null,
    abandonmentSha256: null,
  }
  const body = canonicalReleaseBody({ marker, manifest: artifact.manifest })
  const bytesByName = new Map(
    base.assets.map((entry) => [entry.name, Buffer.from(entry.contentBase64, "base64")]),
  )
  const identities = [
    {
      id: DUPLICATE_DRAFT_SURVIVOR_ID,
      nodeId: "RE_survivor",
      tagName: "untagged-be0ff4bee4ba43b521a9",
    },
    {
      id: DUPLICATE_DRAFT_IDS[0],
      nodeId: "RE_duplicate_one",
      tagName: "untagged-a13939767dd2419ade01",
    },
    {
      id: DUPLICATE_DRAFT_IDS[1],
      nodeId: "RE_duplicate_two",
      tagName: "untagged-20706099efa3c38335a8",
    },
  ]
  const payloads = new Map()
  const releases = identities.map((identity, releaseIndex) => {
    const assets = base.assets.map((entry, assetIndex) => {
      const bytes = bytesByName.get(entry.name)
      const id = String(900_000 + releaseIndex * 100 + assetIndex + 1)
      payloads.set(`${identity.id}:${entry.name}`, Buffer.from(bytes))
      return {
        id: Number(id),
        node_id: `RA_${releaseIndex}_${assetIndex}`,
        name: entry.name,
        label: entry.name === "manifest.json" ? "sealed manifest" : null,
        state: "uploaded",
        content_type: contentType(entry.name),
        size: bytes.byteLength,
        digest: `sha256:${entry.sha256}`,
        uploader: { ...AUTHOR },
        created_at: `2026-08-31T0${releaseIndex}:01:${String(assetIndex).padStart(2, "0")}Z`,
        updated_at: `2026-08-31T0${releaseIndex}:02:${String(assetIndex).padStart(2, "0")}Z`,
        download_count: releaseIndex + assetIndex,
        browser_download_url: `https://github.invalid/releases/assets/${id}`,
      }
    })
    assets.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    return {
      id: Number(identity.id),
      node_id: identity.nodeId,
      tag_name: identity.tagName,
      name: `Dawn v${DUPLICATE_DRAFT_CANDIDATE.version}`,
      target_commitish: "main",
      draft: true,
      immutable: false,
      prerelease: false,
      published_at: null,
      body,
      author: { ...AUTHOR },
      created_at: `2026-08-31T0${releaseIndex}:00:00Z`,
      updated_at: `2026-08-31T0${releaseIndex}:30:00Z`,
      assets,
      html_url: `https://github.invalid/releases/${identity.id}`,
    }
  })

  let downloadCount = 0
  let failVerification = false
  const operations = []
  const github = Object.freeze({
    async downloadReleaseAsset({ assetId, maximumBytes, releaseId }) {
      operations.push(`download:${releaseId}:${assetId}`)
      downloadCount += 1
      const release = releases.find(({ id }) => String(id) === String(releaseId))
      const asset = release?.assets.find(({ id }) => String(id) === String(assetId))
      const bytes =
        asset === undefined ? undefined : payloads.get(`${String(releaseId)}:${asset.name}`)
      if (bytes === undefined || bytes.byteLength > maximumBytes) {
        throw new Error("fixture asset download request is invalid")
      }
      return present("release-asset-download", {
        contentBase64: bytes.toString("base64"),
      })
    },
    async getRelease({ releaseId }) {
      operations.push(`get:${releaseId}`)
      const release = releases.find(({ id }) => String(id) === String(releaseId))
      if (release === undefined) throw new Error("fixture Release does not exist")
      return present("release", { value: structuredClone(release) })
    },
    async listReleaseAssets({ releaseId }) {
      operations.push(`list-assets:${releaseId}`)
      const release = releases.find(({ id }) => String(id) === String(releaseId))
      if (release === undefined) throw new Error("fixture Release does not exist")
      return present("release-assets", {
        value: structuredClone(release.assets),
      })
    },
  })
  const attestations = Object.freeze({
    async verify({ subjects }) {
      if (failVerification) throw new Error("fixture verification failure")
      return { status: "VERIFIED", subjects }
    },
  })

  return {
    candidate: DUPLICATE_DRAFT_CANDIDATE,
    survivorId: DUPLICATE_DRAFT_SURVIVOR_ID,
    duplicateIds: [...DUPLICATE_DRAFT_IDS],
    releases,
    github,
    attestations,
    expectedBaseAssetSet: base.assets.map(({ name, sha256: digest }) => ({
      name,
      sha256: digest,
    })),
    get downloadCount() {
      return downloadCount
    },
    get operations() {
      return [...operations]
    },
    clearOperations() {
      operations.length = 0
    },
    failVerification() {
      failVerification = true
    },
    replaceMarker(mutator) {
      const next = structuredClone(marker)
      mutator(next)
      const nextBody = canonicalReleaseBody({
        marker: next,
        manifest: artifact.manifest,
      })
      for (const release of releases) release.body = nextBody
    },
    assetBytes(releaseId, name) {
      const bytes = payloads.get(`${String(releaseId)}:${name}`)
      if (bytes === undefined) throw new Error("fixture asset is missing")
      return Buffer.from(bytes)
    },
    replaceAssetBytes(releaseId, name, bytes, { updateMetadata = false } = {}) {
      const release = releases.find(({ id }) => String(id) === String(releaseId))
      const asset = release?.assets.find((entry) => entry.name === name)
      if (asset === undefined) throw new Error("fixture asset is missing")
      const replacement = Buffer.from(bytes)
      payloads.set(`${String(releaseId)}:${asset.name}`, replacement)
      if (updateMetadata) {
        asset.size = replacement.byteLength
        asset.digest = `sha256:${sha256(replacement)}`
      }
    },
  }
}

function createArtifact() {
  const packageFiles = []
  const packages = CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => {
    const filename = `${name.replace(/^@/u, "").replace("/", "-")}-${DUPLICATE_DRAFT_CANDIDATE.version}.tgz`
    const bytes = Buffer.from(`package:${name}:${DUPLICATE_DRAFT_CANDIDATE.commitSha}\n`, "utf8")
    packageFiles.push({ name: filename, bytes })
    const sha512 = createHash("sha512").update(bytes).digest("hex")
    return {
      name,
      version: DUPLICATE_DRAFT_CANDIDATE.version,
      filename,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      sha512,
      npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
      access: "public",
    }
  })
  const manifest = {
    schemaVersion: 1,
    version: DUPLICATE_DRAFT_CANDIDATE.version,
    commitSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
    ci: { workflow: "CI", runId: 8001, runAttempt: 1 },
    artifact: {
      name: `release-v${DUPLICATE_DRAFT_CANDIDATE.version}-${DUPLICATE_DRAFT_CANDIDATE.commitSha.slice(0, 12)}`,
      prepareRunId: 8002,
      prepareRunAttempt: 1,
    },
    packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
    packages,
  }
  const manifestBytes = canonicalManifestBytes(manifest)
  const record = createReleaseRecord({
    candidate: {
      version: DUPLICATE_DRAFT_CANDIDATE.version,
      commitSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
      ciWorkflow: "CI",
      ciCheck: "validate",
      publisherWorkflow: ".github/workflows/release.yml",
    },
    manifestSha256: sha256(manifestBytes),
    artifact: { name: manifest.artifact.name },
    artifactUpload: { id: "8003", digest: `sha256:${"a".repeat(64)}` },
    prepareRun: { id: 8002, attempt: 1 },
  })
  return {
    manifest,
    record,
    artifact: {
      manifest,
      files: [{ name: "manifest.json", bytes: manifestBytes }, ...packageFiles],
    },
  }
}

function createAttestation(artifact) {
  const subjects = artifact.artifact.files.map(({ name, bytes }) => ({
    name,
    sha256: sha256(bytes),
  }))
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: subjects.map(({ name, sha256: digest }) => ({
      name,
      digest: { sha256: digest },
    })),
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      runDetails: {
        metadata: {
          invocationId: "https://github.com/cacheplane/dawnai/actions/runs/8004/attempts/1",
        },
      },
    },
  }
  const bundleBytes = Buffer.from(
    `${JSON.stringify({
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {},
      dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
        signatures: [{ sig: "fixture-signature" }],
      },
    })}\n`,
    "utf8",
  )
  const bundleSha256 = sha256(bundleBytes)
  return {
    set: {
      repository: REPOSITORY,
      workflow: ".github/workflows/release.yml",
      sourceRef: `refs/tags/${DUPLICATE_DRAFT_CANDIDATE.tag}`,
      commitSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
      workflowRunId: 8004,
      runAttempt: 1,
      subjects: subjects.map(({ name, sha256: digest }) => ({
        subjectName: name,
        subjectSha256: digest,
        bundleName: `${name}.intoto.jsonl`,
        bundleSha256,
      })),
    },
    bundles: subjects.map(({ name }) => ({
      name: `${name}.intoto.jsonl`,
      bytes: bundleBytes,
    })),
  }
}

function present(operation, fields) {
  return {
    status: "PRESENT",
    operation,
    httpStatus: 200,
    code: null,
    ...fields,
  }
}

function contentType(name) {
  if (name.endsWith(".tgz")) return "application/gzip"
  if (name.endsWith(".jsonl")) return "application/jsonl"
  return "application/json"
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}
