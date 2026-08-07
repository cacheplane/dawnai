import { randomUUID } from "node:crypto"
import type { BackendContext, ExecBackend } from "@dawn-ai/workspace"
import type { Docker, SpawnResult } from "./docker-cli.js"

interface DockerExecOptions {
  readonly timeoutMs?: number
  readonly runWithExecLease?: <T>(operation: () => Promise<T>) => Promise<T>
  readonly pidExhaustionRecovery?: {
    readonly captureToken: () => unknown
    readonly recoverAndRetry: (
      token: unknown,
      retry: () => Promise<SpawnResult>,
    ) => Promise<SpawnResult | undefined>
  }
}

function isPidExhaustion(result: SpawnResult): boolean {
  if (result.exitCode === 0) return false
  const output = `${result.stdout}\n${result.stderr}`
  return (
    output.includes("OCI runtime exec failed") &&
    (output.includes("Resource temporarily unavailable") ||
      output.includes("read init-p: connection reset by peer") ||
      (output.includes("unable to start container process") &&
        output.includes("procReady not received")))
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
      const startedMarker = `__DAWN_EXEC_STARTED_${randomUUID()}__`
      const startedPrefix = `${startedMarker}\n`
      const shArgs = ["sh", "-c", `printf '%s\\n' ${shellQuote(startedMarker)}; ${full}`]
      // `timeout` has second granularity, so round up to the enforced ceiling and
      // report THAT (not the raw ms) — otherwise `timeoutMs: 500` reports "500ms"
      // while the process actually gets a full 1s.
      const timeoutSecs =
        opts.timeoutMs !== undefined ? Math.ceil(opts.timeoutMs / 1000) : undefined
      const argv = timeoutSecs !== undefined ? ["timeout", `${timeoutSecs}s`, ...shArgs] : shArgs
      const attempt = async () => {
        const result = await docker.exec(container, argv, { signal: ctx.signal })
        const started = result.stdout.startsWith(startedPrefix)
        return {
          result: started
            ? { ...result, stdout: result.stdout.slice(startedPrefix.length) }
            : result,
          started,
        }
      }
      const executeWithLease = <T>(operation: () => Promise<T>) =>
        opts.runWithExecLease !== undefined ? opts.runWithExecLease(operation) : operation()
      let recoveryToken: unknown
      const firstAttempt = await executeWithLease(async () => {
        // Token capture and Docker admission share one lease. A queued command
        // therefore records the generation of the keeper it actually enters,
        // not the generation that existed before an earlier recovery.
        recoveryToken = opts.pidExhaustionRecovery?.captureToken()
        return attempt()
      })
      let r = firstAttempt.result
      const isConfiguredTimeout = timeoutSecs !== undefined && r.exitCode === 124
      if (
        opts.pidExhaustionRecovery !== undefined &&
        recoveryToken !== undefined &&
        !isConfiguredTimeout &&
        !firstAttempt.started &&
        isPidExhaustion(r)
      ) {
        const recovered = await opts.pidExhaustionRecovery.recoverAndRetry(
          recoveryToken,
          // Recovery owns the exclusive lifecycle lease, so its retry must run
          // directly rather than attempting to acquire a nested shared lease.
          async () => (await attempt()).result,
        )
        if (recovered !== undefined) r = recovered
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
