# Release recovery: service results and admission sequence

Date: 2026-09-05. Implementation baseline: `12e69d67eee6c08fdb9476a9e231cbd3c716527c`.
Production recovery remains dormant. This report supersedes earlier runbook
statements that the disposable experiments were unrun. It records completed
observations and the work needed to admit a production controller.

## Verified service results

The authorized lab was `blove/dawn-release-recovery-test-20260905-baf081db`,
repository ID `1358322370`. Only fixture workflows and owned test resources were
installed. After evidence retention the repository was archived. The user owns
manual deletion; no further operation against that repository is pending.

| Experiment | Verified result | Limit |
| --- | --- | --- |
| YAML workflow fence | All 36 current-default/current-tag/historical cases passed; three disabled dispatches returned 422 and nine disabled reruns returned 403; positive controls executed the intended writer before and after; all runs drained | Does not establish production platform-workflow authority or admission |
| Operator publication | Normal, discarded-upload-response and discarded-publication-response cases passed; four owned releases, including the initial visibility experiment, read back immutable with one exact asset each | Local operator credential, not actual workflow-token authority |
| Production job topology fixture | Full, published-noop and publish-only phases passed; injected smoke failure skipped dependents and failed-job rerun completed | Harmless command substitutions, not five real smoke lanes |
| Pagination and retention | Ten pages of two runs; 20 completed runs, 58 attempts and 178 retained API/log files | Recorded observation, not current production drainage |

Final fence run IDs: `33976563861`, `33976583663`, `33976647983`,
`33976708615`, `33976880170`, `33976944374`, `33977016108`.
Operator release IDs: `383288739`, `383288828`, `383288918`; initial visibility
experiment: `383288136`.
Topology run IDs: full `33975826834`, no-op `33975868760`, publish-only
`33975888431`, failed smoke and rerun `33975913311` attempts 1 and 2.

Six successful topology jobs were carried forward on the failed-job rerun with
new job IDs and attempt fields but unchanged earlier steps and timestamps.
Seven jobs executed fresh commands. Fresh IDs alone therefore cannot establish
fresh execution. The initial operator assertion expecting stable carried-forward
IDs failed; both that failure and the later timestamp-based verification remain
retained. The source controller's authority checks must continue to correlate
actual execution and independently observed facts.

The publication experiment also observed a successful immutable publication
before an anonymous GET stopped returning 404. The test driver now settles
public visibility with bounded reads only. Unknown write responses are resolved
against the same owned identity; publication is never repeated merely because a
public read lags.

## Evidence and code review

Local evidence root: `artifacts/release-recovery/service-20260905/`.
The portable archive is
`artifacts/release-recovery/service-20260905-evidence.tar.gz` (1,024,574 bytes),
SHA256 `bf3052af87c794652c6d229af7f022b8392a3f7b138c89add1df14c8d31d38d7`.
Its manifest verifies 237 payload files. It contains service observations and
executed source, not the later CI logs or subsequent documentation edits.

The final raw ledger is 20,414,439 bytes, SHA256
`b5d730e640241aa359058149105e9980eeef93e44f7278702b5d6ff90eaf4bd6`.
The canonical witness is 655,800 bytes, SHA256
`d23aed6e3c9af04489314cb9c03ded501e291bb9d4f23870d5091191996f3aa8`.
Exact executed probe source is retained separately; subsequent comments and
validation hardening are not represented as having run in the service experiment.

Independent review of `09186ae7..12e69d67` reprojected all 438 raw calls into
368 witness calls and reproduced the canonical bytes and both digests. It found
a Proxy rejection regression at the raw-ledger boundary. A new test reproduced
acceptance of the proxied ledger, then passed after restoring `types.isProxy`
rejection before introspection, with zero Proxy traps executed. Independent
re-review confirmed the fix. This bounded review does not substitute for the
PR's external review check or a complete production admission review.

[CI 33976684839](https://github.com/cacheplane/dawnai/actions/runs/33976684839)
passed all 20 jobs at baseline `12e69d67`, including 3,224 controller tests.
Full local validation passed during that development interval; it is not a
frozen baseline run. The separately pinned fault harness passed 116 tests,
including interruptions before and after all 32 writes. The subsequent Proxy
fix at `baf50196` passed all 20 jobs in
[CI 33979456327](https://github.com/cacheplane/dawnai/actions/runs/33979456327),
including 3,225 controller tests. Its local full source-test run had four timing
failures; all four passed in an isolated serial rerun, and all remaining local
gates passed separately. The failed full run remains recorded as failed.
These results do not cover the subsequent pagination change.

## Admission sequence

1. **Finish review and final-code validation.** Preserve the new regression,
   refresh closure and script pins, and validate the resulting revision. The
   external reviewer currently fails before code review because its account
   lacks credit. That is neither a code finding nor an approval.
2. **Prove actual workflow publication credentials.** A future authorized lab
   must run the topology fixture's optional publication step using its actual
   `github.token`, an existing non-default source commit, a probe-created
   annotated tag, and separately scoped policy-read authority. Exercise normal and both response-loss cases. Retain
   run/attempt/step identity, exact checked-out controller SHA, policy read,
   immutable final state and exact asset download. Never relabel the local
   operator run as workflow-token evidence.
3. **Resolve the complete production workflow topology.** The inventory
   includes Copilot and Dependabot platform workflows. The current Git-YAML
   contract cannot represent them. Complete the
   [platform assessment](../specs/2026-09-05-platform-workflow-fence-assessment.md)
   with a reviewed exact-identity representation and authority or revocation
   evidence. Filtering the two entries or treating unknown services as harmless
   would invalidate the fence. The YAML matrix does not satisfy this step.
4. **Measure the complete workflow budget.** The earlier fixture recorded 866
   non-304 responses and 2,193 authenticated 304 responses while omitting fence
   calls. An extended model executes the real fence with 514 legacy release
   runs and 16 audit runs, including both complete passes on every observation.
   Its initial compact-record comparison retained all 7,947 HTTP requests and
   60 fence observations while reducing primary-consuming GitHub responses
   from 4,499 to 932 (3,567 fresh 304 responses). This leaves only 68 requests
   against a 1,000-request allowance, and excludes bootstrap, actual lane
   traffic and competing jobs. Larger-metadata fixture validation and actual
   workflow-token measurements remain separate evidence. Never infer shared
   production headroom from the model alone.
5. **Prepare exact production admission.** At the reviewed controller revision,
   re-inspect candidate, tag, manifest, all 45 assets and all 21 packages. Prepare
   a diagnostic proposal outside the active admission path. Bind the complete
   reviewed fence contract, disable and drain the identified legacy writers as
   the reviewed activation operation requires, then observe fresh authority.
6. **Execute and verify the full recovery arc.** Adoption, five real lanes,
   independent audit, finalization and immutable publication must finish. Then
   verify zero-write replay and next-version arbitration. A successful dispatch,
   implementation CI or disposable run alone does not complete this step.

The current repository secret-name inventory contains `RELEASE_GITHUB_TOKEN`
and `ANTHROPIC_API_KEY`; it does not establish a usable separate policy-read
credential. No credential value was inspected or uploaded in this continuation.
The missing credential must be provisioned through the account's normal secret
management flow, not pasted into a conversation or put in a dispatch input.

For a future lab, `RECOVERY_POLICY_READ_TOKEN` is the fixture secret and
`RECOVERY_AUTHORIZED_REPOSITORY` is the repository variable. Production uses
`RELEASE_POLICY_READ_TOKEN`, exposed only to the designated metadata steps as
`DAWN_RECOVERY_POLICY_TOKEN`. Use a repository-scoped fine-grained token or App
credential with Administration(read); the immutability GET requires that
permission. The publisher's write credential remains separate. A new lab and
production need their own deliberate repository grants.
[GitHub permission requirement](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10#check-if-immutable-releases-are-enabled-for-a-repository)

## Architecture recommendation

Continue the existing decision to separate immutable candidate payloads from a
versioned, reviewed controller. The real experiments support a resumable observer,
planner and narrowly scoped writer, durable phase receipts, and independent audit.
They also show why observing a flag or receiving an HTTP acknowledgement cannot
replace checking the resulting state. See the
[architecture and rollout](../specs/2026-09-04-release-reliability-architecture.md).

For the longer-term authority boundary, compare these options explicitly:

| Option | Benefit | Obligation |
| --- | --- | --- |
| Controller in source repository | Smallest migration; existing candidate and workflow identity contracts remain useful | Complete reviewed authority mapping for source and platform workflows |
| Dedicated release-control repository | Separates controller updates and publication credentials from source automation | New cross-repository identity, admission, provenance and audit contracts; legacy source writers still need revocation/drainage |
| External release service | Can centralize scheduling and credentials | Adds service operations, authentication, state storage and availability; current evidence does not justify that cost |

Prefer the existing in-repository controller for the first recovery only if its
complete authority contract can be demonstrated. For normal future releases,
evaluate a dedicated control repository if platform configuration makes that
contract difficult to maintain. Moving execution alone does not revoke the old
source repository's authority and cannot unblock 0.8.24 by itself. Do not turn
the personal disposable lab into a production controller.

Keep build/provenance and registry publication boundaries intact during recovery.
After recovery, prioritize compatible per-lane receipt reuse and measured test
partitioning in separate changes. Maintain unattended normal releases under
reviewed policy; do not add a routine human approval to every release as a side
effect of this exceptional recovery.

Latest read-only production metadata still reports release `382873833` as
`draft=true`, `immutable=false`, 45 assets, opaque tag
`untagged-a4a022eb7414255884bc`, last update `2026-09-04T17:33:11Z`.
Policy is `DORMANT`; no contract or adoption was admitted. These are observations,
not fresh authority for a later write.


## Paginated read verification

A read-only run of the production adapter on 2026-09-05 followed GitHub's
numeric repository Link URLs, validating and canonicalizing each request path.
It read all 514 runs across six pages, then received six authenticated 304s with
empty bodies and absent Link headers. Revalidated navigation metadata remains
separate from actual response headers. Evidence is retained under
`production-pagination-adapter-30s/` in the local evidence root. The first run
hit the reader's default 10-second deadline after five pages and failed closed;
it remains under `production-pagination-adapter/`. The successful run used the
existing 30-second fence limit, without changing production deadlines.

Independent review reproduced an additional structural failure using those
real responses: full run metadata exceeded the fence snapshot's 100,000-node
bound. The reviewed adapter projection preserves every authority field after
full raw validation. Replaying all 12 recorded responses produced identical
fence run identities, shrinking the compact inventory from 7,005,673 to 133,175
bytes without raising global limits. Raw cache bodies and byte accounting stay
unchanged. This is a local replay of real service bytes, not a live production
fence or admission result.
