# Comic Strip Section — Design

**Date:** 2026-05-11
**Status:** Approved
**Scope:** apps/web — new `ComicStrip` landing section, inserted between `WhoItsFor` and `ComparisonTable`

## Problem

The landing page tells the "Dawn fixes fragmentation" story across many sections, but it tells it *abstractly*: pain bullets, persona cards, code diffs, comparison tables. There's no moment that humanizes the transformation — no reader-with-a-name, no "this could be me" scene.

The character/dialog brainstorm earlier in the session locked the format: a 4-panel comic strip showing two developers — one frustrated, one already using Dawn — with the strip ending on the relieved-surprise beat.

## Goals

- Land an emotional bridge between **WhoItsFor** (self-qualification: "this could be you") and **ComparisonTable** (intellectual argument: "here's the technical comparison").
- Show the transformation as a story, not a feature list.
- Voice consistent with the established landing tone — short declaratives, no marketing fluff, the punchline does the selling.
- Ship a v1 with placeholder illustrations; commission cartoony art as a follow-up.

## Non-goals

- Custom-commissioned illustrations for v1. Placeholder SVGs only; real art is a separate follow-up.
- AI-generated panels. Style consistency is too brittle for v1.
- Animation. Static panels only.
- Hero or any other section restructure.

## Approach

### Section structure

Single new file: `apps/web/app/components/landing/ComicStrip.tsx`. Server component.

Section flow (top to bottom):
1. **Eyebrow** — `MEANWHILE…` (caps, amber dot, matches eyebrow style across the page)
2. **No headline.** Comic stands alone.
3. **4-panel horizontal strip.** Responsive: 4-across on `lg`, 2×2 on `md`, single column on mobile.

### The 4-panel dialog (locked)

| Panel | Setting | Dialog |
|---|---|---|
| 1 | Dev A at a cluttered desk, multiple monitors, frowning at a screen of StateGraph boilerplate | **Dev A:** *"Fifth StateGraph this month."* |
| 2 | Same Dev A, head in hands | **Dev A:** *"This isn't agent code. This is project structure."* |
| 3 | Dev B enters frame, casual, holding a coffee mug, peeking at Dev A's screen | **Dev B:** *"You know Next.js, right? Same thing for LangGraph."* |
| 4 | Dev A looking at a clean three-file project, eyes wide | **Dev A:** *"…wait, that's it?"* |

Characters are nameless (Dev A / Dev B) — the strip is short enough that proper nouns add friction without payoff.

### Visual treatment

#### Panel chrome

Each panel is a rounded card matching existing landing-section aesthetics:
- Border: `border border-border-subtle` (or `border-indigo-500/20` if we want the "pre-Dawn" feel on panels 1–2 and amber on 3–4 — see open items)
- Background: `landing-surface`
- Padding: comfortable, so the illustration breathes

Within each panel:
- **Illustration area** at the top (placeholder SVG for v1; cartoony commissioned art for v2)
- **Speech bubble or caption** below the illustration containing the dialog line
- Dialog typography: `text-sm` with the speaker tag (`Dev A:` / `Dev B:`) bolded `text-text-primary font-medium`, the line itself `landing-text-muted leading-relaxed`

#### Placeholder illustrations (v1)

Each panel's illustration area is a simple SVG placeholder — minimal stick-figure or icon-style drawing on a dark background with amber strokes. Goals for v1 placeholders:
- Distinct enough to signal "this is a comic panel"
- Cheap enough that we can ship today
- Easy to swap out for commissioned cartoony art later

Suggested v1 illustrations (the implementer can adjust if a different shape ships cleaner):
- Panel 1: Stick figure at a desk, monitor showing code lines, frowny brow
- Panel 2: Same stick figure with hands over face
- Panel 3: Second stick figure entering frame from the right with a coffee mug
- Panel 4: Both stick figures looking at a 3-file folder tree on the monitor

Inline SVG strings stored as constants at the top of `ComicStrip.tsx`. Each SVG is `width="100%"`, fixed aspect ratio (say `viewBox="0 0 200 140"`), amber stroke color (`stroke="currentColor"` so theme tokens work), no fill.

### Section chrome

```tsx
import type { ReactNode } from "react"

interface Panel {
  readonly speaker: "Dev A" | "Dev B"
  readonly line: string
  readonly illustration: ReactNode
}

const PANELS: readonly Panel[] = [
  { speaker: "Dev A", line: "Fifth StateGraph this month.", illustration: <Panel1SVG /> },
  { speaker: "Dev A", line: "This isn't agent code. This is project structure.", illustration: <Panel2SVG /> },
  { speaker: "Dev B", line: "You know Next.js, right? Same thing for LangGraph.", illustration: <Panel3SVG /> },
  { speaker: "Dev A", line: "…wait, that's it?", illustration: <Panel4SVG /> },
]

export function ComicStrip() {
  return (
    <section className="relative py-20 px-8">
      <div className="text-center max-w-2xl mx-auto mb-12">
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          Meanwhile…
        </p>
      </div>

      <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {PANELS.map((p, i) => (
          <div
            key={`${i}-${p.speaker}`}
            className="landing-surface border border-border-subtle rounded-lg p-5"
          >
            <div className="aspect-[200/140] flex items-center justify-center text-accent-amber mb-4">
              {p.illustration}
            </div>
            <p className="text-sm leading-relaxed">
              <strong className="text-text-primary font-medium">{p.speaker}:</strong>{" "}
              <span className="landing-text-muted">{p.line}</span>
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
```

### `page.tsx` insertion

Current order:
```
...HeroSection → EcosystemSection → ProblemSection → WhoItsFor → ComparisonTable...
```

New order:
```
...HeroSection → EcosystemSection → ProblemSection → WhoItsFor → ComicStrip → ComparisonTable...
```

`ComicStrip` wraps in `<ScrollReveal>` (same pattern as other landing sections).

## Architecture

```
apps/web/app/components/landing/
└── ComicStrip.tsx     # NEW

apps/web/app/page.tsx  # add import + JSX insertion
```

One new file, one edit. No deletions, no API changes.

## Testing

- `pnpm --filter @dawn-ai/web build`, `typecheck`, `lint` all pass.
- Manual smoke at `/` desktop (1440x900):
  - Comic strip renders with 4 panels horizontally between WhoItsFor and ComparisonTable.
  - Each panel shows placeholder illustration + speaker tag + dialog line.
  - Eyebrow "MEANWHILE…" reads as a story break.
- Mobile (390x844):
  - Panels stack to 1 column.
  - Each panel still readable at narrow width.
- Tablet (768x1024):
  - 2×2 grid renders correctly.

## Migration risk

Low — one new file, one JSX insertion, no deletions. Placeholder illustrations are bounded SVG; if v1 reads awkwardly we can iterate the section or hide it behind a feature flag while commissioning real art.

## Open items deferred to plan / follow-up

- **Real cartoony illustrations.** The full-color cartoony illustrations the user picked are NOT in v1 — placeholder SVGs ship instead. Follow-up: commission 4 panels of consistent cartoony art (or generate via AI with a tight seeded style guide) to swap in.
- **Differentiated panel borders.** Open item — should panels 1–2 (pre-Dawn) carry an indigo border ("cool unsolved" tone used on the old ProblemSection cards) and panels 3–4 (post-Dawn) carry amber borders? Default: same border for all 4 — visual differentiation might be too cute. Decide at chrome validation.
- **Speech bubble vs caption layout.** Current spec puts the dialog as a caption *below* the illustration. Alternative: render the dialog as a styled speech bubble *inside* the illustration area. Default: caption below — cleaner, doesn't require fitting variable-length dialog inside fixed illustration art.
- **Mobile reading order.** On mobile (1-column stack), the strip reads top-to-bottom in numerical order — same as desktop left-to-right. Confirmed correct.

## Research grounding

Pulled from the in-conversation brainstorm session 2026-05-11. Specific decisions traced:
- Two-dev format: chosen over single-protagonist (XKCD-style internal monologue), team chat, migration vignette.
- 4 panels: chosen over 3 (too brief), 6 (slides), 2 (no character).
- Full-color cartoony art (illustration style): chosen over XKCD stick figures, line art, AI panels, photographic. v1 ships placeholder SVGs; full-color cartoony is v2.
- Placement: chosen over post-Problem (premature relief), post-Solution (too late), top-of-page (no context).
- Visual chrome: eyebrow-only ("MEANWHILE…") — chosen over no chrome (loses framing) and eyebrow+headline (competes with comic).
