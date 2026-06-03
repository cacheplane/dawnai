# Deterministic Agent E2E with aimock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make offloaded-file names deterministic (keyed on tool_call_id, content-hash fallback) and add a CI-safe, no-real-key aimock-based agent e2e harness with two regression scenarios covering the SP5 (union tool inputs) and SP6a (offload retrieve-back) bug classes.

**Architecture:** Part A removes runtime nondeterminism from offload filenames so static fixtures can target exact paths. Part B adopts `@copilotkit/aimock` (a local OpenAI-compatible mock server), points `dawn dev` at it via `OPENAI_BASE_URL`, and runs two committed-fixture scenarios through the real agent loop.

**Tech Stack:** TypeScript, vitest, `@copilotkit/aimock`, `@langchain/openai` ChatOpenAI, Node `node:crypto`. Packages: `@dawn-ai/langchain`, `@dawn-ai/cli`, root `test/`.

**Spec:** `docs/superpowers/specs/2026-06-03-aimock-deterministic-e2e-design.md`

**Worktree:** `/Users/blove/repos/dawn-aimock`, branch `feat/aimock-deterministic-e2e`.

---

## File map

**Part A (modify):**
- `packages/langchain/src/offload/offload-store.ts` — add `buildOffloadFileName(toolName, content, toolCallId?)`; `write` gains `toolCallId?`.
- `packages/langchain/src/offload/offload-tool-output.ts` — `OffloadToolOutputCtx.toolCallId?`; forward to `store.write`.
- `packages/langchain/src/tool-converter.ts` — `OffloadFn` → `(content, toolName, toolCallId?)`; pass `extractToolCallId(config)` to `offload`.
- `packages/cli/src/lib/runtime/execute-route.ts` — `buildOffload` closure forwards the 3rd arg.
- Tests: `packages/langchain/test/offload-store.test.ts`, `packages/langchain/test/offload-tool-output.test.ts`.

**Part B (create/modify):**
- `packages/langchain/src/chat-model-factory.ts` — honor `OPENAI_BASE_URL` for the openai provider.
- `package.json` (root) — add `@copilotkit/aimock` devDependency.
- `test/runtime/support/aimock-runner.ts` — `startAimock({ fixturePath })`.
- `test/runtime/support/aimock-runner.test.ts` — harness unit test.
- `test/runtime/fixtures/aimock/sp5-union.json`, `test/runtime/fixtures/aimock/sp6a-retrieve.json`, `test/runtime/fixtures/aimock/sp6a-fallback.json` — committed fixtures.
- `test/runtime/run-aimock-e2e.test.ts` — the two scenarios + fallback; builds a packed app with probe tools, starts `dawn dev` against aimock.
- `test/runtime/vitest.config.ts` — add the new test file to `include`.

---

## Task 1: Deterministic offload filename builder

**Files:**
- Modify: `packages/langchain/src/offload/offload-store.ts`
- Test: `packages/langchain/test/offload-store.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/langchain/test/offload-store.test.ts` (match the file's existing import style):

```ts
import { buildOffloadFileName } from "../src/offload/offload-store.js"

describe("buildOffloadFileName", () => {
  it("uses toolName-toolCallId when a tool_call_id is present", () => {
    expect(buildOffloadFileName("readFile", "x".repeat(100), "call_abc123")).toBe(
      "readFile-call_abc123.txt",
    )
  })

  it("falls back to a content hash when tool_call_id is absent", () => {
    const a = buildOffloadFileName("generateReport", "hello world", undefined)
    const b = buildOffloadFileName("generateReport", "hello world", "")
    expect(a).toMatch(/^generateReport-[0-9a-f]{16}\.txt$/)
    expect(b).toBe(a) // empty id also falls back
  })

  it("is stable for identical content and distinct for different content", () => {
    const a = buildOffloadFileName("t", "same", undefined)
    const b = buildOffloadFileName("t", "same", undefined)
    const c = buildOffloadFileName("t", "different", undefined)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it("sanitizes unsafe characters in toolName and toolCallId", () => {
    expect(buildOffloadFileName("we/ir d", "y".repeat(50), "id/with space")).toBe(
      "we_ir_d-id_with_space.txt",
    )
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @dawn-ai/langchain test offload-store`
Expected: FAIL — `buildOffloadFileName` not exported.

- [ ] **Step 3: Implement the builder + use it in `write`**

In `packages/langchain/src/offload/offload-store.ts`, add `createHash` to the crypto import and add the exported builder; change `write`:

```ts
import { createHash, randomBytes } from "node:crypto"
```

```ts
function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_")
}

/**
 * Deterministic offload filename. Keyed on the tool_call_id when present
 * (unique per call in production; fixture-controlled in replay tests). Falls
 * back to a content hash when no id is available — still deterministic and
 * reproducible, since the caller controls the content.
 */
export function buildOffloadFileName(
  toolName: string,
  content: string,
  toolCallId?: string,
): string {
  const name = sanitizeSegment(toolName)
  if (toolCallId && toolCallId.length > 0) {
    return `${name}-${sanitizeSegment(toolCallId)}.txt`
  }
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16)
  return `${name}-${hash}.txt`
}
```

Change the `write` signature and body (currently `write(toolName, content)` building `${safeName}-${this.now()}-${randomBytes(3)...}.txt`):

```ts
  async write(toolName: string, content: string, toolCallId?: string): Promise<string> {
    const fileName = buildOffloadFileName(toolName, content, toolCallId)
    const relPath = `${SUBDIR}/${fileName}`
    const dirAbs = join(this.opts.workspaceRoot, SUBDIR)
    await this.opts.backend.mkdir?.(dirAbs, this.ctx)
    const absPath = join(this.opts.workspaceRoot, relPath)
    await this.opts.backend.writeFile(absPath, content, this.ctx)
    this.maybeGc()
    return relPath
  }
```

(Preserve the existing `mkdir`/`maybeGc` calls exactly as they appear in the current `write`; only the filename line changes. `randomBytes` may now be unused — remove it from the import if so. Read the current `write` body first and keep every line except the filename construction.)

- [ ] **Step 4: Run — expect PASS (and existing store tests still pass)**

Run: `pnpm --filter @dawn-ai/langchain test offload-store`
Expected: PASS. If an existing test asserts the old `-<ts>-<rand>` filename shape, update it to assert the new deterministic shape (`<tool>-<id>.txt` or the content-hash pattern).

- [ ] **Step 5: Lint + typecheck**

Run: `pnpm --filter @dawn-ai/langchain lint && pnpm --filter @dawn-ai/langchain typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/src/offload/offload-store.ts packages/langchain/test/offload-store.test.ts
git commit -m "feat(langchain): deterministic offload filenames (tool_call_id, content-hash fallback)"
```

---

## Task 2: Thread tool_call_id through the offload path

**Files:**
- Modify: `packages/langchain/src/offload/offload-tool-output.ts`
- Modify: `packages/langchain/src/tool-converter.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`
- Test: `packages/langchain/test/offload-tool-output.test.ts`

- [ ] **Step 1: Write failing test for ctx.toolCallId forwarding**

Append to `packages/langchain/test/offload-tool-output.test.ts`:

```ts
it("forwards toolCallId to store.write", async () => {
  const calls: Array<[string, string, string | undefined]> = []
  const store = {
    write: async (toolName: string, content: string, toolCallId?: string) => {
      calls.push([toolName, content, toolCallId])
      return `tool-outputs/${toolName}-${toolCallId}.txt`
    },
  }
  const big = "z".repeat(50)
  const out = await offloadToolOutput(big, {
    toolName: "generateReport",
    thresholdChars: 10,
    previewLines: 2,
    store,
    toolCallId: "call_xyz",
  })
  expect(calls[0]).toEqual(["generateReport", big, "call_xyz"])
  expect(out).toContain("tool-outputs/generateReport-call_xyz.txt")
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @dawn-ai/langchain test offload-tool-output`
Expected: FAIL — `toolCallId` not on ctx / not forwarded.

- [ ] **Step 3: Add `toolCallId` to ctx and forward**

In `packages/langchain/src/offload/offload-tool-output.ts`:

```ts
export interface OffloadToolOutputCtx {
  readonly toolName: string
  readonly thresholdChars: number
  readonly previewLines: number
  readonly store: Pick<OffloadStore, "write">
  readonly toolCallId?: string
}
```

and in the body change `const relPath = await ctx.store.write(ctx.toolName, content)` to:

```ts
    const relPath = await ctx.store.write(ctx.toolName, content, ctx.toolCallId)
```

- [ ] **Step 4: Extend `OffloadFn` and pass the id from the converter**

In `packages/langchain/src/tool-converter.ts`:

```ts
export type OffloadFn = (
  content: string,
  toolName: string,
  toolCallId?: string,
) => Promise<string>
```

In the tool `func` (currently `const finalContent = offload ? await offload(content, tool.name) : content`), compute the id once and pass it:

```ts
      const toolCallId = extractToolCallId(config)
      const finalContent = offload
        ? await offload(content, tool.name, toolCallId || undefined)
        : content
```

(`extractToolCallId` already exists in this file and returns `""` when absent; `|| undefined` makes the offloader take the content-hash fallback. The existing Command-path `extractToolCallId(config)` call below can reuse this `toolCallId` local — replace the second call to avoid double extraction.)

- [ ] **Step 5: Forward the 3rd arg in the execute-route closure**

In `packages/cli/src/lib/runtime/execute-route.ts`, the `buildOffload` closure currently is `(content, toolName) => { if (exempt.has(toolName)) ...; return offloadToolOutput(content, { toolName, thresholdChars, previewLines, store }) }`. Change to:

```ts
  return (content, toolName, toolCallId) => {
    if (exempt.has(toolName)) return Promise.resolve(content)
    return offloadToolOutput(content, {
      toolName,
      thresholdChars,
      previewLines,
      store,
      ...(toolCallId ? { toolCallId } : {}),
    })
  }
```

- [ ] **Step 6: Run tests + typecheck + lint**

Run: `pnpm --filter @dawn-ai/langchain test offload-tool-output && pnpm --filter @dawn-ai/langchain --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/langchain --filter @dawn-ai/cli lint`
Expected: clean. Run the full langchain offload suite too: `pnpm --filter @dawn-ai/langchain test offload` — all green.

- [ ] **Step 7: Commit**

```bash
git add packages/langchain/src/offload/offload-tool-output.ts packages/langchain/src/tool-converter.ts packages/cli/src/lib/runtime/execute-route.ts packages/langchain/test/offload-tool-output.test.ts
git commit -m "feat(langchain,cli): thread tool_call_id into offload for deterministic filenames"
```

---

## Task 3: createChatModel honors OPENAI_BASE_URL

**Context:** `createChatModel` builds `new ChatOpenAI({ model, reasoningEffort? })` and never sets a base URL, so pointing the agent at a local mock requires explicitly passing `configuration.baseURL`. This is what lets aimock intercept the calls.

**Files:**
- Modify: `packages/langchain/src/chat-model-factory.ts`
- Test: `packages/langchain/test/chat-model-factory.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test (uses the injectable `importer`)**

Create/append `packages/langchain/test/chat-model-factory.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest"
import { createChatModel } from "../src/chat-model-factory.js"

describe("createChatModel OPENAI_BASE_URL", () => {
  const prev = process.env.OPENAI_BASE_URL
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prev
  })

  it("passes configuration.baseURL for the openai provider when OPENAI_BASE_URL is set", async () => {
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:1234/v1"
    let captured: Record<string, unknown> | undefined
    class FakeChatOpenAI {
      constructor(options: Record<string, unknown>) {
        captured = options
      }
    }
    await createChatModel({
      model: "gpt-4o-mini",
      provider: "openai",
      importer: async () => ({ ChatOpenAI: FakeChatOpenAI }),
    })
    expect((captured?.configuration as { baseURL?: string } | undefined)?.baseURL).toBe(
      "http://127.0.0.1:1234/v1",
    )
  })

  it("does not set configuration when OPENAI_BASE_URL is unset", async () => {
    delete process.env.OPENAI_BASE_URL
    let captured: Record<string, unknown> | undefined
    class FakeChatOpenAI {
      constructor(options: Record<string, unknown>) {
        captured = options
      }
    }
    await createChatModel({
      model: "gpt-4o-mini",
      provider: "openai",
      importer: async () => ({ ChatOpenAI: FakeChatOpenAI }),
    })
    expect(captured?.configuration).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @dawn-ai/langchain test chat-model-factory`
Expected: FAIL — `configuration` never set.

- [ ] **Step 3: Implement**

In `createChatModel`, after building `constructorOptions` and the openai-reasoning branch, before `return new (...)`:

```ts
  if (options.provider === "openai") {
    const baseURL = process.env.OPENAI_BASE_URL
    if (baseURL) {
      constructorOptions.configuration = { baseURL }
    }
  }
```

- [ ] **Step 4: Run — expect PASS; typecheck + lint**

Run: `pnpm --filter @dawn-ai/langchain test chat-model-factory && pnpm --filter @dawn-ai/langchain typecheck && pnpm --filter @dawn-ai/langchain lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/chat-model-factory.ts packages/langchain/test/chat-model-factory.test.ts
git commit -m "feat(langchain): honor OPENAI_BASE_URL for the openai chat model (enables local mock)"
```

---

## Task 4: aimock harness helper

**Files:**
- Modify: `package.json` (root) — devDependency
- Create: `test/runtime/support/aimock-runner.ts`
- Test: `test/runtime/support/aimock-runner.test.ts`

- [ ] **Step 1: Add the devDependency + install**

Edit root `package.json` `devDependencies`, add `"@copilotkit/aimock": "^1.23.0"`. Then:

Run: `cd /Users/blove/repos/dawn-aimock && pnpm install`
Expected: resolves; lockfile updated. If `^1.23.0` is unavailable, run `pnpm view @copilotkit/aimock version` and use the latest published version, noting it.

- [ ] **Step 2: Write the harness**

Create `test/runtime/support/aimock-runner.ts`:

```ts
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { LLMock } from "@copilotkit/aimock"

export interface AimockHandle {
  readonly port: number
  readonly baseUrl: string
  stop(): Promise<void>
}

type FixtureEntry = Record<string, unknown>

function loadEntries(fixturePath: string): FixtureEntry[] {
  const out: FixtureEntry[] = []
  const read = (full: string): void => {
    const parsed = JSON.parse(readFileSync(full, "utf-8")) as { fixtures: FixtureEntry[] }
    for (const fx of parsed.fixtures) out.push(fx)
  }
  if (statSync(fixturePath).isDirectory()) {
    for (const f of readdirSync(fixturePath).filter((n) => n.endsWith(".json")).sort()) {
      read(join(fixturePath, f))
    }
  } else {
    read(fixturePath)
  }
  return out
}

export async function startAimock(opts: { fixturePath: string }): Promise<AimockHandle> {
  const entries = loadEntries(opts.fixturePath)
  const mock = new LLMock({ port: 0, chunkSize: 4096 })
  if (entries.length > 0) mock.addFixturesFromJSON(entries as never)
  await mock.start()
  let stopped = false
  return {
    port: mock.port,
    baseUrl: `${mock.url}/v1`,
    async stop() {
      if (stopped) return
      stopped = true
      await mock.stop()
    },
  }
}
```

- [ ] **Step 3: Write the harness unit test + a trivial fixture**

Create `test/runtime/fixtures/aimock/hello.json`:

```json
{ "fixtures": [ { "match": { "userMessage": "ping" }, "response": { "content": "pong" } } ] }
```

Create `test/runtime/support/aimock-runner.test.ts`:

```ts
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type AimockHandle, startAimock } from "./aimock-runner.js"

describe("startAimock", () => {
  let handle: AimockHandle | undefined
  afterEach(async () => {
    await handle?.stop()
    handle = undefined
  })

  it("starts, serves a /v1 base URL, and replays a fixture", async () => {
    handle = await startAimock({
      fixturePath: join(import.meta.dirname, "../fixtures/aimock/hello.json"),
    })
    expect(handle.baseUrl).toMatch(/^http:\/\/.+\/v1$/)
    const res = await fetch(`${handle.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "ping" }] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toBe("pong")
  })
})
```

- [ ] **Step 4: Wire the test into the runtime vitest include**

In `test/runtime/vitest.config.ts`, add `"test/runtime/support/aimock-runner.test.ts"` to the `include` array.

- [ ] **Step 5: Run — expect PASS**

Run: `pnpm --filter dawn-tests exec vitest --run --config test/runtime/vitest.config.ts test/runtime/support/aimock-runner.test.ts`
(Discover the test package's filter name first: `grep '"name"' test/package.json` or the root test script. Substitute the correct `--filter` / invocation. If tests run from root, use `pnpm exec vitest --run --config test/runtime/vitest.config.ts test/runtime/support/aimock-runner.test.ts`.)
Expected: PASS — the mock replays `pong`. If aimock's chat-completions path differs, adjust the URL/shape per `node_modules/@copilotkit/aimock` types (the response is OpenAI chat-completion shaped).

- [ ] **Step 6: Lint + commit**

Run: `pnpm lint 2>&1 | tail -3`

```bash
git add package.json pnpm-lock.yaml test/runtime/support/aimock-runner.ts test/runtime/support/aimock-runner.test.ts test/runtime/fixtures/aimock/hello.json test/runtime/vitest.config.ts
git commit -m "test(runtime): add aimock harness (startAimock) + smoke"
```

---

## Task 5: Packed-app scaffolding with probe tools (shared setup for scenarios)

**Context:** The two scenarios need a real `dawn dev` app exposing an agent route + the `applyFilter` and `generateReport` tools + a `workspace/` dir (so offloading activates). Reuse the packed-app harness used by `test/runtime/run-agent-protocol.test.ts`.

**Files:**
- Create: `test/runtime/run-aimock-e2e.test.ts` (scaffolding + first scenario in Task 6; this task lands the shared build helper)

- [ ] **Step 1: Read the existing packed-app harness**

Run: `grep -n "createPackagedInstaller\|createGeneratedApp\|rewriteDependenciesToTarballs\|startDevServer\|allocatePort\|workspace\|echoAgentOverlaySource\|writeFile" test/runtime/run-agent-protocol.test.ts | head -40`
Read those helpers (`test/harness/packaged-app.ts`, `test/runtime/support/dev-server.ts`) to mirror the exact build+install+start sequence.

- [ ] **Step 2: Write the shared scaffolding in `test/runtime/run-aimock-e2e.test.ts`**

Create the file with a `buildProbeApp(tempRoot)` helper that:
1. Packs the workspace (`createPackagedInstaller` with `@dawn-ai/cli`, `core`, `langchain`, `sdk`, `workspace`, `permissions`, `sqlite-storage`, `config-typescript`), `createGeneratedApp({ template: "basic" })`, `rewriteDependenciesToTarballs`.
2. Writes an agent route at `src/app/chat/index.ts` using `agent({ model: "gpt-4o-mini", systemPrompt: "..." })` (mirror the chat example's minimal agent; gpt-4o-mini is just the model string the mock will answer for).
3. Writes the two probe tools:

`src/app/chat/tools/applyFilter.ts`:
```ts
/** Apply a structured filter to records and return how many matched, echoing the input back. */
export default async function applyFilter(input: {
  filter: { status: "open" | "closed"; tags: string[] }
  pagination?: { limit: number; cursor?: string }
  labels?: Record<string, string>
  sort: { by: "date"; dir: "asc" | "desc" } | { by: "name" }
}): Promise<{ matched: number; echo: unknown }> {
  return { matched: input.filter.tags.length, echo: input }
}
```

`src/app/chat/tools/generateReport.ts`:
```ts
/** Generate a large diagnostic report (used to exercise tool-output offloading). */
export default async function generateReport(input: { rows: number }): Promise<string> {
  const n = Math.max(input.rows, 2000)
  const lines: string[] = []
  for (let i = 0; i < n; i++) lines.push(`row ${i}: ${"x".repeat(40)} value=${i * 7}`)
  lines.push("MARKER-DEEP-INSIDE-NEEDLE-42")
  return lines.join("\n")
}
```

4. Creates `workspace/` (so the offload capability activates): `await mkdir(join(appRoot, "workspace"), { recursive: true })`.
5. Runs `pnpm install` in the app (via `spawnProcess`, `env: { NODE_NO_WARNINGS: "1" }`), throws on failure.
Return `{ appRoot }`.

(Write this helper using the exact imports/patterns discovered in Step 1. Do not invent helper names — reuse `createPackagedInstaller`, `createGeneratedApp`, `rewriteDependenciesToTarballs`, `createTrackedTempDir`, `cleanupTrackedTempDirs`, `startDevServer`, `allocatePort` from the same modules `run-agent-protocol.test.ts` imports.)

- [ ] **Step 3: Add a placeholder describe to verify the app builds + boots against aimock**

Add a single `it` that builds the app, starts aimock with `fixtures/aimock/hello.json`, starts `dawn dev` with `env: { OPENAI_BASE_URL: aimock.baseUrl, OPENAI_API_KEY: "test-not-used" }`, hits `POST /threads`, asserts 200, and tears down. This proves the wiring before authoring scenario fixtures.

```ts
const port = await allocatePort()
const server = await startDevServer({ cwd: appRoot, port, env: { OPENAI_BASE_URL: aimock.baseUrl, OPENAI_API_KEY: "test-not-used" } })
const url = await server.waitForReady(30_000)
const created = await fetch(new URL("/threads", url), { method: "POST", body: "{}", headers: { "content-type": "application/json" } })
expect(created.status).toBe(200)
```

- [ ] **Step 4: Add to vitest include + run**

Add `"test/runtime/run-aimock-e2e.test.ts"` to `test/runtime/vitest.config.ts` `include`. Run it:
Run: `pnpm exec vitest --run --config test/runtime/vitest.config.ts test/runtime/run-aimock-e2e.test.ts 2>&1 | tail -20`
Expected: PASS (app builds, boots against aimock, creates a thread). This validates the OPENAI_BASE_URL wiring end-to-end.

- [ ] **Step 5: Commit**

```bash
git add test/runtime/run-aimock-e2e.test.ts test/runtime/vitest.config.ts
git commit -m "test(runtime): packed probe app + aimock boot wiring"
```

---

## Task 6: Scenario 1 — SP5 union tool-call

**Files:**
- Create: `test/runtime/fixtures/aimock/sp5-union.json`
- Modify: `test/runtime/run-aimock-e2e.test.ts`

- [ ] **Step 1: Author the fixture**

Create `test/runtime/fixtures/aimock/sp5-union.json`. Turn 1 (match the user message) returns a tool_call to `applyFilter` with the nested union arg; turn 2 (match `hasToolResult`) returns a short text answer. Use aimock's tool-call response shape (verify against `node_modules/@copilotkit/aimock` `FixtureFileToolCallResponse` type):

```json
{
  "fixtures": [
    {
      "match": { "userMessage": "Filter the open urgent/backend items, newest first." },
      "response": {
        "toolCalls": [
          {
            "id": "call_apply_filter_1",
            "name": "applyFilter",
            "arguments": {
              "filter": { "status": "open", "tags": ["urgent", "backend"] },
              "pagination": { "limit": 25 },
              "labels": { "team": "payments" },
              "sort": { "by": "date", "dir": "desc" }
            }
          }
        ]
      }
    },
    { "match": { "hasToolResult": true }, "response": { "content": "Matched 2 items." } }
  ]
}
```

(If aimock's exact fixture key for tool calls differs — e.g. `tool_calls` or a `buildToolCallResponse` shape — adjust to match the type definitions. The semantic requirement: the assistant's first turn emits a tool_call to `applyFilter` with these args.)

- [ ] **Step 2: Write the failing scenario test**

Add to `run-aimock-e2e.test.ts`:

```ts
it("SP5: a discriminated-union tool argument is accepted by the generated schema", async () => {
  const { appRoot } = await buildProbeApp(tempRoot)
  const aimock = await startAimock({ fixturePath: join(import.meta.dirname, "fixtures/aimock/sp5-union.json") })
  const port = await allocatePort()
  const server = await startDevServer({ cwd: appRoot, port, env: { OPENAI_BASE_URL: aimock.baseUrl, OPENAI_API_KEY: "test-not-used" } })
  try {
    const url = await server.waitForReady(30_000)
    const tid = ((await (await fetch(new URL("/threads", url), { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).json()) as { thread_id: string }).thread_id
    const run = await fetch(new URL(`/threads/${tid}/runs/wait`, url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: "/chat#agent", input: { messages: [{ role: "user", content: "Filter the open urgent/backend items, newest first." }] } }),
    })
    expect(run.status).toBe(200)
    const state = (await run.json()) as { messages: Array<Record<string, unknown>> }
    const toolMsg = state.messages.find((m) => {
      const id = (m as { id?: string[] }).id
      const kw = (m as { kwargs?: { name?: string } }).kwargs
      return Array.isArray(id) && id[2] === "ToolMessage" && kw?.name === "applyFilter"
    }) as { kwargs?: { content?: string } } | undefined
    expect(toolMsg, "applyFilter ToolMessage present").toBeDefined()
    const content = toolMsg?.kwargs?.content ?? ""
    expect(content).not.toContain("did not match expected schema")
    expect(content).not.toContain("Invalid input")
    expect(content).toContain('"matched":2')
  } finally {
    await server.stop()
    await aimock.stop()
  }
}, 120_000)
```

- [ ] **Step 3: Run — expect PASS**

Run: `pnpm exec vitest --run --config test/runtime/vitest.config.ts -t "discriminated-union" 2>&1 | tail -20`
Expected: PASS. (Pre-#188 this would FAIL with a schema-rejection — that's the regression this guards.)

- [ ] **Step 4: Commit**

```bash
git add test/runtime/fixtures/aimock/sp5-union.json test/runtime/run-aimock-e2e.test.ts
git commit -m "test(runtime): SP5 union tool-call scenario via aimock"
```

---

## Task 7: Scenario 2 — SP6a offload retrieve-back (+ fallback variant)

**Files:**
- Create: `test/runtime/fixtures/aimock/sp6a-retrieve.json`
- Create: `test/runtime/fixtures/aimock/sp6a-fallback.json`
- Modify: `test/runtime/run-aimock-e2e.test.ts`

- [ ] **Step 1: Author the retrieve fixture (deterministic path keyed on the fixture's tool_call_id)**

Create `test/runtime/fixtures/aimock/sp6a-retrieve.json`. Turn 1 → `generateReport` with id `call_gen_report_1`; turn 2 (match `hasToolResult`) → `readFile` at the deterministic path `tool-outputs/generateReport-call_gen_report_1.txt`; turn 3 → text answer:

```json
{
  "fixtures": [
    {
      "match": { "userMessage": "Make a 2000-row report and quote the marker line." },
      "response": { "toolCalls": [ { "id": "call_gen_report_1", "name": "generateReport", "arguments": { "rows": 2000 } } ] }
    },
    {
      "match": { "hasToolResult": true, "turnIndex": 1 },
      "response": { "toolCalls": [ { "id": "call_read_1", "name": "readFile", "arguments": { "path": "tool-outputs/generateReport-call_gen_report_1.txt" } } ] }
    },
    { "match": { "hasToolResult": true }, "response": { "content": "Found the marker." } }
  ]
}
```

(Verify aimock's turn discrimination keys against its types — `turnIndex`/`hasToolResult` per the angular runner. Adjust if the exact discriminator names differ; the requirement is: 2nd assistant turn calls `readFile` at the deterministic path.)

- [ ] **Step 2: Write the failing scenario test**

Add to `run-aimock-e2e.test.ts`:

```ts
it("SP6a: an offloaded output is retrieved in full via readFile (no re-offload)", async () => {
  const { appRoot } = await buildProbeApp(tempRoot)
  const aimock = await startAimock({ fixturePath: join(import.meta.dirname, "fixtures/aimock/sp6a-retrieve.json") })
  const port = await allocatePort()
  const server = await startDevServer({ cwd: appRoot, port, env: { OPENAI_BASE_URL: aimock.baseUrl, OPENAI_API_KEY: "test-not-used" } })
  try {
    const url = await server.waitForReady(30_000)
    const tid = ((await (await fetch(new URL("/threads", url), { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).json()) as { thread_id: string }).thread_id
    const run = await fetch(new URL(`/threads/${tid}/runs/wait`, url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: "/chat#agent", input: { messages: [{ role: "user", content: "Make a 2000-row report and quote the marker line." }] } }),
    })
    expect(run.status).toBe(200)
    const state = (await run.json()) as { messages: Array<Record<string, unknown>> }
    const byTool = (name: string) => state.messages.find((m) => {
      const id = (m as { id?: string[] }).id
      const kw = (m as { kwargs?: { name?: string } }).kwargs
      return Array.isArray(id) && id[2] === "ToolMessage" && kw?.name === name
    }) as { kwargs?: { content?: string } } | undefined
    const gen = byTool("generateReport")?.kwargs?.content ?? ""
    const read = byTool("readFile")?.kwargs?.content ?? ""
    expect(gen).toContain("Tool output offloaded")           // generateReport was offloaded
    expect(read).not.toContain("Tool output offloaded")      // readFile was NOT re-offloaded
    expect(read).toContain("MARKER-DEEP-INSIDE-NEEDLE-42")    // full content retrieved
  } finally {
    await server.stop()
    await aimock.stop()
  }
}, 120_000)
```

- [ ] **Step 3: Run — expect PASS**

Run: `pnpm exec vitest --run --config test/runtime/vitest.config.ts -t "retrieved in full" 2>&1 | tail -20`
Expected: PASS. (Pre-#189 the readFile result would itself be an offload stub — the regression this guards.)

- [ ] **Step 4: Fallback variant (content-hash path, no tool_call_id)**

Create `test/runtime/fixtures/aimock/sp6a-fallback.json` identical to `sp6a-retrieve.json` except the `generateReport` tool call **omits `id`** (or sets it to `""`), and the `readFile` path is the content-hash form. Compute the hash deterministically: the fixture author runs a tiny node snippet to get `sha256(generateReport output for rows=2000).slice(0,16)` and uses `tool-outputs/generateReport-<hash>.txt`. Add a helper in the test to compute the expected name from the same `generateReport` body (import the probe tool's logic or recompute the string) and assert the offloaded file exists at that path before the readFile turn.

Because the hash must match the JSON-serialized tool content exactly (the offloader hashes the serialized `content`), the test computes the expected filename via `buildOffloadFileName("generateReport", serializedContent, undefined)` imported from `@dawn-ai/langchain` and asserts the fixture's readFile path equals it (a guard that the committed fixture stays correct). Then assert the same retrieve-back invariants as Step 2.

Run: `pnpm exec vitest --run --config test/runtime/vitest.config.ts -t "content-hash" 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/runtime/fixtures/aimock/sp6a-retrieve.json test/runtime/fixtures/aimock/sp6a-fallback.json test/runtime/run-aimock-e2e.test.ts
git commit -m "test(runtime): SP6a offload retrieve-back scenarios (id + content-hash) via aimock"
```

---

## Task 8: Full validation, changeset, memory, PR

- [ ] **Step 1: Full lane + suite**

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm exec vitest --run --config test/runtime/vitest.config.ts test/runtime/run-aimock-e2e.test.ts
```
Expected: all green. Fix any fallout (e.g. an offload test asserting the old filename shape).

- [ ] **Step 2: Changeset**

Create `.changeset/aimock-deterministic-e2e.md`:

```md
---
"@dawn-ai/langchain": patch
---

Offloaded tool-output filenames are now deterministic — keyed on the originating tool_call_id (content-hash fallback when absent) instead of timestamp+random. This makes offloaded paths stable and traceable, and enables deterministic agent e2e tests. Also: the openai chat model now honors `OPENAI_BASE_URL`, allowing a local mock provider.
```

(If the `@dawn-ai/cli` change to `buildOffload` is user-facing, add `"@dawn-ai/cli": patch` too. The test-only files need no changeset.)

Run: `BASE_REF=origin/main HEAD_REF=feat/aimock-deterministic-e2e node scripts/check-changesets.mjs`
Expected: passes.

- [ ] **Step 3: Push + PR**

```bash
git add .changeset/aimock-deterministic-e2e.md
git commit -m "chore: changeset for deterministic offload filenames + aimock e2e"
git push -u origin feat/aimock-deterministic-e2e
gh pr create --title "test: deterministic offload filenames + aimock agent e2e (CI-safe, no key)" --body "$(cat <<'EOF'
## Summary
- Deterministic offload filenames keyed on tool_call_id (content-hash fallback) — replaces timestamp+rand, enabling deterministic e2e and giving stable/traceable offload paths.
- `OPENAI_BASE_URL` honored by the openai chat model → a local mock provider can intercept agent calls.
- New aimock-based agent e2e harness + two regression scenarios that run in CI with NO real API key: SP5 discriminated-union tool-call acceptance, and SP6a offload→readFile retrieve-back (id + content-hash fallback). These guard the exact two bug classes a manual live smoke found in #188 and #189.

## Test plan
- [x] Unit: buildOffloadFileName (id / hash / sanitize / stability), toolCallId threading, OPENAI_BASE_URL wiring, startAimock smoke
- [x] Integration (runtime lane, no key): SP5 union scenario, SP6a retrieve-back + content-hash fallback
- [x] Full lint + typecheck + test green

Spec: docs/superpowers/specs/2026-06-03-aimock-deterministic-e2e-design.md
Plan: docs/superpowers/plans/2026-06-03-aimock-deterministic-e2e.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Update phase memory**

In `/Users/blove/.claude/projects/-Users-blove-repos-dawn/memory/project_phase_status.md`, note: aimock deterministic e2e harness adopted; offload filenames deterministic (tool_call_id / content-hash); SP5+SP6a now have always-on CI regression guards; PR link.

---

## Self-Review

**Spec coverage:**
- Part A deterministic filenames (primary id / hash fallback / sanitize) → Task 1. ✓
- toolCallId plumbing (OffloadFn, converter, ctx, execute-route closure) → Task 2. ✓
- OPENAI_BASE_URL wiring → Task 3. ✓
- aimock adoption + startAimock → Task 4. ✓
- Probe tools + packed app + boot wiring → Task 5. ✓
- Scenario 1 (SP5 union) → Task 6. ✓
- Scenario 2 (SP6a retrieve) + B5a fallback → Task 7. ✓
- CI placement (runtime lane, no key) → Tasks 5–7 use the runtime vitest config; no OPENAI_API_KEY required. ✓
- Out-of-scope items (record mode, model-injection seam, summarization, preview-1-line) → none implemented. ✓

**Placeholder scan:** Tasks 5/6/7 instruct verifying aimock's exact fixture/turn-discriminator keys and the test-package filter against the installed types rather than hardcoding possibly-wrong names — each gives the exact `grep`/type-file to consult and the semantic requirement. This is deliberate (the aimock fixture schema is an external dependency whose exact keys must be read from its `.d.ts`), not a vague placeholder.

**Type consistency:** `buildOffloadFileName(toolName, content, toolCallId?)` identical in Task 1 (def) and Task 7 Step 4 (consumer). `OffloadFn = (content, toolName, toolCallId?)` consistent across Task 2 (def), execute-route closure, and converter call. `OffloadToolOutputCtx.toolCallId?` produced in Task 2 and consumed by `store.write(toolName, content, toolCallId)` from Task 1. Deterministic path `generateReport-call_gen_report_1.txt` in Task 7's fixture matches the Task 1 primary scheme `<toolName>-<toolCallId>.txt`.
