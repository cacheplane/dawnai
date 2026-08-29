import { createHash } from "node:crypto"
import * as defaultFileSystem from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { snapshotJson } from "./adapter-normalize.mjs"
import { createNpmReader } from "./adapters/npm.mjs"
import { assertPayloadByteLength, RELEASE_PAYLOAD_LIMITS } from "./limits.mjs"
import {
  canonicalManifestBytes,
  manifestSha256,
  parseSealedReleaseManifest,
  validateSealedReleaseManifest,
} from "./manifest.mjs"
import { createNpmAuditVerifier } from "./npm-audit.mjs"
import {
  canonicalNpmEvidenceBytes,
  NPM_EVIDENCE_MAX_BYTES,
  parseNpmEvidence,
} from "./npm-evidence.mjs"
import { createReleasePreparationRunner } from "./process-runner.mjs"
import { canonicalReleaseRecordBytes, parseReleaseRecord } from "./release-record.mjs"
import { compareSemver, isExactSemver, parseSemver } from "./semver.mjs"

const CANDIDATE_FIELDS = Object.freeze([
  "version",
  "commitSha",
  "ciWorkflow",
  "ciCheck",
  "publisherWorkflow",
])
const PUBLISHER_FLAGS = Object.freeze([
  "--artifact-dir",
  "--candidate",
  "--github-output",
  "--record",
  "--report",
])
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const SHA512_PATTERN = /^[0-9a-f]{128}$/u
const MAX_CANDIDATE_BYTES = 16 * 1024
const MAX_POLL_ATTEMPTS = 20
const POLL_DELAY_MS = 2_000
const PUBLISH_COMMAND_TIMEOUT_MS = 5 * 60_000
const EXPECTED_REPOSITORY = "https://github.com/cacheplane/dawnai"

export const PUBLISHER_OVERALL_TIMEOUT_MS = 25 * 60_000

export const PUBLISHER_SPARSE_FILES = Object.freeze([
  "scripts/release/adapter-normalize.mjs",
  "scripts/release/adapters/http.mjs",
  "scripts/release/adapters/npm.mjs",
  "scripts/release/limits.mjs",
  "scripts/release/manifest.mjs",
  "scripts/release/npm-audit.mjs",
  "scripts/release/npm-evidence.mjs",
  "scripts/release/process-runner.mjs",
  "scripts/release/publisher.mjs",
  "scripts/release/release-record.mjs",
  "scripts/release/semver.mjs",
  "scripts/release/topology.mjs",
])

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    await runPublisherCli(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

export async function publishManifestSerially({
  candidate,
  manifest,
  observeRegistry,
  downloadRegistryTarball,
  verifyPackage,
  publishTarball,
  poll,
  log,
}) {
  const identity = validateCandidate(candidate)
  const sealedManifest = validateSealedReleaseManifest(manifest, { candidate: identity })
  assertFunction(observeRegistry, "observeRegistry")
  assertFunction(downloadRegistryTarball, "downloadRegistryTarball")
  assertFunction(verifyPackage, "verifyPackage")
  assertFunction(publishTarball, "publishTarball")
  assertFunction(poll, "poll")
  assertFunction(log, "log")

  const initial = []
  let candidateStarted = false
  for (const entry of sealedManifest.packages) {
    const metadata = await observeMetadata(observeRegistry, entry.name)
    const version = await observeVersion(observeRegistry, entry)
    const analyzed = await analyzeVersion({
      entry,
      metadata,
      version,
      candidate: identity,
      downloadRegistryTarball,
    })
    candidateStarted ||= analyzed.status === "present"
    initial.push(analyzed)
  }
  const initialLatest = newerLatest(initial, identity.version)
  if (initialLatest !== null) {
    return candidateStarted
      ? failNewerLatest(initialLatest.name)
      : supersededResult(identity, sealedManifest)
  }

  for (let index = 0; index < sealedManifest.packages.length; index += 1) {
    const entry = sealedManifest.packages[index]
    let state = initial[index]
    if (state.status === "present") {
      candidateStarted = true
      await waitUntilVerified({
        entry,
        candidate: identity,
        observeRegistry,
        downloadRegistryTarball,
        verifyPackage,
        poll,
      })
      log({ event: "package-verified", name: entry.name })
      continue
    }

    const current = await observeVersion(observeRegistry, entry)
    state = await analyzeVersion({
      entry,
      metadata: state.metadata,
      version: current,
      candidate: identity,
      downloadRegistryTarball,
    })
    if (state.status === "present") {
      candidateStarted = true
      await waitUntilVerified({
        entry,
        candidate: identity,
        observeRegistry,
        downloadRegistryTarball,
        verifyPackage,
        poll,
      })
      log({ event: "package-recovered", name: entry.name })
      continue
    }

    const sweep = await sweepLatest({ manifest: sealedManifest, observeRegistry })
    const latest = newerLatest(sweep, identity.version)
    if (latest !== null) {
      return candidateStarted
        ? failNewerLatest(latest.name)
        : supersededResult(identity, sealedManifest)
    }
    if (sweep[index].metadata.metadata.latest === identity.version) {
      candidateStarted = true
      await waitUntilVerified({
        entry,
        candidate: identity,
        observeRegistry,
        downloadRegistryTarball,
        verifyPackage,
        poll,
      })
      log({ event: "package-recovered", name: entry.name })
      continue
    }

    await publishTarball({ entry })
    candidateStarted = true
    log({ event: "package-publish-accepted", name: entry.name })
    await waitUntilVerified({
      entry,
      candidate: identity,
      observeRegistry,
      downloadRegistryTarball,
      verifyPackage,
      poll,
    })
  }

  const packages = []
  for (const entry of sealedManifest.packages) {
    const metadata = await observeMetadata(observeRegistry, entry.name)
    const version = await observeVersion(observeRegistry, entry)
    const analyzed = await analyzeVersion({
      entry,
      metadata,
      version,
      candidate: identity,
      downloadRegistryTarball,
    })
    if (analyzed.status !== "present" || !registryReady(analyzed, identity)) {
      throw new Error(`Final npm verification is incomplete for ${entry.name}`)
    }
    const audit = await observeNpmAudit(verifyPackage, entry, identity)
    if (audit.status !== "verified") {
      throw new Error(`Final npm verification is incomplete for ${entry.name}`)
    }
    packages.push(packageEvidence(entry, { ...analyzed, audit }))
  }
  const expectedManifestSha256 = manifestSha256(sealedManifest)
  return parseNpmEvidence(
    {
      schemaVersion: 1,
      version: identity.version,
      commitSha: identity.commitSha,
      manifestSha256: expectedManifestSha256,
      complete: true,
      status: "NPM_COMPLETE",
      packages,
    },
    { candidate: identity, manifestSha256: expectedManifestSha256, manifest: sealedManifest },
  )
}

export function parsePublisherArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== PUBLISHER_FLAGS.length * 2) {
    throw new Error(publisherUsage())
  }
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      !PUBLISHER_FLAGS.includes(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      /[\0\r\n]/u.test(value)
    ) {
      throw new Error(`Invalid publisher argument\n${publisherUsage()}`)
    }
    if (values.has(flag)) throw new Error(`Duplicate publisher argument ${flag}`)
    values.set(flag, value)
  }
  if (values.size !== PUBLISHER_FLAGS.length) throw new Error(publisherUsage())
  return {
    candidatePath: values.get("--candidate"),
    recordPath: values.get("--record"),
    artifactDir: values.get("--artifact-dir"),
    reportPath: values.get("--report"),
    githubOutputPath: values.get("--github-output"),
  }
}

export async function runPublisherCli(argv, options = {}) {
  if (options === null || Array.isArray(options) || typeof options !== "object") {
    throw new TypeError("Publisher runtime options must be an object")
  }
  const overallTimeoutMs = options.overallTimeoutMs ?? PUBLISHER_OVERALL_TIMEOUT_MS
  assertBoundedInteger(
    overallTimeoutMs,
    1,
    PUBLISHER_OVERALL_TIMEOUT_MS,
    "publisher overall timeout",
  )
  const deadline = createPublisherDeadline(overallTimeoutMs, {
    scheduleTimeout: options.scheduleTimeout ?? setTimeout,
    cancelTimeout: options.cancelTimeout ?? clearTimeout,
  })
  const environment = options.environment ?? process.env
  if (environment === null || Array.isArray(environment) || typeof environment !== "object") {
    deadline.dispose()
    throw new TypeError("Publisher runtime environment must be an object")
  }
  const runNpm =
    options.runNpm ??
    createReleasePreparationRunner({
      commandTimeoutMs: PUBLISH_COMMAND_TIMEOUT_MS,
      overallTimeoutMs,
    })
  const auditVerifierFactory = options.createNpmAuditVerifier ?? createNpmAuditVerifier
  if (typeof auditVerifierFactory !== "function") {
    deadline.dispose()
    throw new TypeError("npm audit verifier factory must be a function")
  }
  try {
    return await deadline.race(
      runPublisherCliWithinDeadline(argv, {
        fileSystem: options.fileSystem ?? defaultFileSystem,
        npmReader: options.npmReader ?? createNpmReader(),
        runNpm,
        auditVerifierFactory,
        poll: options.poll ?? productionPoll,
        log: options.log ?? productionLog,
        environment,
        deadline,
      }),
    )
  } catch (error) {
    if (deadline.signal.aborted) {
      throw new Error("npm publisher overall deadline expired", { cause: error })
    }
    throw error
  } finally {
    deadline.dispose()
  }
}

async function runPublisherCliWithinDeadline(
  argv,
  { fileSystem, npmReader, runNpm, auditVerifierFactory, poll, log, environment, deadline },
) {
  const input = parsePublisherArguments(argv)
  const paths = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, path.resolve(value)]),
  )
  const candidate = parseCandidate(
    await readBoundedRegularFile(fileSystem, paths.candidatePath, MAX_CANDIDATE_BYTES, "Candidate"),
  )
  const recordBytes = await readBoundedRegularFile(
    fileSystem,
    paths.recordPath,
    RELEASE_PAYLOAD_LIMITS.releaseRecordBytes,
    "Release record",
  )
  const record = parseReleaseRecord(recordBytes)
  if (!Buffer.from(recordBytes).equals(canonicalReleaseRecordBytes(record))) {
    throw new Error("Release record bytes must be canonical")
  }
  if (record.version !== candidate.version || record.commitSha !== candidate.commitSha) {
    throw new Error("Release record identity does not match the candidate")
  }
  const artifact = await verifyPublisherArtifact({
    artifactDir: paths.artifactDir,
    candidate,
    record,
    fileSystem,
  })
  assertNpmReader(npmReader)
  const auditVerifier = await deadline.race(
    auditVerifierFactory({
      runNpm,
      fileSystem,
      environment,
      signal: deadline.signal,
    }),
  )
  try {
    for (const method of ["dispose", "publisherEnvironment", "verifyPackage"]) {
      if (typeof auditVerifier?.[method] !== "function") {
        throw new TypeError(`npm audit verifier must expose ${method}`)
      }
    }
    const observeRegistry = ({ name, version }) =>
      deadline.race(
        version === undefined
          ? npmReader.observePackageMetadata({ name, signal: deadline.signal })
          : npmReader.observePackageVersion({ name, version, signal: deadline.signal }),
      )
    const publishTarball = async ({ entry }) => {
      const tarballPath = artifact.tarballPaths.get(entry.name)
      if (tarballPath === undefined) throw new Error("Recorded tarball path is unavailable")
      await verifyLocalTarball({ entry, tarballPath, fileSystem })
      await runNpm(
        "npm",
        [
          "publish",
          tarballPath,
          "--tag",
          "latest",
          "--access",
          "public",
          "--provenance",
          "--ignore-scripts",
        ],
        {
          cwd: paths.artifactDir,
          env: auditVerifier.publisherEnvironment({ candidate }),
          signal: deadline.signal,
        },
      )
      await verifyLocalTarball({ entry, tarballPath, fileSystem })
    }
    const result = await publishManifestSerially({
      candidate,
      manifest: artifact.manifest,
      observeRegistry,
      downloadRegistryTarball: (request) =>
        deadline.race(npmReader.downloadRegistryTarball({ ...request, signal: deadline.signal })),
      verifyPackage: (request) => deadline.race(auditVerifier.verifyPackage(request)),
      publishTarball,
      poll: (request) => deadline.race(poll({ ...request, signal: deadline.signal })),
      log,
    })
    await writeCanonicalReport({
      fileSystem,
      reportPath: paths.reportPath,
      result,
      candidate,
      manifest: artifact.manifest,
    })
    await fileSystem.appendFile(
      paths.githubOutputPath,
      `complete=${String(result.complete)}\nstate=${result.status}\n`,
      "utf8",
    )
    return result
  } finally {
    if (typeof auditVerifier?.dispose === "function") await auditVerifier.dispose()
  }
}

async function waitUntilVerified({
  entry,
  candidate,
  observeRegistry,
  downloadRegistryTarball,
  verifyPackage,
  poll,
}) {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    const metadata = await observeMetadata(observeRegistry, entry.name)
    const latest = metadata.metadata.latest
    if (latest !== null && compareSemver(latest, candidate.version) > 0) {
      failNewerLatest(entry.name)
    }
    const version = await observeVersion(observeRegistry, entry)
    const analyzed = await analyzeVersion({
      entry,
      metadata,
      version,
      candidate,
      downloadRegistryTarball,
    })
    if (analyzed.status === "present" && registryReady(analyzed, candidate)) {
      const audit = await observeNpmAudit(verifyPackage, entry, candidate)
      if (audit.status === "verified") return { ...analyzed, audit, ready: true }
    }
    if (attempt < MAX_POLL_ATTEMPTS)
      await poll({ name: entry.name, attempt, delayMs: POLL_DELAY_MS })
  }
  throw new Error(`npm registry did not converge for ${entry.name}`)
}

async function sweepLatest({ manifest, observeRegistry }) {
  const result = []
  for (const entry of manifest.packages) {
    result.push({ entry, metadata: await observeMetadata(observeRegistry, entry.name) })
  }
  return result
}

async function observeMetadata(observeRegistry, name) {
  const result = await observeRegistry({ name })
  if (
    result?.status !== "PRESENT" ||
    result.operation !== "package-metadata" ||
    result.metadata?.name !== name ||
    !(
      result.metadata.latest === null ||
      (isExactSemver(result.metadata.latest) &&
        parseSemver(result.metadata.latest).build.length === 0)
    )
  ) {
    throw new Error(`npm metadata observation is ambiguous or unverified for ${name}`)
  }
  return result
}

async function observeVersion(observeRegistry, entry) {
  const result = await observeRegistry({ name: entry.name, version: entry.version })
  if (
    result?.status === "ABSENT" &&
    result.operation === "package-version" &&
    result.httpStatus === 404 &&
    result.code === "E404"
  ) {
    return result
  }
  if (result?.status !== "PRESENT" || result.operation !== "package-version") {
    throw new Error(`npm exact-version observation is ambiguous or unverified for ${entry.name}`)
  }
  return result
}

async function analyzeVersion({ entry, metadata, version, downloadRegistryTarball }) {
  if (version.status === "ABSENT") {
    return { status: "absent", entry, metadata }
  }
  const packageRecord = version.package
  if (
    packageRecord === null ||
    typeof packageRecord !== "object" ||
    packageRecord.name !== entry.name ||
    packageRecord.version !== entry.version ||
    typeof packageRecord.tarballUrl !== "string" ||
    packageRecord.integrity !== entry.npmIntegrity ||
    packageRecord.distTags?.latest !== packageRecord.latest
  ) {
    throw new Error(`npm package identity or integrity conflicts for ${entry.name}`)
  }
  const download = await downloadRegistryTarball({ tarballUrl: packageRecord.tarballUrl })
  if (
    download?.status !== "PRESENT" ||
    download.operation !== "package-tarball" ||
    download.tarball?.url !== packageRecord.tarballUrl
  ) {
    throw new Error(`npm registry tarball could not be verified for ${entry.name}`)
  }
  const tarball = verifyDownloadedTarball(download.tarball, entry)
  if (packageRecord.shasum !== tarball.sha1) {
    throw new Error(`npm registry tarball shasum conflicts for ${entry.name}`)
  }
  return {
    status: "present",
    entry,
    metadata,
    package: packageRecord,
    tarball,
  }
}

function registryReady(analyzed, candidate) {
  return (
    analyzed.metadata.metadata.latest === candidate.version &&
    analyzed.package.latest === candidate.version
  )
}

async function observeNpmAudit(verifyPackage, entry, candidate) {
  const result = await verifyPackage({ entry, candidate })
  if (result?.status === "pending" && Object.keys(result).length === 1) return result
  if (
    result?.status !== "verified" ||
    result.signature?.status !== "valid" ||
    result.signature?.verifier !== "npm-audit-signatures@11.17.0" ||
    result.provenance?.predicateType !== "https://slsa.dev/provenance/v1" ||
    result.provenance.workflow !== candidate.publisherWorkflow ||
    result.provenance.commitSha !== candidate.commitSha ||
    result.provenance.repository !== EXPECTED_REPOSITORY ||
    result.provenance.ref !== `refs/tags/v${candidate.version}`
  ) {
    throw new Error(`Official npm audit evidence is invalid for ${entry.name}`)
  }
  return result
}

function verifyDownloadedTarball(value, entry) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.contentBase64 !== "string" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    !/^[0-9a-f]{40}$/u.test(value.sha1) ||
    !SHA256_PATTERN.test(value.sha256) ||
    !SHA512_PATTERN.test(value.sha512)
  ) {
    throw new Error(`npm registry tarball response is malformed for ${entry.name}`)
  }
  const bytes = Buffer.from(value.contentBase64, "base64")
  if (
    bytes.toString("base64") !== value.contentBase64 ||
    bytes.length !== value.size ||
    bytes.length !== entry.size ||
    digest(bytes, "sha1") !== value.sha1 ||
    digest(bytes, "sha256") !== value.sha256 ||
    digest(bytes, "sha512") !== value.sha512 ||
    value.sha256 !== entry.sha256 ||
    value.sha512 !== entry.sha512
  ) {
    throw new Error(`npm registry tarball bytes or digest do not match ${entry.name}`)
  }
  return value
}

function packageEvidence(entry, analyzed) {
  return deepFreeze({
    name: entry.name,
    version: entry.version,
    status: "present",
    size: entry.size,
    tarballSha256: entry.sha256,
    tarballSha512: entry.sha512,
    integrity: entry.npmIntegrity,
    latest: { status: "present", version: entry.version },
    signature: {
      status: "valid",
      verifier: analyzed.audit.signature.verifier,
    },
    provenance: {
      predicateType: analyzed.audit.provenance.predicateType,
      workflow: analyzed.audit.provenance.workflow,
      commitSha: analyzed.audit.provenance.commitSha,
      repository: analyzed.audit.provenance.repository,
      ref: analyzed.audit.provenance.ref,
    },
  })
}

async function verifyPublisherArtifact({ artifactDir, candidate, record, fileSystem }) {
  const canonicalDir = await fileSystem.realpath(artifactDir)
  if (canonicalDir !== artifactDir) throw new Error("Artifact directory must be canonical")
  const manifestPath = path.join(artifactDir, "manifest.json")
  const manifestBytes = await readBoundedRegularFile(
    fileSystem,
    manifestPath,
    RELEASE_PAYLOAD_LIMITS.manifestBytes,
    "Release manifest",
  )
  const manifest = parseSealedReleaseManifest(manifestBytes, { candidate })
  if (!Buffer.from(manifestBytes).equals(canonicalManifestBytes(manifest))) {
    throw new Error("Release manifest bytes must be canonical")
  }
  if (manifestSha256(manifest) !== record.manifestSha256) {
    throw new Error("Release manifest digest does not match the release record")
  }
  const expected = ["manifest.json", ...manifest.packages.map((entry) => entry.filename)].sort()
  const actual = (await fileSystem.readdir(artifactDir)).sort()
  if (!arraysEqual(actual, expected)) {
    throw new Error("Artifact directory file set does not match the release manifest")
  }
  const tarballPaths = new Map()
  for (const entry of manifest.packages) {
    const tarballPath = path.join(artifactDir, entry.filename)
    await verifyLocalTarball({ entry, tarballPath, fileSystem })
    tarballPaths.set(entry.name, tarballPath)
  }
  return { manifest, tarballPaths }
}

async function verifyLocalTarball({ entry, tarballPath, fileSystem }) {
  const bytes = await readBoundedRegularFile(
    fileSystem,
    tarballPath,
    RELEASE_PAYLOAD_LIMITS.tarballBytes,
    `${entry.name} tarball`,
  )
  if (
    bytes.length !== entry.size ||
    digest(bytes, "sha256") !== entry.sha256 ||
    digest(bytes, "sha512") !== entry.sha512
  ) {
    throw new Error(`${entry.name} local tarball does not match the release manifest`)
  }
}

async function readBoundedRegularFile(fileSystem, target, maximumBytes, label) {
  const before = await fileSystem.lstat(target)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1) {
    throw new Error(`${label} must be one positive regular file`)
  }
  assertPayloadByteLength(before.size, maximumBytes, label)
  const bytes = await fileSystem.readFile(target)
  assertPayloadByteLength(bytes.byteLength, maximumBytes, label)
  const after = await fileSystem.lstat(target)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    after.size !== before.size ||
    after.size !== bytes.byteLength ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mtimeMs !== before.mtimeMs
  ) {
    throw new Error(`${label} changed while being read`)
  }
  return Buffer.from(bytes)
}

async function writeCanonicalReport({ fileSystem, reportPath, result, candidate, manifest }) {
  const bytes =
    result.status === "NPM_COMPLETE"
      ? canonicalNpmEvidenceBytes(result, {
          candidate,
          manifestSha256: manifestSha256(manifest),
          manifest,
        })
      : Buffer.from(`${JSON.stringify(canonicalize(result), null, 2)}\n`, "utf8")
  assertPayloadByteLength(bytes.length, NPM_EVIDENCE_MAX_BYTES, "npm publication report")
  try {
    const existing = await readBoundedRegularFile(
      fileSystem,
      reportPath,
      NPM_EVIDENCE_MAX_BYTES,
      "npm publication report",
    )
    if (!existing.equals(bytes)) throw new Error("Existing npm publication report conflicts")
    return
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  const temporary = `${reportPath}.tmp-${process.pid}`
  try {
    await fileSystem.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
    await fileSystem.rename(temporary, reportPath)
  } catch (error) {
    await fileSystem.unlink(temporary).catch(() => undefined)
    throw error
  }
}

function parseCandidate(raw) {
  let value
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))
  } catch (error) {
    throw new TypeError("Candidate JSON is invalid", { cause: error })
  }
  return validateCandidate(value)
}

function validateCandidate(candidate) {
  const value = snapshotJson(candidate)
  assertExactFields(value, CANDIDATE_FIELDS, "candidate")
  if (
    !isReleaseVersion(value.version) ||
    !SHA_PATTERN.test(value.commitSha) ||
    value.ciWorkflow !== "CI" ||
    value.ciCheck !== "validate" ||
    value.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new TypeError("Candidate identity or release policy is invalid")
  }
  return deepFreeze(value)
}

function newerLatest(observations, candidateVersion) {
  for (const observation of observations) {
    const metadata = observation.metadata ?? observation
    const latest = metadata.metadata.latest
    const entry = observation.entry ?? { name: observation.package?.name }
    if (latest !== null && compareSemver(latest, candidateVersion) > 0) {
      return { name: entry.name }
    }
  }
  return null
}

function failNewerLatest(name) {
  throw new Error(`A newer latest tag conflicts with partial candidate state at ${name}`)
}

function supersededResult(candidate, manifest) {
  return deepFreeze({
    schemaVersion: 1,
    version: candidate.version,
    commitSha: candidate.commitSha,
    manifestSha256: manifestSha256(manifest),
    complete: false,
    status: "SUPERSEDED_NOOP",
    packages: [],
  })
}

async function productionPoll({ delayMs, signal }) {
  if (signal?.aborted === true) throw new Error("npm publisher poll was aborted")
  await new Promise((resolvePromise, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error("npm publisher poll was aborted"))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      resolvePromise()
    }, delayMs)
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted === true) onAbort()
  })
}

function productionLog(event) {
  console.log(JSON.stringify(event))
}

function assertNpmReader(value) {
  for (const method of [
    "observePackageMetadata",
    "observePackageVersion",
    "downloadRegistryTarball",
  ]) {
    if (typeof value?.[method] !== "function") {
      throw new TypeError(`npm reader must expose ${method}`)
    }
  }
}

function assertFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} must be a function`)
}

function createPublisherDeadline(timeoutMs, { scheduleTimeout, cancelTimeout }) {
  if (typeof scheduleTimeout !== "function" || typeof cancelTimeout !== "function") {
    throw new TypeError("publisher deadline scheduler is invalid")
  }
  const controller = new AbortController()
  let rejectExpiration
  const expiration = new Promise((_resolve, reject) => {
    rejectExpiration = reject
  })
  const timer = scheduleTimeout(() => {
    controller.abort()
    rejectExpiration(new Error("npm publisher overall deadline expired"))
  }, timeoutMs)
  return {
    signal: controller.signal,
    race(value) {
      return Promise.race([Promise.resolve(value), expiration])
    },
    dispose() {
      cancelTimeout(timer)
    },
  }
}

function assertBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid`)
  }
}

function assertExactFields(value, fields, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`)
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${label} is missing ${field}`)
  }
  const extra = Object.keys(value).filter((field) => !fields.includes(field))
  if (extra.length > 0) throw new TypeError(`${label} contains unknown field ${extra.sort()[0]}`)
}

function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function digest(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest("hex")
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalize)
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function publisherUsage() {
  return "Usage: node scripts/release/publisher.mjs --candidate <candidate.json> --record <release-record.json> --artifact-dir <directory> --report <publish.json> --github-output <path>"
}
