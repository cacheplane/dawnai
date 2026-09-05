import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import * as defaultFileSystem from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { inflateRawSync } from "node:zlib"

import { createGitHubReader } from "./adapters/github.mjs"
import { assertPayloadByteLength, RELEASE_PAYLOAD_LIMITS } from "./limits.mjs"
import { canonicalManifestBytes, parseSealedReleaseManifest } from "./manifest.mjs"
import { isManagedReleaseForTag } from "./metadata.mjs"
import { canonicalReleaseRecordBytes, parseReleaseRecord } from "./release-record.mjs"

const METADATA_FIELDS = Object.freeze([
  "id",
  "name",
  "serviceDigest",
  "expired",
  "prepareRunId",
  "prepareRunAttempt",
  "headSha",
])
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const LATER_SMOKE_RECEIPT_PATTERN =
  /^smoke-result-[a-z][a-z0-9-]{0,63}-[1-9][0-9]*-[1-9][0-9]*\.json$/u
const LATER_AUDIT_ATTEMPT_PATTERN = /^audit-attempt-[1-9][0-9]*-[1-9][0-9]*\.json$/u
const MAX_LATER_RECEIPT_ASSETS = 1_024
const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_END_SIGNATURE = 0x06054b50
const execFileAsync = promisify(execFile)
/**
 * Every `gh attestation verify` child gets this budget. A runner diagnostic (run 33894039805)
 * measured ~3 s per call under GITHUB_TOKEN, so 180 s is headroom, not a fix: the v0.8.24
 * attest (63 s) and escrow (71 s) job times were 22 sequential calls, and the escrow failures
 * on runs 33889526426 and 33892398216 were not this timeout. Escrow now makes one call.
 */
const ATTESTATION_VERIFY_TIMEOUT_MS = 180_000
const ATTESTATION_REASON_STDERR_BYTES = 2 * 1024
const ATTESTATION_REASON_MAX_LENGTH = 2 * 1024 + 128
const ATTESTATION_REASON_REDACTIONS = Object.freeze([
  /gh[pous]_[A-Za-z0-9]{20,}/gu,
  /github_pat_[A-Za-z0-9_]{20,}/gu,
  /npm_[A-Za-z0-9]{20,}/gu,
  /Bearer\s+\S+/gu,
  /authorization:\s*\S+(?:\s+\S+)?/giu,
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/gu,
])

// Declared before the CLI entrypoint below: this module runs `runArtifactStoreCli` during its
// own evaluation when executed directly, so anything the verifier needs must already exist.
class AttestationVerificationFailure extends Error {
  constructor(reason) {
    super(reason)
    this.name = "AttestationVerificationFailure"
  }
}
const VERIFIED_MATERIALIZATIONS = new WeakMap()

export const ARTIFACT_STORE_SPARSE_FILES = Object.freeze([
  "scripts/release/adapter-normalize.mjs",
  "scripts/release/adapters/conditional-json.mjs",
  "scripts/release/adapters/github.mjs",
  "scripts/release/adapters/http.mjs",
  "scripts/release/artifact-store.mjs",
  "scripts/release/limits.mjs",
  "scripts/release/manifest.mjs",
  "scripts/release/metadata.mjs",
  "scripts/release/npm-evidence.mjs",
  "scripts/release/release-record.mjs",
  "scripts/release/semver.mjs",
  "scripts/release/smoke-result.mjs",
  "scripts/release/terminal-records.mjs",
  "scripts/release/topology.mjs",
])

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    await runArtifactStoreCli(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

export function parseArtifactStoreArguments(argv) {
  if (!Array.isArray(argv) || argv[0] !== "resolve") throw new Error(artifactStoreUsage())
  const values = new Map()
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      !["--record", "--output-dir"].includes(flag) ||
      typeof value !== "string" ||
      value.length === 0
    ) {
      throw new Error(`Invalid artifact-store argument\n${artifactStoreUsage()}`)
    }
    if (values.has(flag)) throw new Error(`Duplicate artifact-store argument ${flag}`)
    values.set(flag, value)
  }
  if (values.size !== 2 || !values.has("--record") || !values.has("--output-dir")) {
    throw new Error(artifactStoreUsage())
  }
  return {
    command: "resolve",
    recordPath: values.get("--record"),
    outputDir: values.get("--output-dir"),
  }
}

export async function runArtifactStoreCli(
  argv,
  {
    environment = process.env,
    fileSystem = defaultFileSystem,
    fetchImpl = fetch,
    runGh = runGhCommand,
  } = {},
) {
  const input = parseArtifactStoreArguments(argv)
  const recordPath = path.resolve(input.recordPath)
  const outputDir = path.resolve(input.outputDir)
  const record = parseReleaseRecord(
    await readBoundedRegularFile(
      fileSystem,
      recordPath,
      RELEASE_PAYLOAD_LIMITS.releaseRecordBytes,
      "Release record",
    ),
  )
  const repository = parseRepository(environment.GITHUB_REPOSITORY)
  const token = environment.GITHUB_TOKEN
  if (typeof token !== "string" || token.length === 0 || /[\r\n]/u.test(token)) {
    throw new Error("GITHUB_TOKEN is required to resolve a release artifact")
  }
  const apiOrigin = environment.GITHUB_API_URL ?? "https://api.github.com"
  const metadataReader = createGitHubReader({
    owner: repository.owner,
    repo: repository.repo,
    ...(environment.GITHUB_REPOSITORY_ID === undefined
      ? {}
      : { repositoryId: environment.GITHUB_REPOSITORY_ID }),
    token,
    apiOrigin,
    fetchImpl,
  })
  const binaryReader = createGitHubReader({
    owner: repository.owner,
    repo: repository.repo,
    ...(environment.GITHUB_REPOSITORY_ID === undefined
      ? {}
      : { repositoryId: environment.GITHUB_REPOSITORY_ID }),
    token,
    apiOrigin,
    fetchImpl,
  })
  const github = createArtifactStoreGitHubRuntime({ metadataReader, binaryReader })
  const artifact = await loadVerifiedReleaseArtifact({
    record,
    actionsReader: github.actionsReader,
    releaseReader: github.releaseReader,
    attestations: createCliAttestationVerifier({
      repository: environment.GITHUB_REPOSITORY,
      token,
      fileSystem,
      runGh,
    }),
    extractArchive: extractActionsArtifactZip,
  })
  return materializeVerifiedReleaseArtifact({ artifact, outputDir, fileSystem })
}

export async function loadVerifiedReleaseArtifact({
  record,
  actionsReader,
  releaseReader,
  attestations,
  extractArchive = extractActionsArtifactZip,
}) {
  const releaseRecord = parseReleaseRecord(record)
  assertMethod(actionsReader, "getArtifactMetadata", "Actions reader")
  assertMethod(actionsReader, "downloadArtifactById", "Actions reader")
  assertMethod(releaseReader, "loadEscrow", "Release reader")
  assertMethod(attestations, "verify", "Attestation verifier")
  if (typeof extractArchive !== "function") {
    throw new TypeError("Trusted Actions archive extractor must be a function")
  }

  const metadataResult = await actionsReader.getArtifactMetadata({
    artifactId: releaseRecord.actionsArtifact.id,
    prepareRunId: releaseRecord.actionsArtifact.prepareRunId,
    prepareRunAttempt: releaseRecord.actionsArtifact.prepareRunAttempt,
  })
  if (metadataResult?.status !== "PRESENT") {
    throw new Error(
      `Actions artifact metadata could not be verified: ${resultCode(metadataResult)}`,
    )
  }
  validateActionsMetadata(metadataResult.value, releaseRecord)

  const download = await actionsReader.downloadArtifactById({
    artifactId: releaseRecord.actionsArtifact.id,
  })
  if (isRetentionExpired(download)) {
    return loadVerifiedEscrow({ releaseRecord, releaseReader, attestations })
  }
  if (download?.status !== "PRESENT" || !(download.archiveBytes instanceof Uint8Array)) {
    throw new Error(`Actions artifact download could not be verified: ${resultCode(download)}`)
  }
  assertPayloadByteLength(
    download.archiveBytes.byteLength,
    RELEASE_PAYLOAD_LIMITS.actionsArchiveBytes,
    "Actions artifact ZIP",
  )
  const archiveBytes = Buffer.from(download.archiveBytes)
  const archiveDigest = `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`
  if (archiveDigest !== releaseRecord.actionsArtifact.serviceDigest) {
    throw new Error("Actions artifact service digest does not match the release record")
  }
  const extracted = await extractArchive(Buffer.from(archiveBytes))
  return verifyMaterializedFiles({
    releaseRecord,
    files: extracted,
    attestations,
    source: "actions",
  })
}

export function extractActionsArtifactZip(
  raw,
  { maxOutputBytes = RELEASE_PAYLOAD_LIMITS.actionsExpandedBytes } = {},
) {
  if (!(raw instanceof Uint8Array)) throw new TypeError("Actions artifact ZIP must be bytes")
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > RELEASE_PAYLOAD_LIMITS.actionsExpandedBytes
  ) {
    throw new TypeError("Actions artifact ZIP output limit is invalid")
  }
  const archive = Buffer.from(raw)
  if (archive.length < 22 || archive.length > RELEASE_PAYLOAD_LIMITS.actionsArchiveBytes) {
    throw new Error("Actions artifact ZIP size is invalid")
  }
  const endOffset = findZipEnd(archive)
  const disk = archive.readUInt16LE(endOffset + 4)
  const centralDisk = archive.readUInt16LE(endOffset + 6)
  const diskEntries = archive.readUInt16LE(endOffset + 8)
  const totalEntries = archive.readUInt16LE(endOffset + 10)
  const centralSize = archive.readUInt32LE(endOffset + 12)
  const centralOffset = archive.readUInt32LE(endOffset + 16)
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries < 1 ||
    totalEntries > RELEASE_PAYLOAD_LIMITS.zipEntries ||
    centralOffset + centralSize > endOffset
  ) {
    throw new Error("Actions artifact ZIP directory is invalid or unsupported")
  }
  const files = []
  let cursor = centralOffset
  let totalUncompressedSize = 0
  for (let index = 0; index < totalEntries; index += 1) {
    assertZipRange(archive, cursor, 46)
    if (archive.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error("Actions artifact ZIP central directory is malformed")
    }
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localOffset = archive.readUInt32LE(cursor + 42)
    assertZipRange(archive, cursor + 46, nameLength + extraLength + commentLength)
    const name = decodeZipName(archive.subarray(cursor + 46, cursor + 46 + nameLength))
    if (nameLength > RELEASE_PAYLOAD_LIMITS.archiveFilenameBytes) {
      throw new Error("Actions artifact ZIP entry name exceeds its byte limit")
    }
    if (
      name.length === 0 ||
      path.posix.basename(name) !== name ||
      path.win32.basename(name) !== name
    ) {
      throw new Error("Actions artifact ZIP entry path must be one safe basename")
    }
    if ((flags & 0x1) !== 0 || ![0, 8].includes(method)) {
      throw new Error("Actions artifact ZIP entry compression is unsupported")
    }
    assertZipRange(archive, localOffset, 30)
    if (archive.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) {
      throw new Error("Actions artifact ZIP local entry is malformed")
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const localFlags = archive.readUInt16LE(localOffset + 6)
    const localMethod = archive.readUInt16LE(localOffset + 8)
    assertZipRange(archive, localOffset + 30, localNameLength + localExtraLength)
    const localName = decodeZipName(
      archive.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    )
    if (localName !== name || localFlags !== flags || localMethod !== method) {
      throw new Error("Actions artifact ZIP local and central entry identities differ")
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    assertZipRange(archive, dataOffset, compressedSize)
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize)
    totalUncompressedSize += uncompressedSize
    const entryLimit =
      name === "manifest.json"
        ? RELEASE_PAYLOAD_LIMITS.manifestBytes
        : RELEASE_PAYLOAD_LIMITS.tarballBytes
    if (
      uncompressedSize > entryLimit ||
      uncompressedSize > maxOutputBytes ||
      totalUncompressedSize > maxOutputBytes
    ) {
      throw new Error("Actions artifact ZIP entry size exceeds the output limit")
    }
    const bytes =
      method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) })
    if (bytes.length !== uncompressedSize) {
      throw new Error("Actions artifact ZIP entry size is invalid")
    }
    files.push({ name, bytes })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  if (cursor !== centralOffset + centralSize) {
    throw new Error("Actions artifact ZIP central directory size is inconsistent")
  }
  if (new Set(files.map((file) => file.name)).size !== files.length) {
    throw new Error("Actions artifact ZIP contains duplicate basenames")
  }
  return files
}

export async function materializeVerifiedReleaseArtifact({
  artifact,
  outputDir,
  fileSystem = defaultFileSystem,
}) {
  const verifiedFiles = VERIFIED_MATERIALIZATIONS.get(artifact)
  if (verifiedFiles === undefined) {
    throw new TypeError("Verified release artifact provenance is invalid")
  }
  if (
    typeof outputDir !== "string" ||
    !path.isAbsolute(outputDir) ||
    path.resolve(outputDir) !== outputDir
  ) {
    throw new TypeError("Artifact output directory must be an absolute normalized path")
  }
  await assertAbsent(outputDir, fileSystem)
  const parent = path.dirname(outputDir)
  await fileSystem.mkdir(parent, { recursive: true })
  const realParent = await fileSystem.realpath(parent)
  const realOutput = path.join(realParent, path.basename(outputDir))
  await assertAbsent(realOutput, fileSystem)
  const temporary = await fileSystem.mkdtemp(path.join(realParent, ".release-materialize-"))
  let moved = false
  try {
    for (const file of verifiedFiles) {
      await fileSystem.writeFile(path.join(temporary, file.name), file.bytes, { flag: "wx" })
    }
    await fileSystem.rename(temporary, realOutput)
    moved = true
  } finally {
    if (!moved) await fileSystem.rm(temporary, { recursive: true, force: true })
  }
  return Object.freeze({ outputDir, source: artifact.source, manifest: artifact.manifest })
}

async function loadVerifiedEscrow({ releaseRecord, releaseReader, attestations }) {
  const escrow = await releaseReader.loadEscrow({
    tag: releaseRecord.tag,
    record: releaseRecord,
  })
  if (
    escrow?.status !== "PRESENT" ||
    escrow.draft !== true ||
    !Array.isArray(escrow.files) ||
    !Array.isArray(escrow.bundles) ||
    !(escrow.releaseRecordBytes instanceof Uint8Array)
  ) {
    throw new Error(`Release escrow could not be verified: ${resultCode(escrow)}`)
  }
  if (!Buffer.from(escrow.releaseRecordBytes).equals(canonicalReleaseRecordBytes(releaseRecord))) {
    throw new Error("Release escrow release-record.json does not match the exact release record")
  }
  const bundles = normalizeFiles(escrow.bundles)
  const expectedBundleNames = escrow.files.map((file) => `${file.name}.intoto.jsonl`)
  if (
    !sameSortedSet(
      bundles.map((bundle) => bundle.name),
      expectedBundleNames,
    )
  ) {
    throw new Error("Release escrow attestation bundle set is incomplete or unexpected")
  }
  return verifyMaterializedFiles({
    releaseRecord,
    files: escrow.files,
    attestations,
    source: "escrow",
    bundles,
  })
}

async function verifyMaterializedFiles({
  releaseRecord,
  files,
  attestations,
  source,
  bundles = [],
}) {
  const normalizedFiles = normalizeFiles(files)
  const manifestFile = normalizedFiles.find((file) => file.name === "manifest.json")
  if (manifestFile === undefined) throw new Error("Verified artifact is missing manifest.json")
  const manifest = parseSealedReleaseManifest(manifestFile.bytes, {
    candidate: { version: releaseRecord.version, commitSha: releaseRecord.commitSha },
  })
  const canonicalBytes = canonicalManifestBytes(manifest)
  if (!Buffer.from(manifestFile.bytes).equals(canonicalBytes)) {
    throw new Error("Release manifest bytes are not canonical")
  }
  const manifestDigest = createHash("sha256").update(canonicalBytes).digest("hex")
  if (manifestDigest !== releaseRecord.manifestSha256) {
    throw new Error("Release manifest digest does not match the release record")
  }
  if (
    manifest.artifact.name !== releaseRecord.actionsArtifact.name ||
    String(manifest.artifact.prepareRunId) !== releaseRecord.actionsArtifact.prepareRunId ||
    manifest.artifact.prepareRunAttempt !== releaseRecord.actionsArtifact.prepareRunAttempt
  ) {
    throw new Error("Release manifest preparation identity does not match the release record")
  }

  const expectedNames = ["manifest.json", ...manifest.packages.map((entry) => entry.filename)]
  const actualNames = normalizedFiles.map((file) => file.name)
  if (!sameSortedSet(expectedNames, actualNames)) {
    throw new Error("Verified artifact inner file set does not exactly match the release manifest")
  }
  const filesByName = new Map(normalizedFiles.map((file) => [file.name, file]))
  for (const entry of manifest.packages) {
    const file = filesByName.get(entry.filename)
    if (file.bytes.length !== entry.size) {
      throw new Error(`Tarball ${entry.filename} size does not match the release manifest`)
    }
    const sha256 = createHash("sha256").update(file.bytes).digest("hex")
    const sha512 = createHash("sha512").update(file.bytes).digest("hex")
    if (sha256 !== entry.sha256 || sha512 !== entry.sha512) {
      throw new Error(`Tarball ${entry.filename} digest does not match the release manifest`)
    }
  }

  const orderedFiles = expectedNames.map((name) => filesByName.get(name))
  const subjects = orderedFiles.map((file) => ({
    name: file.name,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  }))
  const attestationResult = await attestations.verify({
    source,
    record: releaseRecord,
    subjects,
    files: orderedFiles.map((file) => ({ name: file.name, bytes: Buffer.from(file.bytes) })),
    bundles,
  })
  validateAttestationResult(attestationResult, subjects)
  const verifiedFiles = orderedFiles.map((file) => ({
    name: file.name,
    bytes: Buffer.from(file.bytes),
  }))
  const artifact = Object.freeze({
    source,
    record: releaseRecord,
    manifest,
    files: Object.freeze(
      verifiedFiles.map((file) =>
        Object.freeze({ name: file.name, bytes: Buffer.from(file.bytes) }),
      ),
    ),
  })
  VERIFIED_MATERIALIZATIONS.set(
    artifact,
    verifiedFiles.map((file) => Object.freeze({ name: file.name, bytes: Buffer.from(file.bytes) })),
  )
  return artifact
}

function validateActionsMetadata(value, record) {
  const metadata = snapshotExactDataObject(value, METADATA_FIELDS, "Actions artifact metadata")
  if (
    metadata.id !== record.actionsArtifact.id ||
    metadata.name !== record.actionsArtifact.name ||
    metadata.serviceDigest !== record.actionsArtifact.serviceDigest ||
    typeof metadata.expired !== "boolean" ||
    metadata.prepareRunId !== record.actionsArtifact.prepareRunId ||
    metadata.prepareRunAttempt !== record.actionsArtifact.prepareRunAttempt ||
    metadata.headSha !== record.commitSha
  ) {
    throw new Error(
      "Actions artifact metadata does not match exact recorded identity or service digest",
    )
  }
}

function validateAttestationResult(value, subjects) {
  if (value?.status !== "VERIFIED" || !Array.isArray(value.subjects)) {
    const reason =
      typeof value?.reason === "string" && value.reason.length > 0
        ? `: ${sanitizeReasonText(value.reason)}`
        : ""
    throw new Error(`GitHub attestation verification did not succeed${reason}`)
  }
  const normalized = value.subjects.map((subject) => {
    if (
      subject === null ||
      Array.isArray(subject) ||
      typeof subject !== "object" ||
      typeof subject.name !== "string" ||
      !SHA256_PATTERN.test(subject.sha256)
    ) {
      throw new Error("GitHub attestation subjects are malformed")
    }
    return { name: subject.name, sha256: subject.sha256 }
  })
  const expected = subjects.map((subject) => `${subject.name}:${subject.sha256}`).sort()
  const actual = normalized.map((subject) => `${subject.name}:${subject.sha256}`).sort()
  if (!arraysEqual(actual, expected)) {
    throw new Error("GitHub attestation subjects do not exactly cover the release artifact")
  }
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) throw new TypeError("Verified artifact files must be an array")
  const result = files.map((file, index) => {
    const snapshot = snapshotExactDataObject(
      file,
      ["name", "bytes"],
      `Verified artifact file ${index}`,
    )
    if (
      typeof snapshot.name !== "string" ||
      path.posix.basename(snapshot.name) !== snapshot.name ||
      path.win32.basename(snapshot.name) !== snapshot.name ||
      !(snapshot.bytes instanceof Uint8Array)
    ) {
      throw new TypeError(`Verified artifact file ${index} is malformed`)
    }
    return { name: snapshot.name, bytes: Buffer.from(snapshot.bytes) }
  })
  const names = result.map((file) => file.name)
  if (new Set(names).size !== names.length)
    throw new Error("Verified artifact contains duplicate files")
  return result
}

function findZipEnd(archive) {
  const minimum = Math.max(0, archive.length - 65_557)
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) !== ZIP_END_SIGNATURE) continue
    const commentLength = archive.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === archive.length) return offset
  }
  throw new Error("Actions artifact ZIP end record is missing")
}

function assertZipRange(archive, offset, length) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > archive.length
  ) {
    throw new Error("Actions artifact ZIP entry exceeds archive bounds")
  }
}

function decodeZipName(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error("Actions artifact ZIP entry name is not valid UTF-8", { cause: error })
  }
}

async function assertAbsent(target, fileSystem) {
  try {
    await fileSystem.lstat(target)
  } catch (error) {
    if (error?.code === "ENOENT") return
    throw error
  }
  throw new Error(`Artifact output must be fresh; destination already exists: ${target}`)
}

export function createArtifactStoreGitHubRuntime({
  metadataReader,
  binaryReader,
  maxEscrowBytes = RELEASE_PAYLOAD_LIMITS.escrowBytes,
}) {
  if (
    !Number.isSafeInteger(maxEscrowBytes) ||
    maxEscrowBytes < 1 ||
    maxEscrowBytes > RELEASE_PAYLOAD_LIMITS.escrowBytes
  ) {
    throw new TypeError("Release escrow byte budget is invalid")
  }
  return {
    actionsReader: {
      async getArtifactMetadata({ artifactId, prepareRunId, prepareRunAttempt }) {
        const artifactResult = await metadataReader.getActionsArtifact({ artifactId })
        if (artifactResult.status !== "PRESENT") return artifactResult
        const runResult = await metadataReader.getActionsRunAttempt({
          runId: prepareRunId,
          attempt: prepareRunAttempt,
        })
        if (runResult.status !== "PRESENT") return runResult
        const artifact = artifactResult.value
        const run = runResult.value
        if (
          artifact === null ||
          typeof artifact !== "object" ||
          run === null ||
          typeof run !== "object" ||
          artifact.workflow_run === null ||
          typeof artifact.workflow_run !== "object" ||
          String(artifact.id) !== String(artifactId) ||
          String(artifact.workflow_run.id) !== String(prepareRunId) ||
          String(run.id) !== String(prepareRunId) ||
          run.run_attempt !== prepareRunAttempt ||
          artifact.workflow_run.head_sha !== run.head_sha
        ) {
          return { status: "ERROR", httpStatus: 200, code: "MALFORMED_SCHEMA" }
        }
        return {
          status: "PRESENT",
          value: {
            id: String(artifact.id),
            name: artifact.name,
            serviceDigest: artifact.digest,
            expired: artifact.expired,
            prepareRunId: String(run.id),
            prepareRunAttempt: run.run_attempt,
            headSha: run.head_sha,
          },
        }
      },
      async downloadArtifactById({ artifactId }) {
        const result = await binaryReader.downloadActionsArtifact({ artifactId })
        if (result.httpStatus === 410 && result.code === "HTTP_410") {
          return { status: "GONE", httpStatus: 410, code: "RETENTION_EXPIRED" }
        }
        return result.status === "PRESENT"
          ? {
              status: "PRESENT",
              archiveBytes: decodeCanonicalBase64(
                result.contentBase64,
                RELEASE_PAYLOAD_LIMITS.actionsArchiveBytes,
                "Actions artifact ZIP",
              ),
            }
          : result
      },
    },
    releaseReader: {
      async loadEscrow({ tag, record }) {
        const budget = {
          remaining: maxEscrowBytes,
          payloadRemaining: RELEASE_PAYLOAD_LIMITS.actionsExpandedBytes,
          bundlesRemaining: RELEASE_PAYLOAD_LIMITS.attestationBundlesBytes,
        }
        const releasesResult = await metadataReader.listReleases()
        if (releasesResult.status !== "PRESENT") return releasesResult
        const matching = releasesResult.value.filter((release) =>
          isManagedReleaseForTag(release, tag),
        )
        if (matching.length !== 1) {
          return { status: "ERROR", httpStatus: 200, code: "RELEASE_IDENTITY_CONFLICT" }
        }
        const [release] = matching
        if (
          release.target_commitish !== "main" ||
          release.draft !== true ||
          release.immutable !== false ||
          release.prerelease !== false ||
          !Number.isSafeInteger(release.id)
        ) {
          return { status: "ERROR", httpStatus: 200, code: "RELEASE_IDENTITY_CONFLICT" }
        }
        const tagProof = await verifyEscrowAnnotatedTag(metadataReader, { tag, record })
        if (tagProof.status !== "PRESENT") return tagProof
        const assetsResult = await metadataReader.listReleaseAssets({ releaseId: release.id })
        if (assetsResult.status !== "PRESENT" || !Array.isArray(assetsResult.value)) {
          return assetsResult.status === "PRESENT"
            ? { status: "ERROR", httpStatus: 200, code: "MALFORMED_SCHEMA" }
            : assetsResult
        }
        const byName = indexReleaseAssets(assetsResult.value)
        const releaseRecordAsset = requireReleaseAsset(byName, "release-record.json")
        const releaseRecordBytes = await downloadReleaseAsset(
          binaryReader,
          releaseRecordAsset,
          budget,
          {
            classLimit: RELEASE_PAYLOAD_LIMITS.releaseRecordBytes,
            label: "release-record.json",
          },
        )
        const manifestAsset = requireReleaseAsset(byName, "manifest.json")
        const manifestBytes = await downloadReleaseAsset(binaryReader, manifestAsset, budget, {
          classLimit: RELEASE_PAYLOAD_LIMITS.manifestBytes,
          label: "manifest.json",
          remainingField: "payloadRemaining",
        })
        const manifest = parseSealedReleaseManifest(manifestBytes, {
          candidate: { version: record.version, commitSha: record.commitSha },
        })
        const names = ["manifest.json", ...manifest.packages.map((entry) => entry.filename)]
        const bundleNames = names.map((name) => `${name}.intoto.jsonl`)
        const expectedAssetNames = ["release-record.json", ...names, ...bundleNames]
        if (!containsExactEscrowAssetSet(byName, expectedAssetNames)) {
          return { status: "ERROR", httpStatus: 200, code: "ESCROW_ASSET_SET_CONFLICT" }
        }
        const files = [{ name: "manifest.json", bytes: manifestBytes }]
        for (const name of names.slice(1)) {
          files.push({
            name,
            bytes: await downloadReleaseAsset(
              binaryReader,
              requireReleaseAsset(byName, name),
              budget,
              {
                classLimit: RELEASE_PAYLOAD_LIMITS.tarballBytes,
                label: name,
                remainingField: "payloadRemaining",
              },
            ),
          })
        }
        const bundles = []
        for (const name of bundleNames) {
          bundles.push({
            name,
            bytes: await downloadReleaseAsset(
              binaryReader,
              requireReleaseAsset(byName, name),
              budget,
              {
                classLimit: RELEASE_PAYLOAD_LIMITS.attestationBundleBytes,
                label: name,
                remainingField: "bundlesRemaining",
              },
            ),
          })
        }
        return { status: "PRESENT", draft: true, files, releaseRecordBytes, bundles }
      },
    },
  }
}

async function verifyEscrowAnnotatedTag(reader, { tag, record }) {
  const ref = await reader.getRef({ ref: `tags/${tag}` })
  if (ref?.status !== "PRESENT") return ref
  const value = ref.value
  if (
    value === null ||
    typeof value !== "object" ||
    value.ref !== `refs/tags/${tag}` ||
    value.object === null ||
    typeof value.object !== "object" ||
    value.object.type !== "tag" ||
    typeof value.object.sha !== "string" ||
    !SHA_PATTERN.test(value.object.sha)
  ) {
    return { status: "ERROR", httpStatus: 200, code: "TAG_IDENTITY_CONFLICT" }
  }
  const annotated = await reader.getGitTag({ tagSha: value.object.sha })
  if (annotated?.status !== "PRESENT") return annotated
  if (
    annotated.value === null ||
    typeof annotated.value !== "object" ||
    annotated.value.tag !== tag ||
    annotated.value.object === null ||
    typeof annotated.value.object !== "object" ||
    annotated.value.object.type !== "commit" ||
    annotated.value.object.sha !== record.commitSha
  ) {
    return { status: "ERROR", httpStatus: 200, code: "TAG_IDENTITY_CONFLICT" }
  }
  return { status: "PRESENT" }
}

function containsExactEscrowAssetSet(byName, expectedAssetNames) {
  if (byName.size > expectedAssetNames.length + MAX_LATER_RECEIPT_ASSETS) return false
  const expected = new Set(expectedAssetNames)
  if ([...expected].some((name) => !byName.has(name))) return false
  for (const [name, asset] of byName) {
    if (expected.has(name)) continue
    if (!isAllowedLaterReceipt(name, asset.size)) return false
  }
  return true
}

function isAllowedLaterReceipt(name, size) {
  if (
    name !== "audit-result.json" &&
    !LATER_AUDIT_ATTEMPT_PATTERN.test(name) &&
    !LATER_SMOKE_RECEIPT_PATTERN.test(name)
  ) {
    return false
  }
  try {
    assertPayloadByteLength(size, RELEASE_PAYLOAD_LIMITS.auditReceiptBytes, name)
    return true
  } catch {
    return false
  }
}

/**
 * Verifies release attestations with the gh CLI.
 *
 * Escrow mode runs `gh attestation verify --bundle` ONCE, for the first file (the anchor),
 * which proves the signature, the Sigstore chain, the signer workflow, and the source
 * ref/digest of the multi-subject bundle. Every other file is then proved a member of that
 * verified statement locally: its sha256 and name must appear among the statement subjects,
 * the statement must carry exactly as many subjects as the input, and every per-file bundle
 * must be byte-identical to the anchor (the escrow set replicates one bundle 22 times). This
 * turns 22 network verifications into 1.
 *
 * Actions mode has no bundle to prove membership against (gh fetches each subject's
 * attestation from the API by digest), so it stays online per file with the same budget.
 */
export function createCliAttestationVerifier({
  repository,
  token,
  environment = process.env,
  fileSystem = defaultFileSystem,
  runGh = runGhCommand,
}) {
  const verifierEnvironment = { ...environment, GH_TOKEN: token }
  return {
    async verify({ source, record, subjects, files, bundles }) {
      if (!Array.isArray(subjects) || !Array.isArray(files) || files.length !== subjects.length) {
        return invalidAttestationResult("attestation subject and file counts differ")
      }
      if (files.length === 0) return invalidAttestationResult("no attestation subjects to verify")
      const bundlesByName = new Map(
        Array.isArray(bundles) ? bundles.map((bundle) => [bundle.name, bundle]) : [],
      )
      const directory = await fileSystem.mkdtemp(path.join(os.tmpdir(), "dawn-attest-"))
      try {
        const verifyOnline = async (file, bundle) => {
          const target = path.join(directory, file.name)
          await fileSystem.writeFile(target, file.bytes, { flag: "wx" })
          let bundlePath
          if (bundle !== undefined) {
            bundlePath = path.join(directory, bundle.name)
            await fileSystem.writeFile(bundlePath, bundle.bytes, { flag: "wx" })
          }
          const args = buildAttestationVerificationArguments({
            source,
            target,
            repository,
            record,
            ...(bundlePath === undefined ? {} : { bundlePath }),
          })
          try {
            await runGh(args, {
              env: { ...verifierEnvironment },
              timeout: ATTESTATION_VERIFY_TIMEOUT_MS,
              killSignal: "SIGKILL",
            })
          } catch (error) {
            throw new AttestationVerificationFailure(describeGhFailure(file.name, error))
          }
        }
        if (source === "escrow") {
          const anchorFile = files[0]
          const anchorBundle = bundlesByName.get(`${anchorFile.name}.intoto.jsonl`)
          if (anchorBundle === undefined) {
            throw new AttestationVerificationFailure(
              `attestation bundle for ${anchorFile.name} is missing`,
            )
          }
          await verifyOnline(anchorFile, anchorBundle)
          proveSubjectMembership({ anchorBundle, bundlesByName, subjects, files })
        } else {
          for (const file of files) await verifyOnline(file, undefined)
        }
      } catch (error) {
        return invalidAttestationResult(
          error instanceof AttestationVerificationFailure
            ? error.message
            : `attestation verification threw: ${sanitizeReasonText(String(error?.message ?? error))}`,
        )
      } finally {
        await fileSystem.rm(directory, { recursive: true, force: true })
      }
      return { status: "VERIFIED", subjects }
    },
  }
}

function invalidAttestationResult(reason) {
  return { status: "INVALID", subjects: [], reason: sanitizeReasonText(reason) }
}

/**
 * Proves every input file is a subject of the gh-verified anchor statement. The anchor
 * bundle is one JSON line whose DSSE payload is a base64 in-toto statement with
 * `subject[] = { name, digest: { sha256 } }`.
 */
function proveSubjectMembership({ anchorBundle, bundlesByName, subjects, files }) {
  const anchorBytes = Buffer.from(anchorBundle.bytes)
  const statementSubjects = parseAnchorStatementSubjects(anchorBytes)
  if (statementSubjects.length !== subjects.length) {
    throw new AttestationVerificationFailure(
      `anchor attestation lists ${statementSubjects.length} subjects but ${subjects.length} were expected`,
    )
  }
  const attested = new Set(statementSubjects.map(({ name, sha256 }) => `${name}:${sha256}`))
  for (const [index, file] of files.entries()) {
    const bundle = bundlesByName.get(`${file.name}.intoto.jsonl`)
    if (bundle === undefined) {
      throw new AttestationVerificationFailure(`attestation bundle for ${file.name} is missing`)
    }
    if (!Buffer.from(bundle.bytes).equals(anchorBytes)) {
      throw new AttestationVerificationFailure(
        `attestation bundle for ${file.name} is not byte-identical to the verified anchor`,
      )
    }
    const sha256 = createHash("sha256").update(file.bytes).digest("hex")
    const subject = subjects[index]
    if (subject?.name !== file.name || subject.sha256 !== sha256) {
      throw new AttestationVerificationFailure(
        `subject ${index} does not describe file ${file.name} (${sha256})`,
      )
    }
    if (!attested.has(`${file.name}:${sha256}`)) {
      throw new AttestationVerificationFailure(
        `${file.name} (${sha256}) is not attested by the verified anchor`,
      )
    }
  }
}

function parseAnchorStatementSubjects(bytes) {
  let statement
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    const bundle = JSON.parse(source)
    const envelope = bundle?.dsseEnvelope
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      envelope.payloadType !== "application/vnd.in-toto+json" ||
      typeof envelope.payload !== "string"
    ) {
      throw new Error("bundle is not one DSSE in-toto envelope")
    }
    const payload = Buffer.from(envelope.payload, "base64")
    if (payload.length === 0 || payload.toString("base64") !== envelope.payload) {
      throw new Error("bundle payload is not canonical base64")
    }
    statement = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload))
  } catch (error) {
    throw new AttestationVerificationFailure(
      `anchor attestation bundle is unreadable: ${sanitizeReasonText(String(error?.message ?? error))}`,
    )
  }
  if (!Array.isArray(statement?.subject)) {
    throw new AttestationVerificationFailure("anchor attestation statement has no subject list")
  }
  return statement.subject.map((subject, index) => {
    const name = subject?.name
    const sha256 = subject?.digest?.sha256
    if (typeof name !== "string" || !SHA256_PATTERN.test(sha256)) {
      throw new AttestationVerificationFailure(
        `anchor attestation subject ${index} is missing a name or sha256 digest`,
      )
    }
    return { name, sha256 }
  })
}

function describeGhFailure(fileName, error) {
  const parts = [`gh attestation verify ${fileName}:`]
  const signal = typeof error?.signal === "string" ? error.signal : null
  const code = error?.code
  if (signal !== null) {
    parts.push(
      `signal ${signal}${
        signal === "SIGKILL" || error?.killed === true
          ? ` (timed out after ${ATTESTATION_VERIFY_TIMEOUT_MS}ms)`
          : ""
      }`,
    )
  } else if (Number.isInteger(code)) {
    parts.push(`exit code ${code}`)
  } else if (typeof code === "string") {
    parts.push(`error ${code}`)
  } else {
    parts.push("failed without an exit code")
  }
  const stderr = error?.stderr
  const stderrBytes =
    typeof stderr === "string"
      ? Buffer.from(stderr, "utf8")
      : Buffer.isBuffer(stderr)
        ? stderr
        : null
  if (stderrBytes !== null && stderrBytes.length > 0) {
    parts.push(
      `stderr: ${stderrBytes.subarray(0, ATTESTATION_REASON_STDERR_BYTES).toString("utf8")}`,
    )
  } else if (typeof error?.message === "string" && error.message.length > 0) {
    parts.push(error.message)
  }
  return parts.join(" ")
}

/** Redacts credential shapes, strips control characters, collapses whitespace, and bounds length. */
function sanitizeReasonText(value) {
  let text = typeof value === "string" ? value : String(value)
  text = Array.from(text, (character) => {
    const codePoint = character.codePointAt(0)
    return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character
  }).join("")
  text = text.replace(/https?:\/\/[^\s?#]*\?\S*/gu, (token) => token.slice(0, token.indexOf("?")))
  for (const pattern of ATTESTATION_REASON_REDACTIONS) {
    text = text.replace(pattern, "[redacted]")
  }
  text = text.replace(/\s+/gu, " ").trim()
  if (text.length > ATTESTATION_REASON_MAX_LENGTH) {
    text = `${text.slice(0, ATTESTATION_REASON_MAX_LENGTH - 1)}…`
  }
  return text.length === 0 ? "(no reason)" : text
}

export function buildAttestationVerificationArguments({
  source,
  target,
  repository,
  record,
  bundlePath,
}) {
  const releaseRecord = parseReleaseRecord(record)
  if (source !== "actions" && source !== "escrow") {
    throw new TypeError("Attestation source must be actions or escrow")
  }
  if (repository !== "cacheplane/dawnai") {
    throw new TypeError("Attestation repository must be cacheplane/dawnai")
  }
  validateAbsoluteRuntimePath(target, "attestation target")
  if (source === "escrow") validateAbsoluteRuntimePath(bundlePath, "attestation bundle")
  else if (bundlePath !== undefined)
    throw new TypeError("Actions attestation must not use a bundle")
  const args = [
    "attestation",
    "verify",
    target,
    "--repo",
    repository,
    "--digest-alg",
    "sha256",
    "--signer-workflow",
    "cacheplane/dawnai/.github/workflows/release.yml",
    "--deny-self-hosted-runners",
    "--source-digest",
    releaseRecord.commitSha,
    "--source-ref",
    `refs/tags/${releaseRecord.tag}`,
    "--predicate-type",
    "https://slsa.dev/provenance/v1",
  ]
  if (source === "escrow") args.push("--bundle", bundlePath)
  return args
}

function validateAbsoluteRuntimePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new TypeError(`${label} must be an absolute normalized path`)
  }
}

function indexReleaseAssets(assets) {
  const byName = new Map()
  for (const asset of assets) {
    if (
      asset === null ||
      typeof asset !== "object" ||
      typeof asset.name !== "string" ||
      !Number.isSafeInteger(asset.id) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1
    ) {
      throw new Error("Release escrow asset metadata is malformed")
    }
    if (byName.has(asset.name)) throw new Error(`Release escrow has duplicate asset ${asset.name}`)
    byName.set(asset.name, asset)
  }
  return byName
}

function requireReleaseAsset(byName, name) {
  const asset = byName.get(name)
  if (asset === undefined) throw new Error(`Release escrow is missing asset ${name}`)
  return asset
}

async function downloadReleaseAsset(
  reader,
  asset,
  budget,
  { classLimit, label, remainingField } = {},
) {
  assertPayloadByteLength(asset.size, classLimit, `Release escrow asset ${label}`)
  if (asset.size > budget.remaining) {
    throw new Error("Release escrow download byte budget exceeded")
  }
  if (remainingField !== undefined && asset.size > budget[remainingField]) {
    throw new Error(`Release escrow ${label} cumulative byte budget exceeded`)
  }
  const result = await reader.downloadReleaseAsset({
    assetId: asset.id,
    maximumBytes: asset.size,
  })
  if (result.status !== "PRESENT") {
    throw new Error(`Release escrow asset ${asset.name} could not be downloaded`)
  }
  const bytes = decodeCanonicalBase64(result.contentBase64, asset.size, `Release escrow ${label}`)
  if (bytes.length !== asset.size) {
    throw new Error(`Release escrow asset ${label} size differs from metadata`)
  }
  budget.remaining -= bytes.length
  if (remainingField !== undefined) budget[remainingField] -= bytes.length
  return bytes
}

function parseRepository(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new Error("GITHUB_REPOSITORY must be owner/repository")
  }
  const [owner, repo] = value.split("/")
  return { owner, repo }
}

async function runGhCommand(args, options) {
  await execFileAsync("gh", args, { ...options, maxBuffer: 4 * 1024 * 1024 })
}

function decodeCanonicalBase64(value, maximumBytes, label) {
  if (typeof value !== "string") throw new Error("GitHub binary response is missing base64 bytes")
  const maximumBase64Length = 4 * Math.ceil(maximumBytes / 3)
  if (value.length > maximumBase64Length) {
    throw new Error(`${label} exceeds its encoded byte limit`)
  }
  const bytes = Buffer.from(value, "base64")
  if (bytes.toString("base64") !== value)
    throw new Error("GitHub binary response is not canonical base64")
  return bytes
}

async function readBoundedRegularFile(fileSystem, target, maximumBytes, label) {
  const stat = await fileSystem.lstat(target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw new Error(`${label} must be one positive regular file`)
  }
  assertPayloadByteLength(stat.size, maximumBytes, label)
  const bytes = await fileSystem.readFile(target)
  assertPayloadByteLength(bytes.byteLength, maximumBytes, label)
  if (bytes.byteLength !== stat.size) throw new Error(`${label} changed while being read`)
  return bytes
}

function artifactStoreUsage() {
  return "Usage: node scripts/release/artifact-store.mjs resolve --record <release-record.json> --output-dir <directory>"
}

function isRetentionExpired(result) {
  return (
    result?.status === "GONE" && result.httpStatus === 410 && result.code === "RETENTION_EXPIRED"
  )
}

function assertMethod(value, method, label) {
  if (typeof value?.[method] !== "function") throw new TypeError(`${label} must expose ${method}`)
}

function assertObject(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new Error(`${label} is missing field ${field}`)
  }
  const unknown = Object.keys(value)
    .filter((field) => !fields.includes(field))
    .sort()
  if (unknown.length > 0) throw new Error(`${label} contains unknown field ${unknown[0]}`)
}

function snapshotExactDataObject(value, fields, label) {
  assertObject(value, label)
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} snapshot contains a symbol field`)
  }
  const snapshot = Object.create(null)
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} snapshot contains an accessor or non-enumerable field`)
    }
    snapshot[key] = descriptor.value
  }
  assertExactFields(snapshot, fields, label)
  return snapshot
}

function resultCode(result) {
  return `${result?.status ?? "MALFORMED"}/${result?.httpStatus ?? "none"}/${result?.code ?? "none"}`
}

function sameSortedSet(left, right) {
  return arraysEqual([...left].sort(), [...right].sort())
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
