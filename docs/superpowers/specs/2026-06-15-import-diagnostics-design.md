# Friendly import-error diagnostics (Design)

**Status:** Approved for planning
**Date:** 2026-06-15
**Roadmap:** Dogfooding-friction backlog items #3 + #4, designed together because they surface as the *same* runtime failure. A consumer whose environment resolves an older hoisted `@langchain/core` (#3) or who imports a named binding from a CommonJS-default dependency (#4) gets the identical opaque ESM error — `SyntaxError: The requested module 'X' does not provide an export named 'Y'` — with no hint about cause or fix. This adds a reactive diagnostic layer that recognizes that failure shape and rewrites it into an actionable message.

## Investigation: is a library-code fix required? (No.)

Recorded because the scoping question was "reactive only, but verify there isn't a necessary library fix first."

- **Dawn's source imports only stable public `@langchain/core` subpaths** (`/messages`, `/tools`, `/runnables`) — verified across `packages/*/src`. There is no fragile deep import (e.g. `language_models/stream`) in Dawn itself; that floor is **transitive**, pulled by `@langchain/langgraph` / `@langchain/openai`.
- **The version floor is already declared.** `@dawn-ai/langchain` declares `peerDependencies: { "@langchain/core": "^1.1.47" }`; `@dawn-ai/cli` depends on `@dawn-ai/langchain`, so a cli consumer inherits the peer requirement and npm/pnpm emit a peer warning when the resolved core is too old. Dawn is not failing to communicate the requirement.
- **One genuine inconsistency, not the root cause:** `@dawn-ai/sqlite-storage` peers `@langchain/core: "^1.1.44"`, below the suite's `^1.1.47` floor. For a cli consumer the peer intersection still resolves to `^1.1.47`, so it does not lower the effective floor — but it is misleading for standalone sqlite-storage users and violates the suite's uniform-versioning convention. Worth tidying; **not** what produces the cryptic error.

**Conclusion:** the break is fundamentally a *consumer-environment* problem (older core hoisted despite the peer warning, or a CJS-default user dep) that peer ranges **warn about but cannot prevent**. No mandatory library fix removes it. Reactive enrichment is the correct primary feature; the sqlite-storage peer alignment rides along as tidy-up.

## Verified facts (against main @ `01c3c0f`)

- **Current error model:** `CliError(message, exitCode)` is the one structured error type (`packages/cli/src/lib/output.ts`). Commands catch low-level failures and re-wrap with a context prefix (`throw new CliError(\`Validation failed: ${formatErrorMessage(error)}\`)`) — ~37 sites. Top-level `run()` (`packages/cli/src/index.ts`) prints `error.message` to stderr and returns the exit code; `CommanderError` is special-cased; all else prints `.message` and returns 1. **Message-only — no `Error.cause`, no stack, no debug toggle.**
- **IO is abstracted** via `CommandIo` (`stdout`/`stderr`/`stdin` callbacks); tests assert on captured strings, so output must stay plain text (ANSI would pollute assertions).
- **Deps are lean:** cli runtime deps are the `@dawn-ai/*` packages plus `commander` and `tsx` only — no color/format libraries.
- **Import sites that throw the cryptic error:**
  - Route loader — `normalizeRouteModule` in `packages/cli/src/lib/runtime/load-route-kind.ts`: `await import(pathToFileURL(routeFile).href)`.
  - Tool loader — `loadToolDefinition` in `packages/cli/src/lib/runtime/tool-discovery.ts:131`: `await import(\`${pathToFileURL(filePath).href}?t=${Date.now()}\`)`.
  - Config loader — `loadDawnConfig` in `@dawn-ai/core` (`packages/core/src/config.ts`): cli cannot wrap this at the boundary, which is why a `run()` fallback is part of the design.
- Node's failure text is stable: `The requested module '<specifier>' does not provide an export named '<name>'` (an ESM `SyntaxError` raised at the `import()` boundary).

## Decisions (from brainstorming)

- **Reactive only** — no proactive version-floor check beyond the sqlite-storage peer tidy-up.
- **Enrichment inspects the offending package** (filesystem read) to classify #3 vs #4 precisely, degrading to a generic-but-named message when it can't read.
- **Hybrid wiring** — enrich at the import boundary (most context) *and* a fallback pass in `run()` (catches config-load and anything unwrapped).
- **Zero new runtime dependencies**; preserve the original error via native `Error.cause`.

## Design

### 1. `packages/cli/src/lib/diagnostics.ts` — pure `diagnose`

```ts
export interface Diagnostic {
  /** One-line statement of what failed, naming the package + missing export. */
  readonly summary: string
  /** Actionable, multi-line fix guidance. */
  readonly hint: string
}

/**
 * Recognize a Node ESM "does not provide an export named" failure and classify
 * it. Returns null for any error it does not recognize (callers leave those
 * untouched). `appRoot` scopes the node_modules lookup; falls back to cwd.
 */
export function diagnose(error: unknown, opts?: { readonly appRoot?: string }): Diagnostic | null
```

Algorithm:
1. Walk `error` and its `.cause` chain; on each, test the message against `/does not provide an export named ['"](.+?)['"]/` and `/requested module ['"](.+?)['"]/`. If no match anywhere → return `null`.
2. From the specifier, resolve the **package name** (scoped `@scope/name`, bare `name`, or a subpath like `@langchain/core/messages` → `@langchain/core`; a relative/absolute path → treat as a local module, classify generic).
3. Read `<appRoot>/node_modules/<pkg>/package.json` (best-effort; `appRoot ?? process.cwd()`). Classify:
   - **`@langchain/*` (esp. `@langchain/core`)** → #3. Read the installed `version`; read Dawn's required floor from `@dawn-ai/langchain`'s `peerDependencies["@langchain/core"]` via `require.resolve("@dawn-ai/langchain/package.json")` (no hardcoded constant; degrade to "a newer version" if unreadable). Hint: upgrade `@langchain/core` to satisfy the range; `npm ls @langchain/core` to locate the stale copy; mention deduping/hoisting.
   - **package.json present and not `"type": "module"`** (i.e. `"commonjs"` or absent) → #4. Hint: the dependency is CommonJS; Dawn loads route/tool/config modules through Node's ESM resolver, which can't bind named exports from some CJS modules. Use a default import then destructure (`import pkg from "X"; const { Y } = pkg`), or check for a newer ESM (`"type":"module"`) release.
   - **otherwise** (ESM package missing the export, or package.json unreadable) → generic: name the module + missing export, note it is likely a version or module-format mismatch and suggest checking the installed version.

Pure and synchronous; package.json reads via `node:fs` `readFileSync` in a try/catch.

### 2. `CliError` carries `cause`

Extend `CliError` with an optional third arg, stored via the native `Error` options:

```ts
constructor(message: string, exitCode = 1, options?: { cause?: unknown }) {
  super(message, options)
  this.name = "CliError"
  this.exitCode = exitCode
}
```

Behavior unchanged for existing call sites (third arg optional). Sets up a future `--debug` stack view (out of scope).

### 3. Import-boundary helper

`packages/cli/src/lib/runtime/import-module.ts`:

```ts
export async function importModule(
  href: string,
  opts: { readonly kind: "route" | "tool" | "config"; readonly appRoot?: string; readonly sourcePath?: string },
): Promise<unknown>
```

Wraps `await import(href)` in try/catch; on failure runs `diagnose(error, { appRoot })`. If diagnosable, throw `new CliError(message, 1, { cause: error })` where `message` = a one-line context line naming the kind + `sourcePath`, then the diagnostic `summary` and `hint`. If not diagnosable, rethrow the original untouched. The route loader (`load-route-kind.ts`) and tool loader (`tool-discovery.ts`) route their dynamic imports through this helper (preserving the tool loader's `?t=` cache-buster and the existing `registerTsxLoader()` call ordering).

### 4. `run()` fallback pass

In `packages/cli/src/index.ts`, the generic (non-`CliError`, non-`CommanderError`) branch tries `diagnose(error)` before printing; if it returns a `Diagnostic`, print `summary` + `hint` instead of the raw `.message`. Also apply when a `CliError` wraps a diagnosable `cause` whose own message wasn't already enriched (so a command that wrapped a config-load failure as `CliError("... : <raw esm text>")` still gets enriched). Exit codes unchanged.

### 5. Tidy-up

`@dawn-ai/sqlite-storage` `peerDependencies["@langchain/core"]`: `^1.1.44` → `^1.1.47`.

## Testing

- **`diagnose` unit tests** (`packages/cli/test/diagnostics.test.ts`): synthetic `SyntaxError`s with Node's exact text over temp `node_modules/<pkg>/package.json` fixtures (the repo's temp-dir idiom) covering: `@langchain/core` old version → #3 message names installed + required; CJS package (`"type"` absent / `"commonjs"`) → #4 message; ESM package missing export → generic; unreadable/missing package.json → generic; non-matching error → `null`; `.cause`-chained match.
- **cli integration** (`packages/cli/test/import-diagnostics.test.ts`): a fixture app whose route imports a named binding from a deliberately CJS-shaped local package (`node_modules/<pkg>` with `package.json` `"type":"commonjs"` + a `module.exports` file) → `dawn check` exits non-zero and stdout/stderr contains the #4 hint; control fixture with a clean import → no diagnostic. Follows `check-command.test.ts` scaffolding.
- **`Error.cause` regression:** existing cli suite passes unchanged (the third `CliError` arg is optional).

## Docs

A short **"Troubleshooting imports"** section in `apps/web/content/docs/faq.mdx` (or `cli.mdx` — confirm during planning): the two failure classes, what the enriched message tells you, and the manual `npm ls @langchain/core` / CJS-default-import remedies. No new page.

## Changeset

`@dawn-ai/cli` minor (diagnostics + `CliError.cause`) and `@dawn-ai/sqlite-storage` patch/minor (peer bump). Fixed versioning bumps all `@dawn-ai/*` together regardless.

## Out of scope

- Proactive version checking (the "reactive only" decision).
- `--debug` / stack-trace rendering (the `Error.cause` plumbing only prepares for it).
- Color / boxed output and any new formatting dependency (would break the string-capturing test IO; `picocolors` is the conventional pick if revisited, as its own cross-cutting decision).
