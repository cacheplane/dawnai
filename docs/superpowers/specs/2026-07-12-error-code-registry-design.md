# Error-code registry — design

**Date:** 2026-07-12
**Status:** approved (brainstorm)
**Topic:** A central registry of stable numeric `DAWN_Exxxx` error codes with optional `docsPath`, so user-facing failures become linkable, searchable, and self-documenting across all three error surfaces (CLI, HTTP/SSE, tool results).

## Problem

Today a Dawn failure carries only a free-text `message` and (for `CliError`) an `exitCode` of 1 or 2. There is no stable, machine-readable identifier and no consistent path to docs. Consequences:
- A user who hits `Sandbox unavailable: docker run failed …` or `Invalid tool scope: …` has nothing to search or link.
- One error already hardcodes `Docs: https://dawnai.org/docs/tools` (`tool-discovery.ts`) — proving the value, but inconsistently and with a divergent base URL.
- The three surfaces errors reach users through are unaligned: CLI stderr (`CliError`), HTTP/SSE bodies (`server-errors.ts` has a 2-value `kind` enum), and **tool-result strings** (permission `GateResult.reason` is returned to the model as the tool result).

## Goal

A single source of truth mapping a stable **numeric code** → `{ title, docsPath? }`, importable by every package that produces user-facing errors, surfaced on all three channels, rendered into a generated `/docs/errors` reference page, and guarded so codes and their doc links can't rot.

**Decisions locked:** numeric codes (`DAWN_E1001`-style); wire the ~10 highest-value families now (not all ~48 sites); incremental adoption after.

## Non-goals

- Not coding every `CliError` usage/argument error (exit-code-2 sites stay as-is for now).
- Not changing exit codes or error-handling control flow.
- Not internationalization; `title` is English.
- Not a stack-trace/telemetry system.

## Architecture

### The registry — `packages/sdk/src/errors.ts`

`sdk` is the leaf that `core`, `langchain`, and `cli` all depend on (no reverse deps), so a registry here is importable everywhere without cycles.

```ts
export interface DawnErrorDescriptor {
  readonly code: `DAWN_E${number}`
  readonly title: string            // stable, short, human-readable
  readonly docsPath?: string        // "/docs/<slug>#<anchor>" convention; optional
}

// Frozen registry. Numeric ranges by category:
//   E1xxx config / dawn check      E2xxx sandbox
//   E3xxx permissions              E4xxx model / provider
//   E5xxx runtime / import
export const DAWN_ERRORS = { /* code → descriptor */ } as const

export type DawnErrorCode = keyof typeof DAWN_ERRORS
export function describeError(code: DawnErrorCode): DawnErrorDescriptor
export function errorDocsUrl(code: DawnErrorCode, base?: string): string | undefined
```

`docsPath` uses the existing `/docs/<slug>#<anchor>` convention; the printed link uses the canonical base `https://dawnai.org` (centralized here — replaces the hardcoded URL in `tool-discovery.ts`).

### The ~10 high-value families to wire (initial set)

| Code | Family | Origin today | docsPath |
| --- | --- | --- | --- |
| E1001 | Invalid tool scope | `check.ts` / `collect-tool-scope-errors.ts` | `/docs/tools#scoping` |
| E1002 | Invalid sandbox config | `collect-sandbox-errors.ts` | `/docs/sandbox#config` |
| E1003 | Unknown build target | `check.ts` build-target validation | `/docs/deployment` |
| E2001 | Sandbox unavailable (provider) | `docker-sandbox.ts` / `kube-sandbox.ts` | `/docs/sandbox#what-it-is--and-isnt` |
| E2002 | Sandbox preflight failed | `collect-sandbox-errors.ts` | `/docs/sandbox#quickstart` |
| E3001 | Permission denied (HITL) | `permission-gate.ts` (`GateResult.reason`) | `/docs/permissions` |
| E4001 | Model provider package missing | `chat-model-factory.ts` | `/docs/models` (or configuration) |
| E4002 | Unknown model id (advisory warn) | `warn-unknown-model-ids` / factory | `/docs/models` |
| E5001 | Import/export mismatch | `diagnostics.ts` / `import-module.ts` | `/docs/troubleshooting` |
| E5002 | Tool file wrong shape | `tool-discovery.ts` (already links docs) | `/docs/tools` |

(Exact codes/anchors finalized in the plan against real heading anchors; any missing docs anchor is either added or the `docsPath` omitted — a code without docs is valid.)

### Surfacing on the three channels

1. **CLI** — extend `CliError` (`packages/cli/src/lib/output.ts`) with an optional `code?: DawnErrorCode`. `run()`/`renderError` (`index.ts`) append a final line when a code is present: `  [DAWN_E2001] See https://dawnai.org/docs/sandbox#…`. Message text is unchanged; the code line is additive. Non-`CliError` throwables are unaffected.
2. **HTTP/SSE** — `server-errors.ts` error bodies and the AG-UI handler's `{error:{kind,message}}` gain optional `code?` + `docsUrl?` fields (additive; existing `kind` retained).
3. **Tool results** — the permission `GateResult` (`permission-gate.ts`) gains an optional `code`; the denial string returned as the tool result gets a `[DAWN_E3001]` prefix so a denial is machine-identifiable in a transcript. (Sandbox fs/exec `throw`s can adopt codes incrementally.)

### Generated docs page + guard

- **`/docs/errors`** (`apps/web/content/docs/errors.mdx` + `page.tsx` wrapper + nav entry): a generated table of every registry code → title → docs link. Generation script `scripts/generate-error-docs.mjs` reads `DAWN_ERRORS` and writes the MDX table (run in build or committed + checked). Model on `scripts/generate-docs.mjs` (the existing generated-docs pattern).
- **check-docs guard**: extend `scripts/check-docs.mjs` (or a sibling) to assert every registry `docsPath` resolves to a real `/docs/<slug>` page (reuse `docs-bundle.ts`'s nav parsing) and that `/docs/errors` lists exactly the registry's codes. Prevents code/doc drift.

## Data flow

Producer imports `DAWN_ERRORS`/`DawnErrorCode` from `@dawn-ai/sdk` → constructs the error with a `code` (CliError, error body, or GateResult) → the surface's formatter appends the doc link from the descriptor. The registry is the only place codes and doc links are defined.

## Error handling / edge cases

- A code with no `docsPath` prints just `[DAWN_E4002]` (still searchable).
- `describeError` on an unknown code is a compile error (codes are a literal union), so producers can't invent codes.
- `NO_COLOR`/non-TTY: the appended link line is plain text (no styling assumptions).

## Testing

- Unit (`packages/sdk`): the registry is internally consistent (unique codes, valid `DAWN_E` format, `docsPath` matches `/docs/…#…` shape).
- Unit (`cli`): a `CliError` with a code renders the `[CODE] See <url>` line; without a code renders unchanged (snapshot of `renderError`).
- Unit: an HTTP/SSE error body includes `code`/`docsUrl` when constructed with a code; a `GateResult` denial string is prefixed with its code.
- `scripts/check-docs.mjs` guard: fails if a `docsPath` points at a nonexistent page or `/docs/errors` drifts from the registry (fixture test).
- No behavior change for any existing test that asserts on message text (codes are additive lines) — verify the full `cli` suite stays green.

## Rollout

One PR. Changeset: **patch** for `@dawn-ai/sdk`, `@dawn-ai/cli`, `@dawn-ai/core` (+ any surface package touched). Additive and backward-compatible; the foundation for `dawn verify` (spec: verify-env-preflight) to emit codes.

## Build order note

This is the foundation the `verify` preflight builds on (its FAIL results can carry E-codes), so build it before verify-env-preflight; independent of AGENTS.md.
