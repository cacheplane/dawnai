# LangChain Starter Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the default `create-dawn-app` template with a working LangChain chain that uses `ChatOpenAI`, a prompt template, and a Dawn-discovered tool.

**Architecture:** The `app-basic` template's route entry changes from exporting a `workflow` function (LangGraph pattern) to exporting an LCEL chain as default (LangChain pattern). The chain adapter in `@dawn-ai/langchain` handles tool execution via Dawn's built-in tool loop. Dependencies swap `@dawn-ai/langgraph` for `@dawn-ai/langchain` + `@langchain/openai` + `@langchain/core`.

**Tech Stack:** TypeScript, LangChain (LCEL), `@langchain/openai`, `@dawn-ai/langchain` adapter, Dawn filesystem tool discovery

---

## File Structure

| Path | Action | Responsibility |
|------|--------|----------------|
| `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/state.ts` | Modify | Define `HelloInput` and `HelloOutput` types |
| `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts` | Modify | Export LCEL chain as default |
| `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/tools/greet.ts` | Modify | Return richer structured data |
| `packages/devkit/templates/app-basic/package.json.template` | Modify | Swap langgraph → langchain + openai deps |
| `packages/devkit/templates/app-basic/.dawn/dawn.generated.d.ts` | Modify | Regenerate for new tool shape |
| `packages/create-dawn-app/src/index.ts` | Modify | Add langchain specifiers, remove langgraph from template deps |
| `packages/create-dawn-app/test/create-app.test.ts` | Modify | Update assertions from langgraph to langchain |

---

### Task 1: Update the template tool to return richer data

**Files:**
- Modify: `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/tools/greet.ts`

- [ ] **Step 1: Replace the tool implementation**

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

- [ ] **Step 2: Commit**

```bash
git add packages/devkit/templates/app-basic/src/app/\(public\)/hello/\[tenant\]/tools/greet.ts
git commit -m "feat(template): return richer structured data from greet tool"
```

---

### Task 2: Update state types for chain input/output

**Files:**
- Modify: `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/state.ts`

- [ ] **Step 1: Replace the state file with chain input/output types**

```ts
export interface HelloInput {
  readonly tenant: string
  readonly message: string
}

export interface HelloOutput {
  readonly response: string
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/devkit/templates/app-basic/src/app/\(public\)/hello/\[tenant\]/state.ts
git commit -m "feat(template): define HelloInput and HelloOutput for chain route"
```

---

### Task 3: Rewrite the route entry to export an LCEL chain

**Files:**
- Modify: `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts`

- [ ] **Step 1: Replace the route entry with LCEL chain construction**

Dawn discovers routes by looking for **named exports**: `chain`, `graph`, or `workflow`. The template must use `export const chain = ...` (not a default export).

For chain routes, the runtime calls `entry.invoke(input)` directly without passing a tool context. The chain must be self-contained — import the greet tool directly and convert it to a LangChain tool at module level.

```ts
import { ChatPromptTemplate } from "@langchain/core/prompts"
import { ChatOpenAI } from "@langchain/openai"
import { convertToolToLangChain } from "@dawn-ai/langchain"

import greet from "./tools/greet.js"

const model = new ChatOpenAI({
  modelName: "gpt-4o-mini",
  temperature: 0,
})

const prompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    "You are a helpful assistant for the {tenant} organization. Use the available tools to look up tenant information before responding.",
  ],
  ["human", "{message}"],
])

const greetTool = convertToolToLangChain({
  name: "greet",
  description: "Look up information about a tenant",
  run: greet,
})

export const chain = prompt.pipe(model.bindTools([greetTool]))
```

- [ ] **Step 2: Commit**

```bash
git add packages/devkit/templates/app-basic/src/app/\(public\)/hello/\[tenant\]/index.ts
git commit -m "feat(template): export LCEL chain with tool use as named export"
```

---

### Task 4: Update the generated types file

**Files:**
- Modify: `packages/devkit/templates/app-basic/.dawn/dawn.generated.d.ts`

- [ ] **Step 1: Regenerate types to match new tool signature**

```ts
declare module "dawn:routes" {
  export type DawnRoutePath = "/hello/[tenant]";

  export interface DawnRouteParams {
  "/hello/[tenant]": { tenant: string };
  }

  export interface DawnRouteTools {
    "/hello/[tenant]": {
      readonly greet: (input: { readonly tenant: string; }) => Promise<{ name: string; greeting: string; plan: string; }>;
    };
  }

  export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/devkit/templates/app-basic/.dawn/dawn.generated.d.ts
git commit -m "feat(template): regenerate types for updated greet tool return shape"
```

---

### Task 5: Update package.json.template dependencies

**Files:**
- Modify: `packages/devkit/templates/app-basic/package.json.template`

- [ ] **Step 1: Replace the template with updated dependencies**

```json
{
  "name": "{{appName}}",
  "private": true,
  "type": "module",
  "scripts": {
    "check": "dawn check",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dawn-ai/core": "{{dawnCoreSpecifier}}",
    "@dawn-ai/cli": "{{dawnCliSpecifier}}",
    "@dawn-ai/langchain": "{{dawnLangchainSpecifier}}",
    "@dawn-ai/sdk": "{{dawnSdkSpecifier}}",
    "@langchain/core": "{{langchainCoreSpecifier}}",
    "@langchain/openai": "{{langchainOpenaiSpecifier}}"
  },
  "devDependencies": {
    "@dawn-ai/config-typescript": "{{dawnConfigTypescriptSpecifier}}",
    "@types/node": "25.6.0",
    "typescript": "6.0.2"
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/devkit/templates/app-basic/package.json.template
git commit -m "feat(template): swap langgraph dep for langchain + openai + core"
```

---

### Task 6: Update create-dawn-app replacement logic

**Files:**
- Modify: `packages/create-dawn-app/src/index.ts`

- [ ] **Step 1: Add langchainCoreSpecifier and langchainOpenaiSpecifier to the replacement type and both mode branches**

In `createTemplateReplacements`, update the return type to include the new specifiers and remove `dawnLanggraphSpecifier`:

```ts
function createTemplateReplacements(
  appRoot: string,
  options: CliOptions,
): {
  readonly appName: string
  readonly dawnCliSpecifier: string
  readonly dawnConfigTypescriptSpecifier: string
  readonly dawnCoreSpecifier: string
  readonly dawnLangchainSpecifier: string
  readonly dawnLanggraphSpecifier: string
  readonly dawnSdkSpecifier: string
  readonly langchainCoreSpecifier: string
  readonly langchainOpenaiSpecifier: string
} {
  if (options.mode === "internal") {
    return {
      appName: basename(appRoot),
      dawnCliSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/cli")),
      dawnConfigTypescriptSpecifier: createAbsoluteFileSpecifier(
        resolve(repoRoot, "packages/config-typescript"),
      ),
      dawnCoreSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/core")),
      dawnLangchainSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/langchain")),
      dawnLanggraphSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/langgraph")),
      dawnSdkSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/sdk")),
      langchainCoreSpecifier: "0.3.80",
      langchainOpenaiSpecifier: "0.6.17",
    }
  }

  return {
    appName: basename(appRoot),
    dawnCliSpecifier: options.distTag,
    dawnConfigTypescriptSpecifier: options.distTag,
    dawnCoreSpecifier: options.distTag,
    dawnLangchainSpecifier: options.distTag,
    dawnLanggraphSpecifier: options.distTag,
    dawnSdkSpecifier: options.distTag,
    langchainCoreSpecifier: "0.3.80",
    langchainOpenaiSpecifier: "0.6.17",
  }
}
```

Also update `applyInternalModePackageOverrides` to include overrides for `@dawn-ai/langchain` (already present via `dawnLangchainSpecifier`) but NOT for `@langchain/openai` or `@langchain/core` (third-party packages don't need file specifier overrides).

- [ ] **Step 2: Run the create-dawn-app tests to verify**

Run: `pnpm --filter create-dawn-app test`

Expected: Tests should fail because assertions still reference `@dawn-ai/langgraph`.

- [ ] **Step 3: Commit**

```bash
git add packages/create-dawn-app/src/index.ts
git commit -m "feat(create-dawn-app): add langchain version specifiers to replacement map"
```

---

### Task 7: Update create-dawn-app test assertions

**Files:**
- Modify: `packages/create-dawn-app/test/create-app.test.ts`

- [ ] **Step 1: Replace all `@dawn-ai/langgraph` assertions with `@dawn-ai/langchain`**

In the "scaffolds external mode" test, change:
```ts
expect(packageJson.dependencies["@dawn-ai/langgraph"]).not.toMatch(/^file:/)
expect(packageJson.dependencies["@dawn-ai/langgraph"]).toBe("next")
```
to:
```ts
expect(packageJson.dependencies["@dawn-ai/langchain"]).not.toMatch(/^file:/)
expect(packageJson.dependencies["@dawn-ai/langchain"]).toBe("next")
expect(packageJson.dependencies["@langchain/openai"]).toBe("0.6.17")
expect(packageJson.dependencies["@langchain/core"]).toBe("0.3.80")
```

In the "supports explicit internal dev scaffolding" test, change:
```ts
expect(packageJson.dependencies["@dawn-ai/langgraph"]).toMatch(/^file:/)
```
to:
```ts
expect(packageJson.dependencies["@dawn-ai/langchain"]).toMatch(/^file:/)
expect(packageJson.dependencies["@langchain/openai"]).toBe("0.6.17")
expect(packageJson.dependencies["@langchain/core"]).toBe("0.3.80")
```

In the "writes contributor-local package specifiers" test, change:
```ts
expect(resolveFileSpecifier(packageJson.dependencies["@dawn-ai/langgraph"])).toBe(
  resolve(repoRoot, "packages/langgraph"),
)
```
to:
```ts
expect(resolveFileSpecifier(packageJson.dependencies["@dawn-ai/langchain"])).toBe(
  resolve(repoRoot, "packages/langchain"),
)
expect(packageJson.dependencies["@langchain/openai"]).toBe("0.6.17")
expect(packageJson.dependencies["@langchain/core"]).toBe("0.3.80")
```

And update the overrides assertions similarly — change `@dawn-ai/langgraph` references to `@dawn-ai/langchain`:
```ts
expect(resolveFileSpecifier(packageJson.pnpm?.overrides?.["@dawn-ai/langgraph"] ?? "")).toBe(
  resolve(repoRoot, "packages/langgraph"),
)
```
to:
```ts
expect(resolveFileSpecifier(packageJson.pnpm?.overrides?.["@dawn-ai/langchain"] ?? "")).toBe(
  resolve(repoRoot, "packages/langchain"),
)
```

- [ ] **Step 2: Run the create-dawn-app tests**

Run: `pnpm --filter create-dawn-app test`

Expected: All 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/create-dawn-app/test/create-app.test.ts
git commit -m "test(create-dawn-app): update assertions from langgraph to langchain"
```

---

### Task 8: Verify full test suite passes

**Files:** None (verification only)

- [ ] **Step 1: Run the full monorepo test suite**

Run: `pnpm test`

Expected: All packages pass. The CLI tests use inline `workflow` fixtures (not the template) so should be unaffected.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: No type errors. The template files are not part of the monorepo typecheck (they lack a resolvable `node_modules`), but the `create-dawn-app` source and tests should pass.

- [ ] **Step 3: If failures occur, fix them and commit the fixes**

---

## Notes for Implementer

- **Named export `chain`**: Dawn discovers routes by looking for named exports (`chain`, `graph`, or `workflow`). Use `export const chain = ...`, NOT a default export.
- **Tools are self-contained in chain routes**: For `chain` kind, the runtime calls `entry.invoke(input)` without passing tools. The chain must import and bind its own tools at module level.
- **`dawnLanggraphSpecifier` kept in create-dawn-app**: The spec says to keep the replacement logic for future langgraph template use. Don't remove it from `createTemplateReplacements` — only remove the `@dawn-ai/langgraph` line from the `package.json.template`.
- **`@langchain/openai` version**: Use `0.6.17` (latest 0.x, requires `@langchain/core >=0.3.68 <0.4.0`). Use `@langchain/core@0.3.80` (latest 0.3.x). These are pinned in the template, not dist-tag-driven, since they're third-party.
- **No `AgentExecutor`**: The template exports `prompt.pipe(model.bindTools(tools))`. Dawn's chain adapter calls `invoke()` on this chain directly.
