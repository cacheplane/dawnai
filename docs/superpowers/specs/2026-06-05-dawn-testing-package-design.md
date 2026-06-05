# `@dawn-ai/testing` — aimock-based agent testing package (Design)

**Status:** Approved for planning
**Date:** 2026-06-05
**Roadmap:** Post-Phase-3 testing infrastructure. Productizes (and dogfoods) the CI-safe aimock e2e approach introduced in [PR #190](https://github.com/cacheplane/dawnai/pull/190), turning a Dawn-internal test lane into a shipped package Dawn users can use to test their own agents.

## Problem

Dawn's current aimock e2e coverage (`test/runtime/run-aimock-e2e.test.ts`) proved its value — a real-model live smoke found a shipped bug in *each* of SP5 and SP6a that unit/integration/CI all missed, and the aimock lane institutionalized those as deterministic, no-key regression tests. But that infrastructure has three problems:

1. **It doesn't scale.** Each `it()` calls `buildProbeApp()`, which runs `pnpm pack` of every workspace package + `pnpm install` + boots a real `dawn dev` server. That is the dominant cost and it repeats per test. Adding scenarios (and the eventual Deep-Agents work) gets linearly more expensive.
2. **It's not reusable and not productized.** The harness is a monolith inside one test file with duplicated `findToolMessage`/`getToolContent`/`runs/wait` boilerplate. Dawn **users** building their own agents have no supported way to write the same kind of deterministic agent test — yet that is exactly the testing story a meta-framework should own (cf. Angular `TestBed`, `@langchain/core/utils/testing`, LangGraph's test docs).
3. **Fixtures are hand-authored and undefended.** No record-first authoring, no strict-replay CI policy, no drift signal — so fixtures are brittle to write and can silently rot when models change.

This design ships `@dawn-ai/testing`: a small, lifecycle-managed package that lets a Dawn user (and Dawn itself) write fast, deterministic, CI-safe agent tests with aimock at the model boundary — and migrates Dawn's own lane onto it as the forcing function.

## Ecosystem grounding (deep research, 2026-06-05)

Two research passes informed this design. Key findings:

- **aimock already ships the hard parts.** `@copilotkit/aimock` provides record/replay (`llmock --record --provider-openai <url>`), multi-turn match keys (`userMessage` substring, `turnIndex`, `hasToolResult`, `toolCallId`, `sequenceIndex`, `predicate`), per-request fixture scoping headers, a `useAimock()` lifecycle plugin, and scheduled drift detection. We wrap it; we do **not** rebuild a VCR layer.
- **Determinism comes from the fixture, never the live model.** `temperature=0` + `seed` is only "mostly" deterministic (weight refreshes, GPU batch float nondeterminism). Replaying a recorded fixture is the only stable basis for exact assertions — which is legitimate precisely because the response is canned.
- **With aimock, "in-process" does not mean "in-process model."** The app's OpenAI SDK still points at `OPENAI_BASE_URL=aimock` and makes a real HTTP call, so in-process tests still exercise SDK serialization, SSE parsing of the model stream, and `tool_call` wire decoding. The *only* thing in-process skips is Dawn's **own outbound** HTTP server + client-facing SSE encoding — which is Dawn's code, not the user's.
- **Every comparable framework defaults to a fast in-process layer with a thin e2e top** (LangGraph's own test docs invoke the compiled graph in-process with a per-test checkpointer; Angular `TestBed`; Next + Vitest/RTL; tRPC `createCaller`; Fastify `inject`). Subprocess-dev-server e2e is the documented slow/flaky tier (boot timeouts, port races, TIME_WAIT).
- **In-process HTTP injection (`light-my-request`) is the middle path** for covering an outbound HTTP/SSE pipeline without binding a port — Fastify ships it as the recommended default. It supports streaming via `payloadAsStream` (manual chunk reassembly). `supertest` is unsuitable for SSE (it hangs on late `res.end()`).
- **CI must treat fixtures as read-only** (jest `--ci` semantics): missing fixture → fail, never silent-write; re-record is an explicit local gate (`-u`-style). Add a `git diff --exit-code` guard because snapshot tools have bugs that write when they shouldn't.
- **Assertion tiers:** structural/exact assertions over replayed fixtures gate every PR; LLM-as-judge is nightly-only. Pin volatile fields (`id`, `tool_call_id`, `system_fingerprint`, `usage`) to fixed values for byte-stable downstream assertions.

## Architecture — three layers, one package, each owned by the party whose code it covers

| Layer | What runs | Audience | Catches |
|---|---|---|---|
| **A. In-process runtime** (default) | The user's route via Dawn's `streamResolvedRoute`, aimock at the model wire, a fresh checkpointer per run | **Dawn users** (95% of usage) | tool selection, tool-arg schema generation, multi-turn state/checkpoint, streamed model tokens, offload, summarization, permissions interrupts |
| **B. In-process HTTP injection** (`light-my-request`, no port) | The full Agent-Protocol request → SSE pipeline | **Dawn itself** (dogfood) | SSE envelope encoding, AP endpoint wiring, interrupt→SSE propagation |
| **C. Subprocess smoke** (thin) | A real `dawn dev` process + persistent SQLite saver | **Dawn itself**, sparingly | resume-after-restart across genuine process death |

Layer A is the product and the bulk of the value. Layer B replaces today's expensive pack+install-per-test for Dawn's own wire coverage. Layer C keeps only the SP7 restart-resume scenario, which genuinely needs a fresh process.

Rationale for the split: Dawn's own value proposition is that it *owns the HTTP/SSE layer so users don't write it*. Therefore the user-facing package defaults to in-process (covers the user's code — tools/prompts/capabilities/state), and Dawn covers its own outbound wire with Layers B/C in its internal suite. This puts each test layer with the party that owns the code it exercises, without pushing subprocess flakiness onto every user.

## Public API (Layer A — the user-facing surface)

The package exposes a tiny, lifecycle-managed surface. It **hides** port allocation, `OPENAI_BASE_URL` patching (which must happen *before* the model client is constructed), typegen + server + aimock lifecycle, and fixture serialization. It **exposes** exactly three things: a harness, a fixture builder, and assertion matchers.

```ts
import { createAgentHarness, script, expectToolCalled, expectFinalMessage, expectState } from "@dawn-ai/testing"
import { afterAll, it } from "vitest"

const h = await createAgentHarness({
  appRoot: new URL("..", import.meta.url).pathname, // the user's Dawn app root
  route: "/chat#agent",
})
afterAll(() => h.close())

it("filters open items newest-first", async () => {
  const run = await h.run({
    input: "Filter open urgent items, newest first.",
    fixtures: script()
      .user("Filter open urgent items, newest first.")
      .callsTool("applyFilter", { filter: { status: "open" } })
      .replies("Found 2 matching items."),
  })

  expectToolCalled(run, "applyFilter").withArgs({ filter: { status: "open" } })
  expectFinalMessage(run).toContain("Found 2")
  expectState(run).messages.toHaveLength(4)
})
```

### `createAgentHarness(options)` → `AgentHarness`

- **options:** `{ appRoot: string; route: string; fixtures?: FixtureSet; mode?: "in-process" | "http-inject" | "subprocess" }`. `mode` defaults to `"in-process"` (Layer A). The harness loads the app's real `dawn.config.ts` from `appRoot` (so summarization/permissions/offload behave exactly as in production); there is no parallel config-override surface in the initial release — to test a different config, point `appRoot` at a fixture app that has it.
- **On construction:** boots aimock (`port: 0`), runs `runTypegen` **once** for the app (so generated tool schemas exist — gives in-process the same fidelity as a `dawn dev` boot), sets `OPENAI_BASE_URL`/`OPENAI_API_KEY` before any model client is built, and resolves a fresh checkpointer.
- **Returns** a harness with `run()`, `reset()`, and `close()`.
- **Thread persistence:** the harness owns one AP thread by default so repeated `run()` calls form a multi-turn conversation against real persisted state. `reset()` starts a fresh thread (and fresh checkpointer) for isolation; `close()` tears down aimock + any spawned resources, idempotently.

### `harness.run({ input, fixtures? })` → `AgentRunResult`

Posts `input` as a user message to the harness thread, registering `fixtures` for the turn (or relying on the harness-level `fixtures` registered at construction, matched by user-message substring). Drives the run via `streamResolvedRoute` (Layer A) and collects results.

`AgentRunResult` = `{ finalMessage: string; messages: SerializedMessage[]; toolCalls: { name; args; id }[]; tokens: string[]; state: Record<string, unknown>; threadId: string }`.

### `script()` → fixture builder

Scripts **only the model's side** of a turn (the user's real tools execute for real — testing the user's tools is the point). Erases manual `turnIndex`/`hasToolResult` bookkeeping and pins `tool_call_id`s for determinism.

- `.user(text)` — declares the user message that matches this turn (the `userMessage` discriminator).
- `.callsTool(name, args, opts?)` — the model responds with a tool call → an aimock fixture with `response.toolCalls` at the correct auto-assigned `turnIndex`, with a fixed `tool_call_id` (auto-generated stable id unless `opts.id` is given).
- `.replies(content)` — the model responds with content → an aimock fixture at the next `turnIndex` with `hasToolResult: true` when it follows tool calls.
- `.build()` → a `FixtureSet` (the array aimock's `addFixturesFromJSON` consumes). Can also be serialized to a committed `*.fixture.json` and re-loaded.
- **Tool stubbing (opt-in):** `stubTool(name, (args) => result)` on the harness for tools with real side effects (DB/network). Off by default; the common case runs real tools.

Multi-user-turn conversations are expressed as repeated `harness.run()` calls (each turn's fixtures match by user-message substring), not one giant fixture — matching aimock's matcher and keeping PR diffs reviewable.

### Assertion matchers

Thin, runner-agnostic functions over `AgentRunResult` (they throw `AssertionError` on failure, so they work under vitest/jest/node:test). They replace the duplicated message-parsing helpers in today's tests.

- `expectToolCalled(run, name)` → `.withArgs(partial)` / `.times(n)` / `.never()`
- `expectFinalMessage(run)` → `.toContain(s)` / `.toMatch(re)` / `.toEqual(s)`
- `expectStreamedTokens(run)` → asserts ≥1 token streamed (Layer A sees the model SSE)
- `expectState(run)` → `.messages.toHaveLength(n)` / `.field(name).toBeTruthy()/.toEqual(v)`
- `expectOffloaded(run, toolName)` — Dawn-specific: the tool's output was offloaded to a retrievable stub (6a)

**Initial-release non-goals (research anti-patterns):** no LLM-as-judge / semantic matchers in the gating suite (nightly-only territory); no exact-matching on full prompt bodies in fixture match rules (match the minimal discriminator).

## Fixtures, record-mode, drift & CI policy

- **Authoring is record-first, hand-trim-after.** Ship a thin `record()` helper (and a documented `dawn`-adjacent recipe) wrapping aimock's recorder (`llmock --record --provider-openai https://api.openai.com`) to capture a real interaction into a `*.fixture.json`, which the developer trims. Requires a real key; **local only**.
- **CI replays strict and read-only** (jest `--ci` semantics): a missing/unseen fixture → **fail**, never silent-write. Re-recording is an explicit local gate (a `RECORD=1` env / `--record` flag), never in CI.
- **Belt-and-suspenders:** the CI lane runs `git diff --exit-code` over the fixtures directory, because snapshot tools have documented bugs that write when they shouldn't — don't trust the tool to stay read-only.
- **Determinism hygiene:** the fixture builder and `record()` normalization pin volatile fields (`id`, `tool_call_id`, `system_fingerprint`, `usage`) to fixed values so downstream assertions and offload filenames are byte-stable.
- **Drift detection (deferred to a follow-up release).** A scheduled (nightly) workflow re-records committed fixtures against the live API and flags divergence (model/provider wire changes), decoupled from PR gating so PRs stay fast and non-flaky. The initial release leaves the hook (a documented `record()`-based comparison) but does not build the workflow.

## Framework seams (small additions to existing Dawn packages)

All confirmed feasible against the current runtime:

1. **Surface programmatic runtime entries.** Export `streamResolvedRoute`, `executeResolvedRoute`, and `runTypegen` from `@dawn-ai/cli`'s public entry (they already exist in `execute-route.ts` / `run-typegen.ts`; only the package export is missing).
2. **Extract an injectable request listener.** Refactor `startRuntimeServer` (`packages/cli/src/lib/dev/runtime-server.ts`) so the inline `createServer(async (req,res) => …)` closure becomes a named `createRuntimeRequestListener(opts): (req, res) => void`, with `startRuntimeServer` wrapping it + `listen`. This is what Layer B's `light-my-request` injection drives. Pure refactor — no behavior change to the running server.
3. **A `prepareTestApp()` helper** (in `@dawn-ai/testing`) that runs `runTypegen` once + resolves the checkpointer, giving Layer A dev-boot fidelity without a server.

## Packaging

- New workspace package **`@dawn-ai/testing`** (test-only; never in a prod bundle).
- `peerDependencies`: `@dawn-ai/cli`, `@dawn-ai/langchain` (the user already depends on these). `dependencies`: `@copilotkit/aimock`. `light-my-request` for Layer B.
- Standalone package (not a subpath of an existing package), since it pulls in aimock and is install-time-optional.
- Public exports: `createAgentHarness`, `script`, `record`, and the `expect*` matchers + their result/fixture types.
- **Versioning:** this is not framed as a "1.0" — the package is versioned via changesets alongside the rest of the `@dawn-ai/*` packages (its initial published version follows the workspace's normal changeset flow, e.g. a `0.x` line like the other packages, not a fresh `1.0.0`).
- Engines/build/lint/test config mirrors the other `@dawn-ai/*` packages.

## Dogfood migration (the forcing function)

Migrating Dawn's own lane proves the package and removes the pack+install-per-test cost:

- **Port SP5-union, SP6a-offload (retrieve + fallback), and summarization** scenarios from `test/runtime/run-aimock-e2e.test.ts` to **Layer A** using `@dawn-ai/testing` — deleting `buildProbeApp`'s per-test `pnpm pack` + `pnpm install` + `dawn dev` boot. The probe app becomes a small committed fixture app the harness runs in-process. (The SP5 assertion on generated `tools.json` shape is preserved because `prepareTestApp()` runs `runTypegen`.)
- **Keep AP/SSE-envelope coverage** (the boot smoke + any wire-shape assertions) as **Layer B** injection tests.
- **Migrate the SP7 interrupt→restart→resume** scenario onto the package's **Layer C** (`mode: "subprocess"`) — it becomes the one consumer of the shipped subprocess mode, proving that mode end-to-end rather than living as bespoke test-only orchestration.
- Update `test/runtime/vitest.config.ts` includes accordingly.

## Error handling / edge cases

- **Missing fixture for a turn** → aimock strict mode rejects; the harness surfaces a clear error naming the unmatched user message + turn index (not a hang).
- **Model client constructed before env patch** → prevented by `createAgentHarness` setting env and running typegen before first `run()`, and by building the agent lazily per run (Dawn already materializes the agent at execution time, not module load).
- **Thread/state bleed between tests** → fresh checkpointer per harness; `reset()` for a clean thread within a harness; `close()` idempotent.
- **Port races** → aimock `port: 0` (OS-assigned); Layer B binds no port at all; Layer C uses an OS-assigned port.
- **`runTypegen` failure** (bad app) → surfaced from `createAgentHarness` construction with the typegen error, not a downstream mismatch.

## Testing (of the package itself)

- **Unit:** `script()` builder compiles to the expected aimock fixture JSON (turnIndex/hasToolResult/fixed-ids); each `expect*` matcher passes/fails correctly against synthetic `AgentRunResult`s; `record()` invokes the aimock recorder with the right argv (mocked spawn).
- **Integration (dogfood):** the migrated Layer A scenarios (SP5/SP6a/summarization) pass against a committed fixture app, with no `pnpm install`.
- **Layer B:** a `light-my-request` injection test asserts an AP `runs/stream` SSE envelope shape without binding a port.
- **Layer C:** the single restart-resume subprocess smoke.

## Out of scope

- **Drift-detection workflow** (the scheduled live-API nightly compare) — follow-up release; the initial release ships only the `record()` hook.
- **LLM-as-judge / semantic assertions** — nightly/eval territory, not the gating package.
- **Non-OpenAI provider mocking** beyond what aimock already supports out of the box.
- **A bespoke VCR/replay engine** — aimock is the engine; this package is the ergonomic + integration layer.
- **Browser/DOM e2e** (the angular-agent-framework uses Playwright because it tests an Angular UI; Dawn ships a headless agent runtime, so the assertion surface is the Agent Protocol + runtime result, not the DOM).
