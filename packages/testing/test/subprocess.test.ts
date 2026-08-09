import { ChildProcess, spawn } from "node:child_process"
import { createConnection, createServer } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import { createAimock } from "../src/aimock-runner.js"
import { createSubprocessApp, terminateSubprocess } from "../src/subprocess.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const processTreeFixture = fileURLToPath(new URL("./fixtures/subprocess-tree.mjs", import.meta.url))
const TEST_TERMINATION_TIMINGS = {
  graceMs: 100,
  forceMs: 100,
  probeIntervalMs: 5,
  probeTimeoutMs: 10,
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

async function waitForProcessGroupExit(target: number): Promise<void> {
  const observeExit = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        process.kill(target, 0)
      } catch (error) {
        if (hasErrorCode(error, "ESRCH")) return true
        if (!hasErrorCode(error, "EPERM")) throw error
      }
      await delay(10)
    }
    return false
  }

  if (await observeExit()) return
  try {
    process.kill(target, "SIGKILL")
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return
    throw error
  }
  if (!(await observeExit())) {
    throw new Error(`process group ${-target} remained after SIGKILL`)
  }
}

function childExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once("close", () => resolve()))
}

async function waitForChildExit(
  child: ChildProcess,
  exited: Promise<void>,
  forceKill: (this: ChildProcess, signal?: NodeJS.Signals | number) => boolean,
): Promise<void> {
  if (await Promise.race([exited.then(() => true), delay(2_000, false)])) return
  try {
    forceKill.call(child, "SIGKILL")
  } catch (error) {
    if (!hasErrorCode(error, "ESRCH")) throw error
  }
  if (!(await Promise.race([exited.then(() => true), delay(2_000, false)]))) {
    throw new Error(`child process ${child.pid ?? "unknown"} remained after SIGKILL`)
  }
}

function delaySubprocessTermination() {
  const realKill = process.kill.bind(process)
  const realChildKill = ChildProcess.prototype.kill
  const delayedGroups: Array<{ readonly target: number; readonly delivered: Promise<void> }> = []
  const delayedChildren: Array<{
    readonly child: ChildProcess
    readonly delivered: Promise<void>
    readonly exited: Promise<void>
  }> = []
  const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (typeof pid === "number" && pid < 0 && signal === "SIGTERM") {
      // Windows does not support negative-PID process groups. Let the real call
      // throw synchronously so createSubprocessApp exercises its child.kill()
      // fallback, which the ChildProcess spy below delays instead.
      if (process.platform === "win32") return realKill(pid, signal)
      const delivered = delay(100).then(() => {
        try {
          realKill(pid, signal)
        } catch (error) {
          if (!hasErrorCode(error, "ESRCH")) throw error
        }
      })
      delayedGroups.push({ target: pid, delivered })
      return true
    }
    return realKill(pid, signal)
  })
  const childKillSpy = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (
    this: ChildProcess,
    signal,
  ) {
    if (process.platform === "win32" && signal === "SIGTERM") {
      const exited = childExit(this)
      const delivered = delay(100).then(() => {
        if (this.exitCode === null && this.signalCode === null) {
          realChildKill.call(this, signal)
        }
      })
      delayedChildren.push({ child: this, delivered, exited })
      return true
    }
    return realChildKill.call(this, signal)
  })

  return async (): Promise<void> => {
    killSpy.mockRestore()
    childKillSpy.mockRestore()
    await Promise.all(
      [...new Map(delayedGroups.map((entry) => [entry.target, entry])).values()].map(
        async ({ delivered, target }) => {
          try {
            await delivered
          } finally {
            await waitForProcessGroupExit(target)
          }
        },
      ),
    )
    await Promise.all(
      delayedChildren.map(async ({ child, delivered, exited }) => {
        try {
          await delivered
        } finally {
          await waitForChildExit(child, exited, realChildKill)
        }
      }),
    )
  }
}

async function spawnTree(mode: "idle" | "ignore-term" | "leader") {
  const child = spawn(process.execPath, [processTreeFixture, mode], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  })
  if (child.pid === undefined) throw new Error("fixture process has no pid")
  const groupPid = child.pid
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", () => resolve())
  })
  const line = await new Promise<string>((resolve, reject) => {
    let output = ""
    child.once("error", reject)
    child.once("close", () => {
      if (!output.includes("\n")) reject(new Error("fixture closed before readiness"))
    })
    child.stdout?.on("data", (chunk) => {
      output += String(chunk)
      if (output.includes("\n")) resolve(output.trim())
    })
  })
  return { child, closed, groupPid, line }
}

function canConnect(baseUrl: string): Promise<boolean> {
  const url = new URL(baseUrl)
  return new Promise((resolve) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })
}

async function forceKillProcessGroup(groupPid: number, kill: typeof process.kill): Promise<void> {
  try {
    kill(-groupPid, "SIGKILL")
  } catch (error) {
    if (!hasErrorCode(error, "ESRCH")) throw error
  }
  await waitForProcessGroupExit(-groupPid)
}

async function unavailableBaseUrl(): Promise<string> {
  const server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || address === null) {
        reject(new Error("temporary server did not expose a TCP port"))
        return
      }
      resolve(address.port)
    })
  })
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return `http://127.0.0.1:${port}`
}

it("boots a real dawn dev subprocess and serves the AP", async () => {
  const mock = await createAimock({ fixtures: [{ match: {}, response: { content: "ok" } }] })
  const app = await createSubprocessApp({
    appRoot,
    env: { OPENAI_BASE_URL: mock.baseUrl, OPENAI_API_KEY: "test-not-used" },
  })
  try {
    const res = await fetch(new URL("/threads", app.baseUrl), {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { thread_id?: string }
    expect(body.thread_id).toBeTruthy()
  } finally {
    await app.close()
    await mock.close()
  }
}, 120_000)

it("disposes the subprocess via `await using` and leaves it unreachable", async () => {
  const mock = await createAimock({ fixtures: [{ match: {}, response: { content: "ok" } }] })
  let baseUrl: string
  try {
    {
      await using app = await createSubprocessApp({
        appRoot,
        env: { OPENAI_BASE_URL: mock.baseUrl, OPENAI_API_KEY: "test-not-used" },
      })
      baseUrl = app.baseUrl
      const res = await fetch(new URL("/healthz", app.baseUrl))
      expect(res.ok).toBe(true)
    }
    // After the block the child process has been killed — the port is gone.
    await expect(fetch(new URL("/healthz", baseUrl))).rejects.toThrow()
  } finally {
    await mock.close()
  }
}, 120_000)

it("waits for process shutdown and shares one close promise", async () => {
  let mock: Awaited<ReturnType<typeof createAimock>> | undefined
  let app: Awaited<ReturnType<typeof createSubprocessApp>> | undefined
  const finishDelayedTerminations = delaySubprocessTermination()

  try {
    mock = await createAimock({ fixtures: [{ match: {}, response: { content: "ok" } }] })
    app = await createSubprocessApp({
      appRoot,
      env: { OPENAI_BASE_URL: mock.baseUrl, OPENAI_API_KEY: "test-not-used" },
    })
    const first = app.close()
    const second = app.close()
    const disposed = app[Symbol.asyncDispose]()
    expect(second).toBe(first)
    expect(disposed).toBe(first)
    await expect(Promise.race([first.then(() => "closed"), delay(25, "waiting")])).resolves.toBe(
      "waiting",
    )
    await first
    await expect(fetch(new URL("/healthz", app.baseUrl))).rejects.toThrow()
  } finally {
    try {
      if (app) await app.close()
    } finally {
      try {
        await finishDelayedTerminations()
      } finally {
        if (mock) await mock.close()
      }
    }
  }
}, 120_000)

it("waits for cleanup when readiness fails", async () => {
  const finishDelayedTerminations = delaySubprocessTermination()

  try {
    const creating = createSubprocessApp({ appRoot, readyTimeoutMs: 0 })
    const outcome = creating.then(
      () => "created",
      () => "rejected",
    )
    await expect(Promise.race([outcome, delay(25, "waiting")])).resolves.toBe("waiting")
    await expect(creating).rejects.toThrow("within 0ms")
  } finally {
    await finishDelayedTerminations()
  }
}, 120_000)

it.skipIf(process.platform === "win32")(
  "waits for a surviving descendant to release the port",
  async () => {
    const realKill = process.kill.bind(process)
    const { child, closed, groupPid, line } = await spawnTree("leader")
    const baseUrl = `http://127.0.0.1:${Number(line)}`
    try {
      await closed
      expect(await canConnect(baseUrl)).toBe(true)
      await terminateSubprocess(child, groupPid, closed, baseUrl, TEST_TERMINATION_TIMINGS)
      expect(await canConnect(baseUrl)).toBe(false)
    } finally {
      await forceKillProcessGroup(groupPid, realKill)
    }
  },
)

it.skipIf(process.platform === "win32")(
  "escalates an ignoring process group to SIGKILL",
  async () => {
    const realKill = process.kill.bind(process)
    const { child, closed, groupPid } = await spawnTree("ignore-term")
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, signal) => realKill(pid, signal))
    try {
      await terminateSubprocess(
        child,
        groupPid,
        closed,
        await unavailableBaseUrl(),
        TEST_TERMINATION_TIMINGS,
      )
      expect(killSpy).toHaveBeenCalledWith(-groupPid, "SIGKILL")
    } finally {
      killSpy.mockRestore()
      await forceKillProcessGroup(groupPid, realKill)
    }
  },
)

it.skipIf(process.platform === "win32")(
  "rejects on bounded failure after the forced-termination deadline",
  async () => {
    const realKill = process.kill.bind(process)
    const { child, closed, groupPid } = await spawnTree("ignore-term")
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -groupPid && (signal === "SIGTERM" || signal === "SIGKILL")) {
        return true
      }
      return realKill(pid, signal)
    })
    try {
      await expect(
        terminateSubprocess(
          child,
          groupPid,
          closed,
          await unavailableBaseUrl(),
          TEST_TERMINATION_TIMINGS,
        ),
      ).rejects.toThrow(
        `subprocess group ${groupPid} did not stop within ${TEST_TERMINATION_TIMINGS.graceMs + TEST_TERMINATION_TIMINGS.forceMs}ms`,
      )
      expect(killSpy).toHaveBeenCalledWith(-groupPid, "SIGKILL")
    } finally {
      killSpy.mockRestore()
      await forceKillProcessGroup(groupPid, realKill)
    }
  },
)
