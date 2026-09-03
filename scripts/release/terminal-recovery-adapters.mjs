import { snapshotJson } from "./adapter-normalize.mjs"
import { DUPLICATE_DRAFT_RECOVERY_POLICY } from "./duplicate-draft-recovery.mjs"
import {
  assertExactDataFields,
  assertExactObservedMutationState,
  assertExpectedTagObjectSha,
  canonicalize,
  canonicalWriterFence,
  createRecoveryWriterContext,
  deepFreeze,
  escapeRegExp,
  hasExactFields,
  isBoundedText,
  isObject,
  normalizePatchResponse,
  normalizeUploadResponse,
  observeIssuedRecoveryMutation,
  RECOVERY_API_ORIGIN,
  RECOVERY_ASSET_NAME_PATTERN,
  RECOVERY_OWNER,
  RECOVERY_REPOSITORY,
  RECOVERY_SHA256_PATTERN,
  RECOVERY_UPLOAD_ORIGIN,
  readCurrentWriterObservation,
  readExpectedWriterObservation,
  readWriterPreWriteFence,
  requestRecoveryJson,
  requireExactMutationObservation,
  sameJson,
  sha256,
  snapshotExactEvidenceBytes,
  snapshotExactWriterInput,
  verifyRecoveryCandidateTag,
  writeFail,
} from "./duplicate-draft-recovery-adapters.mjs"

export { DuplicateDraftRecoveryWriteError } from "./duplicate-draft-recovery-adapters.mjs"

/** The single Release this boundary may ever name: the v0.8.22 canonical draft. */
export const CANONICAL_RELEASE_ID = DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId
export const CANONICAL_TAG_NAME = "untagged-be0ff4bee4ba43b521a9"
export const CANONICAL_ESCROW_TITLE = `Dawn v${DUPLICATE_DRAFT_RECOVERY_POLICY.version}`
export const CANONICAL_ABANDONED_TITLE = `${CANONICAL_ESCROW_TITLE} (abandoned before publication)`
export const TOMBSTONE_ASSET_NAME = "abandonment.json"

const CANONICAL_BASE_ASSET_COUNT = 45
const MAX_ABANDONMENT_BODY_BYTES = 1024 * 1024
// The PATCH carries a canonicalized {name, body} envelope, so the request bound
// is the body bound plus enough headroom for the title and JSON escaping.
const MAX_ABANDONMENT_REQUEST_BYTES = MAX_ABANDONMENT_BODY_BYTES + 4096
const CANONICAL_TITLES = Object.freeze([CANONICAL_ESCROW_TITLE, CANONICAL_ABANDONED_TITLE])

const TERMINAL_PATCH_URL_PATTERN = new RegExp(
  `^${escapeRegExp(
    `${RECOVERY_API_ORIGIN}/repos/${RECOVERY_OWNER}/${RECOVERY_REPOSITORY}/releases/${CANONICAL_RELEASE_ID}`,
  )}$`,
  "u",
)
const TERMINAL_UPLOAD_URL_PATTERN = new RegExp(
  `^${escapeRegExp(
    `${RECOVERY_UPLOAD_ORIGIN}/repos/${RECOVERY_OWNER}/${RECOVERY_REPOSITORY}/releases/${CANONICAL_RELEASE_ID}/assets?name=${TOMBSTONE_ASSET_NAME}`,
  )}$`,
  "u",
)

const TERMINAL_WRITER_PINS = Object.freeze({
  allowedReleaseIds: Object.freeze(new Set([CANONICAL_RELEASE_ID])),
  patchUrlPattern: TERMINAL_PATCH_URL_PATTERN,
  uploadUrlPattern: TERMINAL_UPLOAD_URL_PATTERN,
  normalizeSnapshot: (input) => normalizeTerminalReleaseSnapshot(input),
  normalizeProjection: (snapshot) => normalizeTerminalReleaseProjection(snapshot),
  projectionSha256: (projection) => terminalReleaseProjectionSha256(projection),
  snapshotLabel: "Canonical Release",
})

/** Build the canonical-pinned writer context: Release 379991871 and nothing else. */
export function createTerminalRecoveryWriterContext(options = {}) {
  return createRecoveryWriterContext(options, TERMINAL_WRITER_PINS)
}

/**
 * Normalize one canonical-draft Release read onto the exact fields this
 * boundary fences. Either pinned title is accepted — the draft is read both
 * before and after the abandonment stamp — but every other projected field is
 * pinned, so drift fails closed rather than being observed.
 */
export function normalizeTerminalReleaseSnapshot({ release, rawAssets, releaseId }) {
  if (
    releaseId !== CANONICAL_RELEASE_ID ||
    !isObject(release) ||
    release.id !== CANONICAL_RELEASE_ID ||
    release.tag_name !== CANONICAL_TAG_NAME ||
    !CANONICAL_TITLES.includes(release.name) ||
    !isBoundedText(release.body, 512 * 1024, true) ||
    release.draft !== true ||
    release.prerelease !== false ||
    release.immutable !== false ||
    release.target_commitish !== "main" ||
    !Array.isArray(rawAssets)
  ) {
    writeFail("RELEASE_MALFORMED", "Canonical Release snapshot is malformed")
  }
  // GitHub lists assets sorted by name and "abandonment.json" sorts among the
  // base assets, so partition by name: the tombstone is always last, which
  // makes the "first 45 are base, the tail is the tombstone" contract true by
  // construction whatever order the listing arrives in.
  const baseAssets = []
  let tombstone = null
  const assetIds = new Set()
  const assetNames = new Set()
  for (const rawAsset of rawAssets) {
    if (
      !isObject(rawAsset) ||
      !Number.isSafeInteger(rawAsset.id) ||
      rawAsset.id < 1 ||
      assetIds.has(rawAsset.id) ||
      typeof rawAsset.name !== "string" ||
      !RECOVERY_ASSET_NAME_PATTERN.test(rawAsset.name) ||
      assetNames.has(rawAsset.name) ||
      typeof rawAsset.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(rawAsset.digest) ||
      !Number.isSafeInteger(rawAsset.size) ||
      rawAsset.size < 1
    ) {
      writeFail("RELEASE_ASSETS_MALFORMED", "Canonical Release asset inventory is malformed")
    }
    assetIds.add(rawAsset.id)
    assetNames.add(rawAsset.name)
    const normalized = {
      id: rawAsset.id,
      name: rawAsset.name,
      sha256: rawAsset.digest.slice(7),
      size: rawAsset.size,
    }
    if (normalized.name === TOMBSTONE_ASSET_NAME) {
      tombstone = normalized
      continue
    }
    baseAssets.push(normalized)
  }
  if (baseAssets.length !== CANONICAL_BASE_ASSET_COUNT) {
    writeFail("RELEASE_ASSETS_MALFORMED", "Canonical Release asset inventory is not exact")
  }
  return deepFreeze({
    releaseId: CANONICAL_RELEASE_ID,
    tagName: CANONICAL_TAG_NAME,
    name: release.name,
    targetCommitish: release.target_commitish,
    draft: release.draft,
    immutable: release.immutable,
    body: release.body,
    assets: tombstone === null ? baseAssets : [...baseAssets, tombstone],
  })
}

/**
 * Project a canonical-draft snapshot onto the exact fields the write fences
 * hash. The title is deliberately part of the projection: the abandonment
 * stamp changes it, so the pre-write (escrow) and post-write (abandoned)
 * fence digests differ by design and a fence pair that hashes equal is proof
 * the stamp did not land.
 */
export function normalizeTerminalReleaseProjection(value) {
  const source = snapshotJson(value)
  if (
    !isObject(source) ||
    source.releaseId !== CANONICAL_RELEASE_ID ||
    source.tagName !== CANONICAL_TAG_NAME ||
    !CANONICAL_TITLES.includes(source.name) ||
    source.targetCommitish !== "main" ||
    source.draft !== true ||
    source.immutable !== false ||
    typeof source.body !== "string" ||
    !Array.isArray(source.assets)
  ) {
    throw new TypeError("Canonical Release projection metadata is not exact")
  }
  const assets = source.assets.map((asset, index) => {
    if (
      !isObject(asset) ||
      !Number.isSafeInteger(asset.id) ||
      asset.id < 1 ||
      typeof asset.name !== "string" ||
      !RECOVERY_ASSET_NAME_PATTERN.test(asset.name) ||
      typeof asset.sha256 !== "string" ||
      !RECOVERY_SHA256_PATTERN.test(asset.sha256) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1
    ) {
      throw new TypeError(`Canonical Release projection asset[${index}] is invalid`)
    }
    return { id: asset.id, name: asset.name, sha256: asset.sha256, size: asset.size }
  })
  if (
    new Set(assets.map(({ id }) => id)).size !== assets.length ||
    new Set(assets.map(({ name }) => name)).size !== assets.length
  ) {
    throw new TypeError("Canonical Release projection assets are not unique")
  }
  return deepFreeze({
    releaseId: source.releaseId,
    tagName: source.tagName,
    name: source.name,
    targetCommitish: source.targetCommitish,
    draft: source.draft,
    immutable: source.immutable,
    body: source.body,
    assets,
  })
}

/** Hash the exact canonical writer-fence projection without transport fields. */
export function terminalReleaseProjectionSha256(value) {
  return sha256(JSON.stringify(canonicalize(normalizeTerminalReleaseProjection(value))))
}

/**
 * Build the immutable terminal-recovery mutation boundary for the v0.8.22
 * canonical draft. It can name exactly one Release, upload exactly one asset
 * name, and issue exactly one kind of PATCH.
 */
export function createTerminalRecoveryWriter(options = {}) {
  const context = createTerminalRecoveryWriterContext(options)

  return Object.freeze({
    async readCanonicalSnapshot() {
      const current = await readCurrentWriterObservation(context, CANONICAL_RELEASE_ID, undefined)
      return current.snapshot
    },

    async uploadTombstoneIfAbsentAndEqual(input) {
      const args = snapshotTombstoneInput(input, context.token)
      const expected = normalizeExpectedTerminalSnapshot(args.expectedSnapshot)
      assertExpectedTagObjectSha(args.expectedTagObjectSha)
      if (
        typeof args.sha256 !== "string" ||
        !RECOVERY_SHA256_PATTERN.test(args.sha256) ||
        sha256(args.bytes) !== args.sha256
      ) {
        throw new TypeError("Recovery tombstone digest is not exact")
      }
      const current = (await readExpectedWriterObservation(context, expected, undefined)).snapshot
      const existing = current.assets.find(({ name }) => name === TOMBSTONE_ASSET_NAME) ?? null
      if (existing !== null) {
        if (existing.sha256 !== args.sha256 || existing.size !== args.bytes.byteLength) {
          writeFail("TOMBSTONE_ASSET_CONFLICT", "Existing abandonment tombstone differs")
        }
        await verifyRecoveryCandidateTag(context, args.expectedTagObjectSha)
        return deepFreeze({
          releaseId: CANONICAL_RELEASE_ID,
          assetId: existing.id,
          name: TOMBSTONE_ASSET_NAME,
          status: "existing",
          sha256: args.sha256,
        })
      }

      await verifyRecoveryCandidateTag(context, args.expectedTagObjectSha)
      const observation = await observeIssuedRecoveryMutation(
        context,
        () =>
          requestRecoveryJson(context, {
            url: `${RECOVERY_UPLOAD_ORIGIN}/repos/${RECOVERY_OWNER}/${RECOVERY_REPOSITORY}/releases/${CANONICAL_RELEASE_ID}/assets?name=${TOMBSTONE_ASSET_NAME}`,
            method: "POST",
            bytes: args.bytes,
            contentType: "application/octet-stream",
            maximumRequestBytes: args.bytes.byteLength,
          }),
        {
          releaseId: CANONICAL_RELEASE_ID,
          originalBody: undefined,
          expectedTagObjectSha: args.expectedTagObjectSha,
        },
      )
      const { response, snapshot: postSnapshot } = requireExactMutationObservation(observation)
      let created
      try {
        if (response.httpStatus !== 201) throw new TypeError("Unexpected upload status")
        created = normalizeUploadResponse(response.body, {
          name: TOMBSTONE_ASSET_NAME,
          sha256: args.sha256,
          bytes: args.bytes,
        })
      } catch {
        writeFail("MUTATION_OUTCOME_AMBIGUOUS", "GitHub recovery mutation outcome is ambiguous")
      }
      assertExactObservedMutationState(postSnapshot, {
        ...current,
        assets: [
          ...current.assets,
          {
            id: created.id,
            name: TOMBSTONE_ASSET_NAME,
            sha256: args.sha256,
            size: args.bytes.byteLength,
          },
        ],
      })
      return deepFreeze({
        releaseId: CANONICAL_RELEASE_ID,
        assetId: created.id,
        name: TOMBSTONE_ASSET_NAME,
        status: "uploaded",
        sha256: args.sha256,
      })
    },

    async abandonCandidateIfCurrent(input) {
      const args = snapshotExactWriterInput(
        input,
        [
          "expectedSnapshot",
          "expectedTagObjectSha",
          "expectedBodySha256",
          "expectedName",
          "expectedBody",
        ],
        "abandon",
      )
      assertExpectedTagObjectSha(args.expectedTagObjectSha)
      assertAbandonmentStamp(args, context.token)
      const expected = normalizeExpectedTerminalSnapshot(args.expectedSnapshot)
      assertAbandonableSnapshot(expected, args)
      const baseline = await readExpectedWriterObservation(context, expected, undefined)
      const preWrite = await readWriterPreWriteFence(
        context,
        expected,
        undefined,
        baseline.projection,
        args.expectedTagObjectSha,
      )
      const current = preWrite.snapshot
      assertAbandonableSnapshot(current, args)
      const observation = await observeIssuedRecoveryMutation(
        context,
        () =>
          requestRecoveryJson(context, {
            url: `${RECOVERY_API_ORIGIN}/repos/${RECOVERY_OWNER}/${RECOVERY_REPOSITORY}/releases/${CANONICAL_RELEASE_ID}`,
            method: "PATCH",
            body: { name: args.expectedName, body: args.expectedBody },
            contentType: "application/json",
            maximumRequestBytes: MAX_ABANDONMENT_REQUEST_BYTES,
          }),
        {
          releaseId: CANONICAL_RELEASE_ID,
          originalBody: undefined,
          expectedTagObjectSha: args.expectedTagObjectSha,
          recordFence: true,
        },
      )
      const {
        response,
        snapshot: postSnapshot,
        projection: postProjection,
        tagObjectSha: postTagObjectSha,
        observedAt: postObservedAt,
      } = requireExactMutationObservation(observation)
      try {
        if (response.httpStatus !== 200) throw new TypeError("Unexpected abandonment status")
        normalizePatchResponse(
          response.body,
          current,
          { name: args.expectedName, body: args.expectedBody },
          { code: "ABANDONMENT_RESPONSE_MALFORMED", message: "Abandonment response is malformed" },
        )
      } catch {
        writeFail("MUTATION_OUTCOME_AMBIGUOUS", "GitHub recovery mutation outcome is ambiguous")
      }
      assertExactObservedMutationState(postSnapshot, {
        ...current,
        name: args.expectedName,
        body: args.expectedBody,
      })
      assertExactObservedMutationState(postProjection, {
        ...preWrite.projection,
        name: args.expectedName,
        body: args.expectedBody,
      })
      return deepFreeze({
        atomic: false,
        releaseId: CANONICAL_RELEASE_ID,
        outcome: "performed",
        preWriteFence: preWrite.fence,
        postWriteFence: canonicalWriterFence(
          context,
          postObservedAt,
          postProjection,
          postTagObjectSha,
        ),
      })
    },
  })
}

function snapshotTombstoneInput(value, token) {
  if (!isObject(value)) throw new TypeError("Recovery tombstone input schema is invalid")
  assertExactDataFields(
    value,
    ["expectedSnapshot", "expectedTagObjectSha", "bytes", "sha256"],
    "Recovery tombstone input",
  )
  const bytes = snapshotExactEvidenceBytes(Object.getOwnPropertyDescriptor(value, "bytes").value)
  if (bytes.includes(Buffer.from(token, "utf8"))) {
    throw new TypeError("Recovery tombstone bytes contain configured credentials")
  }
  return {
    expectedSnapshot: snapshotJson(
      Object.getOwnPropertyDescriptor(value, "expectedSnapshot").value,
    ),
    expectedTagObjectSha: Object.getOwnPropertyDescriptor(value, "expectedTagObjectSha").value,
    bytes,
    sha256: Object.getOwnPropertyDescriptor(value, "sha256").value,
  }
}

/**
 * Validate the exact abandonment stamp before any read. The credential checks
 * run first so a leaked token is reported as a leak rather than as a title or
 * body shape error.
 */
function assertAbandonmentStamp(args, token) {
  const credential = Buffer.from(token, "utf8")
  for (const [field, label] of [
    ["expectedName", "abandonment title"],
    ["expectedBody", "abandonment body"],
  ]) {
    const value = args[field]
    if (typeof value === "string" && Buffer.from(value, "utf8").includes(credential)) {
      throw new TypeError(`Expected ${label} contains configured credentials`)
    }
  }
  if (args.expectedName !== CANONICAL_ABANDONED_TITLE) {
    throw new TypeError("Expected abandonment title is not the canonical stamp")
  }
  if (
    typeof args.expectedBody !== "string" ||
    args.expectedBody.length === 0 ||
    Buffer.byteLength(args.expectedBody, "utf8") > MAX_ABANDONMENT_BODY_BYTES
  ) {
    throw new TypeError("Expected abandonment body is invalid")
  }
}

/**
 * The canonical draft is abandonable only while it still carries the escrow
 * title, the exact escrowed body, and its abandonment tombstone: the evidence
 * must be durable before the body that points at it is replaced.
 */
function assertAbandonableSnapshot(snapshot, args) {
  if (snapshot.name !== CANONICAL_ESCROW_TITLE) {
    throw new TypeError("Canonical draft is not in its escrowed state")
  }
  if (
    typeof args.expectedBodySha256 !== "string" ||
    !RECOVERY_SHA256_PATTERN.test(args.expectedBodySha256) ||
    sha256(snapshot.body) !== args.expectedBodySha256
  ) {
    throw new TypeError("Expected canonical draft body digest is stale")
  }
  const tombstone = snapshot.assets.at(-1)
  if (
    snapshot.assets.length !== CANONICAL_BASE_ASSET_COUNT + 1 ||
    tombstone === undefined ||
    tombstone.name !== TOMBSTONE_ASSET_NAME
  ) {
    throw new TypeError("Canonical draft is missing its abandonment tombstone")
  }
}

function normalizeExpectedTerminalSnapshot(value) {
  let snapshot
  try {
    snapshot = snapshotJson(value)
  } catch {
    throw new TypeError("Expected canonical snapshot is invalid")
  }
  if (
    !hasExactFields(snapshot, [
      "releaseId",
      "tagName",
      "name",
      "targetCommitish",
      "draft",
      "immutable",
      "body",
      "assets",
    ])
  ) {
    throw new TypeError("Expected canonical snapshot schema is invalid")
  }
  normalizeTerminalReleaseProjection(snapshot)
  const tombstones = snapshot.assets.filter(({ name }) => name === TOMBSTONE_ASSET_NAME)
  if (
    snapshot.assets.length !== CANONICAL_BASE_ASSET_COUNT + tombstones.length ||
    tombstones.length > 1 ||
    (tombstones.length === 1 && snapshot.assets.at(-1).name !== TOMBSTONE_ASSET_NAME)
  ) {
    throw new TypeError("Expected canonical asset inventory is not exact")
  }
  return deepFreeze(snapshot)
}

/** Preserve the exact frozen terminal-writer capability surface. */
export function assertTerminalRecoveryWriter(value) {
  if (
    !isObject(value) ||
    !Object.isFrozen(value) ||
    !sameJson(Object.keys(value).sort(), [
      "abandonCandidateIfCurrent",
      "readCanonicalSnapshot",
      "uploadTombstoneIfAbsentAndEqual",
    ]) ||
    Object.values(value).some((method) => typeof method !== "function")
  ) {
    throw new TypeError("Terminal recovery writer surface is not exact")
  }
  return value
}
