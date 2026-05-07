# Dawn Docs Audit — 2026-05-06

**Status:** in progress
**Spec:** `docs/superpowers/specs/2026-05-06-docs-review-design.md`
**Plan:** `docs/superpowers/plans/2026-05-06-docs-review.md`

## Findings format

Each finding uses this schema:

```markdown
### F-NNN: <one-line summary>
- **Surface:** <surface>
- **File:** <path:line if applicable>
- **Type:** gap | misalignment | error | broken-example
- **Severity:** critical | important | minor
- **Description:** <what's wrong>
- **Suggested fix:** <concrete change, or "needs design">
```

Findings are numbered globally across all sections (F-001, F-002, ...). Each subagent claims a contiguous range and announces it in its closing summary so the next subagent picks up from F-(N+1).

## 1. Root README (`README.md`)

_(pending — Task 2)_

## 2. Website load-bearing pages (`getting-started.mdx`, `routes.mdx`, `tools.mdx`, `deployment.mdx`)

_(pending — Task 3)_

## 3. Website supporting pages (`state.mdx`, `cli.mdx`, `dev-server.mdx`, `testing.mdx`)

_(pending — Task 4)_

## 4. Templates (`AGENTS.md`, `CLAUDE.md`)

_(pending — Task 5)_

## 5. Public package READMEs (`@dawn-ai/sdk`, `@dawn-ai/cli`, `create-dawn-ai-app`)

_(pending — Task 6)_

## 6. Internal package READMEs (config-biome, config-typescript, core, devkit, langchain, langgraph, vite-plugin)

_(pending — Task 7)_

## Summary

_(pending — populated at the findings cut after Tasks 2–7)_
