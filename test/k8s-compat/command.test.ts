import { spawn } from "node:child_process"
import { EventEmitter, getEventListeners } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"

import { afterEach, describe, expect, test, vi } from "vitest"
import {
  COMMAND_DEFAULTS,
  type Command,
  CommandExecutionError,
  type CommandSpawner,
  createCommandExecutor,
  executeCommand,
  helm,
  kubectl,
} from "../../scripts/kubernetes-compat/command.ts"

const CONTROLLED_COMMAND_OPTIONS = {
  timeoutMs: 2_000,
  stdoutLimitBytes: 1_024,
  stderrLimitBytes: 1_024,
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) {
      return error
    }
    throw new Error("Expected command rejection to be an Error", { cause: error })
  }
  throw new Error("Expected command to reject")
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for controlled child marker ${path}`)
}

async function expectRecordedProcessStopped(pidPath: string): Promise<void> {
  const pid = Number(await readFile(pidPath, "utf8"))
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)

  try {
    process.kill(pid, 0)
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ESRCH")
    return
  }
  throw new Error(`Controlled child process ${pid} is still running`)
}

function persistentChildScript(pidPath: string, operation: string): string {
  return [
    'const { writeFileSync } = require("node:fs")',
    `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))`,
    operation,
    "setInterval(() => {}, 1_000)",
  ].join(";")
}

class ControlledChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true)
}

describe("context-owned commands", () => {
  test("builds immutable kubectl and Helm metadata with explicit contexts", () => {
    const kubectlCommand = kubectl.command("kind-dawn", ["get", "pods"])
    const helmCommand = helm.command("kind-dawn", ["status", "release"])

    expect(kubectlCommand).toEqual({
      file: "kubectl",
      args: ["--context", "kind-dawn", "get", "pods"],
    })
    expect(helmCommand).toEqual({
      file: "helm",
      args: ["--kube-context", "kind-dawn", "status", "release"],
    })
    expect(Object.isFrozen(kubectlCommand)).toBe(true)
    expect(Object.isFrozen(kubectlCommand.args)).toBe(true)
    expect(Object.isFrozen(helmCommand)).toBe(true)
    expect(Object.isFrozen(helmCommand.args)).toBe(true)
  })

  test("places a token kubeconfig before the wrapper-owned kubectl context", () => {
    expect(
      kubectl.command("kind-dawn", ["get", "pods"], {
        kubeconfig: "/secure/token-kubeconfig",
      }),
    ).toEqual({
      file: "kubectl",
      args: ["--kubeconfig", "/secure/token-kubeconfig", "--context", "kind-dawn", "get", "pods"],
    })
  })

  test("has one dedicated ambient current-context command", () => {
    expect(kubectl.currentContextCommand()).toEqual({
      file: "kubectl",
      args: ["config", "current-context"],
    })
  })

  test.each(["", " ", "\n\t"])("rejects empty context %#", (context) => {
    expect(() => kubectl.command(context, ["get", "pods"])).toThrow(/context.*non-empty/i)
    expect(() => helm.command(context, ["status", "release"])).toThrow(/context.*non-empty/i)
  })

  test("rejects an empty wrapper-owned kubeconfig path", () => {
    expect(() => kubectl.command("kind-dawn", ["get", "pods"], { kubeconfig: " " })).toThrow(
      /kubeconfig.*non-empty/i,
    )
  })

  test.each([
    ["--context", "other"],
    ["--context=other"],
    ["--kube-context", "other"],
    ["--kube-context=other"],
    ["--kubeconfig", "/tmp/other"],
    ["--kubeconfig=/tmp/other"],
  ])("rejects caller-owned context or kubeconfig arguments %#", (...args) => {
    expect(() => kubectl.command("kind-dawn", ["get", ...args])).toThrow(/wrapper-owned/i)
    expect(() => helm.command("kind-dawn", ["status", ...args])).toThrow(/wrapper-owned/i)
  })
})

describe("shell-free command executor", () => {
  test("publishes explicit production timeout and independent byte bounds", () => {
    expect(COMMAND_DEFAULTS).toEqual({
      timeoutMs: 30_000,
      stdoutLimitBytes: 32 * 1_024 * 1_024,
      stderrLimitBytes: 64 * 1_024,
    })
    expect(Object.isFrozen(COMMAND_DEFAULTS)).toBe(true)
  })

  test("passes separate file and args with shell disabled and preserves binary output", async () => {
    const literalArgument = "literal;$(not-a-command)\n"
    const stdoutSuffix = Buffer.from([0x00, 0x7f, 0x80, 0xff])
    const stderrBytes = Buffer.from([0x01, 0x02, 0xfe])
    const script = [
      "const prefix = Buffer.from(process.argv[1])",
      `process.stdout.write(Buffer.concat([prefix, Buffer.from([${[...stdoutSuffix].join(",")}])]))`,
      `process.stderr.write(Buffer.from([${[...stderrBytes].join(",")}]))`,
    ].join(";")
    let observedShell: unknown
    let observedFile: string | undefined
    let observedArgs: readonly string[] | undefined
    const spawner: CommandSpawner = (file, args, options) => {
      observedFile = file
      observedArgs = args
      observedShell = options.shell
      return spawn(file, [...args], options)
    }
    const executor = createCommandExecutor(spawner)
    const command: Command = { file: process.execPath, args: ["-e", script, literalArgument] }

    const result = await executor(command, CONTROLLED_COMMAND_OPTIONS)

    expect(observedFile).toBe(process.execPath)
    expect(observedArgs).toEqual(command.args)
    expect(observedShell).toBe(false)
    expect(result.stdout).toEqual(Buffer.concat([Buffer.from(literalArgument), stdoutSuffix]))
    expect(result.stderr).toEqual(stderrBytes)
    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
  })

  test("rejects spawn errors with safe command metadata", async () => {
    const directory = await createTemporaryDirectory("dawn-k8s-command-spawn-")
    const missingExecutable = join(directory, "missing-command")
    const error = await rejectedError(
      executeCommand(
        { file: missingExecutable, args: ["safe-argument"] },
        CONTROLLED_COMMAND_OPTIONS,
      ),
    )

    expect(error).toBeInstanceOf(CommandExecutionError)
    expect(error.cause).toBeUndefined()
    expect(error.message).toMatch(/failed to start.*ENOENT/is)
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({
      command: { file: missingExecutable, args: ["safe-argument"] },
      outcome: { kind: "spawn-error", code: "ENOENT" },
    })
  })

  test("does not retain a raw spawn cause for sensitive commands", async () => {
    const directory = await createTemporaryDirectory("dawn-k8s-command-sensitive-spawn-")
    const missingExecutable = join(directory, "missing-command")
    const secret = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZW5zaXRpdmUifQ.signature-value"
    const error = await rejectedError(
      executeCommand(
        { file: missingExecutable, args: ["--token", secret] },
        { ...CONTROLLED_COMMAND_OPTIONS, sensitiveOutput: true },
      ),
    )

    expect(error.cause).toBeUndefined()
    expect(error.message).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  test("reports nonzero exit metadata and a bounded stderr diagnostic", async () => {
    const error = await rejectedError(
      executeCommand(
        {
          file: process.execPath,
          args: ["-e", 'process.stderr.write("controlled stderr"); process.exit(7)'],
        },
        CONTROLLED_COMMAND_OPTIONS,
      ),
    )

    expect(error.message).toMatch(/exit code 7/)
    expect(error.message).toContain("controlled stderr")
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({
      command: { file: process.execPath },
      outcome: { kind: "exit", exitCode: 7 },
    })
  })

  test.skipIf(process.platform === "win32")("reports signal termination", async () => {
    const error = await rejectedError(
      executeCommand(
        { file: process.execPath, args: ["-e", 'process.kill(process.pid, "SIGTERM")'] },
        CONTROLLED_COMMAND_OPTIONS,
      ),
    )

    expect(error.message).toMatch(/signal SIGTERM/)
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({
      outcome: { kind: "signal", signal: "SIGTERM" },
    })
  })

  test("times out and terminates the child before rejecting", async () => {
    const directory = await createTemporaryDirectory("dawn-k8s-command-timeout-")
    const pidPath = join(directory, "pid")
    const startedAt = Date.now()

    await expect(
      executeCommand(
        { file: process.execPath, args: ["-e", persistentChildScript(pidPath, "")] },
        { ...CONTROLLED_COMMAND_OPTIONS, timeoutMs: 250 },
      ),
    ).rejects.toThrow(/timed out after 250 ms/)

    expect(Date.now() - startedAt).toBeLessThan(2_000)
    await expectRecordedProcessStopped(pidPath)
  })

  test("terminates the child when stdout exceeds its independent byte limit", async () => {
    const directory = await createTemporaryDirectory("dawn-k8s-command-stdout-")
    const pidPath = join(directory, "pid")

    await expect(
      executeCommand(
        {
          file: process.execPath,
          args: [
            "-e",
            persistentChildScript(pidPath, "process.stdout.write(Buffer.alloc(17, 0x61))"),
          ],
        },
        { ...CONTROLLED_COMMAND_OPTIONS, stdoutLimitBytes: 16 },
      ),
    ).rejects.toThrow(/stdout exceeded 16 bytes/)

    await expectRecordedProcessStopped(pidPath)
  })

  test("bounds stderr independently and terminates its child", async () => {
    const directory = await createTemporaryDirectory("dawn-k8s-command-stderr-")
    const pidPath = join(directory, "pid")
    const hiddenSuffix = "MUST_NOT_APPEAR_IN_DIAGNOSTICS"
    const error = await rejectedError(
      executeCommand(
        {
          file: process.execPath,
          args: [
            "-e",
            persistentChildScript(
              pidPath,
              `process.stdout.write("ok"); process.stderr.write("12345678${hiddenSuffix}")`,
            ),
          ],
        },
        { ...CONTROLLED_COMMAND_OPTIONS, stderrLimitBytes: 8 },
      ),
    )

    expect(error.message).toMatch(/stderr exceeded 8 bytes/)
    expect(error.message).toContain("12345678")
    expect(error.message).not.toContain(hiddenSuffix)
    expect(Buffer.byteLength(error.message)).toBeLessThan(1_024)
    await expectRecordedProcessStopped(pidPath)
  })

  test("honors an external AbortSignal and terminates before rejecting", async () => {
    const directory = await createTemporaryDirectory("dawn-k8s-command-abort-")
    const pidPath = join(directory, "pid")
    const controller = new AbortController()
    const execution = executeCommand(
      { file: process.execPath, args: ["-e", persistentChildScript(pidPath, "")] },
      { ...CONTROLLED_COMMAND_OPTIONS, signal: controller.signal },
    )
    await waitForFile(pidPath)

    controller.abort(new Error("Bearer abort-reason-must-not-leak"))

    const error = await rejectedError(execution)
    expect(error.message).toMatch(/aborted/i)
    expect(error.message).not.toContain("abort-reason-must-not-leak")
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({ outcome: { kind: "aborted" } })
    await expectRecordedProcessStopped(pidPath)
  })

  test("does not spawn for an already-aborted signal", async () => {
    const controller = new AbortController()
    controller.abort("Secret reason")
    const spawner = vi.fn<CommandSpawner>()
    const executor = createCommandExecutor(spawner)

    await expect(
      executor(
        { file: "unused", args: [] },
        { ...CONTROLLED_COMMAND_OPTIONS, signal: controller.signal },
      ),
    ).rejects.toThrow(/aborted/i)
    expect(spawner).not.toHaveBeenCalled()
  })

  test("settles once and removes child, stream, signal, and timer listeners", async () => {
    vi.useFakeTimers()
    const child = new ControlledChild()
    const controller = new AbortController()
    const initialAbortListeners = getEventListeners(controller.signal, "abort").length
    const executor = createCommandExecutor(() => child as never)
    const execution = executor(
      { file: "controlled", args: [] },
      { ...CONTROLLED_COMMAND_OPTIONS, signal: controller.signal },
    )

    child.emit("spawn")
    child.stdout.write(Buffer.from("stdout"))
    child.stderr.write(Buffer.from("stderr"))
    child.emit("close", 0, null)

    await expect(execution).resolves.toMatchObject({
      stdout: Buffer.from("stdout"),
      stderr: Buffer.from("stderr"),
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialAbortListeners)
    expect(child.listenerCount("spawn")).toBe(0)
    expect(child.listenerCount("error")).toBe(0)
    expect(child.listenerCount("close")).toBe(0)
    expect(child.stdout.listenerCount("data")).toBe(0)
    expect(child.stderr.listenerCount("data")).toBe(0)
    expect(child.stdin.listenerCount("error")).toBe(0)
    expect(child.emit("close", 9, null)).toBe(false)
  })

  test("rejects and cleans up when child termination returns false without closing", async () => {
    vi.useFakeTimers()
    const child = new ControlledChild()
    child.kill.mockReturnValue(false)
    const controller = new AbortController()
    const initialAbortListeners = getEventListeners(controller.signal, "abort").length
    const executor = createCommandExecutor(() => child as never)
    const execution = executor(
      { file: "controlled", args: [] },
      { ...CONTROLLED_COMMAND_OPTIONS, signal: controller.signal },
    )
    const observed = execution.catch((error: unknown) => error)
    child.emit("spawn")

    controller.abort()

    const outcome = await Promise.race([
      observed,
      Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => "execution remained pending"),
    ])
    expect(outcome).toBeInstanceOf(CommandExecutionError)
    expect(outcome).toMatchObject({ outcome: { kind: "aborted" } })
    expect((outcome as Error).message).toMatch(/aborted.*termination failed/i)
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    expect(vi.getTimerCount()).toBe(0)
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialAbortListeners)
    expect(child.listenerCount("spawn")).toBe(0)
    expect(child.listenerCount("error")).toBe(0)
    expect(child.listenerCount("close")).toBe(0)
    expect(child.stdout.listenerCount("data")).toBe(0)
    expect(child.stderr.listenerCount("data")).toBe(0)
    expect(child.stdin.listenerCount("error")).toBe(0)
  })

  test("returns sensitive output in memory but never serializes it", async () => {
    const secret = "sensitive-stdin-value"
    const script = [
      "const chunks = []",
      'process.stdin.on("data", (chunk) => chunks.push(chunk))',
      'process.stdin.on("end", () => { const value = Buffer.concat(chunks); process.stdout.write(value); process.stderr.write(value) })',
    ].join(";")

    const result = await executeCommand(
      { file: process.execPath, args: ["-e", script] },
      { ...CONTROLLED_COMMAND_OPTIONS, stdin: Buffer.from(secret), sensitiveOutput: true },
    )

    expect(result.stdout.toString()).toBe(secret)
    expect(result.stderr.toString()).toBe(secret)
    expect(Object.keys(result)).not.toContain("stdout")
    expect(Object.keys(result)).not.toContain("stderr")
    expect(result.command.args).toEqual(["[REDACTED]", "[REDACTED]"])
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain("stdout")
    expect(JSON.stringify(result)).not.toContain("stderr")
  })

  test("redacts sensitive args, stdin, output, abort reasons, and environment from errors", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZW5zaXRpdmUifQ.signature-value"
    const stdinSecret = "Bearer stdin-credential"
    const environmentSecret = "environment-value-must-not-leak"
    const script = [
      "const chunks = []",
      'process.stdin.on("data", (chunk) => chunks.push(chunk))',
      'process.stdin.on("end", () => { process.stderr.write(Buffer.concat(chunks)); process.exit(19) })',
    ].join(";")
    const error = await rejectedError(
      executeCommand(
        { file: process.execPath, args: ["-e", script, "--", "--token", jwt] },
        {
          ...CONTROLLED_COMMAND_OPTIONS,
          env: { ...process.env, KUBERNETES_TEST_SECRET: environmentSecret },
          stdin: stdinSecret,
          sensitiveOutput: true,
        },
      ),
    )
    const serialized = JSON.stringify(error)

    expect(error.message).toMatch(/exit code 19/)
    for (const sensitiveValue of [jwt, stdinSecret, environmentSecret, "signature-value"]) {
      expect(error.message).not.toContain(sensitiveValue)
      expect(serialized).not.toContain(sensitiveValue)
    }
    expect(serialized).not.toContain("KUBERNETES_TEST_SECRET")
    expect(serialized).not.toContain("stdout")
    expect(serialized).not.toContain("stderr")
  })
})
