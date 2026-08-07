# Testing Harness API Cleanup Design

**Status:** Approved 2026-08-07

## Summary

`createAgentHarness()` only implements in-process execution, but its public
`AgentHarnessOptions` type also accepts `"http-inject"` and `"subprocess"`.
Those values compile and then fail during construction. Remove the `mode`
option entirely so the TypeScript surface describes the behavior Dawn actually
supports.

The existing `createAgentProtocolInjector()` and `createSubprocessApp()`
factories remain the canonical APIs for their respective execution paths. Dawn
does not add a compatibility overload, deprecation period, or unified adapter.

## Goals

- Make unsupported harness modes impossible to express through the public
  `createAgentHarness()` type.
- Keep each testing factory aligned with one lifecycle and execution model.
- Preserve the working protocol-injection and subprocess helpers unchanged.
- Document the three APIs as separate tools rather than incomplete modes of one
  abstraction.

## Non-Goals

- Integrating protocol injection or subprocess execution into
  `createAgentHarness()`.
- Renaming or changing `createAgentProtocolInjector()` or
  `createSubprocessApp()`.
- Per-scenario tool mocking.
- Kubernetes compatibility testing or chart hardening.
- Backwards compatibility for `AgentHarnessOptions.mode`.

## Public API

`AgentHarnessOptions` changes from:

```ts
export interface AgentHarnessOptions {
  readonly appRoot: string
  readonly route: string
  readonly fixtures?: FixtureSet
  readonly mode?: "in-process" | "http-inject" | "subprocess"
  // ...
}
```

to:

```ts
export interface AgentHarnessOptions {
  readonly appRoot: string
  readonly route: string
  readonly fixtures?: FixtureSet
  // ...
}
```

`createAgentHarness()` no longer branches on `options.mode` or throws the
`mode ... not yet implemented` error. Its name and documentation define it as
the deterministic in-process agent harness.

The following exports remain unchanged:

```ts
createAgentProtocolInjector(options)
createSubprocessApp(options)
```

Callers that need those lower-level paths choose the corresponding factory
directly. The APIs do not share an options union because their configuration,
results, and lifecycle responsibilities differ.

## Validation And Failure Behavior

The unsupported configuration moves from a runtime failure to a compile-time
failure. A contract test constructs valid `AgentHarnessOptions` and uses
`@ts-expect-error` on an object containing `mode`. The package's existing
`tsconfig.contracts.json` lane verifies the rejection.

JavaScript callers do not receive a special runtime unknown-property check.
Like other structural TypeScript options, an extra property is ignored at
runtime. Adding schema parsing only for this removed field would create a new
validation model and is outside this cleanup.

## Documentation

Update `packages/testing/README.md` to state that `createAgentHarness()` is
in-process without referring to a default mode or future mode integration.
Document `createAgentProtocolInjector()` and `createSubprocessApp()` as explicit
lower-level factories for protocol and process-boundary testing.

The website testing guide currently describes unsupported mode values. Remove
that mode list and replace it with the same three-API model in
`apps/web/content/docs/testing-agents.mdx`, then run the existing CLI docs
generator to update `packages/cli/docs/testing-agents.md`. The generated copy
is not textually identical because the generator removes website-only
`RelatedCards`; verification must use the established generation and docs-
bundle checks rather than a literal file comparison.

## Files

- Modify `packages/testing/src/harness.ts` to remove the option and runtime
  branch.
- Create `packages/testing/test/harness-options.contract.ts` for the public type
  contract, importing `AgentHarnessOptions` through `../src/index.js` so the
  test exercises the package's public export surface.
- Modify `packages/testing/README.md`.
- Modify `apps/web/content/docs/testing-agents.mdx`, then regenerate
  `packages/cli/docs/testing-agents.md` with the existing CLI docs generator.
- Add a patch changeset for `@dawn-ai/testing`.

## Testing

1. Demonstrate the contract test fails before implementation because `mode` is
   still accepted.
2. Remove the field and runtime branch; rerun the contract lane to pass.
3. Run `@dawn-ai/testing` build, typecheck, lint, and test commands.
4. Run the CLI docs generator, documentation bundle tests, and documentation
   guard to verify the generated testing-agent guide matches the supported
   source transformation.
5. Run the repository Definition of Done before publishing the PR.

## Release

Add a patch changeset for `@dawn-ai/testing`. Dawn's fixed 0.x release group
must remain on the 0.8.x line, so this change does not use a minor changeset.
The release note should state directly that the unsupported `mode` property was
removed and point users to the existing dedicated factories.
