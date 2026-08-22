# Dawn Workbench Foundation Implementation Plan (SP2a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Dawn Workbench's foundation in `examples/research/web` — the design tokens, the thread seam, the app shell with a working thread rail, and a custom transcript that renders SP1's activity cards through the customization ladder — proving the ladder can reproduce the flagship look.

**Architecture:** Replace CopilotKit's packaged `CopilotSidebar` with a custom shell built on `@copilotkit/react-core/v2/headless` (`useAgent`, `useInterrupt`, `useConfigureSuggestions`). Tailwind v4 provides utilities; one `theme.css` owns every token. Threads go through a `ThreadSource` interface with a localStorage implementation. Activity cards are thin wrappers that customize SP1's package cards rather than forking them.

**Tech Stack:** Next 16 App Router, React 19, Tailwind v4, `@copilotkit/react-core/v2/headless`, `@dawn-ai/ag-ui/react`, Vitest with `react-dom/server`, Node 24, pnpm 10, Biome.

**Approved spec:** `docs/superpowers/specs/2026-08-19-dawn-workbench-design.md` (SP2 of 4).

**Scope:** This is SP2a — the foundation. The memory panel, the generic tool card, the connect screen, and thread hydration from `/threads/:id/state` land in SP2b once this shell exists to hang them on. SP2a ends with a workbench you can talk to that renders plan and subagent cards inline, in Dawn's design, with threads you can create and switch.

**Execution baseline:** Branch `blove/dawn-workbench` (already created) off `main` at `fb52e062`. This plan changes dependencies, so `pnpm install` without `--frozen-lockfile` is expected; commit the lockfile change. Never hand-edit it.

**Toolchain trap:** Prefix every node/pnpm command with `export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && ` — shell state does not persist and the default shell is Node 22. Never run bare `biome check --write`; pass explicit paths with `--config-path packages/config-biome/biome.json`.

## Two findings that shape this plan

**CopilotKit v2 has a headless entry.** `@copilotkit/react-core/v2/headless` exports `useAgent`, `useInterrupt`, `useConfigureSuggestions`, `useSuggestions`, `useRenderToolCall`, `defineToolCallRenderer`, `useCopilotKit`, and `useThreads`. A custom transcript is fully supported — we are not fighting the library.

**Do NOT use `useThreads`.** Its own docs say it fetches "from the platform" and folds "runtime without thread endpoints" into its error channel. Dawn's server has no thread-list endpoint — threads can be created and fetched by id, not enumerated. Reaching for `useThreads` against a Dawn backend surfaces a config error. That is exactly why the spec calls for a `ThreadSource` seam with a localStorage implementation now, and LangGraph Platform later (where those endpoints do exist).

---

### Task 0: Baseline

- [ ] **Step 1: Confirm branch and a green starting point**

```bash
git branch --show-current   # blove/dawn-workbench
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web build
```

Expected: build succeeds. Note the example currently renders `CopilotSidebar`; that is what this plan replaces.

---

### Task 1: Tailwind v4 and the theme

**Files:**
- Modify: `examples/research/web/package.json`
- Create: `examples/research/web/app/theme.css`
- Modify: `examples/research/web/app/layout.tsx`
- Modify: `examples/research/web/postcss.config.mjs` (create if absent)

- [ ] **Step 1: Add Tailwind**

Add to `dependencies`: `"tailwindcss": "^4.1.0"` and `"@tailwindcss/postcss": "^4.1.0"`. Check `packages/inspector/package.json` for the versions actually in this repo's lockfile and match them rather than inventing a range.

Create `postcss.config.mjs`:

```js
export default { plugins: { "@tailwindcss/postcss": {} } }
```

- [ ] **Step 2: Write the theme**

Create `app/theme.css`. This is the one file a developer edits to restyle the app, and it also drives SP1's cards by overriding their tokens — that is rung 1 of the ladder, exercised for real:

```css
@import "tailwindcss";

/*
 * Every color the workbench uses. Restyling the app is editing this file.
 *
 * The dawn gradient appears in exactly two places by design — the brand mark
 * and the primary action — so the app reads as a tool that happens to be
 * named Dawn rather than a themed demo.
 */
:root {
  --wb-bg: #fafafa;
  --wb-surface: #ffffff;
  --wb-border: #e4e4e7;
  --wb-text: #18181b;
  --wb-muted: #71717a;
  --wb-rail: #f4f4f5;
  --wb-accent-from: #f97316;
  --wb-accent-to: #ec4899;
  --wb-radius: 10px;

  /* Rung 1: the packaged activity cards inherit the workbench palette. */
  --dawn-activity-surface: var(--wb-surface);
  --dawn-activity-border: var(--wb-border);
  --dawn-activity-text: var(--wb-text);
  --dawn-activity-muted: var(--wb-muted);
  --dawn-activity-radius: var(--wb-radius);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-wb-theme="light"]) {
    --wb-bg: #0c0d10;
    --wb-surface: #141519;
    --wb-border: #26272d;
    --wb-text: #e4e6eb;
    --wb-muted: #8b909c;
    --wb-rail: #101114;
  }
}

:root[data-wb-theme="dark"] {
  --wb-bg: #0c0d10;
  --wb-surface: #141519;
  --wb-border: #26272d;
  --wb-text: #e4e6eb;
  --wb-muted: #8b909c;
  --wb-rail: #101114;
}

.wb-brand-mark {
  background: linear-gradient(135deg, var(--wb-accent-from), var(--wb-accent-to));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.wb-primary-action {
  background: linear-gradient(135deg, var(--wb-accent-from), var(--wb-accent-to));
  color: #ffffff;
}
```

Note the activity-token overrides deliberately do NOT set `--dawn-activity-running`/`-complete`/`-failed`: SP1's status colors are already correct and semantic, and overriding them would be restyling for its own sake.

- [ ] **Step 3: Import it**

In `app/layout.tsx`, add `import "./theme.css"` **after** the two existing CSS imports so the token overrides win, and replace the inline `body` style with Tailwind classes plus the background token. Keep both existing imports and the comment explaining why the activity stylesheet is required.

- [ ] **Step 4: Verify and commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm install
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web build
```

Expected: build succeeds and Tailwind processes the sheet. If Next reports an unknown at-rule for `@import "tailwindcss"`, PostCSS is not wired — fix the config, not the CSS.

```bash
git add examples/research/web pnpm-lock.yaml
git commit -m "feat(example): add the workbench theme"
```

---

### Task 2: The ThreadSource seam

**Files:**
- Create: `examples/research/web/app/lib/thread-source.ts`
- Create: `examples/research/web/app/lib/thread-source.test.ts`
- Modify: `examples/research/web/vitest.config.ts`

- [ ] **Step 1: Write the failing tests**

The example's vitest config currently matches `app/**/*.test.{ts,tsx}` and passes with no tests. Confirm that glob covers `.ts` AND `.tsx` before relying on it — a mismatch collects zero tests while exiting 0, which has bitten this repo twice.

```ts
import { beforeEach, describe, expect, test } from "vitest"
import { createLocalThreadSource } from "./thread-source.js"

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  } as Storage
}

describe("local thread source", () => {
  let storage: Storage

  beforeEach(() => {
    storage = memoryStorage()
  })

  test("starts empty", () => {
    expect(createLocalThreadSource(storage).list()).toEqual([])
  })

  test("creates a thread with an id and no title", () => {
    const source = createLocalThreadSource(storage)
    const thread = source.create()
    expect(thread.id).toMatch(/[0-9a-f-]{36}/)
    expect(thread.title).toBeUndefined()
    expect(source.list()).toEqual([thread])
  })

  test("titles a thread from its first user message and keeps the first only", () => {
    const source = createLocalThreadSource(storage)
    const thread = source.create()
    source.touch(thread.id, "Compare the agent architectures in the corpus")
    source.touch(thread.id, "And summarize them")
    expect(source.list()[0]?.title).toBe("Compare the agent architectures in the corpus")
  })

  test("truncates a long title", () => {
    const source = createLocalThreadSource(storage)
    const thread = source.create()
    source.touch(thread.id, "x".repeat(200))
    const title = source.list()[0]?.title ?? ""
    expect(title.length).toBeLessThanOrEqual(80)
  })

  test("lists most recently active first", () => {
    const source = createLocalThreadSource(storage)
    const first = source.create()
    const second = source.create()
    source.touch(first.id, "older")
    source.touch(second.id, "newer")
    expect(source.list().map((thread) => thread.id)).toEqual([second.id, first.id])
  })

  test("survives a reload through storage", () => {
    const source = createLocalThreadSource(storage)
    const thread = source.create()
    source.touch(thread.id, "persisted")
    expect(createLocalThreadSource(storage).list()[0]?.title).toBe("persisted")
  })

  test("tolerates corrupt storage rather than throwing", () => {
    storage.setItem("dawn.workbench.threads", "{not json")
    expect(createLocalThreadSource(storage).list()).toEqual([])
  })

  test("ignores a touch for an unknown thread", () => {
    const source = createLocalThreadSource(storage)
    source.touch("nope", "orphan")
    expect(source.list()).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web test
```

Expected: FAIL — module not found. If instead it reports "No test files found" and exits 0, the vitest `include` glob does not match this path — fix the glob first, and say so in your report.

- [ ] **Step 3: Implement**

```ts
/**
 * Where the thread rail gets its threads.
 *
 * Dawn's server can create and fetch a thread by id but cannot enumerate
 * threads — there is no list endpoint, and adding one is a thread-access
 * authorization question rather than a UI one. So the rail keeps its own list.
 *
 * CopilotKit's `useThreads` is deliberately unused: it fetches from a platform
 * with thread endpoints and folds "runtime without thread endpoints" into its
 * error channel, which is what a Dawn backend would produce.
 *
 * The planned second implementation is LangGraph Platform, which Dawn already
 * deploys to (`dawn build --target langsmith`) and which can enumerate threads.
 * Everything above this interface stays unchanged when that lands.
 */
export interface WorkbenchThread {
  readonly id: string
  readonly title?: string
  readonly lastActiveAt: number
}

export interface ThreadSource {
  list(): WorkbenchThread[]
  create(): WorkbenchThread
  touch(id: string, firstUserMessage?: string): void
}

const STORAGE_KEY = "dawn.workbench.threads"
const MAX_TITLE_LENGTH = 80

function read(storage: Storage): WorkbenchThread[] {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is WorkbenchThread =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "string" &&
        typeof (entry as { lastActiveAt?: unknown }).lastActiveAt === "number",
    )
  } catch {
    // A corrupt or unavailable store costs the rail its history, never the run.
    return []
  }
}

function write(storage: Storage, threads: readonly WorkbenchThread[]): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(threads))
  } catch {
    // Private-mode quota failures must not break the conversation.
  }
}

function byMostRecent(threads: readonly WorkbenchThread[]): WorkbenchThread[] {
  return [...threads].sort((left, right) => right.lastActiveAt - left.lastActiveAt)
}

export function createLocalThreadSource(storage: Storage): ThreadSource {
  return {
    list() {
      return byMostRecent(read(storage))
    },
    create() {
      const thread: WorkbenchThread = {
        id: globalThis.crypto.randomUUID(),
        lastActiveAt: Date.now(),
      }
      write(storage, [thread, ...read(storage)])
      return thread
    },
    touch(id, firstUserMessage) {
      const threads = read(storage)
      const existing = threads.find((thread) => thread.id === id)
      if (existing === undefined) return
      const title =
        existing.title ??
        (firstUserMessage === undefined || firstUserMessage.trim().length === 0
          ? undefined
          : firstUserMessage.trim().slice(0, MAX_TITLE_LENGTH))
      const updated: WorkbenchThread = {
        id,
        lastActiveAt: Date.now(),
        ...(title !== undefined ? { title } : {}),
      }
      write(storage, [updated, ...threads.filter((thread) => thread.id !== id)])
    },
  }
}
```

- [ ] **Step 4: Verify and commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web test
```

Expected: 8 passed. Assert the count — "no test files found" also exits 0.

The `lastActiveAt` ordering test can be flaky if two `Date.now()` calls land in the same millisecond. If it flakes, make `create`/`touch` accept an injected clock rather than adding a sleep.

```bash
git add examples/research/web
git commit -m "feat(example): add the workbench thread source"
```

---

### Task 3: Activity wrappers — the dogfood

**Files:**
- Create: `examples/research/web/app/components/PlanCard.tsx`, `SubagentCard.tsx`
- Create: `examples/research/web/app/components/activity-renderers.tsx`
- Create: `examples/research/web/app/components/activity-renderers.test.tsx`

This is the task the whole arc points at. These wrappers must reach the flagship look through SP1's ladder — tokens (already applied in Task 1), `classNames`, and `components`. **If you cannot match the design without forking a card, stop and report it: that is a gap in the package to fix in SP1, not something to work around here.**

- [ ] **Step 1: Write the wrappers**

```tsx
import { PlanActivityCard, type DawnActivityClassNames } from "@dawn-ai/ag-ui/react"
import type { DawnPlanActivityContent } from "@dawn-ai/ag-ui"

/**
 * The workbench's plan card: SP1's component, customized through the ladder.
 *
 * Rung 1 (palette) is applied globally in `app/theme.css`. This adds rung 2 —
 * Tailwind utilities per part. Nothing here reimplements the card, so the
 * validation and the bounded-content rules stay where they are tested.
 */
const planClassNames: DawnActivityClassNames = {
  root: "shadow-sm",
  header: "text-sm tracking-tight",
  meta: "tabular-nums",
  itemLabel: "leading-relaxed",
}

export function PlanCard({ content }: { content: DawnPlanActivityContent }) {
  return <PlanActivityCard content={content} classNames={planClassNames} />
}
```

Write `SubagentCard.tsx` the same way, importing `SubagentActivityCard` and `SubagentActivityContentOutput` from `@dawn-ai/ag-ui/react`, with its own `classNames` object. Do NOT import the content type from the `/react` entry — `DawnPlanActivityContent` lives on the package root, which the `/react` docstring states explicitly.

- [ ] **Step 2: Register them**

```tsx
import {
  DAWN_PLAN_ACTIVITY_TYPE,
  DAWN_SUBAGENT_ACTIVITY_TYPE,
} from "@dawn-ai/ag-ui"
import { planActivityContentSchema, subagentActivityContentSchema } from "@dawn-ai/ag-ui/react"
import { PlanCard } from "./PlanCard"
import { SubagentCard } from "./SubagentCard"

/**
 * The workbench registers its own wrappers rather than `dawnActivityRenderers`
 * so the cards are the app's to restyle — the same source a scaffolded app will
 * own. The schemas still come from the package, so validation stays identical.
 */
export const workbenchActivityRenderers = [
  {
    activityType: DAWN_PLAN_ACTIVITY_TYPE,
    content: planActivityContentSchema,
    render: ({ content }: { content: Parameters<typeof PlanCard>[0]["content"] }) => (
      <PlanCard content={content} />
    ),
  },
  {
    activityType: DAWN_SUBAGENT_ACTIVITY_TYPE,
    content: subagentActivityContentSchema,
    render: ({ content }: { content: Parameters<typeof SubagentCard>[0]["content"] }) => (
      <SubagentCard content={content} />
    ),
  },
]
```

If the `ReactActivityMessageRenderer` type from `@copilotkit/react-core/v2` is needed for a `satisfies` clause, import it — read how `packages/ag-ui/src/react/renderers.tsx` does it and mirror that, since it is the proven shape.

- [ ] **Step 3: Test that customization actually applied**

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { PlanCard } from "./PlanCard"

const CONTENT = {
  todos: [
    { content: "Search the corpus", status: "completed" },
    { content: "Read the best sources", status: "in_progress" },
  ],
} as const

describe("workbench plan card", () => {
  test("keeps the package defaults and adds the workbench classes", () => {
    const markup = renderToStaticMarkup(<PlanCard content={CONTENT} />)
    expect(markup).toContain("dawn-activity shadow-sm")
    expect(markup).toContain("dawn-activity__meta tabular-nums")
  })

  test("still renders the package's content and bounds", () => {
    const markup = renderToStaticMarkup(<PlanCard content={CONTENT} />)
    expect(markup).toContain("Search the corpus")
    expect(markup).toContain("dawn-activity__item--in_progress")
  })
})
```

Add the equivalent for `SubagentCard`.

- [ ] **Step 4: Verify and commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web test
```

Expected: 8 + 4 = 12 passed.

```bash
git add examples/research/web/app/components
git commit -m "feat(example): customize the activity cards for the workbench"
```

---

### Task 4: The shell, rail, transcript, and composer

**Files:**
- Create: `examples/research/web/app/components/AppShell.tsx`, `ThreadRail.tsx`, `Transcript.tsx`, `Composer.tsx`, `EmptyState.tsx`
- Modify: `examples/research/web/app/page.tsx`

**Why this task specifies rather than dictates.** Every other task here carries complete source. This one gives structure, props, classes, and behavior instead, for one reason: the transcript's shape depends on `useAgent`'s return type, and this plan's author has not read it. Writing speculative code against an unread API would produce something that looks authoritative and is wrong — worse than an accurate specification. **Read `node_modules/@copilotkit/react-core/dist/v2/headless.d.mts` for `useAgent`, `useInterrupt`, and the message types before writing this task**, and report the actual shapes in your summary so later tasks can rely on them.

- [ ] **Step 1: Build the shell**

`AppShell` owns the two-column layout: a fixed-width rail (`w-64`, `bg-[var(--wb-rail)]`, right border) and a `flex-1` main column holding the transcript above the composer. Use Tailwind utilities with the theme's CSS variables via arbitrary values (`bg-[var(--wb-surface)]`, `text-[var(--wb-text)]`, `border-[var(--wb-border)]`). It renders the brand mark with `wb-brand-mark` at the rail's top.

`ThreadRail` takes `threads`, `activeThreadId`, `onSelect`, and `onCreate` as props — it holds no state and does no storage access, so it is trivially testable. The active thread gets a filled background; the rest are hover-highlighted buttons.

`Transcript` calls `useAgent()` from `@copilotkit/react-core/v2/headless` and maps its messages in order. Read the hook's return type in `node_modules/@copilotkit/react-core/dist/v2/headless.d.mts` before writing this — do not guess the message shape. Assistant text renders as prose; activity messages route through the renderers registered on the provider; tool calls render via the existing `ToolCallCard` registration, which stays as-is in this slice.

`Composer` is a textarea plus a send button carrying `wb-primary-action`. Enter sends, Shift+Enter newlines, and the button is disabled while a run is in flight.

`EmptyState` shows the brand mark, one line about what this app does, and the suggestions — it is the first impression, so the suggestions are its center, not a footnote.

- [ ] **Step 2: Rewire `page.tsx`**

Keep the `CopilotKit` provider with `runtimeUrl`, `defaultThrottleMs={100}`, and the existing comment block (it records hard-won knowledge about the throttle and the v2 import paths — do not delete it). Change `renderActivityMessages` to `workbenchActivityRenderers`, drop `CopilotSidebar`, and render `AppShell` instead. Keep `DemoSuggestions`, `PermissionInterrupt`, and `ToolCallCard` mounted — they are registration-only components.

Wire the thread state: create the `ThreadSource` lazily in a `useState` initializer (it touches `localStorage`, which does not exist during SSR — guard with `typeof window === "undefined"`), keep `threads` and `activeThreadId` in state, and pass the CopilotKit thread id down so switching a thread actually switches the conversation.

- [ ] **Step 3: Verify the whole thing builds and renders**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web build
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web test
```

Both must pass. A build failure mentioning `localStorage` or `window` means the SSR guard is missing.

- [ ] **Step 4: Commit**

```bash
git add examples/research/web/app
git commit -m "feat(example): build the workbench shell"
```

---

### Task 5: Verification and handoff

- [ ] **Step 1: Full gates**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm build; echo "EXIT=$?"
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm lint; echo "EXIT=$?"
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && node scripts/check-docs.mjs; echo "EXIT=$?"
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/research-web test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui test
```

No changeset: `@dawn-example/research-web` is private and unpublished.

- [ ] **Step 2: Update the example README**

Describe the layout, name `app/theme.css` as the one file to edit for restyling, state that the activity cards are customized package components rather than forks, and record the thread limits: the list is local to the browser, and switching a thread does not yet restore its history (SP2b).

- [ ] **Step 3: Report the dogfood result**

In the PR body, state plainly whether the flagship look was reachable through the ladder. If any part required forking a card or a `!important`, that is an SP1 gap — name it precisely so it can be fixed in the package rather than absorbed here.

- [ ] **Step 4: Review and finish**

superpowers:requesting-code-review on `git diff main...HEAD`, then superpowers:finishing-a-development-branch. PR title: `feat(example): build the Dawn Workbench foundation`.

---

## Out of scope (SP2b and later)

- Memory-candidate panel and the consolidated allowlisted `/api/dawn/[...path]` proxy.
- Thread hydration from `GET /threads/:id/state`, and the in-app note that historical subagent cards do not restore.
- `ConnectScreen` for an unreachable server.
- Replacing `ToolCallCard` with a themed generic tool card.
- Scaffold integration (SP3) and the Playwright gate (SP4).
