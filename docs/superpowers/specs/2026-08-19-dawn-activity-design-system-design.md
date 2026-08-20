# Dawn Activity Design System (SP1 of 4)

**Status:** Approved for planning
**Date:** 2026-08-19
**Baseline:** `2fc92f46`

## Summary

Give the activity cards in `@dawn-ai/ag-ui/react` Dawn's visual identity by
default, and a real customization ladder so a developer can take them anywhere —
from "override a color" to "replace the component" to "own the source."

Today those cards are deliberately plain: inline styles, no theme, no override
points. They were extracted for portability (PR #484), and portability is what
they got — not identity. A drop-in consumer gets something correct that looks
like nothing in particular.

This slice makes the default beautiful and the override path real. The next
slice (the Workbench) is the dogfood that proves the override path works, and the
scaffold after that hands the override layer to users as source.

## Context

Brian's direction (2026-08-19): the packaged cards should carry the framework's
visual identity by default, and ship extension points so a developer can make
them completely custom. The workbench and the package default will look very
close on purpose — that closeness is the test. If customizing the package cannot
reproduce the flagship, the customization API is a fiction.

The visual direction, chosen from mockups: **crisp neutral** — a near-monochrome
zinc scale, hairline borders, restrained shadows — with the **dawn gradient used
in exactly two places** (brand mark, primary action). Serious tool, named Dawn.

### Constraint that shapes everything

The package cannot depend on Tailwind. Drop-in consumers style their apps however
they like, and a framework dependency inside a protocol package would be an
imposition. But the cards still have to look deliberate out of the box.

The precedent is in the consumers' hands already: `@copilotkit/react-core/v2`
ships `styles.css`, and both Dawn examples import it in `app/layout.tsx`. A
package-shipped stylesheet is a pattern this audience knows.

## Goals

1. The default rendering of `dawn.plan` and `dawn.subagent` looks like Dawn —
   light and dark — with no consumer configuration beyond one CSS import.
2. A customization ladder with four rungs, each usable without the next.
3. No Tailwind, no CSS-in-JS runtime, no component-library dependency.
4. A consumer who imports nothing extra still gets working, styled cards.
5. Existing consumers keep working: this is additive.

## Non-goals

- The workbench, the scaffold, and the browser gate (SP2, SP3, SP4).
- Theming any part of Dawn beyond these two activity cards.
- A general Dawn design system for arbitrary app UI.
- Changing the AG-UI wire protocol, activity content contracts, or suppression.
- Shipping React components for tool cards or permission prompts — those live in
  app source today and stay there until there is a second consumer.

## The customization ladder

Four rungs, in increasing order of power and decreasing order of frequency. Each
works standalone; a developer stops at whichever rung solves their problem.

### Rung 1 — Tokens (most common)

`@dawn-ai/ag-ui/react/styles.css` defines CSS custom properties under a single
scope, with light and dark values:

```css
:root {
  --dawn-activity-surface: …;
  --dawn-activity-border: …;
  --dawn-activity-text: …;
  --dawn-activity-muted: …;
  --dawn-activity-accent: …;      /* the dawn gradient's solid fallback */
  --dawn-activity-running: …;
  --dawn-activity-complete: …;
  --dawn-activity-failed: …;
  --dawn-activity-radius: …;
}
```

Restyling to a house palette is overriding variables in the consumer's own CSS.
No JS, no rebuild of the package, no knowledge of internal markup.

Every rule is a single class scoped under a `dawn-activity` prefix, so the
stylesheet cannot leak into a consumer's app.

### Rung 2 — Class slots

Each card accepts an optional `classNames` object keyed by structural part:

```tsx
<PlanActivityCard
  content={content}
  classNames={{ root: "rounded-2xl border-slate-200", title: "font-semibold" }}
/>
```

Parts are named for what they are, not where they sit — one shared vocabulary
across both cards: `root`, `header`, `title`, `meta`, `badge`, `section`,
`sectionLabel`, `list`, `item`, `itemGlyph`, `itemLabel`, `itemStatus`,
`overflow`, `error`. A card silently ignores parts it has no markup for.
Classes are appended to the defaults, never replace them, so a Tailwind consumer
can layer utilities without fighting specificity.

### Rung 3 — Component slots

Swap a sub-component while keeping the validated content plumbing:

```tsx
<SubagentActivityCard content={content} components={{ ToolRow: MyToolRow }} />
```

Slots are limited to leaf presentational pieces — `TodoRow` and `ToolRow`, the
two repeated rows in the current markup — each with a documented prop contract
(`content`/`name`, `status`, `glyph`, `label`). The card keeps
ownership of validation, ordering, and the bounded-content rules (five recent
tools, 400-character error cap) so a slot cannot break the activity contract.

### Rung 4 — Eject

Copy the component source. The package's card files are single-purpose and
dependency-light by construction, so a copy compiles in a consumer's app with an
import-path change. SP3's scaffold makes this a one-file edit by shipping thin
wrappers the developer owns.

Rung 4 is documented, not automated. There is no `eject` command.

## Architecture

### What changes in `packages/ag-ui/src/react/`

- `styles.css` — new. Tokens plus the scoped default rules. Exported as
  `@dawn-ai/ag-ui/react/styles.css` via a new `exports` entry (the package
  already has a multi-entry map; note from PR #484 that a new subpath means a
  full docs-registry registration pass — `ARTIFACT_REGISTRY`, the API MDX
  ownership table, `api.mdx`, the README runtime binding line, and the frozen
  counters in `check-docs.mjs`, revealed one layer at a time).
- The three card components move from inline styles to the scoped class names,
  and gain `classNames` and `components` props. Their content props, validation,
  and bounded-content behavior are unchanged.
- `index.ts` gains the slot prop types.

Inline styles go away entirely. A card with no stylesheet imported renders
unstyled-but-structured rather than half-styled — documented as such, with the
one-line import as the fix.

### What does not change

`dawnActivityRenderers`, the schemas, the activity type constants, and the
renderers' registration shape. A consumer who upgrades and changes nothing gets
the same components with a better default appearance once they add the CSS
import — and identical behavior either way.

## Dogfooding

`examples/chat/web` is the **default-tier** dogfood: it imports `styles.css` and
nothing else, proving a consumer gets Dawn's look with one line and no
configuration. It already registers `dawnActivityRenderers` (PR #484).

The **customization-tier** dogfood is SP2's workbench, which reaches for rungs 1
through 3 to match the flagship design. If the workbench needs to eject a card to
look right, the ladder has a gap, and closing that gap is SP2's finding to report
back into this package rather than a workaround to absorb silently.

## Testing

- Every card renders from fixture content at each rung: defaults, tokens
  overridden, `classNames` applied, a component slot swapped.
- `classNames` **append** rather than replace — asserted per part, since the
  opposite behavior is the classic footgun.
- A component slot cannot escape the content contract: a slot that renders
  everything it is handed still shows at most five tools and a capped error.
- The stylesheet's selectors are all scoped to the `dawn-activity` prefix —
  asserted by parsing the emitted CSS, so a stray global rule fails the build
  rather than a consumer's layout.
- The packaged artifact actually contains `styles.css` (`pack-check` covers the
  `exports` map; the file's presence gets its own assertion).
- Watch the PR #484 trap: the package's vitest `include` must match `.tsx`, and
  the suite's **count** must be asserted — a glob mismatch collects zero tests
  and exits 0.

## Rollout

A patch changeset for `@dawn-ai/ag-ui`. Additive: new subpath, new optional
props, unchanged behavior. The README documents the ladder with a runnable
example per rung, and the AG-UI docs page gains the CSS import line.

## Acceptance criteria

1. A consumer importing `@dawn-ai/ag-ui/react/styles.css` gets Dawn-identity
   cards in light and dark with no other configuration.
2. Overriding a token restyles without touching markup.
3. `classNames` append to defaults for every documented part.
4. A component slot swaps a leaf without breaking validation or bounds.
5. Card source remains copy-and-compile for the eject path.
6. The stylesheet cannot leak: every selector is prefix-scoped, asserted.
7. `examples/chat/web` shows the default tier with one import.
8. Build, lint, check-docs, pack-check, and the ag-ui suite are green, with the
   test count asserted.

## Deferred

- **SP2:** the Workbench — dogfoods rungs 1–3 and reports any gap back here.
- **SP3:** scaffold integration — npm workspaces, ports, generation, parity, and
  the two-process harness; ships the wrapper source that makes rung 4 a one-file
  edit.
- **SP4:** the Playwright activation gate.
