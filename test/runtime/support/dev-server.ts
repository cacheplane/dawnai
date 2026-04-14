import { spawn, type ChildProcess } from "node:child_process"
import { access, appendFile, mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join } from "node:path"

export interface RunsWaitInvocation {
  readonly assistantId: string
  readonly input: unknown
  readonly mode: "graph" | "workflow"
  readonly routeId: string
  readonly routePath: string
}

export async function allocatePort(): Promise<number> {
  const server = createServer()

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      resolve()
    })
  })

  const address = server.address()

  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate a TCP port")
  }

  const port = address.port

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })

  return port
}

export async function appendDevServerTranscript(
  transcriptPath: string,
  devServer: DevServerHandle,
): Promise<void> {
  await mkdir(dirname(transcriptPath), { recursive: true })
  await appendFile(
    transcriptPath,
    [
      "$ dawn dev",
      devServer.stdout.trimEnd(),
      devServer.stderr.trimEnd().length > 0 ? "[stderr]" : "",
      devServer.stderr.trimEnd(),
      "",
    ]
      .filter((chunk, index, chunks) => chunk.length > 0 || index === chunks.length - 1)
      .join("\n"),
    "utf8",
  )
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function invokeRunsWait(baseUrl: string, invocation: RunsWaitInvocation): Promise<Response> {
  return await fetch(new URL("/runs/wait", baseUrl), {
    body: JSON.stringify({
      assistant_id: invocation.assistantId,
      input: invocation.input,
      metadata: {
        dawn: {
          mode: invocation.mode,
          route_id: invocation.routeId,
          route_path: invocation.routePath,
        },
      },
      on_completion: "delete",
    }),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  })
}

export async function postRunsWait(baseUrl: string, options: {
  readonly body: string
  readonly headers?: Readonly<Record<string, string>>
}): Promise<Response> {
  return await fetch(new URL("/runs/wait", baseUrl), {
    body: options.body,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    method: "POST",
  })
}

export async function startDevServer(options: {
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly port?: number
}): Promise<DevServerHandle> {
  const args = ["exec", "dawn", "dev"]

  if (typeof options.port === "number") {
    args.push("--port", String(options.port))
  }

  const child = spawn("pnpm", args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  return new DevServerHandle(child, options.cwd)
}

export async function waitForPath(path: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await access(path)
      return
    } catch {}

    await delay(25)
  }

  throw new Error(`Timed out waiting for path ${path}`)
}

function countOccurrences(input: string, needle: string): number {
  return input.split(needle).length - 1
}

export class DevServerHandle {
  readonly child: ChildProcess
  readonly cwd: string
  readonly exitPromise: Promise<number | null>
  stderr = ""
  stdout = ""
  private exitCode: number | null | undefined

  constructor(child: ChildProcess, cwd: string) {
    this.child = child
    this.cwd = cwd
    this.exitPromise = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code) => {
        this.exitCode = code
        resolve(code)
      })
    })

    child.stdout?.on("data", (chunk) => {
      this.stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      this.stderr += String(chunk)
    })
  }

  get exited(): boolean {
    return this.exitCode !== undefined
  }

  async stop(): Promise<void> {
    if (this.exited) {
      return
    }

    this.child.kill("SIGTERM")

    const code = await Promise.race([
      this.exitPromise,
      delay(2_000).then(() => {
        this.child.kill("SIGKILL")
        return this.exitPromise
      }),
    ])

    await code
  }

  async waitForExit(): Promise<number | null> {
    return await this.exitPromise
  }

  async waitForLog(pattern: RegExp, timeoutMs = 5_000): Promise<void> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      if (pattern.test(this.stdout) || pattern.test(this.stderr)) {
        return
      }

      if (this.exited) {
        break
      }

      await delay(25)
    }

    throw new Error(`Timed out waiting for log ${pattern}\nSTDOUT:\n${this.stdout}\nSTDERR:\n${this.stderr}`)
  }

  async waitForReady(timeoutMs = 8_000): Promise<string> {
    return await this.waitForNextReady(0, timeoutMs)
  }

  readyCount(): number {
    return countOccurrences(this.stdout, "Dawn dev ready at")
  }

  async waitForNextReady(previousCount: number, timeoutMs = 8_000): Promise<string> {
    const url = await this.waitForPrintedUrl(timeoutMs)
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      if (this.readyCount() <= previousCount) {
        if (this.exited) {
          break
        }

        await delay(25)
        continue
      }

      try {
        const response = await fetch(new URL("/healthz", url))

        if (response.status === 200) {
          const body = (await response.json()) as { readonly status?: string }

          if (body.status === "ready") {
            return url
          }
        }
      } catch {}

      if (this.exited) {
        break
      }

      await delay(25)
    }

    throw new Error(`Timed out waiting for dawn dev readiness\nSTDOUT:\n${this.stdout}\nSTDERR:\n${this.stderr}`)
  }

  async waitForNotReady(timeoutMs = 5_000): Promise<void> {
    const url = await this.waitForPrintedUrl(timeoutMs)
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      try {
        const response = await fetch(new URL("/healthz", url))

        if (response.status !== 200) {
          return
        }
      } catch {
        return
      }

      if (this.exited) {
        return
      }

      await delay(25)
    }

    throw new Error(`Timed out waiting for dawn dev to become not-ready\nSTDOUT:\n${this.stdout}\nSTDERR:\n${this.stderr}`)
  }

  async writeFile(relativePath: string, source: string): Promise<void> {
    const absolutePath = join(this.cwd, relativePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, source, "utf8")
  }

  private async waitForPrintedUrl(timeoutMs: number): Promise<string> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      const match = this.stdout.match(/http:\/\/127\.0\.0\.1:\d+/)

      if (match) {
        return match[0]
      }

      if (this.exited) {
        break
      }

      await delay(25)
    }

    throw new Error(`Timed out waiting for dawn dev URL\nSTDOUT:\n${this.stdout}\nSTDERR:\n${this.stderr}`)
  }
}
