# @dawn-ai/sdk

## 0.8.25

## 0.8.24

## 0.8.23

### Patch Changes

- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.

## 0.8.22

### Patch Changes

- a530e70: Documentation only: this package gains a canonical API reference on dawnai.org
  and a concise npm entrypoint. No runtime behavior changed. (`dawn docs` also
  now discovers every registered detailed API page.)
- 3c68800: Raise `DAWN_E1005` at request time for gated features a runtime cannot serve,
  instead of ignoring them silently. A runtime with no filesystem fallbacks — the
  shape an edge deployment has — now reports a configured `sandbox` block, a
  configured `toolOutput` block, and any route whose skills were recorded at build
  time, naming each feature and its config key. Previously the build gate was the
  only defense, so an entry composed by hand over `@dawn-ai/cli/fetch` never ran
  it and those settings did nothing at all.

  Node behavior is unchanged: the guard fires only when a runtime supplies no
  filesystem fallbacks, and every Node path supplies them, so an app that
  configures a sandbox, tool-output offloading or skills keeps working exactly as
  before.

  **Action may be required:** `dawn build` and `dawn check` now also reject
  `toolOutput` for the `hono` target, so a build that passed before can now fail.
  If your `dawn.config.ts` sets `toolOutput` and your `build.targets` includes
  `"hono"`, that build stops with `DAWN_E1005` naming the key; remove
  `toolOutput`, or drop `"hono"` from `build.targets` and deploy with the `node`
  target, which serves offloading normally. An empty `toolOutput: {}` configures
  nothing and is not rejected. Nothing is lost by removing it: offloading spills
  oversized tool results to a file under `workspace/`, and the edge has no
  filesystem, so it never ran there. It was the only gated feature whose config is
  plain JSON, which is why it slipped through — the other gated keys are live
  objects that get stripped at the build boundary, while these were inlined into
  the bundle intact and then ignored at runtime. Node deployments are unaffected.
  See the upgrade note at https://dawnai.org/docs/upgrading.

  `dawn check` now also detects a stale `.dawn/build/modules.edge.mjs` when `hono`
  is a configured target. An app building for `hono` alone emits no
  `modules.mjs`, so the staleness pass previously did nothing for it and a
  renamed or deleted route shipped in a stale bundle with no warning.

  `DAWN_E1005`'s registry title broadens from "Feature unsupported by the build
  target" to "Feature unsupported by the build target or runtime", since the code
  now has a request-time producer.

- f317dd7: Fail loudly when middleware is present but cannot be loaded, and load it
  correctly on Windows.

  The middleware probe wrapped every candidate import in a bare `catch {}`, so a
  `src/middleware.ts` that threw while being imported — a missing environment
  variable, an ESM/CJS interop break, a syntax error, an unresolved dependency —
  was indistinguishable from an app with no middleware at all. The server started,
  reported healthy, and served every gated Agent Protocol endpoint ungated, with
  no log line anywhere.

  **If your middleware file has been quietly broken, this release turns that into
  a startup failure.** Dawn now decides existence before importing, and a
  middleware file that exists but cannot be loaded exits with `DAWN_E3004`, naming
  the file and the underlying cause. In `dawn dev` the watcher restarts the child
  once you fix it; under `dawn start` or a built `server.mjs` the process exits
  non-zero, so a deploy fails its health check instead of shifting traffic onto an
  ungated server. Existence is probed with `lstat`, and only `ENOENT`/`ENOTDIR`
  count as absent, so an unreadable middleware file is no longer read as "this app
  has none". An app with no middleware file is unaffected.

  Two related fixes ride along. The probe no longer falls through to a later
  candidate when an earlier one fails, so a broken `src/middleware.ts` can no
  longer silently bind a `middleware.ts` at the app root instead. And the dynamic
  import now builds a `file://` URL rather than handing Node's ESM loader a raw
  path: on Windows that path is a drive letter, which the loader rejects as an
  unknown protocol, and the old `catch {}` swallowed it — middleware never ran on
  Windows. It does now, so a Windows app with a middleware file that was inert
  will start gating requests.

  A middleware file that exports no middleware function is still ignored rather
  than fatal, because the built manifest binds the same way, but it now warns on
  stderr and names the file.

- 3c68800: **`RouteConfig` is documented as reserved — Dawn reads none of its fields.**

  `runtime`, `streaming` and `tags` are accepted on a route's exported `config`,
  type-checked, normalized onto the route module and carried into the static build
  manifest, and then nothing branches on any of them. The API docs described
  effects none of them has: `runtime` did not pin a route to an execution
  environment (the node/edge split comes from `build.targets` and is never decided
  per route), `streaming` did not switch on token streaming (the endpoint the
  caller hits decides that), and `tags` were not displayed by the Dev Server UI or
  anywhere else.

  The fields are kept rather than removed — deleting a published field breaks
  every app that set one and buys nothing — but they now carry JSDoc saying they
  are reserved and have no effect, and the API reference says the same. If they
  gain behavior it will be additive.

- d42774e: **Breaking:** scenario files must default export `scenarios("<route>")` from
  `@dawn-ai/sdk/testing`. A plain default-exported array now throws
  `RunScenarioLoadError` at load; wrap the array in `scenarios("/route")` to
  migrate.

  Add route-scoped fluent `dawn test` scenarios with generated application-tool
  types, invocation-local in-process tool mocks, and declarative mock call
  assertions.

- 984c3ad: Thread endpoints can now be authorized with a `src/thread-access.ts` policy.

  `defineThreadAccess` answers a different question from route middleware — may
  this caller create, read, mutate or destroy this thread — and is keyed on the
  thread object rather than on route identity, because a thread has no owning
  route. Five endpoints that previously ran no middleware at all are gated by it:
  `POST /threads`, `GET /threads/:thread_id`, `GET /threads/:thread_id/state`,
  `POST /threads/:thread_id/cancel` and `DELETE /threads/:thread_id`. A read
  denial answers the same 404 a genuine miss answers, so a policy cannot be used
  to enumerate thread ids, and a `delete` is authorized even when the row is
  missing so a 403 cannot confirm that a thread exists.

  The policy loader is fail-closed, unlike the middleware probe: a
  `thread-access.ts` that exists but cannot be imported or binds no usable policy
  fails the boot with `DAWN_E3003` rather than degrading to "no gate". An app with
  no policy file behaves exactly as before, and every boot logs which layer the
  policy came from, or that there is none.

  `dawn build` now fails with `DAWN_E1005` for the `langsmith` target while a
  policy file exists, because that runtime cannot carry the hook. The `node`,
  `hono` and `vercel` targets are unaffected: `node`'s emitted server probes the
  policy at boot, and the bundled web targets carry it in their static manifest.

  One behavior change applies with or without a policy: `POST /threads` drops the
  reserved `dawn:access` key from client-supplied `metadata`. That key holds the
  server-issued access stamp, so a client can never write one — including in an
  app that adopts a policy later.

  `POST /threads/:thread_id/cancel` now binds its cancel to the run the caller
  observed, so a cancel can no longer land on a later run of the same thread; when
  the observed run has already finished it answers the existing
  `409 no_run_in_flight`.

  `@dawn-ai/testing` gains `createThreadAccessHarness` for unit-testing a policy
  without booting a server, and `createAgentProtocolInjector` accepts a
  `threadAccess` policy.

  The run endpoints — `/runs/stream`, `/runs/wait`, `/resume` and `/agui` — plus
  `GET /threads/:thread_id/pending_interrupts` are gated on this policy too.

- 496b54c: Add `resuming` to `ThreadAccessRequest`: a required boolean that is `true` when
  the request carries a resume credential and will continue a parked turn. A
  policy that ignores it behaves the same for resumed and ordinary turns.

  A policy that wants resumes treated differently from ordinary turns — step-up
  auth, a second approver, extra logging — should check `req.resuming` rather than
  `req.operation`. Two endpoints resume, and only one of them says so in its
  operation: `POST /threads/{thread_id}/resume` reports `run.resume`, but a
  `POST /agui/{routeId}` carrying a `resume` array reports `run.agui`, exactly as
  an ordinary AG-UI turn does. The request body is the only thing that separates
  them, and a policy never sees it, so keying the rule on `operation` leaves every
  AG-UI resume ungoverned.

  `resuming` is `false` everywhere else and never absent, so no policy needs
  `?? false`. An endpoint that gates more than once for one request — the gate
  before its side effects, the mid-flight recheck, the implicit create's recheck —
  reports the same value at every site.

  `createThreadAccessHarness().check()` accepts an optional `resuming`, defaulting
  to `false`.

- 67030fa: Thread access now authorizes the run endpoints and the pending-interrupts read.

  Two things to know about the shipped surface.

  **`ThreadOperation` includes `"thread.pending_interrupts"`**, under
  `action: "read"`. An exhaustive `switch` or mapped type over the union must
  handle every member.

  **Ten endpoints are gated on the thread-access axis**, including
  `POST /threads/:id/runs/stream`, `/runs/wait`, `/resume`,
  `POST /agui/:routeId` and `GET /threads/:id/pending_interrupts`. The hazard to
  watch is a policy whose `fallback` returns a bare `{ allow: false }`, or denies
  any operation it does not recognize: it denies these endpoints too, where route
  middleware alone used to decide. Read your `fallback` before
  upgrading. A `run.*` operation on a thread that exists arrives under
  `action: "update"`; on a thread id with no row yet, `run.stream`, `run.wait` and
  `run.agui` arrive under `action: "create"` — see the companion note on stamping
  the implicit create, which lands in the same release. A policy that permits
  `update` for the thread's owner therefore needs one more decision than it did
  before: what its `create` handler should answer for a thread id the client
  picked. `run.resume` never creates and is always an `update`.

  These gates compose with route middleware as AND rather than replacing it;
  middleware still answers "may this caller run this route" and keeps doing the
  per-caller work it does today. An app with no policy file is unaffected.

  `POST /threads/:id/resume` and `GET /threads/:id/pending_interrupts` gate
  **before** middleware rather than after it, so on those two a caller who would
  have received a middleware `401` now receives a thread-access deny — a `403` on
  `/resume`, a `404` on `/pending_interrupts`. That is forced: both resolve the
  route identity middleware would authorize against out of the thread's own
  metadata, so gating after middleware would mean reading a thread the caller is
  not yet authorized to read. On `/resume` it also stops a denied caller taking
  the thread's resume claim, which was a denial of service against a parked turn
  that needed no credential, and reading the `400`/`409` codes as an oracle on a
  guessed `interruptId`/`resumeKey`. A `/pending_interrupts` deny returns the
  handler's own `404 thread_not_found`, indistinguishable from a genuine miss.

  `dawn build --target hono` and `--target vercel` bundle the policy into the
  static module manifest and run it on those runtimes exactly as `dawn dev` does.
  A build that saw a policy file stamps that fact into its entry point, and boot
  fails when such an entry point is paired with a manifest carrying no
  thread-access entry — a stale manifest would otherwise come up with every thread
  endpoint open and nothing to say so. `--target langsmith` refuses with
  `DAWN_E1005`, permanently: it materializes per-route graphs with no Dawn HTTP
  layer to run a policy in.

  `create-dawn-app` templates now carry a deny-by-default `src/thread-access.ts`
  and the shared `src/auth.ts` it imports, both as `.example` files that a rename
  activates. They ship inert because a deny-by-default policy denies every request
  from a caller the app cannot yet authenticate.

  `@dawn-ai/testing`'s `runThreadsStoreConformance` gains two cases, both
  properties the access stamp depends on: a `createThread` on an id that already
  exists never applies the caller's metadata, and `updateMetadata` leaves a
  top-level key its patch does not name intact. Custom `ThreadsStore`
  implementations should re-run the kit.

- 730b136: Threads created implicitly by a run endpoint are now stamped with the caller who
  created them.

  `POST /threads/:id/runs/stream`, `/runs/wait` and `POST /agui/{routeId}` create
  the thread when the id they were given names no row. That create wrote no
  metadata, so the row carried no access stamp — and two things followed from
  that.

  **A policy's legacy branch means only "created before the policy existed"
  again.** `thread.access === undefined` is the branch an app writes when it
  adopts a policy on an existing store, usually admin-only or backfilled. Because
  an unstamped row could be manufactured on demand — by naming any thread id at a
  run endpoint — that branch had quietly widened to "predates the policy, **or**
  was created by anyone a moment ago", which turns a permissive legacy branch
  (the common shape mid-rollout) into an escalation path. The implicit create now
  carries the stamp your `create` handler returns, so the branch means what it
  says.

  **The caller who created a thread can take a second turn on it.** Previously the
  row it had just made read back with no owner, so a policy that authorizes
  against `thread.access` denied its own author from turn two onward. This is the
  flow `POST /agui/{routeId}` drives, since CopilotKit picks its `threadId` in the
  browser and never calls `POST /threads`.

  **`run.*` operations can now arrive under `action: "create"`.** When the row is
  absent, `run.stream`, `run.wait` and `run.agui` are asked under `create` — then
  again as the `update` recheck that follows every create, the same two-step
  `thread.create` already used. The `operation` is unchanged throughout; only the
  `action` differs. `run.resume` is untouched: it requires an already-parked
  thread and creates nothing.

  Read your `create` handler before upgrading. It now decides runs on thread ids
  the client picked, not just `POST /threads`, and the stamp it returns is what
  every later turn on those threads authorizes against. A policy that denied
  `create` outright — or that relied on `update` seeing `thread: undefined` for a
  first turn — changes behavior here. Ownership of a client-chosen id is first
  come, first served: whoever names an unused id is stamped as its owner and can
  hold it against the caller who meant to use it. Mint ids with `POST /threads`
  if that matters; those are server-generated and nobody can call them first.

  The `update` recheck is not optional and is not a stamp comparison. Two callers
  can both find the row absent, and a store that upserts on collision hands the
  loser the winner's row; Dawn re-authorizes the row that actually came back
  before the run proceeds. Comparing the minted stamp with the returned one would
  not catch it — a `permit()` with no stamp leaves both sides `undefined`.

  An app with no policy file is unaffected: the implicit create still passes the
  thread id and nothing else, with no extra gate call and no extra store read.

  The scaffolded `src/thread-access.ts` gains the AG-UI flow as a consequence: its
  `create` handler stamps an authenticated caller, so a browser-chosen `threadId`
  is served and stays served. Its commentary, and the thread-access docs, are
  updated to match.

## 0.8.21

### Patch Changes

- c2c19da: **New `hono` build target — a Dawn app that deploys to Cloudflare Workers.**

  `build: { targets: ["node", "hono"] }` makes `dawn build` emit an edge deploy
  alongside the usual ones: `.dawn/build/app.mjs` (a Hono app whose single
  catch-all hands every request to Dawn's web-standard fetch handler,
  `export default`ed — the shape Workers, Vercel and Bun all accept),
  `modules.edge.mjs` (the static module manifest, free of node builtins),
  `stores.mjs` (a per-request Postgres store factory), and a `wrangler.toml`
  scaffold at the app root. `wrangler deploy` is how you ship it; a gated CI lane
  boots those same artifacts under local workerd and shows them serving Agent
  Protocol and AG-UI with durable state in Postgres. No deploy to Cloudflare's
  platform has been exercised — see the caveats at the end of this note.

  The scaffold carries a bare `name` / `main` / `compatibility_date` and **no
  `nodejs_compat`**: the bundle links zero `node:` specifiers, so the flag would
  buy nothing, and setting it would mask a regression in the work that made the
  bundle node-free. A gated `edge-workerd` CI lane boots the emitted artifacts
  under real workerd — the same binary Cloudflare runs — with that `wrangler.toml`
  untouched, and drives four sequential AG-UI turns against Postgres over a
  `@neondatabase/serverless` WebSocket pool.

  The target is **opt-in and never a default**, because the edge serves a subset
  of Dawn rather than all of it.

  - **The stores are built per request, and that is not stylistic.** A pool held at
    module scope hands request N+1 an idle WebSocket bound to request N's dead I/O
    context; the request then hangs until workerd cancels it, in an alternating
    pattern that fails about half of all requests with nothing thrown. So
    `stores.mjs` builds the pool and all three stores inside the factory and ends
    the pool on dispose, with a module-scope flag recording that this isolate has
    already migrated so per-request instances do not re-run three migration
    transactions each time. That pool also gets an `'error'` listener:
    `@neondatabase/serverless` vendors `pg-pool` _and_ the `events` polyfill, so an
    idle client's failure re-emits on the pool and the shim throws when nothing is
    listening — the same uncaught-exception hazard node `pg` has, and one that
    `nodejs_compat` being off does nothing to remove. A per-request pool is still
    exposed: a client sits idle between every pair of store queries, and pg-pool's
    idle listener outlives `end()`.
  - **`requestStores`**, a new option on `createRuntimeFetchHandler`, is the seam
    that makes that possible: a `(request) => RequestStores` factory whose every
    field is optional and falls through to the boot-resolved store when omitted.
    `RequestStores` is exported from `@dawn-ai/cli/fetch`.
  - **The build fails, by name, on anything the edge cannot serve** — with the new
    `DAWN_E1005`, and reporting every offending feature at once rather than one
    build at a time: `sandbox`, `backends.filesystem`/`backends.exec`, a
    config-supplied `checkpointer` / `threadsStore` / `permissions.store` /
    `memory.store`, a `workspace/` directory, route skills, and route-level
    long-term memory. The store cases matter most: those handles cannot cross a
    build boundary, so before the gate the generated Postgres store quietly took
    their place. `dawn check` applies the identical gate whenever `hono` is a
    configured target.
  - **The provider import map is exhaustive or the build fails.** A bundler cannot
    follow a variable import specifier, so `app.mjs` emits a static `switch` over
    the model packages the app can reach; whatever is missing from it is missing
    from the bundle. A route that will not import, or an agent whose provider
    cannot be inferred, is therefore an error rather than a silently narrower map,
    and `summarization.model` is included.
  - **`dawn build` warns on stderr** when `@dawn-ai/cli`, `@dawn-ai/postgres-storage`,
    `@neondatabase/serverless` or `hono` is missing from the app's `package.json`.
    None of them is a dependency of `@dawn-ai/cli`, deliberately: the CLI does not
    import them, the app it generates does.
  - **Your config is inlined into `app.mjs` at build time**, minus every field that
    cannot survive a build boundary, rather than loaded from `dawn.config.ts` at
    runtime as the `node` target does. Keep secrets in bindings, not in config.

  Also new, both in service of the emitted entry: `seedModelImporter` and
  `providerPackages` from `@dawn-ai/langchain` (re-exported from
  `@dawn-ai/cli/fetch`), and `DAWN_E5301` on a runtime that reaches a store no
  layer supplied.

  Full walkthrough, the supported subset, and an explicit list of what the CI lane
  does **not** settle — no real Cloudflare deploy, Hyperdrive, production
  connection limits, per-query latency, cross-isolate cold starts, and the bundle
  size and startup CPU that `wrangler deploy` enforces and `wrangler dev --local`
  does not — are in the Deployment docs under Edge runtimes.

- c2c19da: Per-request stores are now disposed only after BOTH the response body has
  settled and the run that request started has released its slot. Route work
  outlives its response on three paths — an aborted AG-UI stream, an abandoned
  `/runs/wait`, a cancelled AP stream — and all three keep writing through the
  stores a response-triggered teardown would have closed. `close()` also waits
  for in-flight disposals, so a host awaiting shutdown knows the pools are shut.

  A runtime that reaches a store no layer supplied now answers with a 500 that
  names the missing store and carries the new `DAWN_E5301` code, instead of a
  generic failure with nothing to diagnose.

## 0.8.20

## 0.8.19

## 0.8.18

### Patch Changes

- c6b08a9: Add keyed, parent-owned subagent delegation policies with fail-closed
  constraints and approval. Subagents now run as native resumable LangGraph
  subgraphs, and interrupt resume uses one complete multi-entry request envelope.

  This intentionally removes array-form subagent registration, tool policy on
  the internal `task` mechanism, and scalar interrupt resume. Confirm the fixed
  0.x patch release intent with Brian before release.

## 0.8.17

### Patch Changes

- 713797f: Purge `node:` imports from the edge module graph (deploy-anywhere B3, PR 2a).

  A bundle built from `@dawn-ai/cli/fetch` now links **zero** `node:` specifiers —
  previously it linked 33 of them (including `node:fs` and `node:child_process`)
  via Dawn's own supporting packages. Because static imports resolve when a module
  graph is instantiated, those edges made the bundle require a `node:` shim layer
  (Cloudflare Workers with `nodejs_compat`) even though the injected request path
  never called them. The artifact is now runtime-agnostic, verified by an esbuild
  purity test that bundles on the `neutral` and `browser` platforms with no `node:`
  externals and asserts an empty graph, plus a negative control proving the check
  still fails against the CLI entry.

  **Node-only exports moved to `/node` subpaths.** They are unchanged in behavior;
  only the import specifier differs:

  - `@dawn-ai/core` → `@dawn-ai/core/node`: `discoverRoutes`, `findDawnApp`,
    `assertDawnRoutesDir`, `extractToolSchemasForRoute`, `extractToolTypesForRoute`,
    `registerTsxLoader`
  - `@dawn-ai/permissions` → `@dawn-ai/permissions/node`: `createPermissionsStore`
  - `@dawn-ai/workspace` → `@dawn-ai/workspace/node`: `localFilesystem`, `localExec`

  **New:** `@dawn-ai/sdk/pure` (pure path/hash helpers, parity-tested against
  `node:path`/`node:crypto`); `@dawn-ai/core` gains `registerConfigLoader` and the
  `DawnConfigLoader` type; `@dawn-ai/core/node` gains `registerNodeConfigLoader`,
  `loadDawnConfigUncached`, and `nodeLoadRouteDescription`. `CapabilityMarkerContext`
  gains optional `backendFactories` and `loadRouteDescription` — capability markers
  no longer reach for node implementations by static import, and throw a named error
  when a runtime supplies neither an instance nor a factory.

  **Behavior change:** `createWorkspaceFs` now requires an absolute, POSIX-normalized
  `workspaceRoot` and throws a named error otherwise. Previously a relative root
  silently resolved against `process.cwd()`. Every in-repo caller already passes an
  absolute path; the host lane canonicalizes before calling core. This is
  fail-closed — it cannot widen the workspace path jail, only reject earlier and
  more loudly.

## 0.8.16

### Patch Changes

- 2da55fa: Require Node 24 (the active LTS) everywhere. npm 10 — bundled with Node 22 —
  cannot install Dawn's scaffold dependency graph (its resolver crashes), while
  Node 24's bundled npm ≥ 11 installs it correctly and ships `node:sqlite`
  unflagged. All packages now declare `engines.node >= 24`, `create-dawn-ai-app`
  refuses to scaffold on older Node with an actionable message, `dawn verify`'s
  runtime preflight enforces the same floor, and the `dawn build` node target
  uses a `node:24-slim` base. Scaffolded apps also no longer declare
  `@dawn-ai/core` as a direct dependency — nothing in a generated app imports it
  (it arrives transitively via the CLI and SDK).

## 0.8.15

## 0.8.14

## 0.8.13

### Patch Changes

- 5bbd6e3: Add a `recursionLimit` option to `agent()`. It maps to LangGraph's per-run
  super-step ceiling (default 25), so deep agents — a coordinator that dispatches
  subagents and makes many tool calls — can raise the limit instead of aborting
  with a recursion error.
- 628d1c3: Wire `DAWN_E` error codes into `dawn verify`'s runtime preflight. Add
  `DAWN_E5101` ("Node version below the supported floor") to the error-code
  registry, and surface it (or `DAWN_E2002` for an unreachable sandbox daemon)
  on a failed `dawn verify` runtime check — in both the CLI's `[CODE] See <docs>`
  line and the `--json` output's `runtime.node.code` / `runtime.docker.code`
  fields.
- 18df470: Add a central `DAWN_Exxxx` error-code registry in `@dawn-ai/sdk` and surface
  codes on the failure channels. `CliError` now carries an optional `code` and the
  CLI prints `[CODE] See <docs>`; HTTP/SSE error bodies gain optional `code`/`docsUrl`;
  permission denials returned as tool results are prefixed with `[DAWN_E3001]`.
  The high-value families are wired (`dawn check` config errors, sandbox
  unavailable, permission denied, missing model provider / unknown model id, and
  tool-file shape errors), and a generated `/docs/errors` reference page is guarded
  against drift. Additive and backward-compatible.

## 0.8.12

## 0.8.11

## 0.8.10

## 0.8.9

### Patch Changes

- d3d94af: Argument-level tool constraints: `agent({ tools: { constrain: { deployProd: (args, ctx) => … } } })` runs a per-tool predicate against the model's arguments at call time, returning allow / deny-with-reason / `{ approve: true }` (escalate to the HITL prompt). Predicates may be async and receive a read-only policy context; a throwing or off-contract predicate fails closed. The tool run context now also carries the live `threadId` + route params. `dawn check` validates `constrain` tool names and warns on `approve`/`constrain` overlap.

## 0.8.8

## 0.8.7

## 0.8.6

### Patch Changes

- 1d51b75: Per-tool approval gating: `agent({ tools: { approve: ["deployProd"] } })` makes any named tool require a HITL permission prompt per call (`kind: "tool"` interrupt). Decisions persist name-level under the reserved `tool` key in `.dawn/permissions.json` (exact-name matching); pre-approve via `permissions.allow.tool`. `dawn check` validates `approve` names and warns on overlap with the internally-gated workspace tools, `deny`, and the unsupported `task` case.

## 0.8.5

## 0.8.4

## 0.8.3

### Patch Changes

- 2744a5c: Add long-term memory. Routes gain a typed, cross-session memory collection via
  `defineMemory({ kind, scope, schema })` in `memory.ts` — the agent gets generated
  `remember`/`recall` tools backed by a namespaced `@dawn-ai/memory` store
  (node:sqlite, deterministic keyword+recency recall). Plus route-local `memory.md`
  profile injection and a `dawn memory` CLI (list/search/inspect/approve/reject/forget).
  Writes default to a `candidate` queue (config `memory.writes`). Ships the `semantic`
  kind; vector recall, episodic/procedural kinds, and the dev inspector UI are deferred.
  The research scaffold template now ships a `memory.ts`/`memory.md` example.
- 7339ded: Tool scoping: `agent({ tools: { allow, deny } })` restricts which tools a route's agent may call. `deny` revokes a tool; `allow` grants a withheld capability tool; deny wins.

  **Behavior change (pre-1.0):** subagents are now least-privilege by default — a subagent gets only its own route-local `tools/*.ts`; ambient capability tools (`writeFile`, `runBash`, `task`, `writeTodos`, `remember`/`recall`, …) are withheld unless named in `tools.allow`. A subagent that relied on inheriting these must add `tools: { allow: [...] }`. `dawn check` validates scope names. This scopes the tool surface, not execution (not a sandbox).

## 0.8.2

## 0.8.1

## 0.8.0

### Minor Changes

- Unknown model ids now get advisory warnings instead of late provider 404s. `dawn check`/`verify` warn (exit code unchanged) when an agent route's `model` isn't in the curated list for its resolved provider (`openai`, `google`, `anthropic`, `xai`), with did-you-mean suggestions; the runtime prints the same `[dawn:models]` advisory once per model at chat-model construction. Curated lists are values now (`CURATED_MODEL_IDS` etc.) with types derived, Anthropic and xAI ids included; `validateModelId` and `inferProvider` are exported from `@dawn-ai/sdk`. Note: the narrow `GoogleModelId` union dropped the vendor-retired `gemini-3-pro-preview` (replaced by `gemini-3.1-pro-preview`).

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward.

## 0.7.0

### Minor Changes

- a38ff61: Sandboxed `ctx.fs` for route tools and workflow/graph entries. Tools and route entries now receive a `WorkspaceFs` handle (`readFile`, `readBinaryFile`, `writeFile`, `listDir`) that resolves paths against the route's `workspace/` directory and runs the same permission gate as the agent-facing workspace tools — no more dropping to `node:fs`. The permission gate is extracted to a shared core module; in execution contexts where interactive prompts can't appear (workflow/graph entries), outside-workspace access fails closed with guidance to add an allow rule.

## 0.6.0

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.0

### Minor Changes

- 1005b3a: Add provider-aware agent materialization. Agent configs can now carry an optional `provider`, and the LangChain runtime infers providers for known model families or lazy-loads the explicit provider integration package for built-in provider IDs.
- e8462db: `agent({...})` now accepts an optional `reasoning: { effort }` field. Maps to OpenAI's `reasoningEffort` parameter (`none | minimal | low | medium | high | xhigh`). Non-reasoning models silently ignore it. Useful for tool-use-heavy agents that aren't following directives at the default reasoning depth.

### Patch Changes

- 82dd52f: Correct package README links and CLI/runtime examples, export the SDK reasoning type, and fix `dawn build` agent deployment entry generation.

## 0.1.8

### Patch Changes

- 8c63c1a: Move testing helpers to `@dawn-ai/sdk/testing`.

  `expectError`, `expectMeta`, `expectOutput`, and the `RuntimeExecutionResult` type family now live at `@dawn-ai/sdk/testing` — the canonical home users have been intuitively reaching for. The old `@dawn-ai/cli/testing` subpath continues to work as a re-export for back-compat (and is now JSDoc-deprecated).

  ```ts
  // Preferred
  import { expectError, expectMeta, expectOutput } from "@dawn-ai/sdk/testing";

  // Still works (re-exports from sdk)
  import { expectError, expectMeta, expectOutput } from "@dawn-ai/cli/testing";
  ```

  No behavior change. The packed runtime contract test now exercises both subpaths.

## 0.1.7

### Patch Changes

- db635b1: Docs overhaul.

  - **Public package READMEs** (`@dawn-ai/sdk`, `@dawn-ai/cli`, `create-dawn-ai-app`) fleshed out with overview, install, key APIs, and links to the website.
  - All package READMEs include the Dawn brand image header.

  No code or runtime behavior changes — README content only.

- db635b1: Middleware context now flows through to tools.

  A tool's second argument is now `{ middleware?: Readonly<Record<string, unknown>>, signal: AbortSignal }`. Whatever the global middleware passes via `allow({ ... })` is available to every tool invocation as `ctx.middleware` — for both `/runs/wait` and `/runs/stream` paths.

  Example:

  ```ts
  // src/middleware.ts
  export default defineMiddleware(async (req) => {
    const userId = await verifyToken(req.headers.authorization);
    return allow({ userId });
  });

  // src/app/.../tools/lookup.ts
  export default async (input, { middleware }) => {
    const userId = middleware?.userId;
    return await db.lookup(userId, input);
  };
  ```

- db635b1: Production readiness: deployment config, LLM retry, request middleware.

  - **@dawn-ai/sdk:** `agent()` descriptor now accepts an optional `retry: { maxAttempts, baseDelay }`. Adds `defineMiddleware`, `reject(status, body?)`, `allow(context?)` for request middleware, plus `MiddlewareRequest`, `MiddlewareResult`, and `RetryConfig` types.
  - **@dawn-ai/cli:** `dawn build` produces a correctly-shaped `langgraph.json` for LangGraph Platform (`dependencies: ["."]`, `env` as file path). `dawn verify` adds an advisory `deps` check (4 checks total). Dev server loads `.env` files and runs middleware before route execution.
  - **@dawn-ai/langchain:** Per-agent retry config (`maxAttempts`, `baseDelayMs`) is wired through the agent adapter and applies to streaming and non-streaming paths.

## 0.1.6

## 0.1.5

## 0.1.4

## 0.1.3

## 0.1.2

## 0.0.2

### Patch Changes

- 5c18b2d: Fix workspace:\* protocol leaking into published package dependencies.

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.
