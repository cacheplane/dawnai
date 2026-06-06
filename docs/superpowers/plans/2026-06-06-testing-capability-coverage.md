# `@dawn-ai/testing` Capability Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `@dawn-ai/testing` to capture HITL interrupts, subagent events, plan updates, and the composed system prompt; add a `resume()` path and matchers; and dogfood all five Phase-3 capabilities (permissions, subagents, planning, skills, memory) in-process against the real example apps.

**Architecture:** Additive harness extensions in `@dawn-ai/testing` (no framework changes — the runtime already emits the events, and aimock's `getRequests()` journal exposes the system prompt). Then capability e2e scenarios co-located with `examples/chat/server`.

**Tech Stack:** TypeScript, pnpm/turbo, vitest, biome, `@copilotkit/aimock` 1.28, `@dawn-ai/cli/runtime`.

**Worktree:** `/Users/blove/repos/dawn-capcov` (branch `feat/testing-capability-coverage`, off `origin/main` which includes `@dawn-ai/testing`).

**Spec:** `docs/superpowers/specs/2026-06-06-testing-capability-coverage-design.md`.

---

## Background facts (verified — trust these)

- **Current `AgentRunResult`** (`packages/testing/src/run-result.ts`): `{ finalMessage, messages, toolCalls, tokens, state, threadId }`. `collectRunResult(stream, threadId)` handles `chunk`/`tool_call`/`done` and DROPS everything else (`default: break`). It already has a `normalizeToolArgs` helper.
- **Current harness** (`packages/testing/src/harness.ts`): `createAgentHarness({appRoot, route, fixtures?, mode?})` → `{ baseUrl, run({input, fixtures?}), reset(), close() }`. Only `mode:"in-process"` works. `run()` calls `streamResolvedRoute({appRoot, input:{messages:[{role:"user",content}]}, routeFile, routeId, routePath, threadId})` then `collectRunResult`. `close()` restores env + calls `__resetMaterializedAgentsForTests()`.
- **`AimockHandle`** (`packages/testing/src/aimock-runner.ts`): `{ port, baseUrl, addFixtures(fixtures), stop() }`. The underlying `mock` is `LLMock`, which exposes `getRequests(): JournalEntry[]` where `JournalEntry.body` is a `ChatCompletionRequest` with `messages: {role, content}[]`.
- **Runtime stream chunks** the runtime emits beyond chunk/tool_call/done: `{type:"interrupt", data:{interruptId, kind, detail}}`, `{type:"plan_update", data:{todos:[{content,status}]}}`, and subagent events `{type:"subagent.start", data:{call_id, subagent, route_id, depth}}`, `{type:"subagent.tool_call", data:{call_id, tool, input}}`, `{type:"subagent.tool_result", data:{call_id, tool, output}}`, `{type:"subagent.message", data:{call_id, chunk}}`, `{type:"subagent.end", data:{call_id, final_message}}` (or `{call_id, error}`).
- **Resume**: `streamResolvedRoute` accepts `resumeDecision?: "once"|"always"|"deny"`; when set, the adapter replays `Command({resume})` against the parked thread (same `threadId`). In-process resume needs only `{appRoot, routeFile, routeId, routePath, threadId, resumeDecision}` (no `input`).
- **Example apps** (`examples/chat/server`): chat route key `/chat#agent`; capabilities: workspace (`workspace/AGENTS.md` contains the line `# Workspace memory`), permissions (allow/deny bash in `dawn.config.ts`), planning (`src/app/chat/plan.md` → `writeTodos` tool), skills (`src/app/chat/skills/{workspace-conventions,recover-from-failure}/SKILL.md` → `readSkill` tool). Coordinator route key `/coordinator#agent` with subagents `research` + `summarizer` (→ `task` tool). The package name is `@dawn-example/chat-server`; it already deps on `@dawn-ai/testing` (devDependency, from PR #193) and has a `vitest --run` test script.
- aimock matches fixtures on the **last user-message substring** + `turnIndex`/`hasToolResult`. The `script()` builder auto-assigns those.

---

## File Structure

**`@dawn-ai/testing` (harness extensions):**
- `packages/testing/src/aimock-runner.ts` — add `getRequests()` to `AimockHandle`.
- `packages/testing/src/run-result.ts` — extend `AgentRunResult` + `collectRunResult` (capture interrupt/plan_update/subagent.*); add a `deriveSystemPrompt` helper over journal entries.
- `packages/testing/src/harness.ts` — capture `systemPrompt` per turn; add `resume()`.
- `packages/testing/src/matchers.ts` — add `expectInterrupt`/`expectNoInterrupt`/`expectSubagent`/`expectPlan`/`expectSystemPrompt`.
- `packages/testing/src/index.ts` — export the new matchers + types.
- `packages/testing/test/*.test.ts` — unit tests per unit.

**Dogfood scenarios:**
- `examples/chat/server/test/capabilities.e2e.test.ts` — the five capability scenarios.

---

## Task 1: `AimockHandle.getRequests()` — expose the journal

**Files:**
- Modify: `packages/testing/src/aimock-runner.ts`
- Test: `packages/testing/test/aimock-runner.test.ts` (extend)

- [ ] **Step 1: Add the failing test** (append to the existing file)

```ts
it("exposes received requests via getRequests()", async () => {
  const mock = await startAimock({ fixtures: [{ match: {}, response: { content: "ok" } }] })
  try {
    await fetch(new URL("/v1/chat/completions", mock.baseUrl.replace(/\/v1$/, "")), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "system", content: "SYS-MARKER" }, { role: "user", content: "hi" }] }),
    })
    const reqs = mock.getRequests()
    expect(reqs.length).toBeGreaterThanOrEqual(1)
    const last = reqs[reqs.length - 1] as { body?: { messages?: { role: string; content: unknown }[] } }
    const sys = (last.body?.messages ?? []).filter((m) => m.role === "system").map((m) => m.content).join("\n")
    expect(sys).toContain("SYS-MARKER")
  } finally {
    await mock.stop()
  }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/aimock-runner.test.ts`
Expected: FAIL — `mock.getRequests is not a function`.

- [ ] **Step 3: Implement**

In `aimock-runner.ts`, add to the `AimockHandle` interface and the returned object:

```ts
import type { AimockFixture } from "./fixture-builder.js"
// JournalEntry isn't re-exported usefully for our needs; type the accessor loosely.
export interface AimockHandle {
  readonly port: number
  readonly baseUrl: string
  addFixtures(fixtures: readonly AimockFixture[]): void
  /** All requests the mock has received (aimock's journal). */
  getRequests(): ReadonlyArray<{ body: { messages?: Array<{ role: string; content: unknown }> } | null }>
  stop(): Promise<void>
}
```

In the returned object add:

```ts
    getRequests() {
      return mock.getRequests() as ReadonlyArray<{
        body: { messages?: Array<{ role: string; content: unknown }> } | null
      }>
    },
```

(Verify `mock.getRequests()` exists on the installed `LLMock` — it's in its `.d.ts`. If the return type differs, keep the loose cast above; we only read `.body.messages`.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/aimock-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/aimock-runner.ts packages/testing/test/aimock-runner.test.ts
git commit -m "feat(testing): expose aimock request journal via AimockHandle.getRequests()"
```

---

## Task 2: Extend `AgentRunResult` + `collectRunResult` to capture interrupt / plan_update / subagent events

**Files:**
- Modify: `packages/testing/src/run-result.ts`
- Test: `packages/testing/test/run-result.test.ts` (extend)

- [ ] **Step 1: Add failing tests** (append)

```ts
it("captures interrupts, plan updates, and folds subagent events", async () => {
  async function* s() {
    yield { type: "interrupt", data: { interruptId: "perm-1", kind: "command", detail: { command: "rm -rf tmp" } } }
    yield { type: "plan_update", data: { todos: [{ content: "A", status: "pending" }] } }
    yield { type: "plan_update", data: { todos: [{ content: "A", status: "completed" }] } }
    yield { type: "subagent.start", data: { call_id: "c1", subagent: "research" } }
    yield { type: "subagent.tool_call", data: { call_id: "c1", tool: "webSearch", input: { q: "x" } } }
    yield { type: "subagent.end", data: { call_id: "c1", final_message: "found it" } }
    yield { type: "done", output: { messages: [] } }
  }
  const r = await collectRunResult(s() as never, "t")
  expect(r.interrupts).toEqual([{ interruptId: "perm-1", kind: "command", detail: { command: "rm -rf tmp" } }])
  expect(r.planUpdates).toHaveLength(2)
  expect(r.todos).toEqual([{ content: "A", status: "completed" }])
  expect(r.subagents).toHaveLength(1)
  expect(r.subagents[0]).toMatchObject({ name: "research", callId: "c1", finalMessage: "found it" })
  expect(r.subagents[0]?.toolCalls).toEqual([{ name: "webSearch", args: { q: "x" } }])
  expect(r.subagentEvents.length).toBeGreaterThanOrEqual(3)
})

it("captures a subagent error end", async () => {
  async function* s() {
    yield { type: "subagent.start", data: { call_id: "c1", subagent: "research" } }
    yield { type: "subagent.end", data: { call_id: "c1", error: "boom" } }
    yield { type: "done", output: { messages: [] } }
  }
  const r = await collectRunResult(s() as never, "t")
  expect(r.subagents[0]).toMatchObject({ name: "research", error: "boom" })
})

it("defaults the new fields to empty when absent", async () => {
  async function* s() { yield { type: "done", output: { messages: [] } } }
  const r = await collectRunResult(s() as never, "t")
  expect(r.interrupts).toEqual([])
  expect(r.planUpdates).toEqual([])
  expect(r.todos).toEqual([])
  expect(r.subagents).toEqual([])
  expect(r.systemPrompt).toBe("")
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/run-result.test.ts`
Expected: FAIL — new fields undefined.

- [ ] **Step 3: Implement** — extend types + reducer in `run-result.ts`

Add types near the top:

```ts
export interface InterruptInfo {
  readonly interruptId: string
  readonly kind: string
  readonly detail?: unknown
}
export interface Todo {
  readonly content: string
  readonly status: "pending" | "in_progress" | "completed"
}
export interface SubagentRun {
  readonly name: string
  readonly callId: string
  readonly toolCalls: ReadonlyArray<{ name: string; args: unknown }>
  readonly finalMessage?: string
  readonly error?: string
}
export interface SubagentEvent {
  readonly event: string
  readonly data: unknown
}
```

Extend `AgentRunResult`:

```ts
export interface AgentRunResult {
  readonly finalMessage: string
  readonly messages: ReadonlyArray<Record<string, unknown>>
  readonly toolCalls: ReadonlyArray<ObservedToolCall>
  readonly tokens: ReadonlyArray<string>
  readonly state: Record<string, unknown>
  readonly threadId: string
  readonly interrupts: ReadonlyArray<InterruptInfo>
  readonly planUpdates: ReadonlyArray<{ todos: Todo[] }>
  readonly todos: ReadonlyArray<Todo>
  readonly subagents: ReadonlyArray<SubagentRun>
  readonly subagentEvents: ReadonlyArray<SubagentEvent>
  readonly systemPrompt: string
}
```

In `collectRunResult`, add accumulators and cases. Add before the loop:

```ts
  const interrupts: InterruptInfo[] = []
  const planUpdates: { todos: Todo[] }[] = []
  const subagentEvents: SubagentEvent[] = []
  const subagentsByCall = new Map<string, { name: string; callId: string; toolCalls: { name: string; args: unknown }[]; finalMessage?: string; error?: string }>()

  function subagentFor(callId: string, name?: string) {
    let s = subagentsByCall.get(callId)
    if (!s) {
      s = { name: name ?? "", callId, toolCalls: [] }
      subagentsByCall.set(callId, s)
    } else if (name && !s.name) {
      s.name = name
    }
    return s
  }
```

Replace the `default: break` with capability handling:

```ts
      case "interrupt": {
        const d = (chunk as unknown as { data?: { interruptId?: string; kind?: string; detail?: unknown } }).data ?? {}
        interrupts.push({ interruptId: d.interruptId ?? "", kind: d.kind ?? "", detail: d.detail })
        break
      }
      case "plan_update": {
        const d = (chunk as unknown as { data?: { todos?: Todo[] } }).data ?? {}
        planUpdates.push({ todos: Array.isArray(d.todos) ? d.todos : [] })
        break
      }
      default: {
        const type = (chunk as { type: string }).type
        if (typeof type === "string" && type.startsWith("subagent.")) {
          const d = (chunk as unknown as { data?: Record<string, unknown> }).data ?? {}
          subagentEvents.push({ event: type, data: d })
          const callId = String((d.call_id as string) ?? "")
          if (callId) {
            const sub = type === "subagent.start"
              ? subagentFor(callId, d.subagent as string | undefined)
              : subagentFor(callId)
            if (type === "subagent.tool_call") {
              sub.toolCalls.push({ name: String(d.tool ?? ""), args: normalizeToolArgs(d.input) })
            } else if (type === "subagent.end") {
              if (typeof d.final_message === "string") sub.finalMessage = d.final_message
              if (typeof d.error === "string") sub.error = d.error
            }
          }
        }
        break
      }
```

Update the returned object:

```ts
  return {
    threadId, tokens, toolCalls, state,
    messages: Array.isArray(state.messages) ? (state.messages as Record<string, unknown>[]) : [],
    finalMessage: finalMessageFrom(state),
    interrupts,
    planUpdates,
    todos: planUpdates.length > 0 ? planUpdates[planUpdates.length - 1].todos : [],
    subagents: [...subagentsByCall.values()],
    subagentEvents,
    systemPrompt: "",   // populated by the harness from the aimock journal (Task 3)
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/run-result.test.ts`
Expected: PASS (incl. the existing tests — fields are additive).

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/run-result.ts packages/testing/test/run-result.test.ts
git commit -m "feat(testing): capture interrupts, plan updates, subagent runs in collectRunResult"
```

---

## Task 3: Capture `systemPrompt` per turn in the harness

**Files:**
- Modify: `packages/testing/src/harness.ts`
- Test: `packages/testing/test/harness-fixtures.test.ts` (extend) — uses the existing probe app.

- [ ] **Step 1: Add failing test** (append; the probe app at `packages/testing/test/fixtures/probe-app` has route `/chat#agent` with a `systemPrompt: "You are a test agent..."`)

```ts
it("captures the system prompt the model received", async () => {
  const run = await h.run({
    input: "hello there",
    fixtures: script().user("hello there").replies("hi"),
  })
  expect(run.systemPrompt).toContain("test agent") // from the probe app's agent systemPrompt
})
```

(Use the existing module-level `h` in that file; if none, create one with `createAgentHarness({ appRoot, route: "/chat#agent" })` + `afterAll(close)`.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/harness-fixtures.test.ts`
Expected: FAIL — `systemPrompt` is `""`.

- [ ] **Step 3: Implement** — snapshot the journal around the run and merge `systemPrompt`

Add a private helper in `harness.ts`:

```ts
function systemPromptFromRequests(
  reqs: ReadonlyArray<{ body: { messages?: Array<{ role: string; content: unknown }> } | null }>,
): string {
  // Use the LAST request of the turn (tool rounds re-send the same system prompt).
  const last = reqs[reqs.length - 1]
  const messages = last?.body?.messages ?? []
  return messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n")
}
```

Refactor `run()` to snapshot before/slice after and merge into the result:

```ts
    async run(runOpts) {
      if (runOpts.fixtures) {
        const newFixtures = toFixtureSet(runOpts.fixtures)
        if (newFixtures.length > 0) aimock.addFixtures(newFixtures)
      }
      const before = aimock.getRequests().length
      const stream = streamResolvedRoute({
        appRoot: options.appRoot,
        input: { messages: [{ role: "user", content: runOpts.input }] },
        routeFile: resolved.routeFile,
        routeId: resolved.routeId,
        routePath: resolved.routePath,
        threadId,
      })
      const result = await collectRunResult(stream, threadId)
      const turnReqs = aimock.getRequests().slice(before)
      return { ...result, systemPrompt: systemPromptFromRequests(turnReqs) }
    },
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/harness-fixtures.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/harness.ts packages/testing/test/harness-fixtures.test.ts
git commit -m "feat(testing): capture per-turn systemPrompt from the aimock journal"
```

---

## Task 4: `harness.resume({ decision })`

**Files:**
- Modify: `packages/testing/src/harness.ts`
- Test: covered by the HITL dogfood (Task 9); add a shape test here.

- [ ] **Step 1: Add the method to the `AgentHarness` interface**

```ts
export interface AgentHarness {
  readonly baseUrl: string
  run(opts: { input: string; fixtures?: FixtureSet | ScriptBuilder }): Promise<AgentRunResult>
  resume(opts: { decision: "once" | "always" | "deny"; fixtures?: FixtureSet | ScriptBuilder }): Promise<AgentRunResult>
  reset(): void
  close(): Promise<void>
}
```

- [ ] **Step 2: Implement `resume()`** (next to `run()`), factoring the journal+collect logic

Extract a shared helper inside `createAgentHarness` so `run` and `resume` share it:

```ts
    async function drive(streamInput: { input?: unknown; resumeDecision?: "once" | "always" | "deny" }) {
      const before = aimock.getRequests().length
      const stream = streamResolvedRoute({
        appRoot: options.appRoot,
        ...(streamInput.input !== undefined ? { input: streamInput.input } : {}),
        ...(streamInput.resumeDecision ? { resumeDecision: streamInput.resumeDecision } : {}),
        routeFile: resolved.routeFile,
        routeId: resolved.routeId,
        routePath: resolved.routePath,
        threadId,
      })
      const result = await collectRunResult(stream, threadId)
      const turnReqs = aimock.getRequests().slice(before)
      return { ...result, systemPrompt: systemPromptFromRequests(turnReqs) }
    }
```

Then:

```ts
    async run(runOpts) {
      if (runOpts.fixtures) {
        const f = toFixtureSet(runOpts.fixtures)
        if (f.length > 0) aimock.addFixtures(f)
      }
      return drive({ input: { messages: [{ role: "user", content: runOpts.input }] } })
    },
    async resume(resumeOpts) {
      if (resumeOpts.fixtures) {
        const f = toFixtureSet(resumeOpts.fixtures)
        if (f.length > 0) aimock.addFixtures(f)
      }
      return drive({ resumeDecision: resumeOpts.decision })
    },
```

(`drive` must be declared before the returned `harness` object — define it as a `const`/function in the closure above `const harness`.)

- [ ] **Step 3: Add a shape test** to `packages/testing/test/harness-fixtures.test.ts`

```ts
it("exposes a resume method", () => {
  expect(typeof h.resume).toBe("function")
})
```

- [ ] **Step 4: Validate**

Run: `pnpm --filter @dawn-ai/testing build && pnpm --filter @dawn-ai/testing exec vitest --run test/harness-fixtures.test.ts`
Expected: PASS. (Full resume behavior is exercised in Task 9.)

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/harness.ts packages/testing/test/harness-fixtures.test.ts
git commit -m "feat(testing): add harness.resume({decision}) for HITL flows"
```

---

## Task 5: New matchers

**Files:**
- Modify: `packages/testing/src/matchers.ts`
- Modify: `packages/testing/src/index.ts`
- Test: `packages/testing/test/matchers.test.ts` (extend)

- [ ] **Step 1: Add failing tests** (append)

```ts
import { expectInterrupt, expectNoInterrupt, expectPlan, expectSubagent, expectSystemPrompt } from "../src/matchers.js"

const capRun = {
  ...base,
  interrupts: [{ interruptId: "perm-1", kind: "command", detail: { command: "rm -rf tmp" } }],
  planUpdates: [{ todos: [{ content: "Write spec", status: "completed" }] }],
  todos: [{ content: "Write spec", status: "completed" }],
  subagents: [{ name: "research", callId: "c1", toolCalls: [{ name: "webSearch", args: {} }], finalMessage: "found it" }],
  subagentEvents: [],
  systemPrompt: "You are helpful.\n# Skills\n- refunds",
} as unknown as import("../src/run-result.js").AgentRunResult

it("expectInterrupt ofKind + withDetail", () => {
  expectInterrupt(capRun).ofKind("command").withDetail({ command: "rm -rf tmp" })
  expect(() => expectInterrupt(capRun).ofKind("nope")).toThrow()
  expect(() => expectInterrupt({ ...capRun, interrupts: [] } as never)).toThrow()
})
it("expectNoInterrupt", () => {
  expectNoInterrupt({ ...capRun, interrupts: [] } as never)
  expect(() => expectNoInterrupt(capRun)).toThrow()
})
it("expectSubagent", () => {
  expectSubagent(capRun, "research").called()
  expectSubagent(capRun, "research").calledTool("webSearch")
  expectSubagent(capRun, "research").finalMessageContains("found")
  expect(() => expectSubagent(capRun, "missing").called()).toThrow()
})
it("expectPlan", () => {
  expectPlan(capRun).toHaveTodo("Write spec")
  expectPlan(capRun).toHaveStatus("Write spec", "completed")
  expect(() => expectPlan(capRun).toHaveStatus("Write spec", "pending")).toThrow()
})
it("expectSystemPrompt", () => {
  expectSystemPrompt(capRun).toContain("# Skills")
  expect(() => expectSystemPrompt(capRun).toContain("nope")).toThrow()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/matchers.test.ts`
Expected: FAIL — matchers not exported.

- [ ] **Step 3: Implement** (append to `matchers.ts`; reuse the existing `fail()` + `isSubset()` helpers already in the file)

```ts
export function expectInterrupt(run: AgentRunResult) {
  if (run.interrupts.length === 0) fail("expected at least one interrupt, got none")
  const chain = {
    ofKind(kind: string) {
      if (!run.interrupts.some((i) => i.kind === kind)) {
        fail(`expected an interrupt of kind "${kind}"; kinds: ${run.interrupts.map((i) => i.kind).join(", ")}`)
      }
      return chain
    },
    withDetail(partial: Record<string, unknown>) {
      if (!run.interrupts.some((i) => isSubset(partial, i.detail))) {
        fail(`expected an interrupt with detail ⊇ ${JSON.stringify(partial)}; got ${JSON.stringify(run.interrupts.map((i) => i.detail))}`)
      }
      return chain
    },
  }
  return chain
}

export function expectNoInterrupt(run: AgentRunResult): void {
  if (run.interrupts.length > 0) {
    fail(`expected no interrupts, got ${run.interrupts.length}: ${JSON.stringify(run.interrupts.map((i) => i.kind))}`)
  }
}

export function expectSubagent(run: AgentRunResult, name: string) {
  const sub = run.subagents.find((s) => s.name === name)
  return {
    called() {
      if (!sub) fail(`expected subagent "${name}" to be dispatched; subagents: ${run.subagents.map((s) => s.name).join(", ") || "(none)"}`)
    },
    calledTool(tool: string) {
      if (!sub) fail(`expected subagent "${name}" (not dispatched)`)
      if (!sub.toolCalls.some((t) => t.name === tool)) fail(`expected subagent "${name}" to call "${tool}"; called: ${sub.toolCalls.map((t) => t.name).join(", ") || "(none)"}`)
    },
    finalMessageContains(s: string) {
      if (!sub) fail(`expected subagent "${name}" (not dispatched)`)
      if (!(sub.finalMessage ?? "").includes(s)) fail(`expected subagent "${name}" final message to contain ${JSON.stringify(s)}; got ${JSON.stringify(sub.finalMessage)}`)
    },
  }
}

export function expectPlan(run: AgentRunResult) {
  const todos = run.todos
  return {
    toHaveTodo(content: string) {
      if (!todos.some((t) => t.content.includes(content))) fail(`expected a todo containing ${JSON.stringify(content)}; todos: ${JSON.stringify(todos)}`)
    },
    toHaveStatus(content: string, status: string) {
      const t = todos.find((td) => td.content.includes(content))
      if (!t) fail(`no todo containing ${JSON.stringify(content)}; todos: ${JSON.stringify(todos)}`)
      else if (t.status !== status) fail(`expected todo ${JSON.stringify(content)} status ${status}, got ${t.status}`)
    },
    toHaveLength(n: number) {
      if (todos.length !== n) fail(`expected ${n} todos, got ${todos.length}`)
    },
  }
}

export function expectSystemPrompt(run: AgentRunResult) {
  return {
    toContain(s: string) {
      if (!run.systemPrompt.includes(s)) fail(`system prompt does not contain ${JSON.stringify(s)}; prompt starts: ${JSON.stringify(run.systemPrompt.slice(0, 200))}`)
    },
    toMatch(re: RegExp) {
      if (!re.test(run.systemPrompt)) fail(`system prompt does not match ${re}`)
    },
  }
}
```

Add to `packages/testing/src/index.ts` (with the other matcher exports):

```ts
export {
  expectInterrupt,
  expectNoInterrupt,
  expectPlan,
  expectSubagent,
  expectSystemPrompt,
} from "./matchers.js"
```

Also export the new types from the barrel (alongside the existing run-result exports):

```ts
export type { InterruptInfo, SubagentRun, SubagentEvent, Todo } from "./run-result.js"
```

- [ ] **Step 4: Run to verify it passes + full package suite**

Run:
```
pnpm --filter @dawn-ai/testing exec vitest --run test/matchers.test.ts
pnpm --filter @dawn-ai/testing build && pnpm --filter @dawn-ai/testing typecheck && pnpm --filter @dawn-ai/testing lint && pnpm --filter @dawn-ai/testing test
```
Expected: all green. `biome check --write` if formatting flagged.

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/matchers.ts packages/testing/src/index.ts packages/testing/test/matchers.test.ts
git commit -m "feat(testing): capability matchers (interrupt/subagent/plan/systemPrompt)"
```

---

## Task 6: Dogfood — Memory scenario

**Files:**
- Create: `examples/chat/server/test/capabilities.e2e.test.ts`
- Test: itself.

Co-located with the chat example. Each scenario creates its own harness with try/finally close (the chat app has all capabilities; per-scenario harnesses keep threads isolated).

- [ ] **Step 1: Write the scenario**

```ts
// examples/chat/server/test/capabilities.e2e.test.ts
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { createAgentHarness, expectSystemPrompt, script } from "@dawn-ai/testing"

const appRoot = fileURLToPath(new URL("..", import.meta.url))

it("memory: AGENTS.md is injected into the system prompt", async () => {
  const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
  try {
    const run = await h.run({ input: "hello", fixtures: script().user("hello").replies("hi") })
    expectSystemPrompt(run).toContain("Workspace memory") // a line from workspace/AGENTS.md
  } finally {
    await h.close()
  }
}, 60_000)
```

- [ ] **Step 2: Run to verify it passes**

Run: `pnpm --filter @dawn-example/chat-server exec vitest --run test/capabilities.e2e.test.ts -t memory`
Expected: PASS (the workspace capability injects `workspace/AGENTS.md`; its content includes "Workspace memory"). If the exact injected text differs, open `examples/chat/server/workspace/AGENTS.md`, pick a stable line actually present, and assert on that.

- [ ] **Step 3: False-green check**

Temporarily rename `examples/chat/server/workspace/AGENTS.md` → `AGENTS.md.bak`, re-run, confirm the test FAILS (no memory injected), then restore. Report the result.

- [ ] **Step 4: Commit**

```bash
git add examples/chat/server/test/capabilities.e2e.test.ts
git commit -m "test(chat): dogfood AGENTS.md memory injection via @dawn-ai/testing"
```

---

## Task 7: Dogfood — Skills scenario

**Files:**
- Modify: `examples/chat/server/test/capabilities.e2e.test.ts`

- [ ] **Step 1: Add the scenario**

```ts
import { expectToolCalled } from "@dawn-ai/testing"

it("skills: the skills list is in the prompt and readSkill is callable", async () => {
  const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
  try {
    const run = await h.run({
      input: "recover from the failure",
      fixtures: script()
        .user("recover from the failure")
        .callsTool("readSkill", { name: "recover-from-failure" })
        .replies("Recovered."),
    })
    expectSystemPrompt(run).toContain("# Skills")
    expectToolCalled(run, "readSkill").withArgs({ name: "recover-from-failure" })
  } finally {
    await h.close()
  }
}, 60_000)
```

- [ ] **Step 2: Run + verify**

Run: `pnpm --filter @dawn-example/chat-server exec vitest --run test/capabilities.e2e.test.ts -t skills`
Expected: PASS. If the skills prompt heading differs from `# Skills` or the tool name/arg differs (check `examples/chat/server/src/app/chat/skills/` dir names + the skills capability's tool name `readSkill`), adjust to the real values.

- [ ] **Step 3: Commit**

```bash
git add examples/chat/server/test/capabilities.e2e.test.ts
git commit -m "test(chat): dogfood skills prompt injection + readSkill via @dawn-ai/testing"
```

---

## Task 8: Dogfood — Planning scenario

**Files:**
- Modify: `examples/chat/server/test/capabilities.e2e.test.ts`

- [ ] **Step 1: Add the scenario**

```ts
import { expectPlan } from "@dawn-ai/testing"

it("planning: writeTodos surfaces a plan_update", async () => {
  const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
  try {
    const run = await h.run({
      input: "plan the work",
      fixtures: script()
        .user("plan the work")
        .callsTool("writeTodos", { todos: [{ content: "Draft the outline", status: "in_progress" }] })
        .replies("Planned."),
    })
    expectPlan(run).toHaveTodo("Draft the outline")
    expectPlan(run).toHaveStatus("Draft the outline", "in_progress")
  } finally {
    await h.close()
  }
}, 60_000)
```

- [ ] **Step 2: Run + verify**

Run: `pnpm --filter @dawn-example/chat-server exec vitest --run test/capabilities.e2e.test.ts -t planning`
Expected: PASS. Verify the `writeTodos` tool name + arg shape against the planning capability (`packages/core/src/capabilities/built-in/planning.ts`); the `writeTodos` tool takes `{ todos: [{content, status}] }`. If the tool requires the chat app's `plan.md` to be present to be contributed, it is (the chat route has `plan.md`).

- [ ] **Step 3: False-green check**

Temporarily change the fixture's `writeTodos` content to a different string, re-run, confirm `expectPlan().toHaveTodo("Draft the outline")` FAILS, then revert.

- [ ] **Step 4: Commit**

```bash
git add examples/chat/server/test/capabilities.e2e.test.ts
git commit -m "test(chat): dogfood planning plan_update via @dawn-ai/testing"
```

---

## Task 9: Dogfood — HITL permissions scenario (interrupt → resume)

**Files:**
- Modify: `examples/chat/server/test/capabilities.e2e.test.ts`

- [ ] **Step 1: Confirm the permissions interrupt envelope**

Read `packages/permissions/src/*` + the workspace `runBash` capability to confirm the interrupt `kind` (e.g. `"command"`) and `detail` shape (e.g. `{ command, suggestedPattern }`) emitted when a non-allow-listed bash command runs. Note the exact values to assert. The chat `dawn.config.ts` allows `["ls","pwd","cat","echo","head","tail","wc"]` and denies `["rm -rf","sudo","chmod 777"]`; a command like `npm view react version` is neither → triggers an interactive permission interrupt (mode defaults to `interactive`).

- [ ] **Step 2: Write the scenario**

```ts
import { expectInterrupt, expectNoInterrupt } from "@dawn-ai/testing"

it("permissions: a non-allow-listed command interrupts, then resumes on approval", async () => {
  const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
  try {
    const run = await h.run({
      input: "what version of react is published?",
      fixtures: script()
        .user("what version of react is published?")
        .callsTool("runBash", { command: "npm view react version" })
        .replies("React is at that version."),
    })
    expectInterrupt(run).ofKind("command").withDetail({ command: "npm view react version" })

    const resumed = await h.resume({ decision: "once" })
    expectToolCalled(resumed, "runBash")
    expect(resumed.finalMessage.length).toBeGreaterThan(0)
  } finally {
    await h.close()
  }
}, 90_000)

it("permissions: an allow-listed command runs without interrupt", async () => {
  const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
  try {
    const run = await h.run({
      input: "list the files",
      fixtures: script().user("list the files").callsTool("runBash", { command: "ls" }).replies("Listed."),
    })
    expectNoInterrupt(run)
    expectToolCalled(run, "runBash")
  } finally {
    await h.close()
  }
}, 90_000)
```

- [ ] **Step 3: Run + verify**

Run: `pnpm --filter @dawn-example/chat-server exec vitest --run test/capabilities.e2e.test.ts -t permissions`
Expected: both PASS. Adjust the `runBash` tool name + `detail`/`kind` assertions to the real envelope confirmed in Step 1 (the `command` arg key may be `cmd` — verify the workspace `runBash` tool's input field name and use it consistently in the fixture + `withDetail`). If `mode` isn't `interactive` by default in the chat app and no interrupt fires, set `DAWN_PERMISSIONS_MODE=interactive` in the harness env via the app config (the chat config default applies).

- [ ] **Step 4: False-green check**

Change the resume decision test: temporarily assert `expectNoInterrupt(run)` on the non-allow-listed run — confirm it FAILS (an interrupt WAS raised), then revert. Confirms the interrupt is real, not absent.

- [ ] **Step 5: Commit**

```bash
git add examples/chat/server/test/capabilities.e2e.test.ts
git commit -m "test(chat): dogfood HITL permission interrupt + resume via @dawn-ai/testing"
```

---

## Task 10: Dogfood — Subagents scenario

**Files:**
- Modify: `examples/chat/server/test/capabilities.e2e.test.ts`

- [ ] **Step 1: Confirm the coordinator route + task tool**

Read `examples/chat/server/src/app/coordinator/index.ts` + `subagents/research`. Confirm the route key (`/coordinator#agent`), the `task` tool name, and its input shape (`{ subagent, input }` or similar — check `packages/langchain/src/subagent-tool-bridge.ts` / the generated task tool). Note the child route's model/tools so the child fixture can be scripted (the child makes its own model call → needs a matching fixture).

- [ ] **Step 2: Write the scenario**

```ts
import { expectSubagent } from "@dawn-ai/testing"

it("subagents: coordinator dispatches the research subagent", async () => {
  const h = await createAgentHarness({ appRoot, route: "/coordinator#agent" })
  try {
    const run = await h.run({
      input: "research the topic and summarize",
      fixtures: script()
        // parent turn 0: dispatch the research subagent
        .user("research the topic and summarize")
        .callsTool("task", { subagent: "research", input: "the topic" })
        // parent turn 1 (after subagent result): final synthesis
        .replies("Here is the summary.")
        // child (research) turn: its own user message is the task input
        .user("the topic")
        .replies("Research findings: X, Y, Z."),
    })
    expectSubagent(run, "research").called()
    expectSubagent(run, "research").finalMessageContains("Research findings")
  } finally {
    await h.close()
  }
}, 120_000)
```

- [ ] **Step 3: Run + verify**

Run: `pnpm --filter @dawn-example/chat-server exec vitest --run test/capabilities.e2e.test.ts -t subagents`
Expected: PASS. The `task` tool input keys (`subagent`/`input`) and the child's user-message content (how the child turn is seeded) must match reality — confirm in Step 1 and adjust the fixture. The child fixture matches by its own user-message substring ("the topic").

- [ ] **Step 4: FALLBACK (if Step 3 can't be made deterministic)**

If the coordinator's child dispatch can't be scripted reliably via aimock (e.g. the child user message isn't a stable substring), create a dedicated minimal probe app under `packages/testing/test/fixtures/coordinator-probe/` with a parent route + one trivial subagent, script it deterministically, and run the scenario against that instead. Note in the commit that the real coordinator fell back to a probe app and why.

- [ ] **Step 5: False-green check**

Temporarily change the parent fixture to NOT call `task` (just `.replies(...)`), re-run, confirm `expectSubagent(run,"research").called()` FAILS, then revert.

- [ ] **Step 6: Commit**

```bash
git add examples/chat/server/test/capabilities.e2e.test.ts packages/testing/test/fixtures 2>/dev/null
git commit -m "test(chat): dogfood subagent dispatch via @dawn-ai/testing"
```

---

## Task 11: Wire into CI, validate, changeset, PR

**Files:**
- Create: `.changeset/testing-capability-coverage.md`
- Possibly modify: `examples/chat/server/package.json` (ensure the `test` script picks up `test/*.e2e.test.ts`).

- [ ] **Step 1: Confirm the example's test lane runs the new file**

Check `examples/chat/server/package.json` `test` script + any `vitest.config`. Ensure `test/capabilities.e2e.test.ts` is included by the glob. Confirm the example's tests run in CI (`turbo run test` includes `@dawn-example/chat-server`). If the example isn't in the CI test set, add it (mirror how the package tests are wired). Report what you found.

- [ ] **Step 2: Write the changeset**

```md
---
"@dawn-ai/testing": minor
---

Extend `@dawn-ai/testing` to cover the rest of Dawn's agent capabilities. `AgentRunResult` now captures interrupts, plan updates, subagent runs, and the composed system prompt (read from aimock's request journal); `harness.resume({ decision })` drives HITL interrupt→resume flows. New matchers: `expectInterrupt`/`expectNoInterrupt`, `expectSubagent`, `expectPlan`, `expectSystemPrompt`. Dawn's own example app is dogfooded with in-process e2e for HITL permissions, subagents, planning, skills, and AGENTS.md memory. No framework changes — all capability events were already emitted by the runtime.
```

- [ ] **Step 3: Full validation**

Run:
```
pnpm -r --filter "@dawn-ai/*" build
pnpm --filter @dawn-ai/testing typecheck && pnpm --filter @dawn-ai/testing lint && pnpm --filter @dawn-ai/testing test
pnpm --filter @dawn-example/chat-server exec vitest --run test/capabilities.e2e.test.ts
```
Expected: all green (5 capability scenarios + the permissions allow-listed case). Revert the `apps/web/next-env.d.ts` churn if it appears.

- [ ] **Step 4: Commit, push, PR, auto-merge**

```bash
git add .changeset/testing-capability-coverage.md examples/chat/server/package.json 2>/dev/null
git commit -m "chore: changeset for @dawn-ai/testing capability coverage"
git push -u origin feat/testing-capability-coverage
gh pr create --title "feat(testing): capability coverage (HITL/subagents/planning/skills/memory) + harness extensions" --body-file <(printf '%s\n' "Extends @dawn-ai/testing to capture interrupts/plan/subagent/systemPrompt + harness.resume(); dogfoods all five Phase-3 capabilities in-process against the chat example. No framework changes. Spec: docs/superpowers/specs/2026-06-06-testing-capability-coverage-design.md" "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)") --base main --head feat/testing-capability-coverage
gh pr merge --auto --squash
```

- [ ] **Step 5: Update phase memory**

Append a note to `memory/project_phase_status.md` recording the capability-coverage increment (matchers + resume + systemPrompt-via-journal; five capabilities dogfooded; real-model/drift still deferred).

---

## Self-review notes (for the executor)

- **Type consistency:** `InterruptInfo`/`Todo`/`SubagentRun`/`SubagentEvent` defined in Task 2 are used by the matchers (Task 5) and exported in Task 5. `AgentRunResult.systemPrompt` defaults to `""` in `collectRunResult` (Task 2) and is overridden by the harness (Tasks 3–4). The harness `drive()` helper (Task 4) supersedes the `run()` body from Task 3 — implement Task 3's systemPrompt logic, then refactor into `drive()` in Task 4 (both share `systemPromptFromRequests`).
- **Real-value verification:** Tasks 6–10 assert against the real chat/coordinator apps. The exact strings (AGENTS.md line, `# Skills` heading, `writeTodos`/`runBash`/`readSkill`/`task` tool names + arg keys, interrupt `kind`/`detail`, child user-message seeding) MUST be confirmed against the actual app/capability source before finalizing each assertion — each task says where to look. Prefer reading the source over guessing.
- **Determinism:** every dogfood scenario scripts the model via `script()`; tools run for real. The subagent scenario is the riskiest (child fixture matching) — Task 10 has a probe-app fallback.
- **No framework changes:** if any scenario seems to "need" a runtime change, stop and reconsider — the spec asserts the runtime already emits everything; the gap is only in the harness/observability layer.
