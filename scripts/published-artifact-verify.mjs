#!/usr/bin/env node

import { mkdir, readFile, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  assertCleanDependencySpecs,
  expectedFilesForPackage,
  makeTempDir,
  normalizeCliArgs,
  npmView,
  readPublicPackages,
  removeDir,
  resolvePackageSet,
  resolveRequestedVersion,
  run,
  validatePackageMetadata,
  validatePublishedWaitOptions,
  waitForPublishedVersions,
} from "./lib/published-artifacts.mjs"

const DEFAULT_WAIT_DELAY_MS = 10_000

async function main() {
  try {
    const options = parsePublishedArtifactVerifyArgs(normalizeCliArgs(process.argv.slice(2)))
    const { failures, packageNames } = await runPublishedArtifactVerify(options)

    if (failures.length > 0) {
      console.error(
        `META FAIL ${failures.length} of ${packageNames.length} package(s) failed for ${options.version} in package set ${options.packageSet}`,
      )
      process.exitCode = 1
    } else {
      console.log(
        `META PASS verified ${packageNames.length} package(s) for ${options.version} in package set ${options.packageSet}`,
      )
    }
  } catch (error) {
    console.error(`META FAIL ${error.message}`)
    process.exitCode = 1
  }
}

export async function runPublishedArtifactVerify(options, overrides = {}) {
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

export function parsePublishedArtifactVerifyArgs(args) {
  const parsed = {
    packageSet: "memory-pgvector-core",
    version: "latest",
  }
  let versionProvided = false
  let waitAttempts
  let waitDelayMs

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === "--package-set") {
      parsed.packageSet = readFlagValue(args, index, arg)
      index += 1
      continue
    }

    if (arg === "--version") {
      parsed.version = readFlagValue(args, index, arg)
      versionProvided = true
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
      continue
    }

    if (arg.startsWith("--version=")) {
      parsed.version = arg.slice("--version=".length)
      versionProvided = true
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
  const resolvedVersion = resolveRequestedVersion({ requested: requestedVersion, tags })

  if (!versions.includes(resolvedVersion)) {
    throw new Error(`${packageName}@${resolvedVersion} is not present in npm versions`)
  }

  console.log(`META PASS ${packageName}@${resolvedVersion} registry version present`)

  const tempDir = await makeTempDir("dawn-published-artifact-")
  try {
    const tarballPath = await packPackage({ packageName, tempDir, version: resolvedVersion })
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
