# Deterministic Agent E2E Testing with aimock (Design)

**Status:** Approved for planning
**Date:** 2026-06-03
**Motivation:** A live-API smoke of Phase 3 found a shipped bug in each of SP5 (discriminated-union tool params rejected) and SP6a (offloaded outputs unretrievable). Both were invisible to unit/integration/CI tests because no test exercised the real agent loop against a model. This initiative institutionalizes that smoke as a **deterministic, CI-safe, no-real-key** regression guard.

## Problem

Two gaps:

1. **No deterministic e2e of the real agent loop.** Existing coverage is either pure unit (no model, no dispatch) or live-model (`skipIf(!OPENAI_API_KEY)`, which **skips in CI** — Dawn's CI has no OpenAI key). The two shipped bugs lived precisely in the loop + tool-dispatch path that neither tier exercises in CI.

2. **Dynamic runtime values defeat static replay.** The natural deterministic approach — replay canned model responses via a local OpenAI-compatible mock (aimock) — cannot express a turn whose tool-call args depend on a value *generated at runtime in a prior turn*. The motivating case: an offloaded tool output is saved to `tool-outputs/<name>-<timestamp>-<rand>.txt`, and the agent must call `readFile(<that path>)` to retrieve it — but a static fixture cannot know the timestamp/rand chosen at runtime. The same shape recurs across Dawn (thread ids, interrupt ids, subagent task ids, checkpoint ids).

## Goal

A deterministic, replay-only agent e2e harness that runs in CI with no real API key, plus two committed-fixture regression scenarios covering the SP5 and SP6a bug classes. Achieve this by (a) removing the offload path's runtime nondeterminism *as a product improvement*, and (b) adopting the proven `@copilotkit/aimock` harness already used in the sibling `angular-agent-framework` project.

This spec couples two deliverables that ship together:
- **A. Deterministic offload filenames** (product change).
- **B. aimock harness adoption + two regression scenarios** (test infra).

They are coupled because B's SP6a scenario is only expressible once A makes the offload path reproducible.

---

## Part A — Deterministic offload filenames

**Current behavior:** `OffloadStore.write(toolName, content)` names files `tool-outputs/<toolName>-<unixMs>-<rand>.txt`. The timestamp+rand guarantees uniqueness but is nondeterministic and unknowable to a test author.

**New scheme** (`buildOffloadFileName(toolName, content, toolCallId?)`):
- **Primary** — when a tool_call_id is present: `tool-outputs/<sanitized-toolName>-<sanitized-toolCallId>.txt`. Unique in production (model-generated tool_call_ids don't collide); reproducible in replay because the fixture authors the tool_call_id.
- **Fallback** — when tool_call_id is null/empty (some providers/streaming paths omit it): `tool-outputs/<sanitized-toolName>-<contentHash>.txt`, where `contentHash` = first 16 hex chars of `SHA-256(content)`. Deterministic, reproducible, collision-safe, and still fixture-knowable (the author controls the tool's output, so can compute the hash). Identical content → same filename (idempotent overwrite), which is acceptable.
- **Sanitization:** both `toolName` and `toolCallId` are reduced to `[A-Za-z0-9._-]`, other chars → `_`, to stay filesystem-safe.

**Plumbing:** the offload callback currently receives only `(content, toolName)`. `convertToolToLangChain` already computes `extractToolCallId(config)` (used for the Command path), so:
- Extend `OffloadFn` to `(content: string, toolName: string, toolCallId?: string) => Promise<string>`.
- `convertToolToLangChain` passes the extracted tool_call_id on both the plain and `{result,state}` paths.
- `offloadToolOutput`'s ctx gains `toolCallId?`; it forwards to `store.write`, which uses `buildOffloadFileName`.
- The `buildOffload` exemption closure (from the #189 fix) passes the third arg through unchanged.

**Orthogonality:** only the filename changes. `mtime`-on-write, LRU-touch-on-read, and the size+TTL GC are all unaffected — eviction still sorts by `mtime`. No behavior change to the cap.

**Migration:** none needed. `tool-outputs/` is gitignored runtime state; old `timestamp-rand` files (if any) age out via the existing TTL/size GC.

**Unit tests:** `buildOffloadFileName` — primary (with id), fallback (null id → content hash), sanitization of unsafe chars, identical-content stability, distinct content → distinct hash.

---

## Part B — aimock harness + regression scenarios

### B1. Adopt aimock

- Add `@copilotkit/aimock` as a dev dependency (test/tooling only).
- Port a minimal `startAimock({ fixturePath })` into `test/runtime/support/aimock-runner.ts`, mirroring the angular-agent-framework helper: `new LLMock({ port: 0, chunkSize: 4096 })`, `addFixturesFromJSON(entries)`, expose `baseUrl = ${mock.url}/v1` and `stop()`. Fixtures load from a file or directory of `{ "fixtures": [...] }` JSON.

### B2. Wire dawn dev at the mock

The runtime test starts aimock, then starts `dawn dev` (via the existing `startDevServer({ env })` helper) with:
```
OPENAI_BASE_URL = <aimock baseUrl>
OPENAI_API_KEY  = "test-not-used"
```
**Verify-step / risk:** Dawn builds its chat model via `createChatModel` (`@langchain/openai` `ChatOpenAI`). Confirm it honors `OPENAI_BASE_URL`. If `ChatOpenAI` only reads `configuration.baseURL` and not the env var, add a small wiring fix in `createChatModel` to read `process.env.OPENAI_BASE_URL` into `configuration.baseURL`. This is the one production-touching risk in Part B and must be settled in the plan.

### B3. Probe tools (committed in a test fixture app or the chat example)

- `applyFilter(input: { filter: { status: "open"|"closed"; tags: string[] }; pagination?: {...}; labels?: Record<string,string>; sort: { by: "date"; dir: "asc"|"desc" } | { by: "name" } })` → echoes input back. Exercises nested object + array + enum + optional + Record + **object union** (the SP5 class).
- `generateReport(input: { rows: number })` → returns a deterministic multi-thousand-line string (> 40k chars) with a unique token (`MARKER-DEEP-INSIDE-NEEDLE-42`) at the very end, beyond any preview.

### B4. Scenario 1 — SP5 union tool-call (static fixture)

Fixture: match the user message → respond with a `tool_call` to `applyFilter` carrying `sort: { by: "date", dir: "desc" }` (plus the other nested fields); then a follow-up turn (match `hasToolResult`) returns a short text answer. Assertions:
- The `applyFilter` ToolMessage is **not** a schema-rejection ("did not match expected schema" / "Invalid input").
- The echoed result equals the replayed args (the generated Zod schema accepted the real-wire nested-union arg).

This catches the SP5 class: the generated JSON-Schema→Zod for an object union must accept a correct discriminated-union argument.

### B5. Scenario 2 — SP6a offload retrieve-back (static fixture, enabled by Part A)

Fixture turns:
1. match user message → `tool_call generateReport({ rows: 2000 })` with a **fixture-authored tool_call_id** (e.g. `call_gen_report_1`).
2. match `hasToolResult` / `turnIndex` → `tool_call readFile({ path: "tool-outputs/generateReport-call_gen_report_1.txt" })` — the path is **deterministic from Part A** (primary scheme keyed on the fixture's tool_call_id).
3. match next `hasToolResult` → short text answer.

Assertions:
- `generateReport`'s ToolMessage is an **offload stub** (content offloaded; > 40k threshold).
- the offloaded file exists at the expected deterministic path.
- `readFile`'s ToolMessage is the **full content** (not a second stub) and **contains the needle** `MARKER-DEEP-INSIDE-NEEDLE-42` (proving full retrieval; the needle lives past any preview).

This catches the SP6a class (retrieval re-offload) end-to-end through the real loop.

### B5a. Fallback coverage

One additional fixture variant (or unit-level assertion) exercises the **content-hash fallback**: a `generateReport` call whose replayed tool message omits the tool_call_id, with the follow-up `readFile` targeting `tool-outputs/generateReport-<sha256-prefix>.txt` computed from the known fixture output — asserting retrieval still works when no id is present.

### B6. CI placement

The aimock scenarios run in the existing runtime lane (`pnpm verify:harness:runtime` / `test/runtime/`), which is `fileParallelism: false` (set during SP6a). They require **no** `OPENAI_API_KEY` and **no** network (aimock is local), so they run unconditionally in CI — unlike the existing `skipIf(!OPENAI_API_KEY)` live test, which remains as an optional real-provider check.

---

## Out of scope

- aimock **record mode** (`proxyAndRecord`) — replay-only with hand-authored fixtures for now; recording can come later if fixture authorship becomes burdensome.
- Migrating the existing live `skipIf` SP7 test to aimock — it stays as a real-provider smoke.
- A general model-injection seam in the agent-adapter (the env-based `OPENAI_BASE_URL` approach needs none).
- 6b conversation summarization; the cosmetic offload preview-1-line issue.
- Programmable/dynamic mock responses — Part A removes the need by making paths deterministic.

## Testing

- **Unit:** `buildOffloadFileName` (primary/fallback/sanitization/stability) in `@dawn-ai/langchain`.
- **Harness unit:** `startAimock` starts, serves a `/v1` base URL, replays a trivial fixture, and stops cleanly.
- **Integration (runtime lane, CI, no key):** Scenario 1 (SP5 union) and Scenario 2 (SP6a retrieve-back) + the B5a fallback variant, each driving real `dawn dev` against aimock and asserting as above.
- **Regression safety:** the deterministic-filename change must not break the existing offload unit/integration tests (update any that assert the old `timestamp-rand` name shape).
