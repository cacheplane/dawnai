# `@dawn-ai/testing` Fixture Files + Live Mode + Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the record→commit→replay fixture loop, add a gated live (proxy-record) harness mode, and ship a sample test in `create-dawn-app` — so users can build a productized, fixture-based e2e suite for their agents.

**Architecture:** Package-only additions to `@dawn-ai/testing` (fixture-file load/write, a `live` harness flag that runs aimock in proxy-record mode) plus a scaffold template sample test. No framework changes. Drift detection deferred.

**Tech Stack:** TypeScript, pnpm/turbo, vitest, biome, `@copilotkit/aimock` 1.28, `@dawn-ai/devkit` templates.

**Worktree:** `/Users/blove/repos/dawn-fxlive` (branch `feat/testing-fixture-files-live`, off `origin/main` which includes `@dawn-ai/testing` + capability coverage).

**Spec:** `docs/superpowers/specs/2026-06-06-testing-fixture-files-live-mode-design.md`.

---

## Background facts (verified — trust these)

- **`AimockFixture` / `FixtureSet`** (`packages/testing/src/fixture-builder.ts`): `FixtureSet = AimockFixture[]`; `AimockFixture = { match: {...}, response: {...} }`. `script()` returns a `ScriptBuilder` with `.build(): FixtureSet`.
- **`startAimock`** (`packages/testing/src/aimock-runner.ts`): `startAimock({ fixtures }) → AimockHandle { port, baseUrl, addFixtures(), getRequests(), stop() }`. Internally `new LLMock({ port: 0, chunkSize: 4096 })`, `mock.addFixturesFromJSON(fixtures)`, `mock.start()`.
- **aimock proxy/record:** `new LLMock({ port: 0, record: { providers: { openai: "https://api.openai.com" }, proxyOnly: true } })` proxies unmatched requests to real OpenAI WITHOUT saving fixtures, and the journal (`getRequests()`) is still populated (proxy requests are journaled). `RecordConfig = { providers: Partial<Record<RecordProviderKey,string>>, proxyOnly?: boolean }`. (Confirm exact field names against the installed `@copilotkit/aimock/dist/types.d.ts`.)
- **Harness** (`packages/testing/src/harness.ts`): `createAgentHarness({ appRoot, route, fixtures?, mode? }) → { baseUrl, run, resume, reset, close }`. Construction: `startAimock(...)` once, set `OPENAI_BASE_URL`→aimock + `OPENAI_API_KEY`→`process.env.OPENAI_API_KEY ?? "test-not-used"`, `runTypegen`, resolve route. `run()`/`resume()` use a `drive()` helper that snapshots `aimock.getRequests().length`, streams via `streamResolvedRoute`, and merges `systemPrompt` from `systemPromptFromRequests(turnReqs)` (matches `system`||`developer` roles). `close()` stops aimock, restores env, calls `__resetMaterializedAgentsForTests()`.
- **`record()`** (`packages/testing/src/record.ts`): writes a committed fixture file via the aimock recorder CLI. Local-only.
- **Barrel** (`packages/testing/src/index.ts`): exports `startAimock`, `script`, `createAgentHarness`, all matchers, `record`, `collectRunResult`, `startSubprocessApp`, types.
- **Scaffold template** (`packages/devkit/templates/app-basic/`): `package.json.template` (uses `{{appName}}`, `{{dawn*Specifier}}` placeholders; has `check`/`build`/`typecheck` scripts, deps on core/cli/langchain/sdk/zod, devDeps on config-typescript/@types/node/typescript — NO test script, NO `@dawn-ai/testing`). The one route is `src/app/(public)/hello/[tenant]/index.ts` = `agent({ model:"gpt-4o-mini", systemPrompt:"...{tenant}..." })` with a `greet` tool. `create-dawn-app` scaffolds via `@dawn-ai/devkit` `resolveTemplateDir`/`writeTemplate`.
- **Docs:** `apps/web/content/docs/testing-agents.mdx` (the testing guide from #193).
- The repo `.env` (at `/Users/blove/repos/dawn/.env`) holds a real `OPENAI_API_KEY` for the local live smoke.

---

## File Structure

- `packages/testing/src/fixture-file.ts` (new) — `loadFixtures`, `writeFixtures`.
- `packages/testing/src/aimock-runner.ts` (modify) — `startAimock` gains a `proxy?: { openai: string }` option → LLMock `record`/`proxyOnly` config.
- `packages/testing/src/harness.ts` (modify) — `AgentHarnessOptions.live?: boolean`; live wiring (proxy aimock, keep real key, guard, ignore fixtures).
- `packages/testing/src/index.ts` (modify) — export `loadFixtures`/`writeFixtures`.
- `packages/testing/test/*.test.ts` — unit + round-trip + gated live smoke.
- `packages/devkit/templates/app-basic/{package.json.template, test/agent.test.ts.template}` — scaffold sample.
- `apps/web/content/docs/testing-agents.mdx` (modify) — docs.

---

## Task 1: `loadFixtures` / `writeFixtures`

**Files:**
- Create: `packages/testing/src/fixture-file.ts`
- Test: `packages/testing/test/fixture-file.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/testing/test/fixture-file.test.ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { loadFixtures, writeFixtures } from "../src/fixture-file.js"
import { script } from "../src/fixture-builder.js"

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

function tmp(): string { dir = mkdtempSync(join(tmpdir(), "dt-fx-")); return dir }

it("writeFixtures + loadFixtures round-trips a script() builder", () => {
  const path = join(tmp(), "x.fixture.json")
  writeFixtures(path, script().user("hi").callsTool("greet", { tenant: "acme" }).replies("hello"))
  const loaded = loadFixtures(path)
  expect(loaded).toEqual(
    script().user("hi").callsTool("greet", { tenant: "acme" }).replies("hello").build(),
  )
})

it("writeFixtures accepts a bare FixtureSet", () => {
  const path = join(tmp(), "y.fixture.json")
  const set = [{ match: { userMessage: "a" }, response: { content: "b" } }]
  writeFixtures(path, set)
  expect(loadFixtures(path)).toEqual(set)
})

it("loadFixtures reads a bare-array file too", () => {
  const path = join(tmp(), "z.json")
  writeFixtures(path, [{ match: {}, response: { content: "ok" } }])
  // simulate a bare-array file (no { fixtures } wrapper)
  const fs = require("node:fs") as typeof import("node:fs")
  fs.writeFileSync(path, JSON.stringify([{ match: {}, response: { content: "bare" } }]))
  expect(loadFixtures(path)).toEqual([{ match: {}, response: { content: "bare" } }])
})

it("loadFixtures throws a clear error on a missing file", () => {
  expect(() => loadFixtures("/no/such/file.json")).toThrow(/fixture file/i)
})

it("loadFixtures throws on invalid fixture JSON", () => {
  const path = join(tmp(), "bad.json")
  const fs = require("node:fs") as typeof import("node:fs")
  fs.writeFileSync(path, JSON.stringify({ nope: true }))
  expect(() => loadFixtures(path)).toThrow(/fixture/i)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/fixture-file.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/testing/src/fixture-file.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { AimockFixture, FixtureSet, ScriptBuilder } from "./fixture-builder.js"

function toFixtureSet(f: FixtureSet | ScriptBuilder): FixtureSet {
  return Array.isArray(f) ? f : f.build()
}

/**
 * Write fixtures to a committed JSON file as `{ "fixtures": [...] }` (pretty,
 * stable key order) so PR diffs are reviewable. Accepts a `script()` builder
 * or a bare `FixtureSet`. Creates parent directories as needed.
 */
export function writeFixtures(path: string, fixtures: FixtureSet | ScriptBuilder): void {
  const set = toFixtureSet(fixtures)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ fixtures: set }, null, 2)}\n`, "utf8")
}

/**
 * Load committed fixtures from a JSON file. Accepts both `{ "fixtures": [...] }`
 * and a bare `[...]` array. Returns a `FixtureSet` usable directly in
 * `createAgentHarness({ fixtures })` or `harness.run({ fixtures })`.
 */
export function loadFixtures(path: string): FixtureSet {
  if (!existsSync(path)) {
    throw new Error(`loadFixtures: fixture file not found: ${path}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    throw new Error(`loadFixtures: ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { fixtures?: unknown }).fixtures)
      ? (parsed as { fixtures: unknown[] }).fixtures
      : undefined
  if (!arr) {
    throw new Error(`loadFixtures: ${path} is not a fixture file (expected an array or { "fixtures": [...] })`)
  }
  return arr as AimockFixture[]
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/fixture-file.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/fixture-file.ts packages/testing/test/fixture-file.test.ts
git commit -m "feat(testing): loadFixtures/writeFixtures (commit + replay fixture files)"
```

---

## Task 2: `startAimock` proxy-record option

**Files:**
- Modify: `packages/testing/src/aimock-runner.ts`
- Test: `packages/testing/test/aimock-runner.test.ts` (extend)

- [ ] **Step 1: Confirm the aimock proxy config shape**

Read `node_modules/.pnpm/@copilotkit+aimock@*/node_modules/@copilotkit/aimock/dist/types.d.ts` → `MockServerOptions.record?: RecordConfig`, `RecordConfig = { providers: Partial<Record<"openai"|..., string>>, proxyOnly?: boolean }`. Confirm the `LLMock` constructor accepts `{ record }`.

- [ ] **Step 2: Write the failing test** (append)

```ts
it("accepts a proxy option and exposes the journal (no real upstream call here)", async () => {
  // proxyOnly config is set; we don't actually hit OpenAI in this unit test —
  // just assert the handle is constructed and getRequests() works.
  const mock = await startAimock({ fixtures: [], proxy: { openai: "https://api.openai.com" } })
  try {
    expect(mock.baseUrl).toMatch(/\/v1$/)
    expect(Array.isArray(mock.getRequests())).toBe(true)
  } finally {
    await mock.stop()
  }
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/aimock-runner.test.ts`
Expected: FAIL — `proxy` not accepted / type error.

- [ ] **Step 4: Implement**

Update `startAimock`'s options + the `LLMock` construction:

```ts
export async function startAimock(opts: {
  readonly fixtures: readonly AimockFixture[]
  /** When set, unmatched requests are proxied to the given real upstream(s) and journaled (live/proxy-record mode). */
  readonly proxy?: { readonly openai: string }
}): Promise<AimockHandle> {
  const mock = opts.proxy
    ? new LLMock({ port: 0, chunkSize: 4096, record: { providers: { openai: opts.proxy.openai }, proxyOnly: true } })
    : new LLMock({ port: 0, chunkSize: 4096 })
  if (opts.fixtures.length > 0) {
    mock.addFixturesFromJSON(opts.fixtures as never)
  }
  await mock.start()
  // ...existing return (port/baseUrl/addFixtures/getRequests/stop) unchanged...
}
```
(Keep the rest of the function identical. If TS complains about the `record` field name/shape, align it to the real `MockServerOptions`/`RecordConfig` from Step 1.)

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/aimock-runner.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/testing/src/aimock-runner.ts packages/testing/test/aimock-runner.test.ts
git commit -m "feat(testing): startAimock proxy-record option (proxy unmatched to real upstream, still journaled)"
```

---

## Task 3: Harness `live` mode

**Files:**
- Modify: `packages/testing/src/harness.ts`
- Test: `packages/testing/test/harness-live.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/testing/test/harness-live.test.ts
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

let savedKey: string | undefined
beforeEach(() => { savedKey = process.env.OPENAI_API_KEY })
afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = savedKey
})

it("live mode throws when OPENAI_API_KEY is absent", async () => {
  delete process.env.OPENAI_API_KEY
  await expect(createAgentHarness({ appRoot, route: "/chat#agent", live: true })).rejects.toThrow(/OPENAI_API_KEY/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/harness-live.test.ts`
Expected: FAIL — `live` not accepted, or no throw.

- [ ] **Step 3: Implement**

Add `live?: boolean` to `AgentHarnessOptions`. In `createAgentHarness`, before starting aimock:

```ts
  const live = options.live ?? false
  if (live && !process.env.OPENAI_API_KEY) {
    throw new Error("createAgentHarness({ live: true }) requires a real OPENAI_API_KEY in the environment")
  }
```

Change the aimock start + env wiring to branch on `live`:

```ts
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY

  const aimock: AimockHandle = live
    ? await startAimock({ fixtures: [], proxy: { openai: "https://api.openai.com" } })
    : await startAimock({ fixtures: options.fixtures ?? [] })
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  // Live mode: keep the REAL key so the proxy can authenticate upstream.
  // Mocked mode: dummy key is fine.
  if (!live) process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
```

In `run()`/`resume()` (or the shared `drive()`), when `live`, ignore per-call `fixtures` (the real model responds) — guard the `addFixtures` call:

```ts
    async run(runOpts) {
      if (!live && runOpts.fixtures) {
        const f = toFixtureSet(runOpts.fixtures)
        if (f.length > 0) aimock.addFixtures(f)
      } else if (live && runOpts.fixtures && process.env.DAWN_DEBUG_TESTING === "1") {
        console.warn("[dawn-testing] live mode ignores fixtures — the real model responds")
      }
      return drive({ input: { messages: [{ role: "user", content: runOpts.input }] } })
    },
```
(Apply the same `!live` guard to `resume()`'s fixture handling if present.)

The journal/systemPrompt logic in `drive()` is unchanged — proxy mode still journals, so `systemPrompt` is populated live.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dawn-ai/testing exec vitest --run test/harness-live.test.ts`
Expected: PASS (the guard throws).

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/harness.ts packages/testing/test/harness-live.test.ts
git commit -m "feat(testing): createAgentHarness({ live: true }) proxy-record mode"
```

---

## Task 4: Public barrel + fixture-file round-trip integration test

**Files:**
- Modify: `packages/testing/src/index.ts`
- Test: `packages/testing/test/fixture-file-e2e.test.ts`

- [ ] **Step 1: Export the new file API**

Add to `packages/testing/src/index.ts`:

```ts
export { loadFixtures, writeFixtures } from "./fixture-file.js"
```

- [ ] **Step 2: Write the integration test** (mocked, runs in CI — proves committed fixtures replay through the harness)

```ts
// packages/testing/test/fixture-file-e2e.test.ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { createAgentHarness, expectToolCalled, loadFixtures, script, writeFixtures } from "../src/index.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const dir = mkdtempSync(join(tmpdir(), "dt-fxe2e-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

it("a committed fixture file replays through the harness", async () => {
  const path = join(dir, "filter.fixture.json")
  writeFixtures(
    path,
    script().user("Filter open items").callsTool("applyFilter", { status: "open" }).replies("Found 2."),
  )
  const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
  try {
    const run = await h.run({ input: "Filter open items", fixtures: loadFixtures(path) })
    expectToolCalled(run, "applyFilter").withArgs({ status: "open" })
    expect(run.finalMessage).toContain("Found 2")
  } finally {
    await h.close()
  }
}, 60_000)
```

(Uses the existing probe app at `packages/testing/test/fixtures/probe-app` with route `/chat#agent` + tool `applyFilter` — confirm those exist from the prior increments.)

- [ ] **Step 3: Validate**

Run:
```
pnpm --filter @dawn-ai/testing build
pnpm --filter @dawn-ai/testing exec vitest --run test/fixture-file-e2e.test.ts
pnpm --filter @dawn-ai/testing typecheck && pnpm --filter @dawn-ai/testing lint && pnpm --filter @dawn-ai/testing test
```
Expected: all green. `biome check --write` if formatting flagged.

- [ ] **Step 4: Commit**

```bash
git add packages/testing/src/index.ts packages/testing/test/fixture-file-e2e.test.ts
git commit -m "feat(testing): export loadFixtures/writeFixtures + committed-fixture replay e2e"
```

---

## Task 5: Gated live smoke (local/manual, skips in CI)

**Files:**
- Test: `packages/testing/test/live-smoke.test.ts`

- [ ] **Step 1: Write the gated smoke**

```ts
// packages/testing/test/live-smoke.test.ts
// LIVE: hits the real model via aimock proxy-record. Gated on OPENAI_API_KEY,
// so it SKIPS in CI (no key secret) and runs only locally with a real key.
import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { createAgentHarness, expectToolCalled } from "../src/index.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

it.skipIf(!process.env.OPENAI_API_KEY)(
  "live: the real model drives the applyFilter tool",
  async () => {
    const h = await createAgentHarness({ appRoot, route: "/chat#agent", live: true })
    try {
      const run = await h.run({ input: "Filter the open items, please." })
      // Loose assertions — real model is nondeterministic.
      expectToolCalled(run, "applyFilter")
      expect(run.finalMessage.length).toBeGreaterThan(0)
      expect(run.systemPrompt.length).toBeGreaterThan(0) // proxy-record retains systemPrompt
    } finally {
      await h.close()
    }
  },
  120_000,
)
```

(The probe app's `applyFilter` tool + its `systemPrompt` should make the real model call the tool for this prompt. If the real model is inconsistent, loosen further — assert only `finalMessage`/`systemPrompt` non-empty + no throw.)

- [ ] **Step 2: Verify it SKIPS without a key**

Run (no key): `env -u OPENAI_API_KEY pnpm --filter @dawn-ai/testing exec vitest --run test/live-smoke.test.ts`
Expected: the test is SKIPPED (0 failures). This is what CI sees.

- [ ] **Step 3: Verify it PASSES locally with the real key**

Run with the repo key:
```
export OPENAI_API_KEY=$(grep -E '^OPENAI_API_KEY=' /Users/blove/repos/dawn/.env | cut -d= -f2-)
pnpm --filter @dawn-ai/testing exec vitest --run test/live-smoke.test.ts 2>&1 | tail -15
```
Expected: PASS (real model call via proxy; `applyFilter` called; systemPrompt non-empty). Paste the result. If the live model genuinely won't call the tool for this prompt, adjust the input or loosen the assertion to `finalMessage`/`systemPrompt` non-empty, and note it. Do NOT add the key to CI.

- [ ] **Step 4: Commit**

```bash
git add packages/testing/test/live-smoke.test.ts
git commit -m "test(testing): gated live (proxy-record) smoke — skips in CI"
```

---

## Task 6: `create-dawn-app` scaffold sample test

**Files:**
- Modify: `packages/devkit/templates/app-basic/package.json.template`
- Create: `packages/devkit/templates/app-basic/test/agent.test.ts` (or `.template` — match how devkit copies non-suffixed files; see Step 1)

- [ ] **Step 1: Confirm template-copy conventions + the route key**

Read `@dawn-ai/devkit`'s `writeTemplate`/`resolveTemplateDir` (`packages/devkit/src/...`) to learn: (a) which files get `{{placeholder}}` substitution + the `.template` suffix-stripping rule (`package.json.template` → `package.json`), and (b) whether a plain `.ts` test file is copied verbatim. Also confirm how the harness addresses the template's parameterized route `src/app/(public)/hello/[tenant]/index.ts` — run `createRuntimeRegistry(appRoot).lookup(<key>)` mentally: the key is likely `/hello/[tenant]#agent`. Determine whether `createAgentHarness({ route })` + `run()` can drive a `[tenant]` param route in-process (check how params are supplied — via the route key or input). 

- [ ] **Step 2: Add `@dawn-ai/testing` devDep + a test script to `package.json.template`**

```jsonc
  "scripts": {
    "check": "dawn check",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  // ...
  "devDependencies": {
    "@dawn-ai/config-typescript": "{{dawnConfigTypescriptSpecifier}}",
    "@dawn-ai/testing": "{{dawnTestingSpecifier}}",
    "@types/node": "25.6.0",
    "typescript": "6.0.2",
    "vitest": "4.1.4"
  }
```
Then check `create-dawn-app`'s `createTemplateReplacements` (`packages/create-dawn-app/src/index.ts`) — add a `{{dawnTestingSpecifier}}` replacement alongside the existing `{{dawn*Specifier}}` ones (use the same version-resolution the others use). Verify the exact placeholder mechanism and mirror it.

- [ ] **Step 3: Add the sample test**

Write a sample that targets the template's route. PREFERRED (if Step 1 shows the harness drives the `[tenant]` route):

```ts
// packages/devkit/templates/app-basic/test/agent.test.ts
import { fileURLToPath } from "node:url"
import { afterAll, it } from "vitest"
import { createAgentHarness, expectFinalMessage, script } from "@dawn-ai/testing"

const appRoot = fileURLToPath(new URL("..", import.meta.url))
const h = await createAgentHarness({ appRoot, route: "/hello/[tenant]#agent" })
afterAll(() => h.close())

it("greets the tenant", async () => {
  const run = await h.run({
    input: "Say hello",
    fixtures: script().user("Say hello").replies("Hello from Acme!"),
  })
  expectFinalMessage(run).toContain("Hello")
}, 60_000)
```

FALLBACK (only if a `[tenant]` param route can NOT be driven by the harness in-process): add a minimal param-free agent route to the template for the sample to target —
`packages/devkit/templates/app-basic/src/app/(public)/ping/index.ts`:
```ts
import { agent } from "@dawn-ai/sdk"
export default agent({ model: "gpt-4o-mini", systemPrompt: "You are a friendly ping agent. Reply briefly." })
```
— and point the sample test at `route: "/ping#agent"`. Report which path you took and why.

Confirm the test file is copied by the template writer (if devkit only copies known suffixes, name it `test/agent.test.ts.template` and verify it lands as `test/agent.test.ts` with no unwanted substitution — the file has no `{{...}}` tokens so substitution is a no-op).

- [ ] **Step 4: Validate by generating an app + running its test**

Read how the existing devkit/create-dawn-app tests generate an app (e.g. `createGeneratedApp` in `@dawn-ai/devkit/testing`, used by the runtime lane). Generate a scaffolded app into a temp dir, `pnpm install`, and run its `test` script; confirm the sample test passes. If a full generate+install is too heavy for a unit test, at minimum:
```
cd /Users/blove/repos/dawn-fxlive
pnpm --filter @dawn-ai/devkit build && pnpm --filter @dawn-ai/devkit test 2>&1 | tail -10
pnpm --filter create-dawn-app test 2>&1 | tail -10
```
and add/extend a devkit-or-create-dawn-app test asserting the generated app includes `test/agent.test.ts` + the `@dawn-ai/testing` devDep + the `test` script. Paste results.

- [ ] **Step 5: Commit**

```bash
git add packages/devkit/templates/app-basic packages/create-dawn-app/src/index.ts pnpm-lock.yaml 2>/dev/null
git commit -m "feat(create-dawn-app): scaffold a sample @dawn-ai/testing agent test in new apps"
```

---

## Task 7: Docs

**Files:**
- Modify: `apps/web/content/docs/testing-agents.mdx`

- [ ] **Step 1: Extend the testing guide**

Read the existing page, then add three sections (match its existing `.mdx` style — plain headings, code fences):
1. **Fixtures: author, commit, replay** — `script()` inline, or `record({ out })` from a real model, or `writeFixtures(path, script()...)`; commit the `*.fixture.json`; replay with `createAgentHarness({ fixtures: loadFixtures(path) })` / `h.run({ fixtures: loadFixtures(path) })`. Note CI replays read-only; `record()` is local-only.
2. **Live mode** — `createAgentHarness({ live: true })` runs the real model via aimock proxy-record (real responses + `run.systemPrompt` retained); requires `OPENAI_API_KEY`; assert loosely (real models are nondeterministic); gate with `it.skipIf(!process.env.OPENAI_API_KEY)` so CI skips it.
3. **Your scaffolded app has a test** — `create-dawn-app` ships `test/agent.test.ts`; run `pnpm test`; grow it with more `script()` scenarios + matchers.

Keep code snippets copy-pasteable and use the real exported names.

- [ ] **Step 2: Validate docs build**

Run: `node scripts/check-docs.mjs 2>&1 | tail -5` (the CI "Docs Check"). Expected: pass. If the docs site has a typecheck/build for mdx, run it.

- [ ] **Step 3: Commit**

```bash
git add apps/web/content/docs/testing-agents.mdx
git commit -m "docs(testing): fixtures workflow, live mode, scaffolded test"
```

---

## Task 8: Changeset, validate, PR, memory

**Files:**
- Create: `.changeset/testing-fixture-files-live.md`

- [ ] **Step 1: Changeset**

```md
---
"@dawn-ai/testing": minor
"create-dawn-app": minor
---

`@dawn-ai/testing`: close the fixture record→commit→replay loop with `loadFixtures(path)` / `writeFixtures(path, script()|FixtureSet)`, and add a gated live mode — `createAgentHarness({ live: true })` runs the real model via aimock proxy-record (real responses, with `run.systemPrompt` retained), requiring `OPENAI_API_KEY` and meant to be gated with `skipIf` (never in CI). `create-dawn-app` now scaffolds a sample `test/agent.test.ts` + the `@dawn-ai/testing` devDependency so new apps ship with a passing agent test. Drift detection remains deferred.
```
(If `create-dawn-app`'s package name differs, use its real name; if it isn't independently versioned, drop that line and keep `@dawn-ai/testing` minor.)

- [ ] **Step 2: Full validation**

Run:
```
cd /Users/blove/repos/dawn-fxlive
pnpm install
pnpm -r --filter "@dawn-ai/*" build 2>&1 | tail -3
pnpm --filter @dawn-ai/testing typecheck && pnpm --filter @dawn-ai/testing lint && pnpm --filter @dawn-ai/testing test 2>&1 | grep -E "Test Files|Tests "
pnpm --filter @dawn-ai/devkit test 2>&1 | grep -E "Test Files|Tests "
env -u OPENAI_API_KEY pnpm --filter @dawn-ai/testing exec vitest --run test/live-smoke.test.ts 2>&1 | grep -E "skipped|Tests "
```
Expected: green; the live smoke SKIPS without a key. Revert any `apps/web/next-env.d.ts` churn.

- [ ] **Step 3: Commit, push, PR, auto-merge**

```bash
git add .changeset/testing-fixture-files-live.md
git commit -m "chore: changeset for @dawn-ai/testing fixture files + live mode + scaffold"
git push -u origin feat/testing-fixture-files-live
gh pr create --title "feat(testing): fixture files (record→commit→replay) + live proxy-record mode + scaffold sample" --body-file <(printf '%s\n' "loadFixtures/writeFixtures close the record→commit→replay loop; createAgentHarness({ live: true }) runs the real model via aimock proxy-record (gated, never in CI); create-dawn-app ships a sample agent test. No framework changes; drift deferred. Spec: docs/superpowers/specs/2026-06-06-testing-fixture-files-live-mode-design.md" "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)") --base main --head feat/testing-fixture-files-live
gh pr merge --auto --squash
```

- [ ] **Step 4: Update phase memory**

Append to `memory/project_phase_status.md`: this increment shipped (fixture files + live proxy-record mode + scaffold); drift detection still the deferred future phase.

---

## Self-review notes (for the executor)

- **Type consistency:** `loadFixtures`/`writeFixtures` (Task 1) return/accept `FixtureSet` (= `AimockFixture[]`) — the same type `createAgentHarness({fixtures})`/`run({fixtures})` already accept, so they compose with no adapter (Task 4). `startAimock`'s new `proxy` option (Task 2) is consumed by the harness `live` path (Task 3). `live` defaults false → existing mocked behavior unchanged.
- **Live mode keeps the real key; mocked mode dummies it** — don't dummy the key in the live branch (the proxy needs it upstream).
- **systemPrompt works live** because proxy mode still journals — `drive()`'s existing `systemPromptFromRequests` is reused unchanged.
- **The scaffold route-param question (Task 6) is the main unknown** — verify harness param-route support first; the fallback (a param-free `ping` agent route) is concrete. Don't ship a sample test that can't run.
- **Never add `OPENAI_API_KEY` to CI** — the live smoke must skip there. Verify the skip (Task 5 Step 2, Task 8 Step 2).
- **No framework changes** — everything is in `@dawn-ai/testing`, the devkit template, create-dawn-app replacements, and docs. If something seems to need a runtime change, stop and reconsider.
```
