import { describe, expect, it } from "vitest"
import { withFilesystemLogging } from "../src/with-logging.js"
import type { FilesystemBackend } from "../src/types.js"

const base: FilesystemBackend = {
  async readFile() { return "ok" },
  async writeFile() { return { bytesWritten: 5 } },
  async listDir() { return ["a"] },
  async realPath(p) { return p },
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

  it("forwards readBinaryFile and logs only the path, never the bytes", async () => {
    const log: Array<{ method: string; args: unknown[] }> = []
    const withBinary: FilesystemBackend = {
      ...base,
      async readBinaryFile() {
        return Uint8Array.from([1, 2, 3])
      },
    }
    const wrapped = withFilesystemLogging({ destination: (e) => log.push(e) })(withBinary)
    const out = await wrapped.readBinaryFile?.("img.png", ctx)
    expect([...(out ?? [])]).toEqual([1, 2, 3])
    expect(log).toEqual([{ method: "readBinaryFile", args: ["img.png"] }])
  })

  it("omits readBinaryFile when the wrapped backend lacks it", () => {
    const wrapped = withFilesystemLogging()(base)
    expect(wrapped.readBinaryFile).toBeUndefined()
  })

  it("preserves optional backend methods instead of dropping them", () => {
    const full: FilesystemBackend = {
      ...base,
      async statFile() {
        return { size: 0, mtimeMs: 0 }
      },
      async removeFile() {},
      async touchFile() {},
      async mkdir() {},
    }
    const wrapped = withFilesystemLogging()(full)
    expect(wrapped.statFile).toBeTypeOf("function")
    expect(wrapped.removeFile).toBeTypeOf("function")
    expect(wrapped.touchFile).toBeTypeOf("function")
    expect(wrapped.mkdir).toBeTypeOf("function")
  })

  it("forwards the readFile maxBytes option to the wrapped backend", async () => {
    let seen: { maxBytes?: number } | undefined
    const recording: FilesystemBackend = {
      ...base,
      async readFile(_path, _ctx, opts) {
        seen = opts
        return "ok"
      },
    }
    const wrapped = withFilesystemLogging({ destination: () => undefined })(recording)
    await wrapped.readFile("a.md", ctx, { maxBytes: 42 })
    expect(seen).toEqual({ maxBytes: 42 })
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
