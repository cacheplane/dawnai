import { describe, expect, it } from "vitest"
import { z } from "zod"
import { createMemoryMarker } from "../../src/capabilities/built-in/memory.js"

function fakeStore() {
  const rows: any[] = []
  return {
    rows,
    async put(r: any) {
      const i = rows.findIndex((x) => x.id === r.id)
      if (i >= 0) rows[i] = r
      else rows.push(r)
    },
    async get(id: string) {
      return rows.find((r) => r.id === id) ?? null
    },
    async search(q: any) {
      // namespace + status filter; ignore query (returns all matching for reconciliation)
      return rows.filter(
        (r) => r.namespace === q.namespace && (r.status ?? "active") === (q.status ?? "active"),
      )
    },
    async update(id: string, patch: any) {
      const i = rows.findIndex((r) => r.id === id)
      if (i >= 0) rows[i] = { ...rows[i], ...patch }
    },
    async supersede(id: string) {
      const i = rows.findIndex((r) => r.id === id)
      if (i >= 0) rows[i] = { ...rows[i], status: "superseded" }
    },
  }
}

const baseCtx = (store: any) => ({
  routeManifest: {} as never,
  descriptor: undefined,
  appRoot: "/x",
  memory: {
    store,
    namespace: "ws=a|route=/r",
    writes: "candidate" as const,
    defined: { kind: "semantic", scope: ["route"], identity: ["subject", "predicate"] },
    validate: (data: unknown) => ({ ok: true as const, value: data as Record<string, unknown> }),
    now: "2026-01-01T00:00:00.000Z",
  },
})

function ctxWith(store: any, writes: "auto" | "candidate" | "off") {
  const ctx = baseCtx(store)
  ctx.memory = { ...ctx.memory, writes: writes as any }
  return ctx
}

describe("memory capability", () => {
  it("does not activate without context.memory", async () => {
    expect(
      await createMemoryMarker().detect("/r", {
        routeManifest: {} as never,
        descriptor: undefined,
        appRoot: "/x",
      }),
    ).toBe(false)
  })
  it("contributes recall + remember tools and a memory-index fragment", async () => {
    const c = await createMemoryMarker().load("/r", baseCtx(fakeStore()))
    expect(c.tools?.map((t) => t.name).sort()).toEqual(["recall", "remember"])
    expect(c.promptFragment).toBeDefined()
  })
  it("remember writes a candidate row in candidate mode", async () => {
    const store = fakeStore()
    const c = await createMemoryMarker().load("/r", baseCtx(store))
    const remember = c.tools!.find((t) => t.name === "remember")!
    await remember.run(
      { data: { subject: "billing", predicate: "escalate", value: "500" }, content: "esc" },
      { signal: new AbortController().signal },
    )
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].status).toBe("candidate")
    expect(store.rows[0].namespace).toBe("ws=a|route=/r")
  })
  it("recall returns namespace-scoped active rows", async () => {
    const store = fakeStore()
    store.rows.push({
      id: "m1",
      namespace: "ws=a|route=/r",
      status: "active",
      content: "x",
      data: {},
      kind: "semantic",
      tags: [],
    })
    const c = await createMemoryMarker().load("/r", baseCtx(store))
    const recall = c.tools!.find((t) => t.name === "recall")!
    const out = (await recall.run(
      { query: "x" },
      { signal: new AbortController().signal },
    )) as string
    expect(out).toContain("m1")
  })

  it("falls back to a permissive data schema when context.memory.schema is not a Zod type", async () => {
    const ctx = baseCtx(fakeStore())
    // A non-Zod value (e.g. a plain JSON-Schema object slipping through
    // loadRouteMemory) must NOT be handed to z.object() as the remember tool's
    // `data` shape — that would blow up opaquely at tool-schema use time. The
    // guard falls back to a permissive record instead.
    ;(ctx.memory as { schema?: unknown }).schema = { type: "object", properties: {} }
    const c = await createMemoryMarker().load("/r", ctx)
    const remember = c.tools!.find((t) => t.name === "remember")!
    // safeParse must not throw and must accept arbitrary data under the fallback.
    const parsed = (remember.schema as z.ZodTypeAny).safeParse({
      data: { anything: "goes" },
      content: "x",
    })
    expect(parsed.success).toBe(true)
  })

  it("uses the route's Zod schema as the remember `data` shape when provided", async () => {
    const ctx = baseCtx(fakeStore())
    ;(ctx.memory as { schema?: unknown }).schema = z.object({ subject: z.string() })
    const c = await createMemoryMarker().load("/r", ctx)
    const remember = c.tools!.find((t) => t.name === "remember")!
    const schema = remember.schema as z.ZodTypeAny
    expect(schema.safeParse({ data: { subject: "acme" }, content: "x" }).success).toBe(true)
    // The real schema is actually exercised — a wrong-typed field is rejected.
    expect(schema.safeParse({ data: { subject: 5 }, content: "x" }).success).toBe(false)
  })

  it("auto mode ADDs a new active record", async () => {
    const store = fakeStore()
    const c = await createMemoryMarker().load("/r", ctxWith(store, "auto"))
    const remember = c.tools!.find((t) => t.name === "remember")!
    await remember.run(
      { data: { subject: "billing", predicate: "escalate", value: "500" }, content: "esc" },
      { signal: new AbortController().signal },
    )
    expect(store.rows.filter((r: any) => r.status === "active")).toHaveLength(1)
  })

  it("auto mode UPDATEs idempotently for identical data (no second row)", async () => {
    const store = fakeStore()
    const c = await createMemoryMarker().load("/r", ctxWith(store, "auto"))
    const remember = c.tools!.find((t) => t.name === "remember")!
    const data = { subject: "billing", predicate: "escalate", value: "500" }
    await remember.run({ data, content: "esc" }, { signal: new AbortController().signal })
    await remember.run({ data, content: "esc again" }, { signal: new AbortController().signal })
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].status).toBe("active")
  })

  it("auto mode SUPERSEDEs a contradicting value (old superseded, new active)", async () => {
    const store = fakeStore()
    const c = await createMemoryMarker().load("/r", ctxWith(store, "auto"))
    const remember = c.tools!.find((t) => t.name === "remember")!
    await remember.run(
      { data: { subject: "billing", predicate: "escalate", value: "500" }, content: "v1" },
      { signal: new AbortController().signal },
    )
    await remember.run(
      { data: { subject: "billing", predicate: "escalate", value: "750" }, content: "v2" },
      { signal: new AbortController().signal },
    )
    const active = store.rows.filter((r: any) => r.status === "active")
    const superseded = store.rows.filter((r: any) => r.status === "superseded")
    expect(active).toHaveLength(1)
    expect(active[0].data.value).toBe("750")
    expect(superseded).toHaveLength(1)
    expect(superseded[0].data.value).toBe("500")
  })
})
