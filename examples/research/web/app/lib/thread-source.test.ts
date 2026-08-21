import { beforeEach, describe, expect, test } from "vitest"
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
