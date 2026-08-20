# CopilotKit V2 Example Migration — Design

**Date:** 2026-08-18
**Status:** Implementation complete; verification and WIP reconciliation pending

## Summary

Move the chat and research web examples onto CopilotKit's supported V2 surface
before completing the dependency-security remediation. Both React frontends
already imported `@copilotkit/react-core/v2`; this prerequisite selects stable
CopilotKit `1.68.3` and replaces the two legacy backend endpoint adapters with
the V2 Fetch handler.

CopilotKit V2 is an API surface within the stable `@copilotkit/*` 1.x packages.
It is not a supported `@copilotkit/*@2.x` release. The migration therefore uses
selected stable `1.68.3` and `/v2` imports. It does not use the deprecated
`2.0.0-next.1` publication or the retired `@copilotkitnext/*` packages.

This is the first implementation phase of the revised dependency-security
work. The dependency graph and audit evidence are regenerated only after the
migration, so the remediation is based on the architecture Dawn intends to
keep.

## Motivation

Before this prerequisite, the examples mixed two CopilotKit generations:

- React components, hooks, and styles use `@copilotkit/react-core/v2`.
- Both Next.js runtime routes import the root `@copilotkit/runtime` API and use
  `ExperimentalEmptyAdapter` with
  `copilotRuntimeNextJSAppRouterEndpoint`.

CopilotKit documents those root endpoint factories as the legacy runtime path
and recommends `createCopilotRuntimeHandler` from `@copilotkit/runtime/v2` for
new Fetch-native integrations. Dawn does not need compatibility with the old
transport, so retaining both paths would add complexity without product value.

Updating from the installed `1.66.x` line to selected stable `1.68.3` also gives
the security work a cleaner direct-owner baseline. Compatible transitive ranges
can resolve patched Hono-family and UUID releases without Dawn forcing versions
through package-manager overrides.

## Verified Upstream Facts

- `1.68.3` was the selected stable release of `@copilotkit/react-core` and
  `@copilotkit/runtime` when implementation began.
- CopilotKit's supported V2 imports are
  `@copilotkit/react-core/v2` and `@copilotkit/runtime/v2`.
- `@copilotkit/runtime@2.0.0-next.1` is deprecated as an accidental CI
  publication and is not a migration target.
- `@copilotkitnext/runtime` and `@copilotkitnext/react` are deprecated in favor
  of the normal-package `/v2` exports.
- Stable `@copilotkit/runtime@1.68.3` still declares
  `@ai-sdk/google-vertex`, so changing the import path does not remove the
  outstanding `@ai-sdk/provider-utils` advisory from the installed graph.
- CopilotKit `1.68.3` pins its direct AG-UI client/core dependencies to
  `0.0.57`. Dawn's type-facing `HttpAgent` dependency must stay on that exact
  version to avoid loading a second, potentially type-incompatible
  `AbstractAgent` generation. A separate `@ag-ui/client@0.0.54` remains
  encapsulated below CopilotKit's `@ag-ui/mcp-middleware@0.0.1`; it is not the
  agent type Dawn passes into `CopilotRuntime`.

References:

- [Copilot Runtime guidance](https://docs.copilotkit.ai/backend/copilot-runtime)
- [V2 React migration guide](https://docs.copilotkit.ai/llamaindex/migrate/v2)
- [CopilotKit v1.68.3 release](https://github.com/CopilotKit/CopilotKit/releases/tag/v1.68.3)

## Decisions

1. **Use the selected stable packages.** Raise both examples to
   `@copilotkit/react-core@^1.68.3` and `@copilotkit/runtime@^1.68.3`. Keep
   `@ag-ui/client` exactly pinned at `0.0.57` because it remains pre-1.0 and
   CopilotKit `1.68.3` depends on that exact generation. Do not independently
   update it to `0.0.58`.
2. **Use V2 imports throughout.** All CopilotKit React imports remain on
   `@copilotkit/react-core/v2`; both server routes move to
   `@copilotkit/runtime/v2`.
3. **Adopt the native multi-route V2 transport.** Use
   `createCopilotRuntimeHandler`, a Next.js required catch-all route, and the
   V2 REST/SSE route layout. Do not retain the legacy single-route envelope.
4. **Keep Dawn's AG-UI boundary.** Each CopilotKit runtime continues to register
   an `@ag-ui/client` `HttpAgent` pointing at the existing Dawn `/agui/{route}`
   endpoint. Agent behavior, credentials, and server ownership do not move into
   the web application.
5. **Do not add dependency overrides.** Let declared compatible ranges select
   patched transitive versions. Any remaining advisory must be fixed through a
   direct owner update or represented as a narrow, evidence-backed upstream
   exception in the security plan.
6. **Remove compatibility code rather than dual-running it.** Breaking changes
   are acceptable for these private examples, so there is no feature flag,
   fallback endpoint, or old-client compatibility layer.
7. **Align Dawn's React integration owner without raising its consumer floor.**
   Update `packages/ag-ui`'s development dependency on
   `@copilotkit/react-core` to `^1.68.3`, while preserving its optional peer range
   `>=1.66.0`. The package tests against the selected implementation without
   imposing an unnecessary breaking peer requirement on consumers.
8. **Keep browser verification side-effect free and auditable.** Set
   `agentRules: false` in both Next.js configs so Next 16.3 does not generate
   contributor-rule files during `next dev`. Add a dedicated credential-free
   browser job using local servers, and register its exact entrypoints and
   executables in the workflow audit fixtures. The existing native Vercel
   deployment job remains unchanged.

## Runtime Architecture

Each example keeps the same logical path:

```text
CopilotKit V2 React UI
  -> /api/copilotkit/* (CopilotKit V2 Fetch handler)
  -> HttpAgent
  -> Dawn /agui/{encoded route id}
  -> Dawn agent route
```

The server route moves from:

```text
app/api/copilotkit/route.ts
  @copilotkit/runtime
  ExperimentalEmptyAdapter
  copilotRuntimeNextJSAppRouterEndpoint
```

to:

```text
app/api/copilotkit/[...path]/route.ts
  @copilotkit/runtime/v2
  CopilotRuntime
  createCopilotRuntimeHandler
```

The handler is created once with:

- the existing `default` `HttpAgent` registration;
- `basePath: "/api/copilotkit"`;
- the default multi-route mode; and
- `GET` and `POST` exports for Next.js App Router.

Both `<CopilotKit>` providers explicitly set `useSingleEndpoint={false}` so the
browser uses the V2 routes instead of posting the legacy method envelope to the
base URL.

## Scope

### Chat example

- Upgrade the two CopilotKit packages and retain the aligned AG-UI pin.
- Migrate the CopilotKit runtime route.
- Preserve the `/chat#agent` Dawn route mapping.
- Remove comments and documentation that describe the legacy endpoint factory
  or an obsolete installed CopilotKit version.

### Research example

- Apply the same package and runtime migration.
- Preserve the `/research#agent` Dawn route mapping.
- Keep the existing V2 activity, permission, tool-rendering, suggestions, and
  memory components unchanged except where updated types require a direct
  adjustment.
- Refresh the memory proxy's route-shape comment if it describes the old
  single-route CopilotKit endpoint.

### Shared security work

- Align `packages/ag-ui`'s development owner while preserving its optional peer
  compatibility range.
- Regenerate the lockfile from the upgraded direct dependencies.
- Refresh security tests that currently encode CopilotKit `1.66.x`, legacy
  runtime imports, or the single-route response shape.
- Re-run production and full audits after the migration before revising the
  finding baseline or exception records.
- Add package-owned browser checks plus an additive CI job, and update the
  workflow entrypoint/safe-executable fixtures required by the release
  controller.

## Dependency-Security Effect

The migration is expected to reduce dependency debt, but it is not represented
as a complete audit fix:

- Patched Hono and `@hono/node-server` releases are available within the
  owners' declared compatible ranges. The refreshed graph selects Hono
  `4.13.3`, node-server `1.19.17`, and node-server `2.1.1` without an override.
- CopilotKit's newer UUID range permits the patched 11.x release, removing the
  need for Dawn's UUID override once the final graph proves it is obsolete.
- Mermaid and DOMPurify remain product-reachable through the V2 UI and must
  resolve patched versions; their browser behavior remains covered by a Dawn
  integration test.
- `@ai-sdk/provider-utils` remains under CopilotKit's Google Vertex dependency
  in stable `1.68.3`. The import migration does not remove it, and Dawn will not
  force an incompatible transitive version.
- The Vercel CLI is required by Dawn's native deployment verification lane. Its
  upstream findings remain in the full, development audit only; neither the
  dependency nor the real deployment lane is removed or replaced by an
  override.

Audit expectations are derived from the regenerated graph, not frozen to the
pre-migration alert numbers or finding counts.

## Testing

Verification covers Dawn behavior and public integration contracts rather than
CopilotKit's internal implementation:

1. Typecheck and production-build both web examples.
2. Add an automated frontend transport regression that proves each real
   `<CopilotKit>` provider selects multi-route mode: its first runtime discovery
   request reaches `GET /api/copilotkit/info`, and it does not send the legacy
   method envelope to `POST /api/copilotkit`.
   The observer admits only same-origin requests.
3. Update the deterministic runtime-route test to exercise a valid information
   request plus a malformed run request without calling a model.
4. Add a loopback integration test with a schema-valid fake AG-UI endpoint. Run
   one request through each real CopilotKit handler and assert that `HttpAgent`
   reaches exactly `/agui/%2Fchat%23agent` and
   `/agui/%2Fresearch%23agent`, then forwards the fake SSE response through the
   CopilotKit boundary. This is the CI proof that the migrated examples still
   target Dawn rather than only constructing a valid CopilotKit handler.
5. Run the research web component tests unchanged or with type-only adaptations.
6. Perform a non-gating live-model smoke of chat streaming and the research
   permission/rendering flows when credentials are available; keep the current
   README distinction between deterministic CI coverage and manual live-model
   verification.
7. Run the dependency-resolution tests and both production and full audits.
8. Run both page checks in a dedicated, credential-free CI job and keep its
   parsed workflow entrypoint/executable fixtures in sync.
9. Run the repository Definition of Done before completion.

The tests must fail if either example returns to the root CopilotKit runtime
adapter or if the final lockfile resolves a known vulnerable version that has a
compatible patched release.

## Documentation

Update current guidance in:

- `examples/chat/README.md`
- `examples/chat/web/README.md`
- `examples/research/web/README.md`
- `apps/web/content/docs/recipes/research-web-ui.mdx`
- this design and its active implementation plan

Historical design documents remain historical records. The active security plan
must be updated so its package versions, route shape, tests, and audit
expectations match the migrated examples.

## Sequencing

1. Implement and verify the CopilotKit package/API migration as the first
   coherent change on the security-remediation branch.
2. Regenerate the lockfile and collect fresh dependency evidence.
3. Remove obsolete overrides and remediate the remaining compatible findings.
4. Record only genuinely upstream-blocked findings with exact dependency paths.
5. Run the complete verification and publication-containment process.

Keeping the migration first prevents the security evidence from being captured
against an integration Dawn immediately intends to replace.

## Acceptance Criteria

- Both examples use selected stable CopilotKit `1.68.3` package ranges.
- `packages/ag-ui` tests against `@copilotkit/react-core@^1.68.3` while retaining
  the optional peer range `>=1.66.0`.
- Every CopilotKit product import uses a supported `/v2` entry point.
- Neither example contains `ExperimentalEmptyAdapter` or
  `copilotRuntimeNextJSAppRouterEndpoint`.
- Both examples use the V2 multi-route handler and still reach the same Dawn
  agents through `HttpAgent`.
- Both examples typecheck, build, and pass their relevant integration tests.
- Both providers are regression-tested in multi-route mode, including the
  `/api/copilotkit/info` discovery request.
- Both Next.js configs disable generated agent rules, and the additive browser
  CI job is represented in both workflow audit fixtures without changing the
  native Vercel deployment lane.
- A deterministic loopback test proves each `HttpAgent` retains its exact
  encoded Dawn AG-UI target and forwards a schema-valid event stream.
- Both examples' direct, type-facing `HttpAgent` edges resolve to
  `@ag-ui/client@0.0.57`, and no `0.0.58` identity is present. The older
  `0.0.54` identity is permitted only beneath
  `@ag-ui/mcp-middleware@0.0.1`; its presence is not required if upstream
  removes that private edge.
- The refreshed graph uses compatible patched dependency versions without new
  overrides.
- The refreshed audit explicitly distinguishes fixed findings from the
  remaining provider-utils and Vercel upstream boundaries.

## Non-Goals

- Installing a deprecated CopilotKit `2.0.0-next.1` package.
- Adopting the retired `@copilotkitnext/*` namespace.
- Replacing CopilotKit or bypassing its runtime by connecting browsers directly
  to Dawn.
- Changing Dawn's AG-UI protocol adapter or agent routes.
- Rewriting the existing V2 React components.
- Hiding findings in a separate lockfile, audit ignore, or broad exception.
