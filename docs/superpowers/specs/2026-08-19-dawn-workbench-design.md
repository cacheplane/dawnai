# Dawn Workbench Design (SP1 of 3)

**Status:** Approved for planning
**Date:** 2026-08-19
**Baseline:** `2fc92f46` (`origin/main` after the AG-UI logical-identity arc, the drop-in renderers, and scaffold signposts)

## Summary

Rebuild `examples/research/web` into the Dawn Workbench: the agent UI that Dawn's
scaffold will later ship. A thread rail, one wide transcript with plan and
subagent activity cards inline, a memory-review panel, starter suggestions, and a
first-run screen — in a crisp neutral design with one warm dawn accent, light and
dark.

Every component is plain, readable `.tsx` that a developer will own outright once
it reaches the scaffold. That is the product decision behind this slice: the
generated app hands over source, not a dependency, so the code has to read like
something a person would be glad to inherit.

This slice ships standalone: Dawn's flagship demo becomes genuinely impressive
before any scaffolding changes. It is also the parity source for SP2, so beauty
gets built and reviewed where iteration is cheapest.

## Context

`create-dawn-ai-app` generates a server and no UI. A newcomer's first impression
is a `curl` command. PR #485 made the CLI at least *say* where a UI lives; this
arc gives them one.

The decision (Brian, 2026-08-19): promote a fully scaffolded, beautiful UI into
the generated app — "it's the first impression after install" — and deliver it as
**full source the user owns**, shadcn-style, rather than a package they import.

That splits into three sub-projects. This spec is the first:

- **SP1 (this spec):** build the workbench as `examples/research/web`.
- **SP2:** scaffold integration — npm workspaces, ports, generation, parity, and
  the generated-app harness.
- **SP3:** browser activation gate — Playwright against deterministic aimock.

SP3 satisfies the prerequisite the activities design named
(`docs/superpowers/specs/2026-08-10-ag-ui-plan-subagent-activities-design.md`,
follow-up 2), but inverted: rather than blocking scaffold work on a gate built
against an example, the gate is built against the workbench we own and then
extended to the scaffold's output.

### What already exists

- `@dawn-ai/ag-ui/react` (PR #484) ships `dawnActivityRenderers` and plain card
  components. It stays published and unchanged — it is the drop-in tier for
  existing apps and non-scaffold clients, and `examples/chat/web` remains its
  in-repo consumer so it keeps a real integration test.
- Root tool events are keyed by the model's tool-call id (PR #481), and
  `writeTodos`/`task` present only as `dawn.plan`/`dawn.subagent` activities
  (PR #483). A client that renders no activities shows nothing for that work.
- `GET /threads/:id/state` returns the checkpointed messages and channel values.
  There is **no thread-list endpoint** — threads can be created and fetched by
  id, not enumerated.

## Goals

1. A workbench that looks like a product a developer would want to have built,
   at first run, with no configuration.
2. Full-source components: readable, self-contained, restyleable, with no
   abstraction a reader must decode before editing.
3. Plan and subagent activity cards rendered inline in the transcript.
4. Threads that can be created, switched, and rehydrated from server state.
5. Memory-candidate review and starter suggestions, showing Dawn capabilities a
   generic chat scaffold does not have.
6. Light and dark, driven by tokens in one file.
7. A component test suite that pins every card's rendering from fixture content.

## Non-goals

- Any change to `packages/` — including `@dawn-ai/ag-ui/react`, which stays as
  the drop-in tier.
- Any server endpoint change. The UI composes what exists.
- Template or `create-dawn-ai-app` changes (SP2).
- Playwright or any browser automation (SP3).
- A thread-list endpoint, or thread enumeration of any kind.
- An artifact/report viewer.
- A component library dependency (shadcn/ui as a package, MUI, Chakra).
- Rehydrating historical subagent cards (see "Threads").

## Architecture

### Stack

Next 16 App Router and React 19, unchanged. **Tailwind v4** joins the example —
new for this package, with precedent in `packages/inspector`. No component
library: components are hand-owned in shadcn *style*. Radix is added only if a
primitive genuinely needs it; the expected answer is nothing, or at most the
memory panel's dialog.

Design tokens live in one `app/theme.css` as CSS variables: a zinc neutral scale,
semantic status colors (running / complete / failed / pending), and the dawn
gradient. Restyling the app is editing that one file. The gradient appears in
exactly two places — the brand mark and the primary send action — so the app
reads as a serious tool that happens to be named Dawn.

### Component inventory

Each is one file with one responsibility, small enough to hold in your head:

| Component | Responsibility |
| --- | --- |
| `AppShell` | Rail + main split, theme provider, connection state |
| `ThreadRail` | Thread list, active thread, new-thread action, memory entry point |
| `Transcript` | Ordered message/activity rendering, autoscroll |
| `Composer` | Input, submit, in-flight state |
| `EmptyState` | First-run screen; suggestions are its center |
| `Suggestions` | Corpus-grounded starter prompts |
| `PlanCard` | `dawn.plan` activity — todos with progress |
| `SubagentCard` | `dawn.subagent` activity — name, depth, status, tool summary |
| `ToolCard` | Generic tool call/result; keeps today's envelope unwrapping |
| `PermissionPrompt` | HITL interrupts: approve/deny, including durable ones |
| `MemoryPanel` | Candidate review — approve/reject |
| `ConnectScreen` | Server unreachable — names the URL and the command |

`ToolCard` inherits the argument/result unwrapping in today's `ToolCallCard`
(double-encoded JSON `input`, LangChain `ToolMessage` envelopes) — that logic is
Dawn-wire-format knowledge worth keeping, not app-specific.

`PermissionPrompt` is rebuilt rather than copied: the current version is 109
lines duplicated byte-for-byte between the two examples.

### Data flow

CopilotKit v2 provides the agent connection exactly as today — `runtimeUrl` →
`/api/copilotkit` → the Dawn AG-UI endpoint. Activities render through
`renderActivityMessages`, registered with the **local** card components. This is
the deliberate consequence of the full-source decision: the workbench does not
import `dawnActivityRenderers`.

Direct server reads go through **one** consolidated same-origin proxy,
`/api/dawn/[...path]`, replacing today's memory-only proxy. It forwards to
`DAWN_SERVER_URL` and is **allowlisted** to exactly the paths the UI uses:

- `GET|POST /memory/candidates*`
- `GET /threads/:id/state`
- `GET /threads/:id/pending_interrupts`

Anything else is rejected. An open proxy in a template every Dawn developer
copies is a liability; the allowlist is the point, not an optimization.

### Threads

The rail's list is **client-side** (localStorage): thread id, a title derived
from the first user message, and last-active time. "New thread" mints a UUID.

Switching a thread sets the CopilotKit thread id and **hydrates** from
`GET /threads/:id/state`: serialized LangChain messages become user / assistant /
tool transcript entries, and the checkpointed `todos` channel re-seeds the plan
card.

**Stated limit, in-app and in the README:** historical *subagent* cards do not
rehydrate. They are derived from a live event stream the server does not persist,
so a restored thread shows past prose, tool results, and the plan — and subagent
cards appear again on the next run. Saying so plainly is better than a card that
silently misses history.

No thread-list endpoint is built. Enumeration is a thread-access authorization
question, and dragging it into a UI slice would be the wrong order.

### Errors and edges

- **Server unreachable** — `ConnectScreen` names the expected `DAWN_SERVER_URL`
  and the command to start the server. This is the likeliest first-run state: a
  developer opens the web app before starting the agent.
- **Pending interrupt on a hydrated thread** — `PermissionPrompt` re-renders from
  `/threads/:id/pending_interrupts`, so a durable HITL prompt survives a reload
  instead of stranding the thread.
- **Malformed activity content** — the local schemas fail closed exactly as the
  package's do: no card rather than arbitrary JSON in the transcript.
- **A run that ends with no assistant text** — the transcript shows the
  terminal state rather than an empty bubble.

## Testing

- **Component tests** return to the example: `react-dom/server` rendering of each
  card from fixture content, in the spirit of the 413-line suite that moved into
  the package in #484. Every card, including failure and edge content.
- **Thread hydration** is unit-tested over a canned `/threads/:id/state` payload:
  messages map to the right transcript entries, `todos` re-seeds the plan, and a
  malformed payload degrades without throwing.
- **Proxy allowlist** is tested directly: permitted paths forward, everything
  else is rejected.
- The example's `vitest.config.ts` — vestigial since #484 — becomes live again.
  Note the trap from that PR: an `include` glob of `test/**/*.test.ts` silently
  collects zero `.tsx` files while exiting 0. Assert the test **count**.
- SP1's bar is "every component renders correctly from fixtures, the proxy is
  closed, and the example builds." Real browser behavior is SP3.

## Rollout

`examples/research/web` is a private workspace package: no changeset, no publish,
no consumer to break. The example's README documents the layout, the token file,
the thread limits, and the two-tier story (this workbench versus
`@dawn-ai/ag-ui/react` for existing apps).

`apps/web/content/docs/recipes/research-web-ui.mdx` currently teaches the
package-import path. It stays accurate for that tier and gains a pointer to the
workbench as the fuller reference — the recipe is not rewritten in this slice.

## Acceptance criteria

1. First run with no thread shows `EmptyState` with working suggestions.
2. A run renders plan and subagent cards inline, updating live.
3. A gated tool renders `PermissionPrompt`; approving resumes the run.
4. Memory candidates can be reviewed and approved or rejected.
5. Threads can be created, switched, and rehydrated; the subagent limit is stated
   in the UI.
6. Light and dark both look deliberate; tokens live in one file.
7. Server-down renders `ConnectScreen`, not a crash or an empty page.
8. The proxy forwards only allowlisted paths.
9. Component and hydration tests pass, and the suite's test count is asserted.
10. `pnpm build`, `pnpm lint`, and the example's own build and tests are green.

## Deferred to SP2 / SP3

- **SP2:** npm-workspace template restructure, ports, `create-dawn-app`
  generation and next-steps, extending the byte-for-byte example↔template parity
  guard to a web tree, and teaching the generated-app harness to build a web
  workspace and boot two processes.
- **SP3:** the Playwright activation gate — click a suggestion, watch the plan
  fill, the subagent run, the permission gate fire, approve, see memory
  candidates — against deterministic aimock, modeled on the inspector's lane.

## Open follow-ups (not this arc)

- Historical subagent rehydration would need the server to persist activity
  state; worth revisiting with `MESSAGES_SNAPSHOT`.
- A thread-list endpoint, once thread-access authorization covers enumeration.
- An artifact/report viewer for `workspace/reports`.
