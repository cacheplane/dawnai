import { describe, expect, test } from "vitest"
import type { Docker } from "../src/docker/docker-cli.ts"
import { dockerSandbox } from "../src/docker/docker-sandbox.ts"

function recordingDocker(): { docker: Docker; runs: string[][] } {
  const runs: string[][] = []
  const docker: Docker = {
    run: async (args) => {
      runs.push([...args])
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0 } // not running / absent
      return { stdout: "ok", stderr: "", exitCode: 0 }
    },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  }
  return { docker, runs }
}

const signal = () => new AbortController().signal

describe("dockerSandbox (unit, no daemon)", () => {
  test("acquire runs a container named for the thread + names a volume; deny → --network none", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ image: "node:22-slim", docker })
    const h = await p.acquire({ threadId: "abc", policy: { network: { mode: "deny" } }, signal: signal() })
    expect(h.workspaceRoot).toBe("/workspace")
    expect(h.threadId).toBe("abc")
    const runCmd = runs.find((r) => r[0] === "run")
    expect(runCmd).toBeDefined()
    const joined = (runCmd ?? []).join(" ")
    expect(joined).toContain("dawn-sbx-abc")
    expect(joined).toContain("dawn-sbx-vol-abc:/workspace")
    expect(joined).toContain("--network none")
    expect(joined).toContain("--label dawn.sandbox=abc")
    expect(joined).toContain("sleep infinity")
  })

  test("allow mode uses bridge network; resources + env are applied; host env NOT inherited", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({
      threadId: "abc",
      policy: {
        network: { mode: "allow", denylist: ["169.254.169.254"] },
        env: { FOO: "bar" },
        resources: { memoryMb: 512, cpus: 1 },
      },
      signal: signal(),
    })
    const joined = (runs.find((r) => r[0] === "run") ?? []).join(" ")
    expect(joined).toContain("--network bridge")
    expect(joined).toContain("--memory 512m")
    expect(joined).toContain("--cpus 1")
    expect(joined).toContain("FOO=bar")
    expect(joined).not.toContain("PATH=") // no host env leakage
  })

  test("acquire reattaches: running container → no docker run; stopped → docker start", async () => {
    const runs: string[][] = []
    let psQCount = 0
    const docker: Docker = {
      run: async (args) => {
        runs.push([...args])
        if (args[0] === "ps" && args.includes("-q") && !args.includes("-a")) {
          psQCount += 1
          return { stdout: psQCount === 1 ? "runningid" : "", stderr: "", exitCode: 0 }
        }
        if (args[0] === "ps") return { stdout: "stoppedid", stderr: "", exitCode: 0 } // ps -aq: exists
        return { stdout: "", stderr: "", exitCode: 0 }
      },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    }
    const p = dockerSandbox({ image: "node:22-slim", docker })
    // 1st acquire: container "running" → neither run nor start
    await p.acquire({ threadId: "t", policy: { network: { mode: "deny" } }, signal: signal() })
    expect(runs.some((r) => r[0] === "run")).toBe(false)
    expect(runs.some((r) => r[0] === "start")).toBe(false)
    // 2nd acquire: not running but exists → docker start
    await p.acquire({ threadId: "t", policy: { network: { mode: "deny" } }, signal: signal() })
    expect(runs.some((r) => r[0] === "start")).toBe(true)
  })

  test("release removes container but not volume; destroy removes both", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({ threadId: "abc", policy: { network: { mode: "deny" } }, signal: signal() })
    await p.release("abc")
    expect(runs.some((r) => r[0] === "rm" && r.includes("dawn-sbx-abc"))).toBe(true)
    expect(runs.some((r) => r[0] === "volume" && r[1] === "rm")).toBe(false)
    await p.destroy("abc")
    expect(runs.some((r) => r[0] === "volume" && r[1] === "rm" && r.includes("dawn-sbx-vol-abc"))).toBe(true)
  })

  test("preflight reports daemon unreachable", async () => {
    const docker: Docker = {
      run: async () => ({ stdout: "", stderr: "cannot connect", exitCode: 1 }),
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    }
    const p = dockerSandbox({ image: "node:22-slim", docker })
    const r = await p.preflight?.()
    expect(r?.ok).toBe(false)
    expect(r?.detail).toMatch(/daemon|reachable/i)
  })

  test("thread ids are sanitized for container/volume names", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({ threadId: "t/1:x", policy: { network: { mode: "deny" } }, signal: signal() })
    const joined = (runs.find((r) => r[0] === "run") ?? []).join(" ")
    expect(joined).toContain("dawn-sbx-t_1_x")
    expect(joined).not.toContain("t/1:x")
  })
})

describe("dockerSandbox hardening flags", () => {
  const acquireArgs = (runs: string[][]) => (runs.find((r) => r[0] === "run") ?? []).join(" ")

  test("hardened by default: cap-drop ALL, no-new-privileges, pids-limit 512, read-only + tmpfs, non-root user + HOME", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({ threadId: "abc", policy: { network: { mode: "deny" } }, signal: signal() })
    const j = acquireArgs(runs)
    expect(j).toContain("--cap-drop ALL")
    expect(j).toContain("--security-opt no-new-privileges")
    expect(j).toContain("--pids-limit 512")
    expect(j).toContain("--read-only")
    expect(j).toContain("--tmpfs /tmp")
    expect(j).toContain("--tmpfs /run")
    expect(j).toContain("--user 1000:1000")
    expect(j).toContain("HOME=/workspace")
  })

  test("per-flag opt-outs remove exactly their flags", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({
      threadId: "abc",
      policy: {
        network: { mode: "deny" },
        security: {
          dropAllCapabilities: false,
          noNewPrivileges: false,
          readOnlyRootFilesystem: false,
          runAsNonRoot: false,
          pidsLimit: 128,
        },
      },
      signal: signal(),
    })
    const j = acquireArgs(runs)
    expect(j).not.toContain("--cap-drop")
    expect(j).not.toContain("no-new-privileges")
    expect(j).not.toContain("--read-only")
    expect(j).not.toContain("--tmpfs")
    expect(j).not.toContain("--user")
    expect(j).not.toContain("HOME=/workspace")
    expect(j).toContain("--pids-limit 128")
  })

  test("keeper `run -d` does NOT set -w (so Docker can't stomp the chown'd /workspace ownership)", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({ threadId: "abc", policy: { network: { mode: "deny" } }, signal: signal() })
    const keeper = runs.find((r) => r[0] === "run" && r.includes("-d")) ?? []
    expect(keeper).not.toContain("-w")
    expect(acquireArgs(runs)).not.toContain(" -w ")
  })

  test("custom runAsNonRoot uid/gid", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({
      threadId: "abc",
      policy: { network: { mode: "deny" }, security: { runAsNonRoot: { uid: 2000, gid: 3000 } } },
      signal: signal(),
    })
    expect(acquireArgs(runs)).toContain("--user 2000:3000")
  })

  test("runAsNonRoot: null (raw-parsed config) still runs non-root — fails safe, not root", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({
      threadId: "abc",
      policy: { network: { mode: "deny" }, security: { runAsNonRoot: null as never } },
      signal: signal(),
    })
    expect(acquireArgs(runs)).toContain("--user 1000:1000")
  })
})

describe("dockerSandbox chown-init (Architecture B)", () => {
  // container absent; `volume inspect` exit encodes existence.
  function chownRecorder(volumeExists: boolean) {
    const runs: string[][] = []
    const docker: Docker = {
      run: async (args) => {
        runs.push([...args])
        if (args[0] === "volume" && args[1] === "inspect") {
          return { stdout: "", stderr: "", exitCode: volumeExists ? 0 : 1 }
        }
        if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0 } // container absent
        return { stdout: "ok", stderr: "", exitCode: 0 }
      },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    }
    return { docker, runs }
  }
  const chownRun = (runs: string[][]) =>
    runs.find((r) => r[0] === "run" && r.includes("--rm") && r.join(" ").includes("chown"))

  test("volume absent + non-root → chown-init runs as root BEFORE the keeper", async () => {
    const { docker, runs } = chownRecorder(false)
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({ threadId: "abc", policy: { network: { mode: "deny" } }, signal: signal() })
    const init = chownRun(runs)
    expect(init).toBeDefined()
    const j = (init ?? []).join(" ")
    expect(j).toContain("--user 0:0")
    expect(j).toContain("dawn-sbx-vol-abc:/workspace")
    expect(j).toContain("chown 1000:1000 /workspace")
    const idxInit = runs.findIndex((r) => r === init)
    const idxKeeper = runs.findIndex((r) => r[0] === "run" && r.includes("-d"))
    expect(idxInit).toBeGreaterThanOrEqual(0)
    expect(idxInit).toBeLessThan(idxKeeper)
  })

  test("volume present → NO chown-init (reattach)", async () => {
    const { docker, runs } = chownRecorder(true)
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({ threadId: "abc", policy: { network: { mode: "deny" } }, signal: signal() })
    expect(chownRun(runs)).toBeUndefined()
  })

  test("runAsNonRoot:false → NO chown-init", async () => {
    const { docker, runs } = chownRecorder(false)
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({
      threadId: "abc",
      policy: { network: { mode: "deny" }, security: { runAsNonRoot: false } },
      signal: signal(),
    })
    expect(chownRun(runs)).toBeUndefined()
  })
})

describe("dockerSandbox PID-exhaustion recovery", () => {
  function deferred() {
    let resolve = () => {}
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  test("removes and recreates the keeper with its volume before retrying the command", async () => {
    const acquireSignal = signal()
    const activeSignal = signal()
    const runs: Array<{ args: readonly string[]; signal: AbortSignal | undefined }> = []
    const events: string[] = []
    const execSignals: Array<AbortSignal | undefined> = []
    let volumeInspects = 0
    let execCalls = 0
    const docker: Docker = {
      run: async (args, opts) => {
        runs.push({ args: [...args], signal: opts?.signal })
        events.push(`run:${args.join(" ")}`)
        if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0 }
        if (args[0] === "volume" && args[1] === "inspect") {
          volumeInspects += 1
          return { stdout: "", stderr: "", exitCode: volumeInspects === 1 ? 1 : 0 }
        }
        return { stdout: "ok", stderr: "", exitCode: 0 }
      },
      exec: async (_container, _command, opts) => {
        execCalls += 1
        execSignals.push(opts?.signal)
        events.push(`exec:${execCalls}`)
        return execCalls === 1
          ? {
              stdout: "",
              stderr: "OCI runtime exec failed: Resource temporarily unavailable",
              exitCode: 1,
            }
          : { stdout: "recovered", stderr: "", exitCode: 0 }
      },
    }
    const policy = {
      network: { mode: "deny" as const },
      env: { FOO: "bar" },
      resources: { memoryMb: 256, cpus: 0.5, timeoutMs: 1_250 },
      security: { pidsLimit: 64, runAsNonRoot: { uid: 2000, gid: 3000 } },
    }
    const p = dockerSandbox({ image: "node:22-slim", docker })
    const h = await p.acquire({ threadId: "abc", policy, signal: acquireSignal })

    const result = await h.exec.runCommand(
      { command: "echo hi" },
      { workspaceRoot: h.workspaceRoot, signal: activeSignal },
    )

    expect(result).toEqual({ stdout: "recovered", stderr: "", exitCode: 0 })
    expect(execSignals).toEqual([activeSignal, activeSignal])
    const removal = runs.find((run) => run.args[0] === "rm")
    expect(removal?.args).toEqual(["rm", "-f", "dawn-sbx-abc"])
    expect(removal?.signal).toBeDefined()
    expect(removal?.signal).not.toBe(activeSignal)
    expect(removal?.signal).not.toBe(acquireSignal)
    const keeperRuns = runs.filter((run) => run.args[0] === "run" && run.args.includes("-d"))
    expect(keeperRuns).toHaveLength(2)
    expect(keeperRuns[1]?.args).toEqual(keeperRuns[0]?.args)
    expect(keeperRuns[1]?.args).toEqual(
      expect.arrayContaining([
        "dawn-sbx-vol-abc:/workspace",
        "--network",
        "none",
        "FOO=bar",
        "--memory",
        "256m",
        "--cpus",
        "0.5",
        "--pids-limit",
        "64",
        "--user",
        "2000:3000",
        "node:22-slim",
      ]),
    )
    expect(keeperRuns[1]?.signal).toBe(removal?.signal)
    expect(keeperRuns[1]?.signal).not.toBe(activeSignal)
    expect(keeperRuns[1]?.signal).not.toBe(acquireSignal)
    const chownRuns = runs.filter(
      (run) =>
        run.args[0] === "run" && run.args.includes("--rm") && run.args.join(" ").includes("chown"),
    )
    expect(chownRuns).toHaveLength(1)
    expect(volumeInspects).toBe(2)
    const firstExecIndex = events.indexOf("exec:1")
    const removalIndex = events.indexOf("run:rm -f dawn-sbx-abc")
    const recoveryInspectIndex = events.findIndex(
      (event, index) =>
        index > removalIndex && event === "run:volume inspect dawn-sbx-vol-abc",
    )
    const replacementIndex = events.findIndex(
      (event, index) => index > recoveryInspectIndex && event.startsWith("run:run -d "),
    )
    const secondExecIndex = events.indexOf("exec:2")
    expect(firstExecIndex).toBeLessThan(removalIndex)
    expect(removalIndex).toBeLessThan(recoveryInspectIndex)
    expect(recoveryInspectIndex).toBeLessThan(replacementIndex)
    expect(replacementIndex).toBeLessThan(secondExecIndex)
  })

  test("coalesces concurrent recovery and ignores a stale failure after replacement", async () => {
    const firstSignal = signal()
    const secondSignal = signal()
    const runs: Array<{ args: readonly string[]; signal: AbortSignal | undefined }> = []
    const execAttempts = new Map<string, number>()
    let containerExists = false
    let volumeExists = false
    let resolveSecondStarted = () => {}
    const secondStarted = new Promise<void>((resolve) => {
      resolveSecondStarted = resolve
    })
    let releaseSecondFailure = () => {}
    const secondFailureGate = new Promise<void>((resolve) => {
      releaseSecondFailure = resolve
    })
    const docker: Docker = {
      run: async (args, opts) => {
        runs.push({ args: [...args], signal: opts?.signal })
        if (args[0] === "ps") {
          return { stdout: containerExists ? "keeper-id" : "", stderr: "", exitCode: 0 }
        }
        if (args[0] === "volume" && args[1] === "inspect") {
          return {
            stdout: volumeExists ? "volume" : "",
            stderr: "",
            exitCode: volumeExists ? 0 : 1,
          }
        }
        if (args[0] === "rm") {
          containerExists = false
          return { stdout: "removed", stderr: "", exitCode: 0 }
        }
        if (args[0] === "run" && args.includes("--rm")) {
          volumeExists = true
          return { stdout: "initialized", stderr: "", exitCode: 0 }
        }
        if (args[0] === "run" && args.includes("-d")) {
          containerExists = true
          volumeExists = true
          return { stdout: "keeper-id", stderr: "", exitCode: 0 }
        }
        return { stdout: "ok", stderr: "", exitCode: 0 }
      },
      exec: async (_container, command) => {
        const shellCommand = command.at(-1) ?? ""
        const name = shellCommand.includes("echo first") ? "first" : "second"
        const attempt = (execAttempts.get(name) ?? 0) + 1
        execAttempts.set(name, attempt)
        if (attempt === 1) {
          if (name === "first") {
            await secondStarted
          } else {
            resolveSecondStarted()
            await secondFailureGate
          }
          return {
            stdout: "",
            stderr: "OCI runtime exec failed: Resource temporarily unavailable",
            exitCode: 1,
          }
        }
        return { stdout: `${name} recovered`, stderr: "", exitCode: 0 }
      },
    }
    const policy = { network: { mode: "deny" as const } }
    const p = dockerSandbox({ image: "node:22-slim", docker })
    const firstHandle = await p.acquire({ threadId: "abc", policy, signal: signal() })
    const secondHandle = await p.acquire({ threadId: "abc", policy, signal: signal() })

    const firstResultPromise = firstHandle.exec.runCommand(
      { command: "echo first" },
      { workspaceRoot: firstHandle.workspaceRoot, signal: firstSignal },
    )
    const secondResultPromise = secondHandle.exec.runCommand(
      { command: "echo second" },
      { workspaceRoot: secondHandle.workspaceRoot, signal: secondSignal },
    )
    const firstResult = await firstResultPromise
    releaseSecondFailure()
    const secondResult = await secondResultPromise

    expect(firstResult).toEqual({ stdout: "first recovered", stderr: "", exitCode: 0 })
    expect(secondResult).toEqual({ stdout: "second recovered", stderr: "", exitCode: 0 })
    expect(execAttempts).toEqual(
      new Map([
        ["first", 2],
        ["second", 2],
      ]),
    )
    const removals = runs.filter((run) => run.args[0] === "rm")
    expect(removals).toHaveLength(1)
    expect(removals[0]?.signal).toBeDefined()
    expect(removals[0]?.signal).not.toBe(firstSignal)
    expect(removals[0]?.signal).not.toBe(secondSignal)
    const keeperRuns = runs.filter((run) => run.args[0] === "run" && run.args.includes("-d"))
    expect(keeperRuns).toHaveLength(2)
    expect(keeperRuns[1]?.signal).toBe(removals[0]?.signal)
  })

  test.each(["release", "destroy"] as const)(
    "%s invalidates delayed recovery before a new lifecycle is acquired",
    async (operation) => {
      const execStarted = deferred()
      const releaseFailure = deferred()
      const originalFailure = {
        stdout: "partial",
        stderr: "OCI runtime exec failed: Resource temporarily unavailable",
        exitCode: 1,
      }
      const runs: string[][] = []
      let containerExists = false
      let volumeExists = false
      let execCalls = 0
      const docker: Docker = {
        run: async (args) => {
          runs.push([...args])
          if (args[0] === "ps") {
            return { stdout: containerExists ? "keeper-id" : "", stderr: "", exitCode: 0 }
          }
          if (args[0] === "volume" && args[1] === "inspect") {
            return {
              stdout: volumeExists ? "volume" : "",
              stderr: "",
              exitCode: volumeExists ? 0 : 1,
            }
          }
          if (args[0] === "volume" && args[1] === "rm") {
            volumeExists = false
            return { stdout: "removed volume", stderr: "", exitCode: 0 }
          }
          if (args[0] === "rm") {
            containerExists = false
            return { stdout: "removed keeper", stderr: "", exitCode: 0 }
          }
          if (args[0] === "run" && args.includes("--rm")) {
            volumeExists = true
            return { stdout: "initialized", stderr: "", exitCode: 0 }
          }
          if (args[0] === "run" && args.includes("-d")) {
            containerExists = true
            volumeExists = true
            return { stdout: "keeper-id", stderr: "", exitCode: 0 }
          }
          return { stdout: "ok", stderr: "", exitCode: 0 }
        },
        exec: async () => {
          execCalls += 1
          execStarted.resolve()
          await releaseFailure.promise
          return execCalls === 1
            ? originalFailure
            : { stdout: "old command retried", stderr: "", exitCode: 0 }
        },
      }
      const policy = { network: { mode: "deny" as const } }
      const p = dockerSandbox({ image: "node:22-slim", docker })
      const oldHandle = await p.acquire({ threadId: "abc", policy, signal: signal() })
      const oldResultPromise = oldHandle.exec.runCommand(
        { command: "echo old" },
        { workspaceRoot: oldHandle.workspaceRoot, signal: signal() },
      )
      await execStarted.promise

      if (operation === "release") await p.release("abc")
      else await p.destroy("abc")
      expect(containerExists).toBe(false)
      const newHandle = await p.acquire({ threadId: "abc", policy, signal: signal() })
      expect(newHandle.workspaceRoot).toBe("/workspace")
      expect(containerExists).toBe(true)
      releaseFailure.resolve()
      const oldResult = await oldResultPromise

      expect(oldResult).toEqual(originalFailure)
      expect(execCalls).toBe(1)
      expect(runs.filter((run) => run[0] === "rm")).toHaveLength(1)
      expect(runs.filter((run) => run[0] === "run" && run.includes("-d"))).toHaveLength(2)
      expect(runs.filter((run) => run[0] === "volume" && run[1] === "rm")).toHaveLength(
        operation === "destroy" ? 1 : 0,
      )
    },
  )

  test.each(["release", "destroy"] as const)(
    "%s drains in-flight recreation before final cleanup",
    async (operation) => {
      const replacementStarted = deferred()
      const releaseReplacement = deferred()
      const originalFailure = {
        stdout: "partial",
        stderr: "OCI runtime exec failed: Resource temporarily unavailable",
        exitCode: 1,
      }
      const runs: string[][] = []
      const events: string[] = []
      let containerExists = false
      let volumeExists = false
      let keeperRuns = 0
      let execCalls = 0
      const docker: Docker = {
        run: async (args) => {
          runs.push([...args])
          if (args[0] === "ps") {
            return { stdout: containerExists ? "keeper-id" : "", stderr: "", exitCode: 0 }
          }
          if (args[0] === "volume" && args[1] === "inspect") {
            return {
              stdout: volumeExists ? "volume" : "",
              stderr: "",
              exitCode: volumeExists ? 0 : 1,
            }
          }
          if (args[0] === "volume" && args[1] === "rm") {
            events.push("volume-rm")
            volumeExists = false
            return { stdout: "removed volume", stderr: "", exitCode: 0 }
          }
          if (args[0] === "rm") {
            events.push("rm")
            containerExists = false
            return { stdout: "removed keeper", stderr: "", exitCode: 0 }
          }
          if (args[0] === "run" && args.includes("--rm")) {
            volumeExists = true
            return { stdout: "initialized", stderr: "", exitCode: 0 }
          }
          if (args[0] === "run" && args.includes("-d")) {
            keeperRuns += 1
            events.push(`keeper:${keeperRuns}`)
            if (keeperRuns === 2) {
              replacementStarted.resolve()
              await releaseReplacement.promise
            }
            containerExists = true
            volumeExists = true
            return { stdout: "keeper-id", stderr: "", exitCode: 0 }
          }
          return { stdout: "ok", stderr: "", exitCode: 0 }
        },
        exec: async () => {
          execCalls += 1
          return execCalls === 1
            ? originalFailure
            : { stdout: "old command retried", stderr: "", exitCode: 0 }
        },
      }
      const policy = { network: { mode: "deny" as const } }
      const p = dockerSandbox({ image: "node:22-slim", docker })
      const h = await p.acquire({ threadId: "abc", policy, signal: signal() })
      const commandResultPromise = h.exec.runCommand(
        { command: "echo old" },
        { workspaceRoot: h.workspaceRoot, signal: signal() },
      )
      await replacementStarted.promise
      let cleanupSettled = false
      const cleanupPromise = (operation === "release" ? p.release("abc") : p.destroy("abc")).then(
        () => {
          cleanupSettled = true
        },
      )

      await Promise.resolve()
      expect(cleanupSettled).toBe(false)
      releaseReplacement.resolve()
      const [commandResult] = await Promise.all([commandResultPromise, cleanupPromise])

      expect(commandResult).toEqual(originalFailure)
      expect(execCalls).toBe(1)
      expect(containerExists).toBe(false)
      expect(keeperRuns).toBe(2)
      expect(runs.filter((run) => run[0] === "rm")).toHaveLength(2)
      expect(events.lastIndexOf("keeper:2")).toBeLessThan(events.lastIndexOf("rm"))
      expect(runs.filter((run) => run[0] === "volume" && run[1] === "rm")).toHaveLength(
        operation === "destroy" ? 1 : 0,
      )
    },
  )

  test("caller abort cannot strand a shared in-flight recovery", async () => {
    const firstController = new AbortController()
    const secondController = new AbortController()
    const secondStarted = deferred()
    const releaseSecondFailure = deferred()
    const replacementStarted = deferred()
    const releaseReplacement = deferred()
    const runs: Array<{ args: readonly string[]; signal: AbortSignal | undefined }> = []
    const execAttempts = new Map<string, number>()
    let containerExists = false
    let volumeExists = false
    let keeperRuns = 0
    const docker: Docker = {
      run: async (args, opts) => {
        runs.push({ args: [...args], signal: opts?.signal })
        if (args[0] === "ps") {
          return { stdout: containerExists ? "keeper-id" : "", stderr: "", exitCode: 0 }
        }
        if (args[0] === "volume" && args[1] === "inspect") {
          return {
            stdout: volumeExists ? "volume" : "",
            stderr: "",
            exitCode: volumeExists ? 0 : 1,
          }
        }
        if (args[0] === "rm") {
          containerExists = false
          return { stdout: "removed", stderr: "", exitCode: 0 }
        }
        if (args[0] === "run" && args.includes("--rm")) {
          volumeExists = true
          return { stdout: "initialized", stderr: "", exitCode: 0 }
        }
        if (args[0] === "run" && args.includes("-d")) {
          keeperRuns += 1
          if (keeperRuns === 2) {
            replacementStarted.resolve()
            await releaseReplacement.promise
            if (opts?.signal?.aborted) throw new Error("recovery used an aborted caller signal")
          }
          containerExists = true
          volumeExists = true
          return { stdout: "keeper-id", stderr: "", exitCode: 0 }
        }
        return { stdout: "ok", stderr: "", exitCode: 0 }
      },
      exec: async (_container, command) => {
        const shellCommand = command.at(-1) ?? ""
        const name = shellCommand.includes("echo first") ? "first" : "second"
        const attempt = (execAttempts.get(name) ?? 0) + 1
        execAttempts.set(name, attempt)
        if (attempt === 1) {
          if (name === "first") await secondStarted.promise
          else {
            secondStarted.resolve()
            await releaseSecondFailure.promise
          }
          return {
            stdout: "",
            stderr: "OCI runtime exec failed: Resource temporarily unavailable",
            exitCode: 1,
          }
        }
        return { stdout: `${name} recovered`, stderr: "", exitCode: 0 }
      },
    }
    const policy = { network: { mode: "deny" as const } }
    const p = dockerSandbox({ image: "node:22-slim", docker })
    const firstHandle = await p.acquire({ threadId: "abc", policy, signal: signal() })
    const secondHandle = await p.acquire({ threadId: "abc", policy, signal: signal() })
    const firstResultPromise = firstHandle.exec.runCommand(
      { command: "echo first" },
      { workspaceRoot: firstHandle.workspaceRoot, signal: firstController.signal },
    )
    const secondResultPromise = secondHandle.exec.runCommand(
      { command: "echo second" },
      { workspaceRoot: secondHandle.workspaceRoot, signal: secondController.signal },
    )

    await replacementStarted.promise
    firstController.abort()
    releaseSecondFailure.resolve()
    await Promise.resolve()
    releaseReplacement.resolve()
    const [firstResult, secondResult] = await Promise.all([firstResultPromise, secondResultPromise])

    expect(firstResult.stdout).toBe("first recovered")
    expect(secondResult.stdout).toBe("second recovered")
    expect(containerExists).toBe(true)
    expect(runs.filter((run) => run.args[0] === "rm")).toHaveLength(1)
    expect(keeperRuns).toBe(2)
    const removalIndex = runs.findIndex((run) => run.args[0] === "rm")
    const recoveryRuns = runs.slice(removalIndex)
    expect(recoveryRuns.every((run) => run.signal !== firstController.signal)).toBe(true)
    expect(recoveryRuns.every((run) => run.signal !== secondController.signal)).toBe(true)
  })

  test("concurrent failures wait on the same held removal and replacement", async () => {
    const bothFailuresStarted = deferred()
    const removalStarted = deferred()
    const releaseRemoval = deferred()
    const replacementStarted = deferred()
    const releaseReplacement = deferred()
    const runs: string[][] = []
    const execAttempts = new Map<string, number>()
    let firstAttemptsStarted = 0
    let containerExists = false
    let volumeExists = false
    let keeperRuns = 0
    const docker: Docker = {
      run: async (args) => {
        runs.push([...args])
        if (args[0] === "ps") {
          return { stdout: containerExists ? "keeper-id" : "", stderr: "", exitCode: 0 }
        }
        if (args[0] === "volume" && args[1] === "inspect") {
          return {
            stdout: volumeExists ? "volume" : "",
            stderr: "",
            exitCode: volumeExists ? 0 : 1,
          }
        }
        if (args[0] === "rm") {
          removalStarted.resolve()
          await releaseRemoval.promise
          containerExists = false
          return { stdout: "removed", stderr: "", exitCode: 0 }
        }
        if (args[0] === "run" && args.includes("--rm")) {
          volumeExists = true
          return { stdout: "initialized", stderr: "", exitCode: 0 }
        }
        if (args[0] === "run" && args.includes("-d")) {
          keeperRuns += 1
          if (keeperRuns === 2) {
            replacementStarted.resolve()
            await releaseReplacement.promise
          }
          containerExists = true
          volumeExists = true
          return { stdout: "keeper-id", stderr: "", exitCode: 0 }
        }
        return { stdout: "ok", stderr: "", exitCode: 0 }
      },
      exec: async (_container, command) => {
        const shellCommand = command.at(-1) ?? ""
        const name = shellCommand.includes("echo first") ? "first" : "second"
        const attempt = (execAttempts.get(name) ?? 0) + 1
        execAttempts.set(name, attempt)
        if (attempt === 1) {
          firstAttemptsStarted += 1
          if (firstAttemptsStarted === 2) bothFailuresStarted.resolve()
          await bothFailuresStarted.promise
          return {
            stdout: "",
            stderr: "OCI runtime exec failed: Resource temporarily unavailable",
            exitCode: 1,
          }
        }
        return { stdout: `${name} recovered`, stderr: "", exitCode: 0 }
      },
    }
    const policy = { network: { mode: "deny" as const } }
    const p = dockerSandbox({ image: "node:22-slim", docker })
    const h = await p.acquire({ threadId: "abc", policy, signal: signal() })
    let firstSettled = false
    let secondSettled = false
    const firstResultPromise = h.exec
      .runCommand(
        { command: "echo first" },
        { workspaceRoot: h.workspaceRoot, signal: signal() },
      )
      .then((result) => {
        firstSettled = true
        return result
      })
    const secondResultPromise = h.exec
      .runCommand(
        { command: "echo second" },
        { workspaceRoot: h.workspaceRoot, signal: signal() },
      )
      .then((result) => {
        secondSettled = true
        return result
      })

    await removalStarted.promise
    await Promise.resolve()
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)
    expect(runs.filter((run) => run[0] === "rm")).toHaveLength(1)
    releaseRemoval.resolve()
    await replacementStarted.promise
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)
    expect(execAttempts).toEqual(
      new Map([
        ["first", 1],
        ["second", 1],
      ]),
    )
    releaseReplacement.resolve()
    const [firstResult, secondResult] = await Promise.all([firstResultPromise, secondResultPromise])

    expect(firstResult.stdout).toBe("first recovered")
    expect(secondResult.stdout).toBe("second recovered")
    expect(runs.filter((run) => run[0] === "rm")).toHaveLength(1)
    expect(keeperRuns).toBe(2)
    expect(containerExists).toBe(true)
  })

  test("rejects with DAWN_E2001 when the exhausted keeper cannot be removed", async () => {
    const runs: string[][] = []
    let execCalls = 0
    const docker: Docker = {
      run: async (args) => {
        runs.push([...args])
        if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0 }
        if (args[0] === "volume" && args[1] === "inspect") {
          return { stdout: "ok", stderr: "", exitCode: 0 }
        }
        if (args[0] === "rm") {
          return { stdout: "", stderr: "container removal denied", exitCode: 1 }
        }
        return { stdout: "ok", stderr: "", exitCode: 0 }
      },
      exec: async () => {
        execCalls += 1
        return {
          stdout: "",
          stderr: "OCI runtime exec failed: Resource temporarily unavailable",
          exitCode: 1,
        }
      },
    }
    const p = dockerSandbox({ image: "node:22-slim", docker })
    const h = await p.acquire({
      threadId: "abc",
      policy: { network: { mode: "deny" } },
      signal: signal(),
    })

    await expect(
      h.exec.runCommand(
        { command: "echo hi" },
        { workspaceRoot: h.workspaceRoot, signal: signal() },
      ),
    ).rejects.toMatchObject({
      code: "DAWN_E2001",
      message: expect.stringMatching(
        /remove PID-exhausted container.*abc.*container removal denied/i,
      ),
    })
    expect(execCalls).toBe(1)
    expect(runs.filter((run) => run[0] === "run" && run.includes("-d"))).toHaveLength(1)
    expect(runs.filter((run) => run[0] === "rm")).toEqual([["rm", "-f", "dawn-sbx-abc"]])
  })
})
