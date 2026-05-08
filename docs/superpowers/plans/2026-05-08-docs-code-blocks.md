# Docs Code Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unhighlighted, copy-less, single-file MDX code-block treatment with a shiki-backed pipeline supporting filenames, line highlights, diff markers, multi-file tabs, and a copy button — and rebuild the landing `CodeExample` on the same pipeline.

**Architecture:** Build-time syntax highlighting via `rehype-pretty-code` wired into Next's MDX pipeline. A custom shiki theme (Dawn brand-tuned, transparent background) is shared by docs MDX and the landing `CodeExample`. New `<Pre>` and `<CodeGroup>` MDX components handle header, copy button, and tabs. Inline `<code>` is descoped from block tokens via class-based styling.

**Tech Stack:** Next.js 16 (Turbopack), `@next/mdx`, `rehype-pretty-code`, `shiki`, React 19, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-05-08-docs-code-blocks-design.md`

---

## File structure

**New files:**
- `apps/web/lib/shiki/dawn-theme.ts` — custom shiki theme (TypeScript module exporting a `ThemeRegistration` JSON object).
- `apps/web/lib/shiki/highlight.ts` — `highlight(code, lang)` helper that runs shiki with the Dawn theme; used by the landing `CodeExample` rewrite.
- `apps/web/app/components/mdx/CodeBlock.tsx` — exports `<Pre>` (overrides MDX `pre`) and `<InlineCode>` (overrides MDX `code`).
- `apps/web/app/components/mdx/CodeGroup.tsx` — multi-file tabs wrapper.
- `apps/web/content/docs/_test-codeblocks.mdx` — temporary smoke page exercising every variant; deleted at end of plan.

**Modified files:**
- `apps/web/next.config.ts` — register `rehype-pretty-code`.
- `apps/web/mdx-components.tsx` — wire `<Pre>`, `<InlineCode>`, `<CodeGroup>`.
- `apps/web/app/components/landing/CodeExample.tsx` — rewrite using `highlight()`.
- `apps/web/app/globals.css` — add scoped styles for shiki line containers, diff backgrounds, and inline `code` rules.
- `apps/web/package.json` — add `rehype-pretty-code` and `shiki`.

---

## Task 1: Add dependencies

**Files:**
- Modify: `apps/web/package.json`

- [ ] **Step 1: Install dependencies**

Run from repo root:

```bash
pnpm --filter @dawn-ai/web add rehype-pretty-code shiki
```

Expected: `package.json` updated with `rehype-pretty-code` and `shiki` under `dependencies`. `pnpm-lock.yaml` updated.

- [ ] **Step 2: Verify install**

Run:

```bash
pnpm --filter @dawn-ai/web list rehype-pretty-code shiki
```

Expected: both packages listed with resolved versions.

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): add rehype-pretty-code and shiki for docs highlighting"
```

---

## Task 2: Build the custom Dawn shiki theme

**Files:**
- Create: `apps/web/lib/shiki/dawn-theme.ts`

- [ ] **Step 1: Write the theme file**

Create `apps/web/lib/shiki/dawn-theme.ts`:

```ts
import type { ThemeRegistration } from "shiki"

// Hex values mirror the resolved values of the Dawn brand tokens defined in
// apps/web/app/globals.css. Update both when the palette changes.
//
// Token map:
//   --color-text-secondary       → #c8c8cc (default text)
//   --color-text-muted           → #8b8fa3 (comments)
//   --color-accent-purple        → #c4a7e7 (keywords / control flow)
//   --color-accent-amber-deep    → #f5a524 (type names)
//   --color-accent-amber         → #fbbf24 (constants / numbers)
//   --color-accent-green         → #34c759 (strings)
//   --color-accent-blue          → #7fc8ff (functions / methods)
export const dawnTheme: ThemeRegistration = {
  name: "dawn",
  type: "dark",
  // Transparent background — the surrounding container owns its background.
  colors: {
    "editor.background": "#00000000",
    "editor.foreground": "#c8c8cc",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: { foreground: "#8b8fa3", fontStyle: "italic" },
    },
    {
      scope: ["string", "string.template", "constant.other.symbol"],
      settings: { foreground: "#34c759" },
    },
    {
      scope: ["constant.numeric", "constant.language", "constant.character"],
      settings: { foreground: "#fbbf24" },
    },
    {
      scope: ["keyword", "keyword.control", "storage", "storage.type", "storage.modifier"],
      settings: { foreground: "#c4a7e7" },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "support.type",
        "support.class",
        "entity.other.inherited-class",
      ],
      settings: { foreground: "#f5a524" },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call entity.name.function"],
      settings: { foreground: "#7fc8ff" },
    },
    {
      scope: ["variable", "variable.other", "meta.definition.variable"],
      settings: { foreground: "#c8c8cc" },
    },
    {
      scope: ["punctuation", "meta.brace", "meta.delimiter"],
      settings: { foreground: "#c8c8cc" },
    },
    {
      scope: ["entity.name.tag", "meta.tag"],
      settings: { foreground: "#7fc8ff" },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: { foreground: "#fbbf24" },
    },
  ],
}
```

- [ ] **Step 2: Verify the file type-checks**

Run:

```bash
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS (no new errors). The theme file is not yet imported anywhere, so it must compile in isolation.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/shiki/dawn-theme.ts
git commit -m "feat(web): add custom Dawn shiki theme"
```

---

## Task 3: Wire rehype-pretty-code into the MDX pipeline

**Files:**
- Modify: `apps/web/next.config.ts`

- [ ] **Step 1: Update next.config.ts**

Replace the contents of `apps/web/next.config.ts` with:

```ts
import createMDX from "@next/mdx"
import type { NextConfig } from "next"
import { dawnTheme } from "./lib/shiki/dawn-theme"

const nextConfig: NextConfig = {
  reactStrictMode: true,
  pageExtensions: ["ts", "tsx", "md", "mdx"],
}

const withMDX = createMDX({
  options: {
    // Turbopack requires serializable plugin references — pass as module-path strings
    remarkPlugins: [["remark-gfm", {}]],
    rehypePlugins: [
      [
        "rehype-pretty-code",
        {
          theme: dawnTheme,
          keepBackground: false,
          defaultLang: "plaintext",
        },
      ],
    ],
  },
})

export default withMDX(nextConfig)
```

- [ ] **Step 2: Restart the dev server**

Stop any existing dev server. Run:

```bash
pnpm --filter @dawn-ai/web dev
```

Expected: server starts on port 3000 with no MDX/Turbopack errors. If Turbopack rejects the inline theme object (function-typed serialization issue), fall back to passing the theme by module path:

```ts
rehypePlugins: [
  ["rehype-pretty-code", { themePath: "./lib/shiki/dawn-theme.ts", keepBackground: false }],
],
```

(Verify by visiting http://localhost:3000/docs/getting-started — the existing `bash` and tree blocks should now render with shiki tokens, even before the `<Pre>` component wiring lands.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/next.config.ts
git commit -m "feat(web): wire rehype-pretty-code into MDX pipeline with Dawn theme"
```

---

## Task 4: Implement `<Pre>` and `<InlineCode>` MDX overrides

**Files:**
- Create: `apps/web/app/components/mdx/CodeBlock.tsx`

- [ ] **Step 1: Write the component file**

Create `apps/web/app/components/mdx/CodeBlock.tsx`:

```tsx
"use client"

import { type HTMLAttributes, type ReactNode, useRef, useState } from "react"

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 8.5l3.5 3.5L13 5" />
    </svg>
  )
}

interface PreProps extends HTMLAttributes<HTMLPreElement> {
  readonly children?: ReactNode
  readonly "data-language"?: string
  readonly "data-theme"?: string
}

export function Pre({ children, className, ...rest }: PreProps) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const title = (rest as Record<string, unknown>)["data-rehype-pretty-code-title"] as
    | string
    | undefined
  // rehype-pretty-code emits the title separately as a sibling figcaption when configured;
  // when authors use ```ts title="..." the meta is forwarded onto the <pre> as data-* attrs.
  const language = rest["data-language"]

  const copy = async () => {
    const text = ref.current?.textContent ?? ""
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="relative my-6 rounded-lg border border-border bg-bg-card overflow-hidden">
      {title ? (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle bg-bg-card/60">
          <span className="font-mono text-xs text-text-muted">{title}</span>
          <div className="flex items-center gap-2">
            {language ? (
              <span className="font-mono text-[0.65rem] uppercase tracking-wide text-text-dim">
                {language}
              </span>
            ) : null}
            <CopyButton onCopy={copy} copied={copied} />
          </div>
        </div>
      ) : (
        <div className="absolute top-2 right-2 z-10">
          <CopyButton onCopy={copy} copied={copied} />
        </div>
      )}
      <pre
        ref={ref}
        className={`overflow-x-auto px-4 py-3 text-sm leading-6 font-mono ${className ?? ""}`}
        {...rest}
      >
        {children}
      </pre>
    </div>
  )
}

function CopyButton({ onCopy, copied }: { readonly onCopy: () => void; readonly copied: boolean }) {
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied" : "Copy code"}
      className={`p-1.5 rounded border transition-colors ${
        copied
          ? "border-accent-amber/40 text-accent-amber bg-accent-amber/10"
          : "border-border text-text-muted hover:text-text-primary hover:border-text-muted"
      }`}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}

export function InlineCode({ children, className }: { readonly children?: ReactNode; readonly className?: string }) {
  // Block-level shiki tokens render <code> inside <pre>. The <Pre> override sets the
  // pre's typography directly, so this component only fires for inline <code> via MDX.
  return (
    <code className={`mdx-inline-code ${className ?? ""}`}>
      {children}
    </code>
  )
}
```

- [ ] **Step 2: Verify type-check**

Run:

```bash
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/components/mdx/CodeBlock.tsx
git commit -m "feat(web): add Pre and InlineCode MDX components"
```

---

## Task 5: Implement `<CodeGroup>` for multi-file tabs

**Files:**
- Create: `apps/web/app/components/mdx/CodeGroup.tsx`

- [ ] **Step 1: Write the component file**

Create `apps/web/app/components/mdx/CodeGroup.tsx`:

```tsx
"use client"

import { Children, isValidElement, type ReactElement, type ReactNode, useState } from "react"

interface CodeGroupProps {
  readonly children: ReactNode
}

interface PreElementProps {
  readonly "data-rehype-pretty-code-title"?: string
  readonly "data-language"?: string
  readonly children?: ReactNode
}

export function CodeGroup({ children }: CodeGroupProps) {
  const blocks = Children.toArray(children).filter((c): c is ReactElement<PreElementProps> =>
    isValidElement(c),
  )
  const [active, setActive] = useState(0)
  if (blocks.length === 0) return null

  const titles = blocks.map(
    (block, i) => block.props["data-rehype-pretty-code-title"] ?? `File ${i + 1}`,
  )

  return (
    <div className="my-6 rounded-lg border border-border overflow-hidden bg-bg-card">
      <div role="tablist" className="flex bg-bg-card/60 border-b border-border-subtle">
        {titles.map((title, i) => (
          <button
            key={title}
            type="button"
            role="tab"
            aria-selected={active === i}
            onClick={() => setActive(i)}
            className={`px-3 py-2 text-xs font-mono transition-colors border-b-2 ${
              active === i
                ? "text-accent-amber border-accent-amber"
                : "text-text-muted border-transparent hover:text-text-primary"
            }`}
          >
            {title}
          </button>
        ))}
      </div>
      <div>{blocks[active]}</div>
    </div>
  )
}
```

- [ ] **Step 2: Verify type-check**

Run:

```bash
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/components/mdx/CodeGroup.tsx
git commit -m "feat(web): add CodeGroup MDX component for multi-file tabs"
```

---

## Task 6: Wire components into mdx-components.tsx

**Files:**
- Modify: `apps/web/mdx-components.tsx`

- [ ] **Step 1: Update mdx-components.tsx**

Replace the existing `code:` and `pre:` overrides and the imports block at the top of `apps/web/mdx-components.tsx`:

Find:

```tsx
import type { MDXComponents } from "mdx/types"
import { Callout } from "./app/components/mdx/Callout"
import { Step, Steps } from "./app/components/mdx/Steps"
import { Tab, Tabs } from "./app/components/mdx/Tabs"
```

Replace with:

```tsx
import type { MDXComponents } from "mdx/types"
import { Callout } from "./app/components/mdx/Callout"
import { InlineCode, Pre } from "./app/components/mdx/CodeBlock"
import { CodeGroup } from "./app/components/mdx/CodeGroup"
import { Step, Steps } from "./app/components/mdx/Steps"
import { Tab, Tabs } from "./app/components/mdx/Tabs"
```

Then in the returned components object, add `CodeGroup` to the named-component list:

```tsx
return {
  Callout,
  CodeGroup,
  Steps,
  Step,
  Tabs,
  Tab,
  // ...existing h1, h2, h3, p overrides unchanged...
```

Find:

```tsx
    code: ({ children }) => (
      <code className="bg-bg-card border border-border rounded px-1.5 py-0.5 text-sm font-mono text-text-secondary">
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="bg-bg-card border border-border rounded-lg p-4 overflow-x-auto mb-4 text-sm font-mono leading-relaxed">
        {children}
      </pre>
    ),
```

Replace with:

```tsx
    code: InlineCode,
    pre: Pre,
```

- [ ] **Step 2: Verify type-check**

Run:

```bash
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/mdx-components.tsx
git commit -m "feat(web): wire Pre, InlineCode, and CodeGroup into MDX components"
```

---

## Task 7: Add inline-code and shiki container styles

**Files:**
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Append styles**

Append to the end of `apps/web/app/globals.css`:

```css
/* Inline code (rendered by InlineCode MDX override) */
.mdx-inline-code {
  background: rgb(from var(--color-bg-card) r g b / 0.6);
  color: var(--color-text-secondary);
  border-radius: 4px;
  padding: 0.125rem 0.375rem;
  font-size: 0.875em;
  font-family: var(--font-mono, ui-monospace, monospace);
}

/* Shiki line container — rehype-pretty-code wraps each line in <span data-line> */
[data-line] {
  display: block;
  padding: 0 1rem;
  border-left: 2px solid transparent;
}

/* Highlighted lines (e.g. ```ts {1,3-5} ```) */
[data-highlighted-line] {
  background: rgb(from var(--color-accent-amber) r g b / 0.06);
  border-left-color: var(--color-accent-amber);
}

/* Diff markers ([!code ++] / [!code --]) */
[data-highlighted-line-id="add"],
.line.diff.add {
  background: rgb(from var(--color-accent-green) r g b / 0.10);
  border-left-color: var(--color-accent-green);
}
[data-highlighted-line-id="remove"],
.line.diff.remove {
  background: rgb(239 68 68 / 0.10);
  border-left-color: rgb(239 68 68);
}
```

- [ ] **Step 2: Reload the dev server in the browser**

Visit http://localhost:3000/docs/getting-started. Confirm:
- Code blocks have token colors.
- Inline `code` (e.g. `pnpm`) has a soft background but no border.
- No per-line border on block code.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/globals.css
git commit -m "feat(web): add styles for inline code and shiki line containers"
```

---

## Task 8: Smoke-test all variants in a temporary MDX page

**Files:**
- Create: `apps/web/content/docs/_test-codeblocks.mdx`

This task verifies every authoring variant renders correctly. The page is deleted in Task 11.

- [ ] **Step 1: Create the smoke page**

Create `apps/web/content/docs/_test-codeblocks.mdx`:

````mdx
# Code blocks smoke test

## Bare command (no title)

```bash
npx create-dawn-app my-agent
```

## Titled TypeScript with line highlights

```ts title="src/app/hello/[tenant]/index.ts" {3,5-7}
import type { RuntimeContext } from "@dawn-ai/sdk"
import type { RouteTools } from "dawn:routes"
import type { HelloState } from "./state.js"

export async function workflow(state: HelloState, ctx: RuntimeContext<RouteTools<"/hello/[tenant]">>) {
  const result = await ctx.tools.greet({ tenant: state.tenant })
  return { ...state, greeting: result.greeting }
}
```

## Diff markers

```ts title="route.ts"
export async function workflow(state, ctx) {
  const result = await ctx.tools.greet({ tenant: state.tenant }) // [!code --]
  const result = await ctx.tools.greet({ tenant: state.tenant, locale: state.locale }) // [!code ++]
  return { ...state, greeting: result.greeting }
}
```

## Inline code

Run `dawn run` to start the dev server. The `--port` flag overrides the default.

## CodeGroup with two files

<CodeGroup>
```ts title="route.ts"
export async function workflow(state, ctx) {
  const r = await ctx.tools.greet({ tenant: state.tenant })
  return { ...state, greeting: r.greeting }
}
```
```ts title="tool.ts"
export default async (input: { readonly tenant: string }) => {
  return { greeting: `Hello, ${input.tenant}!` }
}
```
</CodeGroup>
````

- [ ] **Step 2: Verify each variant in the browser**

Visit http://localhost:3000/docs/_test-codeblocks. Verify:
- Bash block: no header, copy button top-right, `npx`/`create-dawn-app` not highlighted (bash has minimal grammar).
- Titled TS block: header with filename + `ts` pill + copy button. Lines 3 and 5–7 have an amber tint.
- Diff block: line 2 red wash with left border, line 3 green wash with left border.
- Inline code: `dawn run` and `--port` have soft bg, no border, mono font.
- CodeGroup: two tabs (`route.ts`, `tool.ts`), clicking switches active block. Each block renders with shiki colors.

If any variant fails, fix the corresponding component before continuing.

- [ ] **Step 3: Click the copy button on the titled TS block**

Verify: button icon transitions to a check, returns to copy after ~2 seconds, and the clipboard contains the block's code.

- [ ] **Step 4: Commit**

```bash
git add apps/web/content/docs/_test-codeblocks.mdx
git commit -m "test(web): add smoke page for code-block variants"
```

---

## Task 9: Build a shiki helper for the landing CodeExample

**Files:**
- Create: `apps/web/lib/shiki/highlight.ts`

- [ ] **Step 1: Write the helper**

Create `apps/web/lib/shiki/highlight.ts`:

```ts
import { createHighlighter, type BundledLanguage } from "shiki"
import { dawnTheme } from "./dawn-theme"

let highlighterPromise: ReturnType<typeof createHighlighter> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [dawnTheme],
      langs: ["typescript", "bash"],
    })
  }
  return highlighterPromise
}

export async function highlight(code: string, lang: BundledLanguage): Promise<string> {
  const highlighter = await getHighlighter()
  return highlighter.codeToHtml(code, { lang, theme: "dawn" })
}
```

- [ ] **Step 2: Verify type-check**

Run:

```bash
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/shiki/highlight.ts
git commit -m "feat(web): add shiki highlight helper for landing snippets"
```

---

## Task 10: Rewrite the landing CodeExample using shiki

**Files:**
- Modify: `apps/web/app/components/landing/CodeExample.tsx`

The existing component hand-tokenizes ~200 lines of `<span>` soup for two code panels. The terminal-output panel and the project-tree section are intentionally kept as-is — they are CLI output and a stylized directory listing, not source code.

- [ ] **Step 1: Replace the file**

Overwrite `apps/web/app/components/landing/CodeExample.tsx` with:

```tsx
import { highlight } from "../../../lib/shiki/highlight"

const ROUTE_SOURCE = `import type { RuntimeContext } from "@dawn-ai/sdk"
import type { RouteTools } from "dawn:routes"
import type { HelloState } from "./state.js"

export async function workflow(
  state: HelloState,
  ctx: RuntimeContext<RouteTools<"/hello/[tenant]">>,
) {
  const result = await ctx.tools.greet({ tenant: state.tenant })
  return { ...state, greeting: result.greeting }
}
`

const TOOL_SOURCE = `export default async (input: {
  readonly tenant: string
}) => {
  return {
    greeting: \`Hello, \${input.tenant}!\`,
  }
}
`

const GENERATED_SOURCE = `declare module "dawn:routes" {
  export type RouteTools<P> = DawnRouteTools[P]
  // greet signature inferred
  // from tools/greet.ts export
}
`

export async function CodeExample() {
  const [routeHtml, toolHtml, generatedHtml] = await Promise.all([
    highlight(ROUTE_SOURCE, "typescript"),
    highlight(TOOL_SOURCE, "typescript"),
    highlight(GENERATED_SOURCE, "typescript"),
  ])

  return (
    <section className="py-20 px-8 border-t border-border-subtle bg-bg-secondary/50">
      <div className="text-center mb-10">
        <p className="text-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          See It
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold text-text-primary leading-[1.1] tracking-tight"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          A Dawn app, typed end to end.
        </h2>
      </div>

      {/* Project tree (unchanged — stylized directory listing, not source code) */}
      <div className="max-w-3xl mx-auto mb-8">
        <div className="bg-bg-card border border-border rounded-lg p-5 font-mono text-sm leading-8 text-text-muted">
          <p className="text-text-secondary text-xs uppercase tracking-wide mb-2 font-sans font-semibold">
            Project Structure
          </p>
          <div><span className="text-yellow-400">src/app/</span></div>
          <div>&nbsp;&nbsp;<span className="text-text-muted">(public)/</span> <span className="text-text-dim text-xs">&larr; route group, excluded from pathname</span></div>
          <div>&nbsp;&nbsp;&nbsp;&nbsp;hello/</div>
          <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-purple-400">[tenant]/</span> <span className="text-text-dim text-xs">&larr; dynamic segment</span></div>
          <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-blue-400">index.ts</span> <span className="text-text-dim text-xs">&larr; route entry</span></div>
          <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-text-secondary">state.ts</span> <span className="text-text-dim text-xs">&larr; route state type</span></div>
          <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-yellow-400">tools/</span> <span className="text-text-dim text-xs">&larr; co-located tools</span></div>
          <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-green-400">greet.ts</span> <span className="text-text-dim text-xs">&larr; typed at build time</span></div>
          <div>&nbsp;&nbsp;<span className="text-text-secondary">dawn.generated.d.ts</span> <span className="text-text-dim text-xs">&larr; auto-generated ambient types</span></div>
          <div><span className="text-text-secondary">dawn.config.ts</span></div>
        </div>
      </div>

      {/* Code panels (highlighted via shiki) */}
      <div className="flex flex-col md:flex-row gap-4 max-w-3xl mx-auto">
        <CodePanel filename="src/app/(public)/hello/[tenant]/index.ts" html={routeHtml} />
        <div className="flex-1 flex flex-col gap-4">
          <CodePanel filename="tools/greet.ts" html={toolHtml} />
          <CodePanel filename="dawn.generated.d.ts (auto-generated)" html={generatedHtml} />
        </div>
      </div>

      {/* CLI output (unchanged — terminal output, not source code) */}
      <div className="max-w-3xl mx-auto mt-6">
        <div className="bg-bg-card border border-border rounded-lg p-4 font-mono text-sm leading-7">
          <p className="text-text-muted text-[0.65rem] mb-2 font-sans">Terminal</p>
          <div className="text-text-secondary">
            <span className="text-accent-amber">$</span>{" "}
            <span className="text-text-primary">dawn run &apos;/hello/acme&apos;</span>
          </div>
          <div className="text-text-muted mt-1">Route&nbsp;&nbsp;&nbsp; /hello/[tenant]</div>
          <div className="text-text-muted">Mode&nbsp;&nbsp;&nbsp;&nbsp; workflow</div>
          <div className="text-text-muted">Tenant&nbsp;&nbsp; acme</div>
          <div className="text-accent-amber mt-1">
            &#10003; {"{"} greeting: &quot;Hello, acme!&quot; {"}"}
          </div>
        </div>
      </div>

      <p className="text-center mt-5 text-text-muted text-sm">
        Type-safe tools, inferred automatically. No manual type wiring. No Zod boilerplate.
      </p>
    </section>
  )
}

interface CodePanelProps {
  readonly filename: string
  readonly html: string
}

function CodePanel({ filename, html }: CodePanelProps) {
  return (
    <div className="flex-1 bg-bg-card border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-2 border-b border-border-subtle">
        <p className="text-text-muted text-[0.65rem] font-mono">{filename}</p>
      </div>
      <div
        className="text-xs leading-6 overflow-x-auto p-4 [&_pre]:bg-transparent [&_pre]:m-0 [&_pre]:p-0"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is server-generated
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
```

- [ ] **Step 2: Verify the landing page renders**

Visit http://localhost:3000. Scroll to the "See It" section. Confirm:
- The two code panels (route + tool/generated stack) show shiki-tokenized code with the Dawn theme.
- Filenames render in the panel headers.
- Project tree and terminal panels are unchanged from before.
- No layout regressions on mobile (`flex-col` at `md:` breakpoint).

- [ ] **Step 3: Verify build**

Run:

```bash
pnpm --filter @dawn-ai/web build
```

Expected: build succeeds. The async server component must compile cleanly.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/components/landing/CodeExample.tsx
git commit -m "feat(web): rewrite landing CodeExample using shiki pipeline"
```

---

## Task 11: Clean up smoke page and finalize

**Files:**
- Delete: `apps/web/content/docs/_test-codeblocks.mdx`

- [ ] **Step 1: Delete the smoke page**

Run:

```bash
rm apps/web/content/docs/_test-codeblocks.mdx
```

- [ ] **Step 2: Verify build is still green**

Run:

```bash
pnpm --filter @dawn-ai/web build && pnpm --filter @dawn-ai/web typecheck
```

Expected: both PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/content/docs/_test-codeblocks.mdx
git commit -m "chore(web): remove code-blocks smoke test page"
```

---

## Verification checklist

After all tasks complete:

- [ ] Existing docs pages (`getting-started`, `routes`, `tools`, `state`, `middleware`, `retry`, `testing`, `cli`, `dev-server`, `deployment`) all render with shiki-highlighted code blocks.
- [ ] No per-line border bug on any block.
- [ ] Inline `<code>` has soft background, no border.
- [ ] Copy button works on at least one bash block and one titled block.
- [ ] Landing page "See It" section uses real shiki output, not hand-tokenized JSX.
- [ ] `pnpm --filter @dawn-ai/web typecheck` passes.
- [ ] `pnpm --filter @dawn-ai/web build` passes.
- [ ] `pnpm --filter @dawn-ai/web lint` passes.
