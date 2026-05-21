import { describe, expect, it } from "vitest"
import { compose } from "../src/compose.js"
import type { FilesystemBackend, FilesystemMiddleware } from "../src/types.js"

const base: FilesystemBackend = {
  async readFile() { return "BASE" },
  async writeFile() { return { bytesWritten: 0 } },
  async listDir() { return [] },
}

describe("compose", () => {
  it("with zero middlewares returns the base unchanged", () => {
    expect(compose<FilesystemBackend>()(base)).toBe(base)
  })

  it("with one middleware wraps the base", async () => {
    const lower: FilesystemMiddleware = (next) => ({
      ...next,
      readFile: async (p, c) => (await next.readFile(p, c)).toLowerCase(),
    })
    const wrapped = compose(lower)(base)
    expect(
      await wrapped.readFile("x", { signal: new AbortController().signal, workspaceRoot: "/" }),
    ).toBe("base")
  })

  it("applies middlewares right-to-left (outermost first)", async () => {
    const trace: string[] = []
    const a: FilesystemMiddleware = (next) => ({
      ...next,
      readFile: async (p, c) => {
        trace.push("a:before")
        const r = await next.readFile(p, c)
        trace.push("a:after")
        return r
      },
    })
    const b: FilesystemMiddleware = (next) => ({
      ...next,
      readFile: async (p, c) => {
        trace.push("b:before")
        const r = await next.readFile(p, c)
        trace.push("b:after")
        return r
      },
    })
    await compose(a, b)(base).readFile("x", {
      signal: new AbortController().signal,
      workspaceRoot: "/",
    })
    expect(trace).toEqual(["a:before", "b:before", "b:after", "a:after"])
  })
})
