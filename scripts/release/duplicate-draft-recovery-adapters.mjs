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
import { DUPLICATE_DRAFT_RECOVERY_POLICY } from "./duplicate-draft-recovery.mjs"
import { parseReleaseMarker } from "./metadata.mjs"

const OWNER = "cacheplane"
const REPOSITORY = "dawnai"
const REPOSITORY_ID = "1210070282"
const API_ORIGIN = "https://api.github.com"
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
          (marker !== null &&
            release.draft === true &&
            release.immutable === false &&
            marker.tag === CANDIDATE_TAG)
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
      !coherentJobState(job) ||
      !orderedTimestamps(job.started_at, job.started_at, job.completed_at)
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
    evidenceAssets,
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
  return safeSnapshot(result.body, `${operation.toUpperCase().replaceAll("-", "_")}_MALFORMED`)
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
    const body = safeSnapshot(result.body, `${operation}_MALFORMED`)
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
      (advertisedLastPage !== null && observedLastPage === null) ||
      (advertisedLastPage !== null && observedLastPage !== advertisedLastPage)
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
  return (
    typeof value === "string" && TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value))
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
