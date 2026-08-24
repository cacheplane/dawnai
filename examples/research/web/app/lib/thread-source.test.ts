import { beforeEach, describe, expect, test, vi } from "vitest"
import { createLocalThreadSource } from "./thread-source.js"

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  } as Storage
}

/** A `fetch` stand-in that answers every call with one canned response. */
function stubFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status,
      }),
  ) as unknown as typeof fetch
}

const CHECKPOINT = {
  values: {
    messages: [
      {
        id: ["langchain_core", "messages", "HumanMessage"],
        kwargs: { content: "hello", id: "h1" },
        lc: 1,
        type: "constructor",
      },
    ],
    todos: [{ content: "Read the corpus", status: "completed" }],
  },
}

describe("local thread source", () => {
  let storage: Storage

  beforeEach(() => {
    storage = memoryStorage()
  })

  test("starts empty", () => {
    expect(createLocalThreadSource(storage).list()).toEqual([])
  })

  test("creates a thread with an id and no title", () => {
    const source = createLocalThreadSource(storage)
    const thread = source.create()
    expect(thread.id).toMatch(/[0-9a-f-]{36}/)
    expect(thread.title).toBeUndefined()
    expect(source.list()).toEqual([thread])
  })

  test("titles a thread from its first user message and keeps the first only", () => {
    const source = createLocalThreadSource(storage)
    const thread = source.create()
    source.touch(thread.id, "Compare the agent architectures in the corpus")
    source.touch(thread.id, "And summarize them")
    expect(source.list()[0]?.title).toBe("Compare the agent architectures in the corpus")
  })

  test("truncates a long title", () => {
    const source = createLocalThreadSource(storage)
    const thread = source.create()
    source.touch(thread.id, "x".repeat(200))
    const title = source.list()[0]?.title ?? ""
    expect(title.length).toBeLessThanOrEqual(80)
  })

  test("lists most recently active first", () => {
    const source = createLocalThreadSource(storage)
    const first = source.create()
    const second = source.create()
    source.touch(first.id, "older")
    source.touch(second.id, "newer")
    expect(source.list().map((thread) => thread.id)).toEqual([second.id, first.id])
  })

  test("survives a reload through storage", () => {
    const source = createLocalThreadSource(storage)
    const thread = source.create()
    source.touch(thread.id, "persisted")
    expect(createLocalThreadSource(storage).list()[0]?.title).toBe("persisted")
  })

  test("tolerates corrupt storage rather than throwing", () => {
    storage.setItem("dawn.workbench.threads", "{not json")
    expect(createLocalThreadSource(storage).list()).toEqual([])
  })

  test("ignores a touch for an unknown thread", () => {
    const source = createLocalThreadSource(storage)
    source.touch("nope", "orphan")
    expect(source.list()).toEqual([])
  })
})

describe("local thread source hydration", () => {
  test("maps a 200 checkpoint into transcript messages and todos", async () => {
    const fetchFn = stubFetch(200, CHECKPOINT)
    const source = createLocalThreadSource(memoryStorage(), fetchFn)
    await expect(source.hydrate("thread-1")).resolves.toEqual({
      messages: [{ content: "hello", id: "h1", role: "user" }],
      todos: [{ content: "Read the corpus", status: "completed" }],
    })
    expect(fetchFn).toHaveBeenCalledWith("/api/dawn/threads/thread-1/state")
  })

  test("encodes the thread id into the path", async () => {
    const fetchFn = stubFetch(404, {})
    await createLocalThreadSource(memoryStorage(), fetchFn).hydrate("a/b?c")
    expect(fetchFn).toHaveBeenCalledWith("/api/dawn/threads/a%2Fb%3Fc/state")
  })

  test("treats a 404 as an empty thread rather than a failure", async () => {
    const source = createLocalThreadSource(
      memoryStorage(),
      stubFetch(404, {
        error: { kind: "request_error", message: "No checkpoint found for thread" },
      }),
    )
    await expect(source.hydrate("never-run")).resolves.toEqual({ messages: [], todos: [] })
  })

  test("hands back a fresh empty result each time, never a shared one", async () => {
    const source = createLocalThreadSource(memoryStorage(), stubFetch(404, {}))
    const first = await source.hydrate("a")
    const second = await source.hydrate("b")
    expect(first.messages).not.toBe(second.messages)
    expect(first.todos).not.toBe(second.todos)
  })

  test("rejects on any other non-2xx so the caller can surface it", async () => {
    const source = createLocalThreadSource(memoryStorage(), stubFetch(500, { error: "boom" }))
    await expect(source.hydrate("thread-1")).rejects.toThrow(/HTTP 500/)
  })
})
