# Parallel Release Validation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline with independent review.

**Goal:** Overlap controller verification with source verification without losing release gates.

**Architecture:** Separate source and controller jobs, with the stable validate check aggregating their results plus packaging/harness checks.

**Tech Stack:** Node 24, pnpm 10.33.0, GitHub Actions, node:test and YAML parser.

- [x] Extend `scripts/release/test/release-integrity.test.mjs` with lane/wiring assertions and executable aggregate truth-table tests; run red.
- [x] Update `.github/workflows/ci.yml` with source-validate, release-controller and aggregate validate jobs. Retain complete commands; no test exclusions or optional aggregate dependencies.
- [x] Update exact workflow-entrypoints.json and workflow-safe-executables.json fixtures, preserving unrelated descriptors/classifications.
- [x] Update AGENTS.md and CONTRIBUTORS.md with the new CI graph and unchanged local sequential validation.
- [x] Update `test/k8s-compat/ci-scope.test.ts` for the unconditional source/controller lanes and exact aggregate, preserving the four metadata-scoped job assertions. Run its 20 tests red then green.
- [ ] Run focused preflight/workflow tests, lint/inventory/docs, independent review, commit and create stacked PR. CI must prove the complete controller suite works from an unbuilt checkout and all aggregate dependencies succeed.
- [ ] Integrate after prerequisite PR #575 and required CI succeed, comparing final tested tree and recording timing evidence.

### CI-discovered Kubernetes report lifecycle defect

- [x] Diagnose reserved-identity rejection from failed job 101375699505 and artifact 9977015609; trace unlink/close versus persistent dev/inode reservation.
- [x] Add red descriptor-retention, failure cleanup, pending-disposal, hard-link rewrite and harness lifecycle assertions.
- [x] Retain accepted descriptors, implement awaited disposal, wire all harness paths.
- [ ] Run full Kubernetes unit suite/typecheck, integrity preflight, independent review and corrected CI.
