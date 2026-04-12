# Dawn Testing Harness Design

Date: 2026-04-11
Status: Proposed
Owner: Dawn

## Summary

Dawn needs a framework-first testing harness that proves three things:

1. Dawn still interprets its filesystem contract correctly.
2. Dawn can scaffold and wire real apps correctly across package boundaries.
3. Dawn can start and execute a minimal runtime path for `graph.ts` and `workflow.ts`.

The recommended design is a layered internal harness with a narrow public CLI surface:

- `pnpm create dawn-app` as the public bootstrap path
- `dawn verify` as the app integrity command that the framework harness also invokes
- `dawn test` reserved for broader runtime and scenario-oriented testing, but not a v1 shipping command

The harness should optimize first for generated-app correctness, while still making contract fixtures and limited execution smoke first-class layers.

## Problem

The current repo has package-level tests, pack checks, publish smoke coverage, and CI validation. That is useful but incomplete for framework hardening. Dawn still lacks one coherent system that can answer:

- does the app filesystem contract still work
- do generated apps actually install, typecheck, build, and pass Dawn verification
- does a minimal app runtime path still start and run

Without that harness, Dawn risks shipping regressions in scaffolding, discovery, type generation, and runtime startup even when package unit tests pass.

## Goals

- Harden Dawn as a framework repo before optimizing for downstream consumer ergonomics.
- Make generated-app correctness the primary v1 verification lane.
- Keep filesystem-contract drift visible and diffable through canonical fixtures.
- Add a narrow runtime smoke layer without turning v1 into a full eval platform.
- Reuse one result model across local CLI, Vitest, and CI.
- Keep the public testing surface small and defensible.

## Non-Goals

- A full user-facing behavioral testing framework for Dawn apps.
- Dataset-driven evals, approvals simulation, memory simulation, or tool simulation in v1.
- Browser-heavy end-to-end coverage as a default verification lane.
- A stable public testing API package in the first iteration.

## Design Principles

- Framework-first: optimize for Dawn's monorepo and fixture apps before generalizing outward.
- Layered confidence: separate filesystem contracts, generated apps, and runtime smoke rather than mixing them into one opaque runner.
- Boring boundaries: prefer packed artifacts, temporary app directories, and explicit process orchestration over magical local coupling.
- Narrow public surface: expose verification through CLI commands, not a large new testing API.
- Debuggable failures: every failed run should leave enough artifacts and logs to explain the breakage quickly.

## Architecture

The harness is one framework-owned subsystem with four internal components and one v1 public command, plus one reserved future command.

### Public Commands

- `pnpm create dawn-app`
  - primary app bootstrap UX
  - backed by the `create-dawn-app` package
- `dawn verify`
  - app-local integrity command
  - runs inside a Dawn app directory
  - validates that app's Dawn contract rather than the framework repo's full fixture matrix
- `dawn test`
  - reserved future public command for broader app/runtime scenario testing
  - explicitly not a v1 shipping deliverable

### Internal Components

- fixture catalog
  - owns checked-in canonical fixtures and the metadata describing what each fixture proves
- app generator
  - creates temporary apps from templates, packed tarballs, and later registry channels
- run orchestrator
  - executes install, typecheck, build, verify, typegen, route inspection, and smoke phases
- result reporter
  - emits consistent human-readable and machine-readable results for local use and CI

### Command Contexts

The spec distinguishes two execution contexts to avoid ambiguity:

- app context
  - a real or generated Dawn app directory
  - `dawn verify` runs here
  - scope: config loading, discovery, manifest generation, type generation, route inspection, and other app-local integrity checks
- framework context
  - the Dawn monorepo
  - the internal harness runs here through Vitest projects and root scripts
  - scope: contract fixtures, generated-app creation, app lifecycle orchestration, smoke execution, and CI aggregation

This separation is important. The framework harness may invoke `dawn verify` inside generated apps as one verification phase, but `dawn verify` is not itself the repo-wide harness runner.

## Harness Layers

### Layer 1: Contract Fixtures

Contract fixtures are checked-in canonical app directories. They exist to catch filesystem-contract drift.

They should cover:

- `dawn.config.ts` loading and `appDir` behavior
- route discovery roots
- segment normalization
- dynamic segments and route groups
- companion file rules such as `graph.ts`, `workflow.ts`, `state.ts`, `ui/`, `evals/`, and invalid combinations
- manifest output
- type generation output
- known-invalid layouts with stable failure expectations

These fixtures should stay small, deterministic, and diff-friendly. They are not full apps. They are contract probes.

### Layer 2: Generated App Fixtures

Generated app fixtures are the primary optimization target for v1.

They exist to prove that Dawn can produce a real app shape and wire it correctly through package boundaries. A generated app run should create a temporary app directory from a template or packed package set, then run the same lifecycle a real user would hit.

This layer should verify:

- `pnpm create dawn-app`
- template materialization
- dependency installation
- Dawn CLI wiring
- `dawn verify`
- `dawn routes`
- `dawn typegen`
- app typecheck
- app build

This layer should use packed artifacts as the default correctness boundary. Local folder dependencies are acceptable for fast development loops, but they are weaker than tarball or registry-equivalent coverage and should not define release confidence.

### Layer 3: Execution Smoke

Execution smoke is a deliberately narrow runtime lane.

It should prove that one generated or curated minimal app can:

- start successfully
- expose the expected minimal runtime boundary
- execute one or two canonical `graph.ts` or `workflow.ts` flows
- produce stable captured outputs and logs

This lane is intentionally not a full behavioral or eval framework. Its purpose is to catch startup and wiring regressions that structural verification cannot catch.

### Ownership Boundaries Between Fixture Types

To avoid duplicated authority:

- contract fixtures are the authoritative source for filesystem and companion-file contract coverage
- generated-app fixtures are the authoritative source for scaffolded-app correctness and package-boundary verification
- execution smoke should prefer generated apps as its default input so runtime startup is validated against the same scaffold path users receive
- curated smoke fixtures are allowed only when a runtime-specific case cannot be expressed cleanly through a supported template

## Recommended Repo Shape

V1 should keep the harness internal to the framework rather than introducing a new public package.

Recommended layout:

```txt
packages/
  cli/
    src/commands/verify.ts
  devkit/
    src/testing/
      fixtures/
      generator/
      orchestrator/
      reporting/
test/
  fixtures/
    contracts/
      valid-basic/
      valid-dynamic/
      invalid-companion/
      invalid-config/
  generated/
    templates/
      basic/
      graph/
  smoke/
    graph-basic/
    workflow-basic/
artifacts/
  testing/
```

Notes:

- `@dawn/devkit` should own the harness primitives in v1 because they are framework-internal and shared by CLI and tests.
- `artifacts/testing/` should be gitignored if persisted locally. It exists to make failures inspectable without digging through temporary shell output.
- `dawn test` does not require a shipped command file in v1. The repo layout above reflects the v1 deliverable only.

## Execution Model

The harness should use different runners for different confidence layers rather than forcing one tool to do every job.

- Vitest `test.projects` should organize the fast structural lanes.
- Node process orchestration should handle generated-app verification and runtime smoke.
- Tarball installs should be the default package-consumption boundary.
- Local-registry verification should be deferred until the first release-hardening phase after the initial harness lands.
- Playwright should remain out of the first harness cut unless Dawn introduces a truly browser-facing contract that cannot be proven otherwise.

## Command Model

### `dawn verify`

`dawn verify` is the app integrity command.

Default behavior:

- run app-local Dawn integrity checks inside the current app directory
- validate config loading, discovery, manifest generation, route inspection, and type generation
- optionally include app-local build checks if the planning phase decides they fit the latency budget

Planned flags:

- `--smoke`
- `--filter <name>`
- `--json`

Behavior:

- default local use should be fast enough for active development inside an app
- when invoked by the framework harness inside a generated app, it acts as one phase within a larger generated-app run
- `--smoke` should remain optional and is only meaningful if the app exposes a supported local smoke target
- JSON output should reuse the same normalized result model consumed by the framework harness and CI

### `dawn test`

`dawn test` remains in architectural scope but is not part of the v1 shipped command surface.

Boundary:

- `verify` answers whether a specific app's Dawn contract is intact
- `test` will later answer whether app behavior holds under scenarios

Keeping those separate now prevents Dawn from conflating framework-hardening concerns with application-level behavioral testing.

## Result Model

The harness should emit one normalized result structure regardless of runner.

### Run-Level Contract

Each harness run should include:

- run identifier
- started and finished timestamps
- requested lanes
- executed lanes
- aggregate status
- aggregate counts for passed, failed, skipped, and errored lane entries
- artifact root path
- lane results

Exit semantics:

- exit code `0` when all requested lanes pass
- exit code `1` when any requested lane fails its assertions
- exit code `2` when the harness itself cannot complete due to infrastructure or orchestration failure

### Lane-Level Contract

Each result group should include:

- lane name such as `contract`, `generated`, or `smoke`
- fixture or app identifier
- executed phases
- phase durations
- pass or fail status
- normalized failure reason
- artifact paths
- command transcripts

This result model should drive:

- local CLI summaries
- CI output
- machine-readable JSON mode

## Artifacts And Failure Reporting

Every failure should leave enough evidence to debug it quickly.

Per run, Dawn should capture:

- generated app directory or snapshot path
- command transcript per phase
- manifest output when relevant
- type generation output when relevant
- runtime logs for smoke runs
- captured request and response artifacts for canonical flow execution

The orchestrator should prefer explicit phase boundaries over one giant combined command. That makes failures attributable to a specific step such as scaffold, install, typegen, build, or runtime start.

## CI Strategy

CI should scale confidence by lane rather than running every expensive path on every change.

### Pull Request Lane

- contract fixtures
- generated apps from packed tarballs

### Protected Branch Lane

- pull request lane
- execution smoke

This ordering matches Dawn's current risk profile. Generated-app correctness is the highest-value v1 lane.

## Initial Scope

The first harness phase should deliver:

1. contract fixtures for filesystem discovery, config, companion rules, manifest generation, and type generation
2. generated-app verification for `pnpm create dawn-app`, install, typecheck, build, `dawn verify`, `dawn routes`, and `dawn typegen`
3. limited execution smoke for one `graph.ts` app and one `workflow.ts` app
4. normalized reporting with machine-readable output
5. CI integration that separates fast structural confidence from slower smoke checks

## Deferred Scope

These belong after the framework harness is stable:

- downstream-repo-first testing workflows
- richer scenario execution under `dawn test`
- dataset-driven evals
- approvals and memory simulation
- browser or UI automation beyond narrow necessity
- a public testing SDK
- local-registry and dist-tag release verification

## Research Basis

This design is aligned with current primary-source guidance:

- Vitest recommends `test.projects` for multi-project test organization and mixed test environments.
- Next.js distinguishes unit-style testing from higher-level runtime and end-to-end concerns, and does not recommend forcing unsupported runtime cases into Vitest.
- pnpm and npm both support the `create-*` initializer model, which supports `pnpm create dawn-app` backed by `create-dawn-app`.
- npm package and publish guidance makes tarballs the correct package artifact boundary for publish-equivalent testing.
- local registries such as Verdaccio are appropriate for release-level install-by-name and dist-tag verification.

## Open Questions

These do not block the design, but they should be resolved during planning:

- whether `dawn verify` should expose a formal `--artifacts-dir` flag in v1
- how much of the harness should be surfaced through root scripts versus package-local commands
- whether smoke execution should target a direct Node entrypoint first or an HTTP server boundary first

## Recommendation

Adopt the layered framework harness as the v1 testing architecture.

Do the work in this order:

1. contract fixture foundation and normalized reporting
2. generated-app verification with tarball-backed package consumption
3. `dawn verify` CLI integration
4. limited execution smoke
5. CI lane separation
6. local registry channel verification in the next release-hardening phase

This keeps the public surface small, hardens the framework where it is currently weakest, and creates a clean growth path toward broader `dawn test` capabilities without overbuilding the first iteration.
