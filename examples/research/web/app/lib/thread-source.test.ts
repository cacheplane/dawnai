import { beforeEach, describe, expect, test, vi } from "vitest"
import { createLocalThreadSource, readParkedInterrupts } from "./thread-source.js"

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

  test("rejects on any other non-2xx, carrying the body's own explanation", async () => {
    // The proxy's 502 shape: a flat `error` string, written to be shown.
    const source = createLocalThreadSource(
      memoryStorage(),
      stubFetch(502, {
        error: "Cannot reach the Dawn server at http://127.0.0.1:3002: ECONNREFUSED",
      }),
    )
    await expect(source.hydrate("thread-1")).rejects.toThrow(
      "Could not load this conversation (HTTP 502): Cannot reach the Dawn server at http://127.0.0.1:3002: ECONNREFUSED",
    )
  })

  test("unwraps the Dawn server's own {error:{message}} shape", async () => {
    const source = createLocalThreadSource(
      memoryStorage(),
      stubFetch(500, { error: { kind: "internal_error", message: "checkpointer exploded" } }),
    )
    await expect(source.hydrate("thread-1")).rejects.toThrow(/HTTP 500\): checkpointer exploded/)
  })

  test("keeps the status when the body is not JSON at all", async () => {
    // An HTML error page from something in front of the server. Parsing it
    // must not replace the status with a raw SyntaxError.
    const fetchFn = vi.fn(
      async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    ) as unknown as typeof fetch
    const source = createLocalThreadSource(memoryStorage(), fetchFn)
    await expect(source.hydrate("thread-1")).rejects.toThrow(
      "Could not load this conversation (HTTP 502)",
    )
    await expect(source.hydrate("thread-1")).rejects.not.toThrow(/Unexpected token/)
  })
})

/**
 * The envelope of a real parked gate, as the endpoint returns it: the entry
 * carries the server's chosen `interruptId` and `resumeKey`, and `value` is
 * the Dawn envelope `permission-gate.ts` wrote.
 */
const PARKED_BODY = {
  interrupts: [
    {
      interruptId: "perm-1",
      resumeKey: "__interrupt__:0",
      value: {
        detail: { argsPreview: "{}", suggestedPattern: "deployProd", toolName: "deployProd" },
        interruptId: "perm-1",
        kind: "tool",
        type: "permission-request",
      },
    },
  ],
}

describe("readParkedInterrupts", () => {
  test("keeps the whole envelope as the card's metadata", () => {
    expect(readParkedInterrupts(PARKED_BODY)).toEqual([
      { interruptId: "perm-1", metadata: PARKED_BODY.interrupts[0]?.value },
    ])
  })

  test("takes the id the SERVER chose, not the one inside the envelope", () => {
    // The server resolves `innerId ?? outerId` and keeps an `aliases` list for
    // when they differ; the resume endpoint matches on the id it published.
    // Re-deriving the precedence here would be a second copy of that rule,
    // free to drift into resuming an id the server does not recognize.
    const parked = readParkedInterrupts({
      interrupts: [
        {
          interruptId: "outer-id",
          resumeKey: null,
          value: { interruptId: "inner-id", kind: "tool" },
        },
      ],
    })
    expect(parked[0]?.interruptId).toBe("outer-id")
  })

  test("is empty for the ordinary empty answer", () => {
    expect(readParkedInterrupts({ interrupts: [] })).toEqual([])
  })

  test.each([
    ["a null body", null],
    ["an error envelope", { error: { code: "thread_not_found" } }],
    ["an array", []],
    ["a non-array interrupts field", { interrupts: "none" }],
  ])("is empty for %s rather than throwing", (_label, body) => {
    expect(readParkedInterrupts(body)).toEqual([])
  })

  test("drops an entry with no usable id, keeping its neighbours", () => {
    // An entry that cannot be resumed would render a button that can only
    // fail; dropping it leaves the thread exactly as stranded as it was.
    const parked = readParkedInterrupts({
      interrupts: [
        { resumeKey: null, value: { kind: "tool" } },
        { interruptId: "", value: {} },
        { interruptId: "perm-2", value: { kind: "command" } },
      ],
    })
    expect(parked).toEqual([{ interruptId: "perm-2", metadata: { kind: "command" } }])
  })

  test("survives an entry whose value is not an object", () => {
    const parked = readParkedInterrupts({
      interrupts: [{ interruptId: "perm-3", value: "surprise" }],
    })
    expect(parked).toEqual([{ interruptId: "perm-3", metadata: {} }])
  })
})

describe("thread source pending interrupts", () => {
  test("asks the proxy for the thread's parked gates", async () => {
    const fetchFn = stubFetch(200, PARKED_BODY)
    const parked = await createLocalThreadSource(memoryStorage(), fetchFn).pendingInterrupts("t 1")
    expect(fetchFn).toHaveBeenCalledWith("/api/dawn/threads/t%201/pending_interrupts", undefined)
    expect(parked).toHaveLength(1)
    expect(parked[0]?.interruptId).toBe("perm-1")
  })

  test("passes an abort signal through when it is given one", async () => {
    const fetchFn = stubFetch(200, { interrupts: [] })
    const controller = new AbortController()
    await createLocalThreadSource(memoryStorage(), fetchFn).pendingInterrupts(
      "t1",
      controller.signal,
    )
    expect(fetchFn).toHaveBeenCalledWith("/api/dawn/threads/t1/pending_interrupts", {
      signal: controller.signal,
    })
  })

  test.each([
    ["404 — no checkpoint row for this thread", 404],
    ["409 — the thread has never run, or its route is gone", 409],
    ["403 — the proxy refused a path outside its allowlist", 403],
    ["502 — the Dawn server is not reachable", 502],
  ])("resolves empty rather than rejecting on %s", async (_label, status) => {
    const source = createLocalThreadSource(memoryStorage(), stubFetch(status, { error: "nope" }))
    await expect(source.pendingInterrupts("thread-1")).resolves.toEqual([])
  })

  test("resolves empty for a 200 that is not the shape it expects", async () => {
    const source = createLocalThreadSource(memoryStorage(), stubFetch(200, { unexpected: true }))
    await expect(source.pendingInterrupts("thread-1")).resolves.toEqual([])
  })
})
