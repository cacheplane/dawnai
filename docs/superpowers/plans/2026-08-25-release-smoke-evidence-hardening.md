# Release Smoke Evidence Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make published-release smoke evidence independently durable and fail closed against lane omission, noncanonical receipts, npm-evidence spoofing, escaped subprocesses, and daemon-owned resource leaks.

**Architecture:** One controller-owned inventory drives raw receipt ingestion, exact Actions-artifact correlation, attempt-scoped draft Release escrow, marker/body evidence, and independent audit. Release commands use an isolated Linux systemd/cgroup-v2 runner with a gated start and verified cleanup; the metadata lane composes that runner with the corrected official npm-audit boundary. Docker identities and cleanup live outside killable clients.

**Tech Stack:** Node.js 24 ESM, `node:test`, GitHub Actions/Release APIs, npm 11.17 official `audit signatures`, Linux cgroup v2, systemd transient services, Docker CLI, Biome.

---

## File structure

- `scripts/release/smoke-result.mjs`: immutable smoke inventory, canonical result parser, correlation, aggregate.
- `scripts/release/cli.mjs`: exact directory/raw-byte ingestion and trusted Actions run identity.
- `scripts/release/metadata.mjs`: Actions binding, attempt-scoped Release receipt escrow, descriptor/body/asset invariants.
- `scripts/release/smoke-containment.mjs`: hardened systemd/cgroup-v2 capability and cleanup adapter.
- `scripts/release/smoke-process-runner.mjs`: bounded command policy over strict containment.
- `scripts/release/smoke-command-shim.mjs`: descriptor parser and pre-exec ready/gate handshake inside the cgroup.
- `scripts/release/smoke/{published-harness,runtime-targets,scaffold,storage}.mjs`: strict production command defaults.
- `scripts/published-artifact-verify.mjs`: existing release-mode metadata lane; strict registry/tar/npm-audit verification while manual mode stays best effort.
- `scripts/published-artifact-smoke.mjs`: inner probes consume outer-allocated Docker identities.
- `scripts/release/audit.mjs`: audit selected durable Release-hosted receipts, never expiring Actions bytes.

### Task 1: Controller-owned inventory and raw canonical bytes

**Files:**
- Modify: `scripts/release/smoke-result.mjs`
- Modify: `scripts/release/cli.mjs`
- Test: `scripts/release/test/smoke-result.test.mjs`
- Test: `scripts/release/test/controller.test.mjs`

- [ ] **Step 1: Write failing inventory tests**

Assert `REQUIRED_RELEASE_SMOKE_LANES` is deeply frozen and exactly `metadata`, `published-harness`, `runtime-targets`, `scaffold`, `storage` in lexical order. Call correlation/aggregation without `requiredLanes`; omission of each lane, duplicates, and extras fail. Supplying `requiredLanes` is an unknown option, so a caller cannot choose a subset.

- [ ] **Step 2: Run the result suite and verify RED**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test scripts/release/test/smoke-result.test.mjs
```

Expected: FAIL because inventory is caller-owned.

- [ ] **Step 3: Implement fixed correlation and root run identity**

Export the fixed inventory, remove `requiredLanes` from options, and add root `workflowRunId`/`runAttempt` to aggregate schema. Each aggregate lane must match both root values.

- [ ] **Step 4: Write failing CLI ingestion tests**

Expect fresh owned-copy `Buffer` values with no caller alias for exactly
`<lane>.json`, stored in an inventory-ordered frozen container. Do not attempt to
freeze nonempty Buffer views. Reject missing/extra/duplicate/misnamed entries,
symlinks, invalid UTF-8, duplicate JSON keys, noncanonical layout, oversize, and
changed-during-read inputs before Release calls; retain raw byte equality and
canonical reparsing assertions.

- [ ] **Step 5: Run controller suite and verify RED**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test scripts/release/test/controller.test.mjs
```

Expected: FAIL because the CLI parses arbitrary JSON entries.

- [ ] **Step 6: Implement exact bounded byte ingestion**

Require exact filenames from the exported inventory, use the bounded no-follow regular-file reader, retain before/after directory identity checks, and return raw Buffers in inventory order. Parse trusted positive `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT` separately for reconciliation.

- [ ] **Step 7: Verify and commit**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test scripts/release/test/smoke-result.test.mjs scripts/release/test/controller.test.mjs
git add scripts/release/smoke-result.mjs scripts/release/cli.mjs scripts/release/test/smoke-result.test.mjs scripts/release/test/controller.test.mjs
git commit -m "fix(release): own exact smoke receipt inventory"
```

Expected: PASS.

### Task 2: Exact Actions binding and durable Release receipt escrow

**Files:**
- Modify: `scripts/release/limits.mjs`
- Modify: `scripts/release/metadata.mjs`
- Modify: `scripts/release/test/metadata.test.mjs`
- Modify: `scripts/release/test/support/marker-observation.mjs`
- Modify exact marker fixtures under: `scripts/release/test/{abandonment,audit,candidate,github-write,planner}.test.mjs`

- [ ] **Step 1: Write failing raw/trusted-run reconciliation tests**

Pass canonical Buffers plus trusted run/attempt. Reject object input, duplicate keys, invalid UTF-8, noncanonical bytes, wrong run/attempt, missing/extra lanes, and failed receipts before any GitHub call.

- [ ] **Step 2: Write failing Actions correlation tests**

Require exact current run-attempt workflow path, tag ref, and SHA. From `listActionsRunArtifacts({runId})`, select exactly one `smoke-result-<lane>-<run>-<attempt>` per lane despite prior attempts. Re-read each unique ID; require exact name/run/SHA, `expired:false`, and canonical service digest; derive the URL only from trusted repository/run plus that API-observed ID, never caller or upload-action output. Download by ID; verify ZIP service digest and exactly one `<lane>.json` whose bytes equal the input. Test missing/duplicate/wrong/expired/drifting cases.

- [ ] **Step 3: Write failing crash/retry escrow tests**

Upload raw receipts as `smoke-result-<lane>-<run>-<attempt>.json` before marker CAS. Fault after each upload and after CAS. Under `NPM_COMPLETE`, zero or a matching lane subset per attempt resumes; a new attempt retains old partial assets in its disjoint namespace. Same-name different bytes, malformed subsets, duplicates, unexpected names, cumulative limits, or mutation fail.

- [ ] **Step 4: Write failing descriptor/body tests**

The selected `artifacts` array has five exact entries:

```js
{
  lane,
  actionsArtifactId,
  actionsArtifactName,
  actionsArtifactUrl,
  actionsArtifactServiceDigest,
  releaseAssetId,
  releaseAssetName,
  receiptSha256,
}
```

The root binds workflow/run/attempt/fixed lanes/aggregate digest. A sorted `receiptAssets` array binds every retained current or prior partial Release receipt `{lane, workflowRunId, runAttempt, releaseAssetId, releaseAssetName, receiptSha256}`. The marker selects exactly one complete attempt. Render all selected locators/digests and retained-attempt count in the body.

- [ ] **Step 5: Run tests and verify RED**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test scripts/release/test/metadata.test.mjs scripts/release/test/controller.test.mjs
```

Expected: FAIL because current code snapshots bytes away and stores one unlocatable aggregate digest.

- [ ] **Step 6: Implement bounded observation, escrow, and CAS**

Add receipt/archive/cumulative limits. Snapshot non-byte inputs separately. Bind the exact Actions reader methods, verify/download each artifact, upload missing raw Release assets with no-clobber/equal-byte semantics, re-list/download and canonical-parse every smoke namespace asset, then construct the full descriptor and perform the sole transition to `SMOKES_COMPLETE`. Re-read marker and assets after CAS.

- [ ] **Step 7: Implement exact marker/asset-union invariants**

Replace `smokeAggregateSha256` with nullable `smoke`. Require `smoke:null` through `NPM_COMPLETE`; require a valid immutable descriptor thereafter. Keep 45 base assets exact, add a bounded smoke group, then the separate bounded audit group. Later phases require the descriptor's full retained asset set and selected five. Only reconciliation may resume a matching pre-marker smoke subset.

- [ ] **Step 8: Update fixtures, verify, and commit**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test \
  scripts/release/test/metadata.test.mjs scripts/release/test/controller.test.mjs \
  scripts/release/test/abandonment.test.mjs scripts/release/test/audit.test.mjs \
  scripts/release/test/candidate.test.mjs scripts/release/test/github-write.test.mjs \
  scripts/release/test/planner.test.mjs
git add scripts/release/limits.mjs scripts/release/metadata.mjs scripts/release/cli.mjs scripts/release/test
git commit -m "fix(release): escrow exact smoke receipts"
```

Expected: PASS.

### Task 3: Mandatory systemd/cgroup-v2 containment

**Files:**
- Create: `scripts/release/smoke-containment.mjs`
- Create: `scripts/release/smoke-command-shim.mjs`
- Create: `scripts/release/smoke-process-runner.mjs`
- Create: `scripts/release/test/smoke-process-runner.test.mjs`
- Modify: `scripts/release/smoke/{published-harness,runtime-targets,scaffold,storage}.mjs`
- Modify: corresponding `scripts/release/test/*-smoke.test.mjs`
- Modify: `scripts/published-artifact-verify.mjs`
- Modify: `scripts/published-artifacts.test.mjs`

- [ ] **Step 1: Write failing executable/probe tests**

Reject non-Linux, missing cgroup v2, failed noninteractive sudo/system manager, missing control files, populated/unclean probe, or fixed `/usr/bin/{sudo,timeout,systemd-run,systemctl,tee}` that is not a root-owned regular executable or is group/world writable. Assert no workload starts. Probe refusal occurs as the first recorded lane check so a correlated failure receipt is still emitted.

- [ ] **Step 2: Write failing hardened-unit/gated-start tests**

Assert `systemd-run --wait --pipe --expand-environment=no` omits `--collect` and
`RemainAfterExit`; require `Type=exec`, `KillMode=control-group`,
`NoNewPrivileges=yes`, `RestrictSUIDSGID=yes`, empty bounding/ambient
capabilities, `Delegate=no`, `ProtectControlGroups=yes`, `UMask=0077`, bounded
`RuntimeMaxSec`, and bounded `TimeoutStopSec`. On stock ubuntu-24.04/systemd 255,
the probe re-reads the effective live `ProtectControlGroups=yes` and `Delegate=no`
properties; it must not install or override systemd. The shim may publish
readiness but cannot spawn the requested command until the controller caches a
validated live `ControlGroup` and opens its gate.

- [ ] **Step 3: Implement capability and gated start**

Probe one hardened transient service. For commands, write a bounded mode-0600 exact descriptor with ready/gate paths, start the fixed Node shim, wait for readiness plus exact live unit state, constrain/cache `ControlGroup` below `/sys/fs/cgroup`, require `cgroup.events`/`cgroup.kill`, then atomically open the gate. Delete descriptor/gate files during cleanup.

- [ ] **Step 4: Write failing lifecycle/control-child tests**

Cover success, accepted exit 1, nonzero/spawn failure, timeout, abort,
`RuntimeMaxSec`, output overflow, and nominal parent exit with a detached child.
Every path cleans the unit. Every privileged control operation is exactly
`/usr/bin/sudo -n /usr/bin/timeout --signal=TERM --kill-after=5s 30s
<fixed-command>`; the long-lived `systemd-run --wait` operation uses exactly
`--signal=TERM --kill-after=10s 25m`. Forbid `--foreground`. The outer client
waits at least 40 seconds for control operations or 25 minutes 15 seconds for the
workload operation before termination/reap fallback, also has a fixed output
bound, and always awaits reap. Cleanup failure aggregates with the primary cause.

- [ ] **Step 5: Implement verified cgroup cleanup**

Signal the entire unit, read cached `cgroup.events`, and while populated write
`1\n` via fixed `/usr/bin/sudo -n /usr/bin/timeout --signal=TERM
--kill-after=5s 30s /usr/bin/tee -- <validated-path>/cgroup.kill`. Wait for
`populated 0`; after deactivation accept only it or exact `ENOENT` for that
cached path. Stop/reset, verify again, and await all control children. Cleanup
also runs on success.

- [ ] **Step 6: Add detached-descendant integration/refusal tests**

With an injected adapter, prove timeout/abort/output/success eliminate detached
signal-ignoring descendants and surface cleanup errors. Include a privileged
control child that ignores `SIGTERM`; prove the positive `--kill-after` deadline,
outer post-hard-kill wait, and reap leave no survivor. Run the real test only
where the exact probe succeeds; other hosts must exercise deterministic
pre-workload refusal and never claim support.

- [ ] **Step 7: Wire every production smoke path**

The four dedicated modules may import non-process helpers but not generic `run`. The existing release-mode branch of `published-artifact-verify.mjs` explicitly selects strict mode; manual mode retains clearly named best-effort execution. Pass strict commands through nested npm/node/tar/Docker/audit/probe/cleanup calls. Static and dynamic contract tests prove no production fallback and failure-receipt behavior.

- [ ] **Step 8: Verify and commit**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test \
  scripts/release/test/smoke-process-runner.test.mjs \
  scripts/release/test/published-harness-smoke.test.mjs \
  scripts/release/test/runtime-targets-smoke.test.mjs \
  scripts/release/test/scaffold-smoke.test.mjs \
  scripts/release/test/storage-smoke.test.mjs
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm test:published-artifacts
git add scripts/release/smoke-containment.mjs scripts/release/smoke-command-shim.mjs scripts/release/smoke-process-runner.mjs scripts/release/smoke scripts/published-artifact-verify.mjs scripts/release/test scripts/published-artifacts.test.mjs
git commit -m "fix(release): contain every smoke subprocess"
```

Expected: PASS.

### Task 4: Official npm audit in release-mode metadata

**Dependency:** Build on corrected boundary `4a95aac900319ce877ff3493603ecc744c5ed66f`; never duplicate its npm 11.17, synthetic-tree, certificate, signature, or SLSA checks.

**Files:**
- Modify: `scripts/published-artifact-verify.mjs`
- Modify: `scripts/lib/published-artifacts.mjs`
- Test: `scripts/published-artifacts.test.mjs`

- [ ] **Step 1: Write failing production trust/wiring tests**

Exercise the existing release-mode branch without overriding package verification. Inject `createNpmReader`, `createNpmAuditVerifier`, and strict runner. Prove all 21 entries receive registry/tarball checks and `auditVerifier.verifyPackage({entry,candidate})`; one verifier is reused and disposed on every path; all npm/tar commands use strict mode. Forged packument provenance/signatures confer no authority. Pending or mismatched official results fail. Removed `npmReader.verifyRegistrySignatures` is never read.

- [ ] **Step 2: Run and verify RED**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm test:published-artifacts
```

Expected: FAIL on the removed legacy signature method/default wiring.

- [ ] **Step 3: Wire official audit once per lane**

Create one `createNpmAuditVerifier({runNpm: strictRunner, environment, signal})`, pass the exact release candidate to each `verifyPackage`, and dispose in `finally`. Registry observation/download proves name/version/latest/integrity/tarball. Change `validateExactPublishedPackageEvidence` to require the corrected pinned official audit result for signature/SLSA identity and ignore packument self-claims.

- [ ] **Step 4: Verify and commit**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test scripts/release/test/npm-audit.test.mjs
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm test:published-artifacts
git add scripts/published-artifact-verify.mjs scripts/lib/published-artifacts.mjs scripts/published-artifacts.test.mjs
git commit -m "fix(release): use official npm audit in metadata smoke"
```

Expected: PASS.

### Task 5: Outer-owned Docker identity and cleanup

**Files:**
- Modify: `scripts/published-artifact-smoke.mjs`
- Modify: `scripts/release/smoke/published-harness.mjs`
- Modify: `scripts/release/smoke/storage.mjs`
- Modify: `scripts/published-artifacts.test.mjs`
- Modify: `scripts/release/test/{published-harness,storage}-smoke.test.mjs`

- [ ] **Step 1: Write failing ownership tests**

Require a preallocated validated thread ID in the generated sandbox probe. Force accepted-then-client-failed and timeout paths; outer cleanup must remove/verify absence of the exact container and volume. In storage, preallocate both pgvector/Postgres names and register both cleanups before either `docker run`; a timeout immediately after daemon acceptance must still remove the exact container. Assert cleanup ordering and primary-plus-cleanup aggregation.

- [ ] **Step 2: Run and verify RED**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test scripts/release/test/published-harness-smoke.test.mjs scripts/release/test/storage-smoke.test.mjs
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm test:published-artifacts
```

Expected: FAIL because killable clients still own identity/cleanup.

- [ ] **Step 3: Implement authoritative idempotent cleanup**

Allocate bounded Docker-safe UUID identities and register cleanups before starting clients. Pass identities inward. Cleanup uses strict commands and treats a missing resource as success only after exact inspect proves absence; daemon/auth/transport errors remain failures. Keep inner cleanup as an idempotent fast path.

- [ ] **Step 4: Require `--ignore-scripts` on initial harness install**

Add the literal flag to the first fixed-group npm install; retain official npm audit accepted exits `[0,1]`.

- [ ] **Step 5: Verify and commit**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test scripts/release/test/published-harness-smoke.test.mjs scripts/release/test/storage-smoke.test.mjs
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm test:published-artifacts
git add scripts/published-artifact-smoke.mjs scripts/release/smoke/published-harness.mjs scripts/release/smoke/storage.mjs scripts/published-artifacts.test.mjs scripts/release/test/published-harness-smoke.test.mjs scripts/release/test/storage-smoke.test.mjs
git commit -m "fix(release): own Docker smoke cleanup externally"
```

Expected: PASS.

### Task 6: Independent audit of durable receipts

**Files:**
- Modify: `scripts/release/audit.mjs`
- Modify: `scripts/release/test/audit.test.mjs`

- [ ] **Step 1: Write failing durable-evidence tests**

With Actions artifacts expired/missing, require audit to use only marker-bound Release receipt assets. Verify every recorded Release asset ID/name/content digest, canonical bytes, lane/run/attempt, exact selected inventory, retained-asset set, and recomputed aggregate. Missing/duplicate/extra/changed/mismatched assets fail. No recent-run listing or Actions download exists.

- [ ] **Step 2: Run and verify RED**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test scripts/release/test/audit.test.mjs
```

Expected: FAIL because audit does not require durable smoke assets.

- [ ] **Step 3: Implement exact Release-hosted re-observation**

Extend draft asset preflight/audit observation to download smoke assets by recorded Release ID, canonical-parse and correlate them, verify the full retained set, select the descriptor's complete attempt, and recompute aggregate digest. Retained Actions metadata may be informational but is never required after completion.

- [ ] **Step 4: Verify and commit**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" node --test scripts/release/test/audit.test.mjs
git add scripts/release/audit.mjs scripts/release/test/audit.test.mjs
git commit -m "fix(release): audit durable smoke receipts"
```

Expected: PASS.

### Task 7: Full verification and independent review

**Files:**
- Review all changed files from the rebased base SHA.

- [ ] **Step 1: Run scoped Biome**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm exec biome check \
  scripts/release/smoke-result.mjs scripts/release/cli.mjs scripts/release/metadata.mjs \
  scripts/release/limits.mjs scripts/release/smoke-containment.mjs \
  scripts/release/smoke-command-shim.mjs scripts/release/smoke-process-runner.mjs \
  scripts/release/smoke scripts/release/audit.mjs scripts/published-artifact-verify.mjs \
  scripts/published-artifact-smoke.mjs scripts/lib/published-artifacts.mjs \
  scripts/release/test scripts/published-artifacts.test.mjs
```

Expected: PASS; apply only scoped fixes.

- [ ] **Step 2: Run release/published suites**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm build
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm test:release-controller
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm test:published-artifacts
```

Expected: PASS.

- [ ] **Step 3: Run Definition of Done**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH" corepack pnpm ci:validate
```

Expected: PASS except separately documented environment-only gated integration lanes.

- [ ] **Step 4: Review exact range**

```bash
git status --short
git diff --check <rebased-base>..HEAD
git log --oneline --decorate <rebased-base>..HEAD
```

Dispatch requirements and code-quality reviewers, fix every Critical/Important finding test-first, and rerun affected/full gates.

- [ ] **Step 5: Hand off Task 10 contract**

Task 10 must select `ubuntu-24.04`, record the observed runner image version,
execute the capability probe as the first receipt-producing lane check, verify
the stock systemd 255 effective `ProtectControlGroups=yes`/`Delegate=no`
properties, and fault-inject/prove the exact root-timeout/client-reap/cgroup
cleanup mechanism, including a privileged TERM-ignoring control child with no
survivor. The label is mutable; no Windows support is claimed. Do not mutate
workflows in this task.
