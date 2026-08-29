import path from "node:path"

import { readBoundedFixture } from "./fixture-io.mjs"
import { createReleasePreparationRunner } from "./process-runner.mjs"

const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/u
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/u
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml"
const RELEASE_WORKFLOW_ID = ".github%2Fworkflows%2Frelease.yml"
const NONTERMINAL_RUN_STATUSES = new Set([
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting",
])
const RELEASE_RUNS_JQ =
  'if type != "object" then error("malformed workflow runs response") elif keys != ["total_count","workflow_runs"] then error("malformed workflow runs response") elif (.workflow_runs | type) != "array" then error("malformed workflow runs response") else {total_count,run_ids:[.workflow_runs[].id],nonterminal_runs:[.workflow_runs[] | select(.status != "completed") | {id,run_attempt,status,event,head_sha,head_branch}]} end'
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_GITHUB_PAGES = 100
const MAX_GITHUB_RECORDS = 10_000
const MAX_GITHUB_REF_BYTES = 1_024
const MAX_GITHUB_EVENT_BYTES = 256
const MAX_GITHUB_BRANCH_BYTES = 1_024
const MAX_FILE_BASE64_BYTES = Math.ceil(MAX_FILE_BYTES / 3) * 4
const MAX_GITHUB_WRAPPED_BASE64_BYTES =
  MAX_FILE_BASE64_BYTES + Math.ceil(MAX_FILE_BASE64_BYTES / 60)
const API_VERSION = "2026-03-10"

export function createOwnerPreflightAdapters({
  cwd,
  environment = process.env,
  readFile,
  run,
} = {}) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new TypeError("Owner preflight adapter root is invalid")
  }
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("Owner preflight adapter environment is invalid")
  }
  const execute =
    run ??
    createReleasePreparationRunner({
      commandTimeoutMs: 15_000,
      overallTimeoutMs: 10 * 60_000,
      maxOutputBytes: 2 * 1024 * 1024,
    })
  if (typeof execute !== "function")
    throw new TypeError("Owner preflight command runner is invalid")
  const read =
    readFile ??
    ((filePath) =>
      readBoundedFixture(path.resolve(cwd, filePath), { root: cwd, maxBytes: MAX_FILE_BYTES }))
  if (typeof read !== "function") throw new TypeError("Owner preflight file reader is invalid")
  const baseEnvironment = safeEnvironment(environment)
  const githubEnvironment = {
    ...baseEnvironment,
    ...(credential(environment) === null ? {} : { GH_TOKEN: credential(environment) }),
  }

  async function executeExact(command, args, options = {}) {
    const result = await execute(command, args, {
      cwd,
      env: options.github === true ? githubEnvironment : baseEnvironment,
      ...(options.acceptedExitCodes === undefined
        ? {}
        : { acceptedExitCodes: options.acceptedExitCodes }),
    })
    if (
      result === null ||
      typeof result !== "object" ||
      !Number.isSafeInteger(result.exitCode) ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string"
    ) {
      throw new TypeError("Owner preflight command result is malformed")
    }
    return result
  }

  async function readGitHub(endpoint, { absenceAllowed = false } = {}) {
    let result
    try {
      result = await executeExact("gh", apiArguments(endpoint), {
        github: true,
        acceptedExitCodes: [0, 1],
      })
    } catch {
      return { status: "unavailable", httpStatus: null, value: null }
    }
    if (result.exitCode !== 0) {
      let response
      try {
        response = parseIncludedResponse(result.stdout)
      } catch {
        return { status: "unavailable", httpStatus: null, value: null }
      }
      if (absenceAllowed && response.httpStatus === 404) {
        return { status: "absent", httpStatus: 404, value: null }
      }
      return { status: "unavailable", httpStatus: response.httpStatus, value: null }
    }
    const response = parseIncludedResponse(result.stdout)
    if (result.exitCode === 0 && response.httpStatus === 200) {
      if (response.value === null || typeof response.value !== "object") {
        throw new TypeError("Owner preflight GitHub response is malformed")
      }
      return { status: "present", httpStatus: 200, value: response.value }
    }
    if (absenceAllowed && response.httpStatus === 404) {
      return { status: "absent", httpStatus: 404, value: null }
    }
    return { status: "unavailable", httpStatus: response.httpStatus, value: null }
  }

  async function readPaginatedGitHub(endpoint, normalize) {
    let result
    try {
      result = await executeExact("gh", paginatedApiArguments(endpoint), {
        github: true,
        acceptedExitCodes: [0, 1],
      })
    } catch {
      return { status: "unavailable", httpStatus: null, value: null }
    }
    if (result.exitCode !== 0) {
      return { status: "unavailable", httpStatus: null, value: null }
    }
    let pages
    try {
      pages = JSON.parse(result.stdout)
    } catch {
      throw new TypeError("Owner preflight GitHub paginated response JSON is malformed")
    }
    return { status: "present", httpStatus: 200, value: normalize(pages) }
  }

  async function readReleaseRuns(repository) {
    const rawRunIds = new Set()
    const nonterminalRunIds = new Set()
    const nonterminalRuns = []
    let totalCount = null
    let pageCount = 1
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const endpoint = `repos/${repository}/actions/workflows/${RELEASE_WORKFLOW_ID}/runs?per_page=100&page=${pageNumber}`
      let result
      try {
        result = await executeExact("gh", releaseRunsApiArguments(endpoint), {
          github: true,
          acceptedExitCodes: [0, 1],
        })
      } catch {
        return { status: "unavailable", httpStatus: null, value: null }
      }
      if (result.exitCode !== 0) {
        return { status: "unavailable", httpStatus: null, value: null }
      }
      let value
      try {
        value = JSON.parse(result.stdout)
      } catch {
        throw new TypeError("Owner preflight release runs response JSON is malformed")
      }
      const normalized = normalizeReleaseRunsPage(value)
      if (pageNumber === 1) {
        totalCount = normalized.totalCount
        pageCount = Math.max(1, Math.ceil(totalCount / 100))
        if (pageCount > MAX_GITHUB_PAGES) {
          throw new TypeError("Owner preflight release runs exceed the page bound")
        }
      } else if (normalized.totalCount !== totalCount) {
        throw new TypeError("Owner preflight release runs total is inconsistent")
      }
      const expectedPageRecords =
        totalCount === 0 ? 0 : pageNumber < pageCount ? 100 : totalCount - (pageCount - 1) * 100
      if (normalized.runIds.length !== expectedPageRecords) {
        throw new TypeError("Owner preflight release runs page is incomplete")
      }

      const pageRunIds = new Set()
      for (const id of normalized.runIds) {
        if (pageRunIds.has(id) || rawRunIds.has(id)) {
          throw new TypeError("Owner preflight release runs contain a duplicate raw identity")
        }
        pageRunIds.add(id)
        rawRunIds.add(id)
      }
      for (const run of normalized.nonterminalRuns) {
        if (!pageRunIds.has(run.id) || nonterminalRunIds.has(run.id)) {
          throw new TypeError("Owner preflight release runs contain an invalid active identity")
        }
        nonterminalRunIds.add(run.id)
        nonterminalRuns.push(run)
      }
    }
    if (rawRunIds.size !== totalCount) {
      throw new TypeError("Owner preflight release runs response is incomplete")
    }
    return {
      status: "present",
      httpStatus: 200,
      value: nonterminalRuns.sort(
        (left, right) => left.id - right.id || left.runAttempt - right.runAttempt,
      ),
    }
  }

  async function normalizeGitHubRead(resultPromise, normalize) {
    const result = await resultPromise
    return result.status === "present" ? { ...result, value: normalize(result.value) } : result
  }

  return Object.freeze({
    files: Object.freeze({
      async read(filePath) {
        if (typeof filePath !== "string" || filePath.length === 0 || path.isAbsolute(filePath)) {
          throw new TypeError("Owner preflight file path is invalid")
        }
        const value = await read(filePath)
        return Buffer.isBuffer(value) || value instanceof Uint8Array
          ? Buffer.from(value).toString("utf8")
          : value
      },
    }),
    git: Object.freeze({
      async headSha() {
        const result = await executeExact("git", ["rev-parse", "--verify", "HEAD^{commit}"])
        const value = result.stdout.trim()
        if (!/^[0-9a-f]{40}$/u.test(value)) {
          throw new TypeError("Owner preflight Git HEAD output is malformed")
        }
        return value
      },
    }),
    npm: Object.freeze({
      async version() {
        const result = await executeExact("npm", ["--version"])
        return exactVersion(result.stdout, "npm")
      },
      async trustList(name) {
        if (typeof name !== "string" || !PACKAGE_PATTERN.test(name)) {
          throw new TypeError("Owner preflight npm package is invalid")
        }
        let result
        try {
          result = await executeExact("npm", ["trust", "list", name, "--json"], {
            acceptedExitCodes: [0, 1],
          })
        } catch {
          return { status: "unavailable", code: "READ_FAILED" }
        }
        let value
        try {
          value = JSON.parse(result.stdout)
        } catch (error) {
          if (result.exitCode !== 0) return { status: "unavailable", code: "READ_FAILED" }
          throw new TypeError("Owner preflight npm trust JSON is malformed", { cause: error })
        }
        if (result.exitCode !== 0) {
          const code = value?.error?.code
          return {
            status: "unavailable",
            code: typeof code === "string" && CODE_PATTERN.test(code) ? code : "READ_FAILED",
          }
        }
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new TypeError("Owner preflight npm trust JSON is malformed")
        }
        return { status: "present", value }
      },
    }),
    github: Object.freeze({
      async version() {
        const result = await executeExact("gh", ["--version"], { github: true })
        const match = /^gh version ([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/u.exec(result.stdout)
        if (match === null) throw new TypeError("Owner preflight gh version is malformed")
        return match[1]
      },
      async getRepository(repository) {
        assertRepository(repository)
        return readGitHub(`repos/${repository}`)
      },
      async getWorkflow(workflowPath) {
        if (typeof workflowPath !== "string" || !WORKFLOW_PATH_PATTERN.test(workflowPath)) {
          throw new TypeError("Owner preflight workflow path is invalid")
        }
        const repository = repositoryFromEnvironment(environment)
        return readGitHub(`repos/${repository}/actions/workflows/${path.basename(workflowPath)}`, {
          absenceAllowed: true,
        })
      },
      async getEnvironment(name) {
        if (typeof name !== "string" || !ENVIRONMENT_PATTERN.test(name)) {
          throw new TypeError("Owner preflight environment name is invalid")
        }
        const repository = repositoryFromEnvironment(environment)
        return readGitHub(`repos/${repository}/environments/${encodeURIComponent(name)}`)
      },
      async getImmutableReleases(repository) {
        assertRepository(repository)
        return readGitHub(`repos/${repository}/immutable-releases`, { absenceAllowed: true })
      },
      async getDefaultBranchRef(repository, branch) {
        assertRepository(repository)
        assertDefaultBranch(branch)
        return normalizeGitHubRead(readGitHub(`repos/${repository}/git/ref/heads/main`), (value) =>
          normalizeDefaultBranchRef(value, branch),
        )
      },
      async listManagedCandidateRefs(repository) {
        assertRepository(repository)
        return readPaginatedGitHub(
          `repos/${repository}/git/matching-refs/tags/v?per_page=100`,
          normalizeManagedCandidateRefs,
        )
      },
      async getAnnotatedTag(repository, tagObjectSha) {
        assertRepository(repository)
        assertSha(tagObjectSha, "tag object SHA")
        return normalizeGitHubRead(
          readGitHub(`repos/${repository}/git/tags/${tagObjectSha}`),
          (value) => normalizeAnnotatedTag(value, tagObjectSha),
        )
      },
      async getWorkflowContent(repository, workflowPath, commitSha) {
        assertRepository(repository)
        assertReleaseWorkflowPath(workflowPath)
        assertSha(commitSha, "workflow commit SHA")
        return normalizeGitHubRead(
          readGitHub(`repos/${repository}/contents/${RELEASE_WORKFLOW_PATH}?ref=${commitSha}`, {
            absenceAllowed: true,
          }),
          (value) => normalizeWorkflowContent(value, workflowPath),
        )
      },
      async listReleaseRuns(repository, workflowPath, ...extraArguments) {
        if (extraArguments.length !== 0) {
          throw new TypeError("Owner preflight release run arguments are invalid")
        }
        assertRepository(repository)
        assertReleaseWorkflowPath(workflowPath)
        return readReleaseRuns(repository)
      },
    }),
  })
}

function apiArguments(endpoint) {
  return [
    "api",
    "--include",
    "--method",
    "GET",
    "--header",
    "Accept: application/vnd.github+json",
    "--header",
    `X-GitHub-Api-Version: ${API_VERSION}`,
    endpoint,
  ]
}

function paginatedApiArguments(endpoint) {
  return [
    "api",
    "--paginate",
    "--slurp",
    "--method",
    "GET",
    "--header",
    "Accept: application/vnd.github+json",
    "--header",
    `X-GitHub-Api-Version: ${API_VERSION}`,
    endpoint,
  ]
}

function releaseRunsApiArguments(endpoint) {
  return [
    "api",
    "--method",
    "GET",
    "--header",
    "Accept: application/vnd.github+json",
    "--header",
    `X-GitHub-Api-Version: ${API_VERSION}`,
    "--jq",
    RELEASE_RUNS_JQ,
    endpoint,
  ]
}

function parseIncludedResponse(stdout) {
  const matches = [...stdout.matchAll(/^HTTP\/\S+\s+([0-9]{3})[^\r\n]*\r?$/gmu)]
  const match = matches.at(-1)
  if (match === undefined) throw new TypeError("Owner preflight GitHub HTTP response is malformed")
  const remainder = stdout.slice(match.index + match[0].length).replace(/^\r?\n/u, "")
  const separator = /\r?\n\r?\n/u.exec(remainder)
  if (separator === null) throw new TypeError("Owner preflight GitHub HTTP headers are malformed")
  const body = remainder.slice(separator.index + separator[0].length).trim()
  let value = null
  if (body.length > 0) {
    try {
      value = JSON.parse(body)
    } catch {
      throw new TypeError("Owner preflight GitHub response JSON is malformed")
    }
  }
  return { httpStatus: Number(match[1]), value }
}

function normalizeDefaultBranchRef(value, branch) {
  if (
    !isObject(value) ||
    value.ref !== `refs/heads/${branch}` ||
    !isObject(value.object) ||
    value.object.type !== "commit" ||
    !isSha(value.object.sha)
  ) {
    throw new TypeError("Owner preflight default branch ref is malformed")
  }
  return { ref: value.ref, object: { type: "commit", sha: value.object.sha } }
}

function normalizeManagedCandidateRefs(pages) {
  assertPageCount(pages, "managed candidate refs")
  const refs = []
  const identities = new Set()
  for (const page of pages) {
    if (!Array.isArray(page)) {
      throw new TypeError("Owner preflight managed candidate refs page is malformed")
    }
    if (page.length > 100 || refs.length + page.length > MAX_GITHUB_RECORDS) {
      throw new TypeError("Owner preflight managed candidate refs exceed the record bound")
    }
    for (const value of page) {
      const ref = normalizeManagedCandidateRef(value)
      if (identities.has(ref.ref)) {
        throw new TypeError("Owner preflight managed candidate refs contain a duplicate identity")
      }
      identities.add(ref.ref)
      refs.push(ref)
    }
  }
  return refs.sort((left, right) => compareStrings(left.ref, right.ref))
}

function normalizeManagedCandidateRef(value) {
  if (
    !isObject(value) ||
    !isManagedTagRef(value.ref) ||
    !isObject(value.object) ||
    !["commit", "tag"].includes(value.object.type) ||
    !isSha(value.object.sha)
  ) {
    throw new TypeError("Owner preflight managed candidate refs contain malformed evidence")
  }
  return {
    ref: value.ref,
    object: { type: value.object.type, sha: value.object.sha },
  }
}

function normalizeAnnotatedTag(value, tagObjectSha) {
  if (
    !isObject(value) ||
    value.sha !== tagObjectSha ||
    !isObject(value.object) ||
    value.object.type !== "commit" ||
    !isSha(value.object.sha)
  ) {
    throw new TypeError("Owner preflight annotated tag is malformed")
  }
  return { sha: tagObjectSha, object: { type: "commit", sha: value.object.sha } }
}

function normalizeWorkflowContent(value, workflowPath) {
  if (
    !isObject(value) ||
    value.type !== "file" ||
    value.encoding !== "base64" ||
    value.path !== workflowPath ||
    value.name !== path.basename(workflowPath) ||
    !isSha(value.sha) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > MAX_FILE_BYTES ||
    typeof value.content !== "string" ||
    value.content.length === 0 ||
    value.content.length > MAX_GITHUB_WRAPPED_BASE64_BYTES ||
    (Object.hasOwn(value, "truncated") && value.truncated !== false)
  ) {
    throw new TypeError("Owner preflight workflow content is malformed")
  }
  const contentBase64 = normalizeGitHubBase64(value.content)
  if (contentBase64 === null || contentBase64.length > MAX_FILE_BASE64_BYTES) {
    throw new TypeError("Owner preflight workflow content is malformed")
  }
  const bytes = Buffer.from(contentBase64, "base64")
  if (
    bytes.length !== value.size ||
    bytes.length > MAX_FILE_BYTES ||
    bytes.toString("base64") !== contentBase64
  ) {
    throw new TypeError("Owner preflight workflow content is malformed")
  }
  return { path: value.path, sha: value.sha, contentBase64 }
}

function normalizeGitHubBase64(value) {
  if (!value.includes("\n")) return value
  const contentBase64 = value.replaceAll("\n", "")
  return value === wrapGitHubBase64(contentBase64) ? contentBase64 : null
}

function wrapGitHubBase64(value) {
  let wrapped = ""
  for (let offset = 0; offset < value.length; offset += 60) {
    wrapped += `${value.slice(offset, offset + 60)}\n`
  }
  return wrapped
}

function normalizeReleaseRunsPage(value) {
  if (!hasExactFields(value, ["total_count", "run_ids", "nonterminal_runs"])) {
    throw new TypeError("Owner preflight release runs page is malformed")
  }
  if (
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 0 ||
    value.total_count > MAX_GITHUB_RECORDS ||
    !Array.isArray(value.run_ids) ||
    value.run_ids.length > 100 ||
    !Array.isArray(value.nonterminal_runs) ||
    value.nonterminal_runs.length > value.run_ids.length
  ) {
    throw new TypeError("Owner preflight release runs page is malformed")
  }
  const runIds = value.run_ids.map((id) => {
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new TypeError("Owner preflight release runs contain a malformed raw identity")
    }
    return id
  })
  return {
    totalCount: value.total_count,
    runIds,
    nonterminalRuns: value.nonterminal_runs.map(normalizeReleaseRun),
  }
}

function normalizeReleaseRun(value) {
  if (
    !hasExactFields(value, ["id", "run_attempt", "status", "event", "head_sha", "head_branch"]) ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    !Number.isSafeInteger(value.run_attempt) ||
    value.run_attempt < 1 ||
    !NONTERMINAL_RUN_STATUSES.has(value.status) ||
    !isBoundedString(value.event, MAX_GITHUB_EVENT_BYTES) ||
    !isSha(value.head_sha) ||
    !isBoundedString(value.head_branch, MAX_GITHUB_BRANCH_BYTES)
  ) {
    throw new TypeError("Owner preflight release runs contain malformed evidence")
  }
  return {
    id: value.id,
    runAttempt: value.run_attempt,
    status: value.status,
    event: value.event,
    headSha: value.head_sha,
    headBranch: value.head_branch,
  }
}

function assertPageCount(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_GITHUB_PAGES) {
    throw new TypeError(`Owner preflight ${label} exceed the page bound`)
  }
}

function hasExactFields(value, fields) {
  if (!isObject(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  return (
    actual.length === expected.length && actual.every((name, index) => name === expected[index])
  )
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value)
}

function isBoundedString(value, maximumBytes) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    ![...value].some((character) => [0, 10, 13].includes(character.codePointAt(0)))
  )
}

function isManagedTagRef(value) {
  if (
    !isBoundedString(value, MAX_GITHUB_REF_BYTES) ||
    !value.startsWith("refs/tags/v") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint <= 32 || codePoint === 127
    })
  ) {
    return false
  }
  if ([...value].some((character) => "~^:?*[\\".includes(character))) return false
  return value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"))
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function exactVersion(value, label) {
  const normalized = value.trim()
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(normalized)) {
    throw new TypeError(`Owner preflight ${label} version is malformed`)
  }
  return normalized
}

function repositoryFromEnvironment(environment) {
  const repository = environment.GITHUB_REPOSITORY ?? "cacheplane/dawnai"
  assertRepository(repository)
  return repository
}

function assertRepository(value) {
  if (typeof value !== "string" || !REPOSITORY_PATTERN.test(value)) {
    throw new TypeError("Owner preflight repository is invalid")
  }
}

function assertDefaultBranch(value) {
  if (value !== "main") {
    throw new TypeError("Owner preflight default branch is invalid")
  }
}

function assertReleaseWorkflowPath(value) {
  if (value !== RELEASE_WORKFLOW_PATH) {
    throw new TypeError("Owner preflight release workflow path is invalid")
  }
}

function assertSha(value, label) {
  if (!isSha(value)) {
    throw new TypeError(`Owner preflight ${label} is invalid`)
  }
}

function credential(environment) {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = environment[name]
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

function safeEnvironment(environment) {
  const names = ["CI", "HOME", "LANG", "LC_ALL", "PATH", "TEMP", "TMP", "TMPDIR", "USERPROFILE"]
  return {
    ...Object.fromEntries(
      names.flatMap((name) =>
        typeof environment[name] === "string" ? [[name, environment[name]]] : [],
      ),
    ),
    NO_COLOR: "1",
  }
}
