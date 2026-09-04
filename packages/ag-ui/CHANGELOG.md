# @dawn-ai/ag-ui

## 0.8.23

### Patch Changes

- 21654e8: Align the CopilotKit v2 examples, research scaffold, and Dawn AG-UI runtime on CopilotKit 1.70 and AG-UI 0.0.59.
- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.

## 0.8.22

### Patch Changes

- 78ab2d7: Give the plan and subagent activity cards Dawn's visual identity, plus a
  customization ladder. Import `@dawn-ai/ag-ui/react/styles.css` for the default
  look in light and dark; override CSS custom properties to restyle; pass
  `classNames` to layer your own classes onto any part; pass `components` to
  replace a todo or tool row outright. Cards render structured-but-unstyled when
  the stylesheet is not imported, and every rule that styles an element is
  scoped so the sheet cannot affect the rest of your app.

  The stylesheet is the only styling the cards carry, so importing it is the
  difference between the default look and bare markup.

- 95abcf5: Expose Dawn planning and subagent progress as bounded standard AG-UI activity
  snapshots. The research web example renders plan checklists and delegated-work
  status from those snapshots, which exclude child prose, prompts, tool inputs,
  tool outputs, and final child answers. The generated research starter renders these
  activities in the web client it ships.
- 77bf84e: Close six gaps in the activity cards' customization ladder. The default
  appearance is unchanged.

  Rung 1 gains four custom properties — `--dawn-activity-margin`,
  `--dawn-activity-padding`, `--dawn-activity-header-weight`, and
  `--dawn-activity-badge-bg` — so the card's box spacing, the header's weight, and
  the depth badge's background are reachable without ejecting. `--dawn-activity-badge-bg`
  defaults to `var(--dawn-activity-border)`, so the badge keeps following the
  palette until it is pointed elsewhere. All three of the sheet's token blocks are
  now wrapped in `:where()`: they carry no specificity, so an application's own
  `:root` override wins in dark mode and under `data-dawn-theme`, not only in
  light. Overriding a token used to require a doubled `:root` selector to beat the
  package's own dark palettes.

  Rung 2 gains two `classNames` keys. `checklist` targets `ActivityChecklist`'s
  wrapper, and `marker` targets the disclosure triangle, which is now a real
  `aria-hidden` span instead of a `::before` — so it can be restyled, and its glyph
  no longer lands in the summary's accessible name.

  Four details worth knowing about the resulting surface:

  - `classNames.section` targets a card's labelled region only, so it is inert on
    `PlanActivityCard` and on a standalone `ActivityChecklist`. Use
    `classNames.checklist` for the checklist wrapper. Keeping them separate means
    one key cannot land on two nested elements and draw a box twice.
  - The disclosure marker is `.dawn-activity__marker` and the checklist wrapper is
    `.dawn-activity__checklist`.
  - Because the marker is a real element rather than generated content, its glyph
    is part of a `<summary>`'s `textContent`. Text assertions over a card header
    should expect it.
  - A partial `:root` palette override applies in dark mode and under
    `data-dawn-theme`, not only in light. Set palette tokens as a set, or point
    them at values that are themselves theme-aware, so a half-overridden palette
    does not mix with the package's.

  `classNames` entries are appended to the package defaults and never
  substituted, but the stylesheet is unlayered, so an appended class only takes
  effect on a property the sheet leaves unset on that element. The README says
  which properties those are and which remain rung-4 work.

- 9d347c8: Ship the plan and subagent activity renderers as `@dawn-ai/ag-ui/react`. A
  CopilotKit client can now render Dawn's built-in orchestration by passing
  `dawnActivityRenderers` to `renderActivityMessages`, instead of copying React
  components out of an example. The card components, the content schemas, and
  the parsed subagent content type are exported too, for clients that want their
  own presentation. React and `@copilotkit/react-core` are optional peer
  dependencies, so server-only consumers install nothing extra.
- 6488d32: Align the rxjs devDependency with the one `@ag-ui/client` actually uses.

  `@ag-ui/client` and its middleware siblings pin rxjs to exactly `7.8.1`, while
  this package's test-only devDependency asked for `7.8.2`. Two copies of rxjs
  meant two nominally distinct `Observable` declarations, so a test consuming a
  stream produced by `@ag-ui/client` could not describe it in types. rxjs is used
  only by the conformance test here; matching the version the objects come from is
  the point of the pin.

- a530e70: Documentation only: this package gains a canonical API reference on dawnai.org
  and a concise npm entrypoint. No runtime behavior changed. (`dawn docs` also
  now discovers every registered detailed API page.)
- 908d690: Carry the model's tool-call ID from a tool execution into the capability
  stream: `StreamTransformerInput` gains an optional `toolCallId`, and the
  planning capability echoes it as `tool_call_id` on `plan_update`. Child
  capability events keep their subagent's tool-call ID internal. This is the
  correlation plumbing behind presenting built-in orchestration work once; the
  presentation change that consumes it ships in this same release.
- 8e83609: Present each built-in orchestration action once. A `writeTodos` call whose plan
  activity was emitted, and a `task` call whose subagent activity was emitted, no
  longer also produce generic tool-call events, so activity-aware AG-UI clients
  stop showing a duplicate card for the same work. Every other tool is unchanged,
  and the generic events return as a fallback whenever the activity cannot be
  produced. An interrupt now also carries the tool-call ID it belongs to, taken
  from the Dawn envelope's call ID.

## 0.8.21

## 0.8.20

## 0.8.19

## 0.8.18

### Patch Changes

- c6b08a9: Add keyed, parent-owned subagent delegation policies with fail-closed
  constraints and approval. Subagents now run as native resumable LangGraph
  subgraphs, and interrupt resume uses one complete multi-entry request envelope.

  This intentionally removes array-form subagent registration, tool policy on
  the internal `task` mechanism, and scalar interrupt resume. Confirm the fixed
  0.x patch release intent with Brian before release.

## 0.8.17

## 0.8.16

### Patch Changes

- 2da55fa: Require Node 24 (the active LTS) everywhere. npm 10 — bundled with Node 22 —
  cannot install Dawn's scaffold dependency graph (its resolver crashes), while
  Node 24's bundled npm ≥ 11 installs it correctly and ships `node:sqlite`
  unflagged. All packages now declare `engines.node >= 24`, `create-dawn-ai-app`
  refuses to scaffold on older Node with an actionable message, `dawn verify`'s
  runtime preflight enforces the same floor, and the `dawn build` node target
  uses a `node:24-slim` base. Scaffolded apps also no longer declare
  `@dawn-ai/core` as a direct dependency — nothing in a generated app imports it
  (it arrives transitively via the CLI and SDK).

## 0.8.15

## 0.8.14

## 0.8.13

### Patch Changes

- 20f0407: Consolidate the existing `@dawn-ai/ag-ui` package as Dawn's pure canonical AG-UI
  adapter. Its root API now maps standard `RunAgentInput` requests and Dawn stream
  chunks, including standard interrupt outcomes and addressed resume decisions,
  while the focused `@dawn-ai/ag-ui/sse` subpath provides event-stream encoding
  without taking ownership of a server or runtime transport.

  The CLI AG-UI endpoint now uses the canonical adapter, applies the same request
  projection as other runtime middleware, and emits canonical events without the
  former custom state event shapes. Pending checkpoint interrupts are resolved
  through the standard resume contract.

  The langchain adapter surfaces each tool invocation's `run_id` on its
  `tool_call` and `tool_result` chunks, and the CLI preserves those IDs through
  Dawn and AG-UI streams for reliable `toolCallId` correlation. Local in-process
  `dawn run` also assigns agent routes a one-shot thread ID so the default SQLite
  checkpointer can execute the same route shape supported by `dawn dev`.

## 0.8.12

## 0.8.11

### Patch Changes

- f0261f1: Add `@dawn-ai/ag-ui`: translate Dawn's runtime stream to the AG-UI protocol and
  serve it at `POST /agui/{routeId}`, so CopilotKit and other AG-UI clients can
  drive Dawn agents. Additive — the existing Agent-Protocol endpoints are unchanged.
