# LangChain Provider Materialization Design

## Summary

Dawn's built-in `agent()` route should support LangChain chat model providers beyond OpenAI while keeping the authoring API simple. The default user experience remains `agent({ model, systemPrompt })`; Dawn infers the provider from known model naming patterns. Advanced users can set `provider` explicitly when inference is ambiguous, when using custom aliases, or when targeting OpenAI-compatible proxies.

Provider integrations are optional peer dependencies. Dawn should not bundle every LangChain provider package into `@dawn-ai/langchain`; it should lazy-import the provider package only when the selected provider is used and emit an actionable install message when the package is missing.

## Goals

- Keep the common `agent({ model })` path provider-aware without requiring boilerplate.
- Preserve today's OpenAI behavior for existing OpenAI model ids.
- Add explicit provider override for ambiguous model strings and custom aliases.
- Keep non-OpenAI provider packages optional so OpenAI-only apps do not pay install or version cost.
- Make failures deterministic and helpful: unknown model names should explain how to set `provider`, and missing provider packages should explain what to install.
- Keep raw `graph` and `chain` route behavior unchanged.

## Non-Goals

- Do not build a full model catalog or guarantee that every LangChain integration is supported in the first implementation.
- Do not validate model availability against remote provider APIs.
- Do not convert Dawn into a provider-agnostic LLM SDK; Dawn should only resolve the chat model needed to materialize `agent()` routes.
- Do not change tool discovery, state schema materialization, subagent dispatch, route ids, or build artifact shape except where tests need provider coverage.

## Public API

Extend `AgentConfig` with an optional provider override:

```ts
export type ModelProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "groq"
  | "ollama"
  | "xai"
  | "openrouter"
  | (string & {})

export interface AgentConfig {
  readonly description?: string
  readonly model: KnownModelId
  readonly provider?: ModelProviderId
  readonly reasoning?: ReasoningConfig
  readonly retry?: RetryConfig
  readonly subagents?: readonly DawnAgent[]
  readonly systemPrompt: string
}
```

The current descriptor runtime shape should also carry `provider?: ModelProviderId`, but `DawnAgent.model` can remain `string` after branding. This preserves the existing descriptor pattern while exposing the provider to materialization.

Common usage:

```ts
export default agent({
  model: "claude-sonnet-4-5",
  systemPrompt: "You are a helpful assistant.",
})
```

Override usage:

```ts
export default agent({
  provider: "anthropic",
  model: "internal-claude-alias",
  systemPrompt: "You are a helpful assistant.",
})
```

OpenAI-compatible proxy usage should use a provider id that makes the behavior explicit, such as `openrouter`, rather than silently treating all custom strings as OpenAI.

## Architecture

Add a provider resolver layer inside `@dawn-ai/langchain` and have `materializeAgent()` call that layer instead of constructing `ChatOpenAI` directly.

```ts
const llm = await resolveChatModel({
  model: descriptor.model,
  provider: descriptor.provider,
  reasoning: descriptor.reasoning,
})
```

The provider resolver has three responsibilities:

1. Select provider: use `descriptor.provider` when present, otherwise infer from `descriptor.model`.
2. Load provider: lazy-import the matching LangChain package.
3. Construct model: pass only options supported by that provider constructor.

Keep this code split by responsibility:

- `packages/sdk/src/model-provider.ts` - public provider id type.
- `packages/sdk/src/agent.ts` - `AgentConfig.provider` and descriptor carry-through.
- `packages/langchain/src/model-provider-resolver.ts` - provider inference, unknown-model errors, and missing-package errors.
- `packages/langchain/src/chat-model-factory.ts` - provider-specific lazy imports and constructor wiring.
- `packages/langchain/src/agent-adapter.ts` - replace direct `ChatOpenAI` construction with `resolveChatModel()`.

## Provider Inference

Inference should be conservative. It should map high-confidence model prefixes and exact families, and otherwise fail with a provider override instruction.

Initial inference rules:

- `gpt-*`, `o3*`, `o4*`, and known OpenAI ids -> `openai`
- `claude-*` -> `anthropic`
- `gemini-*` -> `google`
- `mistral-*`, `mixtral-*`, `codestral-*` -> `mistral`
- `llama*`, `qwen*`, `deepseek*`, and other local-style aliases should not automatically mean Ollama unless the model string is prefixed or the provider is explicit. Too many hosted providers serve these names.
- `grok-*` -> `xai`

If inference returns `undefined`, throw:

```text
Could not infer a LangChain provider for model "my-custom-model".
Set provider explicitly, for example agent({ provider: "anthropic", model: "my-custom-model", ... }).
```

Provider-prefixed model ids can be considered later, but they are not part of the initial design because the approved API prefers automatic inference plus explicit `provider`.

## Optional Peer Dependencies

`@dawn-ai/langchain` should keep `@langchain/openai` as a normal dependency for backwards compatibility and mark other provider packages as optional peers:

- `@langchain/anthropic`
- `@langchain/google`
- `@langchain/mistralai`
- `@langchain/groq`
- `@langchain/ollama`
- `@langchain/xai`
- `@langchain/openrouter`

When a lazy import fails because the peer is missing, convert it into an actionable Dawn error:

```text
Provider "anthropic" requires @langchain/anthropic.
Install it with: pnpm add @langchain/anthropic
```

Do not catch constructor errors that come from invalid API keys, invalid model ids, or provider runtime failures. Those should pass through with provider context preserved where useful.

## Provider Constructors

The first implementation should support a focused constructor map:

- `openai` -> `new ChatOpenAI({ model, reasoningEffort? })`
- `anthropic` -> `new ChatAnthropic({ model })`
- `google` -> `new ChatGoogle({ model })` or the current LangChain JS Gemini chat model class after verification during implementation
- `mistral` -> `new ChatMistralAI({ model })`
- `groq` -> `new ChatGroq({ model })`
- `ollama` -> `new ChatOllama({ model })`
- `xai` -> `new ChatXAI({ model })`
- `openrouter` -> `new ChatOpenRouter({ model })`

Reasoning options should only be passed to providers that support them. Initially, keep `reasoning.effort` OpenAI-only unless a provider-specific mapping is explicitly verified.

## Data Flow

1. User exports a Dawn descriptor with `agent({ model, provider?, systemPrompt, ... })`.
2. Dawn runtime or build identifies the route as `agent`.
3. `executeAgent()` or generated build entry calls `materializeAgent()` / `materializeAgentGraph()`.
4. `materializeAgent()` converts Dawn tools to LangChain tools.
5. `resolveChatModel()` chooses and constructs the provider chat model.
6. `createReactAgent()` receives the resolved chat model, tools, prompt, and optional state schema.
7. Streaming, retry, subagent, prompt-fragment, and state-update behavior continue through the existing `agent-adapter.ts` path.

## Error Handling

Unknown provider:

```text
Unsupported agent provider "foo".
Supported providers: openai, anthropic, google, mistral, groq, ollama, xai, openrouter.
```

Unknown model with no explicit provider:

```text
Could not infer a LangChain provider for model "foo".
Set provider explicitly on agent({ provider: "...", model: "foo", ... }).
```

Missing optional peer:

```text
Provider "google" requires @langchain/google.
Install it with: pnpm add @langchain/google
```

Provider-specific constructor or runtime errors should not be collapsed into generic Dawn errors.

## Testing Strategy

SDK tests:

- `agent()` preserves `provider` in the returned descriptor.
- `AgentConfig` accepts known provider ids and arbitrary provider strings.
- Existing descriptors without `provider` remain valid.

LangChain unit tests:

- `inferProvider()` recognizes OpenAI, Anthropic, Google, Mistral, Groq, and xAI model patterns.
- `inferProvider()` refuses ambiguous custom/local-style model names.
- Explicit `provider` bypasses inference.
- Missing optional peer import produces the expected install message.
- OpenAI materialization still passes `reasoningEffort` only for OpenAI.
- Non-OpenAI providers do not receive OpenAI-only `reasoningEffort`.

CLI/build tests:

- `dawn build` generated agent entries still call `materializeAgentGraph()`.
- A non-OpenAI descriptor with tools generates the same artifact shape as OpenAI descriptors.
- Runtime route execution reaches the materialization path with explicit provider metadata.

Docs checks:

- Update API reference, agents guide, FAQ, templates, README/package summaries, and generated `llms.txt` copy.
- Replace “OpenAI-backed today” language with provider-aware materialization language.
- Keep caveats that raw `graph` and `chain` routes can instantiate any LangChain-compatible provider directly.

## Migration

Existing OpenAI users should not need code changes.

Existing custom model strings that accidentally relied on `ChatOpenAI({ model: custom })` are the compatibility risk. To preserve that path, the implementation can either:

1. Keep arbitrary unknown strings on OpenAI for one release and warn in docs, or
2. Require `provider: "openai"` for unknown strings immediately.

The recommended behavior is option 2 because it avoids silently routing unknown provider names through OpenAI. If this is too breaking for pre-1.0 users, add a release-note caveat and a targeted compatibility test for explicit `provider: "openai"`.

## Open Questions

- Confirm exact current LangChain JS constructor option names for Google Gemini and OpenRouter before implementation.
- Decide whether OpenAI-compatible custom `baseURL` support belongs in the first implementation or should remain a future provider option.
- Decide whether provider-specific constructor options beyond `model` should be added now or deferred. The recommended first pass defers them.
