# `.dawn` Directory — Design Spec

## Goal

Move `dawn.generated.d.ts` out of the user's source tree into a `.dawn/` directory at the project root. This mirrors how Next.js uses `.next/` — generated artifacts live outside authored code. The `.dawn/` directory is gitignored and becomes the home for future build artifacts (e.g., dev server cache).

## Approach

**Output path owned by `findDawnApp`.** The `DiscoveredDawnApp` type gains a `dawnDir` property, computed as `join(appRoot, ".dawn")`. All consumers (`dawn typegen`, Vite plugin) read `app.dawnDir` to determine where to write generated files. This centralizes the path logic in `@dawn-ai/core`.

## Changes

### 1. `@dawn-ai/core` — `DiscoveredDawnApp` gains `dawnDir`

**`packages/core/src/types.ts`**

Add `dawnDir: string` to the `DiscoveredDawnApp` interface:

```ts
export interface DiscoveredDawnApp {
  readonly appRoot: string
  readonly configPath: string
  readonly routesDir: string
  readonly dawnDir: string
}
```

**`packages/core/src/discovery/find-dawn-app.ts`**

Compute `dawnDir` as `join(appRoot, ".dawn")` and return it. Do **not** create the directory here — `findDawnApp` is also called by read-only commands like `dawn routes`. Directory creation is the responsibility of consumers that write (typegen, vite plugin).

### 2. `@dawn-ai/cli` — `typegen` writes to `dawnDir`

**`packages/cli/src/commands/typegen.ts`**

Change the output path from `join(app.routesDir, OUTPUT_FILE)` to `join(app.dawnDir, OUTPUT_FILE)`.

### 3. `@dawn-ai/vite-plugin` — writes to `dawnDir`

**`packages/vite-plugin/src/index.ts`**

Change the output path from `join(app.routesDir, OUTPUT_FILE)` to `join(app.dawnDir, OUTPUT_FILE)`.

### 4. Starter template

**`packages/devkit/templates/app-basic/`**

- **Delete:** `src/app/dawn.generated.d.ts`
- **Create:** `.dawn/dawn.generated.d.ts` with the same content (starter route types for the hello/[tenant] route)

**`packages/devkit/templates/app-basic/tsconfig.json.template`**

Add `.dawn/dawn.generated.d.ts` to the `include` array:

```json
{
  "include": [
    "dawn.config.ts",
    "src/**/*.ts",
    ".dawn/dawn.generated.d.ts"
  ]
}
```

**`packages/devkit/templates/app-basic/gitignore.template`**

New file:

```
node_modules/
dist/
.dawn/
```

**`packages/devkit/src/write-template.ts`**

Handle renaming `gitignore.template` → `.gitignore` during scaffold. npm strips `.gitignore` from published packages, so the template uses a different name and gets renamed at write time.

### 5. Gitignore

**Root `.gitignore`**

Add `.dawn/` entry.

### 6. Test fixture updates

**`packages/cli/test/typegen-command.test.ts`**

- Line 136: `join(appRoot, "src/app/dawn.generated.d.ts")` → `join(appRoot, ".dawn/dawn.generated.d.ts")`
- Line 165: `join(appRoot, "src/custom-app/dawn.generated.d.ts")` → `join(appRoot, ".dawn/dawn.generated.d.ts")`
- Line 172: Remove negative assertion on old path (both default and custom appDir now write to same `.dawn/` location)
- Line 255: `join(appRoot, "src", "custom-app", "dawn.generated.d.ts")` → `join(appRoot, ".dawn", "dawn.generated.d.ts")`

**`test/generated/fixtures/basic.expected.json`**

Add `"dawnDir": "<app-root>/.dawn"` to the verify JSON app check.

**`test/generated/fixtures/custom-app-dir.expected.json`**

Add `"dawnDir": "<app-root>/.dawn"` to the verify JSON app check.

## Out of Scope

- Dev server cache layer inside `.dawn/` — deferred until there's a concrete consumer
- Configurable output directory via `dawn.config.ts` — YAGNI
- Migration tooling for existing projects — the old file can be manually deleted

## Invariants

- The `dawn:routes` module declaration content is unchanged
- TypeScript resolution works via the explicit `include` in `tsconfig.json`
- Scaffolded apps typecheck immediately without running `dawn typegen`
- `.dawn/` is always gitignored
