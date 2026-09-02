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
- Make interruption after the first deletion safely resumable while the
  required main-change freeze remains intact.
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

Release, asset, and workflow-run enumeration uses `per_page=100`, follows only
validated GitHub Link relations, accepts at most 100 pages and 10,000 raw
records, rejects duplicate IDs across pages, and requires stable reported totals
where the endpoint supplies them.

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
the maximum serialized sizes are 4 MiB for proposed, 72 MiB for journal, and 96
MiB for final receipt. Unknown/missing fields, noncanonical bytes, invalid
UTF-8, duplicate keys, digest mismatch, or excessive size are rejected.

The limit module also defines 8 MiB for one authority stage, 2 MiB for one
survivor evidence record, 8 MiB journal-event reserve, and 1 MiB
canonical-envelope reserve. Initialization and tests require:

```text
journalBytes >= ((targets * maximumAttempts) + finalStages +
                 maximumOrphanAuthorityRecoveries) *
                authorityStageBytes + journalEventReserveBytes

finalReceiptBytes >= proposedBytes + journalBytes +
                     authorityStageBytes + survivorEvidenceBytes +
                     envelopeReserveBytes
```

With two targets, three attempts each, one final stage, and exactly one orphan
authority recovery for the whole operation, the journal minimum is 72 MiB. A
second orphan-authority recovery stops without appending. The chosen 96 MiB
final cap preserves 9 MiB of additional headroom over its 87 MiB minimum. Tests
exercise the maximum eight-authority-stage history and both relationships.

### Exact shared records

These field lists are normative, including field order. Every object is exact;
nullable values remain present as `null`.

```text
repository: {name, id, defaultBranch, actor}
actor: {login, id}
controller: {headSha, originMainSha, githubMainSha}
candidate: {version, commitSha, tag}
roles: {survivor, duplicates}
confirmation: {version, commitSha, survivor, duplicates, template}
annotatedTag: {name, objectSha, targetSha, objectType, observedAt}

workflowAuthority:
  {workflowId, path, state, query, nonterminalRuns, observedAt}
workflow query: {statuses, perPage, maximumPages}
workflow run:
  {id, runAttempt, status, event, headSha, headBranch}

npmInventory: {stage, startedAt, completedAt, packages}
npm package observation:
  {name, version, status, httpStatus, code, observedAt}

releaseEvidence:
  {role, id, nodeId, tagName, createdAt, updatedAt, semantic, assets}
release semantic:
  {name, targetCommitish, draft, immutable, prerelease, publishedAt,
   body, bodySha256, author}
release author / asset uploader: {login, id, nodeId}
assetEvidence:
  {id, nodeId, name, label, state, contentType, size, digest, uploader,
   createdAt, updatedAt, downloadCount, downloadSha256}

payloadProof:
  {baseAssetSet, baseAssetSetSha256, consolidationPayloadSha256,
   attestationVerification}
baseAssetSet entry: {name, sha256}
attestationVerification: {status, subjects}
verified subject: {name, sha256}

authorityStage:
  {stage, controller, annotatedTag, workflowAuthority, npmInventory,
   releases, payloadProof, targetRead, observedAt}
targetRead:
  {releaseGetStartedAt, releaseGetCompletedAt, assetsListStartedAt,
   assetsListCompletedAt, evidence, evidenceSha256}
```

IDs use canonical positive decimal strings; SHAs and digests use canonical
lowercase hexadecimal. `controller` requires all three SHAs to match.
`roles.survivor` and `roles.duplicates` are the fixed Release IDs in approved
order. `workflowAuthority.state` must be `disabled_manually`, `path` must be
`.github/workflows/release.yml`, and `nonterminalRuns` must be empty after the
bounded query. The query is exactly statuses `["in_progress","pending",
"queued","requested","waiting"]`, `perPage: 100`, and `maximumPages: 100`.
Every npm package observation must be exact `ABSENT`, HTTP 404, code `E404`,
in canonical fixed-group order.

Release/asset evidence includes service identity and volatile fields for honest
recording, while only the semantic projections in Equality Contract are used
for parity. `baseAssetSet` is the exact 45-entry ordered `{name, sha256}` array
from `canonicalBaseAssetSet`; `attestationVerification` is exactly `VERIFIED`
plus the ordered 22-subject `{name, sha256}` result from the production
verifier. Proposed npm stages are exactly `inspect-initial` and
`inspect-ready`. Perform stages are exactly `perform-initial`,
`pre-delete-1`, `pre-delete-2`, and `final`; the final receipt retains all six
stage-labeled inventories at minimum. A resumed attempt may append another
`perform-initial` plus the target's `pre-delete-1` or `pre-delete-2` inventory,
distinguished by event sequence and attempt number.

`targetRead` is `null` only for the `final` authority stage. For every
pre-delete stage it embeds the complete direct-ID Release and paginated asset
evidence plus the digest of those canonical evidence bytes. Its timestamps must
be monotone, its evidence must equal the target entry semantically, and its
asset identities and metadata must be the latest accepted target view.

### Proposed envelope

The proposed `record` fields are exactly:

```text
schemaVersion, repository, controller, candidate, roles, confirmation,
annotatedTag, workflowAuthority, npmInventories, releases, payloadProof,
inspectedAt
```

`confirmation.template` retains the literal `<64-lowercase-hex-digest>`
placeholder, avoiding self-reference to the proposed digest. `npmInventories`
contains the two inspect stages. `releases` contains survivor then duplicates.
The proposed record contains no credentials or full asset payloads.

### Hash-chained journal envelope

The journal `record` fields are exactly:

```text
schemaVersion, repository, candidate, proposedRecordSha256,
confirmationSha256, deletionOrder, events, updatedAt
```

`events` is an append-only array of envelopes
`{ "event": <event>, "eventSha256": <hex> }`. The event digest is over canonical
event bytes plus one newline. Every event is exactly
`{schemaVersion, sequence, previousEventSha256, type, recordedAt, payload}`;
sequence starts at one and the first previous digest is `null`. Later events
must bind the immediately preceding event digest. Event types and exact payloads
are:

```text
operation-started:
  {proposedRecordSha256, confirmationSha256, controllerSha, deletionOrder}
npm-observed:
  {targetReleaseId, attemptNumber, inventory}
delete-authority-observed:
  {targetReleaseId, attemptNumber, authority}
delete-intent:
  {targetReleaseId, attemptNumber, authorityEventSha256}
delete-outcome:
  {targetReleaseId, attemptNumber, classification, httpStatus, observedAt}
resume-reconciliation:
  {targetReleaseId, attemptNumber, classification, releaseEvidence, observedAt}
absence-converged:
  {targetReleaseId, attemptNumber, basis, directGet404At, listAbsentAt,
   attempts, completedAt}
final-authority-observed:
  {authority}
```

Allowed `delete-outcome.classification` values are `confirmed-204`,
`transport-ambiguous`, and `response-404-ambiguous`; `httpStatus` is 204, null,
or 404 respectively. Allowed resume classifications are
`present-unchanged-retryable` and `absent-ambiguous`; `releaseEvidence` is the
current complete target evidence for the former and `null` for the latter.
Allowed convergence `basis` values are `confirmed-204` and `ambiguous`.
All proposed, journal, final, and journal-event `schemaVersion` fields are the
integer `1`, interpreted by their distinct strict parser contexts.
`attemptNumber` is a canonical integer from 1 through 3; no target may receive
more than three `delete-intent` events.

Every delete attempt embeds a complete immediately preceding
`authorityStage`—including fresh controller, workflow/run, tag, npm, remaining
Release/asset, and payload evidence—in `delete-authority-observed`. The intent
binds that event digest and is atomically durable before the request. A received
204 produces `confirmed-204`. Timeout, transport failure, or a received 404 is
ambiguous. If the process disappears before recording an outcome, resume reads
the target:

- present and semantically identical: append
	`present-unchanged-retryable` only after refreshing every authority source
	and fully hydrating the current 45-asset target evidence. Persist that actual
	fresh evidence in the reconciliation, append the same captured authority for
	the new attempt with no intervening network, persist a new intent, and only
	then retry DELETE. If the prior
  complete npm inventory is more than two minutes old, append a new
  `perform-initial` inventory, wait at least 60 seconds while repeating the
  heavy payload checks, then capture the target's new `pre-delete-1` or
  `pre-delete-2` inventory;
- absent: append `absent-ambiguous` and perform bounded absence convergence;
- changed, published, or malformed: stop without another write.

The same state decision applies after a durably recorded ambiguous outcome. If
the six-read/90-second window repeatedly observes the target present and
semantically unchanged, with complete enumeration still including it and every
other authority input unchanged, perform one full fresh authority capture,
append `present-unchanged-retryable` with that capture's actual current target
evidence, and bind the same capture to the fully fresh numbered attempt. If it
becomes absent, append
`absence-converged`. A changed target, reader disagreement/error, or a third
ambiguous attempt that remains present stops. A target present after a recorded
`confirmed-204` also stops; it is not eligible for retry.

Only `absence-converged` completes a target. The next target cannot receive an
authority or intent event until the preceding target has that terminal event.
The hash chain is the complete transition history verified on every resume.

### Final receipt envelope

The final `record` fields are exactly:

```text
schemaVersion, proposedEnvelope, journalEnvelope, finalAuthority,
finalSurvivor, completedAt
```

The embedded values are the complete canonical envelopes, not bare records or
summary hashes. `finalAuthority` is the exact `final` authority stage and
`finalSurvivor` is the same exact survivor `releaseEvidence` contained within
it. Canonical outcome is never renamed in the receipt: deletion certainty is
derived from the recorded outcome/resume classification plus the required
`absence-converged` event.

The `.dawn` proposed and journal files are opened no-follow, must be regular
files owned by the operator, use mode `0600`, and are replaced through a
same-directory temporary file + fsync + atomic rename + parent-directory fsync.
Creation refuses an existing symlink or unsafe path. The tracked receipt uses a
separate source-file rule: no-follow regular file, expected owner, nonexecutable,
and no group/other write bits; ordinary Git mode `0644` is accepted.

`verify` proves envelope/hash-chain integrity, current survivor equality,
deleted-ID absence, and current authority postconditions. It cannot
independently re-download deleted historical bytes; those are supported by the
embedded pre-delete observations and the survivor's still-live identical
payload. The first public durable copy is the focused receipt follow-up commit.

## Mutation Flow

1. Begin the operational main-change freeze: the sole owner makes no merge or
   direct push to `main` until the final receipt is durable. Re-read
   local/remote/main SHA identity and require a clean merged checkout.
2. Validate the reviewed proposed envelope and exact confirmation. Append
   `operation-started` to a new journal.
3. Require Release `disabled_manually`, zero nonterminal Release runs, and the
   exact three-ID managed set. Capture and append the complete
   `perform-initial` npm E404 inventory bound to target `379982100`, attempt 1.
4. During the at-least-60-second gap, download all 135 asset instances, apply
   production escrow/attestation verification, and prove the exact equality
   projections against the proposal.
5. Capture the `pre-delete-1` complete npm E404 inventory and all other fresh
   authority. After every other network read, directly GET Release `379982100`
   by ID and completely enumerate its assets; record this terminal target read
   in `delete-authority-observed` and require it semantically equal to the
   proposal. Then perform only the local atomic journal write for
   `delete-intent` before issuing DELETE—no intervening network request—while
   the npm inventory is no more than two minutes old.
6. Delete Release `379982100`; append the exact outcome or reconcile an
   interrupted intent. Run bounded read-only convergence; append
   `absence-converged` if absent, or use the bounded new-attempt path if an
   ambiguous outcome remains present and unchanged.
7. Require direct GET of `379982100` to return 404 and a complete paginated
   Release enumeration to exclude it, while the survivor and Release
   `379986168` remain projection/payload-identical to the proposal.
8. Capture complete `pre-delete-2` controller/workflow/run/tag/npm and remaining
   Release/asset evidence. End the authority stage with direct GET of Release
   `379986168` plus its complete asset enumeration. Append the resulting
   `delete-authority-observed`, then perform only the local atomic intent write
   before DELETE. Any intervening network request invalidates the authority
   stage and requires a fresh one.
9. Delete Release `379986168`, append or reconcile the exact outcome, and
   require the same two-source bounded absence convergence while the survivor
   remains unchanged.
10. Capture and append the complete `final` authority stage. Require only
    survivor `379991871`, unchanged body and 45 downloaded assets, unchanged
    annotated tag, Release still disabled, no nonterminal run, and a final
    complete npm E404 inventory.
11. Atomically write the final canonical receipt, independently verify its
    envelopes/hash chain/current-state claims, then end the main-change freeze.

Convergence retries only reads: at most six complete direct-GET/list attempts
within 90 seconds, with bounded backoff no longer than 30 seconds. `403`, `429`,
`5xx`, timeouts, pagination failure,
or changed/discordant evidence blocks the next writer. An exact unchanged target
after an ambiguous outcome may retry only under the three-attempt protocol
above; exhausting it blocks. GitHub does not provide this
design with an atomic multi-Release transaction or a documented conditional
delete. Single-operator exclusivity and disabled Release automation minimize
the GET-to-DELETE race but do not eliminate it; the receipt records the last
observation, not a server-side compare-and-swap. Exact-ID writers, immediate
full re-reads, deterministic order, the write-ahead journal, and postconditions
make uncertainty visible rather than guessed away.

The main-change freeze is a required operational precondition, not an API lock.
The command rechecks all three main SHAs before each DELETE and at finalization.
If `main` advances after the first deletion, the command stops and no longer
claims automatic resumability. The operator preserves the proposed/journal
files and requests a focused reviewed migration change. That change must name
the exact old and successor controller SHAs, parse and verify the old envelopes
and event chain without rewriting them, prove the successor preserves this
command's schemas and safety behavior, emit a migration event/receipt binding
both SHAs, and repeat the full fresh authority sequence before authorizing a
remaining delete. There is no unreviewed SHA override or automatic migration.

## Interruption and Recovery

While the main-change freeze remains intact, the operation is resumable only
through the exact same controller CLI and journal. Resume first validates the
proposed envelope, confirmation digest, repository/controller identity, and
complete hash-chained event history; it never infers permission to delete from
current absence alone. If the freeze was violated, only the reviewed migration
procedure above may restore authority.

- Before any intent: the journal may be discarded and `perform` rerun. The
  proposal is reference evidence rather than fresh mutation authority; all live
  parity and authority reads are repeated by `perform`, and any mismatch stops.
- After `delete-intent` with no later event, directly read the target. If it is
  present and semantically unchanged, append `present-unchanged-retryable`,
  refresh all authority, and create a new attempt. If absent, append
  `absent-ambiguous` and reconcile. Any other state stops.
- After an ambiguous `delete-outcome`, preserve its exact classification. If
  direct GET returns 404 and complete paginated enumeration excludes the ID,
  reconcile absence. If the bounded window instead proves the target remained
  present and exactly unchanged, append `present-unchanged-retryable` and use a
  fully fresh numbered attempt, subject to the three-attempt cap. Any other
  result stops. A `confirmed-204` target that is present stops.
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
- deletion response ambiguity that is neither reconciled absent nor proven
  present-and-unchanged within the bounded window, exhaustion of three attempts,
  or any ambiguous result followed by changed remaining objects;
- proposed/journal/receipt drift or noncanonical bytes.

There is no force mode, survivor override, ID auto-selection, delete-all option,
inline manual repair path, tag mutation, or best-effort continuation. The
reviewed successor-controller migration is a new focused recovery change, not a
runtime bypass.

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
- crash after intent while the target remains unchanged, safe fresh-authority
  retry as a new attempt, crash after server-side absence, and hash-chain
  tampering/reordering/truncation;
- main advance before either writer and after the first deletion, proving the
  current CLI stops and cannot accept an unreviewed successor SHA;
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
