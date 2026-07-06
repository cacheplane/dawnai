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
