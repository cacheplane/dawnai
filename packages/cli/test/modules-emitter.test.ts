import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { discoverRoutes } from "@dawn-ai/core"
import { afterEach, describe, expect, it } from "vitest"

import { createAimock, script } from "../../testing/dist/index.js"
import {
  collectRouteStaticDiscovery,
  emitModulesFile,
  type RouteStaticDiscovery,
} from "../src/lib/build/targets/modules-emitter.js"
import { nodeTarget } from "../src/lib/build/targets/node.js"
import { loadStaticModules } from "../src/lib/runtime/static-modules.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// Fixture app: one agent route (/chat) with a shared tool, a route-local tool,
// state.ts + a custom reducer, memory.ts, and a typegen tools.json to inline —
// plus a second bare agent route (/zeta) to prove deterministic ordering and
// the no-optional-fields emission path.
// ---------------------------------------------------------------------------

async function fixtureApp(): Promise<string> {
  // realpath: on macOS the tmpdir is behind a /var → /private/var symlink, and
  // the loader resolves module URLs to their real paths — keep every path in
  // the test on the resolved side so absolute-path assertions line up.
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "dawn-modules-emitter-")))
  cleanup.push(() =>
    rm(appRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    }),
  )
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
    "package.json": '{ "name": "modules-emitter-fixture", "type": "module" }\n',
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
// Golden test: the emitted text has correct relative imports for every module,
// deterministic ordering, inlined schema/state literals, the runtime-helper
// calls, and a default export — snapshot-pinned with stable formatting.
// ---------------------------------------------------------------------------

describe("emitModulesFile — golden", () => {
  it("emits relative imports, inlined literals, and helper calls in deterministic order", async () => {
    const appRoot = await fixtureApp()
    const discoveries = await collectFixtureDiscoveries(appRoot)
    const buildDir = join(appRoot, ".dawn", "build")

    // Feed the discoveries in REVERSED order — the emitter must still order
    // routes by assistantId, proving the sort (not the caller) is what makes
    // the output deterministic.
    const text = emitModulesFile({
      appRoot,
      buildDir,
      discoveries: [...discoveries].reverse(),
    })

    // Runtime helper import — normalization happens at runtime, not codegen.
    expect(text).toContain('import { buildStaticRouteModule } from "@dawn-ai/cli/runtime"')

    // Static imports with correct relative specifiers (from .dawn/build/),
    // kept `.ts` — the tsx loader resolves them directly, and a `.js` rewrite
    // could bind a stale in-place-compiled sibling instead.
    expect(text).toContain('import * as route0 from "../../src/app/chat/index.ts"')
    expect(text).toContain('import * as route0_tool0 from "../../src/tools/echo.ts"')
    expect(text).toContain('import * as route0_tool1 from "../../src/app/chat/tools/local.ts"')
    expect(text).toContain('import route0_reducer0 from "../../src/app/chat/reducers/count.ts"')
    expect(text).toContain('import * as route0_memory from "../../src/app/chat/memory.ts"')
    expect(text).toContain('import * as route1 from "../../src/app/zeta/index.ts"')

    // routeFile is computed from import.meta.url at RUNTIME — never a baked
    // absolute build-machine path.
    expect(text).toContain(
      'const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")',
    )
    expect(text).toContain('routeFile: resolve(appRoot, "src/app/chat/index.ts")')
    expect(text).not.toContain(appRoot)

    // Deterministic ordering: /chat#agent before /zeta#agent despite reversed
    // input.
    expect(text.indexOf('routeId: "/chat"')).toBeGreaterThan(0)
    expect(text.indexOf('routeId: "/chat"')).toBeLessThan(text.indexOf('routeId: "/zeta"'))

    // Inlined tools.json + state literals — emitted as JSON.parse of a string
    // (never bare object literals, whose quoted "__proto__" keys would perform
    // prototype assignment instead of creating an own property).
    expect(text).toContain("stateDefaults: JSON.parse(")
    expect(text).toContain('[\\"count\\",0]')
    expect(text).toContain('[\\"notes\\",[]]')
    expect(text).toContain("toolSchemas: JSON.parse(")
    expect(text).toContain('\\"description\\":\\"Echoes the input back\\"')
    expect(text).toContain('stateReducers: [["count", route0_reducer0]]')

    expect(text).toContain("export default {")

    expect(text).toMatchInlineSnapshot(`
      "// Generated by dawn build (node target). Regenerated on every build — do not edit.
      // Static module manifest: every route/tool/memory/reducer module below is a
      // static import, so the whole app module graph is known without filesystem
      // discovery at boot. Loaded by server.mjs via loadStaticModules().
      import { dirname, resolve } from "node:path"
      import { fileURLToPath } from "node:url"

      import { buildStaticRouteModule } from "@dawn-ai/cli/runtime"

      import * as route0 from "../../src/app/chat/index.ts"
      import * as route0_tool0 from "../../src/tools/echo.ts"
      import * as route0_tool1 from "../../src/app/chat/tools/local.ts"
      import route0_reducer0 from "../../src/app/chat/reducers/count.ts"
      import * as route0_memory from "../../src/app/chat/memory.ts"
      import * as route1 from "../../src/app/zeta/index.ts"
      import * as route1_tool0 from "../../src/tools/echo.ts"

      // modules.mjs lives at <appRoot>/.dawn/build/modules.mjs → appRoot is two dirs
      // up. Absolute paths are computed here at RUNTIME so a manifest built at one
      // path stays correct when the app runs at another (e.g. inside a container).
      const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

      export default {
        routes: [
          buildStaticRouteModule({
            kind: "agent",
            memoryModule: route0_memory,
            routeFile: resolve(appRoot, "src/app/chat/index.ts"),
            routeId: "/chat",
            routeModule: route0,
            routePath: "src/app/chat/index.ts",
            stateDefaults: JSON.parse("[[\\"count\\",0],[\\"notes\\",[]]]"),
            stateReducers: [["count", route0_reducer0]],
            toolSchemas: JSON.parse("{\\"echo\\":{\\"description\\":\\"Echoes the input back\\",\\"parameters\\":{\\"properties\\":{\\"text\\":{\\"type\\":\\"string\\"}},\\"required\\":[\\"text\\"],\\"type\\":\\"object\\"}}}"),
            tools: [
              { filePath: resolve(appRoot, "src/tools/echo.ts"), module: route0_tool0, name: "echo", scope: "shared" },
              { filePath: resolve(appRoot, "src/app/chat/tools/local.ts"), module: route0_tool1, name: "local", scope: "route-local" },
            ],
          }),
          buildStaticRouteModule({
            kind: "agent",
            routeFile: resolve(appRoot, "src/app/zeta/index.ts"),
            routeId: "/zeta",
            routeModule: route1,
            routePath: "src/app/zeta/index.ts",
            tools: [
              { filePath: resolve(appRoot, "src/tools/echo.ts"), module: route1_tool0, name: "echo", scope: "shared" },
            ],
          }),
        ],
      }
      "
    `)
  })
})

// ---------------------------------------------------------------------------
// Hostile inputs: values that must not corrupt the generated file — a quote
// in a path component (POSIX-legal) must stay inside its string literal, and
// a state default that JSON serialization would mutate must fail the BUILD
// (loudly, naming the route and field) instead of forking prod from dev.
// ---------------------------------------------------------------------------

describe("emitModulesFile — hostile inputs", () => {
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
    const text = emitModulesFile({
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
    // The specifier's quote arrives escaped inside the generated string
    // literal — never as a raw `"` that would terminate it early.
    expect(text).toContain(String.raw`import * as route0 from "../../src/app/we\"ird/index.ts"`)
    expect(text).toContain(
      String.raw`import * as route0_tool0 from "../../src/tools/back\\slash.ts"`,
    )
    expect(text).not.toContain('from "../../src/app/we"ird/index.ts"')
  })

  it("fails the build when a state default would not survive JSON inlining", () => {
    expect(() =>
      emitModulesFile({
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

  it("accepts plain JSON defaults including shared (non-circular) references", () => {
    const shared = { tag: "ok" }
    const text = emitModulesFile({
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
// Functional round-trip: write the emitted file into the fixture's
// .dawn/build/, load it through the same loadStaticModules path server.mjs
// uses, assert the default export is a valid DawnStaticModules, then boot the
// runtime fetch handler from it and run a real aimock turn. Catches
// emit-vs-runtime drift the golden test can't.
// ---------------------------------------------------------------------------

/** Point OPENAI_BASE_URL/OPENAI_API_KEY at a local aimock instance for the
 * duration of the test, restoring the previous env afterward. */
async function withAimock(fixtures: ReturnType<ReturnType<typeof script>["build"]>): Promise<void> {
  const aimock = await createAimock({ fixtures: [] })
  cleanup.push(() => aimock.close())
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  cleanup.push(() => {
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  })
  aimock.addFixtures(fixtures)
}

describe("emitModulesFile — functional round-trip", () => {
  it("emitted manifest loads as a DawnStaticModules and serves a turn", async () => {
    const appRoot = await fixtureApp()

    // The emitted manifest imports "@dawn-ai/cli/runtime" — make it resolvable
    // from the tmpdir fixture by linking the real package (its built dist),
    // the same way lazy-memory-store.test.ts links zod.
    await mkdir(join(appRoot, "node_modules", "@dawn-ai"), { recursive: true })
    await symlink(
      join(repoRoot, "packages", "cli"),
      join(appRoot, "node_modules", "@dawn-ai", "cli"),
      "dir",
    )

    const discoveries = await collectFixtureDiscoveries(appRoot)
    const buildDir = join(appRoot, ".dawn", "build")
    await mkdir(buildDir, { recursive: true })
    const modulesPath = join(buildDir, "modules.mjs")
    await writeFile(modulesPath, emitModulesFile({ appRoot, buildDir, discoveries }), "utf8")

    const modules = await loadStaticModules(pathToFileURL(modulesPath))

    // Shape: a valid DawnStaticModules satisfying the T2 seeding contract.
    expect(modules.routes.map((route) => route.assistantId)).toEqual(["/chat#agent", "/zeta#agent"])
    const chat = modules.routes[0]
    if (!chat) throw new Error("expected the /chat route")

    // routeFile/tool paths are ABSOLUTE at runtime (resolved from
    // import.meta.url, matching where the manifest actually sits).
    expect(chat.routeFile).toBe(join(appRoot, "src/app/chat/index.ts"))
    expect(chat.routePath).toBe("src/app/chat/index.ts")
    expect(chat.kind).toBe("agent")
    expect(chat.module.kind).toBe("agent")

    // Tools in discovery order, with the inlined tools.json schema injected
    // onto the schema-less shared tool.
    expect(chat.tools.map((tool) => tool.name)).toEqual(["echo", "local"])
    expect(chat.tools[0]?.filePath).toBe(join(appRoot, "src/tools/echo.ts"))
    expect(chat.tools[0]?.schema).toEqual({
      properties: { text: { type: "string" } },
      required: ["text"],
      type: "object",
    })
    expect(typeof chat.tools[0]?.run).toBe("function")

    // State fields resolved by the REAL resolveStateFields at runtime: custom
    // reducer bound live, array default inferred as "append", sorted by name.
    expect(chat.stateFields?.map((field) => field.name)).toEqual(["count", "notes"])
    expect(typeof chat.stateFields?.[0]?.reducer).toBe("function")
    expect(chat.stateFields?.[0]?.default).toBe(0)
    expect(chat.stateFields?.[1]?.reducer).toBe("append")

    // Memory descriptor validated by the same rules loadRouteMemory applies.
    expect(chat.memory?.kind).toBe("semantic")

    // The bare route has no optional payloads.
    expect(modules.routes[1]?.stateFields).toBeUndefined()
    expect(modules.routes[1]?.memory).toBeNull()

    // Boot the runtime from the manifest and complete a real turn (T2's
    // pattern) — the emitted file's payloads must satisfy prepareRouteExecution.
    await withAimock(
      script()
        .user("echo hello")
        .callsTool("echo", { text: "hello" })
        .replies("Hi there, friend!")
        .build(),
    )

    const { createRuntimeFetchHandler } = await import("../src/lib/dev/runtime-fetch-handler.js")
    const handler = await createRuntimeFetchHandler({ appRoot, modules })
    cleanup.push(() => handler.close())

    const routeKey = encodeURIComponent("/chat#agent")
    const response = await handler.fetch(
      new Request(`http://localhost/agui/${routeKey}`, {
        body: JSON.stringify({
          context: [],
          forwardedProps: {},
          messages: [{ id: "1", role: "user", content: "echo hello" }],
          runId: "rn-roundtrip",
          state: {},
          threadId: "th-roundtrip",
          tools: [],
        }),
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    )
    expect(response.status).toBe(200)
    const reader = response.body?.getReader()
    if (!reader) throw new Error("expected a streaming response body")
    const chunks: string[] = []
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(new TextDecoder().decode(next.value))
    }
    const body = chunks.join("")
    expect(body).toContain("RUN_STARTED")
    expect(body).toContain("echo: hello")
    expect(body).toContain("Hi there, friend!")
    expect(body).toContain("RUN_FINISHED")
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Node target wiring: emit() writes modules.mjs, lists it in artifacts, and
// server.mjs boots from it via loadStaticModules.
// ---------------------------------------------------------------------------

describe("node target — modules.mjs artifact", () => {
  it("emits modules.mjs alongside server.mjs and wires server.mjs to boot from it", async () => {
    const appRoot = await fixtureApp()
    const manifest = await discoverRoutes({ appRoot })
    const buildDir = join(appRoot, ".dawn", "build")
    await mkdir(buildDir, { recursive: true })

    const { artifacts } = await nodeTarget.emit({
      appRoot,
      buildDir,
      manifest,
    })

    const modulesPath = join(buildDir, "modules.mjs")
    expect(artifacts).toContain(modulesPath)
    const modulesText = await readFile(modulesPath, "utf8")
    expect(modulesText).toContain("buildStaticRouteModule")
    expect(modulesText).toContain('routeId: "/chat"')

    const server = await readFile(join(buildDir, "server.mjs"), "utf8")
    expect(server).toContain("loadStaticModules")
    expect(server).toContain("./modules.mjs")
    expect(server).toContain("serveRuntime({ appRoot, modules })")
  })
})
