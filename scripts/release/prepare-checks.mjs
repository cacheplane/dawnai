import { constants, createReadStream } from "node:fs"
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
import { createGunzip } from "node:zlib"

import { runServer } from "verdaccio"

import {
  expectedExportFailures,
  forbiddenPackedFiles,
  missingExportTargets,
  missingInspectorServerPaths,
  packages as packConfigurations,
  validatePackManifest,
} from "../lib/pack-check.mjs"
import { validatePackageMetadata } from "../lib/published-artifacts.mjs"
import { runTypeScriptToolingProbe } from "../lib/typescript-tooling-probe.mjs"
import {
  assertNoNativeLifecycleScripts,
  readInstalledPackageManifests,
  TSX_VERSION,
  TYPESCRIPT_VERSION,
  ZOD_VERSION,
} from "../published-artifact-smoke.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "./limits.mjs"

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
  scanTarball = scanPreparedTarball,
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
    await scanTarball(tarballPath)
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
    const packedManifestPath = path.join(packedRoot, "package.json")
    const packedManifestStat = await fileSystem.lstat(packedManifestPath)
    if (
      !packedManifestStat.isFile() ||
      packedManifestStat.isSymbolicLink() ||
      packedManifestStat.size < 1 ||
      packedManifestStat.size > RELEASE_PAYLOAD_LIMITS.packedManifestBytes
    ) {
      throw new Error(`${packageJson.name} packed package.json exceeds its byte limit`)
    }
    const packedManifest = JSON.parse(await fileSystem.readFile(packedManifestPath, "utf8"))
    const metadataFailures = validatePackageMetadata(entry.name, packedManifest, entry.version)
    if (metadataFailures.length > 0) {
      throw new Error(`${entry.name} packed metadata failed: ${metadataFailures.join("; ")}`)
    }
    if (entry.access !== "public") {
      throw new Error(`${entry.name} packed access does not match public release access`)
    }
    assertSafePackedPublicationManifest(packedManifest)

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
  let result
  let primaryError
  try {
    registry = await startRegistry()
    assertLoopbackRegistryUrl(registry?.url)
    const npmCache = path.join(temporary, "npm-cache")
    const userConfig = path.join(temporary, "npmrc")
    await fileSystem.mkdir(npmCache)
    await writeRegistryConfig(userConfig, registry.url, fileSystem)
    const environment = registryEnvironment({ registryUrl: registry.url, npmCache, userConfig })

    for (const tarball of tarballs) {
      await run("npm", localPublishArguments(tarball, registry.url), {
        cwd: temporary,
        env: environment,
      })
    }

    const consumer = path.join(temporary, "consumer")
    await initializeProject(consumer, fileSystem)
    await run(
      "npm",
      [
        "install",
        "--registry",
        registry.url,
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
        "--registry",
        registry.url,
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
    result = Object.freeze({ cleanInstall: "passed", typeScript: "passed", scaffold: "passed" })
  } catch (error) {
    primaryError = error
  }
  const cleanupErrors = []
  try {
    await registry?.close()
  } catch (error) {
    cleanupErrors.push(
      new Error(`Release smoke registry close failed: ${formatError(error)}`, { cause: error }),
    )
  }
  try {
    await fileSystem.rm(temporary, { recursive: true, force: true })
  } catch (error) {
    cleanupErrors.push(
      new Error(`Release smoke temporary cleanup failed: ${formatError(error)}`, { cause: error }),
    )
  }
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    const errors = [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors]
    if (errors.length === 1) throw errors[0]
    throw new AggregateError(
      errors,
      `Release smoke failed and cleanup also failed: ${errors.map(formatError).join("; ")}`,
    )
  }
  return result
}

async function smokeScaffolder({ candidate, manifest, temporary, environment, run, fileSystem }) {
  const installer = path.join(temporary, "scaffolder-installer")
  const scaffold = path.join(temporary, "scaffold")
  await initializeProject(installer, fileSystem)
  await run(
    "npm",
    [
      "install",
      "--registry",
      environment.npm_config_registry,
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
  await run(
    "npm",
    ["install", "--registry", environment.npm_config_registry, "--package-lock=false"],
    { cwd: scaffold, env: environment },
  )
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

export function localPublishArguments(tarball, registryUrl) {
  assertLoopbackRegistryUrl(registryUrl)
  return [
    "publish",
    tarball,
    "--registry",
    registryUrl,
    "--ignore-scripts",
    "--tag",
    "latest",
    "--access",
    "public",
    "--scope=",
  ]
}

export function assertSafePackedPublicationManifest(manifest) {
  if (manifest === null || Array.isArray(manifest) || typeof manifest !== "object") {
    throw new TypeError("Packed publication manifest must be an object")
  }
  const publishConfig = manifest.publishConfig
  if (
    publishConfig === null ||
    Array.isArray(publishConfig) ||
    typeof publishConfig !== "object" ||
    Object.getPrototypeOf(publishConfig) !== Object.prototype ||
    !arraysEqual(Object.keys(publishConfig).sort(), ["access"]) ||
    publishConfig.access !== "public"
  ) {
    throw new Error("Packed publishConfig must contain public access only")
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const dependencies = manifest[field]
    if (dependencies === undefined) continue
    if (
      dependencies === null ||
      Array.isArray(dependencies) ||
      typeof dependencies !== "object" ||
      Object.getPrototypeOf(dependencies) !== Object.prototype
    ) {
      throw new TypeError(`Packed ${field} must be an object`)
    }
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (!isRegistryDependencySpecifier(specifier)) {
        throw new Error(`Packed dependency ${field}.${name} has an unsafe registry specifier`)
      }
    }
  }
}

export async function scanPreparedTarball(
  tarballPath,
  {
    maxEntries = RELEASE_PAYLOAD_LIMITS.tarEntries,
    maxExpandedBytes = RELEASE_PAYLOAD_LIMITS.tarExpandedBytes,
    createReadStreamImpl = createReadStream,
  } = {},
) {
  if (
    typeof tarballPath !== "string" ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > RELEASE_PAYLOAD_LIMITS.tarEntries ||
    !Number.isSafeInteger(maxExpandedBytes) ||
    maxExpandedBytes < 1 ||
    maxExpandedBytes > RELEASE_PAYLOAD_LIMITS.tarExpandedBytes ||
    typeof createReadStreamImpl !== "function"
  ) {
    throw new TypeError("Prepared tarball scan limits are invalid")
  }
  const input = createReadStreamImpl(tarballPath, {
    flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  })
  const gunzip = createGunzip()
  input.pipe(gunzip)
  let expandedBytes = 0
  let entries = 0
  let remainingContentBytes = 0
  let remainingPaddingBytes = 0
  let currentType
  let capturedPaxChunks = []
  let pendingPaxPath
  let header = Buffer.alloc(0)
  let zeroBlocks = 0
  try {
    for await (const rawChunk of gunzip) {
      const chunk = Buffer.from(rawChunk)
      expandedBytes += chunk.length
      if (expandedBytes > maxExpandedBytes) {
        throw new Error("Prepared tarball expanded byte limit exceeded")
      }
      let cursor = 0
      while (cursor < chunk.length) {
        if (remainingContentBytes > 0) {
          const consumed = Math.min(remainingContentBytes, chunk.length - cursor)
          if (currentType === "x") {
            capturedPaxChunks.push(Buffer.from(chunk.subarray(cursor, cursor + consumed)))
          }
          remainingContentBytes -= consumed
          cursor += consumed
          if (remainingContentBytes === 0 && remainingPaddingBytes === 0) finishEntry()
          continue
        }
        if (remainingPaddingBytes > 0) {
          const consumed = Math.min(remainingPaddingBytes, chunk.length - cursor)
          remainingPaddingBytes -= consumed
          cursor += consumed
          if (remainingPaddingBytes === 0) finishEntry()
          continue
        }
        const needed = 512 - header.length
        const consumed = Math.min(needed, chunk.length - cursor)
        header = Buffer.concat([header, chunk.subarray(cursor, cursor + consumed)])
        cursor += consumed
        if (header.length !== 512) continue
        if (header.every((byte) => byte === 0)) {
          zeroBlocks += 1
          header = Buffer.alloc(0)
          continue
        }
        if (zeroBlocks >= 2) throw new Error("Prepared tarball has data after its end marker")
        zeroBlocks = 0
        validateTarHeader(header)
        entries += 1
        if (entries > maxEntries) throw new Error("Prepared tarball entry count limit exceeded")
        const size = parseTarOctal(header.subarray(124, 136), "entry size")
        const type = String.fromCharCode(header[156] || 0x30)
        if (type === "1" || type === "2") {
          throw new Error("Prepared tarball contains a symlink or hardlink entry")
        }
        if (!["0", "5", "x"].includes(type)) {
          throw new Error(`Prepared tarball contains unsupported entry type ${type}`)
        }
        if (type === "x") {
          if (
            pendingPaxPath !== undefined ||
            size < 1 ||
            size > RELEASE_PAYLOAD_LIMITS.tarPaxHeaderBytes
          ) {
            throw new Error("Prepared tarball PAX path header is invalid or oversized")
          }
        } else {
          const name = pendingPaxPath ?? tarHeaderName(header)
          pendingPaxPath = undefined
          if (
            Buffer.byteLength(name, "utf8") > RELEASE_PAYLOAD_LIMITS.tarPathBytes ||
            !safePackageArchivePath(name)
          ) {
            throw new Error("Prepared tarball contains an unsafe archive path")
          }
        }
        currentType = type
        remainingContentBytes = size
        remainingPaddingBytes = (512 - (size % 512)) % 512
        capturedPaxChunks = []
        header = Buffer.alloc(0)
        if (remainingContentBytes === 0 && remainingPaddingBytes === 0) finishEntry()
      }
    }
  } finally {
    input.destroy()
    gunzip.destroy()
  }
  if (
    entries < 1 ||
    remainingContentBytes !== 0 ||
    remainingPaddingBytes !== 0 ||
    currentType !== undefined ||
    pendingPaxPath !== undefined ||
    header.length !== 0 ||
    zeroBlocks < 2
  ) {
    throw new Error("Prepared tarball is truncated or missing its end marker")
  }
  return Object.freeze({ entries, expandedBytes })

  function finishEntry() {
    if (currentType === "x") {
      pendingPaxPath = parsePaxPath(Buffer.concat(capturedPaxChunks))
    }
    currentType = undefined
    capturedPaxChunks = []
  }
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

function assertLoopbackRegistryUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("Release smoke registry must be an exact loopback URL")
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== LOOPBACK ||
    url.port === "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new TypeError("Release smoke registry must be an exact loopback URL")
  }
}

function isRegistryDependencySpecifier(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\0\r\n]/u.test(value)
  ) {
    return false
  }
  if (value.startsWith("npm:")) {
    const alias = value.slice(4)
    const separator = alias.lastIndexOf("@")
    if (separator < 1) return false
    const name = alias.slice(0, separator)
    const range = alias.slice(separator + 1)
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u.test(name)) {
      return false
    }
    return isRegistrySemverRange(range)
  }
  return isRegistrySemverRange(value)
}

function isRegistrySemverRange(value) {
  const version = String.raw`(?:0|[1-9][0-9]*|[xX*])(?:\.(?:0|[1-9][0-9]*|[xX*])){0,2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`
  const comparator = new RegExp(`^(?:[~^]|>=?|<=?|=)?v?${version}$`, "u")
  return value.split(/\s*\|\|\s*/u).every((alternative) => {
    const hyphen = alternative.split(/\s+-\s+/u)
    if (hyphen.length === 2) return hyphen.every((entry) => comparator.test(entry))
    if (hyphen.length > 2) return false
    const tokens = alternative.split(/\s+/u)
    return tokens.length > 0 && tokens.every((entry) => comparator.test(entry))
  })
}

function validateTarHeader(header) {
  const expected = parseTarOctal(header.subarray(148, 156), "checksum")
  const copy = Buffer.from(header)
  copy.fill(0x20, 148, 156)
  const actual = copy.reduce((total, byte) => total + byte, 0)
  if (actual !== expected) throw new Error("Prepared tarball header checksum is invalid")
}

function parseTarOctal(bytes, label) {
  const source = Buffer.from(bytes)
    .toString("ascii")
    .replace(/[\0 ]+$/u, "")
    .trimStart()
  if (!/^[0-7]+$/u.test(source)) throw new Error(`Prepared tarball ${label} is invalid`)
  const value = Number.parseInt(source, 8)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Prepared tarball ${label} is outside the safe range`)
  }
  return value
}

function tarHeaderName(header) {
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/su, "")
  const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/su, "")
  return prefix.length === 0 ? name : `${prefix}/${name}`
}

function parsePaxPath(bytes) {
  let cursor = 0
  let pathValue
  while (cursor < bytes.length) {
    const space = bytes.indexOf(0x20, cursor)
    if (space <= cursor) throw new Error("Prepared tarball PAX record length is invalid")
    const lengthSource = bytes.subarray(cursor, space).toString("ascii")
    if (!/^[1-9][0-9]*$/u.test(lengthSource)) {
      throw new Error("Prepared tarball PAX record length is invalid")
    }
    const length = Number(lengthSource)
    const end = cursor + length
    if (!Number.isSafeInteger(length) || end > bytes.length || bytes[end - 1] !== 0x0a) {
      throw new Error("Prepared tarball PAX record exceeds its header")
    }
    const equals = bytes.indexOf(0x3d, space + 1)
    if (equals < 0 || equals >= end - 1) {
      throw new Error("Prepared tarball PAX record is malformed")
    }
    const key = bytes.subarray(space + 1, equals).toString("ascii")
    if (key !== "path" || pathValue !== undefined) {
      throw new Error("Prepared tarball PAX header contains unsupported metadata")
    }
    try {
      pathValue = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(equals + 1, end - 1),
      )
    } catch (error) {
      throw new Error("Prepared tarball PAX path is not valid UTF-8", { cause: error })
    }
    cursor = end
  }
  if (
    pathValue === undefined ||
    Buffer.byteLength(pathValue, "utf8") > RELEASE_PAYLOAD_LIMITS.tarPathBytes ||
    !safePackageArchivePath(pathValue)
  ) {
    throw new Error("Prepared tarball PAX header contains an unsafe archive path")
  }
  return pathValue
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function formatError(error) {
  if (error instanceof AggregateError) return error.message
  return error instanceof Error ? error.message : String(error)
}
