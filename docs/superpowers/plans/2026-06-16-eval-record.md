# `dawn eval --record` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `dawn eval --record` — run an eval suite against the real model, capture each non-inline case's LLM traffic into a per-case sibling `.fixtures.json`, and auto-replay those files on a plain `dawn eval`.

**Architecture:** A pure re-keying transform (`recordingsToFixtures`) converts captured request/response pairs into our `{userMessage,turnIndex,hasToolResult}`-keyed `FixtureSet`. A thin `extractRecordings` seam pulls those pairs out of the aimock journal. The `@dawn-ai/testing` harness gains a `record` mode (proxy-record to a configurable upstream) and `getRecordedFixtures()`. The CLI wires `--record`: inline-fixture cases replay-and-score, non-inline cases record-and-score with fixtures flushed per-case before the gate verdict; plain replay auto-loads sibling files.

**Tech Stack:** TypeScript, pnpm workspaces, vitest, `@copilotkit/aimock` (`LLMock`), commander.

**Branch:** `feat/eval-record` (already created; spec at `docs/superpowers/specs/2026-06-16-eval-record-design.md`).

**Conventions for every task:**
- Run a single test file with: `pnpm --filter <pkg> exec vitest run <relpath> -t "<name>"` (e.g. `pnpm --filter @dawn-ai/testing exec vitest run test/record-fixtures.test.ts`).
- The shell cwd resets to a worktree each call; prefix commands with `cd /Users/blove/repos/dawn`.
- Commit after each task with the message shown.

---

### Task 1: Pure re-keying transform `recordingsToFixtures`

This is the heart of Approach A: convert ordered `{request,response}` recordings into our replay-keyed `FixtureSet`, computing `turnIndex`/`hasToolResult`/`userMessage` exactly as `script()` does (see `packages/testing/src/fixture-builder.ts`: `turnIndex` = call ordinal in the thread, `hasToolResult` = a `tool`-role message is present).

**Files:**
- Create: `packages/testing/src/record-fixtures.ts`
- Test: `packages/testing/test/record-fixtures.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/testing/test/record-fixtures.test.ts
import { describe, expect, it } from "vitest"
import { recordingsToFixtures, type Recording } from "../src/record-fixtures.js"

function userReq(text: string): Recording["request"] {
  return { messages: [{ role: "user", content: text }] }
}
function toolRoundReq(userText: string): Recording["request"] {
  // second LLM call: user + assistant(tool_call) + tool result already in thread
  return {
    messages: [
      { role: "user", content: userText },
      { role: "assistant", content: "", tool_calls: [{ id: "call_x", type: "function", function: { name: "greet", arguments: "{}" } }] },
      { role: "tool", content: "ok", tool_call_id: "call_x" },
    ],
  }
}

describe("recordingsToFixtures", () => {
  it("maps a text-only single call to one fixture (turn 0, no tool result)", () => {
    const recordings: Recording[] = [
      { request: userReq("hello"), response: { content: "Hi there" } },
    ]
    expect(recordingsToFixtures(recordings)).toEqual([
      { match: { userMessage: "hello", turnIndex: 0, hasToolResult: false }, response: { content: "Hi there" } },
    ])
  })

  it("maps a tool round (2 calls) to turn 0 toolCall + turn 1 reply with hasToolResult", () => {
    const recordings: Recording[] = [
      { request: userReq("greet me"), response: { toolCalls: [{ id: "call_x", name: "greet", arguments: { who: "me" } }] } },
      { request: toolRoundReq("greet me"), response: { content: "Hello, me" } },
    ]
    expect(recordingsToFixtures(recordings)).toEqual([
      { match: { userMessage: "greet me", turnIndex: 0, hasToolResult: false }, response: { toolCalls: [{ id: "call_x", name: "greet", arguments: { who: "me" } }] } },
      { match: { userMessage: "greet me", turnIndex: 1, hasToolResult: true }, response: { content: "Hello, me" } },
    ])
  })

  it("uses the FIRST user message as userMessage even when later messages exist", () => {
    const recordings: Recording[] = [
      { request: toolRoundReq("original prompt"), response: { content: "done" } },
    ]
    const [fx] = recordingsToFixtures(recordings)
    expect(fx?.match.userMessage).toBe("original prompt")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/testing exec vitest run test/record-fixtures.test.ts`
Expected: FAIL — `Cannot find module '../src/record-fixtures.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/testing/src/record-fixtures.ts
import type { AimockFixture, AimockResponse, FixtureSet } from "./fixture-builder.js"

/** One captured real-model exchange: the request the agent sent + the response to bake. */
export interface Recording {
  readonly request: {
    readonly messages?: ReadonlyArray<{ readonly role: string; readonly content: unknown }>
  }
  readonly response: AimockResponse
}

function firstUserMessage(req: Recording["request"]): string | undefined {
  for (const m of req.messages ?? []) {
    if (m.role === "user" && typeof m.content === "string") return m.content
  }
  return undefined
}

function hasToolResult(req: Recording["request"]): boolean {
  return (req.messages ?? []).some((m) => m.role === "tool")
}

/**
 * Convert ordered recordings (one per LLM call within a single case/thread) into
 * a replay FixtureSet, keyed with the SAME `{userMessage,turnIndex,hasToolResult}`
 * convention `script()` produces — so the recorded file replays through the same
 * aimock matcher with no drift. `turnIndex` is the 0-based ordinal of the call
 * within the thread; `userMessage` is the first user message (stable across the
 * thread); `hasToolResult` is whether a tool-role message is already present.
 */
export function recordingsToFixtures(recordings: readonly Recording[]): FixtureSet {
  return recordings.map((rec, turnIndex): AimockFixture => {
    const userMessage = firstUserMessage(rec.request)
    return {
      match: {
        ...(userMessage !== undefined ? { userMessage } : {}),
        turnIndex,
        hasToolResult: hasToolResult(rec.request),
      },
      response: rec.response,
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/testing exec vitest run test/record-fixtures.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/testing/src/record-fixtures.ts packages/testing/test/record-fixtures.test.ts
git commit -m "feat(testing): recordingsToFixtures re-keying transform for eval --record"
```

---

### Task 2: `extractRecordings` — pull request/response pairs from the aimock journal

Isolates the only aimock-journal coupling in one pure, synthetic-testable function. A journal entry has `body` (the `ChatCompletionRequest`) and `response.{ source, fixture }` (see `node_modules/@copilotkit/aimock/dist/types.d.ts` `JournalEntry`). For a proxied (real-model) call, `source === "proxy"` and `response.fixture` holds the recorded `Fixture` whose `response` is the baked reply. We convert aimock's `FixtureResponse` to our `AimockResponse`.

**Files:**
- Create: `packages/testing/src/extract-recordings.ts`
- Test: `packages/testing/test/extract-recordings.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/testing/test/extract-recordings.test.ts
import { describe, expect, it } from "vitest"
import { extractRecordings, type JournalEntryLike } from "../src/extract-recordings.js"

const proxyText: JournalEntryLike = {
  body: { messages: [{ role: "user", content: "hello" }] },
  response: { source: "proxy", fixture: { match: {}, response: { content: "Hi" } } },
}
const proxyToolCall: JournalEntryLike = {
  body: { messages: [{ role: "user", content: "greet" }] },
  response: {
    source: "proxy",
    fixture: { match: {}, response: { toolCalls: [{ id: "call_x", name: "greet", arguments: { a: 1 } }] } },
  },
}
const matchedFixture: JournalEntryLike = {
  body: { messages: [{ role: "user", content: "hello" }] },
  response: { source: "fixture", fixture: { match: { userMessage: "hello" }, response: { content: "served" } } },
}

describe("extractRecordings", () => {
  it("keeps only proxied entries (drops fixture-served calls)", () => {
    const out = extractRecordings([proxyText, matchedFixture])
    expect(out).toHaveLength(1)
    expect(out[0]?.response).toEqual({ content: "Hi" })
  })

  it("maps a toolCalls fixture response to our AimockResponse", () => {
    const [rec] = extractRecordings([proxyToolCall])
    expect(rec?.response).toEqual({ toolCalls: [{ id: "call_x", name: "greet", arguments: { a: 1 } }] })
    expect(rec?.request.messages?.[0]).toEqual({ role: "user", content: "greet" })
  })

  it("drops proxied entries with a null fixture (nothing to bake)", () => {
    const out = extractRecordings([{ body: { messages: [] }, response: { source: "proxy", fixture: null } }])
    expect(out).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/testing exec vitest run test/extract-recordings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/testing/src/extract-recordings.ts
import type { AimockResponse } from "./fixture-builder.js"
import type { Recording } from "./record-fixtures.js"

/** The slice of an aimock `JournalEntry` we read. Structural to avoid importing aimock types. */
export interface JournalEntryLike {
  readonly body: { readonly messages?: ReadonlyArray<{ readonly role: string; readonly content: unknown }> } | null
  readonly response?: {
    readonly source?: string
    readonly fixture?: {
      readonly response?: unknown
    } | null
  }
}

/** aimock's baked fixture response → our AimockResponse. Returns null when unmappable. */
function toAimockResponse(fixtureResponse: unknown): AimockResponse | null {
  if (fixtureResponse === null || typeof fixtureResponse !== "object") return null
  const r = fixtureResponse as Record<string, unknown>
  if (Array.isArray(r.toolCalls)) {
    return { toolCalls: r.toolCalls as AimockResponse extends { toolCalls: infer T } ? T : never }
  }
  if (typeof r.content === "string") return { content: r.content }
  return null
}

/**
 * Pull ordered recordings from aimock journal entries, keeping only proxied
 * (real-model) calls whose recorded fixture is present. The output order is the
 * journal order = the call order within the thread.
 */
export function extractRecordings(entries: readonly JournalEntryLike[]): Recording[] {
  const out: Recording[] = []
  for (const entry of entries) {
    if (entry.response?.source !== "proxy") continue
    const fixture = entry.response.fixture
    if (!fixture) continue
    const response = toAimockResponse(fixture.response)
    if (!response) continue
    out.push({ request: { messages: entry.body?.messages }, response })
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/testing exec vitest run test/extract-recordings.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/testing/src/extract-recordings.ts packages/testing/test/extract-recordings.test.ts
git commit -m "feat(testing): extractRecordings journal seam for eval --record"
```

---

### Task 3: aimock-runner record mode + `getRecordings()`

Add a record-capable start path (`proxyOnly:false` so responses are captured) and expose `getRecordings()` on `AimockHandle` (journal → recordings via Task 2). Mirrors the existing `proxy` option in `startAimock` (`packages/testing/src/aimock-runner.ts`).

**Files:**
- Modify: `packages/testing/src/aimock-runner.ts`
- Test: `packages/testing/test/aimock-runner-recordings.test.ts`

- [ ] **Step 1: Write the failing test** (records against a LOCAL fake upstream — a second aimock serving a canned reply; no real key)

```ts
// packages/testing/test/aimock-runner-recordings.test.ts
import { afterAll, expect, it } from "vitest"
import { startAimock } from "../src/aimock-runner.js"

it("getRecordings() captures a proxied response from a local upstream", async () => {
  // Upstream: a plain aimock that always replies "from upstream".
  const upstream = await startAimock({
    fixtures: [{ match: {}, response: { content: "from upstream" } }],
  })
  // Recorder: proxy-record mode pointed at the upstream's base (strip the /v1).
  const recorder = await startAimock({
    fixtures: [],
    proxy: { openai: upstream.baseUrl.replace(/\/v1$/, "") },
    record: true,
  })
  afterAll(async () => {
    await recorder.stop()
    await upstream.stop()
  })

  // Drive one chat request through the recorder via fetch (OpenAI chat shape).
  const res = await fetch(`${recorder.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "ping" }] }),
  })
  expect(res.ok).toBe(true)

  const recordings = recorder.getRecordings()
  expect(recordings).toHaveLength(1)
  expect(recordings[0]?.response).toEqual({ content: "from upstream" })
  expect(recordings[0]?.request.messages?.[0]).toEqual({ role: "user", content: "ping" })
}, 30_000)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/testing exec vitest run test/aimock-runner-recordings.test.ts`
Expected: FAIL — `startAimock` has no `record` option / `getRecordings` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `packages/testing/src/aimock-runner.ts`:

1. Add `import { extractRecordings } from "./extract-recordings.js"` and `import type { Recording } from "./record-fixtures.js"` at the top.
2. Extend `AimockHandle`:

```ts
  /** Ordered recordings (request + baked response) for proxied calls captured in record mode. */
  getRecordings(): readonly Recording[]
```

3. Change the `startAimock` options + `LLMock` construction so `record: true` enables proxy-record (`proxyOnly:false`):

```ts
export async function startAimock(opts: {
  readonly fixtures: readonly AimockFixture[]
  /** When set, proxy unmatched requests to the given upstream providers. */
  readonly proxy?: { openai: string }
  /** With proxy: capture (record) proxied responses so getRecordings() returns them. */
  readonly record?: boolean
}): Promise<AimockHandle> {
  const mock = new LLMock(
    opts.proxy
      ? {
          port: 0,
          chunkSize: 4096,
          record: {
            providers: { openai: opts.proxy.openai },
            proxyOnly: opts.record !== true,
          },
        }
      : { port: 0, chunkSize: 4096 },
  )
```

4. Add `getRecordings` to the returned handle (next to `getRequests`):

```ts
    getRecordings() {
      return extractRecordings(
        mock.getRequests() as Parameters<typeof extractRecordings>[0],
      )
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/testing exec vitest run test/aimock-runner-recordings.test.ts`
Expected: PASS (1 test). If the proxied journal entry exposes the baked response under a different field than `response.fixture.response`, adjust `extractRecordings` (Task 2) and its unit test together — the synthetic-journal test must keep matching the real shape.

- [ ] **Step 5: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/testing/src/aimock-runner.ts packages/testing/test/aimock-runner-recordings.test.ts
git commit -m "feat(testing): aimock record mode + getRecordings()"
```

---

### Task 4: Harness `record` mode + `getRecordedFixtures()`

Add `record?: boolean` and `recordUpstream?: string` to `AgentHarnessOptions`, start aimock in record mode pointed at the upstream (default OpenAI), and expose `getRecordedFixtures()` returning the current case's fixtures. Scope to the last `run()` via a journal-length snapshot (mirrors `drive()`'s existing `snapshotLen` pattern in `packages/testing/src/harness.ts`).

**Files:**
- Modify: `packages/testing/src/harness.ts`
- Modify: `packages/testing/src/index.ts` (no new export needed beyond types already public; verify `AgentHarness` type carries the new method)
- Test: `packages/testing/test/harness-record.test.ts`

- [ ] **Step 1: Write the failing test** (full record→replay loop against a local fake upstream, no real key; uses the probe app at `packages/testing/test/fixtures/probe-app`)

```ts
// packages/testing/test/harness-record.test.ts
import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { startAimock } from "../src/aimock-runner.js"
import { createAgentHarness } from "../src/harness.js"
import { writeFixtures, loadFixtures } from "../src/fixture-file.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

it("records a case against a local upstream, then replays it deterministically", async () => {
  // Fake upstream: always replies "RECORDED ANSWER" (no tools, single turn).
  const upstream = await startAimock({
    fixtures: [{ match: {}, response: { content: "RECORDED ANSWER" } }],
  })
  const recordH = await createAgentHarness({
    appRoot,
    route: "/chat#agent",
    record: true,
    recordUpstream: upstream.baseUrl.replace(/\/v1$/, ""),
  })
  afterAll(async () => {
    await recordH.close()
    await upstream.stop()
  })

  const run = await recordH.run({ input: "what is up" })
  expect(run.finalMessage).toContain("RECORDED ANSWER")

  const fixtures = recordH.getRecordedFixtures()
  expect(fixtures.length).toBeGreaterThanOrEqual(1)
  expect(fixtures[0]?.match.turnIndex).toBe(0)

  const dir = mkdtempSync(join(tmpdir(), "dawn-rec-"))
  const file = join(dir, "smoke.case.fixtures.json")
  writeFixtures(file, fixtures)

  // Replay: a fresh mock-mode harness fed the recorded fixtures reproduces the answer.
  const replayH = await createAgentHarness({ appRoot, route: "/chat#agent", fixtures: loadFixtures(file) })
  try {
    const replay = await replayH.run({ input: "what is up" })
    expect(replay.finalMessage).toContain("RECORDED ANSWER")
  } finally {
    await replayH.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/testing exec vitest run test/harness-record.test.ts`
Expected: FAIL — `record`/`recordUpstream` not accepted, or `getRecordedFixtures` undefined.

- [ ] **Step 3: Write minimal implementation**

In `packages/testing/src/harness.ts`:

1. Imports: add `import { recordingsToFixtures } from "./record-fixtures.js"`.
2. Extend `AgentHarnessOptions`:

```ts
  /** Capture real-model traffic for `getRecordedFixtures()`. Proxies to `recordUpstream`. */
  readonly record?: boolean
  /** Upstream base URL for record mode (no /v1 suffix). Default https://api.openai.com. */
  readonly recordUpstream?: string
```

3. Extend the `AgentHarness` interface with:

```ts
  /** Fixtures captured from the most recent run() (record mode only); re-keyed for replay. */
  getRecordedFixtures(): FixtureSet
```

(Import `FixtureSet` is already imported via `./fixture-builder.js`.)

4. Replace the aimock-start ternary so record mode is honored. After `const live = options.live ?? false`, add `const record = options.record ?? false`. Then:

```ts
  const aimock: AimockHandle = live
    ? await startAimock({ fixtures: [], proxy: { openai: "https://api.openai.com" } })
    : record
      ? await startAimock({
          fixtures: [],
          proxy: { openai: options.recordUpstream ?? "https://api.openai.com" },
          record: true,
        })
      : await startAimock({ fixtures: options.fixtures ?? [] })
```

5. In record mode, do NOT inject the dummy key (real upstream needs the real one when targeting OpenAI; a local upstream ignores it). Change the dummy-key guard to mock-only (neither live nor record):

```ts
  if (!live && !record) {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  }
```

6. Track the last run's journal start. Add `let lastRunJournalStart = 0` near `let threadId = ...`. In `drive()`, set it at the existing snapshot point:

```ts
    const snapshotLen = aimock.getRequests().length
    lastRunJournalStart = snapshotLen
```

7. In `drive()`, skip per-run fixture registration when recording (record runs against the upstream; inline fixtures still register so inline-fixture cases replay — but the CLI never passes fixtures to a recorded case, so this is naturally fine). Change the guard from `if (!live && driveOpts.fixtures)` to `if (!live && !record && driveOpts.fixtures)`.

8. Add `import { extractRecordings } from "./extract-recordings.js"` to the imports, then add the method to the `harness` object. It scopes to the last `run()` by slicing the journal from `lastRunJournalStart`, filters to proxied calls via `extractRecordings`, and re-keys via `recordingsToFixtures`:

```ts
    getRecordedFixtures() {
      const sinceLast = aimock.getRequests().slice(lastRunJournalStart)
      return recordingsToFixtures(
        extractRecordings(sinceLast as Parameters<typeof extractRecordings>[0]),
      )
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/testing exec vitest run test/harness-record.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Run the full testing suite to confirm no regression**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/testing test`
Expected: PASS (all prior tests + the 3 new files).

- [ ] **Step 6: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/testing/src/harness.ts packages/testing/src/index.ts packages/testing/test/harness-record.test.ts
git commit -m "feat(testing): harness record mode + getRecordedFixtures()"
```

---

### Task 5: CLI sibling-path helper + replay auto-load

Add a single source of truth for the sibling fixture filename and wire it into the existing replay branch so a case with no inline fixtures auto-loads `<evalBasename>.<caseSlug>.fixtures.json` instead of erroring.

**Files:**
- Create: `packages/cli/src/lib/runtime/eval-fixture-path.ts`
- Test: `packages/cli/test/eval-fixture-path.test.ts`
- Modify: `packages/cli/src/commands/eval.ts`

- [ ] **Step 1: Write the failing test for the path helper**

```ts
// packages/cli/test/eval-fixture-path.test.ts
import { describe, expect, it } from "vitest"
import { caseSlug, siblingFixturePath } from "../src/lib/runtime/eval-fixture-path.js"

describe("caseSlug", () => {
  it("slugifies a name: lowercase, non-alphanumeric → single dash, trimmed", () => {
    expect(caseSlug("Greets the User!", 0)).toBe("greets-the-user")
    expect(caseSlug("  multiple   spaces  ", 1)).toBe("multiple-spaces")
  })
  it("falls back to case-<index> when name is missing or empties to nothing", () => {
    expect(caseSlug(undefined, 2)).toBe("case-3")
    expect(caseSlug("!!!", 0)).toBe("case-1")
  })
})

describe("siblingFixturePath", () => {
  it("joins baseDir with <evalBasename>.<slug>.fixtures.json", () => {
    const p = siblingFixturePath("/app/src/app/chat/evals/smoke.eval.ts", "/app/src/app/chat/evals", "greets the user", 0)
    expect(p).toBe("/app/src/app/chat/evals/smoke.greets-the-user.fixtures.json")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/cli exec vitest run test/eval-fixture-path.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/lib/runtime/eval-fixture-path.ts
import { basename, join } from "node:path"

/** Stable slug for a case name; falls back to `case-<index+1>` when empty. */
export function caseSlug(name: string | undefined, index: number): string {
  const slug = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : `case-${index + 1}`
}

/** `<baseDir>/<evalBasename>.<caseSlug>.fixtures.json` — the per-case sibling fixture file. */
export function siblingFixturePath(
  evalFile: string,
  baseDir: string,
  caseName: string | undefined,
  index: number,
): string {
  const evalBase = basename(evalFile).replace(/\.eval\.ts$/, "")
  return join(baseDir, `${evalBase}.${caseSlug(caseName, index)}.fixtures.json`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/cli exec vitest run test/eval-fixture-path.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire replay auto-load into `eval.ts`**

In `packages/cli/src/commands/eval.ts`:

1. Add imports:

```ts
import { existsSync } from "node:fs"
import { siblingFixturePath } from "../lib/runtime/eval-fixture-path.js"
```

2. Add `loadFixtures` to the `TestingModule` interface and to the destructure:

```ts
interface TestingModule {
  createAgentHarness(opts: {
    appRoot: string
    route: string
    live?: boolean
    record?: boolean
  }): Promise<AgentHarnessShape>
  loadFixtures(path: string): unknown
  writeFixtures(path: string, fixtures: unknown): void
}
```

   and: `const { createAgentHarness, loadFixtures, writeFixtures } = await importFromApp<TestingModule>(appRoot, "@dawn-ai/testing")`

3. Replace the replay branch inside `runCase` so a missing inline fixture tries the sibling file before erroring. Track a per-eval case index with a counter declared just before `runEval`:

```ts
      let caseIndex = -1
      const report = await runEval(loaded.definition, {
        baseDir: loaded.baseDir,
        runCase: async (testCase) => {
          caseIndex += 1
          harness.reset()
          const input =
            typeof testCase.input === "string" ? testCase.input : JSON.stringify(testCase.input)

          // Replay (default): inline fixtures win; else the recorded sibling file.
          if (!options.live && !options.record) {
            let fixtures: unknown = testCase.fixtures
            if (!fixtures) {
              const sibling = siblingFixturePath(loaded.evalFile, loaded.baseDir, testCase.name, caseIndex)
              if (existsSync(sibling)) fixtures = loadFixtures(sibling)
            }
            if (!fixtures) {
              throw new CliError(
                `Eval "${loaded.definition.name}" case "${testCase.name ?? "?"}" has no fixtures — add script()/fixtures, record with --record, or run with --live`,
                2,
              )
            }
            return harness.run({ input, fixtures })
          }

          // Live / record branches handled in Task 6.
          return harness.run({ input })
        },
      })
```

4. Add `record` to `AgentHarnessShape` and `getRecordedFixtures`:

```ts
interface AgentHarnessShape {
  run(opts: { input: string; fixtures?: unknown }): Promise<AgentRunResultShape>
  getRecordedFixtures(): unknown[]
  reset(): void
  close(): Promise<void>
}
```

- [ ] **Step 6: Run the existing eval command tests to confirm replay still works**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/cli exec vitest run test/eval-command.test.ts`
Expected: PASS (existing eval-command tests unaffected; if the filename differs, run `ls packages/cli/test | grep eval` to find it).

- [ ] **Step 7: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/cli/src/lib/runtime/eval-fixture-path.ts packages/cli/test/eval-fixture-path.test.ts packages/cli/src/commands/eval.ts
git commit -m "feat(cli): sibling fixture path + replay auto-load for eval --record"
```

---

### Task 6: CLI `--record` flag, mode wiring, and per-case write

Add the `--record` flag with guards, construct the harness in record mode, and for each non-inline case write the recorded sibling file BEFORE returning (so a later gate failure never discards it). Inline-fixture cases run-and-score but are not written.

**Files:**
- Modify: `packages/cli/src/commands/eval.ts`
- Test: `packages/cli/test/eval-record.test.ts`

- [ ] **Step 1: Write the failing test** (drives the command with a local upstream; asserts a sibling file is written and a subsequent replay run uses it)

```ts
// packages/cli/test/eval-record.test.ts
// NOTE: This is an integration test of runEvalCommand against a fixture app that
// devDepends on @dawn-ai/testing + @dawn-ai/evals. Use the existing eval-command
// test's harness/setup as the template (see test/eval-command.test.ts for how it
// builds a temp app, points OPENAI_BASE_URL at a local upstream aimock, and calls
// runEvalCommand). Assert:
//   1. runEvalCommand(path, { record: true }, io) with a no-inline-fixture eval
//      writes <evalBase>.<slug>.fixtures.json next to the eval file.
//   2. The file parses as { fixtures: [...] } with a turnIndex:0 entry.
//   3. A follow-up runEvalCommand(path, {}, io) (replay) succeeds using that file
//      (no "has no fixtures" error).
//   4. An inline-fixture case does NOT get a sibling file written.
```

Implement the test concretely by copying the setup from `packages/cli/test/eval-command.test.ts` (same temp-app builder + local upstream aimock). Keep assertions 1–4 above.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/cli exec vitest run test/eval-record.test.ts`
Expected: FAIL — `--record` not handled; no sibling file written.

- [ ] **Step 3: Implement the flag + guards + record wiring**

In `packages/cli/src/commands/eval.ts`:

1. Add to `EvalOptions`: `readonly record?: boolean`.
2. Register the flag in `registerEvalCommand`:

```ts
    .option("--record", "Record fixtures from the real model into sibling files (requires OPENAI_API_KEY); never use in CI")
```

3. At the top of `runEvalCommand`, add guards (after `loadEvals`):

```ts
  if (options.record && options.live) {
    throw new CliError("Choose one of --record or --live, not both", 2)
  }
  if (options.record && !process.env.OPENAI_API_KEY) {
    throw new CliError("dawn eval --record requires OPENAI_API_KEY (records against the real model)", 2)
  }
```

4. Construct the harness with record mode:

```ts
    const harness = await createAgentHarness({
      appRoot: loaded.appRoot,
      route: loaded.route,
      ...(options.live ? { live: true } : {}),
      ...(options.record ? { record: true } : {}),
    })
```

5. Replace the `// Live / record branches handled in Task 6.` tail of `runCase` with:

```ts
          // Record: inline-fixture cases replay+score (registered fixtures match,
          // no proxy); non-inline cases hit the real model and get written.
          if (options.record) {
            if (testCase.fixtures) {
              writeLine(io.stdout, `· ${loaded.definition.name} › ${testCase.name ?? `case ${caseIndex + 1}`}: skipped record (inline fixtures)`)
              return harness.run({ input, fixtures: testCase.fixtures })
            }
            const result = await harness.run({ input })
            const recorded = harness.getRecordedFixtures()
            const sibling = siblingFixturePath(loaded.evalFile, loaded.baseDir, testCase.name, caseIndex)
            if (recorded.length === 0) {
              writeLine(io.stdout, `· ${loaded.definition.name} › ${testCase.name ?? `case ${caseIndex + 1}`}: recorded 0 calls — skipped write`)
            } else {
              try {
                writeFixtures(sibling, recorded)
              } catch (err) {
                throw new CliError(`Failed to write fixtures ${sibling}: ${formatErrorMessage(err)}`, 2)
              }
              writeLine(io.stdout, `· recorded ${recorded.length} fixtures → ${sibling}`)
            }
            return result
          }

          // Live: real model, no capture.
          return harness.run({ input })
```

   (The gate stays active because `runEval` computes the verdict after all `runCase` calls; each write already happened inside `runCase`. The existing `if (report.gated && !report.passed) anyFailed = true` and the trailing `if (anyFailed) throw` lines are unchanged, so `--record` exits nonzero on a gate miss with fixtures already on disk.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/cli exec vitest run test/eval-record.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/cli/src/commands/eval.ts packages/cli/test/eval-record.test.ts
git commit -m "feat(cli): dawn eval --record flag, guards, per-case fixture write"
```

---

### Task 7: Gated live smoke (real key, local-only)

A `skipIf(!OPENAI_API_KEY)` test that records a one-case eval against the real model and replays it. Never runs in CI (no key secret).

**Files:**
- Test: `packages/testing/test/eval-record-live.smoke.test.ts`

- [ ] **Step 1: Write the smoke test**

```ts
// packages/testing/test/eval-record-live.smoke.test.ts
import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const live = Boolean(process.env.OPENAI_API_KEY)

it.skipIf(!live)("records real-model fixtures and re-keys them with turnIndex", async () => {
  const h = await createAgentHarness({ appRoot, route: "/chat#agent", record: true })
  afterAll(() => h.close())
  await h.run({ input: "Say the single word ready." })
  const fixtures = h.getRecordedFixtures()
  expect(fixtures.length).toBeGreaterThanOrEqual(1)
  expect(fixtures[0]?.match.turnIndex).toBe(0)
  expect(fixtures[0]?.response).toBeDefined()
}, 60_000)
```

- [ ] **Step 2: Run it (skips without a key)**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/testing exec vitest run test/eval-record-live.smoke.test.ts`
Expected: SKIPPED (1 skipped) in this environment (no key). The implementer notes it skips; the human runs it locally with the key.

- [ ] **Step 3: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/testing/test/eval-record-live.smoke.test.ts
git commit -m "test(testing): gated live smoke for eval --record recording"
```

---

### Task 8: Dogfood — record-style case in the chat example + committed fixture

Add a no-inline-fixture case to the chat example eval and commit its recorded sibling fixture so the existing deterministic eval CI lane replays it.

**Files:**
- Modify: `examples/chat/server/src/app/chat/evals/smoke.eval.ts`
- Create: `examples/chat/server/src/app/chat/evals/smoke.<slug>.fixtures.json` (generated by recording locally)

- [ ] **Step 1: Read the current eval to match its dataset shape**

Run: `cd /Users/blove/repos/dawn && cat examples/chat/server/src/app/chat/evals/smoke.eval.ts`
Confirm the existing inline `script()` case stays untouched.

- [ ] **Step 2: Add a second, record-style case (no inline fixtures)**

Append a case to the `dataset` array with a stable `name` (e.g. `"recalls capital of france"`), an `input`, and an `expected`/scorer that a recorded answer can satisfy (e.g. `contains("Paris")`). Do NOT add `fixtures` to this case. Keep the existing case unchanged.

- [ ] **Step 3: Record the fixture locally (human runs with the real key)**

Run (local, key authorized for local smokes only):
```bash
cd /Users/blove/repos/dawn
set -a; . /Users/blove/repos/dawn/.env; set +a
pnpm --filter @dawn-ai/cli build
node packages/cli/dist/bin.js eval examples/chat/server --record --cwd examples/chat/server
```
Expected: stdout shows `· recorded N fixtures → …/smoke.recalls-capital-of-france.fixtures.json` and the file exists. (The agent dispatcher/route must match the example's; if `dawn eval` is invoked differently in this repo, mirror the invocation used by the example's package.json `eval` script — check `examples/chat/server/package.json`.)

- [ ] **Step 4: Verify replay is deterministic (no key)**

Run:
```bash
cd /Users/blove/repos/dawn
unset OPENAI_API_KEY
node packages/cli/dist/bin.js eval examples/chat/server --cwd examples/chat/server
```
Expected: both cases PASS using the committed fixtures (the new case replays from the sibling file; no "has no fixtures" error).

- [ ] **Step 5: Commit**

```bash
cd /Users/blove/repos/dawn
git add examples/chat/server/src/app/chat/evals/smoke.eval.ts examples/chat/server/src/app/chat/evals/smoke.*.fixtures.json
git commit -m "test(chat-example): dogfood a recorded (no-inline) eval case"
```

---

### Task 9: Docs + changeset

Document `--record` on the eval docs page and add a changeset (cli minor for the new flag; testing minor for the new harness capability — both bump the fixed group to the next patch per the release process; declare as **patch** to keep the fixed group on a patch, per GOTCHA 6 in the release memory).

**Files:**
- Modify: `apps/web/content/docs/<eval-page>.mdx` (find with the grep below)
- Create: `.changeset/eval-record.md`

- [ ] **Step 1: Find the eval docs page**

Run: `cd /Users/blove/repos/dawn && grep -rln "dawn eval" apps/web/content/docs | head`
Open the matching page.

- [ ] **Step 2: Add a `--record` section**

Document: `dawn eval --record` runs against the real model (requires `OPENAI_API_KEY`, never CI), writes one `<evalBasename>.<caseSlug>.fixtures.json` per case that lacks inline fixtures, and that a plain `dawn eval` auto-replays those committed files. Note inline `script()` fixtures stay authoritative (record skips them), and that the gate still applies (record exits nonzero on a miss, but fixtures are written first). Mention `--record` and `--live` are mutually exclusive.

- [ ] **Step 3: Write the changeset (patch to keep the fixed group on a patch)**

```md
---
"@dawn-ai/cli": patch
"@dawn-ai/testing": patch
---

Add `dawn eval --record`. Records replayable aimock fixtures from a real-model
eval run into per-case sibling `<evalBasename>.<caseSlug>.fixtures.json` files,
auto-loaded on a plain (replay) `dawn eval`. Inline `script()` fixtures stay
authoritative (record skips those cases); the gate still applies during record
but captured fixtures are flushed per-case before the verdict. New
`@dawn-ai/testing` harness capability: `createAgentHarness({ record: true })` +
`harness.getRecordedFixtures()`.
```

- [ ] **Step 4: Commit**

```bash
cd /Users/blove/repos/dawn
git add apps/web/content/docs .changeset/eval-record.md
git commit -m "docs: document dawn eval --record + changeset"
```

---

### Task 10: Full validate + PR

- [ ] **Step 1: Run the full validation**

Run: `cd /Users/blove/repos/dawn && pnpm ci:validate`
Expected: green (build → typecheck → lint → tests). The live smoke (Task 7) skips without a key. Fix any failures before proceeding.

- [ ] **Step 2: Push and open the PR**

```bash
cd /Users/blove/repos/dawn
git push -u origin feat/eval-record
gh pr create --base main --head feat/eval-record \
  --title "feat(cli): dawn eval --record" \
  --body "Implements \`dawn eval --record\` per docs/superpowers/specs/2026-06-16-eval-record-design.md. Records per-case sibling fixtures from a real-model run; plain \`dawn eval\` auto-replays them. New @dawn-ai/testing harness record mode + getRecordedFixtures(). Closes the Phase 4 eval-authoring fast-follow.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3: Update phase memory**

Append to `/Users/blove/.claude/projects/-Users-blove-repos-dawn/memory/project_phase_status.md` under the Phase 4 / eval-authoring entry: `dawn eval --record` shipped — per-case sibling fixtures, harness record mode + getRecordedFixtures(), re-keys recordings to the {userMessage,turnIndex,hasToolResult} convention.

---

## Self-Review

**Spec coverage:**
- Sibling per-case files → Tasks 5 (path helper) + 6 (write). ✓
- `--record` hits real model / key guard / not-with-live → Task 6. ✓
- Inline wins on replay; record skips inline cases → Tasks 5 (auto-load precedence) + 6 (skip+score). ✓
- Record runs all cases for scoring → Task 6 (inline cases run with fixtures; non-inline run+record). ✓
- Gate active but fixtures flushed before verdict → Task 6 (write inside runCase; verdict after). ✓
- `getRecordedFixtures()` re-keying via Approach A → Tasks 1–4. ✓
- Empty-capture warn+skip; write-failure fail-fast → Task 6. ✓
- Tests: unit re-keying (1,2), record→replay integration (3,4,6), gated live smoke (7), dogfood (8). ✓
- Docs + changeset → Task 9. ✓

**Placeholder scan:** Task 6 Step 1 and Task 8 reference an existing test harness/invocation to mirror rather than inlining full code — these are integration setups whose exact boilerplate depends on the current `eval-command.test.ts` and the example's `package.json` script, which the implementer must read first. All pure-logic tasks (1,2,5) carry complete code. Acceptable: the integration tasks point at the concrete template file + list exact assertions.

**Type consistency:** `Recording` (Task 1) is consumed by `extractRecordings` (Task 2), `getRecordings` (Task 3), and `getRecordedFixtures` (Task 4). `recordingsToFixtures` and `extractRecordings` names are used consistently. `siblingFixturePath`/`caseSlug` (Task 5) reused in Task 6. `AgentHarnessShape` gains `getRecordedFixtures`/`record` consistently in Tasks 5–6. Harness `record`/`recordUpstream` options match between Task 4 def and Task 6 usage.
