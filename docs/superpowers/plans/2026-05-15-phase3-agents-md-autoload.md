# Phase 3 — AGENTS.md Autoload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add a built-in capability that auto-injects `<workspace>/AGENTS.md` into the agent's system prompt on every model turn, preserving the agent-updates-its-own-memory loop.

**Architecture:** New `createAgentsMdMarker()` in `@dawn-ai/core` returns a contribution with one promptFragment (no tools, no state, no transformers). `prepareRouteExecution` registers it alongside the existing planning marker. Render re-reads the file each turn via `readFileSync`, wrapped in try/catch for stat races.

**Tech Stack:** TypeScript 6.0.2, pnpm/turbo, vitest, `@dawn-ai/{core,langchain,cli}`.

**Spec:** [docs/superpowers/specs/2026-05-15-phase3-agents-md-autoload-design.md](../specs/2026-05-15-phase3-agents-md-autoload-design.md)

**Working directory:** `/Users/blove/repos/dawn/.claude/worktrees/agents-md` (branch `claude/agents-md`).

---

## File map

**Create:**
- `packages/core/src/capabilities/built-in/agents-md.ts`
- `packages/core/test/capabilities/agents-md.test.ts`
- `packages/langchain/test/agents-md.test.ts`
- `.changeset/phase3-agents-md.md`

**Modify:**
- `packages/core/src/index.ts` — re-export `createAgentsMdMarker`
- `packages/cli/src/lib/runtime/execute-route.ts` — add `createAgentsMdMarker()` to the registry array
- `examples/chat/server/src/app/chat/system-prompt.ts` — remove the "if AGENTS.md exists, run readFile" instruction
- `examples/chat/README.md` — note AGENTS.md autoload is shipped (move out of deferred)

---

## Task 1: Marker implementation + tests

**Files:**
- Create: `packages/core/src/capabilities/built-in/agents-md.ts`
- Create: `packages/core/test/capabilities/agents-md.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/test/capabilities/agents-md.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createAgentsMdMarker } from "../../src/capabilities/built-in/agents-md.js"

describe("createAgentsMdMarker", () => {
  let routeDir: string
  let workDir: string
  let originalCwd: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "dawn-agents-md-"))
    routeDir = join(workDir, "route")
    mkdirSync(routeDir, { recursive: true })
    originalCwd = process.cwd()
    process.chdir(workDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(workDir, { recursive: true, force: true })
  })

  it("always detects (returns true)", async () => {
    const marker = createAgentsMdMarker()
    expect(await marker.detect(routeDir)).toBe(true)
  })

  it("load returns a single promptFragment, no tools/state/transformers", async () => {
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.promptFragment?.placement).toBe("after_user_prompt")
    expect(contribution.tools).toBeUndefined()
    expect(contribution.stateFields).toBeUndefined()
    expect(contribution.streamTransformers).toBeUndefined()
  })

  it("renders empty string when workspace/AGENTS.md does not exist", async () => {
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.promptFragment?.render({})).toBe("")
  })

  it("renders content under '# Memory' heading when file exists", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    writeFileSync(join(workDir, "workspace", "AGENTS.md"), "Remember the pnpm convention.")
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir)
    const out = contribution.promptFragment?.render({}) ?? ""
    expect(out).toContain("# Memory")
    expect(out).toContain("Remember the pnpm convention.")
  })

  it("returns empty string when file is whitespace-only", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    writeFileSync(join(workDir, "workspace", "AGENTS.md"), "   \n\n  \n")
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.promptFragment?.render({})).toBe("")
  })

  it("returns size-notice (not body) when file exceeds 64 KiB", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    const big = "x".repeat(65 * 1024)
    writeFileSync(join(workDir, "workspace", "AGENTS.md"), big)
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir)
    const out = contribution.promptFragment?.render({}) ?? ""
    expect(out).toContain("# Memory")
    expect(out).toContain("exceeds 64 KiB")
    expect(out).not.toContain("xxxxxxxxxxx") // body NOT included
  })

  it("returns empty string when AGENTS.md is a directory (read throws)", async () => {
    mkdirSync(join(workDir, "workspace", "AGENTS.md"), { recursive: true })
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir)
    expect(contribution.promptFragment?.render({})).toBe("")
  })

  it("re-reads the file on each render call", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    const path = join(workDir, "workspace", "AGENTS.md")
    writeFileSync(path, "first")
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir)
    const first = contribution.promptFragment?.render({}) ?? ""
    expect(first).toContain("first")
    writeFileSync(path, "second")
    const second = contribution.promptFragment?.render({}) ?? ""
    expect(second).toContain("second")
    expect(second).not.toContain("first")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @dawn-ai/core test -- agents-md.test
```
Expected: FAIL — `Cannot find module '../../src/capabilities/built-in/agents-md.js'`.

- [ ] **Step 3: Implement the marker**

Create `packages/core/src/capabilities/built-in/agents-md.ts`:

```ts
import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import type { CapabilityMarker } from "../types.js"

const MAX_MEMORY_BYTES = 64 * 1024
const MEMORY_HEADER = "# Memory"

/**
 * Auto-injects the contents of <process.cwd()>/workspace/AGENTS.md into the
 * agent's system prompt under a "# Memory" heading. Always-on: the presence
 * of the file IS the opt-in. Re-reads the file on every model turn so the
 * agent sees its own updated memory immediately after it calls writeFile.
 */
export function createAgentsMdMarker(): CapabilityMarker {
  return {
    name: "agents-md",
    detect: async () => true,
    load: async () => ({
      promptFragment: {
        placement: "after_user_prompt",
        render: () => renderMemoryFragment(workspaceAgentsMdPath()),
      },
    }),
  }
}

function workspaceAgentsMdPath(): string {
  return resolve(process.cwd(), "workspace", "AGENTS.md")
}

function renderMemoryFragment(path: string): string {
  if (!existsSync(path)) return ""

  let size: number
  try {
    size = statSync(path).size
  } catch {
    return ""
  }

  if (size > MAX_MEMORY_BYTES) {
    return `${MEMORY_HEADER}\n\n(workspace/AGENTS.md is ${size} bytes; exceeds ${MAX_MEMORY_BYTES} byte (64 KiB) limit — not loaded)`
  }

  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return ""
  }

  const trimmed = raw.trim()
  if (trimmed.length === 0) return ""

  return `${MEMORY_HEADER}\n\n${trimmed}`
}
```

- [ ] **Step 4: Re-export from core**

Edit `packages/core/src/index.ts`. Append:

```ts
export { createAgentsMdMarker } from "./capabilities/built-in/agents-md.js"
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @dawn-ai/core test -- agents-md.test
```
Expected: 8/8 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/capabilities/built-in/agents-md.ts \
        packages/core/test/capabilities/agents-md.test.ts \
        packages/core/src/index.ts
git commit -m "feat(core): agents-md CapabilityMarker (autoload workspace/AGENTS.md into system prompt)"
```

---

## Task 2: Register the marker in the runtime

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`

- [ ] **Step 1: Locate the registry creation**

```bash
grep -n "createCapabilityRegistry\|createPlanningMarker" packages/cli/src/lib/runtime/execute-route.ts
```

You'll find a line like:
```ts
const registry = createCapabilityRegistry([createPlanningMarker()])
```

- [ ] **Step 2: Add the new marker**

Update the imports at the top to include `createAgentsMdMarker`:

```ts
import {
  applyCapabilities,
  createAgentsMdMarker,
  createCapabilityRegistry,
  createPlanningMarker,
  // ... existing imports
} from "@dawn-ai/core"
```

Change the registry construction to:

```ts
const registry = createCapabilityRegistry([
  createPlanningMarker(),
  createAgentsMdMarker(),
])
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @dawn-ai/cli typecheck
```
Expected: passes.

- [ ] **Step 4: Run cli tests to confirm no regression**

```bash
pnpm --filter @dawn-ai/cli test
```
Expected: existing test count unchanged, all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/execute-route.ts
git commit -m "feat(cli): register agents-md capability marker"
```

---

## Task 3: End-to-end shape test in langchain

**Files:**
- Create: `packages/langchain/test/agents-md.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/langchain/test/agents-md.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  applyCapabilities,
  createAgentsMdMarker,
  createCapabilityRegistry,
} from "@dawn-ai/core"

describe("agents-md capability — end-to-end shape", () => {
  let routeDir: string
  let workDir: string
  let originalCwd: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "dawn-agents-md-e2e-"))
    routeDir = join(workDir, "route")
    mkdirSync(routeDir, { recursive: true })
    originalCwd = process.cwd()
    process.chdir(workDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(workDir, { recursive: true, force: true })
  })

  it("always contributes a promptFragment", async () => {
    const registry = createCapabilityRegistry([createAgentsMdMarker()])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions).toHaveLength(1)
    expect(result.contributions[0]?.contribution.promptFragment?.placement).toBe(
      "after_user_prompt",
    )
  })

  it("renders memory content when workspace/AGENTS.md exists", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    writeFileSync(join(workDir, "workspace", "AGENTS.md"), "Use pnpm, not npm.")
    const registry = createCapabilityRegistry([createAgentsMdMarker()])
    const result = await applyCapabilities(registry, routeDir)
    const fragment = result.contributions[0]?.contribution.promptFragment
    const rendered = fragment?.render({}) ?? ""
    expect(rendered).toContain("# Memory")
    expect(rendered).toContain("Use pnpm, not npm.")
  })

  it("renders empty when workspace/AGENTS.md is absent", async () => {
    const registry = createCapabilityRegistry([createAgentsMdMarker()])
    const result = await applyCapabilities(registry, routeDir)
    const fragment = result.contributions[0]?.contribution.promptFragment
    expect(fragment?.render({})).toBe("")
  })

  it("renders updated content after the file is rewritten", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    const path = join(workDir, "workspace", "AGENTS.md")
    writeFileSync(path, "before")
    const registry = createCapabilityRegistry([createAgentsMdMarker()])
    const result = await applyCapabilities(registry, routeDir)
    const fragment = result.contributions[0]?.contribution.promptFragment
    expect(fragment?.render({})).toContain("before")
    writeFileSync(path, "after")
    expect(fragment?.render({})).toContain("after")
    expect(fragment?.render({})).not.toContain("before")
  })
})
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @dawn-ai/langchain test -- agents-md.test
```
Expected: 4/4 pass.

- [ ] **Step 3: Confirm full langchain suite**

```bash
pnpm --filter @dawn-ai/langchain test
```
Expected: 38 + 4 = 42 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/langchain/test/agents-md.test.ts
git commit -m "test(langchain): agents-md capability end-to-end shape"
```

---

## Task 4: Update the chat example (system prompt + README)

**Files:**
- Modify: `examples/chat/server/src/app/chat/system-prompt.ts`
- Modify: `examples/chat/README.md`

- [ ] **Step 1: Trim the system prompt**

`examples/chat/server/src/app/chat/system-prompt.ts` currently contains a paragraph telling the agent to manually read AGENTS.md. After this change, Dawn auto-injects it; the line is redundant and slightly contradictory.

Replace the "Memory convention" paragraph with a shorter version that keeps the "update when meaningful work happens" guidance but drops the "read at start" instruction.

Read the file first:
```bash
cat examples/chat/server/src/app/chat/system-prompt.ts
```

Then edit so the Memory convention paragraph reads:

> Memory convention: when you complete meaningful work, update `AGENTS.md` (via `writeFile`) so future-you remembers what mattered. Dawn auto-injects the current contents of `workspace/AGENTS.md` into your system prompt on every turn — you don't need to read it manually.

Keep the rest of the file (the four tools list, the "Keep replies short" paragraph) unchanged.

- [ ] **Step 2: Update README**

`examples/chat/README.md` — bump AGENTS.md autoload out of the "Deferred" section. The current "Deferred" list mentions:
> - `AGENTS.md` auto-injection — needs the skills convention

Remove that line (the dependency was wrong; AGENTS.md autoload turned out to be smaller than skills and shipped on its own).

In "What this shows," add a bullet for memory autoload alongside the existing bullets. Suggested wording:

> - `AGENTS.md` memory autoload — Dawn auto-injects `workspace/AGENTS.md` into the system prompt on every turn; the agent updates it via `writeFile`

- [ ] **Step 3: Typecheck the example server**

```bash
pnpm --filter @dawn-example/chat-server typecheck
```
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add examples/chat/server/src/app/chat/system-prompt.ts examples/chat/README.md
git commit -m "feat(examples/chat): rely on Dawn AGENTS.md autoload instead of manual readFile"
```

---

## Task 5: Full workspace verification (controller-side)

The controller runs this; not a subagent task. After tasks 1-4 are merged into the branch:

- [ ] `pnpm install` — clean
- [ ] `pnpm build` — all packages build
- [ ] `pnpm typecheck` — all packages
- [ ] `pnpm test` — full suite passes (added: 8 core + 4 langchain = 12 new tests)
- [ ] `pnpm lint` — clean (run `biome check --write` on new test files if imports need sorting; recommit as a `style:` commit if so)
- [ ] `pnpm pack:check` — passes

If lint fails on new files, run biome's auto-fix for each affected package and commit:
```bash
pnpm --filter @dawn-ai/core exec biome check --write --config-path ../config-biome/biome.json package.json src test tsconfig.json vitest.config.ts
pnpm --filter @dawn-ai/langchain exec biome check --write --config-path ../config-biome/biome.json package.json src test tsconfig.json vitest.config.ts
```

---

## Task 6: Changeset

**Files:**
- Create: `.changeset/phase3-agents-md.md`

- [ ] **Step 1: Create the changeset**

```markdown
---
"@dawn-ai/core": minor
"@dawn-ai/cli": minor
---

Add the `agents-md` built-in capability: Dawn now auto-injects `<workspace>/AGENTS.md` into every agent's system prompt under a `# Memory` heading on every model turn. Always-on (no opt-in marker). Preserves the feedback loop — the agent updates its memory via `writeFile` and the next turn sees the change automatically. Re-reads the file each turn (64 KiB cap; oversize, empty, or unreadable files render empty or a one-line notice).
```

- [ ] **Step 2: Commit**

```bash
git add .changeset/phase3-agents-md.md
git commit -m "chore: changeset for phase-3 agents-md autoload"
```

---

## Task 7: Push + PR (controller-side)

- [ ] Push: `git push -u origin claude/agents-md`
- [ ] Open PR via `gh pr create` with summary + spec/plan links + test plan + follow-up note (a separate PR will demonstrate the feature in the chat example smoke test).
- [ ] Enable auto-merge: `gh pr merge <N> --squash --delete-branch --auto`
- [ ] Wait for CI; if green, the PR auto-merges (review gate is off as of session 2026-05-15).
- [ ] After merge: clean up worktree.
