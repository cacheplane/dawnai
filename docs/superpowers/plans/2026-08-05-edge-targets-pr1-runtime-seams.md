# Edge Targets PR 1 — Runtime Edge-Readiness Seams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every remaining disk/sqlite touchpoint on the fetch core's boot and request path injectable, close the B2 descriptor-map hole, get `node:fs` out of the capability markers, and expose a node-free `@dawn-ai/cli/fetch` entry — with byte-for-byte current behavior when nothing is injected.

**Architecture:** Additive seams only (the B2 PR1 discipline). A sync `MarkerFs` facade replaces direct `node:fs` in capability markers (interface in `@dawn-ai/core`, node impl injected by the cli layer — `promptFragment.render()` is sync, so the async `FilesystemBackend` cannot serve markers). Store/config/middleware injection rides the existing `BootResolvedInstances` shape up into the public options types. The `./fetch` export exposes the already-clean fetch handler graph.

**Tech Stack:** TypeScript strict + `exactOptionalPropertyTypes` (conditional spreads), vitest, existing repo conventions (`src/` imports end `.js`, `test/` imports end `.ts`; never bare `biome check --write` — the repo lint script only).

**Spec:** `docs/superpowers/specs/2026-08-05-edge-targets-design.md` (grounding survey section has file:line for every touchpoint).

**Branch:** `feat/edge-targets` (already cut from `main` at `48dbddfb`). Pin it before dispatching subagents.

**Invariant:** Zero edits to existing tests. Baselines: cli 505, core 232, testing 125+12. Sanctioned exception: none expected; if a task genuinely needs one, STOP and escalate.

---

### Task 1: `MarkerFs` facade — type in core, node impl in cli, threaded into capability context

**Files:**
- Modify: `packages/core/src/capabilities/types.ts` (add `MarkerFs` + context field)
- Create: `packages/cli/src/lib/runtime/node-marker-fs.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route.ts` (pass `markerFs` in the `applyCapabilities` context, ~line 834)
- Test: `packages/cli/test/node-marker-fs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/node-marker-fs.test.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { nodeMarkerFs } from "../src/lib/runtime/node-marker-fs.js"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

describe("nodeMarkerFs", () => {
  it("reports existence, size, and content for a real file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dawn-marker-fs-"))
    cleanup.push(() => rm(dir, { force: true, recursive: true }))
    const file = join(dir, "AGENTS.md")
    await writeFile(file, "remember the thing", "utf8")

    expect(nodeMarkerFs.existsSync(file)).toBe(true)
    expect(nodeMarkerFs.statSizeSync(file)).toBe(18)
    expect(nodeMarkerFs.readFileSync(file)).toBe("remember the thing")
    expect(nodeMarkerFs.readDirSync(dir)).toEqual(["AGENTS.md"])
  })

  it("fails closed on missing paths (no throw from existsSync/statSizeSync)", () => {
    expect(nodeMarkerFs.existsSync("/nonexistent/definitely/not-here")).toBe(false)
    expect(nodeMarkerFs.statSizeSync("/nonexistent/definitely/not-here")).toBeUndefined()
    expect(() => nodeMarkerFs.readFileSync("/nonexistent/definitely/not-here")).toThrow()
    expect(nodeMarkerFs.readDirSync("/nonexistent/definitely/not-here")).toEqual([])
  })
})
```

- [ ] **Step 2: Run it — must fail (module not found)**

Run: `pnpm --filter @dawn-ai/cli exec vitest run test/node-marker-fs.test.ts`
Expected: FAIL — cannot resolve `../src/lib/runtime/node-marker-fs.js`

- [ ] **Step 3: Add `MarkerFs` to core types**

In `packages/core/src/capabilities/types.ts`, above `CapabilityMarkerContext`:

```ts
/**
 * Minimal SYNC filesystem facade for capability markers. Sync because
 * `promptFragment.render()` is synchronous (called per model turn) — the
 * async `FilesystemBackend` cannot serve it. The node implementation lives in
 * the cli layer (keeping `node:fs` OUT of @dawn-ai/core's capability graph so
 * edge bundles stay clean); edge entries simply omit it, and markers must
 * detect-false / render-empty when it is absent.
 */
export interface MarkerFs {
  /** false on any error — never throws. */
  existsSync(path: string): boolean
  /** Byte size, or undefined on any error — never throws. */
  statSizeSync(path: string): number | undefined
  /** UTF-8 content; MAY throw (callers already try/catch reads). */
  readFileSync(path: string): string
  /** Entry names (files+dirs), [] on any error — never throws. */
  readDirSync(path: string): readonly string[]
}
```

And add to `CapabilityMarkerContext` (after `backends`):

```ts
  /**
   * Sync fs facade for marker detect/load/render file access. Absent on
   * runtimes with no filesystem (edge) — markers MUST treat absence as
   * "no marker files exist".
   */
  readonly markerFs?: MarkerFs
```

Export `MarkerFs` from the core barrel if `types.ts` exports are re-exported there (follow the existing pattern for `CapabilityMarkerContext`).

- [ ] **Step 4: Implement `nodeMarkerFs`**

```ts
// packages/cli/src/lib/runtime/node-marker-fs.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"

import type { MarkerFs } from "@dawn-ai/core"

/**
 * The Node implementation of the capability-marker fs facade. Injected by
 * prepareRouteExecution so @dawn-ai/core's markers carry no `node:fs` import
 * of their own (edge bundles built from the `./fetch` entry never pull this
 * module in — it is only imported by the node execute path).
 */
export const nodeMarkerFs: MarkerFs = {
  existsSync: (path) => {
    try {
      return existsSync(path)
    } catch {
      return false
    }
  },
  statSizeSync: (path) => {
    try {
      return statSync(path).size
    } catch {
      return undefined
    }
  },
  readFileSync: (path) => readFileSync(path, "utf8"),
  readDirSync: (path) => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
}
```

- [ ] **Step 5: Thread it into `applyCapabilities`**

In `packages/cli/src/lib/runtime/execute-route.ts`: import `nodeMarkerFs` (with the other `./` runtime imports), then in the `applyCapabilities` context object (~line 834, the one that already passes `routeManifest`/`descriptor`/`backends`), add:

```ts
      markerFs: nodeMarkerFs,
```

- [ ] **Step 6: Build core, run the new test + both suites**

Run: `pnpm --filter @dawn-ai/core build && pnpm --filter @dawn-ai/cli exec vitest run test/node-marker-fs.test.ts && pnpm --filter @dawn-ai/core test && pnpm --filter @dawn-ai/cli test`
Expected: new test PASS; core 232 + new, cli 505 + new, zero existing-test edits.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/capabilities/types.ts packages/cli/src/lib/runtime/node-marker-fs.ts packages/cli/src/lib/runtime/execute-route.ts packages/cli/test/node-marker-fs.test.ts
git commit -m "feat(core,cli): MarkerFs sync facade for capability markers (node impl injected by cli)"
```

---

### Task 2: `agents-md` + `memory-md` markers through `MarkerFs`

**Files:**
- Modify: `packages/core/src/capabilities/built-in/agents-md.ts` (full rewrite below)
- Modify: `packages/core/src/capabilities/built-in/memory-md.ts` (same transformation — its fs calls are at lines ~22 detect `existsSync`, ~36/39/48 render stat+read)
- Test: `packages/core/test/markers-marker-fs.test.ts` (new file)

The transformation (identical for both): delete the `node:fs` import; every `existsSync(p)` → `context.markerFs?.existsSync(p) ?? false`; every `statSync(p).size` (in try/catch) → `markerFs.statSizeSync(p)` with the `undefined` branch returning what the catch returned; every `readFileSync(p, "utf8")` (in try/catch) → `markerFs.readFileSync(p)` in the same try/catch. `render`/`load` close over the `context` they already receive. **No `markerFs` ⇒ behave exactly as if no file exists.**

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/markers-marker-fs.test.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createAgentsMdMarker } from "../src/capabilities/built-in/agents-md.js"
import { createMemoryMdMarker } from "../src/capabilities/built-in/memory-md.js"
import type { CapabilityMarkerContext, MarkerFs } from "../src/capabilities/types.js"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** Real-fs MarkerFs (mirrors the cli's nodeMarkerFs) for behavior parity tests. */
const realMarkerFs = async (): Promise<MarkerFs> => {
  const fs = await import("node:fs")
  return {
    existsSync: (p) => fs.existsSync(p),
    statSizeSync: (p) => {
      try {
        return fs.statSync(p).size
      } catch {
        return undefined
      }
    },
    readFileSync: (p) => fs.readFileSync(p, "utf8"),
    readDirSync: (p) => {
      try {
        return fs.readdirSync(p)
      } catch {
        return []
      }
    },
  }
}

const baseContext = (extra: Partial<CapabilityMarkerContext>): CapabilityMarkerContext =>
  ({
    appRoot: "/nonexistent-app",
    descriptor: undefined,
    routeManifest: { appRoot: "/nonexistent-app", routes: [] },
    ...extra,
  }) as CapabilityMarkerContext

describe("agents-md via MarkerFs", () => {
  it("renders workspace/AGENTS.md content through the facade", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-agents-md-"))
    cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
    await mkdir(join(appRoot, "workspace"), { recursive: true })
    await writeFile(join(appRoot, "workspace", "AGENTS.md"), "user prefers tabs", "utf8")

    const marker = createAgentsMdMarker()
    const context = baseContext({ appRoot, markerFs: await realMarkerFs() })
    expect(await marker.detect("/route", context)).toBe(true)
    const contribution = await marker.load("/route", context)
    const rendered = contribution.promptFragment?.render()
    expect(rendered).toContain("user prefers tabs")
  })

  it("renders empty (no crash) when markerFs is absent — the edge case", async () => {
    const marker = createAgentsMdMarker()
    const context = baseContext({ appRoot: "/anywhere" })
    expect(await marker.detect("/route", context)).toBe(true)
    const contribution = await marker.load("/route", context)
    expect(contribution.promptFragment?.render()).toBe("")
  })
})

describe("memory-md via MarkerFs", () => {
  it("detects and renders route memory.md through the facade", async () => {
    const routeDir = await mkdtemp(join(tmpdir(), "dawn-memory-md-"))
    cleanup.push(() => rm(routeDir, { force: true, recursive: true }))
    await writeFile(join(routeDir, "memory.md"), "route lore", "utf8")

    const marker = createMemoryMdMarker()
    const context = baseContext({ appRoot: routeDir, markerFs: await realMarkerFs() })
    expect(await marker.detect(routeDir, context)).toBe(true)
    const contribution = await marker.load(routeDir, context)
    expect(contribution.promptFragment?.render()).toContain("route lore")
  })

  it("detect is false with no markerFs (edge)", async () => {
    const marker = createMemoryMdMarker()
    expect(await marker.detect("/route", baseContext({}))).toBe(false)
  })
})
```

- [ ] **Step 2: Run — must fail** (markers still read node:fs directly, so the no-markerFs cases return real-fs results and/or types don't line up)

Run: `pnpm --filter @dawn-ai/core exec vitest run test/markers-marker-fs.test.ts`
Expected: FAIL on the "markerFs is absent" cases (agents-md renders via node:fs regardless).

- [ ] **Step 3: Rewrite `agents-md.ts`**

```ts
// packages/core/src/capabilities/built-in/agents-md.ts  (full file)
import { resolve } from "node:path"
import type { CapabilityMarker, MarkerFs } from "../types.js"

const MAX_MEMORY_BYTES = 64 * 1024
const MEMORY_HEADER = `# Memory

The block below is the live contents of \`workspace/AGENTS.md\`, re-read on every turn. This IS your persistent memory — do NOT re-read this file with any tool; the content here is always current. Update it by calling \`writeFile({ path: "AGENTS.md", content: "..." })\` when you learn something worth remembering.

---`

/**
 * Auto-injects the contents of <appRoot>/workspace/AGENTS.md into the
 * agent's system prompt under a "# Memory" heading. Always-on: the presence
 * of the file IS the opt-in. Re-reads the file on every model turn (through
 * the injected MarkerFs) so the agent sees its own updated memory
 * immediately after it calls writeFile. With no MarkerFs (edge runtimes)
 * the fragment renders empty — same as when the file does not exist.
 */
export function createAgentsMdMarker(): CapabilityMarker {
  return {
    name: "agents-md",
    detect: async (_routeDir, _context) => true,
    load: async (_routeDir, context) => {
      const agentsMdPath = resolve(context.appRoot, "workspace", "AGENTS.md")
      const markerFs = context.markerFs
      return {
        promptFragment: {
          placement: "after_user_prompt",
          render: () => (markerFs ? renderMemoryFragment(agentsMdPath, markerFs) : ""),
        },
      }
    },
  }
}

function renderMemoryFragment(path: string, markerFs: MarkerFs): string {
  if (!markerFs.existsSync(path)) return ""

  const size = markerFs.statSizeSync(path)
  if (size === undefined) return ""

  if (size > MAX_MEMORY_BYTES) {
    return `${MEMORY_HEADER}\n\n(workspace/AGENTS.md is ${size} bytes; exceeds 64 KiB limit — not loaded)`
  }

  let raw: string
  try {
    raw = markerFs.readFileSync(path)
  } catch {
    return ""
  }

  const trimmed = raw.trim()
  if (trimmed.length === 0) return ""

  return `${MEMORY_HEADER}\n\n${trimmed}`
}
```

Note: `node:path`'s `resolve` stays for now — Task 10 decides the path-helper story for the whole core capability graph in one sweep.

- [ ] **Step 4: Apply the identical transformation to `memory-md.ts`** — read the file first; swap its `existsSync` (detect), `statSync`, `readFileSync` calls for `context.markerFs` calls with absence ⇒ detect false / render "". Preserve its size-cap and header text exactly.

- [ ] **Step 5: Run the new tests + core suite**

Run: `pnpm --filter @dawn-ai/core exec vitest run test/markers-marker-fs.test.ts && pnpm --filter @dawn-ai/core test`
Expected: all PASS, zero existing-test edits (existing marker tests exercise the cli path, which injects `nodeMarkerFs` from Task 1 — if any existing CORE test constructs contexts directly and breaks, STOP: that is the escalation case, not an edit-the-test case).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/capabilities/built-in/agents-md.ts packages/core/src/capabilities/built-in/memory-md.ts packages/core/test/markers-marker-fs.test.ts
git commit -m "feat(core): agents-md + memory-md markers read through MarkerFs (edge-safe)"
```

---

### Task 3: `planning`, `skills`, `workspace` markers through `MarkerFs`

**Files:**
- Modify: `packages/core/src/capabilities/built-in/planning.ts` (fs at ~:34 detect, ~:107-112 render)
- Modify: `packages/core/src/capabilities/built-in/skills.ts` (fs at ~:31 detect→`discoverSkillDirs` ~:75-92 readdir/stat/exists, ~:105 readSkill tool read)
- Modify: `packages/core/src/capabilities/built-in/workspace.ts` (fs at ~:121-122 detect `existsSync(<appRoot>/workspace)`)
- Test: extend `packages/core/test/markers-marker-fs.test.ts`

Same transformation as Task 2. Marker-specific rules:
- `planning`: no markerFs ⇒ `detect` false (no plan.md ⇒ no planning capability). Its tool contributions (`writeTodos`) are fs-free and unchanged.
- `skills`: `discoverSkillDirs` takes the facade (`readDirSync` + `existsSync` + `statSizeSync`-as-directory-probe — read the current code and preserve its exact directory/SKILL.md rules); the `readSkill` tool's `readFileSync` goes through the facade captured at load time. No markerFs ⇒ detect false.
- `workspace`: detect stays `context.workspaceRoot !== undefined || (context.markerFs?.existsSync(join(appRoot, "workspace")) ?? false)` — a sandbox workspaceRoot still activates it with no host fs. Its tools already run through `context.backends` (async) — do not touch them.

- [ ] **Step 1: Write failing tests** — extend the Task-2 test file:

```ts
describe("planning via MarkerFs", () => {
  it("detects plan.md through the facade and not without it", async () => {
    const routeDir = await mkdtemp(join(tmpdir(), "dawn-planning-"))
    cleanup.push(() => rm(routeDir, { force: true, recursive: true }))
    await writeFile(join(routeDir, "plan.md"), "# plan", "utf8")

    const { createPlanningMarker } = await import("../src/capabilities/built-in/planning.js")
    const marker = createPlanningMarker()
    expect(
      await marker.detect(routeDir, baseContext({ appRoot: routeDir, markerFs: await realMarkerFs() })),
    ).toBe(true)
    expect(await marker.detect(routeDir, baseContext({ appRoot: routeDir }))).toBe(false)
  })
})

describe("skills via MarkerFs", () => {
  it("discovers skill dirs through the facade; detect false without it", async () => {
    const routeDir = await mkdtemp(join(tmpdir(), "dawn-skills-"))
    cleanup.push(() => rm(routeDir, { force: true, recursive: true }))
    await mkdir(join(routeDir, "skills", "greeting"), { recursive: true })
    await writeFile(join(routeDir, "skills", "greeting", "SKILL.md"), "# greeting", "utf8")

    const { createSkillsMarker } = await import("../src/capabilities/built-in/skills.js")
    const marker = createSkillsMarker()
    const withFs = baseContext({ appRoot: routeDir, markerFs: await realMarkerFs() })
    expect(await marker.detect(routeDir, withFs)).toBe(true)
    expect(await marker.detect(routeDir, baseContext({ appRoot: routeDir }))).toBe(false)
  })
})

describe("workspace via MarkerFs", () => {
  it("sandbox workspaceRoot activates without any fs; host dir needs the facade", async () => {
    const { createWorkspaceMarker } = await import("../src/capabilities/built-in/workspace.js")
    const marker = createWorkspaceMarker()
    expect(
      await marker.detect("/route", baseContext({ workspaceRoot: "/workspace" })),
    ).toBe(true)
    expect(await marker.detect("/route", baseContext({ appRoot: "/nope" }))).toBe(false)
  })
})
```

- [ ] **Step 2: Run — must fail** (`pnpm --filter @dawn-ai/core exec vitest run test/markers-marker-fs.test.ts`)

- [ ] **Step 3: Apply the facade swap to all three files** per the rules above — read each file, replace exactly the enumerated fs call sites, delete the `node:fs` imports, keep all prompt text/limits/ordering identical.

- [ ] **Step 4: Run new tests + full core + full cli suites**

Run: `pnpm --filter @dawn-ai/core test && pnpm --filter @dawn-ai/core build && pnpm --filter @dawn-ai/cli test`
Expected: all green (cli integration tests prove Node-path behavior is unchanged through `nodeMarkerFs`).

- [ ] **Step 5: Verify no `node:fs` remains in built-in markers**

Run: `grep -rn "node:fs" packages/core/src/capabilities/built-in/`
Expected: no matches (subagents.ts's `pathToFileURL` is `node:url` — handled in Task 4).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/capabilities/built-in/ packages/core/test/markers-marker-fs.test.ts
git commit -m "feat(core): planning/skills/workspace markers read through MarkerFs"
```

---

### Task 4: subagents descriptions without dynamic import; descriptor map from static modules

**Files:**
- Modify: `packages/core/src/capabilities/built-in/subagents.ts` (`loadDescription` ~:30-40 dynamic-imports child entry files)
- Modify: `packages/core/src/capabilities/types.ts` (context gains `routeDescriptors?: ReadonlyMap<string, unknown>` — routeId → default-export descriptor)
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`:
  - `getCachedDescriptorRouteMap`/`buildDescriptorRouteMap` (~:1312-1329) gains a static source
  - `prepareRouteExecution` passes `routeDescriptors` into `applyCapabilities`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-handler.ts` (build the descriptor map from `options.modules` and thread it — see Step 4)
- Test: `packages/cli/test/static-descriptor-map.test.ts`

Design: when static modules are present, each agent route's descriptor is `route.module.entry` (already normalized). Build `Map<DawnAgent, string>` (descriptor→routeId, for the existing subagents-override resolution) AND `Map<string, unknown>` (routeId→descriptor, for `loadDescription`) from the manifest — zero disk imports. Dynamic path unchanged (falls back to the existing best-effort import).

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/static-descriptor-map.test.ts
import { describe, expect, it, vi } from "vitest"

import {
  __resetDescriptorRouteMapCacheForTests,
  buildDescriptorMapsFromStaticModules,
} from "../src/lib/runtime/execute-route.js"

describe("descriptor maps from static modules", () => {
  it("builds descriptor→routeId and routeId→descriptor maps with zero imports", () => {
    __resetDescriptorRouteMapCacheForTests()
    const importSpy = vi.fn()
    const agentA = { __dawnAgent: true, model: "gpt-5-mini" }
    const agentB = { __dawnAgent: true, model: "gpt-5-mini" }
    const modules = {
      routes: [
        {
          assistantId: "/a#agent",
          kind: "agent",
          memory: null,
          module: { entry: agentA, kind: "agent" },
          routeFile: "/app/src/app/a/index.ts",
          routeId: "/a",
          routePath: "src/app/a/index.ts",
          stateFields: undefined,
          tools: [],
        },
        {
          assistantId: "/a/subagents/b#agent",
          kind: "agent",
          memory: null,
          module: { entry: agentB, kind: "agent" },
          routeFile: "/app/src/app/a/subagents/b/index.ts",
          routeId: "/a/subagents/b",
          routePath: "src/app/a/subagents/b/index.ts",
          stateFields: undefined,
          tools: [],
        },
      ],
    }
    const maps = buildDescriptorMapsFromStaticModules(modules as never)
    expect(importSpy).not.toHaveBeenCalled()
    expect(maps.descriptorRouteMap.get(agentA as never)).toBe("/a")
    expect(maps.routeDescriptors.get("/a/subagents/b")).toBe(agentB)
  })
})
```

Note: `isDawnAgent` guards real descriptors — the fixture objects must satisfy it; read `packages/sdk`'s `isDawnAgent` and shape the fixtures to pass (adjust `__dawnAgent`/brand field to the real brand; if `isDawnAgent` requires the real `agent()` factory, build the fixtures with `agent({ model: "gpt-5-mini" })` imported from `@dawn-ai/sdk` instead of literals).

- [ ] **Step 2: Run — must fail** (export does not exist)

- [ ] **Step 3: Implement**

In `execute-route.ts`, next to `buildDescriptorRouteMap`:

```ts
/**
 * Static-modules fast path: derive both descriptor maps from the manifest —
 * each agent route's `module.entry` IS its default-export descriptor, so no
 * entry file is ever imported from disk (closes the last B2 dynamic-import
 * hole; edge runtimes have no disk to import from).
 */
export function buildDescriptorMapsFromStaticModules(modules: DawnStaticModules): {
  readonly descriptorRouteMap: ReadonlyMap<DawnAgent, string>
  readonly routeDescriptors: ReadonlyMap<string, unknown>
} {
  const descriptorRouteMap = new Map<DawnAgent, string>()
  const routeDescriptors = new Map<string, unknown>()
  for (const route of modules.routes) {
    if (route.kind === "agent" && isDawnAgent(route.module.entry)) {
      descriptorRouteMap.set(route.module.entry, route.routeId)
      routeDescriptors.set(route.routeId, route.module.entry)
    }
  }
  return { descriptorRouteMap, routeDescriptors }
}
```

Wire-through: `BootResolvedInstances` gains `readonly staticModules?: DawnStaticModules`. `createRuntimeFetchHandler` passes `options.modules` down (in `buildRouteTable`'s existing boot-instance plumbing). In `prepareRouteExecution`'s agent branch, replace:

```ts
    const descriptorRouteMap = await getCachedDescriptorRouteMap(routeManifest)
```

with:

```ts
    const staticMaps = options.staticModules
      ? getCachedStaticDescriptorMaps(options.staticModules)
      : undefined
    const descriptorRouteMap =
      staticMaps?.descriptorRouteMap ?? (await getCachedDescriptorRouteMap(routeManifest))
```

where `getCachedStaticDescriptorMaps` memoizes `buildDescriptorMapsFromStaticModules` per manifest object identity (a `WeakMap<DawnStaticModules, …>`, reset inside the existing `__resetDescriptorRouteMapCacheForTests`). Pass `...(staticMaps ? { routeDescriptors: staticMaps.routeDescriptors } : {})` into the `applyCapabilities` context.

In `subagents.ts`: `loadDescription(route)` first checks `context.routeDescriptors?.get(route.id)` — if present and it has a `description`/system-prompt-derived summary (read the current code for exactly what it extracts from the imported module's default export) use it with NO import; otherwise fall back to the existing dynamic import (Node path). No routeDescriptors and no import possible ⇒ same fallback text the current catch produces.

- [ ] **Step 4: Also thread `staticModules` through the subagent re-entry sites** (execute-route.ts ~:1396 and ~:1426) — add `...(staticModules ? { staticModules } : {})` — pulling `staticModules` into `buildSubagentResolver`'s args exactly like `sandboxManager`. (Full boot-instance threading for stores happens in Task 6; this task only threads `staticModules`.)

- [ ] **Step 5: Run the new test + full cli suite** — all green, zero edits.

- [ ] **Step 6: Prove the pruned-source property end to end** — extend `packages/cli/test/static-descriptor-map.test.ts` with an integration case modeled on `static-route-execution.test.ts` (the pruned-fixture proof): build a fixture app with a parent route + `subagents/helper` child via `emitModulesFile`+`loadStaticModules` (or hand-built `DawnStaticModules` from `buildStaticRouteModule`), DELETE the route source files, then run a turn that dispatches the subagent (aimock `callsTool("task", ...)` fixture) and assert it succeeds. This fails before Step 3-4 (descriptor map import ENOENT → subagent unresolvable) and passes after.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/runtime/execute-route.ts packages/cli/src/lib/dev/runtime-fetch-handler.ts packages/core/src/capabilities/built-in/subagents.ts packages/core/src/capabilities/types.ts packages/cli/test/static-descriptor-map.test.ts
git commit -m "feat(cli,core): descriptor maps from static modules — no disk imports on the static path"
```

---

### Task 5: config seam — `seedDawnConfig` + `config` option

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `packages/cli/src/lib/dev/runtime-server.ts` (`StartRuntimeServerOptions.config?: DawnConfig`)
- Modify: `packages/cli/src/lib/dev/runtime-fetch-handler.ts` (seed before any resolver runs)
- Test: `packages/core/test/seed-dawn-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/seed-dawn-config.test.ts
import { afterEach, describe, expect, it } from "vitest"

import { __clearDawnConfigCacheForTests, loadDawnConfig, seedDawnConfig } from "../src/config.js"

afterEach(() => __clearDawnConfigCacheForTests())

describe("seedDawnConfig", () => {
  it("primes the memo so loadDawnConfig never touches disk", async () => {
    seedDawnConfig("/edge-app", { memory: { recall: {} } })
    const loaded = await loadDawnConfig({ appRoot: "/edge-app" })
    expect(loaded.config.memory?.recall).toEqual({})
    expect(loaded.configPath).toBe("<seeded>")
  })

  it("a seeded config wins over a real config file (explicit beats disk)", async () => {
    seedDawnConfig(process.cwd(), {})
    const loaded = await loadDawnConfig({ appRoot: process.cwd() })
    expect(loaded.configPath).toBe("<seeded>")
  })
})
```

- [ ] **Step 2: Run — must fail** (`seedDawnConfig` not exported)

- [ ] **Step 3: Implement in `config.ts`**

```ts
/**
 * Prime the per-appRoot config memo with an already-constructed DawnConfig —
 * the static-wiring seam for runtimes with no filesystem (edge) and for
 * callers that carry their config as an object. Symmetric with
 * seedPreparedRouteModules. Overwrites any cached entry: an explicit seed
 * always beats a disk load.
 */
export function seedDawnConfig(appRoot: string, config: DawnConfig): void {
  configCache.set(
    appRoot,
    Promise.resolve({ appRoot, config, configPath: "<seeded>" }),
  )
}
```

- [ ] **Step 4: Expose the option** — `StartRuntimeServerOptions` gains:

```ts
  /**
   * An already-constructed DawnConfig. When present, it is seeded into the
   * config memo BEFORE any store/sandbox/memory resolution, so
   * `dawn.config.ts` is never read from disk (edge runtimes have none).
   */
  readonly config?: DawnConfig
```

First lines of `createRuntimeFetchHandler` (before `createRuntimeRegistry`):

```ts
  if (options.config) {
    seedDawnConfig(options.appRoot, options.config)
  }
```

- [ ] **Step 5: Fetch-handler test** — add to `packages/cli/test/` a case (new file `config-seam.test.ts`) that creates a fixture app WITH a `dawn.config.ts` exporting `{ permissions: { mode: "bypass" } }` on disk but passes `config: { permissions: { mode: "non-interactive" } }` to `createRuntimeFetchHandler`, then asserts via a turn (or via `resolvePermissionsStore` behavior) that the seeded object won. Model the fixture on `static-registry.test.ts`'s harness.

- [ ] **Step 6: Run new tests + core + cli suites; commit**

```bash
git add packages/core/src/config.ts packages/core/test/seed-dawn-config.test.ts packages/cli/src/lib/dev/runtime-server.ts packages/cli/src/lib/dev/runtime-fetch-handler.ts packages/cli/test/config-seam.test.ts
git commit -m "feat(core,cli): seedDawnConfig + config option — no dawn.config.ts disk read when supplied"
```

---

### Task 6: store injection surface + subagent threading (the big seam)

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-server.ts` (options)
- Modify: `packages/cli/src/lib/dev/runtime-fetch-handler.ts` (use injected instances)
- Modify: `packages/cli/src/lib/dev/serve-runtime.ts` (pass-through on `ServeRuntimeOptions`)
- Modify: `packages/cli/src/lib/runtime/execute-route.ts` (`buildSubagentResolver` threads boot instances)
- Test: `packages/cli/test/store-injection.test.ts`

- [ ] **Step 1: Write the failing test** — the spy proof:

```ts
// packages/cli/test/store-injection.test.ts
// Fixture app modeled on static-registry.test.ts (agent route, aimock turn).
// Inject: MemorySaver checkpointer, in-memory ThreadsStore, in-memory
// PermissionsStore, memoryStore thunk. Spy on sqlite opens the same way
// boot-instances.test.ts (B2 PR1's T2) does — vi.spyOn the sqlite-storage
// factory module — and assert ZERO sqlite constructions and ZERO
// .dawn/permissions.json reads across: boot + a full turn + a SUBAGENT turn.
```

Write it concretely: copy the harness shape of the existing `boot-instances` / `static-route-execution` tests (fixture app builder + aimock `script()`), with a parent route having `subagents/helper` and a fixture conversation that `callsTool("task", { subagent: "helper", ... })` (read `packages/cli/test/` for the existing subagent e2e fixture shape — `tool-scoping` T4 or the subagent e2e test — and mirror its aimock script). In-memory stores:

```ts
const memoryThreads = (): ThreadsStore => {
  const threads = new Map<string, Thread>()
  return {
    createThread: async (t) => { threads.set(t.threadId, t); return t },
    getThread: async (id) => threads.get(id),
    deleteThread: async (id) => void threads.delete(id),
    listThreads: async () => [...threads.values()],
    updateStatus: async (id, status) => { const t = threads.get(id); if (t) threads.set(id, { ...t, status }) },
    updateMetadata: async (id, metadata) => { const t = threads.get(id); if (t) threads.set(id, { ...t, metadata }) },
  }
}
```

(Adjust member names/signatures to the REAL `ThreadsStore` interface in `packages/sqlite-storage/src/threads/store.ts:19-31` — read it first; same for `PermissionsStore` in `packages/permissions/src/types.ts:65-73`: implement `load` as no-op, `match` allow-all or config-driven, `addAllow` recording, `mode: "non-interactive"`.) Checkpointer: `new MemorySaver()` from `@langchain/langgraph`.

Assertions: turn succeeds; subagent turn succeeds; sqlite spy never called; injected threadsStore contains the created thread.

- [ ] **Step 2: Run — must fail** (options don't accept the fields; compile error)

- [ ] **Step 3: Extend `StartRuntimeServerOptions`**

```ts
  /** Boot-resolved checkpointer. Absent: config, then default sqlite. */
  readonly checkpointer?: BaseCheckpointSaver
  /** Boot-resolved threads store. Absent: config, then default sqlite. */
  readonly threadsStore?: ThreadsStore
  /**
   * Boot-resolved permissions store (instance or per-request factory —
   * same semantics as BootResolvedInstances.permissionsStore). Absent:
   * permissionsMode-driven construction from `.dawn/permissions.json`.
   */
  readonly permissionsStore?: PermissionsStore | (() => Promise<PermissionsStore>)
  /** Lazy memory-store thunk. Absent: sqlite-backed resolveMemoryStore. */
  readonly memoryStore?: () => Promise<MemoryStore>
  /** Pre-loaded middleware. Absent: the dynamic src/middleware.ts probe. */
  readonly middleware?: DawnMiddleware
```

(Imports: `type { DawnMiddleware } from "@dawn-ai/sdk"`, `type { MemoryStore } from "@dawn-ai/memory"`, `type { ThreadsStore } from "@dawn-ai/sqlite-storage"`, `type { PermissionsStore } from "@dawn-ai/permissions"`, `type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"` — all type-only, erased at runtime.)

- [ ] **Step 4: Use them in `createRuntimeFetchHandler`**

```ts
  const middleware = options.middleware ?? (await loadMiddleware(options.appRoot))
  const threadsStore = options.threadsStore ?? (await resolveThreadsStore(options.appRoot))
  const checkpointer = options.checkpointer ?? (await resolveCheckpointer(options.appRoot))
  // …
  const getMemoryStore = (): Promise<MemoryStore> => {
    memoryStorePromise ??= options.memoryStore
      ? options.memoryStore()
      : resolveMemoryStore(options.appRoot)
    return memoryStorePromise
  }
  // …
  const permissionsStore: PermissionsStore | (() => Promise<PermissionsStore>) =
    options.permissionsStore ??
    (options.permissionsMode === "boot"
      ? await resolvePermissionsStore(options.appRoot)
      : () => resolvePermissionsStore(options.appRoot))
```

`ServeRuntimeOptions` passes all of them through (it already spreads/forwards `modules` — follow that pattern).

- [ ] **Step 5: Thread boot instances through the subagent resolver.** `buildSubagentResolver`'s args gain `readonly bootInstances?: BootResolvedInstances`; the `prepareRouteExecution` call site (~:975) passes the ones it received:

```ts
      subagentResolver = buildSubagentResolver({
        appRoot: options.appRoot,
        routeDir,
        routeManifest,
        descriptor,
        descriptorRouteMap,
        bootInstances: {
          ...(options.checkpointer ? { checkpointer: options.checkpointer } : {}),
          ...(options.threadsStore ? { threadsStore: options.threadsStore } : {}),
          ...(options.permissionsStore ? { permissionsStore: options.permissionsStore } : {}),
          ...(options.memoryStore ? { memoryStore: options.memoryStore } : {}),
          routeManifest,
          ...(options.staticModules ? { staticModules: options.staticModules } : {}),
        },
        ...(options.sandboxManager ? { sandboxManager: options.sandboxManager } : {}),
        ...(sandboxKey ? { sandboxThreadId: sandboxKey } : {}),
      })
```

and both re-entry sites spread `...args.bootInstances` into `executeResolvedRoute`/`streamResolvedRoute` (replacing the current lone `routeManifest`). This also requires the fetch handler to actually PASS its boot instances into route execution — verify `buildRouteTable`'s call sites already forward checkpointer/threadsStore/permissionsStore/getMemoryStore (they do, from B2 PR1) and now ALSO get `staticModules` (Task 4) — nothing new here beyond the subagent hop.

- [ ] **Step 6: Run the spy test + full cli suite** — new test green (zero sqlite opens including the subagent turn), 505+ green, zero edits.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-server.ts packages/cli/src/lib/dev/runtime-fetch-handler.ts packages/cli/src/lib/dev/serve-runtime.ts packages/cli/src/lib/runtime/execute-route.ts packages/cli/test/store-injection.test.ts
git commit -m "feat(cli): full store/middleware injection surface + subagent boot-instance threading"
```

---

### Task 7: lazy `localFilesystem` + lazy sqlite memory import + lazy offload probe

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts` (`createWorkspaceFs` backend default ~:743; `buildOffload` `existsSync` ~:1455)
- Modify: `packages/cli/src/lib/runtime/resolve-memory.ts` (top-level `sqliteMemoryStore` value import → dynamic inside the function)
- Test: `packages/cli/test/lazy-node-backends.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/lazy-node-backends.test.ts
// 1. resolve-memory: importing the module must NOT import @dawn-ai/memory's
//    sqlite store (vi.mock @dawn-ai/memory with a throwing factory; import
//    resolve-memory.ts; expect no throw until resolveMemoryStore is CALLED).
// 2. createWorkspaceFs default: run a turn on a fixture route whose config
//    provides backends.filesystem (a recording fake); spy on
//    @dawn-ai/workspace's localFilesystem export and assert it was never
//    constructed. (vi.spyOn(workspaceModule, "localFilesystem")).
```

Write both cases concretely against the real module shapes (read `resolve-memory.ts` first: the swap is `import { sqliteMemoryStore } from "@dawn-ai/memory"` → inside `resolveMemoryStore`'s default branch: `const { sqliteMemoryStore } = await import("@dawn-ai/memory")`).

- [ ] **Step 2: Run — must fail** (localFilesystem constructed unconditionally; sqlite imported at module load)

- [ ] **Step 3: Implement.**
  - `resolve-memory.ts`: move the value import into the function (keep type imports top-level — types erase).
  - `execute-route.ts` `createWorkspaceFs` call: `backend: sandboxBackends?.filesystem ?? configBackends?.filesystem ?? localFilesystem()` stays — but `localFilesystem` becomes imported lazily via module-level memo:

```ts
let defaultLocalFilesystem: FilesystemBackend | undefined
function getDefaultLocalFilesystem(): FilesystemBackend {
  defaultLocalFilesystem ??= localFilesystem()
  return defaultLocalFilesystem
}
```

with the call site using `?? getDefaultLocalFilesystem()`. (The import of `localFilesystem` itself stays static in THIS file — execute-route is the node graph; the edge graph split is Task 8. The memo just stops per-request construction.)
  - `buildOffload`: replace the per-request `existsSync(join(appRoot, "workspace"))` with a per-appRoot memo (`Map<string, boolean>`), reset via `__resetRouteLoadCachesForTests`.

- [ ] **Step 4: Run new test + cli suite; commit**

```bash
git add packages/cli/src/lib/runtime/execute-route.ts packages/cli/src/lib/runtime/resolve-memory.ts packages/cli/test/lazy-node-backends.test.ts
git commit -m "perf(cli): lazy localFilesystem/offload probe; sqlite memory import made lazy"
```

---

### Task 8: middleware in the static manifest

**Files:**
- Modify: `packages/cli/src/lib/runtime/static-modules.ts` (`DawnStaticModules.middleware?`)
- Modify: `packages/cli/src/lib/build/targets/modules-emitter.ts` (emit static middleware import when `src/middleware.ts` exists)
- Modify: `packages/cli/src/lib/dev/runtime-fetch-handler.ts` (prefer `options.middleware ?? options.modules?.middleware ?? loadMiddleware(...)`)
- Test: extend `packages/cli/test/modules-emitter.test.ts` is FORBIDDEN (existing file — new tests go in `packages/cli/test/static-middleware.test.ts`)

- [ ] **Step 1: Write the failing test** — `static-middleware.test.ts`: fixture app (reuse the emitter fixture-builder pattern) WITH `src/middleware.ts` default-exporting a `defineMiddleware` that rejects requests missing header `x-ok`; emit via `emitModulesFile` + `collectRouteStaticDiscovery` flow (the collector gains a middleware probe — assert the emitted text contains `import middleware from "../../src/middleware.ts"` and `middleware,` in the default export); load via `loadStaticModules`; boot `createRuntimeFetchHandler({ appRoot, modules })`; assert a request without the header is rejected (middleware ran from the manifest) after DELETING `src/middleware.ts` post-emit — proving zero dynamic probe.

- [ ] **Step 2: Run — must fail.**

- [ ] **Step 3: Implement.**
  - `static-modules.ts`: `DawnStaticModules` gains `readonly middleware?: DawnMiddleware` (type-only import from `@dawn-ai/sdk`); `loadStaticModules`'s entry validation unchanged (middleware optional, validate `typeof === "function"` when present else throw the malformed error).
  - Emitter: `collectAppStaticDiscovery` (or the node-target call site — put the probe where `discoverRoutes` output is assembled in `targets/node.ts`) checks `existsSync(join(appRoot, "src", "middleware.ts"))`; when present `emitModulesFile` gains `middlewareFile?: string` in options and emits `import middleware from ${JSON.stringify(importSpecifier(buildDir, middlewareFile))}` + `  middleware,` inside the default export object (before `routes`). JSON.stringify the specifier (B2 hardening rule).
  - Fetch handler: `const middleware = options.middleware ?? options.modules?.middleware ?? (await loadMiddleware(options.appRoot))`.

- [ ] **Step 4: Run new test + emitter/static suites + full cli; commit**

```bash
git add packages/cli/src/lib/runtime/static-modules.ts packages/cli/src/lib/build/targets/modules-emitter.ts packages/cli/src/lib/build/targets/node.ts packages/cli/src/lib/dev/runtime-fetch-handler.ts packages/cli/test/static-middleware.test.ts
git commit -m "feat(cli): middleware in the static module manifest — no dynamic probe on the static path"
```

---

### Task 9: Web-crypto + path hygiene on the fetch graph

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts` (`randomUUID` from `node:crypto` → global `crypto.randomUUID()`)
- Modify: `packages/cli/src/lib/dev/runtime-registry.ts`, `packages/cli/src/lib/runtime/static-modules.ts`, `packages/cli/src/lib/runtime/resolve-memory.ts`, `packages/cli/src/lib/runtime/route-identity.ts` (`node:path` pure functions → a tiny local pure helper)
- Create: `packages/cli/src/lib/runtime/pure-path.ts`
- Test: `packages/cli/test/pure-path.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/pure-path.test.ts
import { basename, dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

import { pureBasename, pureDirname, pureJoin } from "../src/lib/runtime/pure-path.js"

describe("pure-path parity with node:path (posix inputs)", () => {
  const cases = [
    ["/a/b/c.ts"], ["/a/b/"], ["a/b/../c"], ["/"], ["./x"], ["/a//b"], ["memory.ts"],
  ] as const
  it("dirname/basename match node:path", () => {
    for (const [p] of cases) {
      expect(pureDirname(p)).toBe(dirname(p))
      expect(pureBasename(p)).toBe(basename(p))
    }
  })
  it("join matches node:path", () => {
    expect(pureJoin("/app", ".dawn/threads.sqlite")).toBe(join("/app", ".dawn/threads.sqlite"))
    expect(pureJoin("/a", "b", "..", "c")).toBe(join("/a", "b", "..", "c"))
    expect(pureJoin("a", "b")).toBe(join("a", "b"))
  })
})
```

- [ ] **Step 2: Run — must fail; implement `pure-path.ts`** — POSIX-only implementations (repo targets POSIX; document that Windows build machines' paths only flow through BUILD-time code, which keeps `node:path`):

```ts
// packages/cli/src/lib/runtime/pure-path.ts
/**
 * POSIX-only pure implementations of the three path operations the fetch
 * graph needs (dirname/basename/join). Exist so the `./fetch` entry's module
 * graph carries zero `node:` imports; build-time code keeps `node:path`.
 */
export function pureDirname(path: string): string {
  if (!path.includes("/")) return "."
  const trimmed = path.replace(/\/+$/, "")
  if (trimmed === "") return "/"
  const idx = trimmed.lastIndexOf("/")
  if (idx === -1) return "."
  if (idx === 0) return "/"
  return trimmed.slice(0, idx)
}

export function pureBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "")
  if (trimmed === "") return path === "" ? "" : "/" === path[0] ? "" : path
  const idx = trimmed.lastIndexOf("/")
  return idx === -1 ? trimmed : trimmed.slice(idx + 1)
}

export function pureJoin(...parts: readonly string[]): string {
  const joined = parts.filter((p) => p !== "").join("/")
  if (joined === "") return "."
  const isAbsolute = joined.startsWith("/")
  const segments: string[] = []
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") segments.pop()
      else if (!isAbsolute) segments.push("..")
      continue
    }
    segments.push(segment)
  }
  const body = segments.join("/")
  return isAbsolute ? `/${body}` || "/" : body || "."
}
```

NOTE: node's `basename("/")` is `""` and `dirname("/")` is `"/"` — the parity test pins exact node behavior for every case listed; iterate the implementation until the parity suite passes rather than trusting the sketch above.

- [ ] **Step 3: Swap call sites** on the fetch-graph modules listed in Files (NOT build/, NOT commands/, NOT the dynamic loaders — those stay node). In `execute-route.ts` replace `randomUUID()` (from `node:crypto`) with `globalThis.crypto.randomUUID()` and delete the import; replace its `join`/`resolve` uses on the REQUEST path with `pureJoin` (`resolve(options.routeFile, "..")` → `pureDirname(options.routeFile)`); `isAbsolute`/`resolveRouteFile` (dynamic-entry only) keep `node:path`.

- [ ] **Step 4: Run parity test + full cli suite** (the equivalence and static suites re-prove behavior); commit

```bash
git add packages/cli/src/lib/runtime/pure-path.ts packages/cli/test/pure-path.test.ts packages/cli/src/lib/runtime/execute-route.ts packages/cli/src/lib/dev/runtime-registry.ts packages/cli/src/lib/runtime/static-modules.ts packages/cli/src/lib/runtime/resolve-memory.ts packages/cli/src/lib/runtime/route-identity.ts
git commit -m "feat(cli): pure path/crypto on the fetch graph (node:path/node:crypto removed from request path)"
```

---

### Task 10: the `@dawn-ai/cli/fetch` entry + graph-purity gate

**Files:**
- Create: `packages/cli/src/fetch-exports.ts`
- Modify: `packages/cli/package.json` (exports map + explicit `esbuild` devDependency)
- Test: `packages/cli/test/fetch-entry-purity.test.ts`

- [ ] **Step 1: Write the failing purity test** — the load-bearing gate of the whole PR:

```ts
// packages/cli/test/fetch-entry-purity.test.ts
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { describe, expect, it } from "vitest"

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

describe("@dawn-ai/cli/fetch graph purity", () => {
  it("bundles with ZERO node: imports and no sqlite/tsx/commander", async () => {
    const result = await build({
      bundle: true,
      entryPoints: [join(pkgRoot, "src", "fetch-exports.ts")],
      format: "esm",
      logLevel: "silent",
      metafile: true,
      outfile: "/dev/null",
      platform: "neutral",
      conditions: ["import"],
      mainFields: ["module", "main"],
      write: false,
      external: [
        // Model/provider layer is the app's concern; langgraph's async_hooks
        // usage is a documented nodejs_compat allowance — everything Dawn owns
        // must be import-free of node:.
        "@langchain/*", "langchain", "openai", "zod",
      ],
    })
    const inputs = Object.keys(result.metafile.inputs)
    const nodeImports = inputs.filter((i) => i.startsWith("node:"))
    expect(nodeImports).toEqual([])
    expect(inputs.some((i) => i.includes("sqlite"))).toBe(false)
    expect(inputs.some((i) => i.includes("commander"))).toBe(false)
    expect(inputs.some((i) => i.includes("/tsx/"))).toBe(false)
  }, 60_000)
})
```

(esbuild `platform: "neutral"` makes any `node:` import a resolution ERROR unless external — adjust the assertion mechanics to whichever signal is cleanest: either expect `build` to succeed with zero `node:` inputs, or mark `node:*` external and assert the metafile's `imports` list contains none. Pin the exact mechanics while making the test fail first against `runtime-exports.ts` to prove it detects violations.)

- [ ] **Step 2: Run — must fail** (entry file doesn't exist; then, while developing, the graph will surface stragglers — fix by moving imports, not by widening externals; every widened external must be justified in a comment).

- [ ] **Step 3: Create `fetch-exports.ts`**

```ts
// packages/cli/src/fetch-exports.ts
/**
 * The edge-safe runtime surface: everything needed to serve a Dawn app from a
 * web-standard runtime, with ZERO `node:` imports in the module graph
 * (enforced by test/fetch-entry-purity.test.ts). Excludes: the CLI bin, the
 * node HTTP server, dynamic discovery/loaders, tsx, sqlite. Callers supply
 * `modules` (from the build-time manifest), `config`, and store instances.
 * Exposed as `@dawn-ai/cli/fetch`.
 */

export {
  createRuntimeFetchHandler,
  type RuntimeFetchHandler,
} from "./lib/dev/runtime-fetch-handler.js"
export type { StartRuntimeServerOptions } from "./lib/dev/runtime-server.js"
export {
  buildStaticRouteModule,
  type DawnStaticModules,
  type StaticRouteModule,
  type StaticRouteModuleInput,
} from "./lib/runtime/static-modules.js"
export { seedDawnConfig } from "@dawn-ai/core"
```

CAVEAT the implementer must resolve (this is the task's real work): `runtime-fetch-handler.ts` imports `StartRuntimeServerOptions` from `runtime-server.ts` (which value-imports `node:http`) and value-imports the dynamic resolvers from `execute-route.ts`. Split as needed:
  - Move `StartRuntimeServerOptions` (and its doc comments) into `runtime-fetch-handler.ts` (or a new `runtime-options.ts` with no node imports); `runtime-server.ts` re-exports it (public surface unchanged).
  - `runtime-fetch-handler.ts`'s calls to `resolveThreadsStore`/`resolveCheckpointer`/`resolvePermissionsStore`/`resolveMemoryStore`/`resolveSandboxManager`/`loadMiddleware` become LAZY dynamic imports taken only on the fallback branches (when the corresponding option is absent). On the edge path every option is provided, so none of those imports execute — and per Step 1's esbuild config, dynamic imports still land in the metafile, so gate them behind a build-time-inert indirection: move the fallback resolution into a separate module `node-boot-fallbacks.ts` imported via `await import()`, and mark THAT specifier external-with-comment in the purity test (dynamic-only, never executed on edge — documented as the one allowed seam) — OR pass the fallbacks in as an optional `bootFallbacks` object from `runtime-server.ts` (preferred: zero externals; `createRuntimeFetchHandler` throws a clear error when a store is missing AND no fallbacks were provided — which is exactly the fail-loudly edge behavior the spec wants).

  **Choose the `bootFallbacks` design.** Concretely: `createRuntimeFetchHandler(options)` keeps its signature; `runtime-server.ts`/`serve-runtime.ts`/dev callers pass `bootFallbacks: nodeBootFallbacks` (a new export of `execute-route.ts` bundling the six resolvers); when a store option is absent and `bootFallbacks` is too, throw `new Error("<store>: no instance provided and this runtime has no filesystem fallback — pass one via options (see the edge deployment docs).")`. The purity test then needs zero externals for Dawn's own code, and `execute-route.ts` leaves the fetch graph entirely — `prepareRouteExecution` must therefore also split: move the pure request-path core (everything `prepareRouteExecution` does when caches are seeded + instances provided) into a new `execute-route-core.ts` with the node-only fallbacks staying in `execute-route.ts` which re-exports the core. This split is the largest single edit of the PR; do it as a pure MOVE (functions relocated verbatim, imports adjusted; `execute-route.ts` keeps every current export by re-exporting from the core so no other file changes).

- [ ] **Step 4: package.json exports + esbuild devDep**

```json
"./fetch": {
  "types": "./dist/fetch-exports.d.ts",
  "default": "./dist/fetch-exports.js"
}
```

`"esbuild": "^0.25.0"` under devDependencies (the purity test's own dep — NOT a runtime dependency).

- [ ] **Step 5: Functional proof** — extend the purity test file: bundle `fetch-exports.ts` to an in-memory ESM string, `import(dataUrl)` it, and boot `createRuntimeFetchHandler` from the BUNDLED module with a hand-built `DawnStaticModules` (from `buildStaticRouteModule`), injected in-memory stores (Task 6's), seeded config, and aimock — serve one AG-UI turn via `handler.fetch(new Request(...))` and assert the SSE body. This is "the edge runtime in miniature": bundled graph, no disk, no sqlite, no node server.

- [ ] **Step 6: Run everything** — purity + functional + full cli suite + `pnpm build && pnpm typecheck`. Zero existing-test edits (the execute-route split preserves every export).

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/fetch-exports.ts packages/cli/src/lib/ packages/cli/package.json packages/cli/test/fetch-entry-purity.test.ts
git commit -m "feat(cli): @dawn-ai/cli/fetch — node-free runtime entry, purity-gated by esbuild metafile test"
```

---

### Task 11: docs + changeset + full verification + PR

**Files:**
- Modify: `apps/web/content/docs/deployment.mdx` (short "Edge runtimes (preview)" note: the `./fetch` entry exists; full target lands in the next release)
- Create: `.changeset/edge-runtime-seams.md`
- Modify: `packages/cli/package.json` `files`/`pack` checks only if pack:check flags the new entry

- [ ] **Step 1: Changeset** (patch; confirm touched packages via `git log --oneline origin/main..HEAD --name-only -- packages/ | grep '^packages/' | cut -d/ -f2 | sort -u` — expect `cli` and `core`):

```md
---
"@dawn-ai/cli": patch
"@dawn-ai/core": patch
---

Runtime edge-readiness (deploy-anywhere B3, PR 1 of 3). New `@dawn-ai/cli/fetch`
entry exposes the web-standard runtime with a module graph containing zero
`node:` imports (enforced by an esbuild purity test). `serveRuntime`/
`startRuntimeServer`/`createRuntimeFetchHandler` accept injected checkpointer,
threads store, permissions store, memory store, middleware, and a DawnConfig
object (`seedDawnConfig`) — nothing reads disk or opens sqlite when everything
is supplied, including subagent turns. Capability markers read through a new
sync `MarkerFs` facade (node impl injected by the cli layer), the subagents
descriptor map is derived from the static module manifest with no dynamic
imports, and the static manifest now carries `src/middleware.ts`. Behavior with
nothing injected is unchanged.
```

- [ ] **Step 2: Docs** — one paragraph + code block in deployment.mdx under a new "Edge runtimes (preview)" heading showing `createRuntimeFetchHandler` from `@dawn-ai/cli/fetch` with injected stores. No banned phrases (`node scripts/check-docs.mjs` must pass).

- [ ] **Step 3: Full gates**

```bash
pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test && node scripts/check-docs.mjs && pnpm pack:check
pnpm verify:harness:runtime && pnpm verify:harness:smoke && pnpm verify:harness:framework
```

Expected: all green; monorepo test count = old baselines + this PR's new tests, zero existing edits.

- [ ] **Step 4: Rebase on origin/main, push, open PR**

Title: `feat(cli,core): runtime edge-readiness — injectable stores/config/middleware + node-free @dawn-ai/cli/fetch entry (deploy-anywhere B3, PR 1)`

Body: seams list, the purity-test gate, the subagent-threading fix, spy proof (zero sqlite opens end to end), invariant statement, link to spec. Watch `validate` + all lanes + review; fix findings; merge on green (controller drives this task, not a subagent).

- [ ] **Step 5: Commit any doc/changeset fixes, final push**

---

## Self-review notes (writing-plans checklist)

- **Spec coverage:** PR1 spec items — injection surface ✓ (T6), config seam ✓ (T5), descriptor-map closure ✓ (T4), markers through a facade ✓ (T1-T3; sync `MarkerFs` supersedes the spec's async-backends sketch because `promptFragment.render()` is sync — recorded as a design refinement), subagents description ✓ (T4), lazy workspace fs/offload ✓ (T7), middleware manifest ✓ (T8), `./fetch` entry ✓ (T9-T10). PR2/PR3 items are out of scope here (their plans follow).
- **Type consistency:** `MarkerFs` (T1) is the type used in T2/T3; `bootFallbacks`/`execute-route-core` split is named once (T10) and self-contained; `staticModules` on `BootResolvedInstances` introduced in T4 and reused in T6.
- **Known risk:** T10's execute-route split is the big one — it is spec'd as a verbatim MOVE with re-exports so the 505-test suite is the guard. If the split breaks any existing test, that is a defect in the split, not a reason to edit tests.
