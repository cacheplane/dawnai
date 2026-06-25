# Long-Term Memory Local Smoke + E2E Test — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a gated live-smoke vitest suite + a manual runbook that verify the merged long-term memory feature against a real model locally.

**Architecture:** A `it.skipIf(!OPENAI_API_KEY)` suite drives the in-process harness in live mode (`createAgentHarness({ live: true })`) against probe fixture routes and asserts on deterministic surfaces (tool-was-called via `expectToolCalled`, the `recall` tool's output content, `finalMessage`, and the `dawn memory` CLI via `runMemoryCommand`). Auto-mode scenarios run against the existing probe-app (`writes:"auto"`); candidate governance runs against a new `probe-app-memory-candidate` fixture (since `memory.writes` is app-wide). A committed runbook covers the manual `dawn dev` / Agent-Protocol experience.

**Tech Stack:** vitest, `@dawn-ai/testing` harness (live mode → real OpenAI), `@dawn-ai/memory` (`sqliteMemoryStore`), `@dawn-ai/cli` (`runMemoryCommand`), `node:fs`.

**Branch:** `test/memory-live-smoke` (created off main). Spec: `docs/superpowers/specs/2026-06-19-memory-live-smoke-design.md`.

**CRITICAL execution note:** the suite REQUIRES a real `OPENAI_API_KEY` to actually execute; without it every test SKIPS. Subagents run WITHOUT the key, so their verification is only "the file typechecks, lints, and SKIPS cleanly (vitest reports skipped, 0 failed)". The real live run — actually executing against the model — is done in the FINAL task by the operator (who sources the key from `/Users/blove/repos/dawn/.env`). **Never print the key; never add this suite to any CI lane.**

**Conventions:** prefix shell with `cd /Users/blove/repos/dawn`. Lint via the package script (`pnpm --filter @dawn-ai/testing run lint`), never bare `biome check --write`. Commit after each task with the shown message.

---

## File Structure

- `packages/testing/test/fixtures/probe-app/src/app/memory-other/index.ts` + `memory.ts` — a second auto-mode memory route (for the isolation scenario).
- `packages/testing/test/fixtures/probe-app-memory-candidate/` — a minimal app with `writes:"candidate"`: `package.json`, `dawn.config.ts`, `src/app/notes/index.ts`, `src/app/notes/memory.ts`.
- `packages/testing/test/memory-live.smoke.test.ts` — the gated suite (6 scenarios).
- `docs/superpowers/runbooks/2026-06-19-memory-live-smoke-runbook.md` — manual session checklist.
- `apps/web/content/docs/memory.mdx` — a short "verify locally" pointer (modify).

---

## PHASE 1 — Fixtures

### Task 1.1: Second auto route `/memory-other` (isolation)

**Files:**
- Create: `packages/testing/test/fixtures/probe-app/src/app/memory-other/index.ts`
- Create: `packages/testing/test/fixtures/probe-app/src/app/memory-other/memory.ts`

- [ ] **Step 1: Create the route index** (mirror `memory-chat/index.ts`)

```ts
// packages/testing/test/fixtures/probe-app/src/app/memory-other/index.ts
import { agent } from "@dawn-ai/sdk"
export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a second test agent with its own long-term memory. Use remember/recall when asked.",
})
```

- [ ] **Step 2: Create its memory.ts** (same shape as `memory-chat/memory.ts`; route-scoped → distinct namespace)

```ts
// packages/testing/test/fixtures/probe-app/src/app/memory-other/memory.ts
import { defineMemory } from "@dawn-ai/sdk"
import { z } from "zod"
export default defineMemory({
  kind: "semantic",
  scope: ["route"],
  schema: z.object({ subject: z.string(), predicate: z.string(), value: z.string() }),
})
```

- [ ] **Step 3: Confirm it doesn't break existing probe tests**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/testing test`
Expected: green (the new route adds a memory capability only to `/memory-other`; existing `/chat` and `/memory-chat` tests unaffected). Report the count.

- [ ] **Step 4: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/testing/test/fixtures/probe-app/src/app/memory-other
git commit -m "test(fixtures): second auto memory route /memory-other for isolation smoke"
```

### Task 1.2: Candidate-mode fixture app

**Files:**
- Create: `packages/testing/test/fixtures/probe-app-memory-candidate/package.json`
- Create: `packages/testing/test/fixtures/probe-app-memory-candidate/dawn.config.ts`
- Create: `packages/testing/test/fixtures/probe-app-memory-candidate/src/app/notes/index.ts`
- Create: `packages/testing/test/fixtures/probe-app-memory-candidate/src/app/notes/memory.ts`

- [ ] **Step 1: Create the four files**

```jsonc
// packages/testing/test/fixtures/probe-app-memory-candidate/package.json
{
  "name": "probe-app-memory-candidate",
  "private": true,
  "type": "module"
}
```

```ts
// packages/testing/test/fixtures/probe-app-memory-candidate/dawn.config.ts
export default { memory: { writes: "candidate" } }
```

```ts
// packages/testing/test/fixtures/probe-app-memory-candidate/src/app/notes/index.ts
import { agent } from "@dawn-ai/sdk"
export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a note-taking agent with long-term memory in candidate (review) mode. Use remember/recall when asked.",
})
```

```ts
// packages/testing/test/fixtures/probe-app-memory-candidate/src/app/notes/memory.ts
import { defineMemory } from "@dawn-ai/sdk"
import { z } from "zod"
export default defineMemory({
  kind: "semantic",
  scope: ["route"],
  schema: z.object({ subject: z.string(), predicate: z.string(), value: z.string() }),
})
```

- [ ] **Step 2: Verify the route resolves** (typegen/discovery sanity — build is enough; the suite exercises it live)

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/testing exec tsc -b tsconfig.json 2>/dev/null; echo "fixtures are .ts under test/, not compiled by the package build — OK if no error about them"`
(These fixture files are loaded at runtime via tsx by the harness, not compiled by the package; no test asserts on them yet.)

- [ ] **Step 3: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/testing/test/fixtures/probe-app-memory-candidate
git commit -m "test(fixtures): candidate-mode memory app for governance smoke"
```

---

## PHASE 2 — Gated live-smoke suite

All scenarios live in `packages/testing/test/memory-live.smoke.test.ts`. Shared header:

```ts
// LIVE SMOKE — long-term memory against a real model. Gated on OPENAI_API_KEY:
// SKIPS in CI (no key) and runs only locally. Never add to a CI lane; never print the key.
import { rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"
import { sqliteMemoryStore } from "@dawn-ai/memory"
import { runMemoryCommand } from "@dawn-ai/cli/commands/memory"   // SEE Task 2.1 NOTE on the import path
import { createAgentHarness } from "../src/harness.js"
import { expectToolCalled } from "../src/matchers.js"

const live = Boolean(process.env.OPENAI_API_KEY)
const probeRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const candidateRoot = fileURLToPath(new URL("./fixtures/probe-app-memory-candidate", import.meta.url))

function dbPath(root: string): string {
  return join(root, ".dawn", "memory.sqlite")
}
function cleanDb(root: string): void {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath(root)}${s}`, { force: true })
}
const io = { stdout: () => {}, stderr: () => {} }
```

Each test: `beforeEach`/`afterEach` clean BOTH app DBs. Add `cleanDb` calls in a `beforeEach(() => { cleanDb(probeRoot); cleanDb(candidateRoot) })` and the same in `afterEach`.

### Task 2.1: Resolve the `runMemoryCommand` import + scenario 1–2 (remember + cross-thread recall)

**Files:** Create `packages/testing/test/memory-live.smoke.test.ts`

- [ ] **Step 1: Confirm how to import `runMemoryCommand` from `@dawn-ai/cli`.** Check the CLI's exports map: `cd /Users/blove/repos/dawn && cat packages/cli/package.json | grep -A20 '"exports"'`. `runMemoryCommand` is exported from `packages/cli/src/commands/memory.ts`. If `@dawn-ai/cli` has a `./commands/memory` (or `./runtime`-style) subpath export, use it. If NOT, the cleanest options in order: (a) add a subpath export to the CLI package (small, mirrors the existing `@dawn-ai/cli/runtime` export the testing package already uses), OR (b) import the store-driving CLI behavior by calling the store directly + a thin `approve` helper. **Decision for this plan:** prefer (a) — add `"./commands/memory"` to the CLI `exports` pointing at `dist/commands/memory.js`, since the testing package already depends on `@dawn-ai/cli` and uses its `/runtime` subpath. Do that as the first step here, build the CLI, then import `runMemoryCommand`.

- [ ] **Step 2: Write the file header + scenarios 1–2.**

```ts
it.skipIf(!live)("remembers a fact and recalls it cross-thread (auto mode)", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/memory-chat#agent", live: true })
  try {
    h.reset()
    const r1 = await h.run({
      input: "Remember this durable fact for later: acme escalates billing above 500 dollars.",
    })
    expectToolCalled(r1, "remember")

    // The write landed in the store (deterministic surface — don't assert the model's wording).
    const store = sqliteMemoryStore({ path: dbPath(probeRoot) })
    const active = await store.search({ namespace: "route=/memory-chat", status: "active", query: "billing" })
    expect(active.length).toBeGreaterThanOrEqual(1)

    // Fresh thread: the agent recalls it.
    h.reset()
    const r2 = await h.run({ input: "Using your long-term memory, what is acme's billing escalation threshold?" })
    expectToolCalled(r2, "recall")
    const recall = r2.toolResults.find((t) => t.name === "recall")
    expect(String(recall?.content ?? "")).toContain("500")
    expect(r2.finalMessage).toContain("500")
  } finally {
    await h.close()
  }
}, 120_000)
```

(NOTE on the namespace string: the probe `/memory-chat` route declares `scope: ["route"]`, so the namespace is `route=/memory-chat` after `routeNamespaceKey` normalization. If the live run shows zero rows, log `await sqliteMemoryStore({path}).listCandidates("")` and the active search without a namespace filter to discover the actual namespace, then fix the assertion — but prefer asserting via the `recall` tool output, which is namespace-agnostic.)

- [ ] **Step 3: Verify it SKIPS cleanly without a key**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/testing exec vitest run test/memory-live.smoke.test.ts`
Expected: `1 skipped`, 0 failed. (Subagents cannot run it live.)

- [ ] **Step 4: typecheck + lint** (`pnpm --filter @dawn-ai/testing exec tsc -b tsconfig.json` clean; `pnpm --filter @dawn-ai/testing run lint` 0 errors).

- [ ] **Step 5: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/cli/package.json packages/testing/test/memory-live.smoke.test.ts
git commit -m "test(testing): live-smoke scenarios 1-2 (remember + cross-thread recall)"
```

### Task 2.2: Scenario 3 (supersession) + scenario 4 (namespace isolation)

**Files:** Modify `packages/testing/test/memory-live.smoke.test.ts`

- [ ] **Step 1: Append scenarios 3 and 4.**

```ts
it.skipIf(!live)("supersedes a contradicting value (auto mode)", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/memory-chat#agent", live: true })
  try {
    h.reset()
    await h.run({ input: "Remember: acme escalates billing above 500 dollars." })
    h.reset()
    await h.run({ input: "Update your memory: acme now escalates billing above 750 dollars." })

    const store = sqliteMemoryStore({ path: dbPath(probeRoot) })
    const active = await store.search({ namespace: "route=/memory-chat", status: "active", query: "billing" })
    const superseded = await store.search({ namespace: "route=/memory-chat", status: "superseded", query: "billing" })
    // Newest value is active; the old one is superseded (history retained).
    expect(active.some((r) => JSON.stringify(r.data).includes("750"))).toBe(true)
    expect(superseded.some((r) => JSON.stringify(r.data).includes("500"))).toBe(true)

    h.reset()
    const r = await h.run({ input: "Recall the current acme billing escalation threshold." })
    expect(String(r.toolResults.find((t) => t.name === "recall")?.content ?? "")).toContain("750")
  } finally {
    await h.close()
  }
}, 150_000)

it.skipIf(!live)("isolates memory by route namespace", async () => {
  // Write under /memory-chat.
  const a = await createAgentHarness({ appRoot: probeRoot, route: "/memory-chat#agent", live: true })
  try {
    a.reset()
    await a.run({ input: "Remember: the secret code for chat is ALPHA-111." })
  } finally {
    await a.close()
  }
  // A different route (/memory-other) must NOT recall it (distinct route-scoped namespace).
  const b = await createAgentHarness({ appRoot: probeRoot, route: "/memory-other#agent", live: true })
  try {
    b.reset()
    const r = await b.run({ input: "Using your memory, what is the secret code for chat? If you have no memory of it, say you don't know." })
    const recall = r.toolResults.find((t) => t.name === "recall")
    // /memory-other's recall is scoped to its own namespace → must not contain the other route's secret.
    expect(String(recall?.content ?? "")).not.toContain("ALPHA-111")
    expect(r.finalMessage).not.toContain("ALPHA-111")
  } finally {
    await b.close()
  }
}, 150_000)
```

- [ ] **Step 2: SKIP-clean + typecheck + lint** (as Task 2.1 steps 3–4; now `3 skipped`).

- [ ] **Step 3: Commit** `test(testing): live-smoke scenarios 3-4 (supersession + isolation)`

### Task 2.3: Scenario 5 (memory-index injection)

**Files:** Modify `packages/testing/test/memory-live.smoke.test.ts`

- [ ] **Step 1: Append scenario 5.** A memory must exist BEFORE the run whose systemPrompt we inspect; the capability re-reads the index each run, so remember in run 1, then assert run 2's systemPrompt carries the index.

```ts
it.skipIf(!live)("injects a memory index into the system prompt once memories exist", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/memory-chat#agent", live: true })
  try {
    h.reset()
    await h.run({ input: "Remember: acme escalates billing above 500 dollars." })
    h.reset()
    const r = await h.run({ input: "Hello." })
    // The capability injects a "# Long-Term Memory" index block listing recallable memories.
    expect(r.systemPrompt).toContain("Long-Term Memory")
  } finally {
    await h.close()
  }
}, 120_000)
```

- [ ] **Step 2: SKIP-clean + typecheck + lint** (`4 skipped`).
- [ ] **Step 3: Commit** `test(testing): live-smoke scenario 5 (memory-index injection)`

### Task 2.4: Scenario 6 (candidate → approve → recall via CLI)

**Files:** Modify `packages/testing/test/memory-live.smoke.test.ts`

- [ ] **Step 1: Append scenario 6** (candidate fixture app; drives `runMemoryCommand`).

```ts
it.skipIf(!live)("candidate write is not recalled until approved via dawn memory CLI", async () => {
  const store = sqliteMemoryStore({ path: dbPath(candidateRoot) })

  // 1. Agent remembers → a CANDIDATE (writes:"candidate" in this app's dawn.config).
  const h1 = await createAgentHarness({ appRoot: candidateRoot, route: "/notes#agent", live: true })
  try {
    h1.reset()
    const r1 = await h1.run({ input: "Remember: this project uses pnpm as its package manager." })
    expectToolCalled(r1, "remember")
  } finally {
    await h1.close()
  }
  const candidates = await store.listCandidates("")
  expect(candidates.length).toBeGreaterThanOrEqual(1)
  const candidateId = candidates[0]!.id

  // 2. Before approval, recall does NOT surface the candidate (recall returns active only).
  const h2 = await createAgentHarness({ appRoot: candidateRoot, route: "/notes#agent", live: true })
  try {
    h2.reset()
    const r2 = await h2.run({ input: "Recall: what package manager does this project use? Say you don't know if you have no memory." })
    expect(String(r2.toolResults.find((t) => t.name === "recall")?.content ?? "")).not.toContain("pnpm")
  } finally {
    await h2.close()
  }

  // 3. Approve via the real CLI command.
  await runMemoryCommand(["approve", candidateId], { cwd: candidateRoot }, io)
  expect((await store.get(candidateId))?.status).toBe("active")

  // 4. Now recall surfaces it.
  const h3 = await createAgentHarness({ appRoot: candidateRoot, route: "/notes#agent", live: true })
  try {
    h3.reset()
    const r3 = await h3.run({ input: "Recall: what package manager does this project use?" })
    expect(String(r3.toolResults.find((t) => t.name === "recall")?.content ?? "")).toContain("pnpm")
  } finally {
    await h3.close()
  }

  // 5. forget hard-deletes.
  await runMemoryCommand(["forget", candidateId], { cwd: candidateRoot }, io)
  expect(await store.get(candidateId)).toBeNull()
}, 180_000)
```

- [ ] **Step 2: SKIP-clean + typecheck + lint** (`5 skipped`).
- [ ] **Step 3: Commit** `test(testing): live-smoke scenario 6 (candidate approve/forget via CLI)`

---

## PHASE 3 — Manual runbook + docs note

### Task 3.1: Manual session runbook

**Files:** Create `docs/superpowers/runbooks/2026-06-19-memory-live-smoke-runbook.md`

- [ ] **Step 1: Write the runbook** — a copy-pasteable checklist matching spec §"Deliverable 2". Include exactly: (1) internal-mode scaffold of the research template (`node packages/create-dawn-app/dist/bin.js /tmp/mem-smoke --mode internal --template research`, then `cd /tmp/mem-smoke && pnpm install && pnpm build`), (2) `set -a; . /Users/blove/repos/dawn/.env; set +a` (with a "never echo the key" warning) then `npx dawn check` + `npx dawn dev --port 2024`, (3) Agent-Protocol calls (`POST /threads` → `POST /threads/:id/runs/wait` body `{"route":"/research#agent","input":{"messages":[{"role":"user","content":"…"}]}}`) to remember in one thread and recall in another, (4) `npx dawn memory list/inspect/approve/reject/forget` against the candidate the research app produces (it defaults to candidate), (5) inspecting `.dawn/memory.sqlite` namespaces and confirming the system prompt carries AGENTS.md + route `memory.md` + the memory index together, (6) a per-aspect pass/fail checklist table. Include the exact curl commands.

- [ ] **Step 2: Commit**

```bash
cd /Users/blove/repos/dawn
git add docs/superpowers/runbooks/2026-06-19-memory-live-smoke-runbook.md
git commit -m "docs(runbook): manual local live-smoke session for long-term memory"
```

### Task 3.2: Docs pointer

**Files:** Modify `apps/web/content/docs/memory.mdx`

- [ ] **Step 1: Add a short "Verifying locally" note** at the end of the long-term-memory section pointing readers to the gated live-smoke suite (`packages/testing/test/memory-live.smoke.test.ts`, run locally with `OPENAI_API_KEY`) and the runbook. Keep it 2–4 sentences; do not add banned marketing phrases.

- [ ] **Step 2: Run the docs check**

Run: `cd /Users/blove/repos/dawn && node scripts/check-docs.mjs`
Expected: passes (you only edited prose on an existing registered page).

- [ ] **Step 3: Commit** `docs(memory): point to the local live-smoke suite + runbook`

---

## PHASE 4 — Local live run (operator, with the key)

> This task is performed by the OPERATOR (main agent / human) who has the authorized local key — NOT a subagent. It is the real verification.

### Task 4.1: Run the suite live and fix any real-model issues

- [ ] **Step 1: Build the packages the suite imports** (`pnpm --filter @dawn-ai/cli --filter @dawn-ai/memory --filter @dawn-ai/testing build`).
- [ ] **Step 2: Run live** with the key sourced from `.env` (never printed):

```bash
cd /Users/blove/repos/dawn
set -a; . /Users/blove/repos/dawn/.env; set +a
pnpm --filter @dawn-ai/testing exec vitest run test/memory-live.smoke.test.ts
```
Expected: 6 passed (0 skipped). 

- [ ] **Step 3: If any scenario fails,** diagnose with the run output. Likely real-model issues and fixes: (a) the model didn't call `remember`/`recall` → strengthen the prompt wording in that scenario's `input` (it's a test prompt, tune it); (b) a namespace-string assertion mismatched → switch that assertion to the namespace-agnostic `recall`-output check or discover the real namespace via `listCandidates`/an unfiltered search; (c) the candidate model picked a different `subject`/`predicate` → keep assertions on `value`/content substrings, not exact identity. Re-run until 6/6 green. Do NOT weaken an assertion in a way that would pass even if memory were broken (e.g. keep the "isolation: does NOT contain ALPHA-111" and "candidate: does NOT contain pnpm before approval" negative checks meaningful).
- [ ] **Step 4: Commit any test-prompt/assertion tuning** `test(testing): tune memory live-smoke prompts/assertions from a real-model run`.

### Task 4.2: Optional — execute the manual runbook once

- [ ] Walk the runbook end-to-end against a real model locally; record pass/fail per aspect in the runbook's checklist (or a scratch note). Fix any product bug surfaced (file a follow-up if it's a real defect, e.g. the memory index not appearing, a namespace leak, or a CLI error). This is exploratory verification, not a committed artifact beyond the checklist results.

---

## PHASE 5 — Validate + PR

### Task 5.1: Full validate + PR

- [ ] **Step 1:** `cd /Users/blove/repos/dawn && pnpm ci:validate` → green. The live smoke SKIPS (no key in the validate env), which is correct and expected. Confirm the new fixtures didn't break the generated-app/harness lanes (they're under `packages/testing/test/fixtures/`, loaded at runtime, not packed).
- [ ] **Step 2:** Push + open PR:

```bash
cd /Users/blove/repos/dawn
git push -u origin test/memory-live-smoke
gh pr create --base main --head test/memory-live-smoke \
  --title "test: local live-smoke + runbook for long-term memory" \
  --body "Adds a gated live-smoke suite (skipIf(!OPENAI_API_KEY), never CI) exercising remember/recall, supersession, namespace isolation, memory-index injection, and the candidate→approve→recall CLI loop against a real model via the in-process harness, plus a manual --mode internal runbook. Per docs/superpowers/specs/2026-06-19-memory-live-smoke-design.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3:** Note in the PR body the local 6/6 live result from Task 4.1 (so reviewers know it was actually run against a model).

---

## Self-Review

**Spec coverage:** gated suite + skipIf/never-CI → Phase 2 ✓; structural assertions (tool-called + store/CLI state + recall-output) → all scenarios ✓; auto remember/recall (1,2) ✓; supersession (3) ✓; isolation (4) ✓; index injection (5) ✓; candidate→approve→recall + reject/forget CLI (6) ✓; `/memory-other` + candidate fixture app → Phase 1 ✓; manual runbook → 3.1 ✓; docs note → 3.2 ✓; key-from-.env/never-CI/db-cleanup safety → header + Task 4.1 ✓; coverage matrix's "manual only" rows (memory.md heeded, AGENTS.md interplay) → runbook ✓.

**Placeholder scan:** Task 2.1 Step 1 leaves the `runMemoryCommand` import path to be resolved by reading the CLI exports (it prescribes adding a `./commands/memory` subpath export if absent — a concrete instruction, not a TODO). Task 3.1 specifies the runbook contents precisely rather than inlining the full markdown (a doc-writing task with an explicit content list). Task 4.x is operator-run by necessity (needs the key). All scenario test code is complete and concrete.

**Type consistency:** `dbPath`/`cleanDb`/`io`/`probeRoot`/`candidateRoot` defined in the header (2.1) and reused in 2.2–2.4. `expectToolCalled`, `run.toolResults` (`{name, content}`), `run.systemPrompt`, `run.finalMessage`, `sqliteMemoryStore({path}).search/listCandidates/get`, and `runMemoryCommand(argv, {cwd}, io)` all match the real signatures confirmed from the source. Route ids (`/memory-chat#agent`, `/memory-other#agent`, `/notes#agent`) match the fixtures created in Phase 1.
