#!/usr/bin/env node

import { spawn } from "node:child_process"
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  makeTempDir,
  npmView,
  readPublicPackages,
  removeDir,
  resolvePackageSet,
  resolveRequestedVersion,
} from "./lib/published-artifacts.mjs"

const NATIVE_BUILD_INDICATORS =
  /\b(?:node-gyp|prebuild|prebuild-install|node-pre-gyp|cmake-js|node-gyp-build|prebuildify)\b|gyp ERR!/i
const NATIVE_LIFECYCLE_INDICATORS =
  /\b(?:node-gyp|prebuild|prebuild-install|node-pre-gyp|cmake-js|node-gyp-build|prebuildify)\b|binding\.gyp/i
const NATIVE_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall"]
const REQUIRED_PGVECTOR_PACKAGES = new Set([
  "@dawn-ai/memory-pgvector",
  "@dawn-ai/langchain",
])

export function shouldRunOpenAiSmoke({ enabled, env = process.env }) {
  if (!enabled) {
    return { status: "skip" }
  }

  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when --openai is enabled")
  }

  return { status: "run" }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.openai && !options.pgvector) {
    throw new Error("--openai requires --pgvector")
  }

  shouldRunOpenAiSmoke({ enabled: options.openai })

  const tempDir = await makeTempDir("dawn-published-smoke-")
  const containerName = `dawn-published-smoke-${process.pid}-${Date.now()}`
  let containerCleanupNeeded = false

  try {
    const selectedPackages = await selectedPackageVersions(options)
    await runInstallSmoke(tempDir, selectedPackages)

    if (!options.pgvector) {
      console.log("T1 SKIP pgvector disabled")
      console.log(options.openai ? "T2 SKIP pgvector disabled" : "T2 SKIP")
      console.log("T3 SKIP pgvector disabled")
      return
    }

    assertRuntimePackages(selectedPackages.map((pkg) => pkg.name))
    await assertDockerAvailable()
    containerCleanupNeeded = true
    await startPgvector(containerName)
    const databaseUrl = await databaseUrlForPgvector(containerName)
    await waitForPgvector(containerName)
    await runRuntimeSmoke(tempDir, { databaseUrl, openai: options.openai })
  } finally {
    if (containerCleanupNeeded) {
      await removeContainer(containerName)
    }
    await removeDir(tempDir)
  }
}

function parseArgs(args) {
  const parsed = {
    openai: false,
    packageSet: "memory-pgvector-core",
    pgvector: false,
    version: "latest",
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === "--openai") {
      parsed.openai = true
      continue
    }

    if (arg === "--pgvector") {
      parsed.pgvector = true
      continue
    }

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

async function selectedPackageVersions(options) {
  const publicPackages = await readPublicPackages()
  const packageNames = resolvePackageSet(options.packageSet, publicPackages)
  const resolved = []

  for (const packageName of packageNames) {
    const { versions, tags } = await npmView(packageName)
    const version = resolveRequestedVersion({ requested: options.version, tags })
    if (!versions.includes(version)) {
      throw new Error(`${packageName}@${version} is not present in npm versions`)
    }

    resolved.push({ name: packageName, version })
  }

  return resolved
}

async function runInstallSmoke(tempDir, packages) {
  await runCommand("npm", ["init", "-y"], { cwd: tempDir })
  await runCommand("npm", ["pkg", "set", "type=module"], { cwd: tempDir })

  const specs = packages.map((pkg) => `${pkg.name}@${pkg.version}`)
  const install = await runCommand("npm", ["install", ...specs], { cwd: tempDir })
  const installOutput = `${install.stdout}\n${install.stderr}`
  assertNoNativeInstallOutput(installOutput)

  assertNoNativeLifecycleScripts(await readInstalledPackageManifests(resolve(tempDir, "node_modules")))

  for (const pkg of packages) {
    const manifest = JSON.parse(
      await readFile(resolve(tempDir, "node_modules", ...pkg.name.split("/"), "package.json"), "utf8"),
    )
    if (manifest.version !== pkg.version) {
      throw new Error(`${pkg.name} installed version ${manifest.version}, expected ${pkg.version}`)
    }
  }

  console.log(`T0 PASS installed ${specs.join(" ")}`)
}

export function assertNoNativeInstallOutput(output) {
  if (NATIVE_BUILD_INDICATORS.test(output)) {
    throw new Error("npm install output contained native build indicators")
  }
}

export function assertNoNativeLifecycleScripts(manifests) {
  const failures = []

  for (const entry of manifests) {
    const manifest = entry.manifest ?? entry.packageJson ?? entry

    for (const scriptName of NATIVE_LIFECYCLE_SCRIPTS) {
      const script = manifest.scripts?.[scriptName]
      if (typeof script === "string" && NATIVE_LIFECYCLE_INDICATORS.test(script)) {
        failures.push(`${packageLabel(manifest)} ${scriptName}: ${script}${entry.path ? ` (${entry.path})` : ""}`)
      }
    }

    if (entry.hasBindingGyp) {
      failures.push(`${packageLabel(manifest)} binding.gyp: ${entry.bindingGypPath ?? "binding.gyp"}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`Native build indicators detected: ${failures.join("; ")}`)
  }
}

export async function readInstalledPackageManifests(nodeModulesDir) {
  const manifests = []
  await collectNodeModulesPackageManifests(nodeModulesDir, manifests)
  return manifests
}

async function collectNodeModulesPackageManifests(nodeModulesDir, manifests) {
  let entries
  try {
    entries = await readdir(nodeModulesDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === "ENOENT") {
      return
    }
    throw error
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".bin") {
      continue
    }

    const packageRoot = resolve(nodeModulesDir, entry.name)
    if (entry.name.startsWith("@")) {
      await collectNodeModulesPackageManifests(packageRoot, manifests)
      continue
    }

    await collectPackageManifest(packageRoot, manifests)
  }
}

async function collectPackageManifest(packageRoot, manifests) {
  const packageJsonPath = resolve(packageRoot, "package.json")
  let manifest
  try {
    manifest = JSON.parse(await readFile(packageJsonPath, "utf8"))
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error
    }
  }

  if (manifest) {
    const bindingGypPath = resolve(packageRoot, "binding.gyp")
    manifests.push({
      bindingGypPath,
      hasBindingGyp: await fileExists(bindingGypPath),
      manifest,
      packageRoot,
      path: packageJsonPath,
    })
  }

  await collectNodeModulesPackageManifests(resolve(packageRoot, "node_modules"), manifests)
}

async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false
    }
    throw error
  }
}

function packageLabel(manifest) {
  return `${manifest.name ?? "<unknown>"}${manifest.version ? `@${manifest.version}` : ""}`
}

function assertRuntimePackages(packageNames) {
  for (const packageName of REQUIRED_PGVECTOR_PACKAGES) {
    if (!packageNames.includes(packageName)) {
      throw new Error(`--pgvector requires ${packageName} in the selected package set`)
    }
  }
}

async function assertDockerAvailable() {
  try {
    await runCommand("docker", ["info"])
  } catch (error) {
    throw new Error(`Docker is required for --pgvector but docker info failed:\n${error.message}`)
  }
}

async function startPgvector(containerName) {
  await runCommand("docker", [
    "run",
    "-d",
    "--name",
    containerName,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-p",
    "127.0.0.1::5432",
    "pgvector/pgvector:pg16",
  ])
}

async function databaseUrlForPgvector(containerName) {
  const mapped = await mappedPgvectorHostPort(containerName)
  console.log(`PGVECTOR HOST ${mapped.host}`)
  console.log(`PGVECTOR PORT ${mapped.port}`)
  return pgvectorDatabaseUrl(mapped)
}

async function mappedPgvectorHostPort(containerName) {
  const result = await runCommand("docker", ["port", containerName, "5432/tcp"])
  return parseDockerMappedHostPort(result.stdout)
}

export function parseDockerMappedHostPort(output) {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    const match = trimmed.match(/^\[([^\]]+)\]:(\d+)$/) ?? trimmed.match(/^(.*):(\d+)$/)
    if (match) {
      return {
        host: normalizeDockerMappedHost(match[1]),
        port: Number(match[2]),
      }
    }
  }

  throw new Error(`Could not parse mapped host and port from docker port output: ${output.trim()}`)
}

function normalizeDockerMappedHost(host) {
  if (host === "0.0.0.0" || host === "::") {
    return "127.0.0.1"
  }

  return host
}

export function pgvectorDatabaseUrl({ host, port }) {
  return `postgres://postgres:postgres@${formatDatabaseUrlHost(host)}:${port}/postgres`
}

function formatDatabaseUrlHost(host) {
  return host.includes(":") ? `[${host}]` : host
}

async function waitForPgvector(containerName) {
  const deadline = Date.now() + 60_000
  let lastError

  while (Date.now() < deadline) {
    try {
      await runCommand("docker", ["exec", containerName, "pg_isready", "-U", "postgres"])
      return
    } catch (error) {
      lastError = error
      await sleep(1_000)
    }
  }

  throw new Error(`pgvector container did not become ready:\n${lastError?.message ?? "no readiness output"}`)
}

async function removeContainer(containerName) {
  try {
    await runCommand("docker", ["rm", "-f", containerName])
  } catch (error) {
    console.error(`WARN failed to remove Docker container ${containerName}: ${error.message}`)
  }
}

async function runRuntimeSmoke(tempDir, options) {
  await writeFile(resolve(tempDir, "smoke-runtime.mjs"), runtimeSmokeSource(), "utf8")
  const runtime = await runCommand("node", ["smoke-runtime.mjs"], {
    cwd: tempDir,
    env: runtimeEnv(
      {
        DATABASE_URL: options.databaseUrl,
        RUN_OPENAI: options.openai ? "1" : "0",
        SMOKE_TABLE_PREFIX: `dawn_published_smoke_${process.pid}_${Date.now()}`,
      },
      { includeOpenAi: options.openai },
    ),
    includeOpenAi: options.openai,
  })
  process.stdout.write(runtime.stdout)
  process.stderr.write(runtime.stderr)
}

function runtimeEnv(extra, options = {}) {
  const { OPENAI_API_KEY: _openAiApiKey, ...base } = process.env
  return {
    ...base,
    ...(options.includeOpenAi ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
    ...extra,
  }
}

function runtimeSmokeSource() {
  return String.raw`import assert from "node:assert/strict"

import { openaiEmbedder } from "@dawn-ai/langchain"
import { pgvectorMemoryStore } from "@dawn-ai/memory-pgvector"

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("DATABASE_URL is required")
}

const namespace = "workspace=published-smoke|route=/smoke|"
const tablePrefix = process.env.SMOKE_TABLE_PREFIX ?? "dawn_published_smoke"
const shippingContent = "the customer wants faster shipping on their orders"

function record(id, content) {
  const now = new Date().toISOString()
  return {
    id,
    kind: "semantic",
    namespace,
    content,
    data: { subject: "shipping", preference: "faster" },
    source: { type: "eval", id: "published-artifact-smoke" },
    confidence: 1,
    tags: ["shipping"],
    createdAt: now,
    updatedAt: now,
    status: "active",
  }
}

async function runNoKeySmoke() {
  const store = pgvectorMemoryStore({ connectionString, dimensions: 1536, tablePrefix })
  const storeAgain = pgvectorMemoryStore({ connectionString, dimensions: 1536, tablePrefix })

  try {
    await store.put(record("memory_keyword_shipping", shippingContent))

    const hits = await store.search({ namespace, query: "faster shipping", limit: 3 })
    assert(
      hits.some((hit) => hit.content.includes("faster shipping")),
      "keyword recall missed stored fact",
    )

    await storeAgain.search({ namespace, query: "shipping", limit: 1 })
    console.log("T1 PASS")
  } finally {
    await storeAgain.close()
    await store.close()
  }
}

function runDimensionSmoke() {
  assert.throws(
    () => pgvectorMemoryStore({ connectionString, dimensions: 4001, tablePrefix }),
    (error) =>
      String(error?.message ?? error).includes("4000") &&
      String(error?.message ?? error).includes("halfvec"),
  )
  console.log("T3 PASS")
}

async function runOpenAiSmoke() {
  const embedder = openaiEmbedder()
  assert.equal(embedder.dims, 1536)

  const [probe] = await embedder.embed(["published artifact smoke probe"])
  assert(probe instanceof Float32Array, "probe embed did not return Float32Array")
  assert.equal(probe.length, 1536)

  const store = pgvectorMemoryStore({ connectionString, dimensions: 1536, tablePrefix })
  try {
    const [embedding] = await embedder.embed([shippingContent])
    assert(embedding instanceof Float32Array, "memory embed did not return Float32Array")
    assert.equal(embedding.length, 1536)

    await store.put(record("memory_openai_shipping", shippingContent), {
      embedding,
      embeddingModel: embedder.id,
    })

    const [queryEmbedding] = await embedder.embed(["expedite delivery options"])
    assert(queryEmbedding instanceof Float32Array, "query embed did not return Float32Array")
    assert.equal(queryEmbedding.length, 1536)

    const hits = await store.search({
      namespace,
      query: "expedite delivery options",
      queryEmbedding,
      embedderId: embedder.id,
      limit: 5,
    })

    assert(
      hits.some((hit) => hit.id === "memory_openai_shipping" && hit.content === shippingContent),
      "OpenAI paraphrase recall missed stored fact",
    )
    console.log("T2 PASS")
  } finally {
    await store.close()
  }
}

await runNoKeySmoke()

if (process.env.RUN_OPENAI === "1") {
  await runOpenAiSmoke()
} else {
  console.log("T2 SKIP")
}

runDimensionSmoke()
`
}

export async function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: childProcessEnv(options.env ?? process.env, { includeOpenAi: options.includeOpenAi }),
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr })
        return
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      )
    })
  })
}

function childProcessEnv(env, options = {}) {
  const { OPENAI_API_KEY: openAiApiKey, ...sanitized } = env
  if (options.includeOpenAi && openAiApiKey !== undefined) {
    return { ...sanitized, OPENAI_API_KEY: openAiApiKey }
  }

  return sanitized
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    console.error(`SMOKE FAIL ${error.message}`)
    process.exitCode = 1
  }
}
