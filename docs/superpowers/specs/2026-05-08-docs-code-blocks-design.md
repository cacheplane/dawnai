# Docs Code Blocks — Design

**Date:** 2026-05-08
**Status:** Draft
**Scope:** apps/web — docs MDX rendering pipeline + landing CodeExample rewrite

## Problem

Code blocks in `apps/web/content/docs/*.mdx` and the landing `CodeExample` have four issues:

1. **No syntax highlighting.** Fenced code renders as monochrome text.
2. **Inline `<code>` styling leaks into `<pre>` blocks.** `mdx-components.tsx:33-37` applies `border` to every `<code>`; inside a `<pre>`, each token-bearing `<code>` descendant inherits this, producing a per-line border effect.
3. **No copy button on doc code blocks.** Only the bespoke `CopyCommand` and `CopyPromptButton` on the landing page have copy affordances.
4. **No multi-file authoring affordance.** Showing `route.ts` next to `tool.ts` requires either two stacked blocks or stuffing both into the generic `<Tabs>` (mismatched UX — `<Tabs>` is content-tabs, not code-tabs).

The landing `CodeExample` (`apps/web/app/components/landing/CodeExample.tsx`) hand-tokenizes ~200 lines of `<span>` soup. It is brittle, drifts from real syntax, and duplicates logic the docs pipeline will solve.

## Goals

- Doc code blocks are syntax-highlighted, copy-able, and support multi-file tabs.
- Authoring API is fence-meta-driven so most blocks need no MDX wrapper.
- Single dark theme tuned to the Dawn brand (amber accents on cosmic dark).
- Inline `<code>` is visually distinct from blocks and does not pollute block rendering.
- Landing `CodeExample` is rebuilt on the same pipeline; no hand-tokenized JSX.

## Non-goals

- Light theme / theme toggle. The site is dark-only.
- Persisting active tab across `CodeGroup` instances on a page. (Deferred.)
- Client-side highlighting or runtime theme switching.
- Replacing the generic `<Tabs>` MDX component (still useful for non-code content).

## Approach

### Highlighter: `rehype-pretty-code` (build-time, shiki-backed)

- Wired into `next.config.ts`'s `withMDX` as a `rehypePlugins` entry, passed by module path so it remains Turbopack-serializable.
- Compiles fenced code at build time → no client highlighter bundle.
- Native support for fence meta: `title="..."`, line highlights `{1,3-5}`, diff markers `[!code ++]` / `[!code --]`.

### Custom shiki theme

A custom theme keyed to the existing brand tokens (`--color-bg-card`, `--color-accent-amber`, `--color-accent-green`, etc.).

- **Location:** `apps/web/lib/shiki/dawn-theme.ts` exporting a shiki `ThemeRegistration` JSON object.
- **Background:** transparent — the surrounding `<Pre>` container owns background, so the same theme works across hero glow, docs body, and landing surfaces.
- **Token mapping (initial pass):**
  - keyword / control flow → `--color-accent-purple`
  - type names → `--color-accent-amber-deep`
  - strings → `--color-accent-green`
  - functions / methods → `--color-accent-blue`
  - comments → `--color-text-muted` (italic)
  - punctuation / default → `--color-text-secondary`
  - constants / numbers → `--color-accent-amber`
- Theme uses raw hex (shiki cannot resolve CSS vars); values mirror the resolved hex of the brand tokens. A small comment in the theme file maps each scope back to its brand token.
- Diff line backgrounds:
  - `[!code ++]` → faint green wash (~rgba of accent-green at 0.10)
  - `[!code --]` → faint red wash (~rgba of #ef4444 at 0.10) with a subtle left border in the same hue.

### Authoring API

All driven by fence meta — no wrapper needed for the common case.

````mdx
```ts title="src/app/hello/[tenant]/index.ts" {3,5-7}
import type { RuntimeContext } from "@dawn-ai/sdk"
...
```
````

Bare command (no `title`):

````mdx
```bash
npx create-dawn-app my-agent
```
````

Diff:

````mdx
```ts title="route.ts"
export async function workflow(state, ctx) {
  const result = await ctx.tools.greet({ tenant: state.tenant }) // [!code --]
  const result = await ctx.tools.greet({ tenant: state.tenant, locale: state.locale }) // [!code ++]
  return { ...state, greeting: result.greeting }
}
```
````

Multi-file group:

````mdx
<CodeGroup>
```ts title="route.ts"
...
```
```ts title="tool.ts"
...
```
</CodeGroup>
````

### Components

#### `<Pre>` — overrides default MDX `pre`

- Located at `apps/web/app/components/mdx/CodeBlock.tsx`.
- Reads `data-title` and `data-language` from props injected by `rehype-pretty-code`.
- Renders:
  - **Header strip** (only when `data-title` present): mono filename left, small language pill right, copy button rightmost.
  - **No header** (no title): copy button positioned absolute top-right inside the block.
- Copy button: ghost style, `Copy` icon → `Check` icon for 2s. Mirrors `CopyCommand` accent-amber feedback.
- Container styles: `bg-bg-card`, `border border-border`, `rounded-lg`, `overflow-x-auto`.
- **No** per-line border (fixed by inline-code scoping; see below).

#### `<CodeGroup>` — MDX wrapper for multi-file blocks

- Located at `apps/web/app/components/mdx/CodeGroup.tsx`.
- Reads each child `<pre data-title>` to derive tabs.
- Tab strip: mono font, tighter padding than generic `<Tabs>`, language pill on the right of each tab when present.
- Single shared copy button reflects the active tab's content.
- Active tab held in component state; **not** persisted across instances.
- If a child `<pre>` lacks `data-title`, falls back to `File N`.

#### Inline `<code>` — override in `mdx-components.tsx`

- Drop the `border`. Keep a soft background (`bg-bg-card/60`) and `--color-text-secondary`.
- Scope via Tailwind arbitrary variant or by simply not styling `code` inside `pre` (the new `<Pre>` handles its own typography; we override `code` only at the MDX-component level which only fires for inline by default — but the existing implementation passes the same component for nested `code` too, which is the source of the bug).
- **Fix:** detect `code` rendered inside `pre` by checking for the `data-language` attribute that `rehype-pretty-code` injects on the parent. Simpler and more robust: replace the global `code` override with a `code` component that renders bare children when its parent is a `<pre>` (we do this via CSS — `.prose pre code { all: revert; }` style scoping inside the docs container).
- The cleanest implementation: emit inline `code` with a class (`mdx-inline-code`) and only style that class. Block `<code>` tokens get no class and inherit only from the shiki theme.

### MDX pipeline wiring

`apps/web/next.config.ts`:

```ts
const withMDX = createMDX({
  options: {
    remarkPlugins: [["remark-gfm", {}]],
    rehypePlugins: [
      ["rehype-pretty-code", {
        theme: dawnTheme,                 // imported JSON, serializable
        keepBackground: false,            // container owns background
        defaultLang: "plaintext",
      }],
    ],
  },
})
```

If `rehype-pretty-code`'s options object is not directly Turbopack-serializable (it accepts function callbacks for line/word handlers, which we will not use), we pass only JSON-safe values — confirmed safe.

### Landing CodeExample rewrite

- Replace the hand-tokenized JSX in `apps/web/app/components/landing/CodeExample.tsx` with three highlighted blocks driven by the same shiki pipeline.
- Approach: pre-highlight the three example sources at build time using shiki directly (not through MDX) and render the resulting HTML inside the existing `<Pre>` container. The component becomes a thin layout wrapper around three highlighted snippets.
- Sources move to `apps/web/content/landing/code-example/*.ts.txt` (or inline string constants — to be decided in the plan; inline is fine if the snippets stay <40 lines each).
- Project-tree section above the code panels: kept as-is (it's not code, it's a stylized directory listing). May be polished in a follow-up.
- Terminal output panel: kept as-is — it's not source code, it's CLI output styled distinctly.

## Architecture

```
apps/web/
├── lib/shiki/
│   └── dawn-theme.ts                    # custom shiki theme JSON
├── app/components/mdx/
│   ├── CodeBlock.tsx                    # <Pre> override
│   └── CodeGroup.tsx                    # multi-file tabs wrapper
├── mdx-components.tsx                   # wires <Pre>, fixes inline <code>
└── next.config.ts                       # adds rehype-pretty-code

apps/web/app/components/landing/
└── CodeExample.tsx                      # rewritten using shiki directly
```

Data flow:

1. Author writes fenced code in `.mdx` with optional fence meta.
2. `@next/mdx` runs `remark-gfm` → `rehype-pretty-code` (shiki + theme).
3. Output is `<pre data-language="ts" data-title="...">` with token `<span class="line">...</span>` children.
4. MDX renderer maps `<pre>` → `<Pre>`, which reads attrs and renders the header + copy button + token children.
5. `<CodeGroup>` (when present) wraps multiple `<Pre>` children and switches between them.

## Testing

- **Unit (vitest, jsdom):** `<Pre>` renders header when `data-title` present, copy button copies content, `<CodeGroup>` switches tabs on click.
- **Visual smoke:** one MDX page with one of each variant — bare bash, titled TS, line-highlighted, diff, CodeGroup. Manual review pre-merge.
- **Regression:** the inline `<code>` border bug is fixed — assert no `border` on `pre code` via a rendered DOM snapshot.
- No e2e — code-block UX is covered by unit + manual visual review.

## Migration

- Existing docs MDX uses fenced blocks already; they will pick up highlighting automatically on first build after merge.
- Authors who want filenames or line highlights add fence meta — incremental, no bulk rewrite needed.
- Landing `CodeExample` rewrite happens in the same PR (per scope decision).

## Open items deferred to plan

- Whether snippet sources for `CodeExample` live as inline strings or content files.
- Whether to add an automated check that highlighted code in docs still type-checks against the actual SDK (out of scope unless trivial; likely future spec).
