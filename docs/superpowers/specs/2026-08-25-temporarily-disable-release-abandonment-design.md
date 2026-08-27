# Temporarily Disable Release Abandonment

## Status

Approved for specification on 2026-08-25. This design allows normal fixed-group
releases to proceed without configuring an independent GitHub environment
reviewer, while making the terminal abandonment operation unreachable.

The activation sequence was reassessed against the deployed workflow states on
2026-08-27. The dependency and release-train reconciliation is specified in
[Release Controller Reconciliation After Main Integration](./2026-08-27-release-controller-main-reconciliation-design.md).

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

Manual dispatch is also ref-sensitive. The release controller deliberately
relays reconciliation to `refs/tags/vX.Y.Z`, so GitHub executes the workflow
graph committed at that tag. Removing abandonment only from `main` would not
disable an older tagged workflow that still contains the protected job. At this
initial cutover the controller namespace is clean: no `v*` controller tag
exists, no nonterminal Release run exists, and the abandonment job has never
reached `main`. Strict evidence must preserve and verify those facts instead of
assuming that the current local workflow is the only reachable graph.

## Goals

- Allow normal reconcile, publish, audit, and verification paths to operate
  without a configured abandonment reviewer.
- Ensure no dispatchable controller tag can start the terminal abandonment job
  or receive that job's write token while the capability is disabled. The
  reconcile coordinator retains its existing narrowly scoped tag writer.
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

This is the only option that both unblocks normal publishing and prevents the
terminal abandonment job from receiving its write token.

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

GitHub executes the workflow version stored at a manual dispatch's branch or
tag. The selected disabled mode is therefore an aggregate property of the exact
deployed default-branch workflow and every controller-owned `v*` tag, not merely
of the local checkout. A workflow file may classify as:

1. **Absent:** the ref has no dispatchable release workflow;
2. **Disabled:** the exact reconcile-only surface described above; or
3. **Protected:** the existing exact abandonment job, environment, gates, and
   executables are all present.

Classification is structural YAML parsing with duplicate-key and alias
rejection. Substring or regular-expression matching is not sufficient. Any
partial topology, unexpected abandonment executable, or malformed workflow is
invalid and fails closed. Different refs may legitimately be disabled or
protected, but the aggregate mode is protected whenever any reachable ref is
protected.

### Owner preflight and evidence

Owner evidence becomes `schemaVersion: 2`. Version 1 evidence is rejected, not
upgraded, because evidence lasts only 15 minutes and can be recaptured. The
owner-preflight report remains schema version 1 because its shape does not
change. `controller-schema.json` remains schema version 1, and the workflow
fixture schema versions remain unchanged.

In addition to the existing exact file hashes and repository checks, v2 evidence
records canonical, sorted proof of ref-aware reachability:

- `github.abandonmentMode` is the explicit aggregate `disabled` or `protected`
  result;
- `github.remoteDefaultBranch` records `refs/heads/main`, its exact commit SHA,
  the release workflow path and SHA-256, and that workflow's structural mode;
- `github.managedCandidateRefs` records the complete paginated `refs/tags/v*`
  inventory, including each ref object, peeled commit SHA, workflow status and
  SHA-256, and structural mode;
- `github.nonterminalReleaseRuns` records the complete bounded query for
  queued, requested, waiting, pending, and in-progress Release runs; and
- `github.abandonmentEnvironment` is canonical `null` only when the aggregate
  mode is disabled, otherwise it is the existing exact environment evidence
  object.

The remote default-branch SHA must equal the evidence HEAD, and its fetched
workflow bytes must equal the locally hashed workflow bytes. Ref enumeration,
workflow retrieval, or run-state retrieval that is incomplete or unreadable is
`UNPROVABLE`, never disabled. Invalid per-ref topology or a mismatch between the
explicit mode, ref evidence, environment evidence, and current bytes is `FAIL`.
Capture aborts without writing evidence when structural classification fails.

For this initial cutover, strict pre-enable and post-enable verification require
the aggregate disabled mode, an empty `managedCandidateRefs` array, and no
nonterminal Release run. Disabled capture makes no GitHub environment request.
Protected classification remains implemented and tested with synthetic exact
workflow bytes for a later reviewed activation; it retains the existing
required-reviewer and prevent-self-review checks.

After protected tags ever exist, their historical workflow graphs remain
dispatchable. The aggregate mode therefore stays protected—and the environment
must remain correctly protected—even if a later `main` workflow removes the
job. An unavailable environment is never reclassified as disabled.

The controller marker keeps
`abandonmentEnvironment: "release-abandonment"`. That field remains part of the
historical evidence format and must not be overloaded as a live feature flag.

### Operational behavior

Normal release activation follows this order:

1. before merge, keep the mutating Release and Publish Chart workflows manually
   disabled while the read-only Published Artifact Verification workflow stays
   active; the Version Packages workflow is not deployed yet;
2. merge the ownership switch containing the disabled release workflow and the
   Version Packages workflow;
3. allow Version Packages to become active and, if its push trigger runs, create
   or update its pull request, but do not merge that pull request;
4. synchronize the local checkout to the exact remote `main` SHA;
5. capture fresh strict pre-enable evidence proving matching local/remote
   workflow bytes, Release and Publish Chart still manually disabled, Published
   Artifact Verification and Version Packages active, zero `v*` controller
   tags, and zero nonterminal Release runs;
6. enable and re-read Immutable Releases;
7. activate Release and Publish Chart, require all four controller workflows to
   be active, and immediately capture strict post-enable evidence at the same
   `main` SHA and unchanged empty ref/run snapshot;
8. run the required no-candidate reconciliation; and
9. only then merge the generated Version Packages pull request and let the
   controller publish, audit, and verify the fixed group.

No `release-abandonment` environment is created during this cutover.

Reactivation is a separate reviewed change. Before restoring the workflow
entrypoint, an owner must configure the protected environment with an
independent reviewer and self-review prevention. The reactivation pull request
must restore the exact workflow contract and pass ref-aware strict owner
evidence in protected mode. Once a protected controller tag exists, that
environment is a permanent protection requirement for the tag's lifetime.

Restoring abandonment on `main` affects only candidates tagged after that
restoration. It cannot retrofit the job into a disabled-era tag. A disabled-era
candidate remains reconcile-capable, but an irrecoverable one is permanently
non-abandonable under this workflow. Supporting terminal recovery for such a
candidate would require a separate reviewed design for a protected
default-branch recovery workflow and revised authority binding. Moving,
deleting, or reusing the immutable candidate tag is never an alternative.

### Failure behavior

Disabled mode has one intentional liveness cost: an irrecoverable tagged
pre-publication candidate cannot be tombstoned. The controller continues to
recover any valid resumable candidate, and an incomplete older candidate still
wins arbitration and blocks newer candidates. Operators must not delete, reuse,
or skip such a version. Simply restoring protected abandonment on `main` does
not change the tagged workflow; a separately designed protected recovery path
would be required.

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
- owner evidence is canonical schema v2 and rejects schema v1 without migration;
- remote `main` SHA and workflow bytes match the exact local HEAD and file;
- complete `v*` ref evidence is sorted, peeled, content-bound, and initially
  empty;
- nonterminal Release run evidence is complete and initially empty;
- disabled mode passes strict pre-enable and post-enable verification;
- pre-enable requires Release and Publish Chart to be manually disabled while
  Published Artifact Verification and Version Packages are active, and
  post-enable requires all four workflows to be active;
- protected mode retains the current exact reviewer requirements;
- disabled, protected, unavailable, and mixed evidence cannot be confused;
- any partial abandonment workflow surface fails closed;
- malformed YAML, duplicate keys, aliases, and placeholder workflow bytes cannot
  pass structural classification;
- existing runtime abandonment authority and tombstone tests remain green;
- the byte-exact `workflow-entrypoints.json` and
  `workflow-safe-executables.json` fixtures are manually transcribed and
  reviewed from the final workflow, including all affected step indexes and run
  bodies; their schema versions do not change;
- release-controller tests, workflow contracts, documentation checks, and the
  full repository validation lane pass at the new exact head.

After the implementation is pushed, GitHub Copilot review is requested again so
it reviews the new head. All Copilot findings are triaged before merge. Copilot
leaves a comment review and is not treated as a required human approval or as a
substitute for the independent release artifact audit.

The same implementation commit updates the live operating contract:

- `docs/superpowers/runbooks/2026-08-09-release-integrity-cutover.md` removes
  the environment prerequisite and runnable abandonment procedure, records
  owner evidence v2, and replaces them with the disabled-mode stop-and-preserve
  incident procedure;
- `docs/thread-handoff.md` states that workflow abandonment is unreachable and
  that the retained parsers support only dormant or historical evidence; and
- the original controller design and PR2 plan receive partial-supersession
  banners pointing to this design rather than having their historical records
  rewritten.

## Rollback and reversibility

Before npm publication, the cutover may stop with the mutating workflows
disabled. After any package publishes, rollback or unpublish is forbidden; the
controller must resume from the exact durable artifacts.

Re-enabling abandonment for future tags requires a new reviewed commit, a
protected environment, and fresh ref-aware owner evidence. It does not alter an
existing tag's workflow bytes. No live setting silently changes the workflow
from disabled to protected mode.
