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

  test("runCommand rejects invalid env keys with a clear error", async () => {
    const exec = dockerExec(fakeDocker({}), "c1")
    await expect(
      exec.runCommand({ command: "echo hi", env: { "BAD KEY;x": "1" } }, ctx),
    ).rejects.toThrow(/Invalid environment variable name "BAD KEY;x"/)
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
    expect(r.stderr).toMatch(/timed out after 500ms/i)
    expect(r.stderr).toMatch(/resources\.timeoutMs/)
  })

  test("still validates env keys (regression: keep existing behavior)", async () => {
    const exec = dockerExec(fakeDocker({}), "c1", { timeoutMs: 500 })
    await expect(
      exec.runCommand({ command: "echo", env: { "BAD KEY;x": "1" } }, ctx),
    ).rejects.toThrow(/Invalid environment variable name/i)
  })
})
