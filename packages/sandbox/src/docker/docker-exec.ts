import type { BackendContext, ExecBackend } from "@dawn-ai/workspace"
import type { Docker, SpawnResult } from "./docker-cli.js"

interface DockerExecOptions {
  readonly timeoutMs?: number
  readonly recoverFromPidExhaustion?: (signal: AbortSignal) => Promise<void>
}

function isPidExhaustion(result: SpawnResult): boolean {
  if (result.exitCode === 0) return false
  const output = `${result.stdout}\n${result.stderr}`
  return (
    output.includes("OCI runtime exec failed") &&
    (output.includes("Resource temporarily unavailable") ||
      output.includes("read init-p: connection reset by peer"))
  )
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** ExecBackend that runs commands inside a docker container via `docker exec sh -c`. */
export function dockerExec(
  docker: Docker,
  container: string,
  opts: DockerExecOptions = {},
): ExecBackend {
  return {
    async runCommand(args, ctx: BackendContext) {
      const envPrefix = args.env
        ? Object.entries(args.env)
            .map(([k, v]) => {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
                throw new Error(
                  `Invalid environment variable name ${JSON.stringify(k)}: keys must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
                )
              }
              return `${k}=${shellQuote(v)} `
            })
            .join("")
        : ""
      const cwd = args.cwd ?? ctx.workspaceRoot
      const cdPrefix = cwd ? `cd ${shellQuote(cwd)} && ` : ""
      const full = `${envPrefix}${cdPrefix}${args.command}`
      const shArgs = ["sh", "-c", full]
      // `timeout` has second granularity, so round up to the enforced ceiling and
      // report THAT (not the raw ms) — otherwise `timeoutMs: 500` reports "500ms"
      // while the process actually gets a full 1s.
      const timeoutSecs =
        opts.timeoutMs !== undefined ? Math.ceil(opts.timeoutMs / 1000) : undefined
      const argv = timeoutSecs !== undefined ? ["timeout", `${timeoutSecs}s`, ...shArgs] : shArgs
      const execute = () => docker.exec(container, argv, { signal: ctx.signal })
      let r = await execute()
      if (opts.recoverFromPidExhaustion !== undefined && isPidExhaustion(r)) {
        await opts.recoverFromPidExhaustion(ctx.signal)
        r = await execute()
      }
      if (timeoutSecs !== undefined && r.exitCode === 124) {
        return {
          stdout: r.stdout,
          stderr: `${r.stderr}${r.stderr ? "\n" : ""}Command timed out after ${timeoutSecs}s (resources.timeoutMs: ${opts.timeoutMs}ms).`,
          exitCode: 124,
        }
      }
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
    },
  }
}
