# Dawn Website Accuracy Sweep Design

**Status:** Proposed
**Primary audience:** Application developers building and operating Dawn apps

## Goal

Make the current Dawn website trustworthy again before changing its information
architecture. This first pull request corrects examples, contracts, security
claims, runtime guidance, and generated discovery content that have drifted from
the implementation.

The pull request is deliberately an accuracy sweep, not a documentation
reorganization. A second pull request will reorganize the material around the
application-developer journey and address page size, navigation, and missing
guides.

## Source of truth

Documentation claims will be checked against the current implementation,
public exports, generated starter, and tests. When the implementation has an
important limitation, the docs will state the observable contract and the
limitation rather than infer a stronger guarantee.

Examples that readers can copy will use the actual route input shape, stream
payload shape, tool policy behavior, and supported runtime versions. Where a
claim cannot be validated cheaply, the wording will be narrowed instead of
preserving an absolute promise.

## In scope

### 1. Repair copy-and-run examples

- Correct dynamic-segment route inputs in the typed-state and migration
  guidance. Route parameters are provided in the request input; Dawn does not
  inject them from the URL.
- Update streaming examples to send agent `messages`, parse the runtime's raw
  JSON string chunks, and ignore SSE heartbeat comments safely.
- Replace the misleading route-level “tool retry” recipe with guidance that
  distinguishes model/agent retries from retries implemented inside a tool.
- Correct route-dispatch examples so their request and state shapes match the
  runtime contracts and authored APIs.

### 2. Correct capability and security contracts

- Describe the tools inherited by top-level agents and subagents accurately,
  including shared authored tools, route-authored tools, capability tools, and
  explicit policy filters. Remove the false least-privilege claim.
- Remove access-control examples that request a second approval for tools that
  already have workspace permission gates.
- Explain matching precisely: bash, path, and memory patterns use prefix
  matching, while the reserved `tool` and `subagent` keys match exactly. Only
  an `always` decision is added to the configured permissions store; `once` and
  `deny` are not persisted, and static config entries are not copied into the
  built-in runtime store.
- Add the trust-boundary warning for writable `workspace/AGENTS.md`: its content
  is re-read as persistent prompt context and can affect every Dawn `agent()`
  route and subagent that consumes app-level prompt fragments.
- Distinguish Docker's disabled network from Kubernetes NetworkPolicy. The
  Kubernetes policy permits DNS, depends on the cluster network plugin, and is
  not a universal “zero egress” guarantee.

### 3. Align runtime, deployment, and persistence guidance

- Replace LangSmith-only and local-only statements with separately qualified
  development, Dawn HTTP runtime, and generated LangGraph build targets.
- Explain where middleware runs and call out the generated LangGraph entrypoint
  as the exception to Dawn's HTTP runtime middleware.
- Correct disconnect and cancellation behavior: AG-UI aborts on disconnect;
  Agent Protocol runs continue unless explicitly cancelled.
- Document the current runtime endpoints, memory-candidate endpoints, and SSE
  heartbeats without preserving a stale endpoint count.
- Update Dawn package and self-hosted Node examples to the Node 24+ baseline and
  the current marker-aware Dockerfile behavior. Document the current generated
  LangSmith target separately: it still emits `node_version: "22"`, so the
  website must not present that path as verified against Dawn's Node 24+ package
  requirement until the implementation mismatch is resolved outside this PR.
- Add a prominent single-replica/scaling caveat. Shared Postgres stores do not
  make the in-process run gate and cancellation registry distributed.
- Narrow edge-runtime support claims so optional file-backed capabilities that
  deactivate without the marker filesystem are visible to readers.
- Correct LangSmith deployment descriptions to distinguish the capabilities
  included in generated graphs from the Dawn HTTP, AG-UI, and sandbox services
  that are not included.

### 4. Reconcile memory, testing, eval, inspector, and reference facts

- Remove contradictions in memory lifecycle, required `remember` input, ID
  derivation, and SQLite versus approximate pgvector retrieval guarantees.
- Correct testing examples that describe a reset thread as multi-turn, explain
  live versus mocked model use consistently, and document harness lifecycle
  constraints needed for reliable tests.
- Correct eval recording claims and programmatic examples, and surface the
  shipped memory scorers.
- Correct an existing Inspector, configuration, API, testing, or eval reference
  entry only when its omission or wording makes an existing example, exhaustive
  list, or contract false. New public-surface coverage and general reference
  parity are deferred to the second pull request. The shipped memory scorers are
  added only if the existing scorer inventory presents itself as exhaustive.

### 5. Update website discovery surfaces

- Refresh the landing-page quickstart, website assistant prompts, `llms.txt`,
  and `llms-full.txt` source content so they no longer teach a LangSmith-only
  product or collapse the target-specific Node contracts into one baseline.
- Treat documentation pages, prompts, and templates as the normative current
  reference. Historical blog posts are not rewritten in this pull request;
  `llms-full.txt` will clearly label the Blog section as historical and
  non-normative rather than presenting old post bodies as current contracts.
- Audit the blueprints served by `dawn add` as website discovery content.
  Replace the Docker blueprint's obsolete LangGraph-CLI flow and “no standalone
  server” claim with the current `node` target's generated `server.mjs` and
  marker-aware Dockerfile behavior. Remove single-default-deploy wording from
  the Docker and OpenTelemetry blueprints.
- Align the Getting Started tree and test count with the current default
  scaffold while keeping the page focused on the shortest successful path.
- Add small documentation checks for the highest-risk drift points: public
  runtime endpoints, supported Node baseline, and generated discovery content.

## Out of scope

- Navigation changes, page renames, page splits, or a new information
  architecture.
- New conceptual guides for production topology, deployment-target selection,
  runtime embedding, or security architecture. The first pull request may add
  concise caveats to existing pages; the second will create or reorganize the
  durable guides.
- A full rewrite of Memory, Deployment, Sandbox, Configuration, or API.
- Body-text search, generated API/configuration reference tooling, or broad
  executable-snippet infrastructure.
- Runtime behavior changes, including the streaming retry delay discrepancy.
- README cleanup in example applications unless a website page directly embeds
  or depends on that content.

## Editorial rules

1. Lead with the task an application developer is trying to complete.
2. State public behavior before implementation detail.
3. Prefer a small support matrix or explicit limitation over “same,” “only,”
   “automatic,” or “zero” when behavior differs by target.
4. Keep one canonical explanation for each contract and link to it from other
   pages instead of repeating long caveats.
5. Make the minimum local edit required for accuracy. Do not opportunistically
   shorten, reorder, rename headings, move sections, add conceptual sections, or
   change navigation.

## Verification

Before content edits begin, the implementation plan will establish a closed
claim ledger with these columns: `page/source`, `false claim or broken example`,
`implementation/test authority`, `minimal replacement`, and `verification`.
Only ledgered corrections are eligible for this pull request; newly discovered
content expansions move to the second pull request unless they block safe use.

The change is complete when:

- Every claim-ledger row is resolved and no unlisted content expansion is
  included.
- Every repaired request, route, and stream example matches the current runtime
  types and wire format.
- Capability, permission, network, persistence, cancellation, and deployment
  statements match the implementation and tests.
- Human and machine-facing docs distinguish target-specific contracts: Dawn's
  packages and self-hosted Node target require Node 24+, while the generated
  LangSmith target currently emits `node_version: "22"`. The LangSmith path is
  documented as an unresolved compatibility limitation rather than presented as
  verified compatible.
- Served blueprints contain none of the stale claims that Dawn lacks a
  standalone server, LangSmith is the single default deployment target, or the
  current Dawn Node image should derive from the old LangGraph API image.
- Targeted docs drift checks cover the most consequential corrected claims.
- `pnpm ci:validate` passes from the repository root in the isolated feature
  worktree. The pull-request changesets check must also pass; no changeset is
  expected unless publishable package code changes, which are out of scope.

## Follow-up pull request

After this accuracy sweep lands, the application-developer journey rebuild will
reorganize the docs around getting started, building, integrating, testing,
operating, and deploying. It will split oversized pages, introduce the missing
production-topology and deployment-target guidance, and simplify navigation.
