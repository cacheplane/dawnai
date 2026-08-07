import { describe, expect, test } from "vitest"
import type { Docker } from "../src/docker/docker-cli.ts"
import { dockerExec } from "../src/docker/docker-exec.ts"
import { dockerFilesystem } from "../src/docker/docker-filesystem.ts"

const ctx = { signal: new AbortController().signal, workspaceRoot: "/workspace" }
const fakeDocker = (handlers: Partial<Docker>): Docker => ({
  run: handlers.run ?? (async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  exec: handlers.exec ?? (async () => ({ stdout: "", stderr: "", exitCode: 0 })),
})

describe("dockerFilesystem", () => {
  test("readFile cats inside the container", async () => {
    const fs = dockerFilesystem(
      fakeDocker({
        exec: async (_c, cmd) => ({
          stdout: cmd.join(" ").includes("cat") ? "file-body" : "",
          stderr: "",
          exitCode: 0,
        }),
      }),
      "c1",
    )
    expect(await fs.readFile("/workspace/a.txt", ctx)).toBe("file-body")
  })

  test("readFile enforces maxBytes", async () => {
    const fs = dockerFilesystem(
      fakeDocker({ exec: async () => ({ stdout: "0123456789", stderr: "", exitCode: 0 }) }),
      "c1",
    )
    await expect(fs.readFile("/workspace/a.txt", ctx, { maxBytes: 4 })).rejects.toThrow(/maxBytes|too large|exceeds/i)
  })

  test("writeFile pipes content via stdin", async () => {
    let stdin: string | undefined
    const fs = dockerFilesystem(
      fakeDocker({
        exec: async (_c, _cmd, opts) => {
          stdin = opts?.stdin
          return { stdout: "", stderr: "", exitCode: 0 }
        },
      }),
      "c1",
    )
    const r = await fs.writeFile("/workspace/a.txt", "hello", ctx)
    expect(stdin).toBe("hello")
    expect(r.bytesWritten).toBe(5)
  })

  test("writeFile creates parent directories before writing", async () => {
    let seen: readonly string[] = []
    const fs = dockerFilesystem(
      fakeDocker({
        exec: async (_c, cmd) => {
          seen = cmd
          return { stdout: "", stderr: "", exitCode: 0 }
        },
      }),
      "c1",
    )
    await fs.writeFile("/workspace/new dir/deep/a.txt", "hello", ctx)
    const shCmd = seen[2] ?? ""
    expect(shCmd).toContain("mkdir -p")
    expect(shCmd).toContain("cat >")
    expect(shCmd).toContain(`"$(dirname '/workspace/new dir/deep/a.txt')"`)
  })

  test("listDir parses ls -1 output", async () => {
    const fs = dockerFilesystem(
      fakeDocker({ exec: async () => ({ stdout: "a\nb\n", stderr: "", exitCode: 0 }) }),
      "c1",
    )
    expect(await fs.listDir("/workspace", ctx)).toEqual(["a", "b"])
  })

  test("failed op throws with stderr", async () => {
    const fs = dockerFilesystem(
      fakeDocker({ exec: async () => ({ stdout: "", stderr: "No such file", exitCode: 1 }) }),
      "c1",
    )
    await expect(fs.readFile("/workspace/nope", ctx)).rejects.toThrow(/No such file/)
  })
})

describe("dockerExec", () => {
  test("runCommand runs sh -c inside the container with cwd + env", async () => {
    let seen: readonly string[] = []
    const exec = dockerExec(
      fakeDocker({
        exec: async (_c, cmd) => {
          seen = cmd
          return { stdout: "out", stderr: "", exitCode: 0 }
        },
      }),
      "c1",
    )
    const r = await exec.runCommand({ command: "echo hi", cwd: "/workspace/sub", env: { A: "1" } }, ctx)
    expect(seen[0]).toBe("sh")
    expect(seen[1]).toBe("-c")
    expect(seen[2]).toContain("echo hi")
    expect(seen[2]).toContain("cd '/workspace/sub'")
    expect(seen[2]).toContain("A='1'")
    expect(r).toEqual({ stdout: "out", stderr: "", exitCode: 0 })
  })

  test("runCommand defaults cwd to ctx.workspaceRoot when args.cwd is absent", async () => {
    let seen: readonly string[] = []
    const exec = dockerExec(
      fakeDocker({
        exec: async (_c, cmd) => {
          seen = cmd
          return { stdout: "", stderr: "", exitCode: 0 }
        },
      }),
      "c1",
    )
    await exec.runCommand({ command: "echo hi" }, ctx)
    expect(seen[2]).toContain("cd '/workspace' &&")
  })

  test("runCommand uses args.cwd over ctx.workspaceRoot when provided", async () => {
    let seen: readonly string[] = []
    const exec = dockerExec(
      fakeDocker({
        exec: async (_c, cmd) => {
          seen = cmd
          return { stdout: "", stderr: "", exitCode: 0 }
        },
      }),
      "c1",
    )
    await exec.runCommand({ command: "echo hi", cwd: "/workspace/sub" }, ctx)
    expect(seen[2]).toContain("cd '/workspace/sub' &&")
    expect(seen[2]).not.toContain("cd '/workspace' &&")
  })

  test("runCommand rejects invalid env keys with a clear error", async () => {
    const exec = dockerExec(fakeDocker({}), "c1")
    await expect(
      exec.runCommand({ command: "echo hi", env: { "BAD KEY;x": "1" } }, ctx),
    ).rejects.toThrow(/Invalid environment variable name "BAD KEY;x"/)
  })

  test.each([
    {
      name: "resource temporarily unavailable in stderr",
      first: {
        stdout: "",
        stderr: "OCI runtime exec failed: Resource temporarily unavailable",
        exitCode: 1,
      },
    },
    {
      name: "init pipe reset in stdout",
      first: {
        stdout: "OCI runtime exec failed: read init-p: connection reset by peer",
        stderr: "",
        exitCode: 1,
      },
    },
  ])("recovers and retries after $name", async ({ first }) => {
    const activeCtx = { signal: new AbortController().signal, workspaceRoot: "/workspace" }
    const second = { stdout: "recovered", stderr: "warning", exitCode: 0 }
    const results = [first, second]
    const execSignals: Array<AbortSignal | undefined> = []
    const execCalls: Array<{ container: string; command: readonly string[] }> = []
    const recoveryTokens: unknown[] = []
    const events: string[] = []
    const capturedToken = { lifecycle: "original" }
    let currentToken = capturedToken
    const exec = dockerExec(
      fakeDocker({
        exec: async (container, command, opts) => {
          events.push("exec")
          execCalls.push({ container, command })
          execSignals.push(opts?.signal)
          const result = results.shift()
          if (result === undefined) throw new Error("Unexpected extra Docker exec")
          currentToken = { lifecycle: "replacement" }
          return result
        },
      }),
      "c1",
      {
        pidExhaustionRecovery: {
          captureToken: () => {
            events.push("capture")
            return currentToken
          },
          recoverAndRetry: async (token, retry) => {
            recoveryTokens.push(token)
            return retry()
          },
        },
      },
    )

    const result = await exec.runCommand({ command: "echo hi" }, activeCtx)

    expect(execCalls).toHaveLength(2)
    expect(execCalls[0]).toEqual(execCalls[1])
    expect(execSignals).toHaveLength(2)
    expect(execSignals[0]).toBe(activeCtx.signal)
    expect(execSignals[1]).toBe(activeCtx.signal)
    expect(events[0]).toBe("capture")
    expect(events.filter((event) => event === "capture")).toHaveLength(1)
    expect(recoveryTokens).toEqual([capturedToken])
    expect(result).toEqual(second)
  })

  test.each([
    {
      name: "command-level fork failure",
      result: { stdout: "", stderr: "sh: Cannot fork", exitCode: 1 },
      timeoutMs: undefined,
    },
    {
      name: "generic OCI runtime failure",
      result: { stdout: "", stderr: "OCI runtime exec failed: unknown", exitCode: 1 },
      timeoutMs: undefined,
    },
    {
      name: "successful output containing the recovery markers",
      result: {
        stdout: "OCI runtime exec failed: Resource temporarily unavailable",
        stderr: "",
        exitCode: 0,
      },
      timeoutMs: undefined,
    },
  ])("does not recover from $name", async ({ result, timeoutMs }) => {
    let execCalls = 0
    let recoveryCalls = 0
    const exec = dockerExec(
      fakeDocker({
        exec: async () => {
          execCalls += 1
          return result
        },
      }),
      "c1",
      {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        pidExhaustionRecovery: {
          captureToken: () => ({}),
          recoverAndRetry: async (_token, retry) => {
            recoveryCalls += 1
            return retry()
          },
        },
      },
    )

    await exec.runCommand({ command: "echo hi" }, ctx)

    expect(execCalls).toBe(1)
    expect(recoveryCalls).toBe(0)
  })

  test("does not recover a configured timeout containing PID-exhaustion markers", async () => {
    let execCalls = 0
    let recoveryCalls = 0
    const exec = dockerExec(
      fakeDocker({
        exec: async () => {
          execCalls += 1
          return {
            stdout: "OCI runtime exec failed",
            stderr: "Resource temporarily unavailable",
            exitCode: 124,
          }
        },
      }),
      "c1",
      {
        timeoutMs: 500,
        pidExhaustionRecovery: {
          captureToken: () => ({}),
          recoverAndRetry: async (_token, retry) => {
            recoveryCalls += 1
            return retry()
          },
        },
      },
    )

    const result = await exec.runCommand({ command: "sleep 999" }, ctx)

    expect(execCalls).toBe(1)
    expect(recoveryCalls).toBe(0)
    expect(result.stderr).toContain("Command timed out after 1s")
    expect(result.stderr).toContain("resources.timeoutMs: 500ms")
  })

  test("annotates a timeout returned by the retry after PID-exhaustion recovery", async () => {
    const results = [
      {
        stdout: "",
        stderr: "OCI runtime exec failed: Resource temporarily unavailable",
        exitCode: 1,
      },
      { stdout: "partial", stderr: "timeout detail", exitCode: 124 },
    ]
    let execCalls = 0
    let recoveryCalls = 0
    const exec = dockerExec(
      fakeDocker({
        exec: async () => {
          execCalls += 1
          const result = results.shift()
          if (result === undefined) throw new Error("Unexpected extra Docker exec")
          return result
        },
      }),
      "c1",
      {
        timeoutMs: 500,
        pidExhaustionRecovery: {
          captureToken: () => ({}),
          recoverAndRetry: async (_token, retry) => {
            recoveryCalls += 1
            return retry()
          },
        },
      },
    )

    const result = await exec.runCommand({ command: "sleep 999" }, ctx)

    expect(execCalls).toBe(2)
    expect(recoveryCalls).toBe(1)
    expect(result).toEqual({
      stdout: "partial",
      stderr:
        "timeout detail\nCommand timed out after 1s (resources.timeoutMs: 500ms).",
      exitCode: 124,
    })
  })

  test("retries only once when both attempts report PID exhaustion", async () => {
    const first = {
      stdout: "",
      stderr: "OCI runtime exec failed: Resource temporarily unavailable",
      exitCode: 1,
    }
    const second = {
      stdout: "OCI runtime exec failed: read init-p: connection reset by peer",
      stderr: "second failure",
      exitCode: 137,
    }
    const results = [first, second]
    let execCalls = 0
    let recoveryCalls = 0
    const exec = dockerExec(
      fakeDocker({
        exec: async () => {
          execCalls += 1
          const result = results.shift()
          if (result === undefined) throw new Error("Unexpected extra Docker exec")
          return result
        },
      }),
      "c1",
      {
        pidExhaustionRecovery: {
          captureToken: () => ({}),
          recoverAndRetry: async (_token, retry) => {
            recoveryCalls += 1
            return retry()
          },
        },
      },
    )

    const result = await exec.runCommand({ command: "echo hi" }, ctx)

    expect(execCalls).toBe(2)
    expect(recoveryCalls).toBe(1)
    expect(result).toEqual(second)
  })

  test("returns the original PID-exhaustion result when recovery rejects the captured token", async () => {
    const first = {
      stdout: "partial",
      stderr: "OCI runtime exec failed: Resource temporarily unavailable",
      exitCode: 1,
    }
    const token = { lifecycle: "released" }
    let execCalls = 0
    const recoveryTokens: unknown[] = []
    const exec = dockerExec(
      fakeDocker({
        exec: async () => {
          execCalls += 1
          return first
        },
      }),
      "c1",
      {
        pidExhaustionRecovery: {
          captureToken: () => token,
          recoverAndRetry: async (captured) => {
            recoveryTokens.push(captured)
            return undefined
          },
        },
      },
    )

    const result = await exec.runCommand({ command: "echo hi" }, ctx)

    expect(execCalls).toBe(1)
    expect(recoveryTokens).toEqual([token])
    expect(result).toEqual(first)
  })
})

describe("dockerExec timeout", () => {
  test("wraps the command in `timeout Ns` when timeoutMs is set", async () => {
    let seen: readonly string[] = []
    const exec = dockerExec(
      fakeDocker({ exec: async (_c, cmd) => { seen = cmd; return { stdout: "", stderr: "", exitCode: 0 } } }),
      "c1",
      { timeoutMs: 1500 },
    )
    await exec.runCommand({ command: "echo hi" }, ctx)
    expect(seen[0]).toBe("timeout")
    expect(seen[1]).toBe("2s") // ceil(1500/1000)
    expect(seen[2]).toBe("sh")
    expect(seen.join(" ")).toContain("echo hi")
  })

  test("no timeout wrapping when timeoutMs is unset", async () => {
    let seen: readonly string[] = []
    const exec = dockerExec(
      fakeDocker({ exec: async (_c, cmd) => { seen = cmd; return { stdout: "", stderr: "", exitCode: 0 } } }),
      "c1",
    )
    await exec.runCommand({ command: "echo hi" }, ctx)
    expect(seen[0]).toBe("sh")
  })

  test("exit 124 → annotated stderr pointing at the config", async () => {
    const exec = dockerExec(
      fakeDocker({ exec: async () => ({ stdout: "", stderr: "", exitCode: 124 }) }),
      "c1",
      { timeoutMs: 500 },
    )
    const r = await exec.runCommand({ command: "sleep 999" }, ctx)
    expect(r.exitCode).toBe(124)
    expect(r.stderr).toMatch(/timed out after 1s/i) // ceil(500/1000)
    expect(r.stderr).toMatch(/resources\.timeoutMs: 500ms/)
  })

  test("exit 124 stderr reports the rounded-up ceiling AND the raw configured ms", async () => {
    const exec = dockerExec(
      fakeDocker({ exec: async () => ({ stdout: "", stderr: "", exitCode: 124 }) }),
      "c1",
      { timeoutMs: 500 },
    )
    const r = await exec.runCommand({ command: "sleep 999" }, ctx)
    expect(r.stderr).toContain("after 1s")
    expect(r.stderr).toContain("resources.timeoutMs: 500ms")
  })

  test("still validates env keys (regression: keep existing behavior)", async () => {
    const exec = dockerExec(fakeDocker({}), "c1", { timeoutMs: 500 })
    await expect(
      exec.runCommand({ command: "echo", env: { "BAD KEY;x": "1" } }, ctx),
    ).rejects.toThrow(/Invalid environment variable name/i)
  })
})
