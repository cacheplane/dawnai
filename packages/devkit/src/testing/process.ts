import { spawn } from "node:child_process"

export interface SpawnProcessOptions {
  readonly args?: readonly string[]
  readonly command: string
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
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

export async function spawnProcess(options: SpawnProcessOptions): Promise<SpawnProcessResult> {
  const args = options.args ?? []
  const env = {
    ...process.env,
    ...options.env,
  }

  return await new Promise<SpawnProcessResult>((resolve, reject) => {
    const child = spawn(options.command, [...args], {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk: string | Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on("data", (chunk: string | Buffer) => {
      stderr += chunk.toString()
    })

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
