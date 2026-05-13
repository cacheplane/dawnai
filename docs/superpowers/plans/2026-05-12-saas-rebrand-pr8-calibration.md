# SaaS Rebrand PR 8 — Calibration Plan

> superpowers:subagent-driven-development.

**Goal:** Final calibration pass. Tune the amber accent to meet AA contrast, swap the MDX shiki theme to a light bundled theme, delete now-unused cream-theme tokens and the dark `dawn-theme.ts` helper, and update a handful of globals.css rules that still reference the old amber tokens.

**Spec:** § Risks #1, § Open Calibrations.

---

## Tasks

### Task 1 — Amber contrast tune
- `--color-accent-saas: #d97706` → `#b45309` in `globals.css`. New ratios on `#ffffff` page: text 5.12:1 (passes AA normal), white-on-amber buttons 5.12:1 (passes AA normal). `--color-accent-saas-soft: #fef3c7` (background, not gated by contrast) and `--color-accent-saas-ink: #ffffff` unchanged.

### Task 2 — MDX shiki theme swap
- Edit `apps/web/next.config.ts`: replace the `dawnTheme` import + reference with the bundled string theme name `"github-light"`. Drop the `import { dawnTheme } from "./lib/shiki/dawn-theme"` line and change `theme: dawnTheme` → `theme: "github-light"`.

### Task 3 — Delete dawn-theme.ts
- `rm apps/web/lib/shiki/dawn-theme.ts` (consumer in next.config.ts removed in Task 2; the only other reference is a comment in `highlight-light.ts` which doesn't import it).

### Task 4 — Clean unused legacy tokens in globals.css

Delete the following declarations from the `@theme { ... }` block (they have no consumers after PR 7):

- `--color-dawn-black: #000000;`
- `--color-dawn-white: #ffffff;`
- `--color-dawn-neutral-gray: #6b6b6b;`
- `--color-bg-primary: #fdfbf7;`
- `--color-bg-secondary: #fcfaf3;`
- `--color-bg-card: #fbf8ee;`
- `--color-border: rgba(26, 21, 48, 0.12);`
- `--color-border-subtle: rgba(26, 21, 48, 0.08);`
- `--color-text-primary: #1a1530;`
- `--color-text-secondary: #6d5638;`
- `--color-text-muted: #8a7657;`
- `--color-text-dim: #b2a285;`
- `--color-accent-amber: #f59e0b;`
- `--color-accent-amber-deep: #d97706;`

KEEP: `--color-accent-green`, `--color-accent-blue`, `--color-accent-purple` (used by Callout and PostCard).

Also delete the unused `--dawn-black`, `--dawn-white`, `--dawn-neutral-gray` from the `:root` block. Keep `--dawn-font-sans` and `--header-h`.

### Task 5 — Update remaining globals.css rules

`.mdx-inline-code` (around lines 86-95) hard-codes the amber chip colors. Update to use the SaaS accent:
- `background: rgba(217, 119, 6, 0.1);` → `background: rgba(180, 83, 9, 0.1);`
- `color: #b45309;` → keep as-is (already the new accent value)
- `border: 1px solid rgba(217, 119, 6, 0.25);` → `border: 1px solid rgba(180, 83, 9, 0.25);`

Shiki line highlighting (around lines 122-127):
- `background: rgb(from var(--color-accent-amber) r g b / 0.1);` → `background: rgb(from var(--color-accent-saas) r g b / 0.1);`
- `border-left-color: var(--color-accent-amber);` → `border-left-color: var(--color-accent-saas);`

### Task 6 — Verify

```bash
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web build
pnpm lint
```

If any consumer of the deleted tokens still exists, typecheck/build will fail — fix and re-run.

### Task 7 — Push, PR, merge on green.

---

## Risks

- Deleting tokens that turn out to have a stray consumer the audit missed. Mitigation: build will fail; fix forward.
- `github-light` may render slightly differently than the previous (broken-on-cream) `dawnTheme` output. This is the intent; CI just needs to compile, visual change is the desired outcome.

## Out of scope

- Token renames (`--color-page` → `--color-bg`, `--color-divider` → `--color-border`). Optional polish; can ship later if desired.
- Copy polish on landing sections — judgment call; the words are already Brian-voice from the spec drafting and don't need a sweep here.
- Real screenshots in feature blocks (calibration item from spec); deferred to a future content PR.
