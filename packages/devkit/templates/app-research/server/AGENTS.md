# Dawn App — Coding Agent Instructions

This project uses **Dawn**, the TypeScript meta-framework for LangGraph. Agents
and workflows are file-system routes under `src/app/`.

## Key rules

- A route is a directory with an `index.ts` that exports exactly ONE of:
  `agent` (LLM-driven; default export), `workflow` (deterministic async
  function), `graph` (LangGraph graph), or `chain` (LangChain LCEL Runnable).
- Tools are co-located in a route's `tools/` directory — one default-exported
  async function per file. Their argument types are inferred at build time.
- Optional route state goes in `state.ts` next to the route.
- Never edit `.dawn/dawn.generated.d.ts` — it is generated. Run `dawn typegen`
  if `dawn:routes` types do not resolve.

## Full reference (read this before writing routes)

The complete, version-matched Dawn documentation is bundled with the installed
CLI. Run `dawn docs` to list topics or `dawn docs <topic>` to read one (for
example, `dawn docs tools`). The same files are at
`node_modules/@dawn-ai/cli/docs/` — start with `docs/README.md`.
