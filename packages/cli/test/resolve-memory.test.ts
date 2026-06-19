import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { resolveMemoryStore, resolveMemoryWrites } from "../src/lib/runtime/resolve-memory.js"

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
})

describe("resolveMemoryWrites", () => {
  test("defaults to 'candidate' when no dawn.config.ts exists", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-memory-"))
    tempDirs.push(appRoot)

    const writes = await resolveMemoryWrites(appRoot)
    expect(writes).toBe("candidate")
  })
})
