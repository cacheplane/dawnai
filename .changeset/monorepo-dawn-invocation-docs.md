---
---

Docs-only: add a "Running the CLI" note to the CLI reference — always invoke the `dawn` bin (`pnpm exec dawn …`), and in a hoisted monorepo don't point Node at `node_modules/@dawn-ai/cli/dist/index.js` directly (the cli hoists to the workspace root and the path won't resolve). No package changes.
