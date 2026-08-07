import { afterEach, beforeEach, describe, expect, test } from "vitest"

import {
  __clearConfigLoaderForTests,
  __clearDawnConfigCacheForTests,
  loadDawnConfig,
  registerConfigLoader,
  seedDawnConfig,
} from "../src/config.js"

// Both the memo and the registered loader are process-global. This suite is
// the only one that runs with NO loader registered, so it must leave the
// module in the state it found it in on BOTH sides.
beforeEach(() => {
  __clearDawnConfigCacheForTests()
  __clearConfigLoaderForTests()
})

afterEach(() => {
  __clearDawnConfigCacheForTests()
  __clearConfigLoaderForTests()
})

describe("config loader seam", () => {
  test("rejects with an actionable error when no loader is registered", async () => {
    await expect(loadDawnConfig({ appRoot: "/app" })).rejects.toThrow(
      /no config loader registered/i,
    )
    await expect(loadDawnConfig({ appRoot: "/app" })).rejects.toThrow(/dawn\.config\.ts/)
  })

  test("dispatches through the registered loader and memoizes its result", async () => {
    let calls = 0
    registerConfigLoader(async ({ appRoot }) => {
      calls += 1
      return { appRoot, config: { appDir: "src/app" }, configPath: `${appRoot}/dawn.config.ts` }
    })

    const first = await loadDawnConfig({ appRoot: "/app" })
    const second = await loadDawnConfig({ appRoot: "/app" })

    expect(first.config.appDir).toBe("src/app")
    expect(second).toBe(first)
    expect(calls).toBe(1)
  })

  test("a seed beats the registered loader", async () => {
    let calls = 0
    registerConfigLoader(async ({ appRoot }) => {
      calls += 1
      return { appRoot, config: { appDir: "from-loader" }, configPath: `${appRoot}/dawn.config.ts` }
    })

    seedDawnConfig("/app", { appDir: "seeded" })
    const loaded = await loadDawnConfig({ appRoot: "/app" })

    expect(loaded.configPath).toBe("<seeded>")
    expect(loaded.config.appDir).toBe("seeded")
    expect(calls).toBe(0)
  })

  test("a seed survives an in-flight registered load rejecting after the seed lands", async () => {
    registerConfigLoader(async () => {
      throw new Error("loader blew up")
    })

    // Do NOT await: seed while the load is in flight, so the rejection
    // eviction has to identity-check the cached promise to spare the seed.
    const inFlight = loadDawnConfig({ appRoot: "/app" })
    seedDawnConfig("/app", { appDir: "seeded" })
    await expect(inFlight).rejects.toThrow(/loader blew up/)

    const loaded = await loadDawnConfig({ appRoot: "/app" })
    expect(loaded.configPath).toBe("<seeded>")
    expect(loaded.config.appDir).toBe("seeded")
  })
})
