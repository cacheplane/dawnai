# Docker PID Exhaustion Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover Docker thread sandboxes when PID saturation prevents OCI from starting a command, while preserving workspace data and making the real-Docker containment lane deterministic.

**Architecture:** `docker-exec.ts` narrowly classifies observed OCI PID-exhaustion startup results and invokes an internal recovery callback once. `docker-sandbox.ts` owns the destructive lifecycle operation: remove only the keeper container, recreate it with the original policy and active command signal, retain the named volume, and retry the command once.

**Tech Stack:** TypeScript 7, Node.js 24, Vitest 4, Docker CLI, Changesets, pnpm.

---

## File map

- `packages/sandbox/src/docker/docker-exec.ts`: private PID-exhaustion classifier and one-shot retry orchestration.
- `packages/sandbox/src/docker/docker-sandbox.ts`: volume-preserving container recycle callback and lifecycle errors.
- `packages/sandbox/test/docker-backends.test.ts`: classifier, active-signal, and retry-boundary unit tests.
- `packages/sandbox/test/docker-sandbox.unit.test.ts`: provider recycle, policy/volume preservation, and failure tests.
- `packages/sandbox/test/docker-sandbox.integration.test.ts`: deterministic real-Docker containment and recovery checks.
- `.changeset/<generated-name>.md`: patch release note for `@dawn-ai/sandbox`.

### Task 1: Docker exec classification and one-shot retry

**Files:**
- Modify: `packages/sandbox/test/docker-backends.test.ts`
- Modify: `packages/sandbox/src/docker/docker-exec.ts`

- [ ] **Step 1: Write failing exec recovery tests**

Add tests that construct `dockerExec` with
`recoverFromPidExhaustion(signal)`. Sequence the fake Docker results so the
first is a non-zero `OCI runtime exec failed` result with each known signature
(`Resource temporarily unavailable` in stderr and
`read init-p: connection reset by peer` in stdout), and the second succeeds.
Assert two exec calls, one recovery call, the active command signal identity,
and the successful second result.

- [ ] **Step 2: Write failing negative and retry-boundary tests**

Cover a command-level `sh: Cannot fork`, a generic
`OCI runtime exec failed`, a successful result containing similar text, and a
timeout result. Assert no recovery. Add a case where both attempts return a
matching exhaustion result and assert exactly two exec calls and one recovery.

- [ ] **Step 3: Run the focused test and verify RED**

Run:
`pnpm --filter @dawn-ai/sandbox exec vitest --run --config vitest.config.ts test/docker-backends.test.ts`

Expected: failures because the recovery option and retry do not exist.

- [ ] **Step 4: Implement the minimal classifier and retry**

Add an internal options type with:

```ts
readonly recoverFromPidExhaustion?: (signal: AbortSignal) => Promise<void>
```

Classify only non-zero results whose combined output contains the exact
`OCI runtime exec failed` marker and either known resource signature. Execute
the existing Docker call through a local function, recover on the first matching
result, and call that function once more. Apply existing timeout annotation to
the final result only.

- [ ] **Step 5: Run focused and full backend tests and verify GREEN**

Run the focused command from Step 3, then:
`pnpm --filter @dawn-ai/sandbox test`

- [ ] **Step 6: Commit**

Commit the two files as `fix(sandbox): retry exec after PID exhaustion`.

### Task 2: Provider-owned volume-preserving recycle

**Files:**
- Modify: `packages/sandbox/test/docker-sandbox.unit.test.ts`
- Modify: `packages/sandbox/src/docker/docker-sandbox.ts`

- [ ] **Step 1: Write a failing provider recovery test**

Use a recording Docker fake that performs an initial create, reports a matching
PID-exhaustion result on the first exec, and succeeds on the second. Make volume
inspect fail for initial creation and succeed during recovery. Assert:

- `docker rm -f dawn-sbx-abc` occurs between the two exec attempts;
- a second keeper `docker run -d` uses the original image, policy flags, and
  `dawn-sbx-vol-abc:/workspace`;
- chown-init runs only during initial creation;
- the removal and recreation receive the active command signal; and
- the retried command result is returned.

- [ ] **Step 2: Write a failing removal-error test**

Return non-zero from recovery's `docker rm -f`. Assert the command rejects with
`DAWN_E2001`, includes container-removal context, and performs no second exec.

- [ ] **Step 3: Run the provider test and verify RED**

Run:
`pnpm --filter @dawn-ai/sandbox exec vitest --run --config vitest.config.ts test/docker-sandbox.unit.test.ts`

Expected: recovery assertions fail because the provider supplies no callback.

- [ ] **Step 4: Implement the provider recovery callback**

Add a focused internal recycle helper inside `dockerSandbox`. It must check the
`docker rm -f` exit code, throw `sandboxUnavailable` on failure, then call
`ensureContainer(threadId, policy, activeCommandSignal)`. Wire it into
`dockerExec` while preserving the conditional timeout option required by
`exactOptionalPropertyTypes`.

- [ ] **Step 5: Run focused and package tests and verify GREEN**

Run the focused command from Step 3 and `pnpm --filter @dawn-ai/sandbox test`.

- [ ] **Step 6: Commit**

Commit the two files as `fix(sandbox): recycle PID-exhausted containers`.

### Task 3: Deterministic real-Docker containment and recovery

**Files:**
- Modify: `packages/sandbox/test/docker-sandbox.integration.test.ts`

- [ ] **Step 1: Replace the timing-racy containment assertion**

Set an explicit small `security.pidsLimit` for the adversarial test. Use bounded
short-lived children, assert the spawning command fails before completing the
loop, and poll `echo alive` until it succeeds or a deadline expires. Poll the
actual condition, retaining the latest Docker result for the failure message.

- [ ] **Step 2: Add a real recycle-and-volume test**

Create a workspace sentinel, record the keeper container ID, then launch a
background Node process that fills the PID cgroup and writes a readiness file
without leaving Docker-exec pipes open. Issue `echo recovered` through the
acquired handle. Assert it succeeds after the provider replaces the keeper,
the container ID changes, and the workspace sentinel remains readable.

- [ ] **Step 3: Run focused real-Docker tests repeatedly**

Run at least ten repetitions:

`DAWN_TEST_DOCKER=1 pnpm --filter @dawn-ai/sandbox exec vitest --run --config vitest.config.ts test/docker-sandbox.integration.test.ts`

Expected: every repetition passes, with test cleanup removing containers and
volumes even on assertion failures.

- [ ] **Step 4: Commit**

Commit as `test(sandbox): make PID containment deterministic`.

### Task 4: Release note and scoped quality checks

**Files:**
- Create: `.changeset/<generated-name>.md`

- [ ] **Step 1: Add a patch changeset**

Create a changeset for `@dawn-ai/sandbox` explaining that Docker sandboxes now
recover from OCI PID-exhaustion startup failures by recreating the keeper while
retaining the thread workspace volume.

- [ ] **Step 2: Run scoped static verification**

Run:

```sh
pnpm --filter @dawn-ai/sandbox lint
pnpm --filter @dawn-ai/sandbox build
pnpm --filter @dawn-ai/sandbox typecheck
pnpm --filter @dawn-ai/sandbox test
node scripts/check-changesets.mjs
git diff --check
```

- [ ] **Step 3: Commit**

Commit as `chore: add Docker PID recovery changeset`.

### Task 5: Full verification, review, and publication

**Files:**
- Verify all changed files against this plan and the design spec.

- [ ] **Step 1: Run full local Definition of Done**

Run `pnpm ci:validate` under Node 24 and retain its complete result.

- [ ] **Step 2: Request independent code review**

Review the complete `origin/main..HEAD` range against the spec and this plan.
Fix all Critical and Important findings, rerun affected checks, and repeat review
until approved.

- [ ] **Step 3: Re-run fresh final gates**

Run the focused unit tests, repeated real-Docker lane, full `pnpm ci:validate`,
changeset check, and `git diff --check` after the final code change.

- [ ] **Step 4: Publish a ready pull request**

Push the branch and create a non-draft PR describing the root cause, narrow
recovery behavior, background-process tradeoff, and local verification.

- [ ] **Step 5: Monitor and merge**

Enable squash auto-merge. Monitor all required checks plus `sandbox-docker`.
Investigate any failure from logs, update the branch without force-pushing,
and merge only after both normal validation and real-Docker CI are green.
