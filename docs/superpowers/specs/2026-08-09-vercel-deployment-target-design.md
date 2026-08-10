# First-Class Vercel Deployment Target Design

**Status:** Approved 2026-08-09

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

The job derives the recursive local `@dawn-ai/*` runtime dependency closure
from the fixture's direct Dawn dependencies, packs that closure from the branch
under test, and assembles two isolated fixture copies using only relative
vendored tarballs. A fixture-local package-manager override pins every vendored
Dawn package to its matching tarball, and lockfile validation rejects any
registry-resolved `@dawn-ai/*` copy. This is required because the workspace's
fixed development version can be ahead of the registry; uploaded source cannot
use an external workspace link. The fixture exports a deterministic
graph/workflow route that produces multiple observable stream chunks without a
model call.

The Vercel CLI is pinned to one exact version in the repository lockfile and
invoked from the workspace, not installed from `latest` during CI. The dedicated
test project must allow its short-lived preview URLs to be reached by the
black-box client without an interactive protection challenge. It contains only
the deterministic fixture and test data; production projects are out of scope.

For both deployment commands the lane maps the protected
`DAWN_VERCEL_DATABASE_URL` value to the function's runtime `DATABASE_URL`
without printing it. The source build receives no database credential as a
build environment variable, and the prebuilt artifact is inspected before
deploy to prove the value was not substituted into `index.mjs`.

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

### Shared black-box assertions

Both preview URLs receive the same bounded client sequence:

1. Wait for the deployment to become ready and reject protection, build, or
   boot errors explicitly.
2. Exercise Agent Protocol discovery.
3. Create persistent thread/run state and read it back.
4. Start the deterministic route through an SSE endpoint. The fixture emits a
   first meaningful event and then waits on a database-backed, run-specific
   release barrier. The barrier is fixture-only middleware plus a test table in
   the dedicated Postgres database; it does not depend on two requests landing
   in the same Fluid instance.
5. Read the response as raw `ReadableStream` chunks. Before releasing the
   barrier, require a completed first meaningful SSE frame and require that no
   terminal frame or EOF is present. Only after that observation may the client
   call the release endpoint for the exact run identifier. A platform that
   buffers the whole response deadlocks until the client's bounded pre-release
   timeout and fails, so chunk segmentation or client-side event timestamps
   cannot create a false green.
6. After release, require the terminal event and EOF, then validate the complete
   event sequence and successful outcome.
7. Send another request with a distinct identifier and verify it succeeds,
   covering a reused function instance without depending on reuse as an
   observable guarantee.
8. Inspect runtime-visible failures and fail on uncaught or leaked errors.

Before each deploy the lane parses the exact fixture `vercel.json` and requires
`fluid: true`. It also captures the pinned CLI's debug receipt and requires the
fixture's file to be the local deployment configuration used for both source
and prebuilt commands. The lane does not accept a Dashboard default as proof:
the explicit deployment-level setting is the portable contract, and Vercel
documents that this file setting activates Fluid for that deployment.

Each operation has a finite timeout. The job emits a small JSON receipt naming
the deployment kind, deployment identifier, request statuses, event ordering,
and cleanup result. A final assertion reads the receipt so a renamed flag or
skipped test cannot turn the lane green without performing both deployments.

### Cleanup and diagnostics

Capture the exact deployment identifiers returned by Vercel. An `always()`
step removes only those two preview deployments, even after a test failure.
Cleanup is idempotent and treats an already-absent preview as success. It never
uses a project-wide or wildcard removal command.

On failure, retain source-build logs, function/runtime logs, black-box client
events, and the JSON receipt as short-lived CI artifacts. Secret values are
never written to the receipt or command output.

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
- No generated preview or subprocess remains after tests.
- Lint, build-cache check, build, typecheck, source tests, docs check, pack
  check, harness lanes, and changeset validation pass.
- Documentation claims match the evidence produced by CI.
