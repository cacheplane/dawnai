import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { discoverRoutes } from "@dawn-ai/core/node"
import { afterEach, describe, expect, it } from "vitest"

import * as fetchBarrel from "../src/fetch-exports.js"
import {
  collectRouteStaticDiscovery,
  emitModulesFile,
  type RouteStaticDiscovery,
} from "../src/lib/build/targets/modules-emitter.js"
import {
  loadStaticModules,
  normalizeThreadAccessModule,
} from "../src/lib/runtime/static-modules.js"
import * as runtimeBarrel from "../src/runtime-exports.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const VALID_POLICY_FILE =
  'import { defineThreadAccess } from "@dawn-ai/sdk"\n' +
  "export default defineThreadAccess({\n" +
  '  fallback: () => ({ decision: "allow" }),\n' +
  "})\n"

async function fixtureApp(
  files: Readonly<Record<string, string>> = { "src/thread-access.ts": VALID_POLICY_FILE },
): Promise<string> {
  // realpath: on macOS the tmpdir is behind a /var → /private/var symlink, and
  // the loader resolves module URLs to their real paths.
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "dawn-static-thread-access-")))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const appFiles: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "static-thread-access-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      'export default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n',
    ...files,
  }
  for (const [relativePath, source] of Object.entries(appFiles)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  return appRoot
}

async function collectFixtureDiscoveries(appRoot: string): Promise<RouteStaticDiscovery[]> {
  const manifest = await discoverRoutes({ appRoot })
  const discoveries: RouteStaticDiscovery[] = []
  for (const route of manifest.routes) {
    discoveries.push(await collectRouteStaticDiscovery({ appRoot, route }))
  }
  return discoveries
}

/** Link the real @dawn-ai/cli package into the fixture so the emitted
 * manifest's `"@dawn-ai/cli/runtime"` import resolves from the tmpdir. */
async function linkCliPackage(appRoot: string): Promise<void> {
  await mkdir(join(appRoot, "node_modules", "@dawn-ai"), { recursive: true })
  await symlink(
    join(repoRoot, "packages", "cli"),
    join(appRoot, "node_modules", "@dawn-ai", "cli"),
    "dir",
  )
}

// ---------------------------------------------------------------------------
// Emitter: threadAccessFile produces a namespace import (JSON.stringify'd
// specifier) and a `threadAccess: normalizeThreadAccessModule(...)` entry
// AFTER middleware and BEFORE routes; omitting it emits neither.
// ---------------------------------------------------------------------------

describe("emitModulesFile — thread access", () => {
  it("emits the namespace import and normalize call when threadAccessFile is set", async () => {
    const appRoot = await fixtureApp()
    const discoveries = await collectFixtureDiscoveries(appRoot)

    const text = emitModulesFile({
      appRoot,
      buildDir: join(appRoot, ".dawn", "build"),
      discoveries,
      threadAccessFile: join(appRoot, "src", "thread-access.ts"),
    })

    expect(text).toContain(
      'import { buildStaticRouteModule, normalizeThreadAccessModule } from "@dawn-ai/cli/runtime"',
    )
    expect(text).toContain('import * as threadAccessModule from "../../src/thread-access.ts"')
    expect(text).toContain("  threadAccess: normalizeThreadAccessModule(threadAccessModule),")
    // Before routes in the default export.
    expect(text.indexOf("threadAccess: normalizeThreadAccessModule")).toBeGreaterThan(0)
    expect(text.indexOf("threadAccess: normalizeThreadAccessModule")).toBeLessThan(
      text.indexOf("routes: ["),
    )
  })

  it("composes one import line with middleware, in a fixed order", async () => {
    const appRoot = await fixtureApp({
      "src/middleware.ts":
        'import { allow, defineMiddleware } from "@dawn-ai/sdk"\n' +
        "export default defineMiddleware(() => allow())\n",
      "src/thread-access.ts": VALID_POLICY_FILE,
    })
    const discoveries = await collectFixtureDiscoveries(appRoot)

    const text = emitModulesFile({
      appRoot,
      buildDir: join(appRoot, ".dawn", "build"),
      discoveries,
      middlewareFile: join(appRoot, "src", "middleware.ts"),
      threadAccessFile: join(appRoot, "src", "thread-access.ts"),
    })

    expect(text).toContain(
      'import { buildStaticRouteModule, normalizeMiddlewareModule, normalizeThreadAccessModule } from "@dawn-ai/cli/runtime"',
    )
    // middleware → threadAccess → routes, so the middleware entry keeps the
    // position the existing manifest assertions pin it to.
    expect(text.indexOf("middleware: normalizeMiddlewareModule")).toBeLessThan(
      text.indexOf("threadAccess: normalizeThreadAccessModule"),
    )
    expect(text.indexOf("threadAccess: normalizeThreadAccessModule")).toBeLessThan(
      text.indexOf("routes: ["),
    )
  })

  it("JSON-escapes hostile thread-access specifiers", () => {
    const text = emitModulesFile({
      appRoot: "/app",
      buildDir: "/app/.dawn/build",
      discoveries: [],
      threadAccessFile: '/app/src/thread"access.ts',
    })
    expect(text).toContain(
      String.raw`import * as threadAccessModule from "../../src/thread\"access.ts"`,
    )
    expect(text).not.toContain('from "../../src/thread"access.ts"')
  })

  it("emits no thread-access artifacts when threadAccessFile is absent", async () => {
    const appRoot = await fixtureApp({})
    const discoveries = await collectFixtureDiscoveries(appRoot)
    const text = emitModulesFile({
      appRoot,
      buildDir: join(appRoot, ".dawn", "build"),
      discoveries,
    })
    expect(text).not.toContain("normalizeThreadAccessModule")
    expect(text).not.toContain("threadAccessModule")
    expect(text).not.toContain("threadAccess:")
    expect(text).toContain('import { buildStaticRouteModule } from "@dawn-ai/cli/runtime"')
  })
})

// ---------------------------------------------------------------------------
// Both barrels, or the generated manifest cannot link: the node flavor imports
// `@dawn-ai/cli/runtime` and the edge flavor `@dawn-ai/cli/fetch`, each by
// literal specifier.
// ---------------------------------------------------------------------------

describe("normalizeThreadAccessModule — barrels", () => {
  it("is exported from the runtime entry and the fetch entry, as one function", () => {
    expect(typeof runtimeBarrel.normalizeThreadAccessModule).toBe("function")
    expect(typeof fetchBarrel.normalizeThreadAccessModule).toBe("function")
    expect(runtimeBarrel.normalizeThreadAccessModule).toBe(fetchBarrel.normalizeThreadAccessModule)
  })
})

// ---------------------------------------------------------------------------
// normalizeThreadAccessModule: the SAME export selection the dynamic probe
// uses, and — unlike normalizeMiddlewareModule — a THROW when the selection
// binds nothing usable. The emitter only ever calls it for an app that has a
// policy file, so "bound nothing" means the built app would serve every thread
// endpoint ungated while logging that it has no policy.
// ---------------------------------------------------------------------------

describe("normalizeThreadAccessModule — selection parity and fail-closed", () => {
  const policy = { fallback: () => ({ decision: "allow" }) as const }

  it("selects a default export", () => {
    expect(normalizeThreadAccessModule({ default: policy })).toBe(policy)
  })

  it("falls back to a named `threadAccess` export", () => {
    expect(normalizeThreadAccessModule({ threadAccess: policy })).toBe(policy)
    expect(normalizeThreadAccessModule({ default: undefined, threadAccess: policy })).toBe(policy)
  })

  it("throws when the module binds no policy at all", () => {
    expect(() => normalizeThreadAccessModule({})).toThrow(/default.*threadAccess/s)
    expect(() => normalizeThreadAccessModule(null)).toThrow(/default.*threadAccess/s)
    expect(() => normalizeThreadAccessModule(undefined)).toThrow(/default.*threadAccess/s)
  })

  it("throws DAWN_E3003 rather than degrading to `no policy`", () => {
    try {
      normalizeThreadAccessModule({})
      expect.unreachable("expected a throw")
    } catch (error) {
      expect(error).toMatchObject({ code: "DAWN_E3003" })
    }
  })

  it("throws on a selected value that is not a well-formed policy", () => {
    expect(() => normalizeThreadAccessModule({ default: "nope" })).toThrow(/not an object/)
    expect(() =>
      normalizeThreadAccessModule({ default: { read: () => ({ decision: "allow" }) } }),
    ).toThrow(/`fallback`/)
    expect(() =>
      normalizeThreadAccessModule({ default: { fallback: () => ({}), read: 1 } }),
    ).toThrow(/`read`/)
  })
})

// ---------------------------------------------------------------------------
// Round-trip: the emitted manifest carries a working policy, bound through the
// published `@dawn-ai/cli/runtime` specifier the generated file imports.
// ---------------------------------------------------------------------------

describe("static manifest thread access — round-trip", () => {
  it("binds the policy from the manifest with the source file deleted", async () => {
    const appRoot = await fixtureApp()
    await linkCliPackage(appRoot)

    const discoveries = await collectFixtureDiscoveries(appRoot)
    const buildDir = join(appRoot, ".dawn", "build")
    await mkdir(buildDir, { recursive: true })
    const modulesPath = join(buildDir, "modules.mjs")
    await writeFile(
      modulesPath,
      emitModulesFile({
        appRoot,
        buildDir,
        discoveries,
        threadAccessFile: join(appRoot, "src", "thread-access.ts"),
      }),
      "utf8",
    )

    const modules = await loadStaticModules(pathToFileURL(modulesPath))
    expect(typeof modules.threadAccess?.fallback).toBe("function")
  }, 30_000)
})
