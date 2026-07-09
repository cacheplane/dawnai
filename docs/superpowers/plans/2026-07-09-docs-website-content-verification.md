# Docs Website Content Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify Dawn's docs, website copy, package READMEs, examples, generated docs, and chart docs against the current main branch, then fill accuracy gaps and improve conceptual clarity without drifting from implemented behavior.

**Architecture:** Treat source code, package manifests, generated type declarations, release commits, smoke-test evidence, examples, and existing validation scripts as the source of truth. Update public content in small reviewable slices, and harden docs validation so future package additions and endpoint additions are harder to miss.

**Tech Stack:** Markdown/MDX docs, Next.js website content, package README files, generated CLI docs, Helm chart docs, `rg`, `find`, `node scripts/check-docs.mjs`, pnpm workspace validation.

**Baseline:** `main` at `e9ed1e39` (`chore(deps-dev): bump Node type definitions`) on 2026-07-09.

---

## Current Assessment

The 2026-07-06 docs alignment pass fixed the old scaffold/API drift, and the current core docs are generally strong for routes, CLI, memory, sandbox, testing, evals, and configuration. Since then, main added or shipped several user-facing surfaces that need a fresh docs pass:

- `@dawn-ai/memory-pgvector` shipped and was manually smoke-tested from the real npm registry against real Postgres + pgvector and real OpenAI embeddings.
- `@dawn-ai/ag-ui` shipped, and the chat example now includes a CopilotKit web client over Dawn's `POST /agui/{routeId}` endpoint.
- Kubernetes sandbox and app Helm charts landed.
- Packages are now at `0.8.11`, while some chart metadata still carries `appVersion: "0.8.9"`.

Important strengths to preserve:

- `apps/web/content/docs/memory.mdx` already explains keyword recall, semantic/hybrid recall, pgvector, `openaiEmbedder()`, 1536-dim defaults, HNSW, `vector` versus `halfvec`, and the 4000-dim ceiling.
- `README.md` and `packages/create-dawn-app/README.md` now describe the research scaffold rather than the old default greeter scaffold.
- `apps/web/content/docs/sandbox.mdx` is detailed and honest about Docker, Kubernetes, Helm, network policy, and security scope.
- `apps/web/content/docs/api.mdx` now covers `@dawn-ai/core`, `@dawn-ai/testing`, and `@dawn-ai/evals`, which were prior gaps.

Highest-value gaps found in this assessment:

- `packages/memory-pgvector/README.md` is missing, even though the package is public and its npm homepage points at `packages/memory-pgvector#readme`.
- `packages/ag-ui/README.md` is missing, and `@dawn-ai/ag-ui` is not covered in the API reference.
- `apps/web/content/docs/dev-server.mdx` documents the Agent Protocol endpoints but does not appear to document the new `POST /agui/{routeId}` endpoint.
- `@dawn-ai/langchain` README does not mention `openaiEmbedder()`, the embedding dims, `OPENAI_BASE_URL`, or why `encodingFormat: "float"` matters.
- The current docs checker catches topology, stale banned phrases, and CLI command drift, but it does not require package READMEs for public packages, API docs for new public exports, or docs coverage for new dev-server endpoints.
- Website/landing content is still mostly framework-positioning copy; AG-UI/CopilotKit and production memory storage are under-discoverable outside examples/changelogs.

---

## Task 1: Build The Verification Matrix

- [x] Re-run a focused inventory:

```bash
git status --short
git log --oneline --decorate --max-count=40
find packages -maxdepth 2 -name package.json -print | sort
find packages -maxdepth 2 -name README.md -print | sort
find apps/web/content/docs -maxdepth 2 -type f -name '*.mdx' -print | sort
```

- [x] Compare public package exports against docs coverage:

```bash
rg -n "^export " packages/*/src packages/create-dawn-app/src --glob '*.ts'
rg -n "@dawn-ai/ag-ui|@dawn-ai/memory-pgvector|openaiEmbedder|pgvectorMemoryStore|POST /agui|CopilotKit" README.md apps/web docs examples packages --glob '!**/dist/**'
```

- [x] Record findings in a short audit appendix or in the PR description, including the specific source-of-truth files for each claim.

## Task 2: Fix P1 Discoverability And Accuracy

- [x] Add `packages/memory-pgvector/README.md` with install, exact `pgvectorMemoryStore()` options, `put/search/get/update/delete/listCandidates/close` behavior, dimensions and `halfvec` limits, Postgres requirements, pooling/cleanup, and a real-smoke summary.
- [x] Add `packages/ag-ui/README.md` with exported helpers, `POST /agui/{routeId}`, route id mapping, CopilotKit `HttpAgent` usage, interrupt/resume behavior, and limitations.
- [x] Update `apps/web/content/docs/dev-server.mdx` to document the AG-UI endpoint as additive to Agent Protocol endpoints.
- [x] Update `apps/web/content/docs/api.mdx` with `@dawn-ai/ag-ui` and `@dawn-ai/memory-pgvector` public exports.
- [x] Update `packages/langchain/README.md` to include `openaiEmbedder()`, default `text-embedding-3-small`/1536 dims, `OPENAI_BASE_URL`, and the float encoding contract.

## Task 3: Improve Concepts And Navigation

- [x] Add a concise AG-UI/CopilotKit docs section or page and link it from Dev Server, FAQ, examples, and the docs nav if it becomes a standalone page.
- [x] Tighten the memory page's "when to use SQLite vs pgvector" decision guidance without duplicating the package README.
- [x] Add a "published package smoke" note to memory docs or package docs that distinguishes workspace CI from real registry + real service smoke tests.
- [x] Re-check website landing sections and FAQ for underplayed shipped features: AG-UI, semantic recall, pgvector, Kubernetes sandbox, Helm deployment.
- [x] Review chart docs and metadata, especially `charts/*/Chart.yaml` `appVersion`, for stale release-version claims.

## Task 4: Harden Docs Validation

- [x] Extend `scripts/check-docs.mjs` to fail when a public package lacks a README unless explicitly allowlisted.
- [x] Add a lightweight public-export coverage check for new packages, at least requiring a mention in `apps/web/content/docs/api.mdx` or a package README.
- [x] Add a dev-server endpoint coverage check so route additions like `/agui/:routeId` cannot land without docs.
- [x] Add targeted forbidden/stale phrase checks for "pgvector planned follow-up" outside historical changelogs and for stale chart app versions if appropriate.

## Task 5: Verify

- [x] Run targeted docs checks:

```bash
pnpm build
node scripts/check-docs.mjs
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web build
```

- [x] Run package-specific validation for touched packages:

```bash
pnpm --filter @dawn-ai/ag-ui typecheck
pnpm --filter @dawn-ai/memory-pgvector typecheck
pnpm --filter @dawn-ai/langchain typecheck
```

- [x] If docs include runnable smoke commands, test the no-key paths locally. Do not put `OPENAI_API_KEY` in files.

No new standalone no-key smoke script was added; the runnable docs changes are documentation/config snippets. Verification used docs checks, package typechecks, web build, and full workspace build.

## Task 6: PR Strategy

- [x] Prefer one docs PR if the edit stays focused; split validation-script hardening into a second PR if it grows beyond straightforward checks.
- [x] In the PR body, include before/after coverage evidence: missing README count, new API sections, AG-UI endpoint docs, and commands run.
- [ ] Merge on green after `ci:validate` or the equivalent GitHub checks pass.
