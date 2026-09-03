# Edge Static Marker Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make skills, `plan.md`, and route `memory.md` work on the `hono` and `vercel` build targets by bundling their contents into the static module manifest and serving them through a pure `MarkerFs`.

**Architecture:** The web-runtime emitter already walks each route at build time; it will now also read the three marker file kinds and emit them as a per-route `markerFiles` map inside `modules.edge.mjs`, keyed by the same namespace paths the runtime derives from `routeFile`. A new `staticMarkerFs` in `@dawn-ai/core` implements the existing `MarkerFs` facade over that map, and the route-execution core threads it into `applyCapabilities` when no node boot fallbacks exist. The skills gate is removed from both the build gate and the request-time guard; the guard keeps failing closed for a manifest that records skill names without marker files.

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes`), pnpm workspace, Vitest, Biome, esbuild (tests only), aimock from `@dawn-ai/testing`.

**Spec:** `docs/superpowers/specs/2026-09-03-edge-static-marker-files-design.md`

**Working tree:** `/Users/blove/repos/dawn/.worktrees/edge-static-marker-files` on branch `blove/edge-static-marker-files`. Run every command from that directory. The worktree is installed and built; after any change under `packages/core/src` run `pnpm --filter @dawn-ai/core build` before running `packages/cli` tests, because CLI tests import core through `dist/`.

**Conventions that bite (from `AGENTS.md`):**
- `src/` imports use `.js` extensions; `test/` imports use `.ts` or `.js` as the neighboring tests do.
- Never `{ x: undefined }` for an optional field; use a conditional spread.
- Never run bare `biome check --write`; use `pnpm lint` or `pnpm lint:fix`.
- Changesets are patch-only on 0.x.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/static-marker-fs.ts` (new) | Pure `MarkerFs` over an in-memory path-to-content map. No `node:` imports. |
| `packages/core/src/index.ts` | Export `staticMarkerFs` and `StaticMarkerFiles`. |
| `packages/core/test/static-marker-fs.test.ts` (new) | Unit tests for the facade. |
| `packages/core/test/capabilities/markers-marker-fs.test.ts` | One case proving the skills, planning, and memory-md markers behave the same over `staticMarkerFs` as over `nodeMarkerFs`. |
| `packages/cli/src/lib/build/targets/marker-files.ts` (new) | Build-time reader for a route's marker files with per-kind size limits. Node-only. |
| `packages/cli/src/lib/build/targets/modules-emitter.ts` | `RouteStaticDiscovery.markerFiles`; `collectRouteStaticDiscovery` reads them when asked; `emitModulesFileWithFlavor` emits them when present. |
| `packages/cli/src/lib/build/targets/web-runtime.ts` | Ask discovery for marker files. |
| `packages/cli/src/lib/build/targets/edge-capabilities.ts` | Remove the skills violation. |
| `packages/cli/src/lib/runtime/static-modules-core.ts` | `markerFiles` on `StaticRouteModuleInput` and `StaticRouteModule`; `staticModulesMarkerFiles()` union helper. |
| `packages/cli/src/lib/runtime/execute-route-core.ts` | Thread a cached `staticMarkerFs` into `applyCapabilities` when there are no fallbacks. |
| `packages/cli/src/lib/runtime/edge-capability-report.ts` | Skills clause keys on "skills recorded and no marker files". |
| `packages/cli/test/...` | Emitter, guard, target, and equivalence tests. |
| `apps/web/content/docs/{deployment/edge,cli,faq,upgrading}.mdx` | Doc updates. |
| `.changeset/edge-static-marker-files.md` (new) | Patch changeset. |

---

### Task 0: Amend the spec's size limit

**Files:**
- Modify: `docs/superpowers/specs/2026-09-03-edge-static-marker-files-design.md`

The runtime limits are not uniform: `planning.ts` uses `MAX_PLAN_BYTES = 64 * 1024`, `memory-md.ts` uses `MAX_MEMORY_BYTES = 32 * 1024`, and skills have no runtime limit. The build limit must match each marker, so the spec's "32 KiB" wording is corrected before code follows it.

- [x] **Step 1: Replace the limit wording**

In the spec, find the paragraph in "Design → Build side" item 2 that begins `Each bundled file is limited to 32 KiB` and replace the whole item with:

```markdown
2. Each bundled file is limited to the size its marker enforces at runtime:
   `plan.md` 64 KiB (`MAX_PLAN_BYTES` in `planning.ts`), `memory.md` 32 KiB
   (`MAX_MEMORY_BYTES` in `memory-md.ts`), and `SKILL.md` 32 KiB, which is a
   new limit because the skills marker reads eagerly with no cap. A file over
   its limit fails the build with `DAWN_E1005`, naming the file and its size,
   before any artifact is written. This keeps the property that a green build
   never ships a silently disabled feature.
```

Also in "Goals", change `Bundle growth is bounded by an explicit per-file limit that matches the runtime limit the markers already apply.` to `Bundle growth is bounded by explicit per-file limits that match the limits the markers already apply at runtime.`

In "Error Handling", change `A marker file over 32 KiB fails the build` to `A marker file over its limit fails the build`.

In "Documentation", change `with a 32 KiB per-file limit` to `with per-file limits of 32 KiB for SKILL.md and memory.md and 64 KiB for plan.md`.

In "Testing and Verification", change `a fixture with a 33 KiB SKILL.md fails` to `a fixture with a SKILL.md one byte over 32 KiB fails`.

- [x] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-09-03-edge-static-marker-files-design.md
git commit -m "docs: match marker file limits to each marker's runtime limit"
```

---

### Task 1: `staticMarkerFs` in `@dawn-ai/core`

**Files:**
- Create: `packages/core/src/static-marker-fs.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/static-marker-fs.test.ts`

- [x] **Step 1: Write the failing test**

Create `packages/core/test/static-marker-fs.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { staticMarkerFs } from "../src/static-marker-fs.js"

const files = {
  "/app/src/app/chat/memory.md": "remember: be brief",
  "/app/src/app/chat/plan.md": "- [ ] first\n- [ ] second\n",
  "/app/src/app/chat/skills/cite-sources/SKILL.md": "---\ndescription: Cite.\n---\n\nCite. ✓",
  "/app/src/app/chat/skills/synthesize/SKILL.md": "---\ndescription: Synth.\n---\n\nSynth.",
} as const

describe("staticMarkerFs", () => {
  const fs = staticMarkerFs(files)

  it("reports files by exact key", () => {
    expect(fs.existsSync("/app/src/app/chat/plan.md")).toBe(true)
    expect(fs.readFileSync("/app/src/app/chat/plan.md")).toBe("- [ ] first\n- [ ] second\n")
    expect(fs.isDirectorySync("/app/src/app/chat/plan.md")).toBe(false)
  })

  it("reports byte sizes, not character counts", () => {
    const content = files["/app/src/app/chat/skills/cite-sources/SKILL.md"]
    expect(fs.statSizeSync("/app/src/app/chat/skills/cite-sources/SKILL.md")).toBe(
      new TextEncoder().encode(content).byteLength,
    )
    expect(fs.statSizeSync("/app/src/app/chat/skills")).toBeUndefined()
    expect(fs.statSizeSync("/nope")).toBeUndefined()
  })

  it("derives directories from key prefixes", () => {
    expect(fs.existsSync("/app/src/app/chat/skills")).toBe(true)
    expect(fs.isDirectorySync("/app/src/app/chat/skills")).toBe(true)
    expect(fs.isDirectorySync("/app/src/app/chat/skills/")).toBe(true)
    expect(fs.isDirectorySync("/app/src/app/chat/skills/cite-sources")).toBe(true)
    expect(fs.readFileSync("/app/src/app/chat/skills")).toBeUndefined()
  })

  it("does not treat a key's string prefix as a directory", () => {
    // "/app/src/app/chat/ski" is a prefix of a key but not a path segment boundary.
    expect(fs.existsSync("/app/src/app/chat/ski")).toBe(false)
    expect(fs.isDirectorySync("/app/src/app/chat/ski")).toBe(false)
  })

  it("lists sorted immediate children of a directory", () => {
    expect(fs.readdirSync("/app/src/app/chat/skills")).toEqual(["cite-sources", "synthesize"])
    expect(fs.readdirSync("/app/src/app/chat")).toEqual(["memory.md", "plan.md", "skills"])
    expect(fs.readdirSync("/app/src/app/chat/skills/cite-sources")).toEqual(["SKILL.md"])
  })

  it("returns empty or undefined for misses and files used as directories", () => {
    expect(fs.readdirSync("/app/src/app/chat/plan.md")).toEqual([])
    expect(fs.readdirSync("/missing")).toEqual([])
    expect(fs.existsSync("/missing")).toBe(false)
    expect(fs.readFileSync("/missing")).toBeUndefined()
  })

  it("never throws, even on odd input", () => {
    for (const path of ["", "/", "//", "/app/", "/app/src/app/chat/skills//"]) {
      expect(() => fs.existsSync(path)).not.toThrow()
      expect(() => fs.isDirectorySync(path)).not.toThrow()
      expect(() => fs.statSizeSync(path)).not.toThrow()
      expect(() => fs.readFileSync(path)).not.toThrow()
      expect(() => fs.readdirSync(path)).not.toThrow()
    }
  })

  it("serves an empty map as an empty filesystem", () => {
    const empty = staticMarkerFs({})
    expect(empty.existsSync("/anything")).toBe(false)
    expect(empty.readdirSync("/")).toEqual([])
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @dawn-ai/core exec vitest --run --config vitest.config.ts test/static-marker-fs.test.ts`
Expected: FAIL with "Cannot find module '../src/static-marker-fs.js'" (or equivalent resolution error).

- [x] **Step 3: Write the implementation**

Create `packages/core/src/static-marker-fs.ts`:

```ts
import type { MarkerFs } from "./capabilities/types.js"

/**
 * Absolute namespace paths to UTF-8 contents. Keys are the same strings the
 * capability markers compute with `pureJoin(routeDir, …)`, where `routeDir`
 * is `pureDirname(routeFile)` — on an edge manifest an opaque `/<app-name>/…`
 * namespace, never a build-machine path.
 */
export type StaticMarkerFiles = Readonly<Record<string, string>>

const encoder = new TextEncoder()

function normalize(path: string): string {
  // The markers join with pure helpers, so the only variation a caller can
  // introduce is a trailing separator. Strip it; keep "/" as the root.
  let end = path.length
  while (end > 1 && path[end - 1] === "/") end -= 1
  return path.slice(0, end)
}

/**
 * A `MarkerFs` over an in-memory map, for runtimes with no filesystem.
 *
 * Directories are implied by keys: `/a/b/c.md` makes `/a` and `/a/b`
 * directories. Every method is total — a miss reads exactly as it does on
 * disk, so the markers' own size and parse rules run unchanged.
 */
export function staticMarkerFs(files: StaticMarkerFiles): MarkerFs {
  const entries = new Map<string, string>()
  for (const [key, content] of Object.entries(files)) {
    if (typeof content === "string") entries.set(normalize(key), content)
  }
  const keys = [...entries.keys()]

  const isDirectory = (path: string): boolean => {
    if (path === "/") return keys.length > 0
    const prefix = `${path}/`
    return keys.some((key) => key.startsWith(prefix))
  }

  return {
    existsSync: (path) => {
      const p = normalize(path)
      return entries.has(p) || isDirectory(p)
    },
    isDirectorySync: (path) => {
      const p = normalize(path)
      return !entries.has(p) && isDirectory(p)
    },
    statSizeSync: (path) => {
      const content = entries.get(normalize(path))
      return content === undefined ? undefined : encoder.encode(content).byteLength
    },
    readFileSync: (path) => entries.get(normalize(path)),
    readdirSync: (path) => {
      const p = normalize(path)
      if (entries.has(p)) return []
      const prefix = p === "/" ? "/" : `${p}/`
      const names = new Set<string>()
      for (const key of keys) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const slash = rest.indexOf("/")
        const name = slash === -1 ? rest : rest.slice(0, slash)
        if (name.length > 0) names.add(name)
      }
      return [...names].sort()
    },
  }
}
```

- [x] **Step 4: Export from the barrel**

In `packages/core/src/index.ts`, directly after the line `export { createWorkspaceFs } from "./capabilities/workspace-fs.js"`, add:

```ts
export type { StaticMarkerFiles } from "./static-marker-fs.js"
export { staticMarkerFs } from "./static-marker-fs.js"
```

- [x] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @dawn-ai/core exec vitest --run --config vitest.config.ts test/static-marker-fs.test.ts`
Expected: PASS, 8 tests.

- [x] **Step 6: Build core and typecheck**

Run: `pnpm --filter @dawn-ai/core build && pnpm --filter @dawn-ai/core typecheck`
Expected: both exit 0.

- [x] **Step 7: Commit**

```bash
git add packages/core/src/static-marker-fs.ts packages/core/src/index.ts packages/core/test/static-marker-fs.test.ts
git commit -m "feat(core): add staticMarkerFs, a MarkerFs over an in-memory map"
```

---

### Task 2: Prove the markers behave the same over `staticMarkerFs`

**Files:**
- Modify: `packages/core/test/capabilities/markers-marker-fs.test.ts`

This is the guarantee the whole change rests on: the markers do not change, so the only thing to prove is that the facade is indistinguishable from disk for the three markers.

- [x] **Step 1: Add the failing test**

At the top of `packages/core/test/capabilities/markers-marker-fs.test.ts`, add the import after the existing `nodeMarkerFs` import:

```ts
import { staticMarkerFs } from "../../src/static-marker-fs.js"
```

At the end of the file (after the last `})` of the top-level `describe`), add:

```ts
describe("staticMarkerFs is indistinguishable from nodeMarkerFs for the bundled markers", () => {
  const ROUTE_DIR = "/ns/src/app/chat"
  const PLAN = "- [ ] Restate the question\n- [x] Search the corpus\n"
  const MEMORY = "Prefer short answers."
  const SKILL = "---\ndescription: How to cite.\n---\n\nAlways cite [path]."

  const files = {
    [`${ROUTE_DIR}/memory.md`]: MEMORY,
    [`${ROUTE_DIR}/plan.md`]: PLAN,
    [`${ROUTE_DIR}/skills/cite-sources/SKILL.md`]: SKILL,
  }
  const ctx = makeCtx("/ns", staticMarkerFs(files))

  it("skills: detects, lists in the prompt, and serves the body through readSkill", async () => {
    const marker = createSkillsMarker()
    expect(await marker.detect(ROUTE_DIR, ctx)).toBe(true)
    const contribution = await marker.load(ROUTE_DIR, ctx)
    expect(contribution.promptFragment?.render()).toContain("- **cite-sources** — How to cite.")
    const readSkill = contribution.tools?.find((t) => t.name === "readSkill")
    expect(await readSkill?.run({ name: "cite-sources" })).toBe("Always cite [path].")
  })

  it("planning: seeds todos from plan.md", async () => {
    const marker = createPlanningMarker()
    expect(await marker.detect(ROUTE_DIR, ctx)).toBe(true)
    const contribution = await marker.load(ROUTE_DIR, ctx)
    const todos = contribution.stateFields?.find((f) => f.name === "todos")
    expect(todos?.default).toEqual([
      { content: "Restate the question", status: "pending" },
      { content: "Search the corpus", status: "completed" },
    ])
  })

  it("memory-md: renders the route memory block", async () => {
    const marker = createMemoryMdMarker()
    expect(await marker.detect(ROUTE_DIR, ctx)).toBe(true)
    const contribution = await marker.load(ROUTE_DIR, ctx)
    expect(contribution.promptFragment?.render()).toContain("# Route Memory")
    expect(contribution.promptFragment?.render()).toContain(MEMORY)
  })

  it("none of them detect when the map has no files under the route", async () => {
    const empty = makeCtx("/ns", staticMarkerFs({}))
    expect(await createSkillsMarker().detect(ROUTE_DIR, empty)).toBe(false)
    expect(await createPlanningMarker().detect(ROUTE_DIR, empty)).toBe(false)
    expect(await createMemoryMdMarker().detect(ROUTE_DIR, empty)).toBe(false)
  })
})
```

The `status` strings come from `packages/core/src/capabilities/built-in/plan-md-parser.ts`, which maps `[ ]` to `"pending"` and anything else to `"completed"`.

- [x] **Step 2: Run the test**

Run: `pnpm --filter @dawn-ai/core exec vitest --run --config vitest.config.ts test/capabilities/markers-marker-fs.test.ts`
Expected: PASS. Any failure means the facade is wrong; fix `static-marker-fs.ts`, not the test.

- [x] **Step 3: Commit**

```bash
git add packages/core/test/capabilities/markers-marker-fs.test.ts
git commit -m "test(core): markers behave identically over staticMarkerFs"
```

---

### Task 3: Build-time marker file reader with per-kind limits

**Files:**
- Create: `packages/cli/src/lib/build/targets/marker-files.ts`
- Test: `packages/cli/test/marker-files.test.ts`

- [x] **Step 1: Write the failing test**

Create `packages/cli/test/marker-files.test.ts`:

```ts
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  collectRouteMarkerFiles,
  MARKER_FILE_LIMITS,
} from "../src/lib/build/targets/marker-files.js"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function routeDir(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "dawn-marker-files-")))
  cleanup.push(() => rm(dir, { force: true, maxRetries: 5, recursive: true }))
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(dir, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return dir
}

describe("collectRouteMarkerFiles", () => {
  it("returns undefined for a route with no marker files", async () => {
    const dir = await routeDir({ "index.ts": "export default {}\n" })
    expect(await collectRouteMarkerFiles(dir)).toBeUndefined()
  })

  it("reads plan.md, memory.md, and every discovered SKILL.md, keyed route-relative", async () => {
    const dir = await routeDir({
      "memory.md": "mem",
      "plan.md": "- [ ] one\n",
      "skills/b-skill/SKILL.md": "---\ndescription: B.\n---\nB",
      "skills/a-skill/SKILL.md": "---\ndescription: A.\n---\nA",
      "skills/not-a-skill/README.md": "ignored",
      "skills/.hidden/SKILL.md": "ignored: not identifier-shaped",
    })
    expect(await collectRouteMarkerFiles(dir)).toEqual([
      { content: "mem", relativePath: "memory.md" },
      { content: "- [ ] one\n", relativePath: "plan.md" },
      { content: "---\ndescription: A.\n---\nA", relativePath: "skills/a-skill/SKILL.md" },
      { content: "---\ndescription: B.\n---\nB", relativePath: "skills/b-skill/SKILL.md" },
    ])
  })

  it("fails by name when a file exceeds its marker's limit", async () => {
    const dir = await routeDir({
      "skills/big/SKILL.md": "x".repeat(MARKER_FILE_LIMITS["SKILL.md"] + 1),
    })
    const error = await collectRouteMarkerFiles(dir).catch((e: unknown) => e)
    expect(String(error)).toContain("skills/big/SKILL.md")
    expect(String(error)).toContain(String(MARKER_FILE_LIMITS["SKILL.md"] + 1))
    expect((error as { code?: string }).code).toBe("DAWN_E1005")
  })

  it("allows a file exactly at its limit", async () => {
    const dir = await routeDir({ "plan.md": "x".repeat(MARKER_FILE_LIMITS["plan.md"]) })
    const found = await collectRouteMarkerFiles(dir)
    expect(found?.[0]?.relativePath).toBe("plan.md")
  })

  it("uses the per-kind limits the markers enforce at runtime", () => {
    expect(MARKER_FILE_LIMITS).toEqual({
      "SKILL.md": 32 * 1024,
      "memory.md": 32 * 1024,
      "plan.md": 64 * 1024,
    })
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/marker-files.test.ts`
Expected: FAIL, module not found.

- [x] **Step 3: Write the implementation**

Create `packages/cli/src/lib/build/targets/marker-files.ts`:

```ts
import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import { CliError } from "../../output.js"
import { discoverSkillDirs } from "./edge-capabilities.js"

/** One marker file bundled into an edge manifest. */
export interface RouteMarkerFile {
  /** Route-relative, forward-slashed: `plan.md`, `memory.md`, `skills/<name>/SKILL.md`. */
  readonly relativePath: string
  readonly content: string
}

/**
 * Byte limits per marker kind. `plan.md` and `memory.md` match the runtime
 * limits in `@dawn-ai/core`'s planning and memory-md markers; `SKILL.md` is a
 * new limit because the skills marker reads eagerly with no cap.
 */
export const MARKER_FILE_LIMITS = {
  "SKILL.md": 32 * 1024,
  "memory.md": 32 * 1024,
  "plan.md": 64 * 1024,
} as const

type MarkerKind = keyof typeof MARKER_FILE_LIMITS

async function readMarkerFile(
  routeDir: string,
  relativePath: string,
  kind: MarkerKind,
): Promise<RouteMarkerFile> {
  const absolute = join(routeDir, ...relativePath.split("/"))
  const size = (await stat(absolute)).size
  const limit = MARKER_FILE_LIMITS[kind]
  if (size > limit) {
    throw new CliError(
      `Marker file ${relativePath} is ${size} bytes, over the ${limit}-byte limit for ${kind}. ` +
        `Edge targets bundle marker files into the static module manifest, so the limit the ` +
        `runtime applies is enforced at build time. Shorten the file or split the skill.`,
      1,
      { code: "DAWN_E1005" },
    )
  }
  return { content: await readFile(absolute, "utf8"), relativePath }
}

/**
 * Every marker file an edge manifest must carry for one route, in a stable
 * order, or `undefined` when the route has none. Read failures propagate: a
 * present-but-unreadable file must fail the build, never ship a manifest
 * without it.
 */
export async function collectRouteMarkerFiles(
  routeDir: string,
): Promise<readonly RouteMarkerFile[] | undefined> {
  const found: RouteMarkerFile[] = []
  if (existsSync(join(routeDir, "memory.md"))) {
    found.push(await readMarkerFile(routeDir, "memory.md", "memory.md"))
  }
  if (existsSync(join(routeDir, "plan.md"))) {
    found.push(await readMarkerFile(routeDir, "plan.md", "plan.md"))
  }
  for (const name of [...discoverSkillDirs(join(routeDir, "skills"))].sort()) {
    found.push(await readMarkerFile(routeDir, `skills/${name}/SKILL.md`, "SKILL.md"))
  }
  return found.length > 0 ? found : undefined
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/marker-files.test.ts`
Expected: PASS, 5 tests.

- [x] **Step 5: Commit**

```bash
git add packages/cli/src/lib/build/targets/marker-files.ts packages/cli/test/marker-files.test.ts
git commit -m "feat(cli): read route marker files with per-kind limits at build time"
```

---

### Task 4: Carry marker files through the static module types

**Files:**
- Modify: `packages/cli/src/lib/runtime/static-modules-core.ts`
- Test: `packages/cli/test/static-modules-marker-files.test.ts` (new)

- [x] **Step 1: Write the failing test**

Create `packages/cli/test/static-modules-marker-files.test.ts`:

```ts
import { agent } from "@dawn-ai/sdk"
import { describe, expect, it } from "vitest"

import {
  buildStaticRouteModule,
  staticModulesMarkerFiles,
} from "../src/lib/runtime/static-modules-core.js"

const agentModule = { default: agent({ model: "gpt-5-mini", systemPrompt: "hi" }) }

function route(routeId: string, markerFiles?: Readonly<Record<string, string>>) {
  return buildStaticRouteModule({
    kind: "agent",
    ...(markerFiles ? { markerFiles } : {}),
    routeFile: `/ns/src/app${routeId}/index.ts`,
    routeId,
    routeModule: agentModule,
    routePath: `src/app${routeId}/index.ts`,
    tools: [],
  })
}

describe("static modules — marker files", () => {
  it("keeps a route's markerFiles on the built module and omits the key when absent", () => {
    const withFiles = route("/chat", { "/ns/src/app/chat/plan.md": "- [ ] a\n" })
    expect(withFiles.markerFiles).toEqual({ "/ns/src/app/chat/plan.md": "- [ ] a\n" })
    expect("markerFiles" in route("/zeta")).toBe(false)
    expect("markerFiles" in route("/zeta", {})).toBe(false)
  })

  it("unions every route's files and returns undefined when no route has any", () => {
    const modules = {
      routes: [
        route("/chat", { "/ns/src/app/chat/plan.md": "p" }),
        route("/zeta"),
        route("/research", { "/ns/src/app/research/skills/x/SKILL.md": "s" }),
      ],
    }
    expect(staticModulesMarkerFiles(modules)).toEqual({
      "/ns/src/app/chat/plan.md": "p",
      "/ns/src/app/research/skills/x/SKILL.md": "s",
    })
    expect(staticModulesMarkerFiles({ routes: [route("/zeta")] })).toBeUndefined()
    expect(staticModulesMarkerFiles({ routes: [] })).toBeUndefined()
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/static-modules-marker-files.test.ts`
Expected: FAIL, `staticModulesMarkerFiles` is not exported.

- [x] **Step 3: Add the field and the helper**

In `packages/cli/src/lib/runtime/static-modules-core.ts`:

In `StaticRouteModule`, directly after the `readonly skills?: readonly string[]` member, add:

```ts
  /**
   * Marker file contents this route had at BUILD time, keyed by the absolute
   * namespace path the capability markers compute (`pureJoin(routeDir, …)`
   * with `routeDir = pureDirname(routeFile)`). Emitted only by the edge
   * manifest flavors, which have no filesystem to read `skills/`, `plan.md`,
   * or `memory.md` from at request time; the node manifest never carries it.
   * Absent when the route has no marker files.
   */
  readonly markerFiles?: Readonly<Record<string, string>>
```

In `StaticRouteModuleInput`, directly after `readonly kind: RouteKind`, add:

```ts
  readonly markerFiles?: Readonly<Record<string, string>>
```

In `buildStaticRouteModule`'s returned object, directly after the `skills` conditional spread, add:

```ts
    ...(input.markerFiles && Object.keys(input.markerFiles).length > 0
      ? { markerFiles: input.markerFiles }
      : {}),
```

After the `buildStaticRouteModule` function, add:

```ts
/**
 * Every route's bundled marker files as one map, or `undefined` when no route
 * carries any — the input `staticMarkerFs` takes. Routes never share a
 * directory, so keys cannot collide.
 */
export function staticModulesMarkerFiles(
  modules: Pick<DawnStaticModules, "routes">,
): Readonly<Record<string, string>> | undefined {
  let union: Record<string, string> | undefined
  for (const route of modules.routes) {
    if (!route.markerFiles) continue
    union ??= {}
    Object.assign(union, route.markerFiles)
  }
  return union
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/static-modules-marker-files.test.ts`
Expected: PASS, 2 tests.

- [x] **Step 5: Typecheck the CLI**

Run: `pnpm --filter @dawn-ai/cli typecheck`
Expected: exit 0.

- [x] **Step 6: Commit**

```bash
git add packages/cli/src/lib/runtime/static-modules-core.ts packages/cli/test/static-modules-marker-files.test.ts
git commit -m "feat(cli): carry per-route marker files on static route modules"
```

---

### Task 5: Emit marker files in the edge manifest

**Files:**
- Modify: `packages/cli/src/lib/build/targets/modules-emitter.ts`
- Modify: `packages/cli/src/lib/build/targets/web-runtime.ts`
- Test: `packages/cli/test/edge-modules-emitter.test.ts`
- Test: `packages/cli/test/modules-emitter.test.ts`

- [x] **Step 1: Write the failing edge emitter test**

`packages/cli/test/edge-modules-emitter.test.ts` has a golden inline snapshot of the whole emitted manifest for its shared `fixtureApp()`. Leave that fixture and `collectFixtureDiscoveries` untouched so the snapshot stays valid; the existing `collectFixtureDiscoveries` (which does not ask for marker files) doubles as proof that the emitter omits `markerFiles` when discovery did not collect them.

Add a new `describe` at the end of the file with its own fixture and discovery helper:

```ts
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
    const text = emitEdgeModulesFile({ appRoot, buildDir: join(appRoot, ".dawn", "build"), discoveries })
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
})
```

Add these imports at the top of `edge-modules-emitter.test.ts` (merge with the existing `node:fs/promises` import and add the others):

```ts
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { edgeAppNamespace, emitEdgeModulesFile } from "../src/lib/build/targets/edge-modules-emitter.js"
import { loadStaticModules } from "../src/lib/runtime/static-modules.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
```

(Replace the existing `import { join } from "node:path"` and the existing `emitEdgeModulesFile` import with the lines above.)

- [x] **Step 2: Write the failing node-emitter regression test**

In `packages/cli/test/modules-emitter.test.ts`, inside `describe("emitModulesFile — route skills", ...)`, add a second `it` after the existing one:

```ts
  it("never inlines marker file contents into the node manifest", async () => {
    const appRoot = await skillsFixtureApp()
    const discoveries = await collectFixtureDiscoveries(appRoot)
    expect(discoveries.every((entry) => entry.markerFiles === undefined)).toBe(true)
    const buildDir = join(appRoot, ".dawn", "build")
    const text = emitModulesFile({ appRoot, buildDir, discoveries })
    expect(text).not.toContain("markerFiles")
    expect(text).not.toContain("Cite.")
  })
```

- [x] **Step 3: Run both tests to verify they fail**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/edge-modules-emitter.test.ts test/modules-emitter.test.ts`
Expected: the two new edge cases FAIL (no `markerFiles` in output; `markerFiles` is not an accepted option). The node regression case passes already; keep it.

- [x] **Step 4: Extend discovery and the emitter**

In `packages/cli/src/lib/build/targets/modules-emitter.ts`:

Add the import after the `discoverSkillDirs` import:

```ts
import { collectRouteMarkerFiles, type RouteMarkerFile } from "./marker-files.js"
```

In `RouteStaticDiscovery`, after the `skills` member, add:

```ts
  /**
   * Marker file contents (`plan.md`, `memory.md`, `skills/<name>/SKILL.md`),
   * route-relative. Collected only when `collectRouteStaticDiscovery` is asked
   * for them — the edge flavors, which have no filesystem at request time. The
   * node manifest never carries bodies; it reads them from disk.
   */
  readonly markerFiles?: readonly RouteMarkerFile[]
```

Change the `collectRouteStaticDiscovery` signature and body:

```ts
export async function collectRouteStaticDiscovery(options: {
  readonly appRoot: string
  readonly route: RouteDefinition
  /** Read marker file bodies too (edge flavors only). */
  readonly markerFiles?: boolean
}): Promise<RouteStaticDiscovery> {
```

and, just before the `return {` at the end of that function, add:

```ts
  const markerFiles = options.markerFiles
    ? await collectRouteMarkerFiles(route.routeDir)
    : undefined
```

and in the returned object, after the `skills` conditional spread, add:

```ts
    ...(markerFiles ? { markerFiles } : {}),
```

In `emitModulesFileWithFlavor`, after the `if (discovery.skills && discovery.skills.length > 0) { ... }` block, add:

```ts
    // Marker bodies, keyed by the SAME namespace path the runtime computes
    // (`pureJoin(pureDirname(routeFile), …)`), so a key the markers ask for
    // and a key the build wrote are the same string. `Object.fromEntries`
    // over an array, not an object literal: a "__proto__" key can never
    // perform a prototype assignment this way, and every key/value goes
    // through JSON.stringify so no content can break out of its literal.
    if (discovery.markerFiles && discovery.markerFiles.length > 0) {
      const routeDirRelative = appRootRelative(appRoot, dirname(discovery.entryFile))
      const entries = discovery.markerFiles.map(
        (file) =>
          `        [${flavor.appRootPathExpression(`${routeDirRelative}/${file.relativePath}`)}, ${JSON.stringify(file.content)}],`,
      )
      lines.push(`      markerFiles: Object.fromEntries([`)
      lines.push(...entries)
      lines.push(`      ]),`)
    }
```

Add `dirname` to the existing `node:path` import in that file:

```ts
import { dirname, join, relative, sep } from "node:path"
```

In `packages/cli/src/lib/build/targets/web-runtime.ts`, change the discovery loop to request marker files:

```ts
  for (const route of manifest.routes) {
    discoveries.push(await collectRouteStaticDiscovery({ appRoot, markerFiles: true, route }))
  }
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/edge-modules-emitter.test.ts test/modules-emitter.test.ts`
Expected: PASS, including the untouched golden inline snapshot (its fixture has no marker files, so its output is byte-for-byte unchanged).

- [x] **Step 6: Commit**

```bash
git add packages/cli/src/lib/build/targets/modules-emitter.ts packages/cli/src/lib/build/targets/web-runtime.ts packages/cli/test/edge-modules-emitter.test.ts packages/cli/test/modules-emitter.test.ts
git commit -m "feat(cli): bundle route marker files into the edge static manifest"
```

---

### Task 6: Serve the bundled files at request time

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route-core.ts`
- Modify: `packages/cli/src/lib/runtime/edge-capability-report.ts`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts`
- Test: `packages/cli/test/runtime-capability-guards.test.ts`

- [x] **Step 1: Write the failing guard tests**

In `packages/cli/test/runtime-capability-guards.test.ts`, replace the existing `it("names the route's skills, which otherwise vanish from the prompt in silence", ...)` case with these two:

```ts
  it("names the route's skills when the manifest records names but bundles no bodies", () => {
    // A hand-composed manifest, or one built before marker files were bundled:
    // the skills capability's `detect` would return false and the skills would
    // vanish from the prompt with nothing to report.
    const found = gaps({
      routes: [{ routeId: "/research", skills: ["synthesize-findings", "cite-sources"] }],
    })

    expect(found).toHaveLength(1)
    expect(found[0]?.capability).toContain("skills")
    expect(found[0]?.capability).toContain("cite-sources")
    expect(found[0]?.capability).toContain("synthesize-findings")
    expect(found[0]?.source).toContain("/research")
  })

  it("does not report skills whose bodies the manifest bundles", () => {
    const found = gaps({
      routes: [
        {
          markerFiles: { "/ns/src/app/research/skills/cite-sources/SKILL.md": "…" },
          routeId: "/research",
          skills: ["cite-sources"],
        },
      ],
    })

    expect(found).toEqual([])
  })
```

In the `"reports every gap at once"` case in the same file, the `/research` route has skills and no `markerFiles`, so it still reports; leave it unchanged.

- [x] **Step 2: Run the guard tests to verify the new one fails**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/runtime-capability-guards.test.ts`
Expected: the "does not report skills whose bodies the manifest bundles" case FAILS (one violation reported), and the compiler may reject `markerFiles` on the input type.

- [x] **Step 3: Update the request-time guard**

In `packages/cli/src/lib/runtime/edge-capability-report.ts`, in `RuntimeCapabilityInput.routes`, add a member after `skills`:

```ts
    /** Bundled marker file bodies (see StaticRouteModule.markerFiles); their presence serves the skills. */
    readonly markerFiles?: Readonly<Record<string, string>>
```

Change the skills loop in `collectRuntimeCapabilityGaps`:

```ts
  for (const route of input.routes) {
    const skills = route.skills
    if (!skills || skills.length === 0) continue
    if (route.markerFiles && Object.keys(route.markerFiles).length > 0) continue
    violations.push({
      capability: `skills (${[...skills].sort().join(", ")})`,
      source: `the skills/ directory of route "${route.routeId}", recorded in the static module manifest at build time`,
      reason:
        "skill bodies are read from disk when the route loads, and this runtime has no filesystem " +
        "to read them from — the manifest records the skill names but bundles no bodies, so the " +
        "skills would vanish from the prompt with no error at all",
      remedy:
        "Rebuild with `dawn build` so the manifest bundles the skill bodies, or inline the instructions into the route's `systemPrompt`",
    })
  }
```

- [x] **Step 4: Thread a static MarkerFs into route preparation**

In `packages/cli/src/lib/runtime/execute-route-core.ts`:

Add to the imports from `@dawn-ai/core` (find the existing `import { ... } from "@dawn-ai/core"` and add `staticMarkerFs`), and add `type MarkerFs` if it is not already imported. Add to the import from `./static-modules-core.js` the name `staticModulesMarkerFiles`.

Near `getCachedStaticDescriptorMaps` (search for that function), add:

```ts
/**
 * One `MarkerFs` per manifest, built on first use. The manifest is immutable
 * and process-wide, so the cache is a WeakMap keyed on it — never rebuilt per
 * request, never leaked past the manifest's lifetime.
 */
const staticMarkerFsCache = new WeakMap<DawnStaticModules, MarkerFs | null>()

function getStaticMarkerFs(modules: DawnStaticModules | undefined): MarkerFs | undefined {
  if (!modules) return undefined
  let cached = staticMarkerFsCache.get(modules)
  if (cached === undefined) {
    const files = staticModulesMarkerFiles(modules)
    cached = files ? staticMarkerFs(files) : null
    staticMarkerFsCache.set(modules, cached)
  }
  return cached ?? undefined
}
```

At the `applyCapabilities` call, replace:

```ts
      ...(fallbacks ? { markerFs: fallbacks.markerFs } : {}),
```

with:

```ts
      // Node reads markers from disk. A runtime with no fallbacks serves them
      // from the manifest instead — the build bundled `skills/`, `plan.md`,
      // and `memory.md` there precisely because there is no disk to read.
      ...((): { readonly markerFs?: MarkerFs } => {
        const markerFs = fallbacks ? fallbacks.markerFs : getStaticMarkerFs(options.staticModules)
        return markerFs ? { markerFs } : {}
      })(),
```

Update the comment block above (the "DEGRADES to a documented default" list, `markerFs` entry) to read:

```ts
 *   - `markerFs`              → the manifest's bundled marker files when it
 *                               carries any (`staticMarkerFs`), else omitted
 *                               from `applyCapabilities`; an absent MarkerFs
 *                               means "no filesystem" by contract, so the
 *                               disk-backed markers contribute nothing
```

Also find the line in the same header comment that reads `*   - route \`skills/\`         → contribute nothing without a \`markerFs\`. A` and update that entry to say the edge manifest supplies one when the build bundled the files.

`runtime-fetch-core.ts` needs no change: it already passes `options.modules?.routes` (which now carry `markerFiles`) to `collectRuntimeCapabilityGaps`, and `staticModules` reaches `execute-route-core` through `BootResolvedInstances`.

- [x] **Step 5: Run the guard tests and typecheck**

Run: `pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/runtime-capability-guards.test.ts test/edge-runtime-diagnostics.test.ts`
Expected: typecheck exit 0; both suites PASS unchanged. `edge-runtime-diagnostics.test.ts` injects `skills: ["cite-sources"]` onto built routes with no `markerFiles`, which is exactly the case that must still raise, and it asserts only that the message contains "skills".

- [x] **Step 6: Commit**

```bash
git add packages/cli/src/lib/runtime/execute-route-core.ts packages/cli/src/lib/runtime/edge-capability-report.ts packages/cli/test/runtime-capability-guards.test.ts packages/cli/test/edge-runtime-diagnostics.test.ts
git commit -m "feat(cli): serve bundled marker files through staticMarkerFs on filesystem-less runtimes"
```

---

### Task 7: Remove the build gate and prove the targets build

**Files:**
- Modify: `packages/cli/src/lib/build/targets/edge-capabilities.ts`
- Test: `packages/cli/test/hono-target.test.ts`
- Test: `packages/cli/test/vercel-target.test.ts`

- [x] **Step 1: Rewrite the hono skills gate test into three cases**

In `packages/cli/test/hono-target.test.ts`, inside `describe("hono target — edge capability gating", ...)`, replace `test("fails the build when a route ships skills", ...)` with:

```ts
  test("builds a route that ships skills, plan.md and memory.md, and bundles their bodies", async () => {
    const appRoot = await createFixtureApp({
      "src/app/chat/memory.md": "Prefer short answers.\n",
      "src/app/chat/plan.md": "- [ ] Restate the question\n",
      "src/app/chat/skills/research/SKILL.md": "---\ndescription: Research.\n---\n\nDo research.\n",
    })

    const { artifacts } = await runBuild(appRoot)

    expect(artifacts).toContain("modules.edge.mjs")
    const modules = await readBuildFile(appRoot, "modules.edge.mjs")
    expect(modules).toContain("markerFiles: Object.fromEntries([")
    expect(modules).toContain('"/src/app/chat/skills/research/SKILL.md"')
    expect(modules).toContain("Do research.")
    expect(modules).toContain('skills: ["research"]')
    // dawn check applies the same (now permissive) gate.
    await expect(runCheck(appRoot)).resolves.toBeDefined()
  })

  test("fails the build, before writing artifacts, when a SKILL.md exceeds 32 KiB", async () => {
    const appRoot = await createFixtureApp({
      "src/app/chat/skills/big/SKILL.md": `---\ndescription: Big.\n---\n${"x".repeat(32 * 1024)}`,
    })

    const error = await runBuild(appRoot).catch((e: unknown) => e)

    expect(String(error)).toContain("skills/big/SKILL.md")
    expect(String(error)).toContain("32768")
    expect((error as { code?: string }).code).toBe("DAWN_E1005")
    expect(existsSync(buildFile(appRoot, "app.mjs"))).toBe(false)
    expect(existsSync(buildFile(appRoot, "modules.edge.mjs"))).toBe(false)
  })

  test("still fails the build for the workspace directory even when skills are present", async () => {
    const appRoot = await createFixtureApp({
      "src/app/chat/skills/research/SKILL.md": "---\ndescription: Research.\n---\n\nDo research.\n",
      "workspace/.gitkeep": "",
    })

    const error = await runBuild(appRoot).catch((e: unknown) => e)

    expect(String(error)).toContain("workspace/")
    expect(String(error)).not.toMatch(/\bskills\b.*vanish/)
  })
```

`readBuildFile`, `buildFile`, `runBuild`, and `existsSync` already exist in that file.

- [x] **Step 2: Add the vercel counterpart**

`packages/cli/test/vercel-target.test.ts` uses `createTargetFixture(files)` and `runTargetBuild(appRoot)`, and its full-build cases call `await ensureLinkedDistsFresh()` first. Inside `describe("complete Vercel target", ...)`, after the first `test(...)`, add:

```ts
  test("bundles a route's skill bodies into the function", async () => {
    await ensureLinkedDistsFresh()
    const appRoot = await createTargetFixture({
      "src/app/chat/skills/research/SKILL.md": "---\ndescription: Research.\n---\n\nDo research.\n",
    })

    await runTargetBuild(appRoot)

    // esbuild inlines the manifest into the single function file, so the skill
    // body must be inside it — and keyed by the namespace, not the build path.
    const bundled = await readFile(
      join(appRoot, ".vercel", "output", "functions", "index.func", "index.mjs"),
      "utf8",
    )
    expect(bundled).toContain("Do research.")
    expect(bundled).toContain("/src/app/chat/skills/research/SKILL.md")
    expect(bundled).not.toContain(appRoot)
  }, 180_000)
```

`readFile` and `join` are already imported in that file; if `readFile` is not, add it to the existing `node:fs/promises` import.

- [x] **Step 3: Run to verify the new cases fail**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/hono-target.test.ts test/vercel-target.test.ts`
Expected: the "builds a route that ships skills" cases FAIL with the DAWN_E1005 skills message; the over-limit case may already pass through `collectRouteMarkerFiles` or fail on the gate message ordering; the workspace case passes.

- [x] **Step 4: Remove the skills violation**

In `packages/cli/src/lib/build/targets/edge-capabilities.ts`, inside `collectEdgeCapabilityViolations`, delete this block:

```ts
    const skillsDir = join(route.routeDir, "skills")
    if (discoverSkillDirs(skillsDir).length > 0) {
      violations.push({
        capability: "skills",
        source: appRelative(appRoot, skillsDir),
        reason:
          "skill bodies are read from disk when the route loads, and an edge runtime has no filesystem to read them from — the skills would vanish from the prompt with no error at all",
        remedy:
          "Inline the instructions into the route's `systemPrompt`, or serve them from a tool that fetches them",
      })
    }
```

Keep `discoverSkillDirs` exported; `modules-emitter.ts` and `marker-files.ts` use it. Update its doc comment's sentence "Exported because the static-module emitter records the same names into the manifest" to add "and the marker-file reader bundles their bodies".

- [x] **Step 5: Run the target tests to verify they pass**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/hono-target.test.ts test/vercel-target.test.ts test/static-check.test.ts test/edge-bundle-purity.test.ts`
Expected: PASS. `edge-bundle-purity` proves the emitted bundle is still `node:`-free with the new `staticMarkerFs` import path reachable from `@dawn-ai/cli/fetch`.

- [x] **Step 6: Commit**

```bash
git add packages/cli/src/lib/build/targets/edge-capabilities.ts packages/cli/test/hono-target.test.ts packages/cli/test/vercel-target.test.ts
git commit -m "feat(cli): stop gating skills off the hono and vercel targets"
```

---

### Task 8: Node-versus-edge equivalence for the bundled markers

**Files:**
- Create: `packages/cli/test/static-edge-marker-files.test.ts`

This is the end-to-end proof: the same fixture, built as a node manifest and as an edge manifest, produces the same skills prompt fragment, the same `readSkill` result, the same route memory block, and the same seeded todos.

- [x] **Step 1: Write the test**

Create `packages/cli/test/static-edge-marker-files.test.ts`:

```ts
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { __clearDawnConfigCacheForTests } from "@dawn-ai/core"
import { discoverRoutes } from "@dawn-ai/core/node"
import { __resetMaterializedAgentsForTests } from "@dawn-ai/langchain"
import { matchPermission, type PermissionsStore } from "@dawn-ai/permissions"
import { createThreadsStore, sqliteCheckpointer } from "@dawn-ai/sqlite-storage"
import { afterEach, describe, expect, it } from "vitest"

import { type AimockFixture, createAimock } from "../../testing/dist/index.js"
import { edgeAppNamespace, emitEdgeModulesFile } from "../src/lib/build/targets/edge-modules-emitter.js"
import {
  collectRouteStaticDiscovery,
  emitModulesFile,
  type RouteStaticDiscovery,
} from "../src/lib/build/targets/modules-emitter.js"
import { createRuntimeFetchHandler as createEdgeRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-core.js"
import { createRuntimeFetchHandler as createNodeRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import type { RequestStores } from "../src/lib/dev/runtime-server.js"
import { __resetRouteLoadCachesForTests } from "../src/lib/runtime/execute-route.js"
import { loadStaticModules } from "../src/lib/runtime/static-modules.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const SKILL_BODY = "Always cite the corpus path in square brackets."
const MEMORY_BODY = "Prefer short answers."

async function fixtureApp(): Promise<string> {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "dawn-static-edge-markers-")))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "static-edge-markers-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      'export default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n',
    "src/app/chat/memory.md": `${MEMORY_BODY}\n`,
    "src/app/chat/plan.md": "- [ ] Restate the question\n- [ ] Answer it\n",
    "src/app/chat/skills/cite-sources/SKILL.md": `---\ndescription: How to cite.\n---\n\n${SKILL_BODY}\n`,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  await mkdir(join(appRoot, "node_modules", "@dawn-ai"), { recursive: true })
  await symlink(join(repoRoot, "packages", "cli"), join(appRoot, "node_modules", "@dawn-ai", "cli"), "dir")
  return appRoot
}

function fixtures(): AimockFixture[] {
  return [
    {
      match: { turnIndex: 0, userMessage: "use the skill" },
      response: {
        toolCalls: [{ arguments: { name: "cite-sources" }, id: "call-skill-1", name: "readSkill" }],
      },
    },
    { match: { turnIndex: 1, userMessage: "use the skill" }, response: { content: "Done." } },
  ]
}

async function startAimock() {
  const aimock = await createAimock({ fixtures: [] })
  aimock.addFixtures(fixtures())
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  return {
    /** The system prompt the model saw on the first request. */
    systemPrompt: () => {
      const first = aimock.getRequests()[0]?.body?.messages as
        | { role: string; content: string }[]
        | undefined
      return first?.find((m) => m.role === "system")?.content ?? ""
    },
    stop: async () => {
      await aimock.close()
      if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = prevBaseUrl
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevKey
    },
  }
}

function interactivePermissionsStore(): PermissionsStore {
  const runtimeAllow: Record<string, string[]> = {}
  return {
    addAllow: async (tool, pattern) => {
      const patterns = runtimeAllow[tool] ?? []
      patterns.push(pattern)
      runtimeAllow[tool] = patterns
    },
    load: async () => {},
    match: (tool, candidate) => matchPermission(tool, candidate, runtimeAllow, {}),
    mode: "interactive",
  }
}

async function requestStoresFor(): Promise<(request: Request) => RequestStores> {
  const dbDir = await realpath(await mkdtemp(join(tmpdir(), "dawn-edge-marker-stores-")))
  cleanup.push(() => rm(dbDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  return () => ({
    checkpointer: sqliteCheckpointer({ path: join(dbDir, "checkpoints.sqlite") }),
    dispose: async () => {},
    permissionsStore: interactivePermissionsStore(),
    threadsStore: createThreadsStore({ path: join(dbDir, "threads.sqlite") }),
  })
}

interface Observed {
  readonly systemPrompt: string
  readonly readSkillResult: string
  readonly todos: unknown
}

async function drive(
  handler: { fetch: (request: Request) => Promise<Response> },
  systemPrompt: () => string,
): Promise<Observed> {
  const post = (path: string, body: unknown) =>
    handler.fetch(
      new Request(`http://localhost${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
  const created = (await (await post("/threads", {})).json()) as { thread_id: string }
  const turn = await post(`/threads/${encodeURIComponent(created.thread_id)}/runs/wait`, {
    input: { messages: [{ content: "use the skill", role: "user" }] },
    route: "/chat#agent",
  })
  expect(turn.status).toBe(200)
  const state = (await turn.json()) as {
    messages?: { type?: string; role?: string; content?: unknown; name?: string }[]
    todos?: unknown
  }
  const toolMessage = state.messages?.find(
    (m) => (m.type === "tool" || m.role === "tool") && m.name === "readSkill",
  )
  return {
    readSkillResult: String(toolMessage?.content ?? ""),
    systemPrompt: systemPrompt(),
    todos: state.todos,
  }
}

describe("bundled marker files — node vs edge", () => {
  it("serves the same skills prompt, readSkill body, route memory, and seeded todos", async () => {
    const appRoot = await fixtureApp()
    const manifest = await discoverRoutes({ appRoot })
    const buildDir = join(appRoot, ".dawn", "build")
    await mkdir(buildDir, { recursive: true })

    const nodeDiscoveries: RouteStaticDiscovery[] = []
    const edgeDiscoveries: RouteStaticDiscovery[] = []
    for (const route of manifest.routes) {
      nodeDiscoveries.push(await collectRouteStaticDiscovery({ appRoot, route }))
      edgeDiscoveries.push(await collectRouteStaticDiscovery({ appRoot, markerFiles: true, route }))
    }
    const nodePath = join(buildDir, "modules.mjs")
    const edgePath = join(buildDir, "modules.edge.mjs")
    await writeFile(nodePath, emitModulesFile({ appRoot, buildDir, discoveries: nodeDiscoveries }), "utf8")
    await writeFile(edgePath, emitEdgeModulesFile({ appRoot, buildDir, discoveries: edgeDiscoveries }), "utf8")

    const nodeModules = await loadStaticModules(pathToFileURL(nodePath))
    const nodeAimock = await startAimock()
    const nodeHandler = await createNodeRuntimeFetchHandler({ appRoot, modules: nodeModules })
    let nodeRun: Observed
    try {
      nodeRun = await drive(nodeHandler, nodeAimock.systemPrompt)
    } finally {
      await nodeHandler.close()
      await nodeAimock.stop()
    }

    __resetRouteLoadCachesForTests()
    __clearDawnConfigCacheForTests()
    __resetMaterializedAgentsForTests()

    const edgeModules = await loadStaticModules(pathToFileURL(edgePath))
    const edgeAimock = await startAimock()
    const edgeHandler = await createEdgeRuntimeFetchHandler({
      appRoot: edgeAppNamespace(appRoot),
      config: {},
      modules: edgeModules,
      requestStores: await requestStoresFor(),
    })
    let edgeRun: Observed
    try {
      edgeRun = await drive(edgeHandler, edgeAimock.systemPrompt)
    } finally {
      await edgeHandler.close()
      await edgeAimock.stop()
    }

    // The node run proves the fixture exercises every marker.
    expect(nodeRun.systemPrompt).toContain("# Skills")
    expect(nodeRun.systemPrompt).toContain("- **cite-sources** — How to cite.")
    expect(nodeRun.systemPrompt).toContain("# Route Memory")
    expect(nodeRun.systemPrompt).toContain(MEMORY_BODY)
    expect(nodeRun.readSkillResult).toContain(SKILL_BODY)
    expect(JSON.stringify(nodeRun.todos)).toContain("Restate the question")

    // And the edge run is indistinguishable.
    expect(edgeRun).toEqual(nodeRun)
  }, 120_000)
})
```

- [x] **Step 2: Run it**

Run: `pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/static-edge-marker-files.test.ts`
Expected: PASS. Two likely adjustments if it fails, and what each means:
- The tool message shape differs (`type`/`role`/`name` fields): inspect `state.messages` once with `console.log(JSON.stringify(state.messages, null, 2))`, fix the `find` predicate, remove the log. That is a test-shape fix.
- `todos` is `undefined` on both runs: the final state key may not be `todos` at the top level of the `runs/wait` body; read it from `GET /threads/:id/state` `.values.todos` instead, the way `static-edge-equivalence.test.ts` does.
- Any difference between `edgeRun` and `nodeRun` is a real bug in Tasks 5 or 6; fix the source, not the assertion.

- [x] **Step 3: Commit**

```bash
git add packages/cli/test/static-edge-marker-files.test.ts
git commit -m "test(cli): node and edge serve bundled skills, plan.md and memory.md identically"
```

**As built** — deltas from the code block above:
- The system-prompt accessor tolerates the `developer` role as well as `system`: `gpt-5*` models carry the system prompt as `developer`.
- The suite calls `ensureLinkedDistsFresh()` (from `test/helpers/hono-edge-fixture.js`) before building each fixture, so the linked `@dawn-ai/*` dists the fixture route resolves through are current.
- The `readSkill` tool result is found by a LangChain-serialized `ToolMessage` predicate (`Array.isArray(m.id) && m.id.includes("ToolMessage") && m.kwargs?.name === "readSkill"`), and its body is read from `kwargs.content`.
- Todos are observed from BOTH the `/runs/wait` body (`todosFromBody`) and `GET /threads/:id/state` (`todosFromState`), with no `??` fallback, so a divergence between the two shapes fails instead of being masked.
- A second case was added — "keeps the bundled marker facade across runs on one edge handler" — driving two threads through ONE edge handler, because a facade built once and dropped would serve run 1 and leave run 2 with no skills.
- Teardown/prompt-capture hardening: `startAimock` pushes its idempotent `stop` onto the `cleanup` stack immediately (a throw during handler construction can no longer leak the mock server or a patched `OPENAI_BASE_URL` into a later test), exposes `requestCount()` so `drive` snapshots the request index instead of using magic indices, and a `beforeEach` resets the route-load, config and materialized-agent caches so every case starts clean.

---

### Task 9: Documentation and changeset

**Files:**
- Modify: `apps/web/content/docs/deployment/edge.mdx`
- Modify: `apps/web/content/docs/cli.mdx`
- Modify: `apps/web/content/docs/faq.mdx`
- Modify: `apps/web/content/docs/upgrading.mdx`
- Create: `.changeset/edge-static-marker-files.md`

- [x] **Step 1: edge.mdx**

In the "What the edge cannot serve" table, delete the row:

```
| Skills | a route `skills/<name>/SKILL.md` | Skill bodies are read from disk when a route loads |
```

Replace the paragraph that begins `Filesystem marker capabilities such as route \`memory.md\` and \`plan.md\` do not activate without a marker filesystem.` with:

```markdown
`workspace/AGENTS.md` is the one marker capability that stays off the edge: its contract is a file the agent rewrites through `writeFile` every turn, and a read-only copy would keep half of that promise. The explicit build gates above cover surfaces that would otherwise be silently replaced, dropped, or fail only on first use.

## Skills, `plan.md`, and route `memory.md` are bundled

Route [skills](/docs/skills), a route [`plan.md`](/docs/planning), and a route `memory.md` are static files, so `dawn build` reads them for the `hono` and `vercel` targets and inlines their contents into `modules.edge.mjs` beside the route that owns them. At request time they are served from that manifest through the same marker facade the node runtime reads from disk, so `readSkill`, seeded todos, and the route-memory prompt block behave exactly as they do under `dawn dev`.

The build enforces the size each marker enforces at runtime — 32 KiB for a `SKILL.md` or `memory.md`, 64 KiB for `plan.md` — and fails with `DAWN_E1005`, naming the file, before it writes any artifact. A manifest that records skill names but carries no bodies (one built before this behavior existed, or composed by hand) still fails at boot with `DAWN_E1005` rather than dropping the skills silently; rebuild with `dawn build`.
```

- [x] **Step 2: cli.mdx**

On the line that begins ``The `hono` target serves a **subset** of Dawn``, change `a \`workspace/\` directory, route skills, or route-level long-term memory` to `a \`workspace/\` directory, or route-level long-term memory`.

- [x] **Step 3: faq.mdx**

On the line that begins `Yes, for apps that fit the edge subset.`, change `The sandbox, workspace file and shell tools, tool-output offloading, skills, and long-term memory are unavailable there` to `The sandbox, workspace file and shell tools, tool-output offloading, and long-term memory are unavailable there; route skills, \`plan.md\`, and \`memory.md\` are bundled into the manifest at build time`.

- [x] **Step 4: upgrading.mdx**

Directly above the heading `## Gated features now fail loudly at request time, not just at build time`, add:

```markdown
## Skills, `plan.md`, and route `memory.md` now work on edge targets

The `hono` and `vercel` targets used to fail the build when a route shipped
skills, and `plan.md` and `memory.md` silently did nothing there. `dawn build`
now bundles all three into `modules.edge.mjs` and serves them from the
manifest at request time. An app that removed its skills to pass the gate can
restore them; nothing else changes. Files over the marker's limit — 32 KiB for
`SKILL.md` and `memory.md`, 64 KiB for `plan.md` — fail the build with
`DAWN_E1005` by name. See [Skills, `plan.md`, and route `memory.md` are
bundled](/docs/deployment/edge#skills-planmd-and-route-memorymd-are-bundled).
```

In the existing section below it, change `\`sandbox\`, route [skills](/docs/skills), and \`toolOutput\` used to be read and then quietly do nothing on a runtime with no filesystem. All three now raise` to `\`sandbox\` and \`toolOutput\` used to be read and then quietly do nothing on a runtime with no filesystem. Both now raise`, and change `naming the feature and the config key that introduced it` to `naming the feature and the config key that introduced it; a manifest that records skills but bundles no bodies is reported the same way`.

- [x] **Step 5: Changeset**

Create `.changeset/edge-static-marker-files.md`:

```markdown
---
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
---

Bundle route skills, `plan.md`, and `memory.md` into the `hono` and `vercel` static manifests and serve them at request time through a new `staticMarkerFs`, so those capabilities work on edge targets. The build no longer gates skills off those targets; it instead enforces each marker's size limit by name before writing artifacts.
```

- [x] **Step 6: Run the docs check**

Run: `node scripts/check-docs.mjs && node scripts/check-changesets.mjs`
Expected: both exit 0. If `check-docs` flags a phrase, reword it; do not add an exemption.

- [x] **Step 7: Commit**

```bash
git add apps/web/content/docs/deployment/edge.mdx apps/web/content/docs/cli.mdx apps/web/content/docs/faq.mdx apps/web/content/docs/upgrading.mdx .changeset/edge-static-marker-files.md
git commit -m "docs: skills, plan.md and memory.md are bundled for edge targets"
```

**As built** — deltas from the steps above:
- Also edited `apps/web/content/docs/deployment.mdx` (dropped "skills" from the target-matrix gated-surfaces phrase) and `apps/web/content/docs/deployment/edge.mdx`'s fit-check bullet, which still listed skills as a reason an app does not fit the edge.
- `scripts/check-docs.mjs` required owner rows for the four new `@dawn-ai/core` exports, so `apps/web/content/docs/api/core.mdx` gained rows for `MAX_MEMORY_BYTES`, `MAX_PLAN_BYTES`, `StaticMarkerFiles` and `staticMarkerFs`.
- Editing docs content invalidates `apps/web/app/seo/lastmod.generated.json`; regenerated with `pnpm --filter @dawn-ai/web seo:lastmod` (its `--check` runs in the web suite).
- `packages/cli/docs/**` is untracked in this repo, so nothing there is committed; `packages/cli/README.md` is hand-written and needed no change.
- The FAQ sentence keeps its original "the build fails naming them" clause and gains the bundling note as a following sentence, so "them" still refers to the unavailable surfaces.
- The heading anchor used from `upgrading.mdx` is `/docs/deployment/edge#skills-planmd-and-route-memorymd-are-bundled` (verified against `github-slugger`).
- Review follow-ups landed after the docs commit:
  - The changeset leads with the consumer-visible change and keeps a closing sentence about the two newly exported constants (`MAX_PLAN_BYTES`, `MAX_MEMORY_BYTES`).
  - `dawn check` now enforces the marker-file limits too, via a new `assertRouteMarkerFileLimits` in `packages/cli/src/lib/build/targets/marker-files.ts` called per edge target in `packages/cli/src/commands/check.ts` — the spec's Error Handling section requires `DAWN_E1005` from both `dawn build` and `dawn check`. Findings are aggregated across ALL routes into one error; the build path's discovery-driven enforcement is unchanged.
  - Three factual corrections in `apps/web/content/docs/deployment/edge.mdx`: a bodyless manifest is detected at boot but fails every *request* (the runtime raises the gap from `fetch`), `workspace/AGENTS.md` is the one marker *file* (not capability) that stays off the edge, and the build *caps* each bundled marker rather than mirroring a runtime limit for all three (`SKILL.md`'s cap is build-only). `upgrading.mdx` notes that `dawn check` applies the same limits.

---

### Task 10: Full validation and PR

**Files:** none new.

- [x] **Step 1: Lint and fix**

Run: `pnpm lint`
Expected: exit 0. If it reports fixable formatting in files this branch touched, run `pnpm lint:fix` and re-run `pnpm lint`. Commit any formatting change as `style: biome fixes`.

- [x] **Step 2: Build, typecheck, and the two package test suites**

Run: `pnpm build && pnpm typecheck && pnpm --filter @dawn-ai/core test && pnpm --filter @dawn-ai/cli test`
Expected: all exit 0. Docker-gated suites (`hono-node-roundtrip`, sandbox, pgvector) skip themselves when Docker is absent; that is expected.

- [x] **Step 3: The full CI lane**

Run: `pnpm ci:validate`
Expected: exit 0. This is the Definition of Done from `AGENTS.md`. Budget 20 to 40 minutes. If a harness step fails on something unrelated to this branch, record the failing step and its first error lines in the PR description rather than retrying blindly.

- [x] **Step 4: Push and open the PR**

```bash
git push -u origin blove/edge-static-marker-files
gh pr create --title "feat: bundle skills, plan.md and memory.md into edge manifests" --body-file - <<'EOF'
## Summary

- `@dawn-ai/core`: `staticMarkerFs`, a pure `MarkerFs` over an in-memory map.
- `@dawn-ai/cli`: the `hono` and `vercel` emitters read each route's `skills/*/SKILL.md`, `plan.md`, and `memory.md` at build time and inline them into `modules.edge.mjs`; the runtime serves them through `staticMarkerFs` when it has no node boot fallbacks.
- The skills build gate is removed. The request-time guard now fires only for a manifest that records skill names without bundled bodies.
- Per-file limits match each marker's runtime limit (32 KiB `SKILL.md`/`memory.md`, 64 KiB `plan.md`) and fail the build by name before any artifact is written.
- `workspace/AGENTS.md` stays gated on purpose: its contract is a file the agent rewrites.

Spec: `docs/superpowers/specs/2026-09-03-edge-static-marker-files-design.md`
Plan: `docs/superpowers/plans/2026-09-03-edge-static-marker-files.md`

## Verification

- `pnpm ci:validate` green locally.
- New tests: `packages/core/test/static-marker-fs.test.ts`, `packages/core/test/capabilities/markers-marker-fs.test.ts` (static case), `packages/cli/test/marker-files.test.ts`, `packages/cli/test/static-modules-marker-files.test.ts`, `packages/cli/test/static-edge-marker-files.test.ts` (node vs edge equivalence), plus updated emitter, guard, and target tests.

## Motivation

A Dawn app deployed as the Hono artifact inside a Vercel Node function needs skills and planning for a research agent. The gate was keyed on the target name, not on whether the files could be served; they are static and belong in the manifest, the same way the thread-access policy already travels.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [x] **Step 5: Record the PR URL**

Paste the PR URL into the "Status" section of the spec (`Approved for planning.` → `Implemented in <PR URL>.`), commit as `docs: link spec to PR`, and push.

---

## Consumer dogfood (outside this repository, after Task 10)

Not a gate for the Dawn PR; recorded here so the next session can run it.

1. In the Dawn worktree, after `pnpm build`, note the built packages: `packages/core/dist`, `packages/cli/dist`, `packages/sdk/dist`, `packages/langgraph/dist`, `packages/langchain/dist`, `packages/postgres-storage/dist`.
2. In the consumer worktree `/Users/blove/repos/angular-agent-framework/.claude/worktrees/enrichment-pipeline-growth-32b064`, copy each `dist/` over `node_modules/@dawn-ai/<name>/dist/`. Do not touch `package.json` or `package-lock.json`.
3. Add a throwaway `apps/lifecycle/src/app/dispatch/skills/smoke/SKILL.md` and run `npx nx build lifecycle`. Expect the build to pass and `.dawn/build/modules.edge.mjs` to contain the skill body.
4. Delete the throwaway skill and run `npm ci` in the consumer worktree to restore the published packages.
