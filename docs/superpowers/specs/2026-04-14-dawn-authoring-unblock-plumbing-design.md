# Dawn Authoring-Unblock Plumbing Design

## Goal

Define the minimum CLI/runtime plumbing bar required to unblock real Dawn authoring work.

This is not a public-launch-ready v1. It is a narrower stabilization milestone:

- freeze the Dawn app/project contract that the next authoring layer will depend on
- remove known scaffold/install ambiguity
- freeze the current config/discovery contract
- declare the plumbing layer stable enough for authoring design and implementation to proceed

## Why This Exists

The repository has made strong progress on the lower layers:

- filesystem discovery and route identity
- route validation and type generation
- route execution and local dev runtime
- runtime and packaged-consumer harness coverage

But the current implementation still proves more about CLI/runtime mechanics than about the intended higher-level Dawn thesis as a meta-framework around LangChain, LangGraph, and Deep Agents.

Before a real authoring layer is designed, the Dawn app/project contract needs to stop moving.

If it does not, then:

- authoring APIs will encode unstable project-shape assumptions
- scaffolding and fixtures will drift from the authoring contract
- local runtime and execution semantics will keep leaking filesystem details upward

This design narrows the work to the two stabilization lanes that matter most for unblocking authoring:

1. scaffold and install shape
2. config and discovery stability

## Scope

This plumbing milestone covers:

- the canonical Dawn app creation paths
- the supported Dawn app filesystem contract
- the supported `dawn.config.ts` subset
- route discovery and route identity stability
- the minimum verification needed to trust these assumptions during authoring work

This plumbing milestone does not cover:

- broader authoring abstractions over LangChain, LangGraph, or Deep Agents
- deployment/runtime hosting concerns
- LangSmith tracing or observability abstractions
- a larger template catalog
- migration tooling
- generalized public-launch polish

## Success Definition

Plumbing v1 for authoring is complete when the next authoring plan can safely assume:

- there is a canonical way to create a Dawn app
- there is a canonical way for contributors to bootstrap a Dawn app against the local repo
- Dawn’s supported config/discovery rules are explicit and tested
- route identity and route-shape rules are stable enough to become authoring inputs
- the authoring layer does not need to reopen foundational project-shape questions

## Lane A: Scaffold And Install Shape

### Objective

Make Dawn app creation deterministic for both:

- external package consumers
- contributors building the next authoring layer against the local monorepo

### Current State

The repository already has:

- `create-dawn-app`
- `pnpm create dawn-app` as the intended public initializer path
- the `basic` template
- packaged-app and publish smoke coverage

But the current contributor-local bootstrap story still has edge conditions:

- internal-mode scaffold/install behavior depends on file-based package specifiers
- path resolution can vary with workspace topology and temp directory semantics
- repo-local verification has already exposed real ambiguity between “external-user path” and “internal contributor path”

These are not theoretical issues. They affect whether the next authoring layer can trust the app shape it is built against.

### Required Outcome

At the end of this lane, Dawn should have exactly two explicit scaffold/install stories:

#### 1. External canonical path

The public path is:

- `pnpm create dawn-app`
- install dependencies in the scaffolded app
- run Dawn commands from that generated app

This path should be treated as the canonical user contract and must keep working without repo-local assumptions.

#### 2. Contributor-local canonical path

The local authoring-development path is:

- generate a Dawn app against the local repository on purpose
- install it in a way that is stable for contributors
- run `dawn verify`, `dawn run`, `dawn test`, and `dawn dev` against it

This path does not need to be the same as the public consumer path, but it must be:

- explicit
- documented for contributors
- repeatable in CI or harness coverage
- free of hidden shims or manual patch-up steps

### Acceptance Bar

This lane is complete when:

- one canonical external scaffold path is documented and verified
- one canonical contributor-local scaffold path is documented and verified
- the supported starter template is treated as contract, not just sample content
- package specifier behavior is explicit in both modes
- no known path-resolution or workspace-topology bug remains in the authoring-development path

### Deferrals

This lane intentionally does not require:

- multiple templates
- richer starter scenarios
- generalized workspace migration logic
- launch-grade initializer ergonomics beyond the supported paths above

## Lane B: Config And Discovery Stability

### Objective

Freeze what counts as a Dawn app and what counts as a Dawn route for the next authoring layer.

### Current State

Dawn already has a meaningful contract here:

- app discovery from a project root
- `src/app` as the default routes root
- `appDir` support
- route groups and private-segment handling
- collision detection
- route typing and identity derivation

That is a strong base. The remaining problem is not lack of implementation. It is that these rules need to be treated as frozen authoring inputs rather than just current CLI behavior.

### Required Outcome

At the end of this lane, Dawn should have an explicit supported subset for:

#### Dawn app definition

A Dawn app is defined by:

- project root with `package.json`
- `dawn.config.ts`
- a supported routes root (`src/app` by default, `appDir` when supported)

#### Dawn config definition

The supported `dawn.config.ts` subset must be documented and tested as a frozen narrow contract.

For this milestone, that means:

- `appDir` is the only guaranteed supported option
- accepted shapes are explicit
- unsupported expression patterns are treated as outside the contract rather than “possibly works”

#### Dawn route definition

A Dawn route is defined by stable rules around:

- route directories
- route groups
- private segments
- exactly one primary executable entry
- route identity and pathname derivation
- stable collision/error semantics

### Acceptance Bar

This lane is complete when:

- the supported `dawn.config.ts` subset is explicit and fixture-backed
- route discovery rules are explicit and fixture-backed
- pathname and route-id derivation are treated as stable outputs
- collision and invalid-layout errors are stable enough for authoring tools to depend on
- no near-term authoring plan needs to reopen what a route is or how it is found

### Deferrals

This lane intentionally does not require:

- broader configuration expressiveness
- richer config evaluation
- new executable entry kinds
- wider routing conventions unless authoring immediately depends on them

## Required Verification For This Milestone

The plumbing-unblock milestone needs a smaller, sharper verification bar than a public launch.

It should prove exactly the assumptions authoring will rely on.

### Required checks

#### Scaffold/install verification

Verification should explicitly cover:

- the canonical external scaffold path
- the canonical contributor-local scaffold path
- the generated route shape the next authoring layer will target
- command availability in the generated app

#### Config/discovery verification

Verification should explicitly cover:

- supported `dawn.config.ts` subset
- `appDir` stability
- valid/invalid route directory shapes
- stable route identity and pathname outputs

#### Runtime confidence check

The plumbing milestone does not need broader runtime expansion, but it must keep the existing minimum confidence:

- `dawn verify`
- `dawn run`
- `dawn test`
- `dawn dev`

must still operate correctly against the canonical authoring-development app shape

## What This Milestone Declares Stable

When this work is done, the following should be treated as stable for the next authoring project:

- Dawn app root definition
- supported config subset
- route discovery rules
- route identity derivation
- canonical scaffold/install paths for both public and contributor-local flows

That does not mean “unchangeable forever.” It means “stable enough that the next authoring layer should build on them instead of redesigning them.”

## What This Milestone Explicitly Does Not Declare Stable

The following should remain out of scope for this plumbing freeze:

- backend-neutral authoring semantics
- Deep Agents integration
- LangChain-first authoring contracts
- advanced eval/tracing abstractions
- deployment/runtime hosting abstractions
- broad public CLI ergonomics beyond the authoring-unblock bar

Those belong to the next phase.

## Recommendation

Implement this as a focused stabilization project with two tasks:

1. freeze scaffold/install shape
2. freeze config/discovery shape

Then explicitly declare the result “plumbing v1 for authoring” and move immediately into a real authoring design plan.

This keeps Dawn from over-investing in lower-layer polish while still ensuring the next authoring layer has a stable foundation.
