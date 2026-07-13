# Research workspace memory

Dawn injects this file into the agent's system prompt every turn. Use it for
durable research conventions; the agent updates it with
`writeFile({ path: "AGENTS.md", content: "..." })` when it learns something
worth keeping across sessions.

## House style

- Cite every factual claim with its source path in square brackets, e.g.
  `[corpus/agent-architectures.md]`.
- Prefer the bundled corpus. Only request an external fetch when the corpus
  lacks coverage — and expect the human to approve it.
- Write the final report to `reports/<slug>.md` in the workspace.
- Keep reports skimmable: a two-sentence answer first, then cited supporting
  points, then a short Sources list.
