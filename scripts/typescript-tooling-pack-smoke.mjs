#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  assertCleanDependencySpecs,
  makeTempDir,
  removeDir,
  validatePackageMetadata,
} from "./lib/published-artifacts.mjs"
import { runTypeScriptToolingProbe as defaultRunTypeScriptToolingProbe } from "./lib/typescript-tooling-probe.mjs"
import {
  assertNoNativeLifecycleScripts,
  readInstalledPackageManifests,
  runCommand,
} from "./published-artifact-smoke.mjs"

export const TYPESCRIPT_VERSION = "7.0.2"
export const TSX_VERSION = "4.23.0"
export const ZOD_VERSION = "4.4.3"

export const TOOLING_PACKAGES = [
  { dir: "packages/core", name: "@dawn-ai/core" },
  { dir: "packages/vite-plugin", name: "@dawn-ai/vite-plugin" },
]

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Builds, packs, installs, and probes the TypeScript tooling from local workspace artifacts.
 * Every generated file lives below the temporary root owned and removed by this function.
 */
export async function runTypeScriptToolingPackSmoke(overrides = {}) {
  const dependencies = {
    assertNoNativeLifecycleScripts,
    makeTempDir,
    onPackedArtifactValidated: () => {},
    packWorkspacePackage,
    readInstalledPackageManifests,
    removeDir,
    repoRoot: defaultRepoRoot,
    runCommand,
    runTypeScriptToolingProbe: defaultRunTypeScriptToolingProbe,
    ...overrides,
  }

  const tempRoot = await dependencies.makeTempDir("dawn-typescript-tooling-pack-")
  try {
    const packDir = join(tempRoot, "packs")
    const consumerRoot = join(tempRoot, "consumer")

    await dependencies.runCommand("pnpm", ["--filter", "@dawn-ai/vite-plugin...", "build"], {
      cwd: dependencies.repoRoot,
    })

    await mkdir(packDir, { recursive: true })
    const packedArtifacts = []
    for (const packageConfig of TOOLING_PACKAGES) {
      const artifact = await dependencies.packWorkspacePackage({
        packageConfig,
        packDir,
        repoRoot: dependencies.repoRoot,
        runCommand: dependencies.runCommand,
      })
      validatePackedArtifact(artifact)
      dependencies.onPackedArtifactValidated(artifact)
      packedArtifacts.push(artifact)
    }

    await initializeCleanConsumerProject(consumerRoot)
    await dependencies.runCommand(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--save-exact",
        "--package-lock=false",
        ...packedArtifacts.map(({ tarballPath }) => tarballPath),
        `typescript@${TYPESCRIPT_VERSION}`,
        `tsx@${TSX_VERSION}`,
        `zod@${ZOD_VERSION}`,
      ],
      { cwd: consumerRoot },
    )
    if ((await readdir(consumerRoot)).includes("package-lock.json")) {
      throw new Error("TypeScript tooling consumer unexpectedly created package-lock.json")
    }

    const installedVersions = await assertInstalledVersions(consumerRoot, {
      "@dawn-ai/core": packedArtifacts.find(({ packageName }) => packageName === "@dawn-ai/core")
        .packageVersion,
      "@dawn-ai/vite-plugin": packedArtifacts.find(
        ({ packageName }) => packageName === "@dawn-ai/vite-plugin",
      ).packageVersion,
      tsx: TSX_VERSION,
      typescript: TYPESCRIPT_VERSION,
      zod: ZOD_VERSION,
    })

    dependencies.assertNoNativeLifecycleScripts(
      await dependencies.readInstalledPackageManifests(join(consumerRoot, "node_modules")),
    )

    await dependencies.runTypeScriptToolingProbe({
      expectedTypeScriptVersion: TYPESCRIPT_VERSION,
      root: consumerRoot,
      runCommand: dependencies.runCommand,
    })

    return { installedVersions }
  } finally {
    await dependencies.removeDir(tempRoot)
  }
}

export async function packWorkspacePackage({ packageConfig, packDir, repoRoot, runCommand }) {
  const packageDir = resolve(repoRoot, packageConfig.dir)
  const sourcePackageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"))
  if (sourcePackageJson.name !== packageConfig.name) {
    throw new Error(
      `${packageConfig.dir} package name is ${sourcePackageJson.name}, expected ${packageConfig.name}`,
    )
  }

  const existingFiles = new Set(await readdir(packDir))
  await runCommand("pnpm", ["pack", "--pack-destination", packDir], { cwd: packageDir })
  const tarballNames = (await readdir(packDir)).filter(
    (name) => name.endsWith(".tgz") && !existingFiles.has(name),
  )
  if (tarballNames.length !== 1) {
    throw new Error(
      `${packageConfig.name} pack produced ${tarballNames.length} new tarballs in ${packDir}, expected 1`,
    )
  }

  const tarballPath = join(packDir, tarballNames[0])
  const extractDir = join(packDir, `${packageConfig.name.slice(1).replaceAll("/", "-")}-extract`)
  await mkdir(extractDir)
  await runCommand("tar", ["-xzf", tarballPath, "-C", extractDir], { cwd: repoRoot })
  const packageJson = JSON.parse(
    await readFile(join(extractDir, "package", "package.json"), "utf8"),
  )

  return {
    packageJson,
    packageName: packageConfig.name,
    packageVersion: sourcePackageJson.version,
    tarballPath,
  }
}

export function validatePackedArtifact(artifact) {
  const metadataFailures = validatePackageMetadata(
    artifact.packageName,
    artifact.packageJson,
    artifact.packageVersion,
  )
  if (metadataFailures.length > 0) {
    throw new Error(
      `${artifact.packageName}@${artifact.packageVersion} packed metadata failed: ${metadataFailures.join("; ")}`,
    )
  }

  assertCleanDependencySpecs(
    `${artifact.packageName}@${artifact.packageVersion}`,
    artifact.packageJson,
  )
}

async function initializeCleanConsumerProject(consumerRoot) {
  await mkdir(consumerRoot)
  const entries = await readdir(consumerRoot)
  if (entries.length > 0) {
    throw new Error(`TypeScript tooling consumer root is not empty: ${entries.join(", ")}`)
  }

  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "dawn-typescript-tooling-pack-smoke",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  const unexpectedEntries = (await readdir(consumerRoot)).filter(
    (entry) => entry === "node_modules" || entry === "package-lock.json",
  )
  if (unexpectedEntries.length > 0) {
    throw new Error(
      `TypeScript tooling consumer unexpectedly has prior install state: ${unexpectedEntries.join(", ")}`,
    )
  }
}

async function assertInstalledVersions(consumerRoot, expectedVersions) {
  const installedVersions = {}

  for (const [packageName, expectedVersion] of Object.entries(expectedVersions)) {
    const manifestPath = join(
      consumerRoot,
      "node_modules",
      ...packageName.split("/"),
      "package.json",
    )
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    if (manifest.name !== packageName) {
      throw new Error(`${manifestPath} package name is ${manifest.name}, expected ${packageName}`)
    }
    if (manifest.version !== expectedVersion) {
      throw new Error(
        `${packageName} installed version ${manifest.version}, expected ${expectedVersion} (${manifestPath})`,
      )
    }
    installedVersions[packageName] = manifest.version
  }

  return installedVersions
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  try {
    const { installedVersions } = await runTypeScriptToolingPackSmoke()
    console.log(
      `TypeScript tooling pack smoke passed: ${Object.entries(installedVersions)
        .map(([name, version]) => `${name}@${version}`)
        .join(", ")}; runtime and tsc probes passed without a package lock.`,
    )
  } catch (error) {
    console.error(`TypeScript tooling pack smoke failed: ${error.stack ?? error.message}`)
    process.exitCode = 1
  }
}

export { runCommand }
