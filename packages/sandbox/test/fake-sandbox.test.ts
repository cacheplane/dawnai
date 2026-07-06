import { describe, expect, test } from "vitest"
import { fakeSandbox } from "../src/testing/index.ts"

const ctx = (workspaceRoot: string) => ({ signal: new AbortController().signal, workspaceRoot })

describe("fakeSandbox", () => {
  test("isolates filesystem per thread, persists across acquire (reattach)", async () => {
    const provider = fakeSandbox()
    const a1 = await provider.acquire({ threadId: "a", policy: { network: { mode: "allow" } }, signal: ctx("/x").signal })
    await a1.filesystem.writeFile("/workspace/note.txt", "hello", ctx(a1.workspaceRoot))

    const a2 = await provider.acquire({ threadId: "a", policy: { network: { mode: "allow" } }, signal: ctx("/x").signal })
    expect(await a2.filesystem.readFile("/workspace/note.txt", ctx(a2.workspaceRoot))).toBe("hello")

    const b = await provider.acquire({ threadId: "b", policy: { network: { mode: "allow" } }, signal: ctx("/x").signal })
    expect(await b.filesystem.listDir("/workspace", ctx(b.workspaceRoot))).toEqual([])
  })

  test("release keeps the volume, destroy clears it", async () => {
    const provider = fakeSandbox()
    const h = await provider.acquire({ threadId: "a", policy: { network: { mode: "allow" } }, signal: ctx("/x").signal })
    await h.filesystem.writeFile("/workspace/f", "1", ctx(h.workspaceRoot))

    await provider.release("a")
    const after = await provider.acquire({ threadId: "a", policy: { network: { mode: "allow" } }, signal: ctx("/x").signal })
    expect(await after.filesystem.readFile("/workspace/f", ctx(after.workspaceRoot))).toBe("1")

    await provider.destroy("a")
    const fresh = await provider.acquire({ threadId: "a", policy: { network: { mode: "allow" } }, signal: ctx("/x").signal })
    expect(await fresh.filesystem.listDir("/workspace", ctx(fresh.workspaceRoot))).toEqual([])
  })

  test("exec is scripted + records commands; runBash sees fs writes", async () => {
    const provider = fakeSandbox({ exec: async ({ command }) => ({ stdout: `ran:${command}`, stderr: "", exitCode: 0 }) })
    const h = await provider.acquire({ threadId: "a", policy: { network: { mode: "allow" } }, signal: ctx("/x").signal })
    const r = await h.exec.runCommand({ command: "echo hi" }, ctx(h.workspaceRoot))
    expect(r).toEqual({ stdout: "ran:echo hi", stderr: "", exitCode: 0 })
  })
})
