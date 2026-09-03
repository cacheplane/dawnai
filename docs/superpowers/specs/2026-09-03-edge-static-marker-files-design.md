# Edge Static Marker Files Design

## Status

Approved for planning.

## Problem

Three agent-route capabilities read static, author-owned files through the
`MarkerFs` facade declared in `packages/core/src/capabilities/types.ts`:

- skills (`<routeDir>/skills/<name>/SKILL.md`, exposed through `readSkill`),
- planning (`<routeDir>/plan.md`, seeded into the `todos` channel), and
- route memory (`<routeDir>/memory.md`, rendered into the system prompt).

The node runtime supplies `nodeMarkerFs` through `RuntimeBootFallbacks`. The
edge entry point emitted for the `hono` and `vercel` targets supplies nothing,
so on those targets:

- `assertEdgeCapabilities` fails the build with `DAWN_E1005` when any route
  has a skills directory, and `collectRuntimeCapabilityGaps` repeats the
  rejection at request time for a hand-composed entry;
- `plan.md` and `memory.md` degrade silently because the markers' `detect`
  returns false without a `MarkerFs`.

These files are known in full at build time. They never change after the
build, and the build already walks the same directories to record skill names
into the static module manifest. The thread-access policy already solves the
same shape of problem: probe on disk at build time, carry the result in the
manifest, and run from the manifest at request time. The gate exists only
because nothing carries the file bodies across the build boundary.

The consumer that motivates this change is a Dawn application deployed as the
Hono artifact inside a Vercel Node function. That host has a filesystem for the
bundle, but the target-name gate rejects skills anyway. The fix should not
depend on the host having a filesystem at all; it should make the edge targets
serve these files from the bundle.

## Goals

- Skills, `plan.md`, and route `memory.md` work on the `hono` and `vercel`
  targets exactly as they do under `dawn dev` and the node target, with no
  change to the capability markers.
- The file bodies travel inside the static module manifest, so a deployed
  bundle needs no runtime filesystem and no build-machine path.
- The build and request-time gates for skills are removed, and the remaining
  fail-closed property is preserved: a manifest that records skills but
  supplies no marker files still fails at boot rather than dropping the
  skills silently.
- `@dawn-ai/core`'s default barrel stays free of `node:fs`.
- Bundle growth is bounded by an explicit per-file limit that matches the
  runtime limit the markers already apply.

## Non-goals

- `workspace/AGENTS.md`. Its contract is a file the agent rewrites through
  `writeFile` every turn. A read-only bundled copy would honor the read half
  of that contract and silently break the write half. It stays behind the
  workspace gate with the workspace tools.
- Workspace tools, tool-output offloading, sandbox, exec backends, and
  filesystem backends. Those need a writable filesystem or a process and are
  separate work.
- Long-term memory (`memory.ts`, `recall`, `remember`) on the edge. The
  emitted `stores.mjs` supplies no memory store, and filling that slot needs a
  Postgres memory store built on the per-request Neon pool plus serializable
  memory configuration. That is a follow-up design.
- Changing what the node target emits. Its manifest keeps reading marker files
  from disk through `nodeMarkerFs`.
- Changing the `langsmith` target, which materializes graphs without Dawn's
  HTTP layer or capability markers.

## Approaches Considered

### 1. Bundle marker file bodies into the manifest and serve them through a static `MarkerFs`

The web-runtime emitter reads each route's marker files at build time, emits
them as a string map in `modules.edge.mjs`, and the fetch handler wraps that
map in a pure `MarkerFs` implementation that it threads into route
preparation. The markers do not change. The gates for skills go away because
the reason for them goes away.

This is the approach the design adopts. It reuses the seam the markers already
consume, mirrors the thread-access precedent, and keeps every runtime rule
about sizes, names, and rendering in one place: the markers.

### 2. Teach each marker to read from the manifest directly

Give the skills, planning, and memory-md markers a second input path that
reads from `DawnStaticModules` instead of `MarkerFs`. Rejected: three markers
gain a second code path each, the build gate and the request guard still need
their own view of the same files, and the node path and edge path stop sharing
behavior. The facade exists precisely so the markers do not know where bytes
come from.

### 3. Rely on the host filesystem when the target is deployed on Node

Detect at request time that `node:fs` is available and construct
`nodeMarkerFs`. Rejected: the edge bundle is built without `node:fs`, the
edge manifest's `appRoot` is an opaque namespace rather than a path, and the
fix would only help the Vercel Node host and not Workers. It also reintroduces
the class of silent target-dependent behavior the edge design removed.

## Design

### Build side

`emitWebRuntimeArtifacts` in
`packages/cli/src/lib/build/targets/web-runtime.ts` already runs
`collectRouteStaticDiscovery` per route. This design extends the discovery
result and the edge manifest emitter, not the shared node emitter:

1. `RouteStaticDiscovery` gains an optional `markerFiles` field: a list of
   `{ relativePath, content }` entries, where `relativePath` is relative to
   the route directory using forward slashes. Discovery collects:
   - `skills/<name>/SKILL.md` for every name that `discoverSkillDirs`
     returns, so the recorded skill names and the bundled bodies can never
     disagree;
   - `plan.md` when present;
   - `memory.md` when present.
   Discovery reads these files only when the emitter is producing an edge
   flavor. The node manifest keeps its current shape.
2. Each bundled file is limited to 32 KiB, the same limit `planning.ts` and
   `memory-md.ts` already enforce at runtime and the limit this design applies
   to skill bodies. A file over the limit fails the build with `DAWN_E1005`,
   naming the file and its size, before any artifact is written. This keeps
   the property that a green build never ships a silently disabled feature.
3. `emitEdgeModulesFile` emits a `markerFiles` object on each route entry
   whose keys are namespace paths built the same way every other edge path is
   built: `appRoot + "/<route-relative-path>"`, where `appRoot` is the literal
   `edgeAppNamespace` value. The runtime derives `routeDir` from
   `pureDirname(routeFile)`, and `routeFile` uses the same expression, so the
   keys the markers ask for and the keys the build wrote are the same strings.
   Values are the file contents as JSON string literals.

### Runtime side

1. `@dawn-ai/core` gains `staticMarkerFs(files)` in a new pure module
   exported from the default barrel. It takes a `Readonly<Record<string,
   string>>` of absolute namespace paths to contents and implements the five
   `MarkerFs` methods:
   - `existsSync(path)`: true when `path` is a key or a directory prefix of
     any key;
   - `isDirectorySync(path)`: true only for directory prefixes, never for
     keys;
   - `statSizeSync(path)`: the UTF-8 byte length of the value, undefined for
     directories and misses;
   - `readFileSync(path)`: the value, undefined otherwise;
   - `readdirSync(path)`: the sorted immediate child names under a directory
     prefix, empty otherwise.
   Every method is total and never throws, matching the facade contract.
   Paths are normalized only by stripping a trailing slash; the build writes
   canonical keys and the markers join with the same pure helpers.
2. `StaticRouteModule` and `DawnStaticModules` carry the bundled files.
   `buildStaticRouteModule` accepts the `markerFiles` map on its input and
   records it on the route module. `DawnStaticModules` exposes the union of
   every route's files as `markerFiles`, computed once by `loadStaticModules`
   or the equivalent edge loader, so the fetch handler does not walk routes.
3. `createRuntimeFetchHandler` constructs `staticMarkerFs(modules.markerFiles)`
   when `modules.markerFiles` is present and no `bootFallbacks` exist, and
   threads it into route execution as a new optional `markerFs` input. In
   `execute-route-core.ts`, the `applyCapabilities` call uses
   `fallbacks?.markerFs ?? options.markerFs`. The node path is unchanged
   because it always has fallbacks.
4. The skills, planning, and memory-md markers are not modified. They already
   express every rule in terms of `MarkerFs`.

### Gates

1. `collectEdgeCapabilityViolations` no longer reports skills.
2. `collectRuntimeCapabilityGaps` changes its skills clause from "the route
   recorded skills" to "the route recorded skills and the handler has no
   marker filesystem". A hand-composed entry that constructs
   `DawnStaticModules` with skill names but no `markerFiles` still fails at
   boot with `DAWN_E1005` and the existing message. That is the fail-closed
   property the request guard exists for, and it survives unchanged for the
   case it was written for.
3. `dawn check` inherits the build-gate change because it calls
   `assertEdgeCapabilities`.
4. The workspace, tool-output, sandbox, backend, store-handle, and long-term
   memory gates are untouched.

### Documentation

- `deployment/edge.mdx`: remove the skills row from the gate table, add a
  short section stating that skills, `plan.md`, and route `memory.md` are
  bundled into the manifest at build time with a 32 KiB per-file limit, and
  update the sentence that says marker capabilities do not activate on the
  edge to name only `workspace/AGENTS.md`.
- `skills.mdx` and `planning.mdx` make no target claims today and need no
  change.
- `errors.mdx` is generated; the `DAWN_E1005` description already says
  "unsupported by the build target or runtime", which still covers the new
  over-limit case.
- `cli.mdx`, `faq.mdx`, and `upgrading.mdx` mention the skills gate; each
  mention is updated to the new behavior.
- A patch changeset covering `@dawn-ai/core` and `@dawn-ai/cli`. The fixed
  group releases every package together, so the changeset names only the
  packages whose source changes.

## Error Handling

- A marker file over 32 KiB fails the build and `dawn check` with
  `DAWN_E1005`, naming the route-relative path and the byte size, before any
  artifact is written. The remedy text says to shorten the file or split a
  skill.
- A marker file that exists but cannot be read fails the build with the
  underlying error rather than emitting a manifest without it. Skills already
  fail this way through `findThreadAccessFile`'s precedent of refusing to
  guess.
- At request time, a manifest that records skill names without marker files
  fails boot with the existing `DAWN_E1005` skills message.
- `staticMarkerFs` never throws. A miss reads as absent exactly as it would on
  disk, so the markers' own size and parse rules run unchanged.
- A `SKILL.md` with malformed frontmatter is handled by the skills marker the
  same way on every target; this design adds no new parsing.

## Testing and Verification

Core (`packages/core`):

- Unit tests for `staticMarkerFs`: file and directory existence, directory
  versus file distinction, byte sizes for multi-byte content, sorted child
  listing, trailing-slash tolerance, misses, and that no method throws on any
  input.
- The existing bundle purity test in `packages/cli/test/edge-bundle-purity.test.ts`
  keeps proving that the core default barrel and the edge entry import no
  `node:fs`.

CLI build (`packages/cli`):

- `modules-emitter` and `edge-modules-emitter` tests: a route with two skills,
  a `plan.md`, and a `memory.md` emits `markerFiles` with the expected
  namespace keys and exact contents; a route without marker files emits no
  `markerFiles` key; the node manifest is unchanged.
- `hono-target` and `vercel-target` tests: a fixture with skills builds
  successfully (today it must fail); a fixture with a 33 KiB `SKILL.md` fails
  before any artifact is written, naming the file.
- `static-check` test: `dawn check` on a hono app with skills passes.

CLI runtime (`packages/cli`):

- `runtime-capability-guards` test: skills recorded with marker files present
  produce no violation; skills recorded with no marker files still produce the
  existing violation.
- `static-edge-equivalence` test: for a route with skills, `plan.md`, and
  `memory.md`, the edge handler and the node handler produce the same system
  prompt fragments, the same `readSkill` result for a named skill, and the
  same seeded `todos`, driven by aimock fixtures.
- `hono-node-roundtrip` test: a built hono app that calls `readSkill` in a
  replayed run returns the skill body.

Definition of Done: `pnpm ci:validate` from the repository root, per
`AGENTS.md`, plus the changeset check.

Consumer verification outside this repository: the motivating application
overlays the built `@dawn-ai/*` packages onto its installed copies, runs its
existing `dawn build` and adapter verifier, and exercises `readSkill` through
its authenticated Agent Protocol endpoint. That verification is recorded in
the consumer's own plan and is not a gate for this change.
