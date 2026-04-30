# Dawn Monorepo Design

**Date:** 2026-04-10

## Goal

Create a new `dawn` monorepo that can support three primary product surfaces:

1. A marketing and documentation website
2. A developer-facing TypeScript CLI published as `dawn`
3. A publishable TypeScript library suite for defining a meta-framework layer around LangGraph, LangChain, and Deep Agents

The repo should be simple to reason about, publishable as independent packages, and conservative about runtime abstraction. Dawn should own filesystem conventions, discovery, validation, type generation, and scaffolding, while staying close to native LangGraph and LangChain APIs at runtime.

## Naming Decisions

- Product and repo name: `dawn`
- Architectural concept in docs: `App Graph`
- Primary CLI binary: `dawn`
- Scaffolder package and command: `create-dawn-app`
- Framework package scope: `@dawn-ai/*`

The attached RFC used `DawnGraph` as the public brand. This design simplifies the public surface to `dawn` and reserves `App Graph` as the explanatory concept used in documentation.

Package naming rule:

- framework libraries and internal shared packages use `@dawn-ai/*`
- the scaffolder remains intentionally unscoped as `create-dawn-app`

## Product Thesis

Dawn is a TypeScript-first application framework for graph-shaped agent systems. It should improve developer experience in the same class of way that Next.js improved web app ergonomics:

- opinionated filesystem conventions
- predictable local workflows
- clear route and ownership boundaries
- colocated evals, approvals, UI, and route metadata

Unlike a closed framework runtime, Dawn should preserve escape hatches. A user should be able to author a route with Dawn conventions while keeping graph orchestration in native LangGraph constructs.

## Constraints

- Greenfield repo with no existing git history
- TypeScript-first codebase
- Packages must be publishable independently
- Website and framework code should live in one monorepo but remain cleanly separated
- The initial architecture should optimize for trust, maintainability, and release safety rather than maximal framework cleverness

## Non-Goals

These are explicitly out of scope for the first scaffold and first implementation plan:

- a full visual studio or inspector product
- a production-ready deployment platform abstraction
- a full plugin runtime for third-party CLI extensions
- a custom graph execution engine replacing LangGraph
- broad runtime wrappers that hide native LangGraph or LangChain concepts

## Recommended Monorepo Architecture

Use a `pnpm` workspace monorepo with `turbo` for task orchestration and caching.

### Why this is the recommended default

- `pnpm` provides strong workspace ergonomics and efficient dependency management
- `turbo` gives fast task coordination and remote-cache readiness without imposing a large framework surface
- TypeScript project references support reliable incremental builds for publishable libraries
- This combination keeps the repo shape boring and explicit, which fits Dawn's native-first runtime goal better than a heavier workspace framework

### Why not Nx as the default

Nx is credible and could become useful later if Dawn evolves into a generator-heavy platform. For the current scope, it adds more framework surface area than the project needs. Dawn should avoid starting life inside another large abstraction layer while it is still defining its own conventions.

## Baseline Tooling

- Package manager: `pnpm`
- Task runner and cache: `turbo`
- TypeScript builds: `tsc -b` with project references
- Website framework: Next.js App Router
- Unit and integration tests: Vitest
- Formatting and linting: Biome
- Release management: Changesets
- Node baseline: Node 22.x

## Repository Structure

```txt
dawn/
  apps/
    web/
  packages/
    core/
    langgraph/
    cli/
    create-dawn-app/
    devkit/
    config-biome/
    config-typescript/
  templates/
    app-basic/
    app-agent/
    app-graph/
  docs/
    architecture/
    cli/
    app-graph/
    superpowers/
      specs/
      plans/
```

## Package Responsibilities

### `apps/web`

Marketing and documentation site for Dawn. This app should explain the product, document the App Graph concept, host getting-started guides, and publish examples or package API docs.

The website is part of the monorepo, but it is not the runtime control plane for the framework.

### `@dawn-ai/core`

Owns Dawn-specific conventions and shared contracts:

- app discovery
- route manifest generation
- config loading
- route metadata types
- filesystem parsing
- validation contracts
- type generation inputs

This package is the center of the repo's Dawn-specific logic.

### `@dawn-ai/langgraph`

Owns integration points with LangGraph and adjacent libraries:

- native-first adapters
- route entrypoint contracts for `graph.ts` and `workflow.ts`
- small helper APIs that improve ergonomics without obscuring native runtime behavior

This package must avoid becoming a second runtime layer.

### `@dawn-ai/cli`

Owns the `dawn` binary and command implementations. Commands should compose `@dawn-ai/core` and `@dawn-ai/langgraph` rather than defining duplicate discovery or validation logic.

### `create-dawn-app`

Owns scaffolding for new Dawn applications. It should provide a fast path into Dawn conventions with a small, understandable output tree.

### `@dawn-ai/devkit`

Shared scaffolding and code-generation utilities used by both `create-dawn-app` and `@dawn-ai/cli`. This package prevents those tools from diverging in how they write files, discover templates, or validate project layouts.

### `@dawn-ai/config-biome`

Shared Biome config published or consumed internally by workspace packages.

### `@dawn-ai/config-typescript`

Shared TypeScript base configs for library, app, and Node package use cases.

## Canonical Dawn App Contract

This section locks the minimal filesystem contract that Dawn tooling targets in v1.

### App root

A Dawn application lives at a package or project root containing `package.json` and `dawn.config.ts`.

### Config entrypoint

The canonical config filename is `dawn.config.ts` at the app root.

V1 should keep the config intentionally small. It only needs to cover the fields required to support discovery, route metadata, and future expansion. It should not become a dumping ground for advanced runtime configuration in the first scaffold.

### Discovery root

Route discovery starts at `src/app` relative to the Dawn app root.

Example:

```txt
my-dawn-app/
  package.json
  dawn.config.ts
  src/
    app/
      (public)/
      (internal)/
```

This convention is what `@dawn-ai/core`, `@dawn-ai/cli`, `create-dawn-app`, and `dawn typegen` should share. The Dawn framework repo itself is a monorepo and does not need to be treated as a Dawn application.

## Framework Authoring Model

Dawn should be opinionated at the filesystem boundary and conservative at the runtime boundary.

### Filesystem-owned by Dawn

Dawn should discover and validate files like:

- `route.ts`
- `graph.ts`
- `workflow.ts`
- `state.ts`
- `middleware.ts`
- `memory.ts`
- `ui/`
- `approvals/`
- `evals/`

### Runtime-owned by native libraries

LangGraph and LangChain should remain the primary runtime concepts. Dawn should not require developers to rewrite valid native graph code into a proprietary DSL.

### Route boundary

`route.ts` should remain thin in v1. A preferred shape is:

```ts
export { graph as entry } from "./graph";

export const config = {
  streaming: true,
  runtime: "node",
  tags: ["support"],
};
```

This leaves room to add a `defineRoute()` helper later if it provides real value.

### Graph boundary

`graph.ts` should prefer native LangGraph authoring. Dawn may later add optional helpers, but the native-first path should remain first-class.

### Workflow boundary

`workflow.ts` is also valid in v1. It is an alternative executable entry for a route when structured control flow is clearer than explicit graph construction.

For a single route directory, v1 should allow exactly one primary executable entry:

- `graph.ts`, or
- `workflow.ts`

Future support for `agent.ts` can be added later, but it is not required for the first implementation plan.

## Dynamic Route Semantics

The repo should adopt Next-like route discovery semantics for ownership and entrypoint discovery only:

- `(group)` for organization-only folders
- `[param]` for required parameters
- `[...param]` for catch-all parameters
- `[[...param]]` for optional catch-all parameters
- `_private` for non-routable implementation folders

These conventions describe application surface, not graph topology.

## CLI Scope

### V1 commands

The first implementation plan should focus on:

- `create-dawn-app`
- `dawn check`
- `dawn routes`
- `dawn typegen`

### Deferred commands

These should be designed for later, but not required in the first scaffold:

- `dawn dev`
- `dawn build`
- `dawn start`
- `dawn graph trace`
- `dawn eval`
- `dawn doctor`
- `dawn studio`

The reason to defer them is sequencing. Discovery, manifests, route validation, and generated types must stabilize first.

## Template Scope

The repository may contain multiple template folders over time, but v1 should ship exactly one supported scaffolding template: a minimal `basic` template.

That initial template should establish the canonical app contract:

- `package.json`
- `dawn.config.ts`
- `src/app`
- one example route using either `graph.ts` or `workflow.ts`
- minimal scripts for install, typecheck, and validation

Additional templates such as `agent` and `graph` are future expansions and should not enlarge the first implementation plan.

## Website Scope

The first website should provide:

- homepage and positioning
- docs shell
- getting started guide
- App Graph concept docs
- package overview docs
- CLI command docs
- examples overview

The website should not depend on unfinished runtime internals beyond importing stable markdown, code snippets, or example metadata.

## Build and Publish Strategy

Use `tsc -b` for library builds and project references for incremental correctness.

Reasons:

- predictable output
- stable TypeScript-native packaging
- no early commitment to a bundler abstraction
- easier debugging when package boundaries are still evolving

Each publishable package should define explicit `exports`, `types`, and Node-compatible entrypoints. If Dawn later needs bundled CLI output or additional package validation tooling, that can be introduced selectively instead of repo-wide from day one.

## Release Strategy

Use Changesets from the initial scaffold.

Reasons:

- multiple independently published packages are part of the product from the start
- versioning and changelog discipline are cheaper to establish early than retrofit later
- release coordination across the CLI and libraries should be explicit

## Testing and Quality Strategy

### Repo-wide standards

- Biome for formatting and linting
- Vitest for unit and integration tests
- TypeScript project references for type-safe incremental builds
- CI pipeline covering install, lint, typecheck, test, build, and release-state checks

### Per-package expectations

- `@dawn-ai/core`: filesystem discovery, parsing, and manifest tests
- `@dawn-ai/langgraph`: adapter contract tests against native authoring shapes
- `@dawn-ai/cli`: command and fixture tests
- `create-dawn-app`: smoke tests that scaffold a fixture and validate installable output
- `apps/web`: content and app build verification

## Phased Delivery

### Phase 1: Repo foundation

- initialize git repo
- configure `pnpm`, `turbo`, TypeScript references, Biome, Vitest, and Changesets
- create workspace package boundaries

### Phase 2: Core framework contracts

- implement discovery and config loading in `@dawn-ai/core`
- define route manifests and type generation inputs
- implement minimal LangGraph integration contracts

### Phase 3: Tooling surface

- scaffold `create-dawn-app`
- implement `dawn check`, `dawn routes`, and `dawn typegen`

### Phase 4: Website

- scaffold marketing/docs site
- publish positioning, docs structure, and examples overview

## Risks

### Over-abstraction risk

If Dawn wraps LangGraph too aggressively, it will become harder to trust and harder to maintain as upstream libraries evolve.

### Scope risk

If the first implementation plan tries to deliver the full RFC command surface, the repo will accumulate unstable contracts and churn.

### Boundary risk

If the website, CLI, and framework internals are not separated early, package responsibilities will blur and release workflows will become brittle.

### Naming risk

If the package namespace or docs remain half-committed between `DawnGraph` and `dawn`, the public surface will become inconsistent.

## Decisions Locked by This Spec

- Dawn is the public product, repo, and CLI name
- App Graph is the documentation term for the architectural concept
- The monorepo uses `pnpm` and `turbo`
- The website lives in `apps/web`
- Dawn owns filesystem conventions and tooling, not a replacement runtime
- V1 focuses on scaffolding, discovery, validation, and type generation
- Framework packages use `@dawn-ai/*`, while the scaffolder remains `create-dawn-app`

## Open Questions Deferred Intentionally

These do not block the initial plan and should be handled after the repo foundation exists:

- whether `defineRoute()` earns inclusion in v1 or later
- whether `workflow.ts` needs a Dawn helper or should just register a native functional entrypoint
- whether the CLI eventually needs a plugin model
- whether a visual graph inspector becomes part of the main product or remains a later optional tool

## Success Criteria

The design is successful if the first implementation plan can produce:

- a new git-backed monorepo with stable workspace tooling
- a publishable package layout for website, CLI, and library surfaces
- a minimal but coherent Dawn authoring model
- a first scaffolder path for new users
- a path to grow into the broader RFC without forcing a rewrite
