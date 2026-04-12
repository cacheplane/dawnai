import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"

import { discoverRoutes } from "../src/discovery/discover-routes"

const CONTRACT_FIXTURES_DIR = fileURLToPath(
  new URL("../../../test/fixtures/contracts/", import.meta.url),
)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

function fixtureRoot(name: string) {
  return join(CONTRACT_FIXTURES_DIR, name)
}

async function createAdHocApp(
  prefix: string,
  files: Record<string, string>,
  configSource = "export default {}\n",
) {
  const appRoot = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(appRoot)

  const appFiles = {
    "package.json": "{}\n",
    "dawn.config.ts": configSource,
    ...files,
  }

  await Promise.all(
    Object.entries(appFiles).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source)
    }),
  )

  return appRoot
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

  test("discovers root pages, strips route groups, excludes _private routes, and parses catchall segments", async () => {
    const appRoot = await createAdHocApp("dawn-core-discovery-", {
      "src/app/(public)/page.tsx": "export default {}\n",
      "src/app/(public)/[tenant]/graph.ts": "export default {}\n",
      "src/app/docs/[...path]/workflow.ts": "export default {}\n",
      "src/app/docs/[[...path]]/graph.ts": "export default {}\n",
      "src/app/_private/graph.ts": "export default {}\n",
      "src/app/internal/workflow.ts": "export default {}\n",
      "src/ignored/page.tsx": "export default {}\n",
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes).toEqual([
      expect.objectContaining({
        pathname: "/",
        entryFile: join(appRoot, "src/app/(public)/page.tsx"),
        entryKind: "page",
        segments: [],
      }),
      expect.objectContaining({
        pathname: "/[tenant]",
        entryFile: join(appRoot, "src/app/(public)/[tenant]/graph.ts"),
        entryKind: "graph",
        segments: [{ raw: "[tenant]", name: "tenant", kind: "dynamic" }],
      }),
      expect.objectContaining({
        pathname: "/docs/[...path]",
        entryFile: join(appRoot, "src/app/docs/[...path]/workflow.ts"),
        entryKind: "workflow",
        segments: [
          { raw: "docs", kind: "static" },
          { raw: "[...path]", name: "path", kind: "catchall" },
        ],
      }),
      expect.objectContaining({
        pathname: "/docs/[[...path]]",
        entryFile: join(appRoot, "src/app/docs/[[...path]]/graph.ts"),
        entryKind: "graph",
        segments: [
          { raw: "docs", kind: "static" },
          { raw: "[[...path]]", name: "path", kind: "optional-catchall" },
        ],
      }),
      expect.objectContaining({
        pathname: "/internal",
        entryFile: join(appRoot, "src/app/internal/workflow.ts"),
        entryKind: "workflow",
      }),
    ])
  })

  test("fails validation when the canonical src/app discovery root is missing", async () => {
    const appRoot = await createAdHocApp("dawn-core-missing-src-app-", {})

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(
      `Invalid Dawn app at ${appRoot}. Missing: ${join(appRoot, "src/app")}`,
    )
  })

  test("fails validation when a configured appDir is missing", async () => {
    const appRoot = await createAdHocApp(
      "dawn-core-missing-configured-appdir-",
      {
        "src/app/page.tsx": "export default {}\n",
      },
      'const appDir = "src/custom-app"\nexport default { appDir }\n',
    )

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(
      `Invalid Dawn app at ${appRoot}. Missing: ${join(appRoot, "src/custom-app")}`,
    )
  })

  test("fails with a Dawn-specific error when normalized route paths collide", async () => {
    const appRoot = await createAdHocApp("dawn-core-route-collision-", {
      "src/app/(marketing)/about/page.tsx": "export default {}\n",
      "src/app/about/page.tsx": "export default {}\n",
    })

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(
      'Duplicate Dawn route pathname "/about" detected',
    )
  })
})
