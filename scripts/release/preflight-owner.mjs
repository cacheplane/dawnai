import { createHash } from "node:crypto"

import { snapshotJson } from "./adapter-normalize.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "./manifest.mjs"
import { compareSemver, isExactSemver, parseSemver } from "./semver.mjs"

const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u
const MAX_EVIDENCE_BYTES = 1024 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_VALIDITY_MS = 15 * 60_000
const RELEASE_WORKFLOW = ".github/workflows/release.yml"
const PUBLISH_CHART_WORKFLOW = ".github/workflows/publish-chart.yml"
const CONTROLLER_SCHEMA = "scripts/release/controller-schema.json"

export const OWNER_PREFLIGHT_FILES = Object.freeze([
  ".github/workflows/version-pr.yml",
  RELEASE_WORKFLOW,
  ".github/workflows/published-artifact-verify.yml",
  PUBLISH_CHART_WORKFLOW,
  CONTROLLER_SCHEMA,
])

const EVIDENCE_FIELDS = Object.freeze([
  "schemaVersion",
  "phase",
  "repository",
  "defaultBranch",
  "headSha",
  "capturedAt",
  "expiresAt",
  "tools",
  "files",
  "packages",
  "github",
])
const REPORT_STATUSES = new Set(["PASS", "FAIL", "UNPROVABLE"])

export async function captureOwnerEvidence({
  phase,
  repository,
  packageNames,
  files,
  git,
  npm,
  github,
  now = Date.now,
}) {
  assertPhase(phase)
  if (!REPOSITORY_PATTERN.test(repository)) throw new TypeError("Owner repository is invalid")
  assertCanonicalPackages(packageNames)
  const readFile = bindMethod(files, "read", "owner preflight file reader")
  const readHead = bindMethod(git, "headSha", "owner preflight Git reader")
  const npmVersion = bindMethod(npm, "version", "owner preflight npm adapter")
  const trustList = bindMethod(npm, "trustList", "owner preflight npm adapter")
  const ghVersion = bindMethod(github, "version", "owner preflight GitHub adapter")
  const getRepository = bindMethod(github, "getRepository", "owner preflight GitHub adapter")
  const getWorkflow = bindMethod(github, "getWorkflow", "owner preflight GitHub adapter")
  const getEnvironment = bindMethod(github, "getEnvironment", "owner preflight GitHub adapter")
  const getImmutableReleases = bindMethod(
    github,
    "getImmutableReleases",
    "owner preflight GitHub adapter",
  )
  if (typeof now !== "function") throw new TypeError("Owner preflight clock is invalid")
  const capturedAtMs = now()
  if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs < 0) {
    throw new TypeError("Owner preflight capture time is invalid")
  }

  const localFiles = []
  const localBytes = new Map()
  for (const filePath of OWNER_PREFLIGHT_FILES) {
    const bytes = normalizeBytes(await readFile(filePath), filePath)
    localBytes.set(filePath, bytes)
    localFiles.push({ path: filePath, sha256: sha256(bytes) })
  }
  const schema = parseControllerSchema(localBytes.get(CONTROLLER_SCHEMA))
  if (schema.abandonmentEnvironment.length === 0) {
    throw new TypeError("Controller abandonment environment is invalid")
  }

  const headSha = await readHead()
  if (typeof headSha !== "string" || !SHA_PATTERN.test(headSha)) {
    throw new TypeError("Owner preflight HEAD is invalid")
  }
  const toolVersions = {
    npm: normalizeToolVersion(await npmVersion(), "npm"),
    gh: normalizeToolVersion(await ghVersion(), "gh"),
  }

  const repositoryResult = normalizeRepositoryResult(await getRepository(repository), repository)
  const workflows = []
  for (const filePath of OWNER_PREFLIGHT_FILES.filter((path) => path.endsWith(".yml"))) {
    workflows.push(normalizeWorkflowResult(await getWorkflow(filePath), filePath))
  }
  const environment = normalizeEnvironmentResult(
    await getEnvironment(schema.abandonmentEnvironment),
    schema.abandonmentEnvironment,
  )
  const immutableReleases = normalizeImmutableResult(
    await getImmutableReleases(repository),
    repository,
  )

  const packages = []
  for (const name of packageNames) {
    packages.push(normalizeTrustResult(await trustList(name), name))
  }
  const capturedAt = new Date(capturedAtMs).toISOString()
  const evidence = {
    schemaVersion: 1,
    phase,
    repository,
    defaultBranch: repositoryResult.defaultBranch,
    headSha,
    capturedAt,
    expiresAt: new Date(capturedAtMs + MAX_VALIDITY_MS).toISOString(),
    tools: toolVersions,
    files: localFiles,
    packages,
    github: {
      repository: repositoryResult,
      workflows,
      abandonmentEnvironment: environment,
      immutableReleases,
    },
  }
  return deepFreeze(parseOwnerEvidence(canonicalOwnerEvidenceBytes(evidence)))
}

export function canonicalOwnerEvidenceBytes(value) {
  const evidence = normalizeOwnerEvidence(value)
  const bytes = Buffer.from(`${JSON.stringify(canonicalize(evidence))}\n`, "utf8")
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) throw new TypeError("Owner evidence is too large")
  return bytes
}

export function parseOwnerEvidence(value) {
  const bytes = normalizeBytes(value, "owner evidence", MAX_EVIDENCE_BYTES)
  if (bytes.byteLength === 0 || bytes.at(-1) !== 0x0a || bytes.includes(0x0d)) {
    throw new TypeError("Owner evidence bytes are not canonical")
  }
  let parsed
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw new TypeError("Owner evidence is not UTF-8 JSON", { cause: error })
  }
  const evidence = normalizeOwnerEvidence(parsed)
  const canonical = Buffer.from(`${JSON.stringify(canonicalize(evidence))}\n`, "utf8")
  if (!canonical.equals(bytes)) throw new TypeError("Owner evidence is not canonical")
  return deepFreeze(evidence)
}

export function verifyOwnerEvidence({ evidence, currentHeadSha, currentFiles, now = Date.now }) {
  const normalized = normalizeOwnerEvidence(evidence)
  if (typeof now !== "function") throw new TypeError("Owner evidence verifier clock is invalid")
  if (typeof currentHeadSha !== "string" || !SHA_PATTERN.test(currentHeadSha)) {
    throw new TypeError("Current owner preflight HEAD is invalid")
  }
  if (!(currentFiles instanceof Map))
    throw new TypeError("Current owner preflight files are invalid")
  const nowMs = now()
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("Owner evidence verifier time is invalid")
  }

  const checks = []
  const capturedAtMs = Date.parse(normalized.capturedAt)
  const expiresAtMs = Date.parse(normalized.expiresAt)
  checks.push(
    capturedAtMs > nowMs
      ? result("freshness", "FAIL", "Owner evidence capture time is in the future.")
      : expiresAtMs < nowMs
        ? result("freshness", "UNPROVABLE", "Owner evidence has expired and must be recaptured.")
        : result("freshness", "PASS", "Owner evidence is within its bounded validity window."),
  )
  checks.push(
    normalized.headSha === currentHeadSha
      ? result("head-identity", "PASS", "Owner evidence matches the exact local HEAD.")
      : result("head-identity", "FAIL", "Owner evidence was captured for another HEAD."),
  )

  const fileCheck = verifyCurrentFiles(normalized.files, currentFiles)
  checks.push(fileCheck)
  let schema = null
  try {
    schema = parseControllerSchema(currentFiles.get(CONTROLLER_SCHEMA))
    checks.push(
      result("controller-schema", "PASS", "The controller schema is exact and parseable."),
    )
  } catch {
    checks.push(result("controller-schema", "FAIL", "The controller schema is invalid."))
  }

  checks.push(verifyTools(normalized.tools))
  checks.push(verifyRepository(normalized))
  checks.push(verifyWorkflows(normalized.phase, normalized.github.workflows))
  checks.push(verifyImmutable(normalized.phase, normalized.github.immutableReleases))
  checks.push(
    verifyAbandonmentEnvironment(
      normalized.github.abandonmentEnvironment,
      schema?.abandonmentEnvironment ?? null,
    ),
  )
  checks.push(
    verifyPublishers(
      normalized.packages,
      normalized.repository,
      schema?.npmTrustedPublisherEnvironment,
    ),
  )
  checks.sort((left, right) => compareText(left.id, right.id))
  return deepFreeze({
    schemaVersion: 1,
    phase: normalized.phase,
    status: overallStatus(checks),
    checks,
  })
}

export function renderOwnerPreflightReport(value, { format = "markdown" } = {}) {
  const report = safeSnapshot(value, "Owner preflight report")
  assertExactFields(
    report,
    ["schemaVersion", "phase", "status", "checks"],
    "Owner preflight report",
  )
  if (
    report.schemaVersion !== 1 ||
    !["pre-enable", "post-enable"].includes(report.phase) ||
    !REPORT_STATUSES.has(report.status) ||
    !Array.isArray(report.checks) ||
    report.checks.length === 0 ||
    !report.checks.every(
      (check) =>
        isRecord(check) &&
        Object.keys(check).length === 3 &&
        typeof check.id === "string" &&
        REPORT_STATUSES.has(check.status) &&
        typeof check.summary === "string",
    )
  ) {
    throw new TypeError("Owner preflight report is invalid")
  }
  if (format === "json") return `${JSON.stringify(canonicalize(report), null, 2)}\n`
  if (format !== "markdown") throw new TypeError("Owner preflight report format is invalid")
  return [
    "# Release owner preflight",
    "",
    `Phase: \`${report.phase}\``,
    `Status: \`${report.status}\``,
    "",
    ...report.checks.map(
      (check) => `- \`${check.status}\` \`${check.id}\` — ${safeMarkdown(check.summary)}`,
    ),
    "",
  ].join("\n")
}

function normalizeOwnerEvidence(value) {
  const evidence = safeSnapshot(value, "Owner evidence")
  assertExactFields(evidence, EVIDENCE_FIELDS, "Owner evidence")
  if (
    evidence.schemaVersion !== 1 ||
    !["pre-enable", "post-enable"].includes(evidence.phase) ||
    typeof evidence.repository !== "string" ||
    !REPOSITORY_PATTERN.test(evidence.repository) ||
    !["string", "object"].includes(typeof evidence.defaultBranch) ||
    (evidence.defaultBranch !== null && evidence.defaultBranch !== "main") ||
    typeof evidence.headSha !== "string" ||
    !SHA_PATTERN.test(evidence.headSha) ||
    !isCanonicalTimestamp(evidence.capturedAt) ||
    !isCanonicalTimestamp(evidence.expiresAt)
  ) {
    throw new TypeError("Owner evidence identity is invalid")
  }
  const capturedAt = Date.parse(evidence.capturedAt)
  const expiresAt = Date.parse(evidence.expiresAt)
  if (expiresAt <= capturedAt || expiresAt - capturedAt > MAX_VALIDITY_MS) {
    throw new TypeError("Owner evidence validity window is invalid")
  }
  const tools = normalizeTools(evidence.tools)
  const files = normalizeFileEvidence(evidence.files)
  const packages = normalizePackageEvidence(evidence.packages)
  const github = normalizeGitHubEvidence(evidence.github, evidence.repository)
  if (evidence.defaultBranch !== github.repository.defaultBranch) {
    throw new TypeError("Owner evidence default branch conflicts with repository evidence")
  }
  return {
    schemaVersion: 1,
    phase: evidence.phase,
    repository: evidence.repository,
    defaultBranch: evidence.defaultBranch,
    headSha: evidence.headSha,
    capturedAt: evidence.capturedAt,
    expiresAt: evidence.expiresAt,
    tools,
    files,
    packages,
    github,
  }
}

function normalizeTools(value) {
  assertExactFields(value, ["npm", "gh"], "Owner evidence tools")
  return {
    npm: normalizeToolVersion(value.npm, "npm"),
    gh: normalizeToolVersion(value.gh, "gh"),
  }
}

function normalizeFileEvidence(value) {
  if (!Array.isArray(value) || value.length !== OWNER_PREFLIGHT_FILES.length) {
    throw new TypeError("Owner evidence file inventory is invalid")
  }
  return value.map((entry, index) => {
    assertExactFields(entry, ["path", "sha256"], "Owner evidence file")
    if (entry.path !== OWNER_PREFLIGHT_FILES[index] || !SHA256_PATTERN.test(entry.sha256)) {
      throw new TypeError("Owner evidence file identity is invalid")
    }
    return { path: entry.path, sha256: entry.sha256 }
  })
}

function normalizePackageEvidence(value) {
  if (!Array.isArray(value) || value.length !== CANONICAL_RELEASE_PACKAGE_ORDER.length) {
    throw new TypeError("Owner evidence package inventory is invalid")
  }
  return value.map((entry, index) => {
    if (!isRecord(entry) || entry.name !== CANONICAL_RELEASE_PACKAGE_ORDER[index]) {
      throw new TypeError("Owner evidence package identity is invalid")
    }
    const operation = `npm trust list ${entry.name} --json`
    if (entry.status === "present") {
      assertExactFields(
        entry,
        ["name", "operation", "status", "code", "publisher"],
        "Owner package trust evidence",
      )
      if (entry.operation !== operation || entry.code !== null) {
        throw new TypeError("Owner package trust operation is invalid")
      }
      return {
        name: entry.name,
        operation,
        status: "present",
        code: null,
        publisher: normalizePublisher(entry.publisher),
      }
    }
    assertExactFields(
      entry,
      ["name", "operation", "status", "code", "publisher"],
      "Owner package trust evidence",
    )
    if (
      entry.status !== "unavailable" ||
      entry.operation !== operation ||
      typeof entry.code !== "string" ||
      !CODE_PATTERN.test(entry.code) ||
      entry.publisher !== null
    ) {
      throw new TypeError("Unavailable owner package trust evidence is invalid")
    }
    return { name: entry.name, operation, status: "unavailable", code: entry.code, publisher: null }
  })
}

function normalizePublisher(value) {
  assertExactFields(
    value,
    ["id", "type", "repository", "file", "environment", "permissions"],
    "npm trusted publisher",
  )
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 256 ||
    value.type !== "github" ||
    typeof value.repository !== "string" ||
    !REPOSITORY_PATTERN.test(value.repository) ||
    typeof value.file !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/u.test(value.file) ||
    (value.environment !== null &&
      (typeof value.environment !== "string" || value.environment.length === 0)) ||
    !Array.isArray(value.permissions) ||
    value.permissions.length === 0 ||
    !value.permissions.every(
      (permission, index, values) =>
        ["createPackage", "createStagedPackage"].includes(permission) &&
        values.indexOf(permission) === index,
    )
  ) {
    throw new TypeError("npm trusted publisher is invalid")
  }
  return {
    id: value.id,
    type: value.type,
    repository: value.repository,
    file: value.file,
    environment: value.environment,
    permissions: [...value.permissions].sort(compareText),
  }
}

function normalizeGitHubEvidence(value, repository) {
  assertExactFields(
    value,
    ["repository", "workflows", "abandonmentEnvironment", "immutableReleases"],
    "Owner GitHub evidence",
  )
  return {
    repository: normalizeRepositoryEvidence(value.repository, repository),
    workflows: normalizeWorkflowEvidence(value.workflows),
    abandonmentEnvironment: normalizeEnvironmentEvidence(value.abandonmentEnvironment),
    immutableReleases: normalizeImmutableEvidence(value.immutableReleases, repository),
  }
}

function normalizeRepositoryEvidence(value, repository) {
  assertExactFields(
    value,
    ["operation", "status", "httpStatus", "id", "fullName", "defaultBranch", "administration"],
    "Owner repository evidence",
  )
  if (value.operation !== `GET /repos/${repository}`) {
    throw new TypeError("Owner repository operation is invalid")
  }
  if (value.status === "unavailable") {
    if (
      value.httpStatus !== null ||
      value.id !== null ||
      value.fullName !== null ||
      value.defaultBranch !== null ||
      value.administration !== null
    ) {
      throw new TypeError("Unavailable owner repository evidence is invalid")
    }
    return { ...value }
  }
  if (
    value.status !== "present" ||
    value.httpStatus !== 200 ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    value.fullName !== repository ||
    value.defaultBranch !== "main" ||
    typeof value.administration !== "boolean"
  ) {
    throw new TypeError("Owner repository evidence is invalid")
  }
  return { ...value }
}

function normalizeWorkflowEvidence(value) {
  const paths = OWNER_PREFLIGHT_FILES.filter((path) => path.endsWith(".yml"))
  if (!Array.isArray(value) || value.length !== paths.length) {
    throw new TypeError("Owner workflow evidence inventory is invalid")
  }
  return value.map((entry, index) => {
    const path = paths[index]
    assertExactFields(
      entry,
      ["operation", "status", "httpStatus", "path", "id", "state"],
      "Owner workflow evidence",
    )
    if (
      entry.operation !== `GET /repos/{owner}/{repo}/actions/workflows/${path}` ||
      entry.path !== path
    ) {
      throw new TypeError("Owner workflow operation is invalid")
    }
    if (entry.status === "absent") {
      if (entry.httpStatus !== 404 || entry.id !== null || entry.state !== "absent") {
        throw new TypeError("Absent owner workflow evidence is invalid")
      }
    } else if (entry.status === "unavailable") {
      if (entry.httpStatus !== null || entry.id !== null || entry.state !== "unavailable") {
        throw new TypeError("Unavailable owner workflow evidence is invalid")
      }
    } else if (
      entry.status !== "present" ||
      entry.httpStatus !== 200 ||
      !Number.isSafeInteger(entry.id) ||
      entry.id < 1 ||
      !["active", "disabled_manually"].includes(entry.state)
    ) {
      throw new TypeError("Owner workflow evidence is invalid")
    }
    return { ...entry }
  })
}

function normalizeEnvironmentEvidence(value) {
  assertExactFields(
    value,
    ["operation", "status", "httpStatus", "name", "protectionRules"],
    "Owner environment evidence",
  )
  if (value.operation !== `GET /repos/{owner}/{repo}/environments/${value.name}`) {
    throw new TypeError("Owner environment operation is invalid")
  }
  if (value.status === "unavailable") {
    if (
      value.httpStatus !== null ||
      !Array.isArray(value.protectionRules) ||
      value.protectionRules.length !== 0
    ) {
      throw new TypeError("Unavailable owner environment evidence is invalid")
    }
    return { ...value, protectionRules: [] }
  }
  if (value.status !== "present" || value.httpStatus !== 200 || typeof value.name !== "string") {
    throw new TypeError("Owner environment evidence is invalid")
  }
  if (!Array.isArray(value.protectionRules) || value.protectionRules.length > 32) {
    throw new TypeError("Owner environment protection evidence is invalid")
  }
  const protectionRules = value.protectionRules.map((rule) => {
    assertExactFields(
      rule,
      ["type", "preventSelfReview", "reviewers"],
      "Owner environment protection rule",
    )
    if (
      rule.type !== "required_reviewers" ||
      typeof rule.preventSelfReview !== "boolean" ||
      !Array.isArray(rule.reviewers) ||
      rule.reviewers.length < 1 ||
      rule.reviewers.length > 6 ||
      !rule.reviewers.every(
        (reviewer) =>
          isRecord(reviewer) &&
          Object.keys(reviewer).length === 2 &&
          ["Team", "User"].includes(reviewer.type) &&
          typeof reviewer.name === "string" &&
          reviewer.name.length > 0,
      )
    ) {
      throw new TypeError("Owner required-reviewer evidence is invalid")
    }
    return {
      type: rule.type,
      preventSelfReview: rule.preventSelfReview,
      reviewers: rule.reviewers.map((reviewer) => ({ ...reviewer })),
    }
  })
  return { ...value, protectionRules }
}

function normalizeImmutableEvidence(value, repository) {
  assertExactFields(
    value,
    ["operation", "status", "httpStatus", "enabled", "enforcedByOwner"],
    "Owner immutable Releases evidence",
  )
  if (value.operation !== `GET /repos/${repository}/immutable-releases`) {
    throw new TypeError("Owner immutable Releases operation is invalid")
  }
  if (value.status === "absent") {
    if (value.httpStatus !== 404 || value.enabled !== false || value.enforcedByOwner !== null) {
      throw new TypeError("Disabled immutable Releases evidence is invalid")
    }
  } else if (value.status === "unavailable") {
    if (value.httpStatus !== null || value.enabled !== null || value.enforcedByOwner !== null) {
      throw new TypeError("Unavailable immutable Releases evidence is invalid")
    }
  } else if (
    value.status !== "present" ||
    value.httpStatus !== 200 ||
    typeof value.enabled !== "boolean" ||
    typeof value.enforcedByOwner !== "boolean"
  ) {
    throw new TypeError("Owner immutable Releases evidence is invalid")
  }
  return { ...value }
}

function normalizeRepositoryResult(result, repository) {
  const value = safeSnapshot(result, "Owner repository adapter result")
  if (value?.status !== "present") {
    return {
      operation: `GET /repos/${repository}`,
      status: "unavailable",
      httpStatus: null,
      id: null,
      fullName: null,
      defaultBranch: null,
      administration: null,
    }
  }
  if (value.httpStatus !== 200 || !isRecord(value.value)) {
    throw new TypeError("Owner repository adapter result is malformed")
  }
  return normalizeRepositoryEvidence(
    {
      operation: `GET /repos/${repository}`,
      status: "present",
      httpStatus: 200,
      id: value.value.id,
      fullName: value.value.full_name,
      defaultBranch: value.value.default_branch,
      administration: value.value.permissions?.admin,
    },
    repository,
  )
}

function normalizeWorkflowResult(result, path) {
  const value = safeSnapshot(result, "Owner workflow adapter result")
  const operation = `GET /repos/{owner}/{repo}/actions/workflows/${path}`
  if (value?.status === "absent" && value.httpStatus === 404) {
    return { operation, status: "absent", httpStatus: 404, path, id: null, state: "absent" }
  }
  if (value?.status !== "present") {
    return {
      operation,
      status: "unavailable",
      httpStatus: null,
      path,
      id: null,
      state: "unavailable",
    }
  }
  if (value.httpStatus !== 200 || !isRecord(value.value)) {
    throw new TypeError("Owner workflow adapter result is unavailable or malformed")
  }
  const normalized = {
    operation,
    status: "present",
    httpStatus: 200,
    path: value.value.path,
    id: value.value.id,
    state: value.value.state,
  }
  return normalizeWorkflowEvidence(
    OWNER_PREFLIGHT_FILES.filter((entry) => entry.endsWith(".yml")).map((entry) =>
      entry === path
        ? normalized
        : {
            operation: `GET /repos/{owner}/{repo}/actions/workflows/${entry}`,
            status: "absent",
            httpStatus: 404,
            path: entry,
            id: null,
            state: "absent",
          },
    ),
  ).find((entry) => entry.path === path)
}

function normalizeEnvironmentResult(result, name) {
  const value = safeSnapshot(result, "Owner environment adapter result")
  const operation = `GET /repos/{owner}/{repo}/environments/${name}`
  if (value?.status !== "present" || value.httpStatus !== 200 || !isRecord(value.value)) {
    return { operation, status: "unavailable", httpStatus: null, name, protectionRules: [] }
  }
  const rules = Array.isArray(value.value.protection_rules)
    ? value.value.protection_rules
        .filter((rule) => rule?.type === "required_reviewers")
        .map((rule) => ({
          type: "required_reviewers",
          preventSelfReview: rule.prevent_self_review,
          reviewers: Array.isArray(rule.reviewers)
            ? rule.reviewers.map((reviewer) => ({
                type: reviewer?.type,
                name:
                  reviewer?.type === "Team" ? reviewer?.reviewer?.slug : reviewer?.reviewer?.login,
              }))
            : [],
        }))
    : []
  return normalizeEnvironmentEvidence({
    operation,
    status: "present",
    httpStatus: 200,
    name: value.value.name,
    protectionRules: rules,
  })
}

function normalizeImmutableResult(result, repository) {
  const value = safeSnapshot(result, "Owner immutable Releases adapter result")
  const operation = `GET /repos/${repository}/immutable-releases`
  if (value?.status === "absent" && value.httpStatus === 404) {
    return { operation, status: "absent", httpStatus: 404, enabled: false, enforcedByOwner: null }
  }
  if (value?.status !== "present") {
    return {
      operation,
      status: "unavailable",
      httpStatus: null,
      enabled: null,
      enforcedByOwner: null,
    }
  }
  if (value.httpStatus !== 200 || !isRecord(value.value)) {
    throw new TypeError("Owner immutable Releases adapter result is malformed")
  }
  return normalizeImmutableEvidence(
    {
      operation,
      status: "present",
      httpStatus: 200,
      enabled: value.value.enabled,
      enforcedByOwner: value.value.enforced_by_owner,
    },
    repository,
  )
}

function normalizeTrustResult(result, name) {
  const value = safeSnapshot(result, "Owner npm trust adapter result")
  const operation = `npm trust list ${name} --json`
  if (value?.status !== "present") {
    const code =
      typeof value?.code === "string" && CODE_PATTERN.test(value.code) ? value.code : "READ_FAILED"
    return { name, operation, status: "unavailable", code, publisher: null }
  }
  const source = value.value
  if (!isRecord(source)) throw new TypeError("Owner npm trust adapter result is malformed")
  return {
    name,
    operation,
    status: "present",
    code: null,
    publisher: normalizePublisher({
      id: source.id,
      type: source.type,
      repository: source.repository,
      file: source.file,
      environment: source.environment ?? null,
      permissions: source.permissions,
    }),
  }
}

function verifyCurrentFiles(expected, currentFiles) {
  for (const file of expected) {
    let bytes
    try {
      bytes = normalizeBytes(currentFiles.get(file.path), file.path)
    } catch {
      return result("local-files", "FAIL", "A required owner preflight file is unavailable.")
    }
    if (sha256(bytes) !== file.sha256) {
      return result("local-files", "FAIL", "Owner evidence file digests no longer match HEAD.")
    }
  }
  return result(
    "local-files",
    "PASS",
    "Owner evidence binds every candidate workflow and schema file.",
  )
}

function verifyTools(tools) {
  const npmParsed = parseSemver(tools.npm)
  const npmSupported = Number(npmParsed.major) === 11 && compareSemver(tools.npm, "11.15.0") >= 0
  return npmSupported
    ? result("tool-versions", "PASS", "Captured npm and GitHub CLI versions are supported.")
    : result("tool-versions", "FAIL", "Captured npm does not support trusted-publisher reads.")
}

function verifyRepository(evidence) {
  const repository = evidence.github.repository
  if (repository.status !== "present") {
    return result(
      "repository-capability",
      "UNPROVABLE",
      "Repository owner capability is unavailable.",
    )
  }
  return repository.fullName === evidence.repository &&
    repository.defaultBranch === "main" &&
    repository.administration === true
    ? result(
        "repository-capability",
        "PASS",
        "Repository identity and administration capability are proven.",
      )
    : result(
        "repository-capability",
        "FAIL",
        "Repository identity or administration capability is insufficient.",
      )
}

function verifyWorkflows(phase, workflows) {
  if (workflows.some((workflow) => workflow.status === "unavailable")) {
    return result("workflow-states", "UNPROVABLE", "A remote workflow state is unavailable.")
  }
  const byPath = new Map(workflows.map((workflow) => [workflow.path, workflow]))
  if (phase === "pre-enable") {
    const valid = [RELEASE_WORKFLOW, PUBLISH_CHART_WORKFLOW].every(
      (path) => byPath.get(path)?.state === "disabled_manually",
    )
    return valid
      ? result("workflow-states", "PASS", "Legacy mutating workflows remain manually disabled.")
      : result("workflow-states", "FAIL", "A legacy mutating workflow is not manually disabled.")
  }
  return workflows.every((workflow) => workflow.status === "present" && workflow.state === "active")
    ? result("workflow-states", "PASS", "Every controller workflow is active after cutover.")
    : result("workflow-states", "FAIL", "Every controller workflow must be active after cutover.")
}

function verifyImmutable(phase, immutable) {
  if (!["present", "absent"].includes(immutable.status)) {
    return result("immutable-releases", "UNPROVABLE", "Immutable Releases state is unavailable.")
  }
  if (phase === "post-enable" && immutable.enabled !== true) {
    return result("immutable-releases", "FAIL", "Immutable Releases are not enabled after cutover.")
  }
  return result(
    "immutable-releases",
    "PASS",
    phase === "post-enable"
      ? "Immutable Releases are enabled."
      : "Immutable Releases state was captured before cutover.",
  )
}

function verifyAbandonmentEnvironment(environment, expectedName) {
  if (environment.status !== "present") {
    return result(
      "abandonment-environment",
      "UNPROVABLE",
      "Protected abandonment environment evidence is unavailable.",
    )
  }
  const protectedRule = environment.protectionRules.find(
    (rule) =>
      rule.type === "required_reviewers" &&
      rule.preventSelfReview === true &&
      rule.reviewers.length > 0,
  )
  return environment.name === expectedName && protectedRule !== undefined
    ? result(
        "abandonment-environment",
        "PASS",
        "Abandonment requires independent protected approval.",
      )
    : result(
        "abandonment-environment",
        "FAIL",
        "Abandonment environment protection is insufficient.",
      )
}

function verifyPublishers(packages, repository, environment) {
  if (packages.some((pkg) => pkg.status === "unavailable")) {
    return result(
      "npm-trusted-publishers",
      "UNPROVABLE",
      "At least one npm trusted-publisher relationship is unavailable.",
    )
  }
  const tuples = new Set(
    packages.map(({ publisher }) =>
      JSON.stringify({
        type: publisher.type,
        repository: publisher.repository,
        file: publisher.file,
        environment: publisher.environment,
      }),
    ),
  )
  const valid =
    tuples.size === 1 &&
    packages.every(
      ({ publisher }) =>
        publisher.type === "github" &&
        publisher.repository === repository &&
        publisher.file === "release.yml" &&
        publisher.environment === environment &&
        publisher.permissions.includes("createPackage"),
    )
  return valid
    ? result("npm-trusted-publishers", "PASS", "All 21 packages share one exact trusted publisher.")
    : result(
        "npm-trusted-publishers",
        "FAIL",
        "npm trusted-publisher relationships are mixed or incorrect.",
      )
}

function parseControllerSchema(value) {
  const bytes = normalizeBytes(value, CONTROLLER_SCHEMA)
  let source
  try {
    source = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw new TypeError("Controller schema is not JSON", { cause: error })
  }
  const schema = safeSnapshot(source, "Controller schema")
  assertExactFields(
    schema,
    [
      "schemaVersion",
      "publishingOwner",
      "epoch",
      "npmTrustedPublisherEnvironment",
      "abandonmentEnvironment",
    ],
    "Controller schema",
  )
  if (
    schema.schemaVersion !== 1 ||
    schema.publishingOwner !== "release-controller" ||
    schema.epoch !== "fixed-group-v1" ||
    (schema.npmTrustedPublisherEnvironment !== null &&
      typeof schema.npmTrustedPublisherEnvironment !== "string") ||
    typeof schema.abandonmentEnvironment !== "string"
  ) {
    throw new TypeError("Controller schema is invalid")
  }
  return schema
}

function normalizeToolVersion(value, label) {
  if (typeof value !== "string" || !isExactSemver(value) || parseSemver(value).build.length !== 0) {
    throw new TypeError(`Owner preflight ${label} version is invalid`)
  }
  return value
}

function assertCanonicalPackages(value) {
  if (
    !Array.isArray(value) ||
    value.length !== CANONICAL_RELEASE_PACKAGE_ORDER.length ||
    !value.every((name, index) => name === CANONICAL_RELEASE_PACKAGE_ORDER[index])
  ) {
    throw new TypeError("Owner preflight package inventory is invalid")
  }
}

function assertPhase(value) {
  if (!["pre-enable", "post-enable"].includes(value)) {
    throw new TypeError("Owner preflight phase is invalid")
  }
}

function bindMethod(value, method, label) {
  if (!isRecord(value)) throw new TypeError(`${label} is invalid`)
  const descriptor = Object.getOwnPropertyDescriptor(value, method)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    throw new TypeError(`${label} method ${method} is invalid`)
  }
  return descriptor.value.bind(value)
}

function normalizeBytes(value, label, maximum = MAX_FILE_BYTES) {
  let bytes
  if (Buffer.isBuffer(value)) bytes = Buffer.from(value)
  else if (value instanceof Uint8Array) bytes = Buffer.from(value)
  else if (typeof value === "string") bytes = Buffer.from(value, "utf8")
  else throw new TypeError(`${label} bytes are invalid`)
  if (bytes.byteLength < 1 || bytes.byteLength > maximum) {
    throw new TypeError(`${label} bytes are outside bounds`)
  }
  return bytes
}

function safeSnapshot(value, label) {
  try {
    return snapshotJson(value)
  } catch (error) {
    throw new TypeError(`${label} is descriptor-unsafe`, { cause: error })
  }
}

function assertExactFields(value, fields, label) {
  if (!isRecord(value)) throw new TypeError(`${label} is invalid`)
  const keys = Object.keys(value).sort(compareText)
  const expected = [...fields].sort(compareText)
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) {
    throw new TypeError(`${label} fields are invalid`)
  }
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

function result(id, status, summary) {
  if (!REPORT_STATUSES.has(status)) throw new TypeError("Owner preflight result is invalid")
  return { id, status, summary }
}

function overallStatus(checks) {
  if (checks.some((check) => check.status === "FAIL")) return "FAIL"
  if (checks.some((check) => check.status === "UNPROVABLE")) return "UNPROVABLE"
  return "PASS"
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

function safeMarkdown(value) {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint <= 31 || codePoint === 127 ? " " : character
    })
    .join("")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
