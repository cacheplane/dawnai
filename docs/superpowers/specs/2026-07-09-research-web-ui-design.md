# Research Demo — Web UI (CopilotKit + AG-UI) Design

**Date:** 2026-07-09
**Status:** Approved (design), pending implementation plan
**Author:** Brian Love (with Claude)
**Base branch:** `blove/zealous-goldberg-ab9dfc` (PR #311 — research demo server). Main is merged in, so the base has `/agui` (shipped) and the `examples/chat/web` CopilotKit client to mirror.

## Summary

Give the flagship research demo (`examples/research`) a polished web client — the
same CopilotKit v2 → Dawn/AG-UI pattern the chat example uses, pointed at the
`/research` route, running **live** (no aimock/demo mode, consistent with the chat
UI decision). It surfaces the research experience: streaming chat + a cited report,
a live plan/todos panel, HITL approve/deny for the external fetch, a **subagent
activity** view, and **memory-candidate approval**.

Two of those need new plumbing beyond the chat pattern, so the work is three slices:

- **Slice A — Research web client foundation.** CopilotKit UI over `/agui/research`:
  chat + report, plan/todos, HITL, and subagent activity. No backend change.
- **Slice B — Memory-candidate HTTP API.** New dev-server endpoints to list/approve
  candidates (none exist today; approval is CLI-only). A small, additive Dawn
  capability, with deterministic tests.
- **Slice C — Memory-candidates panel.** The web UI that lists/approves via B.

## Motivation & Context

- PR #322 made Dawn speak AG-UI (`POST /agui/{routeId}`), and the chat example
  (`examples/chat/web`, on main) is a proven CopilotKit v2 client for it. The
  research demo should get the same treatment so the flagship has a real UI.
- The research `/research` route genuinely produces the rich surface: it dispatches
  a `researcher` subagent via `task(...)`, records todos (`plan.md` planning), gates
  an external fetch behind HITL, and proposes durable memory via `remember()`
  (candidate mode). All of these already flow through the `/agui` translator:
  - subagent dispatch → `CUSTOM{ name: "dawn.subagent.*" }`
    (`packages/langchain/src/subagent-dispatcher.ts` → `packages/ag-ui/src/translate.ts:127`)
  - planning → `STATE_SNAPSHOT{ todos }` (`translate.ts:113`)
  - external-fetch permission → `CUSTOM{ name: "on_interrupt" }` (`translate.ts:122`)
  - report → the final assistant message (cited with `[corpus/…]`)
- Memory candidates are the one gap: `remember()` writes `status:"candidate"` records
  to `<appRoot>/.dawn/memory.sqlite`, and the only approval path is the `dawn memory`
  CLI (`packages/cli/src/commands/memory.ts` → `store.update(id,{status:"active"})`).
  A web UI needs an HTTP surface for that (Slice B).

## Decisions

1. **CopilotKit v2, live, mirroring `examples/chat/web`** — same runtime route +
   `HttpAgent` → `/agui`, same `PermissionInterrupt`, `useAgent`, `<CopilotKit>`/
   `<CopilotSidebar>`. Register the research agent under CopilotKit's default id
   ("default") to avoid the per-component `agentId` fragility we hit on the chat UI.
2. **No demo mode / no aimock in the web client** — canonical live connection.
3. **Subagent activity via `agent.subscribe({ onCustomEvent })`** — filter
   `event.name.startsWith("dawn.subagent.")`. (No CopilotKit hook for raw CUSTOM
   events; `AbstractAgent.subscribe` is the mechanism, confirmed in installed types.)
4. **Memory-candidate API as a new dev-server capability** (Slice B), backed by the
   existing store methods, exactly mirroring the CLI approve semantics (a status
   flip — no supersede/reconciliation, same as `dawn memory approve`).

## Non-Goals

- No aimock/demo mode.
- No rewrite of the research server (`examples/research/server` is unchanged; #311).
- No changes to the `/agui` translator or `@dawn-ai/ag-ui` (shipped).
- Slice B does not add auth to the new endpoints (dev-server, localhost — matches the
  existing unauthenticated dev endpoints). Note it as a dev-only surface.

## Architecture

### Slice A — `examples/research/web` (new package, mirrors `examples/chat/web`)

```
examples/research/web/
  app/
    layout.tsx                  # imports @copilotkit/react-core/v2/styles.css
    page.tsx                    # <CopilotKit> + <CopilotSidebar> + panels
    api/copilotkit/route.ts     # CopilotRuntime + HttpAgent → DAWN/agui/<research>
    components/
      PermissionInterrupt.tsx   # copied from chat/web (external-fetch approve/deny)
      PlanPanel.tsx             # useAgent state.todos (research uses planning)
      SubagentActivity.tsx      # agent.subscribe onCustomEvent → dawn.subagent.*
  package.json, tsconfig.json, next.config.mjs, .env.example, README.md
```

- Runtime route registers the agent as `default`:
  `new HttpAgent({ url: \`${DAWN}/agui/${encodeURIComponent("/research#agent")}\` })`.
- `page.tsx`: `<CopilotSidebar>` (the report is the streamed final message with
  `[corpus/…]` citations) + a left column with `PlanPanel` and `SubagentActivity`.
- `SubagentActivity`: `useAgent()` → `useEffect(() => agent.subscribe({ onCustomEvent:
  ({event}) => { if (event.name.startsWith("dawn.subagent.")) append(event.value) } }).unsubscribe)`.
  Renders a list of dispatched sub-questions (`value.subagent`, `value.call_id`, start/end).
- The example root gains `web` alongside `server`; `examples/research/package.json`
  gets `dev`/`build`/`typecheck` for both (parallel dev like `examples/chat`).

### Slice B — memory-candidate endpoints (`packages/cli`)

Add to `packages/cli/src/lib/dev/runtime-server.ts` `buildRouteTable` (mirroring the
`/agui` addition — additive, existing routes untouched), a new handler
`packages/cli/src/lib/dev/memory-handler.ts`:

- `GET /memory/candidates` → `resolveMemoryStore(appRoot).listCandidates("")` → JSON
  array of `{ id, namespace, content, data, confidence, tags, createdAt }`.
- `POST /memory/candidates/:id/approve` → `store.get(id)`; 404 if missing, 409 if not
  `status:"candidate"`; else `store.update(id,{status:"active",updatedAt})`; return the
  updated record. (Same semantics as `runApprove` in `commands/memory.ts`.)
- `POST /memory/candidates/:id/reject` → `store.delete(id)` → `{ ok: true }`.

`resolveMemoryStore` is already imported in the runtime layer; the store resolves to
`<appRoot>/.dawn/memory.sqlite`, the same DB the route writes candidates to.

### Slice C — `MemoryCandidates.tsx` in `examples/research/web`

- A Next.js API proxy `app/api/memory/[...path]/route.ts` forwarding to
  `${DAWN_SERVER_URL}/memory/...` (same proxy shape the chat web used for its old
  endpoints), so the browser calls same-origin.
- `MemoryCandidates.tsx`: `fetch("/api/memory/candidates")` on mount + after each run
  finishes (subscribe `onRunFinishedEvent`), renders each candidate's `content` with
  **Approve** / **Reject** buttons → `POST /api/memory/candidates/:id/approve|reject`,
  then refetch.

## Data Flow

Browser → CopilotKit runtime (`/api/copilotkit`) → `HttpAgent` → Dawn `/agui/research`
→ live coordinator (plans, dispatches `researcher`, gates the fetch, writes a cited
report, proposes memory) → AG-UI events back:
- text → chat/report; `STATE_SNAPSHOT` → PlanPanel; `CUSTOM{dawn.subagent.*}` →
  SubagentActivity; `CUSTOM{on_interrupt}` → PermissionInterrupt.
Separately, MemoryCandidates polls the new `/memory/candidates` HTTP API (Slice B/C)
and approves via it.

## Error Handling

- **Dawn server down / no key:** same as chat — CopilotKit surfaces the connection
  error / `RUN_ERROR`; README documents the key lives on the server.
- **Memory endpoints:** 404 unknown id, 409 non-candidate (mirrors CLI); malformed →
  400. The panel shows an empty state when there are no candidates.
- **No subagent/plan events:** these are model-dependent (only fire if the model calls
  `task`/records todos); the panels render empty until events arrive — documented.

## Testing

- **Slice A:** `turbo build` + `typecheck` for `@dawn-example/research-web` (workspace
  member). Live smoke (maintainer + browser, which we have): chat reply, report with
  `[corpus/…]`, plan panel fills, a fetch prompt raises approve/deny → approve resumes,
  subagent panel shows a `researcher` dispatch.
- **Slice B:** deterministic vitest in `packages/cli/test` using
  `createRuntimeRequestListener` + a fixture app: seed a candidate (via
  `sqliteMemoryStore`/`seedMemory`), `GET /memory/candidates` returns it,
  `POST …/approve` flips it to active (assert via `store.get`), 404/409 paths. No key.
- **Slice C:** typecheck + the live smoke approves a candidate the run produced.

## Slices / Sequencing

1. **A** — research web client foundation (no backend change). Build + live-verify.
2. **B** — memory-candidate endpoints + tests (TDD, deterministic).
3. **C** — memory-candidates panel using B; live-verify approval.

New PR (`blove/research-web`) stacked on #311; retargets to main after #311 lands.

## Risks & Mitigations

- **Subagent/plan events are model-dependent** — mitigate by prompting clearly and
  documenting that the panels populate only when the model dispatches/plans.
- **Report rendering** — v1 renders the final message (markdown + citations) in the
  sidebar; a dedicated report panel (reading the written `reports/*.md`) is a possible
  follow-up, not this scope.
- **CopilotKit v2 API drift** — pin `@copilotkit/*` to the same version the chat web
  uses; reuse its verified component shapes.
- **Memory endpoints are unauthenticated** — acceptable for the localhost dev server
  (matches existing endpoints); note it, don't add auth here.

## Follow-ups (not this scope)

- Dedicated report panel (render `workspace/reports/<slug>.md`).
- Generative-UI tool cards (`useRenderToolCall`) for corpus search/read.
- `/coordinator` chat UI (separate example follow-up).
- Promote the memory-candidate endpoints into a documented part of the Agent Protocol
  surface if they prove broadly useful.
