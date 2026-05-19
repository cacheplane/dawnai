# LangChain Provider Materialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Dawn's built-in `agent({ model })` materialization provider-aware across LangChain chat model integrations, using automatic inference with an explicit `provider` override and optional peer dependencies.

**Architecture:** Add `provider?: ModelProviderId` to SDK descriptors, then replace direct `ChatOpenAI` construction in `@dawn-ai/langchain` with a resolver/factory pair. The resolver handles inference and user-facing errors; the factory lazy-imports provider packages and constructs the selected LangChain chat model. Existing `graph` and `chain` routes remain unchanged.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest 4, LangChain JS 1.x, LangGraph prebuilt React agents, Node.js 22.12+.

---

## References

Spec: `docs/superpowers/specs/2026-05-19-langchain-provider-materialization-design.md`

Current LangChain JS docs checked on May 19, 2026:
- OpenRouter: `@langchain/openrouter`, `ChatOpenRouter` - https://docs.langchain.com/oss/javascript/integrations/chat/openrouter
- Google Gemini: current docs still show `@langchain/google-genai`, `ChatGoogleGenerativeAI`, with a deprecation note toward `ChatGoogle` - https://docs.langchain.com/oss/javascript/integrations/chat/google_generative_ai
- Anthropic: `@langchain/anthropic`, `ChatAnthropic` - https://docs.langchain.com/oss/javascript/integrations/providers/anthropic
- Groq: `@langchain/groq`, `ChatGroq` - https://docs.langchain.com/oss/javascript/integrations/chat/groq
- xAI: `@langchain/xai`, `ChatXAI` - https://docs.langchain.com/oss/javascript/integrations/chat/xai
- Chat model index lists `ChatGoogle`, `ChatMistralAI`, `ChatOllama`, `ChatXAI`, and proxy guidance - https://docs.langchain.com/oss/javascript/integrations/chat

## File Structure

Create:
- `packages/sdk/src/model-provider.ts` - public provider id types.
- `packages/langchain/src/model-provider-resolver.ts` - model-to-provider inference and provider validation.
- `packages/langchain/src/chat-model-factory.ts` - lazy provider imports and constructor wiring.
- `packages/langchain/test/model-provider-resolver.test.ts` - inference and error tests.
- `packages/langchain/test/chat-model-factory.test.ts` - factory tests with injected importers/constructors.

Modify:
- `packages/sdk/src/agent.ts` - descriptor carries `provider`.
- `packages/sdk/src/index.ts` - export provider types.
- `packages/sdk/test/agent.test.ts` - provider carry-through tests.
- `packages/sdk/test/known-model-ids.test.ts` - provider type compatibility tests.
- `packages/langchain/src/agent-adapter.ts` - call `resolveChatModel()` instead of `new ChatOpenAI(...)`.
- `packages/langchain/src/index.ts` - export resolver/factory helpers only if useful for tests or advanced users.
- `packages/langchain/package.json` - optional peer metadata and dev deps for provider integrations.
- `packages/langchain/test/agent-adapter.test.ts` and `packages/langchain/test/agent-descriptor-integration.test.ts` - update comments/assertions away from OpenAI-only wording.
- `packages/cli/test/build-command.test.ts` - ensure non-OpenAI descriptors preserve build artifact shape.
- Docs and website copy found by `rg -n "OpenAI-backed|ChatOpenAI|KnownModelId|provider"` across `apps/web`, `packages/*/README.md`, `CONTRIBUTORS.md`, and `README.md`.

## Task 1: Add Provider To The SDK Descriptor

**Files:**
- Create: `packages/sdk/src/model-provider.ts`
- Modify: `packages/sdk/src/agent.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/agent.test.ts`
- Test: `packages/sdk/test/known-model-ids.test.ts`

- [ ] **Step 1: Write failing SDK tests**

Add to `packages/sdk/test/agent.test.ts`:

```ts
test("preserves optional provider on the descriptor", () => {
  const descriptor = agent({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    systemPrompt: "Hello",
  })

  expect(descriptor.provider).toBe("anthropic")
})

test("provider defaults to undefined when not provided", () => {
  const descriptor = agent({ model: "gpt-4o-mini", systemPrompt: "Hello" })
  expect(descriptor.provider).toBeUndefined()
})
```

Add to `packages/sdk/test/known-model-ids.test.ts`:

```ts
import type { ModelProviderId } from "@dawn-ai/sdk"

test("ModelProviderId accepts known providers and custom strings", () => {
  expectTypeOf<"openai">().toMatchTypeOf<ModelProviderId>()
  expectTypeOf<"anthropic">().toMatchTypeOf<ModelProviderId>()
  expectTypeOf<string & {}>().toMatchTypeOf<ModelProviderId>()
})
```

- [ ] **Step 2: Run SDK tests and verify failure**

Run:

```bash
pnpm exec vitest --run --config packages/sdk/vitest.config.ts packages/sdk/test/agent.test.ts packages/sdk/test/known-model-ids.test.ts
```

Expected: FAIL because `provider` and `ModelProviderId` do not exist yet.

- [ ] **Step 3: Add provider type**

Create `packages/sdk/src/model-provider.ts`:

```ts
export type BuiltInModelProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "groq"
  | "ollama"
  | "xai"
  | "openrouter"

export type ModelProviderId = BuiltInModelProviderId | (string & {})
```

- [ ] **Step 4: Carry provider through descriptors**

Modify `packages/sdk/src/agent.ts`:

```ts
import type { KnownModelId } from "./known-model-ids.js"
import type { ModelProviderId } from "./model-provider.js"
```

Add `readonly provider?: ModelProviderId` to both `DawnAgent` and `AgentConfig`, then add this spread inside `agent()`:

```ts
...(config.provider !== undefined ? { provider: config.provider } : {}),
```

- [ ] **Step 5: Export provider types**

Modify `packages/sdk/src/index.ts`:

```ts
export type {
  BuiltInModelProviderId,
  ModelProviderId,
} from "./model-provider.js"
```

- [ ] **Step 6: Run SDK tests and typecheck**

Run:

```bash
pnpm exec vitest --run --config packages/sdk/vitest.config.ts packages/sdk/test/agent.test.ts packages/sdk/test/known-model-ids.test.ts
pnpm --filter @dawn-ai/sdk typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/model-provider.ts packages/sdk/src/agent.ts packages/sdk/src/index.ts packages/sdk/test/agent.test.ts packages/sdk/test/known-model-ids.test.ts
git commit -m "feat(sdk): add agent provider descriptor field"
```

## Task 2: Implement Conservative Provider Inference

**Files:**
- Create: `packages/langchain/src/model-provider-resolver.ts`
- Create: `packages/langchain/test/model-provider-resolver.test.ts`

- [ ] **Step 1: Write failing resolver tests**

Create `packages/langchain/test/model-provider-resolver.test.ts`:

```ts
import { describe, expect, test } from "vitest"
import {
  inferProvider,
  resolveProvider,
  SUPPORTED_AGENT_PROVIDERS,
} from "../src/model-provider-resolver.js"

describe("model provider resolver", () => {
  test.each([
    ["gpt-4o-mini", "openai"],
    ["gpt-5-mini", "openai"],
    ["o4-mini", "openai"],
    ["claude-sonnet-4-5", "anthropic"],
    ["gemini-2.5-pro", "google"],
    ["mistral-large-latest", "mistral"],
    ["mixtral-8x7b", "mistral"],
    ["codestral-latest", "mistral"],
    ["grok-beta", "xai"],
  ] as const)("infers %s as %s", (model, provider) => {
    expect(inferProvider(model)).toBe(provider)
  })

  test.each(["my-custom-model", "llama-3.3-70b-versatile", "qwen3-32b", "deepseek-r1"])(
    "does not infer ambiguous model %s",
    (model) => {
      expect(inferProvider(model)).toBeUndefined()
    },
  )

  test("explicit provider bypasses inference", () => {
    expect(resolveProvider({ provider: "groq", model: "llama-3.3-70b-versatile" })).toBe("groq")
  })

  test("unknown explicit provider fails with supported list", () => {
    expect(() => resolveProvider({ provider: "unknown", model: "gpt-4o" })).toThrow(
      `Unsupported agent provider "unknown". Supported providers: ${SUPPORTED_AGENT_PROVIDERS.join(", ")}.`,
    )
  })

  test("unknown inferred provider asks for explicit provider", () => {
    expect(() => resolveProvider({ model: "internal-alias" })).toThrow(
      'Could not infer a LangChain provider for model "internal-alias".',
    )
  })
})
```

- [ ] **Step 2: Run resolver tests and verify failure**

Run:

```bash
pnpm exec vitest --run --config packages/langchain/vitest.config.ts packages/langchain/test/model-provider-resolver.test.ts
```

Expected: FAIL because the resolver module does not exist.

- [ ] **Step 3: Implement resolver**

Create `packages/langchain/src/model-provider-resolver.ts`:

```ts
import type { BuiltInModelProviderId, ModelProviderId } from "@dawn-ai/sdk"

export const SUPPORTED_AGENT_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "mistral",
  "groq",
  "ollama",
  "xai",
  "openrouter",
] as const satisfies readonly BuiltInModelProviderId[]

const supportedProviderSet = new Set<string>(SUPPORTED_AGENT_PROVIDERS)

export function inferProvider(model: string): BuiltInModelProviderId | undefined {
  const normalized = model.trim().toLowerCase()

  if (/^(gpt-|o3|o4)/.test(normalized)) return "openai"
  if (normalized.startsWith("claude-")) return "anthropic"
  if (normalized.startsWith("gemini-")) return "google"
  if (
    normalized.startsWith("mistral-") ||
    normalized.startsWith("mixtral-") ||
    normalized.startsWith("codestral-")
  ) {
    return "mistral"
  }
  if (normalized.startsWith("grok-")) return "xai"

  return undefined
}

export function resolveProvider(options: {
  readonly model: string
  readonly provider?: ModelProviderId
}): BuiltInModelProviderId {
  if (options.provider !== undefined) {
    if (supportedProviderSet.has(options.provider)) {
      return options.provider as BuiltInModelProviderId
    }
    throw new Error(
      `Unsupported agent provider "${options.provider}". Supported providers: ${SUPPORTED_AGENT_PROVIDERS.join(", ")}.`,
    )
  }

  const inferred = inferProvider(options.model)
  if (inferred) return inferred

  throw new Error(
    `Could not infer a LangChain provider for model "${options.model}". Set provider explicitly on agent({ provider: "...", model: "${options.model}", ... }).`,
  )
}
```

- [ ] **Step 4: Run resolver tests**

Run:

```bash
pnpm exec vitest --run --config packages/langchain/vitest.config.ts packages/langchain/test/model-provider-resolver.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/model-provider-resolver.ts packages/langchain/test/model-provider-resolver.test.ts
git commit -m "feat(langchain): infer agent model providers"
```

## Task 3: Add Lazy Chat Model Factory

**Files:**
- Create: `packages/langchain/src/chat-model-factory.ts`
- Create: `packages/langchain/test/chat-model-factory.test.ts`
- Modify: `packages/langchain/package.json`

- [ ] **Step 1: Confirm exact Google package before coding**

Use official LangChain JS docs and current npm package availability to decide whether first-pass Google support should use:

```ts
import { ChatGoogleGenerativeAI } from "@langchain/google-genai"
```

or a newer:

```ts
import { ChatGoogle } from "@langchain/google"
```

Record the decision in the test names and docs comments. As of the spec, the docs still show `@langchain/google-genai` but warn it will be replaced by `ChatGoogle`.

- [ ] **Step 2: Add optional peers and dev dependencies**

Modify `packages/langchain/package.json`:

```json
"peerDependencies": {
  "@langchain/core": ">=1.1.0",
  "@langchain/anthropic": "^1.4.0",
  "@langchain/google-genai": "^2.1.31",
  "@langchain/mistralai": "^1.0.8",
  "@langchain/groq": "^1.2.1",
  "@langchain/ollama": "^1.2.7",
  "@langchain/xai": "^1.3.18",
  "@langchain/openrouter": "^0.2.5"
},
"peerDependenciesMeta": {
  "@langchain/anthropic": { "optional": true },
  "@langchain/google-genai": { "optional": true },
  "@langchain/mistralai": { "optional": true },
  "@langchain/groq": { "optional": true },
  "@langchain/ollama": { "optional": true },
  "@langchain/xai": { "optional": true },
  "@langchain/openrouter": { "optional": true }
}
```

Also add the provider packages to `devDependencies` with the same ranges so TypeScript can resolve dynamic imports during repo typecheck. These versions came from `pnpm view` during plan writing; re-check if implementation happens later.

- [ ] **Step 3: Install/update lockfile**

Run:

```bash
pnpm install
```

Expected: `pnpm-lock.yaml` updates with optional provider packages.

- [ ] **Step 4: Write failing factory tests**

Create `packages/langchain/test/chat-model-factory.test.ts`. Use an injected importer so missing-package and constructor-option behavior can be tested without real API calls:

```ts
import { describe, expect, test, vi } from "vitest"
import { createChatModel, missingProviderPackageMessage } from "../src/chat-model-factory.js"

class FakeModel {
  constructor(readonly options: Record<string, unknown>) {}
}

describe("chat model factory", () => {
  test("creates OpenAI with reasoningEffort", async () => {
    const importer = vi.fn().mockResolvedValue({ ChatOpenAI: FakeModel })
    const model = await createChatModel({
      model: "gpt-5-mini",
      provider: "openai",
      reasoning: { effort: "high" },
      importer,
    })

    expect(importer).toHaveBeenCalledWith("@langchain/openai")
    expect((model as FakeModel).options).toEqual({
      model: "gpt-5-mini",
      reasoningEffort: "high",
    })
  })

  test("does not pass OpenAI reasoningEffort to Anthropic", async () => {
    const importer = vi.fn().mockResolvedValue({ ChatAnthropic: FakeModel })
    const model = await createChatModel({
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      reasoning: { effort: "high" },
      importer,
    })

    expect((model as FakeModel).options).toEqual({ model: "claude-sonnet-4-5" })
  })

  test("wraps missing optional peer with install command", async () => {
    const importer = vi.fn().mockRejectedValue(Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" }))

    await expect(
      createChatModel({ model: "claude-sonnet-4-5", provider: "anthropic", importer }),
    ).rejects.toThrow(missingProviderPackageMessage("anthropic", "@langchain/anthropic"))
  })
})
```

- [ ] **Step 5: Run factory tests and verify failure**

Run:

```bash
pnpm exec vitest --run --config packages/langchain/vitest.config.ts packages/langchain/test/chat-model-factory.test.ts
```

Expected: FAIL because the factory module does not exist.

- [ ] **Step 6: Implement factory**

Create `packages/langchain/src/chat-model-factory.ts` with a provider spec map and injectable importer:

```ts
import type { BuiltInModelProviderId, ReasoningConfig } from "@dawn-ai/sdk"

type Importer = (specifier: string) => Promise<Record<string, unknown>>

interface ProviderSpec {
  readonly packageName: string
  readonly exportName: string
}

const providerSpecs: Record<BuiltInModelProviderId, ProviderSpec> = {
  openai: { packageName: "@langchain/openai", exportName: "ChatOpenAI" },
  anthropic: { packageName: "@langchain/anthropic", exportName: "ChatAnthropic" },
  google: { packageName: "@langchain/google-genai", exportName: "ChatGoogleGenerativeAI" },
  mistral: { packageName: "@langchain/mistralai", exportName: "ChatMistralAI" },
  groq: { packageName: "@langchain/groq", exportName: "ChatGroq" },
  ollama: { packageName: "@langchain/ollama", exportName: "ChatOllama" },
  xai: { packageName: "@langchain/xai", exportName: "ChatXAI" },
  openrouter: { packageName: "@langchain/openrouter", exportName: "ChatOpenRouter" },
}

export function missingProviderPackageMessage(provider: BuiltInModelProviderId, packageName: string) {
  return `Provider "${provider}" requires ${packageName}. Install it with: pnpm add ${packageName}`
}
```

Then implement `createChatModel()`:

```ts
export async function createChatModel(options: {
  readonly model: string
  readonly provider: BuiltInModelProviderId
  readonly reasoning?: ReasoningConfig
  readonly importer?: Importer
}): Promise<unknown> {
  const spec = providerSpecs[options.provider]
  const importer = options.importer ?? ((specifier: string) => import(specifier))

  let moduleExports: Record<string, unknown>
  try {
    moduleExports = await importer(spec.packageName)
  } catch (error) {
    if (isMissingModuleError(error)) {
      throw new Error(missingProviderPackageMessage(options.provider, spec.packageName))
    }
    throw error
  }

  const Constructor = moduleExports[spec.exportName]
  if (typeof Constructor !== "function") {
    throw new Error(`Provider "${options.provider}" package ${spec.packageName} does not export ${spec.exportName}.`)
  }

  const constructorOptions: Record<string, unknown> = { model: options.model }
  if (options.provider === "openai" && options.reasoning?.effort) {
    constructorOptions.reasoningEffort = options.reasoning.effort
  }

  return new Constructor(constructorOptions)
}

function isMissingModuleError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ("code" in error ? (error as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND" : true) &&
    /Cannot find (package|module)|ERR_MODULE_NOT_FOUND/i.test(error.message)
  )
}
```

- [ ] **Step 7: Run factory tests and typecheck**

Run:

```bash
pnpm exec vitest --run --config packages/langchain/vitest.config.ts packages/langchain/test/chat-model-factory.test.ts
pnpm --filter @dawn-ai/langchain typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/langchain/package.json pnpm-lock.yaml packages/langchain/src/chat-model-factory.ts packages/langchain/test/chat-model-factory.test.ts
git commit -m "feat(langchain): add provider chat model factory"
```

## Task 4: Wire Provider Resolution Into Agent Materialization

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts`
- Modify: `packages/langchain/src/index.ts`
- Modify: `packages/langchain/test/agent-adapter.test.ts`
- Modify: `packages/langchain/test/agent-descriptor-integration.test.ts`

- [ ] **Step 1: Write/adjust failing integration tests**

In `packages/langchain/test/agent-adapter.test.ts`, add a test that uses a non-OpenAI model with explicit provider and asserts it no longer fails with OpenAI-only materialization wording. Keep the test tolerant of missing API keys:

```ts
test("DawnAgent descriptor accepts explicit non-OpenAI provider", async () => {
  const descriptor = agent({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    systemPrompt: "You are helpful.",
  })

  const error = await executeAgent({
    entry: descriptor,
    input: { question: "hi" },
    routeParamNames: [],
    signal: new AbortController().signal,
    tools: [],
  }).catch((e: Error) => e)

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).not.toContain("ChatOpenAI")
  expect((error as Error).message).not.toContain("must expose invoke")
})
```

- [ ] **Step 2: Run targeted test and verify failure**

Run:

```bash
pnpm exec vitest --run --config packages/langchain/vitest.config.ts packages/langchain/test/agent-adapter.test.ts
```

Expected before implementation: FAIL or still route through direct `ChatOpenAI`.

- [ ] **Step 3: Replace direct ChatOpenAI construction**

Modify `packages/langchain/src/agent-adapter.ts`:

```ts
import { createChatModel } from "./chat-model-factory.js"
import { resolveProvider } from "./model-provider-resolver.js"
```

Replace:

```ts
const { ChatOpenAI } = await import("@langchain/openai")
...
const llm = new ChatOpenAI({ ... })
```

with:

```ts
const provider = resolveProvider({
  model: descriptor.model,
  provider: descriptor.provider,
})
const llm = await createChatModel({
  model: descriptor.model,
  provider,
  reasoning: descriptor.reasoning,
})
```

- [ ] **Step 4: Export focused helpers if needed**

Modify `packages/langchain/src/index.ts` only if tests or downstream users need access:

```ts
export { createChatModel } from "./chat-model-factory.js"
export { inferProvider, resolveProvider } from "./model-provider-resolver.js"
export type { BuiltInModelProviderId, ModelProviderId } from "@dawn-ai/sdk"
```

Prefer exporting `inferProvider` and `resolveProvider` because they are useful for docs and advanced diagnostics. Do not export internal provider spec maps.

- [ ] **Step 5: Update OpenAI-only comments**

Change comments in `packages/langchain/test/agent-adapter.test.ts` and `packages/langchain/test/agent-descriptor-integration.test.ts` from “fail on ChatOpenAI” to “fail on provider construction or network call.”

- [ ] **Step 6: Run LangChain tests**

Run:

```bash
pnpm exec vitest --run --config packages/langchain/vitest.config.ts packages/langchain/test/model-provider-resolver.test.ts packages/langchain/test/chat-model-factory.test.ts packages/langchain/test/agent-adapter.test.ts packages/langchain/test/agent-descriptor-integration.test.ts
pnpm --filter @dawn-ai/langchain typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/langchain/src/agent-adapter.ts packages/langchain/src/index.ts packages/langchain/test/agent-adapter.test.ts packages/langchain/test/agent-descriptor-integration.test.ts
git commit -m "feat(langchain): resolve provider-aware agent models"
```

## Task 5: Cover CLI Build Artifact Stability

**Files:**
- Modify: `packages/cli/test/build-command.test.ts`

- [ ] **Step 1: Add non-OpenAI build test**

Add a second build test or extend the current one with a descriptor like:

```ts
export default agent({
  model: "claude-sonnet-4-5",
  systemPrompt: "Answer tenant support questions.",
})
```

Assert the generated entry still imports `agentDescriptor`, imports discovered tools, and calls:

```ts
export const graph = await materializeAgentGraph({
  descriptor: agentDescriptor,
  tools: [tool0Definition],
})
```

Do not assert provider package imports in build output; provider import remains runtime lazy behavior inside `@dawn-ai/langchain`.

- [ ] **Step 2: Run build command test**

Run:

```bash
pnpm exec vitest --run --config packages/cli/vitest.config.ts packages/cli/test/build-command.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/build-command.test.ts
git commit -m "test(cli): cover non-openai agent build output"
```

## Task 6: Update Documentation And Public Copy

**Files:**
- Modify: `apps/web/content/docs/api.mdx`
- Modify: `apps/web/content/docs/agents.mdx`
- Modify: `apps/web/content/docs/faq.mdx`
- Modify: `apps/web/content/docs/migrating-from-langgraph.mdx`
- Modify: `apps/web/content/templates/AGENTS.md`
- Modify: `apps/web/content/prompts/index.ts`
- Modify: `apps/web/app/llms.txt/route.ts`
- Modify: `apps/web/app/components/landing/Faq.tsx`
- Modify: `packages/langchain/README.md`
- Modify: `packages/sdk/README.md`
- Modify: `CONTRIBUTORS.md`
- Modify: `README.md`
- Optional if still accurate as fixture-specific docs: `docs/brand/README.md`, `docs/brand/quickstart.tape`, `docs/brand/capture-fixture.mjs`

- [ ] **Step 1: Find stale OpenAI-only language**

Run:

```bash
rg -n "OpenAI-backed|ChatOpenAI|KnownModelId|provider adapter|raw graph/chain routes when wiring a different provider" apps/web packages docs README.md CONTRIBUTORS.md
```

Expected: list of docs and comments that need updating.

- [ ] **Step 2: Update API docs**

In `apps/web/content/docs/api.mdx`, add `provider?: ModelProviderId` to `AgentConfig` and describe:

```md
`provider` is optional. When omitted, Dawn infers a provider for known model families. Set it explicitly for aliases, ambiguous model names, local models, or provider routers.
```

Add a `ModelProviderId` section near `KnownModelId`.

- [ ] **Step 3: Update user guidance**

Replace OpenAI-only claims with provider-aware wording:

```md
The built-in `agent()` route materializes to a LangChain chat model. Dawn infers providers for known model families and lazy-loads the matching LangChain integration package. Raw `graph` and `chain` routes can still instantiate any provider directly.
```

Document optional peer installs:

```bash
pnpm add @langchain/anthropic
pnpm add @langchain/google-genai
pnpm add @langchain/openrouter
```

- [ ] **Step 4: Preserve fixture-specific OpenAI docs**

For `docs/brand/*`, keep `ChatOpenAI` wording only where the recording fixture intentionally stubs OpenAI. If a sentence describes Dawn generally, update it.

- [ ] **Step 5: Run docs checks and web typecheck**

Run:

```bash
node scripts/check-docs.mjs
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web packages/*/README.md README.md CONTRIBUTORS.md docs/brand scripts/check-docs.mjs
git commit -m "docs: describe provider-aware agent materialization"
```

Adjust the `git add` paths to include only files actually modified.

## Task 7: Full Verification

**Files:**
- No new files. This validates the whole branch.

- [ ] **Step 1: Run focused package tests**

Run:

```bash
pnpm exec vitest --run --config packages/sdk/vitest.config.ts packages/sdk/test/agent.test.ts packages/sdk/test/known-model-ids.test.ts
pnpm exec vitest --run --config packages/langchain/vitest.config.ts packages/langchain/test/model-provider-resolver.test.ts packages/langchain/test/chat-model-factory.test.ts packages/langchain/test/agent-adapter.test.ts packages/langchain/test/agent-descriptor-integration.test.ts
pnpm exec vitest --run --config packages/cli/vitest.config.ts packages/cli/test/build-command.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package typechecks**

Run:

```bash
pnpm --filter @dawn-ai/sdk typecheck
pnpm --filter @dawn-ai/langchain typecheck
pnpm --filter @dawn-ai/cli typecheck
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS.

- [ ] **Step 3: Run repo lint and docs checks**

Run:

```bash
pnpm lint
node scripts/check-docs.mjs
```

Expected: PASS.

- [ ] **Step 4: Run full test suite if time allows**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git status --short
git diff --stat HEAD
git diff --check
```

Expected: only intentional changes, no whitespace errors.

- [ ] **Step 6: Commit final fixes if needed**

If Task 7 produced fixes, commit them:

```bash
git add <changed-files>
git commit -m "chore: verify provider materialization"
```
