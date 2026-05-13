# SaaS Rebrand Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit and align typography, spacing, color, and interactive patterns across `apps/web` so the SaaS rebrand (PRs #117–#124) reads as one product, not eight glued PRs. Includes renaming `landing-v2` → `landing` and eliminating legacy token references.

**Architecture:** Five sequential phases — static audit (no browser), `landing-v2` rename (mechanical), Chrome-MCP visual sweep across 9 routes × 5 viewports, fix pass, re-verify. Each phase produces a focused commit (or set of commits). Visual sweep is driven by a single design-review subagent because Chrome MCP can only drive one browser window.

**Tech Stack:** Tailwind v4 (`@theme` tokens), Next.js 16 App Router, Chrome MCP for visual review, Vitest for unit tests.

**Spec:** [`docs/superpowers/specs/2026-05-12-saas-rebrand-polish-design.md`](../specs/2026-05-12-saas-rebrand-polish-design.md)

---

## Codebase Notes (read before starting)

- The SaaS rebrand introduced these tokens in `apps/web/app/globals.css` under `@theme`:
  - Surfaces: `--color-page` (`#ffffff`), `--color-surface` (`#fafaf7`), `--color-surface-sunk` (`#f4f2ec`)
  - Ink: `--color-ink` (`#14110d`), `--color-ink-muted` (`#5a554c`), `--color-ink-dim` (`#8a857b`)
  - Dividers: `--color-divider` (`#e6e3da`), `--color-divider-strong` (`#cfcabd`)
  - Accent: `--color-accent-saas` (`#b45309`), `--color-accent-saas-ink` (`#ffffff`), `--color-accent-saas-soft` (`#fef3c7`)
- Legacy tokens removed: every `text-text-*`, `bg-bg-*`, `border-border-subtle`, `border-border`, `accent-amber*`, `landing-dark`.
- `dawnTheme` Shiki theme replaced by `github-light` (configured in `apps/web/next.config.ts` and `apps/web/lib/shiki/highlight-light.ts`).
- New landing components at `apps/web/app/components/landing-v2/` — to be renamed to `landing/` in Phase 2.
- The site already has `--header-h: 4.5rem` and `html { scroll-padding-top: var(--header-h) }` from prior work.
- A dev server is running on port `3003` from this worktree.

## File Structure

**Plan-internal files (committed to the repo for traceability):**

- `docs/superpowers/specs/2026-05-12-saas-rebrand-polish-findings.md` — written by Phase 3's design-review subagent; committed verbatim so the fix pass has a stable reference.

**Code touched (sets per phase):**

- **Phase 2** — every file under `apps/web/app/components/landing-v2/` (rename), plus `apps/web/app/page.tsx` and `apps/web/app/blog/[slug]/page.tsx` (import path updates).
- **Phase 4** — TBD by audit + visual sweep results; expected: scattered files under `apps/web/app/components/{landing,blog,docs}/`, `apps/web/app/brand/`, `apps/web/mdx-components.tsx`, `apps/web/app/globals.css`.

---

## Task 1 — Static audit (greps; produces in-memory checklist)

**Files:**
- Read-only audit pass; no modifications. The output is a checklist used by Task 4.

- [ ] **Step 1: Run the audit greps**

From the repo root, run each grep in turn and record the output. Use `apps/web/app apps/web/mdx-components.tsx` as the search root; exclude `node_modules` and `.next` (they shouldn't be matched anyway since `apps/web/app` is the target).

```bash
echo "=== Legacy surface tokens ==="
grep -rnE "text-text-(primary|secondary|muted|dim)|bg-bg-(primary|secondary|card)" \
  apps/web/app apps/web/mdx-components.tsx

echo "=== Legacy border tokens ==="
grep -rnE "border-border-subtle|border-border([^-]|$)" \
  apps/web/app apps/web/mdx-components.tsx

echo "=== Legacy accent-amber ==="
grep -rnE "accent-amber(-deep)?" \
  apps/web/app apps/web/mdx-components.tsx apps/web/app/globals.css

echo "=== landing-dark scope ==="
grep -rn "landing-dark" apps/web/app apps/web/mdx-components.tsx apps/web/app/globals.css

echo "=== Old Shiki theme ==="
grep -rnE "dawnTheme|dawn-theme" apps/web

echo "=== landing-v2 staging name ==="
grep -rn "landing-v2" apps/web

echo "=== Inline hex from old palette ==="
grep -rnE "#0a0806|#14110d|#f8f5ef|#fdfbf7|#fbf8ee|#fcfaf3" \
  apps/web/app apps/web/mdx-components.tsx
```

- [ ] **Step 2: Record findings in the spec findings file**

For each hit, capture: `file:line: offender → replacement-token`. The replacement table from the spec:

| Offender | Replacement |
|---|---|
| `text-text-primary` | `text-ink` |
| `text-text-secondary` | `text-ink-muted` |
| `text-text-muted` | `text-ink-dim` |
| `text-text-dim` | `text-ink-dim` |
| `bg-bg-primary` | `bg-page` |
| `bg-bg-secondary` | `bg-surface` |
| `bg-bg-card` | `bg-surface-sunk` |
| `border-border-subtle` | `border-divider` |
| `border-border` | `border-divider-strong` |
| `accent-amber-deep` | `accent-saas` |
| `accent-amber` | `accent-saas` (or `accent-saas-soft` for backgrounds) |
| `landing-dark` class | delete (scope no longer exists) |
| inline `#fdfbf7` etc. | replace with `var(--color-page)` or appropriate CSS var |

Write the findings list into a temporary file (or directly into the working terminal scrollback) — DON'T commit it yet. Phase 4 will fold these into a single fix commit.

- [ ] **Step 3: Triage**

For each hit, decide:
- **Replace** — straightforward rewrite using the table above.
- **Investigate** — usage where the right replacement isn't obvious (e.g., a class string built dynamically). Mark these for human / fix-subagent attention.

- [ ] **Step 4: No commit yet**

Static findings drive Phase 4. No commit at end of Task 1.

---

## Task 2 — `landing-v2` → `landing` rename

**Files:**
- Move: `apps/web/app/components/landing-v2/*` → `apps/web/app/components/landing/*`
- Modify: `apps/web/app/page.tsx` (12 imports)
- Modify: `apps/web/app/blog/[slug]/page.tsx` (1 import — `FinalCta`)
- Modify: any other file referencing `landing-v2/` (verify with grep)

- [ ] **Step 1: Verify there's no existing `landing/` directory**

```bash
ls apps/web/app/components/landing 2>&1
```

Expected: `No such file or directory`. (The old `landing/` was deleted in the SaaS rebrand.) If a `landing/` exists, stop and report — the rename can't proceed without a merge plan.

- [ ] **Step 2: Move the folder**

```bash
git mv apps/web/app/components/landing-v2 apps/web/app/components/landing
```

This preserves git history (each file shows as a rename, not delete+add).

- [ ] **Step 3: Update import sites**

Find every reference:

```bash
grep -rn "landing-v2" apps/web 2>/dev/null
```

Expected files (verify):
- `apps/web/app/page.tsx` — 12 imports of `./components/landing-v2/<Foo>`
- `apps/web/app/blog/[slug]/page.tsx` — 1 import of `../../components/landing-v2/FinalCta`

In each file, replace `landing-v2` with `landing` in the import path. The component names themselves DO NOT change.

For example, in `apps/web/app/page.tsx`:

```ts
// Before
import { Hero } from "./components/landing-v2/Hero"

// After
import { Hero } from "./components/landing/Hero"
```

Repeat for every offending line in every file. If the grep finds additional files, update them too.

- [ ] **Step 4: Verify no `landing-v2` references remain**

```bash
grep -rn "landing-v2" apps/web 2>/dev/null
```

Expected: empty output.

- [ ] **Step 5: Run typecheck + lint + build**

```bash
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web build
```

Each must pass. If typecheck fails with `Cannot find module '.../landing-v2/...'`, an import was missed — go back to Step 3.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app
git commit -m "refactor(web): rename landing-v2 to landing now that the rebrand is shipped"
```

---

## Task 3 — Visual sweep (Chrome MCP, design-review subagent)

This task is **dispatched by the controller**, not run as a typical implementer. The controller calls one design-review subagent that owns the entire sweep. Output is a markdown findings file the controller commits before Phase 4.

**Files:**
- Create: `docs/superpowers/specs/2026-05-12-saas-rebrand-polish-findings.md`

- [ ] **Step 1: Verify dev server is up**

```bash
/usr/bin/curl -sf -o /dev/null http://localhost:3003/ && echo "ready"
```

Expected: `ready`. If not, start one: `PORT=3003 pnpm --filter @dawn-ai/web dev &`.

- [ ] **Step 2: Dispatch the design-review subagent**

Single Agent tool call with this prompt (paste verbatim):

```
You are doing a graphic-designer-level visual review of the Dawn marketing site after the SaaS rebrand. Use Chrome MCP (mcp__Claude_in_Chrome__*) to drive a single browser window at the dev server `http://localhost:3003`.

A tab is open at tabId 189619282 (use tabs_context_mcp to confirm or re-create). Iterate sequentially — Chrome MCP cannot parallelize, one browser window only.

## Viewports (5)
375, 414, 768, 1024, 1440 (width × any reasonable height). Set via resize_window.

## Routes (9)
/, /blog, /blog/why-we-built-dawn, /blog/dawn-0-4-release, /blog/tags/philosophy, /docs/getting-started, /docs/routes, /docs/recipes, /brand

That's 45 screen combinations.

## Per-screen checks
1. Typography parity — body font, sizes, line-height, weight, letter-spacing consistent within page and across pages
2. Spacing scale — section padding, gap rhythm, button padding feel like one system
3. Color usage — only SaaS tokens; flag any orphan cream/cosmic surface
4. Buttons + interactive — primary CTA shape, hover, focus rings consistent
5. Header + footer — chrome identical on every route, no positioning drift
6. Content widths — reading column intentional, not 40px drift across pages
7. Mobile responsive — no horizontal overflow; sidebars hidden at <md; TOC at <lg; tap targets ≥ 44px
8. Hierarchy — H1/H2/H3 scale and weight reads cleanly; eyebrows consistent

## Cross-route consistency checks
- Does the landing Hero feel like the same brand as /blog's "Notes on Dawn" page? Same H1 weight, same eyebrow style?
- Do the four feature blocks (FeatureRouting/Tools/Types/DevLoop on landing) match each other's spacing/structure?
- Are the 12 landing sections rhythmically consistent on padding?
- Does /brand look like part of the same site or a leftover?

## Method
- Use mcp__Claude_in_Chrome__browser_batch to combine resize_window + navigate + screenshot in one round trip.
- For overflow checks, run javascript_tool: ({overflow: document.documentElement.scrollWidth > window.innerWidth, sw: document.documentElement.scrollWidth, vw: window.innerWidth}).
- When you notice a possible inconsistency (e.g., two H2s at different sizes), open both routes and verify with computed style queries via javascript_tool.

## Output
Write a single markdown report to docs/superpowers/specs/2026-05-12-saas-rebrand-polish-findings.md grouped by severity:

### Critical
Things that are visibly broken: overflow, illegible contrast, missing chrome, layout collapse.

### Important
Visible inconsistencies a designer would catch: token mismatch between pages, button height drift, line-height jump, eyebrow color drift, sidebar/TOC vertical alignment off.

### Minor
Pixel-nit alignments, sub-px drift, cosmetic touch-ups.

Each finding cites file:component:viewport and a 1-line proposed fix.

## Time-box
30 minutes max. If you've spent more than 30 and have only inspected a subset, stop and write what you have so far with `[PARTIAL]` at the top.

## Reporting
Status (DONE / PARTIAL / BLOCKED). One sentence summary. Path to the findings file. Top 3 Critical / Important items inline.
```

Dispatch with `subagent_type: "general-purpose"`, `model: "sonnet"` (visual judgment + sequential workflow).

- [ ] **Step 3: Review the findings**

When the subagent returns, read `docs/superpowers/specs/2026-05-12-saas-rebrand-polish-findings.md`. Confirm:
- Critical and Important sections are populated (or explicitly empty)
- Each finding has a concrete file path and fix suggestion
- Total finding count is reasonable (not zero — the rebrand was rapid, drift is expected)

If the findings list looks anemic (< 5 Important findings across 45 screens), dispatch a follow-up subagent to look specifically at cross-route consistency, which is the easiest to under-report.

- [ ] **Step 4: Commit the findings file**

```bash
git add docs/superpowers/specs/2026-05-12-saas-rebrand-polish-findings.md
git commit -m "docs: SaaS rebrand polish — visual sweep findings"
```

---

## Task 4 — Fix pass

This task is also a controller-managed dispatch. One fix subagent receives the static-audit checklist (from Task 1) AND the visual-sweep findings file (from Task 3), and applies all Critical + Important fixes.

**Files:**
- Modify: many (driven by the audit and findings). Common candidates: every file under `apps/web/app/components/landing/`, `apps/web/app/components/blog/`, `apps/web/app/components/docs/`, `apps/web/app/brand/`, `apps/web/mdx-components.tsx`, `apps/web/app/globals.css`.

- [ ] **Step 1: Compose the fix prompt**

Paste both inputs into the fix subagent prompt:

- The Task 1 static audit output (legacy tokens, `landing-dark`, `dawnTheme`, inline hexes) plus the replacement table.
- The Task 3 findings file content (or a pointer to it: `docs/superpowers/specs/2026-05-12-saas-rebrand-polish-findings.md`).

- [ ] **Step 2: Dispatch the fix subagent**

```
You are applying a polish-pass to apps/web following a static audit + visual review of the SaaS rebrand.

Inputs:
1. Static audit findings — pasted below (or in the file at `docs/superpowers/specs/2026-05-12-saas-rebrand-polish-findings.md` if attached separately)
2. Visual sweep findings — at `docs/superpowers/specs/2026-05-12-saas-rebrand-polish-findings.md`

Your job:
- Apply every Critical fix
- Apply every Important fix
- Apply Minor fixes ONLY if they're a 1-line trivial change in a file you're already editing
- Skip the rest of Minor and leave them in the findings file for follow-up

For static-audit replacements, use the standard token mapping:
text-text-primary → text-ink
text-text-secondary → text-ink-muted
text-text-muted → text-ink-dim
text-text-dim → text-ink-dim
bg-bg-primary → bg-page
bg-bg-secondary → bg-surface
bg-bg-card → bg-surface-sunk
border-border-subtle → border-divider
border-border → border-divider-strong
accent-amber-deep → accent-saas
accent-amber → accent-saas (or accent-saas-soft for surfaces — judge by context)
landing-dark class → delete the class

After fixes:
1. Run pnpm --filter @dawn-ai/web typecheck (must pass)
2. Run pnpm --filter @dawn-ai/web lint (must pass)
3. Run pnpm vitest run apps/web (must pass)
4. Run pnpm --filter @dawn-ai/web build (must pass)

Commit as 1-2 commits:
- `fix(web): SaaS rebrand polish — token cleanup` for the static-audit fixes
- `fix(web): SaaS rebrand polish — visual consistency` for the visual-sweep fixes
- Or one combined commit if the two categories overlap heavily

Report Status (DONE / DONE_WITH_CONCERNS / BLOCKED), files touched (count by directory), number of Critical/Important/Minor each addressed, anything skipped with rationale.
```

Dispatch with `subagent_type: "general-purpose"`, `model: "opus"` (this requires judgment + many-file editing).

- [ ] **Step 3: Verify build is green after fixes**

```bash
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web lint
pnpm vitest run apps/web
pnpm --filter @dawn-ai/web build
```

All four must pass. If anything fails, the fix subagent should be re-dispatched to address.

---

## Task 5 — Re-verify (Chrome MCP, scoped to fixed routes)

**Files:**
- Read-only verification. May produce a short addendum to the findings file if regressions surfaced.

- [ ] **Step 1: Dispatch the re-verify subagent**

```
You are re-verifying the fixes applied to the Dawn marketing site after a SaaS rebrand polish pass.

Inputs:
- docs/superpowers/specs/2026-05-12-saas-rebrand-polish-findings.md — original findings
- Recent commits — the fix subagent's work; inspect `git log -3 --stat` to see what changed

Your job:
1. For each Critical and Important finding in the file, navigate to the relevant route/viewport via Chrome MCP at http://localhost:3003.
2. Confirm the issue is resolved.
3. Record results inline as appended status in the findings file: ✅ Fixed / ⚠️ Partially fixed / ❌ Still broken / 🆕 New issue.

Use the same Chrome MCP method as the original sweep (browser_batch + screenshot + javascript_tool for measurements).

Don't re-walk every screen — only the ones tied to a Critical or Important finding.

If you find regressions or net-new issues, list them under a new `## Re-verify additions` section in the findings file.

Output: Status (CLEAN / REGRESSIONS / BLOCKED). If REGRESSIONS, list them.
```

Dispatch `subagent_type: "general-purpose"`, `model: "sonnet"`.

- [ ] **Step 2: Inspect results**

If status is CLEAN — proceed to Task 6.

If status is REGRESSIONS — dispatch a second fix subagent with the regression list. Then re-dispatch the verify subagent. Cap at 2 fix iterations total; if still broken, stop and escalate to the human.

- [ ] **Step 3: Commit the annotated findings file**

```bash
git add docs/superpowers/specs/2026-05-12-saas-rebrand-polish-findings.md
git commit -m "docs: annotate SaaS rebrand polish findings with verification results"
```

---

## Task 6 — Final verification + PR

- [ ] **Step 1: Full automated suite**

```bash
pnpm vitest run
pnpm -r typecheck
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web build
```

All must pass. The workspace has two pre-existing test failures (`packages/vite-plugin/test/plugin.test.ts`, `scripts/release-publish.test.mjs`) unrelated to this work; confirm those are the only failures.

- [ ] **Step 2: Final audit re-run**

Re-run the Task 1 greps to confirm zero legacy hits remain:

```bash
grep -rnE "text-text-(primary|secondary|muted|dim)|bg-bg-(primary|secondary|card)|border-border-subtle|border-border([^-]|$)|landing-dark|dawnTheme|landing-v2" \
  apps/web/app apps/web/mdx-components.tsx
```

Expected: empty (or only matches in `globals.css` comments / docs).

If any survive, return to Task 4.

- [ ] **Step 3: Push branch**

```bash
git push -u origin claude/condescending-moore-7988a2
```

(If branch was force-pushed earlier, use `--force-with-lease`.)

- [ ] **Step 4: Open PR**

```bash
gh pr create --title "feat(web): SaaS rebrand polish — full visual review pass" --body "$(cat <<'EOF'
## Summary

Polish pass across apps/web after the SaaS rebrand (PRs #117–#124). Phases:

- **Static audit + token cleanup** — replaced every legacy `text-text-*`, `bg-bg-*`, `border-border-*`, `accent-amber*`, `landing-dark`, `dawnTheme`, and `landing-v2` reference with the new SaaS token names
- **Folder rename** — `landing-v2/` → `landing/` now that the rebrand is shipped
- **Visual sweep** — Chrome-MCP-driven designer-level review at 9 routes × 5 viewports, with cross-route consistency checks (Hero vs Notes-on-Dawn typography, feature block parity, section padding rhythm)
- **Fix pass** — all Critical + Important findings addressed
- **Re-verify** — fixes confirmed via second Chrome-MCP pass on affected routes

## Findings + verification

Full findings + verification annotations:
- Spec: `docs/superpowers/specs/2026-05-12-saas-rebrand-polish-design.md`
- Plan: `docs/superpowers/plans/2026-05-12-saas-rebrand-polish.md`
- Findings + verification: `docs/superpowers/specs/2026-05-12-saas-rebrand-polish-findings.md`

## Known follow-ups (Minor)

Listed in the findings file under un-resolved Minor section.

## Test plan

- [ ] pnpm vitest run apps/web — all tests pass
- [ ] pnpm -r typecheck — clean
- [ ] pnpm --filter @dawn-ai/web lint — clean
- [ ] pnpm --filter @dawn-ai/web build — production build succeeds, all routes pre-render
- [ ] Visit /, /blog, /blog/<slug>, /docs/getting-started, /brand at 375 and 1440 — typography, spacing, colors consistent
- [ ] grep audit confirms zero legacy token references

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Watch CI**

```bash
gh pr checks <PR-NUMBER> --watch
```

When green:

```bash
gh pr merge <PR-NUMBER> --squash --delete-branch --admin
```

- [ ] **Step 6: Verify merged**

```bash
gh pr view <PR-NUMBER> --json state,mergedAt
```

Expected: `{"state":"MERGED", ...}`.

---

## Done criteria

- Phase 1 static audit returns zero hits on rerun.
- `landing-v2/` directory no longer exists; all imports updated.
- Phase 3 findings file committed; Phase 5 verification annotations confirm all Critical + Important are ✅ Fixed.
- All automated checks pass.
- PR merged.
