---
"@dawn-ai/devkit": patch
"create-dawn-ai-app": patch
"@dawn-ai/cli": patch
---

Scaffold the Dawn Workbench alongside the agent.

`npm create dawn-ai-app` now generates a two-package npm workspace instead of a
flat server-only app. `server/` holds everything that used to sit at the project
root and runs on port 3002; `web/` is the Dawn Workbench — a Next 16 client with
a thread rail, a streaming transcript, plan and subagent activity cards, tool
cards, permission prompts that survive a reload, a memory-candidate panel, and a
connect screen — on port 3010. One `npm install` at the root installs both, and
the root scripts delegate into the package that owns each job.

The template's web tree mirrors `examples/research/web` under a parity guard that
compares the two trees byte-for-byte, so the shipped scaffold cannot drift from
the example it is dogfooded against.

Two fixes fall out of the restructure. `dawn verify`'s dependency probe now walks
parent `node_modules` directories the way Node itself resolves, so hoisted
workspace dependencies are no longer reported as missing. And the generated web
package ships an ambient CSS declaration, so `npm run typecheck` succeeds on a
freshly scaffolded app rather than only after a build has generated Next's own
type declarations.
