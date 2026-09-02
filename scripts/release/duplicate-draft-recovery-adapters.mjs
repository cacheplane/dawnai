import { createHash } from "node:crypto"

import { snapshotJson } from "./adapter-normalize.mjs"
import { createGitReader } from "./adapters/git.mjs"
import { createGitHubReader } from "./adapters/github.mjs"
import { createHttpGet } from "./adapters/http.mjs"
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
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024
const RECOVERY_ASSET_BYTES = 64 * 1024
const NONTERMINAL_STATUSES = new Set(["requested", "waiting", "pending", "queued", "in_progress"])

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
  maxResponseBytes = MAX_RESPONSE_BYTES,
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
  const context = { git, github, npm, http, token: token ?? null }

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
        readRequiredCi(github, pullRequest.reviewedHeadSha),
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
      const [allRuns, candidateRuns] = await Promise.all([
        readPaginatedArray(context, {
          path: `/repos/${OWNER}/${REPOSITORY}/actions/workflows/${RELEASE_WORKFLOW_ID}/runs?per_page=100`,
          operation: "release-workflow-runs",
          field: "workflow_runs",
        }),
        readPaginatedArray(context, {
          path: `/repos/${OWNER}/${REPOSITORY}/actions/workflows/${RELEASE_WORKFLOW_ID}/runs?head_sha=${DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha}&per_page=100`,
          operation: "candidate-release-workflow-runs",
          field: "workflow_runs",
        }),
      ])
      const normalizedAll = normalizeReleaseRuns(allRuns)
      const normalizedCandidate = normalizeReleaseRuns(candidateRuns)
      if (
        normalizedCandidate.some(
          (run) => run.headSha !== DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha,
        )
      ) {
        fail("CANDIDATE_RUNS_CONFLICT", "Candidate workflow run identity is not exact")
      }
      const nonterminalRuns = normalizedAll.filter((run) => NONTERMINAL_STATUSES.has(run.status))
      return deepFreeze({ nonterminalRuns, candidateRuns: normalizedCandidate })
    },

    async readCandidatePublishJobs(runId) {
      assertPositiveInteger(runId, "candidate workflow run ID")
      const jobs = requirePresent(
        await github.listActionsRunJobs({ runId }),
        "CANDIDATE_JOBS_UNAVAILABLE",
        "Candidate workflow jobs could not be verified",
      )
      if (!Array.isArray(jobs)) {
        fail("CANDIDATE_JOBS_MALFORMED", "Candidate workflow jobs are malformed")
      }
      return deepFreeze(
        jobs.map((job) => ({
          id: job.id,
          runAttempt: job.runAttempt,
          name: job.name,
          status: job.status,
          conclusion: job.conclusion,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
        })),
      )
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
      const rawAssets = requirePresent(
        await github.listReleaseAssets({ releaseId }),
        "RELEASE_ASSETS_UNAVAILABLE",
        "Release asset inventory could not be verified",
      )
      return normalizeReleaseSnapshot({
        release,
        rawAssets,
        releaseId,
        expectedOriginalBody,
        github,
      })
    },

    async listCandidateReleases() {
      const releases = requirePresent(
        await github.listReleases(),
        "RELEASE_LIST_UNAVAILABLE",
        "Release inventory could not be verified",
      )
      if (!Array.isArray(releases)) {
        fail("RELEASE_LIST_MALFORMED", "Release inventory is malformed")
      }
      const candidates = []
      for (const raw of releases) {
        if (!isObject(raw) || !Number.isSafeInteger(raw.id) || raw.id < 1) {
          fail("RELEASE_LIST_MALFORMED", "Release inventory is malformed")
        }
        const marker = releaseMarker(raw.body)
        if (
          marker === null &&
          typeof raw.body === "string" &&
          raw.body.includes("DAWN_RELEASE_CONTROLLER_MARKER")
        ) {
          fail("RELEASE_LIST_MALFORMED", "Release inventory contains a malformed Dawn marker")
        }
        const identifiesCandidate =
          CANDIDATE_RELEASE_IDS.has(raw.id) ||
          raw.tag_name === CANDIDATE_TAG ||
          (marker !== null &&
            marker.version === DUPLICATE_DRAFT_RECOVERY_POLICY.version &&
            marker.commitSha === DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha &&
            marker.tag === CANDIDATE_TAG)
        if (identifiesCandidate) {
          candidates.push({
            releaseId: raw.id,
            tagName: raw.tag_name,
            draft: raw.draft,
            prerelease: raw.prerelease,
            immutable: raw.immutable,
            targetCommitish: raw.target_commitish,
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
    String(repository.id) !== REPOSITORY_ID ||
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

async function readRequiredCi(github, reviewedHeadSha) {
  const [checks, workflows] = await Promise.all([
    readBoundary("REVIEWED_VALIDATE_UNAVAILABLE", async () =>
      requirePresent(
        await github.getCommitCheckRuns({ commitSha: reviewedHeadSha }),
        "REVIEWED_VALIDATE_UNAVAILABLE",
        "Reviewed validate check could not be verified",
      ),
    ),
    readBoundary("REVIEWED_VALIDATE_UNAVAILABLE", async () =>
      requirePresent(
        await github.listWorkflowRuns({ workflow: "ci.yml", commitSha: reviewedHeadSha }),
        "REVIEWED_VALIDATE_UNAVAILABLE",
        "Reviewed CI workflow run could not be verified",
      ),
    ),
  ])
  if (!Array.isArray(checks) || !Array.isArray(workflows)) {
    fail("REVIEWED_VALIDATE_MALFORMED", "Reviewed CI validate evidence is malformed")
  }
  const matchingWorkflows = workflows.filter(
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
  const matchingChecks = checks.filter(
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
    typeof pull.merged_at !== "string" ||
    Number.isNaN(Date.parse(pull.merged_at)) ||
    pull.merge_commit_sha !== reviewedCommit ||
    !isObject(pull.base) ||
    pull.base.ref !== "main" ||
    !isObject(pull.base.repo) ||
    String(pull.base.repo.id) !== REPOSITORY_ID ||
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
  return value.map((raw) => {
    const run = safeSnapshot(raw, "RELEASE_RUNS_MALFORMED")
    if (
      !isObject(run) ||
      !Number.isSafeInteger(run.id) ||
      run.id < 1 ||
      seen.has(run.id) ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt < 1 ||
      ![...NONTERMINAL_STATUSES, "completed"].includes(run.status) ||
      !isSha(run.head_sha) ||
      run.path !== RELEASE_WORKFLOW_PATH
    ) {
      fail("RELEASE_RUNS_MALFORMED", "Release workflow runs are malformed")
    }
    seen.add(run.id)
    return {
      id: run.id,
      runAttempt: run.run_attempt,
      status: run.status,
      conclusion: run.conclusion ?? null,
      headSha: run.head_sha,
    }
  })
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
    typeof raw.tag_name !== "string" ||
    typeof raw.body !== "string" ||
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
  for (const rawAsset of rawAssets) {
    const asset = safeSnapshot(rawAsset, "RELEASE_ASSETS_MALFORMED")
    if (
      !isObject(asset) ||
      !Number.isSafeInteger(asset.id) ||
      asset.id < 1 ||
      typeof asset.name !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(asset.digest) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1
    ) {
      fail("RELEASE_ASSETS_MALFORMED", "Release asset inventory is malformed")
    }
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

async function readPaginatedArray(context, { path, operation, field }) {
  const records = []
  const seenUrls = new Set()
  let totalCount = null
  let url = `${API_ORIGIN}${path}`
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (seenUrls.has(url)) fail("PAGINATION_DRIFT", "Recovery read pagination is unsafe")
    seenUrls.add(url)
    const result = await context.http.getJson({
      url,
      headers: githubHeaders(context.token, "application/vnd.github+json"),
    })
    if (result.status !== "OK" || result.httpStatus !== 200 || result.code !== null) {
      fail(
        `${operation.toUpperCase().replaceAll("-", "_")}_UNAVAILABLE`,
        `${operation} read failed`,
      )
    }
    const body = safeSnapshot(result.body, "RELEASE_RUNS_MALFORMED")
    if (
      !isObject(body) ||
      !Number.isSafeInteger(body.total_count) ||
      body.total_count < 0 ||
      body.total_count > MAX_RECORDS ||
      !Array.isArray(body[field]) ||
      body[field].length > 100
    ) {
      fail("RELEASE_RUNS_MALFORMED", "Release workflow runs are malformed")
    }
    if (totalCount === null) totalCount = body.total_count
    if (body.total_count !== totalCount) {
      fail("PAGINATION_DRIFT", "Recovery read pagination total changed")
    }
    if (records.length + body[field].length > MAX_RECORDS) {
      fail("RELEASE_RUNS_OVER_LIMIT", "Release workflow runs exceed the record limit")
    }
    records.push(...body[field])
    const next = nextLink(result.headers?.link)
    if (next === null) {
      if (records.length !== totalCount) {
        fail("PAGINATION_DRIFT", "Recovery read pagination is incomplete")
      }
      return records
    }
    if (body[field].length !== 100 || records.length >= totalCount) {
      fail("PAGINATION_DRIFT", "Recovery read pagination is inconsistent")
    }
    const normalized = normalizePaginationUrl(next, path, page + 2)
    if (normalized === null) fail("PAGINATION_DRIFT", "Recovery read pagination is unsafe")
    url = normalized
  }
  fail("RELEASE_RUNS_OVER_LIMIT", "Release workflow runs exceed the page limit")
}

function normalizePaginationUrl(value, initialPath, expectedPage) {
  try {
    const url = new URL(value)
    const initial = new URL(`${API_ORIGIN}${initialPath}`)
    if (
      url.origin !== API_ORIGIN ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.pathname !== initial.pathname
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
    return pageEntries.length === 1 && pageEntries[0][1] === String(expectedPage) ? url.href : null
  } catch {
    return null
  }
}

function nextLink(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== "string") fail("PAGINATION_DRIFT", "Recovery read pagination is unsafe")
  const parts = value.split(",")
  const next = parts.filter((part) => /;\s*rel="next"\s*$/u.test(part.trim()))
  if (next.length === 0) return null
  if (next.length !== 1) fail("PAGINATION_DRIFT", "Recovery read pagination is unsafe")
  const match = /^\s*<([^>]+)>;\s*rel="next"\s*$/u.exec(next[0])
  if (match === null) fail("PAGINATION_DRIFT", "Recovery read pagination is unsafe")
  return match[1]
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
