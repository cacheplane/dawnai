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
  assertDuplicateDraftRecoveryReader,
  DUPLICATE_DRAFT_RECOVERY_POLICY,
  applyDuplicateDraftRecovery as defaultApplyDuplicateDraftRecovery,
  canonicalDuplicateDraftEvidence as defaultCanonicalDuplicateDraftEvidence,
  captureDuplicateDraftRecoveryEvidence as defaultCaptureDuplicateDraftRecoveryEvidence,
  parseDuplicateDraftEvidence as defaultParseDuplicateDraftEvidence,
  normalizeDuplicateDraftReleaseProjection,
} from "./duplicate-draft-recovery.mjs"
import {
  createDuplicateDraftRecoveryReader as defaultCreateDuplicateDraftRecoveryReader,
  createDuplicateDraftRecoveryWriter as defaultCreateDuplicateDraftRecoveryWriter,
} from "./duplicate-draft-recovery-adapters.mjs"
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
  "createNormalProductionRecoveryObserver",
  "createProductionRecoveryObserver",
  "fileSystem",
  "parseDuplicateDraftEvidence",
  "randomUUID",
  "resolveRepositoryRoot",
  "runGit",
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
    const root = await runtime.resolveRepositoryRoot(runtime.cwd, runtime.runGit)
    const paths = resolveInvocationPaths(root, options)
    await assertPrivatePathBoundary(runtime.fileSystem, root, paths.output)

    if (options.command === "capture") {
      await assertReviewedIgnorePolicy({
        fileSystem: runtime.fileSystem,
        root,
        reviewedCommit: options.reviewedCommit,
        relativePaths: [paths.output.relative],
        runGit: runtime.runGit,
      })
      await assertUnusedOutput(runtime.fileSystem, paths.output.absolute)
      outputReservation = await reserveExclusiveOutput(runtime, paths.output.absolute)
      const token = environmentToken(runtime.environment)
      const reader = runtime.createDuplicateDraftRecoveryReader({
        root,
        token,
        run: runtime.runGit,
      })
      const evidence = await runtime.captureDuplicateDraftRecoveryEvidence({
        reviewedCommit: options.reviewedCommit,
        reader,
      })
      const bytes = runtime.canonicalDuplicateDraftEvidence(evidence)
      assertCredentialFreeEvidence(bytes, token)
      await assertPrivatePathBoundary(runtime.fileSystem, root, paths.output)
      await assertReviewedIgnorePolicy({
        fileSystem: runtime.fileSystem,
        root,
        reviewedCommit: options.reviewedCommit,
        relativePaths: [paths.output.relative],
        runGit: runtime.runGit,
      })
      await outputReservation.commit(bytes, MAX_EVIDENCE_BYTES)
      outputReservation = null
      writeSuccessBestEffort(runtime.stdout, "Duplicate draft recovery evidence captured.\n")
      return 0
    }

    await assertPrivatePathBoundary(runtime.fileSystem, root, paths.evidence)
    await assertReviewedIgnorePolicy({
      fileSystem: runtime.fileSystem,
      root,
      reviewedCommit: "HEAD",
      relativePaths: [paths.evidence.relative, paths.output.relative],
      runGit: runtime.runGit,
    })
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
    const reviewedCommit = evidence?.reviewedAuthority?.mergeCommitSha
    if (typeof reviewedCommit !== "string" || !SHA_PATTERN.test(reviewedCommit)) {
      throw new Error("Recovery reviewed authority is invalid")
    }

    await assertPrivatePathBoundary(runtime.fileSystem, root, paths.output)
    await assertReviewedIgnorePolicy({
      fileSystem: runtime.fileSystem,
      root,
      reviewedCommit,
      relativePaths: [paths.evidence.relative, paths.output.relative],
      runGit: runtime.runGit,
    })
    outputReservation = await reserveExclusiveOutput(runtime, paths.output.absolute)

    const token = environmentToken(runtime.environment)
    const reader = runtime.createDuplicateDraftRecoveryReader({
      root,
      token,
      run: runtime.runGit,
    })
    const observer = runtime.createProductionRecoveryObserver({
      root,
      token,
      reader,
      environment: runtime.environment,
      fileSystem: runtime.fileSystem,
      runGit: runtime.runGit,
      // The reviewed merge commit is the exact tree this recovery was authorized against.
      terminalRecordRef: reviewedCommit,
      createNormalObserver: runtime.createNormalProductionRecoveryObserver,
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
    await assertReviewedIgnorePolicy({
      fileSystem: runtime.fileSystem,
      root,
      reviewedCommit,
      relativePaths: [paths.evidence.relative, paths.output.relative],
      runGit: runtime.runGit,
    })
    await outputReservation.commit(receiptBytes, MAX_RECEIPT_BYTES)
    outputReservation = null
    writeSuccessBestEffort(runtime.stdout, "Duplicate draft recovery authorization recorded.\n")
    return 0
  } catch (error) {
    let cleanupUncertain = error instanceof RecoveryOutputCleanupUncertainError
    if (outputReservation !== null) {
      try {
        await outputReservation.abort()
      } catch (cleanupError) {
        if (cleanupError instanceof RecoveryOutputCleanupUncertainError) {
          cleanupUncertain = true
        }
      }
    }
    const input = error instanceof RecoveryInputError
    try {
      stderr.write(
        cleanupUncertain
          ? "Duplicate draft recovery output cleanup uncertain.\n"
          : input
            ? "Invalid duplicate draft recovery input.\n"
            : `Duplicate draft recovery failed.${diagnosticCodeSuffix(error)}\n`,
      )
    } catch {}
    return cleanupUncertain ? 3 : input ? 2 : 1
  }
}

/**
 * Surface a failure's stable code so an operator holding an edit freeze can tell
 * "evidence expired, recapture" from "the PATCH may have landed" without
 * instrumenting the module. Recovery codes are built from static operation
 * names, never from remote data; anything not matching that exact shape is
 * withheld rather than risk echoing a response body.
 */
const RECOVERY_ERROR_NAMES = new Set([
  "DuplicateDraftRecoveryCaptureError",
  "DuplicateDraftRecoveryReadError",
  "DuplicateDraftRecoveryWriteError",
])

function diagnosticCodeSuffix(error) {
  // Only Dawn's own recovery errors qualify. A Node errno such as EIO carries a
  // `code` too, and echoing arbitrary error codes would widen this surface
  // beyond the curated recovery constants.
  const name = Object.getOwnPropertyDescriptor(error ?? {}, "name")?.value ?? error?.name
  if (!RECOVERY_ERROR_NAMES.has(name)) return ""
  const code = Object.getOwnPropertyDescriptor(error ?? {}, "code")?.value
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/u.test(code) ? ` (code: ${code})` : ""
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
  const runGit = createScrubbedGitRunner(dependency("runGit", defaultGitExecutor))
  return Object.freeze({
    cwd,
    environment,
    stdout,
    stderr,
    fileSystem: dependency("fileSystem", defaultFileSystem),
    randomUUID: dependency("randomUUID", defaultRandomUUID),
    runGit,
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
    createNormalProductionRecoveryObserver: dependency(
      "createNormalProductionRecoveryObserver",
      createNormalProductionRecoveryObserver,
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

async function resolveRepositoryRoot(cwd, runGit) {
  let output
  try {
    output = await runGit("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    })
  } catch {
    throw new Error("Recovery repository root is unavailable")
  }
  const root = output.trim()
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

async function assertReviewedIgnorePolicy({
  fileSystem,
  root,
  reviewedCommit,
  relativePaths,
  runGit,
}) {
  if (
    !(reviewedCommit === "HEAD" || SHA_PATTERN.test(reviewedCommit)) ||
    !Array.isArray(relativePaths) ||
    relativePaths.length < 1
  ) {
    throw new Error("Recovery ignore authority is invalid")
  }
  let reviewedText
  try {
    reviewedText = await runGit("git", ["-C", root, "show", `${reviewedCommit}:.gitignore`], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    })
  } catch {
    throw new Error("Recovery reviewed gitignore is unavailable")
  }
  const currentBytes = await readBoundedPrivateFile(
    fileSystem,
    path.join(root, ".gitignore"),
    64 * 1024,
    { requirePrivateMode: false },
  )
  const currentText = new TextDecoder("utf-8", { fatal: true }).decode(currentBytes)
  if (currentText !== reviewedText || !hasReviewedRecoveryIgnoreRule(reviewedText)) {
    throw new Error("Recovery reviewed gitignore rule is absent or changed")
  }
  for (const relative of relativePaths) {
    try {
      await runGit("git", ["-C", root, "check-ignore", "--quiet", "--no-index", "--", relative], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
      })
    } catch {
      throw new Error("Recovery private path is not ignored by reviewed policy")
    }
  }
}

function hasReviewedRecoveryIgnoreRule(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 64 * 1024) return false
  const accepted = new Set([
    ".dawn/",
    "/.dawn/",
    ".dawn/release-recovery/",
    "/.dawn/release-recovery/",
  ])
  return source.split(/\r?\n/u).some((line) => accepted.has(line))
}

function createScrubbedGitRunner(executor) {
  if (typeof executor !== "function") throw new RecoveryInputError()
  const policy = recoveryGitExecutionPolicy()
  const safeEnvironment = safeGitEnvironment()
  return (command, args, options = {}) => {
    if (command !== "git" || !Array.isArray(args)) {
      throw new Error("Recovery Git invocation is invalid")
    }
    return executor(
      policy.executable,
      [
        "-c",
        `core.excludesFile=${policy.nullDevice}`,
        "-c",
        "credential.helper=",
        "--no-pager",
        ...args,
      ],
      {
        ...options,
        shell: false,
        env: { ...safeEnvironment },
        windowsHide: true,
      },
    )
  }
}

export function recoveryGitExecutionPolicy(platform = process.platform) {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("Recovery trusted Git execution is unavailable on this platform")
  }
  return Object.freeze({ executable: "/usr/bin/git", nullDevice: "/dev/null" })
}

function safeGitEnvironment() {
  const descriptor = Object.getOwnPropertyDescriptor(process.env, "PATH")
  const executablePath = descriptor?.value
  if (
    typeof executablePath !== "string" ||
    executablePath.length === 0 ||
    hasControlCharacters(executablePath)
  ) {
    throw new Error("Recovery executable path is invalid")
  }
  return Object.freeze({
    PATH: executablePath,
    HOME: "/nonexistent",
    XDG_CONFIG_HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    GCM_INTERACTIVE: "never",
  })
}

function defaultGitExecutor(command, args, options) {
  return execFile(command, args, options).then(({ stdout }) => stdout)
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
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null
  let current = root
  for (const part of ["", ...relativeParent.split(path.sep)]) {
    if (part.length > 0) current = path.join(current, part)
    const state = await operations.lstat(current, { bigint: true })
    const mode = state.mode & 0o777n
    if (
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      (currentUid !== null && state.uid !== currentUid) ||
      (mode & 0o022n) !== 0n ||
      (current === boundary && mode !== 0o700n)
    ) {
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

async function readBoundedPrivateFile(
  fileSystem,
  target,
  maximumBytes,
  { requirePrivateMode = true } = {},
) {
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
      (requirePrivateMode && (before.mode & 0o077n) !== 0n) ||
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
  let directoryIdentity = null
  let temporaryHandle = null
  let temporary = null
  let temporaryIdentity = null
  let temporaryCreationAttempted = false
  let temporaryOpenCompleted = false
  let temporaryPathCollision = false
  try {
    directoryIdentity = await directoryHandle.stat({ bigint: true })
    if (!directoryIdentity.isDirectory()) throw new Error("Recovery output directory is invalid")
    await assertDirectoryIdentity(operations, directory, directoryIdentity)
    // Prove directory fsync works before any production mutation is possible.
    await directoryHandle.sync()
    const identifier = runtime.randomUUID()
    if (typeof identifier !== "string" || !UUID_PATTERN.test(identifier)) {
      throw new Error("Recovery temporary output identity is invalid")
    }
    temporary = path.join(directory, `.${path.basename(target)}.${identifier}.tmp`)
    temporaryCreationAttempted = true
    temporaryHandle = await operations.open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    )
    temporaryOpenCompleted = true
    temporaryIdentity = await temporaryHandle.stat({ bigint: true })
    assertReservedTemporaryIdentity(temporaryIdentity)

    let settled = false
    let publicationAttempted = false
    let targetPublished = false
    let publishedIdentity = null
    return Object.freeze({
      async commit(value, maximumBytes) {
        if (settled) throw new Error("Recovery output reservation is already settled")
        const bytes = normalizeOutputBytes(value, maximumBytes)
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
        publicationAttempted = true
        publishedIdentity = identity
        await operations.link(temporary, target)
        targetPublished = true
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
        await directoryHandle.sync()
        temporary = null
        temporaryCreationAttempted = false
        temporaryIdentity = null
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
        await directoryHandle.close()
        settled = true
      },
      async abort() {
        if (settled) return
        const cleanupFailures = []
        let handleCloseFailure = null
        if (temporaryHandle !== null) {
          handleCloseFailure = await closeHandleWithRetries(temporaryHandle)
          if (handleCloseFailure === null) temporaryHandle = null
        }
        let cleanupComplete = false
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await cleanupReservationFiles()
            cleanupComplete = true
            cleanupFailures.length = 0
            break
          } catch (error) {
            cleanupFailures.push(error)
          }
        }
        const directoryCloseFailure = await closeHandleWithRetries(directoryHandle)
        if (!cleanupComplete || publicationAttempted || targetPublished || temporary !== null) {
          throw new RecoveryOutputCleanupUncertainError(cleanupFailures)
        }
        settled = true
        const closeFailures = [handleCloseFailure, directoryCloseFailure].filter(
          (failure) => failure !== null,
        )
        if (closeFailures.length > 0) {
          throw new AggregateError(closeFailures, "Recovery output handle cleanup failed")
        }
      },
    })

    async function cleanupReservationFiles() {
      if (settled) return
      if (publicationAttempted) {
        let targetState = null
        try {
          targetState = await operations.lstat(target, { bigint: true })
        } catch (error) {
          if (error?.code !== "ENOENT") throw error
        }
        if (targetState !== null) {
          if (
            publishedIdentity === null ||
            targetState.isSymbolicLink() ||
            targetState.dev !== publishedIdentity.dev ||
            targetState.ino !== publishedIdentity.ino
          ) {
            throw new Error("Recovery published output identity is uncertain")
          }
          await operations.unlink(target)
        }
      }
      if (temporary !== null) {
        const state = await optionalLstat(operations, temporary)
        if (state !== null) {
          if (
            temporaryIdentity === null ||
            state.isSymbolicLink() ||
            !sameDeviceAndInode(state, temporaryIdentity)
          ) {
            throw new Error("Recovery temporary output identity is uncertain")
          }
          await operations.unlink(temporary)
        }
      }
      await proveOutputPathsAbsent({ directoryHandle, operations, target, temporary })
      publicationAttempted = false
      targetPublished = false
      publishedIdentity = null
      temporary = null
      temporaryCreationAttempted = false
      temporaryIdentity = null
    }
  } catch (error) {
    temporaryPathCollision =
      temporaryCreationAttempted && !temporaryOpenCompleted && error?.code === "EEXIST"
    const handleCloseFailure =
      temporaryHandle === null ? null : await closeHandleWithRetries(temporaryHandle)
    if (handleCloseFailure === null) temporaryHandle = null
    const cleanupFailures = []
    let cleanupComplete = false
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await cleanupReservationSetupFiles()
        cleanupComplete = true
        cleanupFailures.length = 0
        break
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError)
      }
    }
    const directoryCloseFailure = await closeHandleWithRetries(directoryHandle)
    if (!cleanupComplete || temporary !== null) {
      throw new RecoveryOutputCleanupUncertainError(cleanupFailures)
    }
    const closeFailures = [handleCloseFailure, directoryCloseFailure].filter(
      (failure) => failure !== null,
    )
    if (closeFailures.length > 0) {
      throw new AggregateError(
        [error, ...closeFailures],
        "Recovery output setup handle cleanup failed",
      )
    }
    throw error
  }

  async function cleanupReservationSetupFiles() {
    if (temporaryCreationAttempted && temporary !== null) {
      const state = await optionalLstat(operations, temporary)
      if (state !== null) {
        if (temporaryPathCollision) {
          throw new Error("Recovery temporary output path is already occupied")
        }
        if (temporaryIdentity !== null) {
          if (state.isSymbolicLink() || !sameDeviceAndInode(state, temporaryIdentity)) {
            throw new Error("Recovery setup temporary identity is uncertain")
          }
        } else {
          assertAmbiguousSetupTemporaryIdentity(state)
        }
        await operations.unlink(temporary)
      }
    }
    await proveOutputPathsAbsent({ directoryHandle, operations, target, temporary })
    temporary = null
    temporaryCreationAttempted = false
    temporaryPathCollision = false
    temporaryIdentity = null
  }
}

function assertReservedTemporaryIdentity(identity) {
  if (
    !identity.isFile() ||
    identity.isSymbolicLink() ||
    identity.nlink !== 1n ||
    identity.size !== 0n ||
    (identity.mode & 0o777n) !== 0o600n
  ) {
    throw new Error("Recovery temporary output reservation is unsafe")
  }
}

function assertAmbiguousSetupTemporaryIdentity(identity) {
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null
  if (
    !identity.isFile() ||
    identity.isSymbolicLink() ||
    identity.nlink !== 1n ||
    identity.size !== 0n ||
    (identity.mode & 0o777n) !== 0o600n ||
    (currentUid !== null && identity.uid !== currentUid)
  ) {
    throw new Error("Recovery ambiguous setup temporary identity is unsafe")
  }
}

async function proveOutputPathsAbsent({ directoryHandle, operations, target, temporary }) {
  await directoryHandle.sync()
  await assertPathAbsent(operations, target)
  if (temporary !== null) await assertPathAbsent(operations, temporary)
  await directoryHandle.sync()
  await assertPathAbsent(operations, target)
  if (temporary !== null) await assertPathAbsent(operations, temporary)
}

async function assertPathAbsent(operations, target) {
  if ((await optionalLstat(operations, target)) !== null) {
    throw new Error("Recovery output path absence is uncertain")
  }
}

async function optionalLstat(operations, target) {
  try {
    return await operations.lstat(target, { bigint: true })
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function closeHandleWithRetries(handle) {
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await handle.close()
      return null
    } catch (error) {
      lastError = error
    }
  }
  return lastError
}

function sameDeviceAndInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino
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

// Capture evidence legitimately carries the canonical Release body, which contains
// GitHub URLs, so it cannot use the receipt's stricter transport rule. The design
// still requires credential-free facts, so enforce that explicitly on the exact
// bytes about to be published rather than relying on the read path's scrubbing.
function assertCredentialFreeEvidence(bytes, token) {
  if (!Buffer.isBuffer(bytes)) throw new Error("Recovery evidence bytes are invalid")
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Recovery GitHub credential is unavailable")
  }
  if (bytes.toString("utf8").includes(token)) {
    throw new Error("Recovery evidence contains transport data")
  }
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

export function createProductionRecoveryObserver({
  root,
  token,
  reader,
  environment,
  fileSystem,
  runGit,
  terminalRecordRef,
  createNormalObserver = createNormalProductionRecoveryObserver,
}) {
  assertDuplicateDraftRecoveryReader(reader)
  if (typeof terminalRecordRef !== "string" || terminalRecordRef.length === 0) {
    throw new TypeError("Recovery terminal record ref is invalid")
  }
  // Retain the exact repository environment gate used by the normal release
  // observer without allowing it to supply credentials or candidate identity.
  const repository = environmentDataProperty(environment, "GITHUB_REPOSITORY")
  if (repository !== undefined && repository !== "cacheplane/dawnai") {
    throw new TypeError("Recovery production repository is invalid")
  }
  if (typeof createNormalObserver !== "function") {
    throw new TypeError("Recovery normal observer factory is invalid")
  }
  const normalObserver = createNormalObserver({
    root,
    token,
    fileSystem,
    runGit,
    terminalRecordRef,
  })
  if (typeof normalObserver !== "function") {
    throw new TypeError("Recovery normal observer is invalid")
  }
  return async ({ candidate }) => {
    assertRecoveryObserverCandidate(candidate)
    const before = await readRecoveryObserverBinding(reader, candidate)
    const normal = snapshotJson(await normalObserver({ candidate }))
    assertExactFields(
      normal,
      ["state", "disposition", "nextTransition", "conflicts", "diagnostics"],
      "Recovery normal observer result",
    )
    const after = await readRecoveryObserverBinding(reader, candidate)
    if (!sameCanonicalData(before, after)) {
      throw new Error("Recovery production Release binding drifted during final authorization")
    }
    return Object.freeze({
      state: normal.state,
      disposition: normal.disposition,
      nextTransition: normal.nextTransition,
      conflicts: Object.freeze([...normal.conflicts]),
      diagnostics: Object.freeze([...normal.diagnostics]),
      releaseId: after.releaseId,
    })
  }
}

/**
 * Build the controller's exact candidate shape. `observeProductionCandidate`
 * and `planRelease` require identity PLUS the CI/publisher policy fields, with
 * no extra keys — passing bare identity throws "Release candidate is invalid"
 * only at run time, after both duplicates have already been quarantined.
 * Mirrors CANDIDATE_POLICY (candidate.mjs) and DEFAULT_CANDIDATE_POLICY
 * (observe.mjs).
 */
export function productionRecoveryCandidate(candidate) {
  assertRecoveryObserverCandidate(candidate)
  return Object.freeze({
    version: candidate.version,
    commitSha: candidate.commitSha,
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  })
}

export function createNormalProductionRecoveryObserver({
  root,
  token,
  fileSystem,
  runGit,
  terminalRecordRef,
}) {
  if (typeof terminalRecordRef !== "string" || terminalRecordRef.length === 0) {
    throw new TypeError("Recovery terminal record ref is invalid")
  }
  const git = createGitReader({ root, run: runGit })
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
  return async ({ candidate }) => {
    const productionCandidate = productionRecoveryCandidate(candidate)
    const [managedInventory, marker] = await Promise.all([
      inventory.read({ ref: candidate.commitSha }),
      readCandidateControllerMarker({ git, candidate }),
    ])
    const observed = await observeProductionCandidate({
      candidate: productionCandidate,
      inventory: managedInventory,
      marker,
      git,
      github,
      npm,
      attestations,
      terminalRecordRef,
    })
    const plan = planRelease({
      candidate: productionCandidate,
      observation: observed.observation,
      mode: "controller",
    })
    return {
      state: plan.state,
      disposition: plan.disposition,
      nextTransition: plan.nextTransition,
      conflicts: plan.conflicts,
      diagnostics: observed.diagnostics,
    }
  }
}

function assertRecoveryObserverCandidate(candidate) {
  assertExactFields(candidate, ["version", "commitSha"], "Recovery observer candidate")
  if (
    candidate.version !== DUPLICATE_DRAFT_RECOVERY_POLICY.version ||
    candidate.commitSha !== DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha
  ) {
    throw new Error("Recovery observer candidate identity is not exact")
  }
}

async function readRecoveryObserverBinding(reader, candidate) {
  const inventory = snapshotJson(await reader.listCandidateReleases())
  if (!Array.isArray(inventory) || inventory.length !== 3) {
    throw new Error("Recovery production candidate inventory is not exact")
  }
  const expected = [
    ...DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates,
    {
      releaseId: DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId,
      tagName: "untagged-be0ff4bee4ba43b521a9",
    },
  ].sort((left, right) => left.releaseId - right.releaseId)
  inventory.sort((left, right) => left?.releaseId - right?.releaseId)
  let canonicalSummary = null
  for (const [index, release] of inventory.entries()) {
    assertExactFields(
      release,
      [
        "releaseId",
        "tagName",
        "title",
        "draft",
        "prerelease",
        "immutable",
        "targetCommitish",
        "marker",
      ],
      "Recovery production candidate Release",
    )
    if (
      release.releaseId !== expected[index].releaseId ||
      release.tagName !== expected[index].tagName ||
      release.title !== `Dawn v${candidate.version}` ||
      release.draft !== true ||
      release.prerelease !== false ||
      release.immutable !== false ||
      release.targetCommitish !== "main"
    ) {
      throw new Error("Recovery production candidate Release identity is not exact")
    }
    if (release.releaseId === DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId) {
      if (!isExactRecoveryCandidateMarker(release.marker, candidate)) {
        throw new Error("Recovery production canonical Release marker is not exact")
      }
      canonicalSummary = release
    } else if (release.marker !== null) {
      throw new Error("Recovery production duplicate Release remains controller-visible")
    }
  }
  if (canonicalSummary === null) {
    throw new Error("Recovery production canonical Release identity is unavailable")
  }
  const snapshot = snapshotJson(
    await reader.readReleaseSnapshot(DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId),
  )
  assertExactFields(
    snapshot,
    [
      "releaseId",
      "tagName",
      "title",
      "targetCommitish",
      "draft",
      "prerelease",
      "immutable",
      "body",
      "marker",
      "assets",
    ],
    "Recovery production canonical Release snapshot",
  )
  const projection = normalizeDuplicateDraftReleaseProjection(snapshot)
  if (
    projection.releaseId !== canonicalSummary.releaseId ||
    projection.tagName !== canonicalSummary.tagName ||
    projection.title !== canonicalSummary.title ||
    projection.targetCommitish !== canonicalSummary.targetCommitish ||
    projection.draft !== canonicalSummary.draft ||
    projection.prerelease !== canonicalSummary.prerelease ||
    projection.immutable !== canonicalSummary.immutable ||
    !sameCanonicalData(snapshot.marker, canonicalSummary.marker)
  ) {
    throw new Error("Recovery production canonical Release identity is not exact")
  }
  return {
    releaseId: projection.releaseId,
    inventory,
    projection,
    marker: snapshot.marker,
  }
}

function isExactRecoveryCandidateMarker(value, candidate) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.version === candidate.version &&
    value.commitSha === candidate.commitSha &&
    value.tag === `v${candidate.version}`
  )
}

function sameCanonicalData(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
}

export async function readCandidateControllerMarker({ git, candidate }) {
  if (
    git === null ||
    typeof git?.showFile !== "function" ||
    candidate === null ||
    typeof candidate !== "object" ||
    !SHA_PATTERN.test(candidate.commitSha)
  ) {
    throw new TypeError("Recovery production controller marker authority is invalid")
  }
  const source = await git.showFile({
    ref: candidate.commitSha,
    path: "scripts/release/controller-schema.json",
  })
  if (typeof source !== "string") {
    throw new TypeError("Recovery production controller marker is invalid")
  }
  const bytes = Buffer.from(source, "utf8")
  if (bytes.byteLength < 1 || bytes.byteLength > 64 * 1024) {
    throw new TypeError("Recovery production controller marker is outside bounds")
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new TypeError("Recovery production controller marker is invalid")
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

function writeSuccessBestEffort(stream, message) {
  let cleanupScheduled = false
  const removeErrorListener = () => {
    if (typeof stream.removeListener === "function") stream.removeListener("error", onError)
  }
  const scheduleCleanup = () => {
    if (cleanupScheduled) return
    cleanupScheduled = true
    setImmediate(removeErrorListener)
  }
  const onError = () => {
    removeErrorListener()
  }
  try {
    if (typeof stream.once === "function" && typeof stream.removeListener === "function") {
      stream.once("error", onError)
    }
    const result = stream.write(message, scheduleCleanup)
    if (result !== null && typeof result === "object" && typeof result.then === "function") {
      void result.then(scheduleCleanup, scheduleCleanup)
    }
    scheduleCleanup()
  } catch {
    scheduleCleanup()
  }
}

class RecoveryOutputCleanupUncertainError extends Error {
  constructor(errors = []) {
    super("Recovery output cleanup is uncertain")
    this.name = "RecoveryOutputCleanupUncertainError"
    this.errors = errors
  }
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
