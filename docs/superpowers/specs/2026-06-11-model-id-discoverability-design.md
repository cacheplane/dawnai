# Unknown model-id discoverability (Design)

**Status:** Approved for planning
**Date:** 2026-06-11
**Roadmap:** Dogfooding-friction backlog item #5. `agent({ model: "gpt-5" })` — a plausible guess — passes typecheck (the `KnownModelId` union widens via `(string & {})`), passes prefix-based provider inference, and fails only at request time with a provider 404 surfacing from deep inside langchain. Dawn should say something useful, earlier, on both the static and runtime paths.

## Problem

1. **Typos pass silently until the first model call.** `KnownModelId` is autocomplete-only; nothing validates the value at `dawn check`/`verify` time or at chat-model construction.
2. **The curated id knowledge is types-only and incomplete.** `packages/sdk/src/known-model-ids.ts` lists OpenAI + Google ids as type unions — there are no runtime values to validate against, and no Anthropic ids at all despite `anthropic` being a supported provider. Any naive "unknown id" warning would false-positive every `claude-*` model.
3. **Provider inference lives in the wrong layer for reuse.** `inferProvider` (prefix-based) sits in `@dawn-ai/langchain` (`model-provider-resolver.ts`); the cli's `check` command has no clean path to it.

## Decisions (from brainstorming)

- **Both surfaces:** `dawn check`/`verify` warns statically; the runtime warns once at chat-model construction. One shared validator feeds both.
- **Per-provider curated lists, warn-only.** If the resolved provider has a curated list and the model isn't in it → warning with did-you-mean suggestions. Providers without curated lists → always silent. **Never a hard error** anywhere — `(string & {})` stays intentional so brand-new, proxy, and custom model ids keep working.
- **Expand the curated lists**, initially: openai (existing), google (existing), **anthropic (new)**, **xai (new, per user request)**. Mistral/groq/ollama/openrouter stay uncurated; a stale curated list is worse than none.
- **xAI churn note** (verified via web, 2026-06-11): `grok-4.3` is the current flagship; as of 2026-05-15 xAI deprecates-and-redirects older ids (`grok-4-fast-*`, `grok-3`, `grok-code-fast-1`, …) to it. The curated xAI list must be small and taken from [docs.x.ai/developers/models](https://docs.x.ai/developers/models) at implementation time; redirected-but-functional ids are fine to omit (warn-only means they still work, and the suggestion nudges users to the current id).

## Verified facts (against main @ `410a179`)

- `KnownModelId = OpenAiModelId | GoogleModelId | (string & {})`; types only, no value arrays. (`packages/sdk/src/known-model-ids.ts`)
- `agent()` descriptor's `model` field is `KnownModelId`; `provider?` is `ModelProviderId`. (`packages/sdk/src/agent.ts`)
- `inferProvider(model)` prefix-matches (`gpt-|o3|o4` → openai, `claude-` → anthropic, `gemini-` → google, mistral/mixtral/codestral → mistral, `grok-` → xai); `resolveProvider({ model, provider? })` validates explicit providers against `SUPPORTED_AGENT_PROVIDERS` and throws a clear error when inference fails. (`packages/langchain/src/model-provider-resolver.ts`)
- `dawn check` only runs route + tool discovery; it never loads agent descriptors, so it cannot see `model` values today. (`packages/cli/src/commands/check.ts`)
- `dawn verify` does NOT run check; it has its own pipeline (`findDawnApp` → `discoverRoutes` → typegen → deps), so the warning pass is a shared helper wired explicitly into both `dawn check` and `dawn verify`.
- The repo's warning-prefix convention is `[dawn:<area>]` (e.g. `[dawn:permissions]`, `[dawn:workspace]`).

## Design

### 1. Values become the source of truth; types derive (`@dawn-ai/sdk`)

Restructure `known-model-ids.ts`:

```ts
export const OPENAI_MODEL_IDS = [
  "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro", "gpt-5-mini",
  "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
  "gpt-4o", "gpt-4o-mini",
  "o3", "o3-mini", "o4-mini",
] as const

export const GOOGLE_MODEL_IDS = [
  "gemini-3-pro-preview", "gemini-3-flash-preview",
  "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite",
] as const

export const ANTHROPIC_MODEL_IDS = [
  "claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001",
] as const

export const XAI_MODEL_IDS = [
  "grok-4.3", // current flagship; finalize the list from docs.x.ai at implementation time
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
```

Existing type names keep their exact exported names (non-breaking); autocomplete gains Anthropic ids. The Anthropic/updated id values above are to be **verified against vendor docs during implementation** (web check), not trusted from this spec.

A curated-lists map keyed by provider id lives beside them:

```ts
export const CURATED_MODEL_IDS: Readonly<Partial<Record<BuiltInModelProviderId, readonly string[]>>> = {
  openai: OPENAI_MODEL_IDS,
  google: GOOGLE_MODEL_IDS,
  anthropic: ANTHROPIC_MODEL_IDS,
  xai: XAI_MODEL_IDS,
}
```

### 2. `inferProvider` moves to sdk; validator lives beside it

`inferProvider` is pure and dependency-free. Move it verbatim to `packages/sdk/src/model-provider.ts` (exported); `@dawn-ai/langchain`'s `model-provider-resolver.ts` imports it from sdk and re-exports it so its own consumers are unaffected. `resolveProvider` behavior unchanged.

New validator in sdk (`packages/sdk/src/validate-model-id.ts`):

```ts
export type ModelIdValidation =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly provider: string
      readonly suggestions: readonly string[]  // nearest curated ids, max 3
    }

export function validateModelId(opts: {
  readonly model: string
  readonly provider?: string
}): ModelIdValidation
```

Rules:
- Resolve provider: explicit `opts.provider` wins; else `inferProvider(opts.model)`.
- Unresolvable provider → `{ ok: true }` (the existing `resolveProvider` runtime error already handles that case with a good message; check stays quiet to avoid double-reporting).
- Provider not in `CURATED_MODEL_IDS` → `{ ok: true }` (uncurated = silent).
- Curated and the model is in the list → `{ ok: true }`.
- Curated and missing → `{ ok: false }` with up to 3 suggestions ranked by Levenshtein distance against that provider's list (small inline distance function; no dependency).

### 3. `dawn check` warning (cli)

`runCheckCommand` gains a descriptor pass: for each route whose `kind` is `agent`, load the route module (the same loader path the runtime uses for descriptors), read `model`/`provider` off the `DawnAgent` descriptor, run `validateModelId`, and print warnings after the route listing:

```
Dawn app is valid: 3 routes discovered.
- /draft/[campaign] (agent)

⚠ /draft/[campaign]: model "gpt-5" is not a known openai model id. Did you mean "gpt-5.4", "gpt-5.5"?
  Known-id lists are advisory — new or proxy model ids work if your provider accepts them.
```

Warnings go to stdout with the route pathname; **exit code stays 0**. Routes that fail to load for this pass are skipped silently (check's existing discovery errors already cover load failures). `dawn verify` surfaces the same warnings via the shared helper.

### 4. Runtime warning at chat-model construction (langchain)

In the chat-model factory, immediately before constructing the provider client: run `validateModelId({ model, provider })`; on `ok: false`, emit once per `(model, provider)` pair per process (module-level `Set` dedup — dev-server reloads and multi-route apps must not spam):

```
[dawn:models] model "gpt-5" is not a known openai model id. Did you mean "gpt-5.4", "gpt-5.5"? Proceeding anyway.
```

via `console.warn`. Execution proceeds unconditionally.

### 5. Testing

- **sdk:** `validateModelId` unit tests — curated miss → suggestions ordered by distance (e.g. `gpt-5` → `gpt-5.4` first), curated hit, uncurated provider silent, explicit provider override beats inference, unresolvable provider silent. `inferProvider` move: langchain's existing resolver tests pass unchanged.
- **cli:** check-command test — fixture app with an agent route using `model: "gpt-5"` → stdout contains the warning + suggestions, exit code 0; a valid-model fixture produces no warning.
- **langchain:** factory test — warn emitted once for a bad id, deduped on second construction, absent for curated hit and for uncurated provider; construction proceeds in all cases.

### 6. Docs

Small additions, same PR: the agents doc's model section (`apps/web/content/docs/agents.mdx` — exact location confirmed during planning) notes that `dawn check` warns on unrecognized ids for curated providers and that the lists are advisory. No new page.

## Out of scope

- Mapping provider 404s into did-you-mean runtime *errors* (deeper langchain error-path work; revisit only if warnings prove insufficient).
- Curating local/router providers (groq, ollama, openrouter); Mistral only if its ids can be confidently verified during implementation.
- A `dawn models` listing command (YAGNI until asked for).

## Changeset

One PR: `"@dawn-ai/sdk": minor`, `"@dawn-ai/langchain": minor`, `"@dawn-ai/cli": minor`.
