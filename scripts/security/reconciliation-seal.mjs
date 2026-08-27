import { createHash } from "node:crypto"
import { constants as FS_CONSTANTS } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { TextDecoder } from "node:util"

import { canonicalJsonBytes, EvidenceError } from "./github-evidence.mjs"
import { validateReconciliationReceipt } from "./reconciliation-receipt.mjs"
import { decodeReconciliationReceiptGzipBase64 } from "./reconciliation-transport.mjs"

const SHA_PATTERN = /^[0-9a-f]{40}$/u

function fail(code) {
  throw new EvidenceError(code)
}

export async function sealReconciliationReceipt({
  expectedMainSha,
  expectedMergeSha,
  expectedPrNumber,
  expectedRepository,
  expectedReviewedBaseSha,
  expectedReviewedHeadSha,
  outputDirectory,
  outputRoot,
  receiptGzipBase64,
  receiptSha256,
  runAttempt,
  runId,
  writerCheckpoint,
}) {
  if (
    expectedRepository !== "cacheplane/dawnai" ||
    !isSha(expectedMainSha) ||
    !isSha(expectedMergeSha) ||
    !isSha(expectedReviewedBaseSha) ||
    !isSha(expectedReviewedHeadSha) ||
    !Number.isSafeInteger(expectedPrNumber) ||
    expectedPrNumber < 1 ||
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    typeof receiptSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receiptSha256) ||
    !(writerCheckpoint === undefined || typeof writerCheckpoint === "function")
  ) {
    fail("INVALID_RECEIPT_CORRELATION")
  }
  const receiptBytes = decodeReconciliationReceiptGzipBase64(receiptGzipBase64)
  const actualDigest = createHash("sha256").update(receiptBytes).digest("hex")
  if (actualDigest !== receiptSha256) fail("RECEIPT_DIGEST_MISMATCH")
  let parsed
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes)
    parsed = JSON.parse(text)
  } catch {
    fail("INVALID_RECONCILIATION_RECEIPT")
  }
  const receipt = validateReconciliationReceipt(parsed)
  if (!canonicalJsonBytes(receipt).equals(receiptBytes)) {
    fail("NON_CANONICAL_RECONCILIATION_RECEIPT")
  }
  if (
    receipt.repository !== expectedRepository ||
    receipt.observationHead !== expectedMainSha ||
    receipt.pr.mergeSha !== expectedMergeSha ||
    receipt.pr.number !== expectedPrNumber ||
    receipt.pr.reviewedBaseSha !== expectedReviewedBaseSha ||
    receipt.pr.reviewedHeadSha !== expectedReviewedHeadSha
  ) {
    fail("RECEIPT_CORRELATION_MISMATCH")
  }
  const manifest = {
    kind: "dependency-security-receipt-uploader",
    observationHead: expectedMainSha,
    receiptSha256,
    repository: expectedRepository,
    runAttempt,
    runId,
    schemaVersion: 1,
  }
  const paths = await writeContainedReceiptPair({
    manifestBytes: canonicalJsonBytes(manifest),
    outputDirectory,
    outputRoot,
    receiptBytes,
    writerCheckpoint,
  })
  return { manifest, ...paths }
}

async function writeContainedReceiptPair({
  manifestBytes,
  outputDirectory,
  outputRoot,
  receiptBytes,
  writerCheckpoint = async () => {},
}) {
  let rootHandle
  let outputHandle
  let receiptFile
  let manifestFile
  try {
    if (typeof outputDirectory !== "string" || typeof outputRoot !== "string") {
      fail("INVALID_RECEIPT_OUTPUT")
    }
    const resolvedRoot = resolve(outputRoot)
    const resolvedOutput = resolve(outputDirectory)
    const outputName = basename(resolvedOutput)
    if (
      dirname(resolvedOutput) !== resolvedRoot ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(outputName)
    ) {
      fail("INVALID_RECEIPT_OUTPUT")
    }
    const rootStat = await lstat(resolvedRoot)
    const rootPath = await realpath(resolvedRoot)
    const canonicalRootStat = await lstat(rootPath)
    const effectiveUserId = process.geteuid?.()
    if (
      !Number.isSafeInteger(effectiveUserId) ||
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !sameFileIdentity(rootStat, canonicalRootStat) ||
      rootStat.uid !== effectiveUserId ||
      (rootStat.mode & 0o7777) !== 0o700
    ) {
      fail("INVALID_RECEIPT_OUTPUT")
    }
    const ancestorChain = await assertTrustedAncestorChain(rootPath, effectiveUserId)
    const rootFlags =
      FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_DIRECTORY ?? 0) | (FS_CONSTANTS.O_NOFOLLOW ?? 0)
    rootHandle = await open(rootPath, rootFlags)
    const anchoredRootStat = await rootHandle.stat()
    if (
      !anchoredRootStat.isDirectory() ||
      anchoredRootStat.uid !== effectiveUserId ||
      (anchoredRootStat.mode & 0o7777) !== 0o700 ||
      !sameFileIdentity(rootStat, anchoredRootStat)
    ) {
      fail("INVALID_RECEIPT_OUTPUT")
    }
    const outputPath = resolve(rootPath, outputName)
    await writerCheckpoint("beforeMkdir", {
      outputDirectory: outputPath,
      outputRoot: rootPath,
    })
    await assertRootIdentity({
      anchoredRootStat,
      ancestorChain,
      effectiveUserId,
      resolvedRoot,
      rootHandle,
      rootPath,
    })
    await mkdir(outputPath, { mode: 0o700, recursive: false })
    await chmod(outputPath, 0o700)
    const outputFlags =
      FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_DIRECTORY ?? 0) | (FS_CONSTANTS.O_NOFOLLOW ?? 0)
    outputHandle = await open(outputPath, outputFlags)
    const outputStat = await outputHandle.stat()
    const outputPathStat = await lstat(outputPath)
    if (
      !outputStat.isDirectory() ||
      !outputPathStat.isDirectory() ||
      outputPathStat.isSymbolicLink() ||
      outputStat.uid !== effectiveUserId ||
      (outputStat.mode & 0o7777) !== 0o700 ||
      !sameFileIdentity(outputStat, outputPathStat)
    ) {
      fail("INVALID_RECEIPT_OUTPUT")
    }
    await writerCheckpoint("afterMkdir", {
      outputDirectory: outputPath,
      outputRoot: rootPath,
    })
    await assertRootIdentity({
      anchoredRootStat,
      ancestorChain,
      effectiveUserId,
      resolvedRoot,
      rootHandle,
      rootPath,
    })
    await assertEmptyOutputDirectory({
      directory: outputPath,
      directoryHandle: outputHandle,
      directoryIdentity: outputStat,
      effectiveUserId,
    })
    const receiptPath = resolve(outputPath, "dependency-security-reconciliation.json")
    const manifestPath = resolve(outputPath, "uploader-manifest.json")
    receiptFile = await writeExclusiveRegularFile(receiptPath, receiptBytes, effectiveUserId)
    manifestFile = await writeExclusiveRegularFile(manifestPath, manifestBytes, effectiveUserId)
    await writerCheckpoint("beforeClose", {
      outputDirectory: outputPath,
      outputRoot: rootPath,
    })
    await assertRootIdentity({
      anchoredRootStat,
      ancestorChain,
      effectiveUserId,
      resolvedRoot,
      rootHandle,
      rootPath,
    })
    await assertReceiptDirectory({
      directory: outputPath,
      directoryHandle: outputHandle,
      directoryIdentity: outputStat,
      effectiveUserId,
      manifestFile,
      receiptFile,
    })
    await receiptFile.handle.close()
    receiptFile = undefined
    await manifestFile.handle.close()
    manifestFile = undefined
    await outputHandle.close()
    outputHandle = undefined
    await rootHandle.close()
    rootHandle = undefined
    return { manifestPath, receiptPath }
  } catch (error) {
    if (error instanceof EvidenceError) throw error
    fail("INVALID_RECEIPT_OUTPUT")
  } finally {
    await receiptFile?.handle.close().catch(() => {})
    await manifestFile?.handle.close().catch(() => {})
    await outputHandle?.close().catch(() => {})
    await rootHandle?.close().catch(() => {})
  }
}

async function writeExclusiveRegularFile(path, bytes, effectiveUserId) {
  const flags =
    FS_CONSTANTS.O_RDWR |
    FS_CONSTANTS.O_CREAT |
    FS_CONSTANTS.O_EXCL |
    (FS_CONSTANTS.O_NOFOLLOW ?? 0)
  let handle
  try {
    handle = await open(path, flags, 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.uid !== effectiveUserId ||
      (opened.mode & 0o7777) !== 0o600 ||
      opened.size !== bytes.byteLength
    ) {
      fail("INVALID_RECEIPT_OUTPUT")
    }
    await assertFileHandleBytes(handle, bytes)
    const closed = await lstat(path)
    if (
      !closed.isFile() ||
      closed.isSymbolicLink() ||
      closed.nlink !== 1 ||
      closed.uid !== effectiveUserId ||
      (closed.mode & 0o7777) !== 0o600 ||
      closed.dev !== opened.dev ||
      closed.ino !== opened.ino ||
      closed.size !== bytes.byteLength
    ) {
      fail("INVALID_RECEIPT_OUTPUT")
    }
    const anchoredHandle = handle
    handle = undefined
    return { bytes, handle: anchoredHandle, identity: opened, path }
  } catch (error) {
    if (error instanceof EvidenceError) throw error
    fail("INVALID_RECEIPT_OUTPUT")
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function assertFileHandleBytes(handle, expected) {
  const actual = Buffer.alloc(expected.byteLength)
  let offset = 0
  while (offset < actual.byteLength) {
    const { bytesRead } = await handle.read(actual, offset, actual.byteLength - offset, offset)
    if (bytesRead < 1) fail("INVALID_RECEIPT_OUTPUT")
    offset += bytesRead
  }
  const expectedDigest = createHash("sha256").update(expected).digest("hex")
  const actualDigest = createHash("sha256").update(actual).digest("hex")
  if (!actual.equals(expected) || actualDigest !== expectedDigest) fail("INVALID_RECEIPT_OUTPUT")
}

async function assertRootIdentity({
  anchoredRootStat,
  ancestorChain,
  effectiveUserId,
  resolvedRoot,
  rootHandle,
  rootPath,
}) {
  const [requested, canonical, anchored, currentRootPath] = await Promise.all([
    lstat(resolvedRoot),
    lstat(rootPath),
    rootHandle.stat(),
    realpath(resolvedRoot),
  ])
  if (
    currentRootPath !== rootPath ||
    !requested.isDirectory() ||
    requested.isSymbolicLink() ||
    !canonical.isDirectory() ||
    canonical.isSymbolicLink() ||
    !anchored.isDirectory() ||
    requested.uid !== effectiveUserId ||
    canonical.uid !== effectiveUserId ||
    anchored.uid !== effectiveUserId ||
    (requested.mode & 0o7777) !== 0o700 ||
    (canonical.mode & 0o7777) !== 0o700 ||
    (anchored.mode & 0o7777) !== 0o700 ||
    !sameFileIdentity(requested, anchoredRootStat) ||
    !sameFileIdentity(canonical, anchoredRootStat) ||
    !sameFileIdentity(anchored, anchoredRootStat)
  ) {
    fail("INVALID_RECEIPT_OUTPUT")
  }
  const currentAncestorChain = await assertTrustedAncestorChain(rootPath, effectiveUserId)
  if (
    currentAncestorChain.length !== ancestorChain.length ||
    currentAncestorChain.some(
      (entry, index) =>
        entry.path !== ancestorChain[index]?.path ||
        !sameFileIdentity(entry.identity, ancestorChain[index]?.identity),
    )
  ) {
    fail("INVALID_RECEIPT_OUTPUT")
  }
}

async function assertTrustedAncestorChain(rootPath, effectiveUserId) {
  const chain = []
  let protectedChild = await lstat(rootPath)
  let ancestor = dirname(rootPath)
  while (true) {
    const current = await lstat(ancestor)
    if (!current.isDirectory() || current.isSymbolicLink()) fail("INVALID_RECEIPT_OUTPUT")
    validateTrustedAncestorPolicy(current.mode, current.uid, protectedChild.uid, effectiveUserId)
    chain.push({ identity: current, path: ancestor })
    const parent = dirname(ancestor)
    if (parent === ancestor) return chain
    protectedChild = current
    ancestor = parent
  }
}

export function validateTrustedAncestorPolicy(
  ancestorMode,
  ancestorUid,
  protectedChildUid,
  effectiveUserId,
) {
  if (
    ![ancestorMode, ancestorUid, protectedChildUid, effectiveUserId].every(Number.isSafeInteger) ||
    ![0, effectiveUserId].includes(ancestorUid) ||
    ((ancestorMode & 0o022) !== 0 &&
      ((ancestorMode & 0o1000) === 0 || protectedChildUid !== effectiveUserId))
  ) {
    fail("INVALID_RECEIPT_OUTPUT")
  }
  return true
}

async function assertEmptyOutputDirectory({
  directory,
  directoryHandle,
  directoryIdentity,
  effectiveUserId,
}) {
  const [current, anchored, entries] = await Promise.all([
    lstat(directory),
    directoryHandle.stat(),
    readdir(directory),
  ])
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !anchored.isDirectory() ||
    current.uid !== effectiveUserId ||
    anchored.uid !== effectiveUserId ||
    (current.mode & 0o7777) !== 0o700 ||
    (anchored.mode & 0o7777) !== 0o700 ||
    !sameFileIdentity(current, directoryIdentity) ||
    !sameFileIdentity(anchored, directoryIdentity) ||
    entries.length !== 0
  ) {
    fail("INVALID_RECEIPT_OUTPUT")
  }
}

async function assertReceiptDirectory({
  directory,
  directoryHandle,
  directoryIdentity,
  effectiveUserId,
  manifestFile,
  receiptFile,
}) {
  const [currentDirectory, anchoredDirectory] = await Promise.all([
    lstat(directory),
    directoryHandle.stat(),
  ])
  if (
    !currentDirectory.isDirectory() ||
    currentDirectory.isSymbolicLink() ||
    !anchoredDirectory.isDirectory() ||
    currentDirectory.uid !== effectiveUserId ||
    anchoredDirectory.uid !== effectiveUserId ||
    (currentDirectory.mode & 0o7777) !== 0o700 ||
    (anchoredDirectory.mode & 0o7777) !== 0o700 ||
    !sameFileIdentity(currentDirectory, directoryIdentity) ||
    !sameFileIdentity(anchoredDirectory, directoryIdentity)
  ) {
    fail("INVALID_RECEIPT_OUTPUT")
  }
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => compareText(left.name, right.name))
  if (
    entries.length !== 2 ||
    entries[0]?.name !== "dependency-security-reconciliation.json" ||
    entries[1]?.name !== "uploader-manifest.json" ||
    entries.some((entry) => !entry.isFile())
  ) {
    fail("INVALID_RECEIPT_OUTPUT")
  }
  for (const file of [receiptFile, manifestFile]) {
    const [current, anchored] = await Promise.all([lstat(file.path), file.handle.stat()])
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !anchored.isFile() ||
      current.nlink !== 1 ||
      anchored.nlink !== 1 ||
      current.uid !== effectiveUserId ||
      anchored.uid !== effectiveUserId ||
      (current.mode & 0o7777) !== 0o600 ||
      (anchored.mode & 0o7777) !== 0o600 ||
      current.size !== file.bytes.byteLength ||
      anchored.size !== file.bytes.byteLength ||
      !sameFileIdentity(current, file.identity) ||
      !sameFileIdentity(anchored, file.identity)
    ) {
      fail("INVALID_RECEIPT_OUTPUT")
    }
    await assertFileHandleBytes(file.handle, file.bytes)
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function isSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value)
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
