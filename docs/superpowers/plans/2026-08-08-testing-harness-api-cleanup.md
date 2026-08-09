# Testing Harness API Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the unsupported `mode` option from `createAgentHarness()` so the public TypeScript API exposes only the in-process behavior it implements.

**Architecture:** Keep `createAgentHarness()`, `createAgentProtocolInjector()`, and `createSubprocessApp()` as three explicit factories with distinct options and lifecycles. Enforce the cleanup at compile time through the package's existing contract-test lane, update the authoritative website documentation, and regenerate the gitignored CLI documentation only for verification.

**Tech Stack:** TypeScript, pnpm, Vitest, TypeScript contract tests, Changesets, generated Markdown docs

---

## File Structure

- `packages/testing/src/harness.ts` owns `AgentHarnessOptions` and the in-process harness implementation.
- `packages/testing/test/harness-options.contract.ts` proves the public export rejects the removed option.
- `packages/testing/README.md` documents the package-level API groups.
- `apps/web/content/docs/testing-agents.mdx` is the authoritative user guide.
- `packages/cli/docs/testing-agents.md` is gitignored generated output used only during verification.
- `.changeset/testing-harness-mode-cleanup.md` records the user-facing patch release.

### Task 1: Remove the unsupported harness option

**Files:**
- Create: `packages/testing/test/harness-options.contract.ts`
- Modify: `packages/testing/src/harness.ts`

- [ ] **Step 1: Write the failing public contract test**

Create `packages/testing/test/harness-options.contract.ts`:

```ts
import type { AgentHarnessOptions } from "../src/index.js"

const validOptions: AgentHarnessOptions = {
  appRoot: "/tmp/dawn-app",
  route: "/chat#agent",
}

const removedMode: AgentHarnessOptions = {
  appRoot: "/tmp/dawn-app",
  route: "/chat#agent",
  // @ts-expect-error createAgentHarness has no transport or process mode.
  mode: "http-inject",
}

void validOptions
void removedMode
```

The existing `packages/testing/tsconfig.contracts.json` already includes
`test/*.contract.ts`; do not modify its include list.

- [ ] **Step 2: Run the contract lane and confirm it fails for the intended reason**

Run:

```bash
pnpm --filter @dawn-ai/testing typecheck
```

Expected: FAIL with TypeScript `TS2578` on the unused `@ts-expect-error`, proving
the current public type still accepts `mode`.

- [ ] **Step 3: Remove the unsupported option and runtime branch**

In `packages/testing/src/harness.ts`, remove this field from
`AgentHarnessOptions`:

```ts
readonly mode?: "in-process" | "http-inject" | "subprocess"
```

Remove this block from the start of `createAgentHarness()`:

```ts
const mode = options.mode ?? "in-process"
if (mode !== "in-process") {
  throw new Error(`createAgentHarness: mode "${mode}" not yet implemented`)
}
```

Do not add unknown-property runtime parsing, an overload, a deprecated alias,
or wiring to the two standalone factories.

- [ ] **Step 4: Run focused verification**

Run:

```bash
pnpm --filter @dawn-ai/testing typecheck
pnpm --filter @dawn-ai/testing test -- harness-construct
```

Expected: both commands PASS. The type lane consumes the `@ts-expect-error`, and
the existing harness construction test confirms the supported path still works.

- [ ] **Step 5: Commit**

```bash
git add packages/testing/src/harness.ts packages/testing/test/harness-options.contract.ts
git commit -m "fix(testing): remove unsupported harness modes"
```

### Task 2: Document the three explicit factories

**Files:**
- Modify: `packages/testing/README.md`
- Modify: `apps/web/content/docs/testing-agents.mdx`
- Create: `.changeset/testing-harness-mode-cleanup.md`
- Generate only: `packages/cli/docs/testing-agents.md`

- [ ] **Step 1: Confirm the stale claims exist**

Run:

```bash
rg -n 'three execution modes|mode.*http-inject|mode.*subprocess|default.*in-process|not yet implemented' \
  packages/testing/README.md apps/web/content/docs/testing-agents.mdx
```

Expected: matches in both documents describing the unsupported `mode` values.

- [ ] **Step 2: Rewrite the website guide around execution boundaries**

Replace the `## The three execution modes` section in
`apps/web/content/docs/testing-agents.mdx` with:

```md
## Choose the execution boundary

`@dawn-ai/testing` exposes a separate factory for each execution boundary:

- **`createAgentHarness()`** runs tools, prompts, capabilities, and state directly through Dawn's runtime in the test process. It is the default choice for fast agent-behavior tests and does not bind an application port.
- **`createAgentProtocolInjector()`** drives Agent Protocol requests through the runtime's fetch handler without binding a port. Use it when the HTTP request, response, or SSE contract is the behavior under test.
- **`createSubprocessApp()`** starts a real `dawn dev` child process. Use it for process-boundary, restart, and persistence tests.

These factories deliberately have separate option and result types. Choose the factory for the boundary the test needs; `createAgentHarness()` does not accept a `mode` option.
```

- [ ] **Step 3: Correct the package README**

Replace the paragraph below `### Harnesses and protocol helpers` in
`packages/testing/README.md` with:

```md
`createAgentHarness()` is the deterministic in-process agent harness.
`createAgentProtocolInjector()` drives the Agent Protocol fetch boundary without
opening a port, and `createSubprocessApp()` starts a real `dawn dev` process.
Each factory has its own options, result, and lifecycle contract; select the
factory for the boundary the test needs.
```

- [ ] **Step 4: Add the patch changeset**

Create `.changeset/testing-harness-mode-cleanup.md`:

```md
---
"@dawn-ai/testing": patch
---

Remove the unsupported `mode` property from `createAgentHarness()` options. The
harness remains the in-process testing API; use the existing
`createAgentProtocolInjector()` or `createSubprocessApp()` factory when testing
those execution boundaries.
```

Do not use a minor changeset: Dawn's fixed 0.x group would advance to 1.0.0.

- [ ] **Step 5: Generate and inspect the CLI docs without committing them**

Run:

```bash
pnpm --filter @dawn-ai/cli build
rg -n 'Choose the execution boundary|does not accept a `mode` option' \
  packages/cli/docs/testing-agents.md
git check-ignore packages/cli/docs/testing-agents.md
git status --short
```

Expected: the generated guide contains the new section, `git check-ignore`
prints the path, and `git status` does not list `packages/cli/docs/`.

- [ ] **Step 6: Run documentation and release checks**

Run:

```bash
pnpm --filter @dawn-ai/cli test -- docs-bundle
node scripts/check-docs.mjs
node scripts/check-changesets.mjs
```

Expected: all commands PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/testing/README.md apps/web/content/docs/testing-agents.mdx \
  .changeset/testing-harness-mode-cleanup.md
git commit -m "docs(testing): clarify harness execution boundaries"
```

### Task 3: Complete verification

**Files:**
- Verify only; no expected source changes

- [ ] **Step 1: Use the repository-supported Node runtime**

Load the workspace's configured dependencies and confirm Node is version 24 or
newer before final verification. Do not rely on a Node 22 shell override.

- [ ] **Step 2: Run package gates**

Run:

```bash
pnpm --filter @dawn-ai/testing build
pnpm --filter @dawn-ai/testing typecheck
pnpm --filter @dawn-ai/testing lint
pnpm --filter @dawn-ai/testing test
```

Expected: all commands PASS.

- [ ] **Step 3: Run the repository Definition of Done**

Run:

```bash
pnpm ci:validate
```

Expected: lint, build-cache, build, typecheck, tests, documentation, package,
release-script, and harness verification all PASS.

- [ ] **Step 4: Inspect the final branch**

Run:

```bash
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors, a clean worktree, and only the approved spec,
plan, API cleanup, contract test, docs, and changeset commits.
