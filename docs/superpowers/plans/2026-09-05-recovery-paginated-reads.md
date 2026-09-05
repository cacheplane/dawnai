# Recovery paginated reads implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. Root owns source and tests; bounded independent review follows each completed change.

**Goal:** Reduce history-page transfer and primary consumption while keeping every fresh page read and complete fence observation.

**Architecture:** A strict page predicate validates total-bound pagination metadata. The conditional reader retains that metadata separately and exposes it with explicit revalidation provenance; raw headers remain unchanged. The real fence observer joins the HTTP rehearsal so its cost is measured.

**Tech stack:** Node ESM, existing bounded HTTP/GitHub adapters, node:test, gh CLI for read-only service verification.

## Task 1: Retain only validated total-count pages

Files: `scripts/release/adapters/conditional-json.mjs`,
`scripts/release/adapters/github.mjs`,
`scripts/release/test/recovery-conditional-reads.test.mjs`.

- [x] Write two-page tests with 100+1 records, fresh 200 then real-shaped 304 with no Link, four network calls, and numeric repository links. Run with `node --test --test-name-pattern='paginated' scripts/release/test/recovery-conditional-reads.test.mjs`; require the new expectations to fail on current code.
- [x] Add a trusted page-retention predicate distinct from ordinary object retention. Include mode in the cache key, retain bounded link metadata separately, revalidate the active predicate on 304, and count metadata toward capacity. Keep raw response headers and status unchanged.
- [x] Add total/page-size/relation eligibility in the GitHub adapter; only strict numeric pagination opts in. Derive navigation from explicit revalidated metadata on 304, never fill missing links on a changed 200. Preserve all downstream inventory checks.
- [x] Cover 0/1/100/101 boundaries, valid changed 200s, inconsistent totals, conflicting/unsafe links, duplicate IDs, missing validators, per-call limits, expired deadlines and cold/evicted readers. Preserve array/cursor/legacy behavior.
- [x] Run the complete conditional-reader, HTTP and GitHub-adapter suites. Independently review the changed production boundary and tests.

## Task 2: Include the actual fence in the full HTTP model

Files: `scripts/release/test/support/recovery-rehearsal.mjs`,
`recovery-observe-fixture.mjs`, `recovery-write-fixture.mjs`,
`recovery-evidence-fixture.mjs` in the same support directory;
new `scripts/release/test/support/recovery-rehearsal-fence.mjs`;
`scripts/release/test/recovery-rehearsal.test.mjs`.

- [x] Add an optional test-only fixture fence configuration before policy and receipt digests are generated. Bind a complete synthetic workflow topology, canonical contract, full service witness and exact source inputs through the existing fixture Git reader. No active policy, contract or evidence directory changes.
- [x] Serve complete 514-run legacy history and 16-run audit history through the owned HTTP server with real Link headers, ETags and 304 behavior. Keep explicit synthetic trust roots and canonical-host confinement.
- [x] Wire `createRecoveryFenceReader` to the same runtime GitHub reader and current job executor used by the recovery invocation. Bypass `evidenceRemote`'s legacy zero-argument/timestamp-rewriting wrapper in real-fence mode; forward request/options unchanged and share the authority clock. Rebind the observer when `resetReads` replaces the reader for a phase/resume, and preserve independent-audit reader separation. Return the actual proof to authority validation; do not add a benchmark beside a fabricated proof. Add a negative case where a malformed actual fence stops a write and assert fresh HTTP reads after reader reset.
- [x] Add a complete-arc regression that includes fence requests in the actual HTTP counters. Compare conditional and unconditional executions with identical inputs, and measure separately initialized phase readers. Preserve all 32 effects, 45 original assets, five lane obligations, independent audit, no-op and next-version assertions.
- [ ] Keep the full fault matrix and malformed-fence regressions. Record remaining quota limits honestly; passing a fixture cannot certify actual workflow headroom.

## Task 3: Service verification, pins and final review

- [x] Run the updated production Link-following adapter read-only against the current GitHub workflow history. Retain exact request URLs, statuses and safe pagination/validator headers. Prove complete count and identity, including numeric Link URLs. No service mutation or workflow-token claim.
- [x] Update conditional-read docs and runbook status. Refresh policy verifier closure, script-content pins and the workflow-contract fixture digest together.
- [ ] Run scoped lint, release inventory, docs and focused boundary tests. Then run full controller and fault suites and applicable CI gates for the final commit. Retain the earlier local source-test timing failures and distinguish independent reruns.
- [ ] Obtain independent review; fix material findings, commit and push the completed batch to the existing recovery PR. Policy remains DORMANT. Report platform authority, scoped policy credential, actual workflow-token publication, quota and external-review requirements that remain unresolved.


## Evidence-driven addition: bounded history projection

Review reproduced a pre-existing production failure using the retained six
GitHub pages: the adapter accepts all 514 records, but their irrelevant metadata
exceeds the fence snapshot's 100,000-node limit. The byte limit alone does not
prevent this. Keep both global limits unchanged.

After complete pagination and full raw record normalization, project the
all-SHA history result onto exactly the fields consumed by `fenceTerminalRuns`:
`id`, `run_attempt`, `workflow_id`, `path`, `repository.id`,
`repository.full_name`, `head_sha`, `status`, and `conclusion`. Preserve field
values and missing fields. Do not project before byte, unsafe-key, total,
duplicate, ID or completeness validation. No filtering of runs or authority
fields. Add generated wide-metadata red/green coverage and replay the retained
actual service pages through the adapter and unchanged fence snapshot/parser.
Review this addition before final pins and gates.


Pre-push verification checkpoint: 105 adapter/conditional tests and 223
policy/fence/workflow tests passed. The wide-metadata real-fence comparison,
malformed-history rejection and uncertain-upload reset tests passed separately.
Independent review approved the production boundary, fixture integration and
projection. Lint, inventory, docs and diff checks passed. The full controller
matrix is running; exact-commit CI and final results will be recorded on PR #572
and in the retained local evidence packet. Production admission remains blocked.
