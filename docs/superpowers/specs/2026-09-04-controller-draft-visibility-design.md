# Controller Draft Visibility Design

## Status

Approved design, 2026-09-04. Sub-project A of the v0.8.22 unblock; prerequisite
for the v0.8.23 release.

## Problem

GitHub lists draft Releases only to callers with push access. In Actions, the
`GITHUB_TOKEN` at `contents: read` receives HTTP 403 for a draft by ID and lists
no drafts (probe run 33780657483, 2026-09-03). The release controller escrows
every candidate as a draft Release and then observes it, but four jobs that
read drafts run with `contents: read`:

- `release.yml` `detect` (the production observer, `cli.mjs observe`)
- `release.yml` `dispatch-audit` (`cli.mjs dispatch-audit`)
- `published-artifact-verify.yml` `coordinate` (lists Releases and reads a
  draft by tag through `independent-audit-coordinator.mjs`)
- `published-artifact-verify.yml` `verify-draft` (`independent-audit.mjs`)

Consequently the v0.8.22 reconcile runs on 2026-09-03 observed the escrow as
absent and skipped every publishing job. Job permissions live in the workflow
file at the immutable candidate tag, so this must merge to `main` before the
v0.8.23 tag is created; the controller creates that tag from `main`.

`publish-npm` and the five smoke jobs do not read the Release (they consume
Actions artifacts and npm), and every other draft-touching job already has
`contents: write`.

## Goals

- Every job that reads a draft Release can see it.
- The set of jobs holding `contents: write` is enumerated and pinned by the
  workflow-contract tests so it cannot grow silently.
- No job gains `id-token: write` or any other write scope it does not have.

## Non-goals

- Changing any script, adapter, or observer behavior.
- Restoring abandonment or altering the audit workflow's dispatch contract.
- Retrofitting the v0.8.22 tag (it is terminal by the reviewed record).

## Design

Grant `contents: write` to exactly the four jobs above. Nothing else changes in
either workflow.

### The observer invariant

The contract tests asserted that `detect`, `prepare`, `hydrate`, and every
smoke job hold no write permission at all (`assertNoWriteOrOidc`). GitHub
offers no read-only scope that exposes drafts, so the invariant for `detect`
becomes: `contents: write` is the only write scope, `id-token` is not `write`,
and the job's steps invoke only the observer (already asserted step by step).
`prepare`, `hydrate`, and the smokes keep the strict no-write assertion. The
same relaxed shape applies to `dispatch-audit`, `coordinate`, and
`verify-draft`, each of which keeps its existing step-level assertions.

### Accepted trade-off

A job running reviewed scripts from `main` with a write-capable token could, if
a script regressed, mutate a Release. The controller's writers already run
under that token in `escrow`, `reconcile-npm`, `reconcile-smokes`,
`record-audit-dispatch`, `correlate-audit`, and `publish-release`; this widens
exposure to four more jobs but to no new code paths, and the adapters' innermost
per-call-site guards are unchanged. This is preferred over an external token
with push access, which would introduce a long-lived credential.

## Testing

`scripts/release/test/workflow-contracts.test.mjs`:

- `detect`, `dispatch-audit`, `coordinate`, `verify-draft`: assert
  `permissions.contents === "write"`, no other write scope, `id-token` not
  `write`.
- A new enumeration test: the exact set of jobs with `contents: write` in
  `release.yml` is `{tag, escrow, reconcile-npm, reconcile-smokes,
  record-audit-dispatch, correlate-audit, publish-release, detect,
  dispatch-audit}` and in `published-artifact-verify.yml` is `{coordinate,
  verify-draft}`; any other job with `contents: write` fails.
- Existing strict assertions for `prepare`, `hydrate`, `publish-npm`, and the
  smokes are unchanged.

## Release sequence

1. Merge this change on green `validate`.
2. Run the runbook's pre-enable checks and a read-only `observe` from `main`:
   v0.8.22 must read `ABANDONED_PREPUBLICATION`; no other candidate pending;
   release.yml `disabled_manually`; zero nonterminal Release runs.
3. Enable `release.yml`.
4. Merge Version Packages PR #525 (v0.8.23). The push to `main` runs the
   controller, which creates the annotated `v0.8.23` tag (carrying this
   workflow) and dispatches at the tag.
5. Watch the tagged run through escrow, publish-npm, the five smokes,
   reconcile, the independent audit, and publish-release. Stop at the first
   failed transition and preserve evidence.

## Success criteria

- The v0.8.23 tagged run's `detect` observes its own escrow draft
  (`CANDIDATE_ESCROWED`) on the run after `escrow`, and the run proceeds to
  `publish-npm`.
- No job outside the enumerated set holds `contents: write`.
