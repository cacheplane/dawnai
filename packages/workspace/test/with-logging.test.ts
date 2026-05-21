import { describe, expect, it } from "vitest"
import { withFilesystemLogging } from "../src/with-logging.js"
import type { FilesystemBackend } from "../src/types.js"

const base: FilesystemBackend = {
  async readFile() { return "ok" },
  async writeFile() { return { bytesWritten: 5 } },
  async listDir() { return ["a"] },
}

const ctx = { signal: new AbortController().signal, workspaceRoot: "/r" }

describe("withFilesystemLogging", () => {
  it("invokes the destination callback for each method", async () => {
    const log: Array<{ method: string; args: unknown[] }> = []
    const wrapped = withFilesystemLogging({ destination: (e) => log.push(e) })(base)
    await wrapped.readFile("a.md", ctx)
    await wrapped.writeFile("b.md", "hi", ctx)
    await wrapped.listDir("/r", ctx)
    expect(log.map((e) => e.method)).toEqual(["readFile", "writeFile", "listDir"])
    expect(log[0]!.args).toEqual(["a.md"])
    expect(log[1]!.args).toEqual(["b.md", "hi"])
  })

  it("forwards return values unchanged", async () => {
    const wrapped = withFilesystemLogging({ destination: () => undefined })(base)
    expect(await wrapped.readFile("a.md", ctx)).toBe("ok")
    expect(await wrapped.writeFile("b.md", "hi", ctx)).toEqual({ bytesWritten: 5 })
    expect([...(await wrapped.listDir("/r", ctx))]).toEqual(["a"])
  })

  it("defaults destination to console.error when not provided", async () => {
    const original = console.error
    const logged: string[] = []
    console.error = ((msg: string) => logged.push(msg)) as typeof console.error
    try {
      const wrapped = withFilesystemLogging()(base)
      await wrapped.readFile("a.md", ctx)
    } finally {
      console.error = original
    }
    expect(logged.length).toBe(1)
    expect(logged[0]).toContain("readFile")
  })
})
