# Agent Protocol Durable Interrupt Honesty (Reattach PR1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship slice 1 of `docs/superpowers/specs/2026-08-09-ap-stream-reattach-design.md` — the checkpoint-backed half of stream reattachment, with no in-memory hub and no attach endpoint. Three observable outcomes: (1) the `__interrupt__` write's payload is no longer discarded during parsing, (2) a new `GET /threads/{thread_id}/pending_interrupts` endpoint lets a reconnecting client re-render a parked permission prompt from durable state alone, and (3) a turn that parked on a human-in-the-loop interrupt reports thread status `"interrupted"` instead of `"idle"` from **both** streaming handlers. Today a parked thread is indistinguishable from a finished one — the agent is waiting on the human and the human's UI says the agent is done. That is the bug this slice closes.

**Architecture:** Everything here is checkpoint-backed and stateless. `packages/cli/src/lib/dev/pending-interrupts.ts` gains a pure `parsePendingInterrupts(tuple)` (split out of `readPendingInterrupts`, which becomes `getTuple` + parse) and an **optional** `value` field on `PendingInterrupt` carrying the interrupt write's payload verbatim — optional because `PendingInterrupt` is re-exported on the public `@dawn-ai/cli/runtime` subpath and a required field would break external code that constructs the literal. `packages/cli/src/lib/dev/runtime-fetch-core.ts` gains one new route entry and one new handler, `handleApPendingInterruptsRequest`, which resolves the thread first (404 `thread_not_found`), then resolves route identity from the same `threadRouteMap ?? thread metadata` precedence `POST /resume` already uses (409 `thread_route_unknown` when unresolvable — fail closed, because the endpoint exposes interrupt payloads and must be gated exactly like the run endpoints that produced them), then runs standard AP middleware with `method: "GET"`, then reads the pending interrupts. Thread-first means thread *existence* is observable before middleware runs; that matches `POST /resume` (which answers 404 at `runtime-fetch-core.ts:1665`, well before its `runMiddleware` at 1721) and is what spec §1 mandates — the payloads themselves stay behind the gate. Parked-status honesty is a plain `let sawInterrupt = false` inside each streaming handler, set when a `StreamChunk` with `type === "interrupt"` passes through the loop — deliberately the handler's own flag and not shared state, so PR2's `LiveTurnHub` is not a prerequisite for any of this. `RunRegistry`, the checkpointer savers, storage packages, and AG-UI are untouched.

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes: true`), Node 24, pnpm 10 workspace, vitest, biome (formatter: 100 cols, double quotes, no semicolons; `correctness/noUnusedVariables` and `noUnusedImports` are **errors** — never write a helper or import one task before its first use), changesets (fixed 0.x group across 21 packages — **patch only**).

---

## File Structure

| File | Create / Modify | Single responsibility |
|---|---|---|
| `packages/cli/src/lib/dev/pending-interrupts.ts` | Modify | Parse `__interrupt__` pending writes; now also surfaces each write's `value` payload, and exposes the pure tuple-parse separately from the `getTuple` that feeds it. |
| `packages/cli/src/lib/dev/runtime-fetch-core.ts` | Modify | Route table + AP handlers; gains the `GET /threads/:thread_id/pending_interrupts` route and handler, plus the saw-interrupt status flag in the run-stream and resume handlers. |
| `packages/cli/test/pending-interrupts.test.ts` | Modify | Unit pins for the parse: existing exact-shape assertions gain `value`; new cases for payload passthrough and the pure parse entry point. |
| `packages/cli/test/pending-interrupts-endpoint.test.ts` | Create | Integration pins for the new endpoint (404 / empty / payload / malformed / route-unknown / middleware gating), parked-vs-cancelled thread status across both streaming handlers, and a postgres-checkpointer lane. |
| `.github/workflows/ci.yml` | Modify | Run the new file's postgres-gated lane in the existing `postgres-storage-docker` job. |
| `apps/web/content/docs/dev-server.mdx` | Modify | Endpoint reference: corrected endpoint-count sentence, new `pending_interrupts` tab, corrected middleware coverage sentence, and the `"interrupted"` disambiguation note (including the `/runs/wait` exception). |
| `.changeset/ap-pending-interrupts.md` | Create | Patch changeset carrying the observable-behavior callouts. |

**Line numbers in this plan are for each file as it stands _before_ this plan's first edit to it.** Earlier steps shift them — Task 2 Step 1 adds one line to the unit test, Task 3 adds ~60 lines to `runtime-fetch-core.ts` above the handlers Task 5 edits. The **quoted code and its exact indentation** is the authoritative anchor in every step; treat the numbers as a place to start looking.

**Not touched in this slice** (PR2/PR3 own them): `live-turn-hub.ts`, the `GET /runs/stream` attach endpoint, `stream-types.ts`, `dawn threads tail`, `packages/cli/src/runtime-exports.ts` (no new symbol is exported — `parsePendingInterrupts` stays internal, so `packages/cli/test/runtime-exports.test.ts` stays untouched), `handleApWaitRequest` (see the `/runs/wait` note below), and `packages/cli/test/resume-endpoint.test.ts`'s `reads > 1 ⇒ throw` checkpointer fixture (PR2's anchor read is what breaks that; PR1 adds no `getTuple` to the resume handler).

**Deliberately out of scope — `/runs/wait` parked status.** `handleApWaitRequest` writes `updateStatus(threadId, "idle")` unconditionally after a successful invoke, so a `/runs/wait` turn that parks still reports `"idle"`. Spec §4 scopes the status fix to the two **streaming** handlers, so that stays as it is. It is a real asymmetry, so it is called out in the docs and the changeset rather than silently left: on `/runs/wait`, use `pending_interrupts` to detect a park.

---

## Task 1: Environment and green baseline

No code changes. This task exists because the repo has a Node-version trap that makes unrelated tests fail and look like your fault, and because a git worktree starts with no `node_modules` at all.

**Files:** none (verification only)

- [ ] **Step 1: Select Node 24 — mandatory, not optional.** The default shell Node in this environment is **v22.14.0**, the repo pins `engines.node: ">=24.0.0"`, and roughly 8 `dawn verify` tests fail spuriously on Node 22. Run from the repo root:
  ```bash
  nvm use 24 && node -v
  ```
  Expect `v24.x.x`. If `nvm` is unavailable, install Node 24 by whatever means and confirm `node -v` before continuing. Every command in this plan assumes Node 24 in the shell.

- [ ] **Step 2: Confirm the working branch.** Subagent worktrees have landed commits on a detached HEAD before; check first.
  ```bash
  git -C /Users/blove/repos/dawn/.claude/worktrees/hopeful-feistel-06251a branch --show-current
  ```
  Expect `blove/agent-protocol-stream-reattach-eda3af`. If it prints nothing (detached HEAD), stop and re-attach the branch before writing any code.

- [ ] **Step 3: Install dependencies.** A fresh `git worktree` does **not** inherit the parent checkout's `node_modules`, and nothing builds without them: `pnpm build` fails with `Cannot find module '@langchain/langgraph'` / `'@dawn-ai/ag-ui/sse'`, and vitest fails with `Cannot find package '@dawn-ai/permissions/node'`. From the repo root:
  ```bash
  pnpm install --frozen-lockfile
  ```
  Expect a completed install with no lockfile mismatch. (If the worktree was already installed, this is a fast no-op — run it anyway.)

- [ ] **Step 4: Build the workspace.** `packages/cli/test/*.test.ts` import built artifacts from `packages/testing/dist/`, so tests fail with module-not-found unless the build ran.
  ```bash
  pnpm build
  ```
  Expect a successful turbo run across all packages.

- [ ] **Step 5: Record the green baseline for the suites this plan touches.**
  ```bash
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/pending-interrupts.test.ts test/run-cancellation.test.ts test/resume-endpoint.test.ts test/runtime-fetch-parity.test.ts test/subagent-interrupts.test.ts
  ```
  Expect all files passing. If anything is red here, it is pre-existing — investigate before layering changes on top.

---

## Task 2: Surface the interrupt payload in the pending-interrupt parse

`readPendingInterrupts` reads `write[2].value` only to pull `interruptId` out of it, then throws the object away. That object *is* the renderable permission prompt. Keep it, and split the pure parse from the read so PR2 can reuse one `getTuple` for values plus interrupts.

The new field is declared **optional** (`readonly value?: unknown`). `PendingInterrupt` is re-exported from `packages/cli/src/runtime-exports.ts` on the public `@dawn-ai/cli/runtime` subpath, so a required field is a compile break for any external caller that constructs the literal. Optional is a strict superset under `exactOptionalPropertyTypes`: the parse always writes the key (so `Object.hasOwn(i, "value")` is always true), and existing literals that omit it still compile.

**Files:**
- Modify: `packages/cli/test/pending-interrupts.test.ts` (imports at lines 13-20; exact-shape assertions at lines 172-186 and 197-206; new cases appended to the `readPendingInterrupts` describe block, which closes at line 274, and a new describe block before the standalone test at line 276)
- Modify: `packages/cli/src/lib/dev/pending-interrupts.ts` (line 1 import; interface at lines 11-15; function at lines 45-103)

The `pending()` helper at lines 308-310 of the test file needs **no** change — it omits `value`, and an optional field lets it keep compiling. That is the in-repo proof that the field is non-breaking.

Step 1 replaces an 8-line import block with a 9-line one, so every line number below it shifts by **+1** once that step lands. Match on the quoted code, not the number.

- [ ] **Step 1: Import the new parse entry point in the unit test.** In `packages/cli/test/pending-interrupts.test.ts`, replace the import block at lines 13-20 with:
  ```ts
  import {
    type DawnResumeEntry,
    parsePendingInterrupts,
    type PendingInterrupt,
    type PendingInterruptSnapshot,
    type PermissionDecision,
    readPendingInterrupts,
    resolvePendingResume,
  } from "../src/lib/dev/pending-interrupts.js"
  ```

- [ ] **Step 2: Add `value` to the two exact-shape assertions.** In the same file, replace the `resolves.toEqual({...})` body at lines 172-186 with:
  ```ts
      await expect(readPendingInterrupts(checkpointer, "thread-2")).resolves.toEqual({
        interrupts: [
          {
            aliases: ["perm-1", RESUME_KEY_1],
            interruptId: "perm-1",
            resumeKey: RESUME_KEY_1,
            value: { interruptId: "perm-1" },
          },
          {
            aliases: [RESUME_KEY_2],
            interruptId: RESUME_KEY_2,
            resumeKey: RESUME_KEY_2,
            value: { kind: "permission" },
          },
        ],
        malformed: false,
      })
  ```
  and the `expect(snapshot).toEqual({...})` body at lines 197-206 with:
  ```ts
      expect(snapshot).toEqual({
        interrupts: [
          {
            aliases: ["perm-1", "outer-ap-id"],
            interruptId: "perm-1",
            resumeKey: null,
            value: { interruptId: "perm-1" },
          },
        ],
        malformed: true,
      })
  ```
  Leave the `expect(resolvePendingResume(...))` assertion that follows at line 207 alone.

- [ ] **Step 3: Add the payload-passthrough cases.** Append these two tests inside the existing `describe("readPendingInterrupts", ...)` block (immediately before its closing `})` at line 274):
  ```ts
    test("surfaces the interrupt payload verbatim so a client can re-render the prompt", async () => {
      const snapshot = await readPendingInterrupts(
        fakeCheckpointer([
          [
            TASK_UUID_1,
            "__interrupt__",
            {
              id: RESUME_KEY_1,
              value: {
                detail: { suggestedPattern: "deployProd", toolName: "deployProd" },
                interruptId: "perm-1",
                kind: "tool",
                type: "permission-request",
              },
            },
          ],
        ]),
        "thread-payload",
      )

      expect(snapshot?.interrupts[0]?.value).toEqual({
        detail: { suggestedPattern: "deployProd", toolName: "deployProd" },
        interruptId: "perm-1",
        kind: "tool",
        type: "permission-request",
      })
    })

    test("reports an absent payload as undefined without marking the write malformed", async () => {
      const snapshot = await readPendingInterrupts(
        fakeCheckpointer([[TASK_UUID_1, "__interrupt__", { id: RESUME_KEY_1 }]]),
        "thread-no-payload",
      )

      // toStrictEqual, not toEqual: toEqual ignores undefined-valued keys, so it
      // would pass whether or not the parse sets `value` at all.
      expect(snapshot).toStrictEqual({
        interrupts: [
          {
            aliases: [RESUME_KEY_1],
            interruptId: RESUME_KEY_1,
            resumeKey: RESUME_KEY_1,
            value: undefined,
          },
        ],
        malformed: false,
      })
    })
  ```

- [ ] **Step 4: Add the pure-parse case.** Append this describe block to the same file, immediately after the `describe("readPendingInterrupts", ...)` block closes (after line 274, before the standalone `test("resumes a real LangGraph interrupt...")` at line 276):
  ```ts
  describe("parsePendingInterrupts", () => {
    test("parses a tuple the caller already holds, with no checkpointer read", () => {
      const tuple = {
        pendingWrites: [
          [TASK_UUID_1, "__interrupt__", { id: RESUME_KEY_1, value: { interruptId: "perm-1" } }],
        ],
      } as unknown as CheckpointTuple

      expect(parsePendingInterrupts(tuple)).toEqual({
        interrupts: [
          {
            aliases: ["perm-1", RESUME_KEY_1],
            interruptId: "perm-1",
            resumeKey: RESUME_KEY_1,
            value: { interruptId: "perm-1" },
          },
        ],
        malformed: false,
      })
    })
  })
  ```
  (`CheckpointTuple` is already imported at line 10 of this test file.)

- [ ] **Step 5: Run the test and watch it fail.**
  ```bash
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/pending-interrupts.test.ts
  ```
  Expected failure: the whole file errors at import time with `SyntaxError: [vite] The requested module '/…/src/lib/dev/pending-interrupts.ts' does not provide an export named 'parsePendingInterrupts'`. If you remove the new import to see past it, the `value:` assertions fail with `- Expected + Received … - "value": {"interruptId": "perm-1"}`.

- [ ] **Step 6: Widen the checkpoint type import.** In `packages/cli/src/lib/dev/pending-interrupts.ts`, replace line 1:
  ```ts
  import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph-checkpoint"
  ```

- [ ] **Step 7: Add `value` to the `PendingInterrupt` interface.** Replace lines 11-15 of the same file:
  ```ts
  export interface PendingInterrupt {
    readonly aliases: readonly string[]
    readonly interruptId: string
    readonly resumeKey: string | null
    /**
     * The `__interrupt__` write's own `value` payload, verbatim — for a
     * permission prompt, `{ interruptId, type, kind, detail }`. This is the
     * renderable content a client that reloaded needs to put the prompt back on
     * screen from durable state alone; parsing it for ids and then discarding it
     * is what made a parked prompt undisplayable after a reconnect. `undefined`
     * when the write carries no `value` key at all.
     *
     * Optional because this interface is public API (`@dawn-ai/cli/runtime`): a
     * required field would stop external code from constructing the literal. The
     * parse always sets the key, so `Object.hasOwn(i, "value")` is always true.
     */
    readonly value?: unknown
  }
  ```

- [ ] **Step 8: Split the parse from the read and keep the payload.** Replace the whole of `readPendingInterrupts` (lines 45-103 of the same file) with:
  ```ts
  /**
   * Parse the `__interrupt__` pending writes out of a checkpoint tuple the
   * caller already holds.
   *
   * Split out of `readPendingInterrupts` so a caller that needs the tuple for
   * something else too — channel values *and* pending interrupts — pays for one
   * `getTuple` instead of two. Pure: no I/O, no checkpointer.
   */
  export function parsePendingInterrupts(tuple: CheckpointTuple): PendingInterruptSnapshot {
    const interrupts: PendingInterrupt[] = []
    let malformed = false
    for (const write of tuple.pendingWrites ?? []) {
      if (!Array.isArray(write) || write[1] !== "__interrupt__") continue
      if (write.length < 3 || !isRecord(write[2])) {
        malformed = true
        continue
      }

      const value = write[2]
      const hasInnerValue = Object.hasOwn(value, "value")
      // Kept verbatim for GET /threads/:id/pending_interrupts: this is the
      // permission prompt a reconnecting client re-renders.
      const payload = hasInnerValue ? value.value : undefined
      const innerValue = isRecord(payload) ? payload : undefined
      if (hasInnerValue && !innerValue) malformed = true

      const rawInnerId = innerValue?.interruptId
      const innerId = asIdentifier(rawInnerId)
      if (rawInnerId !== undefined && !innerId) malformed = true

      const outerId = asIdentifier(value.id)
      const interruptId = innerId ?? outerId
      if (!interruptId) {
        malformed = true
        continue
      }

      const resumeKey = outerId && RESUME_KEY_PATTERN.test(outerId) ? outerId : null
      if (!resumeKey) malformed = true

      const aliases = innerId && outerId && innerId !== outerId ? [innerId, outerId] : [interruptId]
      interrupts.push({ aliases, interruptId, resumeKey, value: payload })
    }

    const interruptIds = new Set<string>()
    const resumeKeys = new Set<string>()
    const aliases = new Set<string>()
    for (const interrupt of interrupts) {
      if (interruptIds.has(interrupt.interruptId)) malformed = true
      interruptIds.add(interrupt.interruptId)
      if (interrupt.resumeKey) {
        if (resumeKeys.has(interrupt.resumeKey)) malformed = true
        resumeKeys.add(interrupt.resumeKey)
      }
      for (const alias of interrupt.aliases) {
        if (aliases.has(alias)) malformed = true
        aliases.add(alias)
      }
    }

    return { interrupts, malformed }
  }

  export async function readPendingInterrupts(
    checkpointer: BaseCheckpointSaver,
    threadId: string,
  ): Promise<PendingInterruptSnapshot | null> {
    const tuple = await checkpointer.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: "" },
    })
    if (!tuple) return null
    return parsePendingInterrupts(tuple)
  }
  ```

- [ ] **Step 9: Run the unit test and watch it pass.**
  ```bash
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/pending-interrupts.test.ts
  ```
  Expect all tests in the file passing.

- [ ] **Step 10: Prove the existing consumers still work.** `POST /resume`, the AG-UI resume validation, the subagent HITL suite, and `@dawn-ai/testing`'s harness all read this snapshot. The `@dawn-ai/cli` **build must run first**: `@dawn-ai/testing` consumes `readPendingInterrupts` through `packages/cli/dist`'s declaration files, so without a rebuild its typecheck would pass against the pre-change `.d.ts` and prove nothing.
  ```bash
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/resume-endpoint.test.ts test/subagent-interrupts.test.ts test/agui-endpoint.test.ts
  pnpm --filter @dawn-ai/cli build
  pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/testing typecheck
  ```
  Expect all green. Every in-repo consumer only *reads* `interruptId` / `resumeKey` (`packages/testing/src/harness.ts:161`, `packages/cli/src/lib/dev/agui-handler.ts:225`), and the only constructed literal is agui-handler's `{ interrupts: [], malformed: false }` empty snapshot, so nothing should move.

- [ ] **Step 11: Commit.**
  ```bash
  git add packages/cli/src/lib/dev/pending-interrupts.ts packages/cli/test/pending-interrupts.test.ts
  git commit -m "$(cat <<'EOF'
  feat(cli): surface interrupt payloads in the pending-interrupt parse

  The __interrupt__ write's `value` payload was read for its interruptId and
  then discarded, so nothing downstream could re-render a parked permission
  prompt. Keep it verbatim on PendingInterrupt as an optional field (the type is
  public API on @dawn-ai/cli/runtime), and split the pure tuple parse out of
  readPendingInterrupts so a caller that already holds a tuple does not pay for
  a second getTuple.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 3: `GET /threads/:thread_id/pending_interrupts` — thread resolution and payload

The endpoint's core contract: unknown thread → 404 `thread_not_found`; known thread with nothing parked → `200 {interrupts: []}`; parked thread → the interrupts with their payloads; a malformed pending-write set is still listed and `malformed` is never surfaced; `no-store` on the success response. Middleware gating lands in Task 4 (kept separate so each half has its own failing test).

**Files:**
- Create: `packages/cli/test/pending-interrupts-endpoint.test.ts`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (new route entry after the `GET /threads/:thread_id/state` entry, which closes with `    },` at line 1076; new handler inserted before line 1596)

Every helper in this file lands in the task that first uses it — biome's `correctness/noUnusedVariables` is an **error**, and TypeScript will not catch it first (`noUnusedLocals` is not set), so a helper written one task early reds `pnpm --filter @dawn-ai/cli lint`.

- [ ] **Step 1: Create the test file's fixtures and helpers.** Write `packages/cli/test/pending-interrupts-endpoint.test.ts` with exactly this content (tests are appended in later steps):
  ```ts
  import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
  import { tmpdir } from "node:os"
  import { dirname, join } from "node:path"
  import type { RunnableConfig } from "@langchain/core/runnables"
  import { MemorySaver } from "@langchain/langgraph"
  import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph-checkpoint"
  import { afterEach, describe, expect, it } from "vitest"
  import { createAimock } from "../../testing/dist/aimock-runner.js"
  import { script } from "../../testing/dist/fixture-builder.js"
  import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn()
  })

  // ---------------------------------------------------------------------------
  // Fixture routes
  // ---------------------------------------------------------------------------

  /** Plain graph route: completes immediately, never parks, never checkpoints. */
  const ECHO_ROUTE = ["export const graph = async () => ({ ok: true })", ""].join("\n")

  /** Blocking graph route (same shape as run-cancellation.test.ts): holds the
   * run slot until a release file appears, so a cancel can land mid-run. It
   * deliberately ignores ctx.signal and self-releases after 15s. */
  const BLOCKING_ROUTE = [
    'import { readFile, writeFile } from "node:fs/promises"',
    "export const graph = async (",
    "  input: { startedFile?: string; releaseFile?: string } | undefined,",
    "  _ctx: { signal: AbortSignal },",
    ") => {",
    "  if (input?.startedFile) await writeFile(input.startedFile, 'started')",
    "  const deadline = Date.now() + 15000",
    "  while (Date.now() < deadline) {",
    "    if (!input?.releaseFile) break",
    "    try { await readFile(input.releaseFile, 'utf8'); break } catch {}",
    "    await new Promise((r) => setTimeout(r, 25))",
    "  }",
    "  return { ok: true }",
    "}",
    "",
  ].join("\n")

  /** Agent route whose `deployProd` tool requires human approval, so the first
   * call to it parks the turn on a real checkpointer-backed HITL interrupt. */
  const PARK_ROUTE = [
    'import { agent } from "@dawn-ai/sdk"',
    "export default agent({",
    '  model: "gpt-5-mini",',
    '  systemPrompt: "You are a test agent. Use the provided tools when asked.",',
    '  tools: { approve: ["deployProd"] },',
    "})",
    "",
  ].join("\n")

  const DEPLOY_TOOL = [
    "/** Deploy to an environment. */",
    "export default async function deployProd(input: { env: string }): Promise<string> {",
    "  return 'deployed to ' + input.env",
    "}",
    "",
  ].join("\n")

  async function fixtureApp(overrides: Record<string, string> = {}): Promise<string> {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-pending-interrupts-"))
    cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
    const files: Record<string, string> = {
      "dawn.config.ts": "export default {}\n",
      "package.json": '{ "name": "pending-interrupts-fixture", "type": "module" }\n',
      "src/app/blocking/index.ts": BLOCKING_ROUTE,
      "src/app/echo/index.ts": ECHO_ROUTE,
      "src/app/park/index.ts": PARK_ROUTE,
      "src/app/park/tools/deployProd.ts": DEPLOY_TOOL,
      ...overrides,
    }
    for (const [rel, body] of Object.entries(files)) {
      const filePath = join(appRoot, rel)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, body, "utf8")
    }
    return appRoot
  }

  /** Point OPENAI_BASE_URL/OPENAI_API_KEY at a local aimock for this test,
   * restoring the previous env afterward. Call BEFORE creating the handler. */
  async function withAimock(fixtures: ReturnType<ReturnType<typeof script>["build"]>): Promise<void> {
    const aimock = await createAimock({ fixtures: [] })
    cleanup.push(() => aimock.close())
    const prevBaseUrl = process.env.OPENAI_BASE_URL
    const prevKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_BASE_URL = aimock.baseUrl
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
    cleanup.push(() => {
      if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = prevBaseUrl
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevKey
    })
    aimock.addFixtures(fixtures)
  }

  /** drainDeadlineMs keeps afterEach from waiting the 30s default when a test
   * deliberately abandons a still-running route; the long heartbeat interval
   * keeps asserted SSE text free of `: ping` frames. `checkpointer` is the seam
   * the malformed-write and postgres cases inject through. */
  async function createHandler(appRoot: string, checkpointer?: BaseCheckpointSaver) {
    const handler = await createRuntimeFetchHandler({
      appRoot,
      apSseHeartbeatIntervalMs: 60_000,
      drainDeadlineMs: 250,
      ...(checkpointer ? { checkpointer } : {}),
    })
    cleanup.push(() => handler.close())
    return handler
  }

  type Handler = Awaited<ReturnType<typeof createHandler>>

  // ---------------------------------------------------------------------------
  // Requests, readers, assertions
  // ---------------------------------------------------------------------------

  function runStreamRequest(
    threadId: string,
    route: string,
    input: unknown = {},
    headers: Record<string, string> = {},
  ): Request {
    return new Request(`http://localhost/threads/${threadId}/runs/stream`, {
      body: JSON.stringify({ input, route }),
      headers: { "content-type": "application/json", ...headers },
      method: "POST",
    })
  }

  function parkRunRequest(threadId: string, message: string): Request {
    return new Request(`http://localhost/threads/${threadId}/runs/stream`, {
      body: JSON.stringify({
        input: { messages: [{ content: message, role: "user" }] },
        route: "/park#agent",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  }

  function pendingInterruptsRequest(threadId: string, headers: Record<string, string> = {}): Request {
    return new Request(`http://localhost/threads/${threadId}/pending_interrupts`, { headers })
  }

  interface PendingInterruptsBody {
    readonly interrupts: ReadonlyArray<{
      readonly interruptId: string
      readonly resumeKey: string | null
      readonly value?: Record<string, unknown>
    }>
  }

  interface ErrorBody {
    readonly error: { readonly message: string; readonly details?: { readonly code?: string } }
  }

  async function readSseText(response: Response): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) return ""
    const decoder = new TextDecoder()
    let text = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text
      text += decoder.decode(value, { stream: true })
    }
  }

  async function drain(response: Response): Promise<void> {
    await readSseText(response)
  }

  async function readPendingInterruptsBody(
    handler: Handler,
    threadId: string,
  ): Promise<PendingInterruptsBody> {
    const response = await handler.fetch(pendingInterruptsRequest(threadId))
    expect(response.status).toBe(200)
    return (await response.json()) as PendingInterruptsBody
  }

  // ---------------------------------------------------------------------------
  // A checkpointer whose pending writes are unaddressable: the outer id is not a
  // 32-hex resume key, so the parse yields the interrupt AND sets `malformed`.
  // Scoped to one thread id, and armed only after the seeding run, so nothing
  // the run itself reads is ever handed a synthetic tuple.
  // ---------------------------------------------------------------------------

  const MALFORMED_THREAD_ID = "t-malformed"

  const MALFORMED_WRITE = [
    "33a12321-3ec2-56a7-b4d7-0337886c4386",
    "__interrupt__",
    { id: "not-a-resume-key", value: { interruptId: "perm-malformed" } },
  ]

  class MalformedPendingWritesSaver extends MemorySaver {
    /** Flipped on only after the seeding run, so nothing the run itself reads is
     * ever handed a synthetic tuple. */
    armed = false

    override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
      const tuple = await super.getTuple(config)
      if (!this.armed || config.configurable?.thread_id !== MALFORMED_THREAD_ID) return tuple
      return { ...tuple, config, pendingWrites: [MALFORMED_WRITE] } as unknown as CheckpointTuple
    }
  }
  ```

- [ ] **Step 2: Append the core-contract tests.** Add this block to the end of `packages/cli/test/pending-interrupts-endpoint.test.ts`:
  ```ts
  describe("GET /threads/:thread_id/pending_interrupts", () => {
    it("returns 404 thread_not_found for a thread that does not exist", async () => {
      const handler = await createHandler(await fixtureApp())

      const response = await handler.fetch(pendingInterruptsRequest("t-missing"))

      expect(response.status).toBe(404)
      const body = (await response.json()) as ErrorBody
      expect(body.error.details?.code).toBe("thread_not_found")
    })

    it("returns an empty list for a thread that ran without parking", async () => {
      const handler = await createHandler(await fixtureApp())
      const threadId = "t-no-interrupts"
      await drain(await handler.fetch(runStreamRequest(threadId, "/echo#graph")))

      const response = await handler.fetch(pendingInterruptsRequest(threadId))

      expect(response.status).toBe(200)
      // Checkpoint state changes under the client; a cached answer would show a
      // prompt that has already been resolved.
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(await response.json()).toEqual({ interrupts: [] })
    }, 30_000)

    it("returns the parked interrupt with the payload that renders its prompt", async () => {
      await withAimock(
        script().user("deploy to staging").callsTool("deployProd", { env: "staging" }).build(),
      )
      const handler = await createHandler(await fixtureApp())
      const threadId = "t-parked-payload"

      const text = await readSseText(
        await handler.fetch(parkRunRequest(threadId, "deploy to staging")),
      )
      expect(text).toContain("event: interrupt")

      const body = await readPendingInterruptsBody(handler, threadId)

      expect(body.interrupts).toHaveLength(1)
      const [parked] = body.interrupts
      expect(parked?.interruptId).toMatch(/^perm-/)
      expect(parked?.resumeKey).toMatch(/^[0-9a-f]{32}$/)
      // The whole point of the endpoint: everything a reloaded UI needs to put
      // the permission prompt back on screen, with no live stream.
      expect(parked?.value).toMatchObject({
        detail: { toolName: "deployProd" },
        interruptId: parked?.interruptId,
        kind: "tool",
        type: "permission-request",
      })
    }, 60_000)

    it("lists a malformed pending write and never surfaces the malformed flag", async () => {
      const saver = new MalformedPendingWritesSaver()
      const handler = await createHandler(await fixtureApp(), saver)
      await drain(await handler.fetch(runStreamRequest(MALFORMED_THREAD_ID, "/echo#graph")))
      saver.armed = true

      const response = await handler.fetch(pendingInterruptsRequest(MALFORMED_THREAD_ID))

      expect(response.status).toBe(200)
      // Reported, not withheld: this endpoint says what is parked. POST /resume
      // is the surface that refuses to act on writes it cannot address safely
      // (malformed_checkpoint), and `malformed` is not part of this contract.
      expect(await response.json()).toEqual({
        interrupts: [
          {
            interruptId: "perm-malformed",
            resumeKey: null,
            value: { interruptId: "perm-malformed" },
          },
        ],
      })
    }, 30_000)
  })
  ```

- [ ] **Step 3: Run the new test file and watch it fail.**
  ```bash
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/pending-interrupts-endpoint.test.ts
  ```
  Expected failure: no route matches the path, so the dispatcher's catch-all replies `404 {"error":{"kind":"request_error","message":"Not found"}}`. The first test fails with `AssertionError: expected undefined to be 'thread_not_found'`, and the other three fail with `expected 404 to be 200`.

- [ ] **Step 4: Add the handler.** In `packages/cli/src/lib/dev/runtime-fetch-core.ts`, insert this function **before line 1596** — the opening `// ---------------------------------------------------------------------------` rule of the Resume handler banner, whose three lines are:
  ```ts
  // ---------------------------------------------------------------------------
  // Resume handler — state-based, reads __interrupt__ from SQLite checkpoint
  // ---------------------------------------------------------------------------
  ```
  Do not split that banner. The new code goes above it, after the blank line that follows the run-stream handler's closing `}` at line 1594:
  ```ts
  // ---------------------------------------------------------------------------
  // AP pending-interrupts handler — durable HITL prompts for a reconnected client
  // ---------------------------------------------------------------------------

  async function handleApPendingInterruptsRequest(options: {
    readonly checkpointer: BaseCheckpointSaver
    readonly threadId: string
    readonly threadsStore: ThreadsStore
  }): Promise<Response> {
    const { checkpointer, threadId, threadsStore } = options

    // Thread first, with the same code POST /cancel and POST /resume use for an
    // unknown thread, so a client branches on one code across the AP surface.
    // Thread existence is therefore observable BEFORE any middleware runs — the
    // same as POST /resume, which answers 404 long before it calls
    // runMiddleware. Deliberate, and fixed by §1 of the spec; the interrupt
    // payloads themselves stay behind the gate added in the next task.
    const thread = await threadsStore.getThread(threadId)
    if (!thread) {
      return Response.json(createRequestErrorBody("Thread not found", { code: "thread_not_found" }), {
        status: 404,
      })
    }

    // A known thread with no checkpoint has nothing parked. That is a 200 with an
    // empty list, not a 404: "no such thread" and "nothing pending" are different
    // answers and a reconnecting client acts on them differently.
    //
    // A malformed pending-write set is still listed — this endpoint reports what
    // is parked, and POST /resume is the surface that refuses to act on writes it
    // cannot address safely (malformed_checkpoint).
    const snapshot = await readPendingInterrupts(checkpointer, threadId)
    const interrupts = (snapshot?.interrupts ?? []).map(({ interruptId, resumeKey, value }) => ({
      interruptId,
      resumeKey,
      value,
    }))
    return Response.json(
      { interrupts },
      // Checkpoint state changes under the client; a cached answer would show a
      // prompt that has already been resolved.
      { headers: { "cache-control": "no-store" }, status: 200 },
    )
  }
  ```

- [ ] **Step 5: Register the route.** In the same file, insert this entry into the array returned by `buildRouteTable`, immediately after the `GET /threads/:thread_id/state` entry (which closes with `    },` at line 1076) and before the `// POST /threads/:thread_id/resume` banner:
  ```ts
      // ------------------------------------------------------------------
      // GET /threads/:thread_id/pending_interrupts — durable HITL prompts
      // ------------------------------------------------------------------
      // Not a collision with GET /threads/:thread_id: that pattern's
      // [^/?#]+ capture cannot span a slash. Dispatch filters on method first,
      // so sharing a path prefix with the POST endpoints is safe too.
      {
        handle: async (request, params) =>
          handleApPendingInterruptsRequest({
            checkpointer: getCheckpointer(request),
            threadId: params.thread_id ?? "",
            threadsStore: getThreadsStore(request),
          }),
        method: "GET",
        pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/pending_interrupts(?:\?.*)?$/,
      },
  ```

- [ ] **Step 6: Run the test and watch it pass.**
  ```bash
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/pending-interrupts-endpoint.test.ts
  ```
  Expect the four tests passing. If the parked test fails with an aimock fixture-matching error, print `text` from the SSE read — the `userMessage` in the script must match the `content` sent in `parkRunRequest` exactly.

- [ ] **Step 7: Typecheck and lint the package.**
  ```bash
  pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint
  ```
  Expect both clean. **Never** run bare `biome check --write` — it mass-reformats the repo; use `pnpm lint:fix` if formatting needs fixing.

- [ ] **Step 8: Commit.**
  ```bash
  git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/pending-interrupts-endpoint.test.ts
  git commit -m "$(cat <<'EOF'
  feat(cli): add the Agent Protocol pending-interrupts endpoint

  GET /threads/:thread_id/pending_interrupts returns the human-in-the-loop
  interrupts parked on a thread together with each interrupt's payload, so a
  client that reloaded can re-render a permission prompt from durable state
  alone. An unknown thread is 404 thread_not_found, matching POST /cancel and
  POST /resume; a known thread with nothing parked is 200 with an empty list; a
  pending write the parse cannot address is still listed, because refusing to
  act on it is POST /resume's job. The response is no-store because checkpoint
  state moves under the client.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 4: Gate the endpoint on route middleware

The endpoint hands back interrupt payloads, so it must be gated exactly like the run endpoints that produced them. Route identity comes from the same precedence `POST /resume` uses, minus the body fallback a GET cannot have. A thread with no resolvable route has never run and is refused rather than served ungated.

The gating test has to prove the fixture middleware **loaded** before it can read anything into a 200: `loadMiddleware` (`packages/cli/src/lib/dev/middleware.ts:37-47`) swallows every import error and returns `undefined`, so a middleware that failed to load produces 200s indistinguishable from a handler that never calls `runMiddleware`. The first assertion is therefore a `POST /runs/stream` **without** the header expecting 403 with the echoed request, and the seeding run then proves the allow path — which is also spec test-strategy item 10 ("rejects/allows identically to the POST stream").

The `@dawn-ai/sdk`-importing middleware form below is verified to load through the dynamic probe from a tmpdir fixture under this vitest config (the specifier resolves through the `@dawn-ai/sdk` alias in `packages/cli/vitest.config.ts`; `packages/cli/test/static-middleware.test.ts:34` writes the same form into a tmpdir fixture). Keep the `POST` assertions anyway — they are what turns a load failure into a legible error instead of a false pass.

**Files:**
- Modify: `packages/cli/test/pending-interrupts-endpoint.test.ts` (append the middleware fixture and a describe block)
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (`handleApPendingInterruptsRequest` options + body; its route entry)

- [ ] **Step 1: Append the middleware fixture and the gating tests.** Add to the end of `packages/cli/test/pending-interrupts-endpoint.test.ts`:
  ```ts
  /** Rejects unless `x-allow` is present, echoing what it observed so a test can
   * pin the middleware inputs a body-less GET produces. */
  const ECHO_MIDDLEWARE = [
    'import { allow, defineMiddleware, reject } from "@dawn-ai/sdk"',
    "export default defineMiddleware((req) =>",
    '  req.headers["x-allow"] ? allow() : reject(403, { method: req.method, routeId: req.routeId }),',
    ")",
    "",
  ].join("\n")

  describe("GET /threads/:thread_id/pending_interrupts — gating", () => {
    it("refuses a thread that has never run with 409 thread_route_unknown", async () => {
      const handler = await createHandler(await fixtureApp())
      const created = await handler.fetch(new Request("http://localhost/threads", { method: "POST" }))
      const { thread_id: threadId } = (await created.json()) as { thread_id: string }

      const response = await handler.fetch(pendingInterruptsRequest(threadId))

      // Fail closed: with no route there is no identity for route-scoped
      // middleware to gate on, and interrupt payloads must never fall through.
      expect(response.status).toBe(409)
      const body = (await response.json()) as ErrorBody
      expect(body.error.details?.code).toBe("thread_route_unknown")
    })

    it("gates on middleware, which observes method GET and the thread's route", async () => {
      const handler = await createHandler(await fixtureApp({ "src/middleware.ts": ECHO_MIDDLEWARE }))
      const threadId = "t-gated"

      // Prove the fixture middleware LOADED before reading anything into a 200.
      // loadMiddleware swallows every import error and returns undefined, so an
      // unloadable fixture serves 200s indistinguishable from a handler that
      // never calls runMiddleware — and this GET would look gated when it is not.
      // This pair is also the "identical to the POST stream" gating assertion.
      const streamRejected = await handler.fetch(runStreamRequest(threadId, "/echo#graph"))
      expect(streamRejected.status).toBe(403)
      expect(await streamRejected.json()).toEqual({ method: "POST", routeId: "/echo" })

      // The rejected POST never reached the threads store, so this allowed run is
      // what creates the thread and records its route.
      const seeded = await handler.fetch(
        runStreamRequest(threadId, "/echo#graph", {}, { "x-allow": "1" }),
      )
      expect(seeded.status).toBe(200)
      await drain(seeded)

      const rejected = await handler.fetch(pendingInterruptsRequest(threadId))
      expect(rejected.status).toBe(403)
      // Dawn's first AP endpoint where middleware sees a method other than POST.
      expect(await rejected.json()).toEqual({ method: "GET", routeId: "/echo" })

      const allowed = await handler.fetch(pendingInterruptsRequest(threadId, { "x-allow": "1" }))
      expect(allowed.status).toBe(200)
      expect(await allowed.json()).toEqual({ interrupts: [] })
    }, 30_000)
  })
  ```

- [ ] **Step 2: Run the test and watch it fail.**
  ```bash
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/pending-interrupts-endpoint.test.ts -t "gating"
  ```
  Expected failure: the never-ran thread is served instead of refused — `AssertionError: expected 200 to be 409`. The middleware test gets as far as the two `POST` assertions (those pass — the POST stream is already gated), then fails at `expect(rejected.status).toBe(403)` with `expected 200 to be 403`, because the handler never calls `runMiddleware`. If instead the **first** POST assertion fails with `expected 200 to be 403`, the fixture middleware did not load — fix that before touching the handler.

- [ ] **Step 3: Widen the handler's options.** In `packages/cli/src/lib/dev/runtime-fetch-core.ts`, replace the signature and destructure of `handleApPendingInterruptsRequest` with:
  ```ts
  async function handleApPendingInterruptsRequest(options: {
    readonly checkpointer: BaseCheckpointSaver
    readonly middleware: DawnMiddleware | undefined
    readonly registry: RuntimeRegistry
    readonly request: Request
    readonly threadId: string
    readonly threadRouteMap: Map<string, string>
    readonly threadsStore: ThreadsStore
  }): Promise<Response> {
    const { checkpointer, middleware, registry, request, threadId, threadRouteMap, threadsStore } =
      options
  ```

- [ ] **Step 4: Resolve the route and run middleware.** In the same function, insert this block **after** the `if (!thread) { … }` guard's closing `}` and **before** the `// A known thread with no checkpoint has nothing parked.` comment block:
  ```ts
    // Route identity for middleware, resolved thread-first in the same priority
    // order POST /resume uses: the in-memory map is the fast path for this server
    // session, thread metadata survives a restart. There is no client-supplied
    // fallback — a GET has no body to carry one.
    const persistedRoute = thread.metadata.route
    const routeKey =
      threadRouteMap.get(threadId) ??
      (typeof persistedRoute === "string" ? persistedRoute : undefined)
    if (!routeKey) {
      // Fail closed. This endpoint exposes interrupt payloads, so it must be
      // gated exactly like the run endpoints that produced them; with no route
      // there is no identity to gate on and route-scoped middleware would
      // silently fall through. Deliberately a different code from /resume's
      // route_not_found: that one is fixable by passing `route` in the body.
      return Response.json(
        createRequestErrorBody(
          `No route recorded for thread "${threadId}": it has never run, so its pending ` +
            "interrupts cannot be gated by route middleware.",
          { code: "thread_route_unknown" },
        ),
        { status: 409 },
      )
    }

    const route = registry.lookup(routeKey)
    if (!route) {
      return Response.json(createRequestErrorBody(`Unknown route: ${routeKey}`), { status: 404 })
    }

    const requestUrl = new URL(request.url)
    const mwRequest: MiddlewareRequest = {
      assistantId: route.assistantId,
      headers: headersToRecord(request.headers),
      // "GET" here — the first AP endpoint where a middleware sees anything
      // other than "POST".
      method: request.method,
      params: {},
      routeId: route.routeId,
      url: `${requestUrl.pathname}${requestUrl.search}`,
    }
    const mwResult = await runMiddleware(middleware, mwRequest)
    if (mwResult.action === "reject") {
      return statusResponse(mwResult.status, mwResult.body)
    }
  ```

- [ ] **Step 5: Pass the new dependencies from the route table.** In the same file, replace the `handle` body of the `GET /threads/:thread_id/pending_interrupts` route entry with:
  ```ts
        handle: async (request, params) =>
          handleApPendingInterruptsRequest({
            checkpointer: getCheckpointer(request),
            middleware,
            registry,
            request,
            threadId: params.thread_id ?? "",
            threadRouteMap,
            threadsStore: getThreadsStore(request),
          }),
  ```

- [ ] **Step 6: Run the whole file and watch it pass.**
  ```bash
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/pending-interrupts-endpoint.test.ts
  ```
  Expect all six tests passing — the Task 3 tests included, since every thread they query has run a route.

- [ ] **Step 7: Typecheck, lint, and re-run the AP suites.**
  ```bash
  pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/runtime-fetch-parity.test.ts test/runtime-fetch-handler.test.ts test/resume-endpoint.test.ts
  ```
  Expect everything green.

- [ ] **Step 8: Commit.**
  ```bash
  git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/pending-interrupts-endpoint.test.ts
  git commit -m "$(cat <<'EOF'
  feat(cli): gate pending-interrupts on route middleware

  The endpoint exposes interrupt payloads, so it runs the standard Agent
  Protocol middleware with the route last run on the thread — resolved from the
  in-memory route map, then thread metadata, the same precedence POST /resume
  uses. A thread with no resolvable route has never run and is refused with 409
  thread_route_unknown rather than served ungated. Because this is a GET,
  middleware now observes req.method of "GET".

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 5: Parked turns report `"interrupted"` from the run-stream handler

A parked turn takes the **normal** completion path — the agent adapter yields the `interrupt` chunk and then `done` — so the `for await` loop drains and the handler writes `"idle"`. That is the reconnect bug in §2 of the spec. Track it with the handler's own flag.

**Files:**
- Modify: `packages/cli/test/pending-interrupts-endpoint.test.ts` (widen the `node:fs/promises` import, append three helpers and a describe block)
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (`handleApStreamRequest`: flag declaration at line 1278, loop body at lines 1307-1312, catch-path status write at lines 1325-1327 — **pre-plan numbers**; Task 3's route entry sits above them, so they have shifted down by roughly 20 lines by now. `handleApStreamRequest` has an indentation-distinct twin in `handleResumeRequest`, so the quoted indentation is what identifies the right one.)

- [ ] **Step 1: Add the helpers this task needs, then the discriminator tests.** First replace line 1 of `packages/cli/test/pending-interrupts-endpoint.test.ts` (`readFile` is used by `waitForFile` below and would have been an unused import until now):
  ```ts
  import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
  ```
  Then add this block to the end of the file:
  ```ts
  function cancelRequest(threadId: string): Request {
    return new Request(`http://localhost/threads/${threadId}/cancel`, { method: "POST" })
  }

  async function threadStatus(handler: Handler, threadId: string): Promise<string> {
    const response = await handler.fetch(new Request(`http://localhost/threads/${threadId}`))
    expect(response.status).toBe(200)
    return ((await response.json()) as { status: string }).status
  }

  async function waitForFile(path: string, timeoutMs = 15_000): Promise<string> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      try {
        return await readFile(path, "utf8")
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    throw new Error(`probe file never appeared: ${path}`)
  }

  // ---------------------------------------------------------------------------
  // "interrupted" is deliberately overloaded: cancelled OR parked. The
  // discriminator is pending_interrupts — non-empty means the agent is waiting
  // on a human. Both halves are asserted here so the overload cannot silently
  // lose one of its meanings.
  // ---------------------------------------------------------------------------

  describe("thread status after a parked or cancelled turn", () => {
    it("marks a parked thread interrupted, with a non-empty pending_interrupts", async () => {
      await withAimock(
        script().user("deploy to staging").callsTool("deployProd", { env: "staging" }).build(),
      )
      const handler = await createHandler(await fixtureApp())
      const threadId = "t-parked-status"

      await drain(await handler.fetch(parkRunRequest(threadId, "deploy to staging")))

      expect(await threadStatus(handler, threadId)).toBe("interrupted")
      const body = await readPendingInterruptsBody(handler, threadId)
      expect(body.interrupts).toHaveLength(1)
    }, 60_000)

    it("marks a cancelled thread interrupted, with an empty pending_interrupts", async () => {
      const appRoot = await fixtureApp()
      const handler = await createHandler(appRoot)
      const threadId = "t-cancelled-status"
      const startedFile = join(appRoot, "cancelled-started.json")
      const releaseFile = join(appRoot, "cancelled-release.json")

      const runResponse = await handler.fetch(
        runStreamRequest(threadId, "/blocking#graph", { releaseFile, startedFile }),
      )
      await waitForFile(startedFile)
      expect((await handler.fetch(cancelRequest(threadId))).status).toBe(200)
      await drain(runResponse)

      expect(await threadStatus(handler, threadId)).toBe("interrupted")
      const body = await readPendingInterruptsBody(handler, threadId)
      expect(body.interrupts).toEqual([])
    }, 30_000)

    it("still reports idle after a turn that completes without parking", async () => {
      const handler = await createHandler(await fixtureApp())
      const threadId = "t-completed-status"

      await drain(await handler.fetch(runStreamRequest(threadId, "/echo#graph")))

      expect(await threadStatus(handler, threadId)).toBe("idle")
    }, 30_000)
  })
  ```

- [ ] **Step 2: Run the new block and watch it fail.**
  ```bash
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/pending-interrupts-endpoint.test.ts -t "thread status after a parked or cancelled turn"
  ```
  Expected failure: only the parked test fails, with `AssertionError: expected 'idle' to be 'interrupted'`. The cancelled and completed tests already pass — they pin behavior that must not change.

- [ ] **Step 3: Declare the flag in `handleApStreamRequest`.** In `packages/cli/src/lib/dev/runtime-fetch-core.ts`, find the declaration at line 1278 (two-space indent — the resume handler has a four-space twin, so match the indentation exactly) and replace:
  ```ts
    let sourceCleanup: Promise<void> | undefined
  ```
  with:
  ```ts
    let sourceCleanup: Promise<void> | undefined
    // A parked turn takes the NORMAL completion path: the adapter yields the
    // interrupt chunk and then `done`, so a drained loop does not mean the turn
    // finished. Without this, a thread waiting on a human reads back as "idle"
    // and a reconnecting client is told the agent is done. Deliberately the
    // handler's own flag, so parked-status honesty depends on nothing outside
    // this request.
    let sawInterrupt = false
  ```

- [ ] **Step 4: Set the flag and use it on the normal completion path.** In the same function, replace lines 1307-1312 (12-space indent on `safeEnqueue`):
  ```ts
            for await (const chunk of abortableAsyncIterable(routeStream, run.signal, (p) => {
              sourceCleanup = p
            })) {
              safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
            }
            await threadsStore.updateStatus(threadId, "idle")
  ```
  with:
  ```ts
            for await (const chunk of abortableAsyncIterable(routeStream, run.signal, (p) => {
              sourceCleanup = p
            })) {
              if (chunk.type === "interrupt") sawInterrupt = true
              safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
            }
            await threadsStore.updateStatus(threadId, sawInterrupt ? "interrupted" : "idle")
  ```

- [ ] **Step 5: Use the flag on the failure path too.** In the same function, replace lines 1325-1327 (10-space indent on `await threadsStore`):
  ```ts
            await threadsStore
              .updateStatus(threadId, run.cancelled ? "interrupted" : "idle")
              .catch(() => undefined)
  ```
  with:
  ```ts
            // A turn that parked and then failed is still parked: the pending
            // interrupt survives in the checkpoint, so "interrupted" wins here
            // too rather than reporting the thread as finished.
            await threadsStore
              .updateStatus(threadId, run.cancelled || sawInterrupt ? "interrupted" : "idle")
              .catch(() => undefined)
  ```

- [ ] **Step 6: Run the file and watch it pass.**
  ```bash
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/pending-interrupts-endpoint.test.ts
  ```
  Expect all nine tests passing.

- [ ] **Step 7: Prove the cancellation and disconnect pins are untouched.** These are the tests that own the other meanings of `"interrupted"` and the deliberate keep-running-on-disconnect contract.
  ```bash
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/run-cancellation.test.ts test/runtime-fetch-parity.test.ts
  ```
  Expect all green, including "marks the thread interrupted after cancellation", "marks the thread interrupted after a cancelled wait", "keeps the heartbeat until a disconnected /runs/stream route ends", and "AP stream: client disconnect does not abort the run (deliberate)".

- [ ] **Step 8: Commit.**
  ```bash
  git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/pending-interrupts-endpoint.test.ts
  git commit -m "$(cat <<'EOF'
  fix(cli): report parked Agent Protocol turns as interrupted

  A turn that parks on a human-in-the-loop interrupt takes the normal completion
  path — the adapter yields the interrupt chunk and then done — so the run
  stream handler wrote thread status "idle" and a reconnecting client was told
  the agent had finished while it was in fact waiting on the human. Track the
  interrupt in the handler's own flag and write "interrupted" instead, on both
  the completion and failure paths.

  The status is now shared with cancelled runs; GET
  /threads/:thread_id/pending_interrupts is the discriminator, and both meanings
  are asserted.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 6: Parked turns report `"interrupted"` from the resume handler

The resume handler has its own copy of the stream loop and status writes. A turn that parks *again* after a resume (an "once" decision does not persist, so the next call to the same tool re-prompts) must report `"interrupted"` from that handler too.

**Files:**
- Modify: `packages/cli/test/pending-interrupts-endpoint.test.ts` (append a helper and a describe block)
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (`handleResumeRequest`: flag declaration at line 1748, loop body at lines 1778-1783, catch-path status write at lines 1796-1798 — **pre-plan numbers**, shifted down by Task 3's handler and route entry plus Task 5's edits. The four-space indentation is what distinguishes these from the twin edited in Task 5.)

- [ ] **Step 1: Append the resume helper and tests.** Add to the end of `packages/cli/test/pending-interrupts-endpoint.test.ts`:
  ```ts
  function resumeRequest(threadId: string, interruptId: string): Request {
    return new Request(`http://localhost/threads/${threadId}/resume`, {
      body: JSON.stringify({
        resume: [{ interruptId, payload: "once", status: "resolved" }],
        route: "/park#agent",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  }

  describe("thread status after a resumed turn", () => {
    it("marks the thread interrupted when the resumed turn parks again", async () => {
      // "once" authorizes exactly one call, so the second call to the same tool
      // re-prompts and the resumed turn parks again.
      await withAimock(
        script()
          .user("deploy to staging")
          .callsTool("deployProd", { env: "staging" })
          .callsTool("deployProd", { env: "prod" })
          .build(),
      )
      const handler = await createHandler(await fixtureApp())
      const threadId = "t-resume-parks-again"

      await drain(await handler.fetch(parkRunRequest(threadId, "deploy to staging")))
      const first = await readPendingInterruptsBody(handler, threadId)
      const interruptId = first.interrupts[0]?.interruptId ?? ""
      expect(interruptId).not.toBe("")

      const resumeText = await readSseText(await handler.fetch(resumeRequest(threadId, interruptId)))
      expect(resumeText).toContain("event: interrupt")

      expect(await threadStatus(handler, threadId)).toBe("interrupted")
      const second = await readPendingInterruptsBody(handler, threadId)
      expect(second.interrupts).toHaveLength(1)
      // A NEW park, not an echo of the answered one.
      expect(second.interrupts[0]?.interruptId).not.toBe(interruptId)
    }, 60_000)

    it("returns the thread to idle when the resumed turn completes", async () => {
      await withAimock(
        script()
          .user("deploy to staging")
          .callsTool("deployProd", { env: "staging" })
          .replies("Deployed.")
          .build(),
      )
      const handler = await createHandler(await fixtureApp())
      const threadId = "t-resume-completes"

      await drain(await handler.fetch(parkRunRequest(threadId, "deploy to staging")))
      const parked = await readPendingInterruptsBody(handler, threadId)
      const interruptId = parked.interrupts[0]?.interruptId ?? ""

      await drain(await handler.fetch(resumeRequest(threadId, interruptId)))

      expect(await threadStatus(handler, threadId)).toBe("idle")
      // The answered prompt is gone from durable state, so a reconnecting client
      // does not re-render a decision the human already made.
      const after = await readPendingInterruptsBody(handler, threadId)
      expect(after.interrupts).toEqual([])
    }, 60_000)
  })
  ```

- [ ] **Step 2: Run the new block and watch it fail.**
  ```bash
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/pending-interrupts-endpoint.test.ts -t "thread status after a resumed turn"
  ```
  Expected failure: the park-again test fails with `AssertionError: expected 'idle' to be 'interrupted'`. The completing-resume test already passes and is the guard that this change does not make every resume look parked.

- [ ] **Step 3: Declare the flag in `handleResumeRequest`.** In `packages/cli/src/lib/dev/runtime-fetch-core.ts`, find the declaration at line 1748 — **four-space** indent, which is what distinguishes it from the twin edited in Task 5 — and replace:
  ```ts
      let sourceCleanup: Promise<void> | undefined
  ```
  with:
  ```ts
      let sourceCleanup: Promise<void> | undefined
      // A resumed turn can park again (an "once" decision authorizes one call,
      // not the tool). Same reasoning as handleApStreamRequest: the adapter's
      // `done` follows the interrupt chunk, so a drained loop is not completion.
      let sawInterrupt = false
  ```

- [ ] **Step 4: Set the flag and use it on the normal completion path.** In the same function, replace lines 1778-1783 (14-space indent on `safeEnqueue`):
  ```ts
              for await (const chunk of abortableAsyncIterable(routeStream, run.signal, (p) => {
                sourceCleanup = p
              })) {
                safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
              }
              await threadsStore.updateStatus(threadId, "idle")
  ```
  with:
  ```ts
              for await (const chunk of abortableAsyncIterable(routeStream, run.signal, (p) => {
                sourceCleanup = p
              })) {
                if (chunk.type === "interrupt") sawInterrupt = true
                safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
              }
              await threadsStore.updateStatus(threadId, sawInterrupt ? "interrupted" : "idle")
  ```

- [ ] **Step 5: Use the flag on the failure path too.** In the same function, replace lines 1796-1798 (12-space indent on `await threadsStore`):
  ```ts
              await threadsStore
                .updateStatus(threadId, run.cancelled ? "interrupted" : "idle")
                .catch(() => undefined)
  ```
  with:
  ```ts
              // A resumed turn that parked and then failed is still parked; the
              // pending interrupt survives in the checkpoint.
              await threadsStore
                .updateStatus(threadId, run.cancelled || sawInterrupt ? "interrupted" : "idle")
                .catch(() => undefined)
  ```

- [ ] **Step 6: Run the file and watch it pass.**
  ```bash
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/pending-interrupts-endpoint.test.ts
  ```
  Expect all eleven tests passing.

- [ ] **Step 7: Re-run every suite that touches resume or run status.**
  ```bash
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/resume-endpoint.test.ts test/run-cancellation.test.ts test/agui-endpoint.test.ts test/subagent-interrupts.test.ts test/runtime-fetch-parity.test.ts
  pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint
  ```
  Expect all green. `resume-endpoint.test.ts`'s `reads > 1 ⇒ throw` checkpointer fixture must still pass — PR1 adds no extra `getTuple` to the resume handler (PR2's anchor read is what will break it, and that is PR2's job to update).

- [ ] **Step 8: Commit.**
  ```bash
  git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/pending-interrupts-endpoint.test.ts
  git commit -m "$(cat <<'EOF'
  fix(cli): report parked resume turns as interrupted

  The resume handler carries its own copy of the stream loop and status writes,
  so a turn that parked again after a resume — an "once" decision authorizes one
  call, not the tool — still reported "idle". Apply the same saw-interrupt flag
  there, on both the completion and failure paths, and pin that a resume which
  runs to completion still returns the thread to "idle".

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 7: Prove the endpoint against a real Postgres checkpointer

The spec's test strategy requires the integration suite to run against **both** sqlite and postgres checkpointer fixtures, postgres env-gated. This endpoint is purely checkpoint-backed, so the backend is exactly the thing that could differ (pending writes are hydrated by each saver's own `getTuple`). Everything above runs on the default sqlite saver; this task adds the gated postgres half.

The repo's convention, verified: `describe.skipIf(process.env.DAWN_TEST_PGSTORAGE !== "1")` plus a Testcontainers `PostgreSqlContainer("postgres:16").withStartupTimeout(180_000)` — see `packages/postgres-storage/test/checkpointer-conformance.test.ts:1-33`. `@dawn-ai/cli` already has `@testcontainers/postgresql` and `pg` as devDependencies.

`@dawn-ai/postgres-storage` is deliberately **not** a `@dawn-ai/cli` dependency (that would be a workspace cycle), so it is imported by relative path to its **`dist`**, exactly as `../../testing/dist/*` already is. Import its `src` instead and `pnpm --filter @dawn-ai/cli typecheck` fails — `packages/cli/tsconfig.json` sets `rootDir: "."`, so a sibling package's `.ts` drags a dozen `TS6059: File … is not under 'rootDir'` / `TS6307` errors into the program. A `.d.ts` under `dist` does not. Task 1's `pnpm build` is what puts it there.

**Files:**
- Modify: `packages/cli/test/pending-interrupts-endpoint.test.ts` (imports + a gated describe block)
- Modify: `.github/workflows/ci.yml` (one step in the existing `postgres-storage-docker` job)

- [ ] **Step 1: Widen the imports.** In `packages/cli/test/pending-interrupts-endpoint.test.ts`, replace the whole import block at the top of the file with:
  ```ts
  import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
  import { tmpdir } from "node:os"
  import { dirname, join } from "node:path"
  import type { RunnableConfig } from "@langchain/core/runnables"
  import { MemorySaver } from "@langchain/langgraph"
  import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph-checkpoint"
  import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
  import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
  import { type DawnPostgresSaver, postgresCheckpointer } from "../../postgres-storage/dist/node.js"
  import { createAimock } from "../../testing/dist/aimock-runner.js"
  import { script } from "../../testing/dist/fixture-builder.js"
  import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
  ```

- [ ] **Step 2: Append the gated postgres lane.** Add to the end of the same file:
  ```ts
  // ---------------------------------------------------------------------------
  // The endpoint reads nothing but the checkpointer's pending writes, so the
  // saver is the one dependency that can change the answer. Everything above
  // runs on sqlite; this runs the same park → list → resume → empty arc against
  // real Postgres. Gated on DAWN_TEST_PGSTORAGE=1 (needs Docker), matching
  // packages/postgres-storage/test/*.
  // ---------------------------------------------------------------------------

  describe.skipIf(process.env.DAWN_TEST_PGSTORAGE !== "1")(
    "pending_interrupts against a real Postgres checkpointer",
    () => {
      let container: StartedPostgreSqlContainer
      let connectionString: string
      // handler.close() does NOT close an injected checkpointer, so the pool is
      // this suite's to end — otherwise vitest hangs on an open pg pool.
      const savers: DawnPostgresSaver[] = []

      beforeAll(async () => {
        // A loaded CI runner can take minutes to pull postgres:16 and accept the
        // first connection; Testcontainers' 60s default is the honest lever.
        container = await new PostgreSqlContainer("postgres:16").withStartupTimeout(180_000).start()
        connectionString = container.getConnectionUri()
      }, 240_000)

      afterAll(async () => {
        await Promise.all(savers.splice(0).map((saver) => saver.close()))
        await container?.stop()
      })

      it("parks, lists the payload, and clears after a resume", async () => {
        await withAimock(
          script()
            .user("deploy to staging")
            .callsTool("deployProd", { env: "staging" })
            .replies("Deployed.")
            .build(),
        )
        const checkpointer = postgresCheckpointer({
          connectionString,
          // Fresh, never-migrated table set per test — no truncation, no teardown.
          tablePrefix: `t_${Math.random().toString(36).slice(2)}`,
        })
        savers.push(checkpointer)
        await checkpointer.ready()
        const handler = await createHandler(await fixtureApp(), checkpointer)
        const threadId = "t-pg-parked"

        await drain(await handler.fetch(parkRunRequest(threadId, "deploy to staging")))

        expect(await threadStatus(handler, threadId)).toBe("interrupted")
        const parked = await readPendingInterruptsBody(handler, threadId)
        expect(parked.interrupts).toHaveLength(1)
        expect(parked.interrupts[0]?.value).toMatchObject({ type: "permission-request" })

        const interruptId = parked.interrupts[0]?.interruptId ?? ""
        await drain(await handler.fetch(resumeRequest(threadId, interruptId)))

        expect(await threadStatus(handler, threadId)).toBe("idle")
        expect((await readPendingInterruptsBody(handler, threadId)).interrupts).toEqual([])
      }, 120_000)
    },
  )
  ```

- [ ] **Step 3: Run it both ways.** Ungated first (proves the skip is clean and the sqlite tests are unaffected), then gated (needs a running Docker daemon):
  ```bash
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/pending-interrupts-endpoint.test.ts
  DAWN_TEST_PGSTORAGE=1 pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/pending-interrupts-endpoint.test.ts
  ```
  Ungated: 11 passed, 1 skipped. Gated: 12 passed. If Docker is unavailable locally, say so explicitly rather than claiming the lane is green — CI runs it in the job wired up next.

- [ ] **Step 4: Wire the CI lane.** In `.github/workflows/ci.yml`, in the `postgres-storage-docker` job, add a step immediately after the existing:
  ```yaml
      - name: Real-Postgres storage tests
        run: DAWN_TEST_PGSTORAGE=1 pnpm --filter @dawn-ai/postgres-storage test
  ```
  namely:
  ```yaml

      - name: Real-Postgres Agent Protocol pending-interrupts tests
        # GET /threads/:id/pending_interrupts is purely checkpoint-backed, so the
        # spec asks for it against both checkpointer fixtures. This job already
        # has Docker and a built workspace, so the gated @dawn-ai/cli lane rides
        # here rather than paying for a fourth Postgres job.
        run: >-
          DAWN_TEST_PGSTORAGE=1 pnpm --filter @dawn-ai/cli exec vitest --run
          --config vitest.config.ts test/pending-interrupts-endpoint.test.ts
  ```
  The job's existing `timeout-minutes: 30` covers the extra container.

- [ ] **Step 5: Typecheck and lint.**
  ```bash
  pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint
  ```
  Expect both clean.

- [ ] **Step 6: Commit.**
  ```bash
  git add packages/cli/test/pending-interrupts-endpoint.test.ts .github/workflows/ci.yml
  git commit -m "$(cat <<'EOF'
  test(cli): run pending-interrupts against a real Postgres checkpointer

  The endpoint reads nothing but the checkpointer's pending writes, so the saver
  is the dependency that can change its answer. Add the park -> list -> resume
  -> empty arc against a Testcontainers Postgres behind DAWN_TEST_PGSTORAGE=1,
  and run it from the existing postgres-storage Docker job.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 8: Document the endpoint and the status overload

`apps/web/content/docs/dev-server.mdx` is the Agent Protocol endpoint reference. Its intro counts endpoints, and its middleware paragraph claims middleware gates only `/runs/stream`, `/runs/wait` and `/resume` — both false the moment this endpoint ships. `packages/cli/docs/*.md` is generated from this MDX during `@dawn-ai/cli` build and is gitignored, so do not hand-edit it.

**Files:**
- Modify: `apps/web/content/docs/dev-server.mdx` (intro sentence at line 31; new `<Tab>` after the `GET /threads/:thread_id/state` tab; new subsection after the run-tracking `</Callout>`; middleware sentence at line 264)

- [ ] **Step 1: Fix the endpoint-count sentence.** In `apps/web/content/docs/dev-server.mdx`, replace line 31 — which currently reads `The dev server exposes eight endpoints organized around a thread lifecycle: create thread → run (wait or stream) → read state → resume.` and is already wrong (there are nine tabs) — with:
  ```mdx
  The dev server exposes a small set of endpoints organized around a thread lifecycle: create thread → run (wait or stream) → read state → inspect pending interrupts → resume. Anything else returns 404. Thread state persists in SQLite under `.dawn/` and survives server restarts — see [Configuration](/docs/configuration) for the `checkpointer` and `threadsStore` defaults and override options.
  ```

- [ ] **Step 2: Add the endpoint tab.** In the same file, immediately after the closing `</Tab>` of the `GET /threads/:thread_id/state` tab (the tab whose body ends with `-> 404 if no checkpoint found`), insert:
  ```mdx
    <Tab label="GET /threads/:thread_id/pending_interrupts">
      List the human-in-the-loop interrupts currently parked on a thread, with the payload each one carries — enough for a client that reloaded to put the permission prompt back on screen without a live stream.

      ```
      GET /threads/:thread_id/pending_interrupts
      -> 200 { "interrupts": [ { "interruptId", "resumeKey", "value" } ] }
      -> 404 if no such thread (error.details.code = thread_not_found)
      -> 409 if the thread has never run (error.details.code = thread_route_unknown)
      ```

      `value` is the interrupt payload as the agent emitted it — for a permission prompt, `{ interruptId, type, kind, detail }`, the same object the `interrupt` SSE event carries. Answer the prompts with `POST /threads/:thread_id/resume`, using `interruptId`. A thread that exists but has nothing parked returns `200 { "interrupts": [] }`, and the response is sent `cache-control: no-store` because checkpoint state moves under the client.

      Middleware gates this endpoint using the route last run on the thread, which is why a thread that has never run is refused rather than served: there would be no route identity to gate on, and the endpoint exposes the same interrupt payloads the run stream does.
    </Tab>
  ```

- [ ] **Step 3: Add the status-disambiguation section.** In the same file, insert the following **after** the `</Callout>` that closes the `<Callout type="warn" title="Run tracking is single-replica">` block and immediately **before** the `## AG-UI endpoint` heading. Not directly after the "Client disconnect" paragraph — that callout belongs to the run-tracking discussion, and a heading inserted above it would silently reassign it to this new section:
  ```mdx
  ### Thread status after an interrupt

  `GET /threads/:thread_id` reports `status: "interrupted"` for **two** different situations: a run stopped by `POST /threads/:thread_id/cancel`, and a turn parked on a human-in-the-loop interrupt waiting for a decision. `GET /threads/:thread_id/pending_interrupts` is the discriminator — a non-empty `interrupts` array means the agent is waiting on a human, an empty one means the run was cancelled.

  Parked turns previously reported `"idle"`, which was indistinguishable from a finished run and left a reloaded UI showing a completed agent that was in fact blocked on a prompt.

  This applies to the two streaming endpoints, `/runs/stream` and `/resume`. `/runs/wait` is a blocking JSON call and still reports `"idle"` when its turn parks — check `pending_interrupts` there rather than the thread status.
  ```

- [ ] **Step 4: Correct the middleware coverage sentence.** In the same file, replace the sentence that begins `` `src/middleware.ts` (default-exporting a function returned by `defineMiddleware`) gates Agent Protocol `/runs/stream`, `/runs/wait`, and `/resume` execution `` through `Thread create, read, delete, and state endpoints do not invoke middleware.` with:
  ```mdx
  `src/middleware.ts` (default-exporting a function returned by `defineMiddleware`) gates Agent Protocol `/runs/stream`, `/runs/wait`, `/resume`, and `/pending_interrupts` execution plus AG-UI route execution under both `dawn dev` and the built runtime served by `dawn start`. Thread create, read, delete, and state endpoints do not invoke middleware. `/pending_interrupts` is a `GET` and has no body, so `req.method` is `"GET"` there and `req.params` is empty; a middleware that assumes `"POST"` needs updating.
  ```

- [ ] **Step 5: Run the docs gate.**
  ```bash
  node scripts/check-docs.mjs
  ```
  Expect no failures. Its banned-phrase scan covers `apps/web/content`, `docs/` (excluding `docs/superpowers/`), `.changeset/` **and `packages/`, including test files** — so a banned phrase such as "byte-identical" in a code comment reds this too. None of the text added by this plan uses one.

- [ ] **Step 6: Regenerate the bundled CLI docs and confirm nothing untracked appears.**
  ```bash
  pnpm --filter @dawn-ai/cli build && git status --short
  ```
  Expect `packages/cli/docs/` to stay out of the status output (it is gitignored) and only the MDX edit to show as modified.

- [ ] **Step 7: Commit.**
  ```bash
  git add apps/web/content/docs/dev-server.mdx
  git commit -m "$(cat <<'EOF'
  docs(cli): document the pending-interrupts endpoint

  Add the endpoint reference tab, drop the stale endpoint count, record that
  middleware now also gates /pending_interrupts and observes a GET method there,
  and explain that "interrupted" means cancelled OR parked with
  pending_interrupts as the discriminator — including that /runs/wait still
  reports "idle" when its turn parks.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 9: Changeset

`scripts/check-changesets.mjs` requires a changeset whenever any `packages/<pkg>/src/` file changes. The release train is a fixed 0.x group across all publishable packages, so a `minor` here would take **every** package to 1.0.0 — use `patch`. Changeset prose is copied verbatim into the generated CHANGELOG and is scanned by `check-docs.mjs`, so avoid its banned phrases ("byte-identical", provider-prefixed model ids, `dawn-ai.org`, `agent.bindTools`, `.dawn/generated`, "auto-bound"/"auto-registered", "speaks the LangSmith protocol natively", "without translation", "What works locally works in production").

**Files:**
- Create: `.changeset/ap-pending-interrupts.md`

- [ ] **Step 1: Write the changeset.** Create `.changeset/ap-pending-interrupts.md` with exactly:
  ```md
  ---
  "@dawn-ai/cli": patch
  ---

  Add `GET /threads/{thread_id}/pending_interrupts`, which returns the human-in-the-loop
  interrupts parked on a thread together with each interrupt's payload, so a client that
  reloaded can re-render a permission prompt from durable checkpoint state alone. Standard
  Agent Protocol middleware gates the endpoint using the route last run on the thread; a
  thread that has never run is refused with `thread_route_unknown`. Because the endpoint is
  a `GET`, middleware can now observe a `req.method` of `"GET"` — middleware that assumed
  `"POST"` needs updating.

  Parked turns now report thread status `"interrupted"` instead of `"idle"` on
  `GET /threads/{thread_id}`, from the run stream and the resume endpoint. `/runs/wait` is
  a blocking JSON call and still reports `"idle"` when its turn parks; use
  `pending_interrupts` to detect a park there. The `"interrupted"` status is shared with
  cancelled runs, and `pending_interrupts` is the discriminator — a non-empty list means
  the agent is waiting on a human.

  `PendingInterrupt` (exported from `@dawn-ai/cli/runtime`) gains an optional
  `value?: unknown` carrying that payload. It is optional so existing code that constructs
  the object keeps compiling; the parse always populates it.
  ```

- [ ] **Step 2: Run the changeset gate.**
  ```bash
  node scripts/check-changesets.mjs && node scripts/check-docs.mjs
  ```
  Expect both clean. `check-docs.mjs` also scans `.changeset/`, which is what catches a banned phrase before it reaches a CHANGELOG.

- [ ] **Step 3: Commit.**
  ```bash
  git add .changeset/ap-pending-interrupts.md
  git commit -m "$(cat <<'EOF'
  chore: record the pending-interrupts changeset

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Verification

Run all of this from the repo root, on Node 24, before opening the PR. Do not claim the work is done until each command has actually been run and its output read.

```bash
nvm use 24 && node -v                      # must print v24.x; the shell default is v22

pnpm install --frozen-lockfile             # a fresh worktree inherits no node_modules
pnpm build                                 # tests import packages/testing/dist — build first

pnpm --filter @dawn-ai/cli typecheck
pnpm --filter @dawn-ai/testing typecheck   # harness.ts consumes the widened PendingInterrupt
pnpm --filter @dawn-ai/cli lint            # NEVER bare `biome check --write`; use pnpm lint:fix

# The suites this slice creates or is most likely to disturb
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/pending-interrupts.test.ts \
  test/pending-interrupts-endpoint.test.ts \
  test/run-cancellation.test.ts \
  test/resume-endpoint.test.ts \
  test/runtime-fetch-parity.test.ts \
  test/runtime-fetch-handler.test.ts \
  test/agui-endpoint.test.ts \
  test/subagent-interrupts.test.ts \
  test/runtime-exports.test.ts

# The postgres checkpointer lane (needs Docker). CI runs this in postgres-storage-docker.
DAWN_TEST_PGSTORAGE=1 pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/pending-interrupts-endpoint.test.ts

pnpm --filter @dawn-ai/cli test             # full CLI package suite
pnpm --filter @dawn-ai/testing test         # harness consumes readPendingInterrupts

node scripts/check-docs.mjs
node scripts/check-changesets.mjs
pnpm pack:check

pnpm ci:validate                            # the full local gate CI runs
```

Named pins that must still be green (they own behavior this slice deliberately does **not** change):

- `run-cancellation.test.ts` → "marks the thread interrupted after cancellation", "marks the thread interrupted after a cancelled wait", "keeps the heartbeat until a disconnected /runs/stream route ends" (asserts `clearInterval` exactly once — this slice adds no second interval), "does not share mutable heartbeat bytes between /runs/stream ticks".
- `runtime-fetch-parity.test.ts` → "AP stream: client disconnect does not abort the run (deliberate)".
- `resume-endpoint.test.ts` → the `reads > 1 ⇒ throw` checkpointer fixture (PR1 adds no `getTuple` to the resume handler).
- `agui-endpoint.test.ts` → "aborts route execution on client disconnect and restores the thread to idle" (AG-UI keeps its opposite default).
- `hono-node-roundtrip.test.ts` / `workerd-lane.test.ts` → the `status: "idle"` assertions after a completed non-parked run. `hono-node-roundtrip.test.ts` is Docker-gated (`DAWN_REQUIRE_DOCKER=1` in CI turns its skip into a failure) and `workerd-lane.test.ts` is its own gated job; run them if those lanes are available locally, otherwise rely on CI.

## PR notes

**Title:** `feat(cli): report parked threads honestly and expose pending interrupts`

The PR description must call out:

1. **Scope.** This is PR1 of three from `docs/superpowers/specs/2026-08-09-ap-stream-reattach-design.md` — the checkpoint-backed half. No `LiveTurnHub`, no `GET /threads/{id}/runs/stream` attach endpoint, no `dawn threads tail`; those are PR2 and PR3. Independently shippable: everything here works across restarts, replicas, and serverless because it reads only checkpoints.
2. **Observable change 1 — thread status.** Parked turns now report `"interrupted"` on `GET /threads/{id}` instead of `"idle"`, from the run stream and the resume endpoint. Note the deliberate overload with cancelled runs (a distinct `ThreadStatus` member is an explicit spec non-goal) and that `pending_interrupts` is the discriminator. Any client that treated `"idle"` as "finished" now gets a truthful answer, and any client that treated `"interrupted"` as "cancelled" needs to check `pending_interrupts`. **`/runs/wait` is unchanged and still reports `"idle"` when its turn parks** — spec §4 scopes the fix to the streaming handlers; it is documented, not fixed here.
3. **Observable change 2 — new middleware input.** `GET /threads/{id}/pending_interrupts` is Dawn's first middleware-gated `GET`, so `req.method` can now be `"GET"` and `req.params` is empty there. Middleware that branched on `"POST"` needs updating.
4. **Public type change.** `PendingInterrupt` is re-exported on `@dawn-ai/cli/runtime`; it gains `value?: unknown`. Optional deliberately — a required field would be a compile break for external code that constructs the literal. The parse always sets the key.
5. **Fail-closed route resolution.** The 409 `thread_route_unknown` on a thread that has never run is deliberate, and deliberately a different code from `/resume`'s `route_not_found` (that one is fixable by passing `route` in the body; a GET has no body).
6. **Thread existence is observable before middleware.** The handler resolves the thread first, so a caller with no valid credentials can still distinguish "no such thread" from "thread exists". This matches `POST /resume` (404 at `runtime-fetch-core.ts:1665`, `runMiddleware` at 1721) and is the order spec §1 mandates; the interrupt payloads stay behind the gate. Flagged so it reads as a decision, not an oversight.
7. **What is not in the response.** `malformed` is not surfaced; the endpoint lists what parsed — including writes it could not address — and `POST /resume` remains the surface that refuses to act on them (`malformed_checkpoint`). Asserted.
8. **Test approach.** New integration file drives the real fetch handler with an aimock-scripted agent whose `deployProd` tool is `approve`-listed, so the park is a genuine checkpointer-backed HITL interrupt rather than a stubbed chunk; the cancelled half of the discriminator uses the existing blocking-route pattern; the gating test proves the fixture middleware loaded (403 on the POST stream) before trusting any 200; and the whole arc is re-run against a real Postgres checkpointer behind `DAWN_TEST_PGSTORAGE=1`.

**Changeset:** `.changeset/ap-pending-interrupts.md`, `"@dawn-ai/cli": patch` (a `minor` on this fixed 0.x group would bump every package to 1.0.0). It must carry all four callouts — parked status, the `/runs/wait` exception, the new `method: "GET"` middleware input, and the public `PendingInterrupt` field — because changeset prose becomes the published CHANGELOG verbatim.
