# Phase 3 — Planning Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in planning capability to Dawn agents, opted in by the presence of a `plan.md` file in the route directory. Auto-injects a `write_todos` tool, a `todos` state channel, and a Dawn-locked planning prompt fragment. Exposes plan changes as a `plan_update` SSE event. Introduces the autowiring engine that all later phase-3 sub-projects will reuse.

**Architecture:** New `CapabilityMarker` interface in `@dawn-ai/core` defines a generic "this directory has feature X, here's what to inject" contract. Engine in core scans a route dir, returns `CapabilityContribution`s. Planning's marker lives in core (pure logic). Runtime wiring (`write_todos` tool, prompt rendering, SSE event) lives in `@dawn-ai/langchain` and `@dawn-ai/cli`. Existing `tools/*.ts` and `state.ts` discovery are re-expressed as built-in `CapabilityMarker`s in the same PR to prove the abstraction.

**Tech Stack:** TypeScript 6.0.2, pnpm/turbo monorepo, vitest, `@langchain/{core,langgraph}@1.x`, `zod@4`.

**Spec:** [docs/superpowers/specs/2026-05-15-phase3-planning-design.md](../specs/2026-05-15-phase3-planning-design.md)

**Working directory:** `/Users/blove/repos/dawn/.claude/worktrees/phase3-planning` (branch `claude/phase3-planning`).

---

## File map (where work lands)

**Create:**
- `packages/core/src/capabilities/types.ts` — `CapabilityMarker`, `CapabilityContribution`, `PromptFragment`, `StreamTransformer` interfaces.
- `packages/core/src/capabilities/registry.ts` — capability registry + apply engine.
- `packages/core/src/capabilities/built-in/planning.ts` — the planning `CapabilityMarker`.
- `packages/core/src/capabilities/built-in/plan-md-parser.ts` — markdown checklist parser.
- `packages/core/test/capabilities/planning.test.ts` — planning marker tests.
- `packages/core/test/capabilities/plan-md-parser.test.ts` — parser tests.
- `packages/core/test/capabilities/registry.test.ts` — engine tests.
- `packages/langchain/src/built-in-tools/write-todos.ts` — `write_todos` tool implementation.
- `packages/langchain/src/planning-prompt.ts` — Dawn-locked prompt fragment + renderer.
- `packages/langchain/test/planning.test.ts` — agent compilation tests for planning.
- `.changeset/phase3-planning-capability.md`

**Modify:**
- `packages/core/src/index.ts` — re-export the new capability types and registry.
- `packages/core/src/types.ts` — extend if needed (probably no change).
- `packages/cli/src/lib/runtime/execute-route.ts` — `prepareRouteExecution` runs the capability engine and merges contributions.
- `packages/cli/src/lib/dev/runtime-server.ts` — emits `plan_update` SSE event when `write_todos` returns.
- `packages/langchain/src/agent-adapter.ts` — `materializeAgent` accepts capability-contributed tools/state/prompt fragments.
- `packages/langchain/src/index.ts` — export `write_todos` tool factory + planning prompt renderer.
- `packages/core/src/typegen/render-tool-types.ts` — include capability-contributed tools in generated `RouteTools`.

---

## Task 1: Capability interfaces

**Files:**
- Create: `packages/core/src/capabilities/types.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Create the interfaces file**

`packages/core/src/capabilities/types.ts`:

```ts
import type { ResolvedStateField } from "../types.js"

export interface DawnToolDefinition {
  readonly description?: string
  readonly name: string
  readonly run: (
    input: unknown,
    context: {
      readonly middleware?: Readonly<Record<string, unknown>>
      readonly signal: AbortSignal
    },
  ) => Promise<unknown> | unknown
  readonly schema?: unknown
}

export interface PromptFragment {
  readonly placement: "after_user_prompt"
  /**
   * Render this fragment given the current state of the agent's channels.
   * Called every model turn so the rendered text can reflect live state
   * (e.g., the current todos list is re-injected each turn).
   */
  readonly render: (state: Readonly<Record<string, unknown>>) => string
}

export interface StreamTransformerInput {
  readonly toolName: string
  readonly toolOutput: unknown
}

export interface StreamTransformerOutput {
  readonly event: string
  readonly data: unknown
}

export interface StreamTransformer {
  readonly observes: "tool_result"
  readonly transform: (
    input: StreamTransformerInput,
  ) => Iterable<StreamTransformerOutput> | AsyncIterable<StreamTransformerOutput>
}

export interface CapabilityContribution {
  readonly tools?: ReadonlyArray<DawnToolDefinition>
  readonly stateFields?: ReadonlyArray<ResolvedStateField>
  readonly promptFragment?: PromptFragment
  readonly streamTransformers?: ReadonlyArray<StreamTransformer>
}

export interface CapabilityMarker {
  readonly name: string
  readonly detect: (routeDir: string) => Promise<boolean>
  readonly load: (routeDir: string) => Promise<CapabilityContribution>
}
```

- [ ] **Step 2: Re-export from core**

Edit `packages/core/src/index.ts`. Add:

```ts
export type {
  CapabilityContribution,
  CapabilityMarker,
  DawnToolDefinition,
  PromptFragment,
  StreamTransformer,
  StreamTransformerInput,
  StreamTransformerOutput,
} from "./capabilities/types.js"
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @dawn-ai/core typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/capabilities packages/core/src/index.ts
git commit -m "feat(core): capability interfaces (CapabilityMarker, CapabilityContribution)"
```

---

## Task 2: Capability registry + engine

**Files:**
- Create: `packages/core/src/capabilities/registry.ts`
- Create: `packages/core/test/capabilities/registry.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/test/capabilities/registry.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  type CapabilityMarker,
  applyCapabilities,
  createCapabilityRegistry,
} from "../../src/capabilities/registry.js"

describe("CapabilityRegistry + applyCapabilities", () => {
  let routeDir: string

  beforeEach(() => {
    routeDir = mkdtempSync(join(tmpdir(), "dawn-cap-"))
  })

  afterEach(() => {
    rmSync(routeDir, { recursive: true, force: true })
  })

  it("returns no contributions when no markers detect", async () => {
    const registry = createCapabilityRegistry([
      {
        name: "never",
        detect: async () => false,
        load: async () => ({ tools: [{ name: "x", run: () => undefined }] }),
      } satisfies CapabilityMarker,
    ])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions).toEqual([])
  })

  it("returns contributions from each detecting marker, in registration order", async () => {
    const registry = createCapabilityRegistry([
      {
        name: "first",
        detect: async () => true,
        load: async () => ({ tools: [{ name: "alpha", run: () => undefined }] }),
      } satisfies CapabilityMarker,
      {
        name: "second",
        detect: async () => true,
        load: async () => ({ tools: [{ name: "beta", run: () => undefined }] }),
      } satisfies CapabilityMarker,
    ])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions.map((c) => c.markerName)).toEqual(["first", "second"])
    expect(result.contributions[0]?.contribution.tools?.[0]?.name).toBe("alpha")
    expect(result.contributions[1]?.contribution.tools?.[0]?.name).toBe("beta")
  })

  it("skips markers whose detect throws", async () => {
    writeFileSync(join(routeDir, "marker.txt"), "")
    const registry = createCapabilityRegistry([
      {
        name: "throwing",
        detect: async () => {
          throw new Error("boom")
        },
        load: async () => ({}),
      } satisfies CapabilityMarker,
      {
        name: "ok",
        detect: async () => true,
        load: async () => ({ tools: [{ name: "ok-tool", run: () => undefined }] }),
      } satisfies CapabilityMarker,
    ])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions.map((c) => c.markerName)).toEqual(["ok"])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.markerName).toBe("throwing")
  })

  it("propagates load errors as result errors, not exceptions", async () => {
    const registry = createCapabilityRegistry([
      {
        name: "bad-load",
        detect: async () => true,
        load: async () => {
          throw new Error("load failed")
        },
      } satisfies CapabilityMarker,
    ])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.markerName).toBe("bad-load")
    expect(result.errors[0]?.message).toContain("load failed")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/core test -- registry.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

`packages/core/src/capabilities/registry.ts`:

```ts
import type { CapabilityContribution, CapabilityMarker } from "./types.js"

export type { CapabilityMarker }

export interface CapabilityRegistry {
  readonly markers: ReadonlyArray<CapabilityMarker>
}

export interface AppliedContribution {
  readonly markerName: string
  readonly contribution: CapabilityContribution
}

export interface CapabilityError {
  readonly markerName: string
  readonly phase: "detect" | "load"
  readonly message: string
}

export interface ApplyResult {
  readonly contributions: ReadonlyArray<AppliedContribution>
  readonly errors: ReadonlyArray<CapabilityError>
}

export function createCapabilityRegistry(
  markers: ReadonlyArray<CapabilityMarker>,
): CapabilityRegistry {
  return { markers }
}

export async function applyCapabilities(
  registry: CapabilityRegistry,
  routeDir: string,
): Promise<ApplyResult> {
  const contributions: AppliedContribution[] = []
  const errors: CapabilityError[] = []

  for (const marker of registry.markers) {
    let detected: boolean
    try {
      detected = await marker.detect(routeDir)
    } catch (error) {
      errors.push({
        markerName: marker.name,
        phase: "detect",
        message: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    if (!detected) continue

    try {
      const contribution = await marker.load(routeDir)
      contributions.push({ markerName: marker.name, contribution })
    } catch (error) {
      errors.push({
        markerName: marker.name,
        phase: "load",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { contributions, errors }
}
```

- [ ] **Step 4: Re-export from core**

Edit `packages/core/src/index.ts`. Add:

```ts
export type {
  AppliedContribution,
  ApplyResult,
  CapabilityError,
  CapabilityRegistry,
} from "./capabilities/registry.js"
export { applyCapabilities, createCapabilityRegistry } from "./capabilities/registry.js"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dawn-ai/core test -- registry.test`
Expected: 4/4 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/capabilities packages/core/test/capabilities packages/core/src/index.ts
git commit -m "feat(core): capability registry + applyCapabilities engine"
```

---

## Task 3: `plan.md` parser

**Files:**
- Create: `packages/core/src/capabilities/built-in/plan-md-parser.ts`
- Create: `packages/core/test/capabilities/plan-md-parser.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/core/test/capabilities/plan-md-parser.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { parsePlanMarkdown } from "../../src/capabilities/built-in/plan-md-parser.js"

describe("parsePlanMarkdown", () => {
  it("returns empty list for empty input", () => {
    expect(parsePlanMarkdown("")).toEqual([])
  })

  it("returns empty list for prose-only input", () => {
    expect(parsePlanMarkdown("# Heading\n\nSome notes here.\n")).toEqual([])
  })

  it("parses pending items", () => {
    expect(parsePlanMarkdown("- [ ] Read AGENTS.md")).toEqual([
      { content: "Read AGENTS.md", status: "pending" },
    ])
  })

  it("parses completed items", () => {
    expect(parsePlanMarkdown("- [x] Done thing")).toEqual([
      { content: "Done thing", status: "completed" },
    ])
  })

  it("treats [X] case-insensitively", () => {
    expect(parsePlanMarkdown("- [X] Capital X")).toEqual([
      { content: "Capital X", status: "completed" },
    ])
  })

  it("ignores intermixed prose and headings", () => {
    const input = `# My plan

Some thoughts.

- [ ] First
- [x] Second
- [ ] Third

End.
`
    expect(parsePlanMarkdown(input)).toEqual([
      { content: "First", status: "pending" },
      { content: "Second", status: "completed" },
      { content: "Third", status: "pending" },
    ])
  })

  it("trims surrounding whitespace from content", () => {
    expect(parsePlanMarkdown("- [ ]   spaced item   ")).toEqual([
      { content: "spaced item", status: "pending" },
    ])
  })

  it("ignores items with empty content", () => {
    expect(parsePlanMarkdown("- [ ]\n- [ ]   \n- [ ] real")).toEqual([
      { content: "real", status: "pending" },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dawn-ai/core test -- plan-md-parser.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

`packages/core/src/capabilities/built-in/plan-md-parser.ts`:

```ts
export interface PlanTodo {
  readonly content: string
  readonly status: "pending" | "completed"
}

const CHECKLIST_LINE = /^\s*-\s*\[([ xX])\]\s*(.*)$/

export function parsePlanMarkdown(input: string): PlanTodo[] {
  const todos: PlanTodo[] = []
  for (const line of input.split(/\r?\n/)) {
    const match = CHECKLIST_LINE.exec(line)
    if (!match) continue
    const checkChar = match[1] ?? " "
    const content = (match[2] ?? "").trim()
    if (content.length === 0) continue
    todos.push({
      content,
      status: checkChar === " " ? "pending" : "completed",
    })
  }
  return todos
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dawn-ai/core test -- plan-md-parser.test`
Expected: 8/8 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capabilities/built-in/plan-md-parser.ts packages/core/test/capabilities/plan-md-parser.test.ts
git commit -m "feat(core): plan.md markdown checklist parser"
```

---

## Task 4: Planning capability marker

**Files:**
- Create: `packages/core/src/capabilities/built-in/planning.ts`
- Create: `packages/core/test/capabilities/planning.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing tests**

`packages/core/test/capabilities/planning.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createPlanningMarker } from "../../src/capabilities/built-in/planning.js"

describe("createPlanningMarker", () => {
  let routeDir: string

  beforeEach(() => {
    routeDir = mkdtempSync(join(tmpdir(), "dawn-planning-"))
  })

  afterEach(() => {
    rmSync(routeDir, { recursive: true, force: true })
  })

  it("does not detect when plan.md is absent", async () => {
    const marker = createPlanningMarker()
    expect(await marker.detect(routeDir)).toBe(false)
  })

  it("detects when plan.md is present (empty)", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    expect(await marker.detect(routeDir)).toBe(true)
  })

  it("contributes a write_todos tool when loaded", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.tools?.[0]?.name).toBe("write_todos")
  })

  it("contributes a todos state field when loaded", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.stateFields?.[0]?.name).toBe("todos")
    expect(contribution.stateFields?.[0]?.reducer).toBe("replace")
    expect(contribution.stateFields?.[0]?.default).toEqual([])
  })

  it("seeds the todos state field from plan.md content", async () => {
    writeFileSync(join(routeDir, "plan.md"), "- [ ] one\n- [x] two\n")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.stateFields?.[0]?.default).toEqual([
      { content: "one", status: "pending" },
      { content: "two", status: "completed" },
    ])
  })

  it("contributes a prompt fragment for the planning instructions", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.promptFragment?.placement).toBe("after_user_prompt")
    const rendered = contribution.promptFragment?.render({ todos: [] }) ?? ""
    expect(rendered).toContain("# Planning")
    expect(rendered).toContain("write_todos")
  })

  it("renders the current todos in the prompt fragment", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir)
    const rendered =
      contribution.promptFragment?.render({
        todos: [
          { content: "first", status: "in_progress" },
          { content: "second", status: "pending" },
        ],
      }) ?? ""
    expect(rendered).toContain("[in_progress] first")
    expect(rendered).toContain("[pending] second")
  })

  it("contributes a stream transformer that maps write_todos results to plan_update events", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir)
    const transformer = contribution.streamTransformers?.[0]
    expect(transformer?.observes).toBe("tool_result")

    const events: Array<{ event: string; data: unknown }> = []
    if (transformer) {
      const newTodos = [{ content: "x", status: "pending" }]
      for await (const out of transformer.transform({
        toolName: "write_todos",
        toolOutput: { todos: newTodos },
      })) {
        events.push(out)
      }
    }

    expect(events).toEqual([{ event: "plan_update", data: { todos: [{ content: "x", status: "pending" }] } }])
  })

  it("stream transformer ignores tool results from other tools", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const marker = createPlanningMarker()
    const contribution = await marker.load(routeDir)
    const transformer = contribution.streamTransformers?.[0]
    const events: Array<unknown> = []
    if (transformer) {
      for await (const out of transformer.transform({
        toolName: "some_other_tool",
        toolOutput: { whatever: true },
      })) {
        events.push(out)
      }
    }
    expect(events).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dawn-ai/core test -- planning.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the planning marker**

`packages/core/src/capabilities/built-in/planning.ts`:

```ts
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { CapabilityMarker, PromptFragment, StreamTransformer } from "../types.js"
import { type PlanTodo, parsePlanMarkdown } from "./plan-md-parser.js"

const PLAN_MD = "plan.md"
const MAX_PLAN_BYTES = 64 * 1024

export interface RuntimeTodo {
  readonly content: string
  readonly status: "pending" | "in_progress" | "completed"
}

const PLANNING_PROMPT_HEADER = `# Planning

For tasks with multiple steps, maintain a plan using \`write_todos({ todos: [...] })\`.
Mark items \`in_progress\` immediately before working on them and \`completed\` when
finished. Always include the full list — \`write_todos\` is full-replace, not incremental.`

export function createPlanningMarker(): CapabilityMarker {
  return {
    name: "planning",
    detect: async (routeDir) => existsSync(join(routeDir, PLAN_MD)),
    load: async (routeDir) => {
      const seedTodos = readSeedTodos(routeDir)

      const writeTodos = {
        name: "write_todos",
        description:
          "Replace the agent's plan with the given list of todos. Pass the full list every time; this tool is not incremental.",
        run: (input: unknown) => {
          // The actual state mutation happens in the langchain runtime;
          // this run() just echoes the canonicalized input back so the
          // tool result event carries the new todos.
          const validated = validateWriteTodosInput(input)
          return { todos: validated }
        },
      }

      const promptFragment: PromptFragment = {
        placement: "after_user_prompt",
        render: (state) => {
          const todos = (state.todos as ReadonlyArray<RuntimeTodo> | undefined) ?? []
          if (todos.length === 0) {
            return `${PLANNING_PROMPT_HEADER}\n\nCurrent plan: (empty)`
          }
          const lines = todos.map((t) => `- [${t.status}] ${t.content}`).join("\n")
          return `${PLANNING_PROMPT_HEADER}\n\nCurrent plan:\n${lines}`
        },
      }

      const streamTransformer: StreamTransformer = {
        observes: "tool_result",
        transform: async function* (input) {
          if (input.toolName !== "write_todos") return
          const out = input.toolOutput as { todos?: ReadonlyArray<RuntimeTodo> } | undefined
          yield {
            event: "plan_update",
            data: { todos: out?.todos ?? [] },
          }
        },
      }

      return {
        tools: [writeTodos],
        stateFields: [
          {
            name: "todos",
            reducer: "replace",
            default: seedTodos as readonly RuntimeTodo[],
          },
        ],
        promptFragment,
        streamTransformers: [streamTransformer],
      }
    },
  }
}

function readSeedTodos(routeDir: string): RuntimeTodo[] {
  const planPath = join(routeDir, PLAN_MD)
  if (!existsSync(planPath)) return []
  const size = statSync(planPath).size
  if (size > MAX_PLAN_BYTES) return []
  let raw: string
  try {
    raw = readFileSync(planPath, "utf8")
  } catch {
    return []
  }
  const parsed: PlanTodo[] = parsePlanMarkdown(raw)
  return parsed.map((t) => ({ content: t.content, status: t.status }))
}

function validateWriteTodosInput(input: unknown): RuntimeTodo[] {
  if (!isRecord(input)) {
    throw new Error("write_todos: input must be an object with a `todos` array")
  }
  const todos = input.todos
  if (!Array.isArray(todos)) {
    throw new Error("write_todos: `todos` must be an array")
  }
  return todos.map((t, i) => {
    if (!isRecord(t)) {
      throw new Error(`write_todos: todos[${i}] must be an object`)
    }
    const content = t.content
    const status = t.status
    if (typeof content !== "string" || content.length === 0) {
      throw new Error(`write_todos: todos[${i}].content must be a non-empty string`)
    }
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      throw new Error(
        `write_todos: todos[${i}].status must be one of pending, in_progress, completed`,
      )
    }
    return { content, status }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
```

- [ ] **Step 4: Re-export from core**

Edit `packages/core/src/index.ts`. Add:

```ts
export type { RuntimeTodo } from "./capabilities/built-in/planning.js"
export { createPlanningMarker } from "./capabilities/built-in/planning.js"
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @dawn-ai/core test -- planning.test`
Expected: 9/9 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/capabilities/built-in/planning.ts packages/core/test/capabilities/planning.test.ts packages/core/src/index.ts
git commit -m "feat(core): planning CapabilityMarker (write_todos + todos channel + prompt fragment + plan_update transformer)"
```

---

## Task 5: Wire capabilities into runtime preparation

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`
- Modify: `packages/langchain/src/agent-adapter.ts`

This task changes how `prepareRouteExecution` assembles tools/state for an agent route, so the planning capability's contributions get merged in.

- [ ] **Step 1: Inspect current shape of `prepareRouteExecution`**

Read `packages/cli/src/lib/runtime/execute-route.ts` lines 187–230. The function currently:
1. Discovers tools via `discoverToolDefinitions`.
2. Discovers state via `discoverStateDefinition` + `resolveStateFields`.
3. Returns `PreparedRoute` with `tools` and `stateFields`.

You'll add capability-engine application after step 2 and before the return.

- [ ] **Step 2: Modify `prepareRouteExecution`**

In `packages/cli/src/lib/runtime/execute-route.ts`, near the top (with the other imports):

```ts
import {
  applyCapabilities,
  createCapabilityRegistry,
  createPlanningMarker,
  type CapabilityContribution,
} from "@dawn-ai/core"
```

In `prepareRouteExecution`, after the `if (normalized.kind === "agent") { ... stateFields = ...}` block and before `return { ... }`, add:

```ts
// Apply capability markers (planning, etc.). Only for agent routes.
let promptFragments: ReadonlyArray<NonNullable<CapabilityContribution["promptFragment"]>> = []
let streamTransformers: ReadonlyArray<
  NonNullable<CapabilityContribution["streamTransformers"]>[number]
> = []

if (normalized.kind === "agent") {
  const registry = createCapabilityRegistry([createPlanningMarker()])
  const applied = await applyCapabilities(registry, routeDir)

  if (applied.errors.length > 0) {
    const messages = applied.errors
      .map((e) => `[${e.markerName}#${e.phase}] ${e.message}`)
      .join("\n  ")
    return { message: `Capability error during route prep:\n  ${messages}`, ok: false }
  }

  const capTools: typeof tools = []
  const capStateFields: ResolvedStateField[] = []
  const capPromptFragments: typeof promptFragments = []
  const capStreamTransformers: typeof streamTransformers = []

  for (const { contribution } of applied.contributions) {
    if (contribution.tools) capTools.push(...contribution.tools)
    if (contribution.stateFields) capStateFields.push(...contribution.stateFields)
    if (contribution.promptFragment) capPromptFragments.push(contribution.promptFragment)
    if (contribution.streamTransformers) capStreamTransformers.push(...contribution.streamTransformers)
  }

  // Conflict detection
  const userToolNames = new Set(tools.map((t) => t.name))
  const userStateNames = new Set((stateFields ?? []).map((f) => f.name))
  for (const t of capTools) {
    if (userToolNames.has(t.name)) {
      return {
        message: `Capability conflict: tool "${t.name}" is contributed by a capability and also defined in tools/. Remove the file in tools/ or remove the capability marker file.`,
        ok: false,
      }
    }
  }
  for (const f of capStateFields) {
    if (userStateNames.has(f.name)) {
      return {
        message: `Capability conflict: state field "${f.name}" is contributed by a capability and also declared in state.ts. Remove the field from state.ts or remove the capability marker file.`,
        ok: false,
      }
    }
  }

  tools = [...tools, ...capTools]
  stateFields = stateFields ? [...stateFields, ...capStateFields] : capStateFields
  promptFragments = capPromptFragments
  streamTransformers = capStreamTransformers
}
```

Then change the return statement to include the new fields:

```ts
return {
  normalized,
  ok: true,
  promptFragments,
  streamTransformers,
  stateFields,
  tools,
}
```

And update the `PreparedRoute` interface (search for it in the same file) to include:

```ts
readonly promptFragments?: ReadonlyArray<...>  // use the same type as above
readonly streamTransformers?: ReadonlyArray<...>
```

- [ ] **Step 3: Thread the new fields into executeAgent / streamAgent**

Both `executeAgent` and `streamAgent` calls in `execute-route.ts` need to receive the new `promptFragments` and `streamTransformers`. Add them to the option-objects passed in.

In `packages/langchain/src/agent-adapter.ts`, extend `AgentOptions`:

```ts
export interface AgentOptions {
  readonly entry: unknown
  readonly input: unknown
  readonly middlewareContext?: Readonly<Record<string, unknown>>
  readonly retry?: RetryConfig
  readonly routeParamNames: readonly string[]
  readonly signal: AbortSignal
  readonly stateFields?: readonly ResolvedStateField[]
  readonly tools: readonly DawnToolDefinition[]
  readonly promptFragments?: readonly PromptFragment[]
  readonly streamTransformers?: readonly StreamTransformer[]
}
```

Import `PromptFragment` and `StreamTransformer` from `@dawn-ai/core`.

- [ ] **Step 4: Use prompt fragments in `materializeAgent`**

In `agent-adapter.ts`'s `materializeAgent`, where `prompt` is built from `descriptor.systemPrompt`:

Current:
```ts
const agentOptions: Record<string, unknown> = {
  llm,
  tools: langchainTools,
  prompt: descriptor.systemPrompt,
}
```

The prompt needs to be a function (or a similar shape) that re-renders fragments each turn from the live state. LangGraph's `createReactAgent` accepts a `prompt` that can be a function `(state) => Message[]`. Replace `prompt` with:

```ts
prompt: (state: Record<string, unknown>) => {
  const fragments = (options.promptFragments ?? [])
    .filter((f) => f.placement === "after_user_prompt")
    .map((f) => f.render(state))
    .filter((s) => s.length > 0)
  const composed = [descriptor.systemPrompt, ...fragments].join("\n\n")
  return [{ role: "system", content: composed }]
},
```

If the `prompt` field signature in `@langchain/langgraph@1.x` `createReactAgent` doesn't accept a function, fall back to building a composite string at materialization time using initial state:

```ts
const initialState: Record<string, unknown> = Object.fromEntries(
  (options.stateFields ?? []).map((f) => [f.name, f.default]),
)
const fragments = (options.promptFragments ?? [])
  .filter((f) => f.placement === "after_user_prompt")
  .map((f) => f.render(initialState))
  .filter((s) => s.length > 0)
const composedPrompt = [descriptor.systemPrompt, ...fragments].join("\n\n")
// ... then prompt: composedPrompt
```

(The function-based prompt is preferred — it re-renders each turn, which is the spec's "Current plan: ..." live re-injection.) Verify which form `createReactAgent` accepts during implementation.

- [ ] **Step 5: Apply stream transformers in `streamFromRunnable`**

In `agent-adapter.ts`'s `streamFromRunnable`, in the `case "on_tool_end":` branch — after yielding the existing `{ type: "tool_result", ... }` event, also dispatch any matching stream transformers:

```ts
case "on_tool_end": {
  hasYielded = true
  yield {
    type: "tool_result" as const,
    data: { name: event.name, output: event.data.output },
  }
  for (const transformer of options.streamTransformers ?? []) {
    if (transformer.observes !== "tool_result") continue
    for await (const out of transformer.transform({
      toolName: event.name,
      toolOutput: event.data.output,
    })) {
      yield {
        type: out.event as AgentStreamChunk["type"],
        data: out.data,
      }
    }
  }
  break
}
```

The `type: out.event as ...` cast is needed because `AgentStreamChunk["type"]` is currently a fixed union of `"token" | "tool_call" | "tool_result" | "done"`. Widen the type:

```ts
export interface AgentStreamChunk {
  readonly type: "token" | "tool_call" | "tool_result" | "done" | (string & {})
  readonly data: unknown
}
```

- [ ] **Step 6: Typecheck both packages**

Run: `pnpm --filter @dawn-ai/core --filter @dawn-ai/langchain --filter @dawn-ai/cli typecheck`
Expected: passes.

- [ ] **Step 7: Run existing langchain tests to confirm no regression**

Run: `pnpm --filter @dawn-ai/langchain test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/lib/runtime/execute-route.ts packages/langchain/src/agent-adapter.ts
git commit -m "feat(runtime): apply capability contributions to agent compilation + streaming"
```

---

## Task 6: Wire `plan_update` SSE event in dev server

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`

The dev server's `/runs/stream` handler maps internal `AgentStreamChunk`s to SSE event lines. The new `plan_update` chunk type from Task 5 needs to be recognized.

- [ ] **Step 1: Find the chunk → SSE mapping**

Run: `grep -n "tool_result\|tool_call\|on_chat_model_stream\|event:" packages/cli/src/lib/dev/runtime-server.ts | head -20`

Locate the switch statement (or similar) that converts `AgentStreamChunk` types to SSE `event: <name>\ndata: <json>\n\n` lines.

- [ ] **Step 2: Add `plan_update` to the mapping**

In the chunk-mapping logic, add a case (or default branch) that handles arbitrary chunk types — including `plan_update` — by writing them through verbatim:

```ts
default: {
  // Capability-contributed event types (e.g. plan_update from the planning capability)
  // are emitted with their literal type as the SSE event name.
  writeSSE(response, chunk.type, chunk.data)
  break
}
```

If the existing code has no default branch, add one that writes through unknown event types. Don't filter to only `plan_update`; future capabilities will emit other event types using the same mechanism.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @dawn-ai/cli typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-server.ts
git commit -m "feat(cli): pass through capability-contributed SSE event types"
```

---

## Task 7: Integration test — planning end-to-end

**Files:**
- Create: `packages/langchain/test/planning.test.ts`

This test exercises the planning capability end-to-end with a mocked LLM, verifying:
- A route with `plan.md` compiles with `write_todos` in its tool set.
- The system prompt includes the planning fragment.
- Calling `write_todos` produces a `plan_update` SSE event in the stream.
- A route without `plan.md` is unaffected.

- [ ] **Step 1: Write the test**

`packages/langchain/test/planning.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyCapabilities, createCapabilityRegistry, createPlanningMarker } from "@dawn-ai/core"

describe("planning capability — end-to-end shape", () => {
  let routeDir: string

  beforeEach(() => {
    routeDir = mkdtempSync(join(tmpdir(), "dawn-planning-e2e-"))
  })

  afterEach(() => {
    rmSync(routeDir, { recursive: true, force: true })
  })

  it("contributes nothing when plan.md is absent", async () => {
    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions).toEqual([])
  })

  it("contributes write_todos + todos channel + prompt fragment + transformer when plan.md is present", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, routeDir)

    expect(result.contributions).toHaveLength(1)
    const contrib = result.contributions[0]?.contribution
    expect(contrib?.tools?.map((t) => t.name)).toEqual(["write_todos"])
    expect(contrib?.stateFields?.map((f) => f.name)).toEqual(["todos"])
    expect(contrib?.promptFragment?.placement).toBe("after_user_prompt")
    expect(contrib?.streamTransformers?.[0]?.observes).toBe("tool_result")
  })

  it("seeds the todos channel from a populated plan.md", async () => {
    writeFileSync(
      join(routeDir, "plan.md"),
      "- [ ] survey workspace\n- [x] read AGENTS.md\n",
    )
    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, routeDir)
    const todosField = result.contributions[0]?.contribution.stateFields?.[0]
    expect(todosField?.default).toEqual([
      { content: "survey workspace", status: "pending" },
      { content: "read AGENTS.md", status: "completed" },
    ])
  })

  it("renders prompt with current todos on each call", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, routeDir)
    const fragment = result.contributions[0]?.contribution.promptFragment
    const r1 = fragment?.render({ todos: [] }) ?? ""
    const r2 =
      fragment?.render({ todos: [{ content: "x", status: "in_progress" }] }) ?? ""
    expect(r1).toContain("(empty)")
    expect(r2).toContain("[in_progress] x")
  })

  it("transformer emits plan_update when write_todos result flows through", async () => {
    writeFileSync(join(routeDir, "plan.md"), "")
    const registry = createCapabilityRegistry([createPlanningMarker()])
    const result = await applyCapabilities(registry, routeDir)
    const transformer = result.contributions[0]?.contribution.streamTransformers?.[0]

    const events: Array<{ event: string; data: unknown }> = []
    if (transformer) {
      for await (const out of transformer.transform({
        toolName: "write_todos",
        toolOutput: { todos: [{ content: "x", status: "pending" }] },
      })) {
        events.push(out)
      }
    }
    expect(events).toEqual([
      { event: "plan_update", data: { todos: [{ content: "x", status: "pending" }] } },
    ])
  })
})
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @dawn-ai/langchain test -- planning.test`
Expected: 5/5 pass. (All tests exercise the core planning marker; this file lives in langchain because the natural place for "planning works in the langchain pipeline" tests is here, even though for v1 we're testing the contribution shape directly.)

- [ ] **Step 3: Commit**

```bash
git add packages/langchain/test/planning.test.ts
git commit -m "test(langchain): planning capability end-to-end shape"
```

---

## Task 8: Typegen — include capability-contributed tools

**Files:**
- Modify: `packages/core/src/typegen/render-tool-types.ts`

Right now `render-tool-types.ts` renders tools from the `tools/` directory. With planning enabled, the generated `RouteTools["/route"]` should also include `write_todos`.

- [ ] **Step 1: Inspect the render function**

Read `packages/core/src/typegen/render-tool-types.ts` and `packages/core/src/typegen/render-route-types.ts` to understand the current tool-type generation pipeline.

- [ ] **Step 2: Decide call-site shape**

The typegen runs from `dawn build` (in `packages/cli/src/commands/build.ts`). The existing pipeline reads tool schemas from `tools/*.ts` discovery. Extend the input to typegen to also accept "additional tools" (capability-contributed). Concretely, a new optional parameter on the render function:

```ts
export interface RenderToolTypesOptions {
  // ... existing fields
  readonly extraTools?: ReadonlyArray<{
    readonly name: string
    readonly inputType: string  // pre-rendered TS source for the input type
    readonly outputType: string  // pre-rendered TS source for the output type
  }>
}
```

Render each extra tool the same way user-discovered tools are rendered, just sourcing the type strings from the extras instead of from typegen extraction.

- [ ] **Step 3: Wire `dawn build` to pass the planning extras when plan.md is present**

In `packages/cli/src/commands/build.ts`, around the typegen invocation: detect `plan.md` in each route dir; if present, add `write_todos` as an extra tool with hard-coded input/output type strings:

```ts
const PLANNING_EXTRA_TOOL = {
  name: "write_todos",
  inputType: `{ todos: ReadonlyArray<{ content: string; status: "pending" | "in_progress" | "completed" }> }`,
  outputType: `{ todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }`,
}
```

Detection logic mirrors the runtime: `existsSync(join(routeDir, "plan.md"))`.

(A future improvement is to source the type strings from the planning marker itself — the marker should expose its tool's TS type description. v1: hard-code in build.ts for simplicity. Refactor when the second capability ships.)

- [ ] **Step 4: Run a typegen smoke test**

Create a temp scratch route with `plan.md`, run `dawn build` against it, and grep the generated `.dawn/dawn.generated.d.ts` for `write_todos`. Don't commit the scratch; just verify the path works locally.

- [ ] **Step 5: Update or add a typegen test**

In `packages/core/test/render-tool-types.test.ts` (or a sibling), add a test that calling the renderer with `extraTools` produces TS source containing the extra tool's signature.

```ts
it("includes extraTools in the rendered RouteTools entry", () => {
  const rendered = renderRouteTypes({
    routes: [
      {
        pathname: "/chat",
        tools: [],
        extraTools: [
          {
            name: "write_todos",
            inputType: `{ todos: ReadonlyArray<{ content: string; status: "pending" }> }`,
            outputType: `{ todos: Array<{ content: string; status: "pending" }> }`,
          },
        ],
        // ... fill in other required fields per the actual function signature
      },
    ],
  })
  expect(rendered).toContain("readonly write_todos:")
  expect(rendered).toContain('status: "pending"')
})
```

(Adapt the test shape to the actual `renderRouteTypes` signature you find in the file.)

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @dawn-ai/core test -- render`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/typegen packages/core/test packages/cli/src/commands/build.ts
git commit -m "feat(typegen): include capability-contributed tools (write_todos) in generated RouteTools"
```

---

## Task 9: Full workspace verification

**Files:** none (verification only)

- [ ] **Step 1: Install + build**

Run from repo root:
```bash
pnpm install
pnpm build
```
Expected: 11/11 packages build green.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 3: Tests**

Run: `pnpm test`
Expected: passes. New tests added in this PR are in `packages/core/test/capabilities/`, `packages/langchain/test/planning.test.ts`, and possibly a new render-tool-types case.

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: passes.

- [ ] **Step 5: Pack check**

Run: `pnpm pack:check`
Expected: passes.

- [ ] **Step 6: Manual smoke test against examples/chat (if local OPENAI_API_KEY available)**

```bash
# in examples/chat/server
touch src/app/chat/plan.md
pnpm dev    # one terminal — boots dev server on :3001
```

In another terminal:
```bash
curl -N -X POST http://127.0.0.1:3001/runs/stream \
  -H "content-type: application/json" \
  -d '{
    "assistant_id": "/chat#agent",
    "input": { "messages": [{ "role": "user", "content": "Make a 3-step plan for surveying a new codebase, then call write_todos to record it." }] },
    "metadata": { "dawn": { "mode": "agent", "route_id": "/chat", "route_path": "src/app/chat/index.ts", "thread_id": "smoke-1" } },
    "on_completion": "delete"
  }'
```

Expected: the SSE response includes a `plan_update` event after the agent calls `write_todos`. If no key, skip this and rely on the unit/integration tests.

(After verifying, `git checkout examples/chat/server/src/app/chat/plan.md` to leave examples/chat untouched in the PR — it gets its own follow-up PR.)

If any verification step fails, fix and re-commit before proceeding to Task 10.

---

## Task 10: Changeset

**Files:**
- Create: `.changeset/phase3-planning-capability.md`

- [ ] **Step 1: Inspect existing changeset format**

```bash
ls .changeset/
head -10 .changeset/*.md | head -30
```

- [ ] **Step 2: Create the changeset**

`.changeset/phase3-planning-capability.md`:

```markdown
---
"@dawn-ai/core": minor
"@dawn-ai/langchain": minor
"@dawn-ai/cli": minor
---

Add the first phase-3 harness capability: planning. A `plan.md` file in a route directory now opts the agent into a built-in `write_todos` tool, a `todos` state channel, a Dawn-locked planning prompt fragment, and a `plan_update` SSE event. Introduces `CapabilityMarker` and `applyCapabilities` in `@dawn-ai/core` — the autowiring spine that all later phase-3 capabilities (skills, subagents, etc.) will reuse.
```

- [ ] **Step 3: Commit**

```bash
git add .changeset
git commit -m "chore: changeset for phase-3 planning capability"
```

---

## Task 11: Push branch and open PR

- [ ] **Step 1: Push**

```bash
git push -u origin claude/phase3-planning
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "feat(core,langchain,cli): phase 3 — planning capability + autowiring engine" --body "$(cat <<'EOF'
## Summary
- First sub-project of the phase-3 opinionated harness program. Adds a built-in **planning capability** opted in by the presence of a \`plan.md\` file in a route directory.
- Auto-injects a \`write_todos\` tool, a \`todos\` state channel (with replace reducer), a Dawn-locked planning prompt fragment that re-renders the current plan each turn, and a \`plan_update\` SSE event on \`/runs/stream\`.
- Introduces the **autowiring engine** (\`CapabilityMarker\` + \`applyCapabilities\`) in \`@dawn-ai/core\`. All later phase-3 capabilities (skills, subagents, ...) will plug into this same interface.

## Why
Forces the three injection mechanisms — tool, state channel, prompt fragment — to exist as a generic abstraction, not as one-off code. The planning capability is the smallest capability that exercises all three.

## Spec & plan
- Spec: \`docs/superpowers/specs/2026-05-15-phase3-planning-design.md\`
- Plan: \`docs/superpowers/plans/2026-05-15-phase3-planning.md\`

## What changes
- \`@dawn-ai/core\`:
  - New \`capabilities/\` directory: types, registry, planning marker, plan.md parser.
  - Re-exports the public API surface.
  - Typegen extended to include capability-contributed tools in generated \`RouteTools\`.
- \`@dawn-ai/langchain\`:
  - \`AgentOptions\` accepts \`promptFragments\` and \`streamTransformers\`.
  - System prompt is composed from descriptor's \`systemPrompt\` + capability fragments (re-rendered each turn).
  - Tool-result events get dispatched through capability stream transformers, emitting things like \`plan_update\`.
- \`@dawn-ai/cli\`:
  - \`prepareRouteExecution\` runs the capability engine, merges contributions into the route's tools/state.
  - Conflict detection: capability-contributed tool name collides with user \`tools/\`, or capability state field collides with user \`state.ts\` → fail-fast with both file paths in the error.
  - Dev server passes through arbitrary capability event types as SSE.

## Test plan
- [x] \`pnpm install\` clean
- [x] \`pnpm build\` — 11/11 packages
- [x] \`pnpm typecheck\` — all packages
- [x] \`pnpm test\` — including new tests under \`packages/core/test/capabilities/\` and \`packages/langchain/test/planning.test.ts\`
- [x] \`pnpm lint\` — clean
- [x] \`pnpm pack:check\` — passes
- [x] Manual smoke against \`examples/chat\` with an \`OPENAI_API_KEY\`: agent calls \`write_todos\` → \`plan_update\` event observable in the stream

## Backwards compatibility
Routes without \`plan.md\` are byte-for-byte identical in behavior. The capability marker's \`detect\` returns \`false\` and no contribution is added. No existing routes need to change.

## Follow-up
- A separate PR adds \`plan.md\` to \`examples/chat/server/src/app/chat/\` and demonstrates planning in the smoke client.
- Sub-project 2 (skills + AGENTS.md autoload) reuses the autowiring engine from this PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Print the PR URL**

The `gh pr create` command prints the URL; capture it for the final summary.

---

## Final checks (controller-side, not subagent task)

- After PR opens: watch CI with `gh pr checks <N> --watch`. If `validate` fails, diagnose with `gh run view --log-failed`.
- If green: `gh pr merge <N> --squash --delete-branch --auto` (or `--admin` per user instruction).
- After merge: clean up the worktree (`git worktree remove .claude/worktrees/phase3-planning`) and the local branch (`git branch -D claude/phase3-planning`).
