import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, test } from "vitest"

import {
  resolveMemoryStore,
  resolveMemoryWrites,
  routeNamespaceKey,
} from "../src/lib/runtime/resolve-memory.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("resolveMemoryStore", () => {
  test("returns a store with put/get/search functions when no dawn.config.ts exists", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-memory-"))
    tempDirs.push(appRoot)

    const store = await resolveMemoryStore(appRoot)

    expect(typeof store.put).toBe("function")
    expect(typeof store.get).toBe("function")
    expect(typeof store.search).toBe("function")
  })

  test("default store round-trips a put + get", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-memory-"))
    tempDirs.push(appRoot)

    const store = await resolveMemoryStore(appRoot)

    await store.put({
      id: "test-id-1",
      kind: "semantic",
      namespace: "test",
      content: "hello memory",
      data: {},
      source: { type: "run", id: "r1" },
      confidence: 1,
      tags: [],
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const record = await store.get("test-id-1")
    expect(record?.content).toBe("hello memory")
  })

  test("threads config.memory.recall into the default sqlite store", async () => {
    // App root with a dawn.config.ts that caps the ranked candidate pool at 1.
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-memory-"))
    tempDirs.push(appRoot)
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      `export default { memory: { recall: { candidatePool: 1 } } }\n`,
    )

    const store = await resolveMemoryStore(appRoot)
    const base = {
      kind: "semantic" as const,
      namespace: "ns",
      data: {},
      source: { type: "run" as const, id: "r" },
      confidence: 1,
      tags: [],
      status: "active" as const,
      createdAt: "2026-07-01T00:00:00.000Z",
    }
    await store.put({
      ...base,
      id: "older",
      content: "billing threshold exact",
      updatedAt: "2026-07-01T00:00:00.000Z",
    })
    await store.put({
      ...base,
      id: "newer",
      content: "billing note",
      updatedAt: "2026-07-04T00:00:00.000Z",
    })
    const out = await store.search({
      namespace: "ns",
      query: "billing threshold",
      now: "2026-07-05T00:00:00.000Z",
    })
    // candidatePool 1 → only the newest token-match is scored/returned. With the
    // default pool (256), "older" (2/2 token match) would win instead.
    expect(out.map((r) => r.id)).toEqual(["newer"])
  })
})

describe("resolveMemoryWrites", () => {
  test("defaults to 'candidate' when no dawn.config.ts exists", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-memory-"))
    tempDirs.push(appRoot)

    const writes = await resolveMemoryWrites(appRoot)
    expect(writes).toBe("candidate")
  })
})

describe("routeNamespaceKey", () => {
  it("normalizes a file path under src/app/ to a clean route key", () => {
    expect(routeNamespaceKey("src/app/memory-chat/index.ts")).toBe("/memory-chat")
  })

  it("handles nested dynamic segments", () => {
    expect(routeNamespaceKey("src/app/support/[tenant]/index.ts")).toBe("/support/[tenant]")
  })

  it("leaves an already-clean URL path unchanged", () => {
    expect(routeNamespaceKey("/chat")).toBe("/chat")
  })

  it("strips a #agent suffix from an already-clean path", () => {
    expect(routeNamespaceKey("/memory-chat#agent")).toBe("/memory-chat")
  })
})
