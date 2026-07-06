# Docs and Website Main-Branch Alignment Audit

Date: 2026-07-06
Baseline: `origin/main`
Baseline commit: `22ebc85d` (`Version Packages (#295)`)
Spec: `docs/superpowers/specs/2026-07-06-docs-website-main-alignment-audit-design.md`
Plan: `docs/superpowers/plans/2026-07-06-docs-website-main-alignment.md`

## Executive Summary

This section is populated in Task 5 after the evidence matrix, findings, and
implementation order are known.

## Scope

This audit covers Dawn's full external developer surface against `origin/main`:
public docs, website narrative, README/package docs, examples, scaffold output,
npm-facing metadata, and generated docs/LLM surfaces.

## Evidence Matrix

| Surface area | Current code fact | Source reference | Expected external surfaces | Observed external surfaces | Status | Finding ID | Notes |
|---|---|---|---|---|---|---|---|

## Findings

### P0: Broken or harmful

### P1: Misleading or adoption-blocking

### P2: Missing depth or reference coverage

### P3: Narrative, IA, or polish opportunity

## Intentionally Excluded

| Area | Reason | Revisit trigger |
|---|---|---|

## Stale-Term Sweeps

| Sweep | Command | Result | Follow-up finding IDs |
|---|---|---|---|

## Verification Notes

| Check | Command | Result | Notes |
|---|---|---|---|
| Baseline fetch | `git fetch origin main && git log --oneline --decorate -1 origin/main` | `22ebc85d (origin/main, origin/HEAD) Version Packages (#295)` | Fetch output: `From github.com:cacheplane/dawnai`; `* branch main -> FETCH_HEAD`. |
| Baseline ancestry | `git merge-base --is-ancestor origin/main HEAD` | Passed; `origin/main is included in HEAD` | Verified after rebasing audit branch onto current `origin/main`. |
| Non-audit diff | `git diff --name-only origin/main -- ...` | No output | No non-audit source paths differ from `origin/main`. |

## Findings-Driven Implementation Batches

These batches are mirrored into the plan after the audit is complete.
