import { execFile, spawn } from "node:child_process"

const PROCESS_TIMEOUT_GRACE_MS = 500
const PROCESS_TIMEOUT_FORCE_MS = 1_000
const PROCESS_TIMEOUT_POLL_MS = 25

export interface SpawnProcessOptions {
  readonly args?: readonly string[]
  readonly command: string
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly shell?: boolean | string
  readonly signal?: AbortSignal
  readonly stdin?: string
  readonly timeoutMs?: number
  readonly unsetEnv?: readonly string[]
}

export interface SpawnProcessResult {
  readonly aborted?: true
  readonly abortReason?: unknown
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly exitCode: number | null
  readonly ok: boolean
  readonly signal: NodeJS.Signals | null
  readonly spawnError?: unknown
  readonly spawnFailed?: true
  readonly stderr: string
  readonly stdout: string
  readonly terminationError?: unknown
  readonly terminationFailed?: true
  readonly timedOut?: true
  readonly timeoutMs?: number
}

export type SpawnProcessErrorPhase = "spawn" | "termination"

export class SpawnProcessError extends Error {
  readonly code?: string
  readonly phase: SpawnProcessErrorPhase
  readonly result: SpawnProcessResult

  constructor(
    message: string,
    options: {
      readonly cause: unknown
      readonly code?: string
      readonly phase: SpawnProcessErrorPhase
      readonly result: SpawnProcessResult
    },
  ) {
    super(message, { cause: options.cause })
    this.name = "SpawnProcessError"
    this.phase = options.phase
    this.result = options.result
    if (options.code !== undefined) this.code = options.code
  }
}

type SpawnProcessInterruption =
  | { readonly reason: unknown; readonly type: "aborted" }
  | { readonly timeoutMs: number; readonly type: "timeout" }

export function removeEnvironmentVariables(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") {
    const normalizedNames = new Set(names.map((name) => name.toLowerCase()))
    for (const name of Object.keys(env)) {
      if (normalizedNames.has(name.toLowerCase())) delete env[name]
    }
    return
  }

  for (const name of names) delete env[name]
}

export async function spawnProcess(options: SpawnProcessOptions): Promise<SpawnProcessResult> {
  const args = options.args ?? []
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
  }
  removeEnvironmentVariables(env, options.unsetEnv ?? [])

  const timeoutMs = options.timeoutMs
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new RangeError(`timeoutMs must be a positive finite number, received ${timeoutMs}`)
  }

  const child = spawn(options.command, [...args], {
    cwd: options.cwd,
    ...(timeoutMs !== undefined || options.signal !== undefined ? { detached: true } : {}),
    env,
    ...(options.shell !== undefined ? { shell: options.shell } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""

  child.stdout.on("data", (chunk: string | Buffer) => {
    stdout += chunk.toString()
  })

  child.stderr.on("data", (chunk: string | Buffer) => {
    stderr += chunk.toString()
  })

  if (typeof options.stdin === "string") {
    child.stdin.write(options.stdin)
  }
  child.stdin.end()

  let closed = false
  const closedPromise = new Promise<{
    readonly exitCode: number | null
    readonly signal: NodeJS.Signals | null
  }>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (exitCode, signal) => {
      closed = true
      resolve({ exitCode, signal })
    })
  })

  if (timeoutMs === undefined && options.signal === undefined) {
    let close: Awaited<typeof closedPromise>
    try {
      close = await closedPromise
    } catch (error) {
      throw createSpawnProcessError(options, args, child, stderr, stdout, "spawn", error)
    }
    return createSpawnProcessResult(options, args, close, stderr, stdout)
  }

  let timeoutHandle: NodeJS.Timeout | undefined
  let abortListener: (() => void) | undefined
  let outcome:
    | {
        readonly close: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }
        readonly type: "closed"
      }
    | { readonly type: "timeout" }
    | { readonly reason: unknown; readonly type: "aborted" }
  try {
    const outcomes: Array<Promise<typeof outcome>> = [
      closedPromise.then((close) => ({ close, type: "closed" as const })),
    ]
    if (timeoutMs !== undefined) {
      outcomes.push(
        new Promise<{ readonly type: "timeout" }>((resolve) => {
          timeoutHandle = setTimeout(() => resolve({ type: "timeout" }), timeoutMs)
        }),
      )
    }
    if (options.signal !== undefined) {
      outcomes.push(
        new Promise<{ readonly reason: unknown; readonly type: "aborted" }>((resolve) => {
          const resolveAborted = () => resolve({ reason: options.signal?.reason, type: "aborted" })
          if (options.signal?.aborted) {
            resolveAborted()
          } else {
            abortListener = resolveAborted
            options.signal?.addEventListener("abort", abortListener, { once: true })
          }
        }),
      )
    }
    outcome = await Promise.race(outcomes)
  } catch (error) {
    throw createSpawnProcessError(options, args, child, stderr, stdout, "spawn", error)
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
    if (abortListener !== undefined) options.signal?.removeEventListener("abort", abortListener)
  }

  if (outcome.type === "closed") {
    return createSpawnProcessResult(options, args, outcome.close, stderr, stdout)
  }

  let interruption: SpawnProcessInterruption
  if (outcome.type === "timeout") {
    if (timeoutMs === undefined) {
      throw new Error("Subprocess timeout resolved without a configured timeout")
    }
    interruption = { timeoutMs, type: "timeout" }
  } else {
    interruption = { reason: outcome.reason, type: "aborted" }
  }

  const groupPid = child.pid
  if (groupPid === undefined) {
    const error = new Error(`Interrupted subprocess ${options.command} has no process id`)
    throw createSpawnProcessError(
      options,
      args,
      child,
      stderr,
      stdout,
      "termination",
      error,
      interruption,
    )
  }

  try {
    await terminateTimedOutProcessTree(child, groupPid, closedPromise, () => closed)
  } catch (error) {
    throw createSpawnProcessError(
      options,
      args,
      child,
      stderr,
      stdout,
      "termination",
      error,
      interruption,
    )
  }
  let close: Awaited<typeof closedPromise>
  try {
    close = await closedPromise
  } catch (error) {
    throw createSpawnProcessError(
      options,
      args,
      child,
      stderr,
      stdout,
      "spawn",
      error,
      interruption,
    )
  }
  return createSpawnProcessResult(options, args, close, stderr, stdout, interruption)
}

function createSpawnProcessResult(
  options: SpawnProcessOptions,
  args: readonly string[],
  close: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null },
  stderr: string,
  stdout: string,
  interruption?: SpawnProcessInterruption,
  failure?: { readonly error: unknown; readonly phase: SpawnProcessErrorPhase },
): SpawnProcessResult {
  return {
    args,
    command: options.command,
    cwd: options.cwd ?? process.cwd(),
    exitCode: close.exitCode,
    ok: failure === undefined && interruption === undefined && close.exitCode === 0,
    signal: close.signal,
    stderr,
    stdout,
    ...(interruption?.type === "timeout"
      ? { timedOut: true, timeoutMs: interruption.timeoutMs }
      : {}),
    ...(interruption?.type === "aborted"
      ? { aborted: true, abortReason: interruption.reason }
      : {}),
    ...(failure?.phase === "spawn" ? { spawnError: failure.error, spawnFailed: true } : {}),
    ...(failure?.phase === "termination"
      ? { terminationError: failure.error, terminationFailed: true }
      : {}),
  }
}

function createSpawnProcessError(
  options: SpawnProcessOptions,
  args: readonly string[],
  child: ReturnType<typeof spawn>,
  stderr: string,
  stdout: string,
  phase: SpawnProcessErrorPhase,
  error: unknown,
  interruption?: SpawnProcessInterruption,
): SpawnProcessError {
  const result = createSpawnProcessResult(
    options,
    args,
    { exitCode: child.exitCode, signal: child.signalCode },
    stderr,
    stdout,
    interruption,
    { error, phase },
  )
  const cause =
    phase === "termination" && interruption?.type === "aborted"
      ? new AggregateError(
          [interruption.reason, error],
          "Subprocess abort and tree termination both failed",
        )
      : error
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const code = readErrorCode(error)
  return new SpawnProcessError(
    phase === "spawn"
      ? `Failed to spawn subprocess ${options.command}: ${detail}`
      : `Failed to terminate interrupted subprocess ${options.command}: ${detail}`,
    {
      cause,
      ...(code !== undefined ? { code } : {}),
      phase,
      result,
    },
  )
}

async function terminateTimedOutProcessTree(
  child: ReturnType<typeof spawn>,
  groupPid: number,
  closed: Promise<unknown>,
  isClosed: () => boolean,
): Promise<void> {
  if (process.platform === "win32") {
    try {
      await taskkillProcessTree(groupPid, PROCESS_TIMEOUT_GRACE_MS + PROCESS_TIMEOUT_FORCE_MS)
    } catch (error) {
      try {
        await waitForClosed(closed, isClosed, PROCESS_TIMEOUT_FORCE_MS, groupPid)
      } catch {
        throw error
      }
      return
    }
    await waitForClosed(closed, isClosed, PROCESS_TIMEOUT_FORCE_MS, groupPid)
    return
  }

  signalProcessGroup(child, groupPid, "SIGTERM")
  if (await waitForProcessGroupExit(groupPid, closed, isClosed, PROCESS_TIMEOUT_GRACE_MS)) return

  signalProcessGroup(child, groupPid, "SIGKILL")
  if (await waitForProcessGroupExit(groupPid, closed, isClosed, PROCESS_TIMEOUT_FORCE_MS)) return

  throw new Error(
    `Timed-out subprocess group ${groupPid} did not stop within ${PROCESS_TIMEOUT_GRACE_MS + PROCESS_TIMEOUT_FORCE_MS}ms`,
  )
}

function signalProcessGroup(
  child: ReturnType<typeof spawn>,
  groupPid: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-groupPid, signal)
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return
    try {
      child.kill(signal)
    } catch (childError) {
      if (!hasErrorCode(childError, "ESRCH")) throw childError
    }
  }
}

async function waitForProcessGroupExit(
  groupPid: number,
  closed: Promise<unknown>,
  isClosed: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isClosed()) {
      if (!processGroupIsRunning(groupPid)) return true
      await delay(PROCESS_TIMEOUT_POLL_MS)
    } else {
      await Promise.race([closed.catch(() => undefined), delay(PROCESS_TIMEOUT_POLL_MS)])
    }
  }
  return isClosed() && !processGroupIsRunning(groupPid)
}

function processGroupIsRunning(groupPid: number): boolean {
  try {
    process.kill(-groupPid, 0)
    return true
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return false
    if (hasErrorCode(error, "EPERM")) return true
    throw error
  }
}

function taskkillProcessTree(pid: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { maxBuffer: 64 * 1024, timeout: timeoutMs, windowsHide: true },
      (error) => (error ? reject(error) : resolve()),
    )
  })
}

async function waitForClosed(
  closed: Promise<unknown>,
  isClosed: () => boolean,
  timeoutMs: number,
  groupPid: number,
): Promise<void> {
  if (isClosed()) return
  let timeoutHandle: NodeJS.Timeout | undefined
  let outcome: "closed" | "timeout"
  try {
    outcome = await Promise.race([
      closed.then(() => "closed" as const),
      new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
  if (outcome !== "closed") {
    throw new Error(`Timed-out subprocess tree ${groupPid} did not close within ${timeoutMs}ms`)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hasErrorCode(error: unknown, code: string): boolean {
  return readErrorCode(error) === code
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const code = Reflect.get(error, "code")
  return typeof code === "string" ? code : undefined
}
