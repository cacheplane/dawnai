import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

import { discoverRoutes } from "../src/discovery/discover-routes"

const CONTRACT_FIXTURES_DIR = fileURLToPath(
  new URL("../../../test/fixtures/contracts/", import.meta.url),
)
function fixtureRoot(name: string) {
  return join(CONTRACT_FIXTURES_DIR, name)
}

describe("discoverRoutes", () => {
  test("discovers the valid default-app fixture from cwd and resolves its executable entry", async () => {
    const appRoot = fixtureRoot("valid-basic")

    const manifest = await discoverRoutes({ cwd: join(appRoot, "src", "app", "(public)") })

    expect(manifest.appRoot).toBe(appRoot)
    expect(manifest.routes.map((route) => [route.pathname, route.entryKind])).toEqual([
      ["/hello/[tenant]", "workflow"],
    ])
    expect(manifest.routes[0]).toMatchObject({
      entryFile: join(appRoot, "src/app/(public)/hello/[tenant]/workflow.ts"),
      routeDir: join(appRoot, "src/app/(public)/hello/[tenant]"),
      segments: [
        { raw: "hello", kind: "static" },
        { raw: "[tenant]", name: "tenant", kind: "dynamic" },
      ],
    })
  })

  test("discovers the valid custom appDir fixture and preserves its configured route path", async () => {
    const appRoot = fixtureRoot("valid-custom-app-dir")

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.appRoot).toBe(appRoot)
    expect(manifest.routes.map((route) => [route.pathname, route.entryKind])).toEqual([
      ["/support/[tenant]", "graph"],
    ])
    expect(manifest.routes[0]).toMatchObject({
      entryFile: join(appRoot, "src/dawn-app/support/[tenant]/graph.ts"),
      routeDir: join(appRoot, "src/dawn-app/support/[tenant]"),
      segments: [
        { raw: "support", kind: "static" },
        { raw: "[tenant]", name: "tenant", kind: "dynamic" },
      ],
    })
  })

  test("fails with a stable Dawn error when a route directory contains both graph.ts and workflow.ts", async () => {
    const appRoot = fixtureRoot("invalid-companion")

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(
      `Route directory ${join(appRoot, "src/app/broken/[tenant]")} has multiple primary entries: graph.ts, workflow.ts`,
    )
  })
})
