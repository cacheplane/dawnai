import { spawn } from "node:child_process"

export interface SpawnProcessOptions {
  readonly args?: readonly string[]
  readonly command: string
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly shell?: boolean | string
  readonly stdin?: string
  readonly unsetEnv?: readonly string[]
}

export interface SpawnProcessResult {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly exitCode: number | null
  readonly ok: boolean
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
  readonly stdout: string
}

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

  return await new Promise<SpawnProcessResult>((resolve, reject) => {
    const child = spawn(options.command, [...args], {
      cwd: options.cwd,
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

    child.on("error", reject)
    child.on("close", (exitCode, signal) => {
      resolve({
        args,
        command: options.command,
        cwd: options.cwd ?? process.cwd(),
        exitCode,
        ok: exitCode === 0,
        signal,
        stderr,
        stdout,
      })
    })
  })
}
