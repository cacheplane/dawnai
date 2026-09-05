# Recovery legacy-fence adapter contract

This implements the missing Task 10 production read boundary. It grants no
admission on its own: policy remains `DORMANT`, approved contract digests remain
empty, and both contract/evidence directories contain only `.gitkeep`.
The existing prepared service probe is not sufficient for this contract.

## Trust and scope

The supported mechanism is `github-workflow-disable-v1`, using GitHub REST
`2026-03-10`. A reviewed digest admits recorded service observations; the record
is not a cryptographic certificate of GitHub responses. A disabled status alone
is insufficient. Runtime combines the reviewed mechanism with fresh repository,
workflow, and complete all-SHA run observations.

Contract files use the exact locator
`scripts/release/recovery-fence-contracts/<sha256>.json`. Evidence uses
`scripts/release/recovery-fence-evidence/<sha256>.json`. Both are bounded canonical
JSON, read from the expected controller commit. The filename commits to the
exact bytes; the contract digest must occur in policy's approved list. No
arbitrary paths, callback conditions, or runtime mutation belong in this adapter.

A contract has exactly these fields:

```text
schemaVersion: 1
kind: recovery-legacy-fence-contract
repository, repositoryId, candidateSourceSha
mechanism: github-workflow-disable-v1
apiVersion: 2026-03-10
evidenceSha256
probeClosure: [{path, sha256}]
fixtures: [{revision: historical|current, path, sha256}]
topology: [{workflowId, workflow, disposition, sources}]
sources: [{source, workflowSha256, executionInputs: [{path, sha256}]}]
source: {kind: current-default} | {kind: commit, sha}
disposition: fenced-legacy|recovery-owner|recovery-audit|nonwriter
```

IDs are canonical positive decimal strings; digests and SHAs are lowercase.
Collections have unique, deterministic ordering and fixed bounds (at most 64
workflows). Sources are nested under topology entries. `current-default` resolves
to the fresh bracketed default-branch SHA; historical source selectors name
independently existing commits. Never embed the contract-owning commit SHA in
its own contract. Recovery owner/audit entries require empty source arrays because
their authority is checked separately against expected SHA and admitted policy.

For every manifest, hash exact raw file bytes. Its digest is the SHA-256 of
`canonicalPolicyBytes(sorted [{path, sha256}])`, matching `hashVerifierClosure`.
`probeClosureSha256` derives from `contract.probeClosure`; any execution-closure
digest derives from `executionInputs` and need not be stored redundantly.
Explicitly exclude policy, contract, evidence, adoption and pin-ledger files from
these manifests to avoid cycles. A source whose authority depends on excluded
data needs separate reviewed treatment or fencing; omission cannot silently
establish safety. Probe closure and fixture paths have fixed supported roots and
must match reviewed bytes. The verifier must reject unsupported schemas and oversized
or partial inventories, not truncate them.

## Required service evidence

An extended evidence record has exactly these fields:

```text
schemaVersion: 1
kind: recovery-workflow-disable-evidence
apiVersion, startedAt, finishedAt
repository, repositoryId, workflowId, workflow, defaultBranch
historicalSha, currentSha, currentTag, historicalTag
probeClosureSha256
fixtureDigests: {historical, current}
calls: [{id, startedAt, finishedAt, method, path, body, status, response}]
setup: {repositoryCall, historicalFixtureCall, currentFixtureCall,
        initialBranchCall, advancedBranchCall, currentTagCall, historicalTagCall,
        historicalSeedDispatchCall, historicalSeedRunCall, historicalSeedJobsCall}
transitions: {disableCall, enableCall}
cases: [{context, stage, method, requestId,
        stateBeforeCall, branchBeforeCall, beforeInventoryCalls, requestCall,
        targetRunCall, targetJobsCall, runAfterCall, jobsAfterCall, afterInventoryCalls,
        stateAfterCall, branchAfterCall}]
restoration: {workflowCall, finalInventoryCalls}
```

References point to unique recorded calls. Use explicit nulls for inapplicable
run/job references; store no authentication headers. The parser recognizes a
finite set of repository, content, ref, workflow, run/attempt/job, inventory,
dispatch/rerun and enable/disable endpoint shapes. Retained response fields must
be sufficient to derive conclusions; supplied outcome booleans are not proof.

Require exactly 36 cases: contexts `current-default`, `current-tag`, `historical`;
stages `active-before`, `disabled`, `active-after`; methods `dispatch`, `all`,
`failed`, `job`. Current-default uses the advanced default branch. Current-tag
uses a tag at that current SHA. Historical dispatch uses a tag at the old SHA;
historical reruns use a default-branch run created before the branch advanced.
The two fixtures differ, including their intentionally failing writer step.

Validate actual fixture bytes, repository/workflow identity, both tag targets,
the distinct branch revisions, and every correlation. The default branch must
remain at the current SHA throughout the historical cases. Positive controls
must reach the intended writer step: runner startup failure does not count.
Returned dispatch run IDs must be direct responses; run IDs, attempts, workflow
IDs, source SHAs and numeric job IDs must match the requested operations. Rerun targets reference completed pre-request run and
job observations; dispatch targets are null. Accepted reruns advance exactly one
attempt, and historical reruns preserve the pre-advance default-branch seed
lineage independently of historical tag dispatches.

Require finite chronology: historical seed dispatch/execution; advanced branch
and both lightweight tags; twelve positive-before cases; disable/readback;
twelve denied cases; enable/readback; twelve positive-after cases; final drainage.

For disabled cases, accepted requests invalidate the mechanism. A supported
HTTP denial is insufficient without a settled, unchanged complete run/attempt
inventory after at least five seconds of settlement, proved by call timestamps.
Inventory identity includes run ID, attempt, status and conclusion. Pagination must be contiguous, complete, unfiltered by SHA, stable
in total and without duplicate IDs. State observations bracket every request.
Final enable/readback and fully drained inventory are mandatory. Bound bytes,
record counts and elapsed time; an exceeded bound produces inconclusive proof.

Task 12 extends the prepared probe to emit this format and tests its validator
against damaged correlations, missing pages and negative controls. An old
12-summary ledger cannot be converted to successful extended evidence by adding
assertions. Real service evidence remains unrun until the user supplies an
explicit disposable repository.

## Exhaustive production topology

Map every API-discovered workflow ID/path to a reviewed topology entry, including
inactive identities retained by GitHub. Unknown or renamed workflows block.
The known legacy release subsystem includes `release.yml` and
`published-artifact-verify.yml`; both require fencing. A workflow name or a
current read-only permission declaration cannot alone prove a historical writer
harmless. In particular, source-write workflows carrying a release credential
need explicit review of their reachable authority.

Each source binding enumerates workflow bytes and reviewed execution inputs.
The existing workflow-entrypoint/executable inventory helpers can assist record
preparation and review; they are test-local code, not a production historical
verification API. Do not build a second shell interpreter. Fenced workflow
sources include the candidate-executed SHA. They are never filters for drainage:
the reviewed mechanism revokes the workflow ID across historical revisions.

A `nonwriter` entry is a git-reviewed workflow-ID-wide exclusion. This is an
explicit trust-root decision, not an inference from current permissions, a
retained-run-head list, or the old inventory's `safe` classification. Its review
must cover historical dispatchable refs, reruns, reusable workflows and dynamic
checkout sources that could hold release authority. A run's head SHA alone does
not determine all executed sources. Unsupported or incompletely understood
source resolution requires fencing the ID; it cannot receive an exclusion.
Each nonwriter entry requires a `current-default` source binding.
Runtime verifies the exact declared current and historical input manifests and
the complete workflow-ID mapping. It does not claim to automate the semantic
review or rescan every branch and tag before every metadata write. Changed
current source bytes or unknown workflow IDs invalidate the contract.
Recovery owner/audit identities match separately pinned v2 workflow contracts.

## Fresh adapter output

Add narrowly scoped GitHub methods using API `2026-03-10`: `getRepository()`,
`listRepositoryWorkflowsComplete()`, `getWorkflowById({workflowId})`, and
`listWorkflowRunsAllShasComplete({workflowId})`. Keep existing filtered callers
and their API behavior unchanged. Complete methods validate consecutive pages,
stable `total_count`, unique IDs, total equality and configured bounds; no filters
other than pagination. Add the repository immutability GET on a separately
credentialed read-only adapter, never exposing its credential to other requests.

The adapter implements `observeLegacyFence` with GET-only dependencies. Read
repository identity, exhaustive workflow inventory, exact workflow identity and
all-SHA run inventories. For each fenced workflow, observe `disabled_manually`,
then fully drained runs, then re-observe state and inventory. Recognized terminal
conclusions only; unknown status, changed inventory, missing/truncated pages or
unavailable proof block. Bracket the whole observation with complete workflow
topology and default-branch identity; changes block. Verify nonwriter source
manifests as the reviewed exclusion's content bindings, not as an automated proof
that all historical sources are harmless.

Return the existing authority contract only after all checks pass:
`contractSha256`, exact candidate/executor, observed/expiry times within the
30-second freshness window, `dawn-release-controller`, cancellation false,
complete inventory, and sorted writer entries with revocation proof digests and
empty active-run lists. The observation begins before the first read; long reads
cannot obtain a fresh timestamp merely by stamping their completion time.

No Task 10 code disables workflows or manufactures service evidence. The Task 12
probe owns only its explicitly authorized fixture resources and restoration.
Production fencing remains a separately reviewed activation operation.

## Design review

Independent review on 2026-09-05 identified and corrected undefined closure
computation, commit/policy digest cycles, incomplete pagination, and missing
rerun target/lifecycle references. The explicit nonwriter trust root above keeps
review responsibility separate from the runtime's finite byte/identity checks.
Actual rehearsal evidence remains absent; no contract is admitted by this design.
