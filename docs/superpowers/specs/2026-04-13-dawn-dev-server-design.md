# Dawn Dev Server Design

Date: 2026-04-13
Status: Proposed
Owner: Dawn

## Summary

Dawn now has a stable route-behavior contract for:

- in-process `dawn run`
- server-backed `dawn run --url`
- `dawn test`
- framework runtime parity
- downstream packaged-app runtime verification

The next gap is local lifecycle. Dawn can target a running server, but it does not yet own a local runtime command that developers can boot, watch, and iterate against.

This design introduces `dawn dev` as Dawn’s only lifecycle command. It owns local development runtime behavior and nothing else:

1. discover the Dawn app from `cwd`
2. serve the whole app locally
3. expose the same `POST /runs/wait` contract Dawn already uses for server-backed execution
4. watch source and restart on change
5. stay transport-compatible with the production Agent Server / LangSmith deployment path

## Problem

Dawn currently has a split local story:

- `dawn run` executes routes directly in-process
- `dawn run --url` assumes some compatible server already exists
- `dawn test` can assert server-backed behavior, but only against a supplied URL or fake server

That leaves three concrete gaps:

1. Dawn does not own the local lifecycle command that developers will actually use day to day.
2. The server-backed contract can drift because Dawn does not yet serve it itself in local development.
3. Real served parity coverage is limited because most server-path tests still target fake servers or external assumptions.

Without a Dawn-owned local runtime command, the project risks:

- weak local ergonomics
- drift between in-process and served execution
- a murky boundary where `dawn run` starts taking on lifecycle concerns
- accidental reinvention of deployment/runtime ownership that should remain with Agent Server and LangSmith

## Goals

- Add `dawn dev` as the single Dawn-owned local lifecycle command.
- Discover the app from `cwd` and serve the whole app.
- Expose the same `POST /runs/wait` contract locally that Dawn expects in server-backed execution.
- Reuse Dawn’s existing route identity and normalized execution-result contract.
- Watch relevant app files and restart on change for correctness.
- Add real served parity coverage against `dawn dev`.
- Keep Dawn aligned with Agent Server / LangSmith rather than creating a second runtime model.

## Non-Goals

- Creating a production serving command.
- Owning deployment or hosted runtime concerns.
- Introducing a Dawn-specific local transport protocol.
- Adding hot module replacement or partial in-process route reload in v1.
- Broadening `dawn dev` into a general-purpose server platform.

## Design Principles

- Dawn owns local lifecycle only.
- Production runtime ownership remains with Agent Server / LangSmith.
- `dawn dev` serves the same contract that `dawn run --url` already targets.
- `dawn run` executes once; `dawn test` asserts behavior; `dawn dev` owns lifecycle.
- Prefer correctness over cleverness for watch behavior.
- Keep local and production transport boundaries as close as possible.

## Command Boundary

`dawn dev` is the only Dawn-owned lifecycle command.

Responsibilities:

- discover the app from `cwd`
- resolve and serve all discovered routes in the app
- expose a local HTTP endpoint for execution
- watch relevant files
- restart cleanly on change
- print the local base URL developers should target with `dawn run --url`

Non-responsibilities:

- deployment
- production hosting
- LangSmith runtime ownership
- alternate local-only execution protocols
- one-shot execution semantics already owned by `dawn run`

The command split becomes:

- `dawn dev`
  - local lifecycle
  - watch and restart
  - local HTTP runtime
- `dawn run`
  - one execution
  - in-process by default
  - optional `--url` against a running runtime
- `dawn test`
  - assertions/scenarios over the run contract

## Local Server Contract

`dawn dev` should serve a narrow local HTTP API whose primary execution surface is:

- `POST /runs/wait`

This is intentionally the same transport contract Dawn already assumes for server-backed execution.

The local request contract should remain:

```json
{
  "assistant_id": "/support/[tenant]#graph",
  "input": {
    "tenant": "acme"
  },
  "metadata": {
    "dawn": {
      "mode": "graph",
      "route_id": "/support/[tenant]",
      "route_path": "src/app/support/[tenant]/graph.ts"
    }
  },
  "on_completion": "delete"
}
```

The local server should:

1. resolve the mode-qualified `assistant_id`
2. map it back to the discovered route entry
3. execute the route in-process
4. return the same server-facing result shape Dawn already expects to normalize

V1 should stay narrow. It may add a health/readiness endpoint for startup coordination, but `/runs/wait` is the primary contract.

## Route Registry

At startup, `dawn dev` should discover the full app and build an in-memory route registry.

Each registry entry should include:

- `routeId`
- `routePath`
- `mode`
- resolved route file
- mode-qualified `assistant_id`

Mode-qualified identifiers remain:

- `${routeId}#graph`
- `${routeId}#workflow`

This keeps Dawn’s local server aligned with:

- `dawn run --url`
- `dawn test` server scenarios
- runtime harness parity checks
- future deployed compatibility against Agent Server-backed runtimes

## Process Model

V1 `dawn dev` should use a parent/child process design.

Parent process responsibilities:

- CLI entrypoint
- file watching
- restart coordination
- user-facing logs
- stable port ownership

Child process responsibilities:

- app discovery
- route registry construction
- local HTTP server
- `/runs/wait` handling
- route execution

Why this split:

- watcher concerns stay separate from execution concerns
- restart behavior is easier to reason about
- stale module state is less likely to survive reloads
- failures in local serving are easier to isolate and recover from

## Watch And Restart Model

V1 should optimize for correctness:

- watch relevant app and config files
- restart the child server process on change
- keep the transport contract stable across restarts

Watched inputs should include:

- `dawn.config.ts`
- `graph.ts`
- `workflow.ts`
- `route.ts`
- `state.ts`

Additional files can be added where they directly affect served execution semantics, but the first version should avoid trying to infer every possible support file relationship.

V1 should not attempt:

- hot module replacement
- partial route reload
- structural-vs-nonstructural diffing

Restart-on-change is slower, but easier to make correct against the transport contract we care about.

## Port And URL Model

`dawn dev` should bind to localhost on a deterministic port.

V1 should support:

- default local port
- optional `--port`

Startup output should clearly print the base URL, for example:

```txt
Dawn dev server listening at http://127.0.0.1:3020
```

That URL should be immediately usable with:

```bash
echo '{"tenant":"acme"}' | dawn run src/app/support/[tenant]/graph.ts --url http://127.0.0.1:3020
```

## Error Handling

`dawn dev` should keep two error classes separate.

Startup / lifecycle errors:

- app discovery failures
- invalid config
- port binding failures
- route registry construction failures

These should fail the command directly and print clear CLI diagnostics.

Request-time execution errors:

- unsupported assistant ids
- malformed `/runs/wait` payloads
- execution failures inside a route

These should be surfaced through the local server contract and normalized by the client-side Dawn execution path the same way remote server responses already are.

This separation keeps:

- lifecycle failures in `dawn dev`
- execution failures in the run contract

## Testing And Verification

`dawn dev` needs three layers of coverage.

### CLI command coverage

Verify that `dawn dev`:

- discovers the app from `cwd`
- starts successfully on a stable port
- exposes `/runs/wait`
- maps mode-qualified assistant ids correctly
- restarts on source change

### Framework served parity coverage

Extend runtime coverage so a small canonical matrix runs against a real `dawn dev` server:

- passing `graph.ts`
- failing `graph.ts`
- passing `workflow.ts`
- failing `workflow.ts`

Assert parity between:

- direct execution
- `dawn run`
- `dawn run --url` against `dawn dev`

### Downstream packaged-app coverage

For packaged generated apps and the handwritten external fixture:

- start `dawn dev`
- run `dawn run --url`
- run `dawn test` server scenarios
- confirm the same contract outside the framework repo boundary

## Risks

- If `dawn dev` exposes local-only HTTP behavior, local and production will drift.
- If watch/restart behavior is flaky, parity tests will become nondeterministic.
- If `dawn dev` starts owning deployment semantics, Dawn will blur its framework boundary.
- If Dawn tries partial reload too early, restart correctness will become hard to trust.

## Recommendation

Implement `dawn dev` as a Dawn-owned local development server with:

- whole-app serving from `cwd`
- `POST /runs/wait` as the primary execution contract
- parent/child watcher architecture
- restart-on-change behavior
- explicit local-only lifecycle ownership

Do not add production serving or deployment behavior. Dawn should own local development runtime semantics while staying transport-compatible with the Agent Server / LangSmith path used in deployment.
