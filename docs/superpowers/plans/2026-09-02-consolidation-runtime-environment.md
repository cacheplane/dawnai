# Consolidation Runtime Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the standalone duplicate-draft consolidation CLI to compose its production adapters without weakening explicit environment validation.

**Architecture:** Preserve whether `environment` was explicitly supplied to the CLI. Route all three CLI modes through one adapter-option builder that omits an implicit environment, allowing the adapter's existing runtime snapshot to own `process.env`.

**Tech Stack:** Node.js 24, ESM, `node:test`, pnpm, Biome

---

### Task 1: Preserve the runtime environment boundary

**Files:**
- Modify: `scripts/release/duplicate-draft-consolidation-cli.mjs`
- Test: `scripts/release/test/duplicate-draft-consolidation-cli.test.mjs`

- [x] **Step 1: Write the failing three-mode environment regressions**

Add table-driven CLI cases for `inspect`, `perform`, and `verify`. For each mode:

1. omit the top-level `environment` option, capture every options object passed
   to `createAdapters`, and assert none has an own `environment` property;
2. pass one frozen plain environment explicitly and assert the identical object
   reaches every `createAdapters` call; and
3. pass `environment: undefined` explicitly and assert it remains an own field
   in the composition options so the adapter's strict explicit-input parser,
   rather than the runtime path, owns rejection.

For `perform`, make the successful dependency invoke `createAdapters()` once
without a budget and once with a frozen request budget. Assert both calls obey
the environment rule and the second preserves the exact budget object. Keep
mode-specific operation dependencies successful so the tests observe only the
composition boundary.

- [x] **Step 2: Prove the regression is red**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test \
  --test-name-pattern='preserves the environment boundary across every mode' \
  scripts/release/test/duplicate-draft-consolidation-cli.test.mjs
```

Expected: FAIL because the current CLI explicitly forwards `process.env`.

- [x] **Step 3: Add the minimal shared composition helper**

Keep `environment` absent from normalized CLI options unless it was supplied by
the caller. Add one helper that returns:

```js
{
  cwd: invocation.cwd,
  ...(Object.hasOwn(invocation, "environment")
    ? { environment: invocation.environment }
    : {}),
  dependencies: { now },
  ...(requestBudget === undefined ? {} : { requestBudget }),
}
```

Use it for `inspect`, `perform`, and `verify`. Do not change adapter validation.

- [x] **Step 4: Prove all environment and budget cases are green**

Run the table-driven regression and require all default, explicit-frozen, and
explicit-undefined cases to pass for all three modes. Require both perform
adapter calls to preserve the exact request-budget behavior.

- [x] **Step 5: Run focused verification**

Run the CLI test, the complete duplicate-draft consolidation suite, scoped
repository-configured Biome, `node scripts/check-docs.mjs`, and
`git diff --check`. Expected: all pass.

- [x] **Step 6: Run full validation and commit**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH \
  DAWN_REQUIRE_DOCKER=1 pnpm ci:validate
```

Expected: all Definition of Done gates pass. Commit the design, plan, test, and
implementation with a factual message, push a focused PR, and require exact-head
CI before merge.

### Task 2: Resume live read-only inspection

**Files:**
- Live private output: `.dawn/release/duplicate-draft-consolidation.proposed.json`

- [ ] **Step 1: Refresh exact merged-main authority**

Require clean symbolic `main` and identical local HEAD, `origin/main`, and
GitHub default-branch SHAs. Confirm Release remains disabled and no nonterminal
Release run exists.

- [ ] **Step 2: Retry the exact production inspect command**

Run the incident-scoped `pnpm release:consolidate-drafts inspect` command from
the merged main checkout. Expected: a canonical private proposal and bounded
safe summary; zero writer calls.

- [ ] **Step 3: Independently validate the proposal**

Confirm mode `0600`, canonical envelope parsing, exact survivor and ordered
duplicates, and the printed record digest before entering the separate live
mutation freeze.
