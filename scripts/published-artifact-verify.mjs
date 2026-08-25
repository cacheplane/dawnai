#!/usr/bin/env node

import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  assertCleanDependencySpecs,
  expectedFilesForPackage,
  makeTempDir,
  normalizeCliArgs,
  npmView,
  PUBLISHED_RELEASE_WORKFLOW,
  readBoundedRegularFile,
  readPublicPackages,
  removeDir,
  resolvePackageSet,
  resolveRequestedVersion,
  run,
  validateExactPublishedPackageEvidence,
  validatePackageMetadata,
  validatePublishedWaitOptions,
  waitForPublishedVersions,
} from "./lib/published-artifacts.mjs"
import { createNpmReader } from "./release/adapters/npm.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "./release/limits.mjs"
import { canonicalManifestBytes, parseSealedReleaseManifest } from "./release/manifest.mjs"
import {
  canonicalSmokeResultBytes,
  formatSmokeError,
  writeCanonicalSmokeResult,
} from "./release/smoke-result.mjs"

const DEFAULT_WAIT_DELAY_MS = 10_000

async function main() {
  try {
    const options = parsePublishedArtifactVerifyArgs(normalizeCliArgs(process.argv.slice(2)))
    const { failures, packageNames } = await runPublishedArtifactVerify(options)

    if (failures.length > 0 && options.releaseMode) {
      console.error(
        `META FAIL ${failures.length} of ${packageNames.length} package(s) failed for exact candidate ${options.version}`,
      )
      process.exitCode = 1
    } else if (failures.length > 0) {
      console.error(
        `META FAIL ${failures.length} of ${packageNames.length} package(s) failed for ${options.version} in package set ${options.packageSet}`,
      )
      process.exitCode = 1
    } else if (options.releaseMode) {
      console.log(
        `META PASS verified ${packageNames.length} package(s) for exact candidate ${options.version}`,
      )
    } else {
      console.log(
        `META PASS verified ${packageNames.length} package(s) for ${options.version} in package set ${options.packageSet}`,
      )
    }
  } catch (error) {
    console.error(`META FAIL ${formatSmokeError(error)}`)
    process.exitCode = 1
  }
}

export async function runPublishedArtifactVerify(options, overrides = {}) {
  if (options.releaseMode) {
    return runReleaseModeVerify(options, overrides)
  }

  const dependencies = {
    readPublicPackages,
    verifyPackage,
    waitForPublishedVersions,
    ...overrides,
  }
  const publicPackages = await dependencies.readPublicPackages()
  const packageNames = resolvePackageSet(options.packageSet, publicPackages)

  if (options.waitAttempts !== undefined) {
    await dependencies.waitForPublishedVersions({
      attempts: options.waitAttempts,
      delayMs: options.waitDelayMs,
      packages: packageNames,
      version: options.version,
    })
  }

  const failures = []

  for (const packageName of packageNames) {
    try {
      await dependencies.verifyPackage(packageName, options.version)
    } catch (error) {
      failures.push(error)
      console.error(`META FAIL ${error.message}`)
    }
  }

  return { failures, packageNames }
}

async function runReleaseModeVerify(options, overrides) {
  const dependencies = {
    createNpmReader,
    env: process.env,
    mkdir,
    now: () => new Date(),
    readManifest: (path) =>
      readBoundedRegularFile(path, RELEASE_PAYLOAD_LIMITS.manifestBytes, "Release manifest"),
    verifyReleasePackage,
    writeResult: writeCanonicalSmokeResult,
    ...overrides,
  }
  if (overrides.readManifest === undefined && overrides.readFile !== undefined) {
    dependencies.readManifest = overrides.readFile
  }
  if (overrides.writeResult === undefined && overrides.writeFile !== undefined) {
    dependencies.writeResult = async (path, receipt) => {
      await dependencies.mkdir(dirname(path), { recursive: true })
      await overrides.writeFile(path, canonicalSmokeResultBytes(receipt))
    }
  }
  const startedAt = timestampFromClock(dependencies.now)
  const failures = []
  const checks = []
  let packageNames = []
  let primaryError

  try {
    const bytes = await dependencies.readManifest(options.manifest)
    const actualDigest = createHash("sha256").update(bytes).digest("hex")
    if (actualDigest !== options.manifestSha256) {
      throw new Error("Release manifest SHA256 does not match --manifest-sha256")
    }
    const manifest = parseSealedReleaseManifest(bytes, {
      candidate: { version: options.version, commitSha: options.commitSha },
    })
    if (!canonicalManifestBytes(manifest).equals(Buffer.from(bytes))) {
      throw new Error("Release manifest bytes are not canonical")
    }
    packageNames = manifest.packages.map(({ name }) => name)
    checks.push({
      name: "manifest",
      conclusion: "success",
      detail: `${packageNames.length} exact packages bound to ${options.manifestSha256}`,
    })
    const npmReader = dependencies.npmReader ?? dependencies.createNpmReader()

    for (const entry of manifest.packages) {
      try {
        await dependencies.verifyReleasePackage(entry, {
          commitSha: options.commitSha,
          npmReader,
          workflow: PUBLISHED_RELEASE_WORKFLOW,
        })
        checks.push({
          name: `package:${entry.name}`,
          conclusion: "success",
          detail: `${entry.name}@${entry.version} exact registry evidence verified`,
        })
      } catch (error) {
        failures.push(error)
        checks.push({
          name: `package:${entry.name}`,
          conclusion: "failure",
          detail: formatSmokeError(error),
        })
        console.error(`META FAIL ${formatSmokeError(error)}`)
      }
    }
  } catch (error) {
    primaryError = error
    failures.push(error)
    checks.push({
      name: "manifest",
      conclusion: "failure",
      detail: formatSmokeError(error),
    })
  }

  let receiptError
  try {
    const receipt = {
      schemaVersion: 1,
      lane: "metadata",
      version: options.version,
      commitSha: options.commitSha,
      manifestSha256: options.manifestSha256,
      workflowRunId: parsePositiveEnvironmentInteger(
        dependencies.env.GITHUB_RUN_ID,
        "GITHUB_RUN_ID",
      ),
      runAttempt: parsePositiveEnvironmentInteger(
        dependencies.env.GITHUB_RUN_ATTEMPT,
        "GITHUB_RUN_ATTEMPT",
      ),
      startedAt,
      finishedAt: timestampFromClock(dependencies.now),
      checks,
      conclusion: checks.every(({ conclusion }) => conclusion === "success")
        ? "success"
        : "failure",
    }
    await dependencies.writeResult(options.result, receipt)
  } catch (error) {
    receiptError = error
  }

  if (primaryError !== undefined || receiptError !== undefined) {
    const errors = [primaryError, receiptError].filter((error) => error !== undefined)
    if (errors.length === 1) throw errors[0]
    throw new AggregateError(errors, "Published metadata verification and receipt write failed")
  }

  return { failures, packageNames }
}

export function parsePublishedArtifactVerifyArgs(args) {
  const parsed = {
    packageSet: "memory-pgvector-core",
    version: "latest",
  }
  let versionProvided = false
  let packageSetProvided = false
  let waitAttempts
  let waitDelayMs

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === "--package-set") {
      parsed.packageSet = readFlagValue(args, index, arg)
      packageSetProvided = true
      index += 1
      continue
    }

    if (arg === "--version") {
      parsed.version = readFlagValue(args, index, arg)
      versionProvided = true
      index += 1
      continue
    }

    if (arg === "--release-mode") {
      parsed.releaseMode = true
      continue
    }

    if (arg === "--commit-sha") {
      parsed.commitSha = readFlagValue(args, index, arg)
      index += 1
      continue
    }

    if (arg === "--manifest") {
      parsed.manifest = readFlagValue(args, index, arg)
      index += 1
      continue
    }

    if (arg === "--manifest-sha256") {
      parsed.manifestSha256 = readFlagValue(args, index, arg)
      index += 1
      continue
    }

    if (arg === "--result") {
      parsed.result = readFlagValue(args, index, arg)
      index += 1
      continue
    }

    if (arg === "--wait-attempts") {
      waitAttempts = parsePositiveInteger(readFlagValue(args, index, arg), arg)
      index += 1
      continue
    }

    if (arg === "--wait-delay-ms") {
      waitDelayMs = parseNonNegativeInteger(readFlagValue(args, index, arg), arg)
      index += 1
      continue
    }

    if (arg.startsWith("--package-set=")) {
      parsed.packageSet = arg.slice("--package-set=".length)
      packageSetProvided = true
      continue
    }

    if (arg.startsWith("--version=")) {
      parsed.version = arg.slice("--version=".length)
      versionProvided = true
      continue
    }

    if (arg.startsWith("--commit-sha=")) {
      parsed.commitSha = arg.slice("--commit-sha=".length)
      continue
    }

    if (arg.startsWith("--manifest=")) {
      parsed.manifest = arg.slice("--manifest=".length)
      continue
    }

    if (arg.startsWith("--manifest-sha256=")) {
      parsed.manifestSha256 = arg.slice("--manifest-sha256=".length)
      continue
    }

    if (arg.startsWith("--result=")) {
      parsed.result = arg.slice("--result=".length)
      continue
    }

    if (arg.startsWith("--wait-attempts=")) {
      waitAttempts = parsePositiveInteger(arg.slice("--wait-attempts=".length), "--wait-attempts")
      continue
    }

    if (arg.startsWith("--wait-delay-ms=")) {
      waitDelayMs = parseNonNegativeInteger(arg.slice("--wait-delay-ms=".length), "--wait-delay-ms")
      continue
    }

    throw new Error(`Unknown argument "${arg}"`)
  }

  if (parsed.releaseMode) {
    if (packageSetProvided) throw new Error("--package-set is not allowed in release mode")
    if (waitAttempts !== undefined || waitDelayMs !== undefined) {
      throw new Error("wait options are not allowed in release mode")
    }
    if (!versionProvided || !isExactVersion(parsed.version)) {
      throw new Error("release mode requires --version with an exact version")
    }
    if (typeof parsed.commitSha !== "string" || !/^[0-9a-f]{40}$/u.test(parsed.commitSha)) {
      throw new Error("release mode requires --commit-sha with a 40-character lowercase SHA")
    }
    if (typeof parsed.manifest !== "string" || parsed.manifest.length === 0) {
      throw new Error("release mode requires --manifest")
    }
    if (
      typeof parsed.manifestSha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(parsed.manifestSha256)
    ) {
      throw new Error("release mode requires --manifest-sha256 with a lowercase SHA256 digest")
    }
    if (typeof parsed.result !== "string" || parsed.result.length === 0) {
      throw new Error("--result is required in release mode")
    }
    delete parsed.packageSet
    return parsed
  }

  for (const flag of ["commitSha", "manifest", "manifestSha256", "result"]) {
    if (parsed[flag] !== undefined) {
      throw new Error(`--${camelToFlag(flag)} requires --release-mode`)
    }
  }

  if (waitDelayMs !== undefined && waitAttempts === undefined) {
    throw new Error("--wait-delay-ms requires --wait-attempts")
  }

  if (waitAttempts !== undefined) {
    if (!versionProvided || !isExactVersion(parsed.version)) {
      throw new Error("--wait-attempts requires --version with an exact version")
    }

    parsed.waitAttempts = waitAttempts
    parsed.waitDelayMs = waitDelayMs ?? DEFAULT_WAIT_DELAY_MS
    validatePublishedWaitOptions({
      attempts: parsed.waitAttempts,
      delayMs: parsed.waitDelayMs,
    })
  }

  return parsed
}

function camelToFlag(value) {
  return value.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`)
}

function isExactVersion(value) {
  const match = value.match(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  )
  if (!match) {
    return false
  }

  const prerelease = match[1]
  return (
    prerelease === undefined ||
    prerelease
      .split(".")
      .every((identifier) => !/^\d+$/.test(identifier) || /^(?:0|[1-9]\d*)$/.test(identifier))
  )
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`)
  }

  return parsed
}

function parseNonNegativeInteger(value, flag) {
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} must be a non-negative integer`)
  }

  return parsed
}

function readFlagValue(args, index, flag) {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`)
  }

  return value
}

async function verifyPackage(packageName, requestedVersion) {
  const { versions, tags } = await npmView(packageName)
  const resolvedVersion = resolveRequestedVersion({
    requested: requestedVersion,
    tags,
  })

  if (!versions.includes(resolvedVersion)) {
    throw new Error(`${packageName}@${resolvedVersion} is not present in npm versions`)
  }

  console.log(`META PASS ${packageName}@${resolvedVersion} registry version present`)

  const tempDir = await makeTempDir("dawn-published-artifact-")
  try {
    const tarballPath = await packPackage({
      packageName,
      tempDir,
      version: resolvedVersion,
    })
    const extractDir = resolve(tempDir, "extract")
    await mkdir(extractDir)
    await run("tar", ["-xzf", tarballPath, "-C", extractDir])

    const extractedPackageDir = resolve(extractDir, "package")
    const packageJson = JSON.parse(
      await readFile(resolve(extractedPackageDir, "package.json"), "utf8"),
    )

    const metadataFailures = validatePackageMetadata(packageName, packageJson, resolvedVersion)
    if (metadataFailures.length > 0) {
      throw new Error(
        `${packageName}@${resolvedVersion} package metadata failed: ${metadataFailures.join("; ")}`,
      )
    }

    assertCleanDependencySpecs(`${packageName}@${resolvedVersion}`, packageJson)
    await assertExpectedFiles({
      packageName,
      packageDir: extractedPackageDir,
      version: resolvedVersion,
    })

    console.log(`META PASS ${packageName}@${resolvedVersion} package metadata clean`)
    console.log(`META PASS ${packageName}@${resolvedVersion} tarball contents present`)
  } finally {
    await removeDir(tempDir)
  }
}

async function verifyReleasePackage(entry, { commitSha, npmReader, workflow }) {
  const observation = await npmReader.observePackageVersion({
    name: entry.name,
    version: entry.version,
  })
  if (observation.status !== "PRESENT") {
    throw new Error(
      `${entry.name}@${entry.version} exact registry observation failed: ${observation.status}/${observation.code ?? "NO_CODE"}`,
    )
  }
  const tarballResult = await npmReader.downloadRegistryTarball({
    tarballUrl: observation.package.tarballUrl,
  })
  if (tarballResult.status !== "PRESENT") {
    throw new Error(
      `${entry.name}@${entry.version} tarball download failed: ${tarballResult.status}/${tarballResult.code ?? "NO_CODE"}`,
    )
  }
  const signature = await npmReader.verifyRegistrySignatures({
    name: entry.name,
    version: entry.version,
    integrity: observation.package.integrity,
    signatures: observation.package.signatures,
  })
  validateExactPublishedPackageEvidence({
    entry,
    observation,
    tarball: tarballResult.tarball,
    signature,
    commitSha,
    workflow,
  })
  await verifyDownloadedPackageContents(entry, tarballResult.tarball.contentBase64)
}

async function verifyDownloadedPackageContents(entry, contentBase64) {
  const tempDir = await makeTempDir("dawn-published-release-verify-")
  try {
    const tarballPath = resolve(tempDir, entry.filename)
    await writeFile(tarballPath, Buffer.from(contentBase64, "base64"))
    const extractDir = resolve(tempDir, "extract")
    await mkdir(extractDir)
    await run("tar", ["-xzf", tarballPath, "-C", extractDir], {
      timeoutMs: 30_000,
    })
    const packageDir = resolve(extractDir, "package")
    const packageJson = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8"))
    const metadataFailures = validatePackageMetadata(entry.name, packageJson, entry.version)
    if (metadataFailures.length > 0) {
      throw new Error(
        `${entry.name}@${entry.version} package metadata failed: ${metadataFailures.join("; ")}`,
      )
    }
    assertCleanDependencySpecs(`${entry.name}@${entry.version}`, packageJson)
    await assertExpectedFiles({
      packageName: entry.name,
      packageDir,
      version: entry.version,
    })
  } finally {
    await removeDir(tempDir)
  }
}

function parsePositiveEnvironmentInteger(value, name) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer in release mode`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive safe integer in release mode`)
  }
  return parsed
}

function timestampFromClock(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime()))
    throw new Error("Verification clock returned an invalid time")
  return date.toISOString()
}

async function packPackage({ packageName, tempDir, version }) {
  const packDir = resolve(tempDir, "pack")
  await mkdir(packDir)
  const output = await run(
    "npm",
    ["pack", `${packageName}@${version}`, "--pack-destination", packDir],
    {
      stdio: "pipe",
    },
  )
  const tarballName = output.trim().split(/\r?\n/).filter(Boolean).at(-1)

  if (!tarballName) {
    throw new Error(`${packageName}@${version} npm pack did not report a tarball`)
  }

  return join(packDir, tarballName)
}

async function assertExpectedFiles({ packageName, packageDir, version }) {
  const missing = []

  for (const file of expectedFilesForPackage(packageName)) {
    try {
      await stat(resolve(packageDir, file))
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error
      }

      missing.push(file)
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `${packageName}@${version} tarball is missing expected file(s): ${missing.join(", ")}`,
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
