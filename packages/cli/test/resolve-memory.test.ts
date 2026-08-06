import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"

import {
  resolveDistillConfig,
  resolveEpisodesConfig,
  resolveMemoryStore,
  resolveMemoryWrites,
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

describe("resolveEpisodesConfig", () => {
  test("returns defaults (disabled) when no dawn.config.ts exists", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-episodes-"))
    tempDirs.push(appRoot)

    const episodes = await resolveEpisodesConfig(appRoot)
    expect(episodes).toEqual({
      enabled: false,
      ttlMs: 30 * 86_400_000,
      cap: 500,
      includeFailedRuns: true,
      embed: false,
    })
  })

  test("returns defaults when config has memory but no episodes block", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-episodes-"))
    tempDirs.push(appRoot)
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      `export default { memory: { writes: "auto" } }\n`,
    )

    const episodes = await resolveEpisodesConfig(appRoot)
    expect(episodes.enabled).toBe(false)
    expect(episodes.ttlMs).toBe(30 * 86_400_000)
    expect(episodes.cap).toBe(500)
  })

  test("threads configured values through", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-episodes-"))
    tempDirs.push(appRoot)
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      `export default { memory: { episodes: { enabled: true, ttlMs: 3_600_000, cap: 3, includeFailedRuns: false } } }\n`,
    )

    const episodes = await resolveEpisodesConfig(appRoot)
    expect(episodes).toEqual({
      enabled: true,
      ttlMs: 3_600_000,
      cap: 3,
      includeFailedRuns: false,
      embed: false,
    })
  })

  test("embed: true resolves to false and warns exactly once per process", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-episodes-"))
      tempDirs.push(appRoot)
      await writeFile(
        join(appRoot, "dawn.config.ts"),
        `export default { memory: { episodes: { enabled: true, embed: true } } }\n`,
      )

      const first = await resolveEpisodesConfig(appRoot)
      expect(first.embed).toBe(false)
      const second = await resolveEpisodesConfig(appRoot)
      expect(second.embed).toBe(false)

      const embedWarnings = warn.mock.calls.filter((c) =>
        String(c[0]).includes("memory.episodes.embed is not yet supported"),
      )
      expect(embedWarnings).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("resolveDistillConfig", () => {
  test("returns documented defaults when no dawn.config.ts exists", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-distill-"))
    tempDirs.push(appRoot)

    expect(await resolveDistillConfig(appRoot)).toEqual({
      model: "gpt-5-mini",
      provider: "openai",
      maxBatches: 5,
      consolidate: { olderThanMs: 7 * 86_400_000, minBatchSize: 5, maxBatchSize: 50 },
      reflect: { minNewRecords: 10, maxRecords: 100, writes: "candidate" },
    })
  })

  test("returns defaults when config has memory but no distill block", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-distill-"))
    tempDirs.push(appRoot)
    await writeFile(join(appRoot, "dawn.config.ts"), `export default { memory: {} }\n`)

    expect(await resolveDistillConfig(appRoot)).toEqual({
      model: "gpt-5-mini",
      provider: "openai",
      maxBatches: 5,
      consolidate: { olderThanMs: 7 * 86_400_000, minBatchSize: 5, maxBatchSize: 50 },
      reflect: { minNewRecords: 10, maxRecords: 100, writes: "candidate" },
    })
  })

  test("honors overrides and leaves untouched defaults intact", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-distill-"))
    tempDirs.push(appRoot)
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      `export default { memory: { distill: { model: "gpt-5", maxBatches: 2, consolidate: { minBatchSize: 3 }, reflect: { writes: "auto" } } } }\n`,
    )

    const c = await resolveDistillConfig(appRoot)
    expect(c.model).toBe("gpt-5")
    expect(c.maxBatches).toBe(2)
    expect(c.consolidate.minBatchSize).toBe(3)
    // Untouched defaults survive a partial override of the same sub-block.
    expect(c.consolidate.maxBatchSize).toBe(50)
    expect(c.consolidate.olderThanMs).toBe(7 * 86_400_000)
    expect(c.reflect.writes).toBe("auto")
    expect(c.reflect.minNewRecords).toBe(10)
    expect(c.reflect.maxRecords).toBe(100)
  })

  test("threads an explicit provider through and passes consolidate.ttlMs when set", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-distill-"))
    tempDirs.push(appRoot)
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      `export default { memory: { distill: { provider: "anthropic", consolidate: { ttlMs: 1000 } } } }\n`,
    )

    const c = await resolveDistillConfig(appRoot)
    expect(c.provider).toBe("anthropic")
    expect(c.consolidate.ttlMs).toBe(1000)
  })

  test("infers the provider from the configured model when none is set", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-distill-"))
    tempDirs.push(appRoot)
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      `export default { memory: { distill: { model: "claude-sonnet-4-5" } } }\n`,
    )

    const c = await resolveDistillConfig(appRoot)
    expect(c.provider).toBe("anthropic")
  })

  test("falls back to openai when the model's provider cannot be inferred", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-distill-"))
    tempDirs.push(appRoot)
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      `export default { memory: { distill: { model: "some-local-model" } } }\n`,
    )

    const c = await resolveDistillConfig(appRoot)
    expect(c.provider).toBe("openai")
  })

  test("returns defaults (never throws) when dawn.config.ts is invalid", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-distill-"))
    tempDirs.push(appRoot)
    // Not an object default export → loadDawnConfig rejects, same catch path the
    // "no dawn.config.ts" case exercises.
    await writeFile(join(appRoot, "dawn.config.ts"), `export default 42\n`)

    expect(await resolveDistillConfig(appRoot)).toEqual({
      model: "gpt-5-mini",
      provider: "openai",
      maxBatches: 5,
      consolidate: { olderThanMs: 7 * 86_400_000, minBatchSize: 5, maxBatchSize: 50 },
      reflect: { minNewRecords: 10, maxRecords: 100, writes: "candidate" },
    })
  })
})
