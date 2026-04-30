# LangChain Starter Template Design

## Goal

Replace the default `create-dawn-app` template with a working LangChain chain implementation that serves as a genuine starting point for developers building with Dawn and LangChain.

## Context

The current `app-basic` template exports a LangGraph `workflow` function with a greet tool. Dawn now has a mature `@dawn-ai/langchain` adapter supporting `chain` route kind with LCEL runnables, Dawn-owned tool conversion, and a ReAct tool execution loop. The template should showcase this path.

Future templates for LangGraph and Deep Agents will follow. When they arrive, this template becomes `app-langchain` and the default becomes configurable. For now, it remains `app-basic`.

## Route Structure

```
src/app/(public)/hello/[tenant]/
  index.ts           — exports LCEL chain (route entry, kind: chain)
  state.ts           — defines HelloInput and HelloOutput types
  tools/greet.ts     — tool that looks up tenant info
```

### `state.ts`

Defines structured input and output types for the chain:

```ts
export interface HelloInput {
  readonly tenant: string
  readonly message: string
}

export interface HelloOutput {
  readonly response: string
}
```

### `index.ts`

Builds and exports an LCEL chain as the default export:

1. Creates a `ChatOpenAI` instance (uses `OPENAI_API_KEY` from environment)
2. Builds a `ChatPromptTemplate` with a system message establishing the assistant's role for the given tenant, and a human message placeholder
3. Converts Dawn-discovered tools to LangChain tools via `convertTools()` from `@dawn-ai/langchain`
4. Binds tools to the model
5. Composes the chain: prompt → model-with-tools
6. Exports the chain as default

The chain adapter in `@dawn-ai/langchain` handles tool execution via Dawn's built-in tool loop — the template does not need to wire up `AgentExecutor` or manual tool calling.

### `tools/greet.ts`

A simple tool that returns tenant-specific information. Keeps the same default-export-function pattern Dawn uses for filesystem tool discovery:

```ts
/**
 * Look up information about a tenant.
 * @param tenant - The tenant identifier to look up
 */
export default async (input: { readonly tenant: string }) => {
  return {
    name: input.tenant,
    greeting: `Welcome, ${input.tenant}!`,
    plan: "starter",
  }
}
```

The tool has a real-ish shape (returns structured data beyond just a greeting) so developers can see where to plug in actual data sources.

## Package Dependencies

### Template `package.json.template` changes

**Remove:**
- `@dawn-ai/langgraph`

**Add:**
- `@dawn-ai/langchain`
- `@langchain/openai`
- `@langchain/core`

**Keep:**
- `@dawn-ai/core`
- `@dawn-ai/cli`
- `@dawn-ai/sdk`
- `@dawn-ai/config-typescript` (devDependency)

### Template replacement variables

Add `dawnLangchainSpecifier` (already exists in `create-dawn-app/src/index.ts`).
Remove `dawnLanggraphSpecifier` from the template (keep the replacement logic in create-dawn-app for future langgraph template use).

Add `langchainOpenaiSpecifier` and `langchainCoreSpecifier` for pinned LangChain versions in external mode.

## create-dawn-app Changes

- Update `package.json.template` with new dependency list
- Add LangChain version specifiers to the replacement map (pinned versions for external mode, `workspace:*` not applicable since these are third-party)
- Internal mode: `@dawn-ai/langchain` uses file specifier like other Dawn packages; `@langchain/openai` and `@langchain/core` use published versions

## Test Updates

Existing tests in `packages/create-dawn-app/test/create-app.test.ts` assert on specific dependency names. These need updating:

- Replace `@dawn-ai/langgraph` assertions with `@dawn-ai/langchain`
- Add assertions for `@langchain/openai` and `@langchain/core` in dependencies
- Update fixture expectations in `test/generated/fixtures/`

Existing tests in `packages/cli/test/` that use the generated app fixture (`test/generated/fixtures/handwritten-runtime-app/`) need updating to use chain route kind instead of workflow.

The `test/generated/fixtures/basic.expected.json` and `custom-app-dir.expected.json` route discovery fixtures should not need changes — they test route discovery, not route kind.

## Dawn Generated Types

The `.dawn/dawn.generated.d.ts` file in the template needs regeneration since the route structure changes (new tool parameter shape).

## What This Does NOT Change

- Route discovery mechanics (filesystem convention unchanged)
- CLI commands (`verify`, `check`, `routes`, `typegen`, `run`, `dev`, `test`)
- The `@dawn-ai/langchain` adapter itself (no changes needed)
- The `@dawn-ai/sdk` contract
- The `dawn.config.ts` format
