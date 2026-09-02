import { createHash } from "node:crypto"
import { isDeepStrictEqual, types as utilTypes } from "node:util"

import { DUPLICATE_DRAFT_CONSOLIDATION_LIMITS } from "./duplicate-draft-consolidation-schema.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "./limits.mjs"
import { canonicalManifestBytes, parseSealedReleaseManifest } from "./manifest.mjs"
import {
  canonicalBaseAssetSet,
  canonicalReleaseBody,
  parseAttestationSet,
  parseReleaseMarker,
  verifyReleaseAttestationAnchor,
} from "./metadata.mjs"
import {
  canonicalReleaseRecordBytes,
  parseReleaseRecord,
  releaseRecordSha256,
} from "./release-record.mjs"

const APPROVED_VERSION = "0.8.22"
const APPROVED_COMMIT_SHA = "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8"
const APPROVED_TAG = "v0.8.22"
const APPROVED_SURVIVOR_ID = "379991871"
const APPROVED_DUPLICATE_IDS = Object.freeze(["379982100", "379986168"])
const APPROVED_AUTHOR = Object.freeze({
  login: "blove",
  id: "61436",
  nodeId: "MDQ6VXNlcjYxNDM2",
})
const RELEASE_EVIDENCE_FIELDS = Object.freeze([
  "role",
  "id",
  "nodeId",
  "tagName",
  "createdAt",
  "updatedAt",
  "semantic",
  "assets",
])
const RELEASE_SEMANTIC_FIELDS = Object.freeze([
  "name",
  "targetCommitish",
  "draft",
  "immutable",
  "prerelease",
  "publishedAt",
  "body",
  "bodySha256",
  "author",
])
const SERVICE_IDENTITY_FIELDS = Object.freeze(["login", "id", "nodeId"])
const ASSET_EVIDENCE_FIELDS = Object.freeze([
  "id",
  "nodeId",
  "name",
  "label",
  "state",
  "contentType",
  "size",
  "digest",
  "uploader",
  "createdAt",
  "updatedAt",
  "downloadCount",
  "downloadSha256",
])
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/u
const ID_PATTERN = /^[1-9][0-9]*$/u
const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u
const GITHUB_TIMESTAMP_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u
const AGGREGATE_ESCROW_BYTES = 3 * RELEASE_PAYLOAD_LIMITS.escrowBytes

export async function inspectEquivalentDrafts(input) {
  const context = snapshotInspectionInput(input)
  const managed = candidateReleases(context.releases, context.candidate)
  if (managed.published.length !== 0) {
    throw new Error("A published Release already matches the candidate")
  }
  if (managed.drafts.length !== 3) {
    throw new Error("Exactly three managed candidate drafts are required")
  }

  const orderedIds = [context.survivorId, ...context.duplicateIds]
  const byId = new Map(
    managed.drafts.map((entry) => [canonicalId(entry.release.id, "Release id"), entry]),
  )
  if (byId.size !== 3 || orderedIds.some((id) => !byId.has(id))) {
    throw new Error("Managed Release roles do not match the approved exact IDs and order")
  }
  const selected = orderedIds.map((id, index) => ({
    ...byId.get(id),
    role: index === 0 ? "survivor" : "duplicate",
  }))
  preflightDownloads(
    selected.map(({ release, marker }) => ({
      release,
      expectedNames: markerAssetNames(marker),
    })),
    context.accounting,
  )

  const counter = {
    downloads: context.accounting.downloadedAssets,
    bytes: context.accounting.downloadedBytes,
  }
  const releases = []
  const hydration = []
  for (const selectedRelease of selected) {
    const result = await hydrateRelease({
      ...selectedRelease,
      candidate: context.candidate,
      github: context.github,
      attestations: context.attestations,
      counter,
    })
    releases.push(result.evidence)
    hydration.push(result)
  }
  assertThreeWayParity(releases)
  for (let index = 1; index < hydration.length; index += 1) {
    if (
      hydration[index].baseAssetSetSha256 !== hydration[0].baseAssetSetSha256 ||
      !isDeepStrictEqual(hydration[index].baseAssetSet, hydration[0].baseAssetSet) ||
      !isDeepStrictEqual(hydration[index].verifiedSubjects, hydration[0].verifiedSubjects)
    ) {
      throw new Error("Candidate draft production payload proofs are not equal")
    }
  }
  if (
    counter.downloads !== 135 ||
    counter.downloads > DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.maximumAssetDownloads ||
    counter.bytes > AGGREGATE_ESCROW_BYTES
  ) {
    throw new Error("Duplicate draft download aggregate exceeded its exact bound")
  }

  const payloadProjection = releases.map((release) => ({
    release: semanticReleaseProjection(release),
    assets: release.assets.map(semanticAssetProjection),
  }))
  return deepFreeze({
    releases,
    payloadProof: {
      baseAssetSet: hydration[0].baseAssetSet,
      baseAssetSetSha256: hydration[0].baseAssetSetSha256,
      consolidationPayloadSha256: canonicalSha256(payloadProjection),
      attestationVerification: {
        status: "VERIFIED",
        subjects: hydration[0].verifiedSubjects,
      },
    },
  })
}

export async function captureDirectTargetRead(input) {
  const value = snapshotPlain(input, "direct target read input", {
    allowFunctions: true,
  })
  assertExactKeys(
    value,
    [
      "candidate",
      "releaseId",
      "role",
      "expectedEvidence",
      "github",
      ...(Object.hasOwn(value, "now") ? ["now"] : []),
    ],
    "direct target read input",
  )
  const candidate = parseCandidate(value.candidate)
  const releaseId = canonicalId(value.releaseId, "Direct target Release id")
  const role = value.role
  if (role !== "survivor" && role !== "duplicate") {
    throw new TypeError("Direct target Release role is invalid")
  }
  const expectedEvidence = parseReleaseEvidence(value.expectedEvidence)
  if (expectedEvidence.id !== releaseId || expectedEvidence.role !== role) {
    throw new Error("Direct target expected evidence identity is invalid")
  }
  const github = bindBoundary(
    value.github,
    ["getRelease", "listReleaseAssets"],
    "GitHub direct target reader",
  )
  const now = value.now === undefined ? () => new Date().toISOString() : value.now
  if (typeof now !== "function") throw new TypeError("Direct target clock is invalid")

  const releaseGetStartedAt = canonicalTimestamp(now(), "Release GET start")
  const releaseEnvelope = await github.getRelease({ releaseId })
  const releaseGetCompletedAt = canonicalTimestamp(now(), "Release GET completion")
  assertMonotone(releaseGetStartedAt, releaseGetCompletedAt, "Release GET")
  const release = exactPresentValue(releaseEnvelope, "release")
  if (canonicalId(release.id, "Direct target Release id") !== releaseId) {
    throw new Error("Direct Release-by-ID read returned the wrong identity")
  }
  const assetsListStartedAt = canonicalTimestamp(now(), "Asset list start")
  assertMonotone(releaseGetCompletedAt, assetsListStartedAt, "Direct target read")
  const assetsEnvelope = await github.listReleaseAssets({ releaseId })
  const assetsListCompletedAt = canonicalTimestamp(now(), "Asset list completion")
  assertMonotone(assetsListStartedAt, assetsListCompletedAt, "Asset list")
  const assets = exactPresentValue(assetsEnvelope, "release-assets")
  if (!Array.isArray(assets)) throw new TypeError("Direct target asset enumeration is invalid")
  const directRelease = { ...snapshotPlain(release, "direct Release"), assets }
  preflightDownloads([
    {
      release: directRelease,
      expectedNames: expectedEvidence.assets.map(({ name }) => name),
    },
  ])
  const directEvidence = buildDirectEvidence({
    release: directRelease,
    role,
    candidate,
    expectedEvidence,
  })
  const evidence = assertEvidenceEqualsProposal(directEvidence, expectedEvidence)
  return deepFreeze({
    releaseGetStartedAt,
    releaseGetCompletedAt,
    assetsListStartedAt,
    assetsListCompletedAt,
    evidence,
    evidenceSha256: canonicalSha256(evidence),
  })
}

export function parseReleaseEvidence(value) {
  value = snapshotPlain(value, "Release evidence")
  assertExactKeys(value, RELEASE_EVIDENCE_FIELDS, "Release evidence")
  if (value.role !== "survivor" && value.role !== "duplicate") {
    throw new TypeError("Release evidence role is invalid")
  }
  if (!Array.isArray(value.assets) || value.assets.length !== 45) {
    throw new TypeError("Release evidence must contain exactly 45 assets")
  }
  const assets = value.assets.map(parseAssetEvidence)
  if (
    new Set(assets.map(({ id }) => id)).size !== 45 ||
    new Set(assets.map(({ name }) => name)).size !== 45
  ) {
    throw new TypeError("Release evidence asset identities must be unique")
  }
  const aggregateSize = assets.reduce(
    (total, { size }) => checkedAdd(total, size, "Release evidence payload"),
    0,
  )
  if (aggregateSize > RELEASE_PAYLOAD_LIMITS.escrowBytes) {
    throw new TypeError("Release evidence exceeds the escrow payload limit")
  }
  return deepFreeze({
    role: value.role,
    id: evidenceId(value.id, "Release id"),
    nodeId: nonemptyString(value.nodeId, "Release node id"),
    tagName: nonemptyString(value.tagName, "Release tag name"),
    createdAt: canonicalTimestamp(value.createdAt, "Release creation timestamp"),
    updatedAt: canonicalTimestamp(value.updatedAt, "Release update timestamp"),
    semantic: parseReleaseSemantic(value.semantic),
    assets,
  })
}

export function semanticReleaseProjection(value) {
  const evidence = parseReleaseEvidence(value)
  return deepFreeze(snapshotPlain(evidence.semantic, "Release semantic projection"))
}

export function semanticAssetProjection(value) {
  const asset = parseAssetEvidence(snapshotPlain(value, "Asset evidence"))
  return deepFreeze({
    name: asset.name,
    label: asset.label,
    state: asset.state,
    contentType: asset.contentType,
    size: asset.size,
    digest: asset.digest,
    uploader: asset.uploader,
    downloadSha256: asset.downloadSha256,
  })
}

export function assertEvidenceEqualsProposal(actual, proposed) {
  const normalizedActual = parseReleaseEvidence(actual)
  const normalizedProposed = parseReleaseEvidence(proposed)
  if (
    !isDeepStrictEqual(
      semanticReleaseProjection(normalizedActual),
      semanticReleaseProjection(normalizedProposed),
    )
  ) {
    throw new Error("Direct Release semantic evidence does not equal the proposal")
  }
  const proposedAssets = new Map(
    normalizedProposed.assets.map((asset) => [asset.name, semanticAssetProjection(asset)]),
  )
  if (
    proposedAssets.size !== normalizedActual.assets.length ||
    normalizedActual.assets.some(
      (asset) => !isDeepStrictEqual(semanticAssetProjection(asset), proposedAssets.get(asset.name)),
    )
  ) {
    throw new Error("Direct Release asset evidence does not equal the proposal")
  }
  return normalizedActual
}

function buildDirectEvidence({ release, role, candidate, expectedEvidence }) {
  validateRawReleasePolicy(release, candidate)
  parseCandidateMarker(release.body, candidate, "Direct target Release")
  const expectedByName = new Map(expectedEvidence.assets.map((asset) => [asset.name, asset]))
  const latestByName = new Map()
  for (const rawAsset of release.assets) {
    const descriptor = parseRawAsset(rawAsset)
    const expected = expectedByName.get(descriptor.name)
    if (expected === undefined) {
      throw new Error("Direct target asset list contains an unknown asset")
    }
    if (descriptor.digest !== `sha256:${expected.downloadSha256}`) {
      throw new Error("Direct target asset digest does not match the proven downloaded payload")
    }
    latestByName.set(descriptor.name, {
      ...descriptor,
      downloadSha256: expected.downloadSha256,
    })
  }
  if (
    latestByName.size !== expectedByName.size ||
    [...expectedByName.keys()].some((name) => !latestByName.has(name))
  ) {
    throw new Error("Direct target asset list is incomplete")
  }
  return parseReleaseEvidence({
    role,
    id: canonicalId(release.id, "Direct target Release id"),
    nodeId: nonemptyString(release.node_id, "Direct target Release node id"),
    tagName: nonemptyString(release.tag_name, "Direct target Release tag name"),
    createdAt: githubTimestamp(release.created_at, "Direct target Release creation timestamp"),
    updatedAt: githubTimestamp(release.updated_at, "Direct target Release update timestamp"),
    semantic: {
      name: nonemptyString(release.name, "Direct target Release name"),
      targetCommitish: nonemptyString(
        release.target_commitish,
        "Direct target Release target commitish",
      ),
      draft: release.draft,
      immutable: release.immutable,
      prerelease: release.prerelease,
      publishedAt: release.published_at,
      body: release.body,
      bodySha256: sha256(Buffer.from(release.body, "utf8")),
      author: parseRawIdentity(release.author, "Direct target Release author"),
    },
    assets: expectedEvidence.assets.map(({ name }) => latestByName.get(name)),
  })
}

function snapshotInspectionInput(input) {
  const value = snapshotPlain(input, "duplicate draft evidence input", {
    allowFunctions: true,
  })
  assertExactKeys(
    value,
    [
      "candidate",
      "survivorId",
      "duplicateIds",
      "releases",
      "github",
      "attestations",
      ...(Object.hasOwn(value, "accounting") ? ["accounting"] : []),
    ],
    "duplicate draft evidence input",
  )
  const candidate = parseCandidate(value.candidate)
  const survivorId = canonicalId(value.survivorId, "Survivor Release id")
  if (survivorId !== APPROVED_SURVIVOR_ID) {
    throw new Error("Survivor Release id is not approved")
  }
  if (
    !Array.isArray(value.duplicateIds) ||
    value.duplicateIds.length !== 2 ||
    !value.duplicateIds.every((id, index) => id === APPROVED_DUPLICATE_IDS[index])
  ) {
    throw new Error("Duplicate Release roles are not in approved order")
  }
  if (!Array.isArray(value.releases)) throw new TypeError("Release enumeration is invalid")
  const accounting = normalizeAccounting(value.accounting)
  return {
    candidate,
    survivorId,
    duplicateIds: [...APPROVED_DUPLICATE_IDS],
    releases: value.releases,
    github: bindBoundary(value.github, ["downloadReleaseAsset"], "GitHub asset reader"),
    attestations: bindBoundary(value.attestations, ["verify"], "Attestation verifier"),
    accounting,
  }
}

function normalizeAccounting(value) {
  if (value === undefined) {
    return Object.freeze({ downloadedAssets: 0, downloadedBytes: 0 })
  }
  assertExactKeys(value, ["downloadedAssets", "downloadedBytes"], "duplicate draft accounting")
  const downloadedAssets = nonnegativeInteger(value.downloadedAssets, "Downloaded asset accounting")
  const downloadedBytes = nonnegativeInteger(value.downloadedBytes, "Downloaded byte accounting")
  if (
    downloadedAssets > DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.maximumAssetDownloads ||
    downloadedBytes > AGGREGATE_ESCROW_BYTES
  ) {
    throw new Error("Duplicate draft accounting already exceeds its aggregate limit")
  }
  return Object.freeze({ downloadedAssets, downloadedBytes })
}

function parseCandidate(value) {
  value = snapshotPlain(value, "candidate identity")
  assertExactKeys(value, ["version", "commitSha", "tag"], "candidate identity")
  if (
    value.version !== APPROVED_VERSION ||
    value.commitSha !== APPROVED_COMMIT_SHA ||
    value.tag !== APPROVED_TAG
  ) {
    throw new Error("Candidate identity is not the approved v0.8.22 candidate")
  }
  return deepFreeze(value)
}

function candidateReleases(releases, candidate) {
  const drafts = []
  const published = []
  const releaseIds = new Set()
  for (const [index, source] of releases.entries()) {
    const release = snapshotPlain(source, `GitHub Release ${index}`)
    const id = canonicalId(release.id, `GitHub Release ${index} id`)
    if (releaseIds.has(id)) throw new Error("GitHub Release enumeration contains duplicate IDs")
    releaseIds.add(id)
    let marker = null
    try {
      marker = parseReleaseMarker(release.body)
    } catch {
      marker = null
    }
    const markerMatches =
      marker !== null &&
      marker.version === candidate.version &&
      marker.commitSha === candidate.commitSha &&
      marker.tag === candidate.tag
    const exactTagMatches = release.tag_name === candidate.tag
    if (!markerMatches && !exactTagMatches) {
      if ([APPROVED_SURVIVOR_ID, ...APPROVED_DUPLICATE_IDS].includes(id) && marker === null) {
        throw new Error("Approved managed candidate draft has a malformed Release marker")
      }
      continue
    }
    if (release.draft !== true || release.immutable !== false || release.published_at !== null) {
      published.push(release)
      continue
    }
    if (marker === null) {
      throw new Error("Managed candidate draft has a malformed Release marker")
    }
    drafts.push({ release, marker })
  }
  return { drafts, published }
}

function markerAssetNames(marker) {
  return [
    "release-record.json",
    ...marker.attestationSet.subjects.map(({ subjectName }) => subjectName),
    ...marker.attestationSet.subjects.map(({ bundleName }) => bundleName),
  ]
}

function assetCategory(name) {
  if (name === "release-record.json") {
    return {
      kind: "record",
      label: "Release record",
      maximumBytes: RELEASE_PAYLOAD_LIMITS.releaseRecordBytes,
    }
  }
  if (name === "manifest.json") {
    return {
      kind: "manifest",
      label: "Release manifest",
      maximumBytes: RELEASE_PAYLOAD_LIMITS.manifestBytes,
    }
  }
  if (name.endsWith(".intoto.jsonl")) {
    return {
      kind: "bundle",
      label: "Attestation bundle",
      maximumBytes: RELEASE_PAYLOAD_LIMITS.attestationBundleBytes,
    }
  }
  if (name.endsWith(".tgz")) {
    return {
      kind: "package",
      label: "Release package tarball",
      maximumBytes: RELEASE_PAYLOAD_LIMITS.tarballBytes,
    }
  }
  throw new Error("Release asset is outside the canonical namespace")
}

function preflightDownloads(entries, accounting = { downloadedAssets: 0, downloadedBytes: 0 }) {
  let aggregate = accounting.downloadedBytes
  let downloads = accounting.downloadedAssets
  for (const [releaseIndex, entry] of entries.entries()) {
    const { release, expectedNames } = entry
    if (!Array.isArray(release.assets) || release.assets.length !== 45) {
      throw new Error(`Release ${releaseIndex} must expose exactly 45 assets`)
    }
    if (
      !Array.isArray(expectedNames) ||
      expectedNames.length !== 45 ||
      new Set(expectedNames).size !== 45
    ) {
      throw new Error("Release canonical asset namespace is invalid")
    }
    const expected = new Set(expectedNames)
    let releaseBytes = 0
    let preparedBytes = 0
    let bundleBytes = 0
    const ids = new Set()
    const names = new Set()
    for (const asset of release.assets) {
      const id = canonicalId(asset.id, "Release asset id")
      const name = nonemptyString(asset.name, "Release asset name")
      if (ids.has(id) || names.has(name)) {
        throw new Error("Release asset enumeration contains a duplicate identity")
      }
      ids.add(id)
      names.add(name)
      if (!expected.has(name)) {
        throw new Error("Release asset is outside the canonical namespace")
      }
      const size = nonnegativeInteger(asset.size, "Release asset size")
      const category = assetCategory(name)
      if (size > category.maximumBytes) {
        throw new Error(`${category.label} exceeds its namespace payload limit`)
      }
      if (category.kind === "package") {
        preparedBytes = checkedAdd(preparedBytes, size, "Prepared package payload")
      }
      if (category.kind === "bundle") {
        bundleBytes = checkedAdd(bundleBytes, size, "Attestation bundle payload")
      }
      releaseBytes = checkedAdd(releaseBytes, size, "Release escrow payload")
      downloads += 1
    }
    if (names.size !== expected.size || expectedNames.some((name) => !names.has(name))) {
      throw new Error("Release asset namespace is incomplete")
    }
    if (preparedBytes > RELEASE_PAYLOAD_LIMITS.preparedTarballsBytes) {
      throw new Error("Prepared package payload exceeds its aggregate limit")
    }
    if (bundleBytes > RELEASE_PAYLOAD_LIMITS.attestationBundlesBytes) {
      throw new Error("Attestation bundle payload exceeds its aggregate limit")
    }
    if (releaseBytes > RELEASE_PAYLOAD_LIMITS.escrowBytes) {
      throw new Error("Release asset evidence exceeds the escrow payload limit")
    }
    aggregate = checkedAdd(aggregate, releaseBytes, "Aggregate Release escrow payload")
  }
  if (
    aggregate > AGGREGATE_ESCROW_BYTES ||
    downloads > DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.maximumAssetDownloads
  ) {
    throw new Error("Duplicate draft aggregate payload or download limit was exceeded")
  }
}

async function hydrateRelease({ release, marker, role, candidate, github, attestations, counter }) {
  validateRawReleasePolicy(release, candidate)
  const parsedMarker = marker ?? parseCandidateMarker(release.body, candidate, "Managed Release")
  const expectedNames = markerAssetNames(parsedMarker)
  const observedNames = new Set(release.assets.map(({ name }) => name))
  if (
    release.assets.length !== expectedNames.length ||
    observedNames.size !== expectedNames.length ||
    expectedNames.some((name) => !observedNames.has(name))
  ) {
    throw new Error("Release assets do not match the exact canonical 45-name set")
  }
  const assetsByName = new Map()
  const downloaded = new Map()
  for (const rawAsset of release.assets) {
    const descriptor = parseRawAsset(rawAsset)
    counter.downloads += 1
    if (counter.downloads > DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.maximumAssetDownloads) {
      throw new Error("Release asset download count exceeds 135")
    }
    const envelope = await github.downloadReleaseAsset({
      releaseId: canonicalId(release.id, "Release id"),
      assetId: descriptor.id,
      maximumBytes: descriptor.size,
    })
    const bytes = exactDownloadBytes(envelope, descriptor.size)
    if (bytes.byteLength !== descriptor.size) {
      throw new Error("Downloaded asset bytes conflict with declared size")
    }
    counter.bytes = checkedAdd(counter.bytes, bytes.byteLength, "Downloaded Release payload")
    if (counter.bytes > AGGREGATE_ESCROW_BYTES) {
      throw new Error("Downloaded Release payload exceeds 192 MiB")
    }
    const downloadSha256 = sha256(bytes)
    if (descriptor.digest !== `sha256:${downloadSha256}`) {
      throw new Error("GitHub asset digest does not match downloaded bytes")
    }
    downloaded.set(descriptor.name, bytes)
    assetsByName.set(descriptor.name, { ...descriptor, downloadSha256 })
  }

  const recordBytes = downloaded.get("release-record.json")
  const record = parseReleaseRecord(recordBytes)
  if (!Buffer.from(recordBytes).equals(canonicalReleaseRecordBytes(record))) {
    throw new Error("Release record bytes are not canonical")
  }
  if (record.version !== candidate.version || record.commitSha !== candidate.commitSha) {
    throw new Error("Release record does not bind the approved candidate")
  }
  if (parsedMarker.releaseRecordSha256 !== releaseRecordSha256(record)) {
    throw new Error("Release marker record digest does not bind the canonical release record")
  }
  const manifestBytes = downloaded.get("manifest.json")
  const manifest = parseSealedReleaseManifest(manifestBytes, { candidate })
  if (!Buffer.from(manifestBytes).equals(canonicalManifestBytes(manifest))) {
    throw new Error("Sealed Release manifest bytes are not canonical")
  }
  const productionCandidate = {
    version: candidate.version,
    commitSha: candidate.commitSha,
  }
  const attestationSet = parseAttestationSet(parsedMarker.attestationSet, {
    candidate: productionCandidate,
    manifest,
    repository: "cacheplane/dawnai",
  })
  const subjectFiles = attestationSet.subjects.map(({ subjectName }) => ({
    name: subjectName,
    bytes: Buffer.from(downloaded.get(subjectName)),
  }))
  const bundles = attestationSet.subjects.map(({ bundleName }) => ({
    name: bundleName,
    bytes: Buffer.from(downloaded.get(bundleName)),
  }))
  const artifact = { manifest, files: subjectFiles }
  const base = canonicalBaseAssetSet({
    record,
    artifact,
    attestationSet,
    bundles,
  })
  if (base.sha256 !== parsedMarker.baseAssetSetSha256) {
    throw new Error("Canonical base asset set digest does not match the Release marker")
  }
  const anchored = await verifyReleaseAttestationAnchor({
    candidate: productionCandidate,
    record,
    artifact,
    bundleBytes: bundles[0].bytes,
    attestations,
  })
  if (
    anchored.baseAssetSetSha256 !== base.sha256 ||
    !isDeepStrictEqual(anchored.attestationSet, attestationSet)
  ) {
    throw new Error("Verified attestation anchor does not match the canonical escrow")
  }
  if (release.body !== canonicalReleaseBody({ marker: parsedMarker, manifest })) {
    throw new Error("Managed Release body bytes are not canonical")
  }
  const assets = base.assets.map(({ name }) => assetsByName.get(name))
  if (assets.some((asset) => asset === undefined)) {
    throw new Error("Canonical base asset evidence is incomplete")
  }
  const semantic = {
    name: nonemptyString(release.name, "Release name"),
    targetCommitish: nonemptyString(release.target_commitish, "Release target commitish"),
    draft: release.draft,
    immutable: release.immutable,
    prerelease: release.prerelease,
    publishedAt: release.published_at,
    body: release.body,
    bodySha256: sha256(Buffer.from(release.body, "utf8")),
    author: parseRawIdentity(release.author, "Release author"),
  }
  const evidence = parseReleaseEvidence({
    role,
    id: canonicalId(release.id, "Release id"),
    nodeId: nonemptyString(release.node_id, "Release node id"),
    tagName: nonemptyString(release.tag_name, "Release tag name"),
    createdAt: githubTimestamp(release.created_at, "Release creation timestamp"),
    updatedAt: githubTimestamp(release.updated_at, "Release update timestamp"),
    semantic,
    assets,
  })
  return {
    evidence,
    baseAssetSet: base.assets.map(({ name, sha256: digest }) => ({
      name,
      sha256: digest,
    })),
    baseAssetSetSha256: base.sha256,
    verifiedSubjects: attestationSet.subjects.map(({ subjectName, subjectSha256 }) => ({
      name: subjectName,
      sha256: subjectSha256,
    })),
  }
}

function parseCandidateMarker(body, candidate, label) {
  let marker
  try {
    marker = parseReleaseMarker(body)
  } catch (error) {
    throw new Error(`${label} has a malformed or noncanonical marker`, {
      cause: error,
    })
  }
  if (
    marker.phase !== "ESCROWED" ||
    marker.revision !== 2 ||
    marker.version !== candidate.version ||
    marker.commitSha !== candidate.commitSha ||
    marker.tag !== candidate.tag
  ) {
    throw new Error(`${label} marker does not bind the approved ESCROWED candidate`)
  }
  return marker
}

function validateRawReleasePolicy(release, candidate) {
  if (
    release.name !== `Dawn v${candidate.version}` ||
    release.target_commitish !== "main" ||
    release.draft !== true ||
    release.immutable !== false ||
    release.prerelease !== false ||
    release.published_at !== null
  ) {
    throw new Error("Managed candidate Release is not the expected mutable draft")
  }
  const author = parseRawIdentity(release.author, "Release author")
  if (!isDeepStrictEqual(author, APPROVED_AUTHOR)) {
    throw new Error("Managed candidate Release author is not approved")
  }
}

function parseRawAsset(value) {
  value = snapshotPlain(value, "GitHub Release asset")
  const required = [
    "id",
    "node_id",
    "name",
    "label",
    "state",
    "content_type",
    "size",
    "digest",
    "uploader",
    "created_at",
    "updated_at",
    "download_count",
  ]
  for (const field of required) {
    if (!Object.hasOwn(value, field))
      throw new TypeError(`GitHub Release asset is missing ${field}`)
  }
  if (value.state !== "uploaded") throw new Error("Release asset state is not uploaded")
  const digest = nonemptyString(value.digest, "Asset service digest")
  if (!DIGEST_PATTERN.test(digest)) throw new TypeError("Asset service digest is malformed")
  return {
    id: canonicalId(value.id, "Asset id"),
    nodeId: nonemptyString(value.node_id, "Asset node id"),
    name: nonemptyString(value.name, "Asset name"),
    label: value.label === null ? null : stringValue(value.label, "Asset label"),
    state: value.state,
    contentType: nonemptyString(value.content_type, "Asset content type"),
    size: nonnegativeInteger(value.size, "Asset size"),
    digest,
    uploader: parseRawIdentity(value.uploader, "Asset uploader"),
    createdAt: githubTimestamp(value.created_at, "Asset creation timestamp"),
    updatedAt: githubTimestamp(value.updated_at, "Asset update timestamp"),
    downloadCount: nonnegativeInteger(value.download_count, "Asset download count"),
  }
}

function parseRawIdentity(value, label) {
  value = snapshotPlain(value, label)
  for (const field of ["login", "id", "node_id"]) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${label} is missing ${field}`)
  }
  return {
    login: nonemptyString(value.login, `${label} login`),
    id: canonicalId(value.id, `${label} id`),
    nodeId: nonemptyString(value.node_id, `${label} node id`),
  }
}

function parseReleaseSemantic(value) {
  value = snapshotPlain(value, "Release semantic evidence")
  assertExactKeys(value, RELEASE_SEMANTIC_FIELDS, "Release semantic evidence")
  if (
    value.draft !== true ||
    value.immutable !== false ||
    value.prerelease !== false ||
    value.publishedAt !== null
  ) {
    throw new TypeError("Release semantic evidence is not a mutable draft")
  }
  const body = stringValue(value.body, "Release body")
  const bodySha256 = sha256Value(value.bodySha256, "Release body digest")
  if (sha256(Buffer.from(body, "utf8")) !== bodySha256) {
    throw new TypeError("Release body digest does not match its canonical bytes")
  }
  return {
    name: nonemptyString(value.name, "Release name"),
    targetCommitish: exactString(value.targetCommitish, "main", "Release target commitish"),
    draft: true,
    immutable: false,
    prerelease: false,
    publishedAt: null,
    body,
    bodySha256,
    author: parseServiceIdentity(value.author, "Release author"),
  }
}

function parseAssetEvidence(value) {
  value = snapshotPlain(value, "Asset evidence")
  assertExactKeys(value, ASSET_EVIDENCE_FIELDS, "Asset evidence")
  const digest = nonemptyString(value.digest, "Asset service digest")
  const match = DIGEST_PATTERN.exec(digest)
  if (match === null) throw new TypeError("Asset service digest is malformed")
  const downloadSha256 = sha256Value(value.downloadSha256, "Downloaded asset digest")
  if (match[1] !== downloadSha256) {
    throw new TypeError("Asset service digest and downloaded digest differ")
  }
  if (value.state !== "uploaded") throw new TypeError("Asset evidence state is not uploaded")
  const size = nonnegativeInteger(value.size, "Asset size")
  if (size > RELEASE_PAYLOAD_LIMITS.tarballBytes)
    throw new TypeError("Asset size exceeds its limit")
  return {
    id: evidenceId(value.id, "Asset id"),
    nodeId: nonemptyString(value.nodeId, "Asset node id"),
    name: nonemptyString(value.name, "Asset name"),
    label: value.label === null ? null : stringValue(value.label, "Asset label"),
    state: "uploaded",
    contentType: nonemptyString(value.contentType, "Asset content type"),
    size,
    digest,
    uploader: parseServiceIdentity(value.uploader, "Asset uploader"),
    createdAt: canonicalTimestamp(value.createdAt, "Asset creation timestamp"),
    updatedAt: canonicalTimestamp(value.updatedAt, "Asset update timestamp"),
    downloadCount: nonnegativeInteger(value.downloadCount, "Asset download count"),
    downloadSha256,
  }
}

function parseServiceIdentity(value, label) {
  value = snapshotPlain(value, label)
  assertExactKeys(value, SERVICE_IDENTITY_FIELDS, label)
  return {
    login: nonemptyString(value.login, `${label} login`),
    id: evidenceId(value.id, `${label} id`),
    nodeId: nonemptyString(value.nodeId, `${label} node id`),
  }
}

function assertThreeWayParity(releases) {
  const releaseProjection = semanticReleaseProjection(releases[0])
  const assetProjection = releases[0].assets.map(semanticAssetProjection)
  for (const release of releases.slice(1)) {
    if (
      !isDeepStrictEqual(semanticReleaseProjection(release), releaseProjection) ||
      !isDeepStrictEqual(release.assets.map(semanticAssetProjection), assetProjection)
    ) {
      throw new Error("Managed candidate Release or asset semantic parity failed")
    }
  }
}

function exactPresentValue(envelope, operation) {
  const value = snapshotPlain(envelope, `GitHub ${operation} observation`)
  assertExactKeys(
    value,
    ["status", "operation", "httpStatus", "code", "value"],
    `GitHub ${operation} observation`,
  )
  if (
    value.status !== "PRESENT" ||
    value.operation !== operation ||
    value.httpStatus !== 200 ||
    value.code !== null
  ) {
    throw new Error(`GitHub ${operation} observation is not exact`)
  }
  return value.value
}

function exactDownloadBytes(envelope, maximumBytes) {
  const value = snapshotPlain(envelope, "GitHub asset download observation")
  assertExactKeys(
    value,
    ["status", "operation", "httpStatus", "code", "contentBase64"],
    "GitHub asset download observation",
  )
  if (
    value.status !== "PRESENT" ||
    value.operation !== "release-asset-download" ||
    value.httpStatus !== 200 ||
    value.code !== null ||
    typeof value.contentBase64 !== "string"
  ) {
    throw new Error("GitHub asset download observation is not exact")
  }
  const maximumBase64Characters = Math.ceil(maximumBytes / 3) * 4
  if (value.contentBase64.length > maximumBase64Characters) {
    throw new Error("GitHub asset download base64 exceeds its declared-size bound")
  }
  const bytes = Buffer.from(value.contentBase64, "base64")
  if (bytes.toString("base64") !== value.contentBase64) {
    throw new Error("GitHub asset download base64 is noncanonical")
  }
  return bytes
}

function bindBoundary(value, methods, label) {
  if (!isPlainObject(value) || utilTypes.isProxy(value)) throw new TypeError(`${label} is invalid`)
  const bound = {}
  for (const method of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(value, method)
    if (!isEnumerableData(descriptor) || typeof descriptor.value !== "function") {
      throw new TypeError(`${label} method ${method} is invalid`)
    }
    bound[method] = descriptor.value.bind(value)
  }
  return Object.freeze(bound)
}

function snapshotPlain(value, label, { allowFunctions = false } = {}) {
  return snapshotValue(value, label, new Set(), allowFunctions)
}

function snapshotValue(value, label, ancestors, allowFunctions) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value
  if (typeof value === "function" && allowFunctions) return value
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new TypeError(`${label} must be plain data`)
  }
  if (ancestors.has(value)) throw new TypeError(`${label} contains a cycle`)
  const next = new Set(ancestors)
  next.add(value)
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value)
    const expected = Array.from({ length: value.length }, (_, index) => String(index))
    if (
      keys.length !== expected.length + 1 ||
      keys.at(-1) !== "length" ||
      expected.some((key, index) => keys[index] !== key)
    ) {
      throw new TypeError(`${label} must be a dense plain array`)
    }
    return expected.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!isEnumerableData(descriptor)) throw new TypeError(`${label} contains an accessor`)
      return snapshotValue(descriptor.value, label, next, allowFunctions)
    })
  }
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`)
  const result = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${label} contains a symbol field`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!isEnumerableData(descriptor))
      throw new TypeError(`${label} contains an accessor or hidden field`)
    result[key] = snapshotValue(descriptor.value, `${label}.${key}`, next, allowFunctions)
  }
  return result
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isEnumerableData(descriptor) {
  return (
    descriptor?.enumerable === true &&
    "value" in descriptor &&
    descriptor.get === undefined &&
    descriptor.set === undefined
  )
}

function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value) || !isDeepStrictEqual(Object.keys(value), expected)) {
    throw new TypeError(`${label} has an invalid exact field schema`)
  }
}

function canonicalId(value, label) {
  const normalized = Number.isSafeInteger(value) && value > 0 ? String(value) : value
  if (typeof normalized !== "string" || !ID_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a positive decimal identity`)
  }
  return normalized
}

function evidenceId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical positive decimal string`)
  }
  return value
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} is invalid`)
  return value
}

function checkedAdd(left, right, label) {
  const result = left + right
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error(`${label} exceeds safe accounting`)
  return result
}

function nonemptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} is invalid`)
  return value
}

function stringValue(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`)
  return value
}

function sha256Value(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value))
    throw new TypeError(`${label} is invalid`)
  return value
}

function exactString(value, expected, label) {
  if (value !== expected) throw new TypeError(`${label} must be ${expected}`)
  return value
}

function canonicalTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !TIMESTAMP_PATTERN.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${label} is not a canonical timestamp`)
  }
  return value
}

function githubTimestamp(value, label) {
  if (typeof value !== "string" || !GITHUB_TIMESTAMP_PATTERN.test(value)) {
    throw new TypeError(`${label} is not an exact GitHub timestamp`)
  }
  const normalized = value.endsWith(".000Z")
    ? value
    : value.includes(".")
      ? value
      : `${value.slice(0, -1)}.000Z`
  try {
    if (new Date(normalized).toISOString() !== normalized) {
      throw new TypeError(`${label} has an invalid GitHub calendar value`)
    }
  } catch {
    throw new TypeError(`${label} has an invalid GitHub calendar value`)
  }
  return normalized
}

function assertMonotone(left, right, label) {
  if (right < left) throw new Error(`${label} timestamps are not monotone`)
}

function canonicalSha256(value) {
  return sha256(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"))
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
