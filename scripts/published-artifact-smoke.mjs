#!/usr/bin/env node

import { spawn } from "node:child_process"
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  assertInstalledCoreResolution,
  makeTempDir,
  normalizeCliArgs,
  npmView,
  readPublicPackages,
  removeDir,
  resolvePackageSet,
  resolveRequestedVersion,
} from "./lib/published-artifacts.mjs"
import { runTypeScriptToolingProbe as defaultRunTypeScriptToolingProbe } from "./lib/typescript-tooling-probe.mjs"

const NATIVE_BUILD_INDICATORS =
  /\b(?:node-gyp|prebuild|prebuild-install|node-pre-gyp|cmake-js|node-gyp-build|prebuildify)\b|gyp ERR!/i
const NATIVE_LIFECYCLE_INDICATORS =
  /\b(?:node-gyp|prebuild|prebuild-install|node-pre-gyp|cmake-js|node-gyp-build|prebuildify)\b|binding\.gyp/i
const NATIVE_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall"]
const REQUIRED_PGVECTOR_PACKAGES = new Set(["@dawn-ai/memory-pgvector", "@dawn-ai/langchain"])

export const TYPESCRIPT_VERSION = "7.0.2"
export const TSX_VERSION = "4.23.0"
export const ZOD_VERSION = "4.4.3"

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
  const options = parseArgs(normalizeCliArgs(process.argv.slice(2)))
  if (options.openai && !options.pgvector) {
    throw new Error("--openai requires --pgvector")
  }

  shouldRunOpenAiSmoke({ enabled: options.openai })

  await runPublishedArtifactSmoke(options)
}

export async function runPublishedArtifactSmoke(options, overrides = {}) {
  const dependencies = {
    assertDockerAvailable,
    assertInstalledCoreResolution,
    databaseUrlForPgvector,
    installTypeScriptTooling,
    makeTempDir,
    removeContainer,
    removeDir,
    runAgUiInstalledProbe,
    runCommand,
    runDockerSandboxInstalledProbe,
    runInstallSmoke,
    runRuntimeSmoke,
    runTypeScriptToolingProbe: defaultRunTypeScriptToolingProbe,
    selectedPackageVersions,
    startPgvector,
    waitForPgvector,
    ...overrides,
  }

  const tempDir = await dependencies.makeTempDir("dawn-published-smoke-")
  const containerName = `dawn-published-smoke-${process.pid}-${Date.now()}`
  let containerCleanupNeeded = false

  try {
    const selectedPackages = await dependencies.selectedPackageVersions(options)
    await dependencies.runInstallSmoke(tempDir, selectedPackages, {
      runCommand: dependencies.runCommand,
    })

    if (shouldRunAgUiProbe(selectedPackages)) {
      await dependencies.runAgUiInstalledProbe(tempDir)
    }

    if (shouldRunTypeScriptToolingProbe(selectedPackages)) {
      await dependencies.installTypeScriptTooling(tempDir, {
        runCommand: dependencies.runCommand,
      })
      const corePackage = selectedPackages.find(({ name }) => name === "@dawn-ai/core")
      await dependencies.assertInstalledCoreResolution({
        consumerRoot: tempDir,
        expectedCoreVersion: corePackage.version,
      })
      await dependencies.runTypeScriptToolingProbe({
        expectedTypeScriptVersion: TYPESCRIPT_VERSION,
        root: tempDir,
        runCommand: dependencies.runCommand,
      })
      console.log("T-TYPESCRIPT-TOOLING PASS")
    }

    if (selectedPackages.some(({ name }) => name === "@dawn-ai/sandbox")) {
      await dependencies.assertDockerAvailable()
      await dependencies.runDockerSandboxInstalledProbe(tempDir)
    }

    if (!options.pgvector) {
      console.log("T1 SKIP pgvector disabled")
      console.log(options.openai ? "T2 SKIP pgvector disabled" : "T2 SKIP")
      console.log("T3 SKIP pgvector disabled")
      return
    }

    assertRuntimePackages(selectedPackages.map((pkg) => pkg.name))
    await dependencies.assertDockerAvailable()
    containerCleanupNeeded = true
    await dependencies.startPgvector(containerName)
    const databaseUrl = await dependencies.databaseUrlForPgvector(containerName)
    await dependencies.waitForPgvector(containerName)
    await dependencies.runRuntimeSmoke(tempDir, { databaseUrl, openai: options.openai })
  } finally {
    if (containerCleanupNeeded) {
      await dependencies.removeContainer(containerName)
    }
    await dependencies.removeDir(tempDir)
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

export async function runInstallSmoke(tempDir, packages, overrides = {}) {
  const command = overrides.runCommand ?? runCommand
  await command("npm", ["init", "-y"], { cwd: tempDir })
  await command("npm", ["pkg", "set", "type=module"], { cwd: tempDir })

  const specs = packages.map((pkg) => `${pkg.name}@${pkg.version}`)
  const install = await command("npm", selectedPackageInstallArgs(packages), { cwd: tempDir })
  const installOutput = `${install.stdout}\n${install.stderr}`
  assertNoNativeInstallOutput(installOutput)

  assertNoNativeLifecycleScripts(
    await readInstalledPackageManifests(resolve(tempDir, "node_modules")),
  )

  for (const pkg of packages) {
    const manifest = JSON.parse(
      await readFile(
        resolve(tempDir, "node_modules", ...pkg.name.split("/"), "package.json"),
        "utf8",
      ),
    )
    if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
      throw new Error(
        `${pkg.name} installed identity ${manifest.name ?? "<unknown>"}@${manifest.version ?? "<unknown>"}, expected ${pkg.name}@${pkg.version}`,
      )
    }
  }

  console.log(`T0 PASS installed ${specs.join(" ")}`)
}

export function selectedPackageInstallArgs(packages) {
  return [
    "install",
    "--save-exact",
    "--package-lock=false",
    ...packages.map(({ name, version }) => `${name}@${version}`),
  ]
}

export function typescriptToolingInstallArgs() {
  return [
    "install",
    "--ignore-scripts",
    "--save-exact",
    "--package-lock=false",
    `typescript@${TYPESCRIPT_VERSION}`,
    `tsx@${TSX_VERSION}`,
    `zod@${ZOD_VERSION}`,
  ]
}

export async function installTypeScriptTooling(tempDir, overrides = {}) {
  const command = overrides.runCommand ?? runCommand
  await command("npm", typescriptToolingInstallArgs(), { cwd: tempDir })
  await assertInstalledPackageIdentities(tempDir, {
    tsx: TSX_VERSION,
    typescript: TYPESCRIPT_VERSION,
    zod: ZOD_VERSION,
  })
}

async function assertInstalledPackageIdentities(tempDir, expectedVersions) {
  for (const [packageName, expectedVersion] of Object.entries(expectedVersions)) {
    const manifestPath = resolve(tempDir, "node_modules", ...packageName.split("/"), "package.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    if (manifest.name !== packageName || manifest.version !== expectedVersion) {
      throw new Error(
        `${packageName} installed identity ${manifest.name ?? "<unknown>"}@${manifest.version ?? "<unknown>"}, expected ${packageName}@${expectedVersion}`,
      )
    }
  }
}

async function runAgUiInstalledProbe(tempDir) {
  await Promise.all([
    writeFile(resolve(tempDir, "smoke-ag-ui.mjs"), agUiEsmProbeSource(), "utf8"),
    writeFile(resolve(tempDir, "smoke-ag-ui.ts"), agUiTypeProbeSource(), "utf8"),
    writeFile(
      resolve(tempDir, "tsconfig.ag-ui.json"),
      `${JSON.stringify(agUiTypeScriptConfig(), null, 2)}\n`,
      "utf8",
    ),
  ])

  for (const { command, args } of agUiProbeCommands()) {
    await runCommand(command, args, { cwd: tempDir })
  }

  console.log("T-AG-UI PASS")
}

export function agUiProbeCommands() {
  return [
    { command: "node", args: ["smoke-ag-ui.mjs"] },
    { command: "npm", args: ["install", "--save-dev", "typescript@7.0.2"] },
    {
      command: "npm",
      args: ["exec", "--", "tsc", "--project", "tsconfig.ag-ui.json"],
    },
  ]
}

export function shouldRunAgUiProbe(packages) {
  return packages.some(({ name }) => name === "@dawn-ai/ag-ui")
}

export function shouldRunTypeScriptToolingProbe(packages) {
  const names = new Set(packages.map(({ name }) => name))
  return names.has("@dawn-ai/core") && names.has("@dawn-ai/vite-plugin")
}

export function agUiEsmProbeSource() {
  return `import assert from "node:assert/strict"

import * as root from "@dawn-ai/ag-ui"
import { encodeAgUiSse } from "@dawn-ai/ag-ui/sse"

assert.deepEqual(Object.keys(root).sort(), [
  "DAWN_PLAN_ACTIVITY_TYPE",
  "DAWN_SUBAGENT_ACTIVITY_TYPE",
  "createCounterIdFactory",
  "createDefaultIdFactory",
  "fromRunAgentInput",
  "toAguiEvents",
])

assert.equal(root.DAWN_PLAN_ACTIVITY_TYPE, "dawn.plan")
assert.equal(root.DAWN_SUBAGENT_ACTIVITY_TYPE, "dawn.subagent")

for (const exportName of [
  "createCounterIdFactory",
  "createDefaultIdFactory",
  "fromRunAgentInput",
  "toAguiEvents",
]) {
  assert.equal(typeof root[exportName], "function", \`canonical export \${exportName} must be a function\`)
}

const event = { type: "RUN_STARTED", threadId: "published-smoke", runId: "published-smoke" }
const encoded = encodeAgUiSse(event)
assert.equal(encoded, \`data: \${JSON.stringify(event)}\\n\\n\`)

const payload = JSON.parse(encoded.slice("data: ".length, -2))
assert.equal(payload.type, "RUN_STARTED")
assert.equal(payload.threadId, "published-smoke")
assert.equal(payload.runId, "published-smoke")
`
}

export function agUiTypeProbeSource() {
  return `import {
  DAWN_PLAN_ACTIVITY_TYPE,
  DAWN_SUBAGENT_ACTIVITY_TYPE,
  createCounterIdFactory,
  createDefaultIdFactory,
  fromRunAgentInput,
  toAguiEvents,
  type AguiOutboundEvent,
  type DawnAgentStreamChunk,
  type DawnInterruptEnvelope,
  type DawnMessage,
  type DawnPlanActivityContent,
  type DawnResumeRequest,
  type DawnRunInput,
  type DawnSubagentActivityContent,
  type IdFactory,
  type RunContext,
  type ToAguiOptions,
} from "@dawn-ai/ag-ui"
import { encodeAgUiSse as encodeAgUiSseFromSubpath } from "@dawn-ai/ag-ui/sse"

// @ts-expect-error MappedRunInput was removed from the canonical root
import type { MappedRunInput } from "@dawn-ai/ag-ui"
// @ts-expect-error ResumeDecision was removed from the canonical root
import type { ResumeDecision } from "@dawn-ai/ag-ui"
// @ts-expect-error AgUiTranslator was removed from the canonical root
import type { AgUiTranslator } from "@dawn-ai/ag-ui"
// @ts-expect-error AgUiEvent was removed from the canonical root
import type { AgUiEvent } from "@dawn-ai/ag-ui"
// @ts-expect-error DawnStreamChunk was removed from the canonical root
import type { DawnStreamChunk } from "@dawn-ai/ag-ui"
// @ts-expect-error DawnToolCallData was removed from the canonical root
import type { DawnToolCallData } from "@dawn-ai/ag-ui"
// @ts-expect-error DawnToolResultData was removed from the canonical root
import type { DawnToolResultData } from "@dawn-ai/ag-ui"
// @ts-expect-error RawChunk was removed from the canonical root
import type { RawChunk } from "@dawn-ai/ag-ui"
// @ts-expect-error TranslatorOptions was removed from the canonical root
import type { TranslatorOptions } from "@dawn-ai/ag-ui"

// @ts-expect-error createAgUiTranslator was removed from the canonical root
import { createAgUiTranslator } from "@dawn-ai/ag-ui"
// @ts-expect-error mapRunInput was removed from the canonical root
import { mapRunInput } from "@dawn-ai/ag-ui"
// @ts-expect-error encodeAgUiSse was removed from the canonical root
import { encodeAgUiSse } from "@dawn-ai/ag-ui"
// @ts-expect-error fromAguiResume was removed from the canonical root
import { fromAguiResume } from "@dawn-ai/ag-ui"
// @ts-expect-error toAguiInterrupt was removed from the canonical root
import { toAguiInterrupt } from "@dawn-ai/ag-ui"
// @ts-expect-error asToolCallData was removed from the canonical root
import { asToolCallData } from "@dawn-ai/ag-ui"
// @ts-expect-error asToolResultData was removed from the canonical root
import { asToolResultData } from "@dawn-ai/ag-ui"

type RootValueSurface = readonly [
  typeof DAWN_PLAN_ACTIVITY_TYPE,
  typeof DAWN_SUBAGENT_ACTIVITY_TYPE,
  typeof createCounterIdFactory,
  typeof createDefaultIdFactory,
  typeof fromRunAgentInput,
  typeof toAguiEvents,
]

type RootTypeSurface = readonly [
  IdFactory,
  DawnMessage,
  DawnRunInput,
  DawnInterruptEnvelope,
  DawnResumeRequest,
  AguiOutboundEvent,
  ToAguiOptions,
  DawnAgentStreamChunk,
  RunContext,
  DawnPlanActivityContent,
  DawnSubagentActivityContent,
]

declare const rootTypeSurface: RootTypeSurface
declare const rootValueSurface: RootValueSurface
const idFactory: IdFactory = createCounterIdFactory()
const chunk: DawnAgentStreamChunk = { type: "token", data: "hello" }
const context: RunContext = { threadId: "published-smoke", runId: "published-smoke" }
const options: ToAguiOptions = { idFactory }
const encoder: typeof encodeAgUiSseFromSubpath = encodeAgUiSseFromSubpath
const planActivity: DawnPlanActivityContent = {
  todos: [{ content: "Search the corpus", status: "in_progress" }],
}
const subagentActivity: DawnSubagentActivityContent = {
  name: "researcher",
  depth: 1,
  status: "running",
  todos: planActivity.todos,
  tools: [{ name: "searchCorpus", status: "completed" }],
  totalToolCount: 1,
}
const planActivityType: "dawn.plan" = DAWN_PLAN_ACTIVITY_TYPE
const subagentActivityType: "dawn.subagent" = DAWN_SUBAGENT_ACTIVITY_TYPE

void [
  rootValueSurface,
  rootTypeSurface,
  chunk,
  context,
  options,
  encoder,
  planActivity,
  subagentActivity,
  planActivityType,
  subagentActivityType,
]
`
}

export function agUiTypeScriptConfig() {
  return {
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      strict: true,
      target: "ES2022",
    },
    files: ["smoke-ag-ui.ts"],
  }
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
        failures.push(
          `${packageLabel(manifest)} ${scriptName}: ${script}${entry.path ? ` (${entry.path})` : ""}`,
        )
      }
    }

    if (entry.hasBindingGyp) {
      failures.push(
        `${packageLabel(manifest)} binding.gyp: ${entry.bindingGypPath ?? "binding.gyp"}`,
      )
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

  throw new Error(
    `pgvector container did not become ready:\n${lastError?.message ?? "no readiness output"}`,
  )
}

async function removeContainer(containerName) {
  try {
    await runCommand("docker", ["rm", "-f", containerName])
  } catch (error) {
    console.error(`WARN failed to remove Docker container ${containerName}: ${error.message}`)
  }
}

export async function runDockerSandboxInstalledProbe(tempDir) {
  await writeFile(
    resolve(tempDir, "smoke-docker-sandbox.mjs"),
    dockerSandboxInstalledProbeSource(),
    "utf8",
  )
  const result = await runCommand("node", ["smoke-docker-sandbox.mjs"], { cwd: tempDir })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
}

export function dockerSandboxInstalledProbeSource() {
  return `import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFile, rm } from "node:fs/promises"
import { promisify } from "node:util"

import { dockerSandbox } from "@dawn-ai/sandbox"

const execFileAsync = promisify(execFile)
const pidsLimit = 32
const recoveryCommands = 24
const threadId = "published-pid-" + process.pid + "-" + Date.now()
const container = "dawn-sbx-" + threadId
const readinessPath = "/workspace/.published-pids-ready.json"
const readinessTemporaryPath = readinessPath + ".tmp"
const localReadinessPath = ".published-pids-ready-" + process.pid + ".json"
const sentinelPath = "/workspace/published-pid-sentinel.txt"
const sentinel = "sentinel-" + Date.now()
const context = (workspaceRoot) => ({ signal: new AbortController().signal, workspaceRoot })

async function docker(args) {
  try {
    const result = await execFileAsync("docker", args, { maxBuffer: 1024 * 1024 })
    return { exitCode: 0, stderr: result.stderr, stdout: result.stdout }
  } catch (error) {
    return {
      exitCode: typeof error?.code === "number" ? error.code : 1,
      stderr: String(error?.stderr ?? error?.message ?? error),
      stdout: String(error?.stdout ?? ""),
    }
  }
}

async function inspectKeeperId() {
  const result = await docker(["inspect", "--format", "{{.Id}}", container])
  assert.equal(result.exitCode, 0, JSON.stringify(result))
  assert.ok(result.stdout.trim(), "keeper inspect returned no ID")
  return result.stdout.trim()
}

async function waitForReadiness() {
  const deadline = Date.now() + 10_000
  let lastResult
  while (Date.now() < deadline) {
    await rm(localReadinessPath, { force: true })
    lastResult = await docker(["cp", container + ":" + readinessPath, localReadinessPath])
    if (lastResult.exitCode === 0) {
      return JSON.parse(await readFile(localReadinessPath, "utf8"))
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("published Docker sandbox PID saturation was not ready: " + JSON.stringify(lastResult))
}

const saturator = [
  'const { renameSync, rmSync, writeFileSync } = require("node:fs")',
  'const { Worker } = require("node:worker_threads")',
  'let started = 0',
  'let settled = false',
  'const workers = []',
  'rmSync("/workspace/.published-pids-ready.json.tmp", { force: true })',
  'rmSync("/workspace/.published-pids-ready.json", { force: true })',
  'function publish(status) { writeFileSync("/workspace/.published-pids-ready.json.tmp", JSON.stringify(status)); renameSync("/workspace/.published-pids-ready.json.tmp", "/workspace/.published-pids-ready.json") }',
  'const keepAlive = setInterval(() => {}, 1000)',
  'const deadline = setTimeout(() => { settled = true; publish({ status: "failed", reason: "deadline", started }); clearInterval(keepAlive); process.exit(88) }, 5000)',
  'function fail(reason, error) { if (settled) return; settled = true; clearTimeout(deadline); publish({ status: "failed", reason, code: error && error.code, started }); clearInterval(keepAlive); process.exit(89) }',
  'function launch() {',
  '  if (settled) return',
  '  if (started >= 128) { fail("attempt-limit"); return }',
  '  let worker',
  '  try { worker = new Worker("setInterval(() => {}, 1000)", { eval: true }) }',
  '  catch (error) {',
  '    const message = String(error && error.message)',
  '    if (error.code !== "ERR_WORKER_INIT_FAILED" || !message.includes("EAGAIN")) { fail("unexpected-worker-error", error); return }',
  '    settled = true; clearTimeout(deadline); publish({ status: "ready", code: error.code, message, started }); return',
  '  }',
  '  worker.once("online", () => { workers.push(worker); started += 1; launch() })',
  '  worker.once("error", (error) => fail("worker-runtime-error", error))',
  '}',
  'launch()',
].join("\\n")

const provider = dockerSandbox({ image: "node:22-slim" })
try {
  const handle = await provider.acquire({
    threadId,
    policy: { network: { mode: "deny" }, security: { pidsLimit } },
    signal: context("/").signal,
  })
  await handle.filesystem.writeFile(sentinelPath, sentinel, context(handle.workspaceRoot))
  const originalKeeperId = await inspectKeeperId()

  const detached = await docker(["exec", "-d", container, "node", "-e", saturator])
  assert.equal(detached.exitCode, 0, JSON.stringify(detached))
  const readiness = await waitForReadiness()
  assert.equal(readiness.status, "ready", JSON.stringify(readiness))
  assert.equal(readiness.code, "ERR_WORKER_INIT_FAILED")
  assert.match(String(readiness.message), /EAGAIN/)

  const saturated = await docker(["stats", "--no-stream", "--format", "{{.PIDs}}", container])
  assert.equal(saturated.exitCode, 0, JSON.stringify(saturated))
  assert.equal(saturated.stdout.trim(), String(pidsLimit))

  const recovered = await Promise.all(
    Array.from({ length: recoveryCommands }, (_, index) =>
      handle.exec.runCommand({ command: "echo recovered-" + index }, context(handle.workspaceRoot)),
    ),
  )
  for (const [index, result] of recovered.entries()) {
    assert.equal(result.exitCode, 0, JSON.stringify(result))
    assert.equal(result.stdout, "recovered-" + index + "\\n")
    assert.equal(result.stderr, "")
  }

  const replacementKeeperId = await inspectKeeperId()
  assert.notEqual(replacementKeeperId, originalKeeperId, "PID-exhausted keeper was not replaced")
  assert.equal(
    await handle.filesystem.readFile(sentinelPath, context(handle.workspaceRoot)),
    sentinel,
  )
  console.log("T-DOCKER-SANDBOX PASS")
} finally {
  await provider.destroy(threadId)
  await rm(localReadinessPath, { force: true })
}
`
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
  return `import assert from "node:assert/strict"

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
