import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agent } from "@dawn-ai/sdk"
import { afterEach, describe, expect, it } from "vitest"

import { script } from "../../testing/dist/index.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import {
  __resetDescriptorRouteMapCacheForTests,
  buildDescriptorMapsFromStaticModules,
  getCachedStaticDescriptorMaps,
} from "../src/lib/runtime/execute-route.js"
import type { DawnStaticModules, StaticRouteModule } from "../src/lib/runtime/static-modules.js"
import {
  buildStaticModulesForFixture,
  cleanup,
  runChatTurn,
  withAimock,
} from "./helpers/static-modules-fixture.js"

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// Unit: buildDescriptorMapsFromStaticModules — both maps derived from the
// manifest with zero imports, agent routes only, memoized per manifest object.
// ---------------------------------------------------------------------------

function staticRoute(overrides: {
  readonly routeId: string
  readonly entry: unknown
  readonly kind: StaticRouteModule["kind"]
}): StaticRouteModule {
  return {
    assistantId: `${overrides.routeId}#${overrides.kind}`,
    kind: overrides.kind,
    memory: null,
    module: { config: {}, entry: overrides.entry, kind: overrides.kind },
    routeFile: `/app/src/app${overrides.routeId}/index.ts`,
    routeId: overrides.routeId,
    routePath: `src/app${overrides.routeId}/index.ts`,
    stateFields: undefined,
    tools: [],
  }
}

describe("buildDescriptorMapsFromStaticModules", () => {
  it("builds descriptor→routeId and routeId→descriptor maps for agent routes only", () => {
    __resetDescriptorRouteMapCacheForTests()
    const agentA = agent({ model: "gpt-5-mini", systemPrompt: "Agent A." })
    const agentB = agent({ model: "gpt-5-mini", systemPrompt: "Agent B." })
    const workflowEntry = async () => "done"
    const modules: DawnStaticModules = {
      routes: [
        staticRoute({ entry: agentA, kind: "agent", routeId: "/a" }),
        staticRoute({ entry: agentB, kind: "agent", routeId: "/a/subagents/b" }),
        staticRoute({ entry: workflowEntry, kind: "workflow", routeId: "/w" }),
      ],
    }

    const maps = buildDescriptorMapsFromStaticModules(modules)

    expect(maps.descriptorRouteMap.get(agentA)).toBe("/a")
    expect(maps.descriptorRouteMap.get(agentB)).toBe("/a/subagents/b")
    expect(maps.descriptorRouteIndex.get(agentA)).toEqual(["/a"])
    expect(maps.descriptorRouteIndex.get(agentB)).toEqual(["/a/subagents/b"])
    expect(maps.routeDescriptors.get("/a")).toBe(agentA)
    expect(maps.routeDescriptors.get("/a/subagents/b")).toBe(agentB)
    // Non-agent routes are excluded from both maps.
    expect(maps.descriptorRouteMap.size).toBe(2)
    expect(maps.routeDescriptors.size).toBe(2)
    expect(maps.routeDescriptors.has("/w")).toBe(false)
  })

  it("preserves every route id when one descriptor is mounted more than once", () => {
    const shared = agent({ model: "gpt-5-mini", systemPrompt: "Shared agent." })
    const maps = buildDescriptorMapsFromStaticModules({
      routes: [
        staticRoute({ entry: shared, kind: "agent", routeId: "/alpha" }),
        staticRoute({ entry: shared, kind: "agent", routeId: "/beta" }),
      ],
    })

    expect(maps.descriptorRouteIndex.get(shared)).toEqual(["/alpha", "/beta"])
  })

  it("memoizes per manifest object identity, reset by __resetDescriptorRouteMapCacheForTests", () => {
    __resetDescriptorRouteMapCacheForTests()
    const modules: DawnStaticModules = {
      routes: [
        staticRoute({
          entry: agent({ model: "gpt-5-mini", systemPrompt: "Agent A." }),
          kind: "agent",
          routeId: "/a",
        }),
      ],
    }

    const first = getCachedStaticDescriptorMaps(modules)
    expect(getCachedStaticDescriptorMaps(modules)).toBe(first)

    // A different manifest object gets its own maps.
    const other: DawnStaticModules = { routes: [...modules.routes] }
    expect(getCachedStaticDescriptorMaps(other)).not.toBe(first)

    __resetDescriptorRouteMapCacheForTests()
    expect(getCachedStaticDescriptorMaps(modules)).not.toBe(first)
  })
})

// ---------------------------------------------------------------------------
// Integration: pruned-source proof for subagent dispatch. The static manifest
// is built from an intact fixture, then every route file path is relocated to
// a pruned root where NO route sources exist (and were never imported — the
// module cache cannot mask a disk read). A turn that dispatches the
// descriptor-override subagent must succeed purely from the manifest: before
// this change the descriptor-route map dynamic-imported every entry file
// (ENOENT → empty map → helper unresolvable → no task tool), failing the run.
// ---------------------------------------------------------------------------

const HELPER_DESCRIPTION = "Echoes text back verbatim."

async function subagentFixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-static-descriptor-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "static-descriptor-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      'import helper from "../helper/index.js"\n' +
      "export default agent({\n" +
      '  model: "gpt-5-mini",\n' +
      '  systemPrompt: "You coordinate work by dispatching subagents.",\n' +
      "  subagents: { helper },\n" +
      "})\n",
    "src/app/helper/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      "export default agent({\n" +
      `  description: "${HELPER_DESCRIPTION}",\n` +
      '  model: "gpt-5-mini",\n' +
      '  systemPrompt: "You echo whatever the user says.",\n' +
      "})\n",
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

/** Rewrite every routeFile path from `fromRoot` to `toRoot` — the deploy-
 * elsewhere shape: modules built on one machine, served from another where
 * the sources do not exist (and were never imported into the module cache). */
function relocateModules(
  modules: DawnStaticModules,
  fromRoot: string,
  toRoot: string,
): DawnStaticModules {
  return {
    routes: modules.routes.map((route) => ({
      ...route,
      routeFile: toRoot + route.routeFile.slice(fromRoot.length),
    })),
  }
}

describe("subagent dispatch from static modules (pruned-source proof)", () => {
  it("dispatches an override subagent with all route sources deleted", async () => {
    const intactRoot = await subagentFixtureApp()
    const intactModules = await buildStaticModulesForFixture(intactRoot)

    // Sanity: the manifest captured both agent routes.
    expect(intactModules.routes.map((r) => r.assistantId).sort()).toEqual([
      "/chat#agent",
      "/helper#agent",
    ])

    // Pruned root: config + package.json + empty src/app only. Route file
    // paths in the manifest are relocated here, where they do not exist.
    const prunedRoot = await mkdtemp(join(tmpdir(), "dawn-static-descriptor-pruned-"))
    cleanup.push(() =>
      rm(prunedRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }),
    )
    await writeFile(join(prunedRoot, "dawn.config.ts"), "export default {}\n", "utf8")
    await writeFile(
      join(prunedRoot, "package.json"),
      '{ "name": "static-descriptor-fixture", "type": "module" }\n',
      "utf8",
    )
    await mkdir(join(prunedRoot, "src/app"), { recursive: true })
    const modules = relocateModules(intactModules, intactRoot, prunedRoot)
    expect(existsSync(join(prunedRoot, "src/app/chat"))).toBe(false)
    expect(existsSync(join(prunedRoot, "src/app/helper"))).toBe(false)

    // Child input deliberately shares no words with the parent's user message
    // so aimock's fixture matching cannot depend on registration order.
    const childInput = "repeat: banana"
    const aimock = await withAimock(
      script()
        // Parent: dispatch to the helper subagent, then wrap up.
        .user("please delegate this task")
        .callsTool("task", { input: childInput, subagent: "helper" })
        .replies("Helper finished.")
        // Child: the dispatcher seeds the child's user message with the task
        // `input` value, so the child fixture matches on that text.
        .user(childInput)
        .replies("banana banana")
        .build(),
    )

    const handler = await createRuntimeFetchHandler({ appRoot: prunedRoot, modules })
    cleanup.push(() => handler.close())

    const body = await runChatTurn(handler, "th-subagent-pruned", "please delegate this task")
    expect(body).toContain("RUN_STARTED")
    // The child actually ran: its scripted reply surfaces through the parent
    // stream's subagent envelopes, and the parent completed its own turn.
    expect(body).toContain("banana banana")
    expect(body).toContain("Helper finished.")
    expect(body).toContain("RUN_FINISHED")

    // Wire-through proof: the helper's descriptor description (resolvable
    // ONLY via routeDescriptors — the entry files no longer exist) reached
    // the parent model's prompt. Deleting the `routeDescriptors` spread at
    // the applyCapabilities call site degrades this to "No description
    // provided." and fails this assertion.
    const promptedRequests = aimock
      .getRequests()
      .filter((request) =>
        JSON.stringify(request.body?.messages ?? []).includes(HELPER_DESCRIPTION),
      )
    expect(promptedRequests.length).toBeGreaterThan(0)
  }, 30_000)
})
