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
attestation and journal but never creates, adopts, quarantines, or deletes a
tool root.

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
- Fail before mutation when source, state, lease, results, or audit evidence do
  not match the operator's accepted values.
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

## Durable Tool-Root Storage

### Location

Resolve a stable per-user state base as follows:

1. Use `XDG_STATE_HOME` only when it is an absolute path.
2. Otherwise use `<homedir>/.local/state` on every supported host.

The runner owns this subtree:

```text
<state-base>/dawn/dedicated-infrastructure/
  <repo-scope>/
    <run-id>/
      tool-root/
```

`repo-scope` is the lowercase SHA-256 of the canonical repository root. The
full digest avoids cross-repository collisions and keeps repository paths out
of directory names. `run-id` is the already-generated validated run ID. State
and lease continue to record the absolute canonical tool-root path; consumers
must not re-derive it after creation.

The state base is outside a checkout so a worktree removal or `git clean` does
not destroy an active run's credentials and tools. It is outside `tmpdir()` so
a normal reboot or temporary-directory purge does not invalidate the lease.

### Creation and Authentication

The runner creates only its Dawn-owned subtree and uses mode `0700` for every
directory it creates. It does not chmod or adopt pre-existing ancestors. Every
Dawn-owned component must be a real directory, must not be a symbolic link,
and must have the expected owner and private mode before descent. The run
directory and `tool-root` are create-exclusive; any pre-existing final path is
a conflict and aborts bootstrap.

Immediately after creation, the runner writes the existing owner marker with
create-only, mode-`0600`, durable publication. It then records stable identities
for the managed directories and marker in state before downloading tools or
creating a kubeconfig. Failure between directory creation and durable state
publication removes only identities captured by that same allocation attempt.
If identity cannot be revalidated, it preserves the path and fails closed.

Normal cleanup validates the exact path against the recorded durable state
root, repo scope, run ID, owner marker, and captured identities. Quarantine and
erasure remain in the same filesystem and retain the current descriptor-based
and journaled removal protocol. Cleanup may remove the exact run directory once
its exact tool root is gone. It may remove an empty exact repo-scope directory,
but never the shared `dawn/dedicated-infrastructure` root or unrelated runs.

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
run when the normal runtime-integrity sidecar is absent. Its first action is a
stable read of its own source followed by comparison with
`accepted-runner-sha256`. It captures the source identity and bytes and
revalidates them immediately before every durable mutation. This guards
against accidental or concurrent source replacement; it is not a claim that
self-verification defeats an adversarially modified program.

The other accepted hashes are operator authorization, not values discovered
and silently trusted by the command. The prior audit must be a stable regular
file directly contained by the exact run root or a descendant reached without
symlinks. Reconciliation does not parse prose from that audit as authority; it
retains its exact path, identity, and digest as supporting evidence.

### Required State Shape

Before publishing a journal, reconciliation must prove all of the following:

- state and lease are stable regular files at their canonical expected paths;
- their run ID, owner nonce, repository root, run root, tool root, state path,
  and creation timestamp agree exactly;
- the state, results files, lease, and prior audit match all accepted hashes;
- `finalizedAt` is null;
- shared bootstrap has exactly one terminal failed attempt with a
  bootstrap/environment classification;
- Kubernetes bootstrap and Docker bootstrap have no attempts and are still in
  their initial states;
- all six lanes are blocked by that shared-bootstrap failure and have no
  attempts;
- no cluster, image, registry process, retention, or registered-fix ownership
  is recorded;
- no ordinary cleanup journal exists;
- no process owned by the current user references the run ID, run root, or tool
  root; and
- the exact recorded tool-root path is absent in repeated stability probes.

The absence probes use stable parent-directory inspection rather than a single
`existsSync` result. They run at entry, after all evidence reads, before and
after attestation publication, before state finalization, and immediately
before lease removal. A reappearing path of any type aborts without deletion.
The command does not invoke Docker, Kind, kubectl, Helm, a registry, downloads,
or any production resource cleanup path because the accepted state proves that
resource creation never began.

Any mismatch preserves all protected files and the active lease. An existing
ordinary cleanup transaction or any state beyond the exact pre-resource shape
must be handled by normal authenticated cleanup or human investigation.

## Attestation and Journal

Reconciliation writes two mode-`0600` files under the exact run root:

- `absent-tool-root-attestation.json`
- `cleanup-journal.json`

The attestation is create-only and includes:

- schema version, transaction ID, run ID, owner nonce, and repository identity;
- exact state, results, lease, and prior-audit paths, identities, and accepted
  hashes;
- the expected absent tool-root path;
- first and last absence observation timestamps;
- the accepted runner hash and captured source identity;
- the prior audit's identity and digest;
- the fixed conclusion `externally-absent-before-reconciliation`;
- the fixed cause `unproven`; and
- explicit statements that no root was created, adopted, quarantined, erased,
  or removed by the transaction.

The cleanup journal uses a new schema and an action named
`reconcile-externally-absent-pre-resource`. This action has no tool-root,
arena, payload, or owner-marker removal identities. Its allowed phases are:

1. `intent`
2. `absence-attested`
3. `state-finalized`
4. `lease-removed`

Journal transitions use the runner's existing create-only temporary file,
atomic rename, file sync, and parent-directory sync protocol. The expected
attestation body and digest, finalization timestamp, exact final state body, and
final state digest are committed in `intent` before the attestation is
published. Replays accept only exactly matching journal, attestation, and state
content for the same transaction. A malformed, extra-field, wrong-action, or
out-of-order journal fails closed.

The transaction performs these mutations in order:

1. Publish `intent` after all entry checks.
2. Publish and durably sync the attestation.
3. Revalidate all immutable evidence and absence, then advance to
   `absence-attested`.
4. Persist the existing exact pre-resource final state using the normal state
   publication protocol. Only finalization and cleanup outcome fields may
   change; lane attempts and ownership inventories remain unchanged.
5. Re-read and authenticate the persisted final state, then advance to
   `state-finalized`.
6. Revalidate source, journal, attestation, immutable evidence, exact lease,
   and root absence. Unlink only the exact captured lease identity and sync its
   parent.
7. Prove the lease is absent and advance to `lease-removed`.

The attestation and completed journal remain as evidence. Reconciliation never
deletes the prior audit, state, results, or transaction records.

## Replay and Concurrency

The existing orchestrator lock remains mandatory. Reconciliation captures the
lock before reading mutable control state and refuses a second controller.
Every replay derives authority from the accepted command arguments and the
already-published exact journal; it does not broaden authority based on the
current filesystem. Before `state-finalized`, the state must match the accepted
initial digest. At or after `state-finalized`, it must instead match the exact
final body and digest committed by `intent`. The accepted state hash always
names the reviewed pre-transaction evidence and does not change between replay
attempts.

If interruption occurs:

- before `intent`, no mutation occurred;
- after `intent`, replay verifies all accepted initial evidence and republishes
  or verifies the exact attestation;
- after `absence-attested`, replay may finalize only the exact state committed
  by the journal;
- after `state-finalized`, replay verifies that final state before touching the
  lease; and
- after lease unlink, replay proves the exact lease is absent before committing
  `lease-removed`.

At every phase, tool-root reappearance, source replacement, evidence mutation,
lock loss, journal replacement, attestation replacement, or lease replacement
stops replay. No rollback deletes evidence or recreates the root.

## Type and Code Boundaries

Keep the implementation inside the existing controller and split the new
logic into narrow internal units:

- state-home resolution and durable tool-root allocation;
- durable-root path and identity authentication;
- reconciliation option parsing;
- exact pre-resource state validation;
- stable accepted-evidence capture and revalidation;
- absence attestation construction and validation; and
- reconciliation transaction publication and replay.

Use discriminated unions so each cleanup action has only its valid fields and
phases. The normal removal action retains removal identities; the preserved
unauthenticated action retains preservation evidence; the reconciliation
action cannot represent removal authority. Parsers reject unknown keys and
invalid action/phase combinations. No compatibility union for obsolete
journal schemas is required.

## Test Strategy

Follow test-driven development and run every test against isolated fixtures,
never the active production run.

### Durable Root Tests

- resolves absolute `XDG_STATE_HOME` and falls back for absent or relative
  values;
- scopes two canonical repositories to different full hashes;
- produces the same root after a simulated reboot or changed `TMPDIR`;
- creates private, non-symlink directories and a durable owner marker;
- rejects pre-existing run roots, symlinks, wrong owners, permissive modes,
  identity swaps, and path escapes;
- removes only exact captured identities on allocation rollback;
- authorizes normal cleanup only under the recorded state root and repo scope;
- removes the exact empty run directory without touching sibling runs; and
- preserves paths on any identity or durability uncertainty.

### Reconciliation Tests

- starts red with the exact stale pre-resource fixture and absent tool root;
- rejects every missing, duplicate, malformed, or mismatched accepted option;
- rejects state, result, lease, audit, source, and file-identity changes;
- rejects a prior audit outside the run root or reached through a symlink;
- rejects each deviation from the exact pre-resource shape;
- rejects any process residue and any root that exists or reappears;
- proves no filesystem deletion primitive or resource command is reachable;
- writes a complete create-only attestation with cause `unproven`;
- fault-injects before and after every journal publication, state publication,
  attestation publication, and lease unlink;
- restarts in a new process from every durable phase and reaches the same final
  bytes;
- rejects malformed, replaced, wrong-action, and out-of-order replay records;
- confirms finalization changes no lane attempts or ownership inventory;
- removes only the exact lease identity after final-state authentication; and
- leaves the completed attestation and journal intact.

Run focused tests repeatedly under Node 24, strict TypeScript with
`exactOptionalPropertyTypes`, and scoped Biome. Then run the controller's full
test suite, its contention and process-lifecycle stress loops, and independent
spec-compliance and code-quality reviews.

## Operational Acceptance

After implementation and review:

1. Record fresh hashes and identities for the protected stale state, results,
   lease, accepted runner, and final read-only audit.
2. Run the reconciliation command once with those exact accepted values.
3. Inspect the completed attestation, journal, final state, and absent lease.
4. Confirm no Docker, Kubernetes, registry, process, socket, or temporary
   residue was created or removed by reconciliation.
5. Start a fresh run and confirm its tool root is under the durable state base.
6. Execute the full dedicated infrastructure ladder sequentially.
7. Confirm normal finalization removes only the fresh run's exact durable tool
   root and active lease while retaining run evidence.
8. Rebase the branch on current `main`, run the repository Definition of Done,
   open a pull request, and merge only after required checks are green.

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

Per-repository scoping by canonical path means moving a checkout changes the
scope for future runs. Active state still records the original absolute root,
so its exact cleanup remains possible; the runner does not search other scopes
or adopt them.

Finally, self-hash verification is an integrity check against mistakes and
concurrent replacement, not a cryptographic trust anchor against malicious
code already executing as the user. The operator must independently inspect
and accept the runner hash before invoking reconciliation.
