import { exec as cpExec } from "node:child_process"
import { promisify } from "node:util"
import type { BackendContext, ExecBackend } from "./types.js"

const execAsync = promisify(cpExec)
const DEFAULT_TIMEOUT_MS = 30_000

export interface LocalExecOptions {
  /** Kill the command if it runs longer than this. Default 30 seconds. */
  readonly timeout?: number
  /**
   * Optional allowlist of command-line patterns. When non-empty, every
   * command must match at least one regex or `runCommand` throws before
   * spawning anything. Use to deny dangerous commands in production.
   */
  readonly allowedCommands?: readonly RegExp[]
}

export function localExec(opts: LocalExecOptions = {}): ExecBackend {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS
  const allowed = opts.allowedCommands
  return {
    async runCommand(args, ctx: BackendContext) {
      if (allowed && allowed.length > 0 && !allowed.some((re) => re.test(args.command))) {
        throw new Error(`Command not allowed by allowedCommands policy: ${args.command}`)
      }
      try {
        const result = await execAsync(args.command, {
          cwd: args.cwd ?? ctx.workspaceRoot,
          env: args.env ?? process.env,
          timeout,
          signal: ctx.signal,
        })
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
      } catch (err) {
        const e = err as NodeJS.ErrnoException & {
          code?: number | string
          stdout?: string
          stderr?: string
          killed?: boolean
        }
        if (e.killed && typeof e.code !== "number") {
          throw new Error(`Command timeout after ${timeout}ms: ${args.command}`)
        }
        return {
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
          exitCode: typeof e.code === "number" ? e.code : 1,
        }
      }
    },
  }
}
