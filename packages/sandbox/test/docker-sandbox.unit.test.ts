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
