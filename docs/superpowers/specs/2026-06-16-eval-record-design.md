# `dawn eval --record` Design

**Status:** Approved (design phase) — 2026-06-16
**Phase:** 4, sub-project 1 (eval authoring) fast-follow
**Related:** [eval authoring design](2026-06-06-eval-authoring-design.md)

## Goal

Let users record replayable aimock fixtures from a real-model eval run, so they
can record once and then replay deterministically (CI-safe, no key) with a plain
`dawn eval`. This closes the gap noted when eval authoring shipped: today
fixtures must be hand-authored via `script()` or committed by hand, because there
was no `@dawn-ai/testing` surface to capture response fixtures from the
in-process aimock handle.

## Background: what exists today

- `dawn eval` (in `packages/cli/src/commands/eval.ts`) runs each discovered
  `*.eval.ts` case through `@dawn-ai/testing`'s `createAgentHarness`, scoring via
  `@dawn-ai/evals` `runEval(def, { runCase, baseDir })`. Both packages are
  dynamic-imported from the app root (createRequire pattern) to avoid a build
  cycle.
- Two modes today: **default replay** (each case must supply `case.fixtures`
  inline, else a `CliError` "no fixtures — add script()/fixtures or run with
  --live") and **`--live`** (proxy every call to the real model via
  `startAimock({ proxy, record:{ proxyOnly:true } })`; no capture).
- `@dawn-ai/testing` already has `writeFixtures(path, fixtures|builder)` /
  `loadFixtures(path)` using the on-disk format `{ "fixtures": [ … ] }`, and
  `script()` produces fixtures keyed on `match:{ userMessage, turnIndex,
  hasToolResult }`.
- The aimock journal (`AimockHandle.getRequests()` → `JournalEntry[]`) records,
  per call, the request `body` (`ChatCompletionRequest`) and
  `response:{ status, fixture, source }` where `source:"proxy"` marks a
  real-model call. LLMock supports `record:{ providers, proxyOnly, fixturePath }`;
  with `proxyOnly:false` the recorder also registers recorded fixtures in memory
  (`getFixtures()`).

## Decisions (locked during brainstorming)

1. **Fixture target:** sibling `.fixtures.json` files next to the `.eval.ts`,
   one **per case**: `<evalBasename>.<caseSlug>.fixtures.json` in the eval's
   `baseDir`. `caseSlug` = slugify(`case.name`), or `case-<index>` when unnamed.
   Slug rule: lowercase; non-alphanumeric runs → single `-`; trim leading/
   trailing `-`.
2. **Recording source:** `--record` runs against the **real model** (same
   upstream/proxy path as `--live`); requires `OPENAI_API_KEY`; gated; never CI.
3. **Inline vs recorded precedence (replay):** inline `case.fixtures` >
   sibling file. A case with inline fixtures is never written to a sibling file
   (its `script()` stays authoritative); a case without inline fixtures
   auto-loads its sibling file in replay.
4. **Record runs all cases for scoring.** In `--record`, inline-fixture cases
   replay their inline fixtures deterministically (aimock matches them, no proxy)
   and are scored; non-inline cases hit the real model, are recorded, and are
   scored. All cases count toward the report.
5. **Gate is active during `--record`** (a threshold/gate miss exits nonzero,
   consistent with replay and `--live`) — **but** captured fixtures are flushed
   to disk per-case during the run, *before* the gate verdict, so a gate failure
   never discards recordings.
6. **Extraction seam:** a first-class `@dawn-ai/testing` capability
   `harness.getRecordedFixtures()` (Approach A), which re-keys recorded responses
   with our `{userMessage, turnIndex, hasToolResult}` convention from the journal
   rather than trusting aimock's auto-generated recorder match keys.

## Architecture

`--record` is a third eval mode alongside default-replay and `--live`.

```
dawn eval --record
  ├─ guard: OPENAI_API_KEY present, else CliError (same as --live)
  ├─ loadEvals()                                   (unchanged)
  └─ for each eval:
       createAgentHarness({ appRoot, route, record: true })   // new mode
       runEval(def, { runCase, baseDir }) where runCase(testCase, index):
         ├─ has inline fixtures → harness.run({ input, fixtures: inline })
         │                         (aimock matches inline; deterministic; scored)
         │                         (NOT written to a sibling file)
         └─ no inline fixtures  → harness.run({ input })       // proxies to real model
                                   fx = harness.getRecordedFixtures()
                                   if fx empty → warn + skip write (no empty file)
                                   else writeFixtures(siblingPath, fx)   // BEFORE returning
       → runEval computes report + gate verdict
  → print report; exit nonzero iff gate fails (fixtures already on disk)
```

Replay (`dawn eval`, unchanged invocation) gains one behavior: when a case has
**no inline fixtures**, the runner resolves `siblingPath` and `loadFixtures()` it;
if the file is absent → today's "no fixtures" `CliError`.

## Components

### `@dawn-ai/testing`

- **`aimock-runner.ts`** — `startAimock` gains a record path:
  `record:{ providers:{ openai }, proxyOnly:false }` (vs `--live`'s
  `proxyOnly:true`). No new public LLMock surface required; `getRequests()` is the
  capture source.
- **`harness.ts`** —
  - New option `record?: boolean` on `AgentHarnessOptions`. Implies real upstream
    and the same `OPENAI_API_KEY` guard as `live`. `record` and `live` are
    mutually exclusive (passing both → throw).
  - New `harness.getRecordedFixtures(): FixtureSet`. Returns fixtures for the
    **current case only** — scoped to the calls since the last `run()`/`reset()`
    boundary, not the whole journal (one harness is reused across all of an
    eval's cases, so the journal accumulates; the CLI calls this immediately
    after each case's `run()`). Walks those entries in chronological order; for
    each entry with `response.source === "proxy"` builds:
    - `match.userMessage` = first `user`-role message text in `body.messages`.
    - `match.turnIndex` = 0-based ordinal of this call among **all** calls in the
      current case's thread (proxied and fixture-matched alike), so the recorded
      keys line up with what `script()`/the replay matcher expects.
    - `match.hasToolResult` = `body.messages` contains a `tool`-role message.
    - `response` = the recorded reply mapped to our `AimockResponse`
      (`{content}` for text; `{toolCalls:[{id,name,arguments}]}` for tool calls),
      sourced from the journal entry's recorded response (`response.fixture`),
      falling back to the in-memory `getFixtures()` correlate if the journal does
      not carry the recorded body.
    Returns `AimockFixture[]` ordered by `turnIndex`. Pure transform — no I/O.
- **`fixture-file.ts`** — reuse `writeFixtures`/`loadFixtures` unchanged.
- **barrel** — export nothing new beyond the option/method already on the public
  `AgentHarness` type.

### `@dawn-ai/cli`

- **`commands/eval.ts`** —
  - Add `--record` to the arg parser. Validate: not combinable with `--live`
    (error if both). Reuse the `--live` key guard for the record path.
  - Construct the harness with `{ record: true }` when `--record`.
  - In `runCase`: branch on `Boolean(testCase.fixtures)`. Inline → run with inline
    fixtures (scored, not written). Non-inline → run, `getRecordedFixtures()`,
    write sibling file (fail-fast `CliError` on write failure; warn+skip on empty
    capture).
  - Per-case stdout summary line: `recorded <n> fixtures → <relpath>` /
    `skipped (inline fixtures)` / `recorded 0 calls — skipped write`.
  - Reset the harness thread per case (`h.reset()`) before each `run()` so the
    journal/turnIndex scope is per-case. Confirm whether the existing replay path
    already does this; if not, add it (it is correct for replay too).
- **`lib/runtime/load-evals.ts`** (or the CLI replay branch that builds
  `runCase`) — a shared `siblingFixturePath(evalFile, caseName, index)` helper
  used by both the record-write path and the replay auto-load path, so the
  filename convention has a single source of truth. Replay auto-load: when
  `!testCase.fixtures`, `loadFixtures(siblingPath)` if it exists; else fall
  through to the existing "no fixtures" error.

## Error handling

- `--record` without `OPENAI_API_KEY` → fail-fast `CliError` (mirrors `--live`).
- `--record` + `--live` together → `CliError` ("choose one of --record / --live").
- A non-inline case that produces **zero** proxied calls → log a warning, **do
  not** write a file (an empty fixtures file would mask the gap and break replay).
- `writeFixtures` filesystem failure → `CliError` naming the path; fail fast (a
  half-recorded suite is worse than an obvious stop). The write happens before
  that case's score is returned, so successfully-written earlier cases persist.
- Re-recording overwrites an existing sibling file (intended refresh path).

## Testing

- **`@dawn-ai/testing` unit (`getRecordedFixtures` re-keying):** feed a synthetic
  journal for a one-tool-round case (2 proxied calls) and assert two fixtures
  with `turnIndex` 0/1 and `hasToolResult` false/true, plus correct
  `userMessage` and response mapping (text vs toolCalls). CI-safe, no network.
- **CLI integration (record→replay loop, no real key):** point the harness's
  "real upstream" at a **local aimock** seeded with canned responses (proxy
  target = a local mock server) so `--record` captures deterministic content
  without a live key. Assert sibling files are written with the expected shape,
  then run plain `dawn eval` and assert it replays from them green. Exercises the
  full loop in CI.
- **Gated live smoke (`skipIf(!OPENAI_API_KEY)`, local only):** `--record` a
  one-case eval against the real model; assert a non-empty sibling file; then
  replay it green.
- **Gate-fails-but-fixtures-written:** a `--record` run whose gate fails exits
  nonzero **and** leaves the sibling files on disk (asserts the flush-before-
  verdict ordering).
- **Dogfood:** add a record-style (no-inline-fixtures) case to the chat example's
  eval and commit its recorded sibling fixture; the existing deterministic eval
  CI lane then replays it.

## Out of scope (YAGNI)

- No simultaneous `--record` + `--live`.
- No auto-editing of `.eval.ts` to inline recordings.
- No central `.dawn/` fixture cache (sibling files are committed artifacts).
- No partial/streaming/anonymized capture, no per-scorer record gating knobs.
