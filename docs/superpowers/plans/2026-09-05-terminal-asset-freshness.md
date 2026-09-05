# Terminal Asset Freshness Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline with independent review.

**Goal:** Preserve the explicit fresh terminal abandonment asset boundary.

**Architecture:** Classification may reuse its observation; final verification uses the original reader.

**Tech Stack:** Node node:test, release controller source and content pins.

- [x] Add stable/changed/deleted/unavailable second-read regressions in candidate.test.mjs and run red.
- [x] Pass originalGithub at the existing inspectAbandonmentRelease call in candidate.mjs. Keep all validation assertions unchanged.
- [x] Refresh affected executable/policy/manifest pins atomically; run candidate, preflight and workflow suites green.
- [ ] Obtain independent review; run required CI; integrate only after the tested tree and prerequisite PRs are verified.
