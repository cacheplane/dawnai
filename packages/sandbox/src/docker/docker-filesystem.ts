import { randomUUID } from "node:crypto"
import type { BackendContext, FilesystemBackend } from "@dawn-ai/workspace"
import type { Docker, SpawnResult } from "./docker-cli.js"
import {
  type DockerPidExhaustionRecovery,
  isDockerExecAdmissionPidExhaustion,
  isStartedShellPidExhaustion,
} from "./docker-pid-exhaustion.js"

interface DockerFilesystemOptions {
  readonly runWithExecLease?: <T>(operation: () => Promise<T>) => Promise<T>
  readonly pidExhaustionRecovery?: DockerPidExhaustionRecovery
}

function q(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** FilesystemBackend whose ops run inside a docker container via `docker exec`. */
export function dockerFilesystem(
  docker: Docker,
  container: string,
  opts: DockerFilesystemOptions = {},
): FilesystemBackend {
  const run = async (cmd: string, ctx: BackendContext, stdin?: string): Promise<SpawnResult> => {
    const startedMarker = `__DAWN_FILESYSTEM_STARTED_${randomUUID()}__`
    const startedPrefix = `${startedMarker}\n`
    const attempt = async () => {
      const result = await docker.exec(
        container,
        ["sh", "-c", `printf '%s\\n' ${q(startedMarker)}; ${cmd}`],
        {
          ...(stdin !== undefined ? { stdin } : {}),
          signal: ctx.signal,
        },
      )
      const started = result.stdout.startsWith(startedPrefix)
      return {
        result: started ? { ...result, stdout: result.stdout.slice(startedPrefix.length) } : result,
        started,
      }
    }
    const executeWithLease = <T>(operation: () => Promise<T>) =>
      opts.runWithExecLease !== undefined ? opts.runWithExecLease(operation) : operation()
    let recoveryToken: unknown
    const firstAttempt = await executeWithLease(async () => {
      recoveryToken = opts.pidExhaustionRecovery?.captureToken()
      return attempt()
    })
    let result = firstAttempt.result
    if (
      opts.pidExhaustionRecovery !== undefined &&
      recoveryToken !== undefined &&
      (firstAttempt.started
        ? isStartedShellPidExhaustion(result)
        : isDockerExecAdmissionPidExhaustion(result))
    ) {
      const recovered = await opts.pidExhaustionRecovery.recoverAndRetry(
        recoveryToken,
        async () => (await attempt()).result,
      )
      if (recovered !== undefined) result = recovered
    }
    return result
  }
  return {
    async readFile(path, ctx, opts) {
      const r = await run(`cat ${q(path)}`, ctx)
      if (r.exitCode !== 0) throw new Error(`readFile failed: ${r.stderr.trim()}`)
      const max = opts?.maxBytes
      if (max !== undefined && Number.isFinite(max) && Buffer.byteLength(r.stdout) > max) {
        throw new Error(`readFile ${path}: content exceeds maxBytes (${max}).`)
      }
      return r.stdout
    },
    async writeFile(path, content, ctx) {
      const r = await run(`mkdir -p "$(dirname ${q(path)})" && cat > ${q(path)}`, ctx, content)
      if (r.exitCode !== 0) throw new Error(`writeFile failed: ${r.stderr.trim()}`)
      return { bytesWritten: Buffer.byteLength(content) }
    },
    async listDir(path, ctx) {
      const r = await run(`ls -1 ${q(path)}`, ctx)
      if (r.exitCode !== 0) throw new Error(`listDir failed: ${r.stderr.trim()}`)
      return r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    },
    async realPath(path, ctx) {
      const r = await run(`realpath -m ${q(path)}`, ctx)
      return r.exitCode === 0 ? r.stdout.trim() : path
    },
    async statFile(path, ctx) {
      const r = await run(`stat -c '%s %Y' ${q(path)}`, ctx)
      if (r.exitCode !== 0) throw new Error(`statFile failed: ${r.stderr.trim()}`)
      const [size, mtime] = r.stdout.trim().split(" ")
      return { size: Number(size), mtimeMs: Number(mtime) * 1000 }
    },
    async removeFile(path, ctx) {
      await run(`rm -f ${q(path)}`, ctx)
    },
    async touchFile(path, ctx) {
      await run(`touch ${q(path)}`, ctx)
    },
    async mkdir(path, ctx) {
      await run(`mkdir -p ${q(path)}`, ctx)
    },
  }
}
