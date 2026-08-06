import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { discoverRoutes } from "@dawn-ai/core/node"
import { afterEach, describe, expect, it } from "vitest"

import { script } from "../../testing/dist/index.js"
import {
  collectRouteStaticDiscovery,
  emitModulesFile,
  type RouteStaticDiscovery,
} from "../src/lib/build/targets/modules-emitter.js"
import { nodeTarget } from "../src/lib/build/targets/node.js"
import { middlewareCandidatePaths } from "../src/lib/dev/middleware.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import { loadStaticModules, normalizeMiddlewareModule } from "../src/lib/runtime/static-modules.js"
import { cleanup, runChatTurn, withAimock } from "./helpers/static-modules-fixture.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// Fixture app: one agent route plus an app middleware file that rejects any
// request missing the `x-ok` header. Two authoring shapes are exercised: the
// documented default export and the named `middleware` export the dynamic
// probe (loadMiddleware) also accepts.
// ---------------------------------------------------------------------------

const DEFAULT_EXPORT_MIDDLEWARE =
  'import { allow, defineMiddleware, reject } from "@dawn-ai/sdk"\n' +
  "export default defineMiddleware((req) =>\n" +
  '  req.headers["x-ok"] ? allow() : reject(401, { error: "missing x-ok" }),\n' +
  ")\n"

const NAMED_EXPORT_MIDDLEWARE =
  'import { allow, defineMiddleware, reject } from "@dawn-ai/sdk"\n' +
  "export const middleware = defineMiddleware((req) =>\n" +
  '  req.headers["x-ok"] ? allow() : reject(401, { error: "missing x-ok" }),\n' +
  ")\n"

async function fixtureApp(
  middlewareFiles: Record<string, string> = { "src/middleware.ts": DEFAULT_EXPORT_MIDDLEWARE },
): Promise<string> {
  // realpath: on macOS the tmpdir is behind a /var → /private/var symlink, and
  // the loader resolves module URLs to their real paths — keep every path in
  // the test on the resolved side so absolute-path assertions line up.
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "dawn-static-middleware-")))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "static-middleware-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      'export default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n',
    ...middlewareFiles,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
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
// Emitter: middlewareFile produces a namespace import (JSON.stringify'd
// specifier) and a `middleware: normalizeMiddlewareModule(...)` entry BEFORE
// routes; omitting middlewareFile emits neither.
// ---------------------------------------------------------------------------

describe("emitModulesFile — middleware", () => {
  it("emits the namespace import and normalize call when middlewareFile is set", async () => {
    const appRoot = await fixtureApp()
    const discoveries = await collectFixtureDiscoveries(appRoot)
    const buildDir = join(appRoot, ".dawn", "build")

    const text = emitModulesFile({
      appRoot,
      buildDir,
      discoveries,
      middlewareFile: join(appRoot, "src", "middleware.ts"),
    })

    expect(text).toContain(
      'import { buildStaticRouteModule, normalizeMiddlewareModule } from "@dawn-ai/cli/runtime"',
    )
    expect(text).toContain('import * as middlewareModule from "../../src/middleware.ts"')
    expect(text).toContain("  middleware: normalizeMiddlewareModule(middlewareModule),")
    // Before routes in the default export.
    expect(text.indexOf("middleware: normalizeMiddlewareModule")).toBeGreaterThan(0)
    expect(text.indexOf("middleware: normalizeMiddlewareModule")).toBeLessThan(
      text.indexOf("routes: ["),
    )
  })

  it("JSON-escapes hostile middleware specifiers", () => {
    const text = emitModulesFile({
      appRoot: "/app",
      buildDir: "/app/.dawn/build",
      discoveries: [],
      middlewareFile: '/app/src/mid"dleware.ts',
    })
    expect(text).toContain(
      String.raw`import * as middlewareModule from "../../src/mid\"dleware.ts"`,
    )
    expect(text).not.toContain('from "../../src/mid"dleware.ts"')
  })

  it("emits no middleware artifacts when middlewareFile is absent", async () => {
    const appRoot = await fixtureApp({})
    const discoveries = await collectFixtureDiscoveries(appRoot)
    const text = emitModulesFile({
      appRoot,
      buildDir: join(appRoot, ".dawn", "build"),
      discoveries,
    })
    expect(text).not.toContain("normalizeMiddlewareModule")
    expect(text).not.toContain("middlewareModule")
    expect(text).toContain('import { buildStaticRouteModule } from "@dawn-ai/cli/runtime"')
  })
})

// ---------------------------------------------------------------------------
// Round-trip: the emitted manifest carries a working middleware function, and
// the fetch handler runs it FROM THE MANIFEST — proven by deleting the
// middleware source file before boot (the dynamic probe would find nothing).
// ---------------------------------------------------------------------------

describe("static manifest middleware — round-trip", () => {
  it("runs manifest middleware with the source file deleted (zero dynamic probe)", async () => {
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
        middlewareFile: join(appRoot, "src", "middleware.ts"),
      }),
      "utf8",
    )

    const modules = await loadStaticModules(pathToFileURL(modulesPath))
    expect(typeof modules.middleware).toBe("function")

    // Delete the middleware source: a dynamic loadMiddleware probe would now
    // find nothing, so any middleware behavior below came from the manifest.
    await rm(join(appRoot, "src", "middleware.ts"))

    await withAimock(script().user("hello").replies("Hi there, friend!").build())

    const handler = await createRuntimeFetchHandler({ appRoot, modules })
    cleanup.push(() => handler.close())

    // Without x-ok → the manifest middleware rejects with 401.
    const routeKey = encodeURIComponent("/chat#agent")
    const rejected = await handler.fetch(
      new Request(`http://localhost/agui/${routeKey}`, {
        body: JSON.stringify({
          context: [],
          forwardedProps: {},
          messages: [{ id: "1", role: "user", content: "hello" }],
          runId: "rn-rejected",
          state: {},
          threadId: "th-rejected",
          tools: [],
        }),
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        method: "POST",
      }),
    )
    expect(rejected.status).toBe(401)

    // With x-ok → middleware continues and the turn completes normally.
    const body = await runChatTurn(handler, "th-allowed", "hello", { "x-ok": "1" })
    expect(body).toContain("RUN_STARTED")
    expect(body).toContain("Hi there, friend!")
    expect(body).toContain("RUN_FINISHED")
  }, 30_000)

  it("binds a named `middleware` export (no default) via normalizeMiddlewareModule", async () => {
    const appRoot = await fixtureApp({ "src/middleware.ts": NAMED_EXPORT_MIDDLEWARE })
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
        middlewareFile: join(appRoot, "src", "middleware.ts"),
      }),
      "utf8",
    )

    const modules = await loadStaticModules(pathToFileURL(modulesPath))
    expect(typeof modules.middleware).toBe("function")
  }, 30_000)

  it("manifest middleware governs when the on-disk middleware disagrees", async () => {
    const appRoot = await fixtureApp() // manifest source: the x-ok rule
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
        middlewareFile: join(appRoot, "src", "middleware.ts"),
      }),
      "utf8",
    )
    const modules = await loadStaticModules(pathToFileURL(modulesPath))
    expect(typeof modules.middleware).toBe("function")

    // Swap the disk truth AFTER the manifest is bound: remove the emitted
    // source and plant a CONTRADICTORY rule (x-disk, not x-ok) at a candidate
    // path the manifest never imported — a fresh module, so no ESM-cache
    // ambiguity can mask a regression to the dynamic probe.
    await rm(join(appRoot, "src", "middleware.ts"))
    await writeFile(
      join(appRoot, "middleware.ts"),
      'import { allow, defineMiddleware, reject } from "@dawn-ai/sdk"\n' +
        "export default defineMiddleware((req) =>\n" +
        '  req.headers["x-disk"] ? allow() : reject(401, { error: "missing x-disk" }),\n' +
        ")\n",
      "utf8",
    )

    await withAimock(script().user("hello").replies("Hi there, friend!").build())
    const handler = await createRuntimeFetchHandler({ appRoot, modules })
    cleanup.push(() => handler.close())

    // Satisfies only the DISK rule → 401 proves the manifest governs (a
    // dynamic probe would have let this request through).
    const routeKey = encodeURIComponent("/chat#agent")
    const rejected = await handler.fetch(
      new Request(`http://localhost/agui/${routeKey}`, {
        body: JSON.stringify({
          context: [],
          forwardedProps: {},
          messages: [{ id: "1", role: "user", content: "hello" }],
          runId: "rn-disk",
          state: {},
          threadId: "th-disk",
          tools: [],
        }),
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          "x-disk": "1",
        },
        method: "POST",
      }),
    )
    expect(rejected.status).toBe(401)

    // Satisfies only the MANIFEST rule → the turn completes.
    const body = await runChatTurn(handler, "th-manifest-wins", "hello", { "x-ok": "1" })
    expect(body).toContain("RUN_FINISHED")
  }, 30_000)
})

// ---------------------------------------------------------------------------
// normalizeMiddlewareModule: exact selection parity with loadMiddleware's
// `mod.default ?? mod.middleware` + function check.
// ---------------------------------------------------------------------------

describe("normalizeMiddlewareModule — selection parity", () => {
  const fn = () => ({ action: "continue" }) as const

  it("selects a function default export", () => {
    expect(normalizeMiddlewareModule({ default: fn })).toBe(fn)
  })

  it("falls back to a function named `middleware` export", () => {
    expect(normalizeMiddlewareModule({ middleware: fn })).toBe(fn)
    expect(normalizeMiddlewareModule({ default: undefined, middleware: fn })).toBe(fn)
  })

  it("returns undefined when nothing usable is exported (dynamic-probe parity)", () => {
    expect(normalizeMiddlewareModule({})).toBeUndefined()
    expect(normalizeMiddlewareModule({ default: "nope" })).toBeUndefined()
    // `default ?? middleware` semantics: a non-null non-function default wins
    // the coalesce and then fails the function check — same as loadMiddleware.
    expect(normalizeMiddlewareModule({ default: "nope", middleware: fn })).toBeUndefined()
    expect(normalizeMiddlewareModule(null)).toBeUndefined()
    expect(normalizeMiddlewareModule(undefined)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Validation: a present-but-non-function middleware entry is a malformed
// manifest (fail loudly at boot); an explicit undefined is legitimate.
// ---------------------------------------------------------------------------

describe("loadStaticModules — middleware validation", () => {
  async function writeManifest(body: string): Promise<string> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "dawn-static-middleware-manifest-")))
    cleanup.push(() => rm(dir, { force: true, recursive: true }))
    const manifestPath = join(dir, "modules.mjs")
    await writeFile(manifestPath, body, "utf8")
    return manifestPath
  }

  it("throws the malformed-manifest error on a non-function middleware", async () => {
    const manifestPath = await writeManifest(
      'export default { middleware: "not-a-function", routes: [] }\n',
    )
    await expect(loadStaticModules(pathToFileURL(manifestPath))).rejects.toThrow(
      /middleware.*re-run `dawn build`/s,
    )
  })

  it("accepts an explicitly-undefined middleware entry", async () => {
    const manifestPath = await writeManifest(
      "export default { middleware: undefined, routes: [] }\n",
    )
    const modules = await loadStaticModules(pathToFileURL(manifestPath))
    expect(modules.middleware).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Node target wiring: emit() probes the SAME four candidate paths as the
// dynamic loadMiddleware, in the same precedence order, and threads the first
// hit into the emitted manifest.
// ---------------------------------------------------------------------------

describe("node target — middleware probe", () => {
  async function emitFixture(appRoot: string): Promise<string> {
    const manifest = await discoverRoutes({ appRoot })
    const buildDir = join(appRoot, ".dawn", "build")
    await mkdir(buildDir, { recursive: true })
    await nodeTarget.emit({ appRoot, buildDir, manifest })
    return readFile(join(buildDir, "modules.mjs"), "utf8")
  }

  it("wires src/middleware.ts into modules.mjs", async () => {
    const appRoot = await fixtureApp()
    const text = await emitFixture(appRoot)
    expect(text).toContain('import * as middlewareModule from "../../src/middleware.ts"')
    expect(text).toContain("middleware: normalizeMiddlewareModule(middlewareModule),")
  })

  it("shares loadMiddleware's exact candidate list", () => {
    expect(middlewareCandidatePaths("/app")).toEqual([
      "/app/src/middleware.ts",
      "/app/src/middleware.js",
      "/app/middleware.ts",
      "/app/middleware.js",
    ])
  })

  it("probes all four candidates in loadMiddleware's precedence order", async () => {
    const jsMiddleware =
      "export default (req) =>\n" +
      '  req.headers["x-ok"] ? { action: "continue" } : { action: "reject", status: 401 }\n'
    const appRoot = await fixtureApp({
      "middleware.js": jsMiddleware,
      "middleware.ts": DEFAULT_EXPORT_MIDDLEWARE,
      "src/middleware.js": jsMiddleware,
      "src/middleware.ts": DEFAULT_EXPORT_MIDDLEWARE,
    })
    // Table: with all four candidates on disk, the emitted specifier follows
    // precedence; removing the current winner promotes the next one.
    const order = [
      ["src/middleware.ts", "../../src/middleware.ts"],
      ["src/middleware.js", "../../src/middleware.js"],
      ["middleware.ts", "../../middleware.ts"],
      ["middleware.js", "../../middleware.js"],
    ] as const
    for (const [rel, specifier] of order) {
      const text = await emitFixture(appRoot)
      expect(text).toContain(`import * as middlewareModule from ${JSON.stringify(specifier)}`)
      await rm(join(appRoot, rel))
    }
    // All candidates removed → no middleware entry at all.
    const text = await emitFixture(appRoot)
    expect(text).not.toContain("middlewareModule")
  })

  it("emits no middleware entry when the app has no middleware file", async () => {
    const appRoot = await fixtureApp({})
    const text = await emitFixture(appRoot)
    expect(text).not.toContain("middlewareModule")
    expect(text).not.toContain("normalizeMiddlewareModule")
  })
})
