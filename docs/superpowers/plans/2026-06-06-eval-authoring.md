# Eval Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship filesystem-discovered agent evals — a new `@dawn-ai/evals` package (datasets + scorers + gates + a pure runner) and a `dawn eval` command that runs an agent route over a dataset and reports/gates on scores, deterministic-by-replay with an opt-in `--live` real-model mode.

**Architecture:** `@dawn-ai/evals` owns author-facing primitives (`defineEval`, the scorer library, `llmJudge`, the `gate.*` policies, dataset types) **and** a pure `runEval(def, { runCase })` orchestrator whose route execution is injected — so the package has no runtime dependency on the harness and is exhaustively unit-testable. The `dawn eval` CLI command owns discovery (`load-evals.ts`, mirroring `load-run-scenarios.ts`), resolves `@dawn-ai/evals` + `@dawn-ai/testing` **from the app root**, builds `runCase` via `createAgentHarness` (replay default / `--live`), and handles reporting + exit codes. This mirrors the established split (author packages + CLI-owns-commands).

**Tech Stack:** TypeScript (ESM, `node:` builtins), vitest, `@dawn-ai/testing` (`createAgentHarness`, `AgentRunResult`, `script`, fixtures), commander (CLI), tsx (eval-file loading), changesets.

**Spec:** `docs/superpowers/specs/2026-06-06-eval-authoring-design.md`

**Deferred from this plan (flag at handoff):** `dawn eval --record` (needs a `@dawn-ai/testing` enhancement to expose captured response fixtures from the in-process aimock handle). Fixtures are authored via `script()` / committed JSON, as the harness tests already do. Also deferred per spec: LangSmith dataset upload, result-history, parallelism, non-agent route kinds.

---

## File Structure

**New package `packages/evals/`:**
- `package.json`, `tsconfig.json`, `vitest.config.ts` — scaffolding (mirror `@dawn-ai/permissions`).
- `src/types.ts` — `EvalCase`, `Dataset`, `Score`, `Scorer`, `EvalDefinition`, `CaseScore`/`CaseResult`/`ScorerAggregate`/`ScoredReport`/`EvalReport`, `GateResult`/`GatePolicy`.
- `src/score.ts` — `normalizeScore(raw): { score; label?; reason? }`.
- `src/define-eval.ts` — `defineEval(def)` (identity + validation).
- `src/scorers.ts` — `exactMatch`, `contains`, `regex`, `jsonEquals`, `toolCalled`, `latencyUnder`, `tokensUnder`, `custom`.
- `src/llm-judge.ts` — `llmJudge(opts)` (fetch-based, injectable `fetchImpl`).
- `src/gate.ts` — `gate` object (`mean`/`passRate`/`everyCase`/`perScorer`/`all`/`any`) + `resolveGate(def)`.
- `src/resolve-dataset.ts` — `resolveDataset(dataset, baseDir)`.
- `src/run-eval.ts` — `runEval(def, options)` pure orchestrator.
- `src/index.ts` — barrel.
- `test/*.test.ts` — one per module.

**CLI (`packages/cli/`):**
- `src/lib/runtime/load-evals.ts` — discovery of `*.eval.ts`.
- `src/commands/eval.ts` — `registerEvalCommand` + `runEvalCommand`.
- `src/index.ts:36-44` — register the new command.
- `test/eval-command.test.ts`, `test/load-evals.test.ts`.

**Wiring:** `vitest.workspace.ts` (add evals project), `.changeset/` (changeset file).

**Dogfood:** `examples/chat/server/src/app/<route>/evals/*.eval.ts` + committed fixtures + `examples/chat/server/test/eval-dogfood.test.ts`.

**Docs:** `apps/web/content/docs/evals.mdx` (+ nav).

---

## Task 1: Scaffold the `@dawn-ai/evals` package

**Files:**
- Create: `packages/evals/package.json`
- Create: `packages/evals/tsconfig.json`
- Create: `packages/evals/vitest.config.ts`
- Create: `packages/evals/src/index.ts`
- Create: `packages/evals/test/smoke.test.ts`
- Modify: `vitest.workspace.ts` (add the evals project)

- [ ] **Step 1: Create `packages/evals/package.json`** (mirrors `@dawn-ai/permissions`; adds `@dawn-ai/testing` as a peer+dev dep for types)

```json
{
  "name": "@dawn-ai/evals",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "license": "MIT",
  "homepage": "https://github.com/cacheplane/dawnai/tree/main/packages/evals#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/cacheplane/dawnai.git",
    "directory": "packages/evals"
  },
  "bugs": {
    "url": "https://github.com/cacheplane/dawnai/issues"
  },
  "engines": {
    "node": ">=22.12.0"
  },
  "files": [
    "dist"
  ],
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc -b tsconfig.json",
    "lint": "biome check --config-path ../config-biome/biome.json package.json src tsconfig.json vitest.config.ts",
    "test": "vitest --run --config vitest.config.ts --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@dawn-ai/testing": "workspace:*"
  },
  "devDependencies": {
    "@dawn-ai/config-typescript": "workspace:*",
    "@dawn-ai/testing": "workspace:*",
    "@types/node": "25.6.0"
  }
}
```

- [ ] **Step 2: Create `packages/evals/tsconfig.json`** (verbatim from permissions)

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "../config-typescript/node.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `packages/evals/vitest.config.ts`** (verbatim from permissions)

```typescript
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
  },
})
```

- [ ] **Step 4: Create a placeholder barrel `packages/evals/src/index.ts`**

```typescript
export const EVALS_PACKAGE = "@dawn-ai/evals"
```

- [ ] **Step 5: Create `packages/evals/test/smoke.test.ts`**

```typescript
import { describe, expect, it } from "vitest"
import { EVALS_PACKAGE } from "../src/index.js"

describe("@dawn-ai/evals", () => {
  it("loads", () => {
    expect(EVALS_PACKAGE).toBe("@dawn-ai/evals")
  })
})
```

- [ ] **Step 6: Register the package's tests in `vitest.workspace.ts`** — add `"./packages/evals/vitest.config.ts",` to the `projects` array, alphabetically between `devkit` and `langchain`:

```typescript
      "./packages/devkit/vitest.config.ts",
      "./packages/evals/vitest.config.ts",
      "./packages/langchain/vitest.config.ts",
```

- [ ] **Step 7: Install + build + test**

Run: `pnpm install && pnpm --filter @dawn-ai/evals build && pnpm --filter @dawn-ai/evals test`
Expected: install links the workspace package; build emits `dist/`; smoke test PASSES (1 passed).

- [ ] **Step 8: Commit**

```bash
git add packages/evals vitest.workspace.ts pnpm-lock.yaml
git commit -m "feat(evals): scaffold @dawn-ai/evals package"
```

---

## Task 2: Core types

**Files:**
- Create: `packages/evals/src/types.ts`
- Test: covered indirectly; no standalone test (types only).

- [ ] **Step 1: Write `packages/evals/src/types.ts`**

```typescript
import type { AgentRunResult, FixtureSet, ScriptBuilder } from "@dawn-ai/testing"

/** One dataset row. `input` is the user message for agent routes (v1). */
export interface EvalCase {
  readonly name?: string
  readonly input: unknown
  readonly expected?: unknown
  /** Per-case aimock fixtures for replay mode; ignored under --live. */
  readonly fixtures?: FixtureSet | ScriptBuilder
  readonly metadata?: Record<string, unknown>
}

/** Inline cases, a path to a committed .json/.jsonl, or a (sync/async) factory. */
export type Dataset =
  | readonly EvalCase[]
  | string
  | (() => EvalCase[] | Promise<EvalCase[]>)

/** A scorer may return a 0..1 number, a boolean, or a rich verdict. */
export type Score = number | boolean | { readonly score: number; readonly label?: string; readonly reason?: string }

export interface Scorer {
  readonly name: string
  /** This scorer's own pass bar (used by gate.perScorer and case-pass). */
  readonly threshold?: number
  readonly score: (run: AgentRunResult, testCase: EvalCase) => Score | Promise<Score>
}

export interface EvalDefinition {
  readonly name: string
  /** Route key like "/chat#agent"; defaults to the co-located route at load time. */
  readonly route?: string
  readonly dataset: Dataset
  readonly scorers: readonly Scorer[]
  /** Sugar for gate.mean(threshold). Ignored if `gate` is set. */
  readonly threshold?: number
  readonly gate?: GatePolicy
}

/** Normalized score for one (case, scorer) pair. */
export interface CaseScore {
  readonly scorer: string
  readonly score: number
  readonly label?: string
  readonly reason?: string
}

export interface CaseResult {
  readonly name: string
  readonly scores: readonly CaseScore[]
  readonly mean: number
  /** Every scorer met its bar (scorer.threshold ?? DEFAULT_CASE_BAR). */
  readonly passed: boolean
}

export interface ScorerAggregate {
  readonly scorer: string
  readonly mean: number
  readonly threshold?: number
}

/** Pre-gate report fed to gate policies. */
export interface ScoredReport {
  readonly name: string
  readonly cases: readonly CaseResult[]
  readonly byScorer: readonly ScorerAggregate[]
  readonly mean: number
}

export interface EvalReport extends ScoredReport {
  /** Whether a gate/threshold was configured (informational evals are false). */
  readonly gated: boolean
  readonly passed: boolean
  readonly reason?: string
}

export type GateResult = { readonly passed: boolean; readonly reason?: string }
export type GatePolicy = (report: ScoredReport) => GateResult

/** A case "passes" when every scorer ≥ its threshold, defaulting to this bar. */
export const DEFAULT_CASE_BAR = 0.5
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @dawn-ai/evals exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/evals/src/types.ts
git commit -m "feat(evals): core types"
```

---

## Task 3: Score normalization

**Files:**
- Create: `packages/evals/src/score.ts`
- Test: `packages/evals/test/score.test.ts`

- [ ] **Step 1: Write the failing test `packages/evals/test/score.test.ts`**

```typescript
import { describe, expect, it } from "vitest"
import { normalizeScore } from "../src/score.js"

describe("normalizeScore", () => {
  it("maps booleans to 1/0", () => {
    expect(normalizeScore(true)).toEqual({ score: 1 })
    expect(normalizeScore(false)).toEqual({ score: 0 })
  })
  it("clamps numbers to [0,1]", () => {
    expect(normalizeScore(0.5)).toEqual({ score: 0.5 })
    expect(normalizeScore(2)).toEqual({ score: 1 })
    expect(normalizeScore(-1)).toEqual({ score: 0 })
  })
  it("passes through rich verdicts, clamping score and keeping label/reason", () => {
    expect(normalizeScore({ score: 1.4, label: "good", reason: "why" })).toEqual({
      score: 1,
      label: "good",
      reason: "why",
    })
  })
  it("treats NaN as 0", () => {
    expect(normalizeScore(Number.NaN)).toEqual({ score: 0 })
  })
})
```

- [ ] **Step 2: Run it (fails — module missing)**

Run: `pnpm --filter @dawn-ai/evals test -- score`
Expected: FAIL (cannot find `../src/score.js`).

- [ ] **Step 3: Write `packages/evals/src/score.ts`**

```typescript
import type { Score } from "./types.js"

export interface NormalizedScore {
  readonly score: number
  readonly label?: string
  readonly reason?: string
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

export function normalizeScore(raw: Score): NormalizedScore {
  if (typeof raw === "boolean") return { score: raw ? 1 : 0 }
  if (typeof raw === "number") return { score: clamp01(raw) }
  const out: NormalizedScore = { score: clamp01(raw.score) }
  return {
    ...out,
    ...(raw.label !== undefined ? { label: raw.label } : {}),
    ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
  }
}
```

- [ ] **Step 4: Run it (passes)**

Run: `pnpm --filter @dawn-ai/evals test -- score`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/evals/src/score.ts packages/evals/test/score.test.ts
git commit -m "feat(evals): score normalization"
```

---

## Task 4: `defineEval` validation

**Files:**
- Create: `packages/evals/src/define-eval.ts`
- Test: `packages/evals/test/define-eval.test.ts`

- [ ] **Step 1: Write the failing test `packages/evals/test/define-eval.test.ts`**

```typescript
import { describe, expect, it } from "vitest"
import { defineEval } from "../src/define-eval.js"
import type { Scorer } from "../src/types.js"

const scorer: Scorer = { name: "s", score: () => 1 }

describe("defineEval", () => {
  it("returns the definition unchanged when valid", () => {
    const def = defineEval({ name: "e", dataset: [{ input: "hi" }], scorers: [scorer] })
    expect(def.name).toBe("e")
  })
  it("throws on empty name", () => {
    expect(() => defineEval({ name: "", dataset: [{ input: "x" }], scorers: [scorer] })).toThrow(
      /name/,
    )
  })
  it("throws on no scorers", () => {
    expect(() => defineEval({ name: "e", dataset: [{ input: "x" }], scorers: [] })).toThrow(
      /scorer/,
    )
  })
  it("throws on an empty inline dataset", () => {
    expect(() => defineEval({ name: "e", dataset: [], scorers: [scorer] })).toThrow(/dataset/)
  })
  it("allows a string or function dataset (resolved later)", () => {
    expect(defineEval({ name: "e", dataset: "cases.jsonl", scorers: [scorer] }).dataset).toBe(
      "cases.jsonl",
    )
    expect(typeof defineEval({ name: "e", dataset: () => [{ input: "x" }], scorers: [scorer] }).dataset).toBe(
      "function",
    )
  })
})
```

- [ ] **Step 2: Run it (fails)**

Run: `pnpm --filter @dawn-ai/evals test -- define-eval`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `packages/evals/src/define-eval.ts`**

```typescript
import type { EvalDefinition } from "./types.js"

export function defineEval(def: EvalDefinition): EvalDefinition {
  if (!def.name || def.name.trim() === "") {
    throw new Error("defineEval: `name` is required")
  }
  if (!def.scorers || def.scorers.length === 0) {
    throw new Error(`defineEval("${def.name}"): at least one scorer is required`)
  }
  if (Array.isArray(def.dataset) && def.dataset.length === 0) {
    throw new Error(`defineEval("${def.name}"): inline dataset is empty`)
  }
  if (def.dataset === undefined || def.dataset === null) {
    throw new Error(`defineEval("${def.name}"): dataset is required`)
  }
  return def
}
```

- [ ] **Step 4: Run it (passes)**

Run: `pnpm --filter @dawn-ai/evals test -- define-eval`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/evals/src/define-eval.ts packages/evals/test/define-eval.test.ts
git commit -m "feat(evals): defineEval validation"
```

---

## Task 5: Built-in code scorers

**Files:**
- Create: `packages/evals/src/scorers.ts`
- Test: `packages/evals/test/scorers.test.ts`

- [ ] **Step 1: Write the failing test `packages/evals/test/scorers.test.ts`**

```typescript
import { describe, expect, it } from "vitest"
import type { AgentRunResult } from "@dawn-ai/testing"
import { contains, custom, exactMatch, jsonEquals, regex, toolCalled, tokensUnder } from "../src/scorers.js"
import { normalizeScore } from "../src/score.js"

function run(partial: Partial<AgentRunResult>): AgentRunResult {
  return {
    finalMessage: "",
    messages: [],
    toolCalls: [],
    tokens: [],
    state: {},
    threadId: "t",
    interrupts: [],
    planUpdates: [],
    todos: [],
    subagents: [],
    subagentEvents: [],
    systemPrompt: "",
    ...partial,
  }
}

const noCase = { input: "" }

describe("built-in scorers", () => {
  it("contains scores 1 when finalMessage includes the substring, else 0", async () => {
    expect(normalizeScore(await contains("Found").score(run({ finalMessage: "Found 2" }), noCase)).score).toBe(1)
    expect(normalizeScore(await contains("Found").score(run({ finalMessage: "none" }), noCase)).score).toBe(0)
  })
  it("regex matches finalMessage", async () => {
    expect(normalizeScore(await regex(/\d+ items/).score(run({ finalMessage: "3 items" }), noCase)).score).toBe(1)
  })
  it("exactMatch compares finalMessage to case.expected", async () => {
    expect(normalizeScore(await exactMatch().score(run({ finalMessage: "ok" }), { input: "", expected: "ok" })).score).toBe(1)
    expect(normalizeScore(await exactMatch().score(run({ finalMessage: "ok" }), { input: "", expected: "no" })).score).toBe(0)
  })
  it("jsonEquals deep-compares parsed finalMessage to case.expected", async () => {
    const r = run({ finalMessage: '{"a":1,"b":[2,3]}' })
    expect(normalizeScore(await jsonEquals().score(r, { input: "", expected: { a: 1, b: [2, 3] } })).score).toBe(1)
  })
  it("toolCalled scores 1 when the named tool was called", async () => {
    const r = run({ toolCalls: [{ name: "applyFilter", args: { status: "open" } }] })
    expect(normalizeScore(await toolCalled("applyFilter").score(r, noCase)).score).toBe(1)
    expect(normalizeScore(await toolCalled("applyFilter", { withArgs: { status: "open" } }).score(r, noCase)).score).toBe(1)
    expect(normalizeScore(await toolCalled("applyFilter", { withArgs: { status: "closed" } }).score(r, noCase)).score).toBe(0)
    expect(normalizeScore(await toolCalled("missing").score(r, noCase)).score).toBe(0)
  })
  it("tokensUnder scores 1 when streamed token count is under the budget", async () => {
    expect(normalizeScore(await tokensUnder(5).score(run({ tokens: ["a", "b"] }), noCase)).score).toBe(1)
    expect(normalizeScore(await tokensUnder(1).score(run({ tokens: ["a", "b"] }), noCase)).score).toBe(0)
  })
  it("custom wraps an async function and carries name + threshold", async () => {
    const s = custom(async (r) => (r.toolCalls.length <= 2 ? 1 : 0), { name: "few-tools", threshold: 1 })
    expect(s.name).toBe("few-tools")
    expect(s.threshold).toBe(1)
    expect(normalizeScore(await s.score(run({}), noCase)).score).toBe(1)
  })
})
```

- [ ] **Step 2: Run it (fails)**

Run: `pnpm --filter @dawn-ai/evals test -- scorers`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `packages/evals/src/scorers.ts`**

```typescript
import type { AgentRunResult } from "@dawn-ai/testing"
import type { EvalCase, Score, Scorer } from "./types.js"

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** finalMessage === case.expected (string compare). */
export function exactMatch(opts?: { threshold?: number }): Scorer {
  return {
    name: "exactMatch",
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: (run, c) => (run.finalMessage === String(c.expected ?? "") ? 1 : 0),
  }
}

export function contains(substring: string, opts?: { threshold?: number }): Scorer {
  return {
    name: `contains(${substring})`,
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: (run) => (run.finalMessage.includes(substring) ? 1 : 0),
  }
}

export function regex(re: RegExp, opts?: { threshold?: number }): Scorer {
  return {
    name: `regex(${re.source})`,
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: (run) => (re.test(run.finalMessage) ? 1 : 0),
  }
}

/** Deep-equals case.expected against parsed finalMessage (default) or a selector. */
export function jsonEquals(opts?: {
  threshold?: number
  select?: (run: AgentRunResult) => unknown
}): Scorer {
  return {
    name: "jsonEquals",
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: (run, c) => {
      let actual: unknown
      if (opts?.select) {
        actual = opts.select(run)
      } else {
        try {
          actual = JSON.parse(run.finalMessage)
        } catch {
          return 0
        }
      }
      return deepEqual(actual, c.expected) ? 1 : 0
    },
  }
}

export function toolCalled(
  name: string,
  opts?: { withArgs?: Record<string, unknown>; threshold?: number },
): Scorer {
  return {
    name: `toolCalled(${name})`,
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: (run) => {
      const calls = run.toolCalls.filter((t) => t.name === name)
      if (calls.length === 0) return 0
      if (!opts?.withArgs) return 1
      const want = opts.withArgs
      const hit = calls.some((call) => {
        const args = (call.args ?? {}) as Record<string, unknown>
        return Object.entries(want).every(([k, v]) => deepEqual(args[k], v))
      })
      return hit ? 1 : 0
    },
  }
}

export function tokensUnder(budget: number, opts?: { threshold?: number }): Scorer {
  return {
    name: `tokensUnder(${budget})`,
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: (run) => (run.tokens.length < budget ? 1 : 0),
  }
}

export function custom(
  fn: (run: AgentRunResult, testCase: EvalCase) => Score | Promise<Score>,
  opts?: { name?: string; threshold?: number },
): Scorer {
  return {
    name: opts?.name ?? "custom",
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: fn,
  }
}
```

> Note: `latencyUnder` from the spec is omitted — `AgentRunResult` has no timing field today; adding one is a `@dawn-ai/testing` change out of scope for this plan. `tokensUnder` covers the budget use-case. (Flag this trim at handoff.)

- [ ] **Step 4: Run it (passes)**

Run: `pnpm --filter @dawn-ai/evals test -- scorers`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/evals/src/scorers.ts packages/evals/test/scorers.test.ts
git commit -m "feat(evals): built-in code scorers"
```

---

## Task 6: `llmJudge` scorer

**Files:**
- Create: `packages/evals/src/llm-judge.ts`
- Test: `packages/evals/test/llm-judge.test.ts`

- [ ] **Step 1: Write the failing test `packages/evals/test/llm-judge.test.ts`**

```typescript
import { describe, expect, it, vi } from "vitest"
import type { AgentRunResult } from "@dawn-ai/testing"
import { llmJudge } from "../src/llm-judge.js"
import { normalizeScore } from "../src/score.js"

function run(finalMessage: string): AgentRunResult {
  return {
    finalMessage, messages: [], toolCalls: [], tokens: [], state: {}, threadId: "t",
    interrupts: [], planUpdates: [], todos: [], subagents: [], subagentEvents: [], systemPrompt: "",
  }
}

function fakeFetch(content: string) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
  )
}

describe("llmJudge", () => {
  it("parses a {score,reason} verdict from the model", async () => {
    const fetchImpl = fakeFetch('{"score":0.8,"reason":"close enough"}')
    const s = llmJudge({ criteria: "Answer reflects {{expected}}", fetchImpl, baseUrl: "http://x/v1", apiKey: "k" })
    const v = normalizeScore(await s.score(run("hello"), { input: "hi", expected: "hello" }))
    expect(v.score).toBe(0.8)
    expect(v.reason).toBe("close enough")
    // criteria interpolated + output included in the user message sent to the model
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)
    expect(JSON.stringify(body.messages)).toContain("hello")
  })
  it("scores 0 with a reason when the verdict is unparseable", async () => {
    const s = llmJudge({ criteria: "x", fetchImpl: fakeFetch("not json"), baseUrl: "http://x/v1", apiKey: "k" })
    const v = normalizeScore(await s.score(run("y"), { input: "i" }))
    expect(v.score).toBe(0)
    expect(v.reason).toMatch(/parse|verdict/i)
  })
  it("carries its threshold", () => {
    expect(llmJudge({ criteria: "x", threshold: 0.7 }).threshold).toBe(0.7)
  })
})
```

- [ ] **Step 2: Run it (fails)**

Run: `pnpm --filter @dawn-ai/evals test -- llm-judge`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `packages/evals/src/llm-judge.ts`**

```typescript
import type { AgentRunResult } from "@dawn-ai/testing"
import type { EvalCase, Scorer } from "./types.js"

type FetchImpl = (input: string, init: RequestInit) => Promise<Response>

export interface LlmJudgeOptions {
  /** Criteria template; supports {{input}}, {{expected}}, {{output}} interpolation. */
  readonly criteria: string
  readonly model?: string
  readonly threshold?: number
  readonly name?: string
  /** Overrides for testing; default to env + global fetch. */
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly fetchImpl?: FetchImpl
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? "")
}

export function llmJudge(opts: LlmJudgeOptions): Scorer {
  const model = opts.model ?? "gpt-4o-mini"
  return {
    name: opts.name ?? "llmJudge",
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: async (run: AgentRunResult, testCase: EvalCase) => {
      const baseUrl = opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
      const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? ""
      const fetchImpl: FetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init))
      const criteria = interpolate(opts.criteria, {
        input: String(testCase.input ?? ""),
        expected: JSON.stringify(testCase.expected ?? ""),
        output: run.finalMessage,
      })
      const user = [
        `Criteria: ${criteria}`,
        `Agent output: ${run.finalMessage}`,
        `Respond ONLY with JSON: {"score": <0..1>, "reason": "<short>"}.`,
      ].join("\n")
      let content: string
      try {
        const res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: "You are a strict grader. Output only the requested JSON." },
              { role: "user", content: user },
            ],
          }),
        })
        const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
        content = json.choices?.[0]?.message?.content ?? ""
      } catch (err) {
        return { score: 0, reason: `judge request failed: ${err instanceof Error ? err.message : String(err)}` }
      }
      try {
        const parsed = JSON.parse(content) as { score: number; reason?: string }
        return { score: parsed.score, reason: parsed.reason ?? "" }
      } catch {
        return { score: 0, reason: `could not parse judge verdict: ${content.slice(0, 120)}` }
      }
    },
  }
}
```

- [ ] **Step 4: Run it (passes)**

Run: `pnpm --filter @dawn-ai/evals test -- llm-judge`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/evals/src/llm-judge.ts packages/evals/test/llm-judge.test.ts
git commit -m "feat(evals): llmJudge scorer (fetch-based, mockable)"
```

---

## Task 7: Gate policies

**Files:**
- Create: `packages/evals/src/gate.ts`
- Test: `packages/evals/test/gate.test.ts`

- [ ] **Step 1: Write the failing test `packages/evals/test/gate.test.ts`**

```typescript
import { describe, expect, it } from "vitest"
import { gate, resolveGate } from "../src/gate.js"
import type { ScoredReport } from "../src/types.js"

const report: ScoredReport = {
  name: "e",
  mean: 0.75,
  cases: [
    { name: "a", mean: 1, passed: true, scores: [] },
    { name: "b", mean: 0.5, passed: false, scores: [] },
  ],
  byScorer: [
    { scorer: "x", mean: 1, threshold: 1 },
    { scorer: "y", mean: 0.5, threshold: 0.8 },
  ],
}

describe("gate policies", () => {
  it("mean(n) checks the overall mean", () => {
    expect(gate.mean(0.7)(report).passed).toBe(true)
    expect(gate.mean(0.8)(report).passed).toBe(false)
  })
  it("passRate(n) checks the fraction of passing cases", () => {
    expect(gate.passRate(0.5)(report).passed).toBe(true)
    expect(gate.passRate(0.6)(report).passed).toBe(false)
  })
  it("everyCase(n) requires all case means ≥ n", () => {
    expect(gate.everyCase(0.5)(report).passed).toBe(true)
    expect(gate.everyCase(0.6)(report).passed).toBe(false)
  })
  it("perScorer() requires each scorer with a threshold to meet it", () => {
    expect(gate.perScorer()(report).passed).toBe(false) // y: 0.5 < 0.8
  })
  it("all() requires every policy; any() requires one", () => {
    expect(gate.all(gate.mean(0.7), gate.everyCase(0.5))(report).passed).toBe(true)
    expect(gate.all(gate.mean(0.7), gate.everyCase(0.6))(report).passed).toBe(false)
    expect(gate.any(gate.mean(0.9), gate.everyCase(0.5))(report).passed).toBe(true)
  })
  it("resolveGate prefers gate, then threshold sugar, then informational", () => {
    expect(resolveGate({ name: "e", dataset: [], scorers: [], gate: gate.mean(0.9) })(report).passed).toBe(false)
    expect(resolveGate({ name: "e", dataset: [], scorers: [], threshold: 0.7 })(report).passed).toBe(true)
    expect(resolveGate({ name: "e", dataset: [], scorers: [] })(report).passed).toBe(true) // informational
  })
})
```

- [ ] **Step 2: Run it (fails)**

Run: `pnpm --filter @dawn-ai/evals test -- gate`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `packages/evals/src/gate.ts`**

```typescript
import { DEFAULT_CASE_BAR, type EvalDefinition, type GatePolicy, type GateResult } from "./types.js"

function pass(reason?: string): GateResult {
  return reason !== undefined ? { passed: true, reason } : { passed: true }
}
function fail(reason: string): GateResult {
  return { passed: false, reason }
}

export const gate = {
  mean(n: number): GatePolicy {
    return (r) => (r.mean >= n ? pass() : fail(`mean ${r.mean.toFixed(2)} < ${n}`))
  },
  passRate(n: number): GatePolicy {
    return (r) => {
      const rate = r.cases.length === 0 ? 1 : r.cases.filter((c) => c.passed).length / r.cases.length
      return rate >= n ? pass() : fail(`pass-rate ${rate.toFixed(2)} < ${n}`)
    }
  },
  everyCase(n: number): GatePolicy {
    return (r) => {
      const bad = r.cases.find((c) => c.mean < n)
      return bad ? fail(`case "${bad.name}" mean ${bad.mean.toFixed(2)} < ${n}`) : pass()
    }
  },
  perScorer(): GatePolicy {
    return (r) => {
      const bad = r.byScorer.find((s) => s.threshold !== undefined && s.mean < s.threshold)
      return bad
        ? fail(`scorer "${bad.scorer}" mean ${bad.mean.toFixed(2)} < ${bad.threshold}`)
        : pass()
    }
  },
  all(...policies: GatePolicy[]): GatePolicy {
    return (r) => {
      for (const p of policies) {
        const res = p(r)
        if (!res.passed) return res
      }
      return pass()
    }
  },
  any(...policies: GatePolicy[]): GatePolicy {
    return (r) => {
      const reasons: string[] = []
      for (const p of policies) {
        const res = p(r)
        if (res.passed) return pass()
        if (res.reason) reasons.push(res.reason)
      }
      return fail(`no policy passed: ${reasons.join("; ")}`)
    }
  },
}

/** gate wins; else threshold → mean(threshold); else informational (always passes). */
export function resolveGate(def: Pick<EvalDefinition, "gate" | "threshold">): GatePolicy {
  if (def.gate) return def.gate
  if (def.threshold !== undefined) return gate.mean(def.threshold)
  return () => pass("informational (no gate)")
}

export { DEFAULT_CASE_BAR }
```

- [ ] **Step 4: Run it (passes)**

Run: `pnpm --filter @dawn-ai/evals test -- gate`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/evals/src/gate.ts packages/evals/test/gate.test.ts
git commit -m "feat(evals): composable gate policies"
```

---

## Task 8: Dataset resolution

**Files:**
- Create: `packages/evals/src/resolve-dataset.ts`
- Test: `packages/evals/test/resolve-dataset.test.ts`

- [ ] **Step 1: Write the failing test `packages/evals/test/resolve-dataset.test.ts`**

```typescript
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveDataset } from "../src/resolve-dataset.js"

describe("resolveDataset", () => {
  it("returns inline arrays as-is", async () => {
    expect(await resolveDataset([{ input: "a" }], "/tmp")).toEqual([{ input: "a" }])
  })
  it("awaits a function dataset", async () => {
    expect(await resolveDataset(async () => [{ input: "b" }], "/tmp")).toEqual([{ input: "b" }])
  })
  it("reads a .json array relative to baseDir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-ds-"))
    writeFileSync(join(dir, "cases.json"), JSON.stringify([{ input: "c" }]))
    expect(await resolveDataset("cases.json", dir)).toEqual([{ input: "c" }])
  })
  it("reads a .jsonl file (one case per line)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-ds-"))
    writeFileSync(join(dir, "cases.jsonl"), '{"input":"x"}\n{"input":"y"}\n')
    expect(await resolveDataset("cases.jsonl", dir)).toEqual([{ input: "x" }, { input: "y" }])
  })
  it("throws a clear error for a missing file", async () => {
    await expect(resolveDataset("nope.json", "/tmp")).rejects.toThrow(/nope\.json/)
  })
})
```

- [ ] **Step 2: Run it (fails)**

Run: `pnpm --filter @dawn-ai/evals test -- resolve-dataset`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `packages/evals/src/resolve-dataset.ts`**

```typescript
import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Dataset, EvalCase } from "./types.js"

export async function resolveDataset(dataset: Dataset, baseDir: string): Promise<EvalCase[]> {
  if (Array.isArray(dataset)) return [...dataset]
  if (typeof dataset === "function") return [...(await dataset())]
  if (typeof dataset === "string") {
    const path = isAbsolute(dataset) ? dataset : resolve(baseDir, dataset)
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch (err) {
      throw new Error(`resolveDataset: cannot read dataset file "${path}": ${err instanceof Error ? err.message : String(err)}`)
    }
    if (path.endsWith(".jsonl")) {
      return raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line, i) => {
          try {
            return JSON.parse(line) as EvalCase
          } catch {
            throw new Error(`resolveDataset: invalid JSONL at line ${i + 1} in "${path}"`)
          }
        })
    }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      throw new Error(`resolveDataset: "${path}" must contain a JSON array of cases`)
    }
    return parsed as EvalCase[]
  }
  throw new Error("resolveDataset: dataset must be an array, a path string, or a function")
}
```

- [ ] **Step 4: Run it (passes)**

Run: `pnpm --filter @dawn-ai/evals test -- resolve-dataset`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/evals/src/resolve-dataset.ts packages/evals/test/resolve-dataset.test.ts
git commit -m "feat(evals): dataset resolution (array | path | function)"
```

---

## Task 9: `runEval` orchestrator

**Files:**
- Create: `packages/evals/src/run-eval.ts`
- Test: `packages/evals/test/run-eval.test.ts`

- [ ] **Step 1: Write the failing test `packages/evals/test/run-eval.test.ts`**

```typescript
import { describe, expect, it } from "vitest"
import type { AgentRunResult } from "@dawn-ai/testing"
import { runEval } from "../src/run-eval.js"
import { contains, toolCalled } from "../src/scorers.js"
import { gate } from "../src/gate.js"

function run(finalMessage: string, toolCalls: AgentRunResult["toolCalls"] = []): AgentRunResult {
  return {
    finalMessage, messages: [], toolCalls, tokens: [], state: {}, threadId: "t",
    interrupts: [], planUpdates: [], todos: [], subagents: [], subagentEvents: [], systemPrompt: "",
  }
}

describe("runEval", () => {
  it("scores every case×scorer, aggregates, and applies the gate", async () => {
    const report = await runEval(
      {
        name: "filter",
        dataset: [
          { name: "open", input: "filter open", expected: "Found 2" },
          { name: "none", input: "filter none", expected: "none" },
        ],
        scorers: [contains("Found"), toolCalled("applyFilter", { threshold: 1 })],
        gate: gate.perScorer(),
      },
      {
        runCase: async (c) =>
          c.name === "open"
            ? run("Found 2", [{ name: "applyFilter", args: {} }])
            : run("nothing here"),
      },
    )
    expect(report.cases).toHaveLength(2)
    expect(report.byScorer.find((s) => s.scorer.startsWith("contains"))?.mean).toBe(0.5)
    // applyFilter only called for "open" → mean 0.5 < threshold 1 → gate fails
    expect(report.passed).toBe(false)
    expect(report.gated).toBe(true)
  })

  it("a thrown scorer scores 0 with the error in reason and does not abort", async () => {
    const report = await runEval(
      {
        name: "e",
        dataset: [{ input: "x" }],
        scorers: [
          { name: "boom", score: () => { throw new Error("kaboom") } },
          contains("x"),
        ],
        threshold: 0,
      },
      { runCase: async () => run("x marks") },
    )
    const boom = report.cases[0]!.scores.find((s) => s.scorer === "boom")!
    expect(boom.score).toBe(0)
    expect(boom.reason).toMatch(/kaboom/)
    expect(report.passed).toBe(true) // threshold 0
  })

  it("is informational (passes) when no gate or threshold is set", async () => {
    const report = await runEval(
      { name: "e", dataset: [{ input: "x" }], scorers: [contains("z")] },
      { runCase: async () => run("no match") },
    )
    expect(report.mean).toBe(0)
    expect(report.gated).toBe(false)
    expect(report.passed).toBe(true)
  })
})
```

- [ ] **Step 2: Run it (fails)**

Run: `pnpm --filter @dawn-ai/evals test -- run-eval`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `packages/evals/src/run-eval.ts`**

```typescript
import type { AgentRunResult } from "@dawn-ai/testing"
import { resolveGate } from "./gate.js"
import { resolveDataset } from "./resolve-dataset.js"
import { normalizeScore } from "./score.js"
import {
  type CaseResult,
  type CaseScore,
  DEFAULT_CASE_BAR,
  type EvalCase,
  type EvalDefinition,
  type EvalReport,
  type ScorerAggregate,
} from "./types.js"

export interface RunEvalOptions {
  /** Executes one case and returns its run result (replay or live; injected by the CLI). */
  readonly runCase: (testCase: EvalCase) => Promise<AgentRunResult>
  /** Base dir for resolving a string dataset path (the eval file's directory). */
  readonly baseDir?: string
}

function mean(nums: readonly number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length
}

export async function runEval(def: EvalDefinition, options: RunEvalOptions): Promise<EvalReport> {
  const cases = await resolveDataset(def.dataset, options.baseDir ?? process.cwd())
  const thresholdOf = new Map(def.scorers.map((s) => [s.name, s.threshold]))

  const caseResults: CaseResult[] = []
  for (const [index, testCase] of cases.entries()) {
    const run = await options.runCase(testCase)
    const scores: CaseScore[] = []
    for (const scorer of def.scorers) {
      let normalized
      try {
        normalized = normalizeScore(await scorer.score(run, testCase))
      } catch (err) {
        normalized = { score: 0, reason: err instanceof Error ? err.message : String(err) }
      }
      scores.push({
        scorer: scorer.name,
        score: normalized.score,
        ...(normalized.label !== undefined ? { label: normalized.label } : {}),
        ...(normalized.reason !== undefined ? { reason: normalized.reason } : {}),
      })
    }
    const passed = scores.every((s) => s.score >= (thresholdOf.get(s.scorer) ?? DEFAULT_CASE_BAR))
    caseResults.push({
      name: testCase.name ?? `case ${index + 1}`,
      scores,
      mean: mean(scores.map((s) => s.score)),
      passed,
    })
  }

  const byScorer: ScorerAggregate[] = def.scorers.map((scorer) => {
    const scorerScores = caseResults.flatMap((c) =>
      c.scores.filter((s) => s.scorer === scorer.name).map((s) => s.score),
    )
    return {
      scorer: scorer.name,
      mean: mean(scorerScores),
      ...(scorer.threshold !== undefined ? { threshold: scorer.threshold } : {}),
    }
  })

  const overallMean = mean(caseResults.flatMap((c) => c.scores.map((s) => s.score)))
  const scored = { name: def.name, cases: caseResults, byScorer, mean: overallMean }
  const gated = def.gate !== undefined || def.threshold !== undefined
  const result = resolveGate(def)(scored)

  return {
    ...scored,
    gated,
    passed: result.passed,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
  }
}
```

- [ ] **Step 4: Run it (passes)**

Run: `pnpm --filter @dawn-ai/evals test -- run-eval`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/evals/src/run-eval.ts packages/evals/test/run-eval.test.ts
git commit -m "feat(evals): runEval orchestrator (pure, injected runner)"
```

---

## Task 10: Public barrel

**Files:**
- Modify: `packages/evals/src/index.ts`

- [ ] **Step 1: Replace `packages/evals/src/index.ts`**

```typescript
export { defineEval } from "./define-eval.js"
export { gate, resolveGate } from "./gate.js"
export { llmJudge, type LlmJudgeOptions } from "./llm-judge.js"
export { resolveDataset } from "./resolve-dataset.js"
export { type NormalizedScore, normalizeScore } from "./score.js"
export { contains, custom, exactMatch, jsonEquals, regex, tokensUnder, toolCalled } from "./scorers.js"
export { runEval, type RunEvalOptions } from "./run-eval.js"
export type {
  CaseResult,
  CaseScore,
  Dataset,
  EvalCase,
  EvalDefinition,
  EvalReport,
  GatePolicy,
  GateResult,
  Score,
  Scorer,
  ScorerAggregate,
  ScoredReport,
} from "./types.js"
```

- [ ] **Step 2: Build + typecheck + full package test**

Run: `pnpm --filter @dawn-ai/evals build && pnpm --filter @dawn-ai/evals test`
Expected: build emits dist; all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/evals/src/index.ts
git commit -m "feat(evals): public barrel"
```

---

## Task 11: CLI eval discovery (`load-evals.ts`)

**Files:**
- Create: `packages/cli/src/lib/runtime/load-evals.ts`
- Test: `packages/cli/test/load-evals.test.ts`

Read `packages/cli/src/lib/runtime/load-run-scenarios.ts` first and mirror its structure (walk, dynamic import via `pathToFileURL`, `findDawnApp` for app root, route resolution). The eval loader walks for `evals/*.eval.ts` under `src/`.

- [ ] **Step 1: Write the failing test `packages/cli/test/load-evals.test.ts`**

```typescript
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadEvals } from "../src/lib/runtime/load-evals.js"

async function makeApp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dawn-evals-"))
  await writeFile(join(root, "dawn.config.ts"), "export default {}\n")
  const routeDir = join(root, "src", "app", "chat")
  await mkdir(join(routeDir, "evals"), { recursive: true })
  await writeFile(join(routeDir, "index.ts"), "export const agent = { invoke: async () => ({}) }\n")
  await writeFile(
    join(routeDir, "evals", "smoke.eval.ts"),
    [
      'import { defineEval, contains } from "@dawn-ai/evals"',
      'export default defineEval({ name: "smoke", dataset: [{ input: "hi" }], scorers: [contains("hi")] })',
    ].join("\n"),
  )
  return root
}

describe("loadEvals", () => {
  it("discovers *.eval.ts, resolves the co-located route, and returns the definition", async () => {
    const root = await makeApp()
    const evals = await loadEvals({ cwd: root })
    expect(evals).toHaveLength(1)
    expect(evals[0]!.definition.name).toBe("smoke")
    expect(evals[0]!.route).toBe("/chat#agent")
    expect(evals[0]!.appRoot).toBe(root)
    expect(evals[0]!.baseDir).toBe(join(root, "src", "app", "chat", "evals"))
  })
})
```

> The exact `route` string format (`"/chat#agent"`) must match how `createRuntimeRegistry().lookup` keys routes — confirm against `runtime-registry.ts` during implementation and align the resolver. If a route lacks an agent export, fall back to the route path alone and let the harness error surface.

- [ ] **Step 2: Run it (fails)**

Run: `pnpm --filter @dawn-ai/cli test -- load-evals`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `packages/cli/src/lib/runtime/load-evals.ts`**

Mirror `load-run-scenarios.ts`. Implement:
- `findDawnApp({ cwd })` (imported from `@dawn-ai/core`, as `load-run-scenarios` does) → `{ appRoot }`.
- Recursively walk `<appRoot>/src` for files matching `*.eval.ts` inside an `evals/` directory.
- For each: `await import(pathToFileURL(file).href)`, read `.default`, validate it is an object with `name`/`dataset`/`scorers` (throw `EvalLoadError` otherwise).
- Resolve the route: explicit `definition.route`, else derive from the nearest ancestor directory containing `index.ts` (route path = dir relative to `src/app` with route-group `(...)` segments stripped, suffixed `#agent`). Reuse any existing route-path helper used by `load-run-scenarios`/`discover-routes` rather than re-deriving.
- Return `LoadedEval[]`:

```typescript
export interface LoadedEval {
  readonly definition: import("@dawn-ai/evals").EvalDefinition
  readonly route: string
  readonly appRoot: string
  readonly baseDir: string   // directory of the .eval.ts file (for string-dataset resolution)
  readonly evalFile: string
}

export class EvalLoadError extends Error {}

export async function loadEvals(options: {
  readonly cwd?: string
  readonly narrowingPath?: string
}): Promise<LoadedEval[]> { /* ...mirror load-run-scenarios... */ }
```

Use `@dawn-ai/evals` only for its `EvalDefinition` type (type-only import); do not construct anything from it here. The eval file itself imports `@dawn-ai/evals` (resolved from the app), so loading it exercises the real package.

- [ ] **Step 4: Run it (passes)**

Run: `pnpm --filter @dawn-ai/cli test -- load-evals`
Expected: PASS (1 passed). If the route-key format differs, fix the resolver to match `runtime-registry` and re-run.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/load-evals.ts packages/cli/test/load-evals.test.ts
git commit -m "feat(cli): eval file discovery (load-evals)"
```

---

## Task 12: `dawn eval` command

**Files:**
- Create: `packages/cli/src/commands/eval.ts`
- Modify: `packages/cli/src/index.ts` (register the command)
- Test: `packages/cli/test/eval-command.test.ts`

The command: load evals → for each, build a `runCase` via the app-resolved `createAgentHarness` → `runEval` → print a report → exit non-zero if any gated eval fails. Resolve `@dawn-ai/evals`'s `runEval` and `@dawn-ai/testing`'s `createAgentHarness` **from the app root** with `createRequire`:

```typescript
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

async function importFromApp<T>(appRoot: string, specifier: string): Promise<T> {
  const require = createRequire(`${appRoot}/package.json`)
  let resolved: string
  try {
    resolved = require.resolve(specifier)
  } catch {
    throw new CliError(
      `dawn eval requires "${specifier}" — add it as a devDependency in your app`,
      2,
    )
  }
  return (await import(pathToFileURL(resolved).href)) as T
}
```

- [ ] **Step 1: Write the failing test `packages/cli/test/eval-command.test.ts`**

This test exercises discovery + reporting + exit code **without a real model** by giving the eval inline `fixtures` (replay). It uses a tiny generated app with an agent route. Mirror the setup style of existing CLI command tests (e.g. `run-command.test.ts`), using a temp app with a real agent route + `tools/`. Assert:
- a passing eval prints `PASS` and the command resolves (exit 0),
- a failing-threshold eval prints `FAIL` and throws a `CommanderError` with exit code 1.

```typescript
import { describe, expect, it } from "vitest"
import { runEvalCommand } from "../src/commands/eval.js"
import { CommanderError } from "commander"
// Build a temp Dawn app with: dawn.config.ts, src/app/chat/index.ts (agent),
// src/app/chat/tools/applyFilter.ts, and src/app/chat/evals/filter.eval.ts whose
// dataset cases carry inline `fixtures: script()...` so replay needs no API key.
// (Reuse the app-scaffolding helpers/patterns from run-command.test.ts.)

describe("dawn eval (replay)", () => {
  it("passes a satisfied eval (exit 0)", async () => {
    const root = await makePassingEvalApp()
    const lines: string[] = []
    await runEvalCommand(undefined, { cwd: root }, { stdout: (m) => lines.push(m), stderr: () => {} })
    expect(lines.join("")).toContain("PASS")
  })
  it("fails a below-threshold eval (exit 1)", async () => {
    const root = await makeFailingEvalApp()
    await expect(
      runEvalCommand(undefined, { cwd: root }, { stdout: () => {}, stderr: () => {} }),
    ).rejects.toBeInstanceOf(CommanderError)
  })
})
```

> Implementer: write `makePassingEvalApp`/`makeFailingEvalApp` by copying the temp-app builder from `run-command.test.ts` and adding an `evals/filter.eval.ts`. The passing eval uses `threshold: 1` with scorers the fixtures satisfy; the failing eval uses `threshold: 1` with a `contains()` the reply does not satisfy.

- [ ] **Step 2: Run it (fails)**

Run: `pnpm --filter @dawn-ai/cli test -- eval-command`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `packages/cli/src/commands/eval.ts`**

```typescript
import { mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { type Command, CommanderError } from "commander"
import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import { type LoadedEval, loadEvals, EvalLoadError } from "../lib/runtime/load-evals.js"

interface EvalOptions {
  readonly cwd?: string
  readonly live?: boolean
  readonly json?: string | boolean
}

export function registerEvalCommand(program: Command, io: CommandIo): void {
  program
    .command("eval [path]")
    .description("Run Dawn agent evals over their datasets")
    .option("--cwd <path>", "Path to the Dawn app root or a child directory within it")
    .option("--live", "Run against the real model (requires OPENAI_API_KEY); never use in CI")
    .option("--json [file]", "Write a JSON report (default .dawn/eval-report.json)")
    .action(async (path: string | undefined, options: EvalOptions) => {
      await runEvalCommand(path, options, io)
    })
}

export async function runEvalCommand(
  narrowingPath: string | undefined,
  options: EvalOptions,
  io: CommandIo,
): Promise<void> {
  let evals: LoadedEval[]
  try {
    evals = await loadEvals({
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(narrowingPath ? { narrowingPath } : {}),
    })
  } catch (error) {
    if (error instanceof EvalLoadError) throw new CliError(`Eval-load failure: ${error.message}`, 2)
    throw new CliError(`Eval-load failure: ${formatErrorMessage(error)}`, 2)
  }
  if (evals.length === 0) throw new CliError("No *.eval.ts files found", 1)

  const appRoot = evals[0]!.appRoot
  const { createAgentHarness } = await importFromApp<typeof import("@dawn-ai/testing")>(
    appRoot,
    "@dawn-ai/testing",
  )
  const { runEval } = await importFromApp<typeof import("@dawn-ai/evals")>(appRoot, "@dawn-ai/evals")

  const reports = []
  let anyFailed = false

  for (const loaded of evals) {
    const harness = await createAgentHarness({
      appRoot: loaded.appRoot,
      route: loaded.route,
      ...(options.live ? { live: true } : {}),
    })
    try {
      const report = await runEval(loaded.definition, {
        baseDir: loaded.baseDir,
        runCase: async (testCase) => {
          harness.reset()
          const input = typeof testCase.input === "string" ? testCase.input : JSON.stringify(testCase.input)
          return harness.run({
            input,
            ...(!options.live && testCase.fixtures ? { fixtures: testCase.fixtures } : {}),
          })
        },
      })
      reports.push(report)
      printReport(report, io)
      if (report.gated && !report.passed) anyFailed = true
    } finally {
      await harness.close()
    }
  }

  if (options.json !== undefined) {
    const target = typeof options.json === "string" ? options.json : join(appRoot, ".dawn", "eval-report.json")
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(reports, null, 2)}\n`, "utf8")
    writeLine(io.stdout, `Wrote report: ${target}`)
  }

  if (anyFailed) throw new CommanderError(1, "dawn.eval.failed", "")
}

function printReport(report: import("@dawn-ai/evals").EvalReport, io: CommandIo): void {
  for (const c of report.cases) {
    const detail = c.scores.map((s) => `${s.scorer}=${s.score.toFixed(2)}`).join(" ")
    writeLine(io.stdout, `${c.passed ? "PASS" : "FAIL"} ${report.name} › ${c.name} mean=${c.mean.toFixed(2)} [${detail}]`)
  }
  const verdict = !report.gated ? "INFO" : report.passed ? "PASS" : "FAIL"
  writeLine(io.stdout, `${verdict} ${report.name} mean=${report.mean.toFixed(2)}${report.reason ? ` (${report.reason})` : ""}`)
}

async function importFromApp<T>(appRoot: string, specifier: string): Promise<T> {
  const require = createRequire(`${appRoot}/package.json`)
  let resolved: string
  try {
    resolved = require.resolve(specifier)
  } catch {
    throw new CliError(`dawn eval requires "${specifier}" — add it as a devDependency in your app`, 2)
  }
  return (await import(pathToFileURL(resolved).href)) as T
}
```

- [ ] **Step 4: Register in `packages/cli/src/index.ts`** — add the import and the registration call alongside the others:

```typescript
import { registerEvalCommand } from "./commands/eval.js"
```
and in `createProgram`, after `registerDevCommand(program, io)`:
```typescript
  registerEvalCommand(program, io)
```

- [ ] **Step 5: Run it (passes)**

Run: `pnpm --filter @dawn-ai/cli test -- eval-command`
Expected: PASS (2 passed).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/eval.ts packages/cli/src/index.ts packages/cli/test/eval-command.test.ts
git commit -m "feat(cli): dawn eval command (replay + --live + --json + gating)"
```

---

## Task 13: Dogfood eval in the chat example + deterministic CI lane

**Files:**
- Create: `examples/chat/server/src/app/<route>/evals/<name>.eval.ts` (pick an existing agent route, e.g. `/chat`)
- Create: `examples/chat/server/test/eval-dogfood.test.ts`

First inspect `examples/chat/server/src/app/` to choose a real agent route + a tool it calls, so the eval's inline `script()` fixtures match real behavior.

- [ ] **Step 1: Write the dogfood eval** (inline dataset + inline `script()` fixtures so it is deterministic/CI-safe; threshold gated)

```typescript
import { contains, defineEval, toolCalled } from "@dawn-ai/evals"
import { script } from "@dawn-ai/testing"

export default defineEval({
  name: "chat smoke",
  dataset: [
    {
      name: "greets",
      input: "Say hello",
      // fixtures must match the route's real tool/turn shape — adjust during implementation
      fixtures: script().user("Say hello").replies("Hello! How can I help?"),
    },
  ],
  scorers: [contains("Hello", { threshold: 1 })],
  threshold: 1,
})
```

- [ ] **Step 2: Write the CI test `examples/chat/server/test/eval-dogfood.test.ts`** (runs the eval through the runner in replay; rides the existing vitest workspace, no real key)

```typescript
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { createAgentHarness } from "@dawn-ai/testing"
import { runEval } from "@dawn-ai/evals"
import evalDef from "../src/app/chat/evals/chat-smoke.eval.js"

const appRoot = fileURLToPath(new URL("..", import.meta.url))

describe("chat example eval (replay)", () => {
  it("passes the gated chat smoke eval deterministically", async () => {
    const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
    try {
      const report = await runEval(evalDef, {
        runCase: async (c) => {
          h.reset()
          return h.run({ input: String(c.input), ...(c.fixtures ? { fixtures: c.fixtures } : {}) })
        },
      })
      expect(report.passed).toBe(true)
    } finally {
      await h.close()
    }
  }, 60_000)
})
```

- [ ] **Step 3: Add `@dawn-ai/evals` to the chat example's devDependencies** in `examples/chat/server/package.json`:

```json
    "@dawn-ai/evals": "workspace:*",
```
Then `pnpm install`.

- [ ] **Step 4: Run it** (adjust the route key / fixtures until green)

Run: `pnpm --filter @dawn-example/chat-server test -- eval-dogfood`
Expected: PASS (1 passed). Also sanity-check the CLI path: `cd examples/chat/server && pnpm exec dawn eval` → prints PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/chat/server pnpm-lock.yaml
git commit -m "test(evals): dogfood a deterministic chat-example eval (replay CI lane)"
```

---

## Task 14: Docs + changeset + full validate

**Files:**
- Create: `apps/web/content/docs/evals.mdx`
- Modify: docs nav/sidebar if one exists (search `testing-agents` references to mirror placement)
- Create: `.changeset/eval-authoring.md`

- [ ] **Step 1: Write `apps/web/content/docs/evals.mdx`** — cover: what evals are vs scenario tests; the `*.eval.ts` convention; `defineEval` with `dataset` (array/path/function); the built-in scorers + `custom` + `llmJudge`; `gate.*` policies + `threshold` sugar + per-scorer thresholds; replay (default, CI-safe, per-case fixtures) vs `--live`; `dawn eval` flags + exit-code gating; the `.dawn/eval-report.json`. Mirror the structure/voice of `apps/web/content/docs/testing-agents.mdx`. Avoid the phrase "byte-identical" (the `scripts/check-docs.mjs` Docs Check lane bans it).

- [ ] **Step 2: Write `.changeset/eval-authoring.md`**

```markdown
---
"@dawn-ai/evals": minor
"@dawn-ai/cli": minor
---

Add eval authoring: a new `@dawn-ai/evals` package (`defineEval`, built-in + `custom` + `llmJudge` scorers, composable `gate.*` policies, `dataset` as array/path/function) and a `dawn eval` command that runs an agent route over a dataset and reports/gates on scores. Default execution is deterministic replay (per-case aimock fixtures, CI-safe); `dawn eval --live` runs the real model locally (gated on `OPENAI_API_KEY`, never in CI). Evals are discovered from `src/app/<route>/evals/*.eval.ts`, mirroring the `run.test.ts` convention.
```

> Note: `@dawn-ai/cli` is in the changeset `fixed` group, so this bumps the whole group; `@dawn-ai/evals` is new and versions independently. This only queues a Version PR — it does not publish.

- [ ] **Step 3: Run the full validation suite**

Run: `pnpm install && pnpm lint && pnpm build && pnpm typecheck && pnpm test`
Expected: all green. Then run the docs + harness gates that CI runs:
Run: `node scripts/check-docs.mjs && pnpm verify:harness:framework`
Expected: docs check passes; framework harness passes. (Run `pnpm verify:harness` if time permits to cover runtime + smoke lanes.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/content/docs/evals.mdx .changeset/eval-authoring.md
git commit -m "docs(evals): eval authoring guide + changeset"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** package boundary (T1), authoring surface/types (T2,T10), scorers incl. llmJudge (T5,T6), gates incl. composition + per-scorer + informational default (T7), dataset overload array/path/function (T8), replay+live execution + per-case fixtures (T9,T12), discovery mirroring run.test.ts (T11), `dawn eval` + reporting + `--json` + gating exit code (T12), LangSmith passive (no task needed — inherited via env, documented in T14), dogfood deterministic CI lane (T13), docs + changeset + validate (T14). **Deviations flagged at handoff:** `--record` deferred (aimock handle exposes requests, not capturable response fixtures); `latencyUnder` dropped (`AgentRunResult` has no timing field); agent-only routes (spec-scoped).

**Placeholder scan:** none — every code step has complete code; T11/T12/T13 leave the temp-app builders and route-key alignment to the implementer with explicit references to the files to copy from (`load-run-scenarios.ts`, `run-command.test.ts`, `runtime-registry.ts`), which is integration detail, not a placeholder for core logic.

**Type consistency:** `EvalDefinition`/`Scorer`/`Score`/`EvalReport`/`ScoredReport`/`GatePolicy` are defined once in T2 and used consistently in T5–T12; `runEval(def, { runCase, baseDir })` signature matches between T9 (definition), T12 (CLI call), and T13 (dogfood call); `normalizeScore` return shape (`{score,label?,reason?}`) is consistent across T3/T5/T9; `gate.*` names match between T7 and the spec/docs.
