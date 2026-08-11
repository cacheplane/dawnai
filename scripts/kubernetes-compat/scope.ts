import { spawn } from "node:child_process"
import { TextDecoder } from "node:util"

export const KUBERNETES_COMPATIBILITY_PATHS = Object.freeze({
  exact: Object.freeze([
    ".npmrc",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "turbo.json",
    ".github/workflows/ci.yml",
    ".github/workflows/kubernetes-compat.yml",
    ".github/kubernetes-compatibility.json",
    "scripts/kubernetes-compat.ts",
    "packages/workspace/src/sandbox-types.ts",
  ]),
  prefixes: Object.freeze([
    ".github/kind/",
    "scripts/kubernetes-compat/",
    "test/k8s-compat/",
    "test/k8s-smoke/",
    "packages/sandbox/",
    "charts/dawn-app/",
    "charts/dawn-sandbox-infra/",
  ]),
})

export interface GitCommandResult {
  readonly stdout: Buffer
}

export type GitCommandRunner = (file: string, args: readonly string[]) => Promise<GitCommandResult>

interface GitCommandOptions {
  readonly timeoutMs: number
  readonly stdoutLimitBytes: number
  readonly stderrLimitBytes: number
}

export const GIT_COMMAND_DEFAULTS: Readonly<GitCommandOptions> = Object.freeze({
  timeoutMs: 30_000,
  stdoutLimitBytes: 32 * 1_024 * 1_024,
  stderrLimitBytes: 64 * 1_024,
})

export interface KubernetesCompatibilityScopeRequest {
  readonly event: unknown
  readonly base?: unknown
  readonly head?: unknown
}

const EXACT_PATHS = new Set<string>(KUBERNETES_COMPATIBILITY_PATHS.exact)
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/

interface BoundedBuffer {
  readonly chunks: Buffer[]
  bytes: number
  readonly limitBytes: number
}

interface PendingCommandFailure {
  readonly message: string
  readonly cause: unknown
}

export function isKubernetesCompatibilityPath(path: string): boolean {
  return (
    EXACT_PATHS.has(path) ||
    KUBERNETES_COMPATIBILITY_PATHS.prefixes.some((prefix) => path.startsWith(prefix))
  )
}

export function parseNulDelimitedGitPaths(output: Buffer): readonly string[] {
  if (output.length === 0) {
    return []
  }
  if (output[output.length - 1] !== 0) {
    throw new Error("Malformed NUL-delimited Git diff output: missing final NUL byte")
  }

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  const paths: string[] = []
  let start = 0

  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) {
      continue
    }
    if (index === start) {
      throw new Error("Malformed NUL-delimited Git diff output: empty filename")
    }

    try {
      paths.push(decoder.decode(output.subarray(start, index)))
    } catch (cause) {
      throw new Error("Malformed Git diff filename: expected valid UTF-8", { cause })
    }
    start = index + 1
  }

  return paths
}

function resolvePositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return resolved
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

function commandError(message: string, stderr: BoundedBuffer, cause: unknown = undefined): Error {
  const diagnostic = Buffer.concat(stderr.chunks, stderr.bytes).toString("utf8").trim()
  const fullMessage = `${message}${diagnostic.length > 0 ? `: ${diagnostic}` : ""}`
  return cause === undefined ? new Error(fullMessage) : new Error(fullMessage, { cause })
}

export function runGitCommand(
  file: string,
  args: readonly string[],
  options: Partial<GitCommandOptions> = {},
): Promise<GitCommandResult> {
  let timeoutMs: number
  let stdoutLimitBytes: number
  let stderrLimitBytes: number
  try {
    timeoutMs = resolvePositiveInteger(
      options.timeoutMs,
      GIT_COMMAND_DEFAULTS.timeoutMs,
      "Git command timeout",
    )
    stdoutLimitBytes = resolvePositiveInteger(
      options.stdoutLimitBytes,
      GIT_COMMAND_DEFAULTS.stdoutLimitBytes,
      "Git command stdout limit",
    )
    stderrLimitBytes = resolvePositiveInteger(
      options.stderrLimitBytes,
      GIT_COMMAND_DEFAULTS.stderrLimitBytes,
      "Git command stderr limit",
    )
  } catch (error) {
    return Promise.reject(error)
  }

  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: BoundedBuffer = { chunks: [], bytes: 0, limitBytes: stdoutLimitBytes }
    const stderr: BoundedBuffer = { chunks: [], bytes: 0, limitBytes: stderrLimitBytes }
    let spawned = false
    let settled = false
    let pendingFailure: PendingCommandFailure | undefined
    let timeout: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout)
        timeout = undefined
      }
      child.off("spawn", onSpawn)
      child.off("error", onError)
      child.off("close", onClose)
      child.stdout.off("data", onStdout)
      child.stderr.off("data", onStderr)
    }

    const settle = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (error === undefined) {
        resolve({ stdout: Buffer.concat(stdout.chunks, stdout.bytes) })
      } else {
        reject(error)
      }
    }

    const terminate = (message: string, cause: unknown = undefined): void => {
      if (settled || pendingFailure !== undefined) {
        return
      }
      pendingFailure = { message, cause }
      child.kill("SIGKILL")
    }

    const onSpawn = (): void => {
      spawned = true
    }

    const onStdout = (chunk: Buffer): void => {
      if (settled || pendingFailure !== undefined) {
        return
      }
      if (!appendBounded(stdout, chunk)) {
        terminate(`Command ${file} stdout exceeded ${stdoutLimitBytes} bytes`)
      }
    }

    const onStderr = (chunk: Buffer): void => {
      if (settled || pendingFailure !== undefined) {
        return
      }
      if (!appendBounded(stderr, chunk)) {
        terminate(`Command ${file} stderr exceeded ${stderrLimitBytes} bytes`)
      }
    }

    const onError = (cause: Error): void => {
      if (pendingFailure !== undefined) {
        return
      }
      if (!spawned) {
        settle(new Error(`Failed to start command ${file}: ${cause.message}`, { cause }))
        return
      }
      terminate(`Command ${file} encountered a child-process error`, cause)
    }

    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (pendingFailure !== undefined) {
        settle(commandError(pendingFailure.message, stderr, pendingFailure.cause))
        return
      }
      if (code === 0) {
        settle()
        return
      }

      const outcome = signal === null ? `exit code ${String(code)}` : `signal ${signal}`
      settle(commandError(`Command ${file} failed with ${outcome}`, stderr))
    }

    child.once("spawn", onSpawn)
    child.on("error", onError)
    child.once("close", onClose)
    child.stdout.on("data", onStdout)
    child.stderr.on("data", onStderr)
    timeout = setTimeout(() => {
      terminate(`Command ${file} timed out after ${timeoutMs} ms`)
    }, timeoutMs)
  })
}

function expectCommitSha(value: unknown, name: "base" | "head"): string {
  if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
    throw new Error(`Pull-request ${name} SHA must be exactly 40 lowercase hexadecimal characters`)
  }
  return value
}

export async function classifyKubernetesCompatibilityScope(
  request: KubernetesCompatibilityScopeRequest,
  runCommand: GitCommandRunner = runGitCommand,
): Promise<boolean> {
  if (request.event === "schedule" || request.event === "workflow_dispatch") {
    return true
  }
  if (request.event !== "pull_request") {
    throw new Error(`Unknown Kubernetes compatibility event mode: ${String(request.event)}`)
  }

  const base = expectCommitSha(request.base, "base")
  const head = expectCommitSha(request.head, "head")

  await runCommand("git", ["cat-file", "-e", `${base}^{commit}`])
  await runCommand("git", ["cat-file", "-e", `${head}^{commit}`])
  const { stdout } = await runCommand("git", ["diff", "--name-only", "-z", base, head])
  if (!Buffer.isBuffer(stdout)) {
    throw new Error("Malformed Git diff output: expected a Buffer")
  }

  return parseNulDelimitedGitPaths(stdout).some(isKubernetesCompatibilityPath)
}
