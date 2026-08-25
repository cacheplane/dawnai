import { createHash } from "node:crypto"

import { snapshotJson } from "./adapter-normalize.mjs"
import { assertPayloadByteLength, RELEASE_PAYLOAD_LIMITS } from "./limits.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "./manifest.mjs"
import {
  abandonmentReleaseMarker,
  canonicalReleaseBody,
  parseReleaseMarker,
  releaseBodySha256,
} from "./metadata.mjs"
import { compareSemver, isExactSemver, parseSemver } from "./semver.mjs"
import { parseAbandonmentRecord } from "./terminal-records.mjs"

const EXPECTED_ENVIRONMENT = "release-abandonment"
const CANDIDATE_FIELDS = Object.freeze([
  "version",
  "commitSha",
  "ciWorkflow",
  "ciCheck",
  "publisherWorkflow",
])
const INPUT_FIELDS = Object.freeze([
  "candidate",
  "reason",
  "actionsHistory",
  "observations",
  "approval",
  "artifactContext",
])
const APPROVAL_INPUT_FIELDS = Object.freeze([
  "environment",
  "environmentId",
  "reviewerId",
  "reviewer",
  "state",
  "observedAt",
  "workflowRunId",
  "runAttempt",
  "actor",
  "actorId",
  "recordedAt",
])
const ARTIFACT_CONTEXT_FIELDS = Object.freeze([
  "predecessor",
  "tag",
  "newerReleaseInterleaved",
  "artifact",
  "release",
])
const TAG_FIELDS = Object.freeze(["status", "annotated", "tag", "commitSha"])
const ARTIFACT_FIELDS = Object.freeze([
  "manifestSha256",
  "releaseRecordSha256",
  "baseAssetSetSha256",
  "attestationSet",
])
const RELEASE_FIELDS = Object.freeze(["status", "releaseId", "bodySha256", "marker", "assets"])
const ASSET_FIELDS = Object.freeze(["id", "name", "sha256"])
const PREDECESSORS = Object.freeze(["CANDIDATE_TAGGED", "ARTIFACTS_PREPARED", "CANDIDATE_ESCROWED"])
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const BASE_ASSET_NAME_PATTERN =
  /^(?:release-record\.json|manifest\.json|[A-Za-z0-9@._+-]+\.tgz(?:\.intoto\.jsonl)?|manifest\.json\.intoto\.jsonl)$/u
const TERMINAL_ASSET_NAME = "abandonment.json"
const ABANDONMENT_RECORD_START = "<!-- DAWN_ABANDONMENT_RECORD_BASE64\n"
const ABANDONMENT_RECORD_END = "\nEND_DAWN_ABANDONMENT_RECORD_BASE64 -->"
const MAX_RELEASES = 10_000
const MIN_REGISTRY_OBSERVATION_GAP_MS = 60_000
const MAX_FRESH_AUTHORIZATION_AGE_MS = 10 * 60_000
const MAX_FRESH_RECORD_AGE_MS = 60_000
const MAX_FRESH_SECOND_OBSERVATION_AGE_MS = 2 * 60_000
const MAX_CLOCK_SKEW_MS = 5_000
const CANONICAL_PACKAGE_NAMES = Object.freeze(
  [...CANONICAL_RELEASE_PACKAGE_ORDER].sort(compareText),
)

export async function evaluateAbandonment(input) {
  const source = snapshotJson(input)
  assertExactFields(source, INPUT_FIELDS, "abandonment evaluation")
  const candidate = validateCandidate(source.candidate)
  const approval = validateApprovalInput(source.approval)
  const artifactContext = validateArtifactContext(source.artifactContext, candidate)
  if (artifactContext.newerReleaseInterleaved !== false) {
    throw new Error("A newer Release interleaved before abandonment")
  }
  const tombstone = buildAbandonmentRecord({
    candidate,
    reason: source.reason,
    actionsHistory: source.actionsHistory,
    observations: source.observations,
    approval,
    artifactContext,
  })
  validateTerminalContext(artifactContext, sha256(canonicalAbandonmentBytes(tombstone)))
  return tombstone
}

export function canonicalAbandonmentBytes(value) {
  const source = snapshotJson(value)
  const record = parseAbandonmentRecord(source, {
    candidate: { version: source.version, commitSha: source.commitSha },
    environment: EXPECTED_ENVIRONMENT,
    packageNames: CANONICAL_PACKAGE_NAMES,
  })
  const bytes = Buffer.from(`${JSON.stringify(canonicalize(record), null, 2)}\n`, "utf8")
  assertPayloadByteLength(
    bytes.byteLength,
    RELEASE_PAYLOAD_LIMITS.auditReceiptBytes,
    "Canonical abandonment record",
  )
  return bytes
}

export function canonicalAbandonmentReleaseBody(input) {
  const source = snapshotJson(input)
  const keys = isRecord(source) ? Object.keys(source) : []
  if (
    !isRecord(source) ||
    !["marker", "tombstone"].every((field) => keys.includes(field)) ||
    keys.some((field) => !["marker", "tombstone", "previousMarker"].includes(field))
  ) {
    throw new TypeError("Canonical abandonment Release body input is invalid")
  }
  const tombstoneBytes = canonicalAbandonmentBytes(source.tombstone)
  const record = parseCanonicalAbandonmentBytes(tombstoneBytes)
  const predecessorMarker = record.predecessor.marker
  if (canonicalText(source.previousMarker ?? null) !== canonicalText(predecessorMarker)) {
    throw new TypeError("Abandonment Release body predecessor evidence is not exact")
  }
  const body = canonicalReleaseBody({
    marker: source.marker,
    manifest: null,
    ...(predecessorMarker === null ? {} : { previousMarker: predecessorMarker }),
  })
  const releaseMarker = parseReleaseMarker(body)
  if (
    releaseMarker.phase !== "ABANDONED_PREPUBLICATION" ||
    record.version !== releaseMarker.version ||
    record.commitSha !== releaseMarker.commitSha ||
    record.tag !== releaseMarker.tag ||
    sha256(tombstoneBytes) !== releaseMarker.abandonmentSha256
  ) {
    throw new TypeError("Abandonment Release body evidence does not match its marker")
  }
  const result = `${body}${ABANDONMENT_RECORD_START}${tombstoneBytes.toString("base64")}${ABANDONMENT_RECORD_END}\n`
  assertPayloadByteLength(
    Buffer.byteLength(result, "utf8"),
    1024 * 1024,
    "Abandonment Release body",
  )
  return result
}

export function parseAbandonmentReleaseBody(body) {
  if (typeof body !== "string") throw new TypeError("Abandonment Release body is invalid")
  assertPayloadByteLength(Buffer.byteLength(body, "utf8"), 1024 * 1024, "Abandonment Release body")
  const marker = parseReleaseMarker(body)
  const start = body.indexOf(ABANDONMENT_RECORD_START)
  const end = body.indexOf(ABANDONMENT_RECORD_END)
  if (
    marker.phase !== "ABANDONED_PREPUBLICATION" ||
    start < 0 ||
    end <= start ||
    body.lastIndexOf(ABANDONMENT_RECORD_START) !== start ||
    body.lastIndexOf(ABANDONMENT_RECORD_END) !== end ||
    end + ABANDONMENT_RECORD_END.length + 1 !== body.length ||
    body.at(-1) !== "\n"
  ) {
    throw new TypeError("Abandonment Release body has no unique canonical embedded record")
  }
  const encodedStart = start + ABANDONMENT_RECORD_START.length
  const encoded = body.slice(encodedStart, end)
  assertPayloadByteLength(
    Buffer.byteLength(encoded, "utf8"),
    Math.ceil(RELEASE_PAYLOAD_LIMITS.auditReceiptBytes / 3) * 4,
    "Embedded abandonment record base64",
  )
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.toString("base64") !== encoded) {
    throw new TypeError("Embedded abandonment record base64 is not canonical")
  }
  assertPayloadByteLength(
    bytes.byteLength,
    RELEASE_PAYLOAD_LIMITS.auditReceiptBytes,
    "Embedded abandonment record",
  )
  const record = parseCanonicalAbandonmentBytes(bytes)
  const previousMarker = record.predecessor.marker
  const expected = canonicalAbandonmentReleaseBody({
    marker,
    tombstone: record,
    ...(previousMarker === null ? {} : { previousMarker }),
  })
  if (body !== expected) throw new TypeError("Abandonment Release body is not canonical")
  return record
}

export async function recordAbandonment(input) {
  const boundary = snapshotRecordInput(input)
  const candidate = validateCandidate(boundary.candidate)
  const reason = validateReason(boundary.reason)
  const context = validateArtifactContext(boundary.artifactContext, candidate)
  if (context.newerReleaseInterleaved !== false) {
    throw new Error("A newer Release interleaved before abandonment")
  }

  await verifyAnnotatedTag(boundary.github.reader, candidate)
  const releases = await readGitHubValue(boundary.github.reader.listReleases({}), "releases")
  const observedRelease = await reconcileReleaseList({
    releases,
    context,
    candidate,
    reader: boundary.github.reader,
  })
  if (observedRelease !== null) {
    await verifyReleaseAndAssets({
      release: observedRelease,
      context,
      candidate,
      reader: boundary.github.reader,
    })
  }
  await verifyAnnotatedTag(boundary.github.reader, candidate)

  const recoveredTombstone = await recoverDurableTombstone({
    release: observedRelease,
    context,
    candidate,
    reader: boundary.github.reader,
  })
  if (recoveredTombstone !== null && recoveredTombstone.reason !== reason) {
    throw new Error("Existing abandonment reason conflicts with the requested recovery")
  }
  const initiallyTerminal = context.release.marker?.phase === "ABANDONED_PREPUBLICATION"
  const initialTombstonePresent = context.release.assets.some(
    (asset) => asset.name === TERMINAL_ASSET_NAME,
  )
  const terminalEvidenceComplete = initiallyTerminal && initialTombstonePresent
  const mutationRequired = !terminalEvidenceComplete
  const finalAuthorization = mutationRequired
    ? await authorizeFreshMutation(
        boundary.authorization,
        candidate,
        reason,
        context,
        recoveredTombstone?.predecessor ?? null,
      )
    : null
  const tombstone = recoveredTombstone ?? finalAuthorization
  if (tombstone === null) throw new Error("Abandonment has no canonical durable evidence")
  const tombstoneBytes = canonicalAbandonmentBytes(tombstone)
  const tombstoneSha256 = sha256(tombstoneBytes)
  validateTerminalContext(context, tombstoneSha256)

  const terminalMarker =
    context.release.marker?.phase === "ABANDONED_PREPUBLICATION"
      ? context.release.marker
      : abandonmentReleaseMarker({
          candidate,
          artifact: context.artifact,
          abandonmentSha256: tombstoneSha256,
          previousMarker: context.release.marker,
        })
  const terminalBody = canonicalAbandonmentReleaseBody({
    marker: terminalMarker,
    tombstone,
    ...(tombstone.predecessor.marker === null
      ? {}
      : { previousMarker: tombstone.predecessor.marker }),
  })
  const title = `Dawn v${candidate.version} (abandoned before publication)`

  let release = observedRelease
  let created = false
  let createReturnedExisting = false
  if (initiallyTerminal) {
    if (
      release === null ||
      canonicalText(parseReleaseMarker(release.body)) !== canonicalText(terminalMarker) ||
      release.body !== terminalBody ||
      release.name !== title
    ) {
      throw new Error("Existing terminal abandonment Release metadata is not exact")
    }
  }

  if (mutationRequired) {
    await reobserveReleaseBoundary(boundary.github.reader, candidate, context.release)
    if (release === null) {
      const receipt = validateCreateReceipt(
        await boundary.github.writer.createDraftRelease({
          tag: `v${candidate.version}`,
          targetSha: candidate.commitSha,
          title,
          body: terminalBody,
        }),
        terminalBody,
      )
      release = await readManagedRelease(
        boundary.github.reader,
        positiveId(receipt.releaseId, "created Release ID"),
      )
      created = receipt.status === "created"
      createReturnedExisting = receipt.status === "existing"
    } else if (initiallyTerminal) {
      await boundary.github.writer.uploadAssetIfAbsentAndEqual({
        releaseId: release.id,
        tag: `v${candidate.version}`,
        targetSha: candidate.commitSha,
        name: TERMINAL_ASSET_NAME,
        bytes: tombstoneBytes,
        sha256: tombstoneSha256,
      })
    } else {
      await boundary.github.writer.updateDraftReleaseIfCurrent({
        releaseId: release.id,
        tag: `v${candidate.version}`,
        targetSha: candidate.commitSha,
        expectedBodySha256: releaseBodySha256(release.body),
        title,
        body: terminalBody,
      })
    }
  }

  if (release === null) throw new Error("Abandonment Release was not established")
  release = await readManagedRelease(boundary.github.reader, release.id)
  assertDraftRelease(release, candidate)
  const currentMarker = parseReleaseMarker(release.body)
  if (canonicalText(currentMarker) !== canonicalText(terminalMarker)) {
    throw new Error("Existing terminal abandonment marker conflicts with exact evidence")
  }
  if (release.body !== terminalBody || release.name !== title) {
    throw new Error("Existing terminal abandonment Release metadata is not exact")
  }

  const currentAssets = await readAssetInventory(boundary.github.reader, release.id)
  assertCurrentAssetInventory(currentAssets, context.release.assets)
  const abandonmentAssets = currentAssets.filter((asset) => asset.name === TERMINAL_ASSET_NAME)
  if (abandonmentAssets.length > 1) throw new Error("Duplicate abandonment assets are ambiguous")
  if (abandonmentAssets.length === 1) {
    await assertRemoteAsset(
      boundary.github.reader,
      abandonmentAssets[0],
      tombstoneSha256,
      RELEASE_PAYLOAD_LIMITS.auditReceiptBytes,
    )
  }

  if (abandonmentAssets.length === 0 && createReturnedExisting) {
    await authorizeFreshMutation(boundary.authorization, candidate, reason, context)
    await reobserveReleaseBoundary(boundary.github.reader, candidate, {
      status: "draft",
      releaseId: release.id,
      bodySha256: releaseBodySha256(release.body),
    })
  }
  if (abandonmentAssets.length === 0) {
    await boundary.github.writer.uploadAssetIfAbsentAndEqual({
      releaseId: release.id,
      tag: `v${candidate.version}`,
      targetSha: candidate.commitSha,
      name: TERMINAL_ASSET_NAME,
      bytes: tombstoneBytes,
      sha256: tombstoneSha256,
    })
  }

  const finalRelease = await readManagedRelease(boundary.github.reader, release.id)
  assertDraftRelease(finalRelease, candidate)
  if (finalRelease.name !== title || finalRelease.body !== terminalBody) {
    throw new Error("Abandonment Release did not retain exact terminal metadata")
  }
  const finalAssets = await readAssetInventory(boundary.github.reader, release.id)
  assertCurrentAssetInventory(finalAssets, context.release.assets, { requireTombstone: true })
  const finalTombstones = finalAssets.filter((asset) => asset.name === TERMINAL_ASSET_NAME)
  if (finalTombstones.length !== 1) throw new Error("Abandonment Release has no unique tombstone")
  await assertRemoteAsset(
    boundary.github.reader,
    finalTombstones[0],
    tombstoneSha256,
    RELEASE_PAYLOAD_LIMITS.auditReceiptBytes,
  )
  await verifyAnnotatedTag(boundary.github.reader, candidate)
  return deepFreeze({
    releaseId: release.id,
    phase: "ABANDONED_PREPUBLICATION",
    status: terminalEvidenceComplete ? "unchanged" : "recorded",
    assetCount: finalAssets.length,
    bodySha256: releaseBodySha256(finalRelease.body),
    created,
  })
}

function snapshotRecordInput(input) {
  if (!isPlainDataObject(input)) throw new TypeError("Abandonment recording input is invalid")
  assertOwnDataFields(
    input,
    ["candidate", "reason", "artifactContext", "authorization", "github"],
    "recording",
  )
  const authorizationValue = dataField(input, "authorization")
  const githubValue = dataField(input, "github")
  if (!isPlainDataObject(githubValue)) throw new TypeError("GitHub effect boundary is invalid")
  assertOwnDataFields(githubValue, ["reader", "writer"], "GitHub effect boundary")
  return {
    candidate: snapshotJson(dataField(input, "candidate")),
    reason: dataField(input, "reason"),
    artifactContext: snapshotJson(dataField(input, "artifactContext")),
    authorization: bindMethods(
      authorizationValue,
      ["readFreshAbandonmentEvidence"],
      "Abandonment authorization reader",
    ),
    github: {
      reader: bindMethods(
        dataField(githubValue, "reader"),
        [
          "getRef",
          "getGitTag",
          "listReleases",
          "getRelease",
          "listReleaseAssets",
          "downloadReleaseAsset",
        ],
        "GitHub reader",
      ),
      writer: bindMethods(
        dataField(githubValue, "writer"),
        [
          "createDraftRelease",
          "updateDraftReleaseIfCurrent",
          "uploadAssetIfAbsentAndEqual",
          "publishReleaseIfCurrent",
          "dispatchWorkflowAtRef",
        ],
        "GitHub writer",
      ),
    },
  }
}

function validateArtifactContext(value, candidate) {
  const context = snapshotJson(value)
  assertExactFields(context, ARTIFACT_CONTEXT_FIELDS, "abandonment artifact context")
  if (!PREDECESSORS.includes(context.predecessor)) {
    throw new TypeError("Abandonment predecessor is invalid")
  }
  assertExactFields(context.tag, TAG_FIELDS, "abandonment tag context")
  if (
    context.tag.status !== "present" ||
    context.tag.annotated !== true ||
    context.tag.tag !== `v${candidate.version}` ||
    context.tag.commitSha !== candidate.commitSha ||
    typeof context.newerReleaseInterleaved !== "boolean"
  ) {
    throw new TypeError("Abandonment tag or newer-release context is invalid")
  }
  assertExactFields(context.artifact, ARTIFACT_FIELDS, "abandonment artifact evidence")
  assertArtifactShape(context.predecessor, context.artifact, candidate)
  assertExactFields(context.release, RELEASE_FIELDS, "abandonment Release context")
  if (!Array.isArray(context.release.assets) || context.release.assets.length > 46) {
    throw new TypeError("Abandonment Release asset context is invalid")
  }
  const assets = context.release.assets.map((asset, index) => {
    assertExactFields(asset, ASSET_FIELDS, `abandonment Release asset ${index}`)
    if (
      !isPositiveInteger(asset.id) ||
      typeof asset.name !== "string" ||
      !SHA256_PATTERN.test(asset.sha256)
    ) {
      throw new TypeError("Abandonment Release asset identity is invalid")
    }
    return asset
  })
  if (
    new Set(assets.map(({ id }) => id)).size !== assets.length ||
    new Set(assets.map(({ name }) => name)).size !== assets.length
  ) {
    throw new TypeError("Abandonment Release asset identities are duplicate")
  }
  if (context.release.status === "absent") {
    if (
      context.release.releaseId !== null ||
      context.release.bodySha256 !== null ||
      context.release.marker !== null ||
      assets.length !== 0 ||
      context.predecessor === "CANDIDATE_ESCROWED"
    ) {
      throw new TypeError("Absent abandonment Release context is inconsistent")
    }
  } else if (context.release.status === "draft") {
    if (
      !isPositiveInteger(context.release.releaseId) ||
      !SHA256_PATTERN.test(context.release.bodySha256) ||
      context.release.marker === null
    ) {
      throw new TypeError("Draft abandonment Release context is invalid")
    }
    const marker = parseReleaseMarker(
      canonicalReleaseBody({ marker: context.release.marker, manifest: null }),
    )
    if (
      marker.version !== candidate.version ||
      marker.commitSha !== candidate.commitSha ||
      marker.tag !== `v${candidate.version}` ||
      canonicalText(markerArtifact(marker)) !== canonicalText(context.artifact)
    ) {
      throw new TypeError("Draft abandonment marker conflicts with artifact context")
    }
    const permittedPhases =
      context.predecessor === "CANDIDATE_ESCROWED"
        ? ["ESCROWED", "ABANDONED_PREPUBLICATION"]
        : ["ABANDONED_PREPUBLICATION"]
    if (!permittedPhases.includes(marker.phase)) {
      throw new TypeError("Draft abandonment marker does not match its predecessor")
    }
  } else {
    throw new TypeError("Abandonment Release status is invalid")
  }
  validateRetainedAssets(context)
  return deepFreeze(context)
}

function assertArtifactShape(predecessor, artifact, candidate) {
  const values = [
    artifact.manifestSha256,
    artifact.releaseRecordSha256,
    artifact.baseAssetSetSha256,
    artifact.attestationSet,
  ]
  const tagged = values.every((value) => value === null)
  const prepared =
    SHA256_PATTERN.test(artifact.manifestSha256) &&
    SHA256_PATTERN.test(artifact.releaseRecordSha256) &&
    artifact.baseAssetSetSha256 === null &&
    artifact.attestationSet === null
  const attested =
    SHA256_PATTERN.test(artifact.manifestSha256) &&
    SHA256_PATTERN.test(artifact.releaseRecordSha256) &&
    SHA256_PATTERN.test(artifact.baseAssetSetSha256) &&
    artifact.attestationSet !== null
  const expected =
    predecessor === "CANDIDATE_TAGGED"
      ? tagged
      : predecessor === "ARTIFACTS_PREPARED"
        ? prepared
        : attested
  if (!expected) throw new TypeError("Abandonment predecessor artifact context is impossible")
  if (attested) {
    abandonmentReleaseMarker({
      candidate,
      artifact,
      abandonmentSha256: "0".repeat(64),
    })
    if (canonicalBaseAssetSetSha256(artifact) !== artifact.baseAssetSetSha256) {
      throw new TypeError("Abandonment base asset set digest is invalid")
    }
  }
}

function validateRetainedAssets(context) {
  const expected = baseAssets(context.artifact)
  const expectedByName = new Map(expected.map((asset, index) => [asset.name, { ...asset, index }]))
  let previousIndex = -1
  let baseCount = 0
  let terminalCount = 0
  for (const asset of context.release.assets) {
    if (asset.name === TERMINAL_ASSET_NAME) {
      terminalCount += 1
      continue
    }
    const base = expectedByName.get(asset.name)
    if (
      base === undefined ||
      asset.sha256 !== base.sha256 ||
      base.index <= previousIndex ||
      !BASE_ASSET_NAME_PATTERN.test(asset.name)
    ) {
      throw new TypeError("Retained abandonment asset conflicts with exact base evidence")
    }
    previousIndex = base.index
    baseCount += 1
  }
  if (terminalCount > 1) throw new TypeError("Abandonment context contains duplicate tombstones")
  if (context.predecessor === "CANDIDATE_ESCROWED" && baseCount !== 45) {
    throw new TypeError("Escrowed abandonment context must preserve all 45 base assets")
  }
  if (["CANDIDATE_TAGGED", "ARTIFACTS_PREPARED"].includes(context.predecessor) && baseCount !== 0) {
    throw new TypeError("Early abandonment context cannot contain escrow assets")
  }
}

function validateTerminalContext(context, tombstoneSha256) {
  const terminalAssets = context.release.assets.filter(
    (asset) => asset.name === TERMINAL_ASSET_NAME,
  )
  if (terminalAssets.some((asset) => asset.sha256 !== tombstoneSha256)) {
    throw new Error("Existing abandonment evidence differs from the requested tombstone")
  }
  if (context.release.marker?.phase === "ABANDONED_PREPUBLICATION") {
    if (context.release.marker.abandonmentSha256 !== tombstoneSha256) {
      throw new Error("Existing terminal abandonment marker differs from the requested evidence")
    }
  } else if (context.release.marker !== null && context.release.marker.abandonmentSha256 !== null) {
    throw new Error("Predecessor marker contains unexpected abandonment evidence")
  }
}

async function recoverDurableTombstone({ release, context, candidate, reader }) {
  if (release === null) return null
  const bodyRecord =
    context.release.marker?.phase === "ABANDONED_PREPUBLICATION"
      ? parseAbandonmentReleaseBody(release.body)
      : null
  const terminalAsset = context.release.assets.find((asset) => asset.name === TERMINAL_ASSET_NAME)
  const assetRecord =
    terminalAsset === undefined
      ? null
      : parseCanonicalAbandonmentBytes(
          await downloadAsset(reader, terminalAsset, RELEASE_PAYLOAD_LIMITS.auditReceiptBytes),
        )
  for (const record of [bodyRecord, assetRecord]) {
    if (
      record !== null &&
      (record.version !== candidate.version || record.commitSha !== candidate.commitSha)
    ) {
      throw new Error("Durable abandonment record conflicts with the candidate identity")
    }
  }
  if (
    bodyRecord !== null &&
    assetRecord !== null &&
    !canonicalAbandonmentBytes(bodyRecord).equals(canonicalAbandonmentBytes(assetRecord))
  ) {
    throw new Error("Durable abandonment body and asset evidence conflict")
  }
  return bodyRecord ?? assetRecord
}

async function reconcileReleaseList({ releases, context, candidate, reader }) {
  if (!Array.isArray(releases) || releases.length > MAX_RELEASES) {
    throw new Error("GitHub Release list is malformed or unbounded")
  }
  const matches = []
  const ids = new Set()
  for (const release of releases) {
    if (
      !isRecord(release) ||
      !isPositiveInteger(release.id) ||
      typeof release.tag_name !== "string"
    ) {
      throw new Error("GitHub Release identity is malformed")
    }
    if (ids.has(release.id)) throw new Error("GitHub Release identities are duplicate")
    ids.add(release.id)
    if (release.tag_name === `v${candidate.version}`) matches.push(release)
    if (release.tag_name.startsWith("v") && isReleaseVersion(release.tag_name.slice(1))) {
      if (compareSemver(release.tag_name.slice(1), candidate.version) > 0) {
        throw new Error("A newer GitHub Release interleaved before abandonment")
      }
    }
  }
  if (matches.length > 1) throw new Error("Duplicate candidate Releases are ambiguous")
  if (context.release.status === "absent") {
    if (matches.length !== 0) throw new Error("Abandonment Release absence observation is stale")
    return null
  }
  if (matches.length !== 1 || matches[0].id !== context.release.releaseId) {
    throw new Error("Abandonment Release identity observation is stale")
  }
  return readManagedRelease(reader, context.release.releaseId)
}

async function reobserveReleaseBoundary(reader, candidate, expectedRelease) {
  const releases = await readGitHubValue(reader.listReleases({}), "releases")
  if (!Array.isArray(releases) || releases.length > MAX_RELEASES) {
    throw new Error("GitHub Release list is malformed or unbounded")
  }
  const ids = new Set()
  const candidateMatches = []
  for (const release of releases) {
    if (
      !isRecord(release) ||
      !isPositiveInteger(release.id) ||
      typeof release.tag_name !== "string" ||
      ids.has(release.id)
    ) {
      throw new Error("GitHub Release identity is malformed or duplicate")
    }
    ids.add(release.id)
    if (release.tag_name === `v${candidate.version}`) candidateMatches.push(release)
    if (release.tag_name.startsWith("v") && isReleaseVersion(release.tag_name.slice(1))) {
      if (compareSemver(release.tag_name.slice(1), candidate.version) > 0) {
        throw new Error("A newer GitHub Release interleaved before abandonment")
      }
    }
  }
  if (candidateMatches.length > 1) {
    throw new Error("Duplicate candidate Releases are ambiguous")
  }
  if (expectedRelease.status === "absent") {
    if (candidateMatches.length !== 0) {
      throw new Error("Abandonment Release absence observation is stale before mutation")
    }
    return
  }
  if (
    expectedRelease.status !== "draft" ||
    candidateMatches.length !== 1 ||
    candidateMatches[0].id !== expectedRelease.releaseId
  ) {
    throw new Error("Abandonment Release identity changed before mutation")
  }
  const exact = await readManagedRelease(reader, expectedRelease.releaseId)
  if (releaseBodySha256(exact.body) !== expectedRelease.bodySha256) {
    throw new Error("Abandonment Release body changed before mutation")
  }
}

function validateCreateReceipt(value, expectedBody) {
  const receipt = snapshotJson(value)
  if (
    !hasExactFields(receipt, ["releaseId", "status", "bodySha256"]) ||
    !isPositiveInteger(receipt.releaseId) ||
    !["created", "existing"].includes(receipt.status) ||
    receipt.bodySha256 !== releaseBodySha256(expectedBody)
  ) {
    throw new Error("Abandonment draft creation receipt is not exact")
  }
  return receipt
}

async function verifyReleaseAndAssets({ release, context, candidate, reader }) {
  assertDraftRelease(release, candidate)
  if (releaseBodySha256(release.body) !== context.release.bodySha256) {
    throw new Error("Abandonment Release body observation is stale")
  }
  const marker = parseReleaseMarker(release.body)
  if (canonicalText(marker) !== canonicalText(context.release.marker)) {
    throw new Error("Abandonment Release marker observation is stale")
  }
  const assets = await readAssetInventory(reader, release.id)
  if (
    assets.length !== context.release.assets.length ||
    assets.some(
      (asset, index) =>
        asset.id !== context.release.assets[index].id ||
        asset.name !== context.release.assets[index].name,
    )
  ) {
    throw new Error("Abandonment Release asset observation is stale")
  }
  let cumulativeBytes = 0
  for (const [index, asset] of assets.entries()) {
    const expected = context.release.assets[index]
    const maximum = assetLimit(asset.name)
    const bytes = await downloadAsset(reader, asset, maximum)
    cumulativeBytes += bytes.byteLength
    assertPayloadByteLength(
      cumulativeBytes,
      RELEASE_PAYLOAD_LIMITS.escrowBytes + RELEASE_PAYLOAD_LIMITS.auditReceiptBytes,
      "Retained abandonment evidence",
    )
    if (sha256(bytes) !== expected.sha256) {
      throw new Error("Retained abandonment asset bytes are stale")
    }
  }
}

async function readAssetInventory(reader, releaseId) {
  const assets = await readGitHubValue(reader.listReleaseAssets({ releaseId }), "release-assets")
  if (!Array.isArray(assets) || assets.length > 46) {
    throw new Error("Abandonment Release asset list is malformed or unbounded")
  }
  const names = new Set()
  const ids = new Set()
  return assets.map((asset) => {
    if (
      !isRecord(asset) ||
      !isPositiveInteger(asset.id) ||
      typeof asset.name !== "string" ||
      names.has(asset.name) ||
      ids.has(asset.id)
    ) {
      throw new Error("Abandonment Release asset identity is invalid or duplicate")
    }
    names.add(asset.name)
    ids.add(asset.id)
    return { id: asset.id, name: asset.name }
  })
}

function assertCurrentAssetInventory(actual, observed, { requireTombstone = false } = {}) {
  const expectedByName = new Map(observed.map((asset) => [asset.name, asset]))
  let tombstones = 0
  for (const asset of actual) {
    if (asset.name === TERMINAL_ASSET_NAME) {
      tombstones += 1
      continue
    }
    const expected = expectedByName.get(asset.name)
    if (expected === undefined || expected.id !== asset.id) {
      throw new Error("Abandonment Release asset inventory changed before mutation")
    }
  }
  const expectedBase = observed.filter((asset) => asset.name !== TERMINAL_ASSET_NAME)
  if (
    actual.filter((asset) => asset.name !== TERMINAL_ASSET_NAME).length !== expectedBase.length ||
    tombstones > 1 ||
    (requireTombstone && tombstones !== 1)
  ) {
    throw new Error("Abandonment Release asset inventory changed before mutation")
  }
}

async function assertRemoteAsset(reader, asset, expectedSha256, maximumBytes) {
  const bytes = await downloadAsset(reader, asset, maximumBytes)
  if (sha256(bytes) !== expectedSha256) {
    throw new Error("Remote abandonment evidence bytes conflict with the canonical tombstone")
  }
}

async function downloadAsset(reader, asset, maximumBytes) {
  const result = snapshotJson(await reader.downloadReleaseAsset({ assetId: asset.id }))
  if (
    !hasExactFields(result, ["status", "operation", "httpStatus", "code", "contentBase64"]) ||
    result.status !== "PRESENT" ||
    result.operation !== "release-asset-download" ||
    result.httpStatus !== 200 ||
    result.code !== null ||
    typeof result.contentBase64 !== "string"
  ) {
    throw new Error("Abandonment Release asset download is not exact")
  }
  const maximumBase64Bytes = Math.ceil(maximumBytes / 3) * 4
  assertPayloadByteLength(
    Buffer.byteLength(result.contentBase64, "utf8"),
    maximumBase64Bytes,
    "Abandonment Release asset base64",
  )
  const bytes = Buffer.from(result.contentBase64, "base64")
  if (bytes.toString("base64") !== result.contentBase64) {
    throw new Error("Abandonment Release asset base64 is not canonical")
  }
  assertPayloadByteLength(bytes.byteLength, maximumBytes, "Abandonment Release asset")
  return bytes
}

function baseAssets(artifact) {
  if (artifact.attestationSet === null) return []
  const assets = [
    { name: "release-record.json", sha256: artifact.releaseRecordSha256 },
    { name: "manifest.json", sha256: artifact.manifestSha256 },
    ...artifact.attestationSet.subjects.slice(1).map((subject) => ({
      name: subject.subjectName,
      sha256: subject.subjectSha256,
    })),
    ...artifact.attestationSet.subjects.map((subject) => ({
      name: subject.bundleName,
      sha256: subject.bundleSha256,
    })),
  ]
  if (assets.length !== 45 || new Set(assets.map(({ name }) => name)).size !== 45) {
    throw new TypeError("Abandonment base asset set is invalid")
  }
  return assets
}

function canonicalBaseAssetSetSha256(artifact) {
  return sha256(
    Buffer.from(
      `${JSON.stringify(baseAssets(artifact).map(({ name, sha256: digest }) => ({ name, sha256: digest })))}\n`,
      "utf8",
    ),
  )
}

function assetLimit(name) {
  if (name === "release-record.json") return RELEASE_PAYLOAD_LIMITS.releaseRecordBytes
  if (name === "manifest.json") return RELEASE_PAYLOAD_LIMITS.manifestBytes
  if (name.endsWith(".tgz")) return RELEASE_PAYLOAD_LIMITS.tarballBytes
  if (name.endsWith(".intoto.jsonl")) return RELEASE_PAYLOAD_LIMITS.attestationBundleBytes
  if (name === TERMINAL_ASSET_NAME) return RELEASE_PAYLOAD_LIMITS.auditReceiptBytes
  throw new TypeError("Abandonment Release contains an unknown asset namespace")
}

function markerArtifact(marker) {
  return {
    manifestSha256: marker.manifestSha256,
    releaseRecordSha256: marker.releaseRecordSha256,
    baseAssetSetSha256: marker.baseAssetSetSha256,
    attestationSet: marker.attestationSet,
  }
}

function validateApprovalInput(value) {
  assertExactFields(value, APPROVAL_INPUT_FIELDS, "abandonment approval input")
  if (value.environment !== EXPECTED_ENVIRONMENT) {
    throw new TypeError("Abandonment requires the protected release-abandonment environment")
  }
  return value
}

function buildAbandonmentRecord({
  candidate,
  reason,
  actionsHistory,
  observations,
  approval,
  artifactContext,
  predecessorEvidence = null,
}) {
  return parseAbandonmentRecord(
    {
      schemaVersion: 1,
      version: candidate.version,
      commitSha: candidate.commitSha,
      tag: `v${candidate.version}`,
      predecessor: predecessorEvidence ?? {
        state: artifactContext.predecessor,
        releaseStatus: artifactContext.release.status,
        releaseId: artifactContext.release.releaseId,
        bodySha256: artifactContext.release.bodySha256,
        marker: artifactContext.release.marker,
        artifact: artifactContext.artifact,
      },
      reason,
      actor: approval.actor,
      actorId: approval.actorId,
      recordedAt: approval.recordedAt,
      approval: {
        environment: approval.environment,
        environmentId: approval.environmentId,
        reviewerId: approval.reviewerId,
        reviewer: approval.reviewer,
        state: approval.state,
        observedAt: approval.observedAt,
        workflowRunId: approval.workflowRunId,
        runAttempt: approval.runAttempt,
      },
      actionsHistory,
      observations,
    },
    {
      candidate,
      environment: EXPECTED_ENVIRONMENT,
      packageNames: CANONICAL_PACKAGE_NAMES,
    },
  )
}

async function authorizeFreshMutation(
  authorization,
  candidate,
  reason,
  artifactContext,
  predecessorEvidence = null,
) {
  const evidence = snapshotJson(
    await authorization.readFreshAbandonmentEvidence({ candidate: snapshotJson(candidate) }),
  )
  assertExactFields(
    evidence,
    ["actionsHistory", "observations", "approval"],
    "fresh abandonment authorization",
  )
  const approval = validateApprovalInput(evidence.approval)
  const record = buildAbandonmentRecord({
    candidate,
    reason,
    actionsHistory: evidence.actionsHistory,
    observations: evidence.observations,
    approval,
    artifactContext,
    predecessorEvidence,
  })
  assertFreshAuthorization(record, Date.now())
  return record
}

function validateReason(value) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > 8_192 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint <= 31 || codePoint === 127
    })
  ) {
    throw new TypeError("Abandonment reason is invalid")
  }
  return value
}

function parseCanonicalAbandonmentBytes(bytes) {
  let value
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw new TypeError("Canonical abandonment bytes are not valid UTF-8 JSON", { cause: error })
  }
  const canonical = canonicalAbandonmentBytes(value)
  if (!canonical.equals(bytes)) {
    throw new TypeError("Abandonment record bytes are not canonical")
  }
  return parseAbandonmentRecord(value, {
    candidate: { version: value.version, commitSha: value.commitSha },
    environment: EXPECTED_ENVIRONMENT,
    packageNames: CANONICAL_PACKAGE_NAMES,
  })
}

function assertFreshAuthorization(record, now) {
  const approvalTime = Date.parse(record.approval.observedAt)
  const historyTime = Date.parse(record.actionsHistory.observedAt)
  const firstTime = Date.parse(record.observations[0].observedAt)
  const secondTime = Date.parse(record.observations[1].observedAt)
  const recordedTime = Date.parse(record.recordedAt)
  const oldest = Math.min(approvalTime, historyTime, firstTime, secondTime, recordedTime)
  const newest = Math.max(approvalTime, historyTime, firstTime, secondTime, recordedTime)
  if (
    secondTime - firstTime < MIN_REGISTRY_OBSERVATION_GAP_MS ||
    oldest < now - MAX_FRESH_AUTHORIZATION_AGE_MS ||
    recordedTime < now - MAX_FRESH_RECORD_AGE_MS ||
    secondTime < now - MAX_FRESH_SECOND_OBSERVATION_AGE_MS ||
    newest > now + MAX_CLOCK_SKEW_MS
  ) {
    throw new Error("Fresh abandonment authorization is stale or insufficiently separated")
  }
}

function validateCandidate(value) {
  if (!isRecord(value)) throw new TypeError("Abandonment candidate is invalid")
  const keys = Object.keys(value)
  if (
    !["version", "commitSha"].every((field) => keys.includes(field)) ||
    keys.some((field) => !CANDIDATE_FIELDS.includes(field)) ||
    !isReleaseVersion(value.version) ||
    !SHA_PATTERN.test(value.commitSha)
  ) {
    throw new TypeError("Abandonment candidate identity is invalid")
  }
  if (
    (value.ciWorkflow !== undefined && value.ciWorkflow !== "CI") ||
    (value.ciCheck !== undefined && value.ciCheck !== "validate") ||
    (value.publisherWorkflow !== undefined &&
      value.publisherWorkflow !== ".github/workflows/release.yml")
  ) {
    throw new TypeError("Abandonment candidate policy identity is invalid")
  }
  return deepFreeze(value)
}

async function verifyAnnotatedTag(reader, candidate) {
  const tag = `v${candidate.version}`
  const ref = await readGitHubValue(reader.getRef({ ref: `tags/${tag}` }), "ref")
  if (!isRecord(ref.object) || ref.object.type !== "tag" || !SHA_PATTERN.test(ref.object.sha)) {
    throw new Error("Abandonment requires one annotated candidate tag")
  }
  const annotated = await readGitHubValue(reader.getGitTag({ tagSha: ref.object.sha }), "git-tag")
  if (
    annotated.tag !== tag ||
    !isRecord(annotated.object) ||
    annotated.object.type !== "commit" ||
    annotated.object.sha !== candidate.commitSha
  ) {
    throw new Error("Abandonment candidate tag identity changed")
  }
}

async function readManagedRelease(reader, releaseId) {
  const release = await readGitHubValue(reader.getRelease({ releaseId }), "release")
  if (!isRecord(release) || release.id !== releaseId) {
    throw new Error("Managed abandonment Release response is malformed")
  }
  return release
}

function assertDraftRelease(release, candidate) {
  if (
    release.tag_name !== `v${candidate.version}` ||
    release.target_commitish !== "main" ||
    release.prerelease !== false ||
    typeof release.name !== "string" ||
    typeof release.body !== "string" ||
    release.draft !== true ||
    release.immutable !== false
  ) {
    throw new Error("Abandonment requires the exact mutable candidate draft")
  }
}

async function readGitHubValue(promise, operation) {
  const envelope = snapshotJson(await promise)
  if (
    !hasExactFields(envelope, ["status", "operation", "httpStatus", "code", "value"]) ||
    envelope.status !== "PRESENT" ||
    envelope.operation !== operation ||
    !Number.isInteger(envelope.httpStatus) ||
    envelope.httpStatus < 200 ||
    envelope.httpStatus >= 300 ||
    envelope.code !== null
  ) {
    throw new Error(`GitHub ${operation} observation is not exact`)
  }
  return envelope.value
}

function bindMethods(value, methods, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  const result = Object.create(null)
  for (const method of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(value, method)
    if (!isEnumerableData(descriptor) || typeof descriptor.value !== "function") {
      throw new TypeError(`${label} method ${method} is invalid`)
    }
    result[method] = descriptor.value.bind(value)
  }
  return Object.freeze(result)
}

function assertOwnDataFields(value, fields, label) {
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((key) => typeof key !== "string")
  ) {
    throw new TypeError(`${label} input schema is invalid`)
  }
  for (const field of fields) {
    if (!isEnumerableData(Object.getOwnPropertyDescriptor(value, field))) {
      throw new TypeError(`${label} contains an accessor field`)
    }
  }
}

function dataField(value, field) {
  const descriptor = Object.getOwnPropertyDescriptor(value, field)
  if (!isEnumerableData(descriptor)) throw new TypeError("Input contains an accessor field")
  return descriptor.value
}

function assertExactFields(value, fields, label) {
  if (!hasExactFields(value, fields)) throw new TypeError(`${label} schema is invalid`)
}

function hasExactFields(value, fields) {
  return (
    isRecord(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  )
}

function isReleaseVersion(value) {
  if (!isExactSemver(value)) return false
  const parsed = parseSemver(value)
  return parsed.prerelease.length === 0 && parsed.build.length === 0
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function positiveId(value, label) {
  if (!isPositiveInteger(value)) throw new TypeError(`${label} is invalid`)
  return value
}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object"
}

function isPlainDataObject(value) {
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype
}

function isEnumerableData(descriptor) {
  return (
    descriptor?.enumerable === true &&
    "value" in descriptor &&
    descriptor.get === undefined &&
    descriptor.set === undefined
  )
}

function canonicalText(value) {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
