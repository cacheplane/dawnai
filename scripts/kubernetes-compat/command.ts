import {
  type ChildProcessByStdio,
  execFile,
  type SpawnOptionsWithStdioTuple,
  spawn,
} from "node:child_process"
import type { Readable, Writable } from "node:stream"

export interface Command {
  readonly file: string
  readonly args: readonly string[]
}

export interface CommandExecutionOptions {
  readonly timeoutMs?: number
  readonly stdoutLimitBytes?: number
  readonly stderrLimitBytes?: number
  readonly signal?: AbortSignal
  readonly stdin?: string | Uint8Array
  readonly sensitiveOutput?: boolean
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly acceptedExitCodes?: readonly number[]
  readonly terminateProcessTree?: boolean
}

interface ResolvedCommandExecutionOptions {
  readonly timeoutMs: number
  readonly stdoutLimitBytes: number
  readonly stderrLimitBytes: number
  readonly signal?: AbortSignal
  readonly stdin?: string | Uint8Array
  readonly sensitiveOutput: boolean
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly acceptedExitCodes: ReadonlySet<number>
  readonly terminateProcessTree: boolean
}

export type CommandSpawnOptions = SpawnOptionsWithStdioTuple<"pipe", "pipe", "pipe"> & {
  readonly shell: false
}

type CommandChild = ChildProcessByStdio<Writable, Readable, Readable>

export type CommandSpawner = (
  file: string,
  args: readonly string[],
  options: CommandSpawnOptions,
) => CommandChild

export interface CommandTerminationDependencies {
  readonly platform: NodeJS.Platform
  readonly killProcessGroup: (pid: number, signal: NodeJS.Signals) => void
  readonly taskkillProcessTree: (pid: number, timeoutMs: number) => Promise<void>
}

export type CommandOutcome =
  | { readonly kind: "exit"; readonly exitCode: number }
  | { readonly kind: "signal"; readonly signal: NodeJS.Signals }
  | { readonly kind: "spawn-error"; readonly code: string }
  | { readonly kind: "child-error" }
  | { readonly kind: "timeout"; readonly timeoutMs: number }
  | { readonly kind: "aborted" }
  | { readonly kind: "stdout-overflow"; readonly limitBytes: number }
  | { readonly kind: "stderr-overflow"; readonly limitBytes: number }

export interface SerializedCommandResult {
  readonly command: Command
  readonly outcome: { readonly kind: "exit"; readonly exitCode: number }
}

export interface CommandResult {
  readonly command: Command
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly exitCode: number
  readonly signal: null
  toJSON(): SerializedCommandResult
}

export interface SerializedCommandError {
  readonly name: "CommandExecutionError"
  readonly message: string
  readonly command: Command
  readonly outcome: CommandOutcome
}

interface BoundedBuffer {
  readonly chunks: Buffer[]
  bytes: number
  readonly limitBytes: number
}

interface PendingFailure {
  readonly message: string
  readonly outcome: CommandOutcome
}

const REDACTED = "[REDACTED]"
const CREDENTIAL_ARGUMENT_PATTERN =
  /(?:bearer\s+\S+|[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{3,})/i
const SENSITIVE_ARGUMENT_FLAG_PATTERN =
  /^--?(?:authorization|password|secret|token|kubeconfig)(?:=|$)/i
const WRAPPER_OWNED_ARGUMENT_PATTERN = /^--(?:context|kube-context|kubeconfig)(?:=|$)/
const WINDOWS_TREE_TERMINATION_TIMEOUT_MS = 5_000

export const COMMAND_DEFAULTS = Object.freeze({
  timeoutMs: 30_000,
  stdoutLimitBytes: 32 * 1_024 * 1_024,
  stderrLimitBytes: 64 * 1_024,
})

function expectNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function normalizeCommand(command: Command): Command {
  const file = expectNonEmptyString(command.file, "Command file")
  if (
    !Array.isArray(command.args) ||
    command.args.some((argument) => typeof argument !== "string")
  ) {
    throw new Error("Command args must be an array of strings")
  }
  return Object.freeze({ file, args: Object.freeze([...command.args]) })
}

function resolvePositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return resolved
}

function resolveOptions(options: CommandExecutionOptions): ResolvedCommandExecutionOptions {
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new Error("Command signal must be an AbortSignal")
  }
  if (
    options.stdin !== undefined &&
    typeof options.stdin !== "string" &&
    !(options.stdin instanceof Uint8Array)
  ) {
    throw new Error("Command stdin must be a string or Uint8Array")
  }
  const acceptedExitCodes = options.acceptedExitCodes ?? []
  if (
    !Array.isArray(acceptedExitCodes) ||
    acceptedExitCodes.some((code) => !Number.isSafeInteger(code) || code <= 0 || code > 255) ||
    new Set(acceptedExitCodes).size !== acceptedExitCodes.length
  ) {
    throw new Error("Command accepted exit codes must be unique integers between 1 and 255")
  }
  if (
    options.terminateProcessTree !== undefined &&
    typeof options.terminateProcessTree !== "boolean"
  ) {
    throw new Error("Command process-tree termination option must be a boolean")
  }
  return {
    timeoutMs: resolvePositiveInteger(
      options.timeoutMs,
      COMMAND_DEFAULTS.timeoutMs,
      "Command timeout",
    ),
    stdoutLimitBytes: resolvePositiveInteger(
      options.stdoutLimitBytes,
      COMMAND_DEFAULTS.stdoutLimitBytes,
      "Command stdout limit",
    ),
    stderrLimitBytes: resolvePositiveInteger(
      options.stderrLimitBytes,
      COMMAND_DEFAULTS.stderrLimitBytes,
      "Command stderr limit",
    ),
    sensitiveOutput: options.sensitiveOutput === true,
    acceptedExitCodes: new Set(acceptedExitCodes),
    terminateProcessTree: options.terminateProcessTree === true,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  }
}

function redactArguments(args: readonly string[], redactAll: boolean): readonly string[] {
  if (redactAll) {
    return Object.freeze(args.map(() => REDACTED))
  }

  let redactNext = false
  return Object.freeze(
    args.map((argument) => {
      if (redactNext) {
        redactNext = false
        return REDACTED
      }
      if (SENSITIVE_ARGUMENT_FLAG_PATTERN.test(argument)) {
        const separator = argument.indexOf("=")
        if (separator >= 0) {
          return `${argument.slice(0, separator + 1)}${REDACTED}`
        }
        redactNext = true
        return argument
      }
      return CREDENTIAL_ARGUMENT_PATTERN.test(argument) ? REDACTED : argument
    }),
  )
}

function safeCommand(command: Command, redactAllArgs: boolean): Command {
  const file = CREDENTIAL_ARGUMENT_PATTERN.test(command.file) ? REDACTED : command.file
  return Object.freeze({ file, args: redactArguments(command.args, redactAllArgs) })
}

function errorCode(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
  ) {
    return cause.code
  }
  return "UNKNOWN"
}

export class CommandExecutionError extends Error {
  readonly command: Command
  readonly outcome: CommandOutcome

  constructor(
    message: string,
    command: Command,
    outcome: CommandOutcome,
    options: { readonly sensitiveOutput?: boolean } = {},
  ) {
    super(message)
    this.name = "CommandExecutionError"
    this.command = safeCommand(command, options.sensitiveOutput === true)
    this.outcome = Object.freeze({ ...outcome })
  }

  toJSON(): SerializedCommandError {
    return {
      name: "CommandExecutionError",
      message: this.message,
      command: this.command,
      outcome: this.outcome,
    }
  }
}

class CompletedCommandResult implements CommandResult {
  readonly command: Command
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly exitCode: number
  readonly signal = null
  readonly #sensitiveOutput: boolean

  constructor(
    command: Command,
    stdout: Buffer,
    stderr: Buffer,
    exitCode: number,
    sensitiveOutput: boolean,
  ) {
    this.command = safeCommand(command, sensitiveOutput)
    this.stdout = stdout
    this.stderr = stderr
    this.exitCode = exitCode
    this.#sensitiveOutput = sensitiveOutput
    Object.defineProperties(this, {
      stdout: { value: stdout, enumerable: false, writable: false, configurable: false },
      stderr: { value: stderr, enumerable: false, writable: false, configurable: false },
    })
  }

  toJSON(): SerializedCommandResult {
    return {
      command: safeCommand(this.command, this.#sensitiveOutput),
      outcome: { kind: "exit", exitCode: this.exitCode },
    }
  }
}

function appendBounded(buffer: BoundedBuffer, chunk: Buffer): boolean {
  const remaining = buffer.limitBytes - buffer.bytes
  if (chunk.length <= remaining) {
    buffer.chunks.push(chunk)
    buffer.bytes += chunk.length
    return true
  }
  if (remaining > 0) {
    buffer.chunks.push(chunk.subarray(0, remaining))
    buffer.bytes += remaining
  }
  return false
}

function diagnosticSuffix(stderr: BoundedBuffer, sensitiveOutput: boolean): string {
  if (sensitiveOutput) {
    return ""
  }
  const diagnostic = Buffer.concat(stderr.chunks, stderr.bytes).toString("utf8").trim()
  return diagnostic.length > 0 ? `: ${diagnostic}` : ""
}

const defaultSpawner: CommandSpawner = (file, args, options) => spawn(file, args, options)

function taskkillProcessTree(pid: number, timeoutMs: number): Promise<void> {
  return new Promise((resolveTaskkill, rejectTaskkill) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      {
        windowsHide: true,
        timeout: Math.max(1, timeoutMs),
        maxBuffer: 64 * 1_024,
      },
      (error) => (error === null ? resolveTaskkill() : rejectTaskkill(error)),
    )
  })
}

const DEFAULT_TERMINATION_DEPENDENCIES: CommandTerminationDependencies = Object.freeze({
  platform: process.platform,
  killProcessGroup: (pid: number, signal: NodeJS.Signals): void => {
    process.kill(-pid, signal)
  },
  taskkillProcessTree,
})

function killDirectChild(child: CommandChild, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal)
  } catch {
    return false
  }
}

async function dispatchProcessTreeTermination(
  child: CommandChild,
  signal: NodeJS.Signals,
  dependencies: CommandTerminationDependencies,
): Promise<boolean> {
  const pid = child.pid
  if (pid === undefined) return killDirectChild(child, signal)

  if (dependencies.platform === "win32") {
    try {
      await dependencies.taskkillProcessTree(pid, WINDOWS_TREE_TERMINATION_TIMEOUT_MS)
      return true
    } catch {
      killDirectChild(child, signal)
      return false
    }
  }

  try {
    dependencies.killProcessGroup(pid, signal)
    return true
  } catch {
    killDirectChild(child, signal)
    return false
  }
}

export type CommandExecutor = (
  command: Command,
  options?: CommandExecutionOptions,
) => Promise<CommandResult>

export function createCommandExecutor(
  spawnCommand: CommandSpawner = defaultSpawner,
  injectedTerminationDependencies: Partial<CommandTerminationDependencies> = {},
): CommandExecutor {
  const terminationDependencies: CommandTerminationDependencies = {
    platform: injectedTerminationDependencies.platform ?? DEFAULT_TERMINATION_DEPENDENCIES.platform,
    killProcessGroup:
      injectedTerminationDependencies.killProcessGroup ??
      DEFAULT_TERMINATION_DEPENDENCIES.killProcessGroup,
    taskkillProcessTree:
      injectedTerminationDependencies.taskkillProcessTree ??
      DEFAULT_TERMINATION_DEPENDENCIES.taskkillProcessTree,
  }
  return (command, executionOptions = {}) => {
    let normalizedCommand: Command
    let options: ResolvedCommandExecutionOptions
    try {
      normalizedCommand = normalizeCommand(command)
      options = resolveOptions(executionOptions)
    } catch (error) {
      return Promise.reject(error)
    }

    const createError = (
      failure: PendingFailure,
      stderr?: BoundedBuffer,
    ): CommandExecutionError => {
      const safe = safeCommand(normalizedCommand, options.sensitiveOutput)
      const message = `${failure.message} (${JSON.stringify(safe.file)})${
        stderr === undefined ? "" : diagnosticSuffix(stderr, options.sensitiveOutput)
      }`
      return new CommandExecutionError(message, normalizedCommand, failure.outcome, {
        ...(options.sensitiveOutput ? { sensitiveOutput: true } : {}),
      })
    }

    if (options.signal?.aborted === true) {
      return Promise.reject(
        createError({ message: "Command was aborted before start", outcome: { kind: "aborted" } }),
      )
    }

    return new Promise((resolve, reject) => {
      let child: CommandChild
      try {
        child = spawnCommand(normalizedCommand.file, normalizedCommand.args, {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          ...(options.terminateProcessTree && terminationDependencies.platform !== "win32"
            ? { detached: true }
            : {}),
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(options.env !== undefined ? { env: options.env } : {}),
        })
      } catch (cause) {
        reject(
          createError({
            message: `Failed to start command: ${errorCode(cause)}`,
            outcome: { kind: "spawn-error", code: errorCode(cause) },
          }),
        )
        return
      }

      const stdout: BoundedBuffer = {
        chunks: [],
        bytes: 0,
        limitBytes: options.stdoutLimitBytes,
      }
      const stderr: BoundedBuffer = {
        chunks: [],
        bytes: 0,
        limitBytes: options.stderrLimitBytes,
      }
      let spawned = false
      let settled = false
      let pendingFailure: PendingFailure | undefined
      let closedAfterFailure = false
      let terminationDispatch: Promise<boolean> | undefined
      let timeout: NodeJS.Timeout | undefined

      const cleanup = (): void => {
        if (timeout !== undefined) {
          clearTimeout(timeout)
          timeout = undefined
        }
        options.signal?.removeEventListener("abort", onAbort)
        child.off("spawn", onSpawn)
        child.off("error", onError)
        child.off("close", onClose)
        child.stdout.off("data", onStdout)
        child.stderr.off("data", onStderr)
        child.stdin.off("error", onStdinError)
      }

      const settle = (error?: Error, exitCode = 0): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        if (error !== undefined) {
          reject(error)
          return
        }
        resolve(
          new CompletedCommandResult(
            normalizedCommand,
            Buffer.concat(stdout.chunks, stdout.bytes),
            Buffer.concat(stderr.chunks, stderr.bytes),
            exitCode,
            options.sensitiveOutput,
          ),
        )
      }

      const terminate = (failure: PendingFailure): void => {
        if (settled || pendingFailure !== undefined) {
          return
        }
        pendingFailure = failure
        terminationDispatch = Promise.resolve().then(() =>
          options.terminateProcessTree
            ? dispatchProcessTreeTermination(child, "SIGKILL", terminationDependencies)
            : killDirectChild(child, "SIGKILL"),
        )
        void terminationDispatch.then((dispatched) => {
          if (settled) return
          if (!dispatched) {
            settle(
              createError(
                {
                  message: `${failure.message}; ${options.terminateProcessTree ? "process-tree" : "child"} termination failed`,
                  outcome: failure.outcome,
                },
                stderr,
              ),
            )
            return
          }
          if (closedAfterFailure) settle(createError(failure, stderr))
        })
      }

      function onSpawn(): void {
        spawned = true
      }

      function onStdout(value: Buffer | string): void {
        if (settled || pendingFailure !== undefined) {
          return
        }
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        if (!appendBounded(stdout, chunk)) {
          terminate({
            message: `Command stdout exceeded ${options.stdoutLimitBytes} bytes`,
            outcome: { kind: "stdout-overflow", limitBytes: options.stdoutLimitBytes },
          })
        }
      }

      function onStderr(value: Buffer | string): void {
        if (settled || pendingFailure !== undefined) {
          return
        }
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        if (!appendBounded(stderr, chunk)) {
          terminate({
            message: `Command stderr exceeded ${options.stderrLimitBytes} bytes`,
            outcome: { kind: "stderr-overflow", limitBytes: options.stderrLimitBytes },
          })
        }
      }

      function onStdinError(): void {
        if (settled || pendingFailure !== undefined) {
          return
        }
        terminate({
          message: "Command encountered a stdin error",
          outcome: { kind: "child-error" },
        })
      }

      function onError(cause: Error): void {
        if (settled || pendingFailure !== undefined) {
          return
        }
        if (!spawned) {
          settle(
            createError({
              message: `Failed to start command: ${errorCode(cause)}`,
              outcome: { kind: "spawn-error", code: errorCode(cause) },
            }),
          )
          return
        }
        terminate({
          message: "Command encountered a child-process error",
          outcome: { kind: "child-error" },
        })
      }

      function onClose(code: number | null, signal: NodeJS.Signals | null): void {
        if (pendingFailure !== undefined) {
          const failure = pendingFailure
          closedAfterFailure = true
          if (terminationDispatch === undefined) {
            settle(createError(failure, stderr))
          } else {
            void terminationDispatch.then((dispatched) => {
              if (dispatched) settle(createError(failure, stderr))
            })
          }
          return
        }
        if (code === 0 || (code !== null && options.acceptedExitCodes.has(code))) {
          settle(undefined, code ?? 0)
          return
        }
        if (signal !== null) {
          const failure: PendingFailure = {
            message: `Command failed with signal ${signal}`,
            outcome: { kind: "signal", signal },
          }
          if (options.terminateProcessTree) {
            terminate(failure)
            closedAfterFailure = true
          } else {
            settle(createError(failure, stderr))
          }
          return
        }
        const failure: PendingFailure = {
          message: `Command failed with exit code ${String(code)}`,
          outcome: { kind: "exit", exitCode: code ?? -1 },
        }
        if (options.terminateProcessTree) {
          terminate(failure)
          closedAfterFailure = true
        } else {
          settle(createError(failure, stderr))
        }
      }

      function onAbort(): void {
        terminate({ message: "Command was aborted", outcome: { kind: "aborted" } })
      }

      child.once("spawn", onSpawn)
      child.on("error", onError)
      child.once("close", onClose)
      child.stdout.on("data", onStdout)
      child.stderr.on("data", onStderr)
      child.stdin.on("error", onStdinError)
      options.signal?.addEventListener("abort", onAbort, { once: true })
      timeout = setTimeout(() => {
        terminate({
          message: `Command timed out after ${options.timeoutMs} ms`,
          outcome: { kind: "timeout", timeoutMs: options.timeoutMs },
        })
      }, options.timeoutMs)

      if (options.stdin === undefined) {
        child.stdin.end()
      } else {
        child.stdin.end(options.stdin)
      }
    })
  }
}

export const executeCommand = createCommandExecutor()

function expectCallerArgs(args: readonly string[]): readonly string[] {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new Error("Command args must be an array of strings")
  }
  const smuggled = args.find((argument) => WRAPPER_OWNED_ARGUMENT_PATTERN.test(argument))
  if (smuggled !== undefined) {
    throw new Error(`Argument ${smuggled} is wrapper-owned and cannot be supplied by the caller`)
  }
  return args
}

function ownedCommand(file: string, args: readonly string[]): Command {
  return Object.freeze({ file, args: Object.freeze([...args]) })
}

export const kubectl = Object.freeze({
  command(
    context: string,
    args: readonly string[],
    options: { readonly kubeconfig?: string } = {},
  ): Command {
    const ownedContext = expectNonEmptyString(context, "kubectl context")
    const callerArgs = expectCallerArgs(args)
    const kubeconfig =
      options.kubeconfig === undefined
        ? undefined
        : expectNonEmptyString(options.kubeconfig, "kubectl kubeconfig")
    return ownedCommand("kubectl", [
      ...(kubeconfig !== undefined ? ["--kubeconfig", kubeconfig] : []),
      "--context",
      ownedContext,
      ...callerArgs,
    ])
  },
  currentContextCommand(): Command {
    return ownedCommand("kubectl", ["config", "current-context"])
  },
})

export const helm = Object.freeze({
  command(context: string, args: readonly string[]): Command {
    const ownedContext = expectNonEmptyString(context, "Helm context")
    const callerArgs = expectCallerArgs(args)
    return ownedCommand("helm", ["--kube-context", ownedContext, ...callerArgs])
  },
})
