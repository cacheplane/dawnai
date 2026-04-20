import { describe, expect, test } from "vitest"
import { chainAdapter } from "@dawn/langchain"

describe("chainAdapter", () => {
  test("kind is chain", () => {
    expect(chainAdapter.kind).toBe("chain")
  })

  test("execute calls invoke on the entry", async () => {
    const entry = {
      invoke: async (input: unknown) => ({ result: input }),
      stream: async function* () { yield "chunk" },
    }

    const output = await chainAdapter.execute(entry, { message: "hello" }, {
      signal: new AbortController().signal,
    })

    expect(output).toEqual({ result: { message: "hello" } })
  })

  test("stream yields chunks from entry.stream", async () => {
    const entry = {
      invoke: async () => ({}),
      stream: async function* () {
        yield "chunk1"
        yield "chunk2"
        yield "chunk3"
      },
    }

    const chunks: unknown[] = []
    for await (const chunk of chainAdapter.stream(entry, {}, {
      signal: new AbortController().signal,
    })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual(["chunk1", "chunk2", "chunk3"])
  })

  test("stream falls back to invoke when no stream method", async () => {
    const entry = {
      invoke: async (input: unknown) => ({ result: input }),
    }

    const chunks: unknown[] = []
    for await (const chunk of chainAdapter.stream(entry, { msg: "hi" }, {
      signal: new AbortController().signal,
    })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([{ result: { msg: "hi" } }])
  })

  test("execute throws when entry has no invoke method", async () => {
    await expect(
      chainAdapter.execute("not-a-runnable", {}, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/invoke/)
  })
})
