# Consolidation Runtime Environment Design

**Status:** Implemented and locally verified; merge and live retry pending

**Date:** 2026-09-02

**Scope:** Production composition for the duplicate-draft consolidation CLI

## Problem

The standalone consolidation CLI defaults `environment` to Node's `process.env`
and then passes that value explicitly to
`createDuplicateDraftConsolidationAdapters`. The adapter treats explicit
environment overrides as untrusted caller data and therefore requires a plain
data object. Node's host-owned `process.env` object is not a plain object, so
production `inspect` stops during adapter composition before any live read.

The adapter already owns a separate runtime path: when the `environment` option
is absent, it snapshots `process.env` with runtime-specific validation and
allowlisting. Tests that explicitly inject an environment must continue through
the stricter caller-data path.

## Considered approaches

1. **Omit an implicit environment at the CLI-to-adapter boundary.** Preserve
   whether the caller supplied `environment`; pass it only when explicit. The
   adapter then uses its existing runtime snapshot for standalone execution.
2. Copy `process.env` into a plain object in the CLI. This duplicates environment
   ownership and allowlisting across layers.
3. Let the adapter's explicit-override parser accept `process.env`. This weakens
   the distinction between host-owned runtime state and injected caller data.

## Decision

Use approach 1. The CLI will preserve option presence and build one exact
adapter-composition object for `inspect`, `perform`, and `verify`. It includes
`environment` only when the caller explicitly supplied it, and continues to add
the request budget only when present. No new flag, override, fallback, or
compatibility path is introduced.

## Safety and verification

- Add a table-driven regression proving the standalone/default CLI omits
  `environment` for `inspect`, `perform`, and `verify`.
- For all three modes, prove an explicitly injected frozen plain environment is
  still forwarded by identity, while explicit `environment: undefined` remains
  explicit and reaches strict adapter rejection.
- For `perform`, cover both initial composition and the request-budget path.
- Run the focused CLI and consolidation suites, repository-configured static
  checks, documentation checks, and the full validation lane before merge.
- After merge, retry the exact read-only live `inspect` command. Any later live
  authority drift still stops through the existing fail-closed workflow.
