# LangChain 1.x + Zod 4 Upgrade Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Dawn from `@langchain/{core,langgraph,openai}@0.x` + `zod@3.24.4` to LangChain `1.x` + `zod@4`. Drop the transitive `zod-to-json-schema`. Remove the cast-through-unknown workaround in `tool-converter.ts`.

**Architecture:** Single PR off `main`. Disciplined commit boundaries: one logical change per commit. Discovery-driven within each task — bump deps, run typecheck, fix what TS flags. The four files in `packages/langchain/src/` are the primary work; `packages/cli` and `packages/vite-plugin` get minor audit fixes.

**Tech Stack:** TypeScript 6.0.2, pnpm 10.33.0, turbo, `@langchain/core@1.x`, `@langchain/langgraph@1.x`, `@langchain/openai@1.x`, `openai@6.x`, `zod@4.x`.

**Spec:** [docs/superpowers/specs/2026-05-15-langchain-1x-zod-4-upgrade-design.md](../specs/2026-05-15-langchain-1x-zod-4-upgrade-design.md)

**Working directory:** `/Users/blove/repos/dawn/.claude/worktrees/langchain-1x-upgrade` (branch `claude/langchain-1x-upgrade`).

---

## Task 1: Bump dependency versions

**Files:**
- Modify: `packages/langchain/package.json`
- Modify: `packages/vite-plugin/package.json`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Bump `packages/langchain/package.json`**

In `dependencies`, change:
```json
"@langchain/langgraph": "^0.2.71"  →  "@langchain/langgraph": "^1.3.0"
"@langchain/openai":   "^0.3.17"   →  "@langchain/openai":   "^1.4.5"
```

In `peerDependencies`, change:
```json
"@langchain/core": ">=0.3.0"  →  "@langchain/core": ">=1.1.0"
```

In `devDependencies`, change:
```json
"@langchain/core":     "0.3.80"   →  "@langchain/core":     "1.1.46"
"@langchain/langgraph":"0.2.71"   →  "@langchain/langgraph":"1.3.0"
"@langchain/openai":   "0.3.17"   →  "@langchain/openai":   "1.4.5"
"zod":                 "3.24.4"   →  "zod":                 "4.4.3"
```

- [ ] **Step 2: Bump `packages/vite-plugin/package.json`**

Change:
```json
"zod": "3.24.4"  →  "zod": "4.4.3"
```

- [ ] **Step 3: Bump `packages/cli/package.json`**

Change:
```json
"@langchain/core": "0.3.80"  →  "@langchain/core": "1.1.46"
```

- [ ] **Step 4: Install and update lockfile**

Run: `pnpm install`
Expected: install succeeds. May see deprecation warnings; capture them but proceed.

- [ ] **Step 5: Verify `zod-to-json-schema` is gone from the resolution**

Run: `pnpm why zod-to-json-schema 2>&1 | head -20`
Expected: either "no dependents" or it only appears in transitive `@langchain` packages that still ship it but don't require it for Dawn. If it's still listed as a direct dependency of any `@dawn-ai/*` package, that's a bug — flag it.

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/package.json packages/vite-plugin/package.json packages/cli/package.json pnpm-lock.yaml
git commit -m "chore(deps): bump @langchain/* to 1.x and zod to 4.x"
```

---

## Task 2: Audit and fix `packages/langchain/src/tool-converter.ts`

**Files:**
- Modify: `packages/langchain/src/tool-converter.ts`

- [ ] **Step 1: Run typecheck to surface failures**

Run: `pnpm --filter @dawn-ai/langchain typecheck 2>&1 | tee /tmp/tool-converter-errors.log | head -60`
Capture errors that mention `tool-converter.ts`. Other-file errors are addressed in later tasks; ignore them here.

- [ ] **Step 2: Remove the cast and the workaround comment**

In `packages/langchain/src/tool-converter.ts` at the `new DynamicStructuredTool({...})` call (currently around lines 22–34):

Replace:
```ts
  // Cast through unknown to bridge the dual-Zod version type incompatibility
  // (package uses zod@3.24.4; @langchain/core uses zod@3.25.x — structurally identical at runtime)
  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description ?? "",
    schema: schema as unknown as z.ZodObject<z.ZodRawShape>,
    func: async (input, _runManager, config) => {
      const signal = config?.signal ?? new AbortController().signal
      const result = await tool.run(input, {
        ...(middlewareContext ? { middleware: middlewareContext } : {}),
        signal,
      })
      return JSON.stringify(result)
    },
  }) as unknown as DynamicStructuredTool
```

With:
```ts
  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description ?? "",
    schema,
    func: async (input, _runManager, config) => {
      const signal = config?.signal ?? new AbortController().signal
      const result = await tool.run(input, {
        ...(middlewareContext ? { middleware: middlewareContext } : {}),
        signal,
      })
      return JSON.stringify(result)
    },
  })
```

- [ ] **Step 3: Handle the helper return type**

The `toZodSchema` helper ends with:
```ts
return z.record(z.string(), z.unknown()) as unknown as z.ZodObject<z.ZodRawShape>
```

With zod 4, `z.record(z.string(), z.unknown())` is no longer assignable to `z.ZodObject<z.ZodRawShape>` — it never was, the cast hid it. Two options:

- **Option A (preferred):** Keep `z.record` as the fallback shape, but change `toZodSchema`'s return type to `z.ZodTypeAny` and propagate that through `convertToolToLangChain`. `DynamicStructuredTool` in 1.x accepts any Standard Schema.
- **Option B:** Replace `z.record(...)` with `z.object({})` as the empty fallback. Loses the "any extra fields allowed" semantics but matches the declared return type.

Choose Option A. Update:
```ts
function toZodSchema(value: unknown): z.ZodTypeAny {
  if (isZodObject(value)) return value
  if (isJsonSchemaObject(value)) return jsonSchemaToZod(value)
  return z.record(z.string(), z.unknown())
}
```

And update `isZodObject`'s return type narrowing to `z.ZodObject<z.ZodRawShape>` if needed — likely no change required since the predicate still returns the same shape.

- [ ] **Step 4: Audit zod 4 API surface used in this file**

The helpers use: `z.object`, `z.string`, `z.number`, `z.boolean`, `z.array`, `z.unknown`, `z.record`, `.optional()`. These are stable in zod 4. **One specific check:** confirm `z.record(z.string(), z.unknown())` (two-arg form) is what's already in the code (it is, per the current source). Single-arg `z.record(z.unknown())` would be a zod 4 break, but the file already uses the two-arg form.

- [ ] **Step 5: Typecheck again**

Run: `pnpm --filter @dawn-ai/langchain typecheck 2>&1 | grep -i "tool-converter" | head`
Expected: no errors in `tool-converter.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/src/tool-converter.ts
git commit -m "refactor(langchain): drop dual-zod cast in tool-converter

LangChain 1.x accepts Standard Schema directly; with Dawn now on a
single zod 4 there is no version split to bridge. Removes the cast
and updates the fallback helper's return type to ZodTypeAny."
```

---

## Task 3: Audit and fix `packages/langchain/src/state-adapter.ts`

**Files:**
- Modify: `packages/langchain/src/state-adapter.ts` (only if typecheck flags it)

- [ ] **Step 1: Typecheck**

Run: `pnpm --filter @dawn-ai/langchain typecheck 2>&1 | grep -i "state-adapter" | head`

- [ ] **Step 2: If no errors, skip to Task 4. If errors exist, fix them.**

The most likely issue: the `biome-ignore lint/suspicious/noExplicitAny` comment at the bottom of `materializeStateSchema` returns `Annotation.Root(spec as any)`. LangGraph 1.x retains `Annotation.Root` with the same shape, so this should continue to work. If TS flags a new issue with how `spec` is typed, narrow the type explicitly rather than expanding the `as any`.

If TS flags it: replace the cast with a properly typed `spec` (record of `Annotation` instances), keeping the same runtime behavior.

- [ ] **Step 3: Commit (only if changes were made)**

```bash
git add packages/langchain/src/state-adapter.ts
git commit -m "refactor(langchain): state-adapter for langgraph 1.x"
```

If no changes were needed, skip the commit and proceed to Task 4.

---

## Task 4: Audit and fix `packages/langchain/src/agent-adapter.ts`

This is the riskiest file. It calls `createReactAgent`, `ChatOpenAI`, and `streamEvents({version: "v2"})`. Each is a candidate for an API change in 1.x.

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts`

- [ ] **Step 1: Typecheck**

Run: `pnpm --filter @dawn-ai/langchain typecheck 2>&1 | grep -i "agent-adapter" | head -40`

- [ ] **Step 2: Audit `ChatOpenAI` constructor**

The current code:
```ts
const llm = new ChatOpenAI({
  model: descriptor.model,
})
```

In `@langchain/openai@1.x`, the `model` field is unchanged. Confirm no error here. If TS flags it (e.g., `apiKey` now required), pass `apiKey: process.env.OPENAI_API_KEY` defensively.

- [ ] **Step 3: Audit `createReactAgent`**

The current code:
```ts
const compiled = createReactAgent(agentOptions as any)
```

with options `{ llm, tools, prompt, stateSchema? }`.

In `@langchain/langgraph@1.x`, `createReactAgent` is in `@langchain/langgraph/prebuilt` and accepts a similar options shape. The argument names should be unchanged (`llm`, `tools`, `prompt`, `stateSchema`). If TS flags issues, consult the type signature via:
```bash
node -e "import('@langchain/langgraph/prebuilt').then(m => console.log(Object.keys(m)))"
```
and adjust option names accordingly.

- [ ] **Step 4: Audit `streamEvents({version: "v2"})`**

The current code uses `streamEvents` with `version: "v2"`. LangChain 1.x may have introduced `version: "v3"` or removed `"v2"`. The event names consumed (`on_chat_model_stream`, `on_tool_start`, `on_tool_end`, `on_chain_end`) and their data shapes need to be confirmed in 1.x.

**Verification approach:**
1. Check the `streamEvents` type signature in `@langchain/core` — find what `version` values it accepts now.
2. If `"v2"` is still accepted, no change needed.
3. If only `"v3"` is accepted, change to `version: "v3"` and verify the event names and data shapes are the same (they were stable from v2 → v3 per the LangChain JS changelog; the v3 changes were largely additive).

If event names or shapes change, update the `switch (event.event)` cases accordingly.

- [ ] **Step 5: Run typecheck after edits**

Run: `pnpm --filter @dawn-ai/langchain typecheck 2>&1 | grep -i "agent-adapter" | head`
Expected: no errors in `agent-adapter.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/src/agent-adapter.ts
git commit -m "refactor(langchain): agent-adapter for @langchain/openai 1.x and langgraph 1.x"
```

---

## Task 5: Audit and fix `packages/langchain/src/tool-loop.ts`

**Files:**
- Modify: `packages/langchain/src/tool-loop.ts` (only if typecheck flags it)

- [ ] **Step 1: Typecheck**

Run: `pnpm --filter @dawn-ai/langchain typecheck 2>&1 | grep -i "tool-loop" | head`

- [ ] **Step 2: If no errors, skip to Task 6. If errors exist, fix them.**

The file imports `AIMessage` and `ToolMessage` from `@langchain/core/messages`. The shapes (`.tool_calls` on `AIMessage`, `ToolMessage({ content, tool_call_id })` constructor) are stable across the 0.3 → 1.x boundary per the LangChain changelog.

If TS flags `tool_calls` shape changes (e.g., a renamed property or stricter typing on `call.args`), update the predicate `isAIMessageWithToolCalls` and the `result.tool_calls.map(...)` body accordingly. Keep semantics identical.

- [ ] **Step 3: Commit (only if changes were made)**

```bash
git add packages/langchain/src/tool-loop.ts
git commit -m "refactor(langchain): tool-loop for @langchain/core 1.x messages"
```

---

## Task 6: Audit and fix `packages/langchain/src/chain-adapter.ts`

This file was not inspected during planning. It exists in the package and may also need updates.

**Files:**
- Modify: `packages/langchain/src/chain-adapter.ts` (only if typecheck flags it)

- [ ] **Step 1: Typecheck**

Run: `pnpm --filter @dawn-ai/langchain typecheck 2>&1 | grep -i "chain-adapter" | head`

- [ ] **Step 2: If no errors, skip to Task 7. If errors exist, fix them.**

Use the same approach as Task 5: identify the failing API call, look up its 1.x replacement, make the minimal change.

- [ ] **Step 3: Commit (only if changes were made)**

```bash
git add packages/langchain/src/chain-adapter.ts
git commit -m "refactor(langchain): chain-adapter for langchain 1.x"
```

---

## Task 7: Audit `packages/cli/src/commands/build.ts`

**Files:**
- Modify: `packages/cli/src/commands/build.ts` (only if typecheck flags it)

- [ ] **Step 1: Typecheck the cli package**

Run: `pnpm --filter @dawn-ai/cli typecheck 2>&1 | head -40`

- [ ] **Step 2: If no errors in build.ts, skip to Task 8. If errors exist, fix them.**

The file imports from `@langchain/core`. Most likely candidates for breakage are type imports that moved subpaths in 1.x. Look at the failing import; if the type now lives in a different subpath (e.g., `@langchain/core/runnables` vs `@langchain/core/messages`), update the import.

- [ ] **Step 3: Commit (only if changes were made)**

```bash
git add packages/cli/src/commands/build.ts
git commit -m "refactor(cli): build.ts imports for @langchain/core 1.x"
```

---

## Task 8: Audit `packages/vite-plugin/src/index.ts`

**Files:**
- Modify: `packages/vite-plugin/src/index.ts` (only if typecheck flags it)

- [ ] **Step 1: Typecheck**

Run: `pnpm --filter @dawn-ai/vite-plugin typecheck 2>&1 | head -40`

- [ ] **Step 2: If no errors, skip to Task 9. If errors exist, fix them.**

Zod 4 breaking patterns to look for:
- `z.string().nonempty()` → `z.string().min(1)`
- `z.record(valueType)` → `z.record(z.string(), valueType)`
- `z.setErrorMap` → `z.config({ customError })`

If the file uses any of these, replace them. Otherwise the file should compile unchanged.

- [ ] **Step 3: Commit (only if changes were made)**

```bash
git add packages/vite-plugin/src/index.ts
git commit -m "refactor(vite-plugin): zod 4 API adjustments"
```

---

## Task 9: Full workspace verification

**Files:** none (verification only)

- [ ] **Step 1: Clean rebuild**

Run from repo root:
```bash
pnpm install
pnpm build
```
Expected: all packages build successfully.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: passes across all workspace packages.

- [ ] **Step 3: Tests**

Run: `pnpm test`
Expected: passes. If a test snapshots zod error messages and breaks, update the snapshot — zod 4 changed error phrasing.

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: passes. Common breakages: unused imports left over from removed code.

- [ ] **Step 5: Pack check**

Run: `pnpm pack:check`
Expected: passes. Confirms the packed package shapes haven't shifted.

- [ ] **Step 6: Verify `zod-to-json-schema` removal**

Run: `pnpm why zod-to-json-schema 2>&1`
Expected: no direct Dawn dependency. (Transitive presence inside other `@langchain` packages is acceptable; what matters is that Dawn doesn't pull it in directly.)

- [ ] **Step 7: Verify the cast is gone**

Run: `grep -n "as unknown as z.ZodObject" packages/langchain/src/tool-converter.ts`
Expected: no matches.

If any verification fails, fix and commit. Do not proceed to Task 10 with failing checks.

---

## Task 10: Push branch and open PR

- [ ] **Step 1: Push**

```bash
git push -u origin claude/langchain-1x-upgrade
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat: upgrade @langchain/* to 1.x and zod to 4.x" --body "$(cat <<'EOF'
## Summary
- Bumps \`@langchain/core\` (0.3.80 → 1.1.46), \`@langchain/langgraph\` (0.2.71 → 1.3.0), \`@langchain/openai\` (0.3.17 → 1.4.5)
- Bumps \`zod\` (3.24.4 → 4.4.3) in \`packages/langchain\` and \`packages/vite-plugin\`
- Drops the cast-through-unknown workaround in \`packages/langchain/src/tool-converter.ts\` — single zod version means no version split to bridge
- Transitive \`openai\` v4 → v6 via @langchain/openai

## Why
Dawn pinned \`zod@3.24.4\` below \`@langchain/core@0.3.80\`'s declared floor of \`^3.25.32\`. That mismatch caused pnpm to hoist a second zod for LangChain, and \`tool-converter.ts:25\` worked around the resulting type incompatibility with \`as unknown as z.ZodObject<z.ZodRawShape>\`. It also surfaced as \`Package subpath './v3' is not defined by "exports" in zod@3.24.4\` whenever the LangChain bridge generated tool schemas. Aligning on a single zod 4 fixes both.

## Spec
- Spec: \`docs/superpowers/specs/2026-05-15-langchain-1x-zod-4-upgrade-design.md\`

## Test plan
- [x] \`pnpm install\` succeeds without zod or @langchain peer-dep warnings
- [x] \`pnpm typecheck\` passes
- [x] \`pnpm test\` passes
- [x] \`pnpm build\` passes
- [x] \`pnpm lint\` passes
- [x] \`pnpm pack:check\` passes
- [x] \`pnpm why zod-to-json-schema\` shows no direct Dawn dependency
- [x] The cast-through-unknown in tool-converter.ts is gone

## Follow-up
After this merges: rebase PR #140 (\`examples/chat\`) on the new main and drop its README "Known issues" section about the zod mismatch.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Print the PR URL**

The `gh pr create` command prints the URL; capture it for the final summary.
