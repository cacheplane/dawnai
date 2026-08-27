# Release Controller Reconciliation After Main Integration

**Date:** 2026-08-27

**Status:** Direction approved; focused specification review pending

## Summary

Reconcile the release-controller branch with `main` before completing the
controller cutover and the first production release. The integrated baseline is
`origin/main` at `6488d32a23907112daa593ae3f31b0144df6ed02`, merged into the
feature branch by `c7fc700c`.

The integration changes the dependency-remediation work materially:

- `main` already migrated the chat, research, and research-scaffold CopilotKit
  integrations to the supported `/v2` imports;
- the feature branch's later CopilotKit `1.69.0` refresh does not remove the
  remaining vulnerable upstream dependency boundary and now breaks the new
  research-scaffold parity guard;
- the feature branch's `next typegen` typecheck workaround is no longer needed;
  and
- `main` added a larger documentation/SEO surface that must be included in
  production verification.

The selected approach is to preserve the completed V2 migration while removing
only the branch-specific package refresh and workaround. Keep the exact Vercel
CLI dependency and real Vercel CI lane, do not add dependency overrides, finish
the disabled-abandonment controller design, and release only after the merged
head passes the complete repository and production verification contract.

## Current evidence

This evidence is a dated decision input, not a permanent release receipt. Every
quantity and external state must be re-derived at the final reviewed head before
activation.

- A frozen install, full build, full typecheck, isolated release-controller
  suite, and dependency-security suite pass after merging current `main`.
- The devkit template suite has one failure: the branch's version-only edits in
  three research example files no longer match the new research scaffold.
- Current `main` uses CopilotKit `^1.68.3`, direct AG-UI `0.0.57`, and `/v2`
  imports in both examples and the research scaffold.
- Registry inspection on 2026-08-27 found CopilotKit `1.69.2` as the latest
  stable release. It still directly selects AG-UI `0.0.57` and retains the
  Google Vertex/provider-utils path that owns the remaining CopilotKit-side
  advisory. Moving from `1.68.3` to `1.69.0` or `1.69.2` therefore does not
  remove that boundary.
- Registry inspection found Vercel `59.7.0` as the latest release. Its relevant
  direct and nested packages still select the vulnerable tar, path matcher,
  undici, and TOML boundaries observed through the required CLI. Updating the
  direct Vercel version does not currently clear those advisories.
- The repository currently has 46 pending changesets across the fixed group of
  21 publishable packages. The derived next train is `0.8.22`, and the current
  release design expects 45 base assets before lane receipts. These values must
  be rechecked rather than hard-coded into controller behavior.
- The Release and Publish Chart workflows are manually disabled. Published
  Artifact Verification is active and read-only. The new Version Packages
  workflow is absent from the deployed default branch until this pull request
  merges. Immutable Releases are not yet enabled. There are no controller-owned
  `v*` tags and no nonterminal Release runs.
- The repository has no independent second GitHub identity available for the
  abandonment environment. The separately approved disabled-abandonment design
  remains the prerequisite for activation.

## Goals

- Preserve the supported CopilotKit V2 API surface already present on `main`.
- Restore example/scaffold parity without adding compatibility code or package
  manager overrides.
- Keep the Vercel CLI and native deployment lane as required release evidence.
- Reconcile the disabled-abandonment design with the workflows actually
  deployed today.
- Verify the larger merged release train and website surface before and after
  production publication.
- Request a fresh GitHub Copilot pull-request review on the final pushed head and
  triage every finding before merge.

## Non-goals

- Do not remove the Vercel CLI, replace its deployment with a mock, or remove the
  `vercel-native` CI lane.
- Do not force patched transitive versions with overrides, patches, or runtime
  shims while upstream owners still select incompatible boundaries.
- Do not upgrade CopilotKit merely because a newer stable number exists when it
  does not improve the advisory boundary.
- Do not reintroduce legacy CopilotKit imports or add an old-client compatibility
  path.
- Do not enable unreviewed terminal abandonment.
- Do not merge a generated Version Packages pull request until the controller
  ownership cutover has produced strict post-enable and no-candidate receipts.

## Approaches considered

### Reconcile to `main`'s reviewed dependency graph — selected

Keep all `/v2` application code from `main`, restore the selected CopilotKit
`1.68.3`/AG-UI `0.0.57` graph, and remove the branch-only typecheck workaround.
This fixes scaffold parity, minimizes release-train churn, and avoids claiming a
security improvement that the newer stable package does not provide.

### Upgrade every CopilotKit owner to `1.69.2` — rejected for this release

This would make the examples and scaffold consistent only if all copies, tests,
and the lockfile moved together. It still would not remove the advisory-owning
provider path or change the AG-UI generation. It adds dependency and generated
lockfile churn to an already large controller release without a corresponding
security boundary improvement.

A future upgrade remains appropriate when upstream changes the vulnerable path
or the product needs behavior introduced after `1.68.3`.

### Remove Vercel or replace the native lane — rejected

Vercel is a real deployment target, not a development-only convenience. Its CLI
is used to prove the production build against the provider's native behavior.
Removing it would discard required functional evidence while leaving the
underlying upstream advisories unresolved rather than remediated.

### Add targeted dependency overrides — rejected

Overrides would make Dawn responsible for combinations the direct owners did
not select. That is especially fragile across Vercel's bundled execution path
and CopilotKit's pre-1.0 AG-UI types. The release records the remaining upstream
findings instead of silently forcing them.

## Design

### CopilotKit and scaffold boundary

The implementation restores only the branch-specific version refresh:

- both example manifests return to `@copilotkit/react-core@^1.68.3` and
  `@copilotkit/runtime@^1.68.3`;
- `packages/ag-ui` returns its React Core development owner to `^1.68.3` while
  retaining the existing optional peer range;
- direct `@ag-ui/client` stays exactly `0.0.57` everywhere it is a type-facing
  owner;
- lockfile importers, dependency-security receipts, documentation version
  references, and version-only code comments return to that graph;
- the chat and research example `typecheck` scripts return to plain
  `tsc -p . --noEmit`; and
- research example source remains equal to the scaffold-owned source wherever
  the existing devkit parity test requires equality.

All `@copilotkit/react-core/v2` and `@copilotkit/runtime/v2` imports, V2 Fetch
handlers, catch-all routes, multi-route provider behavior, browser tests, and CI
coverage remain. There is no backward-compatibility layer.

The existing dependency-security tests remain the guardrail for direct owner
versions, a single type-facing AG-UI generation, and confinement of the
remaining provider-utils finding to the private CopilotKit path. They must not
encode the absence of an advisory that upstream still installs.

### Vercel boundary

Keep the exact root `vercel@58.9.0` development dependency and the real
`vercel-native` CI job. Keep the provider deployment harness, receipt checks,
and production CLI verification unchanged except where final-main reconciliation
requires new expected bytes or metadata.

The dependency audit records the remaining CLI-owned findings as upstream
exposure. No direct Vercel bump, override, local patch, or substitute deployment
lane is part of this release. Reassess when an upstream release actually changes
the relevant transitive selections.

### Website production-build boundary

Retain the feature branch's production-only TypeScript configuration:

- normal website typecheck still includes test modules;
- Next production build uses `apps/web/tsconfig.build.json`, which excludes test
  and spec modules; and
- the focused production-build configuration test and lint inventory remain.

This is additive to `main`'s SEO scripts, content changes, and `vercel.json`.
Neither side of the merged configuration is dropped.

### Disabled abandonment

The release workflow exposes reconcile only and contains no dispatchable
abandonment job or abandonment executable. The dormant CLI implementation and
historical evidence parsers remain for a separately reviewed future
reactivation. Strict owner evidence is ref-aware as specified in
[Temporarily Disable Release Abandonment](./2026-08-25-temporarily-disable-release-abandonment-design.md).

The initial cutover continues to require no controller-owned `v*` tag and no
nonterminal Release run. No `release-abandonment` environment is created.

### Workflow state and activation order

The safe order distinguishes mutating workflows from read-only or PR-maintenance
workflows.

Before merge:

- Release and Publish Chart remain `disabled_manually`;
- Published Artifact Verification remains active because it is read-only and
  cannot publish a package, chart, or Release; and
- Version Packages is absent because its workflow file is not yet on deployed
  `main`.

After the ownership-switch pull request merges, the new Version Packages
workflow becomes active and its push-triggered run may create or update the
Version Packages pull request. That is acceptable: the workflow prepares the
version commit but does not publish. The pull request must remain unmerged.

At the exact reviewed remote `main` SHA:

1. synchronize the local checkout and require its HEAD and workflow bytes to
   match remote `main`;
2. capture strict pre-enable evidence requiring Release and Publish Chart to be
   present and manually disabled, and requiring Published Artifact Verification
   and Version Packages to be present and active;
3. require zero controller-owned `v*` refs and zero nonterminal Release runs;
4. enable Immutable Releases and re-read the setting as enabled;
5. activate Release and Publish Chart, then require all four controller
   workflows to be present and active;
6. capture strict post-enable evidence at the same SHA with the unchanged empty
   ref/run snapshot;
7. dispatch reconciliation through the CLI and require the directly correlated
   result to be `NO_CANDIDATE`, with no tag, draft Release, package, or chart
   created; and
8. only then merge the Version Packages pull request.

If `main` moves, evidence expires, the Version Packages pull request merges
early, a candidate appears, or any workflow state differs, stop and recapture or
reassess. Do not infer continuity across SHAs.

### Release and production verification

Before merge, the final head must pass:

- frozen installation, scaffold parity, lint, build-cache check, full build,
  full typecheck, source tests, release inventory/controller checks, docs,
  packing, TypeScript-tooling pack verification, and all harness lanes through
  `pnpm ci:validate`;
- the complete dependency-security suite;
- the applicable gated Docker, Kubernetes, Postgres/pgvector, chart, edge,
  CopilotKit browser, and real Vercel deployment lanes;
- fixed-group release rehearsal with an injected mid-publish interruption,
  resume, independent artifact comparison, and clean no-op reconciliation; and
- a fresh GitHub Copilot review of the final pushed head, with every comment
  resolved or explicitly rejected with evidence.

The live release must preserve the existing controller evidence contract for
all 21 fixed-group packages, npm provenance, registry bytes, GitHub attestations,
the draft immutable Release, chart publication, and every smoke receipt. The
published-artifact verifier remains an independent audit and is not replaced by
pull-request review.

Production verification also covers the website changes integrated from
`main`. At the final head, derive the expected site inventory from the built
output and compare production through the CLI and browser smoke. The current
snapshot contains 83 sitemap URLs; a different final count requires explained
source changes, not a silently weakened assertion. Verify:

- the production deployment resolves to the intended commit and canonical
  HTTPS origin;
- every derived sitemap URL is reachable and the production sitemap equals the
  built inventory;
- `robots.txt`, `llms.txt`, and `llms-full.txt` expose the expected canonical
  surfaces;
- representative landing, docs, API, recipe, and blog pages have the expected
  status, canonical URL, metadata, and JSON-LD;
- production metadata and structured data match the built contract; and
- blog Open Graph image routes return valid images for the final content set.

All external repository, npm, Vercel, and deployment operations use their
authenticated CLIs. Browser automation is used only for user-visible production
behavior that a service CLI cannot prove.

## Failure and rollback behavior

Before the first npm publication, any failed gate stops the cutover with Release
and Publish Chart disabled. An already-created Version Packages pull request is
left unmerged until a new exact-head assessment passes.

After any package publishes, do not unpublish, delete or reuse the candidate
tag, replace assets, or start a different version. Resume the exact durable
candidate through the controller and preserve its evidence. The intentional
non-abandonable failure mode remains governed by the disabled-abandonment design.

## Acceptance criteria

- The branch contains current `main`'s CopilotKit V2 code with the consistent
  `1.68.3`/AG-UI `0.0.57` dependency graph and passing scaffold parity.
- No new override, compatibility shim, Vercel removal, or native-lane removal is
  present.
- The disabled-abandonment spec and runbook describe the actual pre-merge and
  post-merge workflow states.
- Strict owner evidence tests enforce the exact four-workflow activation
  topology and ref-aware disabled state.
- Complete local, CI, gated-lane, rehearsal, and fresh Copilot review evidence
  is green at the final head.
- Immutable Releases is enabled before either mutating workflow is activated.
- No-candidate reconciliation succeeds before the Version Packages pull request
  merges.
- The fixed group publishes once, every release smoke/audit receipt agrees, and
  production artifacts and website behavior verify against the exact released
  commit.
