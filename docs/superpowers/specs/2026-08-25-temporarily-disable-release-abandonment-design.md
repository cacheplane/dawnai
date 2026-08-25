# Temporarily Disable Release Abandonment

## Status

Approved for specification on 2026-08-25. This design allows normal fixed-group
releases to proceed without configuring an independent GitHub environment
reviewer, while making the terminal abandonment operation unreachable.

## Context

The release controller currently exposes two manual operations:

- `reconcile`, which advances or resumes the one exact fixed-group candidate;
- `abandon`, which permanently tombstones a pre-publication candidate.

`abandon` is intentionally protected by the `release-abandonment` GitHub
environment and by runtime reconstruction of one approval from a reviewer whose
stable identity differs from the dispatch actor. The repository currently has
only one GitHub identity with access, so that environment cannot be configured
with a genuinely independent reviewer.

Simply allowing a missing environment is not safe enough. GitHub creates a
referenced missing environment without protection and may start the job with its
declared `contents: write` token. Dawn's runtime authority would reject the
missing approval before its first writer call, but the workflow would already
have issued mutation authority. The release cutover must not depend on that
code-level rejection.

## Goals

- Allow normal reconcile, publish, audit, and verification paths to operate
  without a configured abandonment reviewer.
- Ensure no workflow invocation can issue write authority for abandonment while
  the capability is disabled.
- Keep the existing abandonment authority, tombstone format, recovery parser,
  and tests available for a later reviewed reactivation.
- Make strict owner evidence prove that abandonment is unreachable, rather than
  treating an unreadable or unprotected environment as sufficient.
- Preserve the independent published-artifact audit. GitHub Copilot review is an
  additional pull-request review and does not replace that production gate.

## Non-goals

- Do not permit self-approved or unprotected abandonment.
- Do not synthesize approval evidence or add an administrative bypass.
- Do not change npm trusted-publisher relationships, the release candidate
  marker, or historical abandonment evidence.
- Do not introduce a mutable repository variable, secret, or local override as
  an abandonment switch.

## Approaches considered

### Disable workflow reachability — selected

Remove the manual abandon option and the write-capable abandonment job while
retaining the underlying controller implementation. Strict preflight derives
the disabled state from the exact workflow bytes and accepts canonical disabled
evidence.

This is the only option that both unblocks normal publishing and prevents an
abandonment dispatch from receiving a write token.

### Keep the job and rely on runtime rejection — rejected

The existing runtime correctly requires one independent approval before its
first writer call. However, a missing GitHub environment can be auto-created
without protection, allowing the job to start with `contents: write` before the
runtime rejects it. That token boundary is weaker than the intended policy.

### Permit unprotected abandonment — rejected

This would require a new authorization and tombstone schema and would remove the
two-person terminal decision. Treating missing protection as implicit approval
would also make accidental configuration loss indistinguishable from intended
policy.

## Design

### Workflow surface

`.github/workflows/release.yml` remains the sole release controller, but its
manual interface exposes only `operation=reconcile`:

- the `operation` choice contains only `reconcile`;
- the abandonment-only `reason` input is removed;
- abandonment-specific intent and tag-routing branches are removed;
- the `abandon` job is removed;
- no workflow executable invokes `abandonment-context` or `cli.mjs abandon`.

All reconcile jobs, the global non-cancelling queue, npm publication, smoke
lanes, independent audit, immutable Release publication, and scheduled recovery
remain unchanged.

The CLI abandonment commands and their authority, record, candidate, observe,
and terminal-evidence modules remain in source. They have no workflow entrypoint
and receive no GitHub token during normal release operation.

### Owner preflight and evidence

Owner preflight classifies abandonment reachability from the exact local
`release.yml` bytes that are already hashed into owner evidence.

The classifier has only two valid modes:

1. **Disabled:** the workflow exposes only reconcile, contains no abandonment
   input, job, gate, or executable, and therefore cannot issue abandonment write
   authority.
2. **Protected:** the workflow exposes the existing exact protected abandonment
   surface and names the controller schema's environment. This mode retains the
   existing required-reviewer and prevent-self-review checks.

Any partial or mixed surface is invalid and fails closed.

Owner evidence is versioned for the nullable representation:

- disabled mode records `github.abandonmentEnvironment: null` and does not call
  the GitHub environment endpoint;
- protected mode records the existing exact environment evidence object;
- an unavailable environment is never reclassified as disabled;
- evidence mode and current workflow mode must agree exactly during
  verification.

Strict pre-enable and post-enable verification pass for disabled mode only when
the exact current workflow remains unreachable. If a future change restores any
abandonment surface, strict evidence again requires a present protected
environment with at least one reviewer and self-review prevention.

The controller marker keeps
`abandonmentEnvironment: "release-abandonment"`. That field remains part of the
historical evidence format and must not be overloaded as a live feature flag.

### Operational behavior

Normal release activation follows the existing order:

1. capture fresh strict pre-enable evidence at the exact reviewed SHA;
2. merge the ownership switch;
3. enable and re-read Immutable Releases;
4. activate the release, chart, verification, and version workflows;
5. capture strict post-enable evidence at the unchanged main SHA;
6. run the required no-candidate reconciliation;
7. merge the generated Version Packages pull request and let the controller
   publish, audit, and verify the fixed group.

No `release-abandonment` environment is created during this cutover.

Reactivation is a separate reviewed change. Before restoring the workflow
entrypoint, an owner must configure the protected environment with an
independent reviewer and self-review prevention. The reactivation pull request
must restore the exact workflow contract and pass strict owner evidence in
protected mode.

### Failure behavior

Disabled mode has one intentional liveness cost: an irrecoverable tagged
pre-publication candidate cannot be tombstoned. The controller continues to
recover any valid resumable candidate, and an incomplete older candidate still
wins arbitration and blocks newer candidates. Operators must not delete, reuse,
or skip such a version. Restoring protected abandonment would then require a
reviewed change based on a state assessment.

This liveness cost is preferable to granting unreviewed terminal mutation
authority.

## Verification

Implementation follows test-driven development. Tests must fail before the
workflow or preflight implementation changes.

Required coverage:

- workflow dispatch exposes only reconcile and contains no reason input;
- no abandonment job or abandonment executable exists in release workflow
  entrypoints or safe-executable fixtures;
- disabled owner capture records canonical null and never reads a GitHub
  environment;
- disabled mode passes strict pre-enable and post-enable verification;
- protected mode retains the current exact reviewer requirements;
- disabled, protected, unavailable, and mixed evidence cannot be confused;
- any partial abandonment workflow surface fails closed;
- existing runtime abandonment authority and tombstone tests remain green;
- generated workflow inventories are refreshed from the final workflow;
- release-controller tests, workflow contracts, documentation checks, and the
  full repository validation lane pass at the new exact head.

After the implementation is pushed, GitHub Copilot review is requested again so
it reviews the new head. All Copilot findings are triaged before merge. Copilot
leaves a comment review and is not treated as a required human approval or as a
substitute for the independent release artifact audit.

## Rollback and reversibility

Before npm publication, the cutover may stop with the mutating workflows
disabled. After any package publishes, rollback or unpublish is forbidden; the
controller must resume from the exact durable artifacts.

Re-enabling abandonment requires a new reviewed commit and fresh owner evidence.
No live setting silently changes the workflow from disabled to protected mode.
