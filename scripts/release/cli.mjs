#!/usr/bin/env node

import * as defaultFileSystem from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const COMMANDS = Object.freeze({
  tag: Object.freeze(["candidate"]),
  prepare: Object.freeze([
    "candidate",
    "inventory",
    "root",
    "output-dir",
    "ci-receipt",
    "prepare-run",
    "preparation-authority",
    "source-ref",
  ]),
  "record-artifact": Object.freeze(["candidate", "manifest", "artifact-upload-result", "output"]),
  "reconcile-npm": Object.freeze(["candidate", "record", "manifest", "npm-evidence"]),
  "reconcile-smokes": Object.freeze([
    "candidate",
    "record",
    "manifest",
    "npm-evidence",
    "smoke-results",
  ]),
  "dispatch-audit": Object.freeze(["version", "commit-sha", "manifest-sha256", "output"]),
  "record-audit-dispatch": Object.freeze(["candidate", "dispatch-result"]),
  "correlate-audit": Object.freeze(["candidate", "dispatch-result", "audit-result"]),
  "publish-release": Object.freeze(["candidate", "record", "audit-result"]),
})
const MAX_JSON_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_PATH_BYTES = 4_096
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

export async function runReleaseCli(argv, dependencies = {}) {
  const parsed = parseArguments(argv)
  const runtime = normalizeDependencies(dependencies)
  if (parsed.command === "tag") {
    return runTag(parsed.options, runtime)
  }
  if (parsed.command === "prepare") {
    return runPrepare(parsed.options, runtime)
  }
  if (parsed.command === "record-artifact") {
    return runRecordArtifact(parsed.options, runtime)
  }
  if (parsed.command === "reconcile-npm") {
    return runReconcileNpm(parsed.options, runtime)
  }
  if (parsed.command === "reconcile-smokes") {
    return runReconcileSmokes(parsed.options, runtime)
  }
  if (parsed.command === "dispatch-audit") {
    return runDispatchAudit(parsed.options, runtime)
  }
  if (parsed.command === "record-audit-dispatch") {
    return runRecordAuditDispatch(parsed.options, runtime)
  }
  if (parsed.command === "correlate-audit") {
    return runCorrelateAudit(parsed.options, runtime)
  }
  if (parsed.command === "publish-release") {
    return runPublishRelease(parsed.options, runtime)
  }
  throw new TypeError("Release CLI command is unsupported")
}

async function runReconcileNpm(options, runtime) {
  const github = await requireGitHub(runtime)
  const { candidate, record, manifest, npmEvidence } = await readReconciliationInputs(
    options,
    runtime,
  )
  const module = await runtime.importModule(new URL("./metadata.mjs", import.meta.url).href)
  return moduleFunction(
    module,
    "reconcileNpmEvidence",
    "npm evidence reconciliation",
  )({
    candidate,
    record,
    manifest,
    npmEvidence,
    github,
  })
}

async function runReconcileSmokes(options, runtime) {
  const github = await requireGitHub(runtime)
  const [{ candidate, record, manifest, npmEvidence }, smokeResults] = await Promise.all([
    readReconciliationInputs(options, runtime),
    readSmokeResults(runtime, options["smoke-results"]),
  ])
  const module = await runtime.importModule(new URL("./metadata.mjs", import.meta.url).href)
  return moduleFunction(
    module,
    "reconcileSmokeEvidence",
    "smoke evidence reconciliation",
  )({
    candidate,
    record,
    manifest,
    npmEvidence,
    smokeResults,
    github,
  })
}

async function readReconciliationInputs(options, runtime) {
  const candidate = await readCandidate(runtime, options.candidate)
  const [record, manifestBytes, npmEvidence] = await Promise.all([
    readJsonFile(
      runtime.fileSystem,
      resolveCliPath(options.record, runtime.cwd),
      MAX_JSON_BYTES,
      "release record",
    ),
    readRegularFile(
      runtime.fileSystem,
      resolveCliPath(options.manifest, runtime.cwd),
      MAX_MANIFEST_BYTES,
      "manifest",
    ),
    readJsonFile(
      runtime.fileSystem,
      resolveCliPath(options["npm-evidence"], runtime.cwd),
      MAX_MANIFEST_BYTES,
      "npm evidence",
    ),
  ])
  const module = await runtime.importModule(new URL("./manifest.mjs", import.meta.url).href)
  const manifest = moduleFunction(
    module,
    "parseSealedReleaseManifest",
    "manifest parser",
  )(manifestBytes, { candidate })
  return Object.freeze({ candidate, record, manifest, npmEvidence })
}

async function readSmokeResults(runtime, value) {
  const directory = resolveCliPath(value, runtime.cwd)
  if (typeof runtime.fileSystem.readdir !== "function") {
    throw new TypeError("Release CLI filesystem directory reader is invalid")
  }
  const before = await runtime.fileSystem.lstat(directory)
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new TypeError("Release CLI smoke results must be one regular directory")
  }
  const entries = await runtime.fileSystem.readdir(directory, { withFileTypes: true })
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 256) {
    throw new TypeError("Release CLI smoke result directory is empty or exceeds its bound")
  }
  const names = entries.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      entry.name.includes("/") ||
      entry.name.includes("\\") ||
      entry.name.includes("\0") ||
      !entry.name.endsWith(".json") ||
      typeof entry.isFile !== "function" ||
      !entry.isFile() ||
      (typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink())
    ) {
      throw new TypeError("Release CLI smoke result directory contains an invalid entry")
    }
    return entry.name
  })
  names.sort(compareText)
  if (new Set(names).size !== names.length) {
    throw new TypeError("Release CLI smoke result directory contains duplicate entries")
  }
  const results = await Promise.all(
    names.map((name) =>
      readJsonFile(
        runtime.fileSystem,
        path.join(directory, name),
        MAX_JSON_BYTES,
        `smoke result ${name}`,
      ),
    ),
  )
  const after = await runtime.fileSystem.lstat(directory)
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino
  ) {
    throw new Error("Release CLI smoke result directory changed while it was read")
  }
  return Object.freeze(results)
}

async function runDispatchAudit(options, runtime) {
  const github = await requireGitHub(runtime)
  const module = await runtime.importModule(new URL("./audit.mjs", import.meta.url).href)
  const dispatch = moduleFunction(module, "dispatchIndependentAudit", "audit dispatch")
  const candidate = candidateDocument({
    version: options.version,
    commitSha: options["commit-sha"],
  })
  const receipt = await dispatch({
    candidate,
    manifestSha256: options["manifest-sha256"],
    github: github.writer,
  })
  await writeCanonicalFile(
    runtime.fileSystem,
    resolveCliPath(options.output, runtime.cwd),
    canonicalJsonBytes(receipt),
    "audit dispatch receipt",
  )
  return receipt
}

async function runRecordAuditDispatch(options, runtime) {
  const github = await requireGitHub(runtime)
  const [candidate, dispatch] = await Promise.all([
    readCandidate(runtime, options.candidate),
    readJsonFile(
      runtime.fileSystem,
      resolveCliPath(options["dispatch-result"], runtime.cwd),
      MAX_JSON_BYTES,
      "audit dispatch result",
    ),
  ])
  const module = await runtime.importModule(new URL("./audit.mjs", import.meta.url).href)
  return moduleFunction(
    module,
    "recordAuditDispatch",
    "audit dispatch recording",
  )({
    candidate,
    dispatch,
    github,
  })
}

async function runCorrelateAudit(options, runtime) {
  const github = await requireGitHub(runtime)
  const [candidate, dispatch, auditResult] = await Promise.all([
    readCandidate(runtime, options.candidate),
    readJsonFile(
      runtime.fileSystem,
      resolveCliPath(options["dispatch-result"], runtime.cwd),
      MAX_JSON_BYTES,
      "audit dispatch result",
    ),
    readJsonFile(
      runtime.fileSystem,
      resolveCliPath(options["audit-result"], runtime.cwd),
      MAX_JSON_BYTES,
      "audit result",
    ),
  ])
  const auditModule = await runtime.importModule(new URL("./audit.mjs", import.meta.url).href)
  const terminalModule = await runtime.importModule(
    new URL("./terminal-records.mjs", import.meta.url).href,
  )
  const result = moduleFunction(
    terminalModule,
    "parseAuditResult",
    "audit-result parser",
  )(auditResult)
  const recorded = await moduleFunction(
    auditModule,
    "recordAuditAttempt",
    "audit attempt recording",
  )({ candidate, dispatch, result, github })
  if (result.conclusion !== "success") return recorded
  return moduleFunction(
    auditModule,
    "verifyAuditSuccess",
    "audit success verification",
  )({
    candidate,
    dispatch,
    result,
    github,
  })
}

async function runPublishRelease(options, runtime) {
  const github = await requireGitHub(runtime)
  const [candidate, record, auditResult] = await Promise.all([
    readCandidate(runtime, options.candidate),
    readJsonFile(
      runtime.fileSystem,
      resolveCliPath(options.record, runtime.cwd),
      MAX_JSON_BYTES,
      "release record",
    ),
    readJsonFile(
      runtime.fileSystem,
      resolveCliPath(options["audit-result"], runtime.cwd),
      MAX_JSON_BYTES,
      "audit result",
    ),
  ])
  const module = await runtime.importModule(new URL("./metadata.mjs", import.meta.url).href)
  return moduleFunction(
    module,
    "publishConsolidatedRelease",
    "Release publication",
  )({
    candidate,
    record,
    auditResult,
    github,
  })
}

async function runTag(options, runtime) {
  const candidate = await readCandidate(runtime, options.candidate)
  const module = await runtime.importModule(
    new URL("./adapters/git-write.mjs", import.meta.url).href,
  )
  const createWriter = moduleFunction(module, "createCandidateTagWriter", "candidate tag writer")
  const writer = createWriter({ root: runtime.cwd })
  const createAnnotatedTag = moduleFunction(
    writer,
    "createAnnotatedTag",
    "candidate tag creation",
  ).bind(writer)
  const pushTag = moduleFunction(writer, "pushTag", "candidate tag push").bind(writer)
  const tag = `v${candidate.version}`
  const created = await createAnnotatedTag({
    tag,
    sha: candidate.commitSha,
    message: `Dawn release ${tag}`,
  })
  const pushed = await pushTag({ tag })
  return Object.freeze({ tag, commitSha: candidate.commitSha, created, pushed })
}

async function runPrepare(options, runtime) {
  const candidate = await readCandidate(runtime, options.candidate)
  const inventory = await readJsonFile(
    runtime.fileSystem,
    resolveCliPath(options.inventory, runtime.cwd),
    MAX_MANIFEST_BYTES,
    "inventory",
  )
  const ci = await readJsonFile(
    runtime.fileSystem,
    resolveCliPath(options["ci-receipt"], runtime.cwd),
    MAX_JSON_BYTES,
    "CI receipt",
  )
  const prepareRun = await readJsonFile(
    runtime.fileSystem,
    resolveCliPath(options["prepare-run"], runtime.cwd),
    MAX_JSON_BYTES,
    "prepare run receipt",
  )
  const preparationAuthority = await readJsonFile(
    runtime.fileSystem,
    resolveCliPath(options["preparation-authority"], runtime.cwd),
    MAX_JSON_BYTES,
    "preparation authority",
  )
  const module = await runtime.importModule(new URL("./prepare.mjs", import.meta.url).href)
  const prepare = moduleFunction(module, "prepareReleaseArtifacts", "release preparation")
  return prepare({
    candidate,
    inventory,
    root: resolveCliPath(options.root, runtime.cwd),
    outputDir: resolveCliPath(options["output-dir"], runtime.cwd),
    ci,
    prepareRun,
    preparationAuthority,
    sourceRef: options["source-ref"],
  })
}

async function runRecordArtifact(options, runtime) {
  const paths = Object.fromEntries(
    Object.entries(options).map(([key, value]) => [key, resolveCliPath(value, runtime.cwd)]),
  )
  const candidate = candidateDocument(
    await readJsonFile(runtime.fileSystem, paths.candidate, MAX_JSON_BYTES, "candidate"),
  )
  const manifestBytes = await readRegularFile(
    runtime.fileSystem,
    paths.manifest,
    MAX_MANIFEST_BYTES,
    "manifest",
  )
  const upload = await readJsonFile(
    runtime.fileSystem,
    paths["artifact-upload-result"],
    MAX_JSON_BYTES,
    "artifact upload result",
  )

  const manifestModule = await runtime.importModule(new URL("./manifest.mjs", import.meta.url).href)
  const recordModule = await runtime.importModule(
    new URL("./release-record.mjs", import.meta.url).href,
  )
  const parseManifest = moduleFunction(
    manifestModule,
    "parseSealedReleaseManifest",
    "manifest parser",
  )
  const manifestDigest = moduleFunction(manifestModule, "manifestSha256", "manifest digest")
  const createRecord = moduleFunction(recordModule, "createReleaseRecord", "release-record creator")
  const canonicalRecordBytes = moduleFunction(
    recordModule,
    "canonicalReleaseRecordBytes",
    "release-record encoder",
  )

  const manifest = parseManifest(manifestBytes, { candidate })
  const receipt = normalizeArtifactUpload(upload, manifest)
  const record = createRecord({
    candidate,
    manifestSha256: manifestDigest(manifest),
    artifact: { name: manifest.artifact.name },
    artifactUpload: { id: receipt.artifactId, digest: receipt.artifactDigest },
    prepareRun: {
      id: manifest.artifact.prepareRunId,
      attempt: manifest.artifact.prepareRunAttempt,
    },
  })
  await writeCanonicalFile(
    runtime.fileSystem,
    paths.output,
    canonicalRecordBytes(record),
    "release record",
  )
  return record
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== "string") {
    throw usageError()
  }
  const command = argv[0]
  const fields = COMMANDS[command]
  if (fields === undefined) throw usageError()
  if ((argv.length - 1) % 2 !== 0) throw usageError()
  const options = Object.create(null)
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      typeof flag !== "string" ||
      typeof value !== "string" ||
      !flag.startsWith("--") ||
      value.length === 0
    ) {
      throw usageError()
    }
    const name = flag.slice(2)
    if (!fields.includes(name) || Object.hasOwn(options, name)) throw usageError()
    options[name] = value
  }
  if (Object.keys(options).length !== fields.length || fields.some((field) => !options[field])) {
    throw usageError()
  }
  return { command, options: Object.freeze(options) }
}

function normalizeDependencies(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Release CLI dependencies are invalid")
  }
  const cwd = value.cwd ?? process.cwd()
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new TypeError("Release CLI working directory must be absolute")
  }
  const importModule = value.importModule ?? ((specifier) => import(specifier))
  if (typeof importModule !== "function") {
    throw new TypeError("Release CLI module loader is invalid")
  }
  const fileSystem = value.fileSystem ?? defaultFileSystem
  for (const method of ["lstat", "readFile", "writeFile"]) {
    if (typeof fileSystem?.[method] !== "function") {
      throw new TypeError(`Release CLI filesystem method ${method} is invalid`)
    }
  }
  const githubDescriptor = Object.getOwnPropertyDescriptor(value, "github")
  if (
    githubDescriptor !== undefined &&
    (!("value" in githubDescriptor) || !githubDescriptor.enumerable)
  ) {
    throw new TypeError("Release CLI GitHub boundary is invalid")
  }
  const environmentDescriptor = Object.getOwnPropertyDescriptor(value, "environment")
  if (
    environmentDescriptor !== undefined &&
    (!("value" in environmentDescriptor) || !environmentDescriptor.enumerable)
  ) {
    throw new TypeError("Release CLI environment boundary is invalid")
  }
  const environment = environmentDescriptor?.value ?? process.env
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("Release CLI environment boundary is invalid")
  }
  const tokenDescriptor = Object.getOwnPropertyDescriptor(environment, "GITHUB_TOKEN")
  if (tokenDescriptor !== undefined && !("value" in tokenDescriptor)) {
    throw new TypeError("Release CLI GitHub token must be a data property")
  }
  return Object.freeze({
    cwd,
    importModule,
    fileSystem,
    github: githubDescriptor?.value,
    githubToken: tokenDescriptor?.value,
  })
}

async function readCandidate(runtime, value) {
  const candidate = await readJsonFile(
    runtime.fileSystem,
    resolveCliPath(value, runtime.cwd),
    MAX_JSON_BYTES,
    "candidate",
  )
  return candidateDocument(candidate)
}

function candidateDocument(value) {
  const candidate =
    Object.keys(value).length === 2
      ? {
          version: value.version,
          commitSha: value.commitSha,
          ciWorkflow: "CI",
          ciCheck: "validate",
          publisherWorkflow: ".github/workflows/release.yml",
        }
      : value
  const fields = ["version", "commitSha", "ciWorkflow", "ciCheck", "publisherWorkflow"]
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.keys(candidate).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(candidate, field)) ||
    typeof candidate.version !== "string" ||
    !isExactSemver(candidate.version) ||
    typeof candidate.commitSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(candidate.commitSha) ||
    candidate.ciWorkflow !== "CI" ||
    candidate.ciCheck !== "validate" ||
    candidate.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new TypeError("Release CLI candidate has an invalid exact-key identity")
  }
  return Object.freeze({ ...candidate })
}

function isExactSemver(value) {
  const match = typeof value === "string" ? SEMVER_PATTERN.exec(value) : null
  return (
    match !== null &&
    !(match[4]?.split(".") ?? []).some(
      (identifier) => /^[0-9]+$/u.test(identifier) && /^0[0-9]+$/u.test(identifier),
    )
  )
}

async function requireGitHub(runtime) {
  if (runtime.github !== undefined) return validateGitHubBoundary(runtime.github)
  const token = runtime.githubToken
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 4_096 ||
    /[\r\n]/u.test(token)
  ) {
    throw new TypeError("Release CLI command requires GITHUB_TOKEN")
  }
  const readerModule = await runtime.importModule(
    new URL("./adapters/github.mjs", import.meta.url).href,
  )
  const writerModule = await runtime.importModule(
    new URL("./adapters/github-write.mjs", import.meta.url).href,
  )
  const reader = moduleFunction(
    readerModule,
    "createGitHubReader",
    "GitHub reader factory",
  )({
    owner: "cacheplane",
    repo: "dawnai",
    token,
  })
  const writer = moduleFunction(
    writerModule,
    "createGitHubWriter",
    "GitHub writer factory",
  )({
    owner: "cacheplane",
    repo: "dawnai",
    token,
    reader,
  })
  return validateGitHubBoundary(
    moduleFunction(
      writerModule,
      "composeGitHubEffects",
      "GitHub effect composer",
    )({
      reader,
      writer,
    }),
  )
}

function validateGitHubBoundary(github) {
  if (
    github === null ||
    typeof github !== "object" ||
    Array.isArray(github) ||
    github.reader === null ||
    typeof github.reader !== "object" ||
    github.writer === null ||
    typeof github.writer !== "object"
  ) {
    throw new TypeError("Release CLI command requires a valid GitHub effect boundary")
  }
  return github
}

function normalizeArtifactUpload(value, manifest) {
  const fields = ["artifactId", "artifactUrl", "artifactDigest"]
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field)) ||
    typeof value.artifactId !== "string" ||
    !DECIMAL_ID_PATTERN.test(value.artifactId) ||
    typeof value.artifactDigest !== "string" ||
    !SHA256_PATTERN.test(value.artifactDigest)
  ) {
    throw new TypeError("Artifact upload output has an invalid exact-key schema")
  }
  const expectedUrl = `https://github.com/cacheplane/dawnai/actions/runs/${manifest.artifact.prepareRunId}/artifacts/${value.artifactId}`
  if (value.artifactUrl !== expectedUrl) {
    throw new TypeError("Artifact upload URL does not match the run and artifact ID")
  }
  return Object.freeze({
    artifactId: value.artifactId,
    artifactUrl: value.artifactUrl,
    artifactDigest: value.artifactDigest,
  })
}

async function readJsonFile(fileSystem, filePath, maximumBytes, label) {
  const bytes = await readRegularFile(fileSystem, filePath, maximumBytes, label)
  let value
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw new TypeError(`Release CLI ${label} JSON is invalid`, { cause: error })
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Release CLI ${label} must be one JSON object`)
  }
  return value
}

async function readRegularFile(fileSystem, filePath, maximumBytes, label) {
  const before = await fileSystem.lstat(filePath)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !Number.isSafeInteger(before.size) ||
    before.size < 1 ||
    before.size > maximumBytes
  ) {
    throw new TypeError(`Release CLI ${label} must be one bounded regular file`)
  }
  const bytes = await fileSystem.readFile(filePath)
  const after = await fileSystem.lstat(filePath)
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== before.size ||
    after.size !== before.size ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    !after.isFile() ||
    after.isSymbolicLink()
  ) {
    throw new Error(`Release CLI ${label} changed while it was read`)
  }
  return Buffer.from(bytes)
}

async function writeCanonicalFile(fileSystem, filePath, bytes, label) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_JSON_BYTES) {
    throw new TypeError(`Release CLI ${label} bytes are invalid`)
  }
  try {
    await fileSystem.writeFile(filePath, Buffer.from(bytes), { flag: "wx", mode: 0o600 })
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
    const existing = await readRegularFile(fileSystem, filePath, MAX_JSON_BYTES, label)
    if (!existing.equals(Buffer.from(bytes))) {
      throw new Error(`Release CLI ${label} output already exists with different bytes`)
    }
  }
}

function resolveCliPath(value, cwd) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
  ) {
    throw new TypeError("Release CLI path argument is invalid")
  }
  return path.resolve(cwd, value)
}

function moduleFunction(module, name, label) {
  if (
    module === null ||
    typeof module !== "object" ||
    typeof Object.getOwnPropertyDescriptor(module, name)?.value !== "function"
  ) {
    throw new TypeError(`Release CLI ${label} module is invalid`)
  }
  return Object.getOwnPropertyDescriptor(module, name).value
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`, "utf8")
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function usageError() {
  return new TypeError(
    "Usage: cli.mjs record-artifact --candidate <path> --manifest <path> --artifact-upload-result <path> --output <path>",
  )
}

const executedPath =
  process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href
if (executedPath === import.meta.url) {
  try {
    await runReleaseCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`release CLI failed: ${safeCode(error)}\n`)
    process.exitCode = 1
  }
}

function safeCode(error) {
  const code = error?.code
  return typeof code === "string" && /^[A-Z0-9_]{1,128}$/u.test(code)
    ? code
    : "INVALID_RELEASE_COMMAND"
}
