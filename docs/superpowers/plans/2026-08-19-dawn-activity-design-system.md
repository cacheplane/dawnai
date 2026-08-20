# Dawn Activity Design System Implementation Plan (SP1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@dawn-ai/ag-ui/react`'s activity cards Dawn's visual identity by default, plus a four-rung customization ladder, so a drop-in consumer gets something that looks deliberate and a demanding consumer can take it anywhere.

**Architecture:** Replace the cards' inline styles with prefix-scoped class names, and ship the styling as an optional stylesheet at a new `@dawn-ai/ag-ui/react/styles.css` subpath — the same pattern `@copilotkit/react-core/v2/styles.css` uses and both Dawn examples already import. Theming is CSS custom properties (rung 1). Two new optional props add `classNames` for per-part class append (rung 2) and `components` for leaf-slot replacement (rung 3). Ejecting stays a documented copy (rung 4).

**Tech Stack:** TypeScript, React 19, Vitest with `react-dom/server`, Node 24, pnpm 10, Biome, Changesets. No Tailwind, no CSS-in-JS, no component library — the package must not impose a styling stack on consumers.

**Approved spec:** `docs/superpowers/specs/2026-08-19-dawn-activity-design-system-design.md`

**Execution baseline:** Branch off `main` at `2fc92f46` or later. This plan changes a published package's `exports` map and adds an asset, so `pnpm install` (no `--frozen-lockfile`) may be needed; commit any lockfile change. Never hand-edit `pnpm-lock.yaml`.

**Toolchain trap:** Prefix every node/pnpm command with `export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && ` — shell state does not persist between commands and the default shell is Node 22. Never run bare `biome check --write`; pass explicit paths with `--config-path packages/config-biome/biome.json`.

**Known traps from PR #484 (same package):**
1. The package's vitest `include` must match `.tsx`. A glob mismatch collects **zero** tests and exits 0 — always assert the test **count** changed, never just that a file exists.
2. Adding a subpath to `exports` red-lines `check-docs`, which runs in CI and `ci:validate`. It reveals requirements **one layer at a time**: registry entry, API MDX ownership table, `api.mdx` row, a README runtime+stability binding line, `api-reference.test.ts` expectations, and frozen counters. Task 2 does all of it in one pass.
3. `API_REQUIRED_CONTRACT_KEYS` is a frozen high-value baseline — do **not** add to it; the MDX ownership table is what satisfies export documentation.

---

## File structure

| File | Responsibility |
| --- | --- |
| `packages/ag-ui/src/react/styles.css` | **New.** Tokens + all default rules, every selector `dawn-activity`-prefixed |
| `packages/ag-ui/src/react/parts.ts` | **New.** The `ClassNames`/`Components` types and the tiny `cx` helper both cards share |
| `packages/ag-ui/src/react/ActivityChecklist.tsx` | List rendering; gains `classNames`/`components` pass-through |
| `packages/ag-ui/src/react/PlanActivityCard.tsx` | Plan card; classes instead of inline styles |
| `packages/ag-ui/src/react/SubagentActivityCard.tsx` | Subagent card; same |
| `packages/ag-ui/src/react/index.ts` | Adds the new public types |
| `packages/ag-ui/package.json` | `./react/styles.css` export entry; `files` already ships `dist` |
| `packages/ag-ui/test/react/styles.test.ts` | **New.** Selector-scoping and token presence, parsed from the CSS |
| `packages/ag-ui/test/react/customization.test.tsx` | **New.** The ladder: tokens, classNames append, component slots, bounds |

---

### Task 0: Baseline

- [ ] **Step 1: Branch and confirm the baseline is green**

```bash
git checkout main && git pull --ff-only
git checkout -b blove/ag-ui-activity-design-system
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui test
```

Expected: **174 passed**. Note that number — every later task states its expected count relative to it. If it differs, use the real number as your baseline and say so in your report.

---

### Task 1: The stylesheet

**Files:**
- Create: `packages/ag-ui/src/react/styles.css`
- Create: `packages/ag-ui/test/react/styles.test.ts`

The CSS is authored by hand and copied to `dist` by the build (Task 2 wires that). Every selector must start with `.dawn-activity` so the sheet cannot touch a consumer's markup.

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const CSS = readFileSync(
  fileURLToPath(new URL("../../src/react/styles.css", import.meta.url)),
  "utf8",
)

/** Selector text of every rule, excluding at-rule preludes. */
function selectors(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const out: string[] = []
  for (const match of withoutComments.matchAll(/(^|[}{;])\s*([^{}@]+?)\s*\{/g)) {
    const selector = match[2]?.trim()
    if (selector) out.push(selector)
  }
  return out
}

describe("styles.css", () => {
  test("defines the documented tokens with light values", () => {
    for (const token of [
      "--dawn-activity-surface",
      "--dawn-activity-border",
      "--dawn-activity-text",
      "--dawn-activity-muted",
      "--dawn-activity-accent",
      "--dawn-activity-running",
      "--dawn-activity-complete",
      "--dawn-activity-failed",
      "--dawn-activity-radius",
    ]) {
      expect(CSS).toContain(token)
    }
  })

  test("every rule is scoped to the dawn-activity prefix", () => {
    const unscoped = selectors(CSS).filter((selector) => {
      if (selector === ":root") return false
      return selector
        .split(",")
        .some((part) => !part.trim().includes(".dawn-activity"))
    })
    expect(unscoped).toEqual([])
  })

  test("ships a dark palette that an explicit light theme can override", () => {
    expect(CSS).toContain("prefers-color-scheme: dark")
    expect(CSS).toContain('[data-dawn-theme="dark"]')
    expect(CSS).toContain('[data-dawn-theme="light"]')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/ag-ui && npx vitest --run test/react/styles.test.ts
```

Expected: FAIL — `styles.css` does not exist.

- [ ] **Step 3: Write the stylesheet**

```css
/*
 * Dawn activity cards — default appearance.
 *
 * Import once in your app:
 *   import "@dawn-ai/ag-ui/react/styles.css"
 *
 * Rung 1 of the customization ladder: override any token below in your own CSS
 * to restyle without touching markup. Every selector here is scoped to the
 * `dawn-activity` prefix, so this sheet cannot affect the rest of your app.
 */

:root {
  --dawn-activity-surface: #ffffff;
  --dawn-activity-border: #e4e4e7;
  --dawn-activity-text: #18181b;
  --dawn-activity-muted: #71717a;
  --dawn-activity-accent: #ea580c;
  --dawn-activity-running: #2563eb;
  --dawn-activity-complete: #16a34a;
  --dawn-activity-failed: #9f1239;
  --dawn-activity-radius: 10px;
  --dawn-activity-gap: 8px;
  --dawn-activity-font-size: 13px;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-dawn-theme="light"]) {
    --dawn-activity-surface: #141519;
    --dawn-activity-border: #26272d;
    --dawn-activity-text: #e4e6eb;
    --dawn-activity-muted: #8b909c;
    --dawn-activity-accent: #fb923c;
    --dawn-activity-running: #60a5fa;
    --dawn-activity-complete: #4ade80;
    --dawn-activity-failed: #fb7185;
  }
}

:root[data-dawn-theme="dark"] {
  --dawn-activity-surface: #141519;
  --dawn-activity-border: #26272d;
  --dawn-activity-text: #e4e6eb;
  --dawn-activity-muted: #8b909c;
  --dawn-activity-accent: #fb923c;
  --dawn-activity-running: #60a5fa;
  --dawn-activity-complete: #4ade80;
  --dawn-activity-failed: #fb7185;
}

.dawn-activity {
  background: var(--dawn-activity-surface);
  border: 1px solid var(--dawn-activity-border);
  border-radius: var(--dawn-activity-radius);
  color: var(--dawn-activity-text);
  font-size: var(--dawn-activity-font-size);
  margin: 6px 0;
  padding: 8px 10px;
}

.dawn-activity__header {
  cursor: pointer;
  font-weight: 600;
  list-style: none;
}

.dawn-activity__title {
  min-width: 0;
  overflow-wrap: anywhere;
}

.dawn-activity__meta {
  color: var(--dawn-activity-muted);
  font-weight: 400;
}

.dawn-activity__badge {
  background: var(--dawn-activity-border);
  border-radius: 4px;
  font-size: 11px;
  margin-left: 6px;
  padding: 1px 5px;
}

.dawn-activity__section {
  margin-top: var(--dawn-activity-gap);
}

.dawn-activity__section-label {
  color: var(--dawn-activity-muted);
  font-size: 11px;
  font-weight: 600;
}

.dawn-activity__list {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
}

.dawn-activity__item {
  align-items: baseline;
  display: flex;
  gap: var(--dawn-activity-gap);
  margin-top: 4px;
}

.dawn-activity__item-glyph {
  color: var(--dawn-activity-muted);
}

.dawn-activity__item--running .dawn-activity__item-glyph {
  color: var(--dawn-activity-running);
}

.dawn-activity__item--completed .dawn-activity__item-glyph {
  color: var(--dawn-activity-complete);
}

.dawn-activity__item--incomplete .dawn-activity__item-glyph {
  color: var(--dawn-activity-failed);
}

.dawn-activity__item-label {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.dawn-activity__item-status {
  color: var(--dawn-activity-muted);
  font-size: 11px;
}

.dawn-activity__overflow {
  color: var(--dawn-activity-muted);
  font-size: 12px;
  margin-top: 5px;
}

.dawn-activity__error {
  color: var(--dawn-activity-failed);
  margin-top: var(--dawn-activity-gap);
  overflow-wrap: anywhere;
}
```

- [ ] **Step 4: Run to green, then commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/ag-ui && npx vitest --run test/react/styles.test.ts
```

Expected: 3 passed.

```bash
git add packages/ag-ui/src/react/styles.css packages/ag-ui/test/react/styles.test.ts
git commit -m "feat(ag-ui): add the activity stylesheet"
```

---

### Task 2: Ship the stylesheet as a subpath

**Files:**
- Modify: `packages/ag-ui/package.json`
- Modify: `apps/web/app/components/docs/api-reference.ts`
- Modify: `apps/web/content/docs/api/ag-ui.mdx`, `apps/web/content/docs/api.mdx`
- Modify: `packages/ag-ui/README.md`
- Modify: `apps/web/app/components/docs/api-reference.test.ts`, `scripts/check-docs.mjs`

`tsc` does not copy `.css`. The build script must.

- [ ] **Step 1: Copy the CSS during build and export it**

In `packages/ag-ui/package.json`, add to `exports`:

```json
    "./react/styles.css": "./dist/react/styles.css"
```

(No `types` condition — a CSS asset has none.)

Then extend the `build` script so the asset lands in `dist`. The script currently ends with `tsc -b tsconfig.json`; append a copy step:

```
&& node -e \"require('node:fs').copyFileSync('src/react/styles.css','dist/react/styles.css')\"
```

- [ ] **Step 2: Verify the packed artifact contains it**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui build
ls -l packages/ag-ui/dist/react/styles.css
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && node scripts/pack-check.mjs; echo "EXIT=$?"
```

Expected: the file exists and pack-check exits 0. If pack-check complains the export is missing from the packed artifact, the copy step did not run — fix the build script, not the test.

- [ ] **Step 3: Register the subpath across the docs system**

Run `node scripts/check-docs.mjs` and work the failures one at a time — it reveals them in layers. Expect to touch all of:

1. `ARTIFACT_REGISTRY` in `apps/web/app/components/docs/api-reference.ts` — add an entry beside the existing `@dawn-ai/ag-ui` `.`/`./react` ones. Read `runtimeImport`'s signature and the `RuntimeCompatibility`/`ApiReferenceCoverage` types before choosing arguments. A CSS asset exports no symbols, so `detailed` coverage (which demands documented exports) is the wrong shape — check whether `catalog-only` exists and is accepted here; if the registry has no coverage level that fits an asset, **STOP and report** rather than inventing documentation for exports that do not exist.
2. `apps/web/content/docs/api/ag-ui.mdx` — a `### @dawn-ai/ag-ui/react/styles.css` subsection describing the import line and the tokens, matching the neighbouring sections' format.
3. `apps/web/content/docs/api.mdx` — the catalog row's subpath list.
4. `packages/ag-ui/README.md` — a visible line binding the surface to its runtime and stability tokens. Note from PR #484: `check-docs` requires surface + runtime + stability on **one visible line**, so the token cannot be omitted, only explained around.
5. `apps/web/app/components/docs/api-reference.test.ts` and the frozen counters in `scripts/check-docs.mjs` (there is a **total** count and an **import** count — both may move).

- [ ] **Step 4: Verify and commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && node scripts/check-docs.mjs; echo "EXIT=$?"
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/web test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm lint; echo "EXIT=$?"
```

All must exit 0.

```bash
git add -A && git commit -m "build(ag-ui): ship the activity stylesheet as a subpath"
```

---

### Task 3: Shared parts vocabulary

**Files:**
- Create: `packages/ag-ui/src/react/parts.ts`

Both cards and the checklist need the same class-append helper and the same part names. One file, no logic beyond string joining.

- [ ] **Step 1: Write it**

```tsx
/**
 * Rungs 2 and 3 of the customization ladder.
 *
 * `classNames` entries are APPENDED to the package defaults, never substituted,
 * so a consumer can layer utility classes without fighting specificity. Slot
 * components replace a leaf's rendering while the card keeps ownership of
 * validation, ordering, and the bounded-content rules.
 */
import type { ReactNode } from "react"

/** Structural parts every activity surface can expose. */
export interface DawnActivityClassNames {
  readonly root?: string
  readonly header?: string
  readonly title?: string
  readonly meta?: string
  readonly badge?: string
  readonly section?: string
  readonly sectionLabel?: string
  readonly list?: string
  readonly item?: string
  readonly itemGlyph?: string
  readonly itemLabel?: string
  readonly itemStatus?: string
  readonly overflow?: string
  readonly error?: string
}

export interface DawnTodoRowProps {
  readonly content: string
  readonly status: "pending" | "in_progress" | "completed"
  readonly glyph: string
  readonly label: string
}

export interface DawnToolRowProps {
  readonly name: string
  readonly status: "running" | "completed" | "incomplete"
  readonly glyph: string
  readonly label: string
}

/** Leaf components a consumer may replace. */
export interface DawnActivityComponents {
  readonly TodoRow?: (props: DawnTodoRowProps) => ReactNode
  readonly ToolRow?: (props: DawnToolRowProps) => ReactNode
}

/** Join a package default with an optional consumer class. */
export function cx(base: string, extra?: string): string {
  return extra ? `${base} ${extra}` : base
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/ag-ui && npx tsc --noEmit
```

```bash
git add packages/ag-ui/src/react/parts.ts
git commit -m "feat(ag-ui): add the activity parts vocabulary"
```

---

### Task 4: Convert the cards to classes

**Files:**
- Modify: `packages/ag-ui/src/react/ActivityChecklist.tsx`, `PlanActivityCard.tsx`, `SubagentActivityCard.tsx`
- Modify: `packages/ag-ui/test/react/renderers.test.tsx`

Behavior stays identical: same DOM structure, same a11y attributes (`role="list"`, `aria-hidden` glyphs, `role="alert"` on the error, `aria-label` sections), same bounds (`limit = 8` todos; tools already bounded to five upstream), same `open` defaults. Only presentation moves from `style` to `className`.

- [ ] **Step 1: Update the existing suite's expectations first**

Read `packages/ag-ui/test/react/renderers.test.tsx`. Any assertion matching inline style strings must become a class assertion. Run it and see exactly which fail:

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/ag-ui && npx vitest --run test/react/renderers.test.tsx
```

Do **not** weaken an assertion to make it pass — if a test checked that a failed subagent renders its error in a distinct color, it should now check for `dawn-activity__error`.

- [ ] **Step 2: Convert `ActivityChecklist.tsx`**

```tsx
import type { DawnPlanActivityContent } from "../activities.js"
import { cx, type DawnActivityClassNames, type DawnActivityComponents } from "./parts.js"

const statusPresentation = {
  pending: { glyph: "○", label: "pending" },
  in_progress: { glyph: "◐", label: "in progress" },
  completed: { glyph: "✓", label: "completed" },
} as const

export function ActivityChecklist({
  todos,
  limit = 8,
  classNames,
  components,
}: {
  todos: DawnPlanActivityContent["todos"]
  limit?: number
  classNames?: DawnActivityClassNames
  components?: DawnActivityComponents
}) {
  const visibleTodos = todos.slice(0, limit)
  const overflow = todos.length - visibleTodos.length
  const TodoRow = components?.TodoRow

  return (
    <div className="dawn-activity__section">
      {/* biome-ignore lint/a11y/noRedundantRoles: Markerless lists need explicit list semantics. */}
      <ol role="list" className={cx("dawn-activity__list", classNames?.list)}>
        {visibleTodos.map((todo, index) => {
          const presentation = statusPresentation[todo.status]
          const key =
            // biome-ignore lint/suspicious/noArrayIndexKey: Activity todos intentionally expose no stable runtime IDs.
            `${todo.content}:${index}`
          if (TodoRow) {
            return (
              <li key={key} className={cx(`dawn-activity__item dawn-activity__item--${todo.status}`, classNames?.item)}>
                <TodoRow
                  content={todo.content}
                  status={todo.status}
                  glyph={presentation.glyph}
                  label={presentation.label}
                />
              </li>
            )
          }
          return (
            <li
              key={key}
              className={cx(
                `dawn-activity__item dawn-activity__item--${todo.status}`,
                classNames?.item,
              )}
            >
              <span aria-hidden="true" className={cx("dawn-activity__item-glyph", classNames?.itemGlyph)}>
                {presentation.glyph}
              </span>
              <span className={cx("dawn-activity__item-label", classNames?.itemLabel)}>
                {todo.content}
              </span>
              <span className={cx("dawn-activity__item-status", classNames?.itemStatus)}>
                {presentation.label}
              </span>
            </li>
          )
        })}
      </ol>
      {overflow > 0 ? (
        <div className={cx("dawn-activity__overflow", classNames?.overflow)}>+{overflow} more</div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 3: Convert `PlanActivityCard.tsx`**

```tsx
import type { DawnPlanActivityContent } from "../activities.js"
import { ActivityChecklist } from "./ActivityChecklist.js"
import { cx, type DawnActivityClassNames, type DawnActivityComponents } from "./parts.js"

export function PlanActivityCard({
  content,
  classNames,
  components,
}: {
  content: DawnPlanActivityContent
  classNames?: DawnActivityClassNames
  components?: DawnActivityComponents
}) {
  const completedCount = content.todos.filter((todo) => todo.status === "completed").length
  const hasActiveTodo = content.todos.some((todo) => todo.status === "in_progress")

  return (
    <details open={hasActiveTodo} className={cx("dawn-activity", classNames?.root)}>
      <summary className={cx("dawn-activity__header", classNames?.header)}>
        <span className={cx("dawn-activity__title", classNames?.title)}>Plan</span>
        <span className={cx("dawn-activity__meta", classNames?.meta)}>
          {" "}
          · {completedCount}/{content.todos.length} complete
        </span>
      </summary>
      <ActivityChecklist
        todos={content.todos}
        limit={8}
        {...(classNames ? { classNames } : {})}
        {...(components ? { components } : {})}
      />
    </details>
  )
}
```

- [ ] **Step 4: Convert `SubagentActivityCard.tsx`**

```tsx
import { ActivityChecklist } from "./ActivityChecklist.js"
import { cx, type DawnActivityClassNames, type DawnActivityComponents } from "./parts.js"
import type { SubagentActivityContentOutput } from "./schemas.js"

const toolStatusPresentation = {
  running: { glyph: "◐", label: "running" },
  completed: { glyph: "✓", label: "completed" },
  incomplete: { glyph: "!", label: "incomplete" },
} as const

export function SubagentActivityCard({
  content,
  classNames,
  components,
}: {
  content: SubagentActivityContentOutput
  classNames?: DawnActivityClassNames
  components?: DawnActivityComponents
}) {
  const ToolRow = components?.ToolRow

  return (
    <details open={content.status === "running"} className={cx("dawn-activity", classNames?.root)}>
      <summary className={cx("dawn-activity__header", classNames?.header)}>
        <span className={cx("dawn-activity__title", classNames?.title)}>{content.name}</span>
        <span className={cx("dawn-activity__meta", classNames?.meta)}> · {content.status}</span>
        <span className={cx("dawn-activity__meta", classNames?.meta)}>
          {" "}
          · {content.totalToolCount} tools
        </span>
        {content.depth > 1 ? (
          <span className={cx("dawn-activity__badge", classNames?.badge)}>nested</span>
        ) : null}
      </summary>

      {content.todos !== undefined ? (
        <section
          aria-label="Subagent plan"
          className={cx("dawn-activity__section", classNames?.section)}
        >
          <div className={cx("dawn-activity__section-label", classNames?.sectionLabel)}>Plan</div>
          <ActivityChecklist
            todos={content.todos}
            limit={8}
            {...(classNames ? { classNames } : {})}
            {...(components ? { components } : {})}
          />
        </section>
      ) : null}

      {content.tools.length > 0 ? (
        <section
          aria-label="Subagent tools"
          className={cx("dawn-activity__section", classNames?.section)}
        >
          <div className={cx("dawn-activity__section-label", classNames?.sectionLabel)}>Tools</div>
          {/* biome-ignore lint/a11y/noRedundantRoles: Markerless lists need explicit list semantics. */}
          <ul role="list" className={cx("dawn-activity__list", classNames?.list)}>
            {content.tools.map((tool, index) => {
              const presentation = toolStatusPresentation[tool.status]
              const key =
                // biome-ignore lint/suspicious/noArrayIndexKey: Activity tools intentionally expose no stable runtime IDs.
                `${tool.name}:${index}`
              const itemClass = cx(
                `dawn-activity__item dawn-activity__item--${tool.status}`,
                classNames?.item,
              )
              if (ToolRow) {
                return (
                  <li key={key} className={itemClass}>
                    <ToolRow
                      name={tool.name}
                      status={tool.status}
                      glyph={presentation.glyph}
                      label={presentation.label}
                    />
                  </li>
                )
              }
              return (
                <li key={key} className={itemClass}>
                  <span
                    aria-hidden="true"
                    className={cx("dawn-activity__item-glyph", classNames?.itemGlyph)}
                  >
                    {presentation.glyph}
                  </span>
                  <span className={cx("dawn-activity__item-label", classNames?.itemLabel)}>
                    {tool.name}
                  </span>
                  <span className={cx("dawn-activity__item-status", classNames?.itemStatus)}>
                    {presentation.label}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {content.status === "failed" ? (
        <div role="alert" className={cx("dawn-activity__error", classNames?.error)}>
          {content.error}
        </div>
      ) : null}
    </details>
  )
}
```

Note the two preserved `aria-label`s, `role="alert"`, and `aria-hidden` glyphs — accessibility is not a presentation detail and must survive the conversion.

- [ ] **Step 5: Green, then commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui test
```

Expected: baseline + 3 (Task 1's styles tests). No inline `style=` attributes remain in the three card files:

```bash
grep -n "style={{" packages/ag-ui/src/react/*.tsx; echo "inline-styles-above(none=good)"
```

```bash
git add packages/ag-ui/src/react packages/ag-ui/test/react/renderers.test.tsx
git commit -m "feat(ag-ui): style the activity cards with scoped classes"
```

---

### Task 5: Pin the ladder

**Files:**
- Create: `packages/ag-ui/test/react/customization.test.tsx`
- Modify: `packages/ag-ui/src/react/index.ts`

- [ ] **Step 1: Export the new types**

Add to `index.ts` (keep the file's existing sorted-export style):

```ts
export type {
  DawnActivityClassNames,
  DawnActivityComponents,
  DawnTodoRowProps,
  DawnToolRowProps,
} from "./parts.js"
```

- [ ] **Step 2: Write the ladder tests**

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { PlanActivityCard } from "../../src/react/PlanActivityCard.js"
import { SubagentActivityCard } from "../../src/react/SubagentActivityCard.js"

const PLAN = {
  todos: [
    { content: "Search the corpus", status: "completed" },
    { content: "Read the best sources", status: "in_progress" },
  ],
} as const

const SUBAGENT = {
  name: "researcher",
  depth: 1,
  status: "running",
  tools: [{ name: "searchCorpus", status: "running" }],
  totalToolCount: 1,
} as const

describe("customization ladder", () => {
  test("rung 2: classNames append to defaults rather than replacing them", () => {
    const html = renderToStaticMarkup(
      <PlanActivityCard
        content={PLAN}
        classNames={{ root: "my-root", list: "my-list", itemLabel: "my-label" }}
      />,
    )
    expect(html).toContain("dawn-activity my-root")
    expect(html).toContain("dawn-activity__list my-list")
    expect(html).toContain("dawn-activity__item-label my-label")
  })

  test("rung 2: omitted parts keep bare defaults", () => {
    const html = renderToStaticMarkup(<PlanActivityCard content={PLAN} />)
    expect(html).toContain('class="dawn-activity"')
    expect(html).not.toContain("undefined")
  })

  test("rung 3: a TodoRow slot replaces the row body", () => {
    const html = renderToStaticMarkup(
      <PlanActivityCard
        content={PLAN}
        components={{ TodoRow: ({ content }) => <em>{content}</em> }}
      />,
    )
    expect(html).toContain("<em>Search the corpus</em>")
    expect(html).not.toContain("dawn-activity__item-glyph")
  })

  test("rung 3: a ToolRow slot replaces tool rows", () => {
    const html = renderToStaticMarkup(
      <SubagentActivityCard
        content={SUBAGENT}
        components={{ ToolRow: ({ name }) => <b>{name}</b> }}
      />,
    )
    expect(html).toContain("<b>searchCorpus</b>")
  })

  test("a slot cannot exceed the card's todo bound", () => {
    const many = {
      todos: Array.from({ length: 20 }, (_, index) => ({
        content: `todo ${index}`,
        status: "pending" as const,
      })),
    }
    const html = renderToStaticMarkup(
      <PlanActivityCard content={many} components={{ TodoRow: ({ content }) => <em>{content}</em> }} />,
    )
    expect(html.match(/<em>/g)).toHaveLength(8)
    expect(html).toContain("+12 more")
  })

  test("status modifiers drive per-item styling hooks", () => {
    const html = renderToStaticMarkup(<PlanActivityCard content={PLAN} />)
    expect(html).toContain("dawn-activity__item--completed")
    expect(html).toContain("dawn-activity__item--in_progress")
  })
})
```

- [ ] **Step 3: Run, then commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && cd packages/ag-ui && npx tsc --noEmit
```

Expected: baseline + 3 + 6. **Assert the count moved** — a `.tsx` glob mismatch silently collects nothing.

```bash
git add packages/ag-ui/src/react/index.ts packages/ag-ui/test/react/customization.test.tsx
git commit -m "feat(ag-ui): expose the activity customization ladder"
```

---

### Task 6: Default-tier dogfood

**Files:**
- Modify: `examples/chat/web/app/layout.tsx`

- [ ] **Step 1: Import the stylesheet**

`layout.tsx` already imports `@copilotkit/react-core/v2/styles.css`. Add below it:

```tsx
import "@dawn-ai/ag-ui/react/styles.css"
```

This is the whole default tier: one line, no configuration, Dawn-identity cards.

- [ ] **Step 2: Verify the example builds**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-example/chat-web build
```

If Next cannot resolve the CSS subpath, the `exports` entry from Task 2 is wrong — fix the export map, not the import.

```bash
git add examples/chat/web/app/layout.tsx
git commit -m "feat(example): adopt the default activity styling"
```

---

### Task 7: Docs, changeset, full verification

**Files:**
- Modify: `packages/ag-ui/README.md`, `apps/web/content/docs/ag-ui.mdx`
- Create: `.changeset/ag-ui-activity-design-system.md`

- [ ] **Step 1: Document the ladder**

In `packages/ag-ui/README.md`, add a "Customizing the activity cards" section with one runnable example per rung: the CSS import plus a token override; a `classNames` example; a `components` slot example; and a sentence for eject that says the card sources are copy-and-compile. State that omitting the CSS import renders structured-but-unstyled cards.

In `apps/web/content/docs/ag-ui.mdx`, add the import line beside the existing `dawnActivityRenderers` guidance.

Check `AGENTS.md` and `scripts/check-docs.mjs`'s `forbiddenContent` before writing prose.

- [ ] **Step 2: Changeset**

```markdown
---
"@dawn-ai/ag-ui": patch
---

Give the plan and subagent activity cards Dawn's visual identity, plus a
customization ladder. Import `@dawn-ai/ag-ui/react/styles.css` for the default
look in light and dark; override CSS custom properties to restyle; pass
`classNames` to layer your own classes onto any part; pass `components` to
replace a todo or tool row outright. Cards render structured-but-unstyled when
the stylesheet is not imported, and every selector is scoped so the sheet cannot
affect the rest of your app.
```

Must be `patch` — the fixed 0.x group turns a `minor` into a 1.0.0 bump.

- [ ] **Step 3: Full gates, each exit code echoed**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm build; echo "EXIT=$?"
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/ag-ui test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm --filter @dawn-ai/cli test
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm lint; echo "EXIT=$?"
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && node scripts/check-docs.mjs; echo "EXIT=$?"
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && node scripts/pack-check.mjs; echo "EXIT=$?"
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm vitest run --config test/generated/vitest.config.ts run-generated-research-activation
```

Never pipe these through `tail`/`head` in a way that hides the exit code.

- [ ] **Step 4: Commit, review, finish**

```bash
git add -A && git commit -m "docs: document the activity customization ladder"
```

Then superpowers:requesting-code-review on `git diff main...HEAD`, and superpowers:finishing-a-development-branch. PR title: `feat(ag-ui): give activity cards Dawn's identity and a customization ladder`. The body must note that the default appearance changes for consumers who import the stylesheet, that behavior is unchanged, and that SP2's workbench is the customization-tier dogfood that will report any ladder gap back here.

---

## Out of scope

- The workbench (SP2), scaffold integration (SP3), Playwright (SP4).
- Styling tool cards or permission prompts — no second consumer yet.
- Any change to `dawnActivityRenderers`, the schemas, the activity constants, the wire protocol, or suppression behavior.
- A theme-switching API. Consumers set `data-dawn-theme` or rely on `prefers-color-scheme`.
