# CLI Documentation Turbo Cache Design

**Status:** Approved 2026-08-09

## Summary

The `@dawn-ai/cli` build generates its bundled Markdown documentation from the
website MDX tree and navigation file. Those inputs live outside the CLI package,
and the generated `packages/cli/docs/**` tree is outside Turbo's declared build
outputs. Turbo can therefore reuse the CLI build after source documentation
changes or restore `dist/**` without restoring the bundled docs.

Give the CLI build an explicit package-qualified cache contract: retain normal
package inputs, add the external website documentation inputs, and cache both
`dist/**` and generated `docs/**`. Extend the existing build-cache guard to
validate Turbo's effective task configuration.

## Goals

- Invalidate only the CLI build when website MDX or documentation navigation
  changes.
- Restore generated CLI documentation on a clean Turbo cache hit.
- Preserve all default package-local inputs in the CLI build hash.
- Guard the effective cache contract against future source or configuration
  drift.
- Keep the configuration centralized in the repository's root `turbo.json`.

## Non-Goals

- Making website documentation a global dependency of every build task.
- Introducing the repository's first package-local Turbo configuration.
- Changing the documentation generator or its Markdown transformations.
- Committing the generated, gitignored `packages/cli/docs/**` tree.
- Changing packaging behavior outside the CLI package.

## Root Cause

`packages/cli/package.json` runs TypeScript compilation followed by
`packages/cli/scripts/generate-docs.mjs`. The generator reads:

- `apps/web/content/docs/**/*.mdx`
- `apps/web/app/components/docs/nav.ts`

and writes `packages/cli/docs/**`.

Turbo's default task inputs cover Git-tracked files inside the workspace
package. A dry run for `@dawn-ai/cli#build` currently reports 227 package-local
inputs, zero website MDX files, and zero navigation inputs. The generic build
task declares `dist/**` and Next.js outputs but not CLI `docs/**`.

This produces two independent failure modes:

1. A website-doc-only change leaves the CLI task hash unchanged, so stale
   generated docs can remain in a developer or CI workspace.
2. A clean cache hit restores `dist/**` but not `docs/**`, so `dawn docs` can
   report that bundled docs are missing and a cached build can be incomplete for
   packaging.

The pack check masks the bug by rebuilding packages directly before packing.

## Turbo Task Contract

Add a package-qualified task override in root `turbo.json`:

```json
"@dawn-ai/cli#build": {
  "dependsOn": ["^build"],
  "inputs": [
    "$TURBO_DEFAULT$",
    "$TURBO_ROOT$/apps/web/content/docs/**/*.mdx",
    "$TURBO_ROOT$/apps/web/app/components/docs/nav.ts"
  ],
  "outputs": ["dist/**", "docs/**"]
}
```

`$TURBO_DEFAULT$` retains the normal package-local hash inputs. `$TURBO_ROOT$`
makes the cross-package source relationship explicit. Repeating `dependsOn`
and `dist/**` keeps the complete effective contract visible without relying on
task-override merging behavior.

The override affects only `@dawn-ai/cli#build`; unrelated packages keep their
existing hashes when website documentation changes.

## Regression Guard

Extend `scripts/check-build-cache-config.mjs`, which already runs in the main CI
lane, to inspect:

```text
turbo run build --filter=@dawn-ai/cli --dry=json
```

Parse the effective `@dawn-ai/cli#build` task and require:

- every current tracked `apps/web/content/docs/**/*.mdx` source appears in its
  effective inputs;
- `apps/web/app/components/docs/nav.ts` appears;
- ordinary CLI package inputs remain present, detecting accidental loss of
  `$TURBO_DEFAULT$`; use `packages/cli/src/index.ts` as a representative source
  input rather than a metadata file;
- `dist/**` and `docs/**` both appear in effective outputs.

The check fails with a focused list of missing cache-contract elements. Running
the strengthened guard before editing `turbo.json` provides the required red
test; adding the task override turns it green.

## Error Handling

- Failure to execute or parse Turbo's dry run fails the cache-config check with
  the underlying command or parse error.
- A missing CLI task is reported directly rather than producing a generic
  property error.
- Missing external inputs and outputs are accumulated so one run reports the
  complete drift.
- The guard derives the MDX inventory from the filesystem so newly added topics
  are automatically covered by the configured glob.

## Testing

1. Strengthen `check-build-cache-config.mjs` first and observe it fail against
   the current effective CLI task.
2. Add the package-qualified Turbo task and observe the guard pass.
3. Inspect the dry run to confirm the website docs, navigation file, normal CLI
   inputs, and both output trees are present.
4. Build the CLI dependency closure and verify `packages/cli/docs/**` is
   generated.
5. Remove the generated docs, rerun the unchanged CLI build as a cache hit, and
   verify the complete `packages/cli/docs/**` tree is restored.
6. Run lint, build-cache, build, typecheck, tests, docs check, pack check, and
   the repository Definition of Done.

## Files

- Modify `turbo.json` with the `@dawn-ai/cli#build` cache contract.
- Modify `scripts/check-build-cache-config.mjs` with the effective-configuration
  regression guard.
- Add a patch changeset for `@dawn-ai/cli`.

## Release

This is a patch fix for the CLI package. The release note will state that CLI
documentation generation now invalidates and restores correctly through the
Turbo build cache.
