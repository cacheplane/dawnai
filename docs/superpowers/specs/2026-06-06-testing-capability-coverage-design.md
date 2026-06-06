# `@dawn-ai/testing` capability coverage + harness extensions (Design)

**Status:** Approved for planning
**Date:** 2026-06-06
**Roadmap:** Follow-on to `@dawn-ai/testing` ([PR #193](https://github.com/cacheplane/dawnai/pull/193)). Extends the package to cover the remaining Phase-3 capabilities (HITL permissions, subagents, planning, skills, AGENTS.md memory) via aimock, and grows the harness with the affordances those scenarios require.

## Problem

`@dawn-ai/testing` shipped with Layer-A in-process coverage of SP5 (union schema), SP6a (offload), and summarization. But five Phase-3 capabilities have **zero** package-based e2e coverage: HITL permissions (interrupt → resume), subagents, planning, skills, and AGENTS.md memory. Those are also the features most likely to regress silently and the ones whose stream/state surfaces (`interrupt`, `subagent.*`, `plan_update`, the composed system prompt) the harness currently **drops** — `collectRunResult` only captures `chunk`/`tool_call`/`done`, `harness.run()` has no resume path, and the system prompt isn't observable. Closing this both protects those capabilities and forces the harness API to grow the right way.

This increment is **Track 1 only** — capability coverage + the harness extensions. Real-model smoke and drift detection are explicitly **out of scope** (deferred to a later increment).

## Verified facts (against the current runtime + aimock 1.28)

- **Runtime stream chunks** (`packages/cli/src/lib/runtime/stream-types.ts`): `{type:"chunk",data}` | `{type:"tool_call",name,input}` | `{type:"tool_result",name,output}` | `{type:"done",output}` | `{type:string,data}` (catch-all for capability events).
- **Interrupt**: emitted as `{type:"interrupt", data:{interruptId, kind, detail}}` (agent-adapter surfaces the capability's interrupt envelope verbatim). The permissions capability's `detail` carries `{command, suggestedPattern}` for bash and path info for path-jail.
- **Resume**: `streamResolvedRoute({ resumeDecision: "once"|"always"|"deny" })` continues a parked thread by forwarding `Command({resume})`; the AP equivalent is `POST /threads/:id/resume {interrupt_id, decision}`.
- **Subagents** (`packages/langchain/src/subagent-dispatcher.ts`): emit `subagent.start` `{call_id, subagent, route_id, depth}`, `subagent.tool_call` `{call_id, tool, input}`, `subagent.tool_result` `{call_id, tool, output}`, `subagent.message` `{call_id, chunk}`, `subagent.end` `{call_id, final_message}` (or `{call_id, error}`), plus `subagent.<capability>` passthrough.
- **Planning** (`packages/core/src/capabilities/built-in/planning.ts`): a stream transformer observes `writeTodos` results and emits `{type:"plan_update", data:{todos:[{content,status}]}}`.
- **System prompt observability**: `LLMock` exposes `getRequests(): JournalEntry[]`; `JournalEntry.body` is the full `ChatCompletionRequest` with `messages: ChatMessage[]`. The `system`-role message text is the exact composed prompt Dawn sent (capability prompt fragments included). No framework change needed to observe it.
- **Probe targets** (`examples/chat/server`): the chat route has `plan.md` (planning), `skills/` (skills), `workspace/AGENTS.md` (memory), and `dawn.config.ts` permissions (allow/deny bash). A `coordinator` route has `subagents/research` + `subagents/summarizer`.
- aimock matches fixtures on the **last user-message substring** (`match.userMessage`) + `turnIndex`/`hasToolResult`, NOT the whole prompt — so running against a real app's richer prompt is not brittle.

## Architecture — harness extensions (the foundation)

All additive and backward-compatible; existing `@dawn-ai/testing` tests are unaffected.

### 1. `collectRunResult` captures the dropped events

The reducer stops discarding capability chunks and folds them into new result fields:

| Stream chunk | New field |
|---|---|
| `interrupt` | `interrupts: InterruptInfo[]` (`{interruptId, kind, detail}`) |
| `plan_update` | `planUpdates: {todos:Todo[]}[]`; convenience `todos` = latest |
| `subagent.*` | `subagentEvents: SubagentEvent[]` (raw) + folded `subagents: SubagentRun[]` |

The subagent fold groups events by `call_id` into one `SubagentRun` per dispatched child: `{ name, callId, toolCalls: {name,args}[], finalMessage?, error? }`.

### 2. `harness.resume({ decision })` — the HITL mechanism

`run()` continues to send a fresh user message. A new sibling continues the **same thread** with a resume decision, driving `streamResolvedRoute({ resumeDecision })`:

```ts
const run = await h.run({ input: "...", fixtures: script().user("...").callsTool("runBash", {...}) })
expectInterrupt(run).ofKind("command")
const resumed = await h.resume({ decision: "once" })   // same thread, replays Command({resume})
expectToolCalled(resumed, "runBash")
```

`resume()` returns a normal `AgentRunResult` for the resumed turn. `decision: "once" | "always" | "deny"`. The harness owns the thread id; callers pass nothing else. Resume re-enters the same in-process stream collection path as `run()`.

### 3. `run.systemPrompt` — composed prompt via the aimock journal

Each `run()`/`resume()` snapshots `mock.getRequests().length` before the turn and slices the journal after, isolating the model requests that turn made. `systemPrompt` = the concatenated text of `system`-role messages from that turn's (last) request body. This is the actual prompt Dawn composed — capability prompt fragments (skills listing, AGENTS.md memory) included. This is what makes skills + memory assertions possible with no framework change.

Implementation note: the harness must read the journal off the live `LLMock` instance — `startAimock` will expose the handle (or a `getRequestsSince(n)` helper) so the harness can correlate per-turn. If journal correlation proves unreliable (e.g. concurrent turns), the fallback is a per-turn marker in the request, but the snapshot-slice approach is expected to suffice for the harness's serial run model.

### 4. Extended `AgentRunResult` (additive)

```ts
interface AgentRunResult {
  // existing
  finalMessage: string; messages: SerializedMessage[]; toolCalls: ObservedToolCall[]
  tokens: string[]; state: Record<string, unknown>; threadId: string
  // new
  interrupts: InterruptInfo[]          // { interruptId: string; kind: string; detail?: unknown }
  planUpdates: { todos: Todo[] }[]     // Todo = { content: string; status: "pending"|"in_progress"|"completed" }
  todos: Todo[]                        // convenience: latest planUpdate's todos (or [])
  subagents: SubagentRun[]             // { name; callId; toolCalls: {name,args}[]; finalMessage?; error? }
  subagentEvents: SubagentEvent[]      // raw { event: string; data: unknown }, for advanced assertions
  systemPrompt: string                 // system text aimock received this turn ("" if none)
}
```

## New matchers

Runner-agnostic, throw `AssertionError` on failure (same style as existing matchers):

```ts
expectInterrupt(run)                       // at least one interrupt was raised (returns the chain)
expectInterrupt(run).ofKind(kind)          // by interrupt kind (e.g. "command")
expectInterrupt(run).withDetail(partial)   // interrupt.detail ⊇ partial (e.g. { command: "rm -rf tmp" })
expectNoInterrupt(run)                     // run.interrupts is empty

expectSubagent(run, name).called()                  // a SubagentRun with this name exists
expectSubagent(run, name).calledTool(toolName)      // …that called this tool
expectSubagent(run, name).finalMessageContains(s)   // …whose final message contains s

expectPlan(run).toHaveTodo(content)                 // a todo with matching content exists
expectPlan(run).toHaveStatus(content, status)       // …with this status
expectPlan(run).toHaveLength(n)                     // latest plan has n todos

expectSystemPrompt(run).toContain(s)
expectSystemPrompt(run).toMatch(re)
```

Skills + memory reuse `expectSystemPrompt` and the existing `expectToolCalled("readSkill")`. No matcher invents data — each reads a Section-1 field. All exported from the package barrel.

## Capability scenarios + probe targets

Primary probe target is the **real example apps** — the truest dogfood (they already wire every capability), and robust because fixtures match on the user-message substring, not the whole prompt. Each scenario runs in-process (Layer A) via the extended harness.

| # | Capability | Probe target | Scripted fixture | Assertions |
|---|---|---|---|---|
| 1 | HITL permissions | `examples/chat` (allow/deny bash seeded) | model → `runBash` with a non-allow-listed command | `expectInterrupt(run).ofKind("command").withDetail({command: ...})`; `h.resume({decision:"once"})` → `expectToolCalled(resumed,"runBash")` + final. Plus a `deny` path (run does not complete the tool) and an allow-listed command → `expectNoInterrupt`. (Exact `detail` shape confirmed against the permissions interrupt envelope during implementation.) |
| 2 | Subagents | `examples/chat` `coordinator` route | parent → `task({subagent:"research", ...})`; child fixture replies | `expectSubagent(run,"research").called()` + `.finalMessageContains(...)`; parent's final synthesizes the child result. |
| 3 | Planning | `examples/chat` (`plan.md`) | model → `writeTodos([...])` then a reply | `expectPlan(run).toHaveTodo(...)` + `.toHaveStatus(...)`; `run.planUpdates` reflects the update. |
| 4 | Skills | `examples/chat` (`skills/`) | model → `readSkill({name})` then a reply | `expectSystemPrompt(run).toContain("# Skills")` + `expectToolCalled(run,"readSkill").withArgs({name})`. |
| 5 | Memory | `examples/chat` (`workspace/AGENTS.md`) | model → a plain reply | `expectSystemPrompt(run).toContain("<known AGENTS.md line>")`. |

Scenarios live in a new test file co-located with the app they exercise (e.g. `examples/chat/server/test/capabilities.e2e.test.ts`) so the dogfood sits next to the example and runs in CI's existing source-test lane.

**Per-scenario fallback:** if a capability is awkward to trigger deterministically against the real example (most likely subagents, if the coordinator's child dispatch is finicky to script via aimock), that one scenario gets a dedicated minimal probe app under `packages/testing/test/fixtures/` instead. This is decided per-scenario during implementation and noted — not pre-built for all five.

## Wiring / CI

- New matchers + `resume()` + result fields ship from `@dawn-ai/testing` (the package's own unit tests cover the new matchers + `collectRunResult` folding with synthetic streams).
- The five capability scenarios run in CI via the lane that already runs the example/package tests (`turbo run test` / the runtime lane). No new CI job.
- A changeset bumps `@dawn-ai/testing` (minor — new matchers + `resume()` + result fields). No other package changes are required (the runtime already emits all needed events; observability is via aimock's journal).

## Error handling / edge cases

- **No interrupt when one is expected** (e.g. command was allow-listed) → `expectInterrupt` throws with the list of interrupts seen (empty). `expectNoInterrupt` is its inverse.
- **Resume without a prior interrupt** → `harness.resume()` surfaces a clear error ("no parked interrupt on this thread") rather than a confusing runtime failure.
- **Subagent event correlation** → fold strictly by `call_id`; an `subagent.end` with `error` populates `SubagentRun.error` so failure cases are assertable.
- **System-prompt journal correlation** → snapshot-slice per turn; if a turn made multiple model requests (tool rounds), `systemPrompt` is taken from the turn's requests (the system text is stable across a turn's rounds). Empty string if no request was made.
- **Backward compatibility** → all result fields are additive; existing tests and matchers are untouched.

## Testing (of the new harness code)

- **Unit (`@dawn-ai/testing`):** `collectRunResult` folds synthetic `interrupt`/`plan_update`/`subagent.*` chunks into the right fields (incl. multi-child subagent fold + error case); each new matcher passes/fails correctly against synthetic `AgentRunResult`s; `systemPrompt` derivation from a synthetic journal entry.
- **Integration (dogfood):** the five capability scenarios above, in-process against the example apps, each with an adversarial false-green check during implementation (break the capability → the scenario fails).

## Out of scope (explicit)

- **Real-model smoke** (`skipIf(!OPENAI_API_KEY)` against the live model) — deferred to a later increment.
- **Drift detection** (scheduled nightly re-record vs live API) — deferred.
- **Browser/UI e2e** of the chat web client — separate effort.
- **`createAgentHarness` http-inject / subprocess mode wiring** — the standalone `injectAgentProtocol`/`startSubprocessApp` primitives remain as-is; this increment is Layer-A capability coverage.
- **Scaffold adoption** (sample test in `create-dawn-app`) — separate follow-up.
