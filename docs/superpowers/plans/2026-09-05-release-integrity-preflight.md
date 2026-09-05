# Release Integrity Preflight Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement inline with independent review.

**Goal:** Detect release contract and pin failures before expensive validation while preserving full coverage.

**Architecture:** Reuse release-integrity.test.mjs and recovery-policy.test.mjs through one pnpm script, called early by CI and local validation.

**Tech Stack:** Node 24 node:test, pnpm 10.33.0, GitHub Actions YAML.

- [x] Add regression assertions in new `scripts/release/test/release-integrity.test.mjs` for unconditional early CI/local execution and unchanged full controller coverage; run red.
- [x] Add `test:release-integrity` in `package.json`; prepend it to `ci:validate`; insert the CI step after Install in `.github/workflows/ci.yml`.
- [x] Update the exact CI validate-step descriptor in `scripts/release/test/fixtures/workflow-entrypoints.json` and safe executable entry in `workflow-safe-executables.json`; shift only subsequent validate step indexes. Preserve all other entries and authority classifications.
- [x] Run `pnpm test:release-integrity` green and measure duration. Prove a stale content pin fails in an owned temporary source-only fixture, with no package dist outputs.
- [x] Update `AGENTS.md` and `CONTRIBUTORS.md` validation guidance to reflect the additive preflight.
- [ ] Run lint, inventory, docs and full controller checks; independently review the diff; commit and create a PR. Let CI verify all repository gates and integrate only after required checks succeed.
