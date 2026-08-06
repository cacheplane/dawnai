import { describe, expect, it, vi } from "vitest"
import { offloadToolOutput } from "../src/offload/offload-tool-output.js"

function fakeStore(rel = "tool-outputs/x-1-a.txt") {
  return { write: vi.fn(async () => rel) }
}

describe("offloadToolOutput", () => {
  const base = { toolName: "search", thresholdChars: 40_000, previewLines: 10 }

  it("returns content unchanged when under threshold", async () => {
    const store = fakeStore()
    const out = await offloadToolOutput("small", { ...base, store: store as never })
    expect(out).toBe("small")
    expect(store.write).not.toHaveBeenCalled()
  })

  it("writes and returns a stub when over threshold", async () => {
    const store = fakeStore("tool-outputs/search-1-a.txt")
    const signal = new AbortController().signal
    const big = "x".repeat(40_001)
    const out = await offloadToolOutput(big, { ...base, signal, store: store as never })
    expect(store.write).toHaveBeenCalledWith("search", big, { signal })
    expect(out).toContain("Tool output offloaded")
    expect(out).toContain("tool-outputs/search-1-a.txt")
  })

  it("returns original content if the store write throws", async () => {
    const store = {
      write: vi.fn(async () => {
        throw new Error("disk full")
      }),
    }
    const big = "x".repeat(40_001)
    const out = await offloadToolOutput(big, { ...base, store: store as never })
    expect(out).toBe(big)
  })

  it("forwards toolCallId to store.write", async () => {
    const calls: Array<
      [string, string, { readonly signal?: AbortSignal; readonly toolCallId?: string }]
    > = []
    const store = {
      write: async (
        toolName: string,
        content: string,
        options: { readonly signal?: AbortSignal; readonly toolCallId?: string },
      ) => {
        calls.push([toolName, content, options])
        return `tool-outputs/${toolName}-${options.toolCallId}.txt`
      },
    }
    const big = "z".repeat(50)
    const signal = new AbortController().signal
    const out = await offloadToolOutput(big, {
      toolName: "generateReport",
      thresholdChars: 10,
      previewLines: 2,
      signal,
      store,
      toolCallId: "call_xyz",
    })
    expect(calls[0]).toEqual(["generateReport", big, { signal, toolCallId: "call_xyz" }])
    expect(out).toContain("tool-outputs/generateReport-call_xyz.txt")
  })
})
