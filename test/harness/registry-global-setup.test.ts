import { describe, expect, test } from "vitest"

import { getTestRegistryUrl } from "./local-registry.ts"

describe("registry globalSetup", () => {
  test("exposes a reachable registry URL to test workers", async () => {
    const url = getTestRegistryUrl()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)

    const response = await fetch(new URL("/-/ping", url))
    expect(response.ok).toBe(true)
  })
})
