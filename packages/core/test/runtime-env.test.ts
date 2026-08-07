import { afterEach, describe, expect, it, vi } from "vitest"

import {
  __clearSeededRuntimeEnvForTests,
  readRuntimeEnv,
  seedRuntimeEnv,
} from "../src/runtime-env.js"

/**
 * `readRuntimeEnv` is the seam that lets Dawn read configuration on a runtime
 * with no `process` (workerd without `nodejs_compat`, which is exactly what the
 * hono target emits). The contract has three parts, and all three are load
 * bearing:
 *
 *  1. On Node with nothing seeded it must be indistinguishable from a direct
 *     `process.env[name]` read — every existing code path depends on that.
 *  2. `process.env` must WIN over a seeded value, so seeding can never quietly
 *     shadow a real deployment variable.
 *  3. With no `process` at all it must return the seeded value rather than
 *     throwing — the whole point.
 */
describe("readRuntimeEnv", () => {
  afterEach(() => {
    __clearSeededRuntimeEnvForTests()
    vi.unstubAllGlobals()
    delete process.env.DAWN_TEST_RUNTIME_ENV
  })

  describe("on node, with nothing seeded", () => {
    it("returns the process.env value", () => {
      process.env.DAWN_TEST_RUNTIME_ENV = "from-process"
      expect(readRuntimeEnv("DAWN_TEST_RUNTIME_ENV")).toBe("from-process")
    })

    it("returns undefined for an unset name", () => {
      expect(readRuntimeEnv("DAWN_TEST_RUNTIME_ENV")).toBeUndefined()
    })

    it("preserves an empty string rather than treating it as unset", () => {
      // `process.env.X = ""` reads back as `""`, not `undefined`. If the seam
      // used `||` instead of an `undefined` check it would silently differ here.
      process.env.DAWN_TEST_RUNTIME_ENV = ""
      expect(readRuntimeEnv("DAWN_TEST_RUNTIME_ENV")).toBe("")
    })

    it("sees a value set AFTER the module was imported", () => {
      // Guards against caching `process.env` at module scope, which would break
      // every test that stubs an env var late.
      expect(readRuntimeEnv("DAWN_TEST_RUNTIME_ENV")).toBeUndefined()
      process.env.DAWN_TEST_RUNTIME_ENV = "set-late"
      expect(readRuntimeEnv("DAWN_TEST_RUNTIME_ENV")).toBe("set-late")
    })
  })

  describe("precedence", () => {
    it("prefers process.env over a seeded value", () => {
      seedRuntimeEnv({ DAWN_TEST_RUNTIME_ENV: "from-seed" })
      process.env.DAWN_TEST_RUNTIME_ENV = "from-process"
      expect(readRuntimeEnv("DAWN_TEST_RUNTIME_ENV")).toBe("from-process")
    })

    it("falls back to the seeded value when process.env does not have it", () => {
      seedRuntimeEnv({ DAWN_TEST_RUNTIME_ENV: "from-seed" })
      expect(readRuntimeEnv("DAWN_TEST_RUNTIME_ENV")).toBe("from-seed")
    })

    it("lets the last seed win and does not merge", () => {
      seedRuntimeEnv({ DAWN_TEST_RUNTIME_ENV: "first", OTHER: "kept?" })
      seedRuntimeEnv({ DAWN_TEST_RUNTIME_ENV: "second" })
      expect(readRuntimeEnv("DAWN_TEST_RUNTIME_ENV")).toBe("second")
      expect(readRuntimeEnv("OTHER")).toBeUndefined()
    })

    it("copies the seeded object so later mutation cannot change it", () => {
      const supplied: Record<string, string> = { DAWN_TEST_RUNTIME_ENV: "at-seed-time" }
      seedRuntimeEnv(supplied)
      supplied.DAWN_TEST_RUNTIME_ENV = "mutated-later"
      expect(readRuntimeEnv("DAWN_TEST_RUNTIME_ENV")).toBe("at-seed-time")
    })
  })

  describe("on a runtime with no process (workerd without nodejs_compat)", () => {
    /**
     * Read with `globalThis.process` removed. The read is captured and the stub
     * torn down BEFORE asserting, so vitest's own machinery never runs a single
     * instruction inside the process-less window.
     */
    function readWithoutProcess(name: string): string | undefined {
      vi.stubGlobal("process", undefined)
      try {
        return readRuntimeEnv(name)
      } finally {
        vi.unstubAllGlobals()
      }
    }

    it("returns the seeded value instead of throwing", () => {
      seedRuntimeEnv({ OPENAI_BASE_URL: "http://127.0.0.1:4010/v1" })
      expect(readWithoutProcess("OPENAI_BASE_URL")).toBe("http://127.0.0.1:4010/v1")
    })

    it("returns undefined — not a ReferenceError — when nothing is seeded", () => {
      // This is the defect the whole change exists to fix: the old
      // `process.env.X` form threw here, taking down the first turn.
      expect(() => readWithoutProcess("OPENAI_BASE_URL")).not.toThrow()
      expect(readWithoutProcess("OPENAI_BASE_URL")).toBeUndefined()
    })

    it("leaves a debug flag OFF when nothing is seeded", () => {
      // The four DAWN_DEBUG_* call sites compare against "1"; unseeded must be
      // falsy so debug output stays off by default on the edge.
      expect(readWithoutProcess("DAWN_DEBUG_MEMORY")).toBeUndefined()
    })

    it("still lets a debug flag be turned on by seeding it", () => {
      seedRuntimeEnv({ DAWN_DEBUG_MEMORY: "1" })
      expect(readWithoutProcess("DAWN_DEBUG_MEMORY")).toBe("1")
    })
  })
})
