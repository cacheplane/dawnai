# Recovery release inventory budget implementation plan

> For agentic workers: use superpowers:executing-plans for this bounded correction.

**Goal:** Make both recovery routing inventory paths accept the same complete bounded release history.

**Architecture:** Reuse the existing 16 MiB allowance specifically for release inventory reads. Preserve all unrelated snapshot and authority limits.

**Tech Stack:** Node.js ESM, node:test, GitHub Actions.

- [x] Review the bounded design.
- [x] Add production-sized routing regression and safety controls to `scripts/release/test/recovery-routing.test.mjs`; demonstrate the successful path fails before the fix.
- [x] Name and apply the shared release inventory allowance in `scripts/release/recovery/observe.mjs`.
- [ ] Refresh the dormant policy's verifier closure digest, affected transitive release content pins and their manifest baseline, run focused tests and repository checks, and obtain independent review.
- [ ] Reproduce production discovery read-only and open a separate PR; complete required CI before merge.
- [ ] Verify post-merge observation and preserve activation blockers separately.
