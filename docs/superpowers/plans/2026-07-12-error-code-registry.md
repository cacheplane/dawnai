# Error-code registry — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. Follow TDD.

**Goal:** Stable numeric `DAWN_Exxxx` error codes with optional `docsPath`, surfaced on CLI / HTTP-SSE / tool-result channels, plus a generated `/docs/errors` page and a drift guard. Wire the ~10 highest-value families.

**Architecture:** A frozen registry in `@dawn-ai/sdk` (the leaf dep). `CliError` and the error surfaces carry an optional `code`; formatters append the docs link. Codes are a TS literal union so producers can't invent them.

**Spec:** `docs/superpowers/specs/2026-07-12-error-code-registry-design.md`

**Conventions:** `src`→`.js` imports, `test`→`.ts`; `exactOptionalPropertyTypes` → conditional-spread; `pnpm --filter <pkg> lint`; changeset **patch**.

---

## Task 1: The registry module (`@dawn-ai/sdk`)

**Files:**
- Create: `packages/sdk/src/errors.ts`
- Modify: `packages/sdk/src/index.ts` (export)
- Test: `packages/sdk/test/errors.test.ts`

- [ ] **Step 1: Failing test** — `errors.test.ts`: every descriptor's `code` matches `/^DAWN_E\d{4}$/`, codes are unique, every `docsPath` (when present) matches `/^\/docs\/[a-z0-9-]+(#[a-z0-9-]+)?$/`; `describeError(code)` returns the descriptor; `errorDocsUrl(code)` returns `https://dawnai.org<docsPath>` or `undefined`.
- [ ] **Step 2: Run → fail** (`pnpm --filter @dawn-ai/sdk test errors`).
- [ ] **Step 3: Implement** `errors.ts`:

```ts
export interface DawnErrorDescriptor {
  readonly code: `DAWN_E${number}`
  readonly title: string
  readonly docsPath?: string
}
const DOCS_BASE = "https://dawnai.org"
// Ranges: E1xxx config/check · E2xxx sandbox · E3xxx permissions · E4xxx model/provider · E5xxx runtime/import
export const DAWN_ERRORS = {
  DAWN_E1001: { code: "DAWN_E1001", title: "Invalid tool scope", docsPath: "/docs/tools" },
  DAWN_E1002: { code: "DAWN_E1002", title: "Invalid sandbox config", docsPath: "/docs/sandbox" },
  DAWN_E1003: { code: "DAWN_E1003", title: "Unknown build target", docsPath: "/docs/deployment" },
  DAWN_E2001: { code: "DAWN_E2001", title: "Sandbox unavailable", docsPath: "/docs/sandbox" },
  DAWN_E2002: { code: "DAWN_E2002", title: "Sandbox preflight failed", docsPath: "/docs/sandbox" },
  DAWN_E3001: { code: "DAWN_E3001", title: "Permission denied", docsPath: "/docs/permissions" },
  DAWN_E4001: { code: "DAWN_E4001", title: "Model provider package missing", docsPath: "/docs/configuration" },
  DAWN_E4002: { code: "DAWN_E4002", title: "Unknown model id", docsPath: "/docs/configuration" },
  DAWN_E5001: { code: "DAWN_E5001", title: "Import or export mismatch" },
  DAWN_E5002: { code: "DAWN_E5002", title: "Tool file has the wrong shape", docsPath: "/docs/tools" },
} as const satisfies Record<string, DawnErrorDescriptor>

export type DawnErrorCode = keyof typeof DAWN_ERRORS
export function describeError(code: DawnErrorCode): DawnErrorDescriptor { return DAWN_ERRORS[code] }
export function errorDocsUrl(code: DawnErrorCode, base = DOCS_BASE): string | undefined {
  const p = DAWN_ERRORS[code].docsPath
  return p ? `${base}${p}` : undefined
}
```
   IMPORTANT: before finalizing each `docsPath`, confirm the target `/docs/<slug>` page exists (`ls apps/web/content/docs`) and pick a real heading anchor where useful; if no page fits, omit `docsPath` (a code without docs is valid). Adjust the table accordingly (e.g. there may be no `/docs/models` — the spec used `/docs/configuration`; verify).
- [ ] **Step 4: Export** from `packages/sdk/src/index.ts`: `export { DAWN_ERRORS, describeError, errorDocsUrl } from "./errors.js"` + the types.
- [ ] **Step 5: Run → pass**; `pnpm --filter @dawn-ai/sdk typecheck && lint`.
- [ ] **Step 6: Commit** `feat(sdk): DAWN_Exxxx error-code registry`.

---

## Task 2: `CliError` carries a code; CLI prints the docs link

**Files:**
- Modify: `packages/cli/src/lib/output.ts` (CliError), `packages/cli/src/index.ts` (renderError/run)
- Test: `packages/cli/test/error-code-render.test.ts`

- [ ] **Step 1: Failing test** — a `new CliError("msg", 1, { code: "DAWN_E2001" })` rendered by the CLI's error path produces `msg` followed by a line containing `[DAWN_E2001]` and `https://dawnai.org/docs/sandbox`; a `CliError` with no code renders exactly `msg` (unchanged).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — add `readonly code?: DawnErrorCode` to `CliError` (accept in the options arg alongside `cause`). In `index.ts` where a `CliError` is printed (`run()`), after writing `error.message`, if `error.code` is set, write a second line: `  [${error.code}] See ${errorDocsUrl(error.code)}` (omit the URL clause if `errorDocsUrl` is undefined → just `  [${code}]`). Import from `@dawn-ai/sdk`.
- [ ] **Step 4: Run → pass**; full `@dawn-ai/cli` suite green (additive; no existing message assertions should break — verify).
- [ ] **Step 5: Commit** `feat(cli): CliError carries an error code + prints the docs link`.

---

## Task 3: Wire the high-value families to codes

**Files (modify, add the `code` at each throw/return site):**
- `packages/cli/src/commands/check.ts` — the three `Invalid …` throws → E1001/E1002/E1003.
- `packages/sandbox/src/docker/docker-sandbox.ts` + `kubernetes/kube-sandbox.ts` — "Sandbox unavailable" `Error`s → wrap so the code reaches the user (these are plain `Error`; the CLI catches non-CliError via `renderError`. Simplest: attach `code` where they surface as `CliError`, OR add a `code` field the runtime error body reads. Keep scope tight: for the throw sites that become `CliError` at the CLI boundary, pass the code there).
- `packages/core/src/capabilities/permission-gate.ts` — `GateResult` gains optional `code`; denial `reason` returned as a tool result is prefixed `[DAWN_E3001] `.
- `packages/langchain/src/chat-model-factory.ts` — provider-package-missing `Error` → E4001; unknown-model-id warning → include `[DAWN_E4002]`.
- `packages/cli/src/lib/runtime/tool-discovery.ts` — replace the hardcoded `Docs: https://dawnai.org/docs/tools` with the registry (E5002) so the URL is centralized.

- [ ] **Step 1:** For each site, add the code (TDD where a unit test exists for that error; otherwise a focused assertion). Keep messages otherwise unchanged. Do NOT attempt all 48 CliError sites — only the families in the registry.
- [ ] **Step 2:** `GateResult` code test: a denied tool op returns a result string beginning `[DAWN_E3001]`.
- [ ] **Step 3:** HTTP/SSE bodies (`packages/cli/src/lib/dev/server-errors.ts` + `agui-handler.ts`): add optional `code?`/`docsUrl?` to the error body shape; populate where a coded error is caught. Additive; existing `kind` retained. Unit test: a body built with a code includes `code`+`docsUrl`.
- [ ] **Step 4:** Full suites green (`sdk`, `cli`, `core`, `sandbox`, `langchain` — run each `--filter` test); typecheck/lint.
- [ ] **Step 5: Commit** `feat: adopt error codes at the high-value failure sites (check/sandbox/permissions/model/tool-discovery)`.

---

## Task 4: Generated `/docs/errors` page + drift guard

**Files:**
- Create: `scripts/generate-error-docs.mjs`, `apps/web/content/docs/errors.mdx`, `apps/web/app/docs/errors/page.tsx`
- Modify: `apps/web/app/components/docs/nav.ts` (nav entry), `scripts/check-docs.mjs` (guard)
- Test: `packages/sdk/test/errors.test.ts` (extend) or a script test

- [ ] **Step 1:** `generate-error-docs.mjs` imports `DAWN_ERRORS` (from the built sdk dist or via tsx) and writes `errors.mdx`: a table `Code | Meaning | Docs`. Model on `scripts/generate-docs.mjs`. Add an npm script if the repo generates docs in CI, or commit the output + guard it's in sync.
- [ ] **Step 2:** `errors.mdx` + `page.tsx` wrapper + nav entry (new MDX pages REQUIRE the `page.tsx` under `apps/web/app/docs/<slug>/` and a `nav.ts` entry or `check-docs.mjs` topology fails — see the AGENTS.md/docs conventions).
- [ ] **Step 3:** Extend `check-docs.mjs` (or a sibling `check-error-docs.mjs` wired into the `validate` lane) to assert: every registry `docsPath` resolves to a real `/docs/<slug>` (reuse `packages/cli/src/lib/docs-bundle.ts` nav parsing), and `/docs/errors` lists exactly the registry's codes (fails on drift).
- [ ] **Step 4:** `node scripts/check-docs.mjs` + the new guard pass; `pnpm --filter @dawn-ai/web build` renders `/docs/errors`.
- [ ] **Step 5: Commit** `docs: generated /docs/errors reference + drift guard`.

---

## Task 5: Changeset + full verify + PR

- [ ] **Step 1:** `.changeset/error-code-registry.md` — **patch** for the touched publishable packages (confirm via `git log --oneline origin/main..HEAD --name-only -- packages/ | grep '^packages/' | cut -d/ -f2 | sort -u`; expect `sdk`, `cli`, `core`, `sandbox`, `langchain`).
- [ ] **Step 2:** Full local verify: `pnpm build && pnpm typecheck && pnpm lint && pnpm test && node scripts/check-docs.mjs && pnpm pack:check`.
- [ ] **Step 3:** Rebase on `origin/main`, push, open PR, watch `validate` + review; fix findings.

**Notes:** Branch e.g. `feat/error-code-registry`; pin before subagent dispatch. Keep every message-text change additive so existing snapshot/assertion tests stay green.
