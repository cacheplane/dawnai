# Research Starter Integrity Design

**Status:** Approved
**Date:** 2026-08-09
**Baseline:** `72cd7a71` (`main` after PR #431)

## Summary

Make Dawn's default `research` scaffold a trustworthy published product before
promoting the research web UI into it. The dogfooded research server remains the
behavioral source of truth. The devkit template mirrors that behavior through an
exhaustive parity contract, while a new packaged npm lane proves that a default
external scaffold installs, validates, builds, starts, and completes two
deterministic AG-UI journeys.

This slice also makes every generated command mean what its name and onboarding
copy say it means. It adds an environment example, restores the missing deep
research recursion limit, and corrects only the documentation that defines this
starter contract.

The work deliberately does not add the web UI, AG-UI activity mappings,
provider selection, a human-friendly run command, or deployment features.

## Context

The `research` template became the default `create-dawn-ai-app` output in 0.7.0.
It demonstrates planning, subagents, tools, workspace access, permissions,
memory, tests, and evals. The later `examples/research/server` application is the
dogfooded version of the same agent and now backs the CopilotKit research UI.

The two copies have already drifted. The example coordinator sets
`recursionLimit: 100` because a research run can exceed LangGraph's default 25
super-steps; the published template omits the setting. The current parity guard
protects shared test files only, so it cannot catch coordinator, subagent, tool,
prompt, workspace, or eval drift.

The generated product also lacks a release-blocking published lifecycle. The
framework and runtime-contract harnesses explicitly scaffold the optional
`basic` template. Package-level research tests exercise workspace source, but
they do not prove that the default creator output installs and runs from the
candidate registry.

Finally, the generated command and onboarding contract is inconsistent:

- creator output says `check` generates route and tool types, although `check`
  validates without writing them;
- `build` runs TypeScript with `noEmit: true`, rather than producing Dawn
  deployment artifacts;
- the template has no `verify`, `typegen`, or `start` script;
- no `.env.example` tells the user where the required key belongs; and
- public starter guidance disagrees about the Node floor, paths, ports, and
  command effects.

These gaps make it unsafe to distribute the existing web example as the default
activation experience. The server contract must be reliable first.

## Goals

1. Make `examples/research/server` the explicit behavioral source of truth for
   the default research scaffold.
2. Fail quickly when any shared behavior file is added, removed, renamed, or
   changed without a corresponding template update.
3. Restore `recursionLimit: 100` in the generated research coordinator.
4. Give each generated npm script one accurate responsibility.
5. Provide a server-side `.env.example` and a short, honest live onboarding
   path that requires a real key.
6. Prove the default packaged external scaffold with npm 11 on Node 24.
7. Exercise one successful corpus-research journey and one interrupt/resume
   journey through the generated app's real AG-UI endpoint without a real model.
8. Preserve diagnostic artifacts when the published-contract lane fails.
9. Align directly affected documentation and release the change with the
   required patch changeset.

## Non-goals

- Add or scaffold the research web UI.
- Map Dawn planning or subagent chunks into AG-UI activities.
- Add provider or model selection to `create-dawn-ai-app`.
- Collect or store a user's API key in the creator.
- Add `dawn ask`, `research/run`, or another interactive run command.
- Present aimock fixtures as a keyless product demo.
- Add AG-UI reconnect, event replay, or thread-management UI.
- Change Dawn runtime, build-target, or deployment semantics.
- Modify memory stores, Inspector behavior, or memory governance APIs.
- Guarantee every package manager in the new published-contract lane. npm 11 on
  Node 24 is the normative generated-app contract; the Dawn monorepo continues
  to use pnpm internally.
- Perform a broad documentation rewrite unrelated to the generated research
  path.

## Selected approach

Keep the example and template as separate, independently useful trees. Protect
their shared behavioral surface with an exhaustive parity classification, then
verify the actual published output with a deterministic packaged activation
test.

This is preferable to generating the template from the example because the two
trees legitimately differ in package manifests, dependency specifiers, ports,
workspace metadata, and onboarding copy. It is preferable to end-to-end tests
alone because parity failures are faster and identify the exact source of drift.

## Architecture and ownership

The integrity model has three layers:

```text
examples/research/server
        |
        | exhaustive behavioral parity
        v
packages/devkit/templates/app-research
        |
        | packaged @dawn-ai/devkit + create-dawn-ai-app
        v
default external scaffold
        |
        | npm 11 lifecycle + aimock-backed AG-UI journeys
        v
published starter contract
```

### Dogfooded behavior source

`examples/research/server` owns how the research agent behaves. The parity
surface comprises:

- root `AGENTS.md` and `dawn.config.ts`;
- every file under `src/`;
- every file under `test/`; and
- every file under `workspace/`.

That includes the coordinator, researcher subagent, route memory and planning
files, route state, tools, skills, tests, eval logic, workspace instructions,
corpus, and fetch script.

The example's `.env.example` also becomes the source for the template's new
`.env.example`, provided it contains placeholders only. It is a parity-owned
root file and is compared with the same fail-closed path/content checks.

### Template-owned surface

The devkit template continues to own files whose generated-app concerns differ
from the workspace example:

- `package.json.template`;
- `tsconfig.json.template`;
- `pnpm-workspace.yaml.template`;
- `npmrc.template`;
- `gitignore.template`;
- `.dawn/dawn.generated.d.ts`; and
- the generated-app `README.md`.

The example continues to own its workspace package manifest, changelog,
Dockerfile, Vitest configuration, and example-specific README.

### Exhaustive parity guard

The existing test-file-only parity helper becomes a general research parity
contract. It normalizes the template's `.template` suffix when mapping paths.
It then:

1. inventories the configured example and template parity roots from disk;
2. asserts that every source path maps to one unique normalized path, so suffix
   normalization cannot conceal collisions;
3. asserts that their normalized path sets are identical;
4. compares the bytes of every corresponding file; and
5. reports missing, extra, collision, and content-drifted paths separately.

The guard must derive the inventory from disk rather than maintain a list of
shared leaf files. A new file under a parity root therefore fails until the
template contains its counterpart. Intentionally different roots and top-level
files remain explicitly outside the parity set.

## Generated command contract

The default research template exposes the following scripts:

| Script | Command | Contract |
|---|---|---|
| `dev` | `dawn dev --port 3000` | Discover source, write generated types, and run the HMR development server. |
| `verify` | `dawn verify` | Check app integrity, Node, required packages, the selected provider key, and configured infrastructure. |
| `typegen` | `dawn typegen` | Write `.dawn/dawn.generated.d.ts`. |
| `check` | `dawn check` | Validate routes, tools, and configuration without writing generated files. |
| `typecheck` | `tsc --noEmit` | Run TypeScript validation. |
| `test` | `vitest run` | Run deterministic offline agent scenarios. |
| `eval` | `dawn eval` | Run deterministic offline evals unless the user explicitly selects live mode. |
| `build` | `dawn build` | Write configured deployment artifacts under `.dawn/build`. |
| `start` | `node --env-file-if-exists=.env .dawn/build/server.mjs` | Load the generated app's default local env file when present, then run the Node artifact from the most recent successful build. |

`check` does not imply `typegen`. `start` does not imply `build`. There are no
hidden npm lifecycle hooks such as `predev` or `prestart`; the commands remain
transparent and composable.

The existing sandbox and memory utility scripts remain unchanged.

### Build and start semantics

The generated `build` script must exercise Dawn's real build command rather than
the no-emit TypeScript configuration. `npm start` serves the emitted Node entry
point and therefore requires a preceding successful `npm run build`.

The emitted server entry does not itself load `.env`. Because generated apps
require Node 24, the start script uses Node's
`--env-file-if-exists=.env` flag. Existing process environment values retain
precedence, and a missing `.env` is allowed for deployments that inject
environment variables externally. This convenience script intentionally covers
the generated starter's default `.env`; custom production launchers remain free
to provide a different environment source.

This design does not change `dawn start`. It only gives a generated application
a coherent package-script pair for its build artifact. The README states the
required order and the artifact path.

## Environment and onboarding contract

The generated project includes:

```dotenv
OPENAI_API_KEY=
```

in `.env.example`. `.env` remains ignored. The creator never prompts for, reads,
logs, or writes a real credential. The browser is out of scope, so no client
environment variable is introduced.

The creator's primary handoff is:

```text
cd <app>
npm install
cp .env.example .env
# add OPENAI_API_KEY
npm run verify
npm run dev
```

The output no longer inserts `check` and `test` between creation and the first
live run. Those remain important confidence commands and appear in separate
README sections with `typegen` and `eval`. The README explicitly distinguishes:

- the real-key live path;
- offline tests and evals backed by deterministic fixtures; and
- the production `build` then `start` path.

The fixtures are verification assets, not a keyless primary activation mode.

## Packaged activation contract

### Placement

Add one default-research activation scenario to the generated-app framework
harness. The scenario uses the existing local registry and artifact-preservation
infrastructure but creates the application through the packaged creator's
default path. It must not pass `--template research`; the test proves that
research remains the default.

Repository package builds and local-registry setup may continue to use pnpm.
The user-facing portion of this scenario installs the packaged creator and runs
the generated application with npm 11. This distinction lets the monorepo keep
its package-manager conventions while testing the advertised external contract.

### One prepared application

The scenario creates and installs one generated application, then reuses it for
all authoring checks and runtime journeys. It runs these commands through the
generated package scripts:

1. `npm install`
2. `npm run typegen`
3. `npm run check`
4. `npm run typecheck`
5. `npm test`
6. `npm run eval`
7. `npm run verify` with the deterministic test provider environment
8. `npm run build`

Before the lifecycle commands, the harness records `npm --version` and fails
unless the major version is 11. This prevents a future CI image change from
silently weakening the advertised npm contract.

The harness writes a test-only `.env` containing aimock's dynamic base URL and
the placeholder API key. It then starts `npm run dev` and drives the two AG-UI
journeys. After stopping the development server, it starts `npm start`, checks
`/healthz`, and completes a minimal model-backed AG-UI roundtrip on a fresh
thread. The built-server subprocess must have `OPENAI_BASE_URL` and
`OPENAI_API_KEY` removed from its inherited environment, so `.env` is its only
source for those values. That roundtrip—not health alone—proves the built entry
loaded `.env` and can reach the configured provider endpoint. Only one server
session is active at a time, and the expensive scaffold/install is not repeated.

### Deterministic provider boundary

The harness starts one aimock instance and passes the generated server:

- `OPENAI_BASE_URL` pointing to aimock; and
- `OPENAI_API_KEY=test-not-used`.

Fixtures script model decisions only. Route discovery, tool execution,
subagent dispatch, permission parking/resume, workspace writes, checkpoints,
AG-UI translation, and SSE framing remain real Dawn behavior. CI never contacts
an external model provider.

### Journey 1: safe corpus research

Use a grounded prompt equivalent to the existing first suggestion:

> What are common agent architectures? Write a short cited report.

The deterministic fixture sequence drives the coordinator through recall,
planning, researcher delegation, corpus search/read, synthesis, and report
writing. Assertions cover stable observable contracts:

- one `RUN_STARTED` before streamed work;
- correlated AG-UI tool calls and results for the expected public tool surface;
- visible delegation through the coordinator's `task` tool call;
- a terminal `RUN_FINISHED` success outcome;
- a report under `workspace/reports/`; and
- report content containing citations to the bundled corpus.

The test does not freeze the complete assistant prose or generated report.

Planning and subagent capability chunks are still ignored by the current AG-UI
adapter. This starter-integrity slice therefore does not assert activity events;
that contract belongs to the subsequent AG-UI activity design.

### Journey 2: gated external research

Use a prompt equivalent to the existing permission suggestion for a topic not
covered by the bundled corpus. The deterministic sequence asks the coordinator
to call the gated `runBash` fetch command.

The first AG-UI request must:

- use a fresh explicit thread id;
- emit one terminal `RUN_FINISHED` with `outcome.type: "interrupt"`;
- expose the interrupt id and permission metadata; and
- perform no post-permission work before resolution.

The second request uses the same thread id and sends a top-level `resume` entry
with that interrupt id, `status: "resolved"`, and payload `"once"`. It must
complete successfully and preserve interrupt correlation. Explicit denial and
parallel-interrupt behavior remain covered by faster package-level suites.

### AG-UI assertions

The packaged scenario parses SSE `data:` frames and validates semantic ordering,
not chunk timing or arbitrary generated ids. Assertions normalize thread, run,
message, tool-call, port, version, and temporary-path values where necessary.
The transcript records sanitized requests, decoded events, command stdout and
stderr, and terminal results.

## Failure handling and diagnostics

- Node below 24 continues to fail before scaffolding writes the application.
- `npm run verify` reports a missing provider credential or dependency before a
  real run.
- A missing built entry causes `npm start` to fail; onboarding documents the
  required `build` then `start` order.
- `npm start` loads `.env` only when it exists and continues to honor
  externally injected environment variables. The built-server AG-UI smoke
  proves this path reaches aimock rather than merely returning health.
- Parity failures separately list missing template paths, unexpected template
  paths, normalized-path collisions, and content drift.
- Each packaged lifecycle command records its cwd, command, exit status, stdout,
  and stderr.
- Each runtime journey has bounded readiness, request, stream, and shutdown
  waits. No unbounded polling or sleeps are added.
- The generated application, command transcript, and decoded AG-UI transcript
  are preserved on failure and removed after success.
- Test environments use placeholders only. No real credential is written to an
  artifact or transcript.
- Child servers and aimock are stopped in `finally` paths. Cleanup uses the
  existing tracked-temp and bounded subprocess helpers.

## Documentation scope

Update only surfaces that define or directly contradict the starter contract:

- `packages/devkit/templates/app-research/README.md`;
- `packages/create-dawn-app/src/index.ts` handoff output;
- `packages/create-dawn-app/README.md`;
- `apps/web/content/docs/getting-started.mdx`;
- directly affected CLI documentation that claims `check` writes types; and
- research example READMEs whose ports or web-mode claims contradict the current
  scripts.

The documentation must agree on:

- Node 24 and npm 11 as the supported generated path;
- `src/tools` as the shared corpus-tool location;
- `check` versus `typegen` semantics;
- the real-key live path;
- current research server ports; and
- the offline-test versus live-run distinction.

PRs #429 and #430 are changing edge documentation and runtime guards. Rebase
after those changes before editing overlapping documentation. Do not expand this
slice into an edge or deployment rewrite.

## Release and compatibility

This is additive for existing applications. It changes newly generated files,
creator output, and release verification; it does not migrate existing projects
or change the behavior of Dawn's CLI commands.

Add a patch changeset for the user-facing `@dawn-ai/devkit` and
`create-dawn-ai-app` changes. Dawn's fixed package group will carry the release
according to the existing changeset configuration.

## Delivery shape

Implement the design as one PR with independently reviewable commits:

1. Add failing exhaustive parity and default-research packaged-contract tests.
2. Restore behavioral parity, including `recursionLimit: 100`.
3. Correct generated scripts and add `.env.example`.
4. Complete both deterministic AG-UI activation journeys and artifact-start
   proof.
5. Reconcile directly affected onboarding documentation and add the changeset.

The branch must be based on current `main`. Avoid memory internals while the
memory browse work is active, and keep deployment topology out of scope while
the edge and Vercel work proceeds independently.

## Acceptance criteria

The design is complete when all of the following are true:

1. A candidate-registry `create-dawn-ai-app <target>` invocation produces the
   research template without passing `--template research`.
2. That app installs with npm 11 on Node 24, and the lane asserts the npm major
   rather than assuming it from the CI image.
3. `typegen`, `check`, `typecheck`, `test`, `eval`, `verify`, and `build` pass
   through the generated scripts in the deterministic environment.
4. `build` writes `.dawn/build/server.mjs`, and `npm start` loads the test `.env`,
   serves a healthy runtime, and completes a model-backed AG-UI smoke through
   aimock.
5. The generated coordinator contains `recursionLimit: 100`.
6. The safe AG-UI journey exercises the intended research tools, terminates
   successfully, and writes a cited report.
7. The gated journey terminates with a standard interrupt, resumes on the same
   thread with an explicit `"once"` resolution, and completes.
8. CI makes no external provider request and requires no real API key.
9. Any behavioral path addition, removal, rename, or content drift between the
   example and template fails the fast parity suite.
10. Generated onboarding and directly affected public docs agree on commands,
    Node/npm floor, paths, ports, and key requirements.
11. Failure output points to preserved generated-app and transcript artifacts.
12. The required patch changeset is present.
13. The repository's standard validation lanes pass.

## Follow-up

After this integrity contract ships, the next independent design maps Dawn plan
and subagent lifecycle chunks to standard AG-UI activity events, hardens the
CopilotKit research example, and prepares that proven UI for later promotion
into the default scaffold.
