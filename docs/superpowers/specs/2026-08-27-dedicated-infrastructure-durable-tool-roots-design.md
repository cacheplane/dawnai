# Dedicated Infrastructure Durable Tool Roots and Absent-Root Reconciliation

**Date:** 2026-08-27

## Summary

The dedicated infrastructure runner currently stores durable run state and its
active lease under the repository, but creates its tool root under the
operating system temporary directory. A reboot can therefore remove the tool
root while leaving an active lease that normal cleanup correctly refuses to
finalize. This design aligns those lifetimes for future runs and adds one
fail-closed recovery transaction for the already-observed pre-resource case.

Future tool roots live in private per-user state storage until their run is
finalized. Normal cleanup keeps its existing exact-ownership requirement. A
separate `reconcile-absent-pre-resource` command can finalize a run only when
the accepted runner and all protected evidence match operator-supplied hashes,
the state has the exact pre-resource failure shape, and the recorded tool root
remains absent through repeated checks. Reconciliation writes a durable
attestation and append-only phase chain but never creates, adopts, quarantines,
or deletes a tool root.

This is hardening for the local evidence runner. It does not add a product API,
CI command, or general-purpose abandoned-run garbage collector.

## Problem

The current runner creates a tool root with
`mkdtemp(join(tmpdir(), "dawn-infra-tools-"))`. The root contains downloaded
tools, the kubeconfig, ownership metadata, and the runtime-integrity sidecar.
The run state, results, and global active-run lease instead live under
`artifacts/testing/dedicated-infrastructure/`.

Those locations have different durability. On the current stale run, the
shared bootstrap failed before Kubernetes, Docker, registry, or lane resources
were created. The repository evidence and lease survived a host reboot, while
the temporary tool root disappeared. The cause of that disappearance is not
provable from the retained evidence. Normal cleanup must continue to reject the
missing root because absence alone cannot authenticate deletion or prove that
an arbitrary active run is safe to finalize.

The runner also validates its normal commands through a sidecar stored inside
the missing tool root. The recovery path therefore needs an explicit,
operator-accepted source hash instead of silently bypassing the integrity
boundary.

## Goals

- Give future tool roots at least the same lifetime as their active leases.
- Preserve exact owner, path, device/inode, mode, and marker checks for normal
  cleanup.
- Finalize the one valid externally absent pre-resource state without
  inventing ownership evidence or granting deletion authority.
- Make interrupted reconciliation replayable from every durable phase.
- Retain a reviewable attestation of what was proved and what remains unknown.
- Fail before durable scaffold or lock creation when the initial source, state,
  lease, results, or audit evidence does not match the operator's accepted
  values, and revalidate it before every authoritative transaction mutation.
- Exercise the change with deterministic fault injection and process-restart
  tests before using it on the stale run.

## Non-goals

- Recovering or deleting a tool root that still exists but lacks valid owner
  metadata.
- Finalizing runs that reached resource creation, contain retained resources,
  or have ambiguous lane attempts.
- Inferring that a reboot, operating-system purge, test, or person removed the
  old root. The attestation records the cause as unproven.
- Supporting arbitrary historical state, lease, integrity, or cleanup-journal
  schemas. There is no backwards-compatibility requirement.
- Scanning user state for abandoned runs or adding automatic time-based
  cleanup.
- Changing the checked-in infrastructure workflows or exposing the local
  evidence runner as a supported Dawn CLI surface.

## Decision

Implement two narrow mechanisms in the existing run-local controller:

1. A durable tool-root allocator for all new runs.
2. A distinct, no-delete reconciliation transaction for an exact absent
   pre-resource run.

Do not make normal cleanup treat a missing root as success. That would erase
the ownership distinction the existing cleanup hardening established. Do not
recreate the missing legacy root or forge its owner marker or integrity
sidecar. Those approaches manufacture evidence and could authorize deletion of
content the runner never proved it owned.

## Durable Control and Tool Storage

### Location

Resolve the state base once from `os.userInfo()` for the effective user, then
canonicalize that returned home directory:

```text
<canonical-home>/.local/state
```

There is no environment override. In particular, `XDG_STATE_HOME`, `HOME`, and
`TMPDIR` cannot redirect an active run's control state. The runner rejects a
home or state base that equals or descends from the canonical operating-system
temporary directory, `/tmp`, or `/private/tmp`. This bounds the durability
claim to a normal persistent user home; it does not claim survival from user,
administrator, disk, or backup-policy deletion.

The runner owns this subtree:

```text
<state-base>/dawn/dedicated-infrastructure/
  <checkout-scope>/
    repository.json
    locks/
    lease-events/
    runs/
      <run-id>/
        control.json
        tool-root/
        cleanup-transaction/
```

`checkout-scope` is the lowercase SHA-256 of the canonical repository root, a
NUL separator, and the canonical Git common-directory path. The full digest
avoids cross-repository collisions and keeps paths out of directory names.
`repository.json` binds those canonical paths to their captured filesystem
identities. Recreating a different checkout at the same path cannot adopt the
scope when the Git common-directory identity differs. Moving a checkout creates
a different scope; the runner never searches for or adopts old scopes.

`run-id` is the already-generated validated run ID. The durable `control.json`
records the run ID, owner nonce, repository and run roots, state path, tool-root
path, owner-marker identity, and initial state digest before credentials or
downloaded tools are created. Repository state records the same absolute
canonical tool-root and control-record paths. Consumers use recorded paths and
must not re-derive them after allocation.

The control record, tool root, lock generations, and authoritative lease events
are outside the checkout. Removing a worktree or running `git clean` therefore
does not leave credentials with no authenticated recovery locator. A human can
enumerate the private checkout scopes and inspect `repository.json` and
`control.json`; automatic cross-scope adoption remains forbidden.

Future runs stop creating `artifacts/testing/dedicated-infrastructure/active-run.json`.
That legacy file is accepted only as explicitly hashed evidence for the current
reconciliation. It is never deleted or overwritten by the new controller.

### Creation and Authentication

Starting from a stable descriptor for the canonical home, the runner creates
and descends through each managed component with its existing descriptor-bound
operation seam. It uses mode `0700` for every directory it creates and does not
chmod or adopt pre-existing ancestors. Every component from `.local` through
the run directory must be a real directory, not a symbolic link, owned by the
current effective user, and not group- or world-writable. Each identity is
revalidated around descent. Unavailable no-follow semantics, an identity swap,
or an ownership ambiguity fails closed.

The checkout-scope, run directory, `control.json`, and `tool-root` are created
through create-exclusive operations. A matching pre-existing checkout scope is
reused only after exact `repository.json` authentication. Any pre-existing run
ID is a conflict and aborts bootstrap.

Immediately after tool-root creation, the runner writes the existing owner
marker with create-only, mode-`0600`, durable publication. It then writes the
create-only durable control record and a create-only `acquired` lease event,
syncing each file and parent directory before downloading tools or creating a
kubeconfig. The repository state is published only after those durable records
exist. Before the `acquired` event exists, an unambiguous allocation failure may
retire only empty create-exclusive identities captured by that attempt. After
the event exists, no allocation rollback removes the tool root or control
record; the run remains active for normal authenticated cleanup. If any
identity or publication result is ambiguous, the path and control records
remain for manual recovery and the run fails closed.

Lease events are immutable, create-exclusive JSON records with a monotonic
generation, predecessor digest, checkout identity, run identity, owner nonce,
control-record digest, timestamp, and event kind. The authoritative active run
is the latest valid hash-linked event: `acquired` makes its run active and
`finalized` retires that same acquisition. Gaps, forks, replacements, malformed
events, or more than one valid successor are conflicts. Events are retained;
normal cleanup does not unlink an active-lease file.

Normal cleanup validates the exact path against the durable control record,
checkout scope, run ID, owner marker, and captured identities. Quarantine and
erasure remain in the same filesystem and retain the current descriptor-based
and journaled removal protocol. Only a normal-cleanup journal proving this
controller authenticated and removed the exact tool root authorizes a
create-only `finalized` lease event. Mere root absence never authorizes parent
cleanup or lease retirement.

The run directory and durable control record remain as recovery evidence after
normal cleanup. The controller removes neither the checkout-scope directory nor
shared state ancestors. A later retention feature may be designed separately;
this change grants no authority to scavenge old control records.

Changing `TMPDIR` between bootstrap, status, and cleanup must have no effect on
the path or its authorization.

## Reconciliation Authority

### Command Surface

Add a dedicated command:

```text
reconcile-absent-pre-resource \
  --accepted-runner-sha256 <sha256> \
  --accepted-state-sha256 <sha256> \
  --accepted-results-json-sha256 <sha256> \
  --accepted-results-tsv-sha256 <sha256> \
  --accepted-lease-sha256 <sha256> \
  --prior-audit <absolute-path-under-run-root> \
  --accepted-prior-audit-sha256 <sha256>
```

All options are required and must occur exactly once. Hashes are lowercase
64-character hexadecimal values. The command is the only entrypoint allowed to
run when the normal runtime-integrity sidecar is absent.

The reconciler remains a single source file with no mutable local imports. Its
canonical path is exactly `<run-root>/infra-runner.ts`, reached without
symlinks. Top-level execution for this command may parse arguments and declare
functions but performs no filesystem or process mutation until it has opened,
stably read, and matched that exact file to `accepted-runner-sha256`. It captures
the source identity and bytes and revalidates them immediately before every
durable mutation. The acceptance procedure also verifies the hash externally
before launch. This guards against mistakes and concurrent source replacement;
it is not a claim that a program can establish trust in adversarial code that
is already executing as the user.

The other accepted hashes are operator authorization, not values discovered
and silently trusted by the command. The prior audit must be a stable regular
file directly contained by the exact run root or a descendant reached without
symlinks. Reconciliation does not parse prose from that audit as authority; it
retains its exact path, identity, and digest as supporting evidence.

Before any durable mutation, the command performs a preliminary stable read and
validation of the complete accepted source and evidence set, exact state shape,
results projections, and tool-root absence. It repeats those checks after lock
acquisition and before `intent`; the preliminary pass provides fail-fast
behavior, while the locked pass provides transaction authority.

Before locking, reconciliation may create only the private checkout-scope
directory, its exact `repository.json`, and the lock directory needed to
serialize controllers. After lock acquisition it may create the exact legacy
run directory and an empty `cleanup-transaction` directory. It never creates
`tool-root` or a future run's `control.json`. A crash before `intent` is
replayable only when those directories and repository marker have the exact
identities and content captured by the same allocation attempt and the
transaction directory contains no records. Conflicting or extra content fails
closed and is never removed. The subsequent `intent` is the legacy run's
durable control record.

### Required State Shape

Before publishing an intent record, reconciliation must prove all of the
following:

- runner, state, results JSON, results TSV, and legacy lease are stable
  mode-`0600` regular files at their exact canonical paths; the prior audit is a
  stable regular file owned by the current user and not group- or
  world-writable; every path is reached without symlinks, with identities
  captured before and revalidated after each read;
- their run ID, owner nonce, repository root, run root, tool root, state path,
  and creation timestamp agree exactly;
- the state, results files, lease, and prior audit match all accepted hashes;
- parsed `results.json` is canonically equal to `state.results`, and
  `results.tsv` is exactly the runner's deterministic TSV projection of those
  results;
- `finalizedAt` is null;
- shared bootstrap has exactly one terminal failed attempt with a
  bootstrap/environment classification;
- Kubernetes bootstrap and Docker bootstrap have no attempts and are still in
  their initial states;
- all six lanes are blocked by that shared-bootstrap failure and have no
  attempts;
- no cluster, image, registry process, retention, or registered-fix ownership
  is recorded;
- no ordinary cleanup journal or durable lease event already exists for this
  legacy run;
- the recorded active registry PID is null and a best-effort diagnostic scan
  finds no matching known run process in the current process table; and
- the exact recorded tool-root path is absent in repeated stability probes.

The absence probes use descriptor-bound, stable parent-directory inspection
rather than a single `existsSync` result. They run at entry, after all evidence
reads, before and after attestation publication, before state finalization, and
immediately before legacy lease retirement. A reappearing path of any type
aborts without deletion.

The accepted state proves only that it records no resource attempt or owned
resource. It cannot prove that no historical command ran before an interrupted
state write, and a process-table scan cannot prove the absence of inherited
file descriptors. The prior audit and accepted hashes are explicit
operator-reviewed authority for proceeding with this one run. The attestation
states those limits. The reconciliation implementation itself has no Docker,
Kind, kubectl, Helm, registry, download, tool-root creation, quarantine,
erasure, or removal dependency, so it can prove that it initiates none of those
operations.

Any mismatch preserves all protected files and the active lease. An existing
ordinary cleanup transaction or any state beyond the exact pre-resource shape
must be handled by normal authenticated cleanup or human investigation.

## Attestation and Journal

Reconciliation writes authoritative mode-`0600` records under the exact
durable run-control directory:

```text
cleanup-transaction/
  absent-tool-root-attestation.json
  00-intent.json
  01-absence-attested.json
  02-state-finalized.json
  staging/

lease-events/
  <generation>-legacy-lease-retired.json
```

After completion it may write a create-only copy of the attestation under the
repository run root for convenient review. That copy is evidence only; replay
and lease authority come from the durable records.

The attestation is create-only and includes:

- schema version, transaction ID, run ID, owner nonce, and repository identity;
- exact state, results, lease, and prior-audit paths, identities, and accepted
  hashes;
- the expected absent tool-root path;
- initial and pre-attestation absence observation timestamps;
- the accepted runner hash and captured source identity;
- the prior audit's identity and digest;
- the fixed conclusion `operator-reviewed-pre-resource-state-with-absent-tool-root`;
- the fixed cause `unproven`; and
- explicit statements that the historical absence of all unrecorded resources
  is not proven and that no root or resource was created, adopted, inspected
  through a production tool, quarantined, erased, or removed by the
  transaction.

The phase records use a new schema and an action named
`reconcile-externally-absent-pre-resource`. This action has no tool-root,
arena, payload, owner-marker, or unlink identity. Its allowed phases are:

1. `intent`
2. `absence-attested`
3. `state-finalized`
4. `legacy-lease-retired`

Each phase has its own create-exclusive file. The terminal lease event is also
the `legacy-lease-retired` phase; no second completion file is published. A
record contains its ordinal, phase, transaction and run identities,
predecessor filename and digest, the digest of the immutable intent payload,
and the phase-specific evidence.

The publisher writes complete bytes to a create-exclusive file under
`staging/` whose name is bound to the active lock generation and target phase,
then syncs it. It publishes those same bytes into the absent final name with a
create-exclusive hard link and syncs the transaction directory. Staging files
are never authority and are never deleted. A staging file left by a dead lock
generation is accepted only as retained residue bound to that authenticated
retired generation; replay creates a new stage under its own generation. If
hard-link publication is unavailable, the command fails before advancing. If
the final name already exists, the runner accepts only its stable exact
expected content and identity. It never overwrites a phase file.

`intent` commits the accepted arguments; all initial evidence paths,
identities, and digests; the expected attestation body and digest; the fixed
finalization timestamp; the exact final `RunState` body formed by changing only
`finalizedAt`; its digest; and the expected legacy lease identity and digest.
Later reconciliation records hash-chain to it. The terminal lease event records
both the `state-finalized` record digest and the preceding lease-event digest,
or an explicit null lease predecessor when retiring the accepted legacy lease
as the first durable event. Replays accept only the unique contiguous chain
for the same transaction. Gaps, forks, extra records, malformed fields,
wrong-action records, and out-of-order records fail closed.

The transaction performs these mutations in order:

1. Create and durably publish `intent` after all entry checks.
2. Publish and durably sync the attestation.
3. Revalidate all immutable evidence and absence, then advance to
   `absence-attested`.
4. Persist the existing exact pre-resource final state using the normal state
   publication protocol. Only `finalizedAt` changes; results, lane attempts,
   cleanup statuses, and ownership inventories remain unchanged.
5. Re-read and authenticate the exact intent-committed final state, capture its
   stable post-publication identity, and advance to `state-finalized`.
6. Revalidate source, the complete phase chain, attestation, immutable
   evidence, exact legacy lease, final state, and root absence. Publish the
   `legacy-lease-retired` event in the durable lease ledger. That event binds
   the accepted legacy lease path, identity, and digest to this completed
   transaction and supersedes it for the new controller without modifying it.
7. Re-read the lease ledger and prove that the unique latest event retires this
   exact legacy acquisition.

The legacy `active-run.json`, attestation, and completed phase chain remain as
evidence. Reconciliation never deletes or overwrites the prior audit, state,
results, lease, or transaction records.

## Replay and Concurrency

### Crash-Recoverable Lock

All future controller commands and reconciliation use append-only lock
generations under the durable checkout scope. Acquisition atomically creates a
directory whose strictly validated basename encodes the generation, PID,
platform-specific process birth identity, and random nonce. Its planned
metadata includes the predecessor-retirement digest, run and transaction
identities, and verified source digest. A metadata file is then published
create-only inside the directory.

The directory name is the crash floor: even if death occurs before metadata is
complete, replay can identify the exact process generation without trusting
partial content. A live exact PID and birth identity always causes a second
controller to fail. A malformed directory name, duplicate generation, or
unexpected entry fails closed.

Normal command completion appends a create-exclusive `released` record bound to
the active lock generation; it does not delete the lock. A crash leaves the
generation without that release record and enters stale-lock recovery.

After a process death, the lock file remains. A new controller may retire it
only after all of these checks:

- stable authentication of the lock directory, its name, checkout scope, and
  predecessor chain; complete metadata must also authenticate the source and
  transaction, while missing or partial metadata is preserved as crash residue;
- a definitive platform probe that the exact PID/birth-identity pair is no
  longer alive;
- create-exclusive publication of the unique next-generation takeover claim;
  and
- append-only publication of a retirement record bound to the stale lock's
  path, directory identity, recursively bounded inventory digest, and takeover
  nonce.

An unavailable, permission-denied, malformed, or ambiguous liveness result
refuses takeover. Lock records are never blindly deleted or overwritten. Two
replayers racing for the same generation cannot both publish the
create-exclusive takeover claim; the loser re-reads the chain and fails while
the winner is live. The existing descriptor-bound retirement protocol performs
all path operations relative to authenticated parent identities.

### Phase Matrix

Every replay derives authority from the accepted command arguments and the
already-published exact intent; it does not broaden authority based on current
filesystem contents. The accepted state hash always names the reviewed initial
state and remains the same across replay attempts.

| Highest durable phase | Accepted state | Accepted legacy lease | Next action |
|---|---|---|---|
| none | exact accepted initial body, hash, and identity | exact accepted body, hash, and identity | publish `intent` |
| `intent` | exact initial state only | exact accepted lease | publish or authenticate attestation |
| `absence-attested` | exact initial state, or exact intent-committed final body after a crash between state publication and phase publication | exact accepted lease | publish final state if initial; otherwise capture final identity; then publish `state-finalized` |
| `state-finalized` | exact final body and the identity recorded by that phase | exact accepted lease | publish the terminal durable lease event |
| `legacy-lease-retired` | exact final body and recorded identity | exact accepted lease, or absent; any replacement conflicts | verify the complete reconciliation and lease chains and return success |

At `absence-attested`, any state content other than the exact accepted initial
body or exact intent-committed final body is a conflict. If the final body is
already present, replay captures and revalidates its stable identity before
publishing `state-finalized`. At `state-finalized`, a different final-state
identity is a replacement even when its content matches.

The terminal lease event is create-exclusive and no legacy lease unlink occurs,
so there is no post-unlink ambiguity. If process death occurs after terminal
event publication but before return, replay authenticates that exact event as
the highest phase and completes without another mutation.

If interruption occurs:

- before `intent`, no mutation occurred;
- after `intent`, replay verifies all accepted initial evidence and republishes
  or verifies the exact attestation;
- after `absence-attested`, replay may finalize only the exact state committed
  by `intent`;
- after `state-finalized`, replay verifies that final state before touching the
  lease ledger; and
- after terminal lease-event publication, replay verifies that exact event and
  performs no further mutation.

At every phase, tool-root reappearance, source replacement, evidence mutation,
lock loss, phase-chain replacement, attestation replacement, or legacy lease
replacement stops replay. No rollback deletes evidence or recreates the root.

## Type and Code Boundaries

Keep the implementation inside the existing controller and split the new
logic into narrow internal units:

- fixed state-home resolution, checkout-scope authentication, and durable
  control/tool-root allocation;
- durable lease-event parsing and active-run resolution;
- crash-recoverable lock acquisition and authenticated stale-lock retirement;
- durable-root path and identity authentication;
- reconciliation option parsing;
- exact legacy pre-resource state validation;
- stable accepted-evidence capture and revalidation;
- absence attestation construction and validation; and
- append-only phase publication and reconciliation replay.

Define an exact `LegacyReconciliationState` parser for schema-version-1 state
used only by `reconcile-absent-pre-resource`. It accepts the current reviewed
shape and produces a final body by changing only `finalizedAt`. It is not a
general legacy reader. Define schema-version-2 state for future runs with exact
durable checkout-scope, control-record, and lease-acquisition references.
Normal commands accept only schema version 2 after migration.

Every protected file has a typed evidence descriptor containing its exact path,
expected mode policy, filesystem identity, content digest, and stable bytes.
The intent payload discriminates initial state evidence from its deterministic
final-state body. Results JSON and TSV descriptors additionally carry their
validated relationship to `RunState.results`.

Use discriminated unions so each cleanup action has only its valid fields and
phases. The normal removal action retains removal identities; the preserved
unauthenticated action retains preservation evidence; the reconciliation
action cannot represent removal authority. Parsers reject unknown keys and
invalid action/phase combinations.

The append-only phase publisher is shared by normal cleanup and reconciliation.
Normal cleanup keeps its removal phases; reconciliation uses only the four
phases in this design. All actions use immutable create-exclusive files and
hash links instead of replace-in-place `cleanup-journal.json`. No compatibility
union for obsolete journal schemas is required, and the stale run has no
existing journal to migrate.

## Test Strategy

Follow test-driven development and run every test against isolated fixtures,
never the active production run.

### Durable Root Tests

- ignores `HOME`, `XDG_STATE_HOME`, and `TMPDIR` redirection after canonical
  home resolution and rejects a home or state path under known temporary roots;
- scopes different canonical checkout and Git common-directory identities to
  different full hashes;
- produces the same root after a simulated reboot or changed `TMPDIR`;
- creates private, non-symlink directories, a durable repository marker,
  control record, owner marker, and acquired lease event;
- rejects pre-existing run roots, symlinks, wrong owners, permissive modes,
  identity swaps, checkout recreation with a different Git identity, hash-chain
  forks, and path escapes;
- preserves a discoverable durable control record when the checkout disappears;
- removes only exact captured identities on unambiguous allocation rollback and
  preserves the complete control record on ambiguity;
- authorizes normal cleanup only under the recorded state root and checkout
  scope;
- proves root absence alone cannot retire a lease or remove a parent;
- publishes a `finalized` lease event only after authenticated exact root
  removal; and
- preserves paths on any identity or durability uncertainty.

### Lock and Journal Tests

- proves a live exact PID and process-birth identity excludes a second
  controller;
- kills the lock holder before and after every durable phase and proves an
  exact dead-process takeover can continue;
- kills lock acquisition before, during, and after metadata publication and
  proves the validated directory name is sufficient for fail-closed recovery;
- refuses stale takeover for PID reuse, permission errors, uncertain liveness,
  wrong source, malformed records, missing predecessors, and identity swaps;
- races multiple takeover attempts and proves only one next generation exists;
- races phase publication with a conflicting final file and proves no existing
  record is overwritten;
- validates create-exclusive hard-link publication, file sync, directory sync,
  retained lock-scoped staging residue, and restart recovery at each boundary;
- runs normal-removal, preserved-root, and reconciliation action/phase unions
  through the shared append-only publisher.

### Reconciliation Tests

- starts red with the exact stale pre-resource fixture and absent tool root;
- rejects every missing, duplicate, malformed, or mismatched accepted option;
- rejects state, result, lease, audit, source, state-schema, and file-identity
  changes;
- rejects a noncanonical runner path, mutable helper import, or source closure
  that differs from the single accepted file;
- rejects `results.json` that differs from `state.results` and any TSV that is
  not the exact deterministic projection;
- rejects a prior audit outside the run root or reached through a symlink;
- rejects each deviation from the exact pre-resource shape;
- rejects a recorded registry PID and records the bounded process scan as
  diagnostic evidence without claiming it proves descriptor absence;
- rejects any root that exists or reappears;
- proves no filesystem deletion, tool-root creation, or resource-command
  dependency is reachable;
- writes a complete create-only attestation with cause `unproven`;
- fault-injects before and after every phase publication, state publication,
  attestation publication, and terminal lease-event publication;
- restarts in a new process from every durable phase and reaches the same final
  bytes;
- covers both exact state bodies in the post-publication/pre-phase crash window
  and rejects every third body or post-phase identity replacement;
- rejects malformed, replaced, forked, wrong-action, and out-of-order replay
  records;
- confirms finalization changes only `finalizedAt`;
- leaves the accepted legacy lease unchanged while publishing exactly one
  terminal retirement event; and
- leaves the completed attestation and phase chain intact.

Run focused tests repeatedly under Node 24, strict TypeScript with
`exactOptionalPropertyTypes`, and scoped Biome. Then run the controller's full
test suite, its contention and process-lifecycle stress loops, and independent
spec-compliance and code-quality reviews.

## Operational Acceptance

After implementation and review:

1. Record fresh hashes and identities for the protected stale state, results,
   lease, accepted runner, and final read-only audit. Verify the accepted runner
   hash in a separate process before launch.
2. Run the reconciliation command once with those exact accepted values.
3. Inspect the completed attestation, phase chain, final state, unchanged legacy
   lease, and terminal durable lease event.
4. Confirm reconciliation invoked no Docker, Kubernetes, registry, download,
   tool-root creation, quarantine, erasure, or removal operation.
5. Rebase the branch on current `main` and reassess the checked-in workflows,
   compatibility pins, chart topology, and known merge conflicts.
6. Start a fresh run, confirm its tool root and control index use the durable
   state base, and execute the full dedicated infrastructure ladder
   sequentially.
7. Confirm normal finalization removes only the fresh run's exact durable tool
   root, appends its exact `finalized` lease event, and retains control and run
   evidence.
8. Run the repository Definition of Done, open a pull request, merge only after
   required hosted Linux checks are green, and verify the merged revision.

## Drawbacks and Trade-offs

Durable state can survive a crash indefinitely, so an interrupted run may leave
downloaded binaries and credentials on disk until authenticated cleanup is
resumed. This is preferable to losing the evidence needed to retire an active
lease. Private modes, exact ownership checks, and no automatic scavenger bound
the risk.

The reconciliation command is intentionally verbose. Requiring independent
accepted hashes makes operator authorization visible and prevents the command
from treating whatever it reads as trusted truth. It also means genuine
evidence changes require a new review rather than a convenience flag.

Per-checkout scoping means moving a checkout or Git common directory changes the
scope for future runs. The durable repository and control records keep the old
run discoverable for exact manual recovery, but the runner does not search
other scopes or adopt them automatically.

Append-only locks, phase records, and lease events consume a small amount of
state after every run. Retaining them is the mechanism that makes replay and
retirement authority auditable without unsafe compare-then-unlink operations.
Automatic compaction or garbage collection is deliberately deferred.

Finally, self-hash verification is an integrity check against mistakes and
concurrent replacement, not a cryptographic trust anchor against malicious
code already executing as the user. The operator must independently inspect
and accept the runner hash before invoking reconciliation.
