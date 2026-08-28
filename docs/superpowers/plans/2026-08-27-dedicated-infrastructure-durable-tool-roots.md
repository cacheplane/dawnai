# Dedicated Infrastructure Durable Tool Roots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to implement this plan task by task.
> Use a fresh implementer for each task, then run spec-compliance review followed
> by code-quality review before starting the next task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Make future dedicated-infrastructure tool roots and control evidence
durable on Linux, implement a standalone no-delete reconciliation transaction,
and preserve the exact stale Darwin pre-resource run until a separately
reviewed native Darwin authority mechanism can retire it.

**Architecture:** Add narrow ignored TypeScript units beside the existing
run-local controller for durable paths, immutable publication, lease events,
append-only locks, schema-version-2 allocation, and reconciliation. Bundle the
reconciliation entrypoint into one self-contained `infra-reconciler.mjs` that
runs directly under the accepted Node binary and imports only `node:*`
built-ins. Preserve the current normal cleanup transaction, adapt it only to
durable paths and the terminal lease event, and keep the protected legacy
state, projections, lease, and audit byte-for-byte unchanged.

**Tech Stack:** Node.js 24 built-ins, TypeScript 7 with NodeNext ESM and
`exactOptionalPropertyTypes`, `tsx --test`, esbuild, Biome, pnpm, Git, Docker,
Kind, kubectl, and Helm.

### Platform Amendment

The Darwin capability probe performed during Task 2 established that Node.js
24 cannot perform child operations through `/dev/fd/<fd>` and exposes no
`openat`-family API. Therefore authoritative mutation in this plan is Linux-only
through a proved `/proc/self/fd/<fd>` descriptor root. Darwin must fail before
the first mutation; it may run pure and no-mutation tests only. A pathname
fallback is forbidden because it would weaken the accepted authority model.

Task 11 is retained as the future operational checklist but is deferred on the
current Darwin host. Do not read, copy, hash, or mutate its protected stale
evidence as part of this implementation. Moving those files to Linux would
change the filesystem identities the transaction is meant to authenticate.
Task 12 may proceed after Task 10, with authoritative integration and the fresh
ladder executed on native or hosted Linux.

---

## Execution Contract

- Work only from `/Users/blove/.codex/worktrees/b5f4/dawn` on
  `blove/kubernetes-compat-hardening` until the explicit rebase task.
- The accepted design is
  `docs/superpowers/specs/2026-08-27-dedicated-infrastructure-durable-tool-roots-design.md`.
- Use `/Users/blove/.nvm/versions/node/v24.19.0/bin` at the front of `PATH` for
  every implementation, build, test, and operational command.
- Keep all controller implementation, generated executables, tests, and
  evidence under the ignored run root. Do not force-add them to Git and do not
  add a package script, workflow, public Dawn command, or product API.
- Do not use the protected stale run as a test fixture. Synthetic fixtures must
  have their own temporary repository, Git directory, state home, run root,
  legacy lease, and absent tool-root pathname.
- Do not create, replace, chmod, rename, truncate, unlink, or rewrite the
  protected stale state, projections, lease, audit, or missing tool root before
  Task 10. Reconciliation must leave those files and their metadata unchanged.
- No Docker, Kind, kubectl, Helm, registry, download, process-scan, quarantine,
  erasure, removal, or child-process path may be reachable from reconciliation.
- The ignored implementation is accepted by exact source and executable hashes
  plus review evidence, not by committing generated operational artifacts.
- Use `apply_patch` for source edits. Never use a shell heredoc or ad hoc script
  to write controller files.

Use this preamble for every local implementation command:

```bash
cd /Users/blove/.codex/worktrees/b5f4/dawn
export NODE24_BIN=/Users/blove/.nvm/versions/node/v24.19.0/bin
export PATH="$NODE24_BIN:$PATH"
export LEGACY_RUN_ID=20260819T155609Z-d6624eb3
export LEGACY_RUN_ROOT="$PWD/artifacts/testing/dedicated-infrastructure/$LEGACY_RUN_ID"
test "$(git branch --show-current)" = blove/kubernetes-compat-hardening
test -f "$LEGACY_RUN_ROOT/infra-runner.ts"
test -f "$LEGACY_RUN_ROOT/infra-runner.test.ts"
git check-ignore "$LEGACY_RUN_ROOT/infra-runner.ts"
```

## File Map

All implementation files below are ignored and live under
`artifacts/testing/dedicated-infrastructure/20260819T155609Z-d6624eb3/`.

| File | Responsibility |
|---|---|
| `infra-durable-types.ts` | Exact schemas, discriminated unions, canonical JSON, hashes, strict unknown-key parsers, and the frozen exact schema-version-1 validator shared at build time. |
| `infra-durable-paths.ts` | Fixed user-state resolution, Git common-directory resolution, checkout-scope derivation, no-follow traversal, identities, and planned durable paths. |
| `infra-immutable-json.ts` | Create-only mode-0400 hard-link publication, target-parent durability, staging validation, and exact adoption. |
| `infra-lease-ledger.ts` | Immutable lease-event parsing, contiguous grammar, active/inactive resolution, prepared/acquired/finalized transitions, and legacy genesis retirement. |
| `infra-durable-lock.ts` | Append-only lock claim/terminal chain, loopback challenge, deterministic dead retirement, and critical-section ownership. |
| `infra-durable-allocation.ts` | Schema-version-2 initial state, prepared-state replay, owner marker, control record, acquired event, and normal finalization integration. |
| `infra-reconciliation.ts` | Option parsing, exact schema-version-1 overlay, protected evidence descriptors, absence probes, setup plan, attestation, and replay engine. |
| `infra-reconciler-entry.ts` | Standalone CLI entrypoint; imports only the reconciliation build-time graph and exposes no normal dispatcher. |
| `build-infra-reconciler.mjs` | Pins the esbuild invocation, audits the build graph and emitted imports, and verifies deterministic output without joining the runtime closure. |
| `infra-reconciler.mjs` | Deterministic reviewed esbuild output executed directly by accepted Node. |
| `infra-controller.test-support.ts` | Synthetic repositories, exact legacy/v2 fixture builders, fault hooks, process harnesses, and immutable tree snapshots. |
| `infra-durable-*.test.ts` | Focused unit/process tests for the corresponding module. |
| `infra-reconciliation.test.ts` | In-process reconciliation conformance and crash-replay tests. |
| `infra-reconciler.process.test.ts` | Clean-environment, executable-closure, restart, and no-resource process tests. |
| `infra-control.tsconfig.json` | Strict no-emit typecheck over the ignored controller graph and tests. |
| `infra-runner.ts` | Existing controller; schema-version-2 command integration and normal durable cleanup only. |
| `infra-runner.test.ts` | Existing regression suite; add integration assertions without weakening old coverage. |

Runtime imports by `infra-runner.ts` expand its mutable source closure. Upgrade
the ignored runner-integrity document to schema version 2 so it lists the exact
canonical path, mode, identity, and SHA-256 of `infra-runner.ts` plus every
runtime-imported `infra-durable-*.ts` module. Reconciliation does not trust that
sidecar: its accepted mutable executable closure is exactly the canonical Node
binary and bundled `infra-reconciler.mjs`.

Future bootstrap receives
`--accepted-source-manifest-sha256 <sha256>` exactly once. Before any durable
mutation, it stably reads a mode-`0600` canonical source manifest directly under
the new repository run root and proves that the manifest digest matches the
operator-accepted argument and that every listed runtime source has its exact
path, identity, mode, and digest. The schema-version-2 runner-integrity document
copies that accepted manifest digest and stable source descriptors; it does not
bootstrap trust by silently hashing whatever source happens to execute.

## Shared Types

Use narrow exact records. Do not use index signatures on authority-bearing
objects and do not retain optional keys with `undefined` values.

```ts
export interface FileIdentity {
  readonly dev: string
  readonly ino: string
  readonly uid: number
  readonly mode: number
  readonly size: string
  readonly mtimeNs: string
  readonly ctimeNs: string
}

export interface AcceptedEvidence {
  readonly path: string
  readonly identity: FileIdentity
  readonly sha256: string
  readonly bytes: Uint8Array
  readonly modePolicy: "exact-0600" | "owner-private"
}

export type LeaseEvent =
  | AllocationPreparedEvent
  | AcquiredEvent
  | FinalizedEvent
  | LegacyLeaseRetiredEvent

export type LockTerminal = ReleasedLockEvent | DeadRetiredLockEvent

export type ReconciliationPhase =
  | ReconciliationIntent
  | AbsenceAttestedPhase
  | LegacyLeaseRetiredEvent

export interface DurablePaths {
  readonly stateBase: string
  readonly controllerBase: string
  readonly checkoutScope: string
  readonly scopeRoot: string
  readonly repositoryMarker: string
  readonly locksRoot: string
  readonly leaseEventsRoot: string
  readonly runControlRoot: string
  readonly controlPath: string
  readonly toolRoot: string
  readonly cleanupTransactionRoot: string
}

export interface RunStateV2 {
  readonly schemaVersion: 2
  readonly runId: string
  readonly runToken: string
  readonly ownerNonce: string
  readonly repoRoot: string
  readonly repositoryIdentity: FileIdentity
  readonly gitCommonDirectory: string
  readonly gitCommonDirectoryIdentity: FileIdentity
  readonly runRoot: string
  readonly statePath: string
  readonly stateBase: string
  readonly checkoutScope: string
  readonly scopeRoot: string
  readonly repositoryMarkerPath: string
  readonly allocationPreparedPath: string
  readonly leaseAcquisitionPath: string
  readonly controlPath: string
  readonly toolRoot: string
  readonly toolRootIdentity: FileIdentity
  readonly ownerMarkerPath: string
  readonly ownerMarkerIdentity: FileIdentity
  readonly kubeconfig: string
  readonly createdAt: string
  readonly initialHead: string
  readonly expectedBranch: string
  readonly sourceManifestSha256: string
  readonly reconcilerSha256: string
  readonly finalizedAt: string | null
  readonly policySha256: string
  readonly tools: Readonly<Record<string, ToolRecord>>
  readonly sharedBootstrap: BootstrapPhaseRecord
  readonly dockerBootstrap: BootstrapPhaseRecord
  readonly kubernetesBootstrap: BootstrapPhaseRecord
  readonly baseline: DockerBaseline
  readonly ownedClusters: readonly string[]
  readonly ownedImages: Readonly<Record<string, string>>
  readonly activeRegistryPid: number | null
  readonly results: readonly LaneResult[]
  readonly retained: readonly RetainedRecord[]
  readonly fixes: readonly FixRecord[]
}

export type ControllerSourceIdentity =
  | {
      readonly kind: "normal-runner"
      readonly nodeSha256: string
      readonly reconcilerSha256: string
      readonly sourceManifestSha256: string
    }
  | {
      readonly kind: "reconciler"
      readonly nodeSha256: string
      readonly reconcilerSha256: string
    }
```

`RepositoryMarker` contains only canonical repository/Git-common-directory
paths, captured identities, checkout scope, schema version, and creation time;
it is checkout-scoped and reusable across runs, so it has no run ID, run token,
or owner nonce. `AllocationPreparedEvent`, `DurableControlRecord`,
`AcquiredEvent`, and `FinalizedEvent` repeat the run/owner/repository/scope
identities and use directional references only: prepared carries exact initial
state bytes and digest; state carries prepared, control, and acquired-event
paths but none of their digests;
control carries prepared and stable state identities/digests; acquired carries
the control digest; finalized carries the acquired predecessor digest and exact
normal-cleanup terminal journal digest. Lock claims always carry
`ControllerSourceIdentity`; normal commands therefore still bind the accepted
reconciler artifact stored in control while also binding their accepted source
manifest.

Every parser follows the same exact-key pattern:

```ts
export function expectExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort()
  const expected = [...required].sort()
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new Error(`${label} keys mismatch`)
  }
}
```

## Task 1: Establish Strict Types, Synthetic Fixtures, and Source-Closure Integrity

**Files:**
- Create ignored: `infra-durable-types.ts`
- Create ignored: `infra-controller.test-support.ts`
- Create ignored: `infra-control.tsconfig.json`
- Modify ignored: `infra-runner.ts`
- Modify ignored: `infra-runner.test.ts`
- Test ignored: `infra-durable-types.test.ts`

- [ ] **Step 1: Write failing exact-schema and source-closure tests**

Cover canonical JSON, lowercase hashes, run IDs, decimal identities, rejection of
unknown/missing keys, `exactOptionalPropertyTypes`, and runner-integrity schema
version 2. Freeze every `RunStateV2`, repository marker, prepared, control,
acquired, finalized, reconciliation setup, source-manifest, and source-identity
key listed above.
Prove a missing or mismatched `--accepted-source-manifest-sha256`, or replacement
of any imported source file, fails before lock or state mutation. Build only
synthetic files; snapshot their tree before and after each rejection. The exact
legacy fixture is an independently authored literal with different run ID,
nonce, paths, timestamps, and commit from the protected run; tests never copy or
parameterize from protected bytes.

- [ ] **Step 2: Run the focused tests and confirm red**

```bash
pnpm exec tsx --test \
  "$LEGACY_RUN_ROOT/infra-durable-types.test.ts" \
  "$LEGACY_RUN_ROOT/infra-runner.test.ts" \
  --test-name-pattern='durable types|source closure'
```

Expected: failure because exact durable schemas and integrity schema version 2
do not exist.

- [ ] **Step 3: Implement exact types, fixture builders, and integrity v2**

The fixture factory accepts a temporary root and returns all paths explicitly;
it must not read global environment or the protected run. The integrity sidecar
contains a sorted, nonempty `sources` array and requires the exact path, mode
`0600`, stable identity, and digest for every runtime import.

- [ ] **Step 4: Typecheck and rerun focused tests**

```bash
pnpm exec tsc -p "$LEGACY_RUN_ROOT/infra-control.tsconfig.json" --noEmit
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-durable-types.test.ts"
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-runner.test.ts" \
  --test-name-pattern='source closure'
```

Expected: pass under strict NodeNext and `exactOptionalPropertyTypes`.

- [ ] **Step 5: Record ignored source hashes**

```bash
shasum -a 256 "$LEGACY_RUN_ROOT"/infra-durable-types.ts \
  "$LEGACY_RUN_ROOT"/infra-controller.test-support.ts \
  "$LEGACY_RUN_ROOT"/infra-runner.ts > "$LEGACY_RUN_ROOT/task-01-source-hashes.txt"
```

Do not commit ignored files.

## Task 2: Resolve and Authenticate Durable Paths

**Files:**
- Create ignored: `infra-durable-paths.ts`
- Test ignored: `infra-durable-paths.test.ts`
- Modify ignored: `infra-runner.ts`

- [ ] **Step 1: Write failing state-home and checkout-scope tests**

Test environment redirection, known temporary roots, direct `.git`, strict
`gitdir:` plus `commondir`, symlinks, extra lines, traversal, wrong owner,
permissive modes, identity swaps, checkout deletion/recreation, and two Git
common-directory identities at the same checkout path. Expected scope is:

```ts
sha256(`${canonicalRepoRoot}\0${canonicalGitCommonDirectory}`)
```

- [ ] **Step 2: Confirm red**

```bash
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-durable-paths.test.ts"
```

Expected: missing durable path resolver.

- [ ] **Step 3: Implement fixed-home resolution and descriptor-bound descent**

Resolve `os.userInfo().homedir`, canonicalize it, append `.local/state`, and
reject paths equal to or below canonical `os.tmpdir()`, `/tmp`, or
`/private/tmp`. Create only planned `0700` directories, never chmod existing
ancestors, reject symlinks and group/world-writable components, and return
captured identities with every `DurablePaths` result.

Node exposes no native `openat`/`unlinkat`. Implement `DirectoryCapability`
with an open directory `FileHandle` and a descriptor-root pathname
(`/proc/self/fd/<fd>` on Linux). Prove the descriptor root resolves to the
captured directory identity, perform child operations through that descriptor
root with `O_NOFOLLOW`, and revalidate both the pinned handle and original
pathname before and after each callback-free operation. Fail closed before the
first mutation when the platform lacks a working descriptor root. Darwin tests
must prove `/dev/fd/<fd>` is rejected as non-traversable and that no managed
path was created. Linux tests must move or replace the original pathname during
traversal and prove operations remain bound to the captured directory or reject
without mutation.

- [ ] **Step 4: Prove deterministic paths and strict failures**

```bash
pnpm exec tsc -p "$LEGACY_RUN_ROOT/infra-control.tsconfig.json" --noEmit
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-durable-paths.test.ts"
```

Expected: pass, including changed `TMPDIR` and simulated reboot cases.

- [ ] **Step 5: Record ignored source hashes**

```bash
shasum -a 256 "$LEGACY_RUN_ROOT"/infra-durable-paths.ts \
  "$LEGACY_RUN_ROOT"/infra-durable-paths.test.ts > "$LEGACY_RUN_ROOT/task-02-source-hashes.txt"
```

## Task 2A: Add Opaque Descriptor-Bound Child Operations

**Files:**
- Modify ignored: `infra-durable-paths.ts`
- Modify ignored: `infra-durable-paths.test.ts`
- Refresh ignored: `task-02-source-hashes.txt`

Task 3 must not trust the structural diagnostic fields on
`AuthenticatedDirectory` or import `__testing`. Add the smallest fixed-purpose
production seam that resolves every directory and child-file capability through
private runtime state.

- [ ] **Step 1: Write failing capability and lifetime tests**

Prove that structurally forged directory and child-file objects are rejected;
parents cannot close with open children; failed child closes remain retryable;
successful closes are terminal; every failed open and post-open validation
aggregates primary and cleanup failures; and every operation revalidates parent
descriptor, original pathname, file descriptor, and child namespace identity.
Cover traversal names, symlinks, wrong owner, wrong mode, identity swaps,
concurrent growth, oversized reads, and Linux capability failure without a
pathname fallback. Also cover concurrent parent close/open, parent
close/directory-operation, and child close/operation races; a poisoned parent
that retains an unclosed failed-open descriptor; the 4,096-entry listing bound;
primary plus all cleanup-error aggregation; atomic busy-parent rejection and
successful parent-close retry after child close; exact mode `0600` update and
mode `0400` read opens; and append overflow beyond the fixed 16 MiB result
bound.

- [ ] **Step 2: Confirm red**

```bash
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-durable-paths.test.ts" \
  --test-name-pattern='child-file capability|authenticated child'
```

- [ ] **Step 3: Implement fixed-purpose opaque child operations**

Keep the child brand private and validate every value through a private
`WeakMap`. Expose narrow production functions for create-exclusive mode-`0600`,
bounded read open, mode-`0600` update open, stable bounded read, exact-size
append, file sync, fixed `0600` to `0400` hardening, snapshot, sibling-only
hard-link, strict directory listing, pinned-directory sync, and retryable child
close. All path components are single non-traversing names and every file open
uses `O_NOFOLLOW`.

Use the exact exported type and function signatures in the design's
Capability-Bound Child Operations section. Acquire a directory operation lease
synchronously before the first `await`; serialize each child's operations; and
block parent close for in-flight operations, children, or retained failed-open
cleanup. A failed post-open cleanup poisons the parent and retains the handle.

Writable or non-`0400` child capabilities cannot hard-link. Hardening does not
promote update authority: callers must sync metadata, close the update
capability, and reopen read-only. A hard link requires source link count one,
targets only an absent sibling under the same authenticated parent, and proves
same inode, mode `0400`, and link count two afterward. Test unexplained
out-of-parent aliases, concurrent extra links, and source/target namespace
replacement. Publisher hooks remain outside these callback-free operations.

- [ ] **Step 4: Verify on Darwin and Linux**

On Darwin, prove unsupported capability failure occurs before mutation. On a
native or isolated Docker Linux test closure containing only allowed source and
test files, execute the positive create, resume, harden, link, list, sync,
identity-race, close-failure, and bound-growth matrix against
`/proc/self/fd/<fd>`. Never mount or copy protected stale evidence into the
Linux closure. Include writable-descriptor retirement, every concurrent
operation/close race, link-count races, and poisoned failed-open cleanup.

```bash
pnpm exec tsc -p "$LEGACY_RUN_ROOT/infra-control.tsconfig.json" --noEmit
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-durable-paths.test.ts"
```

- [ ] **Step 5: Refresh Task 2 acceptance and reviews**

Refresh `task-02-source-hashes.txt`, keep it mode `0600`, verify it from the
repository root, and repeat Task 2 spec-compliance followed by code-quality
review before restarting Task 3. Task 1 acceptance remains valid unless a Task
1 source changes. Any partial Task 3 test or implementation evidence is invalid;
restart Task 3 from its full red test step and run both Task 3 reviews against
the finalized capability signatures.

## Task 3: Add the Immutable JSON Publisher

**Files:**
- Create ignored: `infra-immutable-json.ts`
- Test ignored: `infra-immutable-json.test.ts`

- [ ] **Step 1: Write the full publication fault matrix first**

Inject faults before/after create, write, file sync, chmod, metadata sync,
hard-link, target-parent sync, and stable reread. Test raced finals, wrong bytes,
wrong modes, hard links replaced by symlinks, retained `0600` partial staging,
retained `0400` complete staging, unexplained entries, and a target whose direct
parent differs from the transaction directory. Reject wrong-owner staging,
non-regular staging, and staging larger than the fixed 2 MiB immutable-JSON
bound before parsing or replay. A `0600` partial must be an exact canonical-byte
prefix; reject malformed or oversized prefixes before mutation and append only
the missing suffix. Test unconditional resync of retained exact `0400` staging
and direct-parent resync before accepting an exact pre-existing final. Cover
writable-descriptor retirement, source link counts other than one, concurrent
extra aliases, source/target replacement, collision-capability cleanup, and a
winner collision after link but before parent sync. Reject canonical output
larger than 2 MiB before creating or appending a staging file.

- [ ] **Step 2: Confirm red**

```bash
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-immutable-json.test.ts"
```

- [ ] **Step 3: Implement one create-only publication primitive**

Expose this narrow contract:

```ts
export interface ImmutablePublication {
  readonly path: string
  readonly identity: FileIdentity
  readonly sha256: string
  readonly bytes: Uint8Array
}

export interface ImmutablePublisherHooks {
  readonly beforeCreate?: () => void | Promise<void>
  readonly afterCreate?: () => void | Promise<void>
  readonly beforeWrite?: () => void | Promise<void>
  readonly afterWrite?: () => void | Promise<void>
  readonly beforeDataSync?: () => void | Promise<void>
  readonly afterDataSync?: () => void | Promise<void>
  readonly beforeHarden?: () => void | Promise<void>
  readonly afterHarden?: () => void | Promise<void>
  readonly beforeMetadataSync?: () => void | Promise<void>
  readonly afterMetadataSync?: () => void | Promise<void>
  readonly beforeLink?: () => void | Promise<void>
  readonly afterLink?: () => void | Promise<void>
  readonly beforeParentSync?: () => void | Promise<void>
  readonly afterParentSync?: () => void | Promise<void>
  readonly beforeStableReread?: () => void | Promise<void>
  readonly afterStableReread?: () => void | Promise<void>
}

declare const immutableTargetCollisionBrand: unique symbol

export interface ImmutableTargetCollision extends Error {
  readonly [immutableTargetCollisionBrand]: true
  readonly target: AuthenticatedChildFile<"read">
}

export function isImmutableTargetCollision(
  value: unknown,
): value is ImmutableTargetCollision

export async function publishImmutableJson(options: {
  readonly parent: AuthenticatedDirectory
  readonly finalName: string
  readonly value: unknown
  readonly lockGeneration?: number
  readonly hooks?: ImmutablePublisherHooks
}): Promise<ImmutablePublication>
```

Canonicalize once, stage mode `0600`, sync bytes, chmod `0400`, sync metadata,
hard-link to the absent final name, sync the final name's direct parent, and
stably reread. Derive the strict staging name internally from the final target,
content digest, and lock generation when present; callers cannot supply an
arbitrary staging binding. Never rename, overwrite, or delete staging evidence.
Every staging replay requires a bounded regular file owned by the current
effective user; mode `0600` may be only an exact prefix and appends only the
missing suffix at its authenticated size. After complete-byte sync, harden,
sync metadata, close update authority, and reopen read-only before linking. A
retained `0400` stage is synced again before linking. Mode `0400` must match the
complete digest encoded in its filename and have link count one before a new
link.
An exact pre-existing final is accepted. A different stable final throws a
typed `ImmutableTargetCollision` containing only its authenticated read
capability. Before exact-final acceptance, sync its direct parent again and
prove the expected staging alias, inode, mode, bytes, and link count. Ownership
of a collision capability transfers to the catcher, which must close it in
`finally`. Before semantic adoption, the catcher must validate the winner, sync
the authenticated direct parent, and stably reread the same capability. The
publisher never decides semantic adoption: setup code may catch that collision
and validate the winner's accepted evidence/path plan, while lock code may catch
it and validate the winner's generation/predecessor before returning `lost`.
Every other caller treats collision as fatal. Hooks run only between complete
capability operations at the exact named boundaries above. Collision creation
and the type guard use private runtime state; structural lookalikes are rejected.

- [ ] **Step 4: Run focused verification and stress exact adoption**

```bash
pnpm exec tsc -p "$LEGACY_RUN_ROOT/infra-control.tsconfig.json" --noEmit
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-immutable-json.test.ts"
for i in $(seq 1 25); do
  pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-immutable-json.test.ts" \
    --test-name-pattern='race|parent sync' >/dev/null || exit 1
done
```

Expected: all passes, with no overwritten final path.

## Task 4: Implement the Lease-Event Ledger

**Files:**
- Create ignored: `infra-lease-ledger.ts`
- Test ignored: `infra-lease-ledger.test.ts`

- [ ] **Step 1: Write failing grammar and digest-chain tests**

Cover both allowed genesis events, contiguous generations, inactive-to-prepared,
prepared-to-acquired, acquired-to-finalized, cross-run rejection, gaps, forks,
two successors, malformed names, wrong predecessors, unknown keys, staging
residue, and reconciliation refusal after any schema-version-2 event.

- [ ] **Step 2: Confirm red**

```bash
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-lease-ledger.test.ts"
```

- [ ] **Step 3: Implement strict parsing and transition construction**

Return a discriminated resolution:

```ts
export type LeaseResolution =
  | { readonly status: "empty"; readonly nextGeneration: 0 }
  | { readonly status: "prepared"; readonly latest: AllocationPreparedEvent }
  | { readonly status: "active"; readonly latest: AcquiredEvent }
  | { readonly status: "inactive"; readonly latest: FinalizedEvent | LegacyLeaseRetiredEvent }
```

Event filenames bind zero-padded generation and event kind. Parse every
authoritative file before selecting latest; never treat a directory listing's
last entry as authority.

- [ ] **Step 4: Run focused verification**

```bash
pnpm exec tsc -p "$LEGACY_RUN_ROOT/infra-control.tsconfig.json" --noEmit
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-lease-ledger.test.ts"
```

## Task 5: Implement the Append-Only Challenge Lock

**Files:**
- Create ignored: `infra-durable-lock.ts`
- Test ignored: `infra-durable-lock.test.ts`

- [ ] **Step 1: Write failing process and chain tests**

Use real child processes and loopback sockets. Test exact challenge responses,
losing claim races, crash before/after every publisher boundary, live holders,
connection refusal plus `ESRCH`, PID reuse, `EPERM`, timeout, malformed response,
ambiguous network errors, deterministic dead-retirement contention, released
versus dead-retired conflict, generation gaps, and successor-before-terminal.
Run the same cases for both `ControllerSourceIdentity` variants and reject a
normal claim whose source manifest or control-record reconciler hash changes.

- [ ] **Step 2: Confirm red**

```bash
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-durable-lock.test.ts"
```

- [ ] **Step 3: Implement lock claims and deterministic terminals**

Claims contain generation, predecessor-terminal digest, run/transaction IDs,
nonce, PID, loopback port, and accepted Node/reconciler digests. A holder owns
the critical section only while its exact claim remains highest and its server
is listening. `dead-retired` contains no observer identity or timestamp, so
independent contenders compute identical bytes.

- [ ] **Step 4: Run process stress**

```bash
pnpm exec tsc -p "$LEGACY_RUN_ROOT/infra-control.tsconfig.json" --noEmit
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-durable-lock.test.ts"
for i in $(seq 1 50); do
  pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-durable-lock.test.ts" \
    --test-name-pattern='contention|dead retirement' >/dev/null || exit 1
done
```

Expected: exactly one winner and one terminal per generation.

## Task 6: Allocate and Resume Schema-Version-2 Runs

**Files:**
- Create ignored: `infra-durable-allocation.ts`
- Test ignored: `infra-durable-allocation.test.ts`
- Modify ignored: `infra-runner.ts`
- Modify ignored: `infra-runner.test.ts`

- [ ] **Step 1: Write failing allocation-order and replay tests**

Assert exact order: authenticate or create the checkout scope, immutably publish
or authenticate exact `repository.json`, create the private run/tool root,
immutably publish or authenticate the owner marker, publish
`allocation-prepared`, repository state, `control.json`, then the acquired event
referenced by `state.leaseAcquisitionPath`. Kill before and after each mutation,
restart in a new process, and require identical prepared state bytes. Owner
marker tests cover every publisher fault, exact mode `0400`, replay, identity
replacement, and mismatched existing bytes.
Test no acquired event without state/control, no download before acquired,
pre-prepared exact rollback, post-prepared preservation, pre-existing run IDs,
identity swaps, checkout disappearance, changed `TMPDIR`, and legacy lease
blocking without the exact genesis retirement. Reuse a matching checkout scope
only after exact repository-marker authentication; reject a missing, replaced,
forked, wrong-mode, wrong-identity, or path-mismatched marker before run
allocation.

- [ ] **Step 2: Confirm red**

```bash
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-durable-allocation.test.ts"
```

- [ ] **Step 3: Implement allocation and runner integration**

Add `RunStateV2` as an exact schema, retain `LegacyRunStateV1` only in the
reconciliation module, and make normal commands accept only version 2. A fresh
run root contains controller source and no state; `bootstrap` derives the
validated run ID from its canonical run-root basename, allocates durable
control, publishes initial state, acquires the lease event, and only then enters
the existing bootstrap phases. Store canonical durable paths in state and never
re-derive them in later commands. Capture the clean initial Git HEAD and branch
into v2 state during allocation and replace the current `INITIAL_HEAD` and
`EXPECTED_BRANCH` constants in normal v2 command checks with those recorded
values. The frozen legacy parser retains the reviewed historical values.

The operator first creates one new private repository run root, copies the
exact accepted source set, and publishes its canonical source manifest with a
create-exclusive mode-`0600` write plus parent sync. Bootstrap requires that
manifest's independently recorded digest as its only argument. Before the
prepared event, rollback may remove only empty identities created by this exact
attempt; after prepared publication, replay preserves and resumes all control
evidence.

- [ ] **Step 4: Adapt normal cleanup without broadening authority**

Keep the existing exact removal journal. Point its arena and payload at the
durable run-control filesystem and append `finalized` only after the journal
proves the exact authenticated root was removed. Retain the durable run and
control records. Add a negative test proving an absent root alone cannot retire
the lease or remove a parent. Retain
`preserve-unauthenticated-pre-resource` in the cleanup discriminated union and
its tests only as preservation evidence: it may retain an exact observed root
and block cleanup, but can never remove a path or append `finalized`. Remove the
old positive schema-version-1 normal-finalization behavior; schema-version-1
absent roots are finalized only by the standalone reconciler, with no
backwards-compatible normal cleanup success path.

- [ ] **Step 5: Run focused and existing integration tests**

```bash
pnpm exec tsc -p "$LEGACY_RUN_ROOT/infra-control.tsconfig.json" --noEmit
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-durable-allocation.test.ts"
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-runner.test.ts" \
  --test-name-pattern='schema version 2|durable allocation|normal cleanup'
```

Expected: pass with all fixtures outside the protected run.

## Task 7: Validate Exact Legacy Evidence and Reconciliation Options

**Files:**
- Create ignored: `infra-reconciliation.ts`
- Test ignored: `infra-reconciliation.test.ts`

- [ ] **Step 1: Write failing CLI and evidence-matrix tests**

Test every missing, duplicate, malformed, or unknown option; canonical run-root
descendant audit enforcement; exact mode/uid/type/size bounds; stable identity
before/after reads; accepted hashes; Node path/version/tool record agreement;
exact results JSON and TSV projections; every pre-resource state deviation;
registry PID; ordinary cleanup journal; nonempty v2 ledger; and root presence or
reappearance. Snapshot all evidence metadata before and after rejection.

- [ ] **Step 2: Confirm red**

```bash
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-reconciliation.test.ts" \
  --test-name-pattern='options|legacy evidence|absence'
```

- [ ] **Step 3: Implement option parsing and the frozen legacy overlay**

The parser accepts only `reconcile-absent-pre-resource` plus each required
option exactly once. Extract the current schema-version-1
`validateState(..., { allowStaleFix: true })` logic into
`infra-durable-types.ts` without semantic changes, freeze it under a
`validateLegacyReconciliationState` export, and add the exact pre-resource
overlay in this module. The runner imports the shared exact field validators but
normal commands reject schema version 1. The reconciler bundle therefore gets
the reviewed parser without importing `infra-runner.ts`. Use bounded descriptor
reads: Node max 256 MiB, reconciler max 2 MiB, and existing evidence bounds from
the design.

- [ ] **Step 4: Implement repeated descriptor-bound absence probes**

Probe the exact recorded parent and basename without following the child.
Return a captured parent identity and observation timestamp; revalidate both at
every authorization boundary. Never call a delete API from this module.

- [ ] **Step 5: Run focused verification**

```bash
pnpm exec tsc -p "$LEGACY_RUN_ROOT/infra-control.tsconfig.json" --noEmit
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-reconciliation.test.ts" \
  --test-name-pattern='options|legacy evidence|absence'
```

## Task 8: Implement Setup, Attestation, and Reconciliation Replay

**Files:**
- Modify ignored: `infra-reconciliation.ts`
- Modify ignored: `infra-reconciliation.test.ts`

- [ ] **Step 1: Write the phase and crash matrix first**

Cover none, setup-planned, intent, absence-attested, and legacy-retired. Inject
faults at every staging, hard-link, parent-sync, directory-creation, lock, and
phase boundary. Race setup publication, replace/fork each record, add
unexplained entries, mutate each protected file, reintroduce the root, and
restart in a fresh process after every durable point. Every preliminary source,
evidence, schema, projection, audit-route, ledger, or absence failure must prove
that no setup plan or external control path was created. After setup, crash at
each authorized scope, marker, lock-directory, legacy run-directory, and
transaction-directory creation; replay must authenticate exact existing paths
without deleting them. Add an explicit test that `intent` cannot publish until
lock ownership and the complete locked evidence/absence pass both succeed.

- [ ] **Step 2: Confirm red**

```bash
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-reconciliation.test.ts" \
  --test-name-pattern='setup|attestation|phase|replay|retirement template'
```

- [ ] **Step 3: Implement setup-plan publication before external mutation**

Run the complete preliminary Node/reconciler/evidence/schema/projection/audit/
ledger/absence validation first. Only after it passes, publish
`durable-reconciliation-setup.json` in the authenticated repository run root.
The winner commits transaction ID, logical-finalization time, exact evidence
digests, state-base/scope inputs, exact repository-marker bytes and digest,
planned paths, and the required effective owner and mode for every planned
directory and immutable record. The parser rejects unknown/missing setup keys.
A racing loser catches `ImmutableTargetCollision` and may adopt only a stable
winner with the same accepted evidence, marker digest, owner/mode plan, and
derivation, then uses the winner's transaction and timestamp. No external
durable directory exists before this step completes.

- [ ] **Step 4: Create only setup-authorized paths and acquire the lock**

Create or authenticate the exact private scope, repository marker, lock root,
legacy run-control root, and empty cleanup-transaction root in the setup plan's
order. Acquire the append-only lock before creating/authenticating the legacy
run and transaction directories. Under the held claim, repeat the complete
source/evidence/schema/projection/ledger/absence validation and reauthenticate
the setup plan and every created path. Any mismatch or lock loss stops before
`intent` and leaves all setup evidence intact.

- [ ] **Step 5: Implement the no-delete reconciliation transaction**

After lock acquisition, publish exact `00-intent.json`, immutable attestation,
`01-absence-attested.json`, then the genesis
`legacy-lease-retired` event. The intent commits a retirement template with
`leasePredecessorSha256: null` and no
`reconciliationPredecessorSha256`; derive the terminal event by adding the
absence-phase digest. The attestation uses fixed conclusion and cause strings
from the design and explicitly denies resource/removal proof. After terminal
publication, reread and strictly parse the complete lease directory, prove the
terminal is the unique genesis/latest event and exactly retires this legacy
lease/transaction, revalidate protected evidence and absence once more, and
only then return success. Replay from an already visible terminal performs the
same verification without another mutation.

- [ ] **Step 6: Prove immutability and replay convergence**

```bash
pnpm exec tsc -p "$LEGACY_RUN_ROOT/infra-control.tsconfig.json" --noEmit
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-reconciliation.test.ts"
```

Expected: every phase restart converges to identical authoritative bytes, the
legacy lease and `state.finalizedAt` remain unchanged, and no delete/resource
hook is observed.

## Task 9: Build and Harden the Standalone Reconciler

**Files:**
- Create ignored: `infra-reconciler-entry.ts`
- Create ignored: `build-infra-reconciler.mjs`
- Generate ignored: `infra-reconciler.mjs`
- Create ignored: `infra-reconciler.process.test.ts`

- [ ] **Step 1: Write failing executable-closure process tests**

Launch only the accepted canonical Node binary. Test package-runner, `tsx`,
loader/preload flags, symlinked Node/reconciler, wrong Node version/path/hash,
wrong reconciler hash/identity, `NODE_OPTIONS`, `NODE_PATH`, unexpected env,
dynamic/local/package imports, normal dispatcher strings, and source
replacement before each mutation. Use the test process's real canonical Node
executable and construct synthetic state/tool evidence around it; do not use a
wrapper that broadens the executable closure.

- [ ] **Step 2: Confirm red**

```bash
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-reconciler.process.test.ts"
```

- [ ] **Step 3: Implement the minimal entrypoint and deterministic bundle**

```bash
node "$LEGACY_RUN_ROOT/build-infra-reconciler.mjs" --write
chmod 0600 "$LEGACY_RUN_ROOT/infra-reconciler.mjs"
```

The entrypoint performs only argument parsing, executable preflight, and a call
to the reconciliation engine. It must not import `infra-runner.ts`, invoke a
child process, or contain normal infrastructure command names. The build script
imports the pinned workspace `esbuild@0.28.1`, fixes bundle/platform/format/
target/legal-comment settings, writes no source map, emits a metafile, and
rejects every input outside the explicit reconciliation graph. It is used only
before acceptance and is not imported by the generated runtime.

- [ ] **Step 4: Inspect the emitted module graph and deterministic bytes**

```bash
node "$LEGACY_RUN_ROOT/build-infra-reconciler.mjs" --check
node --check "$LEGACY_RUN_ROOT/infra-reconciler.mjs"
! rg --pcre2 '(?:from|import\()\s*["\x27](?!node:)' "$LEGACY_RUN_ROOT/infra-reconciler.mjs"
node -e '
const {readFileSync}=require("node:fs");
const m=JSON.parse(readFileSync(process.argv[1],"utf8"));
const bad=Object.keys(m.inputs).filter(p=>!p.endsWith("infra-reconciler-entry.ts")&&!/infra-(durable-types|durable-paths|immutable-json|lease-ledger|durable-lock|reconciliation)\.ts$/.test(p));
if(bad.length) throw new Error(`unexpected bundle inputs: ${bad.join(", ")}`)
' "$LEGACY_RUN_ROOT/infra-reconciler-metafile.json"
```

- [ ] **Step 5: Run process tests with clean environments**

```bash
pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-reconciler.process.test.ts"
```

Expected: all acceptance paths run directly under Node and all rejected paths
leave fixture trees unchanged.

## Task 10: Complete Isolated Verification and Two-Stage Review

**Files:**
- Modify ignored files only when a review finding requires it
- Create ignored: `implementation-acceptance.txt`

- [ ] **Step 1: Run strict typecheck, scoped lint, and every ignored test**

```bash
pnpm exec tsc -p "$LEGACY_RUN_ROOT/infra-control.tsconfig.json" --noEmit
pnpm exec biome check \
  "$LEGACY_RUN_ROOT"/infra-durable-*.ts \
  "$LEGACY_RUN_ROOT"/infra-immutable-json.ts \
  "$LEGACY_RUN_ROOT"/infra-lease-ledger.ts \
  "$LEGACY_RUN_ROOT"/infra-reconciliation*.ts \
  "$LEGACY_RUN_ROOT"/infra-reconciler-entry.ts \
  "$LEGACY_RUN_ROOT"/infra-controller.test-support.ts \
  "$LEGACY_RUN_ROOT"/infra-runner.ts \
  "$LEGACY_RUN_ROOT"/infra-runner.test.ts
pnpm exec tsx --test "$LEGACY_RUN_ROOT"/*.test.ts
```

- [ ] **Step 2: Run focused stress and protected-evidence nonmutation checks**

Record fresh `stat` and SHA-256 snapshots of protected evidence before and after
stress. The missing tool root must remain absent.

```bash
for i in $(seq 1 25); do
  pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-durable-lock.test.ts" \
    --test-name-pattern='contention|dead retirement' >/dev/null || exit 1
  pnpm exec tsx --test "$LEGACY_RUN_ROOT/infra-reconciliation.test.ts" \
    --test-name-pattern='crash|restart|reappearance' >/dev/null || exit 1
done
```

- [ ] **Step 3: Dispatch an independent spec-compliance reviewer**

Give the reviewer only the approved spec, this plan, the ignored source/test
paths, generated bundle/metafile, and test output. Require findings with exact
file/line references and an explicit answer on deletion/resource reachability,
hash-cycle freedom, protected-file immutability, lock ambiguity, and ledger
grammar. Fix findings through TDD and rerun Steps 1-2.

- [ ] **Step 4: Dispatch an independent code-quality reviewer**

Require review of parser exactness, descriptor lifetime, fsync target, error
aggregation, process cleanup, test determinism, source closure, and
maintainability. Fix findings through TDD and rerun Steps 1-2.

- [ ] **Step 5: Freeze accepted hashes**

Write `implementation-acceptance.txt` with exact hashes for all ignored source,
tests, bundle, metafile, and verification logs. Set implementation files mode
`0600`. Do not include protected evidence hashes yet; Task 11 records those
immediately before launch.

## Task 11: Reconcile the Protected Stale Run Once (Deferred on Darwin)

**Status:** Deferred. Do not execute this task on the current Darwin host. The
protected evidence must remain unopened and unchanged until a separate native
Darwin descriptor-relative mutation design is approved and implemented. Do not
copy the evidence to Linux because doing so changes the identities this
transaction authenticates.

**Files:**
- Read unchanged: `state.json`, `results.json`, `results.tsv`, prior audit,
  legacy `active-run.json`, accepted Node binary, and `infra-reconciler.mjs`
- Create immutable: `durable-reconciliation-setup.json` and planned durable
  reconciliation/ledger records
- Create ignored: `reconciliation-acceptance.txt`

- [ ] **Step 1: Independently capture exact pre-launch evidence**

Platform prerequisite: a reviewed native Darwin `openat`-family authority
implementation is available and included in the accepted executable closure.
Without it, stop before reading any protected path.

Use two separate Node processes to capture no-follow identities, modes, sizes,
times, and SHA-256 values. Confirm they agree, the tool root is absent, the
ledger is empty, and all accepted hashes match the implementation acceptance
record. Do not derive CLI hash arguments from within the reconciler invocation.

- [ ] **Step 2: Launch exactly once with a clean allowlisted environment**

Invoke the canonical Node binary and exact `infra-reconciler.mjs` path with all
required accepted hashes and the canonical prior-audit path. Use `env -i` with
only the locale keys allowed by the implementation. Do not invoke through
pnpm, tsx, npm, a shell loader, or a symlink.

- [ ] **Step 3: Authenticate the completed chains**

Verify setup, lock claim/release, intent, attestation, absence phase, and the
unique genesis `legacy-lease-retired` event. Confirm the terminal event binds
the exact legacy lease identity/hash and the absence digest, and the ledger
resolves inactive.

- [ ] **Step 4: Prove legacy evidence and resource state were untouched**

Compare pre/post bytes and metadata for state, results, lease, prior audit,
Node, and reconciler. Confirm `state.finalizedAt` is still null, the legacy
lease remains present and unchanged, the old tool root remains absent, and no
Docker/Kind/Kubernetes/registry/download/removal operation was emitted.

- [ ] **Step 5: Record the operational acceptance audit**

Write hashes, identities, exact command argv, clean environment key names,
phase-chain digests, logical-finalization timestamp, and nonmutation result to
`reconciliation-acceptance.txt`. Never record credentials or environment
values.

## Task 12: Rebase, Run the Fresh Linux Ladder, and Integrate the Branch

**Files:**
- Reassess tracked workflows, compatibility policy, chart topology, and branch
  changes after current `main`
- Create ignored: a new schema-version-2 dedicated-infrastructure run and its
  acceptance logs
- Modify tracked files only for proven post-rebase regressions, with a
  changeset when user-facing packages change

- [ ] **Step 1: Fetch and rebase onto current main**

```bash
git status --short --branch
git fetch origin main
git rebase origin/main
```

Resolve conflicts in favor of current architecture and current `main` behavior,
not by restoring stale fixtures. After rebase, reread `AGENTS.md`, CI workflows,
compatibility policy, chart files, and release checks; update this operational
procedure only if their current contracts changed.

- [ ] **Step 2: Run the repository build before any `dist/` consumer**

```bash
pnpm install --frozen-lockfile
pnpm build
```

- [ ] **Step 3: Create a fresh v2 run and inspect allocation before bootstrap**

On native or hosted Linux, copy only the accepted ignored controller
source/test/bundle set into a new private ignored repository run root. Invoke
`bootstrap`; before its first child command hook, assert the tool root is under
canonical user state, the prepared event/state/control/acquired chain is
complete, no repo-local active lease was created, and changed `TMPDIR` cannot
alter recorded paths. Publish the exact source manifest first and pass its
independently recorded digest as
`bootstrap --accepted-source-manifest-sha256 <sha256>`; no source-seeding helper
is part of the authenticated controller or product repository. On Darwin, run
only the unsupported-platform no-mutation assertion.

- [ ] **Step 4: Run the full ladder sequentially**

Execute on native or hosted Linux in the canonical order:

1. `chart-apply-1.35`
2. `focused-1.35`
3. `focused-1.34`
4. `focused-1.36`
5. `kubernetes-e2e-1.35`
6. `docker-e2e`

Use the existing retry/fix policy from
`docs/superpowers/plans/2026-08-11-dedicated-infrastructure-lanes.md`. Do not
skip a lane, parallelize resource-owning lanes, or widen cleanup authority.

- [ ] **Step 5: Validate and normally finalize the fresh run**

Run `validate`, then `cleanup`. Prove the exact durable tool root alone was
removed, the normal cleanup journal is complete, one `finalized` event follows
the exact `acquired` event, and durable run/control/ledger evidence remains.

- [ ] **Step 6: Run the full repository Definition of Done**

```bash
pnpm ci:validate
```

Also run the gated infrastructure lanes whose local equivalents changed and
the chart validation/apply smoke commands if they are not already represented
by the dedicated ladder. Run `node scripts/check-changesets.mjs` before opening
the PR.

- [ ] **Step 7: Review and publish the branch**

Use `superpowers:requesting-code-review` for the tracked diff. Ensure commit and
PR text contain no references to coding-agent products. Push
`blove/kubernetes-compat-hardening`, open the PR, report the exact local ladder
and Definition-of-Done evidence, and merge only after required hosted Linux
checks are green.

- [ ] **Step 8: Verify the merged revision locally and in hosted production**

Fetch `origin/main`, verify the merge commit contains the reviewed tracked
changes, build and run the relevant pure and unsupported-platform local smoke
checks from that revision, and confirm the hosted required checks and Linux
infrastructure lanes completed on the merged SHA. Treat hosted CI as the
production verification for this local infrastructure feature; do not deploy
or mutate a Dawn application runtime.
