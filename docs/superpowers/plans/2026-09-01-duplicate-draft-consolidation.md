# Duplicate Draft Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, merge, and operate a focused local CLI that proves the three v0.8.22 drafts equivalent, preserves Release `379991871`, safely removes only Releases `379982100` and `379986168`, and records a verifiable receipt.

**Architecture:** Implement a standalone operator path that is unreachable from `.github/workflows/release.yml`. Strict schema, safe-file, evidence, authority, journal, adapter, and orchestration modules keep the destructive effect isolated behind an exact duplicate-ID boundary; production release parsers and attestation verification remain the source of truth for the 45-asset escrow. A hash-chained write-ahead journal makes interruption outcomes explicit and resumable while the required `main` freeze remains intact.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`, existing Dawn release readers/parsers, GitHub CLI authentication, GitHub REST API, npm registry reader, SHA-256 canonical JSON envelopes.

---

## Execution setup

Implement this prerequisite from current `origin/main`, not from the larger
single-owner abandonment branch.

1. Use `superpowers:using-git-worktrees` to create a clean worktree on branch
   `blove/duplicate-draft-consolidation` from the latest `origin/main`.
2. Bring only these approved documents into that worktree:
   `docs/superpowers/specs/2026-09-01-duplicate-draft-consolidation-design.md`
   and this plan. Do not bring abandonment implementation commits.
3. Verify the starting point with:

   ```bash
   git merge-base --is-ancestor origin/main HEAD
   git diff --name-only origin/main...HEAD
   ```

   Before implementation, the diff must contain only the two documentation
   files. Release must remain `disabled_manually`; this setup does not mutate
   GitHub or npm state.

## File structure

### Create

- `scripts/release/duplicate-draft-consolidation-schema.mjs` — exact shared
  record schemas, canonical JSON/envelope encoding, hash validation, size caps.
- `scripts/release/duplicate-draft-consolidation-files.mjs` — no-follow bounded
  reads and atomic durable writes for private `.dawn` evidence and the tracked
  receipt.
- `scripts/release/duplicate-draft-consolidation-evidence.mjs` — strict GitHub
  Release/asset normalization, 45-asset hydration, production escrow and
  attestation verification, three-way semantic/payload equality.
- `scripts/release/duplicate-draft-consolidation-adapters.mjs` — bounded local
  Git/GitHub/npm/attestation adapters and the one exact Release DELETE effect.
- `scripts/release/duplicate-draft-consolidation-authority.mjs` — repository,
  main, workflow/run, tag, npm, Release, and terminal direct-target observations.
- `scripts/release/duplicate-draft-consolidation-journal.mjs` — hash-chained
  events, legal transitions, attempt bounds, resume decisions, final receipt.
- `scripts/release/duplicate-draft-consolidation.mjs` — `inspect`, `perform`, and
  `verify` orchestration with no process-global dependencies.
- `scripts/release/duplicate-draft-consolidation-cli.mjs` — strict operator CLI,
  production dependency composition, redacted output, exit codes.
- `scripts/release/test/support/duplicate-draft-consolidation-fixture.mjs` — one
  realistic three-draft/45-asset fixture used across focused tests.
- `scripts/release/test/duplicate-draft-consolidation-schema.test.mjs`
- `scripts/release/test/duplicate-draft-consolidation-files.test.mjs`
- `scripts/release/test/duplicate-draft-consolidation-evidence.test.mjs`
- `scripts/release/test/duplicate-draft-consolidation-adapters.test.mjs`
- `scripts/release/test/duplicate-draft-consolidation-authority.test.mjs`
- `scripts/release/test/duplicate-draft-consolidation-journal.test.mjs`
- `scripts/release/test/duplicate-draft-consolidation.test.mjs`
- `scripts/release/test/duplicate-draft-consolidation-cli.test.mjs`
- `scripts/release/test/duplicate-draft-consolidation-rehearsal.test.mjs`

### Modify

- `scripts/release/test/workflow-contracts.test.mjs` — prove the new CLI and
  DELETE effect are unreachable from every workflow.
- `package.json` — add the local `release:consolidate-drafts` command only.

### Explicitly unchanged

- `.github/workflows/release.yml`
- `scripts/release/test/fixtures/release-script-hashes.json`
- `scripts/release/controller-schema.json`
- Vercel dependencies and the `vercel-native` CI lane

The new operator CLI is not workflow-reachable, so it must not be added to the
release-path hash inventory.

### Task 1: Lock dedicated limits and canonical envelope schemas

**Files:**
- Create: `scripts/release/duplicate-draft-consolidation-schema.mjs`
- Test: `scripts/release/test/duplicate-draft-consolidation-schema.test.mjs`

- [ ] **Step 1: Write failing limit tests**

Import the dedicated consolidation limits from the new schema module and assert:

```js
assert.deepEqual(DUPLICATE_DRAFT_CONSOLIDATION_LIMITS, {
  proposedBytes: 4 * MEBIBYTE,
  journalBytes: 72 * MEBIBYTE,
  finalReceiptBytes: 96 * MEBIBYTE,
  authorityStageBytes: 8 * MEBIBYTE,
  survivorEvidenceBytes: 2 * MEBIBYTE,
  journalEventReserveBytes: 8 * MEBIBYTE,
  envelopeReserveBytes: MEBIBYTE,
  maximumDeleteAttempts: 3,
  maximumTargets: 2,
  maximumOrphanAuthorityRecoveries: 1,
  maximumAssetDownloads: 135,
})
assert.ok(
  DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes >=
    (2 * 3 + 1 + 1) *
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.authorityStageBytes +
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalEventReserveBytes,
)
assert.ok(
  DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.finalReceiptBytes >=
    DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.proposedBytes +
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes +
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.authorityStageBytes +
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.survivorEvidenceBytes +
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.envelopeReserveBytes,
)
```

- [ ] **Step 2: Run the limit test and verify RED**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test scripts/release/test/duplicate-draft-consolidation-schema.test.mjs
```

Expected: FAIL because the dedicated schema module does not exist.

- [ ] **Step 3: Add the exact limits and module-load invariants**

Export the frozen object above from
`duplicate-draft-consolidation-schema.mjs`. Throw at module initialization if
either headroom relationship is false. Import existing `RELEASE_PAYLOAD_LIMITS`
for per-Release escrow caps, but keep `limits.mjs` and its workflow-reachable
pinned hash unchanged.

- [ ] **Step 4: Write failing canonical-envelope tests**

Cover all three exact top-level record schemas and the event envelope. Use the
field order from the approved design. Test:

```js
const envelope = createConsolidationEnvelope("proposed", proposedRecord())
const bytes = canonicalConsolidationEnvelopeBytes("proposed", envelope)
assert.deepEqual(parseConsolidationEnvelope("proposed", bytes), envelope)
assert.match(envelope.recordSha256, /^[0-9a-f]{64}$/u)
```

Mutate each required field, add an unknown field, reorder a fixed array, inject
a duplicate JSON key, change the digest, omit the final newline, pass invalid
UTF-8, and exceed the per-kind size bound. Each must throw before returning data.

- [ ] **Step 5: Run the schema test and verify RED**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test scripts/release/test/duplicate-draft-consolidation-schema.test.mjs
```

Expected: FAIL because the schema module does not exist.

- [ ] **Step 6: Implement the minimal strict codec**

Export:

```js
export function createConsolidationEnvelope(kind, record)
export function canonicalConsolidationEnvelopeBytes(kind, envelope)
export function parseConsolidationEnvelope(kind, bytes)
export function canonicalRecordSha256(record)
export function canonicalEventEnvelope(event, previousEventSha256)
export function parseJournalEventEnvelope(value, expectedSequence, previousEventSha256)
```

Use exact field arrays for every object in the design. Normalize into newly
constructed objects in canonical field order; do not canonicalize unknown input
by sorting arbitrary keys. Hash `JSON.stringify(record) + "\n"`, with the digest
outside the hashed record. Canonical-byte comparison must reject duplicate keys
because parsed-and-reencoded bytes differ.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test scripts/release/test/duplicate-draft-consolidation-schema.test.mjs
```

Expected: PASS.

Commit:

```bash
git add scripts/release/duplicate-draft-consolidation-schema.mjs scripts/release/test/duplicate-draft-consolidation-schema.test.mjs
git commit -m "feat(release): define draft consolidation evidence"
```

### Task 2: Implement safe private evidence and tracked-receipt files

**Files:**
- Create: `scripts/release/duplicate-draft-consolidation-files.mjs`
- Test: `scripts/release/test/duplicate-draft-consolidation-files.test.mjs`

- [ ] **Step 1: Write adversarial failing tests**

In a temporary repository, test private-file mode `0600`, tracked-file mode
`0644`, symlink rejection, non-regular-file rejection, wrong-owner injection,
hard-link rejection, group/other writable rejection, oversized input, pathname
replacement during read, same-size mutation during read, partial write failure,
and atomic replacement preserving the previous complete file.

The core success assertion is:

```js
await writePrivateEnvelope(target, bytes)
assert.equal((await stat(target)).mode & 0o777, 0o600)
assert.deepEqual(await readPrivateEnvelope(target, maximumBytes), bytes)
```

- [ ] **Step 2: Run the file test and verify RED**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test scripts/release/test/duplicate-draft-consolidation-files.test.mjs
```

Expected: FAIL because the file module does not exist.

- [ ] **Step 3: Implement safe reads and atomic writes**

Export:

```js
export async function readPrivateEnvelope(filePath, maximumBytes, dependencies)
export async function writePrivateEnvelope(filePath, bytes, dependencies)
export async function readTrackedReceipt(filePath, maximumBytes, dependencies)
export async function writeTrackedReceipt(filePath, bytes, dependencies)
```

For `.dawn` files require no-follow support, one regular link, current effective
owner, and exact `0600`. For the tracked receipt require regular/no-follow,
current owner, nonexecutable, and no group/other write bits; accept `0644`.
Compare device, inode, size, link count, mtime, and ctime before/after reading and
revalidate the final pathname. Write a same-directory `wx` temporary file,
`fsync` it, rename atomically, then `fsync` the parent directory. Clean up only
the exact temporary pathname on failure.

- [ ] **Step 4: Run focused tests and commit**

Run the test above; expected PASS.

Commit:

```bash
git add scripts/release/duplicate-draft-consolidation-files.mjs scripts/release/test/duplicate-draft-consolidation-files.test.mjs
git commit -m "feat(release): secure consolidation evidence files"
```

### Task 3: Prove exact Release and 45-asset parity

**Files:**
- Create: `scripts/release/duplicate-draft-consolidation-evidence.mjs`
- Create: `scripts/release/test/support/duplicate-draft-consolidation-fixture.mjs`
- Test: `scripts/release/test/duplicate-draft-consolidation-evidence.test.mjs`

- [ ] **Step 1: Build a realistic failing fixture**

Create three drafts with the approved IDs and opaque tags, distinct Release and
asset IDs, the same canonical `ESCROWED` body, one canonical
`release-record.json`, `manifest.json`, 21 package archives, and 22 replicated
multi-subject `.intoto.jsonl` bundles. The helper returns fake read adapters and
the expected 45-entry `{name, sha256}` projection.

- [ ] **Step 2: Write failing evidence tests**

Test the exact semantic Release projection and per-name asset projection. Cover
every excluded volatile field independently to prove it does not create false
inequality, then mutate each included field independently to prove it blocks.
Also cover:

- malformed/noncanonical marker body;
- wrong release record or manifest bytes;
- package order/name/hash drift;
- missing, extra, duplicate, or non-`uploaded` asset;
- malformed GitHub digest or digest/download mismatch;
- bundle-set mismatch or failed attestation verification;
- payload over 64 MiB per Release, 192 MiB aggregate, or 135 downloads;
- fourth matching draft, published candidate Release, or wrong author.

Use:

```js
const result = await inspectEquivalentDrafts({
  candidate: CANDIDATE,
  survivorId: "379991871",
  duplicateIds: ["379982100", "379986168"],
  releases: fixture.releases,
  github: fixture.github,
  attestations: fixture.attestations,
})
assert.equal(result.releases.length, 3)
assert.equal(result.payloadProof.baseAssetSet.length, 45)
assert.equal(result.attestationVerification.subjects.length, 22)
```

- [ ] **Step 3: Run the evidence test and verify RED**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test scripts/release/test/duplicate-draft-consolidation-evidence.test.mjs
```

Expected: FAIL because the evidence module does not exist.

- [ ] **Step 4: Implement evidence normalization and hydration**

Export:

```js
export async function inspectEquivalentDrafts(input)
export async function captureDirectTargetRead(input)
export function parseReleaseEvidence(value)
export function semanticReleaseProjection(value)
export function semanticAssetProjection(value)
export function assertEvidenceEqualsProposal(actual, proposed)
```

For each Release:

1. Parse the body with `parseReleaseMarker` and compare it with
   `canonicalReleaseBody`.
2. Download exactly 45 assets under existing release payload limits.
3. Parse `release-record.json` with `parseReleaseRecord` and require canonical
   record bytes.
4. Parse canonical `manifest.json` with `parseSealedReleaseManifest`.
5. Parse marker attestations with `parseAttestationSet`.
6. Call `canonicalBaseAssetSet` with the actual record, manifest/package bytes,
   marker attestation set, and all 22 bundles.
7. Call existing `verifyReleaseAttestationAnchor` with the replicated anchor
   bundle and compare its returned attestation set/base digest to the marker and
   canonical base set.
8. Compare every included semantic field and every same-name byte digest across
   all three drafts.

Do not export or duplicate the private attestation verifier from `metadata.mjs`;
the existing public anchor verifier already reaches the production verifier.

- [ ] **Step 5: Run focused tests and commit**

Run the evidence test; expected PASS.

Commit:

```bash
git add scripts/release/duplicate-draft-consolidation-evidence.mjs scripts/release/test/support/duplicate-draft-consolidation-fixture.mjs scripts/release/test/duplicate-draft-consolidation-evidence.test.mjs
git commit -m "feat(release): prove duplicate draft parity"
```

### Task 4: Add bounded production adapters and the isolated DELETE effect

**Files:**
- Create: `scripts/release/duplicate-draft-consolidation-adapters.mjs`
- Test: `scripts/release/test/duplicate-draft-consolidation-adapters.test.mjs`

- [ ] **Step 1: Write failing adapter tests**

Inject command and fetch fakes. Prove:

- authentication comes from `gh auth token` or an existing safe token variable,
  never argv/receipt/log output;
- GitHub reads use the trusted origin, API headers, 100-item pages, 100-page and
  10,000-record caps, and duplicate-ID rejection;
- local HEAD, symbolic branch, clean status, and `origin/main` use non-shell Git;
- repository/user/workflow/run/tag reads return exact normalized evidence;
- npm delegates to `createNpmReader` and preserves `ABSENT`/404/`E404`;
- only the approved duplicate IDs can reach DELETE;
- survivor, reordered/extra/missing ID, untrusted origin, malformed response,
  403/429/5xx, and abort-before-send are rejected;
- received 204 maps to `confirmed-204`, received 404 to
  `response-404-ambiguous`, and timeout/transport loss to
  `transport-ambiguous`.

The destructive-boundary assertion must be explicit:

```js
await assert.rejects(
  () => writer.deleteDuplicate({ releaseId: "379991871" }),
  /survivor|approved duplicate/u,
)
assert.equal(fetchCalls.length, 0)
```

- [ ] **Step 2: Run the adapter test and verify RED**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test scripts/release/test/duplicate-draft-consolidation-adapters.test.mjs
```

Expected: FAIL because the adapter module does not exist.

- [ ] **Step 3: Implement the production composition**

Export:

```js
export async function createDuplicateDraftConsolidationAdapters(options)
export function createExactDuplicateDeleteEffect(options)
```

Reuse `createGitHubReader`, `createOwnerPreflightAdapters`, `createNpmReader`,
`createCliAttestationVerifier`, and the bounded process runner. Resolve the
GitHub token in memory through `gh auth token` only when no safe injected token
exists. The delete effect accepts the frozen survivor and ordered duplicate
set at construction and performs one `DELETE
/repos/cacheplane/dawnai/releases/{releaseId}` with a bounded timeout. It must
not expose create/update/publish/tag methods.

- [ ] **Step 4: Run focused tests and commit**

Run the adapter test; expected PASS.

Commit:

```bash
git add scripts/release/duplicate-draft-consolidation-adapters.mjs scripts/release/test/duplicate-draft-consolidation-adapters.test.mjs
git commit -m "feat(release): isolate duplicate draft deletion"
```

### Task 5: Capture fresh authority with a terminal direct-target read

**Files:**
- Create: `scripts/release/duplicate-draft-consolidation-authority.mjs`
- Test: `scripts/release/test/duplicate-draft-consolidation-authority.test.mjs`

- [ ] **Step 1: Write failing authority tests**

Model the exact `cacheplane/dawnai` repository/user identity, `main` SHA triple,
disabled Release workflow, empty nonterminal runs, annotated `v0.8.22`, ordered
21-package npm inventory, remaining draft set, payload proof, and direct target
read. Assert the final two network calls are direct Release-by-ID and full asset
enumeration; after they complete, orchestration may perform only the local
journal write before DELETE.

Reject dirty checkout, non-`main` branch, mismatched HEAD/origin/GitHub SHA,
wrong actor/repository, active workflow, active run, moved/lightweight tag,
non-E404 npm result, missing/extra Release, target/list disagreement, stale npm
observation, and clock reversal.

- [ ] **Step 2: Run the authority test and verify RED**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test scripts/release/test/duplicate-draft-consolidation-authority.test.mjs
```

Expected: FAIL because the authority module does not exist.

- [ ] **Step 3: Implement staged authority capture**

Export:

```js
export async function captureNpmInventory(input)
export async function captureConsolidationAuthority(input)
export function assertFreshWriterAuthority(authority, proposal, now)
```

`captureConsolidationAuthority` must perform all broad reads first, then direct
GET of the target, then complete target asset enumeration. Store operation
start/completion timestamps and the canonical direct-evidence digest in
`targetRead`. Return with a sealed `networkEpoch`; the orchestrator consumes it
exactly once when persisting intent and invalidates it if any adapter read occurs
in between. Require the pre-delete npm inventory to be at most two minutes old.

- [ ] **Step 4: Run focused tests and commit**

Run the authority test; expected PASS.

Commit:

```bash
git add scripts/release/duplicate-draft-consolidation-authority.mjs scripts/release/test/duplicate-draft-consolidation-authority.test.mjs
git commit -m "feat(release): bind fresh consolidation authority"
```

### Task 6: Implement the hash-chained journal and resume state machine

**Files:**
- Create: `scripts/release/duplicate-draft-consolidation-journal.mjs`
- Test: `scripts/release/test/duplicate-draft-consolidation-journal.test.mjs`

- [ ] **Step 1: Write failing transition tests**

Cover every event type and legal sequence from the design. Explicitly test:

- previous-event digest, sequence, truncation, reordering, and mutation checks;
- fixed target order and no second-target event before first absence convergence;
- write-ahead intent before each DELETE;
- confirmed 204 then absence convergence;
- timeout/404 then absence convergence;
- intent with no outcome + present unchanged -> new attempt;
- recorded ambiguous outcome + six reads present unchanged -> new attempt;
- absent after unrecorded request -> `absent-ambiguous` + convergence;
- target change/publish/malformed -> stop;
- present after confirmed 204 -> stop;
- three-attempt cap;
- main SHA drift -> stop and preserve the journal;
- final authority only after both targets converge absent.

- [ ] **Step 2: Run the journal test and verify RED**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test scripts/release/test/duplicate-draft-consolidation-journal.test.mjs
```

Expected: FAIL because the journal module does not exist.

- [ ] **Step 3: Implement journal derivation and append operations**

Export:

```js
export function createConsolidationJournal(input)
export function parseConsolidationJournal(envelope)
export function deriveConsolidationState(journal)
export function appendJournalEvent(journal, type, payload, recordedAt)
export function nextResumeAction(state, liveTarget)
export function createFinalConsolidationReceipt(input)
```

Never mutate an existing event. Every append creates a new journal envelope and
is durably replaced through `writePrivateEnvelope`. Derive current state only by
replaying the exact event chain. `nextResumeAction` returns one of
`refresh-and-retry`, `reconcile-absence`, `complete`, or `stop`; it never calls a
writer.

- [ ] **Step 4: Run focused tests and commit**

Run the journal test; expected PASS.

Commit:

```bash
git add scripts/release/duplicate-draft-consolidation-journal.mjs scripts/release/test/duplicate-draft-consolidation-journal.test.mjs
git commit -m "feat(release): journal draft consolidation"
```

### Task 7: Implement read-only `inspect` and its CLI contract

**Files:**
- Create: `scripts/release/duplicate-draft-consolidation.mjs`
- Create: `scripts/release/duplicate-draft-consolidation-cli.mjs`
- Test: `scripts/release/test/duplicate-draft-consolidation.test.mjs`
- Test: `scripts/release/test/duplicate-draft-consolidation-cli.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing inspect tests**

Use injected adapters and a fake clock/waiter. Assert `inspect`:

1. validates exact candidate and ID roles;
2. captures `inspect-initial` npm absence;
3. hydrates and verifies all 135 asset instances during the observation gap;
4. waits only the remainder required to reach 60 seconds;
5. captures `inspect-ready` npm absence and final authority metadata;
6. writes one canonical private proposed envelope;
7. returns/prints only its digest and safe summary;
8. makes zero writer calls.

Reject every unknown/duplicate/missing flag and output path outside
`.dawn/release/`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test scripts/release/test/duplicate-draft-consolidation.test.mjs scripts/release/test/duplicate-draft-consolidation-cli.test.mjs
```

Expected: FAIL because inspect/CLI exports do not exist.

- [ ] **Step 3: Implement `inspect` and strict argument parsing**

Export:

```js
export async function inspectDuplicateDrafts(input, dependencies)
export async function runDuplicateDraftConsolidationCli(options)
```

Add this package script:

```json
"release:consolidate-drafts": "node scripts/release/duplicate-draft-consolidation-cli.mjs"
```

The exact production command is:

```bash
pnpm release:consolidate-drafts inspect \
  --version 0.8.22 \
  --commit-sha 2a80deece2ff958fe7fde8fddeb4f99bed70a1c8 \
  --survivor 379991871 \
  --duplicates 379982100,379986168 \
  --output .dawn/release/duplicate-draft-consolidation.proposed.json
```

CLI exit codes are 0 success, 2 invalid invocation, and 1 failed evidence or
authority. Error output is one redacted line and never includes tokens, bodies,
asset bytes, or raw remote diagnostics.

- [ ] **Step 4: Run focused tests and commit**

Run both tests; expected PASS.

Commit:

```bash
git add package.json scripts/release/duplicate-draft-consolidation.mjs scripts/release/duplicate-draft-consolidation-cli.mjs scripts/release/test/duplicate-draft-consolidation.test.mjs scripts/release/test/duplicate-draft-consolidation-cli.test.mjs
git commit -m "feat(release): inspect duplicate drafts"
```

### Task 8: Implement one-target deletion, convergence, and retry

**Files:**
- Modify: `scripts/release/duplicate-draft-consolidation.mjs`
- Modify: `scripts/release/test/duplicate-draft-consolidation.test.mjs`

- [ ] **Step 1: Write failing mutation-kernel tests**

For one target, assert exact call order:

```text
fresh authority
direct target GET
complete target asset list
durable authority event
durable intent event
DELETE
durable outcome event (when observable)
bounded direct-GET/list convergence
durable convergence or retry event
```

Inject process loss after every durable boundary and before/after DELETE. Cover
204, 404, transport timeout, absent on resume, present unchanged on resume,
recorded ambiguity remaining present for the full window, reader disagreement,
rate limit/server error, and exhausted third attempt. Assert no survivor ID can
reach the writer under any state corruption.

- [ ] **Step 2: Run the mutation test and verify RED**

Run the focused orchestration test. Expected: FAIL because `performOneDeletion`
does not exist.

- [ ] **Step 3: Implement the minimal mutation kernel**

Add an internal/export-for-test function:

```js
export async function performOneDuplicateDeletion(input, dependencies)
```

Use six complete read attempts under one 90-second wall-clock ceiling, give each
request the exact remaining timeout, and bound every backoff by its policy,
30 seconds, and the remaining shared budget. Retry DELETE only for an
ambiguous/unrecorded outcome whose target remains present and semantically
unchanged through the bounded window. Before recording the retry transition,
perform a completely fresh full authority capture, persist its actual current
45-asset target evidence, then append that same authority and consume its epoch
without intervening network. Any included Release or asset drift, clock
reversal, 403/429/5xx/timeout, or pagination failure stops rather than being
treated as absence.

- [ ] **Step 4: Run focused tests and commit**

Run the orchestration and journal tests; expected PASS.

Commit:

```bash
git add scripts/release/duplicate-draft-consolidation.mjs scripts/release/test/duplicate-draft-consolidation.test.mjs
git commit -m "feat(release): delete exact duplicate drafts"
```

### Task 9: Complete two-target `perform` and final receipt materialization

**Files:**
- Modify: `scripts/release/duplicate-draft-consolidation.mjs`
- Modify: `scripts/release/duplicate-draft-consolidation-cli.mjs`
- Modify: `scripts/release/test/duplicate-draft-consolidation.test.mjs`
- Modify: `scripts/release/test/duplicate-draft-consolidation-cli.test.mjs`

- [ ] **Step 1: Write failing end-to-end perform tests**

Assert `perform`:

- safely reads and verifies the reviewed proposed envelope;
- requires the exact confirmation containing its digest;
- requires clean merged `main` before the first writer and the same main SHA
  before the second writer/finalization;
- appends `operation-started` and `perform-initial` evidence;
- repeats the 60-second npm/payload proof before target one;
- completes target one before any target-two authority event;
- captures fresh `pre-delete-2` authority before target two;
- records all six minimum npm stages plus retry stages;
- captures final one-survivor authority and npm E404;
- writes a complete tracked receipt only after final verification;
- never writes or mutates the survivor.

Add failures for incorrect proposal digest, altered confirmation, main advance
after the first deletion, publication between deletions, changed survivor,
unexpected fourth draft, and receipt write failure after both deletions. The last
case must resume by rematerializing the same receipt without another DELETE.

- [ ] **Step 2: Run focused tests and verify RED**

Run the focused orchestration and CLI tests. Expected: FAIL because `perform`
is not wired.

- [ ] **Step 3: Implement `perform` and CLI mode**

Export:

```js
export async function performDuplicateDraftConsolidation(input, dependencies)
```

The exact production shape is:

```bash
pnpm release:consolidate-drafts perform \
  --proposal .dawn/release/duplicate-draft-consolidation.proposed.json \
  --journal .dawn/release/duplicate-draft-consolidation.journal.json \
  --receipt scripts/release/duplicate-draft-consolidation.json \
  --confirmation "CONSOLIDATE v0.8.22 2a80deece2ff958fe7fde8fddeb4f99bed70a1c8 SURVIVOR 379991871 DELETE 379982100,379986168 PROPOSAL <actual-digest>"
```

There is no force, alternate survivor, reordered IDs, delete-all, SHA override,
or workflow mode.

- [ ] **Step 4: Run focused tests and commit**

Run schema, files, evidence, authority, journal, orchestration, and CLI tests;
expected PASS.

Commit:

```bash
git add scripts/release/duplicate-draft-consolidation.mjs scripts/release/duplicate-draft-consolidation-cli.mjs scripts/release/test/duplicate-draft-consolidation.test.mjs scripts/release/test/duplicate-draft-consolidation-cli.test.mjs
git commit -m "feat(release): perform draft consolidation"
```

### Task 10: Implement independent `verify`

**Files:**
- Modify: `scripts/release/duplicate-draft-consolidation.mjs`
- Modify: `scripts/release/duplicate-draft-consolidation-cli.mjs`
- Modify: `scripts/release/test/duplicate-draft-consolidation.test.mjs`
- Modify: `scripts/release/test/duplicate-draft-consolidation-cli.test.mjs`

- [ ] **Step 1: Write failing verify tests**

Verify must safely read a normal `0644` tracked receipt, parse both embedded
envelopes, replay the event hash chain, prove both deleted IDs absent by direct
GET and complete list, re-download and verify the survivor's 45 assets, and
recheck main/workflow/runs/tag/final npm absence. Tamper every receipt layer and
assert rejection.

Also assert the report says historical duplicate payload parity is supported by
the embedded pre-delete evidence plus current survivor, not independently
re-downloaded deleted bytes.

- [ ] **Step 2: Run verify tests and verify RED**

Expected: FAIL because verify mode is not implemented.

- [ ] **Step 3: Implement verify and CLI mode**

Export:

```js
export async function verifyDuplicateDraftConsolidation(input, dependencies)
```

Production command:

```bash
pnpm release:consolidate-drafts verify \
  --receipt scripts/release/duplicate-draft-consolidation.json
```

The receipt file is absent from the implementation PR and is created only by a
successful live operation.

- [ ] **Step 4: Run focused tests and commit**

Run focused tests; expected PASS.

Commit:

```bash
git add scripts/release/duplicate-draft-consolidation.mjs scripts/release/duplicate-draft-consolidation-cli.mjs scripts/release/test/duplicate-draft-consolidation.test.mjs scripts/release/test/duplicate-draft-consolidation-cli.test.mjs
git commit -m "feat(release): verify draft consolidation"
```

### Task 11: Add full rehearsal and prove workflow isolation

**Files:**
- Create: `scripts/release/test/duplicate-draft-consolidation-rehearsal.test.mjs`
- Modify: `scripts/release/test/workflow-contracts.test.mjs`

- [ ] **Step 1: Write the realistic rehearsal**

Run `inspect -> perform -> verify` against the realistic three-draft fake with
distinct IDs and equal bytes. Rehearse clean completion and process loss at:

- before first intent;
- after first intent but before DELETE;
- after server deletion but before response;
- after first convergence;
- after second intent;
- after second deletion but before receipt;
- after receipt write but before CLI success output.

Assert every legal resume reaches exactly one unchanged survivor and exactly two
DELETE effects total unless a bounded retry is intentionally injected.

- [ ] **Step 2: Write workflow-isolation assertions**

Read all workflow sources and assert none contains
`duplicate-draft-consolidation`, `release:consolidate-drafts`, or a Release
DELETE endpoint. Re-run the existing release-controller reachability/hash tests
and assert `release-script-hashes.json` is unchanged.

- [ ] **Step 3: Run rehearsal and verify RED/GREEN**

Run:

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test scripts/release/test/duplicate-draft-consolidation.test.mjs scripts/release/test/duplicate-draft-consolidation-*.test.mjs scripts/release/test/workflow-contracts.test.mjs
```

Expected before completing fixtures: FAIL. Complete only fixture/harness code,
then rerun; expected PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/release/test/duplicate-draft-consolidation-rehearsal.test.mjs scripts/release/test/workflow-contracts.test.mjs
git commit -m "test(release): rehearse draft consolidation"
```

### Task 12: Run integration gates and independent review

**Files:**
- Modify only files required by concrete test/review findings.

- [ ] **Step 1: Run scoped format/lint without broad writes**

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm exec biome check --config-path packages/config-biome/biome.json package.json scripts/release/duplicate-draft-consolidation*.mjs scripts/release/test/duplicate-draft-consolidation*.test.mjs scripts/release/test/support/duplicate-draft-consolidation-fixture.mjs scripts/release/test/workflow-contracts.test.mjs
```

Expected: PASS. If formatting is required, scope `--write` to only these files.

- [ ] **Step 2: Run focused and full release-controller tests**

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node --test scripts/release/test/duplicate-draft-consolidation.test.mjs scripts/release/test/duplicate-draft-consolidation-*.test.mjs
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH pnpm test:release-controller
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH node scripts/check-docs.mjs
git diff --check
```

Expected: all PASS; controller-schema digest and release-path script hashes
remain unchanged.

- [ ] **Step 3: Run the repository Definition of Done**

```bash
PATH=/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH DAWN_REQUIRE_DOCKER=1 pnpm ci:validate
```

Expected: PASS through lint, build, typecheck, tests, release inventory,
release-controller, docs, pack checks, TypeScript tooling, and all harness lanes.

- [ ] **Step 4: Request technical review**

Use `superpowers:requesting-code-review`. Review must check the exact head,
destructive boundary, event/journal state machine, safe files, immediate direct
read, retry cap, receipt limits, and workflow isolation. Also request the user's
GitHub review assistant on the PR, as previously agreed.

- [ ] **Step 5: Address findings with `superpowers:receiving-code-review`**

Reproduce every actionable finding with a failing test before changing code.
Rerun Steps 1–3 after the final fix.

- [ ] **Step 6: Commit integration fixes**

Use a factual commit message describing the concrete fix. The worktree must be
clean and the implementation PR must not contain the live receipt.

### Task 13: Merge the focused prerequisite and run read-only `inspect`

**Files:**
- Live local only: `.dawn/release/duplicate-draft-consolidation.proposed.json`

- [ ] **Step 1: Merge only after exact-head checks pass**

Release remains `disabled_manually`. Verify the PR changes only the focused
modules/tests/docs/package script, then merge. Pull the exact merged `main` into
the primary repository checkout and verify local HEAD, `origin/main`, and GitHub
main match.

- [ ] **Step 2: Refresh read-only live state**

Using `gh` and npm CLI reads, require the exact three approved drafts, 45 assets
each, annotated tag target, disabled Release workflow, no nonterminal Release
run, and npm E404 for all 21 packages. Stop on any drift.

- [ ] **Step 3: Run `inspect` from exact merged main**

Run the exact inspect command from Task 7. Review the canonical proposal and its
printed digest. No GitHub writer is invoked in this task.

- [ ] **Step 4: Independently verify the proposed envelope**

Run the focused schema/evidence verifier against the file, confirm survivor and
ordered duplicate IDs, then retain the private `0600` file for `perform`.

### Task 14: Freeze main, perform the live consolidation, and verify

**Files:**
- Live local: `.dawn/release/duplicate-draft-consolidation.journal.json`
- Create after success: `scripts/release/duplicate-draft-consolidation.json`

- [ ] **Step 1: Begin the main-change freeze**

Do not merge or push `main` until the receipt is durable. Recheck exact merged
main, clean checkout, Release disabled, zero active runs, tag identity, all npm
E404s, and the three-draft proposal. Stop if any check differs.

- [ ] **Step 2: Run `perform` with the exact proposal digest**

Substitute the actual digest into the Task 9 confirmation and run the command.
Do not retry manually after an ambiguous result; resume only through the same
CLI and journal.

- [ ] **Step 3: Run independent `verify`**

Run Task 10's verify command plus independent read-only `gh`/npm CLI checks.
Require only survivor `379991871`, both deleted IDs 404/list-absent, unchanged
45 survivor assets, unchanged tag, disabled Release, zero active runs, and all
npm versions absent.

- [ ] **Step 4: End the main-change freeze**

End it only after the final receipt is canonical and verify passes. If main
moved during the window, preserve proposal/journal and stop for the reviewed
successor-controller migration; do not use an override.

### Task 15: Publish the receipt and resume the release program

**Files:**
- Add: `scripts/release/duplicate-draft-consolidation.json`
- Modify only if required: release runbook blocker/status text.

- [ ] **Step 1: Create a focused receipt branch from the verified checkout**

Commit only the canonical receipt and accurate runbook status. Do not include
`.dawn` private files or asset payloads.

- [ ] **Step 2: Re-run receipt and release-integrity verification**

Run verify, focused tests, full release-controller tests, docs check, and
`git diff --check`. Request review and merge the receipt follow-up.

- [ ] **Step 3: Rebase the larger abandonment branch**

Rebase `blove/single-owner-release-abandonment` on the new `main`, resolve only
real overlaps, and rerun its Task 12 integration/Definition-of-Done gate.

- [ ] **Step 4: Resume the approved release sequence**

Continue trusted-publisher cutover, abandon v0.8.22, cut v0.8.23 with
provenance, run the full smoke tests including the real Vercel deployment lane,
and verify production. No compatibility shim, dependency override, Vercel CLI
removal, or CI-lane removal is part of this plan.
