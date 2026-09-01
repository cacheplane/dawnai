# Duplicate Draft Consolidation Design

**Date:** 2026-09-01  
**Status:** Approved direction; implementation not started  
**Repository:** `cacheplane/dawnai`  
**Candidate:** `v0.8.22` at `2a80deece2ff958fe7fde8fddeb4f99bed70a1c8`

## Summary

The v0.8.22 recovery is blocked because GitHub currently contains three mutable,
marker-identical `ESCROWED` drafts for one candidate. Dawn deliberately refuses
to choose between duplicate managed Releases. Before the npm trust cutover or
prepublication abandonment can proceed, the duplicate set must converge to one
unambiguous managed draft.

The consolidation preserves Release `379991871`, which the previously approved
immutable-draft recovery design explicitly identified as the existing v0.8.22
draft. A dedicated local operator CLI will prove complete parity, delete only
Releases `379982100` and `379986168`, verify the unchanged survivor, and emit a
canonical public receipt. The Release workflow remains disabled throughout the
live consolidation.

This is single-owner recovery. It provides deterministic evidence, exhaustive
read-before-write checks, resumability, and a stable survivor, but it does not
claim dual control or a GitHub-side atomic compare-and-delete primitive.

## Current Evidence

Read-only observations on 2026-09-01 found these managed drafts:

| Role | Release ID | Opaque `tag_name` |
| --- | ---: | --- |
| survivor | `379991871` | `untagged-be0ff4bee4ba43b521a9` |
| duplicate | `379982100` | `untagged-a13939767dd2419ade01` |
| duplicate | `379986168` | `untagged-20706099efa3c38335a8` |

All three are mutable drafts named `Dawn v0.8.22`, target `main`, contain the
same canonical `ESCROWED` body, identify the same candidate and annotated tag,
and expose the same 45-name asset projection. The Release and asset IDs differ,
as expected for independent GitHub objects. Live state must be re-read before
any action; this table is evidence, not continuing authority.

The survivor is not chosen by numeric ordering or most-recent mutation. Release
`379991871` is pinned because the earlier approved recovery design and plan
explicitly named it as the draft to converge and preserve.

## Goals

- Converge exactly three equivalent v0.8.22 managed drafts to exactly one.
- Preserve Release `379991871`, its opaque draft identity, body, and all 45
  assets without mutation.
- Delete only Releases `379982100` and `379986168` after exhaustive equality
  and live-authority checks.
- Emit a canonical, bounded, self-verifying receipt suitable for source control.
- Make interruption after the first deletion safely resumable.
- Keep Release disabled and prevent npm publication throughout consolidation.
- Restore the exactly-one-draft precondition required by the abandonment
  controller and subsequent trust cutover.

## Non-goals

- Do not abandon v0.8.22 in this operation.
- Do not publish, retag, rename, edit, or recreate any Release.
- Do not delete or reuse the annotated `v0.8.22` tag.
- Do not add a third Release workflow operation or temporarily enable Release.
- Do not teach ordinary candidate discovery to choose among duplicates.
- Do not retain duplicate asset payloads in Git; the byte-identical survivor is
  the recovery source, while the receipt preserves identities and digests.
- Do not begin the npm trusted-publisher cutover.

## Considered Approaches

### 1. Preserve the recorded survivor and delete exact duplicates — selected

This restores the controller's one-object invariant with the smallest live
change. It retains the draft already named by the prior recovery design and
removes only redundant GitHub objects after byte-level parity checks.

### 2. Abandon all three drafts

This would leave three terminal records for one candidate, complicate discovery,
and preserve the ambiguity the controller is designed to reject. It also turns
one release incident into three apparently authoritative release records.

### 3. Edit two drafts so they no longer look managed

Removing or changing markers would be a fragile manual repair. It would retain
misleading drafts, require mutation of body evidence, and create behavior that a
future controller change could accidentally rediscover.

## Architecture

### Dedicated operator command

Add a dedicated CLI and production module for this one recovery class. It is
not a dormant abandonment command and is not reachable from `release.yml`.

The CLI has three modes:

- `inspect`: read and compare the exact live set; write a canonical proposed
  consolidation record without mutating GitHub.
- `perform`: repeat all live reads, validate the proposed record, delete the two
  exact duplicate IDs in deterministic order, and write a final receipt.
- `verify`: strictly parse and independently verify a final receipt against
  current GitHub state.

The implementation should separate strict parsing/classification, GitHub/npm
adapters, and mutation orchestration so tests exercise production logic without
shelling around it.

### Exact command contract

The survivor and duplicate IDs are explicit inputs, not discovered by sorting:

```text
survivor: 379991871
duplicates: 379982100,379986168
```

`perform` requires an exact confirmation string containing the version,
candidate SHA, survivor ID, and ordered duplicate IDs. The CLI rejects unknown,
duplicate, reordered, missing, or additional IDs. The survivor ID is excluded
from every deletion adapter by type and runtime checks.

The command runs only from a clean checkout of the exact merged `main` recovery
controller. Local Git HEAD, `origin/main`, and the GitHub default-branch SHA must
agree before the first writer and before the second writer.

### GitHub and npm adapters

Use bounded, paginated production readers for Releases, assets, annotated tags,
workflow states, workflow runs, and asset downloads. Authentication remains in
the environment or the existing `gh` session; tokens never appear in argv,
receipts, logs, or source files.

The only writer deletes one exact Release ID. It accepts the statically validated
duplicate-ID set and cannot receive the survivor ID.

## Equality Contract

Before deletion, exactly three managed v0.8.22 drafts must exist and no published
Release may match the candidate. For all three drafts, require:

- exact mutable metadata: name, target branch, draft/immutable/prerelease flags;
- exact canonical body bytes and SHA-256;
- exact `ESCROWED` marker, candidate version/SHA, annotated tag, revision, sealed
  manifest digest, release-record digest, base-asset-set digest, and attestation
  set;
- exactly 45 assets with the canonical unique name set;
- per-name size and GitHub digest equality;
- downloaded byte equality for every same-name asset across all three drafts;
- canonical sealed `manifest.json`, release record, and attestation-set validity;
- identical aggregate asset-set digest computed from sorted names, sizes, hashes,
  and downloaded bytes.

Release IDs, node IDs, opaque `tag_name` values, asset IDs, and timestamps are
recorded but are expected to differ. No other metadata difference is tolerated.

The annotated `v0.8.22` tag must remain annotated and peel to
`2a80deece2ff958fe7fde8fddeb4f99bed70a1c8`. All 21 fixed-group npm `0.8.22`
endpoints must return exact E404 in two observations at least 60 seconds apart.
Release must be `disabled_manually`, and no nonterminal Release run may exist.

All downloaded bytes and aggregate reads are bounded by existing release payload
limits plus an explicit three-draft aggregate ceiling. Pagination exhaustion,
duplicate IDs/names, missing digests, invalid base64, unknown assets, or a fourth
matching draft blocks the operation.

## Proposed and Final Receipts

`inspect` writes a canonical proposed record under `.dawn/release/`. It is local,
untracked, bounded, no-follow read on reuse, and contains no credentials or full
asset payloads.

`perform` writes a resumable local checkpoint before the first deletion and a
final canonical receipt at:

```text
scripts/release/duplicate-draft-consolidation.json
```

The final receipt records:

- schema version, repository identity, operator login/ID, controller SHA, exact
  confirmation, and timestamps;
- candidate and annotated-tag object/target identity;
- Release workflow state and bounded nonterminal-run query;
- both npm E404 observations and their interval;
- survivor before/after metadata, body digest, asset projection, and aggregate
  asset-set digest;
- each duplicate's Release/node/tag identity, body digest, asset projection, and
  aggregate asset-set digest;
- deterministic deletion order and exact successful deletion observations;
- final bounded Release enumeration proving exactly one managed draft;
- a digest over the canonical receipt bytes.

Receipt parsing uses exact fields, canonical ordering, strict UTF-8, byte bounds,
and digest recomputation. The tracked receipt is created only from a completed
live operation; the repository contains no placeholder success receipt.

## Mutation Flow

1. Re-read local/remote/main SHA identity and require a clean merged checkout.
2. Require Release `disabled_manually` and zero nonterminal Release runs.
3. Read all Releases and require the exact three-ID managed set.
4. Verify the annotated tag and two npm E404 observations at least 60 seconds
   apart.
5. Download and compare every asset and create the proposed record/checkpoint.
6. Immediately before the first writer, repeat main/workflow/run/tag/Release/body/
   asset reads and require exact equality with the checkpoint.
7. Delete Release `379982100`.
8. Re-read GitHub. Require the survivor and Release `379986168` unchanged,
   `379982100` absent, and no additional managed Release or active run.
9. Immediately repeat the authoritative checks and delete Release `379986168`.
10. Re-read GitHub and npm. Require only survivor `379991871`, unchanged body and
    45 downloaded assets, unchanged annotated tag, Release still disabled, no
    nonterminal run, and all npm endpoints still E404.
11. Atomically write the final canonical receipt and verify it independently.

GitHub does not provide this design with an atomic multi-Release transaction.
The protection is single-operator exclusivity, disabled release automation,
exact-ID writers, immediate full re-reads, deterministic order, checkpoints,
and postconditions. Any ambiguity stops rather than guessing.

## Interruption and Recovery

The operation is resumable only through the same CLI and checkpoint.

- Before any deletion: rerun from inspection.
- After deleting `379982100`: require it absent, require `379986168` and the
  survivor still exactly match the checkpoint, repeat all authority checks, then
  continue with the second deletion.
- After both deletions but before receipt write: require the exact final state and
  materialize the same final receipt.
- If the survivor is missing or changed, a deleted duplicate reappears, an
  unexpected draft appears, publication begins, or evidence differs: stop. Do
  not recreate, edit, or delete anything else automatically.

The survivor's verified bytes are the recovery source for the removed duplicate
payloads. The receipt preserves the deleted GitHub identities and byte digests;
no automatic duplicate recreation is part of this recovery.

## Failure and Stop Conditions

Stop before mutation or before the next deletion on any of these conditions:

- survivor or duplicate ID mismatch;
- additional, missing, published, immutable, or malformed candidate Release;
- metadata, body, marker, manifest, asset namespace, size, digest, or downloaded
  byte mismatch;
- moved, lightweight, missing, or retargeted annotated tag;
- any npm result other than exact E404;
- Release not disabled or any nonterminal Release run;
- local, origin, or GitHub main SHA disagreement;
- actor/repository mismatch, pagination overflow, aggregate byte overflow, or
  malformed API response;
- deletion response ambiguity or failed absence re-read;
- checkpoint/receipt drift or noncanonical bytes.

There is no force mode, survivor override, ID auto-selection, delete-all option,
manual repair path, tag mutation, or best-effort continuation.

## Testing and Rehearsal

Implementation follows test-first development and must cover:

- exact three-way equality and aggregate byte comparison;
- body/marker/manifest/attestation/asset mismatches;
- extra, missing, reordered, duplicate, or unknown Release/asset IDs;
- survivor ID reaching the deletion adapter;
- active runs, workflow-state drift, main drift, tag drift, npm publication, and
  pagination/byte-bound failures;
- runner loss before deletion, after the first deletion, after the second
  deletion, and before final receipt materialization;
- idempotent resume from each legal checkpoint state;
- rejection of every illegal partial state;
- final receipt canonicalization, tamper detection, and independent live verify;
- a realistic three-draft fake with distinct Release and asset IDs but exact
  same-name bytes;
- proof that Release stays disabled and the survivor is never written.

The full release-controller suite, docs checks, repository Definition of Done,
and Docker-required validation run before any live consolidation. The dedicated
CLI and every workflow-reachable dependency remain content-pinned where the
release integrity policy requires it.

## Delivery and Live Sequence

1. Implement and rehearse the dedicated consolidation command locally.
2. Run Task 12, including `DAWN_REQUIRE_DOCKER=1 pnpm ci:validate`.
3. Review, merge, and verify the exact recovery-controller head while Release
   remains disabled.
4. From a clean checkout of merged `main`, run `inspect`, review its proposed
   record, then run `perform` with the exact confirmation.
5. Independently verify the one-survivor state and final receipt.
6. Commit the final receipt in a focused follow-up change and rerun the relevant
   release-integrity verification.
7. Only then begin the npm trusted-publisher cutover and the remaining v0.8.22
   abandonment/v0.8.23 provenance-release sequence.

No step in this design removes the Vercel CLI, the real `vercel-native` lane, or
the later independent production deployment verification.
