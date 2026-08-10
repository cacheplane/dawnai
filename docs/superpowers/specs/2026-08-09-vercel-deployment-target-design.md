# First-Class Vercel Deployment Target Design

**Status:** Approved 2026-08-09; native-fixture reconciliation approved 2026-08-09

## Summary

Dawn's opt-in `hono` build target emits a web-standard Hono application that
links cleanly for Vercel, but Vercel does not discover the generated
`.dawn/build/app.mjs` at that location and Dawn has never executed it on the
platform. The documentation therefore describes Vercel compatibility as an
inference rather than a supported deployment path.

Add an opt-in `vercel` target that emits Vercel Build Output API v3 artifacts.
The target will package the same static, web-standard Dawn runtime used by the
`hono` target as a Node 24 Vercel Function and route the full Agent Protocol
surface to it. One output supports both clean-checkout builds initiated by a
Git-connected Vercel project and local `vercel deploy --prebuilt` deployments.

Prove both paths with credential-free structural and execution tests plus a
credentialed CI lane that creates two native preview deployments, drives real
stateful and streaming Agent Protocol requests, and removes the previews.

## Goals

- Make Vercel an intentional Dawn deployment target rather than an inferred
  property of another target.
- Support a Git-connected Vercel project building a clean checkout with no
  committed `.dawn/**` or `.vercel/output/**` artifacts.
- Support a local `dawn build` followed by `vercel deploy --prebuilt`.
- Make both flows consume the same Build Output API artifact contract.
- Run the generated function on Vercel's Node 24 runtime with Fluid compute.
- Prove real Agent Protocol persistence, incremental SSE delivery, and
  subsequent-request behavior on native Vercel infrastructure.
- Preserve user-owned Vercel project metadata and authored configuration.
- Keep the existing `hono`/Cloudflare behavior and evidence unchanged.

## Non-Goals

- Adding Vercel to Dawn's default build targets.
- Replacing the `hono` target or its Wrangler scaffold.
- Targeting Vercel's legacy Edge Runtime. The generated function uses the Node
  runtime, which supports the Web Fetch API and Fluid compute.
- Adding Vercel-specific application APIs, caching, image optimization,
  middleware, cron configuration, or observability features.
- Proving the Vercel Git provider's webhook delivery. The lane proves the
  clean-checkout remote-build contract the integration invokes; webhook
  delivery is Vercel-owned infrastructure.
- Supporting a checked-in Build Output directory. Generated output remains
  disposable and ignored.
- Adding Bun or Deno runtime coverage in this change.

## Existing State and Gap

The `hono` target currently writes:

```text
.dawn/build/app.mjs
.dawn/build/modules.edge.mjs
.dawn/build/stores.mjs
wrangler.toml
```

`app.mjs` default-exports a Hono application. The emitted module graph is
tested for Node-builtin purity, exercised under `@hono/node-server` on every CI
run, and exercised under real workerd in a gated lane. Those tests establish a
portable runtime surface, but not Vercel packaging or execution.

Vercel's zero-configuration Hono detection only recognizes fixed root and
`src/` entry names. It does not discover `.dawn/build/app.mjs`. A user must
therefore invent a wrapper, routing, and build configuration before the
existing artifact can deploy. The documentation correctly labels Vercel as
unobserved, but the product story stops there.

Vercel's Build Output API is the platform contract intended for framework
authors. It also provides the common artifact consumed by hosted source builds
and `vercel deploy --prebuilt`, so it avoids maintaining a root-entry wrapper
path and a separate prebuilt path.

## User Experience

An app opts in explicitly:

```ts
import { config } from "@dawn-ai/cli"

export default config({
  build: { targets: ["vercel"] },
})
```

It may combine this target with independent targets such as `node` or
`langsmith`. Selecting both `hono` and `vercel` is valid but redundant unless
the same app deploys to both Cloudflare and Vercel.

### Git-connected deployment

The developer runs `dawn build` once when enabling the target and commits the
generated root `vercel.json` scaffold. Vercel then performs:

```text
clean checkout -> install -> dawn build -> consume .vercel/output
```

Pushing a tracked branch causes the connected Vercel project to run that build
and deploy the resulting function. Neither `.dawn/**` nor
`.vercel/output/**` is committed.

### Local source deployment

Running `vercel deploy` uploads source and asks Vercel to execute the same
configured build remotely. This is the CLI equivalent of the Git-connected
clean-checkout build contract.

### Local prebuilt deployment

Running:

```text
dawn build
vercel deploy --prebuilt
```

uploads the already-generated `.vercel/output` without sharing source for a
second build. Runtime environment variables remain deployment inputs rather
than build-time substitutions, so the prebuilt artifact contains no database
or provider credentials.

## Target Architecture

Register `vercel` beside the existing build targets and add it to the public
target-name types, validation, CLI help, and generated documentation. It stays
out of `DEFAULT_BUILD_TARGETS`.

Refactor the host-neutral parts of the `hono` target into a focused internal
emitter rather than copying generated runtime templates. Both targets use the
same logic for:

- edge-capability validation;
- static route, tool, state, middleware, and provider discovery;
- `modules.edge.mjs` generation;
- per-request Neon/Postgres store construction and disposal;
- runtime-environment seeding; and
- the Hono catch-all around `createRuntimeFetchHandler`.

The `hono` target continues to publish those files under `.dawn/build` and to
own `wrangler.toml`. The `vercel` target stages equivalent runtime files only
as inputs to its bundle and owns Vercel output and configuration. Shared code
must not make the Vercel target emit a Wrangler scaffold or make the Hono target
emit Vercel files.

## Build Output Contract

The published tree is:

```text
.vercel/output/
├── config.json
└── functions/
    └── index.func/
        ├── .vc-config.json
        └── index.mjs
```

`.vc-config.json` declares:

- `runtime: "nodejs24.x"`;
- `handler: "index.mjs"`; and
- `launcherType: "Nodejs"`.

`index.mjs` is a self-contained ESM bundle whose default export exposes the
generated Hono app through Vercel's Web Fetch API function contract. The bundle
includes Dawn runtime packages, the statically discovered application modules,
Hono, the Postgres stores, the Neon driver, and statically identified model
provider packages. It must not rely on files above `index.func`, because the
Build Output API packages a function directory as its filesystem boundary.

`@dawn-ai/langchain` keeps its ordinary Node variable-import fallback behind a
package-internal `#default-model-importer` condition. The Vercel bundle selects
`dawn-static-provider-imports` (and preserves esbuild's `module` condition), so
only a loader-free fallback enters the function while the generated entry
continues seeding its statically discovered provider map. Ordinary Node imports
still select the dynamic default. If application code constructs a model at
module scope before the generated entry can seed the static map, the function
fails with targeted guidance instead of retaining an unresolved runtime import.
Every condition target is a packed `dist` artifact; the published import map
never points at unshipped source.

Some bundled CommonJS dependencies access Node builtins with literal
`require(...)` calls. The first esbuild pass uses an internal compatibility
plugin that intercepts only esbuild `require-call` resolutions whose literal
specifier is a recognized Node builtin. It canonicalizes bare builtin names to
`node:*` and routes each through a CommonJS wrapper that statically
default-imports the canonical `node:*` module and assigns that imported value to
`module.exports`. This preserves the callable or object value returned by
CommonJS `require`, rather than substituting an ESM namespace object. `module`
and `node:module` are never bridged. Nonliteral requires and unresolved or
external nonbuiltins remain fail-closed.

The plugin has one narrow optional-peer rule for `pg`. It applies only when the
importer resolves inside the real `pg` package boundary, the owning
`package.json` declares `name: "pg"`, and the importer-relative path is exactly
`lib/native/client.js`. The same manifest must declare a string
`peerDependencies["pg-native"]` range and
`peerDependenciesMeta["pg-native"].optional === true`. Only then does that
file's literal `require("pg-native")` resolve to a lazy CommonJS stub whose
evaluation throws an error with code `MODULE_NOT_FOUND`, accurately modeling an
absent optional native binding. No other importer or import kind receives that
stub: direct `pg-native` use remains unsupported and fails the build.
Credential-free bundle execution proves the ordinary JavaScript `pg.Pool` path
works, `pg.native` resolves to `null`, and `NODE_PG_FORCE_NATIVE` fails with the
expected missing-module error.

This compatibility pass does not weaken or replace
`validateVercelOutput`. The independent post-bundle validation pass remains
unchanged: it still rejects `module`/`node:module`, nonliteral runtime
dependencies, unbundled nonbuiltins, virtual inputs, and dependencies that
escape the function-directory boundary.

`.vercel/output/config.json` uses Build Output API version 3 and routes every
request path and method to the single `index` function. Agent Protocol paths
must remain unchanged; there is no `/api` prefix or application rewrite visible
to clients.

The bundle targets Vercel's Node runtime, but continues importing Dawn's
web-standard runtime and structurally typed Postgres entry points. It must not
switch back to the node-only dynamic filesystem loader or SQLite. Node is the
host, not an excuse to create a different application contract.

## Transactional Output Ownership

The target owns `.vercel/output` only when selected. It never removes the
`.vercel` directory, `.vercel/project.json`, downloaded environment settings,
or other project metadata.

Build all output in an invocation-unique staging directory inside `.vercel`.
Validate the complete staged tree before publishing it. Publication uses an
exact backup-and-rename sequence:

1. Rename an existing `.vercel/output` to an invocation-owned backup.
2. Rename the complete staging directory to `.vercel/output` on the same
   filesystem.
3. Remove the backup after publication succeeds.
4. If publication fails, restore the exact backup and report the original
   failure, preserving any rollback error as additional context.

Any failure before publication leaves the previous output untouched. Cleanup
may remove only staging and backup paths created by the current invocation.
This prevents a failed bundle from leaving a directory that looks deployable
but is missing code, configuration, or routing.

Invocation-directory cleanup is part of the reported result, but never replaces
the target's primary failure. A cleanup-only failure after publication reports
that final output remains valid and leaves the invocation directory for
inspection. When target execution and cleanup both fail, the target failure is
the `AggregateError` cause and first contained error; the cleanup error is the
second contained error, and the message names the retained invocation path.

## Root Vercel Configuration

When no root `vercel.json` exists, the target writes a minimal scaffold:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "node node_modules/@dawn-ai/cli/dist/index.js build",
  "fluid": true
}
```

The explicit Node entry matches Dawn's existing deployable examples and avoids
depending on a package-manager-specific binary shim.

`fluid: true` is part of the target's lifecycle contract, not an optimization
left to a project's age or Dashboard defaults. Vercel supports this
deployment-level setting for Node functions, and an explicit file value takes
precedence over project defaults. It gives every source and prebuilt deployment
the same concurrency model even when the connected project predates Vercel's
Fluid-by-default rollout.

The root file is a user-owned, committed deployment input after creation. Dawn
never overwrites an existing file. If one exists, the target parses and
preserves it, writes Dawn's recommended reference to
`.dawn/build/vercel.json`, and warns only when it cannot establish that the
authored configuration runs Dawn's build. The warning explains that Vercel
Dashboard build settings may satisfy the build-command contract and names both
files for reconciliation; it does not claim the deploy is broken when that
cannot be known locally.

An authored `fluid: false` conflicts directly with the target's supported
lifecycle and fails the build with an explanation. An omitted `fluid` setting
preserves the file but warns that Dawn cannot guarantee the deployment-level
contract from source; the reference file includes `fluid: true`. This is not
silenced by a Dashboard default because the committed deployment should be
portable between old and new Vercel projects.

An invalid existing `vercel.json` fails with its path and parse error because
Vercel itself cannot consume it. Extra valid user settings remain authoritative.

The app templates add `.vercel/` to their generated `.gitignore`. Existing
apps are told to ignore `.vercel/` in the deployment guide. `vercel.json`
remains at the root and is therefore not covered by that directory rule.

## Environment and Persistence

The artifact reads configuration at function invocation time. At minimum the
generated store factory requires `DATABASE_URL`. The native lane uses a
dedicated hosted Postgres/Neon database supplied as a protected secret. The
fixture route is deterministic and model-free, so the lane does not require a
model-provider credential and cannot fail because of model availability or
cost.

Per-request pools, migrations, error listeners, disposal barriers, and runtime
environment reads retain the same semantics already tested by the Hono and
workerd lanes. A subsequent request is mandatory in the Vercel lane because
Fluid compute can reuse one function instance across requests; a one-request
smoke would miss the class of cross-request lifecycle failure previously found
under workerd.

## Credential-Free Verification

Fast tests run on every contributor machine and every PR, including forks:

1. A target-registry test proves `vercel` is known, opt-in, combinable with
   other targets, and rejected consistently when misspelled.
2. Target tests inspect the complete Build Output API tree, v3 routing, Node 24
   function metadata, and artifact report.
3. The generated function bundle is imported and driven with Web Requests in a
   Node 24 process, proving its handler shape and streaming body without using
   Vitest aliases.
4. A negative control removes or corrupts required output metadata and proves
   the structural verifier fails.
5. Root-config tests prove create-once behavior, preservation of authored
   settings, reference-file output, actionable warnings, and invalid-JSON
   failure.
6. Publication tests inject failures before and during publication and prove
   the prior output is retained or restored while unrelated `.vercel` files
   remain untouched.
7. Bundle tests prove the function is self-contained within `index.func` by
   copying only that directory and importing it from a new location.

Tests are written red first. Generated-code assertions execute the output or
parse the platform JSON; comments and source-string matches are not accepted as
proof of runtime behavior.

## Native Vercel CI Lane

Add a `vercel-native` job to `.github/workflows/ci.yml`. It runs on
same-repository pull requests and `main`, uses Node 24 and the repository's
pinned pnpm version, and is attached to a protected `vercel-preview`
environment. Fork pull requests receive no secrets and rely on the complete
credential-free suite.

The environment supplies:

- `DAWN_VERCEL_TOKEN`;
- `DAWN_VERCEL_ORG_ID`;
- `DAWN_VERCEL_PROJECT_ID`; and
- `DAWN_VERCEL_DATABASE_URL`.

The lane does not call `POST /assistants/search`: Dawn's current web runtime
does not expose that endpoint, and adding a new public Agent Protocol surface is
outside this target's scope. Instead, successful dispatch of the fixture's
exact route keys through the existing run endpoints proves that the deployed
static registry contains them. An unknown route key is the negative control
and must return `404`.

The job derives the recursive local `@dawn-ai/*` runtime dependency closure
from the fixture's direct Dawn dependencies by following `dependencies`,
`optionalDependencies`, and non-optional `peerDependencies`. It packs exactly
that closure from the branch under test and assembles two isolated fixture
copies using only relative vendored tarballs. A fixture-local package-manager
override pins every vendored Dawn package to its matching tarball. Each lockfile
must contain every expected Dawn package exactly once from the matching
`file:vendor/<tarball>` and no unexpected Dawn package. Validation rejects
registry or semver resolution, `workspace:`, `link:`, absolute paths,
repository or shared-assets paths. Both fixture manifests set
`"packageManager": "pnpm@10.33.0"`.

The source fixture removes or never creates `node_modules`, then rejects every
symlink recursively across its exact uploaded tree. The prebuilt fixture's
frozen pnpm install is allowed to create its normal `node_modules` symlinks;
validation instead rejects every symlink recursively within its `vendor/` and
`.vercel/output/` upload surfaces. This is required because the workspace's
fixed development version can be ahead of the registry; uploaded source and
prebuilt output cannot use an external workspace link or checkout path.

The fixture exports three deterministic, model-free routes:

- `/state#agent` is a raw compiled LangGraph `StateGraph`, exported as the
  named `agent` entry. It defines inline `messages`, `visits`, and `markers`
  annotations with summing/appending reducers and compiles against a
  module-lifetime `DawnPostgresSaver`. The fixture owns a small Node `pg.Pool`
  (`max: 2`, 10-second connection, 30-second idle, 5-second query and statement
  timeouts, and an explicit pool error listener) and passes it to the saver.
  Construction performs no query or migration at module evaluation, so
  Vercel's source-build discovery does not require `DATABASE_URL`; connections
  and migrations remain lazy at runtime.
- `/stream#agent` is a raw legacy Runnable that emits one meaningful token,
  waits on a run-specific Postgres barrier with a finite overall deadline and a
  per-query deadline race, emits a second token, then supplies a root
  `on_chain_end` result that Dawn exposes as the public `done` event.
- `/release#graph` performs a parameterized update constrained by the exact
  barrier identifier and `released = false`, returns the identifier through
  `RETURNING`, and succeeds only when exactly one returned row matches the
  requested identifier. The statically emitted fixture middleware requires an
  unguessable, run-specific header for this route and allows ordinary fixture
  traffic.

For each fixture, the harness generates a 32-byte random release value and
retains the raw base64url form only in the black-box client's memory. It embeds
only `SHA-256(rawReleaseValue)` in the generated middleware. The middleware
hashes the presented header and uses Node's constant-time byte comparison
against that digest before allowing `/release`; missing, malformed, or
mismatched values return `401`. The raw value is never placed in fixture source,
the function bundle, an environment variable, a manifest, a receipt, a log, or
an artifact. The generated digest is nonsecret and is not accepted as the
request credential.

Raw agent inputs are normalized to `{ messages: HumanMessage[] }`. The state
markers and stream barrier identifier are therefore carried as the sole user
message content and read from the latest message; arbitrary top-level input
fields are not treated as evidence. The fixture declares its generated-runtime
imports, direct imports, and required peers explicitly: `@langchain/core`
`1.2.5`, `@langchain/langgraph` `1.4.9`, `@langchain/langgraph-checkpoint`
`1.1.3`, `@neondatabase/serverless` `1.1.0`, `hono` `4.12.28`, `pg` `8.22.0`,
and `zod` `4.4.3`. It does not rely on dependencies hoisted from the repository
CLI install.

The route-owned saver writes the same default `public.dawn_checkpoints` and
`public.dawn_writes` tables, empty checkpoint namespace, and serialization
format that the generated request-scoped saver reads. Thus two runs through
`/state#agent` followed by the generated `GET /threads/:id/state` exercise a
writer and reader created by different parts of the deployed bundle. This
route-owned pool is intentionally scoped to one Fluid function module and is
not closed per request; Vercel instance teardown owns its socket lifetime.

Every operation invokes the absolute package-local binary at
`packages/cli/node_modules/.bin/vercel`; root `pnpm exec`, `npx`, and ambient
`PATH` resolution are forbidden. Before any external operation, the lane runs
that binary's version command under Node 24 and requires stdout exactly
`58.9.0\n` plus stderr exactly
`Vercel CLI 58.9.0 (Node.js <current-Node-version>)\n`.
Every CLI invocation passes an absolute job-owned `--global-config` directory
created with owner-only permissions. The directory and its ancestors must be
regular, non-symlink paths separate from both fixtures. Every CLI call uses a
direct argument array rather than a shell, so ambient user configuration and
cached authentication cannot participate.

Each fixture contains a regular, non-symlink `.vercel/project.json` with
exactly the `orgId` and `projectId` supplied by the protected environment, and
the harness rejects any ambient or mismatched link.

This lane requires a team-owned dedicated project:
`DAWN_VERCEL_ORG_ID` must match `^team_[A-Za-z0-9]+$` and
`DAWN_VERCEL_PROJECT_ID` must match `^prj_[A-Za-z0-9]+$`. Personal-account
ownership is not inferred by omitting scope. Every REST helper uses the fixed
`https://api.vercel.com` origin, disables redirects, has a finite timeout, and
selectively parses only the fields required by this contract.

Before either deployment, and again before cleanup, the harness makes an
in-process authenticated `GET /v9/projects/<projectId>?teamId=<orgId>` Vercel
API request. A valid response must have the exact expected `id` and
`accountId`. Its optional `rootDirectory` must be absent or exactly `null`, and
the harness normalizes either representation to `null`; any string, including
the empty string, or any other type fails. This matches pinned CLI `58.9.0`'s
no-root behavior while preventing it from replacing the explicit local
configuration with a config below a remotely configured project root. The
dedicated project must allow its short-lived preview URLs to be reached by the
black-box client without an interactive protection challenge. It contains only
the deterministic fixture and test data; production projects are out of scope.

Vercel can force an empty project's first deployment to the production target
even when the CLI explicitly requests preview. Provisioning therefore retains
one inert static bootstrap deployment in this dedicated project, marked only
with `dawnVercelBootstrap=v1`, with domain assignment skipped and no Dawn route
or database credential in its deploy command. Before enabling the lane, a
separate disposable `--target preview` probe must receive authoritative target
`null` or `preview`, then be deleted by exact ID with a `404` readback. The
bootstrap is external project state, never lane evidence. Reconciliation filters
only `dawnVercelRun`, so neither test cleanup nor fallback cleanup may select or
delete the retained bootstrap.

The harness constructs every child environment from a sanitized base. It
removes all inherited names beginning `DAWN_VERCEL_`, `VERCEL_`, or `NOW_`, as
well as `DATABASE_URL` and every release-token alias, before adding only the
values that operation needs. Every CLI child explicitly sets
`VERCEL_TELEMETRY_DISABLED=1` and `NO_UPDATE_NOTIFIER=1`. The version and
local-build children receive no deployment credential. Deploy, inspect, and
log children receive child-only
`VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID`; deploy alone also
receives child-only `DATABASE_URL` and the valueless pair `--env DATABASE_URL`,
which pinned CLI `58.9.0` resolves from its environment. SQL operations receive
only the database credential. In-process Vercel API calls put the token only in
the `Authorization` header. No token, database credential, or release-header
value appears in argv. Every credentialed deploy, inspect, and log invocation
passes `--scope <expected-org-id>` because pinned CLI `58.9.0` does not derive
`getScope()` from the fixture link for every command. The expected organization
ID and the log command's `--project <expected-project-id>` are the only
protected scope values allowed in argv, and command metadata is redacted before
reporting. Debug mode is forbidden for every credential-bearing command.

The source build receives no database credential as a build environment
variable, and the prebuilt artifact is inspected before deploy to prove the
value was not substituted into `index.mjs`. All successful and failed child
stdout and stderr are captured rather than inherited. Before any console
output, persistence, or throw, the harness applies the same redactor across
message, stack, command metadata, stdout, stderr, API request metadata, and API
error bodies. Generated function files and uploaded diagnostic artifacts reject
raw and URL-encoded forms of every protected value and the release-header
value, including after otherwise successful commands. The required local
`.vercel/project.json` scope control is parsed in place and is never uploaded as
a diagnostic artifact.

Before spawning each logical deployment attempt, the lane derives a
deterministic, nonsecret marker as `vclrun_` plus the first 32 lowercase hex
characters of SHA-256 over the UTF-8 bytes of this exact JSON array:

```json
["dawn-vercel-marker-v1","<GITHUB_REPOSITORY_ID>","<GITHUB_RUN_ID>","<GITHUB_RUN_ATTEMPT>","<GITHUB_JOB>","<source|prebuilt>","<logicalAttemptIndex>"]
```

The harness validates the four GitHub coordinates as nonempty strings, the
kind as the shown literal union, and the attempt index as a canonical
nonnegative decimal string before calling `JSON.stringify` on the array. It
atomically persists that exact preimage array, marker, deployment kind,
safe-integer Unix-millisecond lower time bound, and `spawnStarted: true` before
process creation. A harness-level retry uses a new logical-attempt index,
marker, and manifest entry; source and prebuilt attempts never reuse a marker.

The deploy command includes `--target preview`,
`--meta dawnVercelRun=<marker>`,
`--scope <expected-org-id>`, `--non-interactive`, `--yes`, `--no-wait`, and
`--json`. Preview intent is explicit rather than inferred from the CI branch or
project defaults. The metadata behavior and the `/v6/deployments` `meta-<key>`
reconciliation filter are compatibility contracts of pinned CLI `58.9.0`, not
generic current-OpenAPI claims. Pinned CLI `58.9.0` has exactly two accepted
JSON receipt shapes: a top-level object with own `id` and `url` fields and no
`deployment` field, or an object with `status: "ok"`, no top-level `id` or
`url`, and a `deployment` object with own `id` and `url` fields. The harness
parses stdout as exactly one JSON document with no non-whitespace prefix or
suffix and rejects conflicting or multiple candidate fields, unknown nesting,
regex or bare-URL fallback, malformed IDs, and malformed origins. It does not
infer readiness from the deploy receipt.

After parsing, the lane atomically persists the exact `dpl_...` identifier and
canonical HTTPS origin, then validates an authoritative
`GET /v13/deployments/<id>?teamId=<orgId>` response before any inspect,
readiness, log, or black-box operation. That response must match the exact ID,
canonical origin, expected `projectId`, expected `ownerId`, reconciliation
marker, bounded attempt time, and a non-production target. The harness extracts
and atomically persists only the deployment ID, canonical origin, marker,
creation timestamp, target, and `projectIdMatched`/`ownerIdMatched` booleans. It
never persists the raw project/owner values or complete response because that
response can contain private environment metadata. The lane then uses
`inspect <id> --scope <expected-org-id> --wait --json --non-interactive` for the
separate readiness transition. Deploy output may contain an absolute URL while inspect output
contains a bare hostname. The harness canonicalizes either representation to
an HTTPS origin, rejecting credentials, ports, non-root paths, queries,
fragments, and non-HTTPS schemes, then requires exact canonical-origin equality
and stores only that canonical value.

### Source-build preview

The first fixture has no `.dawn` build directory and no `.vercel/output`. The
lane asserts both absences, then performs a normal source deployment. Vercel
runs the committed `vercel.json` build command against that clean source and
deploys the output. This proves the build behavior used by a Git-connected
project without attempting to test Vercel's webhook service.

### Prebuilt preview

The second fixture runs the workspace-built Dawn CLI locally. The lane asserts
the Build Output API receipt and deploys it with `vercel deploy --prebuilt`.
No source-build fallback is allowed; the command and logs are checked so a
silently rebuilt source deployment cannot satisfy this half of the lane.
Pinned `inspect <id> --logs` evidence begins with the same exact CLI/Node version
banner, followed by the exact deployment-fetch line, canonical timestamped build
events, and final `status\t● Ready`; extra polling, retry, or warning lines fail.

### Shared black-box assertions

Both preview URLs receive the same bounded client sequence:

1. Resolve the already persisted deployment identifier with the pinned CLI,
   require its returned identifier and URL to match the deployment receipt,
   require `readyState: "READY"`, and reject protection, build, or boot errors
   explicitly.
2. Send one unknown route key through an existing run endpoint and require
   `404`. Do not issue separate positive discovery probes. Derive
   `routeDispatchStatus` from the same functional requests below: successful
   state responses for `/state#agent`, the completed SSE run for
   `/stream#agent`, and the successful authorized `/release#graph` response.
   Mark each route dispatched only after its corresponding functional
   assertions pass.
3. Generate a cryptographically unique, cleanup-validated Agent Protocol thread
   identifier and atomically persist it before its first request. Run
   `/state#agent` twice through that client-chosen thread path with distinct
   user-message markers; the run endpoint idempotently creates the thread.
   Require `visits` to advance from `1` to `2`, markers to accumulate in order,
   and `GET /threads/:id/state` to expose the same second state. A parameterized
   SQL query must also find at least one physical checkpoint row for that exact
   thread identifier.
4. Generate and atomically persist distinct target and sentinel barrier
   identifiers before inserting both as unreleased. Call `/release#graph` once
   without its release header and once with an incorrect value; require `401`
   both times and verify both exact rows remain unreleased. Then start
   `/stream#agent` through the SSE endpoint. The fixture emits a first
   meaningful event and waits on the target barrier. The barrier is
   fixture-only middleware plus a test table in the dedicated Postgres
   database; it does not depend on two requests landing in the same Fluid
   instance.
5. Issue the stream request with redirects disabled. Before acquiring its raw
   `ReadableStream` reader, require HTTP `200`, `response.redirected === false`,
   the exact requested deployment origin, and a `Content-Type` whose parsed
   MIME essence is `text/event-stream`. Normalize CRLF without corrupting
   incomplete tails and parse only completed SSE frames. Ignore heartbeat
   comments and concatenate every `data:` line in a frame with a newline before
   JSON parsing. Before release, require public `event: chunk` with JSON data exactly
   `"before-release"`, and require no `"after-release"` chunk, public
   `event: done`, or EOF. Confirm the target remains unreleased in SQL, then
   start and preserve one pending read-for-next-meaningful-frame operation. It
   may consume heartbeats and partial bytes, but for one full second it must
   produce no completed meaningful frame and no EOF; the timeout must win the
   race without cancelling that pending operation. Only then may the authorized
   release request run. It must return exactly one affected identifier matching
   the target; a database read must show target `released = true` and sentinel
   `released = false`. A platform that buffers the whole response deadlocks
   until the bounded pre-release timeout and fails, while a route that failed to
   block resolves the preserved read before authorization and also fails.
6. After release, require public `event: chunk` with JSON data exactly
   `"after-release"` from the preserved read operation, then public
   `event: done` with data exactly
   `{ "output": { "barrierId": "<target>", "released": true } }`, then EOF.
   The fixture's root `on_chain_end` is internal adapter input, not a public SSE
   frame. The complete meaningful order is first chunk, authorized release,
   second chunk, `done`, then EOF.
7. Generate and atomically persist another exact thread identifier plus a
   nonsecret `log-vcl-[a-f0-9]{32}` marker. Send that marker as the sole user
   message in a new `/state#agent` request and require success. The fixture's
   record node recognizes only that exact marker grammar and emits exactly one
   canonical `console.info` line containing only a fixed label and that marker,
   with no other request input, header, or environment value. This produces the
   log-scan anchor and covers a later request without depending on Fluid
   instance reuse as an observable guarantee.
8. Record the log-scan start before black-box traffic. Each poll invokes the
   package-local CLI as `logs --project <expected-project-id> --deployment
   <exact-deployment-id> --json --since <absolute-ISO-start> --until
   <absolute-ISO-end> --limit 1000 --scope <expected-org-id>
   --non-interactive`. Reject malformed JSONL, empty request identifiers,
   missing or mismatched deployment identifiers, and any row from another
   deployment. Specifically, require each row's `id` to be a nonempty request
   identifier and `deploymentId` to equal the exact deployment. Pinned CLI
   `58.9.0` synthesizes JSONL `projectId` from `--project`; require that scope
   echo to match, but never treat it as ownership evidence. Ownership comes
   from the authenticated project and deployment API bindings above. Scan
   `responseStatusCode`, top-level `level`, top-level `message`, and every
   nested `logs[]` entry's `level` and `message`. Reject `error` or `fatal`
   levels even if their messages lack a keyword, and reject a truthy or
   malformed top-level or nested `messageTruncated` field. Canonically
   fingerprint every normalized field and complete nested log entry; if a
   request identifier reappears with changed content, treat it as a new row
   version, rescan it, and reset the quiet timer.

   Poll until a unique benign fixture marker from the final request appears.
   Poll every two seconds with a 180-second overall deadline. Returning exactly
   1,000 rows fails because pinned CLI `58.9.0` does not expose whether more
   rows exist. After the marker first appears, require 30 consecutive seconds
   with no new row version, resetting the quiet timer whenever one appears,
   and perform one final query at the boundary. Scan every row version through
   that final query for 5xx responses and uncaught, unhandled, handler, pool,
   connection, leak, or lifecycle errors. Empty logs, differently scoped logs,
   malformed rows, truncation, or failure to complete the quiet interval before
   the deadline cannot pass.

Before each deploy the lane parses the exact fixture `vercel.json`, requires
`fluid: true`, and records its SHA-256. Each deploy subprocess uses the fixture
root as `cwd`, omits a positional project path, and passes the absolute fixture
file through the pinned CLI's explicit local-config option. The authoritative
project preflight's normalized-null `rootDirectory` assertion is part of this
config-path proof; without it, CLI `58.9.0` can replace the supplied config. A
debug-log string is not accepted as proof. The lane does not accept a Dashboard
default as proof: the explicit deployment-level setting is the portable
contract, and Vercel documents that this file setting activates Fluid for that
deployment.

Each operation has a finite timeout. Incremental evidence is written only to
`receipt.partial.json`, which can never satisfy CI. After every database and
deployment cleanup postcondition succeeds, the harness atomically creates
`receipt.json` with this versioned, closed shape:

```ts
interface VercelNativeReceiptV1 {
  readonly schemaVersion: 1
  readonly cliVersion: "58.9.0"
  readonly projectBindingVerified: true
  readonly kinds: readonly ["source", "prebuilt"]
  readonly deployments: readonly [
    VercelDeploymentReceiptV1<"source">,
    VercelDeploymentReceiptV1<"prebuilt">,
  ]
}

interface VercelDeploymentReceiptV1<Kind extends "source" | "prebuilt"> {
  readonly kind: Kind
  readonly deploymentId: string
  readonly canonicalOrigin: string
  readonly apiBindingVerified: true
  readonly config: { readonly fluid: true; readonly sha256: string }
  readonly readyState: "READY"
  readonly routes: {
    readonly unknownRoute404: true
    readonly state: true
    readonly stream: true
    readonly release: true
  }
  readonly state: {
    readonly visits: readonly [1, 2]
    readonly markersInOrder: true
    readonly generatedReadMatched: true
    readonly physicalCheckpoint: true
  }
  readonly middleware: {
    readonly missingHeader401: true
    readonly wrongHeader401: true
    readonly selectiveRelease: true
    readonly sentinelUnreleased: true
  }
  readonly stream: {
    readonly status: 200
    readonly contentType: "text/event-stream"
    readonly noRedirect: true
    readonly beforeFrameIndex: number
    readonly preReleaseQuietMs: 1000
    readonly authorizedReleaseAfterBeforeFrame: true
    readonly afterFrameIndex: number
    readonly doneFrameIndex: number
    readonly eofAfterDone: true
  }
  readonly laterRequest: { readonly succeeded: true; readonly logMarkerSeen: true }
  readonly logs: {
    readonly pollIntervalMs: 2000
    readonly quietIntervalMs: 30000
    readonly queryStartIso: string
    readonly queryEndIso: string
    readonly uniqueRowVersions: number
    readonly exactDeploymentOnly: true
    readonly noTruncation: true
    readonly noErrors: true
  }
  readonly reconciliation: {
    readonly markerPersistedBeforeSpawn: true
    readonly apiBindingVerified: true
    readonly expectedCardinality: true
  }
  readonly cleanup: {
    readonly deploymentAbsent: true
    readonly databaseRowsAbsent: true
  }
  readonly provenance: Kind extends "source"
    ? {
        readonly cleanSource: true
        readonly prebuiltOutputAbsent: true
        readonly remoteBuildObserved: true
      }
    : {
        readonly localOutputValidated: true
        readonly prebuiltDeployObserved: true
        readonly remoteSourceBuildAbsent: true
      }
}
```

The strict validator rejects missing and additional keys, invalid ID/origin/hash
grammars, non-finite or unordered frame indexes, nonpositive row counts, invalid
ISO timestamps, either deployment in the wrong tuple position, and any literal
that is not exactly the value above. It also requires
`beforeFrameIndex < afterFrameIndex < doneFrameIndex`. A final CI assertion
accepts only `receipt.json` after both deployments and all cleanup have run.
Neither receipt contains protected raw organization/project identifiers, an
Authorization header, or complete Vercel API responses.

### Cleanup and diagnostics

The cleanup manifest is incremental and recoverable across a deploy-child
interruption or failure between remote creation and local JSON persistence. It
atomically persists each deployment attempt's marker derivation coordinates,
kind, lower time bound, and `spawnStarted` state before invoking the CLI; each
exact deployment identifier, safe non-scope fields, and project/owner match
booleans as soon as available; each cleanup-validated thread identifier before
its first run; and each target and sentinel barrier identifier before insertion.
Every resource retains its own cleaned flag without deleting history.
Deployment IDs must match `^dpl_[A-Za-z0-9]+$`, reconciliation markers must
match `^vclrun_[a-f0-9]{32}$`, thread IDs must match
`^t-vcl-[a-f0-9]{32}$`, and barrier IDs must match
`^b-vcl-[a-f0-9]{32}$` before any command, URL, or query is built.

After every deploy attempt, including a nonzero exit or invalid receipt, and
again in the `always()` step, the harness reconciles each persisted marker via
the authenticated Vercel API. It first verifies the exact project response
described above, then exhausts pagination for
`GET /v6/deployments?teamId=<orgId>&projectId=<projectId>&meta-dawnVercelRun=<marker>&since=<attempt-window-start>&until=<reconciliation-window-end>&limit=100`,
where `since` and `until` are safe-integer Unix milliseconds. The first page
uses the fixed persisted lower bound and the current poll's upper bound. On
later pages, retain every other filter and replace only `until` with the
safe-integer Unix-millisecond `pagination.next` cursor. Reject a repeated,
non-integer, or non-decreasing cursor, track all cursor values to detect cycles,
and fail after 100 pages rather than accepting incomplete reconciliation.

The accepted creation window runs from five minutes before the persisted
attempt start through five minutes after each poll begins to tolerate clock
skew while remaining finite. Poll all pages every two seconds, with a
30-second quiet interval and a 180-second overall deadline. Start quiet time
only after the first fully paginated poll. The upper bound grows with each new
poll. Repeated empty polls may satisfy quiet only after the full 30 seconds and
one final fully paginated boundary query. Every newly observed live
marker-matched ID resets quiet; one empty result is never accepted as
read-after-write proof. Deleted tombstones may remain listable, so quiet means
no new live ID rather than an empty list.

Pinned `/v6` list rows use `uid` for the deployment ID, a bare `url` hostname,
and safe-integer Unix-millisecond `created`. Every row must match the marker,
deployment kind's recorded attempt window, strict deployment-ID grammar, and
canonical-origin contract. The query itself supplies the exact expected
project and owner scope. Each candidate is then independently read through
`GET /v13/deployments/<id>?teamId=<orgId>`, whose corresponding fields are
`id`, bare `url`, and safe-integer Unix-millisecond `createdAt`. Each live
response must match exact `id`, `url`, `projectId`, `ownerId`, metadata marker,
creation time, and non-production target before the extracted fields and ID are
atomically added to the cleanup manifest. More than one validated deployment
for one never-reused marker is an invariant failure, but cleanup still attempts
every validated exact ID.

The cleanup workset is the union of exact IDs already in the manifest and IDs
recovered from marker reconciliation. Every workset ID must have its own prior
authenticated-owner validation under the matching persisted marker, unless a
persisted successful-delete receipt already establishes it.

The `always()` step receives the token, expected organization/project, and
database URL only through its own process environment. It never places those
values in a subprocess argv. After marker reconciliation, each extant exact ID
is deleted with authenticated
`DELETE /v13/deployments/<id>?teamId=<orgId>`; list rows are never direct delete
targets, and the CLI `remove` command is forbidden because pinned `58.9.0` can
also interpret its argument as a project. The request never supplies the
optional `url` query parameter, which would cause Vercel to ignore the path ID.
Deletion must return HTTP `200` with `uid` equal to the exact ID and
`state: "DELETED"`; only those two extracted fields are persisted.

Cleanup then polls the same exact-ID GET every two seconds for at most 60
seconds and requires a genuine `404` under the already verified team/project
scope. A pre-delete or DELETE-time `404` is idempotent success only when a prior
authenticated-owner exact-ID validation or a persisted successful-delete
receipt already established that resource, and the follow-up exact GET is also
`404`. `401`, `403`, undocumented `410`, rate-limit, malformed response, scope,
network, and generic failures are never classified as absence.

Database cleanup first calls `to_regclass` with bound names from the fixed
allowlist `public.dawn_vercel_test_barriers`, `public.dawn_writes`,
`public.dawn_checkpoints`, and `public.dawn_threads`. A null result is a
verified zero-resource postcondition for that table, which is necessary when a
boot failure occurs before lazy migrations. For each table that exists,
cleanup uses bound values to delete only the persisted barrier IDs, then each
persisted thread ID from writes, checkpoints, and threads in that order. It
verifies each target and sentinel barrier ID has zero rows in the fixture table
and each thread ID has zero rows in all three Dawn tables before setting that
resource's cleaned flag.

Every database and deployment resource is attempted independently, and cleanup
aggregates all failures. When a primary test failure exists, it remains the
aggregate cause and first contained error; cleanup errors follow it. A passing
receipt is valid only after every cleanup postcondition succeeds. Cleanup is
idempotent and never uses a project-wide or wildcard removal target;
marker-filtered listing is used only to recover candidates, and removal remains
exact-ID-only after authoritative validation.

This contract is intentionally scoped: it closes the Vercel CLI
creation-to-JSON gap when the job's `always()` step can run. Loss of the entire
runner or workflow before that step is outside the lane's immediate-cleanup
guarantee. The deterministic marker is reconstructible for an independent
operator or janitor, but this design does not add that external executor and
must not be described as fully interruption-safe cleanup.

On failure, retain redacted source-build logs, function/runtime logs,
black-box client events, incremental cleanup history, and the JSON receipt as
short-lived CI artifacts. Before upload, scan every final artifact and receipt
for raw and URL-encoded protected values. Secret values are never written to
the receipt, command output, thrown errors, or artifacts.

## Error Handling

- Unsupported edge capabilities fail before any Vercel output is staged.
- Bundle resolution failures name the missing application or provider package
  and explain that deployed functions cannot resolve files outside the
  function directory.
- Malformed Build Output metadata fails local structural verification before a
  deploy command can run.
- Missing runtime `DATABASE_URL` retains the existing targeted Hono error and
  adds Vercel environment-variable guidance in the deployment documentation.
- Missing CI secrets make the same-repository native job fail with the missing
  secret names. They do not silently skip a required deployment.
- A source preview that finds prebuilt output fails before deployment.
- A prebuilt preview that performs a remote source build fails its receipt
  assertion.
- Local invocation cleanup failure after successful publication reports that
  final output remains valid and leaves the exact staging path inspectable.
- Local invocation cleanup never masks a primary bundle, validation, config,
  publication, or rollback failure; both errors are retained with the primary
  failure as aggregate cause.
- Preview cleanup failures are reported separately and do not hide the primary
  build or runtime failure.

## Documentation

Update the CLI and deployment documentation to:

- list `vercel` as an opt-in target;
- distinguish Vercel Node/Fluid compute from the Cloudflare-oriented `hono`
  target;
- show exact configuration and commands for Git-connected, local source, and
  local prebuilt deployments;
- explain `vercel.json` ownership and reconciliation;
- list runtime environment requirements;
- tell existing apps to ignore `.vercel/`;
- replace the current "Vercel is inference" statement only after the native
  lane passes; and
- state precisely which Vercel behaviors are observed versus supplied by the
  platform integration.

## Files and Release

Expected implementation scope:

- build-target registration and public target types;
- a focused shared web-runtime emitter extracted from `hono.ts`;
- a new Vercel target and target tests;
- a native Vercel fixture, black-box client, and CI job;
- CLI/deployment documentation;
- scaffold `.gitignore` templates; and
- one patch changeset for `@dawn-ai/cli` under Dawn's fixed 0.x release group.

This is a patch release: it adds an opt-in deployment output without changing
existing default builds or authored application APIs.

## Definition of Done

- Both credential-free and native Vercel tests pass on Node 24.
- The native receipt proves one source-built and one prebuilt deployment served
  stateful and incrementally streamed Agent Protocol traffic.
- Existing Hono Node and workerd lanes remain green.
- A completed lane, including a failed test whose `always()` step runs, leaves
  no generated preview or subprocess. The design does not claim immediate
  cleanup after total runner loss.
- Lint, build-cache check, build, typecheck, source tests, docs check, pack
  check, harness lanes, and changeset validation pass.
- Documentation claims match the evidence produced by CI.
