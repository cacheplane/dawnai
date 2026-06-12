# Model-Id Discoverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `dawn check`/`verify` and the runtime warn (never error) on model ids that aren't in a curated per-provider list, with did-you-mean suggestions.

**Architecture:** One PR off `feat/model-id-discoverability` (spec: `docs/superpowers/specs/2026-06-11-model-id-discoverability-design.md`). sdk becomes the source of truth: value arrays of curated ids (types derive), `inferProvider` moved in from langchain (re-exported there, zero behavior change), and a pure `validateModelId`. cli's check command gains an agent-descriptor pass; langchain's chat-model factory warns once per (model, provider).

**Tech Stack:** TypeScript (no semicolons, double quotes, 2-space, `.js` specifiers), pnpm, Vitest, Biome, changesets.

**Conventions:** `pnpm -r build` once at start; rebuild a package (`pnpm --filter <pkg> build`) after editing it when another package's tests consume it via dist. Also run `pnpm -r --if-present typecheck` before declaring done — CI typechecks contract files that build+lint miss. `pyenv: cannot rehash` warnings are harmless noise.

---

### Task 1: Values-first curated model ids in sdk

**Files:**
- Modify: `packages/sdk/src/known-model-ids.ts` (full rewrite)
- Modify: `packages/sdk/src/index.ts` (export new values + types)
- Test: `packages/sdk/test/known-model-ids.test.ts` (create)

- [ ] **Step 1: Verify current vendor ids (web).** Use WebSearch to confirm, as of today: (a) xAI's current API model ids from docs.x.ai/developers/models (spec note: `grok-4.3` is flagship; xAI deprecated-and-redirected `grok-4-fast-*`/`grok-3`/`grok-code-fast-1` on 2026-05-15 — list only currently-recommended ids, keep it small); (b) Anthropic's current ids (spec baseline: `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`); (c) spot-check the existing OpenAI/Google lists for obvious staleness — keep existing entries unless clearly removed by the vendor (warn-only semantics tolerate dead ids; do not churn the list speculatively). Record what you verified in your report.

- [ ] **Step 2: Write the failing test** (`packages/sdk/test/known-model-ids.test.ts`):

```ts
import { describe, expect, it } from "vitest"
import {
  ANTHROPIC_MODEL_IDS,
  CURATED_MODEL_IDS,
  GOOGLE_MODEL_IDS,
  OPENAI_MODEL_IDS,
  XAI_MODEL_IDS,
} from "../src/known-model-ids.js"

describe("curated model ids", () => {
  it("exposes non-empty curated lists for openai, google, anthropic, xai", () => {
    for (const list of [OPENAI_MODEL_IDS, GOOGLE_MODEL_IDS, ANTHROPIC_MODEL_IDS, XAI_MODEL_IDS]) {
      expect(list.length).toBeGreaterThan(0)
    }
  })

  it("maps curated providers to their lists and omits uncurated providers", () => {
    expect(CURATED_MODEL_IDS.openai).toBe(OPENAI_MODEL_IDS)
    expect(CURATED_MODEL_IDS.google).toBe(GOOGLE_MODEL_IDS)
    expect(CURATED_MODEL_IDS.anthropic).toBe(ANTHROPIC_MODEL_IDS)
    expect(CURATED_MODEL_IDS.xai).toBe(XAI_MODEL_IDS)
    expect(CURATED_MODEL_IDS).not.toHaveProperty("ollama")
    expect(CURATED_MODEL_IDS).not.toHaveProperty("openrouter")
    expect(CURATED_MODEL_IDS).not.toHaveProperty("groq")
  })

  it("keeps the flagship anchors present", () => {
    expect(OPENAI_MODEL_IDS).toContain("gpt-5.5")
    expect(ANTHROPIC_MODEL_IDS).toContain("claude-opus-4-8")
    expect(XAI_MODEL_IDS).toContain("grok-4.3")
    expect(GOOGLE_MODEL_IDS).toContain("gemini-2.5-pro")
  })
})
```

(Adjust the anchor assertions to whatever Step 1 verified — they must reflect the shipped lists.)

- [ ] **Step 3: Run to verify failure:** `pnpm --filter @dawn-ai/sdk test -- known-model-ids` — FAIL (value exports don't exist; if sdk has no test script, check package.json — add the same vitest test script the other packages use ONLY if missing, mirroring `packages/core/package.json`).

- [ ] **Step 4: Rewrite `known-model-ids.ts`** — value arrays first, types derived, existing type names preserved:

```ts
import type { BuiltInModelProviderId } from "./model-provider.js"

export const OPENAI_MODEL_IDS = [
  // GPT-5.x series
  "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro", "gpt-5-mini",
  // GPT-4.1 series
  "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
  // GPT-4o series
  "gpt-4o", "gpt-4o-mini",
  // Reasoning
  "o3", "o3-mini", "o4-mini",
] as const

export const GOOGLE_MODEL_IDS = [
  "gemini-3-pro-preview", "gemini-3-flash-preview",
  "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite",
] as const

export const ANTHROPIC_MODEL_IDS = [
  // verified against vendor docs in Step 1 — adjust if needed
  "claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001",
] as const

export const XAI_MODEL_IDS = [
  // verified against docs.x.ai in Step 1 — adjust if needed
  "grok-4.3",
] as const

export type OpenAiModelId = (typeof OPENAI_MODEL_IDS)[number]
export type GoogleModelId = (typeof GOOGLE_MODEL_IDS)[number]
export type AnthropicModelId = (typeof ANTHROPIC_MODEL_IDS)[number]
export type XaiModelId = (typeof XAI_MODEL_IDS)[number]

export type KnownModelId =
  | OpenAiModelId
  | GoogleModelId
  | AnthropicModelId
  | XaiModelId
  | (string & {})

/**
 * Curated id lists keyed by provider. Providers absent from this map are
 * uncurated — validation stays silent for them. Lists are advisory:
 * warn-only consumers must never hard-fail on a miss.
 */
export const CURATED_MODEL_IDS: Readonly<
  Partial<Record<BuiltInModelProviderId, readonly string[]>>
> = {
  openai: OPENAI_MODEL_IDS,
  google: GOOGLE_MODEL_IDS,
  anthropic: ANTHROPIC_MODEL_IDS,
  xai: XAI_MODEL_IDS,
}
```

Update `packages/sdk/src/index.ts`: the existing `KnownModelId`/`OpenAiModelId`/`GoogleModelId` type exports stay; add `AnthropicModelId`, `XaiModelId` types and the five value exports (`OPENAI_MODEL_IDS`, `GOOGLE_MODEL_IDS`, `ANTHROPIC_MODEL_IDS`, `XAI_MODEL_IDS`, `CURATED_MODEL_IDS`) following the file's grouping.

- [ ] **Step 5: Verify green + build + lint:** `pnpm --filter @dawn-ai/sdk build && pnpm --filter @dawn-ai/sdk test && pnpm --filter @dawn-ai/sdk lint`. Also `pnpm -r build` (KnownModelId consumers must still compile — `agent.ts` references should be untouched).

- [ ] **Step 6: Commit:**
```bash
git add packages/sdk/src/known-model-ids.ts packages/sdk/src/index.ts packages/sdk/test/known-model-ids.test.ts
git commit -m "feat(sdk): values-first curated model ids incl. anthropic and xai"
```

### Task 2: Move `inferProvider` to sdk (pure move; langchain re-exports)

**Files:**
- Modify: `packages/sdk/src/model-provider.ts` (add `inferProvider` + `SUPPORTED_AGENT_PROVIDERS`)
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/langchain/src/model-provider-resolver.ts`
- Test: existing `packages/langchain/test/model-provider-resolver.test.ts` must pass UNCHANGED

- [ ] **Step 1:** MOVE (verbatim bodies) from `packages/langchain/src/model-provider-resolver.ts` into `packages/sdk/src/model-provider.ts`: the `SUPPORTED_AGENT_PROVIDERS` const (and its `satisfies` clause) and `inferProvider`. Export both from sdk's index.

- [ ] **Step 2:** Rewrite `model-provider-resolver.ts` to import them from `@dawn-ai/sdk` and re-export (`export { inferProvider, SUPPORTED_AGENT_PROVIDERS } from "@dawn-ai/sdk"` — keeping langchain's public API identical since `packages/langchain/src/index.ts:16` re-exports `inferProvider`). `resolveProvider` stays in langchain, now consuming the imported pieces; its body is unchanged.

- [ ] **Step 3:** `pnpm --filter @dawn-ai/sdk build && pnpm --filter @dawn-ai/langchain build && pnpm --filter @dawn-ai/langchain test` — all 159 langchain tests pass unchanged (the resolver tests import from `../src/model-provider-resolver.js`, which still exports everything).

- [ ] **Step 4:** Lint both packages, commit:
```bash
git add packages/sdk/src/model-provider.ts packages/sdk/src/index.ts packages/langchain/src/model-provider-resolver.ts
git commit -m "refactor(sdk): host inferProvider and supported-provider list; langchain re-exports"
```

### Task 3: `validateModelId` in sdk (TDD)

**Files:**
- Create: `packages/sdk/src/validate-model-id.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/validate-model-id.test.ts` (create)

- [ ] **Step 1: Write the failing tests:**

```ts
import { describe, expect, it } from "vitest"
import { validateModelId } from "../src/validate-model-id.js"

describe("validateModelId", () => {
  it("flags a near-miss on a curated provider with distance-ranked suggestions", () => {
    const result = validateModelId({ model: "gpt-5" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.provider).toBe("openai")
      expect(result.suggestions[0]).toBe("gpt-5.5")
      expect(result.suggestions.length).toBeLessThanOrEqual(3)
    }
  })

  it("accepts curated hits", () => {
    expect(validateModelId({ model: "gpt-5.5" })).toEqual({ ok: true })
    expect(validateModelId({ model: "claude-opus-4-8" })).toEqual({ ok: true })
    expect(validateModelId({ model: "grok-4.3" })).toEqual({ ok: true })
  })

  it("stays silent for uncurated providers", () => {
    expect(validateModelId({ model: "llama3.1", provider: "ollama" })).toEqual({ ok: true })
    expect(validateModelId({ model: "anything", provider: "openrouter" })).toEqual({ ok: true })
    expect(validateModelId({ model: "mixtral-8x22b" })).toEqual({ ok: true }) // infers mistral, uncurated
  })

  it("stays silent when no provider can be resolved", () => {
    expect(validateModelId({ model: "totally-custom" })).toEqual({ ok: true })
  })

  it("explicit provider beats inference", () => {
    // gpt-prefixed model explicitly routed through an uncurated gateway: silent
    expect(validateModelId({ model: "gpt-5", provider: "openrouter" })).toEqual({ ok: true })
    // custom-named model explicitly on a curated provider: flagged
    const result = validateModelId({ model: "my-alias", provider: "anthropic" })
    expect(result.ok).toBe(false)
  })

  it("flags an anthropic near-miss with a suggestion", () => {
    const result = validateModelId({ model: "claude-opus-4.8" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.suggestions).toContain("claude-opus-4-8")
  })
})
```

- [ ] **Step 2:** `pnpm --filter @dawn-ai/sdk test -- validate-model-id` — FAIL (module missing).

- [ ] **Step 3: Implement `packages/sdk/src/validate-model-id.ts`:**

```ts
import { CURATED_MODEL_IDS } from "./known-model-ids.js"
import { inferProvider } from "./model-provider.js"

export type ModelIdValidation =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly provider: string
      /** Nearest curated ids for the provider, closest first, max 3. */
      readonly suggestions: readonly string[]
    }

/**
 * Advisory check of a model id against the curated per-provider lists.
 * Silent (ok: true) for uncurated or unresolvable providers — the lists are
 * suggestions, not gates; consumers must warn, never hard-fail.
 */
export function validateModelId(opts: {
  readonly model: string
  readonly provider?: string
}): ModelIdValidation {
  const provider = opts.provider ?? inferProvider(opts.model)
  if (!provider) return { ok: true }

  const curated = (CURATED_MODEL_IDS as Readonly<Record<string, readonly string[] | undefined>>)[
    provider
  ]
  if (!curated) return { ok: true }
  if (curated.includes(opts.model)) return { ok: true }

  const suggestions = [...curated]
    .map((id) => ({ distance: levenshtein(opts.model, id), id }))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((entry) => entry.id)

  return { ok: false, provider, suggestions }
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const dist: number[] = Array.from({ length: cols }, (_, j) => j)
  for (let i = 1; i < rows; i++) {
    let prevDiagonal = dist[0] as number
    dist[0] = i
    for (let j = 1; j < cols; j++) {
      const previous = dist[j] as number
      dist[j] = Math.min(
        previous + 1,
        (dist[j - 1] as number) + 1,
        prevDiagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      prevDiagonal = previous
    }
  }
  return dist[cols - 1] as number
}
```

(If Biome objects to the `as number` assertions, restructure with non-asserting reads — e.g. `?? 0` fallbacks; behavior identical.)

Export `validateModelId` + `ModelIdValidation` from sdk's index.

- [ ] **Step 4:** `pnpm --filter @dawn-ai/sdk build && pnpm --filter @dawn-ai/sdk test && pnpm --filter @dawn-ai/sdk lint` — green.

- [ ] **Step 5: Commit:**
```bash
git add packages/sdk/src/validate-model-id.ts packages/sdk/src/index.ts packages/sdk/test/validate-model-id.test.ts
git commit -m "feat(sdk): validateModelId advisory check with did-you-mean suggestions"
```

### Task 4: `dawn check` descriptor pass (TDD)

**Files:**
- Modify: `packages/cli/src/commands/check.ts`
- Test: `packages/cli/test/check-model-ids.test.ts` (create)

- [ ] **Step 1: Write the failing test** — follow `packages/cli/test/check-command.test.ts`'s `createFixtureApp`/`invoke` pattern exactly (in-process `run` from `../src/index.js`):

```ts
// fixtures: an agent route with a bad model id
"src/app/(public)/draft/index.ts": `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5",
  systemPrompt: "You draft things.",
})
`,
```

Tests:
1. `dawn check` on the bad-model fixture → exit code **0**, stdout contains `model "gpt-5" is not a known openai model id`, contains `gpt-5.5` (suggestion), and contains the route pathname `/draft`.
2. Same fixture with `model: "gpt-5.5"` → exit 0, stdout contains NO `is not a known` text.
3. Fixture with `model: "llama3.1", provider: "ollama"` → exit 0, no warning (uncurated).

(The fixture app needs `@dawn-ai/sdk` resolvable — check how existing check/run fixtures that import `@dawn-ai/sdk` handle node_modules; `run-command.test.ts` fixtures import it, so copy that scaffolding precisely.)

- [ ] **Step 2:** Run, verify FAIL (no warning emitted today).

- [ ] **Step 3: Implement** in `runCheckCommand` after the route listing loop:

```ts
for (const route of manifest.routes) {
  if (route.kind !== "agent") continue
  let normalized: NormalizedRouteModule
  try {
    normalized = await normalizeRouteModule(join(route.routeDir, "index.ts"))
  } catch {
    continue // load failures are surfaced by discovery paths, not this advisory pass
  }
  if (!isDawnAgent(normalized.entry)) continue
  const verdict = validateModelId({
    model: normalized.entry.model,
    ...(normalized.entry.provider ? { provider: normalized.entry.provider } : {}),
  })
  if (!verdict.ok) {
    const suggestions = verdict.suggestions.map((s) => `"${s}"`).join(", ")
    writeLine(
      io.stdout,
      `\n⚠ ${route.pathname}: model "${normalized.entry.model}" is not a known ${verdict.provider} model id.` +
        (suggestions ? ` Did you mean ${suggestions}?` : "") +
        `\n  Known-id lists are advisory — new or proxy model ids work if your provider accepts them.`,
    )
  }
}
```

Imports: `isDawnAgent`, `validateModelId` from `@dawn-ai/sdk`; `normalizeRouteModule` + its type from `../lib/runtime/load-route-kind.js`; `join` from `node:path`. Exit code unaffected.

- [ ] **Step 4:** Rebuild + run: `pnpm --filter @dawn-ai/sdk build && pnpm --filter @dawn-ai/cli test -- check-model-ids` then the FULL cli suite. All green.

- [ ] **Step 5:** Lint + commit:
```bash
git add packages/cli/src/commands/check.ts packages/cli/test/check-model-ids.test.ts
git commit -m "feat(cli): dawn check warns on unknown model ids with suggestions"
```

### Task 5: Runtime warn in the chat-model factory (TDD)

**Files:**
- Modify: `packages/langchain/src/chat-model-factory.ts`
- Test: `packages/langchain/test/chat-model-factory-warnings.test.ts` (create)

- [ ] **Step 1: Read `chat-model-factory.ts` in full**, then write the failing tests. The factory is called with `{ model, provider, reasoning? }` where provider is already resolved. Test via a spy on `console.warn`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { warnOnUnknownModelId } from "../src/chat-model-factory.js"

describe("model id warnings", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("warns once per (model, provider) pair with suggestions", () => {
    warnOnUnknownModelId({ model: "gpt-5", provider: "openai" })
    warnOnUnknownModelId({ model: "gpt-5", provider: "openai" })
    expect(console.warn).toHaveBeenCalledTimes(1)
    const message = vi.mocked(console.warn).mock.calls[0]?.[0] as string
    expect(message).toContain("[dawn:models]")
    expect(message).toContain('"gpt-5"')
    expect(message).toContain("gpt-5.5")
    expect(message).toContain("Proceeding anyway")
  })

  it("stays silent for curated hits and uncurated providers", () => {
    warnOnUnknownModelId({ model: "gpt-5.5", provider: "openai" })
    warnOnUnknownModelId({ model: "llama3.1", provider: "ollama" })
    expect(console.warn).not.toHaveBeenCalled()
  })
})
```

Note the dedup Set is module-level; use distinct (model, provider) pairs across tests or expose nothing — design the test around fresh pairs rather than resetting module state (e.g. the dedup test uses `gpt-5`, the silent test uses different ids). Do NOT add a reset hook to production code just for tests.

- [ ] **Step 2:** Run to verify FAIL (export missing).

- [ ] **Step 3: Implement** in `chat-model-factory.ts`:

```ts
const warnedModelIds = new Set<string>()

/** Advisory once-per-process warning; never blocks model construction. */
export function warnOnUnknownModelId(opts: {
  readonly model: string
  readonly provider: string
}): void {
  const key = `${opts.provider} ${opts.model}`
  if (warnedModelIds.has(key)) return
  const verdict = validateModelId(opts)
  if (verdict.ok) return
  warnedModelIds.add(key)
  const suggestions = verdict.suggestions.map((s) => `"${s}"`).join(", ")
  console.warn(
    `[dawn:models] model "${opts.model}" is not a known ${verdict.provider} model id.` +
      (suggestions ? ` Did you mean ${suggestions}?` : "") +
      " Proceeding anyway.",
  )
}
```

Call it at the top of the existing factory function (before provider-spec resolution), importing `validateModelId` from `@dawn-ai/sdk`. Only add the key to the Set when a warning is actually emitted (curated hits stay cheap and re-checkable).

- [ ] **Step 4:** `pnpm --filter @dawn-ai/langchain build && pnpm --filter @dawn-ai/langchain test` — new tests pass, all 159+ existing pass.

- [ ] **Step 5:** Lint + commit:
```bash
git add packages/langchain/src/chat-model-factory.ts packages/langchain/test/chat-model-factory-warnings.test.ts
git commit -m "feat(langchain): once-per-process advisory warning for unknown model ids"
```

### Task 6: Docs note + changeset + full verification + PR

**Files:**
- Modify: `apps/web/content/docs/agents.mdx` ("Model providers" section, after the provider-explicit paragraph ~line 33)
- Create: `.changeset/model-id-discoverability.md`

- [ ] **Step 1: agents.mdx** — add one short paragraph to "Model providers":

```mdx
`dawn check` (and `dawn verify`) warn when a model id isn't in Dawn's curated list for the resolved provider (`openai`, `google`, `anthropic`, `xai`), with did-you-mean suggestions; the runtime prints the same advisory once when the model is constructed. The lists are advisory — new, proxy, or gateway model ids run fine if your provider accepts them, and providers without curated lists (`mistral`, `groq`, `ollama`, `openrouter`) are never warned about.
```

Build the docs site: `pnpm --filter @dawn-ai/web build` (revert `apps/web/next-env.d.ts` churn).

- [ ] **Step 2: Changeset** `.changeset/model-id-discoverability.md`:

```md
---
"@dawn-ai/sdk": minor
"@dawn-ai/langchain": minor
"@dawn-ai/cli": minor
---

Unknown model ids now get advisory warnings instead of late provider 404s. `dawn check`/`verify` warn (exit code unchanged) when an agent route's `model` isn't in the curated list for its resolved provider (`openai`, `google`, `anthropic`, `xai`), with did-you-mean suggestions; the runtime prints the same `[dawn:models]` advisory once per model at chat-model construction. Curated lists are values now (`CURATED_MODEL_IDS` etc.) with types derived, Anthropic and xAI ids included; `validateModelId` and `inferProvider` are exported from `@dawn-ai/sdk`.
```

- [ ] **Step 3: Full verification:**
`pnpm -r build && pnpm -r --if-present typecheck && pnpm --filter @dawn-ai/sdk test && pnpm --filter @dawn-ai/langchain test && pnpm --filter @dawn-ai/cli test && pnpm --filter @dawn-ai/sdk lint && pnpm --filter @dawn-ai/langchain lint && pnpm --filter @dawn-ai/cli lint`

- [ ] **Step 4: Commit + push + PR:**
```bash
git add apps/web/content/docs/agents.mdx .changeset/model-id-discoverability.md
git commit -m "docs: model-id advisory warnings note; changeset"
git push -u origin feat/model-id-discoverability
gh pr create --base main --title "feat: advisory warnings for unknown model ids" \
  --body "Backlog #5. Spec: docs/superpowers/specs/2026-06-11-model-id-discoverability-design.md. Curated per-provider id lists (values-first, +anthropic +xai), shared validateModelId, dawn check/verify warnings with did-you-mean, once-per-process runtime advisory."
```
