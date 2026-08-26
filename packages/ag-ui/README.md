<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/ag-ui

Supported AG-UI protocol translation for Dawn runtime streams, client inputs, interrupts, activities, and SSE responses.

## Install

```bash
pnpm add @dawn-ai/ag-ui
```

```ts
import { fromRunAgentInput, toAguiEvents } from "@dawn-ai/ag-ui"
import { encodeAgUiSse } from "@dawn-ai/ag-ui/sse"
```

Plan and subagent activity snapshots are translated on the root surface; use the focused API reference for their exact identifiers and payload contracts.

Built-in orchestration is presented once. A `writeTodos` or `task` call whose activity was emitted produces no `TOOL_CALL_*` events, correlated by the model's tool-call id; every other tool is unchanged. The rule fails open, so the ordinary tool events are preserved whenever the activity cannot be produced. A client that registers no activity renderer therefore sees less for those two tools: activity snapshots are the canonical surface for them.

## React renderers

`@dawn-ai/ag-ui/react` renders those activity snapshots. The drop-in is one prop:

```tsx
import { CopilotKit } from "@copilotkit/react-core/v2"
import { dawnActivityRenderers } from "@dawn-ai/ag-ui/react"

<CopilotKit
  runtimeUrl="/api/copilotkit"
  useSingleEndpoint={false}
  renderActivityMessages={dawnActivityRenderers}
>
```

The subpath exports three layers, from drop-in to build-your-own:

- `dawnActivityRenderers` — both renderers, ready to pass to CopilotKit's `renderActivityMessages`.
- `dawnPlanActivityRenderer` and `dawnSubagentActivityRenderer` — the individual renderers, for a client that wants one of them or mixes them with its own.
- `PlanActivityCard`, `SubagentActivityCard`, and `ActivityChecklist` — plain React components taking `content`, plus `planActivityContentSchema` and `subagentActivityContentSchema`, the strict validators behind the renderers, for presenting the same activities another way.

`react` and `@copilotkit/react-core` are optional peer dependencies used only by this subpath. Importing the root or `./sse` entry never loads it, so a server-only consumer installs nothing extra.

### Customizing the activity cards

The cards ship with Dawn's visual identity via an optional stylesheet, plus a four-rung customization ladder. A card renders structured-but-unstyled markup if the stylesheet is not imported.

**Rung 1 — tokens.** Import the stylesheet once, then override its CSS custom properties in your own CSS to restyle without touching markup:

```ts
import "@dawn-ai/ag-ui/react/styles.css"
```

```css
:root {
  --dawn-activity-radius: 4px;
  --dawn-activity-padding: 12px 14px;
}
```

Palette tokens are the one case worth care. Your `:root` block now wins in dark
mode too, so a single hard-coded colour applies to BOTH themes — pick values
that work in each, or scope them the way the sheet does:

```css
:root {
  --dawn-activity-running: #6d28d9;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-dawn-theme="light"]) {
    --dawn-activity-running: #a78bfa;
  }
}
```

The full set is `--dawn-activity-` plus `surface`, `border`, `text`, `muted`, `running`, `complete`, `failed`, `badge-bg`, `radius`, `gap`, `font-size`, `margin`, `padding`, and `header-weight`. `--dawn-activity-badge-bg` defaults to `var(--dawn-activity-border)`, so the depth badge follows the palette until you point it elsewhere — `transparent`, plus a border through `classNames.badge`, gives an outline chip.

Put the overrides in plain, unlayered CSS. A Tailwind `@theme` block is not a substitute: token values declared there lose to this sheet in every configuration tested.

Light and dark values ship out of the box, keyed off `prefers-color-scheme`; set `data-dawn-theme="dark"` or `data-dawn-theme="light"` on the root element to force one regardless of the system setting (the selectors match only `:root`, not an arbitrary ancestor). All three of the sheet's token blocks are wrapped in `:where()`, so they carry no specificity at all and your own `:root` block wins in every theme, whichever sheet the browser parses first.

**Rung 2 — `classNames`.** Pass per-part class names; they are appended to the package defaults, never substituted:

```tsx
<PlanActivityCard content={content} classNames={{ root: "my-plan-card", title: "font-mono" }} />
```

Appended is not the same as applied. `styles.css` is plain, unlayered CSS, and an unlayered rule beats a layered one regardless of specificity, so a Tailwind utility touching a property the sheet already sets on that same element loses silently. **A `classNames` entry only takes effect on a property the sheet leaves unset there.** Most of what it does claim is reachable at rung 1 instead: background, border color, radius, text color, font-size, margin and padding on the card, and the header's weight, all have tokens. Reachable at neither rung, and needing rung 4: the badge's radius, font-size, weight and padding; the section label's weight and size; the item-status and overflow font-sizes; and the list and item geometry.

A class is applied to every element of that part the card renders, so a part that repeats gets it more than once. `item` lands on each row, and on `SubagentActivityCard` `list`, `itemGlyph`, `itemLabel` and `itemStatus` land on both the plan checklist and the tools list.

Three keys are easy to confuse. `section` is a card's labelled region and exists only on `SubagentActivityCard`; `checklist` is `ActivityChecklist`'s own wrapper, which both cards render; `marker` is the disclosure triangle, an `aria-hidden` span that is the first child of the header.

> **Upgrading from 0.8.21 or earlier.** `classNames.section` used to land on the checklist wrapper as well as the labelled region — pass `classNames.checklist` for the wrapper now. Three changes fail silently rather than erroring. `.dawn-activity__header::before` is gone, replaced by `.dawn-activity__marker`; `.dawn-activity__section` no longer matches the checklist wrapper, which is `.dawn-activity__checklist`; and the marker is now the FIRST CHILD of `<summary>`, so `:first-child` and `nth-child()` selectors against the header shift by one. A plain `:root` palette override also now wins in dark mode and under `data-dawn-theme`, where the package's dark rules used to outrank it — so a partial override that used to lose now leaks through; set palette tokens as a set. A `<summary>` `textContent` assertion also now sees the `▸` glyph, which a pseudo-element never contributed.

**Rung 3 — `components`.** Replace a leaf's rendering while the card keeps ownership of validation, ordering, and the bounded-content rules:

```tsx
<PlanActivityCard
  content={content}
  components={{
    TodoRow: ({ content, status, glyph, label }) => (
      <span>
        <span aria-hidden="true">{glyph}</span> {content} ({label})
      </span>
    ),
  }}
/>
```

`ActivityChecklist`, `PlanActivityCard`, and `SubagentActivityCard` all accept `classNames` and `components`; `SubagentActivityCard` also has a `ToolRow` slot for its tool rows.

**Rung 4 — eject.** For anything the ladder does not cover, copy `PlanActivityCard.tsx`, `SubagentActivityCard.tsx`, and `ActivityChecklist.tsx` into your own app. Each carries two package-internal imports that do not exist in your tree, so repoint them — note they resolve to two *different* entries:

| File | Rewrite | To |
|---|---|---|
| `ActivityChecklist.tsx` | `"../activities.js"` | `"@dawn-ai/ag-ui"` |
| `ActivityChecklist.tsx` | `"./parts.js"` | `"@dawn-ai/ag-ui/react"` |
| `PlanActivityCard.tsx` | `"../activities.js"` | `"@dawn-ai/ag-ui"` |
| `PlanActivityCard.tsx` | `"./parts.js"` | `"@dawn-ai/ag-ui/react"` |
| `SubagentActivityCard.tsx` | `"./parts.js"` | `"@dawn-ai/ag-ui/react"` |
| `SubagentActivityCard.tsx` | `"./schemas.js"` | `"@dawn-ai/ag-ui/react"` |

`DawnPlanActivityContent` lives on the root entry; `cx`, the `classNames`/`components` types, and `SubagentActivityContentOutput` come from `/react`. The `"./ActivityChecklist.js"` imports need no change — they resolve to the sibling file you copied. After those rewrites the components are yours to change freely.

## Runtime and stability

- `@dawn-ai/ag-ui` is a supported, edge-safe integration surface.
- `@dawn-ai/ag-ui/sse` is a supported, edge-safe integration surface.
- `@dawn-ai/ag-ui/react` is a supported React application surface, built for browser bundles. Dawn records its runtime as `node-only`, which means only that it does not pass Dawn's edge-safety guard — not that it requires Node: React's own JSX runtime reads `process.env.NODE_ENV`, which an application bundler substitutes as usual but the stricter edge guard rejects. The other two entries never load it.
- `@dawn-ai/ag-ui/react/styles.css` is a supported integration surface carrying the cards' default appearance. It is a stylesheet asset, so it has no runtime classification at all: a bundler resolves it and nothing evaluates it as JavaScript. Import it once alongside your global CSS; it is optional, and every rule that styles an element is scoped to the `dawn-activity` prefix (the sheet also declares `--dawn-activity-*` custom properties on `:root`, which is intended and harmless — each of those three blocks is wrapped in `:where()`, so an application's own `:root` override always wins).

They translate protocol data; they do not authenticate callers or make client-provided state authoritative.

Use the [AG-UI API reference](https://dawnai.org/docs/api/ag-ui) for exact contracts. See [AG-UI and Web Clients](https://dawnai.org/docs/ag-ui) for setup and [Agent Protocol](https://dawnai.org/docs/dev-server/agent-protocol) for the underlying runtime endpoints.

## License

MIT
