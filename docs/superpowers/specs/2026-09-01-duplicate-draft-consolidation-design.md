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
- Keep Release disabled and repeatedly observe npm absence throughout
  consolidation. This excludes the active Release automation but cannot prevent
  an out-of-band publisher from racing the operator.
- Restore the exactly-one-draft precondition required by the abandonment
  controller and subsequent trust cutover.

## Non-goals

- Do not abandon v0.8.22 in this operation.
- Do not publish, retag, rename, edit, or recreate any Release.
- Do not delete or reuse the annotated `v0.8.22` tag.
- Do not add a third Release workflow operation or temporarily enable Release.
- Do not teach ordinary candidate discovery to choose among duplicates.
- Do not retain duplicate asset payloads in Git; the payload-identical survivor is
  the recovery source. Deleting a duplicate permanently removes its GitHub
  Release and asset identities, URLs, timestamps, and service history; the
  operator evidence retains the last observed identities and payload digests,
  not a recreatable GitHub object.
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
- `perform`: repeat all live reads, validate the proposed record, use a durable
  write-ahead journal while deleting the two exact duplicate IDs in
  deterministic order, and write a final receipt.
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

`perform` requires the canonical SHA-256 of the reviewed `inspect` record and an
exact confirmation string containing the version, candidate SHA, survivor ID,
and ordered duplicate IDs. Both values are persisted before any write. The CLI
rejects unknown, duplicate, reordered, missing, or additional IDs. The survivor
ID is excluded from every deletion adapter by type and runtime checks.

For this incident the exact string is:

```text
CONSOLIDATE v0.8.22 2a80deece2ff958fe7fde8fddeb4f99bed70a1c8 SURVIVOR 379991871 DELETE 379982100,379986168 PROPOSAL <64-lowercase-hex-digest>
```

The command runs only from a clean checkout of the exact merged focused
consolidation change. Local Git HEAD, `origin/main`, and the GitHub
default-branch SHA must agree before the first writer and before the second
writer.

### GitHub and npm adapters

Use bounded, paginated production readers for Releases, assets, annotated tags,
workflow states, workflow runs, and asset downloads. Authentication remains in
the environment or the existing `gh` session; tokens never appear in argv,
receipts, logs, or source files.

The only writer deletes one exact Release ID. It accepts the statically validated
duplicate-ID set and cannot receive the survivor ID. GitHub documents `204` and
`404` as the delete endpoint outcomes and does not document conditional
`DELETE` for this endpoint, so the design does not claim compare-and-delete:

- <https://docs.github.com/en/rest/releases/releases#delete-a-release>
- <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests>

## Equality Contract

Before deletion, exactly three managed v0.8.22 drafts must exist and no
published Release may match the candidate. Parsers require the known fields and
their types but tolerate additive GitHub response fields. Equality is defined
only by the following explicit semantic projections.

The Release projection is:

```text
name, target_commitish, draft, immutable, prerelease, published_at,
canonical body bytes, body SHA-256, author login/id/node_id
```

It must be identical for all three, with `draft: true`, `immutable: false`,
`prerelease: false`, `published_at: null`, target `main`, and the expected
single-owner author. The body must round-trip through `parseReleaseMarker` and
`canonicalReleaseBody` and bind the exact `ESCROWED` marker, candidate
version/SHA, annotated tag, revision, sealed-manifest digest,
release-record digest, canonical `baseAssetSetSha256`, and 22-subject
attestation set.

Release `id`, `node_id`, opaque `tag_name`, derived URLs, and
`created_at`/`updated_at` are validated and recorded but intentionally excluded
from equality. Unmentioned optional or additive API fields are not compared.

The per-name asset projection is:

```text
name, label, state, content_type, size, digest,
uploader login/id/node_id, downloaded SHA-256
```

It must be identical for all three and each downloaded byte sequence must be
equal. Asset `id`, `node_id`, derived URLs, timestamps, and `download_count` are
validated and recorded but excluded from equality. Missing required fields,
duplicate names/IDs, non-`uploaded` state, absent or malformed GitHub SHA-256,
and unknown assets fail closed.

The 45-asset namespace is the existing production escrow contract, not a new
consolidation-specific digest:

- one canonical `release-record.json`, parsed by `parseReleaseRecord` and
  compared to `canonicalReleaseRecordBytes`;
- 22 ordered subjects: canonical `manifest.json` plus the 21 fixed-group
  package archives, with the manifest parsed by `parseSealedReleaseManifest`;
- 22 ordered `.intoto.jsonl` bundle assets bound by `parseAttestationSet` and
  verified through the production attestation-bundle verifier;
- the exact ordered `{name, sha256}` projection produced by
  `canonicalBaseAssetSet`, whose digest must equal marker
  `baseAssetSetSha256`.

The implementation reuses these production parsers and verification routines;
if an internal verifier must become exported, that export is part of the
focused change. A separately named `consolidationPayloadSha256` may hash the
canonical three-Release equality projection for proposed-record binding, but it is
never substituted for `baseAssetSetSha256`.

The annotated `v0.8.22` tag must remain annotated and peel to
`2a80deece2ff958fe7fde8fddeb4f99bed70a1c8`. All 21 fixed-group npm `0.8.22`
endpoints must return exact E404 in two complete observations at least 60
seconds apart. Release must be `disabled_manually`, and no nonterminal Release
run may exist.

Freshness follows the existing abandonment chronology. The first npm inventory
is captured before the heavy work; downloads and byte verification occur during
the observation gap; the second complete inventory is captured at least 60
seconds later. Final main/workflow/run/tag/Release reads follow it, and the
first `DELETE` must begin while that second observation is no more than two
minutes old. After first-delete convergence, a fresh complete npm E404 inventory
is required immediately before the second writer. A final complete E404
inventory is required after both deletions. These checks observe absence; they
do not reserve the npm namespace or exclude an out-of-band publisher.

All downloaded bytes and aggregate reads are bounded by the existing 64 MiB
per-Release escrow limit and an explicit 192 MiB three-Release aggregate
ceiling. At most 45 assets per Release and 135 asset downloads overall are
accepted. Pagination exhaustion,
duplicate IDs/names, missing digests, invalid base64, unknown assets, or a fourth
matching draft blocks the operation.

## Proposed Record, Journal, and Final Receipt

The three files have distinct exact-schema envelopes:

```text
.dawn/release/duplicate-draft-consolidation.proposed.json
.dawn/release/duplicate-draft-consolidation.journal.json
scripts/release/duplicate-draft-consolidation.json
```

Each envelope is `{ "record": <exact-schema object>, "recordSha256": <hex> }`.
`recordSha256` is SHA-256 over the canonical UTF-8 JSON bytes of `record` plus
one newline; the digest field is outside the hashed projection. The proposed,
journal, and receipt records use separate schema identifiers and exact field
sets. All arrays have fixed canonical order, timestamps are canonical UTC, and
the maximum serialized sizes are 4 MiB for proposed, 512 KiB for journal, and
8 MiB for final receipt. Unknown/missing fields,
noncanonical bytes, invalid UTF-8, duplicate keys, digest mismatch, or excessive
size are rejected.

The exact top-level `record` fields, in canonical order, are:

```text
proposed:
  schemaVersion, repository, controller, candidate, roles, confirmation,
  annotatedTag, workflowAuthority, npmAuthority, releases, payloadProof,
  inspectedAt

journal:
  schemaVersion, repository, candidate, proposedRecordSha256,
  confirmationSha256, deletionOrder, targets, updatedAt

final:
  schemaVersion, proposed, proposedRecordSha256, journal,
  finalAuthority, finalSurvivor, completedAt
```

`roles` is exactly `{survivor, duplicates}` in the fixed ID order;
the proposed `confirmation` is exactly `{version, commitSha, survivor,
duplicates, template}` and its template retains the literal
`<64-lowercase-hex-digest>` placeholder, avoiding a self-reference to the
proposed envelope digest. The journal binds the fully substituted operator
string through `confirmationSha256`. `releases` is a three-element
survivor-then-duplicates array of the exact Release and asset projections
defined in Equality Contract; `payloadProof` is exactly
`{baseAssetSet, baseAssetSetSha256, consolidationPayloadSha256,
attestationVerification}`. `npmAuthority` contains ordered 21-package complete
inventories and their start/end timestamps. `workflowAuthority` contains the
workflow file/id/state plus the bounded run query and result.

`repository` is exactly `{name, id, defaultBranch, actor}` with `actor` exactly
`{login, id}`. `controller` is exactly `{headSha, originMainSha,
githubMainSha}` and all three SHAs must match. `candidate` is exactly
`{version, commitSha, tag}`. `annotatedTag` is exactly `{name, objectSha,
targetSha, objectType}`. Each authority observation carries its own
`observedAt`; no global timestamp is used to imply simultaneous reads.

Each journal `targets` entry is exactly `{releaseId, status, intent, outcome,
convergence}` in deletion order. Nullable subrecords remain present as `null`:
`intent` is `{persistedAt, lastObservationSha256}`, where the digest binds the
complete direct-read projection already materialized in the proposed record; `outcome` is
`{classification, httpStatus, observedAt}`; and `convergence` is
`{directGet404At, listAbsentAt, attempts, completedAt}`. `finalAuthority` and
`finalSurvivor` reuse the exact authority and survivor projections rather than
introducing weaker summary shapes. The implementation plan will translate
these field lists directly into strict parsers and canonicalizers; it may not
add evidence fields without revising this design and tests first.

The proposed record contains the immutable inspection evidence: repository and
candidate identity, controller SHA, exact ID roles, tag/workflow/npm authority,
all three Release and asset projections, the canonical base-asset-set proof,
attestation verification result, and `consolidationPayloadSha256`. It contains
no credentials or full asset payloads.

The journal contains the proposed-record digest, exact confirmation digest,
ordered deletion plan, and a state for each target:

```text
pending -> intent-persisted -> outcome-recorded -> absence-reconciled
```

Before every request, `intent-persisted` plus the digest binding the target's
complete last observation to the proposed record is atomically durable. At
`outcome-recorded`, outcome classification
is exactly `confirmed-204` or `outcome-ambiguous`. Only a response actually
received as `204` is confirmed. A timeout, transport failure, process loss, or
`404` after that initially-present observation is never relabeled as confirmed;
it is ambiguous. Both classifications must pass the bounded convergence checks
before status advances to `absence-reconciled`. A target initially absent
without a matching persisted intent is an illegal state.

Local evidence files are opened no-follow, must be regular files owned by the
operator, use mode `0600`, and are replaced through same-directory temporary
file + fsync + atomic rename + parent-directory fsync. Creation refuses an
existing symlink or unsafe path. The journal is write-ahead state, not merely a
log written after the request.

`perform` materializes a final canonical receipt at:

```text
scripts/release/duplicate-draft-consolidation.json
```

The final receipt records:

- schema version, repository identity, operator login/ID, controller SHA, exact
  confirmation, and timestamps;
- candidate and annotated-tag object/target identity;
- Release workflow state and bounded nonterminal-run query;
- both npm E404 observations and their interval;
- survivor before/after metadata, body digest, asset projection, and canonical
  base-asset-set digest;
- each duplicate's Release/node/tag identity, body digest, asset projection, and
  canonical base-asset-set digest;
- deterministic deletion order and, for each target, either a received
  `confirmed-204` observation or an honest
  `outcome-ambiguous-but-absence-reconciled` observation;
- final bounded Release enumeration proving exactly one managed draft;
- the full pre-delete proposed record, its digest, and the final journal state.

Receipt parsing uses the same safe-file and canonical-envelope rules. The
tracked receipt is created only from a completed live operation; the repository
contains no placeholder success receipt. `verify` can prove the receipt's
integrity, current survivor equality, deleted-ID absence, and current authority
postconditions. It cannot independently re-download deleted historical bytes;
those are supported by the embedded pre-delete observation and the survivor's
still-live identical payload. The first public durable copy is the focused
receipt follow-up commit after consolidation.

## Mutation Flow

1. Re-read local/remote/main SHA identity and require a clean merged checkout.
2. Require Release `disabled_manually` and zero nonterminal Release runs.
3. Read all paginated Releases and require the exact three-ID managed set.
4. Verify the annotated tag and capture the first complete npm E404 inventory.
5. During the at-least-60-second gap, download all 135 asset instances, apply
   production escrow/attestation verification, and prove the exact equality
   projections.
6. Capture the second complete npm E404 inventory. Then repeat
   main/workflow/run/tag/Release/body/asset metadata reads, bind them to the
   proposed-record digest, and require that no more than two minutes elapse
   before the first writer begins.
7. Immediately before the request, directly GET Release `379982100` and its
   complete paginated assets, require exact equality, and atomically persist its
   `intent-persisted` journal state.
8. Delete Release `379982100`; record `confirmed-204` or honest ambiguous
   outcome, then run bounded read-only convergence.
9. Require direct GET of `379982100` to return 404 and a complete paginated
   Release enumeration to exclude it, while the survivor and Release
   `379986168` remain byte-for-byte/projection-identical to the proposal.
10. Repeat main/workflow/run/tag checks, require a fresh complete npm E404
    inventory, directly GET Release `379986168` and all its assets, and persist
    its `intent-persisted` state.
11. Delete Release `379986168`, classify the response honestly, and require the
    same two-source bounded absence convergence while the survivor remains
    unchanged.
12. Re-read GitHub and npm. Require only survivor `379991871`, unchanged body
    and 45 downloaded assets, unchanged annotated tag, Release still disabled,
    no nonterminal run, and a final complete npm E404 inventory.
13. Atomically write the final canonical receipt and verify its envelope and
    current-state claims independently.

Convergence retries only reads: at most six complete direct-GET/list attempts
within 90 seconds, with bounded backoff no longer than 30 seconds. `403`, `429`,
`5xx`, timeouts, pagination failure,
or failure to converge blocks the next writer. GitHub does not provide this
design with an atomic multi-Release transaction or a documented conditional
delete. Single-operator exclusivity and disabled Release automation minimize
the GET-to-DELETE race but do not eliminate it; the receipt records the last
observation, not a server-side compare-and-swap. Exact-ID writers, immediate
full re-reads, deterministic order, the write-ahead journal, and postconditions
make uncertainty visible rather than guessed away.

## Interruption and Recovery

The operation is resumable only through the same CLI and journal. Resume first
validates the proposed envelope, confirmation digest, repository/controller
identity, and complete journal transition history; it never infers permission
to delete from current absence alone.

- Before any deletion: rerun from inspection.
- At `intent-persisted` after a restart, no response was durably recorded, so
  classify the result as ambiguous. At `outcome-recorded`, preserve the durable
  `confirmed-204` or ambiguous classification. In either case reconcile only
  when direct GET returns 404 and complete paginated enumeration excludes the
  ID.
- After resolving `379982100`: require Release `379986168` and the survivor still
  exactly match the proposal, repeat all authority checks including fresh npm
  absence, then continue with the second deletion.
- After both deletions but before receipt write: require the exact final state and
  materialize the same final receipt.
- If the survivor is missing or changed, a deleted duplicate reappears, an
  unexpected draft appears, publication begins, or evidence differs: stop. Do
  not recreate, edit, or delete anything else automatically.

The survivor's verified payload bytes are the recovery source for the removed
duplicate payloads. Deleted Release/asset identities and service history are
not recoverable; the receipt preserves only their last observed values and byte
digests. No automatic duplicate recreation is part of this recovery.

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
- deletion response ambiguity that cannot be reconciled by both bounded absence
  readers, or any ambiguous result followed by changed remaining objects;
- proposed/journal/receipt drift or noncanonical bytes.

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
- request timeout and process loss after server-side delete but before response
  or journal update, preserving the distinction between `confirmed-204` and
  reconciled ambiguity;
- direct-GET/list disagreement, delayed delete convergence, exhausted read-only
  retries, and every `403`/`429`/`5xx`/timeout stop path;
- idempotent resume from each legal journal state;
- rejection of every illegal partial state;
- proposed/journal/final exact schemas, hash projections, canonicalization,
  safe-file behavior, atomic transitions, tamper detection, and independent
  live verify without claiming historical-byte revalidation;
- a realistic three-draft fake with distinct Release and asset IDs but exact
  same-name bytes;
- proof that Release stays disabled and the survivor is never written.

The full release-controller suite, docs checks, repository Definition of Done,
and Docker-required validation run before any live consolidation. The dedicated
CLI and every workflow-reachable dependency remain content-pinned where the
release integrity policy requires it.

## Delivery and Live Sequence

The duplicate repair is a focused prerequisite, not a new operation bundled
into the larger single-owner abandonment branch. This explicitly supersedes the
old Task 13/14 ordering while the duplicate blocker exists.

1. Branch from current `main` and implement only the dedicated consolidation
   CLI, minimum shared production-parser exports, tests, and this design/plan.
2. Rehearse it locally and run the focused checks plus the repository Definition
   of Done, including `DAWN_REQUIRE_DOCKER=1 pnpm ci:validate`.
3. Review and merge that focused prerequisite while Release remains disabled.
4. From a clean checkout of the exact merged `main`, run `inspect`; review and
   retain its proposed envelope; then run `perform` with its digest and the
   exact confirmation.
5. Run `verify` and independent read-only GitHub/npm checks against the
   one-survivor state.
6. Commit the final receipt in a focused follow-up change and rerun the relevant
   release-integrity verification. This commit makes the embedded pre-delete
   evidence public; it does not make deleted GitHub service identities
   recreatable.
7. Rebase the larger single-owner abandonment work on that main, rerun its
   integration gate, then resume its trust cutover and abandonment tasks.
8. Only after those gates abandon v0.8.22, cut v0.8.23 with provenance, run the
   complete smoke tests, and verify production.

No step in this design removes the Vercel CLI, the real `vercel-native` lane, or
the later independent production deployment verification.
