import { describe, expect, it } from "vitest"
import { createMemoryMarker } from "../../src/capabilities/built-in/memory.js"

function fakeStore() {
  const rows: any[] = []
  return {
    rows,
    async put(r: any) {
      rows.push(r)
    },
    async get(id: string) {
      return rows.find((r) => r.id === id) ?? null
    },
    async search(q: any) {
      return rows.filter(
        (r) => r.namespace === q.namespace && (r.status ?? "active") === (q.status ?? "active"),
      )
    },
    async update() {},
    async supersede() {},
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
})
