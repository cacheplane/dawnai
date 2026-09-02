import { createHash } from "node:crypto"

import { snapshotJson } from "./adapter-normalize.mjs"
import { createGitReader } from "./adapters/git.mjs"
import { createGitHubReader } from "./adapters/github.mjs"
import {
  createHttpGet,
  DEFAULT_HTTP_MAX_RESPONSE_BYTES,
  DEFAULT_HTTP_TIMEOUT_MS,
} from "./adapters/http.mjs"
import { createNpmReader } from "./adapters/npm.mjs"
import {
  canonicalRecoveryNotice,
  canonicalRecoveryReceipt,
  DUPLICATE_DRAFT_RECOVERY_POLICY,
  originalBodyAssetName,
  recoveryReceiptAssetName,
} from "./duplicate-draft-recovery.mjs"
import { parseReleaseMarker } from "./metadata.mjs"

const OWNER = "cacheplane"
const REPOSITORY = "dawnai"
const REPOSITORY_ID = "1210070282"
const API_ORIGIN = "https://api.github.com"
const UPLOAD_ORIGIN = "https://uploads.github.com"
const API_VERSION = "2022-11-28"
const RELEASE_WORKFLOW_ID = 260503756
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml"
const CANDIDATE_TAG = `v${DUPLICATE_DRAFT_RECOVERY_POLICY.version}`
const CANDIDATE_RELEASE_IDS = new Set([
  DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId,
  ...DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates.map(({ releaseId }) => releaseId),
])
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const MAX_PAGES = 100
const MAX_RECORDS = 10_000
const RECOVERY_ASSET_BYTES = 64 * 1024
const WRITER_MAX_TIMEOUT_MS = 300_000
const WRITER_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const WRITER_MAX_RESPONSE_CHUNKS = 1_024
const WRITER_TITLE = `Dawn v${DUPLICATE_DRAFT_RECOVERY_POLICY.version}`
const DUPLICATE_TAG_BY_ID = new Map(
  DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates.map(({ releaseId, tagName }) => [releaseId, tagName]),
)
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype)
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
).get
const NONTERMINAL_STATUSES = new Set(["requested", "waiting", "pending", "queued", "in_progress"])
const RUN_STATUSES = new Set([...NONTERMINAL_STATUSES, "completed"])
const JOB_STATUSES = new Set(["waiting", "pending", "queued", "in_progress", "completed"])
const TERMINAL_CONCLUSIONS = new Set([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
])
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u
const ASSET_NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/u
const UNSAFE_REMOTE_KEYS = new Set(["__proto__", "constructor", "prototype"])

export class DuplicateDraftRecoveryReadError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "DuplicateDraftRecoveryReadError"
    this.code = code
  }
}

/** Build the immutable, read-only production boundary used by recovery capture. */
export function createDuplicateDraftRecoveryReader({
  root,
  token,
  fetchImpl = fetch,
  run,
  timeoutMs,
  maxResponseBytes = DEFAULT_HTTP_MAX_RESPONSE_BYTES,
  now = Date.now,
} = {}) {
  const git = createGitReader({
    root,
    ...(run === undefined ? {} : { run }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
  const github = createGitHubReader({
    owner: OWNER,
    repo: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    ...(token === undefined ? {} : { token }),
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    maxResponseBytes,
    maxPages: MAX_PAGES,
    maxRecords: MAX_RECORDS,
    now,
  })
  const npm = createNpmReader({
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    maxResponseBytes,
  })
  const http = createHttpGet({
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    maxResponseBytes,
  })
  const context = {
    git,
    github,
    npm,
    http,
    token: token ?? null,
    timeoutMs: timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    maxResponseBytes,
    now,
  }

  return Object.freeze({
    async readReviewedMergeAuthority(reviewedCommit) {
      assertSha(reviewedCommit, "reviewed commit")
      const [localHistory, repository, pullRequests, mergeCommit] = await Promise.all([
        readBoundary("LOCAL_HEAD_UNAVAILABLE", () =>
          git.listFirstParentHistory({ ref: "HEAD", maxCount: 1 }),
        ),
        readRepositoryState(context),
        readExactJson(context, {
          path: `/repos/${OWNER}/${REPOSITORY}/commits/${reviewedCommit}/pulls?per_page=2`,
          operation: "reviewed-associated-pull-request",
          accept: "application/vnd.github+json",
        }),
        readExactJson(context, {
          path: `/repos/${OWNER}/${REPOSITORY}/git/commits/${reviewedCommit}`,
          operation: "reviewed-merge-commit",
        }),
      ])
      if (localHistory.length !== 1 || localHistory[0] !== reviewedCommit) {
        fail("REVIEWED_COMMIT_NOT_LOCAL_HEAD", "Reviewed recovery commit is not local HEAD")
      }
      if (repository.mainSha !== reviewedCommit) {
        fail("REVIEWED_COMMIT_NOT_REMOTE_MAIN", "Reviewed recovery commit is not remote main")
      }
      if (!Array.isArray(pullRequests) || pullRequests.length !== 1) {
        fail(
          "REVIEWED_PULL_REQUEST_AMBIGUOUS",
          "Reviewed recovery commit must have exactly one associated pull request",
        )
      }
      const pullRequest = normalizeReviewedPullRequest(pullRequests[0], reviewedCommit)
      const [headCommit, ci] = await Promise.all([
        readExactJson(context, {
          path: `/repos/${OWNER}/${REPOSITORY}/git/commits/${pullRequest.reviewedHeadSha}`,
          operation: "reviewed-head-commit",
        }),
        readRequiredCi(context, pullRequest.reviewedHeadSha),
      ])
      const mergeTreeSha = commitTreeSha(mergeCommit, reviewedCommit, "merge")
      const reviewedTreeSha = commitTreeSha(
        headCommit,
        pullRequest.reviewedHeadSha,
        "pull request head",
      )
      if (mergeTreeSha !== reviewedTreeSha) {
        fail("REVIEWED_TREE_MISMATCH", "Reviewed and merged recovery trees are not identical")
      }
      return deepFreeze({
        mergeCommitSha: reviewedCommit,
        mergeTreeSha,
        pullRequestNumber: pullRequest.pullRequestNumber,
        reviewedHeadSha: pullRequest.reviewedHeadSha,
        reviewedTreeSha,
        validateRunId: ci.validateRunId,
      })
    },

    readRepositoryState() {
      return readRepositoryState(context)
    },

    async readCandidateTag() {
      const ref = requirePresent(
        await github.getRef({ ref: `tags/${CANDIDATE_TAG}` }),
        "CANDIDATE_TAG_UNAVAILABLE",
        "Candidate tag could not be verified",
      )
      if (
        !isObject(ref) ||
        ref.ref !== `refs/tags/${CANDIDATE_TAG}` ||
        !isObject(ref.object) ||
        ref.object.type !== "tag" ||
        !isSha(ref.object.sha)
      ) {
        fail("CANDIDATE_TAG_MALFORMED", "Candidate tag evidence is malformed")
      }
      const tag = requirePresent(
        await github.getGitTag({ tagSha: ref.object.sha }),
        "CANDIDATE_TAG_UNAVAILABLE",
        "Candidate tag could not be verified",
      )
      if (
        !isObject(tag) ||
        tag.sha !== ref.object.sha ||
        tag.tag !== CANDIDATE_TAG ||
        !isObject(tag.object) ||
        tag.object.type !== "commit" ||
        tag.object.sha !== DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha
      ) {
        fail("CANDIDATE_TAG_CONFLICT", "Candidate tag identity is not exact")
      }
      return deepFreeze({
        version: DUPLICATE_DRAFT_RECOVERY_POLICY.version,
        commitSha: DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha,
        tagObjectSha: ref.object.sha,
      })
    },

    async readWorkflowState() {
      const value = await readExactJson(context, {
        path: `/repos/${OWNER}/${REPOSITORY}/actions/workflows/${RELEASE_WORKFLOW_ID}`,
        operation: "release-workflow",
      })
      if (
        !isObject(value) ||
        value.id !== RELEASE_WORKFLOW_ID ||
        value.path !== RELEASE_WORKFLOW_PATH ||
        value.state !== "disabled_manually"
      ) {
        fail("RELEASE_WORKFLOW_CONFLICT", "Release workflow state is not exact")
      }
      return deepFreeze({ id: RELEASE_WORKFLOW_ID, state: "disabled_manually" })
    },

    async readImmutableReleases() {
      const value = await readExactJson(context, {
        path: `/repos/${OWNER}/${REPOSITORY}/immutable-releases`,
        operation: "immutable-releases",
      })
      if (!isObject(value) || value.enabled !== true) {
        fail("IMMUTABLE_RELEASES_DISABLED", "Immutable Releases is not enabled")
      }
      return deepFreeze({ enabled: true })
    },

    async readReleaseRuns() {
      const rawRuns = await readStrictPages(context, {
        path: `/repos/${OWNER}/${REPOSITORY}/actions/workflows/${RELEASE_WORKFLOW_ID}/runs?per_page=100`,
        operation: "RELEASE_RUNS",
        field: "workflow_runs",
        requireTotalCount: true,
      })
      const runs = normalizeReleaseRuns(rawRuns)
      const candidateRuns = runs.filter(
        (run) => run.headSha === DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha,
      )
      return deepFreeze({ runs, candidateRuns })
    },

    async readCandidatePublishJobs(runId, runAttempt) {
      assertPositiveInteger(runId, "candidate workflow run ID")
      assertPositiveInteger(runAttempt, "candidate workflow run attempt")
      const jobs = await readStrictPages(context, {
        path: `/repos/${OWNER}/${REPOSITORY}/actions/runs/${runId}/jobs?filter=all&per_page=100`,
        operation: "CANDIDATE_JOBS",
        field: "jobs",
        requireTotalCount: true,
      })
      return deepFreeze(normalizeCandidateJobs(jobs, runId, runAttempt))
    },

    async readNpmAbsence(name) {
      const result = await npm.observePackageVersion({
        name,
        version: DUPLICATE_DRAFT_RECOVERY_POLICY.version,
      })
      if (
        result?.status !== "ABSENT" ||
        result.operation !== "package-version" ||
        result.httpStatus !== 404 ||
        result.code !== "E404"
      ) {
        fail("NPM_VERSION_NOT_ABSENT", "Exact npm package version absence could not be verified")
      }
      return deepFreeze({
        name,
        version: DUPLICATE_DRAFT_RECOVERY_POLICY.version,
        status: "absent",
      })
    },

    async readReleaseSnapshot(releaseId, { expectedOriginalBody } = {}) {
      assertPositiveInteger(releaseId, "Release ID")
      if (expectedOriginalBody !== undefined && typeof expectedOriginalBody !== "string") {
        throw new TypeError("Expected original Release body is invalid")
      }
      const release = requirePresent(
        await github.getRelease({ releaseId }),
        "RELEASE_UNAVAILABLE",
        "Release snapshot could not be verified",
      )
      const rawAssets = await readStrictPages(context, {
        path: `/repos/${OWNER}/${REPOSITORY}/releases/${releaseId}/assets?per_page=100`,
        operation: "RELEASE_ASSETS",
      })
      return normalizeReleaseSnapshot({
        release,
        rawAssets,
        releaseId,
        expectedOriginalBody,
        github,
        token: context.token,
      })
    },

    async listCandidateReleases() {
      const releases = await readStrictPages(context, {
        path: `/repos/${OWNER}/${REPOSITORY}/releases?per_page=100`,
        operation: "RELEASE_LIST",
      })
      const candidates = []
      const releaseIds = new Set()
      for (const raw of releases) {
        const release = normalizeReleaseRow(raw)
        if (releaseIds.has(release.id)) {
          fail("PAGINATION_DRIFT", "Release inventory contains a repeated ID")
        }
        releaseIds.add(release.id)
        const marker = releaseMarker(release.body)
        if (
          marker === null &&
          typeof release.body === "string" &&
          release.body.includes("DAWN_RELEASE_CONTROLLER_MARKER")
        ) {
          fail("RELEASE_LIST_MALFORMED", "Release inventory contains a malformed Dawn marker")
        }
        const identifiesCandidate =
          CANDIDATE_RELEASE_IDS.has(release.id) ||
          release.tagName === CANDIDATE_TAG ||
          (marker !== null && marker.tag === CANDIDATE_TAG)
        if (identifiesCandidate) {
          candidates.push({
            releaseId: release.id,
            tagName: release.tagName,
            draft: release.draft,
            prerelease: release.prerelease,
            immutable: release.immutable,
            targetCommitish: release.targetCommitish,
            marker,
          })
        }
      }
      return deepFreeze(candidates.sort((left, right) => left.releaseId - right.releaseId))
    },
  })
}

/** Build the immutable, candidate-specific production mutation boundary. */
export function createDuplicateDraftRecoveryWriter(options = {}) {
  const config = snapshotWriterOptions(options)
  const token = config.token
  const fetchImpl = config.fetchImpl ?? fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  const maxResponseBytes = config.maxResponseBytes ?? WRITER_MAX_RESPONSE_BYTES
  const observedNow = config.now ?? Date.now
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 4096 ||
    hasUnsafeTokenCharacters(token)
  ) {
    throw new TypeError("Invalid GitHub token")
  }
  if (typeof fetchImpl !== "function") throw new TypeError("Recovery writer fetch is invalid")
  if (typeof observedNow !== "function") throw new TypeError("Recovery writer clock is invalid")
  assertBoundedInteger(timeoutMs, 1, WRITER_MAX_TIMEOUT_MS, "Recovery writer timeout")
  assertBoundedInteger(
    maxResponseBytes,
    1,
    WRITER_MAX_RESPONSE_BYTES,
    "Recovery writer response limit",
  )
  const strictFetchImpl = createStrictCredentialFetch(fetchImpl, token, maxResponseBytes, timeoutMs)
  const github = createGitHubReader({
    owner: OWNER,
    repo: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    fetchImpl: strictFetchImpl,
    timeoutMs,
    maxResponseBytes,
    now: Date.now,
    maxPages: MAX_PAGES,
    maxRecords: MAX_RECORDS,
  })
  const http = createHttpGet({ fetchImpl: strictFetchImpl, timeoutMs, maxResponseBytes })
  const context = Object.freeze({
    token,
    github,
    http,
    fetchImpl: strictFetchImpl,
    timeoutMs,
    maxResponseBytes,
    now: Date.now,
    observedNow,
    strictCredentials: true,
  })

  return Object.freeze({
    async uploadEvidenceAssetIfAbsentAndEqual(input) {
      const args = snapshotRecoveryAssetInput(input, token)
      const expected = normalizeExpectedWriterSnapshot(args.expectedSnapshot)
      const releaseId = expected.releaseId
      const kind = validateEvidenceUpload(expected, args)
      const current = await readExpectedWriterSnapshot(context, expected, expected.body)
      const existing = current.assets.find((asset) => asset.name === args.name) ?? null
      if (existing !== null) {
        assertExistingEvidenceAsset(existing, args, kind)
        await verifyRecoveryCandidateTag(context, args.expectedTagObjectSha)
        return deepFreeze({
          releaseId,
          assetId: existing.id,
          name: args.name,
          status: "existing",
          sha256: args.sha256,
        })
      }

      await verifyRecoveryCandidateTag(context, args.expectedTagObjectSha)
      const observation = await observeIssuedRecoveryMutation(
        context,
        () =>
          requestRecoveryJson(context, {
            url: `${UPLOAD_ORIGIN}/repos/${OWNER}/${REPOSITORY}/releases/${releaseId}/assets?name=${encodeURIComponent(args.name)}`,
            method: "POST",
            bytes: args.bytes,
            contentType: "application/octet-stream",
            maximumRequestBytes: RECOVERY_ASSET_BYTES,
          }),
        {
          releaseId,
          originalBody: current.body,
          expectedTagObjectSha: args.expectedTagObjectSha,
        },
      )
      const { response, snapshot: postSnapshot } = requireExactMutationObservation(observation)
      let created
      try {
        if (response.httpStatus !== 201) {
          throw new TypeError("Unexpected upload status")
        }
        created = normalizeUploadResponse(response.body, args)
      } catch {
        writeFail("MUTATION_OUTCOME_AMBIGUOUS", "GitHub recovery mutation outcome is ambiguous")
      }
      const appendedAsset = {
        id: created.id,
        name: args.name,
        sha256: args.sha256,
        ...(kind === "receipt" ? { bytes: args.bytes.toString("utf8") } : {}),
      }
      const expectedAfter = {
        ...current,
        assets: [...current.assets, appendedAsset],
        evidenceAssets: [...current.evidenceAssets, kind],
      }
      assertExactObservedMutationState(postSnapshot, expectedAfter)
      return deepFreeze({
        releaseId,
        assetId: created.id,
        name: args.name,
        status: "uploaded",
        sha256: args.sha256,
      })
    },

    async quarantineDuplicateBodyIfCurrent(input) {
      const args = snapshotExactWriterInput(
        input,
        ["expectedSnapshot", "expectedTagObjectSha", "expectedBodySha256", "expectedNotice"],
        "quarantine",
      )
      const expected = normalizeExpectedWriterSnapshot(args.expectedSnapshot)
      assertExpectedTagObjectSha(args.expectedTagObjectSha)
      if (Buffer.from(args.expectedNotice, "utf8").includes(Buffer.from(token, "utf8"))) {
        throw new TypeError("Recovery notice contains configured credentials")
      }
      validateQuarantineInput(expected, args)
      const baseline = await readExpectedWriterObservation(context, expected, expected.body)
      const preWrite = await readQuarantinePreWriteFence(
        context,
        expected,
        expected.body,
        baseline.projection,
        args.expectedTagObjectSha,
      )
      const current = preWrite.snapshot
      const observation = await observeIssuedRecoveryMutation(
        context,
        () =>
          requestRecoveryJson(context, {
            url: `${API_ORIGIN}/repos/${OWNER}/${REPOSITORY}/releases/${current.releaseId}`,
            method: "PATCH",
            body: { body: args.expectedNotice },
            contentType: "application/json",
            maximumRequestBytes: 16 * 1024,
          }),
        {
          releaseId: current.releaseId,
          originalBody: current.body,
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
        if (response.httpStatus !== 200) throw new TypeError("Unexpected quarantine status")
        normalizePatchResponse(response.body, current, args.expectedNotice)
      } catch {
        writeFail("MUTATION_OUTCOME_AMBIGUOUS", "GitHub recovery mutation outcome is ambiguous")
      }
      const expectedAfter = {
        ...current,
        body: args.expectedNotice,
        marker: null,
      }
      assertExactObservedMutationState(postSnapshot, expectedAfter)
      assertExactObservedMutationState(postProjection, {
        ...preWrite.projection,
        body: args.expectedNotice,
      })
      return deepFreeze({
        atomic: false,
        releaseId: current.releaseId,
        outcome: "performed",
        preWriteFence: preWrite.fence,
        postWriteFence: canonicalWriterFence(postObservedAt, postProjection, postTagObjectSha),
      })
    },
  })
}

function snapshotWriterOptions(value) {
  if (!isPlainObject(value)) throw new TypeError("Recovery writer options schema is invalid")
  const allowed = new Set(["token", "fetchImpl", "timeoutMs", "maxResponseBytes", "now"])
  const result = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError("Recovery writer options schema is invalid")
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!isEnumerableData(descriptor)) {
      throw new TypeError("Recovery writer options contain an accessor")
    }
    result[key] = descriptor.value
  }
  return result
}

function snapshotRecoveryAssetInput(value, token) {
  if (!isPlainObject(value)) throw new TypeError("Recovery asset input schema is invalid")
  const expectedFields = ["expectedSnapshot", "expectedTagObjectSha", "name", "bytes", "sha256"]
  assertExactDataFields(value, expectedFields, "Recovery asset input")
  const expectedTagObjectSha = Object.getOwnPropertyDescriptor(value, "expectedTagObjectSha").value
  assertExpectedTagObjectSha(expectedTagObjectSha)
  const copied = snapshotExactEvidenceBytes(Object.getOwnPropertyDescriptor(value, "bytes").value)
  if (copied.includes(Buffer.from(token, "utf8"))) {
    throw new TypeError("Recovery evidence bytes contain configured credentials")
  }
  return {
    expectedSnapshot: snapshotJson(
      Object.getOwnPropertyDescriptor(value, "expectedSnapshot").value,
    ),
    expectedTagObjectSha,
    name: Object.getOwnPropertyDescriptor(value, "name").value,
    bytes: copied,
    sha256: Object.getOwnPropertyDescriptor(value, "sha256").value,
  }
}

function snapshotExactEvidenceBytes(value) {
  let prototype
  let byteLength
  try {
    byteLength = TYPED_ARRAY_BYTE_LENGTH.call(value)
    prototype = Object.getPrototypeOf(value)
    if (prototype !== Buffer.prototype && prototype !== Uint8Array.prototype) {
      throw new TypeError("Unexpected byte container prototype")
    }
  } catch {
    throw new TypeError("Recovery evidence bytes are invalid")
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > RECOVERY_ASSET_BYTES) {
    throw new TypeError("Recovery evidence bytes are invalid")
  }
  let keys
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    throw new TypeError("Recovery evidence bytes are invalid")
  }
  if (keys.length !== byteLength) throw new TypeError("Recovery evidence bytes are invalid")
  for (let index = 0; index < byteLength; index += 1) {
    const key = keys[index]
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null
    if (key !== String(index) || !isEnumerableData(descriptor)) {
      throw new TypeError("Recovery evidence bytes are invalid")
    }
  }
  try {
    return Buffer.from(Uint8Array.prototype.slice.call(value))
  } catch {
    throw new TypeError("Recovery evidence bytes are invalid")
  }
}

function snapshotExactWriterInput(value, fields, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} input schema is invalid`)
  assertExactDataFields(value, fields, `${label} input`)
  const source = {}
  for (const field of fields) source[field] = Object.getOwnPropertyDescriptor(value, field).value
  try {
    return deepFreeze(snapshotJson(source))
  } catch {
    throw new TypeError(`${label} input schema is invalid`)
  }
}

function assertExactDataFields(value, fields, label) {
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
    fields.some((field) => !isEnumerableData(Object.getOwnPropertyDescriptor(value, field)))
  ) {
    throw new TypeError(`${label} schema is invalid`)
  }
}

function isEnumerableData(descriptor) {
  return (
    descriptor?.enumerable === true &&
    "value" in descriptor &&
    descriptor.get === undefined &&
    descriptor.set === undefined
  )
}

function assertExpectedTagObjectSha(value) {
  if (!isSha(value)) throw new TypeError("Expected candidate tag object SHA is invalid")
}

function normalizeExpectedWriterSnapshot(value) {
  let snapshot
  try {
    snapshot = snapshotJson(value)
  } catch {
    throw new TypeError("Expected recovery snapshot is invalid")
  }
  const fields = ["releaseId", "tagName", "body", "marker", "assets", "evidenceAssets"]
  if (!hasExactFields(snapshot, fields)) {
    throw new TypeError("Expected recovery snapshot schema is invalid")
  }
  const expectedTag = DUPLICATE_TAG_BY_ID.get(snapshot.releaseId)
  if (expectedTag === undefined || snapshot.tagName !== expectedTag) {
    throw new TypeError("Recovery mutation target is not an approved duplicate Release")
  }
  if (!isBoundedText(snapshot.body, 512 * 1024, true)) {
    throw new TypeError("Expected recovery body is invalid")
  }
  if (!Array.isArray(snapshot.assets) || !Array.isArray(snapshot.evidenceAssets)) {
    throw new TypeError("Expected recovery asset inventory is invalid")
  }
  const expectedKinds = snapshot.evidenceAssets
  if (
    expectedKinds.length > 2 ||
    expectedKinds.some((kind) => kind !== "body" && kind !== "receipt") ||
    new Set(expectedKinds).size !== expectedKinds.length ||
    (expectedKinds.includes("receipt") && !expectedKinds.includes("body"))
  ) {
    throw new TypeError("Expected recovery evidence state is invalid")
  }
  const names = new Set()
  const ids = new Set()
  for (const asset of snapshot.assets) {
    if (
      !isObject(asset) ||
      ![3, 4].includes(Object.keys(asset).length) ||
      !hasExactFields(
        asset,
        Object.hasOwn(asset, "bytes")
          ? ["id", "name", "sha256", "bytes"]
          : ["id", "name", "sha256"],
      ) ||
      !Number.isSafeInteger(asset.id) ||
      asset.id < 1 ||
      typeof asset.name !== "string" ||
      !ASSET_NAME_PATTERN.test(asset.name) ||
      !SHA256_PATTERN.test(asset.sha256) ||
      names.has(asset.name) ||
      ids.has(asset.id) ||
      (Object.hasOwn(asset, "bytes") && typeof asset.bytes !== "string")
    ) {
      throw new TypeError("Expected recovery asset inventory is invalid")
    }
    names.add(asset.name)
    ids.add(asset.id)
  }
  if (snapshot.assets.length !== 45 + expectedKinds.length) {
    throw new TypeError("Expected recovery asset inventory is incomplete")
  }
  return deepFreeze(snapshot)
}

function validateEvidenceUpload(snapshot, args) {
  validateEscrowedSnapshot(snapshot)
  if (typeof args.sha256 !== "string" || !SHA256_PATTERN.test(args.sha256)) {
    throw new TypeError("Recovery evidence digest is invalid")
  }
  if (sha256(args.bytes) !== args.sha256) {
    throw new TypeError("Recovery evidence input digest is not exact")
  }
  const bodySha256 = sha256(snapshot.body)
  const archiveName = originalBodyAssetName(snapshot.releaseId, bodySha256)
  const receiptName = recoveryReceiptAssetName(snapshot.releaseId)
  if (args.name === archiveName) {
    if (!args.bytes.equals(Buffer.from(snapshot.body, "utf8"))) {
      throw new TypeError("Original-body archive bytes are not exact")
    }
    if (!["", "body"].includes(snapshot.evidenceAssets.join(","))) {
      throw new TypeError("Original-body archive state is not recognized")
    }
    return "body"
  }
  if (args.name === receiptName) {
    if (!["body", "body,receipt"].includes(snapshot.evidenceAssets.join(","))) {
      throw new TypeError("Recovery receipt state is not recognized")
    }
    const receipt = parseCanonicalRecoveryReceipt(args.bytes)
    if (
      receipt.duplicateReleaseId !== snapshot.releaseId ||
      receipt.originalBodySha256 !== bodySha256 ||
      receipt.baseAssetSetSha256 !== snapshot.marker.baseAssetSetSha256 ||
      receipt.archiveAsset.name !== archiveName ||
      receipt.archiveAsset.sha256 !== bodySha256
    ) {
      throw new TypeError("Recovery receipt is not derived from the candidate snapshot")
    }
    return "receipt"
  }
  throw new TypeError("Recovery evidence asset name is not candidate-derived")
}

function validateEscrowedSnapshot(snapshot) {
  let parsed
  try {
    parsed = parseReleaseMarker(snapshot.body)
  } catch {
    throw new TypeError("Expected duplicate Release body is not canonical")
  }
  if (
    !sameJson(parsed, snapshot.marker) ||
    parsed.phase !== "ESCROWED" ||
    parsed.version !== DUPLICATE_DRAFT_RECOVERY_POLICY.version ||
    parsed.commitSha !== DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha ||
    parsed.tag !== CANDIDATE_TAG ||
    typeof parsed.baseAssetSetSha256 !== "string" ||
    !SHA256_PATTERN.test(parsed.baseAssetSetSha256)
  ) {
    throw new TypeError("Expected duplicate Release marker is not the approved candidate")
  }
  const originalAssets = snapshot.assets.slice(0, 45)
  const baseAssetSetSha256 = sha256(
    `${JSON.stringify(originalAssets.map(({ name, sha256: digest }) => ({ name, sha256: digest })))}\n`,
  )
  if (baseAssetSetSha256 !== parsed.baseAssetSetSha256) {
    throw new TypeError("Expected duplicate Release asset inventory is not exact")
  }
  const bodySha256 = sha256(snapshot.body)
  const archiveName = originalBodyAssetName(snapshot.releaseId, bodySha256)
  const receiptName = recoveryReceiptAssetName(snapshot.releaseId)
  for (const [index, kind] of snapshot.evidenceAssets.entries()) {
    const asset = snapshot.assets[45 + index]
    if (kind === "body") {
      if (
        asset.name !== archiveName ||
        asset.sha256 !== bodySha256 ||
        Object.hasOwn(asset, "bytes")
      ) {
        throw new TypeError("Expected original-body archive asset is not exact")
      }
      continue
    }
    if (
      asset.name !== receiptName ||
      typeof asset.bytes !== "string" ||
      sha256(asset.bytes) !== asset.sha256
    ) {
      throw new TypeError("Expected recovery receipt asset is not exact")
    }
    const receipt = parseCanonicalRecoveryReceipt(Buffer.from(asset.bytes, "utf8"))
    if (
      receipt.duplicateReleaseId !== snapshot.releaseId ||
      receipt.originalBodySha256 !== bodySha256 ||
      receipt.baseAssetSetSha256 !== parsed.baseAssetSetSha256 ||
      receipt.archiveAsset.name !== archiveName ||
      receipt.archiveAsset.sha256 !== bodySha256
    ) {
      throw new TypeError("Expected recovery receipt asset is not candidate-derived")
    }
  }
}

function parseCanonicalRecoveryReceipt(bytes) {
  let parsed
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new TypeError("Recovery receipt bytes are malformed")
  }
  if (
    !hasExactFields(parsed, [
      "schemaVersion",
      "repository",
      "version",
      "candidateSha",
      "recoveryCommit",
      "canonicalReleaseId",
      "duplicateReleaseId",
      "originalBodySha256",
      "baseAssetSetSha256",
      "archiveAsset",
    ]) ||
    parsed.schemaVersion !== 1
  ) {
    throw new TypeError("Recovery receipt schema is invalid")
  }
  const input = { ...parsed }
  delete input.schemaVersion
  let canonical
  try {
    canonical = canonicalRecoveryReceipt(input)
  } catch {
    throw new TypeError("Recovery receipt is not candidate-derived")
  }
  if (!canonical.equals(bytes)) throw new TypeError("Recovery receipt bytes are not canonical")
  return parsed
}

function validateQuarantineInput(snapshot, args) {
  validateEscrowedSnapshot(snapshot)
  if (snapshot.evidenceAssets.join(",") !== "body,receipt") {
    throw new TypeError("Duplicate Release is not ready for quarantine")
  }
  if (
    typeof args.expectedBodySha256 !== "string" ||
    !SHA256_PATTERN.test(args.expectedBodySha256) ||
    sha256(snapshot.body) !== args.expectedBodySha256
  ) {
    throw new TypeError("Expected duplicate Release body digest is stale")
  }
  if (typeof args.expectedNotice !== "string") {
    throw new TypeError("Expected recovery notice is invalid")
  }
  let notice
  try {
    notice = JSON.parse(args.expectedNotice)
  } catch {
    throw new TypeError("Expected recovery notice is malformed")
  }
  if (
    !hasExactFields(notice, [
      "schemaVersion",
      "type",
      "repository",
      "version",
      "candidateSha",
      "canonicalReleaseId",
      "duplicateReleaseId",
      "originalBodySha256",
      "archiveAssetName",
      "receiptAssetName",
      "receiptSha256",
    ])
  ) {
    throw new TypeError("Expected recovery notice schema is invalid")
  }
  const noticeInput = { ...notice }
  delete noticeInput.schemaVersion
  delete noticeInput.type
  delete noticeInput.candidateSha
  let canonical
  try {
    canonical = canonicalRecoveryNotice(noticeInput)
  } catch {
    throw new TypeError("Expected recovery notice is not candidate-derived")
  }
  const archive = snapshot.assets.at(-2)
  const receipt = snapshot.assets.at(-1)
  if (
    canonical !== args.expectedNotice ||
    notice.originalBodySha256 !== args.expectedBodySha256 ||
    archive.name !== notice.archiveAssetName ||
    archive.sha256 !== notice.originalBodySha256 ||
    receipt.name !== notice.receiptAssetName ||
    receipt.sha256 !== notice.receiptSha256 ||
    receipt.bytes === undefined ||
    sha256(receipt.bytes) !== receipt.sha256
  ) {
    throw new TypeError("Expected recovery notice does not match the complete snapshot")
  }
}

async function verifyRecoveryCandidateTag(context, expectedTagObjectSha) {
  try {
    const ref = requirePresent(
      await context.github.getRef({ ref: `tags/${CANDIDATE_TAG}` }),
      "CANDIDATE_TAG_UNAVAILABLE",
      "Candidate tag could not be verified",
    )
    if (
      !isObject(ref) ||
      ref.ref !== `refs/tags/${CANDIDATE_TAG}` ||
      !isObject(ref.object) ||
      ref.object.type !== "tag" ||
      ref.object.sha !== expectedTagObjectSha
    ) {
      writeFail("CANDIDATE_TAG_CONFLICT", "Candidate tag identity is not exact")
    }
    const tag = requirePresent(
      await context.github.getGitTag({ tagSha: ref.object.sha }),
      "CANDIDATE_TAG_UNAVAILABLE",
      "Candidate tag could not be verified",
    )
    if (
      !isObject(tag) ||
      tag.sha !== ref.object.sha ||
      tag.tag !== CANDIDATE_TAG ||
      !isObject(tag.object) ||
      tag.object.type !== "commit" ||
      tag.object.sha !== DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha
    ) {
      writeFail("CANDIDATE_TAG_CONFLICT", "Candidate tag identity is not exact")
    }
    return ref.object.sha
  } catch (error) {
    if (error instanceof DuplicateDraftRecoveryWriteError) throw error
    writeFail("CANDIDATE_TAG_UNAVAILABLE", "Candidate tag could not be verified")
  }
}

async function observeIssuedRecoveryMutation(
  context,
  request,
  { releaseId, originalBody, expectedTagObjectSha, recordFence = false },
) {
  let response
  let requestError = null
  try {
    response = await request()
  } catch (error) {
    requestError = error
  }
  let tagError = null
  let tagObjectSha = null
  try {
    tagObjectSha = await verifyRecoveryCandidateTag(context, expectedTagObjectSha)
  } catch (error) {
    tagError = error
  }
  let snapshot = null
  let projection = null
  let observedAt = null
  let snapshotError = null
  try {
    const current = await readCurrentWriterObservation(context, releaseId, originalBody)
    snapshot = current.snapshot
    projection = current.projection
    observedAt = recordFence ? writerObservedAt(context) : null
  } catch (error) {
    snapshotError = error
  }
  return {
    response,
    requestError,
    tagError,
    tagObjectSha,
    snapshot,
    projection,
    observedAt,
    snapshotError,
  }
}

function requireExactMutationObservation(observation) {
  if (observation.tagError !== null) {
    writeFail(
      "POST_WRITE_TAG_FENCE_CONFLICT",
      "Candidate tag post-write fence could not be verified",
    )
  }
  if (observation.requestError !== null || observation.snapshotError !== null) {
    writeFail("MUTATION_OUTCOME_AMBIGUOUS", "GitHub recovery mutation outcome is ambiguous")
  }
  return {
    response: observation.response,
    snapshot: observation.snapshot,
    projection: observation.projection,
    tagObjectSha: observation.tagObjectSha,
    observedAt: observation.observedAt,
  }
}

function assertExactObservedMutationState(actual, expected) {
  if (!sameJson(actual, expected)) {
    writeFail("MUTATION_OUTCOME_AMBIGUOUS", "GitHub recovery mutation outcome is ambiguous")
  }
}

async function readExpectedWriterSnapshot(context, expected, originalBody) {
  return (await readExpectedWriterObservation(context, expected, originalBody)).snapshot
}

async function readExpectedWriterObservation(context, expected, originalBody) {
  const current = await readCurrentWriterObservation(context, expected.releaseId, originalBody)
  if (!sameJson(current.snapshot, expected)) {
    writeFail("RELEASE_SNAPSHOT_CONFLICT", "Duplicate Release snapshot drifted")
  }
  return current
}

async function readCurrentWriterObservation(context, releaseId, originalBody) {
  try {
    const release = requirePresent(
      await context.github.getRelease({ releaseId }),
      "RELEASE_UNAVAILABLE",
      "Release snapshot could not be verified",
    )
    const raw = safeWriterRemoteSnapshot(release, context.token, "RELEASE_MALFORMED")
    if (raw.name !== WRITER_TITLE) {
      writeFail("RELEASE_TITLE_CONFLICT", "Duplicate Release title is not exact")
    }
    const rawAssets = await readStrictPages(context, {
      path: `/repos/${OWNER}/${REPOSITORY}/releases/${releaseId}/assets?per_page=100`,
      operation: "RECOVERY_WRITE_ASSETS",
    })
    const snapshot = await normalizeReleaseSnapshot({
      release: raw,
      rawAssets,
      releaseId,
      expectedOriginalBody: originalBody,
      github: context.github,
      token: context.token,
    })
    return deepFreeze({
      snapshot,
      projection: normalizeWriterProjection(raw, rawAssets, snapshot),
    })
  } catch (error) {
    if (error instanceof DuplicateDraftRecoveryWriteError) throw error
    writeFail("RELEASE_SNAPSHOT_UNAVAILABLE", "Duplicate Release snapshot could not be verified")
  }
}

async function readQuarantinePreWriteFence(
  context,
  expected,
  originalBody,
  baselineProjection,
  expectedTagObjectSha,
) {
  const [tagObjectSha, current] = await Promise.all([
    verifyRecoveryCandidateTag(context, expectedTagObjectSha),
    readCurrentWriterObservation(context, expected.releaseId, originalBody),
  ])
  if (!sameJson(current.snapshot, expected) || !sameJson(current.projection, baselineProjection)) {
    writeFail("RELEASE_SNAPSHOT_CONFLICT", "Duplicate Release snapshot drifted")
  }
  const observedAt = writerObservedAt(context)
  return deepFreeze({
    snapshot: current.snapshot,
    projection: current.projection,
    fence: canonicalWriterFence(observedAt, current.projection, tagObjectSha),
  })
}

function normalizeWriterProjection(raw, rawAssets, snapshot) {
  return deepFreeze({
    releaseId: snapshot.releaseId,
    tagName: snapshot.tagName,
    title: raw.name,
    targetCommitish: raw.target_commitish,
    draft: raw.draft,
    prerelease: raw.prerelease,
    immutable: raw.immutable,
    body: snapshot.body,
    assets: rawAssets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      sha256: asset.digest.slice(7),
      size: asset.size,
    })),
  })
}

function writerObservedAt(context) {
  let milliseconds
  try {
    milliseconds = context.observedNow()
  } catch {
    writeFail("WRITE_FENCE_CLOCK_INVALID", "Recovery write fence clock is invalid")
  }
  if (!Number.isSafeInteger(milliseconds)) {
    writeFail("WRITE_FENCE_CLOCK_INVALID", "Recovery write fence clock is invalid")
  }
  let observedAt
  try {
    observedAt = new Date(milliseconds).toISOString()
  } catch {
    writeFail("WRITE_FENCE_CLOCK_INVALID", "Recovery write fence clock is invalid")
  }
  return observedAt
}

function canonicalWriterFence(observedAt, projection, tagObjectSha) {
  return deepFreeze({
    observedAt,
    projectionSha256: sha256(Buffer.from(JSON.stringify(canonicalize(projection)), "utf8")),
    tagObjectSha,
  })
}

function assertExistingEvidenceAsset(asset, args, kind) {
  if (asset.sha256 !== args.sha256) {
    writeFail("EVIDENCE_ASSET_CONFLICT", "Existing recovery evidence asset digest differs")
  }
  if (kind === "receipt" && asset.bytes !== args.bytes.toString("utf8")) {
    writeFail("EVIDENCE_ASSET_CONFLICT", "Existing recovery evidence asset bytes differ")
  }
}

function normalizeUploadResponse(value, args) {
  const response = safeWriteResponse(value, "EVIDENCE_UPLOAD_RESPONSE_MALFORMED")
  if (
    !isObject(response) ||
    !Number.isSafeInteger(response.id) ||
    response.id < 1 ||
    response.name !== args.name ||
    response.digest !== `sha256:${args.sha256}` ||
    response.size !== args.bytes.byteLength ||
    response.state !== "uploaded"
  ) {
    writeFail("EVIDENCE_UPLOAD_RESPONSE_MALFORMED", "Evidence upload response is malformed")
  }
  return { id: response.id }
}

function normalizePatchResponse(value, current, expectedNotice) {
  const response = safeWriteResponse(value, "QUARANTINE_RESPONSE_MALFORMED")
  if (
    !isObject(response) ||
    response.id !== current.releaseId ||
    response.tag_name !== current.tagName ||
    response.name !== WRITER_TITLE ||
    response.body !== expectedNotice ||
    response.draft !== true ||
    response.prerelease !== false ||
    response.immutable !== false ||
    response.target_commitish !== "main"
  ) {
    writeFail("QUARANTINE_RESPONSE_MALFORMED", "Quarantine response is malformed")
  }
}

function safeWriteResponse(value, code) {
  try {
    return snapshotJson(value)
  } catch {
    writeFail(code, "GitHub write response is malformed")
  }
}

function createStrictCredentialFetch(fetchImpl, token, maximumResponseBytes, timeoutMs) {
  const credential = Buffer.from(token, "utf8")
  return async (url, init) => {
    const deadline = createWriterResponseDeadline(timeoutMs, init?.signal)
    try {
      const parsedUrl = new URL(url)
      const existingHeaders = new Headers(init?.headers)
      const authenticatedInit = {
        ...init,
        signal: deadline.signal,
        ...(parsedUrl.origin === API_ORIGIN && !existingHeaders.has("authorization")
          ? {
              headers: {
                ...Object.fromEntries(existingHeaders.entries()),
                Authorization: `Bearer ${token}`,
              },
            }
          : {}),
      }
      const response = await deadline.race(() => fetchImpl(url, authenticatedInit))
      const body = response?.body
      if (body === null || body === undefined || typeof body.getReader !== "function") {
        return response
      }
      const bytes = await readStrictWriterResponse(body, maximumResponseBytes, credential, deadline)
      return {
        status: response.status,
        headers: response.headers,
        body: bufferedResponseBody(bytes),
      }
    } finally {
      deadline.dispose()
    }
  }
}

async function readStrictWriterResponse(body, maximum, credential, deadline) {
  const reader = body.getReader()
  if (reader === null || typeof reader !== "object" || typeof reader.read !== "function") {
    writeFail("WRITE_RESPONSE_MALFORMED", "GitHub recovery response body is malformed")
  }
  const chunks = []
  let total = 0
  let chunkCount = 0
  let tail = Buffer.alloc(0)
  try {
    while (true) {
      const result = await deadline.race(() => reader.read())
      if (result === null || typeof result !== "object" || typeof result.done !== "boolean") {
        writeFail("WRITE_RESPONSE_MALFORMED", "GitHub recovery response body is malformed")
      }
      if (result.done) break
      const bytes = snapshotStrictResponseChunk(result.value, maximum)
      if (bytes.byteLength === 0) {
        writeFail("WRITE_RESPONSE_NO_PROGRESS", "GitHub recovery response made no progress")
      }
      chunkCount += 1
      if (chunkCount > WRITER_MAX_RESPONSE_CHUNKS) {
        writeFail(
          "WRITE_RESPONSE_CHUNKS_OVER_LIMIT",
          "GitHub recovery response has too many chunks",
        )
      }
      total += bytes.byteLength
      if (total > maximum) {
        writeFail("WRITE_RESPONSE_OVER_LIMIT", "GitHub recovery response exceeds byte limit")
      }
      const searchable = tail.length === 0 ? bytes : Buffer.concat([tail, bytes])
      if (searchable.includes(credential)) {
        writeFail(
          "REMOTE_CREDENTIAL_CONFLICT",
          "GitHub recovery response contains configured credentials",
        )
      }
      const retained = Math.min(Math.max(credential.byteLength - 1, 0), searchable.byteLength)
      tail =
        retained === 0 ? Buffer.alloc(0) : searchable.subarray(searchable.byteLength - retained)
      chunks.push(bytes)
    }
  } catch (error) {
    safelyCancelReader(reader)
    throw error
  } finally {
    safelyReleaseReader(reader)
  }
  return Buffer.concat(chunks, total)
}

function bufferedResponseBody(bytes) {
  let claimed = false
  return {
    getReader() {
      if (claimed) throw new TypeError("Recovery response body was already consumed")
      claimed = true
      let delivered = false
      return {
        async read() {
          if (delivered || bytes.byteLength === 0) return { done: true, value: undefined }
          delivered = true
          return { done: false, value: bytes }
        },
        async cancel() {
          delivered = true
        },
        releaseLock() {},
      }
    },
    async cancel() {
      claimed = true
    },
  }
}

function createWriterResponseDeadline(timeoutMs, callerSignal) {
  const controller = new AbortController()
  const deadline = performance.now() + timeoutMs
  const abort = () => controller.abort()
  if (callerSignal?.aborted === true) abort()
  else callerSignal?.addEventListener("abort", abort, { once: true })
  const timeout = setTimeout(abort, timeoutMs)
  return {
    signal: controller.signal,
    async race(operation) {
      assertWriterResponseDeadline(deadline, controller.signal)
      let rejectAbort
      const aborted = new Promise((_resolve, reject) => {
        rejectAbort = () =>
          reject(
            new DuplicateDraftRecoveryWriteError(
              "WRITE_TIMEOUT",
              "GitHub recovery response timed out",
            ),
          )
        controller.signal.addEventListener("abort", rejectAbort, { once: true })
      })
      try {
        const result = await Promise.race([Promise.resolve().then(operation), aborted])
        assertWriterResponseDeadline(deadline, controller.signal)
        return result
      } finally {
        controller.signal.removeEventListener("abort", rejectAbort)
      }
    },
    dispose() {
      clearTimeout(timeout)
      callerSignal?.removeEventListener("abort", abort)
    },
  }
}

function assertWriterResponseDeadline(deadline, signal) {
  if (signal.aborted || performance.now() >= deadline) {
    writeFail("WRITE_TIMEOUT", "GitHub recovery response timed out")
  }
}

function safelyCancelReader(reader) {
  if (typeof reader.cancel !== "function") return
  try {
    Promise.resolve(reader.cancel()).catch(() => {})
  } catch {
    // Preserve the primary fail-closed result.
  }
}

function safelyReleaseReader(reader) {
  if (typeof reader.releaseLock !== "function") return
  try {
    reader.releaseLock()
  } catch {
    // The response has already been bounded or failed closed.
  }
}

function snapshotStrictResponseChunk(value, maximum) {
  let prototype
  let byteLength
  try {
    byteLength = TYPED_ARRAY_BYTE_LENGTH.call(value)
    prototype = Object.getPrototypeOf(value)
    if (prototype !== Buffer.prototype && prototype !== Uint8Array.prototype) {
      throw new TypeError("Unexpected response chunk prototype")
    }
  } catch {
    writeFail("WRITE_RESPONSE_MALFORMED", "GitHub recovery response chunk is malformed")
  }
  if (byteLength > maximum) {
    writeFail("WRITE_RESPONSE_OVER_LIMIT", "GitHub recovery write response exceeds byte limit")
  }
  try {
    return Buffer.from(Uint8Array.prototype.slice.call(value))
  } catch {
    writeFail("WRITE_RESPONSE_MALFORMED", "GitHub recovery response chunk is malformed")
  }
}

async function requestRecoveryJson(
  context,
  { url, method, body, bytes: suppliedBytes, contentType, maximumRequestBytes },
) {
  const expectedApiUrl = `${API_ORIGIN}/repos/${OWNER}/${REPOSITORY}/releases/`
  const expectedUploadUrl = `${UPLOAD_ORIGIN}/repos/${OWNER}/${REPOSITORY}/releases/`
  if (
    !["POST", "PATCH"].includes(method) ||
    (method === "POST" ? !url.startsWith(expectedUploadUrl) : !url.startsWith(expectedApiUrl))
  ) {
    throw new TypeError("Recovery writer URL or method is not allowed")
  }
  const requestBytes =
    suppliedBytes === undefined
      ? Buffer.from(JSON.stringify(canonicalize(body)), "utf8")
      : Buffer.from(suppliedBytes)
  if (requestBytes.byteLength < 1 || requestBytes.byteLength > maximumRequestBytes) {
    throw new TypeError("Recovery write request exceeds its byte limit")
  }
  const controller = new AbortController()
  const deadline = performance.now() + context.timeoutMs
  const timeout = setTimeout(() => controller.abort(), context.timeoutMs)
  try {
    let response
    try {
      response = await fetchRecoveryWrite(
        context.fetchImpl,
        url,
        {
          method,
          redirect: "manual",
          headers: {
            Accept: "application/vnd.github+json",
            "Content-Type": contentType,
            "X-GitHub-Api-Version": API_VERSION,
            Authorization: `Bearer ${context.token}`,
          },
          body: requestBytes,
          signal: controller.signal,
        },
        controller.signal,
      )
      assertRecoveryWriteDeadline(deadline, controller.signal)
    } catch {
      writeFail(
        controller.signal.aborted ? "WRITE_TIMEOUT" : "WRITE_UNAVAILABLE",
        controller.signal.aborted
          ? "GitHub recovery write timed out"
          : "GitHub recovery write failed",
      )
    }
    if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) {
      cancelResponseBody(response?.body)
      writeFail("WRITE_RESPONSE_MALFORMED", "GitHub recovery write response is malformed")
    }
    if (response.status >= 300 && response.status < 400) {
      cancelResponseBody(response.body)
      writeFail("WRITE_REDIRECT_FORBIDDEN", "GitHub recovery write redirects are forbidden")
    }
    const responseBytes = await readBoundedWriteResponse(
      response.body,
      context.maxResponseBytes,
      controller.signal,
      deadline,
    )
    if (responseBytes.byteLength === 0) {
      return { httpStatus: response.status, body: null }
    }
    const responseContentType = response.headers?.get?.("content-type")
    if (
      typeof responseContentType !== "string" ||
      !/^application\/(?:[A-Za-z0-9!#$&^_.+-]+\+)?json(?:\s*;|\s*$)/iu.test(responseContentType)
    ) {
      writeFail("WRITE_CONTENT_TYPE_CONFLICT", "GitHub recovery write response is not JSON")
    }
    let parsed
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes))
    } catch {
      writeFail("WRITE_RESPONSE_MALFORMED", "GitHub recovery write response JSON is malformed")
    }
    return {
      httpStatus: response.status,
      body: safeWriterRemoteSnapshot(parsed, context.token, "WRITE_RESPONSE_MALFORMED"),
    }
  } catch (error) {
    if (error instanceof DuplicateDraftRecoveryWriteError) throw error
    writeFail(
      controller.signal.aborted ? "WRITE_TIMEOUT" : "WRITE_RESPONSE_MALFORMED",
      controller.signal.aborted
        ? "GitHub recovery write timed out"
        : "GitHub recovery write response is malformed",
    )
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchRecoveryWrite(fetchImpl, url, init, signal) {
  let rejectAbort
  const aborted = new Promise((_resolve, reject) => {
    rejectAbort = () =>
      reject(
        new DuplicateDraftRecoveryWriteError("WRITE_TIMEOUT", "GitHub recovery write timed out"),
      )
    signal.addEventListener("abort", rejectAbort, { once: true })
  })
  try {
    return await Promise.race([fetchImpl(url, init), aborted])
  } finally {
    signal.removeEventListener("abort", rejectAbort)
  }
}

async function readBoundedWriteResponse(stream, maximum, signal, deadline) {
  if (stream === null) return Buffer.alloc(0)
  if (stream === undefined || typeof stream.getReader !== "function") {
    writeFail("WRITE_RESPONSE_MALFORMED", "GitHub recovery write response body is malformed")
  }
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  let chunkCount = 0
  try {
    while (true) {
      assertRecoveryWriteDeadline(deadline, signal)
      const { done, value } = await readRecoveryWriteChunk(reader, signal, deadline)
      assertRecoveryWriteDeadline(deadline, signal)
      if (done) break
      if (!(value instanceof Uint8Array)) {
        writeFail("WRITE_RESPONSE_MALFORMED", "GitHub recovery write response body is malformed")
      }
      if (value.byteLength === 0) {
        writeFail("WRITE_RESPONSE_NO_PROGRESS", "GitHub recovery write response made no progress")
      }
      chunkCount += 1
      if (chunkCount > WRITER_MAX_RESPONSE_CHUNKS) {
        writeFail(
          "WRITE_RESPONSE_CHUNKS_OVER_LIMIT",
          "GitHub recovery write response has too many chunks",
        )
      }
      total += value.byteLength
      if (total > maximum) {
        writeFail("WRITE_RESPONSE_OVER_LIMIT", "GitHub recovery write response exceeds byte limit")
      }
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  }
  return Buffer.concat(chunks, total)
}

async function readRecoveryWriteChunk(reader, signal, deadline) {
  assertRecoveryWriteDeadline(deadline, signal)
  let rejectAbort
  const aborted = new Promise((_resolve, reject) => {
    rejectAbort = () =>
      reject(
        new DuplicateDraftRecoveryWriteError("WRITE_TIMEOUT", "GitHub recovery write timed out"),
      )
    signal.addEventListener("abort", rejectAbort, { once: true })
  })
  try {
    return await Promise.race([reader.read(), aborted])
  } finally {
    signal.removeEventListener("abort", rejectAbort)
  }
}

function assertRecoveryWriteDeadline(deadline, signal) {
  if (signal.aborted || performance.now() >= deadline) {
    writeFail("WRITE_TIMEOUT", "GitHub recovery write timed out")
  }
}

function cancelResponseBody(body) {
  if (body !== null && body !== undefined && typeof body.cancel === "function") {
    void body.cancel().catch(() => {})
  }
}

function assertBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid`)
  }
}

function hasUnsafeTokenCharacters(value) {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code <= 31 || code === 127) return true
  }
  return false
}

function isPlainObject(value) {
  if (!isObject(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactFields(value, fields) {
  if (!isObject(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function sameJson(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}

export class DuplicateDraftRecoveryWriteError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "DuplicateDraftRecoveryWriteError"
    this.code = code
  }
}

function writeFail(code, message) {
  throw new DuplicateDraftRecoveryWriteError(code, message)
}

async function readRepositoryState(context) {
  const [repository, mainRef] = await Promise.all([
    readExactJson(context, {
      path: `/repos/${OWNER}/${REPOSITORY}`,
      operation: "repository",
    }),
    context.github.getRef({ ref: "heads/main" }),
  ])
  if (
    !isObject(repository) ||
    repository.id !== Number(REPOSITORY_ID) ||
    repository.full_name !== DUPLICATE_DRAFT_RECOVERY_POLICY.repository ||
    repository.name !== REPOSITORY ||
    repository.default_branch !== "main" ||
    !isObject(repository.owner) ||
    repository.owner.login !== OWNER
  ) {
    fail("REPOSITORY_IDENTITY_CONFLICT", "Recovery repository identity is not exact")
  }
  const ref = requirePresent(
    await mainRef,
    "REMOTE_MAIN_UNAVAILABLE",
    "Remote main could not be verified",
  )
  if (
    !isObject(ref) ||
    ref.ref !== "refs/heads/main" ||
    !isObject(ref.object) ||
    ref.object.type !== "commit" ||
    !isSha(ref.object.sha)
  ) {
    fail("REMOTE_MAIN_MALFORMED", "Remote main evidence is malformed")
  }
  return deepFreeze({
    id: Number(REPOSITORY_ID),
    nameWithOwner: DUPLICATE_DRAFT_RECOVERY_POLICY.repository,
    mainSha: ref.object.sha,
  })
}

async function readRequiredCi(context, reviewedHeadSha) {
  const [checks, workflows] = await Promise.all([
    readStrictPages(context, {
      path: `/repos/${OWNER}/${REPOSITORY}/commits/${reviewedHeadSha}/check-runs?per_page=100`,
      operation: "REVIEWED_VALIDATE_CHECKS",
      field: "check_runs",
      requireTotalCount: true,
    }),
    readStrictPages(context, {
      path: `/repos/${OWNER}/${REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${reviewedHeadSha}&per_page=100`,
      operation: "REVIEWED_CI_RUNS",
      field: "workflow_runs",
      requireTotalCount: true,
    }),
  ])
  const normalizedChecks = checks.map((check) => normalizeCheckRun(check, reviewedHeadSha))
  const normalizedWorkflows = workflows.map((run) => normalizeReviewedCiRun(run, reviewedHeadSha))
  assertUniqueIds(normalizedChecks, "REVIEWED_VALIDATE_MALFORMED")
  assertUniqueIds(normalizedWorkflows, "REVIEWED_VALIDATE_MALFORMED")
  const matchingWorkflows = normalizedWorkflows.filter(
    (run) =>
      run?.name === "CI" &&
      run?.path === ".github/workflows/ci.yml" &&
      run?.head_sha === reviewedHeadSha &&
      run?.event === "pull_request",
  )
  if (matchingWorkflows.length !== 1) {
    fail("REVIEWED_VALIDATE_NOT_SUCCESSFUL", "Reviewed CI validate check did not succeed")
  }
  const workflow = matchingWorkflows[0]
  const matchingChecks = normalizedChecks.filter(
    (check) =>
      check?.name === "validate" &&
      check?.head_sha === reviewedHeadSha &&
      String(check?.check_suite?.id) === String(workflow.check_suite_id),
  )
  if (
    matchingChecks.length !== 1 ||
    !Number.isSafeInteger(workflow.id) ||
    workflow.id < 1 ||
    !Number.isSafeInteger(workflow.run_attempt) ||
    workflow.run_attempt < 1 ||
    !Number.isSafeInteger(workflow.check_suite_id) ||
    workflow.check_suite_id < 1 ||
    workflow.status !== "completed" ||
    workflow.conclusion !== "success" ||
    matchingChecks[0].status !== "completed" ||
    matchingChecks[0].conclusion !== "success"
  ) {
    fail("REVIEWED_VALIDATE_NOT_SUCCESSFUL", "Reviewed CI validate check did not succeed")
  }
  return { validateRunId: workflow.id }
}

function normalizeReviewedPullRequest(value, reviewedCommit) {
  const pull = safeSnapshot(value, "REVIEWED_PULL_REQUEST_MALFORMED")
  if (
    !isObject(pull) ||
    !Number.isSafeInteger(pull.number) ||
    pull.number < 1 ||
    pull.state !== "closed" ||
    !isTimestamp(pull.merged_at) ||
    pull.merge_commit_sha !== reviewedCommit ||
    !isObject(pull.base) ||
    pull.base.ref !== "main" ||
    !isObject(pull.base.repo) ||
    pull.base.repo.id !== Number(REPOSITORY_ID) ||
    pull.base.repo.full_name !== DUPLICATE_DRAFT_RECOVERY_POLICY.repository ||
    !isObject(pull.head) ||
    !isSha(pull.head.sha)
  ) {
    fail("REVIEWED_PULL_REQUEST_CONFLICT", "Reviewed pull request identity is not exact")
  }
  return { pullRequestNumber: pull.number, reviewedHeadSha: pull.head.sha }
}

function commitTreeSha(value, expectedCommitSha, label) {
  const commit = safeSnapshot(value, "REVIEWED_COMMIT_MALFORMED")
  if (
    !isObject(commit) ||
    commit.sha !== expectedCommitSha ||
    !isObject(commit.tree) ||
    !isSha(commit.tree.sha)
  ) {
    fail("REVIEWED_COMMIT_MALFORMED", `Reviewed ${label} evidence is malformed`)
  }
  return commit.tree.sha
}

function normalizeReleaseRuns(value) {
  if (!Array.isArray(value)) fail("RELEASE_RUNS_MALFORMED", "Release workflow runs are malformed")
  const seen = new Set()
  const runs = value.map((raw) => {
    const run = safeSnapshot(raw, "RELEASE_RUNS_MALFORMED")
    if (
      !isObject(run) ||
      !Number.isSafeInteger(run.id) ||
      run.id < 1 ||
      seen.has(run.id) ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt < 1 ||
      !RUN_STATUSES.has(run.status) ||
      !isSha(run.head_sha) ||
      run.path !== RELEASE_WORKFLOW_PATH ||
      !isTimestamp(run.created_at) ||
      !isNullableTimestamp(run.run_started_at) ||
      !isTimestamp(run.updated_at) ||
      !coherentRunState(run) ||
      !orderedTimestamps(run.created_at, run.run_started_at, run.updated_at)
    ) {
      fail("RELEASE_RUNS_MALFORMED", "Release workflow runs are malformed")
    }
    seen.add(run.id)
    return {
      id: run.id,
      runAttempt: run.run_attempt,
      status: run.status,
      conclusion: run.conclusion,
      headSha: run.head_sha,
      createdAt: run.created_at,
      startedAt: run.run_started_at,
      updatedAt: run.updated_at,
    }
  })
  return runs.sort((left, right) => left.id - right.id || left.runAttempt - right.runAttempt)
}

function normalizeCandidateJobs(value, expectedRunId, currentAttempt) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("CANDIDATE_JOBS_MALFORMED", "Candidate workflow jobs are malformed")
  }
  const ids = new Set()
  const identities = new Set()
  const attempts = new Set()
  const publisherJobsByAttempt = new Map()
  const jobs = value.map((raw) => {
    const job = safeSnapshot(raw, "CANDIDATE_JOBS_MALFORMED")
    const identity = `${job?.run_attempt}:${job?.id}`
    if (
      !isObject(job) ||
      !Number.isSafeInteger(job.id) ||
      job.id < 1 ||
      ids.has(job.id) ||
      identities.has(identity) ||
      !Number.isSafeInteger(job.run_id) ||
      job.run_id !== expectedRunId ||
      !Number.isSafeInteger(job.run_attempt) ||
      job.run_attempt < 1 ||
      job.run_attempt > currentAttempt ||
      !isBoundedText(job.name, 512) ||
      !JOB_STATUSES.has(job.status) ||
      !isNullableTimestamp(job.started_at) ||
      !isNullableTimestamp(job.completed_at) ||
      !coherentJobState(job)
    ) {
      fail("CANDIDATE_JOBS_MALFORMED", "Candidate workflow jobs are malformed")
    }
    ids.add(job.id)
    identities.add(identity)
    attempts.add(job.run_attempt)
    if (job.name === "publish-npm") {
      publisherJobsByAttempt.set(
        job.run_attempt,
        (publisherJobsByAttempt.get(job.run_attempt) ?? 0) + 1,
      )
    }
    return {
      id: job.id,
      runId: job.run_id,
      runAttempt: job.run_attempt,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    }
  })
  if (attempts.size !== currentAttempt) {
    fail("CANDIDATE_JOBS_MALFORMED", "Candidate workflow job attempt coverage is incomplete")
  }
  for (let attempt = 1; attempt <= currentAttempt; attempt += 1) {
    if (!attempts.has(attempt) || publisherJobsByAttempt.get(attempt) !== 1) {
      fail("CANDIDATE_JOBS_MALFORMED", "Candidate workflow publish job identity is not exact")
    }
  }
  return jobs.sort((left, right) => left.runAttempt - right.runAttempt || left.id - right.id)
}

function normalizeReleaseRow(value) {
  const release = safeSnapshot(value, "RELEASE_LIST_MALFORMED")
  if (
    !isObject(release) ||
    !Number.isSafeInteger(release.id) ||
    release.id < 1 ||
    !isBoundedText(release.tag_name, 1024) ||
    !(release.body === null || isBoundedText(release.body, 512 * 1024, true)) ||
    typeof release.draft !== "boolean" ||
    typeof release.prerelease !== "boolean" ||
    typeof release.immutable !== "boolean" ||
    !isBoundedText(release.target_commitish, 1024)
  ) {
    fail("RELEASE_LIST_MALFORMED", "Release inventory is malformed")
  }
  return {
    id: release.id,
    tagName: release.tag_name,
    body: release.body,
    draft: release.draft,
    prerelease: release.prerelease,
    immutable: release.immutable,
    targetCommitish: release.target_commitish,
  }
}

function normalizeCheckRun(value, reviewedHeadSha) {
  const check = safeSnapshot(value, "REVIEWED_VALIDATE_MALFORMED")
  if (
    !isObject(check) ||
    !Number.isSafeInteger(check.id) ||
    check.id < 1 ||
    !isBoundedText(check.name, 256) ||
    check.head_sha !== reviewedHeadSha ||
    !isObject(check.check_suite) ||
    !Number.isSafeInteger(check.check_suite.id) ||
    check.check_suite.id < 1 ||
    !["queued", "in_progress", "completed"].includes(check.status) ||
    !coherentTerminalState(check.status, check.conclusion)
  ) {
    fail("REVIEWED_VALIDATE_MALFORMED", "Reviewed validate check evidence is malformed")
  }
  return check
}

function normalizeReviewedCiRun(value, reviewedHeadSha) {
  const run = safeSnapshot(value, "REVIEWED_VALIDATE_MALFORMED")
  if (
    !isObject(run) ||
    !Number.isSafeInteger(run.id) ||
    run.id < 1 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    !Number.isSafeInteger(run.check_suite_id) ||
    run.check_suite_id < 1 ||
    run.head_sha !== reviewedHeadSha ||
    !isBoundedText(run.name, 256) ||
    !isBoundedText(run.path, 1024) ||
    !isBoundedText(run.event, 256) ||
    !RUN_STATUSES.has(run.status) ||
    !coherentTerminalState(run.status, run.conclusion)
  ) {
    fail("REVIEWED_VALIDATE_MALFORMED", "Reviewed CI workflow evidence is malformed")
  }
  return run
}

function assertUniqueIds(values, code) {
  if (new Set(values.map(({ id }) => id)).size !== values.length) {
    fail(code, "Recovery read contains duplicate record IDs")
  }
}

async function normalizeReleaseSnapshot({
  release,
  rawAssets,
  releaseId,
  expectedOriginalBody,
  github,
  token,
}) {
  const raw = safeSnapshot(release, "RELEASE_MALFORMED")
  if (
    !isObject(raw) ||
    raw.id !== releaseId ||
    !isBoundedText(raw.tag_name, 1024) ||
    !isBoundedText(raw.body, 512 * 1024, true) ||
    raw.draft !== true ||
    raw.prerelease !== false ||
    raw.immutable !== false ||
    raw.target_commitish !== "main" ||
    !Array.isArray(rawAssets)
  ) {
    fail("RELEASE_MALFORMED", "Release snapshot is malformed")
  }
  const marker = releaseMarker(raw.body)
  const assets = []
  const evidenceAssets = []
  const assetIds = new Set()
  const assetNames = new Set()
  for (const rawAsset of rawAssets) {
    const asset = safeSnapshot(rawAsset, "RELEASE_ASSETS_MALFORMED")
    if (
      !isObject(asset) ||
      !Number.isSafeInteger(asset.id) ||
      asset.id < 1 ||
      assetIds.has(asset.id) ||
      !ASSET_NAME_PATTERN.test(asset.name) ||
      assetNames.has(asset.name) ||
      !/^sha256:[0-9a-f]{64}$/u.test(asset.digest) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1
    ) {
      fail("RELEASE_ASSETS_MALFORMED", "Release asset inventory is malformed")
    }
    assetIds.add(asset.id)
    assetNames.add(asset.name)
    const normalized = { id: asset.id, name: asset.name, sha256: asset.digest.slice(7) }
    const kind = recoveryEvidenceKind(asset.name, releaseId)
    if (kind !== null) {
      if (expectedOriginalBody === undefined) {
        fail("RECOVERY_ASSET_UNEXPECTED", "Recovery evidence asset is not expected here")
      }
      const downloaded = requirePresent(
        await github.downloadReleaseAsset({
          assetId: asset.id,
          maximumBytes: RECOVERY_ASSET_BYTES,
        }),
        "RECOVERY_ASSET_UNAVAILABLE",
        "Recovery evidence asset bytes could not be verified",
      )
      if (
        typeof downloaded !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(downloaded)
      ) {
        fail("RECOVERY_ASSET_BYTES_CONFLICT", "Recovery evidence asset bytes are not exact")
      }
      const bytes = Buffer.from(downloaded, "base64")
      if (token !== null && bytes.includes(Buffer.from(token, "utf8"))) {
        fail(
          "RECOVERY_ASSET_CREDENTIAL_CONFLICT",
          "Recovery evidence asset contains configured credentials",
        )
      }
      if (
        bytes.toString("base64") !== downloaded ||
        bytes.byteLength !== asset.size ||
        sha256(bytes) !== normalized.sha256
      ) {
        fail("RECOVERY_ASSET_BYTES_CONFLICT", "Recovery evidence asset bytes are not exact")
      }
      if (kind === "body") {
        if (bytes.toString("utf8") !== expectedOriginalBody) {
          fail("RECOVERY_BODY_ARCHIVE_CONFLICT", "Archived original Release body is not exact")
        }
      } else {
        normalized.bytes = bytes.toString("utf8")
      }
      evidenceAssets.push(kind)
    }
    assets.push(normalized)
  }
  return deepFreeze({
    releaseId,
    tagName: raw.tag_name,
    body: raw.body,
    marker,
    assets,
    ...(releaseId === DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId ? {} : { evidenceAssets }),
  })
}

function recoveryEvidenceKind(name, releaseId) {
  const prefix = `dawn-v${DUPLICATE_DRAFT_RECOVERY_POLICY.version}-duplicate-${releaseId}-`
  if (new RegExp(`^${prefix}original-body-[0-9a-f]{64}\\.txt$`, "u").test(name)) return "body"
  if (name === `${prefix}recovery-receipt.json`) return "receipt"
  return null
}

function releaseMarker(body) {
  if (typeof body !== "string") return null
  try {
    return parseReleaseMarker(body)
  } catch {
    return null
  }
}

async function readExactJson(context, { path, operation, accept = "application/vnd.github+json" }) {
  const result = await context.http.getJson({
    url: `${API_ORIGIN}${path}`,
    headers: githubHeaders(context.token, accept),
  })
  if (
    result.status !== "OK" ||
    result.httpStatus !== 200 ||
    result.code !== null ||
    result.headers?.link !== null
  ) {
    fail(`${operation.toUpperCase().replaceAll("-", "_")}_UNAVAILABLE`, `${operation} read failed`)
  }
  const malformedCode = `${operation.toUpperCase().replaceAll("-", "_")}_MALFORMED`
  return safeContextRemoteSnapshot(context, result.body, malformedCode)
}

async function readStrictPages(context, { path, operation, field, requireTotalCount = false }) {
  const records = []
  const seenUrls = new Set()
  let totalCount = null
  let advertisedLastPage = null
  let url = `${API_ORIGIN}${path}`
  let remainingBytes = context.maxResponseBytes
  const startedAt = context.now()
  if (!Number.isSafeInteger(startedAt)) {
    fail(`${operation}_UNAVAILABLE`, `${operation.toLowerCase()} read failed`)
  }
  const deadline = startedAt + context.timeoutMs
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (seenUrls.has(url)) fail("PAGINATION_DRIFT", "Recovery read pagination is unsafe")
    seenUrls.add(url)
    const currentTime = context.now()
    const remainingTime = deadline - currentTime
    if (!Number.isSafeInteger(currentTime) || remainingTime < 1) {
      fail(`${operation}_UNAVAILABLE`, `${operation.toLowerCase()} read failed`)
    }
    if (remainingBytes < 1) {
      fail(`${operation}_OVER_LIMIT`, `${operation.toLowerCase()} read exceeds the byte limit`)
    }
    const result = await readBoundary(`${operation}_UNAVAILABLE`, () =>
      context.http.getJson({
        url,
        headers: githubHeaders(context.token, "application/vnd.github+json"),
        timeoutMs: Math.min(context.timeoutMs, remainingTime),
        maxResponseBytes: remainingBytes,
      }),
    )
    if (result.status !== "OK" || result.httpStatus !== 200 || result.code !== null) {
      const code =
        result.code === "RESPONSE_TOO_LARGE"
          ? `${operation}_OVER_LIMIT`
          : `${operation}_UNAVAILABLE`
      fail(code, `${operation.toLowerCase()} read failed`)
    }
    if (!Number.isSafeInteger(result.bodyBytes) || result.bodyBytes < 0) {
      fail(`${operation}_MALFORMED`, `${operation.toLowerCase()} response is malformed`)
    }
    remainingBytes -= result.bodyBytes
    const body = safeContextRemoteSnapshot(context, result.body, `${operation}_MALFORMED`)
    let pageRecords
    if (field === undefined) {
      if (!Array.isArray(body)) {
        fail(`${operation}_MALFORMED`, `${operation.toLowerCase()} response is malformed`)
      }
      pageRecords = body
    } else {
      if (!isObject(body) || !Array.isArray(body[field])) {
        fail(`${operation}_MALFORMED`, `${operation.toLowerCase()} response is malformed`)
      }
      pageRecords = body[field]
    }
    if (requireTotalCount) {
      if (
        !isObject(body) ||
        !Number.isSafeInteger(body.total_count) ||
        body.total_count < 0 ||
        body.total_count > MAX_RECORDS
      ) {
        fail(`${operation}_MALFORMED`, `${operation.toLowerCase()} response is malformed`)
      }
      if (totalCount === null) totalCount = body.total_count
      if (body.total_count !== totalCount) {
        fail("PAGINATION_DRIFT", "Recovery read pagination total changed")
      }
    }
    if (pageRecords.length > 100) {
      fail(`${operation}_OVER_LIMIT`, `${operation.toLowerCase()} read exceeds the page size`)
    }
    if (records.length + pageRecords.length > MAX_RECORDS) {
      fail(`${operation}_OVER_LIMIT`, `${operation.toLowerCase()} read exceeds the record limit`)
    }
    records.push(...pageRecords)
    const links = linkRelations(result.headers?.link)
    for (const link of links.values()) {
      if (normalizePaginationPage(link, path) === null) {
        fail("PAGINATION_DRIFT", "Recovery read pagination is unsafe")
      }
    }
    const last = links.get("last")
    const observedLastPage =
      last === undefined ? null : (normalizePaginationPage(last, path)?.page ?? null)
    if (
      advertisedLastPage !== null &&
      observedLastPage !== null &&
      observedLastPage !== advertisedLastPage
    ) {
      fail("PAGINATION_DRIFT", "Recovery read pagination last page changed")
    }
    if (advertisedLastPage === null && observedLastPage !== null) {
      advertisedLastPage = observedLastPage
    }
    const next = links.get("next") ?? null
    if (next === null) {
      if (advertisedLastPage !== null && advertisedLastPage !== page + 1) {
        fail("PAGINATION_DRIFT", "Recovery read pagination is incomplete")
      }
      if (requireTotalCount && records.length !== totalCount) {
        fail("PAGINATION_DRIFT", "Recovery read pagination is incomplete")
      }
      return records
    }
    if (pageRecords.length !== 100 || (requireTotalCount && records.length >= totalCount)) {
      fail("PAGINATION_DRIFT", "Recovery read pagination is inconsistent")
    }
    const normalized = normalizePaginationUrl(next, path, page + 2)
    if (normalized === null) fail("PAGINATION_DRIFT", "Recovery read pagination is unsafe")
    if (advertisedLastPage !== null && page + 2 > advertisedLastPage) {
      fail("PAGINATION_DRIFT", "Recovery read pagination is inconsistent")
    }
    url = normalized
  }
  fail(`${operation}_OVER_LIMIT`, `${operation.toLowerCase()} read exceeds the page limit`)
}

function normalizePaginationUrl(value, initialPath, expectedPage) {
  const normalized = normalizePaginationPage(value, initialPath)
  return normalized?.page === expectedPage ? normalized.href : null
}

function normalizePaginationPage(value, initialPath) {
  try {
    const url = new URL(value)
    const initial = new URL(`${API_ORIGIN}${initialPath}`)
    if (
      url.origin !== API_ORIGIN ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      ![initial.pathname, repositoryIdPath(initial.pathname)].includes(url.pathname)
    ) {
      return null
    }
    const expectedEntries = [...initial.searchParams.entries()]
    const actualEntries = [...url.searchParams.entries()]
    if (actualEntries.length !== expectedEntries.length + 1) {
      return null
    }
    for (const [name, expected] of expectedEntries) {
      const matches = actualEntries.filter(([actualName]) => actualName === name)
      if (matches.length !== 1 || matches[0][1] !== expected) return null
    }
    const pageEntries = actualEntries.filter(([name]) => name === "page")
    if (pageEntries.length !== 1 || !/^[1-9][0-9]*$/u.test(pageEntries[0][1])) return null
    const page = Number(pageEntries[0][1])
    return Number.isSafeInteger(page) && page <= MAX_PAGES ? { href: url.href, page } : null
  } catch {
    return null
  }
}

function repositoryIdPath(pathname) {
  const prefix = `/repos/${OWNER}/${REPOSITORY}`
  return pathname.startsWith(prefix)
    ? `/repositories/${REPOSITORY_ID}${pathname.slice(prefix.length)}`
    : pathname
}

function linkRelations(value) {
  if (value === null || value === undefined) return new Map()
  if (typeof value !== "string") fail("PAGINATION_DRIFT", "Recovery read pagination is unsafe")
  const relations = new Map()
  for (const part of value.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="([a-z]+)"\s*$/u.exec(part)
    if (match === null || relations.has(match[2])) {
      fail("PAGINATION_DRIFT", "Recovery read pagination is unsafe")
    }
    relations.set(match[2], match[1])
  }
  return relations
}

function githubHeaders(token, accept) {
  return {
    Accept: accept,
    ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    "X-GitHub-Api-Version": API_VERSION,
  }
}

function requirePresent(result, code, message) {
  if (result?.status !== "PRESENT" || result.code !== null) fail(code, message)
  return safeSnapshot(result.value ?? result.contentBase64, code)
}

async function readBoundary(code, operation) {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof DuplicateDraftRecoveryReadError) throw error
    fail(code, "Recovery read boundary is unavailable")
  }
}

function safeSnapshot(value, code) {
  try {
    return snapshotJson(value)
  } catch {
    fail(code, "Recovery read response is malformed")
  }
}

function safeRemoteSnapshot(value, token, code) {
  try {
    return canonicalRemoteJson(snapshotJson(value), token)
  } catch {
    fail(code, "Recovery read response is malformed")
  }
}

function safeContextRemoteSnapshot(context, value, code) {
  return context.strictCredentials === true
    ? safeWriterRemoteSnapshot(value, context.token, code)
    : safeRemoteSnapshot(value, context.token, code)
}

function safeWriterRemoteSnapshot(value, token, code) {
  let snapshot
  try {
    snapshot = snapshotJson(value)
  } catch {
    writeFail(code, "GitHub recovery response is malformed")
  }
  try {
    return canonicalWriterRemoteJson(snapshot, token)
  } catch {
    writeFail("REMOTE_CREDENTIAL_CONFLICT", "GitHub recovery response is not credential-safe")
  }
}

function canonicalWriterRemoteJson(value, token) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value
  if (typeof value === "string") {
    if (value.includes(token)) throw new TypeError("Credential occurrence")
    return value
  }
  if (Array.isArray(value)) return value.map((item) => canonicalWriterRemoteJson(item, token))
  const normalized = {}
  for (const key of Object.keys(value).sort()) {
    if (
      UNSAFE_REMOTE_KEYS.has(key) ||
      /token|secret|authorization|cookie/iu.test(key) ||
      key.includes(token)
    ) {
      throw new TypeError("Unsafe remote response key")
    }
    Object.defineProperty(normalized, key, {
      value: canonicalWriterRemoteJson(value[key], token),
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return normalized
}

function canonicalRemoteJson(value, token) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value
  if (typeof value === "string") {
    return token === null ? value : value.split(token).join("[REDACTED]")
  }
  if (Array.isArray(value)) return value.map((item) => canonicalRemoteJson(item, token))
  const normalized = {}
  for (const key of Object.keys(value).sort()) {
    if (
      UNSAFE_REMOTE_KEYS.has(key) ||
      /token|secret|authorization|cookie/iu.test(key) ||
      (token !== null && key.includes(token))
    ) {
      throw new TypeError("Unsafe remote response key")
    }
    Object.defineProperty(normalized, key, {
      value: canonicalRemoteJson(value[key], token),
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return normalized
}

function assertSha(value, label) {
  if (!isSha(value)) throw new TypeError(`${label} is invalid`)
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} is invalid`)
}

function isSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value)
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return false
  const canonical = new Date(milliseconds).toISOString()
  return (
    value === canonical ||
    (canonical.endsWith(".000Z") && value === canonical.replace(".000Z", "Z"))
  )
}

function isNullableTimestamp(value) {
  return value === null || isTimestamp(value)
}

function isBoundedText(value, maximumBytes, allowEmpty = false) {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    Buffer.byteLength(value) <= maximumBytes &&
    !/[\0\r]/u.test(value)
  )
}

function coherentTerminalState(status, conclusion) {
  return status === "completed" ? TERMINAL_CONCLUSIONS.has(conclusion) : conclusion === null
}

function coherentRunState(run) {
  return (
    coherentTerminalState(run.status, run.conclusion) &&
    (run.status === "completed" || run.status === "in_progress"
      ? run.run_started_at !== null
      : run.run_started_at === null)
  )
}

function coherentJobState(job) {
  return (
    coherentTerminalState(job.status, job.conclusion) &&
    (job.status === "completed"
      ? job.started_at !== null && job.completed_at !== null
      : job.completed_at === null &&
        (job.status === "in_progress" ? job.started_at !== null : job.started_at === null))
  )
}

function orderedTimestamps(...values) {
  const timestamps = values.filter((value) => value !== null).map((value) => Date.parse(value))
  return timestamps.every((value, index) => index === 0 || timestamps[index - 1] <= value)
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function fail(code, message) {
  throw new DuplicateDraftRecoveryReadError(code, message)
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
