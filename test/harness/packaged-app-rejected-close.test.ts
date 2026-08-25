import type { ChildProcess } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { expect, it, vi } from "vitest"

type TaskkillCallback = (error: Error | null, stdout: string, stderr: string) => void

const childProcessHooks = vi.hoisted(() => ({
  onSpawn: undefined as ((child: ChildProcess) => void) | undefined,
  onTaskkill: undefined as ((pid: number, callback: TaskkillCallback) => ChildProcess) | undefined,
}))

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      if (args[0] === "taskkill.exe" && childProcessHooks.onTaskkill !== undefined) {
        const taskkillArgs = args[1]
        const callback = args.at(-1)
        if (!Array.isArray(taskkillArgs) || typeof callback !== "function") {
          throw new Error("Unexpected taskkill invocation")
        }
        const pid = Number(taskkillArgs[taskkillArgs.indexOf("/PID") + 1])
        return childProcessHooks.onTaskkill(pid, callback as TaskkillCallback)
      }
      return Reflect.apply(actual.execFile, undefined, args)
    },
    spawn: (...args: unknown[]) => {
      const child = Reflect.apply(actual.spawn, undefined, args) as ChildProcess
      childProcessHooks.onSpawn?.(child)
      return child
    },
  }
})

import { runPackagedCommand } from "./packaged-app.ts"

const REPO_ROOT = resolve(import.meta.dirname, "../..")
const HANGING_PROCESS_TREE_FIXTURE = resolve(
  REPO_ROOT,
  "packages/devkit/test/fixtures/hanging-process-tree.mjs",
)

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error && typeof error === "object" && Reflect.get(error, "code") === "ESRCH") return false
    throw error
  }
}

async function expectProcessStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (processIsRunning(pid) && Date.now() < deadline) await delay(25)
  expect(processIsRunning(pid)).toBe(false)
}

async function waitForTopology(path: string): Promise<{
  readonly descendantPid: number
  readonly leaderPid: number
}> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as {
        readonly descendantPid: number
        readonly leaderPid: number
      }
    } catch (error) {
      const retryable =
        error instanceof SyntaxError ||
        (error !== null && typeof error === "object" && Reflect.get(error, "code") === "ENOENT")
      if (!retryable) throw error
      await delay(25)
    }
  }
  throw new Error(`Hanging process fixture did not become ready at ${path}`)
}

async function waitForFirstStdoutLine(child: ChildProcess): Promise<string> {
  const stdout = child.stdout
  if (stdout === null) throw new Error("Hanging process fixture has no stdout pipe")

  return await new Promise<string>((resolvePromise, rejectPromise) => {
    let output = ""
    const timeout = setTimeout(() => {
      cleanup()
      rejectPromise(new Error("Hanging process fixture did not emit stdout"))
    }, 2_000)
    const cleanup = () => {
      clearTimeout(timeout)
      stdout.off("data", onData)
      stdout.off("error", onError)
    }
    const onData = (chunk: string | Buffer) => {
      output += chunk.toString()
      if (Buffer.byteLength(output, "utf8") > 1_024) {
        cleanup()
        rejectPromise(new Error("Hanging process fixture stdout exceeded its bound"))
        return
      }
      const newline = output.indexOf("\n")
      if (newline === -1) return
      cleanup()
      resolvePromise(output.slice(0, newline))
    }
    const onError = (error: Error) => {
      cleanup()
      rejectPromise(error)
    }
    stdout.on("data", onData)
    stdout.once("error", onError)
  })
}

function stopProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL")
  } catch (error) {
    if (!(error && typeof error === "object" && Reflect.get(error, "code") === "ESRCH")) {
      throw error
    }
  }
}

it.skipIf(process.platform === "win32")(
  "paces force escalation and records the original child error after an abort",
  async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dawn-rejected-close-abort-"))
    const readyPath = join(tempRoot, "ready.json")
    const transcriptPath = join(tempRoot, "commands.log")
    const controller = new AbortController()
    const abortReason = new Error("cancel rejected-close fixture")
    const childError = new Error("injected child error during interruption")
    let spawnedChild: ChildProcess | undefined
    let stdoutReady: Promise<string> | undefined
    let topology: Awaited<ReturnType<typeof waitForTopology>> | undefined
    let commandResult: ReturnType<typeof runPackagedCommand> | undefined
    let maximumTimerGapMs = 0
    let lastTimerAt = performance.now()
    const heartbeat = setInterval(() => {
      const now = performance.now()
      maximumTimerGapMs = Math.max(maximumTimerGapMs, now - lastTimerAt)
      lastTimerAt = now
    }, 10)

    childProcessHooks.onSpawn = (child) => {
      spawnedChild = child
      stdoutReady = waitForFirstStdoutLine(child)
      void stdoutReady.catch(() => undefined)
    }
    try {
      commandResult = runPackagedCommand({
        args: [HANGING_PROCESS_TREE_FIXTURE, "8000", readyPath, "ignore-term"],
        command: process.execPath,
        cwd: tempRoot,
        signal: controller.signal,
        transcriptPath,
      })
      topology = await waitForTopology(readyPath)
      expect(spawnedChild?.pid).toBe(topology.leaderPid)
      if (stdoutReady === undefined) throw new Error("Spawn hook did not observe fixture stdout")
      expect(await stdoutReady).toBe(JSON.stringify(topology))

      controller.abort(abortReason)
      await Promise.resolve()
      if (spawnedChild === undefined) throw new Error("Spawn hook did not capture the fixture")
      spawnedChild.emit("error", childError)

      let thrown: unknown
      try {
        await commandResult
      } catch (error) {
        thrown = error
      }
      await delay(20)

      expect.soft(maximumTimerGapMs).toBeLessThan(400)
      expect.soft(thrown).toMatchObject({ cause: childError, phase: "spawn" })
      expect
        .soft((thrown as { result?: { spawnError?: unknown } }).result?.spawnError)
        .toBe(childError)
      const transcript = await readFile(transcriptPath, "utf8")
      expect.soft(transcript).toContain(JSON.stringify(topology))
      expect.soft(transcript).toContain("[aborted: Error: cancel rejected-close fixture]")
      expect
        .soft(transcript)
        .toContain("[spawn error Error: injected child error during interruption]")
      expect.soft(transcript).not.toContain("[termination error")
      await expectProcessStopped(topology.leaderPid)
      await expectProcessStopped(topology.descendantPid)
    } finally {
      clearInterval(heartbeat)
      childProcessHooks.onSpawn = undefined
      controller.abort(abortReason)
      await commandResult?.catch(() => undefined)
      await stdoutReady?.catch(() => undefined)
      if (topology !== undefined) {
        stopProcessGroup(topology.leaderPid)
        await expectProcessStopped(topology.leaderPid)
        await expectProcessStopped(topology.descendantPid)
      }
      await rm(tempRoot, { force: true, recursive: true })
    }
  },
)

it.runIf(process.platform !== "win32")(
  "waits for Windows child close before recording its original rejection",
  async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")
    const tempRoot = await mkdtemp(join(tmpdir(), "dawn-windows-rejected-close-"))
    const readyPath = join(tempRoot, "ready.json")
    const transcriptPath = join(tempRoot, "commands.log")
    const controller = new AbortController()
    const abortReason = new Error("cancel simulated Windows fixture")
    const childError = new Error("injected Windows child error during interruption")
    let spawnedChild: ChildProcess | undefined
    let stdoutReady: Promise<string> | undefined
    let topology: Awaited<ReturnType<typeof waitForTopology>> | undefined
    let commandResult: ReturnType<typeof runPackagedCommand> | undefined

    childProcessHooks.onSpawn = (child) => {
      spawnedChild = child
      stdoutReady = waitForFirstStdoutLine(child)
      void stdoutReady.catch(() => undefined)
    }
    childProcessHooks.onTaskkill = (pid, callback) => {
      process.kill(-pid, "SIGKILL")
      callback(null, "", "")
      if (spawnedChild === undefined) throw new Error("Spawn hook did not capture the fixture")
      return spawnedChild
    }
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" })
    try {
      commandResult = runPackagedCommand({
        args: [HANGING_PROCESS_TREE_FIXTURE, "8000", readyPath],
        command: process.execPath,
        cwd: tempRoot,
        signal: controller.signal,
        transcriptPath,
      })
      topology = await waitForTopology(readyPath)
      expect(spawnedChild?.pid).toBe(topology.leaderPid)
      if (stdoutReady === undefined) throw new Error("Spawn hook did not observe fixture stdout")
      expect(await stdoutReady).toBe(JSON.stringify(topology))

      controller.abort(abortReason)
      await Promise.resolve()
      if (spawnedChild === undefined) throw new Error("Spawn hook did not capture the fixture")
      spawnedChild.emit("error", childError)

      let thrown: unknown
      try {
        await commandResult
      } catch (error) {
        thrown = error
      }

      expect.soft(thrown).toMatchObject({ cause: childError, phase: "spawn" })
      expect
        .soft((thrown as { result?: { spawnError?: unknown } }).result?.spawnError)
        .toBe(childError)
      const transcript = await readFile(transcriptPath, "utf8")
      expect.soft(transcript).toContain(JSON.stringify(topology))
      expect
        .soft(transcript)
        .toContain("[spawn error Error: injected Windows child error during interruption]")
      expect.soft(transcript).not.toContain("[termination error")
      await expectProcessStopped(topology.leaderPid)
      await expectProcessStopped(topology.descendantPid)
    } finally {
      childProcessHooks.onSpawn = undefined
      childProcessHooks.onTaskkill = undefined
      controller.abort(abortReason)
      await commandResult?.catch(() => undefined)
      await stdoutReady?.catch(() => undefined)
      if (platformDescriptor !== undefined) {
        Object.defineProperty(process, "platform", platformDescriptor)
      }
      if (topology !== undefined) {
        stopProcessGroup(topology.leaderPid)
        await expectProcessStopped(topology.leaderPid)
        await expectProcessStopped(topology.descendantPid)
      }
      await rm(tempRoot, { force: true, recursive: true })
    }
  },
)
