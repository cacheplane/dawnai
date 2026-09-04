# Post-publication recovery with an independent controller

Date: 2026-09-04

Status: proposed implementation design, pending written-spec review.

Independent spec review: passed on 2026-09-04; user review remains pending.

Parent: [Release reliability architecture](./2026-09-04-release-reliability-architecture.md).

## Objective and bounded scope

Finish a candidate whose complete package inventory is already published with
matching source and tarball evidence, using a reviewed controller that can be
newer than the candidate. The first adoption target is 0.8.24, but version and
release identity belong in a reviewed adoption record, not executable constants.

This delivers post-publication verification, evidence reconciliation, independent
audit, GitHub Release publication, and truthful outcome reporting. It does not
publish npm packages, rebuild payloads, move tags, abandon partially published
candidates, implement smoke waivers, redesign CI, or change chart publication.
Its workflows receive no npm credential, OIDC issuance permission, or attestation
write permission. Existing artifact attestations remain the trust anchor.

## Invariants

1. The annotated candidate tag, source SHA, manifest, tarballs, and existing
   attestations retain their exact identity throughout recovery.
2. All expected package versions must be present and verified before adoption.
   Missing packages, mismatches, or ambiguous observations block recovery.
3. A newer verifier can produce evidence about older packages. It cannot
   fabricate candidate-origin workflow identity or convert failed lanes to passes.
4. Every phase has durable evidence and one selected metadata writer.
5. All five required lanes must genuinely pass under the new contract. Audit
   remains independent. The committed 0.8.24 adjudication is historical context,
   never authority to satisfy these gates.
6. A published immutable release cannot gain or replace evidence assets. Assemble
   and audit its complete evidence before publication. GitHub still permits
   title/body edits; controller policy forbids using them to redefine completion.

## Authority and invocation

Add a dedicated post-publication workflow on the protected default branch.
Inputs identify repository, version, candidate SHA, manifest digest, canonical
release ID, and expected controller SHA. Derive repository identity from GitHub;
cross-check any supplied value. Controller SHA is an equality assertion, not
permission to execute arbitrary caller-selected code.

The actual controller is the workflow invocation's immutable `github.sha`.
Every job checks out that SHA. Before any write, require that it is a reviewed
merged main commit with successful required CI, that workflow execution is from
the default-branch ref, and that its contract/import closure satisfies the
repository's reviewed policy. Require actual SHA to equal expected controller
SHA. A main-branch dispatch race fails before mutation; the operator or
coordinator captures the new reviewed revision and retries.

The first adoption is authorized by a merged git record containing the exact
candidate identity, canonical Release ID, manifest digest, expected legacy
marker/body digest, allowed starting phase, policy digest, and adoption intent.
It grants only the named post-publication operations. Absence, mismatch,
malformation, or an unknown schema is an explicit block. The record is bound to
the workflow's checkout, never loaded from a moving branch during execution.
An accepted migration references its record path, bytes digest, and actual
reviewed controller commit, avoiding a self-referential commit hash in the file.

Subsequent compatible controllers must have green main CI and the same accepted
policy digest, support the adopted evidence version, and record their own SHA.
Changing the policy or accepted verifier implementation requires a new reviewed
policy revision and new affected verification evidence. Admission is explicit,
not based only on a semver comparison or a caller's compatibility claim.

## Ownership cutover

Upgrade main's shared discovery/router before permitting adoption. An authorized
adoption intent reserves the exact candidate for the new recovery owner. Legacy
detect returns a non-continuing handoff outcome, never tag/publish work for that
candidate. This covers push, schedule, and manual entrypoints, including old tag
invocations that execute current main's observer. Unsupported readers block;
they do not reinterpret version 2 evidence as an unmanaged release.

Share `dawn-release-controller` concurrency with the existing release workflow,
with cancellation disabled. Verify that all reachable legacy writer workflows
participate; stop adoption if a candidate writer is outside that fence. Drain
already-running legacy jobs before the new workflow obtains ownership, and
re-observe candidate jobs and marker immediately before the migration. A
candidate reservation blocks later version publication until recovery completes.

Rerunning only failed legacy jobs may reuse old successful detection outputs.
Before adoption, prove against the exact frozen candidate code that every such
writer rejects a version 2 marker before its first upload or metadata mutation.
The main router alone is not this fence. If a reachable old writer cannot make
that guarantee, block adoption until its mutation authority is verifiably
revoked. Rehearsal includes failed-job-only reruns after ownership changes.

The adoption record must match only the intended candidate; it cannot reserve a
different version or route unrelated releases. Once the version 2 marker is
accepted, deleting the git intent cannot return the candidate to legacy writers.
Discovery recognizes the durable ownership marker and blocks if its policy is
missing. All later-version arbitration consumes the version 2 terminal result.

Cooperative workflow serialization plus pre/post-write checks is the supported
concurrency guarantee. The existing writer implements read-compare-PATCH-read,
not a server-side atomic compare-and-swap. Recovery requires no concurrent manual
Release edits. A detected external edit is a conflict; do not claim protection
against an administrator deliberately racing writes.

## Evidence version 2 and migration

Keep the original sealed manifest and release-record schemas unchanged. Introduce
an explicitly versioned post-publication marker and sidecar receipt set. Readers
dispatch by marker schema before validating phase-specific contents. Unknown
schemas or mixed interpretations fail closed. Published version 1 releases remain
readable through their existing parser; no historical bulk migration occurs.

The version 2 marker binds:

- candidate identity, canonical release ID, original manifest/release-record
  digests and exact base asset set;
- adoption receipt digest and legacy body archive identity;
- monotonically increasing revision, controller ownership, and evidence schema;
- policy digest, selected verification-set digest, selected audit receipt digest;
- current phase and the last independently proven transition.

Adoption archives the exact legacy body as a new deterministic, digest-qualified
asset. Its receipt binds the archive, original asset IDs/names/digests, npm
verification result, authorization record digest, and executor/run identity.
New assets use a disjoint `recovery-v2-` namespace. Same-name/equal-byte uploads
are resumable; same-name/different-byte content blocks. Upload receipts and
re-read their exact bytes before advancing the marker. Preserve all original
assets and any valid partial recovery receipts.

Archive names depend only on the archived bytes and candidate identity. Attempt
receipts use executor/run/attempt-qualified names, so a new attempt cannot
collide with a receipt whose provenance differs. The accepted adoption receipt
enumerates retained valid partial attempts and selects the original legacy
snapshot. Replaying the same attempt uses its existing canonical bytes instead
of regenerating timestamps. Test takeover by a newer compatible controller
before the first version 2 marker as well as after it.

The migration is one-way after the first version 2 marker. The audited final
asset inventory includes original and retained recovery evidence; stale,
unbound, or unexpected assets cannot be silently ignored. Adoption must tolerate
a valid subset of its own deterministic migration assets after interruption,
while still matching the original base inventory and body digest.

Version 2 evidence is canonical bounded JSON, parsed as raw bytes with exact
fields, duplicate/unknown-field rejection, validated digests and identifiers,
and the existing descriptor-safe snapshot discipline. Define schema limits
alongside schemas and test the maximum accepted/rejected shapes. Do not encode
today's package count as a general invariant; derive the exact set from the
verified manifest and release inventory.

## Transition contract

| From | Operation | Required proof before advancing | To |
| --- | --- | --- | --- |
| Legacy `NPM_COMPLETE` | Adopt candidate | Authorized legacy snapshot, complete matching registry evidence, archived body, unchanged base assets, exclusive ownership | `RECOVERY_ADOPTED` |
| `RECOVERY_ADOPTED` | Verify published artifacts | Exact complete five-lane receipt set with real passing outcomes and current accepted policy | `VERIFICATION_COMPLETE` |
| `VERIFICATION_COMPLETE` | Request independent audit | Correlated dispatch receipt persisted for the selected verification set | `AUDIT_PENDING` |
| `AUDIT_PENDING` | Reconcile independent audit | Successful compatible audit, bound to the frozen evidence selection | `AUDIT_VERIFIED` |
| `AUDIT_VERIFIED` | Finalize and publish GitHub Release | Finalization asset binds all durable evidence; fresh tag/registry/asset checks; immutable-release policy enabled | `PUBLICATION_READY` marker followed by publication |
| `PUBLICATION_READY` | Observe publication | Published immutable release, tag, finalization asset, and its exact evidence inventory; compare title/body with reconstruction | Derived `COMPLETE`, with separately reported display drift if present |

Limit the first implementation's adoption start phase to legacy `NPM_COMPLETE`.
Supporting another legacy phase requires its own tested admission rule; do not
implicitly treat all published candidates as equivalent.

Before writing `PUBLICATION_READY`, upload and re-read the single canonical
`recovery-v2-finalization.json` asset. It binds candidate, release ID, policy,
adoption, selected verification and audit receipts, and every other final asset
by identity and digest. It excludes itself from that inventory to avoid a
recursive hash. It contains the semantic fields needed to reconstruct the exact
canonical final title/body, including the marker revision. The renderer receives
the finalization bytes' digest as a separate input; the finalization file does
not embed a digest of a body that embeds its own digest.

This asset is the final evidence selection. Once it exists, retries validate and
reuse it, issue no additional evidence uploads, and finish publication after
fresh checks. A missing marker update is reconstructed from its verified bytes.
An invalid or newly ineligible final selection blocks; replacing it is outside
this first recovery contract and needs a reviewed forward-migration design.

`COMPLETE` is derived from the independently observed published state plus this
asset and reconstructed metadata. GitHub makes the asset and tag immutable,
not the title/body. Later title/body drift is reported as metadata drift without
discarding the historical completion proof or reopening npm publication. An
absent, invalid, or conflicting immutable finalization asset is an integrity
failure and blocks advancement. The controller does not automatically repair
postpublication display edits. See [GitHub's documented semantics](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

Published discovery uses the immutable candidate tag and canonical Release ID,
then the fixed finalization asset name. It does not depend on the editable title
or on finding a parseable marker in the body. A removed or corrupt body marker
is display drift when the immutable proof validates, never permission to hand
ownership back to a legacy writer.

If publication succeeds but its response is lost, a rerun derives the same
terminal state without another mutation. If readiness is durable but publication
did not occur, retry after fresh precondition checks. No postpublication body
write is necessary for completion; that is controller policy, not an API limit.

Failed verification stays at `RECOVERY_ADOPTED` with failure receipts. Failed
audit stays nonterminal with an immutable attempt receipt and a classified retry
or block. A repeated exact plan is a no-op only when its postcondition is proven.

## Verifier execution and receipts

Reuse the five existing obligations: `metadata`, `published-harness`,
`runtime-targets`, `scaffold`, and `storage`. Run current reviewed probe code
against exact npm versions or independently downloaded payloads as each check
requires, in clean temporary projects outside the checkout. Never substitute
workspace packages or rebuilt dist output. Preserve strict process containment
and cleanup verification.

Version 2 receipts distinguish the subject candidate SHA from the executor SHA.
They also bind lane/check identity, manifest, policy, environment/toolchain
profile, run/attempt/job identity, timestamps, actual check outcomes, and captured
dependency resolution evidence. A successful runner exit cannot override a
failed check or failed cleanup. A partial or missing receipt is not success.

For sub-project 1, select one complete five-lane set from one recovery run/attempt.
Retries rerun all five lanes; preserve older receipts for diagnosis. Cross-run
reuse is intentionally deferred. Export only the fields each subprocess API
accepts, with contract tests against the real strict runner.

Unprivileged smoke workers get read-only package access and verified artifact
inputs. A metadata writer escrows their results after correlating the actual
GitHub workflow, job, run, attempt, SHA, artifact ID, service digest, and exact
receipt bytes. Do not trust receipt-supplied provenance without these independent
API checks. Actions artifact expiry after escrow cannot erase accepted proof.
The escrowed provenance descriptor records the API-validated workflow path,
executor SHA, run/attempt/job identity and outcomes, Actions artifact ID and
service digest, raw receipt digest, and validation time. Later audit checks that
descriptor and the release-hosted receipt bytes under the accepted adoption
chain; expired Actions downloads are not required again. Missing or conflicting
provenance that was never successfully escrowed blocks acceptance.

## Independent audit and finalization

Add a dedicated independent post-publication audit workflow invoked at the
default branch with expected auditor SHA, candidate identity, release ID, policy
digest, and verification-set digest. Capture the expected SHA from the reviewed
controller revision for this attempt. Verify actual run SHA equals that value.
A dispatch race with advancing main causes an explicit failed attempt and
recapture under a compatible controller; no audit from an unexpected SHA is used.

The auditor runs in a fresh environment and re-downloads release-hosted evidence
and npm artifacts without using the recovery run's checkout, cache, or local
files. It verifies existing signatures, source claims, registry bytes, tag,
adoption chain, receipt provenance, exact lane coverage and outcomes, policy,
and complete asset inventory. It does not execute the candidate's frozen audit
code. It accepts only the explicit version 2 contract.

Use direct dispatch run identity, as the existing controller does. Persist a
dispatch intent before the API call. If dispatch acceptance is ambiguous and
its exact run identity cannot be recovered from an API receipt, record an
uncorrelated attempt and create a fresh uniquely identified request. The
uncorrelated run is read-only and can never satisfy a gate. A later correlated
attempt may succeed; do not guess by scanning recent runs.

The audit selection binds a frozen verification set and inventory revision.
Subsequent audit bookkeeping assets are permitted only in their declared attempt
namespace; one finalization asset is then allowed and must bind the exact audited
selection plus those receipts. All must be fully bound before publication. The auditor emits a result
artifact; the recovery writer validates and escrows it. The audit workflow never
waits for the release-controller concurrency group held by its caller.

GitHub's current draft visibility requires a token with contents-write scope.
Where that token is required for observation, describe the job accurately as
read-only in behavior, not in token authority. Restrict its API adapter to reads,
run only reviewed code, never expose the token to smoke subprocesses, and cover
this boundary in the real GitHub contract lane. Only the selected metadata
writer performs release mutations.

Publish only after the correlated audit passes and final fresh identity checks
pass. The finalizer compares the exact final asset inventory with the frozen
audited set plus its explicitly allowed audit receipts and finalization asset.
The existing writer's
version 1 marker assumptions must not be bypassed: introduce a separately
validated version 2 writer boundary sharing low-level transport where appropriate.

## Outcomes and retry policy

The workflow finalizer reports requested candidate, controller SHA, starting and
ending durable phases, completed mutations, receipt locations, and next action.
It runs after failed/skipped jobs when the platform can schedule it. Job output
presence or workflow success alone never implies release completion.

Transport timeout, throttling, transient service failure, and recognized registry
propagation lag get bounded backoff using Retry-After when available. Resume
after the workflow budget rather than exhausting a runner indefinitely. Identity
mismatch, invalid signatures, unsupported schema, deterministic probe failures,
or unexpected remote mutation block immediately. Retry limits and per-call/job
budgets belong to one tested policy module, not duplicated workflow literals.

Recovery is manually dispatched in this first delivery. A reserved candidate
with no active owner produces an explicit blocked/recovery-required status,
not a misleading successful no-op. Automatic resume scheduling is a later
change. Dispatch-only success remains a pending handoff, not release success.

## Rollout, rollback, and verification

1. Land dormant version 2 schemas/readers, the routing admission rule, recovery
   workflow, independent audit workflow, and narrowly scoped writer. Keep
   admission empty. Extend release-code closure pins and workflow policy
   fixtures together. New workflow files alone confer no adoption authority.
2. Rehearse locally with a legacy candidate and upgraded executor. Run real
   GitHub contract tests in explicitly disposable integration resources, using
   production adapters and the production job dependency topology. That
   environment is authorized separately from production recovery.
3. Prepare the exact 0.8.24 adoption record and fresh read-only preflight report.
   Review the record, evidence, controller revision, and proposed mutations.
   A merged record reserves the candidate; a separate explicit recovery dispatch
   begins execution. This design document does not perform either action.
4. Drain legacy writers, acquire the existing concurrency fence, recapture
   preconditions, and adopt. Run actual verification before allowing progress.
5. Independently audit, publish only on verified evidence, and re-observe
   terminal completion. Reconcile again and require a no-op with unchanged bytes.
6. Demonstrate that later-version arbitration can proceed after the durable
   terminal result. Do not infer this from the recovery workflow's green status.

Before adoption, removal of an unused reservation returns the unchanged legacy
candidate to its previous ownership. After adoption, disable writes if necessary
and forward-repair under a compatible controller. Do not revert the marker,
delete evidence, or restore legacy writer ownership. Never rewrite an immutable
published release. Failed checks leave the candidate incomplete and later
publication blocked; a waiver requires a separate design.

Required tests cover old candidate/new executor success; schema routing across
all readers; adoption after each partial upload; lost PATCH/publish responses;
unrelated/malformed adoption records; changed tag/manifest/registry bytes;
failed or missing lanes; executor-SHA mismatch; main advancing during dispatch;
audit failure and uncorrelated dispatch; Actions artifact expiry; external edits;
legacy jobs in flight and failed-job-only reruns; different concurrency groups;
skipped required jobs; finalization response loss; later title/body edits,
including removal or corruption of the whole marker; and
the final immutable publication/no-op/arbitration sequence.

Mutation checks must prove that dropping a lane, trusting a receipt's self-claimed
SHA, accepting unknown controller policy, ignoring a failed audit, or allowing a
legacy writer after adoption turns the relevant tests red. The GitHub contract
lane must exercise actual draft listing/token behavior and skipped dependency
semantics, including the failures documented in PRs #561, #557, and #569.

Run the repository's required implementation gates at the final implementation
head, plus targeted controller tests and disposable integration rehearsal. For
this documentation-only proposal, verification consists of document consistency,
reference checks, and independent spec review; it is not evidence of executable
recovery or a passing production pipeline.
