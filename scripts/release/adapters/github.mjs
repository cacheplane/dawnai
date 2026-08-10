import { createHttpGet, DEFAULT_HTTP_MAX_RESPONSE_BYTES, DEFAULT_HTTP_TIMEOUT_MS } from "./http.mjs"

const API_ORIGIN = "https://api.github.com"
const API_VERSION = "2022-11-28"
const JSON_ACCEPT = "application/vnd.github+json"
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u
const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const CURSOR_PATTERN = /^[A-Za-z0-9._~+/=-]{1,512}$/u
const MAX_DOWNLOAD_LOCATION_BYTES = 4_096
const SIGNED_DOWNLOAD_HOSTS = new Set([
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "pipelines.actions.githubusercontent.com",
])
const SIGNED_AZURE_HOST_PATTERN = /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/u
const UNSAFE_REMOTE_KEYS = new Set(["__proto__", "constructor", "prototype"])
export const DEFAULT_GITHUB_MAX_PAGES = 100
export const DEFAULT_GITHUB_MAX_RECORDS = 10_000
const MAX_GITHUB_PAGES = 1_000
const MAX_GITHUB_RECORDS = 1_000_000
const MAX_GITHUB_OWNER_BYTES = 100
const MAX_GITHUB_REPOSITORY_BYTES = 256
const MAX_GITHUB_REF_BYTES = 1_024
const MAX_GITHUB_NAME_BYTES = 256
const MAX_GITHUB_ID_BYTES = 32
const MAX_GITHUB_DIGEST_BYTES = 128
const MAX_GITHUB_TOKEN_BYTES = 4_096

// Named methods return JSON-safe envelopes with status, operation, httpStatus, and code.
// JSON endpoints add canonicalized value; download endpoints add base64 content.
export function createGitHubReader({
  owner,
  repo,
  token,
  fetchImpl = fetch,
  timeoutMs,
  maxResponseBytes,
  maxPages = DEFAULT_GITHUB_MAX_PAGES,
  maxRecords = DEFAULT_GITHUB_MAX_RECORDS,
  now = Date.now,
}) {
  assertIdentity(owner, OWNER_PATTERN, "GitHub owner", MAX_GITHUB_OWNER_BYTES)
  assertIdentity(repo, REPOSITORY_PATTERN, "GitHub repository", MAX_GITHUB_REPOSITORY_BYTES)
  assertInputByteLength(token, MAX_GITHUB_TOKEN_BYTES, "GitHub token")
  if (
    token !== undefined &&
    (typeof token !== "string" || token.length === 0 || /[\r\n]/u.test(token))
  ) {
    throw new TypeError("Invalid GitHub token")
  }
  assertBoundedInteger(maxPages, 1, MAX_GITHUB_PAGES, "GitHub maximum pages")
  assertBoundedInteger(maxRecords, 1, MAX_GITHUB_RECORDS, "GitHub maximum records")
  if (typeof now !== "function") throw new TypeError("Invalid GitHub clock")
  const base = `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const http = createHttpGet({
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
  })
  const context = {
    base,
    http,
    token: token ?? null,
    timeoutMs: timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    maxResponseBytes: maxResponseBytes ?? DEFAULT_HTTP_MAX_RESPONSE_BYTES,
    maxPages,
    maxRecords,
    now,
  }

  return {
    getCommitCheckRuns({ commitSha }) {
      assertCommitSha(commitSha)
      return readPaginated(context, {
        initialUrl: `${base}/commits/${commitSha}/check-runs?per_page=100`,
        operation: "commit-check-runs",
        extract: objectArray("check_runs"),
        compare: compareIdThenName,
      })
    },
    getRef({ ref }) {
      assertRef(ref, "GitHub ref")
      return readObject(context, {
        url: `${base}/git/ref/${encodeURIComponent(ref)}`,
        operation: "ref",
      })
    },
    listTagRefs() {
      return readPaginated(context, {
        initialUrl: `${base}/git/matching-refs/tags/?per_page=100`,
        operation: "tag-refs",
        extract: arrayBody,
        compare: compareStringFieldThenCanonical("ref"),
      })
    },
    getReleaseByTag({ tag }) {
      assertTag(tag)
      return readObject(context, {
        url: `${base}/releases/tags/${encodeURIComponent(tag)}`,
        operation: "release",
      })
    },
    listReleaseAssets({ releaseId }) {
      const id = normalizeId(releaseId)
      return readPaginated(context, {
        initialUrl: `${base}/releases/${id}/assets?per_page=100`,
        operation: "release-assets",
        extract: arrayBody,
        compare: compareIdThenName,
      })
    },
    downloadReleaseAsset({ assetId }) {
      const id = normalizeId(assetId)
      return readBinary(context, {
        url: `${base}/releases/assets/${id}`,
        operation: "release-asset-download",
      })
    },
    listActionsArtifacts({ name } = {}) {
      if (name !== undefined) {
        assertSafeName(name, "Actions artifact name")
      }
      const query = new URLSearchParams({ per_page: "100" })
      if (name !== undefined) {
        query.set("name", name)
      }
      return readPaginated(context, {
        initialUrl: `${base}/actions/artifacts?${query}`,
        operation: "actions-artifacts",
        extract: objectArray("artifacts"),
        compare: compareIdThenName,
      })
    },
    getActionsRun({ runId }) {
      const id = normalizeId(runId)
      return readObject(context, {
        url: `${base}/actions/runs/${id}`,
        operation: "actions-run",
      })
    },
    listWorkflowRuns({ workflow, commitSha }) {
      assertWorkflow(workflow)
      assertCommitSha(commitSha)
      const query = new URLSearchParams({ head_sha: commitSha, per_page: "100" })
      return readPaginated(context, {
        initialUrl: `${base}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`,
        operation: "workflow-runs",
        extract: objectArray("workflow_runs"),
        compare: compareIdThenName,
      })
    },
    downloadActionsArtifact({ artifactId }) {
      const id = normalizeId(artifactId)
      return readBinary(context, {
        url: `${base}/actions/artifacts/${id}/zip`,
        operation: "actions-artifact-download",
      })
    },
    getAttestations({ subjectDigest }) {
      assertInputByteLength(subjectDigest, MAX_GITHUB_DIGEST_BYTES, "attestation subject digest")
      if (typeof subjectDigest !== "string" || !DIGEST_PATTERN.test(subjectDigest)) {
        throw new TypeError("Invalid attestation subject digest")
      }
      return readPaginated(context, {
        initialUrl: `${base}/attestations/${encodeURIComponent(subjectDigest)}?per_page=100`,
        operation: "attestations",
        extract: objectArray("attestations"),
        compare: compareAttestations,
        cursorPagination: true,
      })
    },
    getWorkflow({ workflow }) {
      assertWorkflow(workflow)
      return readObject(context, {
        url: `${base}/actions/workflows/${encodeURIComponent(workflow)}`,
        operation: "workflow",
      })
    },
    getActionsPermissions() {
      return readObject(context, {
        url: `${base}/actions/permissions`,
        operation: "actions-permissions",
      })
    },
    getWorkflowPermissions() {
      return readObject(context, {
        url: `${base}/actions/permissions/workflow`,
        operation: "workflow-permissions",
      })
    },
    listEnvironments() {
      return readPaginated(context, {
        initialUrl: `${base}/environments?per_page=100`,
        operation: "environments",
        extract: objectArray("environments"),
        compare: compareStringFieldThenCanonical("name"),
      })
    },
    getBranchProtection({ branch }) {
      assertRef(branch, "GitHub branch")
      return readObject(context, {
        url: `${base}/branches/${encodeURIComponent(branch)}/protection`,
        operation: "branch-protection",
      })
    },
  }
}

async function readObject(context, { url, operation, validate = isObject }) {
  const result = await readJson(context, { url, operation })
  if (result.status !== "PRESENT") {
    return publicResult(result)
  }
  if (!validate(result.body)) {
    return failure("ERROR", operation, result.httpStatus, "MALFORMED_SCHEMA")
  }
  let value
  try {
    value = canonicalJson(result.body, context.token)
  } catch (error) {
    return failure(
      "ERROR",
      operation,
      result.httpStatus,
      error instanceof UnsafeResponseKeyError ? error.code : "MALFORMED_SCHEMA",
    )
  }
  if (value === null) {
    return failure("ERROR", operation, result.httpStatus, "MALFORMED_SCHEMA")
  }
  return { ...publicResult(result), value }
}

async function readPaginated(
  context,
  { initialUrl, operation, extract, compare, cursorPagination = false },
) {
  const records = []
  const budget = createOperationBudget(context)
  let url = initialUrl
  for (let page = 0; page < context.maxPages; page += 1) {
    if (budget.deadline <= budget.now()) {
      return failure("AMBIGUOUS", operation, null, "TIMEOUT")
    }
    if (budget.remainingBytes < 1) {
      return failure("ERROR", operation, null, "OPERATION_TOO_LARGE")
    }
    const requestBudget = remainingRequestBudget(budget)
    if (requestBudget === null) {
      return failure("AMBIGUOUS", operation, null, "TIMEOUT")
    }
    const result = await readJson(context, {
      url,
      operation,
      requestBudget,
    })
    if (result.code === "RESPONSE_TOO_LARGE") {
      return failure("ERROR", operation, result.httpStatus, "OPERATION_TOO_LARGE")
    }
    if (result.status !== "PRESENT") {
      return publicResult(result)
    }
    budget.remainingBytes -= result.bodyBytes
    const pageRecords = extract(result.body)
    if (pageRecords === null) {
      return failure("ERROR", operation, result.httpStatus, "MALFORMED_SCHEMA")
    }
    if (records.length + pageRecords.length > context.maxRecords) {
      return failure("ERROR", operation, result.httpStatus, "RECORD_LIMIT_EXCEEDED")
    }
    for (const record of pageRecords) {
      let normalized
      try {
        normalized = canonicalJson(record, context.token)
      } catch (error) {
        return failure(
          "ERROR",
          operation,
          result.httpStatus,
          error instanceof UnsafeResponseKeyError ? error.code : "MALFORMED_SCHEMA",
        )
      }
      if (!isObject(normalized)) {
        return failure("ERROR", operation, result.httpStatus, "MALFORMED_SCHEMA")
      }
      records.push(normalized)
    }
    if (result.nextUrl === null) {
      records.sort(compare)
      return { ...publicResult(result), value: records }
    }
    if (page + 1 >= context.maxPages) {
      return failure("ERROR", operation, result.httpStatus, "PAGE_LIMIT_EXCEEDED")
    }
    const nextUrl = normalizeNextUrl(result.nextUrl, initialUrl, cursorPagination)
    if (nextUrl === null) {
      return failure("ERROR", operation, result.httpStatus, "UNSAFE_PAGINATION_URL")
    }
    url = nextUrl
  }
  return failure("ERROR", operation, null, "PAGE_LIMIT_EXCEEDED")
}

async function readJson(context, { url, operation, requestBudget = {} }) {
  const response = await context.http.getJson({
    url,
    headers: requestHeaders(context.token, JSON_ACCEPT),
    ...requestBudget,
  })
  const classification = classifyGitHubResponse(response, operation)
  if (classification.status !== "PRESENT") {
    return classification
  }
  const link = parseNextLink(response.headers.link)
  if (link.status === "ERROR") {
    return failure("ERROR", operation, response.httpStatus, "MALFORMED_LINK_HEADER")
  }
  return {
    ...classification,
    body: response.body,
    bodyBytes: response.bodyBytes,
    nextUrl: link.nextUrl,
  }
}

async function readBinary(context, { url, operation }) {
  const budget = createOperationBudget(context)
  const firstRequest = remainingRequestBudget(budget)
  if (firstRequest === null) {
    return failure("AMBIGUOUS", operation, null, "TIMEOUT")
  }
  const result = await context.http.getBinary({
    url,
    headers: requestHeaders(context.token, "application/octet-stream"),
    ...firstRequest,
  })
  if (result.code === "RESPONSE_TOO_LARGE") {
    return failure("ERROR", operation, result.httpStatus, "OPERATION_TOO_LARGE")
  }
  if (result.code === "REDIRECT") {
    if (result.httpStatus !== 302) {
      return failure("ERROR", operation, result.httpStatus, "REDIRECT")
    }
    const signedUrl = normalizeSignedDownloadUrl(result.headers?.location)
    if (signedUrl === null) {
      return failure("ERROR", operation, result.httpStatus, "UNSAFE_DOWNLOAD_URL")
    }
    const secondRequest = remainingRequestBudget(budget)
    if (secondRequest === null) {
      return failure("AMBIGUOUS", operation, null, "TIMEOUT")
    }
    const downloaded = await context.http.getBinary({
      url: signedUrl,
      headers: {},
      ...secondRequest,
    })
    if (downloaded.code === "RESPONSE_TOO_LARGE") {
      return failure("ERROR", operation, downloaded.httpStatus, "OPERATION_TOO_LARGE")
    }
    const downloadClassification = classifyGitHubResponse(downloaded, operation)
    return downloadClassification.status === "PRESENT"
      ? { ...downloadClassification, contentBase64: downloaded.contentBase64 }
      : downloadClassification
  }
  const classification = classifyGitHubResponse(result, operation)
  return classification.status === "PRESENT"
    ? { ...classification, contentBase64: result.contentBase64 }
    : classification
}

function createOperationBudget(context) {
  return {
    deadline: context.now() + context.timeoutMs,
    remainingBytes: context.maxResponseBytes,
    now: context.now,
  }
}

function remainingRequestBudget(budget) {
  const timeoutMs = budget.deadline - budget.now()
  return timeoutMs > 0
    ? { timeoutMs: Math.min(timeoutMs, 300_000), maxResponseBytes: budget.remainingBytes }
    : null
}

function normalizeSignedDownloadUrl(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_DOWNLOAD_LOCATION_BYTES) {
    return null
  }
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      (SIGNED_DOWNLOAD_HOSTS.has(hostname) || SIGNED_AZURE_HOST_PATTERN.test(hostname))
      ? url.href
      : null
  } catch {
    return null
  }
}

function classifyGitHubResponse(result, operation) {
  const httpStatus = result.httpStatus
  if (result.code === "MALFORMED_RESPONSE") {
    return failure("ERROR", operation, httpStatus, result.code)
  }
  if (httpStatus === 404) {
    return failure("AMBIGUOUS", operation, httpStatus, "NOT_FOUND_OR_HIDDEN")
  }
  if (httpStatus === 401) {
    return failure("AMBIGUOUS", operation, httpStatus, "UNAUTHORIZED")
  }
  if (httpStatus === 429 || result.headers?.rateLimitRemaining === "0") {
    return failure("AMBIGUOUS", operation, httpStatus, "RATE_LIMITED")
  }
  if (httpStatus === 403) {
    return failure("AMBIGUOUS", operation, httpStatus, "FORBIDDEN")
  }
  if (httpStatus >= 500) {
    return failure("AMBIGUOUS", operation, httpStatus, "SERVER_ERROR")
  }
  if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
    return result.code === "REDIRECT"
      ? failure("ERROR", operation, httpStatus, "REDIRECT")
      : failure("AMBIGUOUS", operation, httpStatus, `HTTP_${httpStatus}`)
  }
  if (result.status !== "OK") {
    return failure(
      ["ABORTED", "NETWORK_ERROR", "TIMEOUT"].includes(result.code) ? "AMBIGUOUS" : "ERROR",
      operation,
      httpStatus,
      result.code,
    )
  }
  return failure("PRESENT", operation, httpStatus, null)
}

function requestHeaders(token, accept) {
  return {
    Accept: accept,
    ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    "X-GitHub-Api-Version": API_VERSION,
  }
}

function normalizeNextUrl(value, initialValue, cursorPagination) {
  try {
    const url = new URL(value)
    const initial = new URL(initialValue)
    return url.origin === API_ORIGIN &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      url.pathname === initial.pathname &&
      paginationQueryMatches(url.searchParams, initial.searchParams, cursorPagination)
      ? url.href
      : null
  } catch {
    return null
  }
}

function paginationQueryMatches(actual, initial, cursorPagination) {
  const actualValues = queryValues(actual)
  const initialValues = queryValues(initial)
  if (actualValues === null || initialValues === null) {
    return false
  }
  for (const key of actualValues.keys()) {
    if (
      !initialValues.has(key) &&
      key !== "page" &&
      key !== "per_page" &&
      !(cursorPagination && (key === "before" || key === "after"))
    ) {
      return false
    }
  }
  for (const [key, values] of initialValues) {
    if (key !== "page" && key !== "per_page" && !arraysEqual(actualValues.get(key), values)) {
      return false
    }
  }
  const pages = actualValues.get("page")
  const before = actualValues.get("before")
  const after = actualValues.get("after")
  const cursor = before ?? after
  if (before !== undefined && after !== undefined) {
    return false
  }
  if (
    cursor === undefined
      ? pages?.length !== 1 || !isPositiveInteger(pages[0])
      : pages !== undefined || cursor.length !== 1 || !CURSOR_PATTERN.test(cursor[0])
  ) {
    return false
  }
  const perPage = actualValues.get("per_page")
  return (
    perPage === undefined ||
    (perPage.length === 1 && isPositiveInteger(perPage[0]) && Number(perPage[0]) <= 100)
  )
}

function queryValues(searchParams) {
  const values = new Map()
  for (const [key, value] of searchParams) {
    const entries = values.get(key) ?? []
    entries.push(value)
    values.set(key, entries)
    if (entries.length > 1) {
      return null
    }
  }
  return values
}

function arraysEqual(left, right) {
  return left?.length === right.length && left.every((value, index) => value === right[index])
}

function isPositiveInteger(value) {
  return /^[1-9][0-9]*$/u.test(value)
}

function parseNextLink(value) {
  if (value === null) {
    return { status: "NONE", nextUrl: null }
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return { status: "ERROR", nextUrl: null }
  }
  const nextUrls = []
  for (const part of value.split(",")) {
    const match = /^\s*<([^<>\s]+)>((?:\s*;[^;]*)+)\s*$/u.exec(part)
    if (match === null) {
      return { status: "ERROR", nextUrl: null }
    }
    const parameters = parseLinkParameters(match[2])
    if (parameters === null || !parameters.has("rel")) {
      return { status: "ERROR", nextUrl: null }
    }
    const relations = parameters.get("rel").split(/\s+/u)
    if (
      relations.length === 0 ||
      new Set(relations).size !== relations.length ||
      (relations.includes("next") && relations.includes("prev")) ||
      relations.some((relation) => !/^[A-Za-z][A-Za-z0-9._-]*$/u.test(relation))
    ) {
      return { status: "ERROR", nextUrl: null }
    }
    if (relations.includes("next")) {
      nextUrls.push(match[1])
    }
  }
  return nextUrls.length > 1
    ? { status: "ERROR", nextUrl: null }
    : { status: nextUrls.length === 1 ? "NEXT" : "NONE", nextUrl: nextUrls[0] ?? null }
}

function parseLinkParameters(value) {
  const parameters = new Map()
  let remaining = value
  while (remaining.length > 0) {
    const match =
      /^\s*;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)=(?:"([^"\\]*)"|([!#$%&'*+.^_`|~0-9A-Za-z-]+))/u.exec(
        remaining,
      )
    if (match === null || parameters.has(match[1].toLowerCase())) {
      return null
    }
    parameters.set(match[1].toLowerCase(), match[2] ?? match[3])
    remaining = remaining.slice(match[0].length)
  }
  return parameters
}

function canonicalJson(value, token) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return Number.isFinite(value) || typeof value !== "number" ? value : null
  }
  if (typeof value === "string") {
    return token === null ? value : value.split(token).join("[REDACTED]")
  }
  if (Array.isArray(value)) {
    const result = []
    for (const item of value) {
      const normalized = canonicalJson(item, token)
      if (normalized === undefined) {
        return null
      }
      result.push(normalized)
    }
    return result
  }
  if (!isObject(value)) {
    return undefined
  }
  const result = {}
  for (const key of Object.keys(value).sort()) {
    if (
      UNSAFE_REMOTE_KEYS.has(key) ||
      /token|secret|authorization|cookie/iu.test(key) ||
      (token !== null && key.includes(token))
    ) {
      throw new UnsafeResponseKeyError()
    }
    const normalized = canonicalJson(value[key], token)
    if (normalized === undefined) {
      return null
    }
    Object.defineProperty(result, key, {
      value: normalized,
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return result
}

class UnsafeResponseKeyError extends Error {
  constructor() {
    super("Unsafe response key")
    this.code = "UNSAFE_RESPONSE_KEY"
  }
}

function objectArray(field) {
  return (value) => (isObject(value) && Array.isArray(value[field]) ? value[field] : null)
}

function arrayBody(value) {
  return Array.isArray(value) ? value : null
}

function compareIdThenName(left, right) {
  const leftId = typeof left.id === "number" ? left.id : Number.MAX_SAFE_INTEGER
  const rightId = typeof right.id === "number" ? right.id : Number.MAX_SAFE_INTEGER
  if (leftId !== rightId) {
    return leftId < rightId ? -1 : 1
  }
  const nameComparison = compareStrings(String(left.name ?? ""), String(right.name ?? ""))
  return nameComparison === 0 ? compareCanonicalJson(left, right) : nameComparison
}

function compareAttestations(left, right) {
  if (Number.isSafeInteger(left.id) && Number.isSafeInteger(right.id) && left.id !== right.id) {
    return left.id - right.id
  }
  return compareCanonicalJson(left, right)
}

function compareStringFieldThenCanonical(field) {
  return (left, right) => {
    const comparison = compareStrings(String(left[field] ?? ""), String(right[field] ?? ""))
    return comparison === 0 ? compareCanonicalJson(left, right) : comparison
  }
}

function compareCanonicalJson(left, right) {
  return compareStrings(JSON.stringify(left), JSON.stringify(right))
}

function compareStrings(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

function assertCommitSha(value) {
  assertInputByteLength(value, MAX_GITHUB_DIGEST_BYTES, "GitHub commit SHA")
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new TypeError("Invalid GitHub commit SHA")
  }
}

function assertTag(value) {
  assertRef(value, "GitHub tag")
  if (value.startsWith("refs/")) {
    throw new TypeError("Invalid GitHub tag")
  }
}

function assertRef(value, label) {
  assertInputByteLength(value, MAX_GITHUB_REF_BYTES, label)
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError(`Invalid ${label}`)
  }
}

function assertWorkflow(value) {
  assertInputByteLength(value, MAX_GITHUB_NAME_BYTES, "GitHub workflow")
  if (typeof value !== "string" || !SAFE_NAME_PATTERN.test(value)) {
    throw new TypeError("Invalid GitHub workflow")
  }
}

function assertSafeName(value, label) {
  assertInputByteLength(value, MAX_GITHUB_NAME_BYTES, label)
  if (typeof value !== "string" || !SAFE_NAME_PATTERN.test(value)) {
    throw new TypeError(`Invalid ${label}`)
  }
}

function normalizeId(value) {
  assertInputByteLength(value, MAX_GITHUB_ID_BYTES, "GitHub resource ID")
  if (
    !(
      (Number.isSafeInteger(value) && value > 0) ||
      (typeof value === "string" && /^[1-9][0-9]*$/u.test(value))
    )
  ) {
    throw new TypeError("Invalid GitHub resource ID")
  }
  return String(value)
}

function assertIdentity(value, pattern, label, maximumBytes) {
  assertInputByteLength(value, maximumBytes, label)
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`Invalid ${label}`)
  }
}

function assertInputByteLength(value, maximum, label) {
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") > maximum) {
    const error = new TypeError(`${label} exceeds byte limit`)
    error.code = "INPUT_TOO_LONG"
    throw error
  }
}

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object"
}

function failure(status, operation, httpStatus, code) {
  return { status, operation, httpStatus, code }
}

function publicResult(result) {
  return failure(result.status, result.operation, result.httpStatus, result.code)
}

function assertBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Invalid ${label}`)
  }
}
