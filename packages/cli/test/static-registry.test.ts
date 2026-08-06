import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NormalizedRouteModule } from "@dawn-ai/core"
import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeRegistry } from "../src/lib/dev/runtime-registry.js"
import type { DawnStaticModules, StaticRouteModule } from "../src/lib/runtime/static-modules.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** A minimal, honestly-constructed `NormalizedRouteModule` — no file import. */
function fakeNormalizedModule(): NormalizedRouteModule {
  return {
    config: {},
    entry: async () => ({ ok: true }),
    kind: "workflow",
  }
}

function buildStaticModules(): DawnStaticModules {
  const route: StaticRouteModule = {
    assistantId: "/probe#workflow",
    kind: "workflow",
    memory: null,
    module: fakeNormalizedModule(),
    routeFile: "/nonexistent/approot/src/app/probe/index.ts",
    routeId: "/probe",
    routePath: "src/app/probe/index.ts",
    stateFields: undefined,
    tools: [],
  }
  return { routes: [route] }
}

describe("createRuntimeRegistry — static modules short-circuit", () => {
  it("builds a registry from prebuilt entries with zero filesystem access", async () => {
    const modules = buildStaticModules()
    // A nonexistent appRoot: the dynamic path (discoverRoutes) would throw on
    // this (ENOENT walking the route tree) — success here proves the static
    // path never touches the filesystem.
    const appRoot = "/nonexistent/approot"

    const registry = await createRuntimeRegistry(appRoot, modules)

    expect(registry.appRoot).toBe(appRoot)
    expect(registry.entries).toEqual([
      {
        assistantId: "/probe#workflow",
        mode: "workflow",
        routeFile: "/nonexistent/approot/src/app/probe/index.ts",
        routeId: "/probe",
        routePath: "src/app/probe/index.ts",
      },
    ])
    expect(registry.lookup("/probe#workflow")).toEqual(registry.entries[0])
    expect(registry.lookup("/missing#workflow")).toBeNull()

    // The manifest is synthesized (not absent) so downstream `routeManifest`
    // threading keeps working — same route identity, no re-derivation.
    expect(registry.manifest).toBeDefined()
    expect(registry.manifest?.appRoot).toBe(appRoot)
    expect(registry.manifest?.routes).toEqual([
      {
        entryFile: "/nonexistent/approot/src/app/probe/index.ts",
        id: "/probe",
        kind: "workflow",
        pathname: "/probe",
        routeDir: "/nonexistent/approot/src/app/probe",
        segments: [{ kind: "static", raw: "probe" }],
      },
    ])
  })

  it("keeps multiple static routes independently addressable", async () => {
    const modules: DawnStaticModules = {
      routes: [
        {
          assistantId: "/chat#agent",
          kind: "agent",
          memory: null,
          module: { config: {}, entry: {}, kind: "agent" },
          routeFile: "/nonexistent/approot/src/app/chat/index.ts",
          routeId: "/chat",
          routePath: "src/app/chat/index.ts",
          stateFields: undefined,
          tools: [],
        },
        {
          assistantId: "/probe#workflow",
          kind: "workflow",
          memory: null,
          module: fakeNormalizedModule(),
          routeFile: "/nonexistent/approot/src/app/probe/index.ts",
          routeId: "/probe",
          routePath: "src/app/probe/index.ts",
          stateFields: undefined,
          tools: [],
        },
      ],
    }

    const registry = await createRuntimeRegistry("/nonexistent/approot", modules)

    expect(registry.entries).toHaveLength(2)
    expect(registry.lookup("/chat#agent")?.routeId).toBe("/chat")
    expect(registry.lookup("/probe#workflow")?.routeId).toBe("/probe")
  })
})

describe("createRuntimeRegistry — without modules (existing dynamic behavior)", () => {
  async function fixtureApp(): Promise<string> {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-static-registry-"))
    cleanup.push(() =>
      rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }),
    )
    await writeFixtureFile(appRoot, "dawn.config.ts", "export default {}\n")
    await writeFixtureFile(
      appRoot,
      "package.json",
      '{ "name": "static-registry-fixture", "type": "module" }\n',
    )
    await writeFixtureFile(
      appRoot,
      "src/app/probe/index.ts",
      "export const workflow = async () => ({ ok: true })\n",
    )
    return appRoot
  }

  async function writeFixtureFile(appRoot: string, rel: string, body: string): Promise<void> {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }

  it("discovers routes from disk when no modules are provided", async () => {
    const appRoot = await fixtureApp()

    const registry = await createRuntimeRegistry(appRoot)

    expect(registry.appRoot).toBe(appRoot)
    expect(registry.entries).toEqual([
      {
        assistantId: "/probe#workflow",
        mode: "workflow",
        routeFile: join(appRoot, "src/app/probe/index.ts"),
        routeId: "/probe",
        routePath: "src/app/probe/index.ts",
      },
    ])
    expect(registry.lookup("/probe#workflow")).toEqual(registry.entries[0])
    expect(registry.manifest).toBeDefined()
  })
})
