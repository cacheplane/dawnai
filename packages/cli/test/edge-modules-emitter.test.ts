import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { discoverRoutes } from "@dawn-ai/core/node"
import { pureDirname } from "@dawn-ai/sdk/pure"
import { transform } from "esbuild"
import { afterEach, describe, expect, it } from "vitest"

import {
  edgeAppNamespace,
  emitEdgeModulesFile,
} from "../src/lib/build/targets/edge-modules-emitter.js"
import {
  collectRouteStaticDiscovery,
  type RouteStaticDiscovery,
} from "../src/lib/build/targets/modules-emitter.js"
import { loadStaticModules } from "../src/lib/runtime/static-modules.js"
import { ensureLinkedDistsFresh } from "./helpers/hono-edge-fixture.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// Fixture app: deliberately the SAME shape as modules-emitter.test.ts's — one
// agent route (/chat) with a shared tool, a route-local tool, state.ts + a
// custom reducer, memory.ts and a typegen tools.json, plus a bare /zeta route.
// Emitting the same input through both emitters is what makes the two goldens
// comparable line-for-line, so a divergence beyond the three intended ones is
// visible in review.
//
// The app directory has a FIXED name inside the temp dir: the edge manifest
// bakes `basename(appRoot)` in as its namespace id, and a random mkdtemp suffix
// would make the inline snapshot unstable.
// ---------------------------------------------------------------------------

const APP_DIR_NAME = "edge-emitter-fixture-app"

async function fixtureApp(): Promise<string> {
  // realpath: on macOS the tmpdir is behind a /var → /private/var symlink.
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "dawn-edge-modules-emitter-")))
  cleanup.push(() =>
    rm(tempRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    }),
  )
  const appRoot = join(tempRoot, APP_DIR_NAME)
  const files: Record<string, string> = {
    ".dawn/routes/chat/tools.json": `${JSON.stringify(
      {
        echo: {
          description: "Echoes the input back",
          parameters: {
            properties: { text: { type: "string" } },
            required: ["text"],
            type: "object",
          },
        },
      },
      null,
      2,
    )}\n`,
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "edge-modules-emitter-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      'export default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n',
    "src/app/chat/memory.ts":
      "export default {\n" +
      '  kind: "semantic",\n' +
      '  scope: ["route"],\n' +
      "  schema: { parse: (value: unknown) => value },\n" +
      "}\n",
    "src/app/chat/reducers/count.ts":
      "export default (current: unknown, incoming: unknown) =>\n" +
      '  (typeof current === "number" ? current : 0) + (typeof incoming === "number" ? incoming : 0)\n',
    "src/app/chat/state.ts":
      "export default {\n" +
      "  parse: (input: unknown) => ({ count: 0, notes: [] as string[], ...((input as object) ?? {}) }),\n" +
      "}\n",
    "src/app/chat/tools/local.ts":
      'export const description = "A route-local helper"\n' +
      'export default async (input: { note: string }) => "noted: " + input.note\n',
    "src/app/zeta/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      'export default agent({ model: "gpt-5-mini", systemPrompt: "Zeta." })\n',
    "src/middleware.ts": "export default async (_ctx: unknown, next: () => unknown) => next()\n",
    "src/tools/echo.ts":
      'export const description = "Echoes the input back"\n' +
      'export default async (input: { text: string }) => "echo: " + input.text\n',
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

// ---------------------------------------------------------------------------
// Golden: the same manifest the node emitter produces, minus every node-ism —
// no node: imports, no build-machine paths, and the runtime helpers pulled from
// the node-free `@dawn-ai/cli/fetch` entry.
// ---------------------------------------------------------------------------

describe("emitEdgeModulesFile — golden", () => {
  it("emits relative imports, inlined literals, and helper calls in deterministic order", async () => {
    const appRoot = await fixtureApp()
    const discoveries = await collectFixtureDiscoveries(appRoot)
    const buildDir = join(appRoot, ".dawn", "build")

    // Reversed input: the emitter's assistantId sort (not the caller) is what
    // makes the output deterministic.
    const text = emitEdgeModulesFile({
      appRoot,
      buildDir,
      discoveries: [...discoveries].reverse(),
    })

    // --- the three edge-specific differences -------------------------------
    // An edge runtime has neither module, so importing them is a boot crash.
    expect(text).not.toContain("node:path")
    expect(text).not.toContain("node:url")
    expect(text).not.toContain("node:")
    // No build-machine path may survive into a deployed bundle: appRoot is an
    // opaque namespace id (thread/cache keys), never something resolved onto a
    // filesystem that does not exist there.
    expect(text).not.toContain(appRoot)
    // Rooted at "/": nothing resolves it on disk, but a RELATIVE base makes
    // Dawn's pure path helpers throw — `pureResolve` has no cwd to fall back on,
    // and built-in capabilities resolve against the handler's appRoot (see
    // core's agents-md.ts). A regression back to a bare basename would only
    // surface at runtime, on an edge deploy.
    expect(text).toContain(`const appRoot = "/${APP_DIR_NAME}"`)
    expect(text).toMatch(/^const appRoot = "\//m)
    // The node-free entry, not @dawn-ai/cli/runtime (which reaches tsx/sqlite).
    expect(text).toContain('from "@dawn-ai/cli/fetch"')
    expect(text).not.toContain("@dawn-ai/cli/runtime")
    // No runtime path math survives either — `resolve`/`fileURLToPath` would be
    // free variables in the emitted module.
    expect(text).not.toContain("fileURLToPath")
    expect(text).not.toContain("resolve(appRoot")

    // --- everything else is the node emitter's output, unchanged ------------
    expect(text).toContain('import { buildStaticRouteModule } from "@dawn-ai/cli/fetch"')
    expect(text).toContain('import * as route0 from "../../src/app/chat/index.ts"')
    expect(text).toContain('import * as route0_tool0 from "../../src/tools/echo.ts"')
    expect(text).toContain('import * as route0_tool1 from "../../src/app/chat/tools/local.ts"')
    expect(text).toContain('import route0_reducer0 from "../../src/app/chat/reducers/count.ts"')
    expect(text).toContain('import * as route0_memory from "../../src/app/chat/memory.ts"')
    expect(text).toContain('import * as route1 from "../../src/app/zeta/index.ts"')

    // Deterministic ordering despite reversed input.
    expect(text.indexOf('routeId: "/chat"')).toBeGreaterThan(0)
    expect(text.indexOf('routeId: "/chat"')).toBeLessThan(text.indexOf('routeId: "/zeta"'))

    // Inlined literals keep the JSON.parse-of-a-string encoding: in a bare JS
    // object literal a quoted "__proto__" key performs prototype assignment.
    expect(text).toContain("stateDefaults: JSON.parse(")
    expect(text).toContain('[\\"count\\",0]')
    expect(text).toContain('[\\"notes\\",[]]')
    expect(text).toContain("toolSchemas: JSON.parse(")
    expect(text).toContain('\\"description\\":\\"Echoes the input back\\"')
    expect(text).toContain('stateReducers: [["count", route0_reducer0]]')
    expect(text).toContain("export default {")

    // The emitted text must be a parseable ES module — a golden built from
    // string concatenation can otherwise drift into something that only looks
    // right.
    await expect(transform(text, { format: "esm", loader: "js" })).resolves.toBeTruthy()

    expect(text).toMatchInlineSnapshot(`
      "// Generated by dawn build (hono target). Regenerated on every build — do not edit.
      // Static module manifest for an edge bundle: every route/tool/memory/reducer
      // module below is a static import, so the whole app module graph is known
      // without filesystem discovery. Loaded by app.mjs as a plain ES module.

      import { buildStaticRouteModule } from "@dawn-ai/cli/fetch"

      import * as route0 from "../../src/app/chat/index.ts"
      import * as route0_tool0 from "../../src/tools/echo.ts"
      import * as route0_tool1 from "../../src/app/chat/tools/local.ts"
      import route0_reducer0 from "../../src/app/chat/reducers/count.ts"
      import * as route0_memory from "../../src/app/chat/memory.ts"
      import * as route1 from "../../src/app/zeta/index.ts"
      import * as route1_tool0 from "../../src/tools/echo.ts"

      // There is no filesystem and no import.meta.url path math on an edge runtime,
      // so appRoot is a build-time literal: the app directory's name, used purely as
      // an opaque namespace id (thread keys, cache keys). Never a build-machine path
      // — a deployed bundle must not depend on where it was built. It is rooted at
      // "/" because nothing resolves it on disk but Dawn's pure path helpers reject a
      // relative base (pureResolve throws rather than rooting at a cwd that an edge
      // runtime does not have).
      const appRoot = "/edge-emitter-fixture-app"

      export default {
        routes: [
          buildStaticRouteModule({
            kind: "agent",
            memoryModule: route0_memory,
            routeFile: appRoot + "/src/app/chat/index.ts",
            routeId: "/chat",
            routeModule: route0,
            routePath: "src/app/chat/index.ts",
            stateDefaults: JSON.parse("[[\\"count\\",0],[\\"notes\\",[]]]"),
            stateReducers: [["count", route0_reducer0]],
            toolSchemas: JSON.parse("{\\"echo\\":{\\"description\\":\\"Echoes the input back\\",\\"parameters\\":{\\"properties\\":{\\"text\\":{\\"type\\":\\"string\\"}},\\"required\\":[\\"text\\"],\\"type\\":\\"object\\"}}}"),
            tools: [
              { filePath: appRoot + "/src/tools/echo.ts", module: route0_tool0, name: "echo", scope: "shared" },
              { filePath: appRoot + "/src/app/chat/tools/local.ts", module: route0_tool1, name: "local", scope: "route-local" },
            ],
          }),
          buildStaticRouteModule({
            kind: "agent",
            routeFile: appRoot + "/src/app/zeta/index.ts",
            routeId: "/zeta",
            routeModule: route1,
            routePath: "src/app/zeta/index.ts",
            tools: [
              { filePath: appRoot + "/src/tools/echo.ts", module: route1_tool0, name: "echo", scope: "shared" },
            ],
          }),
        ],
      }
      "
    `)
  })

  it("imports normalizeMiddlewareModule from the fetch entry too", async () => {
    const appRoot = await fixtureApp()
    const discoveries = await collectFixtureDiscoveries(appRoot)
    const text = emitEdgeModulesFile({
      appRoot,
      buildDir: join(appRoot, ".dawn", "build"),
      discoveries,
      middlewareFile: join(appRoot, "src", "middleware.ts"),
    })

    expect(text).toContain(
      'import { buildStaticRouteModule, normalizeMiddlewareModule } from "@dawn-ai/cli/fetch"',
    )
    expect(text).toContain('import * as middlewareModule from "../../src/middleware.ts"')
    expect(text).toContain("  middleware: normalizeMiddlewareModule(middlewareModule),")
    // Middleware is bound before routes, matching the node manifest.
    expect(text.indexOf("middleware: normalizeMiddlewareModule")).toBeLessThan(
      text.indexOf("routes: ["),
    )
    expect(text).not.toContain("node:")
    expect(text).not.toContain(appRoot)
  })

  it("imports normalizeThreadAccessModule from the fetch entry too", async () => {
    const appRoot = await fixtureApp()
    const discoveries = await collectFixtureDiscoveries(appRoot)
    const text = emitEdgeModulesFile({
      appRoot,
      buildDir: join(appRoot, ".dawn", "build"),
      discoveries,
      middlewareFile: join(appRoot, "src", "middleware.ts"),
      threadAccessFile: join(appRoot, "src", "thread-access.ts"),
    })

    // One import line, composed from a list — the edge manifest links against
    // `@dawn-ai/cli/fetch`, so the fetch barrel must export this too or the
    // deployed bundle fails at link time rather than at boot.
    expect(text).toContain(
      'import { buildStaticRouteModule, normalizeMiddlewareModule, normalizeThreadAccessModule } from "@dawn-ai/cli/fetch"',
    )
    expect(text).toContain('import * as threadAccessModule from "../../src/thread-access.ts"')
    expect(text).toContain("  threadAccess: normalizeThreadAccessModule(threadAccessModule),")
    // middleware → threadAccess → routes, matching the node manifest.
    expect(text.indexOf("middleware: normalizeMiddlewareModule")).toBeLessThan(
      text.indexOf("threadAccess: normalizeThreadAccessModule"),
    )
    expect(text.indexOf("threadAccess: normalizeThreadAccessModule")).toBeLessThan(
      text.indexOf("routes: ["),
    )
    expect(text).not.toContain("node:")
    expect(text).not.toContain(appRoot)
  })
})

// ---------------------------------------------------------------------------
// Hostile inputs: the node emitter's hardening (modules-emitter.test.ts:228-300)
// re-run against the edge emitter. Shared code is the INTENT, but only an
// executed assertion proves the edge path actually inherits it — a divergent
// copy is exactly how this hardening would silently stop applying.
// ---------------------------------------------------------------------------

describe("emitEdgeModulesFile — hostile inputs", () => {
  const bareDiscovery = (overrides: Partial<RouteStaticDiscovery>): RouteStaticDiscovery => ({
    entryFile: "/app/src/app/plain/index.ts",
    kind: "agent",
    memoryFile: undefined,
    reducers: undefined,
    routeId: "/plain",
    stateDefaults: undefined,
    toolSchemas: undefined,
    tools: [],
    ...overrides,
  })

  it("JSON-escapes quotes and backslashes in import specifiers", () => {
    const text = emitEdgeModulesFile({
      appRoot: "/app",
      buildDir: "/app/.dawn/build",
      discoveries: [
        bareDiscovery({
          entryFile: '/app/src/app/we"ird/index.ts',
          routeId: "/weird",
          tools: [
            {
              filePath: "/app/src/tools/back\\slash.ts",
              name: "back\\slash",
              scope: "shared",
            },
          ],
        }),
      ],
    })
    expect(text).toContain(String.raw`import * as route0 from "../../src/app/we\"ird/index.ts"`)
    expect(text).toContain(
      String.raw`import * as route0_tool0 from "../../src/tools/back\\slash.ts"`,
    )
    expect(text).not.toContain('from "../../src/app/we"ird/index.ts"')
  })

  it("JSON-escapes a hostile appRoot basename in the namespace literal", () => {
    // The appRoot literal is interpolated like every other value: a directory
    // named with a quote must not be able to terminate the string early.
    const text = emitEdgeModulesFile({
      appRoot: '/tmp/we"ird-app',
      buildDir: '/tmp/we"ird-app/.dawn/build',
      discoveries: [bareDiscovery({ entryFile: '/tmp/we"ird-app/src/app/plain/index.ts' })],
    })
    expect(text).toContain(String.raw`const appRoot = "/we\"ird-app"`)
    expect(text).not.toContain('const appRoot = "/we"ird-app"')
  })

  it("falls back to a rooted namespace when the app root has no basename", () => {
    // Degenerate app root (the filesystem root): the namespace must still be a
    // rooted, non-empty id rather than a bare "/".
    const text = emitEdgeModulesFile({
      appRoot: "/",
      buildDir: "/.dawn/build",
      discoveries: [bareDiscovery({ entryFile: "/src/app/plain/index.ts" })],
    })
    expect(text).toContain('const appRoot = "/app"')
  })

  it("fails the build when a state default would not survive JSON inlining", () => {
    expect(() =>
      emitEdgeModulesFile({
        appRoot: "/app",
        buildDir: "/app/.dawn/build",
        discoveries: [
          bareDiscovery({
            routeId: "/dated",
            stateDefaults: [["startedAt", { nested: new Date(0) }]],
          }),
        ],
      }),
    ).toThrow(/Route "\/dated" state field "startedAt".*at startedAt\.nested/s)
  })

  it("fails the build on a circular state default, naming the cycle", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() =>
      emitEdgeModulesFile({
        appRoot: "/app",
        buildDir: "/app/.dawn/build",
        discoveries: [bareDiscovery({ routeId: "/looped", stateDefaults: [["loop", cycle]] })],
      }),
    ).toThrow(/circular reference/)
  })

  it("accepts plain JSON defaults including shared (non-circular) references", () => {
    const shared = { tag: "ok" }
    const text = emitEdgeModulesFile({
      appRoot: "/app",
      buildDir: "/app/.dawn/build",
      discoveries: [
        bareDiscovery({
          routeId: "/shared",
          stateDefaults: [
            ["a", shared],
            ["b", { left: shared, right: shared }],
          ],
        }),
      ],
    })
    expect(text).toContain("stateDefaults: JSON.parse(")
  })
})

// ---------------------------------------------------------------------------
// Marker files: the bodies an edge runtime cannot read from disk at request
// time. Its own fixture (a superset of `fixtureApp`'s files) so the golden
// snapshot above keeps emitting exactly the bytes it pins.
// ---------------------------------------------------------------------------

async function markerFixtureApp(): Promise<string> {
  const appRoot = await fixtureApp()
  const extra: Record<string, string> = {
    "src/app/chat/memory.md": "Prefer short answers.\n",
    "src/app/chat/plan.md": "- [ ] Restate the question\n",
    "src/app/chat/skills/cite-sources/SKILL.md": "---\ndescription: Cite.\n---\n\nCite [path].\n",
  }
  for (const [rel, body] of Object.entries(extra)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

async function collectMarkerDiscoveries(appRoot: string): Promise<RouteStaticDiscovery[]> {
  const manifest = await discoverRoutes({ appRoot })
  const discoveries: RouteStaticDiscovery[] = []
  for (const route of manifest.routes) {
    discoveries.push(await collectRouteStaticDiscovery({ appRoot, markerFiles: true, route }))
  }
  return discoveries
}

describe("emitEdgeModulesFile — marker files", () => {
  it("omits markerFiles entirely when discovery was not asked to collect them", async () => {
    const appRoot = await markerFixtureApp()
    const discoveries = await collectFixtureDiscoveries(appRoot)
    const text = emitEdgeModulesFile({
      appRoot,
      buildDir: join(appRoot, ".dawn", "build"),
      discoveries,
    })
    expect(text).not.toContain("markerFiles")
    // The names are still recorded, which is what the request-time guard reads.
    expect(text).toContain('skills: ["cite-sources"]')
  })

  it("inlines skills, plan.md and memory.md keyed by namespace path, on the routes that have them", async () => {
    const appRoot = await markerFixtureApp()
    const discoveries = await collectMarkerDiscoveries(appRoot)
    const buildDir = join(appRoot, ".dawn", "build")

    const text = emitEdgeModulesFile({ appRoot, buildDir, discoveries })

    expect(text).toContain("markerFiles: Object.fromEntries([")
    expect(text).toContain(`[appRoot + "/src/app/chat/memory.md", "Prefer short answers.\\n"]`)
    expect(text).toContain(`[appRoot + "/src/app/chat/plan.md", "- [ ] Restate the question\\n"]`)
    expect(text).toContain(
      `[appRoot + "/src/app/chat/skills/cite-sources/SKILL.md", "---\\ndescription: Cite.\\n---\\n\\nCite [path].\\n"]`,
    )
    // Only the one route that has marker files carries the key.
    expect(text.match(/markerFiles:/g)).toHaveLength(1)
    // Still a build-machine-path-free, node-free manifest.
    expect(text).not.toContain(appRoot)
    expect(text).not.toContain("node:")
  })

  it("survives the round trip through loadStaticModules with the runtime's routeDir keys", async () => {
    await ensureLinkedDistsFresh()
    const appRoot = await markerFixtureApp()
    const discoveries = await collectMarkerDiscoveries(appRoot)
    const buildDir = join(appRoot, ".dawn", "build")
    await mkdir(buildDir, { recursive: true })
    await mkdir(join(appRoot, "node_modules", "@dawn-ai"), { recursive: true })
    await symlink(
      join(repoRoot, "packages", "cli"),
      join(appRoot, "node_modules", "@dawn-ai", "cli"),
      "dir",
    )
    const modulesPath = join(buildDir, "modules.edge.mjs")
    await writeFile(modulesPath, emitEdgeModulesFile({ appRoot, buildDir, discoveries }), "utf8")

    const modules = await loadStaticModules(pathToFileURL(modulesPath))
    const chat = modules.routes.find((route) => route.routeId === "/chat")
    const zeta = modules.routes.find((route) => route.routeId === "/zeta")
    const ns = edgeAppNamespace(appRoot)
    expect(chat?.markerFiles).toEqual({
      [`${ns}/src/app/chat/memory.md`]: "Prefer short answers.\n",
      [`${ns}/src/app/chat/plan.md`]: "- [ ] Restate the question\n",
      [`${ns}/src/app/chat/skills/cite-sources/SKILL.md`]:
        "---\ndescription: Cite.\n---\n\nCite [path].\n",
    })
    expect(chat?.skills).toEqual(["cite-sources"])
    expect(zeta?.markerFiles).toBeUndefined()
  }, 30_000)

  it("keys every markerFiles entry under the route's own routeFile directory", async () => {
    await ensureLinkedDistsFresh()
    const appRoot = await markerFixtureApp()
    const discoveries = await collectMarkerDiscoveries(appRoot)
    const buildDir = join(appRoot, ".dawn", "build")
    await mkdir(buildDir, { recursive: true })
    await mkdir(join(appRoot, "node_modules", "@dawn-ai"), { recursive: true })
    await symlink(
      join(repoRoot, "packages", "cli"),
      join(appRoot, "node_modules", "@dawn-ai", "cli"),
      "dir",
    )
    const modulesPath = join(buildDir, "modules.edge.mjs")
    await writeFile(modulesPath, emitEdgeModulesFile({ appRoot, buildDir, discoveries }), "utf8")

    const modules = await loadStaticModules(pathToFileURL(modulesPath))
    const chat = modules.routes.find((route) => route.routeId === "/chat")
    if (!chat?.markerFiles || !chat.routeFile) {
      throw new Error("expected the /chat route to carry markerFiles and a routeFile")
    }

    // Assert the invariant from the manifest's own data — the directory each
    // key must be rooted at is derived from `routeFile` the same way the
    // runtime derives it, not from a hand-written string.
    const expectedDir = pureDirname(chat.routeFile)
    const keys = Object.keys(chat.markerFiles)
    for (const key of keys) {
      expect(key.startsWith(`${expectedDir}/`)).toBe(true)
    }
    expect(new Set(keys)).toEqual(
      new Set([
        `${expectedDir}/memory.md`,
        `${expectedDir}/plan.md`,
        `${expectedDir}/skills/cite-sources/SKILL.md`,
      ]),
    )
  }, 30_000)
})
