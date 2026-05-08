# Pattern Section (ArchitectureSection redesign) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing You/Dawn/LangChain card stack in `ArchitectureSection.tsx` with a "pattern" treatment that lands the Next.js → Dawn metaphor: italic-gold "App Router" headline, two file trees side-by-side (Next.js vs Dawn), a 5-row translation table, and a tight closing line.

**Architecture:** Single-file rewrite. Outer scaffolding (`<section>` wrapper, `py-36`, `border-t`, mounted in `page.tsx` between Solution and CodeExample) stays. Inner content is replaced end-to-end. File trees use fixed-dark code surfaces (matching the post-Pass-1 discipline in `CodeExample`); the translation table sits on a white card; the rest of the section reads from the daylight palette via `landing-text` / `landing-text-muted` utilities.

**Tech Stack:** React 19, Next.js 16, TypeScript 6, Tailwind v4 (CSS-first config). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-08-pattern-section-design.md`

---

## File structure

**Modified:**
- `apps/web/app/components/landing/ArchitectureSection.tsx` — full rewrite. Old `Layer` interface, `LAYERS` const, `Connector`, and `LayerCard` helpers are removed; replaced with `FileTree`, `TableRow` helpers in the same file.

That's the entire footprint. No other files touched.

---

## Task 1: Rewrite `ArchitectureSection.tsx`

**Files:**
- Modify: `apps/web/app/components/landing/ArchitectureSection.tsx`

This is a complete rewrite — the new content replaces the entire file in one commit. Steps below verify each piece in order.

- [ ] **Step 1: Replace the file with the new implementation**

Overwrite `apps/web/app/components/landing/ArchitectureSection.tsx` with these exact contents:

```tsx
interface TreeLine {
  readonly indent: number
  readonly tokens: readonly TreeToken[]
}

interface TreeToken {
  readonly text: string
  readonly color?: "yellow" | "purple" | "blue" | "green" | "muted" | "default"
}

interface TreeNote {
  readonly text: string
}

type TreeRow = TreeLine | (TreeLine & { readonly note?: TreeNote })

const NEXTJS_TREE: readonly (TreeLine & { readonly note?: TreeNote })[] = [
  { indent: 0, tokens: [{ text: "app/", color: "yellow" }] },
  { indent: 1, tokens: [{ text: "middleware.ts", color: "green" }] },
  {
    indent: 1,
    tokens: [{ text: "(public)/", color: "yellow" }],
    note: { text: "← route group" },
  },
  { indent: 2, tokens: [{ text: "hello/", color: "yellow" }] },
  {
    indent: 3,
    tokens: [{ text: "[tenant]/", color: "purple" }],
    note: { text: "← dynamic segment" },
  },
  {
    indent: 4,
    tokens: [{ text: "page.tsx", color: "blue" }],
    note: { text: "← UI route" },
  },
  {
    indent: 4,
    tokens: [{ text: "route.ts", color: "green" }],
    note: { text: "← API endpoint" },
  },
]

const DAWN_TREE: readonly (TreeLine & { readonly note?: TreeNote })[] = [
  { indent: 0, tokens: [{ text: "app/", color: "yellow" }] },
  { indent: 1, tokens: [{ text: "middleware.ts", color: "green" }] },
  {
    indent: 1,
    tokens: [{ text: "(public)/", color: "yellow" }],
    note: { text: "← route group" },
  },
  { indent: 2, tokens: [{ text: "hello/", color: "yellow" }] },
  {
    indent: 3,
    tokens: [{ text: "[tenant]/", color: "purple" }],
    note: { text: "← dynamic segment" },
  },
  {
    indent: 4,
    tokens: [{ text: "index.ts", color: "blue" }],
    note: { text: "← agent workflow" },
  },
  {
    indent: 4,
    tokens: [{ text: "tools/greet.ts", color: "green" }],
    note: { text: "← typed tool" },
  },
]

interface MappingRow {
  readonly nextjs: { readonly cell: string; readonly desc: string }
  readonly dawn: { readonly cell: string; readonly desc: string }
}

const MAPPING: readonly MappingRow[] = [
  {
    nextjs: { cell: "app/page.tsx", desc: "A route's UI — what gets rendered for a path." },
    dawn: { cell: "app/index.ts", desc: "A route's agent workflow — what runs for a path." },
  },
  {
    nextjs: { cell: "app/route.ts", desc: "An HTTP handler at this path." },
    dawn: {
      cell: "app/tools/*.ts",
      desc: "A typed tool the agent at this path can call. Co-located.",
    },
  },
  {
    nextjs: {
      cell: "[slug]/",
      desc: "Dynamic segment — typed at build via generated params.",
    },
    dawn: {
      cell: "[tenant]/",
      desc: "Dynamic segment — typed at build via generated RouteState.",
    },
  },
  {
    nextjs: { cell: "middleware.ts", desc: "Edge / request middleware. Runs before the handler." },
    dawn: {
      cell: "middleware.ts",
      desc: "Auth, retry, logging — same semantics, runs before the workflow.",
    },
  },
  {
    nextjs: { cell: "next dev", desc: "Type-aware dev server with HMR." },
    dawn: {
      cell: "dawn dev",
      desc: "Type-aware dev server with HMR — speaks the LangGraph deployment protocol.",
    },
  },
]

const TOKEN_COLOR_CLASS: Record<NonNullable<TreeToken["color"]>, string> = {
  yellow: "text-yellow-400",
  purple: "text-purple-400",
  blue: "text-blue-400",
  green: "text-green-400",
  muted: "text-text-muted",
  default: "text-text-secondary",
}

function FileTree({
  tag,
  meta,
  tagColor,
  rows,
}: {
  readonly tag: string
  readonly meta: string
  readonly tagColor: "white" | "amber"
  readonly rows: readonly (TreeLine & { readonly note?: TreeNote })[]
}) {
  const tagClass = tagColor === "amber" ? "text-accent-amber" : "text-text-primary"
  return (
    <div className="bg-bg-card border border-border rounded-xl p-6 font-mono text-sm leading-[2] text-text-muted shadow-[0_12px_32px_-16px_rgba(33,24,12,0.18)]">
      <div className="flex items-center justify-between pb-3 mb-3 border-b border-border-subtle">
        <span
          className={`font-sans text-[10px] uppercase tracking-[0.15em] font-bold ${tagClass}`}
        >
          {tag}
        </span>
        <span className="font-sans text-[11px] text-text-dim">{meta}</span>
      </div>
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tree structure is static and stable
        <div key={i}>
          {Array.from({ length: row.indent }).map((_, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: indent is static
            <span key={j}>&nbsp;&nbsp;</span>
          ))}
          {row.tokens.map((tok, j) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens are static
              key={j}
              className={tok.color ? TOKEN_COLOR_CLASS[tok.color] : TOKEN_COLOR_CLASS.default}
            >
              {tok.text}
            </span>
          ))}
          {row.note && (
            <span className="text-text-dim text-[11px] not-italic font-sans pl-2 italic">
              {row.note.text}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

export function ArchitectureSection() {
  return (
    <section className="relative py-36 px-8 border-t landing-border">
      <div className="max-w-[1100px] mx-auto">
        {/* Eyebrow */}
        <p className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-accent-amber font-semibold mb-3">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          The pattern
        </p>

        {/* Headline */}
        <h2
          className="font-display font-bold tracking-tight leading-[1.05] mb-4 max-w-[720px] landing-text"
          style={{
            fontSize: "clamp(40px, 6vw, 56px)",
            letterSpacing: "-0.025em",
            fontVariationSettings: "'opsz' 144, 'SOFT' 50",
          }}
        >
          It&apos;s{" "}
          <span style={{ color: "#d97706", fontStyle: "italic" }}>App Router</span>.
          <br />
          For agents.
        </h2>

        {/* Lede */}
        <p className="landing-text-muted text-lg leading-relaxed max-w-[600px] mb-14">
          If you can build a Next.js app, you can build a Dawn agent. Same file-system
          conventions, same type inference, same dev server ergonomics — applied to LangGraph.
        </p>

        {/* File trees */}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_60px_1fr] gap-4 md:gap-0 items-stretch mb-16">
          <FileTree
            tag="Next.js · App Router"
            meta="a web app"
            tagColor="white"
            rows={NEXTJS_TREE}
          />
          <div className="hidden md:flex flex-col items-center justify-center gap-2 text-accent-amber-deep">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            <span
              className="font-mono text-[9px] uppercase font-bold tracking-[0.18em]"
              style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", padding: "8px 0" }}
            >
              same conventions
            </span>
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </div>
          {/* Mobile-only horizontal rule between trees */}
          <div
            className="md:hidden flex items-center justify-center gap-2 text-accent-amber-deep py-2"
            aria-hidden
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14M6 13l6 6 6-6" />
            </svg>
            <span className="font-mono text-[9px] uppercase font-bold tracking-[0.18em]">
              same conventions
            </span>
          </div>
          <FileTree
            tag="Dawn · App Router for agents"
            meta="an AI agent"
            tagColor="amber"
            rows={DAWN_TREE}
          />
        </div>

        {/* Translation table */}
        <div
          className="rounded-xl overflow-hidden border"
          style={{
            background: "white",
            borderColor: "rgba(33,24,12,0.10)",
            boxShadow: "0 4px 16px -8px rgba(33,24,12,0.08)",
          }}
        >
          {/* Header row */}
          <div
            className="grid grid-cols-[1fr_60px_1fr] px-7 py-3.5 text-[11px] uppercase tracking-[0.15em] font-bold"
            style={{ background: "rgba(217,119,6,0.06)", color: "#d97706" }}
          >
            <div>Next.js · App Router</div>
            <div />
            <div>Dawn</div>
          </div>
          {MAPPING.map((row, i) => (
            <div
              key={row.nextjs.cell + row.dawn.cell}
              className={`grid grid-cols-[1fr_60px_1fr] px-7 py-5 items-start ${
                i < MAPPING.length - 1 ? "border-b" : ""
              }`}
              style={{ borderColor: "rgba(33,24,12,0.06)" }}
            >
              <div>
                <span className="font-mono text-sm" style={{ color: "#21180c" }}>
                  {row.nextjs.cell}
                </span>
                <p className="text-[13px] leading-relaxed mt-1.5" style={{ color: "#6d5638" }}>
                  {row.nextjs.desc}
                </p>
              </div>
              <div
                className="text-center font-bold pt-0.5"
                style={{ color: "#d97706" }}
                aria-hidden
              >
                →
              </div>
              <div>
                <span className="font-mono text-sm" style={{ color: "#21180c" }}>
                  {row.dawn.cell}
                </span>
                <p className="text-[13px] leading-relaxed mt-1.5" style={{ color: "#6d5638" }}>
                  {row.dawn.desc}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Closing line */}
        <div className="text-center mt-12 max-w-[640px] mx-auto">
          <p className="landing-text-muted leading-relaxed" style={{ fontSize: "17px" }}>
            Same patterns.{" "}
            <span
              className="inline-block px-2.5 py-0.5 rounded-full font-mono text-[13px]"
              style={{ background: "rgba(33,24,12,0.06)", color: "#21180c" }}
            >
              Next.js
            </span>{" "}
            ergonomics,{" "}
            <span
              className="inline-block px-2.5 py-0.5 rounded-full font-mono text-[13px]"
              style={{ background: "rgba(217,119,6,0.12)", color: "#d97706" }}
            >
              Dawn
            </span>{" "}
            conventions, LangGraph runtime.
          </p>
        </div>
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Verify type-check**

Run from worktree root:

```
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS (no errors).

- [ ] **Step 3: Verify build**

Run:

```
pnpm --filter @dawn-ai/web build
```

Expected: PASS. The page rendering this section should still SSG cleanly.

- [ ] **Step 4: Verify lint**

Run:

```
pnpm --filter @dawn-ai/web lint
```

Expected: PASS. If lint flags formatting (likely on the long inline-style strings), apply biome fixes:

```
pnpm --filter @dawn-ai/web exec biome check --config-path ../../packages/config-biome/biome.json --css-parse-tailwind-directives=true --write app/components/landing/ArchitectureSection.tsx
```

Then re-run lint to confirm clean.

- [ ] **Step 5: Commit**

```
git add apps/web/app/components/landing/ArchitectureSection.tsx
git commit -m "feat(web): rewrite ArchitectureSection as the pattern moment (Next.js → Dawn)"
```

---

## Task 2: Verification

- [ ] **Step 1: Manual visual smoke**

If the dev server is running on port 3000, refresh `http://localhost:3000` and scroll to where ArchitectureSection sits (after SolutionSection, before CodeExample). If the dev server is not running, start it:

```
pnpm --filter @dawn-ai/web dev
```

Verify:

1. Eyebrow reads `• THE PATTERN` in amber, all caps, letter-spaced.
2. Headline reads "It's *App Router*. For agents." — "App Router" is italic and gold (`#d97706`); the rest is dark serif.
3. Lede paragraph below the headline is muted body color, max ~600px width.
4. Two file trees render side-by-side at desktop width, on dark code surfaces. Tree headers show "Next.js · App Router / a web app" (left, white tag) and "Dawn · App Router for agents / an AI agent" (right, amber tag). Token colors are vivid: yellow folders, purple `[tenant]/`, blue route file (`page.tsx` / `index.ts`), green tools.
5. Between the trees, a vertical "same conventions" gold label with arrows above and below.
6. Translation table sits below the trees: white card, soft border, 5 rows. Header row has amber-on-cream background and uppercase text. Each data row has a monospace cell on each side, a body-text description below it, and a gold `→` in the center column.
7. Closing line: "Same patterns. `Next.js` ergonomics, `Dawn` conventions, LangGraph runtime." with two pill chips — `Next.js` on neutral cosmic-gray, `Dawn` on amber.
8. Resize the browser to a narrow width (~640px). The trees stack vertically. Between them, a horizontal arrow + "same conventions" pill appears (instead of the vertical spine). The translation table stays usable; the gold `→` arrow may get crowded but the rows remain readable.

If any of those don't match, fix in `ArchitectureSection.tsx` and re-verify before committing tweaks.

- [ ] **Step 2: Confirm the old `Layer`/`LayerCard` types are no longer referenced**

Run:

```
grep -rn "LayerCard\|interface Layer\b" apps/web
```

Expected: no matches outside `ArchitectureSection.tsx` (where they're already gone in the rewrite). If anything else imports them, the rewrite has broken a consumer — fix the consumer, re-run typecheck.

- [ ] **Step 3: Tweak commit (if anything was adjusted in step 1)**

If smoke testing revealed something to fix:

```
git add apps/web/app/components/landing/ArchitectureSection.tsx
git commit -m "chore(web): tune pattern section after smoke test"
```

If nothing needed fixing, skip this step.

---

## Verification checklist

After all tasks complete:

- [ ] `apps/web/app/components/landing/ArchitectureSection.tsx` renders the new pattern treatment (no `LayerCard`, no `Layer` interface, no You/Dawn/LangChain stack).
- [ ] `pnpm --filter @dawn-ai/web build && typecheck && lint` all PASS.
- [ ] Manual scroll smoke confirms headline italic-gold "App Router", side-by-side trees, translation table, two-pill closing line.
- [ ] Mobile-narrow layout: trees stack with horizontal "same conventions" arrow between them.
- [ ] No console errors.
