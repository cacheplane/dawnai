# Smoke gate adjudication

How to close out a candidate whose packages published correctly but whose own
smoke lanes cannot pass.

## When this applies

All of the following must be true. If any is false, do not adjudicate.

1. The candidate's packages are published and correct, with npm provenance that
   verifies against the candidate commit.
2. One or more required smoke lanes fail **deterministically**, and the cause is
   a defect in the candidate's own smoke scripts rather than evidence about the
   published packages.
3. The defect cannot be fixed in place. Every release job except `detect` checks
   out `candidate_sha`, so a fix merged to main reaches only the *next*
   candidate.
4. The tag cannot be moved, because `validateExactPublishedPackageEvidence`
   rejects a candidate whose commit disagrees with the published provenance.

If the packages did not publish, this is not the tool. A pre-publication
candidate is abandoned instead (`ABANDONED_PREPUBLICATION`).

## Why an adjudication is needed at all

The controller selects the oldest **incomplete** candidate, and only
`NO_CANDIDATE`, `SUPERSEDED_NOOP`, `AUDIT_COMPLETE` and
`ABANDONED_PREPUBLICATION` are terminal. A published candidate stuck at the
smoke gate is therefore re-selected forever, and no later version can be
released. Cutting a newer version does **not** supersede it.

## What the record does and does not do

- It records that an operator reviewed the lane outcomes and adjudicated the
  **smoke gate only**, for one exactly-named candidate.
- It never asserts that the lanes passed. Each lane carries its real outcome
  (`passed`, `failed`, `flaked`) and the reason.
- The **audit gate stays live**. Adjudication moves the candidate to
  `SMOKES_COMPLETE`; the release audit still has to run and verify.
- It only advances a candidate whose packages actually published
  (`evidence.npm.complete`).

## Writing one

Create `scripts/release/smoke-adjudications/v<version>.json`. Every field is
required, and the record is rejected outright if anything is unexpected.

- `version`, `commitSha`, `manifestSha256` — the exact candidate. All three must
  match the observed candidate or the record does nothing.
- `adjudicatedLanes` — every required lane, with its true outcome and a detail
  explaining it. Missing or extra lanes void the record, so a lane added later
  is never silently waived.
- `authority` — `mode` is always `operator-adjudication`; record the operator and
  the commit whose evidence was reviewed.
- `remediation` — the commit that fixes the defect, and what it changed.
- `reason` — why this candidate cannot finish without adjudication.

Then re-run the release. `detect` reads the record from the controller ref,
`smokeAdjudicationApplies` binds it to the candidate, and the state advances.

## Failure modes it is built to refuse

A record that is absent, unreadable, malformed, filed under the wrong version,
carrying unknown fields, or naming a different version, commit, manifest or lane
set has **no effect**. Every one of these leaves the smoke gate shut. This is
deliberate: the failure mode of an adjudication must be "the release stays
stuck", never "the gate opens wider than intended".

## Pin coverage

The controller state machine this relies on — `observe.mjs`, `evidence.mjs`,
`state.mjs`, `observation-schema.mjs` and `smoke-adjudication.mjs` — is content
pinned, so a change to the adjudication path fails
`pnpm test:release-controller` until the reviewed fixture is regenerated in the
same commit. That coverage came from the import-closure pinning added alongside
this mechanism; before it, only scripts named directly on workflow command lines
were pinned, and this module would not have been.

The adjudication **records** are not pinned by that gate, because they are data
rather than executed code. A record is instead constrained by its own schema and
by exact binding to one candidate: the strongest review point is the pull request
that adds the record.

## History

First used for v0.8.24 (2026-09-04). Its `storage` and `runtime-targets` lanes
carried defects fixed on main in `2689ef8d`, which could not reach the frozen
candidate `88c01c4a`. All 21 packages had already published correctly.
