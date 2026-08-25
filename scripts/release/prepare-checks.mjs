import { constants } from "node:fs"
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { runServer } from "verdaccio"

import {
  expectedExportFailures,
  forbiddenPackedFiles,
  missingExportTargets,
  missingInspectorServerPaths,
  packages as packConfigurations,
  validatePackManifest,
} from "../lib/pack-check.mjs"
import { assertCleanDependencySpecs, validatePackageMetadata } from "../lib/published-artifacts.mjs"
import { runTypeScriptToolingProbe } from "../lib/typescript-tooling-probe.mjs"
import {
  assertNoNativeLifecycleScripts,
  readInstalledPackageManifests,
  TSX_VERSION,
  TYPESCRIPT_VERSION,
  ZOD_VERSION,
} from "../published-artifact-smoke.mjs"

const LOOPBACK = "127.0.0.1"
const REGISTRY_BODY_LIMIT = "64mb"

export function createProductionPreparationChecks({ root, run, fileSystem }) {
  validatePackManifest(root, packConfigurations)
  return Object.freeze({
    inspectTarball(input) {
      return inspectPreparedTarball({ ...input, root, run, fileSystem })
    },
    smokeTarballs(input) {
      return smokePreparedTarballs({ ...input, root, run, fileSystem })
    },
  })
}

export async function inspectPreparedTarball({
  packageJson,
  tarballPath,
  entry,
  root,
  run,
  fileSystem = { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile },
}) {
  const packageDirectory = path.posix.dirname(packageJson.path)
  const configuration = packConfigurations.find((candidate) => candidate.dir === packageDirectory)
  if (configuration === undefined) {
    throw new Error(`No production pack inspection contract exists for ${packageJson.name}`)
  }
  const createdTemporary = await fileSystem.mkdtemp(path.join(tmpdir(), "dawn-release-inspect-"))
  const temporary = await fileSystem.realpath(createdTemporary)
  try {
    const listing = commandStdout(await run("tar", ["-tzf", tarballPath], { cwd: root }))
    const archiveEntries = listing.split("\n").filter(Boolean)
    if (
      archiveEntries.length === 0 ||
      archiveEntries.some((name) => !safePackageArchivePath(name))
    ) {
      throw new Error(`${packageJson.name} tarball contains an unsafe or empty file set`)
    }
    const verboseListing = commandStdout(await run("tar", ["-tvzf", tarballPath], { cwd: root }))
    if (
      verboseListing
        .split("\n")
        .filter(Boolean)
        .some((line) => line.startsWith("l") || line.startsWith("h"))
    ) {
      throw new Error(`${packageJson.name} tarball contains a symlink or hardlink entry`)
    }
    await run("tar", ["-xzf", tarballPath, "-C", temporary], { cwd: root })
    const packedRoot = path.join(temporary, "package")
    const canonicalPackedRoot = await fileSystem.realpath(packedRoot)
    if (canonicalPackedRoot !== packedRoot) {
      throw new Error(`${packageJson.name} packed root resolves through a symlink`)
    }
    await assertNoExtractedLinks(packedRoot, fileSystem)
    const packedManifest = JSON.parse(
      await fileSystem.readFile(path.join(packedRoot, "package.json"), "utf8"),
    )
    const metadataFailures = validatePackageMetadata(entry.name, packedManifest, entry.version)
    if (metadataFailures.length > 0) {
      throw new Error(`${entry.name} packed metadata failed: ${metadataFailures.join("; ")}`)
    }
    if (packedManifest.publishConfig?.access !== entry.access || entry.access !== "public") {
      throw new Error(`${entry.name} packed access does not match public release access`)
    }
    assertCleanDependencySpecs(`${entry.name}@${entry.version}`, packedManifest)

    const failures = []
    for (const relativePath of configuration.expectedFiles) {
      try {
        await fileSystem.access(path.join(packedRoot, relativePath), constants.F_OK)
      } catch {
        failures.push(`missing ${relativePath}`)
      }
    }
    for (const relativePath of forbiddenPackedFiles(packedRoot, configuration.forbiddenFiles)) {
      failures.push(`contains forbidden file ${relativePath}`)
    }
    for (const field of configuration.requiredFields) {
      if (readField(packedManifest, field) === undefined) failures.push(`missing field ${field}`)
    }
    for (const missing of missingInspectorServerPaths(packedRoot, packedManifest)) {
      failures.push(`dawnInspector.server target is missing: ${missing}`)
    }
    for (const missing of missingExportTargets(packedRoot, packedManifest.exports)) {
      failures.push(`export target is missing: ${missing}`)
    }
    failures.push(...expectedExportFailures(packedManifest.exports, configuration.expectedExports))
    if (failures.length > 0) {
      throw new Error(`${entry.name} packed contents failed: ${failures.join("; ")}`)
    }
    await run("pnpm", ["exec", "publint", packedRoot], { cwd: root })
    return Object.freeze({ status: "verified" })
  } finally {
    await fileSystem.rm(createdTemporary, { recursive: true, force: true })
  }
}

export async function smokePreparedTarballs({
  candidate,
  manifest,
  tarballs,
  run,
  fileSystem = { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile },
  startRegistry = startLoopbackRegistry,
  runTypeScriptProbe = runTypeScriptToolingProbe,
}) {
  const temporary = await fileSystem.mkdtemp(path.join(tmpdir(), "dawn-release-smoke-"))
  let registry
  try {
    registry = await startRegistry()
    const npmCache = path.join(temporary, "npm-cache")
    const userConfig = path.join(temporary, "npmrc")
    await fileSystem.mkdir(npmCache)
    await writeRegistryConfig(userConfig, registry.url, fileSystem)
    const environment = registryEnvironment({ registryUrl: registry.url, npmCache, userConfig })

    for (const tarball of tarballs) {
      await run("npm", localPublishArguments(tarball), { cwd: temporary, env: environment })
    }

    const consumer = path.join(temporary, "consumer")
    await initializeProject(consumer, fileSystem)
    await run(
      "npm",
      [
        "install",
        "--save-exact",
        "--package-lock=false",
        ...manifest.packages.map(({ name, version }) => `${name}@${version}`),
      ],
      { cwd: consumer, env: environment },
    )
    await assertNoPackageLock(consumer, fileSystem)
    await verifyInstalledCandidate({ root: consumer, manifest, fileSystem })
    assertNoNativeLifecycleScripts(
      await readInstalledPackageManifests(path.join(consumer, "node_modules")),
    )

    await run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--save-exact",
        "--package-lock=false",
        `typescript@${TYPESCRIPT_VERSION}`,
        `tsx@${TSX_VERSION}`,
        `zod@${ZOD_VERSION}`,
      ],
      { cwd: consumer, env: environment },
    )
    const registryRun = withEnvironment(run, environment)
    await runTypeScriptProbe({
      expectedTypeScriptVersion: TYPESCRIPT_VERSION,
      root: consumer,
      runCommand: registryRun,
    })

    await smokeScaffolder({
      candidate,
      manifest,
      temporary,
      environment,
      run,
      fileSystem,
    })
    return Object.freeze({ cleanInstall: "passed", typeScript: "passed", scaffold: "passed" })
  } finally {
    await registry?.close()
    await fileSystem.rm(temporary, { recursive: true, force: true })
  }
}

async function smokeScaffolder({ candidate, manifest, temporary, environment, run, fileSystem }) {
  const installer = path.join(temporary, "scaffolder-installer")
  const scaffold = path.join(temporary, "scaffold")
  await initializeProject(installer, fileSystem)
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--save-exact",
      "--package-lock=false",
      `create-dawn-ai-app@${candidate.version}`,
    ],
    { cwd: installer, env: environment },
  )
  const executable = path.join(installer, "node_modules", ".bin", "create-dawn-ai-app")
  await run(executable, [scaffold, "--template", "basic", "--dist-tag", "latest"], {
    cwd: installer,
    env: environment,
  })
  await writeRegistryConfig(
    path.join(scaffold, ".npmrc"),
    environment.npm_config_registry,
    fileSystem,
  )
  await run("npm", ["install", "--package-lock=false"], { cwd: scaffold, env: environment })
  await assertNoPackageLock(scaffold, fileSystem)
  await verifyInstalledCandidate({ root: scaffold, manifest, fileSystem, installedOnly: true })
  await run("npm", ["run", "typecheck"], { cwd: scaffold, env: environment })
  await run("npm", ["run", "build"], { cwd: scaffold, env: environment })
}

async function verifyInstalledCandidate({ root, manifest, fileSystem, installedOnly = false }) {
  const declared = installedOnly
    ? await declaredDawnPackages(path.join(root, "package.json"), fileSystem)
    : new Set(manifest.packages.map(({ name }) => name))
  for (const entry of manifest.packages) {
    if (!declared.has(entry.name)) continue
    const installed = JSON.parse(
      await fileSystem.readFile(
        path.join(root, "node_modules", ...entry.name.split("/"), "package.json"),
        "utf8",
      ),
    )
    if (installed.name !== entry.name || installed.version !== entry.version) {
      throw new Error(
        `${entry.name} installed as ${installed.name}@${installed.version}, expected exact candidate ${entry.version}`,
      )
    }
  }
}

async function declaredDawnPackages(manifestPath, fileSystem) {
  const manifest = JSON.parse(await fileSystem.readFile(manifestPath, "utf8"))
  return new Set(
    Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) =>
      name.startsWith("@dawn-ai/"),
    ),
  )
}

async function initializeProject(root, fileSystem) {
  await fileSystem.mkdir(root)
  if ((await fileSystem.readdir(root)).length !== 0) throw new Error("Smoke project must be fresh")
  await fileSystem.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "dawn-release-smoke", private: true, type: "module" }, null, 2)}\n`,
    { flag: "wx" },
  )
}

async function assertNoPackageLock(root, fileSystem) {
  if ((await fileSystem.readdir(root)).includes("package-lock.json")) {
    throw new Error("Release smoke unexpectedly created package-lock.json")
  }
}

async function writeRegistryConfig(target, registryUrl, fileSystem) {
  const host = new URL(registryUrl).host
  await fileSystem.writeFile(
    target,
    [
      `registry=${registryUrl}`,
      `@dawn-ai:registry=${registryUrl}`,
      `//${host}/:_authToken=fake`,
      "replace-registry-host=never",
      "",
    ].join("\n"),
    "utf8",
  )
}

function registryEnvironment({ registryUrl, npmCache, userConfig }) {
  const host = new URL(registryUrl).host
  return {
    ...runtimeEnvironment(),
    NPM_CONFIG_PROVENANCE: "false",
    npm_config_cache: npmCache,
    npm_config_registry: registryUrl,
    npm_config_replace_registry_host: "never",
    npm_config_scope: "",
    npm_config_userconfig: userConfig,
    "npm_config_@dawn-ai:registry": registryUrl,
    [`npm_config_//${host}/:_authToken`]: "fake",
  }
}

function runtimeEnvironment() {
  const allowed = [
    "CI",
    "COMSPEC",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
  ]
  return Object.fromEntries(
    allowed.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  )
}

function withEnvironment(run, environment) {
  return (command, args, options = {}) =>
    run(command, args, { ...options, env: { ...environment, ...options.env } })
}

export function localPublishArguments(tarball) {
  return [
    "publish",
    tarball,
    "--ignore-scripts",
    "--tag",
    "latest",
    "--access",
    "public",
    "--scope=",
  ]
}

export async function startLoopbackRegistry({
  runServerImpl = runServer,
  timeoutMs = 10_000,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError("Release smoke registry timeout is invalid")
  }
  const directory = await mkdtemp(path.join(tmpdir(), "dawn-release-registry-"))
  let server
  try {
    const application = await deadline(
      runServerImpl({
        configPath: path.join(directory, "config.yaml"),
        storage: path.join(directory, "storage"),
        uplinks: { npmjs: { url: "https://registry.npmjs.org/", maxage: "30m" } },
        packages: {
          "@dawn-ai/*": { access: "$all", publish: "$anonymous", unpublish: "$anonymous" },
          "create-dawn-ai-app": {
            access: "$all",
            publish: "$anonymous",
            unpublish: "$anonymous",
          },
          "**": { access: "$all", publish: "$anonymous", proxy: "npmjs" },
        },
        log: { type: "stdout", format: "pretty", level: "fatal" },
        max_body_size: REGISTRY_BODY_LIMIT,
      }),
      timeoutMs,
      "registry startup",
    )
    server = application.listen(0, LOOPBACK)
    await deadline(
      new Promise((resolvePromise, reject) => {
        server.once("listening", resolvePromise)
        server.once("error", reject)
      }),
      timeoutMs,
      "registry listen",
    )
    const address = server.address()
    if (address === null || typeof address === "string" || address.address !== LOOPBACK) {
      throw new Error("Release smoke registry did not bind to loopback")
    }
    return Object.freeze({
      url: `http://${LOOPBACK}:${address.port}/`,
      async close() {
        try {
          await deadline(closeServer(server), timeoutMs, "registry shutdown")
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      },
    })
  } catch (error) {
    if (server !== undefined) await closeServer(server).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

function closeServer(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)))
    server.closeAllConnections?.()
  })
}

async function assertNoExtractedLinks(root, fileSystem) {
  for (const entry of await fileSystem.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    const stat = await fileSystem.lstat(target)
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) {
      throw new Error("Packed artifact extraction contains a symlink or hardlink")
    }
    if (stat.isDirectory()) await assertNoExtractedLinks(target, fileSystem)
  }
}

function deadline(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function safePackageArchivePath(name) {
  if (typeof name !== "string" || name.includes("\\") || name.startsWith("/")) return false
  const normalized = path.posix.normalize(name)
  return (
    (normalized === "package" || normalized.startsWith("package/")) &&
    !normalized.split("/").includes("..")
  )
}

function commandStdout(result) {
  if (typeof result === "string") return result
  if (typeof result?.stdout === "string") return result.stdout
  throw new TypeError("Preparation command result must expose stdout")
}

function readField(value, dottedPath) {
  return dottedPath.split(".").reduce((current, segment) => current?.[segment], value)
}
