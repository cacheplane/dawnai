#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process"
import { randomUUID as defaultRandomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import * as defaultFileSystem from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { isProxy } from "node:util/types"

import { snapshotJson } from "./adapter-normalize.mjs"
import { createGitReader } from "./adapters/git.mjs"
import { createGitHubReader } from "./adapters/github.mjs"
import { createNpmReader } from "./adapters/npm.mjs"
import { createCliAttestationVerifier } from "./artifact-store.mjs"
import {
  DUPLICATE_DRAFT_RECOVERY_POLICY,
  applyDuplicateDraftRecovery as defaultApplyDuplicateDraftRecovery,
  canonicalDuplicateDraftEvidence as defaultCanonicalDuplicateDraftEvidence,
  captureDuplicateDraftRecoveryEvidence as defaultCaptureDuplicateDraftRecoveryEvidence,
  parseDuplicateDraftEvidence as defaultParseDuplicateDraftEvidence,
} from "./duplicate-draft-recovery.mjs"
import {
  createDuplicateDraftRecoveryReader as defaultCreateDuplicateDraftRecoveryReader,
  createDuplicateDraftRecoveryWriter as defaultCreateDuplicateDraftRecoveryWriter,
} from "./duplicate-draft-recovery-adapters.mjs"
import { readBoundedFixture } from "./fixture-io.mjs"
import { createProductionInventoryReader, observeProductionCandidate } from "./observe.mjs"
import { planRelease } from "./planner.mjs"

const execFile = promisify(execFileCallback)
const RECOVERY_DIRECTORY = ".dawn/release-recovery"
const ACKNOWLEDGEMENT_FLAG = "--acknowledge-non-atomic-release-edit-freeze"
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MAX_PATH_BYTES = 4_096
const MAX_EVIDENCE_BYTES = 512 * 1024
const MAX_RECEIPT_BYTES = 512 * 1024
const MAX_GIT_OUTPUT_BYTES = 8 * 1024
const DEPENDENCY_FIELDS = Object.freeze([
  "applyDuplicateDraftRecovery",
  "canonicalDuplicateDraftEvidence",
  "captureDuplicateDraftRecoveryEvidence",
  "createDuplicateDraftRecoveryReader",
  "createDuplicateDraftRecoveryWriter",
  "createProductionRecoveryObserver",
  "fileSystem",
  "parseDuplicateDraftEvidence",
  "randomUUID",
  "resolveRepositoryRoot",
])

export function parseDuplicateDraftRecoveryCliArguments(argv) {
  const values = snapshotArgumentArray(argv)
  if (
    values.length === 5 &&
    values[0] === "capture" &&
    values[1] === "--reviewed-commit" &&
    SHA_PATTERN.test(values[2]) &&
    values[3] === "--output"
  ) {
    return Object.freeze({
      command: "capture",
      reviewedCommit: values[2],
      output: normalizePrivatePath(values[4]),
    })
  }
  if (
    values.length === 6 &&
    values[0] === "apply" &&
    values[1] === "--evidence" &&
    values[3] === ACKNOWLEDGEMENT_FLAG &&
    values[4] === "--output"
  ) {
    const evidence = normalizePrivatePath(values[2])
    const output = normalizePrivatePath(values[5])
    if (evidence === output) throw new RecoveryInputError()
    return Object.freeze({ command: "apply", evidence, output })
  }
  throw new RecoveryInputError()
}

export async function runDuplicateDraftRecoveryCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  dependencies = {},
} = {}) {
  let outputReservation = null
  try {
    const options = parseDuplicateDraftRecoveryCliArguments(argv)
    const runtime = normalizeRuntime({
      cwd,
      environment,
      stdout,
      stderr,
      dependencies,
    })
    const root = await runtime.resolveRepositoryRoot(runtime.cwd)
    const paths = resolveInvocationPaths(root, options)
    await assertPrivatePathBoundary(runtime.fileSystem, root, paths.output)

    if (options.command === "capture") {
      await assertGitIgnored(root, paths.output.relative)
      await assertUnusedOutput(runtime.fileSystem, paths.output.absolute)
      const token = environmentToken(runtime.environment)
      const reader = runtime.createDuplicateDraftRecoveryReader({
        root,
        token,
      })
      const evidence = await runtime.captureDuplicateDraftRecoveryEvidence({
        reviewedCommit: options.reviewedCommit,
        reader,
      })
      const bytes = runtime.canonicalDuplicateDraftEvidence(evidence)
      await assertPrivatePathBoundary(runtime.fileSystem, root, paths.output)
      await assertGitIgnored(root, paths.output.relative)
      outputReservation = await reserveExclusiveOutput(runtime, paths.output.absolute)
      await outputReservation.commit(bytes, MAX_EVIDENCE_BYTES)
      outputReservation = null
      runtime.stdout.write("Duplicate draft recovery evidence captured.\n")
      return 0
    }

    await assertPrivatePathBoundary(runtime.fileSystem, root, paths.evidence)
    await assertGitIgnored(root, paths.evidence.relative)
    await assertGitIgnored(root, paths.output.relative)
    const evidenceBytes = await readBoundedPrivateFile(
      runtime.fileSystem,
      paths.evidence.absolute,
      MAX_EVIDENCE_BYTES,
    )
    // Reject malformed UTF-8 at the filesystem boundary before invoking the
    // canonical evidence parser.
    new TextDecoder("utf-8", { fatal: true }).decode(evidenceBytes)
    const evidence = runtime.parseDuplicateDraftEvidence(evidenceBytes)
    const acknowledgement = concurrencyAcknowledgement()

    await assertPrivatePathBoundary(runtime.fileSystem, root, paths.output)
    await assertGitIgnored(root, paths.output.relative)
    outputReservation = await reserveExclusiveOutput(runtime, paths.output.absolute)

    const token = environmentToken(runtime.environment)
    const reader = runtime.createDuplicateDraftRecoveryReader({ root, token })
    const observer = runtime.createProductionRecoveryObserver({
      root,
      token,
      reader,
      environment: runtime.environment,
      fileSystem: runtime.fileSystem,
    })
    const receipt = await runtime.applyDuplicateDraftRecovery({
      evidence,
      concurrencyAcknowledgement: acknowledgement,
      reader,
      createWriter: () => runtime.createDuplicateDraftRecoveryWriter({ token }),
      observer,
    })
    const receiptBytes = canonicalFinalAuthorizationReceiptBytes(receipt, token)
    await assertPrivatePathBoundary(runtime.fileSystem, root, paths.output)
    await assertGitIgnored(root, paths.output.relative)
    await outputReservation.commit(receiptBytes, MAX_RECEIPT_BYTES)
    outputReservation = null
    runtime.stdout.write("Duplicate draft recovery authorization recorded.\n")
    return 0
  } catch (error) {
    await outputReservation?.abort().catch(() => {})
    const input = error instanceof RecoveryInputError
    try {
      stderr.write(
        input ? "Invalid duplicate draft recovery input.\n" : "Duplicate draft recovery failed.\n",
      )
    } catch {}
    return input ? 2 : 1
  }
}

function normalizeRuntime({ cwd, environment, stdout, stderr, dependencies }) {
  if (
    typeof cwd !== "string" ||
    !path.isAbsolute(cwd) ||
    hasControlCharacters(cwd) ||
    environment === null ||
    typeof environment !== "object" ||
    stdout === null ||
    typeof stdout?.write !== "function" ||
    stderr === null ||
    typeof stderr?.write !== "function"
  ) {
    throw new RecoveryInputError()
  }
  validateDependencies(dependencies)
  const dependency = (name, fallback) => dataProperty(dependencies, name) ?? fallback
  return Object.freeze({
    cwd,
    environment,
    stdout,
    stderr,
    fileSystem: dependency("fileSystem", defaultFileSystem),
    randomUUID: dependency("randomUUID", defaultRandomUUID),
    resolveRepositoryRoot: dependency("resolveRepositoryRoot", resolveRepositoryRoot),
    applyDuplicateDraftRecovery: dependency(
      "applyDuplicateDraftRecovery",
      defaultApplyDuplicateDraftRecovery,
    ),
    canonicalDuplicateDraftEvidence: dependency(
      "canonicalDuplicateDraftEvidence",
      defaultCanonicalDuplicateDraftEvidence,
    ),
    captureDuplicateDraftRecoveryEvidence: dependency(
      "captureDuplicateDraftRecoveryEvidence",
      defaultCaptureDuplicateDraftRecoveryEvidence,
    ),
    createDuplicateDraftRecoveryReader: dependency(
      "createDuplicateDraftRecoveryReader",
      defaultCreateDuplicateDraftRecoveryReader,
    ),
    createDuplicateDraftRecoveryWriter: dependency(
      "createDuplicateDraftRecoveryWriter",
      defaultCreateDuplicateDraftRecoveryWriter,
    ),
    createProductionRecoveryObserver: dependency(
      "createProductionRecoveryObserver",
      createProductionRecoveryObserver,
    ),
    parseDuplicateDraftEvidence: dependency(
      "parseDuplicateDraftEvidence",
      defaultParseDuplicateDraftEvidence,
    ),
  })
}

function validateDependencies(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new RecoveryInputError()
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null
    if (
      typeof key !== "string" ||
      !DEPENDENCY_FIELDS.includes(key) ||
      descriptor === null ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      (key !== "fileSystem" && typeof descriptor.value !== "function")
    ) {
      throw new RecoveryInputError()
    }
  }
}

function snapshotArgumentArray(value) {
  if (!Array.isArray(value) || value.length > 8) throw new RecoveryInputError()
  const output = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length === 0 ||
      Buffer.byteLength(descriptor.value, "utf8") > MAX_PATH_BYTES ||
      hasControlCharacters(descriptor.value)
    ) {
      throw new RecoveryInputError()
    }
    output.push(descriptor.value)
  }
  return output
}

function normalizePrivatePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    hasControlCharacters(value) ||
    path.isAbsolute(value) ||
    value !== path.normalize(value) ||
    !value.startsWith(`${RECOVERY_DIRECTORY}/`)
  ) {
    throw new RecoveryInputError()
  }
  const relative = path.relative(RECOVERY_DIRECTORY, value)
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new RecoveryInputError()
  }
  return value
}

function resolveInvocationPaths(root, options) {
  const output = resolvePrivatePath(root, options.output)
  if (options.command === "capture") return { output }
  return { evidence: resolvePrivatePath(root, options.evidence), output }
}

function resolvePrivatePath(root, relative) {
  const absolute = path.resolve(root, relative)
  const boundary = path.resolve(root, RECOVERY_DIRECTORY)
  const fromBoundary = path.relative(boundary, absolute)
  if (fromBoundary === "" || fromBoundary.startsWith("..") || path.isAbsolute(fromBoundary)) {
    throw new RecoveryInputError()
  }
  return Object.freeze({ absolute, relative })
}

async function resolveRepositoryRoot(cwd) {
  let result
  try {
    result = await execFile("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    })
  } catch {
    throw new Error("Recovery repository root is unavailable")
  }
  const root = result.stdout.trim()
  if (
    root.length === 0 ||
    Buffer.byteLength(root, "utf8") > MAX_PATH_BYTES ||
    hasControlCharacters(root) ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root
  ) {
    throw new Error("Recovery repository root is invalid")
  }
  return root
}

async function assertGitIgnored(root, relative) {
  try {
    await execFile("git", ["-C", root, "check-ignore", "--quiet", "--no-index", "--", relative], {
      timeout: 10_000,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    })
  } catch {
    throw new Error("Recovery private path is not ignored")
  }
}

async function assertPrivatePathBoundary(fileSystem, root, target) {
  const operations = fileSystemOperations(fileSystem, ["lstat"])
  const boundary = path.resolve(root, RECOVERY_DIRECTORY)
  const fromBoundary = path.relative(boundary, target.absolute)
  if (
    fromBoundary === "" ||
    fromBoundary.startsWith("..") ||
    path.isAbsolute(fromBoundary) ||
    path.resolve(root, target.relative) !== target.absolute
  ) {
    throw new Error("Recovery private path escaped containment")
  }
  const parent = path.dirname(target.absolute)
  const relativeParent = path.relative(root, parent)
  let current = root
  for (const part of relativeParent.split(path.sep)) {
    if (part.length === 0) continue
    current = path.join(current, part)
    const state = await operations.lstat(current, { bigint: true })
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new Error("Recovery private path parent is unsafe")
    }
  }
}

async function assertUnusedOutput(fileSystem, target) {
  const operations = fileSystemOperations(fileSystem, ["lstat"])
  try {
    await operations.lstat(target)
  } catch (error) {
    if (error?.code === "ENOENT") return
    throw error
  }
  throw new Error("Recovery output already exists")
}

async function readBoundedPrivateFile(fileSystem, target, maximumBytes) {
  const operations = fileSystemOperations(fileSystem, ["lstat", "open"])
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new Error("Recovery no-follow reads are unavailable")
  }
  let handle
  try {
    handle = await operations.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    throw new Error("Recovery evidence is unavailable")
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes) ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("Recovery evidence is not one bounded private file")
    }
    const bytes = Buffer.allocUnsafe(Number(before.size))
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const linked = await operations.lstat(target, { bigint: true })
    if (
      offset !== bytes.byteLength ||
      !sameFileIdentity(before, after) ||
      linked.isSymbolicLink() ||
      !sameFileIdentity(after, linked)
    ) {
      throw new Error("Recovery evidence changed while it was read")
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function reserveExclusiveOutput(runtime, target) {
  const operations = fileSystemOperations(runtime.fileSystem, ["link", "lstat", "open", "unlink"])
  if (!Number.isInteger(fsConstants.O_DIRECTORY) || !Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new Error("Recovery durable output primitives are unavailable")
  }
  await assertUnusedOutput(runtime.fileSystem, target)
  const directory = path.dirname(target)
  const directoryHandle = await operations.open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  )
  let temporaryHandle
  let temporary
  try {
    const directoryIdentity = await directoryHandle.stat({ bigint: true })
    if (!directoryIdentity.isDirectory()) throw new Error("Recovery output directory is invalid")
    await assertDirectoryIdentity(operations, directory, directoryIdentity)
    const identifier = runtime.randomUUID()
    if (typeof identifier !== "string" || !UUID_PATTERN.test(identifier)) {
      throw new Error("Recovery temporary output identity is invalid")
    }
    temporary = path.join(directory, `.${path.basename(target)}.${identifier}.tmp`)
    temporaryHandle = await operations.open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    )

    let settled = false
    return Object.freeze({
      async commit(value, maximumBytes) {
        if (settled) throw new Error("Recovery output reservation is already settled")
        const bytes = normalizeOutputBytes(value, maximumBytes)
        let primaryError = null
        try {
          await assertDirectoryIdentity(operations, directory, directoryIdentity)
          await temporaryHandle.writeFile(bytes)
          await temporaryHandle.sync()
          const identity = await temporaryHandle.stat({ bigint: true })
          if (
            !identity.isFile() ||
            identity.nlink !== 1n ||
            identity.size !== BigInt(bytes.byteLength) ||
            (identity.mode & 0o777n) !== 0o600n
          ) {
            throw new Error("Recovery temporary output was not durably written")
          }
          await temporaryHandle.close()
          temporaryHandle = null
          await assertDirectoryIdentity(operations, directory, directoryIdentity)
          await operations.link(temporary, target)
          const linked = await operations.lstat(target, { bigint: true })
          if (
            linked.isSymbolicLink() ||
            linked.dev !== identity.dev ||
            linked.ino !== identity.ino ||
            linked.size !== identity.size ||
            linked.nlink < 2n
          ) {
            throw new Error("Recovery output link identity is invalid")
          }
          await directoryHandle.sync()
          await operations.unlink(temporary)
          temporary = null
          await directoryHandle.sync()
          const final = await operations.lstat(target, { bigint: true })
          if (
            final.isSymbolicLink() ||
            final.dev !== identity.dev ||
            final.ino !== identity.ino ||
            final.size !== identity.size ||
            final.nlink !== 1n ||
            (final.mode & 0o777n) !== 0o600n
          ) {
            throw new Error("Recovery output final identity is invalid")
          }
          settled = true
          await directoryHandle.close()
        } catch (error) {
          primaryError = error
        }
        if (primaryError !== null) {
          await cleanupReservation().catch(() => {})
          throw primaryError
        }
      },
      async abort() {
        if (settled) return
        await cleanupReservation()
      },
    })

    async function cleanupReservation() {
      settled = true
      await temporaryHandle?.close().catch(() => {})
      temporaryHandle = null
      if (temporary !== null) {
        await operations.unlink(temporary).catch((error) => {
          if (error?.code !== "ENOENT") throw error
        })
        temporary = null
        await directoryHandle.sync()
      }
      await directoryHandle.close()
    }
  } catch (error) {
    await temporaryHandle?.close().catch(() => {})
    if (temporary !== undefined) await operations.unlink(temporary).catch(() => {})
    await directoryHandle.close().catch(() => {})
    throw error
  }
}

function normalizeOutputBytes(value, maximumBytes) {
  if (!(value instanceof Uint8Array)) throw new Error("Recovery output bytes are invalid")
  const bytes = Buffer.from(value)
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
    throw new Error("Recovery output bytes exceed their bound")
  }
  return bytes
}

function canonicalFinalAuthorizationReceiptBytes(value, token) {
  assertDeepFrozenData(value, "Recovery final authorization receipt")
  const receipt = snapshotJson(value)
  validateFinalAuthorizationReceipt(receipt)
  assertCredentialFreeReceipt(receipt, token)
  return normalizeOutputBytes(
    Buffer.from(`${JSON.stringify(canonicalize(receipt))}\n`, "utf8"),
    MAX_RECEIPT_BYTES,
  )
}

function validateFinalAuthorizationReceipt(receipt) {
  assertExactFields(
    receipt,
    [
      "schemaVersion",
      "atomic",
      "concurrencyAcknowledgement",
      "freezeScope",
      "evidenceCapturedAt",
      "appliedAt",
      "candidate",
      "duplicates",
      "finalAuthorization",
    ],
    "Recovery final authorization receipt",
  )
  if (
    receipt.schemaVersion !== 1 ||
    receipt.atomic !== false ||
    !isCanonicalTimestamp(receipt.evidenceCapturedAt) ||
    !isCanonicalTimestamp(receipt.appliedAt) ||
    Date.parse(receipt.appliedAt) < Date.parse(receipt.evidenceCapturedAt)
  ) {
    throw new Error("Recovery final authorization receipt is invalid")
  }
  validateAcknowledgement(receipt.concurrencyAcknowledgement)
  assertExactFields(receipt.freezeScope, ["mode", "releaseIds"], "Recovery freeze scope")
  if (
    receipt.freezeScope.mode !== "operator-freeze-compare-before-write-v1" ||
    !arraysEqual(
      receipt.freezeScope.releaseIds,
      DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates.map(({ releaseId }) => releaseId),
    )
  ) {
    throw new Error("Recovery freeze scope is invalid")
  }
  assertExactFields(
    receipt.candidate,
    ["version", "commitSha", "releaseId"],
    "Recovery receipt candidate",
  )
  if (
    receipt.candidate.version !== DUPLICATE_DRAFT_RECOVERY_POLICY.version ||
    receipt.candidate.commitSha !== DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha ||
    receipt.candidate.releaseId !== DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId
  ) {
    throw new Error("Recovery receipt candidate is invalid")
  }
  if (
    !Array.isArray(receipt.duplicates) ||
    receipt.duplicates.length !== DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates.length
  ) {
    throw new Error("Recovery receipt duplicate results are invalid")
  }
  for (const [index, duplicate] of receipt.duplicates.entries()) {
    const expected = DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates[index]
    if (duplicate?.outcome === "performed") {
      assertExactFields(
        duplicate,
        ["releaseId", "outcome", "preWriteFence", "postWriteFence"],
        "Recovery performed result",
      )
      if (duplicate.releaseId !== expected.releaseId) {
        throw new Error("Recovery performed result identity is invalid")
      }
      validateFence(duplicate.preWriteFence)
      validateFence(duplicate.postWriteFence)
      if (
        Date.parse(duplicate.preWriteFence.observedAt) >
        Date.parse(duplicate.postWriteFence.observedAt)
      ) {
        throw new Error("Recovery performed result timeline is invalid")
      }
      continue
    }
    assertExactFields(
      duplicate,
      ["releaseId", "outcome", "priorFenceObservations", "verifiedAt", "projectionSha256"],
      "Recovery preexisting result",
    )
    if (
      duplicate.releaseId !== expected.releaseId ||
      duplicate.outcome !== "preexisting-quarantined" ||
      duplicate.priorFenceObservations !== null ||
      !isCanonicalTimestamp(duplicate.verifiedAt) ||
      !SHA256_PATTERN.test(duplicate.projectionSha256)
    ) {
      throw new Error("Recovery preexisting result is invalid")
    }
  }
  assertExactFields(
    receipt.finalAuthorization,
    ["state", "disposition", "nextTransition", "conflicts", "diagnostics", "releaseId"],
    "Recovery final observer result",
  )
  if (
    receipt.finalAuthorization.state !== "CANDIDATE_ESCROWED" ||
    receipt.finalAuthorization.disposition !== "would-transition" ||
    receipt.finalAuthorization.nextTransition !== "publish-npm-packages" ||
    !arraysEqual(receipt.finalAuthorization.conflicts, []) ||
    !arraysEqual(receipt.finalAuthorization.diagnostics, []) ||
    receipt.finalAuthorization.releaseId !== DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId
  ) {
    throw new Error("Recovery final observer result is invalid")
  }
}

function validateAcknowledgement(value) {
  assertExactFields(
    value,
    ["acknowledged", "atomic", "mode", "releaseIds"],
    "Recovery concurrency acknowledgement",
  )
  if (
    value.acknowledged !== true ||
    value.atomic !== false ||
    value.mode !== "operator-freeze-compare-before-write-v1" ||
    !arraysEqual(
      value.releaseIds,
      DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates.map(({ releaseId }) => releaseId),
    )
  ) {
    throw new Error("Recovery concurrency acknowledgement is invalid")
  }
}

function validateFence(value) {
  assertExactFields(
    value,
    ["observedAt", "projectionSha256", "tagObjectSha"],
    "Recovery write fence",
  )
  if (
    !isCanonicalTimestamp(value.observedAt) ||
    !SHA256_PATTERN.test(value.projectionSha256) ||
    !SHA_PATTERN.test(value.tagObjectSha)
  ) {
    throw new Error("Recovery write fence is invalid")
  }
}

function assertExactFields(value, fields, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !arraysEqual(Object.keys(value).sort(), [...fields].sort())
  ) {
    throw new Error(`${label} fields are invalid`)
  }
}

function assertDeepFrozenData(value, label, ancestors = new Set()) {
  if (value === null || typeof value !== "object") return
  if (isProxy(value) || ancestors.has(value) || !Object.isFrozen(value)) {
    throw new Error(`${label} is not immutable plain data`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && ![Object.prototype, null].includes(prototype)) {
    throw new Error(`${label} is not immutable plain data`)
  }
  ancestors.add(value)
  if (Array.isArray(value) && Object.keys(value).length !== value.length) {
    throw new Error(`${label} is not immutable plain data`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null
    if (
      typeof key !== "string" ||
      descriptor === null ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new Error(`${label} is not immutable plain data`)
    }
    assertDeepFrozenData(descriptor.value, label, ancestors)
  }
  ancestors.delete(value)
}

function assertCredentialFreeReceipt(value, token) {
  if (typeof value === "string") {
    if (value.includes(token) || /https?:\/\//iu.test(value)) {
      throw new Error("Recovery final authorization receipt contains transport data")
    }
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) assertCredentialFreeReceipt(child, token)
    return
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertCredentialFreeReceipt(key, token)
      assertCredentialFreeReceipt(child, token)
    }
  }
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false
  const milliseconds = Date.parse(value)
  return Number.isSafeInteger(milliseconds) && new Date(milliseconds).toISOString() === value
}

function arraysEqual(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function concurrencyAcknowledgement() {
  const releaseIds = Object.freeze(
    DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates.map(({ releaseId }) => releaseId),
  )
  return Object.freeze({
    acknowledged: true,
    atomic: false,
    mode: "operator-freeze-compare-before-write-v1",
    releaseIds,
  })
}

function createProductionRecoveryObserver({ root, token, reader, environment, fileSystem }) {
  const git = createGitReader({ root })
  const github = createGitHubReader({
    owner: "cacheplane",
    repo: "dawnai",
    repositoryId: "1210070282",
    token,
  })
  const npm = createNpmReader()
  const inventory = createProductionInventoryReader({ root, git })
  const attestations = createCliAttestationVerifier({
    repository: "cacheplane/dawnai",
    token,
    fileSystem,
  })
  if (reader === null || typeof reader !== "object") {
    throw new TypeError("Recovery production reader is invalid")
  }
  // Retain the exact repository environment gate used by the normal release
  // observer without allowing it to supply credentials or candidate identity.
  const repository = environmentDataProperty(environment, "GITHUB_REPOSITORY")
  if (repository !== undefined && repository !== "cacheplane/dawnai") {
    throw new TypeError("Recovery production repository is invalid")
  }
  return async ({ candidate }) => {
    const [managedInventory, markerBytes] = await Promise.all([
      inventory.read({ ref: candidate.commitSha }),
      readBoundedFixture(path.join(root, "scripts/release/controller-schema.json"), {
        root,
        maxBytes: 64 * 1024,
      }),
    ])
    let marker
    try {
      marker = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(markerBytes))
    } catch {
      throw new TypeError("Recovery production controller marker is invalid")
    }
    const observed = await observeProductionCandidate({
      candidate,
      inventory: managedInventory,
      marker,
      git,
      github,
      npm,
      attestations,
    })
    const plan = planRelease({
      candidate,
      observation: observed.observation,
      mode: "controller",
    })
    return Object.freeze({
      state: plan.state,
      disposition: plan.disposition,
      nextTransition: plan.nextTransition,
      conflicts: plan.conflicts,
      diagnostics: observed.diagnostics,
      releaseId: DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId,
    })
  }
}

function environmentToken(environment) {
  const token = environmentDataProperty(environment, "GITHUB_TOKEN")
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 4_096 ||
    hasControlCharacters(token)
  ) {
    throw new Error("Recovery GitHub credential is unavailable")
  }
  return token
}

function environmentDataProperty(environment, name) {
  if (environment === null || typeof environment !== "object") {
    throw new RecoveryInputError()
  }
  const descriptor = Object.getOwnPropertyDescriptor(environment, name)
  if (descriptor === undefined) return undefined
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new Error("Recovery environment is unsafe")
  }
  return descriptor.value
}

function dataProperty(value, name) {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  return descriptor === undefined ? undefined : descriptor.value
}

function fileSystemOperations(fileSystem, methods) {
  if (fileSystem === null || (typeof fileSystem !== "object" && typeof fileSystem !== "function")) {
    throw new RecoveryInputError()
  }
  const output = Object.create(null)
  for (const method of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(fileSystem, method)
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      throw new RecoveryInputError()
    }
    output[method] = descriptor.value.bind(fileSystem)
  }
  return Object.freeze(output)
}

async function assertDirectoryIdentity(operations, directory, expected) {
  const actual = await operations.lstat(directory, { bigint: true })
  if (
    !actual.isDirectory() ||
    actual.isSymbolicLink() ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new Error("Recovery output directory changed during operation")
  }
}

function sameFileIdentity(before, after) {
  return (
    after.isFile() &&
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.size === before.size &&
    after.nlink === before.nlink &&
    after.mtimeNs === before.mtimeNs &&
    after.ctimeNs === before.ctimeNs
  )
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127
  })
}

class RecoveryInputError extends Error {
  constructor() {
    super("Invalid duplicate draft recovery input")
  }
}

const executedPath =
  process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href
if (executedPath === import.meta.url) {
  process.exitCode = await runDuplicateDraftRecoveryCli()
}
