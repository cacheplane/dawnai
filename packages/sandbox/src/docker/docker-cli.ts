import { spawn } from "node:child_process"

export interface SpawnResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type Spawner = (
  args: readonly string[],
  opts?: { readonly stdin?: string; readonly signal?: AbortSignal },
) => Promise<SpawnResult>

const defaultSpawn: Spawner = (args, opts) =>
  new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn("docker", [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts?.signal ? { signal: opts.signal } : {}),
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => {
      stdout += String(c)
    })
    child.stderr.on("data", (c) => {
      stderr += String(c)
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }))
    if (opts?.stdin !== undefined) child.stdin.end(opts.stdin)
    else child.stdin.end()
  })

export interface Docker {
  run(args: readonly string[], opts?: { readonly signal?: AbortSignal }): Promise<SpawnResult>
  exec(
    container: string,
    command: readonly string[],
    opts?: { readonly stdin?: string; readonly signal?: AbortSignal },
  ): Promise<SpawnResult>
}

/** Thin docker-CLI wrapper. `spawn` is injectable so unit tests need no daemon. */
export function createDocker(deps: { readonly spawn?: Spawner } = {}): Docker {
  const sp = deps.spawn ?? defaultSpawn
  return {
    run: (args, opts) => sp(args, opts),
    exec: (container, command, opts) => sp(["exec", "-i", container, ...command], opts),
  }
}
