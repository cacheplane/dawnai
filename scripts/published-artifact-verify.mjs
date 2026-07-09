#!/usr/bin/env node

import { mkdir, readFile, stat } from "node:fs/promises"
import { join, resolve } from "node:path"

import {
  assertCleanDependencySpecs,
  expectedFilesForPackage,
  makeTempDir,
  npmView,
  readPublicPackages,
  removeDir,
  resolvePackageSet,
  resolveRequestedVersion,
  run,
  validatePackageMetadata,
} from "./lib/published-artifacts.mjs"

try {
  const { packageSet, version } = parseArgs(process.argv.slice(2))
  const publicPackages = await readPublicPackages()
  const packageNames = resolvePackageSet(packageSet, publicPackages)

  for (const packageName of packageNames) {
    await verifyPackage(packageName, version)
  }

  console.log(`META PASS verified ${packageNames.length} package(s) for ${version} in package set ${packageSet}`)
} catch (error) {
  console.error(`META FAIL ${error.message}`)
  process.exitCode = 1
}

function parseArgs(args) {
  const parsed = {
    packageSet: "memory-pgvector-core",
    version: "latest",
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === "--package-set") {
      parsed.packageSet = readFlagValue(args, index, arg)
      index += 1
      continue
    }

    if (arg === "--version") {
      parsed.version = readFlagValue(args, index, arg)
      index += 1
      continue
    }

    if (arg.startsWith("--package-set=")) {
      parsed.packageSet = arg.slice("--package-set=".length)
      continue
    }

    if (arg.startsWith("--version=")) {
      parsed.version = arg.slice("--version=".length)
      continue
    }

    throw new Error(`Unknown argument "${arg}"`)
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
    const packageJson = JSON.parse(await readFile(resolve(extractedPackageDir, "package.json"), "utf8"))

    const metadataFailures = validatePackageMetadata(packageName, packageJson)
    if (metadataFailures.length > 0) {
      throw new Error(`${packageName}@${resolvedVersion} package metadata failed: ${metadataFailures.join("; ")}`)
    }

    assertCleanDependencySpecs(`${packageName}@${resolvedVersion}`, packageJson)
    await assertExpectedFiles({ packageName, packageDir: extractedPackageDir, version: resolvedVersion })

    console.log(`META PASS ${packageName}@${resolvedVersion} package metadata clean`)
    console.log(`META PASS ${packageName}@${resolvedVersion} tarball contents present`)
  } finally {
    await removeDir(tempDir)
  }
}

async function packPackage({ packageName, tempDir, version }) {
  const packDir = resolve(tempDir, "pack")
  await mkdir(packDir)
  const output = await run("npm", ["pack", `${packageName}@${version}`, "--pack-destination", packDir], {
    stdio: "pipe",
  })
  const tarballName = output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1)

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
    throw new Error(`${packageName}@${version} tarball is missing expected file(s): ${missing.join(", ")}`)
  }
}
