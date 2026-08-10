import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, posix, resolve, win32 } from "node:path"

import { spawnProcess } from "../../packages/devkit/src/testing/index.ts"
import { removeEnvironmentVariables } from "../../packages/devkit/src/testing/process.ts"
import { terminateSubprocess } from "../../packages/testing/src/subprocess.ts"
import {
  allocatePort,
  appendDevServerTranscript,
  type DevServerHandle,
  delay,
  startDevServer,
} from "../runtime/support/dev-server.ts"
import { getTestRegistryUrl } from "./local-registry.ts"
import { writeRegistryNpmrc } from "./scaffold-packaging.ts"

const REPO_ROOT = resolve(import.meta.dirname, "../..")
const PACKAGED_COMMAND_TIMEOUT_MS = 180_000
const PACKAGED_NPM_READY_TIMEOUT_MS = 60_000
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
  await runPackagedNpmCommand({
    args: ["install", "--no-save", "create-dawn-ai-app@latest"],
    cwd: installerDir,
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
  readonly stdin?: string
  readonly timeoutMs?: number
  readonly transcriptPath?: string
  readonly unsetEnv?: readonly string[]
}) {
  const displayArgs = options.displayArgs ?? options.args
  const displayCommand = options.displayCommand ?? options.command
  const result = await spawnProcess({
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
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    timeoutMs: options.timeoutMs ?? PACKAGED_COMMAND_TIMEOUT_MS,
    ...(options.unsetEnv ? { unsetEnv: options.unsetEnv } : {}),
  })

  if (options.transcriptPath) {
    await appendFile(
      options.transcriptPath,
      [
        `$ (cd ${result.cwd} && ${displayCommand} ${displayArgs.join(" ")})`,
        result.stdout.trimEnd(),
        result.stderr.trimEnd(),
        result.timedOut ? `[timed out after ${result.timeoutMs}ms]` : "",
        `[exit ${result.exitCode}]`,
        "",
      ]
        .filter((chunk, index, chunks) => chunk.length > 0 || index === chunks.length - 1)
        .join("\n"),
      "utf8",
    )
  }

  if (!result.ok) {
    const failure = result.timedOut
      ? `Command timed out after ${result.timeoutMs}ms: ${displayCommand} ${displayArgs.join(" ")}`
      : `Command failed: ${displayCommand} ${displayArgs.join(" ")}`
    throw new Error([failure, result.stdout, result.stderr].filter(Boolean).join("\n"))
  }

  return result
}

export async function runPackagedNpmCommand(options: {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
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
    displayArgs: options.args,
    displayCommand: launch.displayCommand,
    ...(options.env ? { env: options.env } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.transcriptPath ? { transcriptPath: options.transcriptPath } : {}),
    ...(options.unsetEnv ? { unsetEnv: options.unsetEnv } : {}),
  })
}

export async function runGeneratedAppNpmCommand(options: {
  readonly args: readonly string[]
  readonly cwd: string
  readonly timeoutMs?: number
  readonly transcriptPath?: string
}) {
  return await runPackagedNpmCommand({
    args: options.args,
    cwd: options.cwd,
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

function assertPackagedNpmChildRunning(options: {
  readonly healthUrl: string
  readonly readStderr: () => string
  readonly readStdout: () => string
  readonly script: "dev" | "start"
  readonly state: PackagedNpmChildState
}): void {
  if (options.state.failed) {
    throw new Error(
      withProcessOutput(
        `npm run ${options.script} failed before ${options.healthUrl} became healthy: ${formatError(options.state.error)}`,
        options.readStdout(),
        options.readStderr(),
      ),
      { cause: options.state.error },
    )
  }
  if (options.state.closed) {
    throw new Error(
      withProcessOutput(
        `npm run ${options.script} exited before ${options.healthUrl} became healthy (exit ${options.state.exitCode ?? "null"}, signal ${options.state.signal ?? "none"})`,
        options.readStdout(),
        options.readStderr(),
      ),
    )
  }
}

async function waitForPackagedNpmReady(options: {
  readonly closed: Promise<void>
  readonly healthUrl: string
  readonly readStderr: () => string
  readonly readStdout: () => string
  readonly script: "dev" | "start"
  readonly state: PackagedNpmChildState
}): Promise<void> {
  const deadline = Date.now() + PACKAGED_NPM_READY_TIMEOUT_MS

  while (Date.now() < deadline) {
    assertPackagedNpmChildRunning(options)

    const remainingMs = Math.max(1, deadline - Date.now())
    let ready = false
    try {
      const response = await fetch(options.healthUrl, {
        signal: AbortSignal.timeout(Math.min(1_000, remainingMs)),
      })
      const body = await response.json().catch(() => undefined)
      ready =
        response.ok &&
        typeof body === "object" &&
        body !== null &&
        Reflect.get(body, "status") === "ready"
    } catch {
      // The server may still be starting. Child state is checked again below.
    }

    if (ready) {
      assertPackagedNpmChildRunning(options)
      return
    }

    if (options.state.failed || options.state.closed) continue
    const waitMs = Math.min(100, Math.max(0, deadline - Date.now()))
    if (waitMs === 0) break
    await Promise.race([delay(waitMs), options.closed.catch(() => undefined)])
  }

  throw new Error(
    withProcessOutput(
      `Timed out waiting for npm run ${options.script} readiness at ${options.healthUrl} within ${PACKAGED_NPM_READY_TIMEOUT_MS}ms`,
      options.readStdout(),
      options.readStderr(),
    ),
  )
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
    readonly script: "dev" | "start"
    readonly scriptArgs?: readonly string[]
    readonly transcriptPath: string
    readonly unsetEnv?: readonly string[]
  },
  action: (session: { readonly url: string }) => Promise<T>,
): Promise<T> {
  const port = await allocatePort()
  const url = `http://127.0.0.1:${port}`
  const healthUrl = new URL("/healthz", url).href
  const args = ["run", options.script, ...(options.scriptArgs ?? [])]
  const npmLaunch = resolveNpmLaunch()
  if (options.script === "dev") args.push("--", "--port", String(port))

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
      healthUrl,
      readStderr: () => stderr,
      readStdout: () => stdout,
      script: options.script,
      state,
    })
    actionResult = { value: await action({ url }) }
  } catch (error) {
    recordFailure(error, `npm run ${options.script} failed and cleanup also failed`)
  } finally {
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
