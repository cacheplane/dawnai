import { createHash, timingSafeEqual } from "node:crypto"

import { normalizeAdapterEnvelope, snapshotJson } from "../adapter-normalize.mjs"
import { assertPayloadByteLength, RELEASE_PAYLOAD_LIMITS } from "../limits.mjs"
import {
  isManagedReleaseForTag,
  parseReleaseMarker,
  parseSmokeReleaseAssetName,
  preflightPublicationAssetMetadata,
  releaseBodySha256,
  validatePublicationAuditAssets,
} from "../metadata.mjs"

const API_ORIGIN = "https://api.github.com"
const UPLOAD_ORIGIN = "https://uploads.github.com"
const RELEASE_API_VERSION = "2022-11-28"
const DISPATCH_API_VERSION = "2026-03-10"
const JSON_ACCEPT = "application/vnd.github+json"
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u
const TAG_PATTERN =
  /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const ASSET_NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._@+-]{0,511}$/u
const WORKFLOWS = new Set([
  ".github/workflows/release.yml",
  ".github/workflows/published-artifact-verify.yml",
])
const READER_METHODS = Object.freeze([
  "getRef",
  "getGitTag",
  "listReleases",
  "getRelease",
  "listReleaseAssets",
  "downloadReleaseAsset",
])
const MAX_TIMEOUT_MS = 300_000
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_JSON_REQUEST_BYTES = 4 * 1024 * 1024
// Failure detail carried on a writer Error: the HTTP status plus a short sanitized snippet of
// the response body. Two v0.8.24 escrow failures at the draft POST were undiagnosable because
// the status was discarded. Never the headers, never the token. The redaction set mirrors
// `safeDetail` in ../cli.mjs (which must not be imported here: cli.mjs imports this adapter).
const FAILURE_SNIPPET_MAX_LENGTH = 200
const FAILURE_SNIPPET_MAX_INPUT_LENGTH = 4096
const FAILURE_SNIPPET_REDACTIONS = Object.freeze([
  /gh[pous]_[A-Za-z0-9]{20,}/gu,
  /github_pat_[A-Za-z0-9_]{20,}/gu,
  /npm_[A-Za-z0-9]{20,}/gu,
  /Bearer\s+\S+/giu,
  /authorization:\s*\S+(?:\s+\S+)?/giu,
  /(?<![A-Za-z0-9_.-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/gu,
])

export function composeGitHubEffects({ reader, writer }) {
  if (
    reader === null ||
    typeof reader !== "object" ||
    writer === null ||
    typeof writer !== "object"
  ) {
    throw new TypeError("GitHub effects require explicit reader and writer objects")
  }
  const methods = Object.keys(writer).sort()
  const expected = [
    "createDraftRelease",
    "dispatchWorkflowAtRef",
    "publishReleaseIfCurrent",
    "updateDraftReleaseIfCurrent",
    "uploadAssetIfAbsentAndEqual",
  ].sort()
  if (
    !arraysEqual(methods, expected) ||
    methods.some((name) => typeof writer[name] !== "function")
  ) {
    throw new TypeError("GitHub writer must expose exactly five named methods")
  }
  return Object.freeze({ reader, writer })
}

export function createGitHubWriter({
  owner,
  repo,
  token,
  reader,
  apiOrigin = API_ORIGIN,
  uploadOrigin,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
}) {
  validateIdentity(owner, OWNER_PATTERN, "GitHub owner")
  validateIdentity(repo, REPOSITORY_PATTERN, "GitHub repository")
  if (
    token !== undefined &&
    (typeof token !== "string" ||
      token.length === 0 ||
      token.length > 4096 ||
      /[\r\n]/u.test(token))
  ) {
    throw new TypeError("Invalid GitHub token")
  }
  if (typeof fetchImpl !== "function") throw new TypeError("GitHub writer fetch is invalid")
  assertInteger(timeoutMs, 1, MAX_TIMEOUT_MS, "GitHub writer timeout")
  assertInteger(maxResponseBytes, 1, MAX_RESPONSE_BYTES, "GitHub writer response limit")
  const normalizedApiOrigin = normalizeOrigin(apiOrigin, "GitHub API origin")
  const normalizedUploadOrigin = normalizeOrigin(
    uploadOrigin ?? (normalizedApiOrigin === API_ORIGIN ? UPLOAD_ORIGIN : normalizedApiOrigin),
    "GitHub upload origin",
  )
  if (
    token !== undefined &&
    (normalizedApiOrigin !== API_ORIGIN || normalizedUploadOrigin !== UPLOAD_ORIGIN)
  ) {
    throw new TypeError("GitHub token requires trusted GitHub API and upload origins")
  }
  const reads = snapshotReader(reader)
  const base = `${normalizedApiOrigin}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const uploadBase = `${normalizedUploadOrigin}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const context = Object.freeze({
    owner,
    repo,
    token: token ?? null,
    reads,
    base,
    uploadBase,
    fetchImpl,
    timeoutMs,
    maxResponseBytes,
  })

  return Object.freeze({
    async createDraftRelease(input) {
      const args = snapshotExactInput(
        input,
        ["tag", "targetSha", "title", "body"],
        "draft creation",
      )
      validateTagAndSha(args.tag, args.targetSha)
      validateText(args.title, 512, "Release title")
      validateText(args.body, 1024 * 1024, "Release body")
      await verifyAnnotatedTag(context, args.tag, args.targetSha)
      const existing = await findReleaseByTag(context, args)
      if (existing !== null) {
        const release = await readRelease(context, existing.id)
        assertDraftIdentity(
          release,
          { ...args, releaseId: existing.id },
          {
            title: args.title,
            body: args.body,
          },
        )
        await verifyAnnotatedTag(context, args.tag, args.targetSha)
        return Object.freeze({
          releaseId: release.id,
          status: "existing",
          bodySha256: releaseBodySha256(release.body),
        })
      }

      const response = await requestJson(context, {
        url: `${context.base}/releases`,
        method: "POST",
        apiVersion: RELEASE_API_VERSION,
        body: {
          tag_name: args.tag,
          name: args.title,
          body: args.body,
          draft: true,
          generate_release_notes: false,
        },
      })
      if (![201, 422].includes(response.httpStatus)) {
        throw new Error(writeFailureMessage("GitHub draft creation", response))
      }
      let releaseId
      let status
      if (response.httpStatus === 201) {
        releaseId = positiveId(response.body?.id, "created Release ID")
        status = "created"
      } else {
        const raced = await findReleaseByTag(context, args)
        if (raced === null) {
          throw new Error(
            writeFailureMessage(
              "GitHub draft creation race could not be reconciled: no Release matches the tag and the POST",
              response,
            ),
          )
        }
        releaseId = raced.id
        status = "existing"
      }
      const release = await readRelease(context, releaseId)
      assertDraftIdentity(release, { ...args, releaseId }, { title: args.title, body: args.body })
      await verifyAnnotatedTag(context, args.tag, args.targetSha)
      return Object.freeze({
        releaseId,
        status,
        bodySha256: releaseBodySha256(release.body),
      })
    },

    async updateDraftReleaseIfCurrent(input) {
      const args = snapshotExactInput(
        input,
        ["releaseId", "tag", "targetSha", "expectedBodySha256", "title", "body"],
        "draft update",
      )
      const releaseId = positiveId(args.releaseId, "Release ID")
      validateTagAndSha(args.tag, args.targetSha)
      assertSha256(args.expectedBodySha256, "expected Release body digest")
      validateText(args.title, 512, "Release title")
      validateText(args.body, 1024 * 1024, "Release body")
      await verifyAnnotatedTag(context, args.tag, args.targetSha)
      const current = await readRelease(context, releaseId)
      assertDraftIdentity(current, args)
      if (releaseBodySha256(current.body) !== args.expectedBodySha256) {
        throw new Error("Release body compare-and-swap is stale")
      }
      if (current.body === args.body && current.name === args.title) {
        await verifyAnnotatedTag(context, args.tag, args.targetSha)
        return Object.freeze({
          releaseId,
          status: "unchanged",
          bodySha256: releaseBodySha256(current.body),
        })
      }
      const response = await requestJson(context, {
        url: `${context.base}/releases/${releaseId}`,
        method: "PATCH",
        apiVersion: RELEASE_API_VERSION,
        body: { name: args.title, body: args.body },
      })
      if (response.httpStatus !== 200) {
        throw new Error(writeFailureMessage("GitHub draft update", response))
      }
      const updated = await readRelease(context, releaseId)
      assertDraftIdentity(updated, args, { title: args.title, body: args.body })
      await verifyAnnotatedTag(context, args.tag, args.targetSha)
      return Object.freeze({
        releaseId,
        status: "updated",
        bodySha256: releaseBodySha256(updated.body),
      })
    },

    async uploadAssetIfAbsentAndEqual(input) {
      const args = snapshotAssetInput(input)
      const releaseId = positiveId(args.releaseId, "Release ID")
      validateTagAndSha(args.tag, args.targetSha)
      validateAssetName(args.name)
      assertSha256(args.sha256, "Release asset digest")
      if (sha256(args.bytes) !== args.sha256) throw new Error("Release asset input digest mismatch")
      await verifyAnnotatedTag(context, args.tag, args.targetSha)
      assertDraftIdentity(await readRelease(context, releaseId), args)
      let assets = await readAssets(context, releaseId)
      let existing = findOneAsset(assets, args.name)
      if (existing !== null) {
        await assertAssetEquality(context, existing, args.sha256, args.maximumBytes)
        await verifyAnnotatedTag(context, args.tag, args.targetSha)
        return Object.freeze({ assetId: existing.id, status: "existing", sha256: args.sha256 })
      }
      const response = await requestJson(context, {
        url: `${context.uploadBase}/releases/${releaseId}/assets?name=${encodeURIComponent(args.name)}`,
        method: "POST",
        apiVersion: RELEASE_API_VERSION,
        bodyBytes: args.bytes,
        contentType: "application/octet-stream",
        maxRequestBytes: args.maximumBytes,
      })
      if (![201, 422].includes(response.httpStatus)) {
        throw new Error(writeFailureMessage("GitHub Release asset upload", response))
      }
      assets = await readAssets(context, releaseId)
      existing = findOneAsset(assets, args.name)
      if (existing === null) throw new Error("Uploaded Release asset was not present on re-read")
      await assertAssetEquality(context, existing, args.sha256, args.maximumBytes)
      await verifyAnnotatedTag(context, args.tag, args.targetSha)
      return Object.freeze({
        assetId: existing.id,
        status: response.httpStatus === 201 ? "uploaded" : "existing",
        sha256: args.sha256,
      })
    },

    async publishReleaseIfCurrent(input) {
      const args = snapshotExactInput(
        input,
        ["releaseId", "tag", "targetSha", "expectedBodySha256", "assets"],
        "Release publication",
      )
      const releaseId = positiveId(args.releaseId, "Release ID")
      validateTagAndSha(args.tag, args.targetSha)
      assertSha256(args.expectedBodySha256, "expected Release body digest")
      const expectedAssets = normalizeExpectedAssets(args.assets)
      await verifyAnnotatedTag(context, args.tag, args.targetSha)
      const current = await readRelease(context, releaseId)
      if (current.draft === true) assertDraftIdentity(current, args)
      else assertPublishedIdentity(current, args)
      if (releaseBodySha256(current.body) !== args.expectedBodySha256) {
        throw new Error("Release publication body compare-and-swap is stale")
      }
      const marker = parseReleaseMarker(current.body)
      validatePublicationMarker(marker, args, expectedAssets)
      await assertExactPublicationAssets(context, releaseId, expectedAssets, marker)
      if (current.draft === false) {
        await verifyAnnotatedTag(context, args.tag, args.targetSha)
        return Object.freeze({ releaseId, status: "existing", immutable: true })
      }
      const response = await requestJson(context, {
        url: `${context.base}/releases/${releaseId}`,
        method: "PATCH",
        apiVersion: RELEASE_API_VERSION,
        body: { tag_name: args.tag, draft: false },
      })
      if (response.httpStatus !== 200) {
        throw new Error(writeFailureMessage("Release publication", response))
      }
      const published = await readRelease(context, releaseId)
      assertPublishedIdentity(published, args)
      if (published.body !== current.body || published.name !== current.name) {
        throw new Error("Published Release immutable re-read changed metadata")
      }
      await assertExactPublicationAssets(context, releaseId, expectedAssets, marker)
      await verifyAnnotatedTag(context, args.tag, args.targetSha)
      return Object.freeze({ releaseId, status: "published", immutable: true })
    },

    async dispatchWorkflowAtRef(input) {
      const args = snapshotExactInput(input, ["workflow", "ref", "inputs"], "workflow dispatch")
      if (!WORKFLOWS.has(args.workflow))
        throw new TypeError("Workflow dispatch path is not allowed")
      assertTag(args.ref)
      if (!isRecord(args.inputs)) throw new TypeError("Workflow dispatch inputs must be an object")
      rejectRemovedDispatchField(args.inputs)
      const requestBody = { ref: args.ref, inputs: args.inputs }
      const response = await requestJson(context, {
        url: `${context.base}/actions/workflows/${encodeURIComponent(args.workflow)}/dispatches`,
        method: "POST",
        apiVersion: DISPATCH_API_VERSION,
        body: requestBody,
      })
      if (response.httpStatus !== 200) {
        throw new Error(
          writeFailureMessage(
            "GitHub workflow dispatch requires the direct HTTP 200 run receipt but",
            response,
          ),
        )
      }
      const receipt = snapshotJson(response.body)
      if (
        !hasExactFields(receipt, ["workflow_run_id", "run_url", "html_url"]) ||
        !isPositiveInteger(receipt.workflow_run_id)
      ) {
        throw new Error("GitHub workflow dispatch receipt is malformed")
      }
      const id = receipt.workflow_run_id
      if (
        receipt.run_url !== `${context.base}/actions/runs/${id}` ||
        receipt.html_url !==
          `https://github.com/${context.owner}/${context.repo}/actions/runs/${id}`
      ) {
        throw new Error("GitHub workflow dispatch receipt URLs do not match the returned run")
      }
      return Object.freeze({
        workflowRunId: id,
        runUrl: receipt.run_url,
        htmlUrl: receipt.html_url,
      })
    },
  })
}

async function verifyAnnotatedTag(context, tag, targetSha) {
  const ref = await readValue(context, "getRef", { ref: `tags/${tag}` }, "ref")
  if (
    !isRecord(ref.object) ||
    ref.object.type !== "tag" ||
    typeof ref.object.sha !== "string" ||
    !SHA_PATTERN.test(ref.object.sha)
  ) {
    throw new Error("Candidate tag must be one annotated Git tag object")
  }
  const annotated = await readValue(context, "getGitTag", { tagSha: ref.object.sha }, "git-tag")
  if (
    annotated.tag !== tag ||
    !isRecord(annotated.object) ||
    annotated.object.type !== "commit" ||
    annotated.object.sha !== targetSha
  ) {
    throw new Error("Annotated candidate tag does not peel to the target commit")
  }
}

async function findReleaseByTag(context, { tag, title, body }) {
  const releases = await readValue(context, "listReleases", {}, "releases")
  if (!Array.isArray(releases)) throw new Error("GitHub Release list is malformed")
  const matches = releases.filter(
    (release) =>
      isRecord(release) &&
      (release.tag_name === tag ||
        (release.name === title && release.body === body && isManagedReleaseForTag(release, tag))),
  )
  if (matches.length > 1) throw new Error("Duplicate matching GitHub Releases are ambiguous")
  if (matches.length === 0) return null
  return { id: positiveId(matches[0].id, "Release ID") }
}

async function readRelease(context, releaseId) {
  const release = await readValue(context, "getRelease", { releaseId }, "release")
  if (!isRecord(release)) throw new Error("GitHub Release response is malformed")
  return release
}

async function readAssets(context, releaseId) {
  const assets = await readValue(context, "listReleaseAssets", { releaseId }, "release-assets")
  if (!Array.isArray(assets)) throw new Error("GitHub Release asset list is malformed")
  const names = new Set()
  const ids = new Set()
  return assets.map((asset) => {
    if (!isRecord(asset)) throw new Error("GitHub Release asset is malformed")
    const id = positiveId(asset.id, "Release asset ID")
    validateAssetName(asset.name)
    if (names.has(asset.name) || ids.has(id)) {
      throw new Error("Duplicate GitHub Release asset identity is ambiguous")
    }
    names.add(asset.name)
    ids.add(id)
    if (!Number.isSafeInteger(asset.size) || asset.size < 1) {
      throw new Error("GitHub Release asset declared size is malformed")
    }
    return { id, name: asset.name, size: asset.size }
  })
}

async function readValue(context, method, args, operation) {
  const envelope = normalizeAdapterEnvelope(await context.reads[method](args), {
    source: "github",
    operation,
    payloadKey: "value",
  })
  if (envelope.status !== "PRESENT") {
    throw new Error(
      `GitHub ${operation} observation is not exact: ${envelope.code ?? envelope.status}`,
    )
  }
  return envelope.value
}

function assertDraftIdentity(release, args, expected = {}) {
  assertCommonReleaseMetadata(release, args)
  if (release.draft !== true || release.immutable !== false) {
    throw new Error("GitHub Release is not the expected mutable draft")
  }
  if (expected.title !== undefined && release.name !== expected.title) {
    throw new Error("GitHub Release title changed during compare-and-swap")
  }
  if (expected.body !== undefined && release.body !== expected.body) {
    throw new Error("GitHub Release body changed during compare-and-swap")
  }
}

function assertPublishedIdentity(release, args) {
  assertCommonReleaseMetadata(release, args)
  if (release.tag_name !== args.tag || release.draft !== false || release.immutable !== true) {
    throw new Error("GitHub published Release identity or metadata is malformed")
  }
}

function assertCommonReleaseMetadata(release, args) {
  if (
    positiveId(release.id, "Release ID") !== positiveId(args.releaseId, "Release ID") ||
    typeof release.tag_name !== "string" ||
    release.target_commitish !== "main" ||
    release.prerelease !== false ||
    typeof release.name !== "string" ||
    typeof release.body !== "string" ||
    typeof release.draft !== "boolean" ||
    typeof release.immutable !== "boolean"
  ) {
    throw new Error("GitHub Release identity or metadata is malformed")
  }
}

function findOneAsset(assets, name) {
  const matches = assets.filter((asset) => asset.name === name)
  if (matches.length > 1) throw new Error("Duplicate same-name GitHub Release assets")
  return matches[0] ?? null
}

async function assertAssetEquality(context, asset, expectedSha256, maximumBytes) {
  assertPayloadByteLength(asset.size, maximumBytes, `${asset.name} declared size`)
  const envelope = normalizeAdapterEnvelope(
    await context.reads.downloadReleaseAsset({ assetId: asset.id, maximumBytes: asset.size }),
    {
      source: "github",
      operation: "release-asset-download",
      payloadKey: "contentBase64",
    },
  )
  if (envelope.status !== "PRESENT" || typeof envelope.contentBase64 !== "string") {
    throw new Error("GitHub Release asset bytes could not be read exactly")
  }
  let bytes
  try {
    bytes = Buffer.from(envelope.contentBase64, "base64")
  } catch {
    throw new Error("GitHub Release asset bytes are malformed")
  }
  const canonicalBase64 = bytes.toString("base64")
  if (
    canonicalBase64 !== envelope.contentBase64 ||
    bytes.byteLength !== asset.size ||
    bytes.byteLength > maximumBytes ||
    !safeDigestEqual(sha256(bytes), expectedSha256)
  ) {
    throw new Error("GitHub Release asset has different bytes or digest")
  }
  return bytes
}

async function assertExactRemoteAssets(context, releaseId, expectedAssets, marker) {
  const actual = await readAssets(context, releaseId)
  const descriptors = preflightPublicationAssetMetadata(actual, { marker })
  if (
    descriptors.length !== expectedAssets.length ||
    !arraysEqual(
      descriptors.map(({ name }) => name).sort(compareText),
      expectedAssets.map(({ name }) => name).sort(compareText),
    )
  ) {
    throw new Error("GitHub Release asset namespace is not exact")
  }
  const expectedByName = new Map(expectedAssets.map((asset) => [asset.name, asset.sha256]))
  const auditAssets = []
  const totals = { base: 0, prepared: 0, bundles: 0, audit: 0 }
  for (const descriptor of descriptors) {
    const bytes = await assertAssetEquality(
      context,
      descriptor,
      expectedByName.get(descriptor.name),
      descriptor.maximumBytes,
    )
    accountPublicationDownload(descriptor, bytes, totals)
    if (descriptor.group === "audit") {
      auditAssets.push(Object.freeze({ name: descriptor.name, bytes }))
    }
  }
  return Object.freeze(auditAssets)
}

async function assertExactPublicationAssets(context, releaseId, expectedAssets, marker) {
  const auditAssets = await assertExactRemoteAssets(context, releaseId, expectedAssets, marker)
  validatePublicationAuditAssets(auditAssets, { marker })
}

function accountPublicationDownload(descriptor, bytes, totals) {
  if (descriptor.group === "audit") {
    totals.audit = addBoundedBytes(
      totals.audit,
      bytes.byteLength,
      RELEASE_PAYLOAD_LIMITS.auditEvidenceBytes,
      "Downloaded publication audit evidence",
    )
    return
  }
  totals.base = addBoundedBytes(
    totals.base,
    bytes.byteLength,
    RELEASE_PAYLOAD_LIMITS.escrowBytes,
    "Downloaded publication base assets",
  )
  if (descriptor.group === "prepared") {
    totals.prepared = addBoundedBytes(
      totals.prepared,
      bytes.byteLength,
      RELEASE_PAYLOAD_LIMITS.actionsExpandedBytes,
      "Downloaded publication prepared assets",
    )
  } else if (descriptor.group === "bundles") {
    totals.bundles = addBoundedBytes(
      totals.bundles,
      bytes.byteLength,
      RELEASE_PAYLOAD_LIMITS.attestationBundlesBytes,
      "Downloaded publication attestation bundles",
    )
  }
}

function addBoundedBytes(current, size, maximum, label) {
  const total = current + size
  assertPayloadByteLength(total, maximum, label)
  return total
}

function validatePublicationMarker(marker, args, assets) {
  if (
    marker.phase !== "AUDIT_VERIFIED" ||
    marker.tag !== args.tag ||
    marker.commitSha !== args.targetSha ||
    marker.audit?.conclusion !== "success" ||
    marker.audit?.canonicalSha256 !== marker.audit?.attemptSha256
  ) {
    throw new Error("Release publication requires an AUDIT_VERIFIED marker")
  }
  const baseAssets = markerBaseAssets(marker)
  const baseNames = new Set(baseAssets.map(({ name }) => name))
  const smokeAssets = marker.smoke.receiptAssets.map((asset) => ({
    name: asset.releaseAssetName,
    sha256: asset.receiptSha256,
  }))
  const smokeNames = new Set(smokeAssets.map(({ name }) => name))
  const assetNames = new Set(assets.map(({ name }) => name))
  if (
    [...baseNames].some((name) => !assetNames.has(name)) ||
    [...smokeNames].some((name) => !assetNames.has(name)) ||
    !assetNames.has(marker.audit.attemptAssetName) ||
    !assetNames.has("audit-result.json")
  ) {
    throw new Error("Release publication is missing required base or audit assets")
  }
  for (const name of assetNames) {
    if (
      !baseNames.has(name) &&
      !smokeNames.has(name) &&
      name !== "audit-result.json" &&
      !/^audit-attempt-[1-9][0-9]*-[1-9][0-9]*\.json$/u.test(name)
    ) {
      throw new Error("Release publication contains an unexpected asset")
    }
  }
  const byName = new Map(assets.map((asset) => [asset.name, asset.sha256]))
  if (baseAssets.some((asset) => byName.get(asset.name) !== asset.sha256)) {
    throw new Error("Release publication base asset digests do not match its marker")
  }
  if (smokeAssets.some((asset) => byName.get(asset.name) !== asset.sha256)) {
    throw new Error("Release publication smoke receipt digests do not match its marker")
  }
  if (
    byName.get(marker.audit.attemptAssetName) !== marker.audit.attemptSha256 ||
    byName.get("audit-result.json") !== marker.audit.canonicalSha256
  ) {
    throw new Error("Release publication audit asset digests do not match its marker")
  }
}

function markerBaseAssets(marker) {
  const assets = [
    { name: "release-record.json", sha256: marker.releaseRecordSha256 },
    { name: "manifest.json", sha256: marker.manifestSha256 },
    ...marker.attestationSet.subjects.slice(1).map((subject) => ({
      name: subject.subjectName,
      sha256: subject.subjectSha256,
    })),
    ...marker.attestationSet.subjects.map((subject) => ({
      name: subject.bundleName,
      sha256: subject.bundleSha256,
    })),
  ]
  if (assets.length !== 45 || new Set(assets.map(({ name }) => name)).size !== 45) {
    throw new Error("Release publication base asset set is not exact")
  }
  const digest = sha256(
    Buffer.from(
      `${JSON.stringify(assets.map(({ name, sha256: assetSha256 }) => ({ name, sha256: assetSha256 })))}\n`,
      "utf8",
    ),
  )
  if (!safeDigestEqual(digest, marker.baseAssetSetSha256)) {
    throw new Error("Release publication base asset-set digest does not match its marker")
  }
  return assets
}

function normalizeExpectedAssets(value) {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError("Expected assets are invalid")
  const names = new Set()
  return value.map((asset) => {
    if (!isRecord(asset) || !hasExactFields(asset, ["name", "sha256"])) {
      throw new TypeError("Expected Release asset schema is invalid")
    }
    validateAssetName(asset.name)
    assertSha256(asset.sha256, "expected Release asset digest")
    if (names.has(asset.name)) throw new TypeError("Expected Release assets contain duplicates")
    names.add(asset.name)
    return Object.freeze({ name: asset.name, sha256: asset.sha256 })
  })
}

async function requestJson(
  context,
  {
    url,
    method,
    apiVersion,
    body,
    bodyBytes,
    contentType = "application/json",
    maxRequestBytes = MAX_JSON_REQUEST_BYTES,
  },
) {
  const bytes =
    bodyBytes === undefined
      ? Buffer.from(JSON.stringify(canonicalize(body)), "utf8")
      : Buffer.from(bodyBytes)
  if (bytes.length > maxRequestBytes) throw new TypeError("GitHub write request exceeds byte limit")
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), context.timeoutMs)
  try {
    let response
    try {
      response = await context.fetchImpl(url, {
        method,
        redirect: "manual",
        headers: {
          Accept: JSON_ACCEPT,
          "Content-Type": contentType,
          "X-GitHub-Api-Version": apiVersion,
          ...(context.token === null ? {} : { Authorization: `Bearer ${context.token}` }),
        },
        body: bytes,
        signal: controller.signal,
      })
    } catch (error) {
      throw new Error(
        controller.signal.aborted
          ? `GitHub write timed out after ${context.timeoutMs} ms (${method})`
          : `GitHub write failed (${method})`,
        {
          cause: error,
        },
      )
    }
    const status = response?.status
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      cancelResponseBody(response?.body)
      throw new Error("GitHub write returned a malformed response")
    }
    if (status >= 300 && status < 400) {
      cancelResponseBody(response.body)
      throw new Error("GitHub write redirects are forbidden")
    }
    let responseBytes
    try {
      responseBytes = await readBoundedResponse(
        response.body,
        context.maxResponseBytes,
        controller.signal,
      )
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `GitHub write timed out after ${context.timeoutMs} ms reading the ${method} response`,
          { cause: error },
        )
      }
      throw error
    }
    const responseContentType = response.headers?.get?.("content-type")
    if (status < 200 || status >= 300) {
      // A failed write's body is never consumed as data; it is only summarized for the operator,
      // so the JSON content-type contract below does not apply to it.
      return {
        httpStatus: status,
        body: null,
        detail: describeFailureBody(responseBytes, responseContentType),
      }
    }
    if (responseBytes.length === 0) return { httpStatus: status, body: null, detail: null }
    if (
      typeof responseContentType !== "string" ||
      !/^application\/(?:[A-Za-z0-9!#$&^_.+-]+\+)?json(?:\s*;|\s*$)/iu.test(responseContentType)
    ) {
      throw new Error("GitHub write response content type is not JSON")
    }
    let parsed
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes))
    } catch (error) {
      throw new Error("GitHub write response JSON is malformed", { cause: error })
    }
    return { httpStatus: status, body: snapshotJson(parsed), detail: null }
  } finally {
    clearTimeout(timeout)
  }
}

function writeFailureMessage(prefix, response) {
  const head = `${prefix} returned HTTP ${response.httpStatus}`
  return response.detail === null ? head : `${head}: ${response.detail}`
}

function describeFailureBody(bytes, contentType) {
  if (bytes.length === 0) return null
  // The body is already bounded by maxResponseBytes; decode leniently so a truncated or
  // non-UTF-8 error page still yields a glimpse instead of a second failure.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  let raw = text
  if (typeof contentType === "string" && /json/iu.test(contentType)) {
    try {
      const parsed = JSON.parse(text)
      const parts = []
      if (isRecord(parsed)) {
        if (typeof parsed.message === "string") parts.push(parsed.message)
        if (parsed.errors !== undefined) parts.push(`errors=${JSON.stringify(parsed.errors)}`)
      }
      if (parts.length > 0) raw = parts.join(" ")
    } catch {
      // Fall through to the text snippet: a malformed error body is still worth a glimpse.
    }
  }
  return sanitizeFailureSnippet(raw)
}

function sanitizeFailureSnippet(value) {
  let snippet = Array.from(value.slice(0, FAILURE_SNIPPET_MAX_INPUT_LENGTH), (character) => {
    const codePoint = character.codePointAt(0)
    return codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
      ? " "
      : character
  }).join("")
  snippet = snippet.replace(/https?:\/\/[^\s?#]*\?\S*/gu, (token) =>
    token.slice(0, token.indexOf("?")),
  )
  for (const pattern of FAILURE_SNIPPET_REDACTIONS) {
    snippet = snippet.replace(pattern, "[redacted]")
  }
  snippet = snippet.replace(/\s+/gu, " ").trim()
  if (snippet.length === 0) return null
  if (snippet.length > FAILURE_SNIPPET_MAX_LENGTH) {
    snippet = `${snippet.slice(0, FAILURE_SNIPPET_MAX_LENGTH - 1)}\u2026`
  }
  return snippet
}

async function readBoundedResponse(stream, maximum, signal) {
  if (stream === null) return Buffer.alloc(0)
  if (stream === undefined || typeof stream.getReader !== "function") {
    throw new Error("GitHub write response body is malformed")
  }
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal)
      if (done) break
      if (!(value instanceof Uint8Array)) throw new Error("GitHub write response body is malformed")
      total += value.byteLength
      if (total > maximum) throw new Error("GitHub write response exceeds byte limit")
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  }
  return Buffer.concat(chunks, total)
}

async function readWithAbort(reader, signal) {
  if (signal.aborted) throw new Error("GitHub write timed out")
  let rejectAbort
  const aborted = new Promise((_resolve, reject) => {
    rejectAbort = () => reject(new Error("GitHub write timed out"))
    signal.addEventListener("abort", rejectAbort, { once: true })
  })
  try {
    return await Promise.race([reader.read(), aborted])
  } finally {
    signal.removeEventListener("abort", rejectAbort)
  }
}

function cancelResponseBody(body) {
  if (body !== null && body !== undefined && typeof body.cancel === "function") {
    void body.cancel().catch(() => {})
  }
}

function snapshotReader(reader) {
  if (reader === null || typeof reader !== "object" || Array.isArray(reader)) {
    throw new TypeError("GitHub writer requires the bounded reader")
  }
  const result = Object.create(null)
  for (const method of READER_METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(reader, method)
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      throw new TypeError(`GitHub reader method ${method} is invalid`)
    }
    result[method] = descriptor.value.bind(reader)
  }
  return Object.freeze(result)
}

function snapshotExactInput(value, fields, label) {
  const snapshot = snapshotJson(value)
  if (!hasExactFields(snapshot, fields)) throw new TypeError(`${label} input schema is invalid`)
  return deepFreeze(snapshot)
}

function snapshotAssetInput(value) {
  if (!isRecord(value)) throw new TypeError("Release asset input is invalid")
  const fields = ["releaseId", "tag", "targetSha", "name", "bytes", "sha256"]
  if (!sameOwnDataFields(value, fields))
    throw new TypeError("Release asset input schema is invalid")
  const name = dataField(value, "name")
  validateAssetName(name)
  const maximumBytes = assetUploadLimit(name)
  const json = snapshotJson({
    releaseId: dataField(value, "releaseId"),
    tag: dataField(value, "tag"),
    targetSha: dataField(value, "targetSha"),
    name,
    sha256: dataField(value, "sha256"),
  })
  const bytes = dataField(value, "bytes")
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Release asset bytes are invalid")
  assertPayloadByteLength(bytes.byteLength, maximumBytes, `${name} upload`)
  return { ...json, bytes: Buffer.from(bytes), maximumBytes }
}

function assetUploadLimit(name) {
  if (name === "release-record.json") return RELEASE_PAYLOAD_LIMITS.releaseRecordBytes
  if (name === "manifest.json") return RELEASE_PAYLOAD_LIMITS.manifestBytes
  if (name.endsWith(".tgz")) return RELEASE_PAYLOAD_LIMITS.tarballBytes
  if (name === "manifest.json.intoto.jsonl" || name.endsWith(".tgz.intoto.jsonl")) {
    return RELEASE_PAYLOAD_LIMITS.attestationBundleBytes
  }
  if (parseSmokeReleaseAssetName(name) !== null) {
    return RELEASE_PAYLOAD_LIMITS.smokeReceiptBytes
  }
  if (
    name === "audit-result.json" ||
    name === "abandonment.json" ||
    /^audit-attempt-[1-9][0-9]*-[1-9][0-9]*\.json$/u.test(name)
  ) {
    return RELEASE_PAYLOAD_LIMITS.auditReceiptBytes
  }
  throw new TypeError("GitHub Release asset namespace is not allowed")
}

function sameOwnDataFields(value, fields) {
  const keys = Reflect.ownKeys(value)
  return (
    keys.length === fields.length &&
    fields.every(
      (field) =>
        keys.includes(field) && isEnumerableData(Object.getOwnPropertyDescriptor(value, field)),
    ) &&
    keys.every((key) => typeof key === "string")
  )
}

function dataField(value, field) {
  const descriptor = Object.getOwnPropertyDescriptor(value, field)
  if (!isEnumerableData(descriptor)) throw new TypeError("GitHub writer input contains an accessor")
  return descriptor.value
}

function isEnumerableData(descriptor) {
  return (
    descriptor?.enumerable === true &&
    "value" in descriptor &&
    descriptor.get === undefined &&
    descriptor.set === undefined
  )
}

function validateTagAndSha(tag, targetSha) {
  assertTag(tag)
  if (typeof targetSha !== "string" || !SHA_PATTERN.test(targetSha)) {
    throw new TypeError("GitHub target SHA is invalid")
  }
}

function assertTag(value) {
  if (typeof value !== "string" || !TAG_PATTERN.test(value)) {
    throw new TypeError("GitHub candidate tag is invalid")
  }
}

function validateAssetName(value) {
  if (typeof value !== "string" || !ASSET_NAME_PATTERN.test(value)) {
    throw new TypeError("GitHub Release asset name is invalid")
  }
}

function validateText(value, maximumBytes, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    value.includes(String.fromCharCode(0))
  ) {
    throw new TypeError(`${label} is invalid`)
  }
}

function positiveId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} is invalid`)
  return value
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
}

function rejectRemovedDispatchField(value) {
  if (Array.isArray(value)) {
    for (const item of value) rejectRemovedDispatchField(item)
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (key === "return_run_details") {
      throw new TypeError("Removed return_run_details dispatch field is forbidden")
    }
    rejectRemovedDispatchField(child)
  }
}

function validateIdentity(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid`)
}

function normalizeOrigin(value, label) {
  if (typeof value !== "string" || value.length > 1024) throw new TypeError(`${label} is invalid`)
  let url
  try {
    url = new URL(value)
  } catch (error) {
    throw new TypeError(`${label} is invalid`, { cause: error })
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  if (
    !["https:", ...(loopback ? ["http:"] : [])].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(`${label} is invalid`)
  }
  return url.origin
}

function hasExactFields(value, fields) {
  return (
    isRecord(value) &&
    arraysEqual(Object.keys(value).sort(compareText), [...fields].sort(compareText))
  )
}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object"
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function safeDigestEqual(left, right) {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function assertInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid`)
  }
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
