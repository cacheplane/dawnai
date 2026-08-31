# Npm Exact-Version Absence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the release controller prove an unpublished npm version absent without trusting a fragile error-body shape.

**Architecture:** Keep the exact-version request as the first observation. On HTTP 404, confirm absence through a second bounded install-v1 packument read whose package and version-map identities are validated before emitting the existing canonical `E404` absence envelope.

**Tech Stack:** Node.js 24.19.0, Node test runner, npm registry HTTP adapter, pnpm 10.33.0.

---

### Task 1: Reproduce the production response

**Files:**
- Modify: `scripts/release/test/npm-adapter.test.mjs`

- [x] Add a test whose exact-version response is HTTP 404 with a JSON string,
      followed by a valid install-v1 packument that omits the requested version.
- [x] Require two exact requests and the canonical `ABSENT`/404/`E404` envelope.
- [x] Run `node --test scripts/release/test/npm-adapter.test.mjs` and confirm the
      new test fails because the current adapter returns `AMBIGUOUS` after one read.

### Task 2: Implement the two-read proof

**Files:**
- Modify: `scripts/release/adapters/npm.mjs`
- Modify: `scripts/release/test/npm-adapter.test.mjs`

- [x] Route every exact-version HTTP 404 through a bounded package-metadata read.
- [x] Validate the exact package identity and complete `versions` mapping.
- [x] Return canonical absence only when the requested version key is absent.
- [x] Add fail-closed tests for malformed metadata, package-level 404, and a
      packument that conflicts by containing the requested version.
- [x] Run the npm adapter test file and confirm all cases pass.

### Task 3: Verify and deliver the controller fix

**Files:**
- Modify the adapter, its unit and integration tests, the release rehearsal, the
  audited release-script hash fixture, and these design/plan documents.

- [x] Run focused release adapter, observation, planner, workflow, and controller tests.
- [x] Run `DAWN_REQUIRE_DOCKER=1 pnpm ci:validate`.
- [ ] Commit, push, open a PR, require exact-head CI and Copilot review, then merge
      with a head guard.
- [ ] Dispatch `reconcile` for version `0.8.22` and commit
      `2a80deece2ff958fe7fde8fddeb4f99bed70a1c8`; do not create a replacement
      candidate or publish locally.
