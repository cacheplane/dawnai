import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, posix, resolve, win32 } from "node:path"

import { type SpawnProcessResult, spawnProcess } from "../../packages/devkit/src/testing/index.ts"
import {
  removeEnvironmentVariables,
  SpawnProcessError,
} from "../../packages/devkit/src/testing/process.ts"
import { terminateSubprocess } from "../../packages/testing/src/subprocess.ts"
import {
  allocatePort,
  appendDevServerTranscript,
  type DevServerHandle,
  delay,
  startDevServer,
} from "../runtime/support/dev-server.ts"
import { getTestRegistryUrl } from "./local-registry.ts"
import { candidateRegistryNpmArgs, writeRegistryNpmrc } from "./scaffold-packaging.ts"

const REPO_ROOT = resolve(import.meta.dirname, "../..")
const PACKAGED_COMMAND_TIMEOUT_MS = 180_000
const PACKAGED_NPM_READY_TIMEOUT_MS = 60_000
// On abort, `awaitWithAbort` stops WAITING on the action but the action keeps
// unwinding — and a nested `withPackagedNpmServer` call is exactly such an
// action, with a live child process of its own. Measured: the outer settled 29ms
// after abort while the inner child stayed alive another 500-1000ms. Tearing
// down before the action settles loses LIFO order and lets two children append
// to one transcript at once.
//
// This does NOT budget for reaping a child — it budgets for a nested session's
// ENTIRE `finally`: that session's own settle, then its `terminateSubprocess`,
// then its transcript append. `terminateSubprocess` defaults to graceMs 2_000 +
// forceMs 2_000 (`packages/testing/src/subprocess.ts:20-24`) and this file
// passes no timings, so a child that needs SIGKILL puts a hard 4s floor under
// the wait. 5_000 sits ~1s above that floor.
//
// So do not trim this toward what the tests appear to need. The nested fixture
// releases its port after 600ms, and any value at or above ~1s keeps that test
// green — while breaking the LIFO/transcript invariant the first time a real
// inner child escalates to SIGKILL, which T11 concedes happens under CI
// contention. (The "~1.2s for a `next dev` group" figure this constant once
// cited does not reproduce: five runs through the real `terminateSubprocess` at
// load average 21.65 gave 56/57/60/134/145ms with zero survivors. It was never
// the right bound anyway.)
const PACKAGED_NPM_ACTION_SETTLE_MS = 5_000
export const GENERATED_APP_UNSET_ENV = [
  "DAWN_DEMO_DOCKER_SANDBOX",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
] as const

export interface NpmLaunch {
  readonly argsPrefix: readonly string[]
  readonly command: string
  readonly displayCommand: "npm"
}

export function resolveNpmLaunch(
  options: {
    readonly execPath?: string
    readonly pathExists?: (path: string) => boolean
    readonly platform?: NodeJS.Platform
  } = {},
): NpmLaunch {
  const execPath = options.execPath ?? process.execPath
  const pathExists = options.pathExists ?? existsSync
  const platform = options.platform ?? process.platform
  const pathApi = platform === "win32" ? win32 : posix
  const nodeDir = pathApi.dirname(execPath)
  const candidates =
    platform === "win32"
      ? [
          pathApi.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
          pathApi.resolve(nodeDir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
          pathApi.resolve(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
        ]
      : [
          pathApi.resolve(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
          pathApi.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
          pathApi.resolve(nodeDir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
        ]
  const npmCliPath = candidates.find(pathExists)

  if (npmCliPath === undefined) {
    throw new Error(
      `Could not resolve npm CLI for Node executable ${execPath}; checked:\n${candidates.join("\n")}`,
    )
  }

  return { argsPrefix: [npmCliPath], command: execPath, displayCommand: "npm" }
}

export interface TrackedTempDir {
  path: string
  preserve: boolean
}

export interface PackagedDevServerSession {
  readonly devServer: DevServerHandle
  readonly url: string
}

export async function createTrackedTempDir(
  prefix: string,
  registry: TrackedTempDir[],
): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  registry.push({ path, preserve: false })
  return path
}

export function markTrackedTempDirForPreserve(registry: TrackedTempDir[], path: string): void {
  const tracked = registry.find((entry) => entry.path === path)

  if (tracked) {
    tracked.preserve = true
  }
}

export async function cleanupTrackedTempDirs(registry: TrackedTempDir[]): Promise<void> {
  const tracked = registry.splice(0)

  await Promise.all(
    tracked
      .filter((entry) => !entry.preserve)
      // maxRetries handles the ENOTEMPTY race where a just-killed dev server's
      // child flushes a SQLite WAL file into .dawn/ between readdir and rmdir.
      .map((entry) =>
        rm(entry.path, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }),
      ),
  )
}

/**
 * Pack the CURRENT create-dawn-ai-app source and install it into a temp installer
 * dir, returning that dir. Lets a standalone test run `pnpm exec create-dawn-ai-app`
 * with the local build (not the published npmjs version).
 *
 * The scaffolder declares `@dawn-ai/devkit` as a runtime dep. Pack and override
 * the current local devkit too so tests exercise the templates in this checkout
 * instead of whatever candidate package the ephemeral registry last published.
 * Requires the registry globalSetup to have run (DAWN_TEST_REGISTRY_URL set);
 * getTestRegistryUrl() throws otherwise.
 */
export async function installPackagedScaffolder(
  tempRoot: string,
): Promise<{ installerDir: string }> {
  const packsDir = join(tempRoot, "packs")
  const installerDir = join(tempRoot, "installer")

  await mkdir(packsDir, { recursive: true })
  await mkdir(installerDir, { recursive: true })

  const devkitTarballPath = await packCurrentPackage("@dawn-ai/devkit", packsDir)
  const scaffolderTarballPath = await packCurrentPackage("create-dawn-ai-app", packsDir)

  await writeFile(
    join(installerDir, "package.json"),
    `${JSON.stringify({ name: "installer", private: true }, null, 2)}\n`,
    "utf8",
  )
  await writeFile(
    join(installerDir, "pnpm-workspace.yaml"),
    [
      "packages:",
      "  - .",
      "",
      "onlyBuiltDependencies:",
      "  - esbuild",
      "",
      "allowBuilds:",
      "  esbuild: true",
      "",
      "overrides:",
      `  "@dawn-ai/devkit": ${JSON.stringify(`file:${devkitTarballPath}`)}`,
      "",
    ].join("\n"),
    "utf8",
  )

  await runPackagedCommand({
    args: ["add", devkitTarballPath, scaffolderTarballPath],
    command: "pnpm",
    cwd: installerDir,
    env: { npm_config_registry: getTestRegistryUrl() },
  })

  return { installerDir }
}

export async function installRegistryScaffolderWithNpm(options: {
  readonly signal?: AbortSignal
  readonly tempRoot: string
  readonly transcriptPath: string
}): Promise<{ readonly installerDir: string }> {
  const installerDir = join(options.tempRoot, "installer")

  await mkdir(installerDir, { recursive: true })
  await writeFile(
    join(installerDir, "package.json"),
    `${JSON.stringify({ name: "installer", private: true }, null, 2)}\n`,
    "utf8",
  )
  await writeRegistryNpmrc(installerDir, getTestRegistryUrl())
  const displayArgs = ["install", "--no-save", "create-dawn-ai-app@latest"]
  await runPackagedNpmCommand({
    args: [...candidateRegistryNpmArgs(getTestRegistryUrl()), ...displayArgs],
    cwd: installerDir,
    displayArgs,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    transcriptPath: options.transcriptPath,
  })

  return { installerDir }
}

async function packCurrentPackage(packageName: string, packsDir: string): Promise<string> {
  await runPackagedCommand({
    args: ["--filter", packageName, "build"],
    command: "pnpm",
    cwd: REPO_ROOT,
  })

  const packResult = await runPackagedCommand({
    args: ["--filter", packageName, "pack", "--pack-destination", packsDir],
    command: "pnpm",
    cwd: REPO_ROOT,
  })

  const tarballName = packResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => line.endsWith(".tgz"))

  if (!tarballName) {
    throw new Error(
      `Could not determine tarball name for ${packageName} from pnpm pack stdout:\n${packResult.stdout}`,
    )
  }

  return join(packsDir, basename(tarballName))
}

export async function runPackagedCommand(options: {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly displayArgs?: readonly string[]
  readonly displayCommand?: string
  readonly env?: NodeJS.ProcessEnv
  readonly shell?: boolean | string
  readonly signal?: AbortSignal
  readonly stdin?: string
  readonly timeoutMs?: number
  readonly transcriptPath?: string
  readonly unsetEnv?: readonly string[]
}) {
  const displayArgs = options.displayArgs ?? options.args
  const displayCommand = options.displayCommand ?? options.command
  let result: SpawnProcessResult
  let commandError: unknown
  try {
    result = await spawnProcess({
      args: options.args,
      command: options.command,
      cwd: options.cwd,
      env: {
        // Suppress Node.js experimental-feature warnings (e.g. node:sqlite)
        // so the harness does not treat non-empty stderr as a failure.
        NODE_NO_WARNINGS: "1",
        ...options.env,
      },
      ...(options.shell !== undefined ? { shell: options.shell } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      timeoutMs: options.timeoutMs ?? PACKAGED_COMMAND_TIMEOUT_MS,
      ...(options.unsetEnv ? { unsetEnv: options.unsetEnv } : {}),
    })
  } catch (error) {
    if (!(error instanceof SpawnProcessError)) throw error
    result = error.result
    commandError = error
  }

  if (!result.ok && commandError === undefined) {
    const failure = result.aborted
      ? `Command aborted: ${displayCommand} ${displayArgs.join(" ")}`
      : result.timedOut
        ? `Command timed out after ${result.timeoutMs}ms: ${displayCommand} ${displayArgs.join(" ")}`
        : `Command failed: ${displayCommand} ${displayArgs.join(" ")}`
    const message = [failure, result.stdout, result.stderr].filter(Boolean).join("\n")
    commandError = result.aborted
      ? new Error(message, { cause: result.abortReason })
      : new Error(message)
  }

  let transcriptError: unknown
  if (options.transcriptPath) {
    try {
      await appendPackagedCommandTranscript({
        displayArgs,
        displayCommand,
        result,
        transcriptPath: options.transcriptPath,
      })
    } catch (error) {
      transcriptError = error
    }
  }

  if (commandError !== undefined && transcriptError !== undefined) {
    throw new AggregateError(
      [commandError, transcriptError],
      "Packaged command failed and transcript recording also failed",
      { cause: commandError },
    )
  }
  if (commandError !== undefined) throw commandError
  if (transcriptError !== undefined) throw transcriptError
  return result
}

async function appendPackagedCommandTranscript(options: {
  readonly displayArgs: readonly string[]
  readonly displayCommand: string
  readonly result: SpawnProcessResult
  readonly transcriptPath: string
}): Promise<void> {
  const exitState = options.result.spawnFailed
    ? "[exit unavailable signal none]"
    : options.result.terminationFailed &&
        options.result.exitCode === null &&
        options.result.signal === null
      ? "[exit pending signal pending]"
      : `[exit ${options.result.exitCode}]`

  await appendFile(
    options.transcriptPath,
    [
      `$ (cd ${options.result.cwd} && ${options.displayCommand} ${options.displayArgs.join(" ")})`,
      options.result.stdout.trimEnd(),
      options.result.stderr.trimEnd(),
      options.result.aborted ? `[aborted: ${formatError(options.result.abortReason)}]` : "",
      options.result.timedOut ? `[timed out after ${options.result.timeoutMs}ms]` : "",
      options.result.spawnFailed ? `[spawn error ${formatError(options.result.spawnError)}]` : "",
      options.result.terminationFailed
        ? `[termination error ${formatError(options.result.terminationError)}]`
        : "",
      exitState,
      "",
    ]
      .filter((chunk, index, chunks) => chunk.length > 0 || index === chunks.length - 1)
      .join("\n"),
    "utf8",
  )
}

export async function runPackagedNpmCommand(options: {
  readonly args: readonly string[]
  readonly cwd: string
  readonly displayArgs?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly stdin?: string
  readonly timeoutMs?: number
  readonly transcriptPath?: string
  readonly unsetEnv?: readonly string[]
}) {
  const launch = resolveNpmLaunch()
  return await runPackagedCommand({
    args: [...launch.argsPrefix, ...options.args],
    command: launch.command,
    cwd: options.cwd,
    displayArgs: options.displayArgs ?? options.args,
    displayCommand: launch.displayCommand,
    ...(options.env ? { env: options.env } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.transcriptPath ? { transcriptPath: options.transcriptPath } : {}),
    ...(options.unsetEnv ? { unsetEnv: options.unsetEnv } : {}),
  })
}

export async function runGeneratedAppNpmCommand(options: {
  readonly args: readonly string[]
  readonly cwd: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly transcriptPath?: string
}) {
  const displayArgs = options.args
  return await runPackagedNpmCommand({
    args: [...candidateRegistryNpmArgs(getTestRegistryUrl()), ...displayArgs],
    cwd: options.cwd,
    displayArgs,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.transcriptPath ? { transcriptPath: options.transcriptPath } : {}),
    unsetEnv: GENERATED_APP_UNSET_ENV,
  })
}

export async function withPackagedDevServer<T>(
  options: {
    readonly appRoot: string
    readonly env?: Readonly<Record<string, string>>
    readonly port?: number
    readonly transcriptPath: string
  },
  action: (session: PackagedDevServerSession) => Promise<T>,
): Promise<T> {
  const devServer = await startDevServer({
    cwd: options.appRoot,
    ...(options.env ? { env: options.env } : {}),
    ...(typeof options.port === "number" ? { port: options.port } : {}),
  })

  try {
    const url = await devServer.waitForReady()

    return await action({
      devServer,
      url,
    })
  } finally {
    await devServer.stop()
    await appendDevServerTranscript(options.transcriptPath, devServer)
  }
}

interface PackagedNpmChildState {
  closed: boolean
  error: unknown
  exitCode: number | null | undefined
  failed: boolean
  signal: NodeJS.Signals | null | undefined
}

function createChildClosePromise(child: ChildProcess, state: PackagedNpmChildState): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      state.error = error
      state.failed = true
      reject(error)
    })
    child.once("close", (exitCode, signal) => {
      state.closed = true
      state.exitCode = exitCode
      state.signal = signal
      resolve()
    })
  })
}

function createChildSpawnPromise(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function withProcessOutput(message: string, stdout: string, stderr: string): string {
  return [
    message,
    stdout.length > 0 ? `STDOUT:\n${stdout}` : "",
    stderr.length > 0 ? `STDERR:\n${stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export type PackagedNpmScript = "dev" | "dev:web" | "start"

export interface PackagedNpmReadiness {
  /** Quoted in every readiness failure, e.g. `GET /healthz -> {"status":"ready"}`. */
  readonly describe: string
  /**
   * One probe attempt. `detail` from the LAST attempt is quoted in the timeout
   * message: with two children, a 502 body naming an unreachable upstream is the
   * difference between a five-minute diagnosis and an hour spent blaming the
   * wrong process.
   */
  readonly probe: (
    baseUrl: string,
    signal: AbortSignal,
  ) => Promise<{ readonly detail?: string; readonly ready: boolean }>
}

export const dawnHealthzReadiness: PackagedNpmReadiness = {
  describe: `GET /healthz -> {"status":"ready"}`,
  async probe(baseUrl, signal) {
    const response = await fetch(new URL("/healthz", baseUrl), { signal })
    const body = (await response.json().catch(() => undefined)) as unknown
    if (
      response.ok &&
      typeof body === "object" &&
      body !== null &&
      Reflect.get(body, "status") === "ready"
    ) {
      return { ready: true }
    }
    return {
      detail: `HTTP ${response.status} ${JSON.stringify(body) ?? "<unparsed>"}`.slice(0, 300),
      ready: false,
    }
  },
}

/**
 * Readiness for a child with no `/healthz`. Next compiles route handlers lazily,
 * so a 2xx here means that route's whole module graph compiled — not merely that
 * the port is listening. Readying on stdout or on a TCP connect does NOT fail
 * cleanly when it is wrong: a request issued at Next's own `Ready in` line
 * blocked 20,676ms before answering.
 */
export function httpOkReadiness(path: string): PackagedNpmReadiness {
  return {
    describe: `GET ${path} -> 2xx`,
    async probe(baseUrl, signal) {
      const response = await fetch(new URL(path, baseUrl), { signal })
      if (response.ok) {
        await response.body?.cancel()
        return { ready: true }
      }
      const detail = await response.text().catch(() => "")
      return { detail: `HTTP ${response.status} ${detail}`.slice(0, 300), ready: false }
    },
  }
}

function assertPackagedNpmChildRunning(options: {
  readonly readiness: PackagedNpmReadiness
  readonly readStderr: () => string
  readonly readStdout: () => string
  readonly script: PackagedNpmScript
  readonly state: PackagedNpmChildState
  readonly url: string
}): void {
  if (options.state.failed) {
    throw new Error(
      withProcessOutput(
        `npm run ${options.script} failed before ${options.readiness.describe} at ${options.url} succeeded: ${formatError(options.state.error)}`,
        options.readStdout(),
        options.readStderr(),
      ),
      { cause: options.state.error },
    )
  }
  if (options.state.closed) {
    throw new Error(
      withProcessOutput(
        `npm run ${options.script} exited before ${options.readiness.describe} at ${options.url} succeeded (exit ${options.state.exitCode ?? "null"}, signal ${options.state.signal ?? "none"})`,
        options.readStdout(),
        options.readStderr(),
      ),
    )
  }
}

async function waitForPackagedNpmReady(options: {
  readonly closed: Promise<void>
  readonly readiness: PackagedNpmReadiness
  readonly readStderr: () => string
  readonly readStdout: () => string
  readonly script: PackagedNpmScript
  readonly signal?: AbortSignal
  readonly state: PackagedNpmChildState
  readonly url: string
}): Promise<void> {
  const deadline = Date.now() + PACKAGED_NPM_READY_TIMEOUT_MS
  let lastDetail = "<no probe completed>"

  while (Date.now() < deadline) {
    options.signal?.throwIfAborted()
    assertPackagedNpmChildRunning(options)

    const remainingMs = Math.max(1, deadline - Date.now())
    let ready = false
    try {
      const requestTimeoutSignal = AbortSignal.timeout(Math.min(1_000, remainingMs))
      const attempt = await options.readiness.probe(
        options.url,
        options.signal === undefined
          ? requestTimeoutSignal
          : AbortSignal.any([options.signal, requestTimeoutSignal]),
      )
      ready = attempt.ready
      if (attempt.detail !== undefined) lastDetail = attempt.detail
    } catch (error) {
      options.signal?.throwIfAborted()
      lastDetail = formatError(error)
      // The server may still be starting. Child state is checked again below.
    }

    if (ready) {
      options.signal?.throwIfAborted()
      assertPackagedNpmChildRunning(options)
      return
    }

    if (options.state.failed || options.state.closed) continue
    const waitMs = Math.min(100, Math.max(0, deadline - Date.now()))
    if (waitMs === 0) break
    await awaitWithAbort(
      Promise.race([delay(waitMs), options.closed.catch(() => undefined)]),
      options.signal,
    )
  }

  throw new Error(
    withProcessOutput(
      `Timed out waiting for npm run ${options.script} readiness (${options.readiness.describe}) at ${options.url} within ${PACKAGED_NPM_READY_TIMEOUT_MS}ms; last probe: ${lastDetail}`,
      options.readStdout(),
      options.readStderr(),
    ),
  )
}

async function awaitWithAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return await pending
  // The caller may have synchronously aborted while producing an already-rejected
  // promise. Observe that rejection before abort checks can throw the signal reason.
  void pending.catch(() => undefined)
  signal.throwIfAborted()

  let onAbort: () => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try {
        signal.throwIfAborted()
      } catch (error) {
        reject(error)
      }
    }
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })

  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

async function appendPackagedNpmServerTranscript(options: {
  readonly args: readonly string[]
  readonly appRoot: string
  readonly spawnFailure: unknown
  readonly state: PackagedNpmChildState
  readonly stderr: string
  readonly stdout: string
  readonly transcriptPath: string
}): Promise<void> {
  const exitState = options.spawnFailure
    ? `[exit unavailable signal none; spawn error ${formatError(options.spawnFailure)}]`
    : options.state.failed
      ? `[exit unavailable signal none; spawn error ${formatError(options.state.error)}]`
      : options.state.closed
        ? `[exit ${options.state.exitCode ?? "null"} signal ${options.state.signal ?? "none"}]`
        : "[exit pending signal pending]"

  await mkdir(dirname(options.transcriptPath), { recursive: true })
  await appendFile(
    options.transcriptPath,
    [
      `$ (cd ${options.appRoot} && npm ${options.args.join(" ")})`,
      options.stdout.trimEnd(),
      options.stderr.trimEnd().length > 0 ? "[stderr]" : "",
      options.stderr.trimEnd(),
      exitState,
      "",
    ]
      .filter((chunk, index, chunks) => chunk.length > 0 || index === chunks.length - 1)
      .join("\n"),
    "utf8",
  )
}

export async function withPackagedNpmServer<T>(
  options: {
    readonly appRoot: string
    readonly env?: Readonly<Record<string, string>>
    readonly readiness?: PackagedNpmReadiness
    readonly script: PackagedNpmScript
    readonly scriptArgs?: readonly string[]
    readonly signal?: AbortSignal
    readonly transcriptPath: string
    readonly unsetEnv?: readonly string[]
  },
  action: (session: { readonly url: string }) => Promise<T>,
): Promise<T> {
  options.signal?.throwIfAborted()
  const port = await allocatePort()
  options.signal?.throwIfAborted()
  const url = `http://127.0.0.1:${port}`
  const readiness = options.readiness ?? dawnHealthzReadiness
  const args = ["run", options.script, ...(options.scriptArgs ?? [])]
  const npmLaunch = resolveNpmLaunch()
  // Which flags go on is decided by the BINARY each script fronts — `dev` fronts
  // `dawn dev`, `dev:web` fronts `next dev` — even though the branch below can
  // only read the script name to tell them apart. `next` binds the IPv6 wildcard
  // by default (contradicting its own help text), and `-H 127.0.0.1` is the flag
  // it honours. `HOST`/`HOSTNAME` are ignored UNCONDITIONALLY, not merely when a
  // `-p` is present: Next's commander definition carries `.env('PORT')` on `-p`
  // and nothing on `-H`, and a live bind with all three set and no `-p` still
  // took the wildcard while honouring the port. So dropping `-p` does not make
  // `HOST` start working — it binds the LAN.
  if (options.script === "dev") args.push("--", "--port", String(port))
  else if (options.script === "dev:web") args.push("--", "--port", String(port), "-H", "127.0.0.1")

  const env: NodeJS.ProcessEnv = {
    ...process.env,
  }
  removeEnvironmentVariables(env, GENERATED_APP_UNSET_ENV)
  Object.assign(env, {
    // Suppress Node.js experimental-feature warnings (e.g. node:sqlite)
    // so the harness does not treat non-empty stderr as a failure.
    NODE_NO_WARNINGS: "1",
    ...options.env,
    ...(options.script === "start" ? { HOST: "127.0.0.1", PORT: String(port) } : {}),
  })
  removeEnvironmentVariables(env, options.unsetEnv ?? [])

  const state: PackagedNpmChildState = {
    closed: false,
    error: undefined,
    exitCode: undefined,
    failed: false,
    signal: undefined,
  }
  let child: ChildProcess | undefined
  let closed: Promise<void> | undefined
  let groupPid: number | undefined
  let stdout = ""
  let stderr = ""
  let spawnFailure: { readonly error: unknown } | undefined
  let failure: { readonly error: unknown } | undefined
  let actionResult: { readonly value: T } | undefined
  let pendingAction: Promise<T> | undefined

  const recordFailure = (error: unknown, message: string): void => {
    failure = failure ? { error: new AggregateError([failure.error, error], message) } : { error }
  }

  try {
    try {
      child = spawn(npmLaunch.command, [...npmLaunch.argsPrefix, ...args], {
        cwd: options.appRoot,
        detached: true,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (error) {
      spawnFailure = { error }
      throw new Error(`Failed to spawn npm run ${options.script}: ${formatError(error)}`, {
        cause: error,
      })
    }

    closed = createChildClosePromise(child, state)
    const spawned = createChildSpawnPromise(child)
    void closed.catch(() => undefined)

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.stdin?.end()

    try {
      await spawned
    } catch (error) {
      spawnFailure = { error }
      throw new Error(`Failed to spawn npm run ${options.script}: ${formatError(error)}`, {
        cause: error,
      })
    }

    groupPid = child.pid
    if (groupPid === undefined) {
      throw new Error(`npm run ${options.script} subprocess has no process id`)
    }

    await waitForPackagedNpmReady({
      closed,
      readiness,
      readStderr: () => stderr,
      readStdout: () => stdout,
      script: options.script,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      state,
      url,
    })
    options.signal?.throwIfAborted()
    pendingAction = action({ url })
    actionResult = { value: await awaitWithAbort(pendingAction, options.signal) }
  } catch (error) {
    recordFailure(error, `npm run ${options.script} failed and cleanup also failed`)
  } finally {
    // Let the action finish unwinding before this child dies. A nested session
    // is still tearing down its own child here; without this the two teardowns
    // interleave and both append to `transcriptPath` at once.
    if (pendingAction !== undefined) {
      // The timer is cancelled rather than left to fire: on every SUCCESSFUL
      // teardown this race is decided in a microtask, and a bare `delay()` would
      // still leave a live 5s handle behind — measured, the call returned at
      // 264ms and the handle was still in the process census at 5237ms. NOT
      // `.unref()`: that trades the stray handle for a silent exit-0 in the
      // middle of teardown whenever an action genuinely never settles.
      let settleTimer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          pendingAction.catch(() => undefined),
          new Promise<void>((settle) => {
            settleTimer = setTimeout(settle, PACKAGED_NPM_ACTION_SETTLE_MS)
          }),
        ])
      } finally {
        if (settleTimer !== undefined) clearTimeout(settleTimer)
      }
    }

    if (child && closed && groupPid !== undefined) {
      try {
        await terminateSubprocess(child, groupPid, closed, url)
      } catch (error) {
        recordFailure(error, `npm run ${options.script} failed and cleanup also failed`)
      }
    } else if (closed) {
      await Promise.race([closed.catch(() => undefined), delay(1_000)])
    }

    try {
      await appendPackagedNpmServerTranscript({
        args,
        appRoot: options.appRoot,
        spawnFailure: spawnFailure?.error,
        state,
        stderr,
        stdout,
        transcriptPath: options.transcriptPath,
      })
    } catch (error) {
      recordFailure(error, `npm run ${options.script} failed and transcript recording also failed`)
    }
  }

  if (failure) throw failure.error
  if (!actionResult) {
    throw new Error(`npm run ${options.script} completed without an action result`)
  }
  return actionResult.value
}
