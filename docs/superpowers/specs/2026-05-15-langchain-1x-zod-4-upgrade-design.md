# LangChain 1.x + Zod 4 Upgrade — Design

**Date:** 2026-05-15
**Status:** Draft — pending user approval
**Owner:** Brian Love

## Summary

Migrate Dawn from `@langchain/{core,langgraph,openai}@0.x` + `zod@3.24.4` to LangChain `1.x` + `zod@4`. Drop the transitive `zod-to-json-schema` dependency (LangGraph 1.x speaks Standard Schema directly) and remove the cast-through-unknown workaround in `packages/langchain/src/tool-converter.ts` that exists solely to bridge a dual-zod version split. Audit `@langchain/openai` usage for v0.3 → v1 breaking changes. One PR off `main`, atomic merge.

## Motivation

Dawn pins `zod@3.24.4` in `packages/langchain` and `packages/vite-plugin`. This is *below* `@langchain/core@0.3.80`'s declared floor of `^3.25.32`. Pnpm therefore hoists a second zod for LangChain, and `packages/langchain/src/tool-converter.ts:25` paper-overs the resulting type incompatibility with `as unknown as z.ZodObject<z.ZodRawShape>`.

The mismatch surfaces visibly when Dawn's LangChain bridge generates tool schemas at agent invocation:
```
Package subpath './v3' is not defined by "exports" in zod@3.24.4
…/zod-to-json-schema/dist/esm/parsers/array.js
```
This is what blocks the canonical chat example (PR #140) from running an end-to-end agent loop without a workaround.

Beyond fixing the bug, the upgrade unlocks LangChain's modern surface area — Standard Schema, the 1.x streaming model, Code Interpreter and Programmatic Tool Calling support — which Dawn's eventual phase-3 opinionated harness work will need.

## Non-goals

- New features. Upgrade and simplify only.
- LLM-touching smoke tests in CI (existing `pnpm test` and typecheck are sufficient for this PR).
- Adopting the OpenAI Responses API. `ChatOpenAI` continues to use Chat Completions.
- Touching `examples/chat`. PR #140 is held; it gets a follow-up commit after this PR merges to drop its "Known issues" section.
- Expanding `KnownModelId` or other SDK-level type changes.
- Adopting new LangGraph 1.x features beyond what the upgrade itself requires (`Send` improvements, ContextHub, etc.).

## Target versions

| Package | Current | Target |
|---|---|---|
| `@langchain/core` | `0.3.80` | `^1.1.46` |
| `@langchain/langgraph` | `0.2.71` | `^1.3.0` |
| `@langchain/openai` | `0.3.17` | `^1.4.5` |
| `openai` (transitive) | `^4.77.0` | `^6.34.0` |
| `zod` | `3.24.4` | `^4.4.3` |
| `zod-to-json-schema` | (transitive) | **removed** |

## Affected Dawn packages

| Package | Scope of change |
|---|---|
| `packages/langchain` | All four source files (`agent-adapter.ts`, `state-adapter.ts`, `tool-converter.ts`, `tool-loop.ts`). Cast removed. `zod-to-json-schema` dropped. `@langchain/openai` usage audited. |
| `packages/cli` | `commands/build.ts` audit for `@langchain/core` imports that may have moved. |
| `packages/vite-plugin` | Zod pin bump. `src/index.ts` updated for any zod 4 API changes. |
| `packages/sdk` | No direct dep on zod or `@langchain/*` — re-verified after upgrade; expected no source changes. |
| `apps/web` | No direct dep. No changes. |
| `examples/chat/*` | Not touched in this PR. Handled in the #140 follow-up after merge. |

## Code-level changes (per file)

### `packages/langchain/src/tool-converter.ts`

- Remove `as unknown as z.ZodObject<z.ZodRawShape>` cast at line 25.
- Remove the surrounding comment about dual-zod-version incompatibility.
- Pass Dawn's zod 4 `ZodObject` directly to `DynamicStructuredTool`. LangChain 1.x's tool schema field accepts Standard Schema, so zod 4 objects qualify natively.
- Remove any `zod-to-json-schema` import.

### `packages/langchain/src/state-adapter.ts`

- Continues to build a LangGraph `Annotation.Root` from the route's Zod state schema, merged with `MessagesAnnotation`. The `Annotation` / `MessagesAnnotation` API surface is unchanged between LangGraph 0.2 and 1.x (verified against the 1.x changelog).
- Zod 4 inference is stricter; expect 1–3 line tweaks at field-introspection sites. The auto-reducer heuristic (append for array, replace for scalar — see `packages/core/src/state/resolve-state-fields.ts`) keeps working as long as field metadata reads correctly from zod 4.

### `packages/langchain/src/agent-adapter.ts`

- Wires `agent({ model, systemPrompt })` to a compiled LangGraph graph.
- `ChatOpenAI` instantiation: confirm parameter names match `@langchain/openai@1`. `modelName` was deprecated in 0.3 in favor of `model`; `temperature`, `maxTokens`, `apiKey` shapes unchanged.
- `bindTools()` is stable. Returns the bound model.
- No expected API rename, but the audit step verifies.

### `packages/langchain/src/tool-loop.ts`

- ReAct-style loop reading `lastMessage.tool_calls`. The `AIMessage` shape and `tool_calls` array shape are stable across the 0.3 → 1.x boundary.
- Expected to be a no-op or trivial type-tweak after deps bump.

### `packages/cli/src/commands/build.ts`

- Has one `@langchain/core` import (per the file map). Audit to confirm it still resolves; most type imports in `@langchain/core` are stable, but value imports occasionally moved between subpaths in 1.x.

### `packages/vite-plugin/src/index.ts`

- Uses zod for config validation. Zod 4 retains `.object()`, `.string()`, `.parse()`, `.safeParse()` shapes. Audit for any of the breaking-change patterns listed below.

## Expected zod 4 breaking changes to handle

If present in Dawn code (will be discovered via typecheck after the bump):

1. `z.string().nonempty()` removed → replace with `z.string().min(1)`.
2. `z.record(valueType)` → `z.record(keyType, valueType)` (two-arg form required).
3. `z.setErrorMap` → `z.config({ customError })`.
4. `.transform()` inference subtleties — fix with explicit type parameters if needed.
5. `.preprocess` signature unchanged; inference slightly different — fix with explicit input/output types if needed.
6. Error message phrasing changed — may break tests that snapshot zod error messages.

## LangChain 1.x changes to handle

1. Tool schema field accepts Standard Schema — zod 4 objects pass directly (this is the cleanup payoff).
2. `Annotation.Root` / `MessagesAnnotation` unchanged.
3. `tool_calls` shape on `AIMessage` stable.
4. `createReactAgent` from `@langchain/langgraph/prebuilt` widened to accept Standard Schema — only relevant if Dawn uses it (Dawn does not appear to; it has its own `tool-loop.ts`).

## OpenAI SDK v4 → v6 (transitive)

1. `new OpenAI({ apiKey })` shape unchanged.
2. Chat Completions remains the default API used by `ChatOpenAI`; Responses API is opt-in via a separate class. No forced migration.
3. Streaming event shapes for chat completions stable; LangChain wraps them.
4. Embeddings API shape unchanged (not used in Dawn).

## Execution strategy

A single PR off `main` with disciplined commit boundaries (one logical change per commit) so review chunks naturally and `git bisect` stays useful. Order:

1. Bump dep versions in `packages/langchain/package.json` and `packages/vite-plugin/package.json` (and any others surfaced by audit). Single commit.
2. `pnpm install` + lockfile commit.
3. Fix `packages/langchain/src/tool-converter.ts` — remove cast, drop `zod-to-json-schema` if imported.
4. Fix `packages/langchain/src/state-adapter.ts` — zod 4 API tweaks.
5. Fix `packages/langchain/src/agent-adapter.ts` — `@langchain/openai` v1 audit + any rename.
6. Fix `packages/langchain/src/tool-loop.ts` — likely no-op; commit only if changes required.
7. Fix `packages/cli/src/commands/build.ts` — only if audit surfaces issues.
8. Fix `packages/vite-plugin/src/index.ts` — only if zod 4 API changes affect it.
9. Drop `zod-to-json-schema` from any explicit dependency lists (and remove unused imports). Update lockfile.
10. Final `pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm pack:check` from the repo root — verify all green.

Run `pnpm typecheck` after each code commit to localize regressions. Type errors are the upgrade's primary signal; treat them as a checklist.

## Success criteria

- `pnpm install` succeeds with no `zod` or `@langchain/*` peer-dep warnings.
- `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm lint` all pass.
- `pnpm pack:check` passes.
- `pnpm why zod-to-json-schema` returns no results (transitive removal verified).
- `packages/langchain/src/tool-converter.ts` no longer contains the cast or the dual-zod-version comment.
- Diff is bounded to `packages/{langchain,cli,vite-plugin}` plus lockfile and the workspace-level `package.json` if a dependency override was needed (not expected).
- No new features. No unrelated refactors. No new tests in this PR.

## Follow-up after this PR merges

1. Rebase the chat-example branch (`claude/keen-nightingale-44b28b`, PR #140) on the new `main`.
2. Commit on #140 removes the "Known issues — `zod-to-json-schema` peer-dep mismatch" section from `examples/chat/README.md`.
3. Locally run `examples/chat` end-to-end with an `OPENAI_API_KEY`. Confirm a tool-call round-trip completes.
4. Re-request review on #140.

## Open questions

- **`packages/cli/src/commands/build.ts`'s exact `@langchain/core` usage** — to be confirmed during execution. If it imports value-level APIs that moved subpaths, audit may surface a sub-task; if it's type-only imports, this is a no-op.
- **Whether `packages/sdk` has any indirect dependence on a specific zod version** — believed to be `(string & {})` fallbacks only, but worth re-confirming during typecheck.
- **Lockfile churn** — major-version dep bumps cascade through the lockfile. Expect a sizeable lockfile diff. Not a problem; just noting it for the reviewer.
