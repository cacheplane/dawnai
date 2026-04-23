# Dawn Root Documentation Design

## Goal

Add accurate, succinct, repo-root Markdown documentation for two audiences:

- framework users trying Dawn as it exists today
- contributors working inside the Dawn monorepo

The output of this design is:

- `/Users/blove/repos/dawn/README.md`
- `/Users/blove/repos/dawn/CONTRIBUTORS.md`

These documents should become the primary human-readable entrypoints for the current repository. They should describe the Dawn repository as it exists now, not as it is planned to evolve.

## Status

Dawn already has:

- package-level README files under `packages/*`
- a docs website under `apps/web`
- detailed design and implementation history under `docs/superpowers`

What Dawn does not have yet is a concise root documentation layer that answers:

- What is Dawn?
- How do I try it right now?
- What commands actually exist today?
- What does the current app contract look like?
- How is this monorepo organized for contributors?

That gap currently forces readers to infer the current product from package READMEs, tests, and design specs. The root docs should remove that ambiguity.

## Non-Goals

This documentation pass does not:

- introduce a larger `/docs` information architecture
- document future commands or aspirational roadmap items
- replace the website as the long-form public docs surface
- duplicate every package README in the root docs
- turn `docs/superpowers` into the primary contributor manual

Roadmap and future-facing material should remain under `/docs`, not in the root docs.

## Documentation Architecture

Use two root documents with distinct responsibilities.

### `README.md`

Audience:

- framework users first
- evaluators of the project second
- contributors only after the user journey is clear

Purpose:

- explain what Dawn is in one screenful
- provide a fast path to a successful local run
- document the current Dawn app contract
- document the commands and packages that exist today
- clearly state the current boundary of the framework

### `CONTRIBUTORS.md`

Audience:

- engineers working inside the Dawn monorepo

Purpose:

- explain repo layout and ownership boundaries
- document local setup and verification commands
- describe current harness and test lanes
- show where design history lives without making it the primary onboarding path

## `README.md` Content Design

The README should be user-first and operational.

Recommended section order:

1. project description
2. current status
3. quickstart
4. current app contract
5. CLI commands
6. package overview
7. current limits and boundaries
8. contributor link

### Project Description

Describe Dawn as a TypeScript meta-framework around:

- filesystem conventions
- route discovery
- route validation
- route type generation
- local route execution
- local development runtime

The description must also state what Dawn is not:

- not a deployment runtime
- not a replacement for LangSmith traces
- not a hosted runtime platform

### Current Status

Include a short, direct status note that the repository is still intentionally narrow and that the documented behavior reflects the currently implemented surfaces only.

This avoids the common problem where an early-stage repo README sounds broader than the product actually is.

### Quickstart

The README quickstart should optimize for a five-minute successful run.

It should use the current supported scaffolding and execution path:

1. scaffold a new app with `pnpm create dawn-app`
2. install dependencies
3. execute the scaffolded route with `dawn run`
4. optionally boot the local runtime with `dawn dev`
5. optionally re-run the same route over `--url`

The quickstart should use the real route shipped by the `basic` template:

- `src/app/(public)/hello/[tenant]/workflow.ts`

It should show the required shell quoting around route paths containing `(`, `)`, or `[` characters.

### Current App Contract

This section should define the narrow Dawn contract that the repository actually supports today:

- app root contains `package.json` and `dawn.config.ts`
- route discovery starts at `src/app` by default
- `appDir` is the only currently supported config option
- each route directory must expose exactly one primary executable entry:
  - `graph.ts`
  - `workflow.ts`
- the current `basic` scaffold ships a `workflow.ts` route

This section should prefer explicit statements over broad framework language.

### CLI Commands

Document only commands that exist now:

- `create-dawn-app`
- `dawn check`
- `dawn routes`
- `dawn typegen`
- `dawn run`
- `dawn test`
- `dawn dev`

For each command, explain:

- what it does
- when to use it
- one concise example where helpful

Do not document unimplemented commands or reserved ideas.

### Package Overview

Summarize the public package split:

- `@dawnai.org/core`
- `@dawnai.org/langgraph`
- `@dawnai.org/cli`
- `create-dawn-app`
- `@dawnai.org/devkit`
- `@dawnai.org/config-typescript`
- `@dawnai.org/config-biome`

This section should stay high-level and route deeper implementation detail to `CONTRIBUTORS.md`.

### Current Limits And Boundaries

This section should call out present constraints that materially affect adoption or expectations, such as:

- current configuration support is intentionally narrow
- the starter template surface is intentionally small
- local runtime ownership stops at `dawn dev`
- deployment and traces remain outside Dawn’s runtime ownership

This should be framed as current boundaries, not roadmap promises.

## `CONTRIBUTORS.md` Content Design

The contributor guide should assume the reader is already in the repository and needs operational clarity.

Recommended section order:

1. contributor overview
2. repo layout
3. package responsibilities
4. local setup
5. common commands
6. verification and test lanes
7. documentation sources of truth
8. contribution expectations

### Repo Layout

Document the current high-level layout:

- `apps/web`
- `packages/*`
- `test/*`
- `scripts/*`
- `docs/*`

This section should explain what each top-level area is for, not just list names.

### Package Responsibilities

The contributor guide should map package boundaries clearly:

- `@dawnai.org/core` owns discovery, config loading, validation, and route types
- `@dawnai.org/langgraph` owns thin route authoring contracts
- `@dawnai.org/cli` owns user-facing commands and local runtime behavior
- `create-dawn-app` owns scaffolding
- `@dawnai.org/devkit` owns shared template and file-generation helpers
- config packages own shared workspace configuration

### Local Setup

Document the current contributor bootstrap flow:

- required Node version
- `pnpm install`
- common local commands

Avoid speculative tooling or setup steps that the repo does not require.

### Common Commands

Document the commands contributors actually use now:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm ci:validate`
- `pnpm verify:harness`
- `node scripts/publish-smoke.mjs`

Where useful, explain which commands are fast inner-loop commands and which are full gates.

### Verification And Test Lanes

Explain the current harness and test organization in contributor terms:

- package/unit and CLI tests under Vitest
- framework verification
- runtime contract verification
- smoke verification
- generated/packaged app verification
- publish smoke

This section should help contributors understand where to add coverage when they change framework behavior.

### Documentation Sources Of Truth

Explain the intended hierarchy:

- root docs for current operational understanding
- package READMEs for package-local context
- website docs for public-facing narrative docs
- `docs/superpowers` for design and implementation history

This keeps contributors from treating historical specs as the only way to learn the repo.

## Writing Constraints

Both documents should be:

- accurate to current code
- concise
- complete for their target audience
- explicit about current limits
- free of roadmap language in the root docs

They should avoid:

- vague marketing language
- speculative features
- duplicated deep implementation detail
- contradictions with package READMEs or current CLI behavior

## Verification

The documentation change should be considered complete when:

- both files exist at the repo root
- examples and command references match current behavior
- the docs completeness check still passes
- contributor guidance names the current verification gates correctly

The implementation plan should include a final documentation verification step using:

- `node scripts/check-docs.mjs`

and any additional targeted checks needed to confirm examples still match current commands and routes.

## Recommendation

Implement this as a focused documentation slice:

- add a user-first root `README.md`
- add a contributor-first root `CONTRIBUTORS.md`
- keep both rooted in current repository behavior
- leave future-facing material under `/docs`

This is enough structure to make the Dawn repo understandable without overbuilding a documentation system before the framework surface settles further.
