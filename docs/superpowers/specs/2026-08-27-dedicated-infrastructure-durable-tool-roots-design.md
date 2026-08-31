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
the accepted reconciler and all protected evidence match operator-supplied hashes,
the state has the exact pre-resource failure shape, and the recorded tool root
remains absent through repeated checks. Reconciliation writes a durable
attestation and append-only phase chain but never creates, adopts, quarantines,
or deletes a tool root.

This is hardening for the local evidence runner. It does not add a product API,
CI command, or general-purpose abandoned-run garbage collector.

### Platform Support Amendment

Authoritative filesystem mutation in this v1 design is supported only on Linux
when `/proc/self/fd/<fd>` is present and independently proved to be a traversable
view of the captured directory descriptor. Node.js 24 exposes neither the
`openat` family nor child operations on a directory `FileHandle`. On Darwin,
`/dev/fd/<fd>` identifies the open directory but is not traversable for child
operations, so the controller must fail before its first authoritative
filesystem mutation. Darwin remains supported for pure resolution, parsing,
identity, and no-mutation failure tests.

There is no pathname-based Darwin fallback. Such a fallback would reintroduce a
swap window between authentication and mutation and invalidate the descriptor-
authority guarantees below. Native Darwin support requires a separately
reviewed `openat`-family binding or helper whose executable and loading closure
become part of the accepted authority boundary.

The protected stale run was created on Darwin. Its accepted filesystem
identities cannot be copied to Linux without changing the evidence being
authenticated, so this design does not reconcile it on the current host. That
one-time operation remains deferred and its protected evidence remains
untouched until native Darwin descriptor-relative mutation is designed and
reviewed. Linux implementation and acceptance must use synthetic fixtures and
fresh Linux-native runs only.

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

Reconciliation resolves the Git common directory without launching Git: it
stably reads either the checkout's real `.git` directory or its strict
single-line `gitdir:` indirection, then the optional strict `commondir` file,
rejecting symlinks, path escapes, extra lines, malformed relative paths, and
identity changes. The normal runner must derive the same canonical path and
identity.

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
Schema-version-2 bootstrap still checks that exact legacy path. If a file is
present, bootstrap refuses unless the ledger's genesis event is
`legacy-lease-retired` and binds that exact stable path, identity, content, and
digest. Reconciliation requires an empty lease ledger and refuses to append
after any schema-version-2 event.

### Creation and Authentication

Starting from a stable descriptor for the canonical home, the runner creates
and descends through each managed component with its existing descriptor-bound
operation seam. It uses mode `0700` for every directory it creates and does not
chmod or adopt pre-existing ancestors. Every component from `.local` through
the run directory must be a real directory, not a symbolic link, owned by the
current effective user, and not group- or world-writable. Each identity is
revalidated around descent. Unavailable no-follow semantics, an identity swap,
or an ownership ambiguity fails closed.

On Linux, every child operation is performed through a proved
`/proc/self/fd/<fd>` descriptor root. On other platforms, including Darwin v1,
the runner proves that no traversable descriptor root is available and returns
an unsupported-platform failure before creating a managed directory or
publishing an authority record.

### Capability-Bound Child Operations

`AuthenticatedDirectory` is an opaque runtime authority, not a structural data
record. Its exported diagnostic path, descriptor-root string, and identity are
never accepted as authority inputs by another module. Every production child
operation resolves the directory through private module state, keeps its pinned
descriptor open, and revalidates the descriptor, original pathname, and child
namespace around one callback-free operation.

The path module exposes fixed-purpose child-file capabilities rather than a
generic filesystem callback. A child capability is unforgeable in TypeScript
and is also authenticated through private runtime state. The narrow operation
surface is:

```ts
export type AuthenticatedChildFileAccess = "read" | "update"

declare const authenticatedChildFileBrand: unique symbol

export interface AuthenticatedChildFile<
  Access extends AuthenticatedChildFileAccess,
> {
  readonly [authenticatedChildFileBrand]: Access
}

export interface AuthenticatedChildFileSnapshot {
  readonly path: string
  readonly identity: FileIdentity
  readonly linkCount: string
}

export interface StableAuthenticatedChildFileRead
  extends AuthenticatedChildFileSnapshot {
  readonly bytes: Uint8Array
}

export function createExclusivePrivateFileChild(
  parent: AuthenticatedDirectory,
  name: string,
): Promise<AuthenticatedChildFile<"update">>

export function openPrivateFileChildForUpdate(
  parent: AuthenticatedDirectory,
  name: string,
): Promise<AuthenticatedChildFile<"update">>

export function openPrivateFileChildForRead(
  parent: AuthenticatedDirectory,
  name: string,
): Promise<AuthenticatedChildFile<"read">>

export function readStableAuthenticatedChildFile(
  file: AuthenticatedChildFile<AuthenticatedChildFileAccess>,
  maximumBytes: number,
): Promise<StableAuthenticatedChildFileRead>

export function writeConvergentAuthenticatedChildFileSuffix(
  file: AuthenticatedChildFile<"update">,
  expectedCurrentSize: number,
  bytes: Uint8Array,
): Promise<AuthenticatedChildFileSnapshot>

export function syncAuthenticatedChildFile(
  file: AuthenticatedChildFile<AuthenticatedChildFileAccess>,
): Promise<void>

export function hardenAuthenticatedChildFileReadOnly(
  file: AuthenticatedChildFile<"update">,
): Promise<AuthenticatedChildFileSnapshot>

export function statAuthenticatedChildFile(
  file: AuthenticatedChildFile<AuthenticatedChildFileAccess>,
): Promise<AuthenticatedChildFileSnapshot>

export function linkReadOnlyAuthenticatedChildFile(
  source: AuthenticatedChildFile<"read">,
  finalName: string,
): Promise<AuthenticatedChildFileSnapshot>

export function listAuthenticatedDirectoryChildren(
  directory: AuthenticatedDirectory,
): Promise<readonly string[]>

export function syncAuthenticatedDirectory(
  directory: AuthenticatedDirectory,
): Promise<void>

export function closeAuthenticatedChildFile(
  file: AuthenticatedChildFile<AuthenticatedChildFileAccess>,
): Promise<void>
```

The private brand prevents structural construction at compile time; every
function also rejects values absent from its private `WeakMap`. Snapshot paths
and identities are diagnostic values and grant no authority. Directory listing
is sorted and capped at 4,096 entries without first allocating an unbounded
array. A requested stable-read bound must be a positive safe integer no larger
than 16 MiB, and the reader checks size before allocation and during chunked
read. A convergent suffix write rejects a negative or unsafe current size, an
input larger than 16 MiB, or a current-size-plus-input result larger than 16
MiB. It synchronously copies the input bytes before its first `await`, opens
update authority with `O_RDWR | O_NOFOLLOW` and never `O_APPEND`, checks the
exact initial size, writes at explicit bounded positions, and checks the exact
resulting size and requested byte range.

Every overlapping invocation against the same inode has a caller precondition:
all supplied bytes derive from one immutable complete canonical byte sequence,
so bytes at overlapping file offsets agree even when callers authenticated
different current sizes. Divergence violates the precondition and has no
conflict-detection or outcome guarantee. A failure may leave a longer canonical
prefix. After an unknown outcome, a retry must stably reread and authenticate
the current prefix, rederive the missing suffix from the complete canonical
sequence, and issue a new call; it must never replay a stale call.

Task 3 rejects canonical output larger than its narrower 2 MiB immutable-JSON
limit before create or suffix write. Read open accepts only exact mode `0400`;
update open accepts only exact mode `0600` and performs stable reads through
that update capability while replay validates a partial prefix.

The operations enforce these transitions:

- create a mode-`0600` regular child with `O_CREAT | O_EXCL | O_NOFOLLOW`;
- open an existing regular child for bounded read or mode-`0600` update with
  `O_NOFOLLOW`;
- stably read bounded bytes and identity;
- write a convergent canonical suffix only at an exact authenticated current
  size;
- sync file data or metadata, harden mode from `0600` to `0400`, and stat;
- hard-link one mode-`0400` child to an absent sibling name under the same
  authenticated parent;
- list strict child names and sync the pinned parent directory; and
- close a child capability with retryable failure semantics.

Every directory operation acquires a synchronous operation lease before its
first `await`. Parent close checks for an operation lease, open child, or
retained failed-open cleanup before setting its transient closing state. A busy
close rejects atomically without changing state, child close remains permitted,
and parent close can be retried after the reservation clears. A descriptor-close
failure also clears the transient closing state and leaves the parent retryable.
Each child serializes its operations and rejects a second operation while one
is in flight. If post-open validation and descriptor close both fail, the
parent retains the handle, becomes poisoned, throws one aggregate containing
the primary plus every cleanup error, and rejects every future operation and
close; process exit is the only v1 cleanup for that fail-closed state. Every
failed open or validation follows the same aggregation rule whether or not it
poisons the parent.

A failed child close leaves the capability open and retryable; a successful
close is terminal. A successful convergent suffix write is not a durability
claim. The publisher must still sync file data, harden, sync metadata,
successfully close update authority, authentically reopen the child with
`O_RDONLY | O_NOFOLLOW`, and verify before linking. Hardening changes mode only,
and peer hardening during a convergent write is handled by publisher-level
retry or adoption rather than by widening the write operation's authority. An
existing writable descriptor is never promoted into read authority.
Hard-linking requires a read capability whose source is mode `0400`, still
names the authenticated inode, and has link count exactly one. The target is an
absent sibling under the same authenticated parent. After link, source and
target must be the same inode, mode `0400`, with link count exactly two. Any
prior or concurrent extra alias, source replacement, target replacement, or
count ambiguity fails closed and is never rolled back by deletion.

Directory listing returns names only; every authoritative use of a listed
entry reopens it with no-follow semantics. Stable reads reject growth,
replacement, unexpected mode or owner, and identity changes.

Publisher fault hooks run only between complete capability operations. No hook
runs after authority validation but before a syscall inside one operation. This
keeps fault injection from becoming a production pathname race seam.

The checkout-scope, run directory, `control.json`, and `tool-root` are created
through create-exclusive operations. A matching pre-existing checkout scope is
reused only after exact `repository.json` authentication. Any pre-existing run
ID is a conflict and aborts bootstrap.

Immediately after tool-root creation, the runner writes the existing owner
marker with immutable publication. It then constructs the exact initial
schema-version-2 state bytes. A create-only `allocation-prepared` lease event
stores those bytes and their digest, the tool-root and marker identities, and
the future state and control paths. This event reserves the checkout and blocks
another run.

The runner next publishes the still-absent repository state with the immutable
publisher, stably rereads it, publishes `control.json` referencing the prepared
event and initial state identity/digest, and finally publishes `acquired`
referencing the control-record digest. Only then may it download tools, create a
kubeconfig, or execute bootstrap. References are directional: state contains
control and prepared paths but not their digests; prepared contains the exact
state bytes; control references prepared and state; acquired references
control. There is no digest cycle.

A crash after `allocation-prepared` is exactly resumable from the stored state
bytes. Replay accepts only absent state/control, or their exact expected stable
files, and advances through the same order. Before `allocation-prepared`, an
unambiguous failure may retire only empty create-exclusive identities captured
by that attempt. At or after `allocation-prepared`, no rollback removes the tool
root or control evidence; the reserved run must be resumed and normally
cleaned. Any identity or publication ambiguity preserves all paths and fails
closed.

Lease events are immutable JSON records with a monotonic generation,
predecessor digest, checkout identity, run identity, owner nonce, timestamp,
and event-specific references. The grammar is:

- an empty ledger accepts either `allocation-prepared` for a clean checkout or
  the one genesis-only `legacy-lease-retired` migration event;
- `legacy-lease-retired` and `finalized` are inactive states and may be followed
  only by a new run's `allocation-prepared`;
- `allocation-prepared` is a blocking reservation and may be followed only by
  `acquired` for the same run and control record;
- `acquired` is active and may be followed only by `finalized` for the same run
  after authenticated cleanup; and
- every successor names the exact predecessor digest.

Gaps, forks, replacements, malformed events, invalid transitions, or more than
one valid successor are conflicts. Events are retained; normal cleanup does not
unlink an active-lease file.

### Immutable Publication

Every new authoritative JSON file in the durable control tree, including
repository markers, allocation and lease events, control records, lock events,
attestations, and reconciliation phases, uses one primitive. The publisher
writes complete canonical bytes to a create-exclusive mode-`0600` staging file
under the authenticated target parent, syncs it, changes it to mode `0400`,
syncs that metadata, hard-links the now-read-only inode to the absent final
name, and syncs the final name's direct parent directory. The retained staging
name therefore cannot normally mutate the authoritative hard link. A target in
`lease-events/` syncs `lease-events/`, not the transaction directory. If the
final name exists, only stable exact expected bytes, identity, and mode `0400`
are accepted. Hard-link or mode-hardening unavailability fails before
advancement.

There are two explicit reservation-race exceptions. A loser racing the fixed
setup-plan name may adopt the winner only when that stable plan has the same
accepted evidence digests and canonical path derivation, then uses the winner's
transaction ID and logical-finalization timestamp. A loser racing a lock claim
may return `lost` under the stricter lock rule below. Every other `EEXIST`
requires the caller's exact expected bytes.

Staging files are never authoritative and are not deleted. Their names bind the
target name, content digest, and lock generation when one exists. A replay may
ignore only bounded regular files with a strict staging name and current-user
ownership. Mode `0600` identifies an interrupted pre-hardening stage and may
contain only an exact prefix of the canonical bytes. Replay rejects an
oversized or mismatched prefix without mutation and writes only a rederived
missing suffix at the authenticated current size. If that write has an unknown
outcome, replay stably rereads and authenticates the prefix and rederives the
suffix instead of replaying stale arguments. After complete-byte verification,
the publisher unconditionally syncs data, hardens, syncs metadata, closes
update authority, and reopens read-only. A peer that hardens the same canonical
stage is handled by publisher retry or adoption. Mode `0400` must have the
filename's complete content digest and is synced again before link because the
prior process may have crashed before metadata durability. Other modes, names,
types, ownership, unexplained entries, or link counts fail closed.

After a successful link, the publisher syncs the authenticated direct parent
before reread. An exact pre-existing final is accepted only with the expected
mode, bytes, staging alias, inode, and link count; its direct parent is synced
again before acceptance because it may represent a crash after link but before
directory sync. A different stable final transfers an open authenticated read
capability to `ImmutableTargetCollision`. The catcher owns that capability and
must close it in `finally`; until then the parent intentionally cannot close.
Before either permitted semantic winner adoption, the catcher validates the
winner, syncs the authenticated direct parent, and stably rereads the same open
capability. This is mandatory even when validation succeeded before sync,
because the winner may have crashed after link but before directory durability.

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
<canonical-node> <run-root>/infra-reconciler.mjs reconcile-absent-pre-resource \
  --accepted-node-sha256 <sha256> \
  --accepted-reconciler-sha256 <sha256> \
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

The accepted executable is a reviewed, self-contained `infra-reconciler.mjs`, not
the TypeScript source executed through `pnpm`, `tsx`, or another loader. Its
canonical path is exactly `<run-root>/infra-reconciler.mjs`, reached without
symlinks. It imports only `node:*` built-ins and performs no package, local-file,
configuration, dynamic module, or child-process resolution. It does not contain
the normal infrastructure command dispatcher. The implementation may remain
authored and tested in TypeScript with shared pure helpers, but the operator
reviews and accepts the exact bundled `.mjs` bytes that Node executes.

Launch uses the absolute canonical Node path already recorded by the accepted
legacy state. `process.execPath`, Node version, the state tool record, and
`accepted-node-sha256` must all agree. The operator independently verifies both
Node and reconciler hashes before launch and invokes them with a clean environment.
The command rejects `NODE_OPTIONS`, `NODE_PATH`, preload/loader flags, package
runner invocation, symlinked executables, and any environment key outside a
small fixed locale-only allowlist.

Top-level execution may parse arguments, import built-ins, and declare
functions but performs no filesystem or process mutation until it has opened,
stably read, and matched the exact executable file and Node binary to their
accepted hashes. It captures both identities and bytes and revalidates them
immediately before every durable mutation. This authenticates the mutable
executable closure used by reconciliation. It is not a claim that a program can
establish trust in adversarial code or a compromised kernel already executing
as the user.

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

After the preliminary evidence pass and before any external control-directory
creation, reconciliation publishes
`<run-root>/durable-reconciliation-setup.json` with the immutable publisher
staging directly in the already-authenticated run root. The setup plan commits
the transaction ID, canonical state base, checkout-scope derivation inputs,
exact repository-marker bytes and digest, planned lock/run/transaction paths,
required owners and modes, and the accepted evidence digests.

Only that setup plan authorizes creation or reuse of the private checkout-scope
directory, exact `repository.json`, and lock directory. After lock acquisition
it authorizes the exact legacy run directory and empty `cleanup-transaction`
directory. Replay does not need lost in-memory identities from the creating
process: it reauthenticates every planned path as a nonsymlink, current-user,
private directory with exact expected marker content and only explained planned
entries. The first locked `intent` captures their stable identities. A mismatch
fails closed and is never removed.

Reconciliation never creates `tool-root` or a future run's `control.json`. The
subsequent `intent` is the legacy run's durable control record and includes the
setup-plan identity and digest.

### Required State Shape

Before publishing an intent record, reconciliation must prove all of the
following:

- reconciler, state, results JSON, results TSV, and legacy lease are stable
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
- the recorded active registry PID is null; and
- the exact recorded tool-root path is absent in repeated stability probes.

The absence probes use descriptor-bound, stable parent-directory inspection
rather than a single `existsSync` result. They run at entry, after all evidence
reads, before and after attestation publication, before state finalization, and
immediately before legacy lease retirement. A reappearing path of any type
aborts without deletion.

The accepted state proves only that it records no resource attempt or owned
resource. It cannot prove that no historical command ran before an interrupted
state write or that no process retained an inherited file descriptor. The
prior audit and accepted hashes are explicit
operator-reviewed authority for proceeding with this one run. The attestation
states those limits. The reconciliation implementation itself has no Docker,
Kind, kubectl, Helm, registry, download, tool-root creation, quarantine,
erasure, or removal dependency, so it can prove that it initiates none of those
operations.

Any mismatch preserves all protected files and the active lease. An existing
ordinary cleanup transaction or any state beyond the exact pre-resource shape
must be handled by normal authenticated cleanup or human investigation.

### Protected Evidence Matrix

| Evidence | Exact path | Owner and mode | Maximum bytes | Required content relation |
|---|---|---|---:|---|
| Node | canonical `state.tools.node.path` and `process.execPath` | current user; regular executable; no group/world write | 256 MiB | accepted digest, recorded tool digest, and required Node version agree |
| Reconciler | `<run-root>/infra-reconciler.mjs` | current user; regular `0600` | 2 MiB | self-contained ESM, accepted digest, no mutable imports or child processes |
| State | `<run-root>/state.json` | current user; regular `0600` | 1 MiB | strict legacy parser and accepted digest |
| Results JSON | `<run-root>/results.json` | current user; regular `0600` | 1 MiB | exact projection of `state.results` |
| Results TSV | `<run-root>/results.tsv` | current user; regular `0600` | 1 MiB | exact byte projection defined below |
| Legacy lease | `<repo-root>/artifacts/testing/dedicated-infrastructure/active-run.json` | current user; regular `0600` | 64 KiB | strict six-field lease schema and exact state identity agreement |
| Prior audit | accepted canonical descendant of `<run-root>` | current user; regular; no group/world write | 1 MiB | accepted digest; supporting evidence only |

Task 7's runtime source scan is conservative fail-fast validation, not a
semantic trust boundary. Task 9's deterministic build, restricted metafile
graph, source review, and operator-accepted bundle digest establish the
executable-closure relation.

Every path component is opened relative to a stable authenticated parent with
no-follow semantics. For each file, the reader opens once, captures BigInt
`dev`, inode, UID, permission bits, size, mtime, and ctime with descriptor
`fstat`, reads bounded bytes from that descriptor, repeats `fstat`, and then
proves the canonical path still names the same device/inode through the stable
parent. Any field change, short/long read, non-regular type, unsupported
no-follow operation, or path replacement fails. The descriptor stores decimal
device/inode strings, SHA-256 of exact bytes, and the complete bytes for later
revalidation. Every authoritative phase repeats this algorithm and requires the
same identity and digest.

`results.json` bytes must equal
`JSON.stringify(state.results, null, 2) + "\n"`. The TSV bytes use the fixed
header and column order `lane`, `status`, `started_at`, `finished_at`,
`exit_code`, `classification`, `resource`, `tool_versions`, `native_artifact`,
`cleanup`, `retry`, `blocked_by`, `hosted_equivalent`. Each row follows
`state.results` order; `tool_versions` uses `JSON.stringify`; null or undefined
becomes empty; all tabs, carriage returns, and newlines in values collapse to a
single space; columns are tab-separated; and every row ends with `\n`.

### Exact Legacy State

`LegacyReconciliationState` is the existing strict schema-version-1
`validateState(..., { allowStaleFix: true })` parser frozen under regression
tests, followed by the exact overlay below. The base parser rejects unknown or
missing keys at every nested object, invalid enums, invalid timestamp order,
noncanonical paths, duplicate records, projection inconsistencies, and invalid
attempt/fix/retention relationships. Reconciliation does not add optional or
permissive legacy fields.

| Field group | Required pre-resource value |
|---|---|
| Identity | `schemaVersion: 1`; accepted run ID, run token, owner nonce, canonical repo/run roots, absolute recorded tool root and kubeconfig, ordered creation timestamp, `finalizedAt: null`, accepted policy digest |
| Tools | exact sorted keys `curl`, `git`, `jq`, `node`, `os`, `pnpm`; each strict version/path/digest record; Node agrees with the accepted runtime |
| Shared bootstrap | status `failed`; nonempty reason; terminal classification `bootstrap/environment`; exactly one failed `attempt0` |
| Shared commands | nonempty and every executable/stage/argument tuple belongs to the frozen pre-resource allowlist of Git preflight, runtime/version probes, and `pnpm install --frozen-lockfile`; no resource executable or command is permitted |
| Docker and Kubernetes bootstrap | status `pending`; null reason and terminal classification; empty attempts |
| Baseline and ownership | every baseline member null; `ownedClusters: []`; `ownedImages: {}`; `activeRegistryPid: null`; `retained: []`; `fixes: []` |
| Results | exactly six records in canonical lane order; each `blocked`, bootstrap/environment classified, zero attempts, null exit/native artifact/verified commit, cleanup `not-run`, retry `none`, zero post-fix runs, and blocked by the one shared-bootstrap failure |

The legacy lease parser requires exactly `runId`, `ownerNonce`, `runRoot`,
`toolRoot`, `statePath`, and `createdAt`, with every value equal to state and
`statePath` equal to `<run-root>/state.json`. Accepted file hashes then bind the
specific timestamps, reason strings, tool versions, resources, and hosted-lane
labels that are intentionally not generalized by the overlay.

## Attestation and Journal

Reconciliation writes authoritative mode-`0400` records at these exact planned
locations:

```text
<repository-run-root>/
  durable-reconciliation-setup.json

<durable-run-control>/
  cleanup-transaction/
    absent-tool-root-attestation.json
    00-intent.json
    01-absence-attested.json
    staging/

<durable-checkout-scope>/
  lease-events/
    <generation>-legacy-lease-retired.json
```

The attestation uses the immutable publisher and includes:

- schema version, transaction ID, run ID, owner nonce, and repository identity;
- exact state, results, lease, and prior-audit paths, identities, and accepted
  hashes;
- the expected absent tool-root path;
- initial and pre-attestation absence observation timestamps;
- the accepted Node and reconciler hashes and captured identities;
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
3. `legacy-lease-retired`

Each phase has its own immutable file. The terminal lease event is also
the `legacy-lease-retired` phase; no second completion file is published. A
record contains its ordinal, phase, transaction and run identities,
predecessor filename and digest, the digest of the immutable intent payload,
and the phase-specific evidence.

`intent` commits the accepted arguments; all initial evidence paths,
identities, and digests; the expected attestation body and digest; the fixed
logical-finalization timestamp; the exact immutable legacy state, results, and
lease identities and digests; and a canonical legacy-retirement template plus
its digest. The template binds the accepted legacy lease path, identity,
content digest, run identity, owner nonce, logical-finalization timestamp, and
null `leasePredecessorSha256`, but deliberately omits
`reconciliationPredecessorSha256`.

Later reconciliation records hash-chain to `intent`. After
`absence-attested` is published, the terminal lease event is derived by adding
that phase record's digest as `reconciliationPredecessorSha256` to the exact
intent-committed template. The terminal event is valid only as the empty
ledger's genesis event and has inactive active-run semantics. Separating the
lease-ledger predecessor from the reconciliation predecessor avoids a hash
cycle: `intent` commits the template, `absence-attested` names the intent
digest, and the terminal event names the absence digest. Replays accept only
the unique contiguous chain for the same transaction. Gaps, forks, extra
records, malformed fields, wrong-action records, and out-of-order records fail
closed.

The transaction performs these mutations in order:

1. Create and durably publish `intent` after all entry checks.
2. Publish and durably sync the attestation with the immutable publisher.
3. Revalidate all immutable evidence and absence, then advance to
   `absence-attested`.
4. Revalidate Node, reconciler, the complete phase chain, attestation, immutable
   state/results evidence, exact legacy lease, and root absence. Publish the
   `legacy-lease-retired` event in the durable lease ledger. That event binds
   the accepted legacy lease path, identity, and digest to this completed
   transaction and supersedes it for the new controller without modifying it.
5. Re-read the lease ledger and prove that its unique genesis/latest event
   retires this
   exact legacy acquisition.

The legacy `active-run.json`, attestation, and completed phase chain remain as
evidence. Reconciliation never deletes or overwrites the prior audit, state,
results, lease, or transaction records. In particular, the schema-version-1
state retains `finalizedAt: null`; the terminal event is the new controller's
authoritative logical finalization record.

## Replay and Concurrency

### Crash-Recoverable Lock

All future controller commands and reconciliation use an append-only lock-event
chain under the durable checkout scope. Each generation has exactly one claim
and one terminal event:

```text
<generation>-claim.json
<generation>-released.json | <generation>-dead-retired.json
```

Before publishing a claim, a contender starts a Node loopback TCP challenge
server on `127.0.0.1` with an operating-system-assigned port. It constructs the
complete claim bytes with the generation, predecessor-terminal digest, run and
transaction identities, random nonce, PID, port, and verified Node and reconciler
digests. The immutable publisher then races those complete synced bytes into
the single create-exclusive claim name. A loser closes its server and does not
enter the critical section. A crash before claim publication leaves only
non-authoritative staging residue and an operating-system-released port.

For lock claim publication, on `EEXIST` a contender may return `lost` only
after the winning claim is a stable valid record for the same generation and
predecessor. Any other non-reservation target still requires the caller's exact
expected bytes.

The winning server answers a random challenge with a digest bound to the claim
nonce and challenge. A second controller treats the claim as live only after an
exact response. It treats the owner as definitely dead only when loopback
connection is refused and `process.kill(pid, 0)` reports `ESRCH`. A reused or
otherwise live PID, timeout, unexpected response, permission error, network
error, or any ambiguous result refuses retirement.

Normal completion publishes a deterministic `released` record bound to the
claim digest. When the owner is definitely dead, any contender may publish the
single deterministic `dead-retired` record bound to that same digest. Those two
terminal names are mutually exclusive by validation: observing both is a
conflict. Retirement has no observer nonce or timestamp, so independent
contenders compute identical bytes. They may race the exact no-clobber
publication; the loser accepts the winner's exact record. They then race a
normal claim for the next generation, of which only one can win.

The chain starts at generation zero with a null predecessor. Each later claim
must name the preceding terminal digest. Generations are contiguous and the
only nonterminal generation may be the highest claim. Staging files are allowed
only when bound to an authenticated claim attempt and never participate in the
chain. Gaps, duplicate claims, both terminal kinds, a successor to an
unterminated claim, malformed records, source mismatches, or extra authoritative
files fail closed. No lock or retirement record is deleted or overwritten.

### Phase Matrix

Every replay derives authority from the accepted command arguments and the
already-published exact intent; it does not broaden authority based on current
filesystem contents. The accepted state hash always names the reviewed initial
state and remains the same across replay attempts.

| Highest durable phase | Accepted protected evidence | Lease ledger | Next action |
|---|---|---|---|
| none | every accepted file has its original exact bytes, hash, and identity | empty | publish the run-root setup plan; no setup-authorized mutation for this transaction has occurred |
| `setup-planned` | unchanged exact evidence | empty | create or authenticate only planned control paths, acquire the durable lock, then publish `intent` |
| `intent` | unchanged exact evidence | empty | publish or authenticate attestation, then `absence-attested` |
| `absence-attested` | unchanged exact evidence | empty | publish the genesis `legacy-lease-retired` event |
| `legacy-lease-retired` | unchanged exact evidence | the terminal event is the unique genesis/latest event | verify both chains and return success |

Reconciliation never has a phase in which a protected file may have either of
two bodies. Any changed state, result, audit, reconciler, Node binary, or legacy
lease content or identity is a conflict at every row.

The terminal lease event is create-exclusive and no legacy lease unlink occurs,
so there is no post-unlink ambiguity. If process death occurs after terminal
event publication but before return, replay authenticates that exact event as
the highest phase and completes without another mutation.

If interruption occurs:

- before the setup plan, no mutation occurred;
- after `setup-planned`, replay authenticates only the exact planned external
  directories and marker, then reacquires the lock and publishes `intent`;
- after `intent`, replay verifies all accepted initial evidence and republishes
  or verifies the exact attestation;
- after `absence-attested`, replay verifies unchanged protected evidence before
  publishing the terminal lease event; and
- after terminal lease-event publication, replay verifies that exact event and
  performs no further mutation.

At every phase, tool-root reappearance, source replacement, evidence mutation,
lock loss, phase-chain replacement, attestation replacement, or legacy lease
replacement stops replay. No rollback deletes evidence or recreates the root.

## Type and Code Boundaries

Keep authored implementation and tests beside the existing run-local
controller. Pure TypeScript helpers may be shared at build time, but the
reconciliation entrypoint is bundled into the self-contained accepted `.mjs`
and has no mutable runtime imports. Split the logic into narrow internal units:

- fixed state-home resolution, checkout-scope authentication, durable
  control/tool-root allocation, and opaque descriptor-bound child operations;
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
shape without modifying it and produces only the typed logical-finalization
payload for `intent`. It is not a general legacy reader. Define
schema-version-2 state for future runs with exact durable checkout-scope,
prepared-event, control-record, and lease-acquisition references. Normal
commands accept only schema version 2 after migration.

Every protected file has a typed evidence descriptor containing its exact path,
expected mode policy, filesystem identity, content digest, and stable bytes.
Results JSON and TSV descriptors additionally carry their validated
relationship to `RunState.results`.

Use discriminated unions so each cleanup action has only its valid fields and
phases. The normal removal action retains removal identities; the preserved
unauthenticated action retains preservation evidence; the reconciliation
action cannot represent removal authority. Parsers reject unknown keys and
invalid action/phase combinations.

The immutable publisher is used for the new durable-control files and
reconciliation only. This follow-up does not migrate the already-reviewed
normal tool-root removal journal. Future schema-version-2 cleanup adapts that
existing authenticated removal transaction only enough to read durable control
paths and append its `finalized` lease event. The absent-root reconciliation
remains a separate action with no removal dependency or authority. The stale
run has no existing cleanup journal to migrate.

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
  prepared event, repository state, control record, owner marker, and acquired
  lease event in the required order;
- kills allocation before and after each publication, resumes exact prepared
  state bytes, and proves no acquired event exists without state and control;
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

- proves an exact loopback challenge response excludes a second controller;
- kills the lock holder before and after every durable phase and proves an
  exact deterministic dead retirement can continue;
- kills lock acquisition before and after staging, claim hard-link, terminal
  hard-link, and parent sync boundaries;
- refuses retirement for PID reuse, successful or ambiguous challenge results,
  permission errors, wrong source, malformed records, missing predecessors, and
  identity swaps;
- races deterministic dead-retirement publication and the next claim, proving
  one terminal and one winning next generation;
- races phase publication with a conflicting final file and proves no existing
  record is overwritten;
- validates the immutable publisher for every target directory, including
  target-parent sync, retained staging residue, and restart recovery at each
  boundary; and
- crashes after the run-root setup plan and each planned external-directory
  creation, then proves replay authenticates exact planned paths without
  deletion or lost in-memory identities;
- races setup-plan publication and proves the loser adopts only a winner bound
  to the same accepted evidence and path plan;
- rejects unexplained staging files and every lock/lease grammar gap, fork, or
  invalid transition.

### Reconciliation Tests

- starts red with the exact stale pre-resource fixture and absent tool root;
- rejects every missing, duplicate, malformed, or mismatched accepted option;
- rejects Node, state, result, lease, audit, reconciler, state-schema, and
  file-identity changes;
- rejects `pnpm`/`tsx`/loader execution, a noncanonical reconciler or Node path,
  mutable imports, `NODE_OPTIONS`, `NODE_PATH`, and an executable closure that
  differs from the two accepted files;
- rejects `results.json` that differs from `state.results` and any TSV that is
  not the exact deterministic projection;
- rejects a prior audit outside the run root or reached through a symlink;
- rejects each deviation from the exact pre-resource shape;
- rejects a recorded registry PID without launching an external process scan;
- rejects any root that exists or reappears;
- proves no filesystem deletion, tool-root creation, or resource-command
  dependency is reachable;
- writes a complete immutable attestation with cause `unproven`;
- fault-injects before and after every intent, attestation, absence-phase, and
  terminal lease-event publication boundary;
- proves `intent` commits a retirement template with an explicit null lease
  predecessor and no reconciliation predecessor, then derives one terminal
  event by adding the exact absence-phase digest without a hash cycle;
- restarts in a new process from every durable phase and reaches the same final
  bytes;
- rejects malformed, replaced, forked, wrong-action, and out-of-order replay
  records;
- confirms every protected file, including `state.finalizedAt`, remains
  unchanged;
- leaves the accepted legacy lease unchanged while publishing exactly one
  genesis terminal retirement event and rejects reconciliation after any v2
  event; and
- leaves the completed attestation and phase chain intact.

Run focused tests repeatedly under Node 24, strict TypeScript with
`exactOptionalPropertyTypes`, and scoped Biome. Then run the controller's full
test suite, its contention and process-lifecycle stress loops, and independent
spec-compliance and code-quality reviews.

## Operational Acceptance

After implementation and review:

1. On Darwin, prove unsupported-platform failure occurs before the first
   authoritative mutation and confirm the protected stale evidence was neither
   opened nor changed. Record the stale reconciliation as deferred, not passed.
2. On native or hosted Linux, run the reconciliation transaction against exact
   synthetic pre-resource evidence and inspect the completed attestation,
   phase chain, logical-finalization timestamp, and terminal durable lease
   event.
3. Confirm Linux reconciliation invoked no Docker, Kubernetes, registry,
   download, tool-root creation, quarantine, erasure, or removal operation.
4. Rebase the branch on current `main` and reassess the checked-in workflows,
   compatibility pins, chart topology, and known merge conflicts.
5. On native or hosted Linux, start a fresh run, confirm its tool root and
   control index use the durable state base, and execute the full dedicated
   infrastructure ladder sequentially.
6. Confirm normal finalization removes only the fresh run's exact durable tool
   root, appends its exact `finalized` lease event, and retains control and run
   evidence.
7. Run the repository Definition of Done, open a pull request, merge only after
   required hosted Linux checks are green, and verify the merged revision.

Reconciliation of the protected Darwin stale run is not an acceptance gate for
the Linux v1 implementation. It remains a separate future operational action
after native Darwin support has its own approved authority design.

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

Finally, executable hashing is an integrity check against mistakes and
concurrent replacement, not a cryptographic trust anchor against malicious
code or a compromised kernel already executing as the user. The operator must
independently inspect and accept the Node and self-contained reconciler hashes before
invoking reconciliation.
