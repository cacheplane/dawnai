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
})
