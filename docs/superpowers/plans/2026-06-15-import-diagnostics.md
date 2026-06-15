# Import-Error Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the opaque `SyntaxError: The requested module 'X' does not provide an export named 'Y'` into an actionable diagnostic that distinguishes an old `@langchain/core` (#3) from a CommonJS-default dependency (#4).

**Architecture:** One PR off `feat/import-diagnostics` (spec: `docs/superpowers/specs/2026-06-15-import-diagnostics-design.md`). A pure `diagnose(error)` utility in `@dawn-ai/cli` classifies the failure by reading the offending package's `package.json`. It's wired at the dynamic-import boundary (route + tool loaders) and as a fallback in the top-level `run()` catch. `CliError` gains a native `cause`. Zero new dependencies. Plus a one-line `@dawn-ai/sqlite-storage` peer-range tidy-up.

**Tech Stack:** TypeScript (no semicolons, double quotes, 2-space, ESM `.js` specifiers), pnpm, Vitest, Biome, changesets.

**Conventions:** `pnpm -r build` once at start; rebuild a package after editing it when another package's tests consume its `dist`. Run `pnpm -r --if-present typecheck` before declaring done (CI typechecks contract files build+lint miss). `pyenv: cannot rehash` output is harmless noise. CLI output is plain text routed through `CommandIo` — no `console.*`, no ANSI.

---

### Task 1: `diagnose()` utility (TDD)

**Files:**
- Create: `packages/cli/src/lib/diagnostics.ts`
- Test: `packages/cli/test/diagnostics.test.ts` (create)

- [ ] **Step 1: Write the failing tests.** These build temp `node_modules/<pkg>/package.json` fixtures (the repo's temp-dir idiom) and feed synthetic `SyntaxError`s with Node's exact wording.

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { diagnose } from "../src/lib/diagnostics.js"

function esmError(specifier: string, name: string): SyntaxError {
  return new SyntaxError(
    `The requested module '${specifier}' does not provide an export named '${name}'`,
  )
}

describe("diagnose", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-diag-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  function installPkg(name: string, pkgJson: Record<string, unknown>): void {
    const dir = join(appRoot, "node_modules", ...name.split("/"))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson), "utf8")
  }

  it("returns null for an unrelated error", () => {
    expect(diagnose(new Error("boom"), { appRoot })).toBeNull()
  })

  it("classifies @langchain/core as a version-floor issue, naming installed version", () => {
    installPkg("@langchain/core", { name: "@langchain/core", version: "1.1.40", type: "module" })
    const d = diagnose(esmError("@langchain/core", "tool"), { appRoot })
    expect(d).not.toBeNull()
    expect(d?.summary).toContain("@langchain/core")
    expect(d?.hint).toContain("1.1.40") // the installed (too-old) version
    expect(d?.hint).toMatch(/npm ls @langchain\/core/)
  })

  it("classifies a subpath specifier to its package", () => {
    installPkg("@langchain/core", { name: "@langchain/core", version: "1.1.40", type: "module" })
    const d = diagnose(esmError("@langchain/core/messages", "AIMessage"), { appRoot })
    expect(d?.summary).toContain("@langchain/core")
  })

  it("classifies a CommonJS dependency as a module-format issue", () => {
    installPkg("legacy-dep", { name: "legacy-dep", version: "2.0.0", type: "commonjs" })
    const d = diagnose(esmError("legacy-dep", "doThing"), { appRoot })
    expect(d?.summary).toContain("legacy-dep")
    expect(d?.hint).toMatch(/CommonJS/i)
    expect(d?.hint).toContain("doThing") // suggests default-import + destructure of the name
  })

  it("treats a package with no \"type\" field as CommonJS", () => {
    installPkg("untyped-dep", { name: "untyped-dep", version: "1.0.0" })
    const d = diagnose(esmError("untyped-dep", "x"), { appRoot })
    expect(d?.hint).toMatch(/CommonJS/i)
  })

  it("falls back to a generic named message for an ESM package missing the export", () => {
    installPkg("modern-dep", { name: "modern-dep", version: "1.0.0", type: "module" })
    const d = diagnose(esmError("modern-dep", "missingThing"), { appRoot })
    expect(d).not.toBeNull()
    expect(d?.summary).toContain("modern-dep")
    expect(d?.summary).toContain("missingThing")
    expect(d?.hint).toMatch(/version|format/i)
  })

  it("falls back to generic when the package.json can't be read", () => {
    const d = diagnose(esmError("ghost-dep", "x"), { appRoot })
    expect(d).not.toBeNull()
    expect(d?.summary).toContain("ghost-dep")
  })

  it("finds the error through a cause chain", () => {
    const wrapped = new Error("Validation failed", { cause: esmError("legacy-dep", "y") })
    installPkg("legacy-dep", { name: "legacy-dep", version: "2.0.0", type: "commonjs" })
    expect(diagnose(wrapped, { appRoot })?.hint).toMatch(/CommonJS/i)
  })

  it("returns null for a relative-specifier failure (no package to inspect)", () => {
    expect(diagnose(esmError("./local.js", "x"), { appRoot })).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter @dawn-ai/cli test -- diagnostics` → FAIL (module missing).

- [ ] **Step 3: Implement `packages/cli/src/lib/diagnostics.ts`:**

```ts
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

export interface Diagnostic {
  readonly summary: string
  readonly hint: string
}

const EXPORT_RE = /does not provide an export named ['"](.+?)['"]/
const MODULE_RE = /requested module ['"](.+?)['"]/

interface ExportFailure {
  readonly specifier: string
  readonly missingExport: string
}

function findExportFailure(error: unknown): ExportFailure | null {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    const exportMatch = EXPORT_RE.exec(current.message)
    if (exportMatch) {
      const moduleMatch = MODULE_RE.exec(current.message)
      return { specifier: moduleMatch?.[1] ?? "", missingExport: exportMatch[1] ?? "" }
    }
    current = (current as { cause?: unknown }).cause
  }
  return null
}

/** Bare/scoped package name from a specifier, or null for relative/absolute/empty. */
function packageNameOf(specifier: string): string | null {
  if (!specifier) return null
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {
    return null
  }
  const parts = specifier.split("/")
  if (specifier.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  }
  return parts[0] ?? null
}

interface PackageManifest {
  readonly version?: string
  readonly type?: string
}

function readManifest(appRoot: string, pkg: string): PackageManifest | null {
  try {
    const raw = readFileSync(join(appRoot, "node_modules", ...pkg.split("/"), "package.json"), "utf8")
    return JSON.parse(raw) as PackageManifest
  } catch {
    return null
  }
}

/** Dawn's required @langchain/core range, read from @dawn-ai/langchain's peer deps. Best-effort. */
function requiredCoreRange(): string | null {
  try {
    const require = createRequire(import.meta.url)
    // @dawn-ai/langchain exposes ./package.json in its exports map (see Task note).
    const manifestPath = require.resolve("@dawn-ai/langchain/package.json")
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      peerDependencies?: Record<string, string>
    }
    return pkg.peerDependencies?.["@langchain/core"] ?? null
  } catch {
    return null
  }
}

export function diagnose(error: unknown, opts?: { readonly appRoot?: string }): Diagnostic | null {
  const failure = findExportFailure(error)
  if (!failure) return null

  const pkg = packageNameOf(failure.specifier)
  if (!pkg) return null // relative/local module: no package to inspect, leave untouched

  const appRoot = opts?.appRoot ?? process.cwd()
  const manifest = readManifest(appRoot, pkg)

  // #3 — LangChain ecosystem version floor.
  if (pkg === "@langchain/core" || pkg.startsWith("@langchain/")) {
    const installed = manifest?.version ? `${manifest.version}` : "an older version"
    const range = requiredCoreRange()
    const need = range ? `a version satisfying ${range}` : "a newer version"
    return {
      summary: `${pkg} does not provide the export "${failure.missingExport}" that Dawn's runtime imports.`,
      hint:
        `Your installed @langchain/core is ${installed}; Dawn needs ${need}. ` +
        `An older @langchain/core was likely hoisted into your install. ` +
        `Run "npm ls @langchain/core" (or your package manager's equivalent) to find the stale copy, ` +
        `then upgrade/dedupe it.`,
    }
  }

  // #4 — CommonJS-default dependency under the ESM resolver.
  if (manifest && manifest.type !== "module") {
    return {
      summary: `Cannot import "${failure.missingExport}" from "${pkg}".`,
      hint:
        `"${pkg}" is a CommonJS package, and Dawn loads route/tool/config modules through Node's ` +
        `ESM resolver, which can't always bind named exports from CommonJS. ` +
        `Use a default import and destructure: import pkg from "${pkg}"; const { ${failure.missingExport} } = pkg. ` +
        `If the package ships an ESM build ("type": "module"), upgrade to it.`,
    }
  }

  // Generic — ESM package missing the export, or manifest unreadable.
  return {
    summary: `Module "${pkg}" does not provide an export named "${failure.missingExport}".`,
    hint:
      `This is usually a version mismatch (the installed "${pkg}" is older or newer than expected) ` +
      `or a module-format issue. Check the installed version with "npm ls ${pkg}".`,
  }
}
```

- [ ] **Step 4: Verify green.** `pnpm --filter @dawn-ai/cli build && pnpm --filter @dawn-ai/cli test -- diagnostics` → all pass. `pnpm --filter @dawn-ai/cli lint`.

- [ ] **Step 5: Commit.**
```bash
git add packages/cli/src/lib/diagnostics.ts packages/cli/test/diagnostics.test.ts
git commit -m "feat(cli): diagnose() classifies opaque ESM import failures"
```

### Task 2: `@dawn-ai/langchain` exposes `./package.json`; verify `requiredCoreRange` resolves

**Files:**
- Modify: `packages/langchain/package.json` (only if its `exports` map blocks `./package.json`)
- Test: extend `packages/cli/test/diagnostics.test.ts`

- [ ] **Step 1:** Read `packages/langchain/package.json`'s `exports` field. If it is a map that does NOT already allow `./package.json`, add `"./package.json": "./package.json"`. If `exports` is absent or already permits it, make NO change (Node allows `package.json` access by default when not restricted) and note that in your report.

- [ ] **Step 2: Add a test** to `diagnostics.test.ts` proving the #3 hint includes the real range when resolvable (run from the monorepo where `@dawn-ai/langchain` is installed):

```ts
it("includes Dawn's required @langchain/core range in the #3 hint when resolvable", () => {
  // appRoot here is the temp dir; requiredCoreRange resolves @dawn-ai/langchain from the
  // cli package's own location (createRequire(import.meta.url)), independent of appRoot.
  installPkg("@langchain/core", { name: "@langchain/core", version: "1.1.40", type: "module" })
  const d = diagnose(esmError("@langchain/core", "tool"), { appRoot })
  // Range string like "^1.1.47" — assert the floor digits appear, OR the graceful fallback.
  expect(d?.hint).toMatch(/satisfying \^?1\.1\.\d+|a newer version/)
})
```

(The `|a newer version` alternative keeps the test honest if package.json subpath resolution isn't available in the test runner — but prefer the real range. If it falls back, investigate whether the `exports` change from Step 1 is needed and report.)

- [ ] **Step 2b:** Run `pnpm --filter @dawn-ai/cli test -- diagnostics` — green, and report whether the real range or the fallback was exercised.

- [ ] **Step 3: Commit** (include `packages/langchain/package.json` only if changed):
```bash
git add packages/cli/test/diagnostics.test.ts
git commit -m "test(cli): diagnose surfaces the required @langchain/core range"
```

### Task 3: `CliError` carries `cause`

**Files:**
- Modify: `packages/cli/src/lib/output.ts`
- Test: `packages/cli/test/output.test.ts` (create if absent; else extend)

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, expect, it } from "vitest"
import { CliError } from "../src/lib/output.js"

describe("CliError", () => {
  it("preserves an optional cause", () => {
    const root = new Error("root")
    const err = new CliError("wrapped", 2, { cause: root })
    expect(err.exitCode).toBe(2)
    expect(err.cause).toBe(root)
  })
  it("defaults exitCode to 1 and has no cause when omitted", () => {
    const err = new CliError("plain")
    expect(err.exitCode).toBe(1)
    expect(err.cause).toBeUndefined()
  })
})
```

- [ ] **Step 2:** Run → FAIL (constructor takes no 3rd arg; `cause` undefined).

- [ ] **Step 3: Implement** — update the `CliError` constructor in `output.ts`:

```ts
constructor(message: string, exitCode = 1, options?: { readonly cause?: unknown }) {
  super(message, options)
  this.name = "CliError"
  this.exitCode = exitCode
}
```

- [ ] **Step 4:** `pnpm --filter @dawn-ai/cli test -- output` green; full cli suite still green (existing `new CliError(msg)` / `new CliError(msg, code)` calls unaffected). Lint.

- [ ] **Step 5: Commit.**
```bash
git add packages/cli/src/lib/output.ts packages/cli/test/output.test.ts
git commit -m "feat(cli): CliError preserves an optional cause"
```

### Task 4: `importModule` boundary helper + wire route/tool loaders (TDD)

**Files:**
- Create: `packages/cli/src/lib/runtime/import-module.ts`
- Modify: `packages/cli/src/lib/runtime/load-route-kind.ts`, `packages/cli/src/lib/runtime/tool-discovery.ts`
- Test: `packages/cli/test/import-module.test.ts` (create)

- [ ] **Step 1: Write the failing test** (drives a real dynamic import of a temp CJS package with a missing named export; if cjs-module-lexer auto-detects exports on some Node versions, a guaranteed-absent name still throws):

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError } from "../src/lib/output.js"
import { importModule } from "../src/lib/runtime/import-module.js"

describe("importModule", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-importmod-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  it("returns the module on success", async () => {
    const file = join(appRoot, "ok.mjs")
    writeFileSync(file, "export const value = 42\n", "utf8")
    const mod = (await importModule(pathToFileURL(file).href, { kind: "route", appRoot })) as {
      value: number
    }
    expect(mod.value).toBe(42)
  })

  it("rethrows a diagnosable failure as an enriched CliError with cause + kind/path context", async () => {
    const dep = join(appRoot, "node_modules", "legacy-dep")
    mkdirSync(dep, { recursive: true })
    writeFileSync(join(dep, "package.json"), JSON.stringify({ name: "legacy-dep", version: "1.0.0", type: "commonjs", main: "index.js" }), "utf8")
    writeFileSync(join(dep, "index.js"), "module.exports = { present: 1 }\n", "utf8")
    const route = join(appRoot, "route.mjs")
    writeFileSync(route, "import { absent } from \"legacy-dep\"\nexport default absent\n", "utf8")

    await expect(
      importModule(pathToFileURL(route).href, { kind: "route", appRoot, sourcePath: route }),
    ).rejects.toMatchObject({
      name: "CliError",
      message: expect.stringMatching(/CommonJS/i),
    })
    // and the original error is preserved as cause
    const err = await importModule(pathToFileURL(route).href, { kind: "route", appRoot }).catch((e) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).cause).toBeInstanceOf(Error)
  })

  it("rethrows a non-diagnosable error untouched", async () => {
    const file = join(appRoot, "throws.mjs")
    writeFileSync(file, "throw new Error(\"plain boom\")\n", "utf8")
    await expect(importModule(pathToFileURL(file).href, { kind: "tool", appRoot })).rejects.toThrow(
      /plain boom/,
    )
  })
})
```

- [ ] **Step 2:** Run → FAIL (module missing).

- [ ] **Step 3: Implement `packages/cli/src/lib/runtime/import-module.ts`:**

```ts
import { CliError } from "../output.js"
import { diagnose } from "../diagnostics.js"

export async function importModule(
  href: string,
  opts: {
    readonly kind: "route" | "tool" | "config"
    readonly appRoot?: string
    readonly sourcePath?: string
  },
): Promise<unknown> {
  try {
    return await import(href)
  } catch (error) {
    const diag = diagnose(error, opts.appRoot ? { appRoot: opts.appRoot } : undefined)
    if (!diag) throw error
    const where = opts.sourcePath ? ` (loading ${opts.kind} ${opts.sourcePath})` : ` (loading a ${opts.kind})`
    throw new CliError(`${diag.summary}${where}\n\n${diag.hint}`, 1, { cause: error })
  }
}
```

- [ ] **Step 4: Wire the loaders.**
  - `load-route-kind.ts` `normalizeRouteModule`: replace `await import(pathToFileURL(routeFile).href)` with `await importModule(pathToFileURL(routeFile).href, { kind: "route", appRoot: <see note>, sourcePath: routeFile })`. `normalizeRouteModule` currently takes only `routeFile` — add an optional `appRoot` param threaded from its callers where readily available; if a caller lacks it, omit `appRoot` (diagnose falls back to cwd). Keep `registerTsxLoader()` ordering unchanged. Preserve the existing module-shape cast.
  - `tool-discovery.ts` `loadToolDefinition`: replace the `await import(\`${pathToFileURL(filePath).href}?t=${Date.now()}\`)` with `await importModule(\`${pathToFileURL(filePath).href}?t=${Date.now()}\`, { kind: "tool", appRoot: options.appRoot, sourcePath: filePath })` — `discoverToolDefinitions` already has `appRoot`; thread it into `loadToolDefinition` (add a param). Keep the cast.

- [ ] **Step 5: Verify.** `pnpm --filter @dawn-ai/cli build && pnpm --filter @dawn-ai/cli test` — new tests pass; full suite green (route/tool discovery behavior unchanged on the success path). Lint.

- [ ] **Step 6: Commit.**
```bash
git add packages/cli/src/lib/runtime/import-module.ts packages/cli/src/lib/runtime/load-route-kind.ts packages/cli/src/lib/runtime/tool-discovery.ts packages/cli/test/import-module.test.ts
git commit -m "feat(cli): enrich import failures at the route/tool load boundary"
```

### Task 5: `run()` fallback diagnostic pass (TDD)

**Files:**
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/run-diagnostics.test.ts` (create)

- [ ] **Step 1: Write the failing test** — drive `run()` with a command path that throws a diagnosable error not wrapped by `importModule`. Simplest: a fixture app whose `dawn.config.ts` (loaded by `loadDawnConfig` in core, unwrapped) imports a missing named export. Follow `check-command.test.ts` scaffolding. Assert the enriched text appears on stderr and the exit code is non-zero. If wiring a config-import failure end-to-end proves fragile in the test, instead unit-test the extracted fallback (see Step 3) by calling it directly with a synthetic diagnosable error and asserting it returns the enriched lines — and add a smaller integration assertion. State which you did.

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement.** In `run()`'s catch, before the final generic `writeLine(io.stderr, ...)`, add a diagnostic pass. Factor the message choice into a small local helper so it's unit-testable:

```ts
// in the catch, replacing the generic tail:
const diag = diagnose(error)
if (diag) {
  writeLine(io.stderr, `${diag.summary}\n\n${diag.hint}`)
  return 1
}
writeLine(io.stderr, error instanceof Error ? error.message : String(error))
return 1
```

Also handle the case where a command wrapped a diagnosable failure as a `CliError` whose message is NOT already enriched: in the `error instanceof CliError` branch, if `error.cause` diagnoses to a `Diagnostic` AND `error.message` doesn't already contain `diag.summary`, print the enriched form (append the hint) instead of the bare wrapped message. Keep `error.exitCode`. Import `diagnose` from `./lib/diagnostics.js`.

- [ ] **Step 4: Verify.** `pnpm --filter @dawn-ai/cli test` — green incl. the new test; confirm existing `index`/`run` tests unaffected. Lint.

- [ ] **Step 5: Commit.**
```bash
git add packages/cli/src/index.ts packages/cli/test/run-diagnostics.test.ts
git commit -m "feat(cli): run() enriches diagnosable errors that bypass the load boundary"
```

### Task 6: End-to-end `dawn check` integration (TDD)

**Files:**
- Test: `packages/cli/test/import-diagnostics-integration.test.ts` (create)

- [ ] **Step 1: Write the test** — copy `check-command.test.ts`'s `createFixtureApp` + in-process `invoke`. Create a fixture app with a real CommonJS dep in its `node_modules` and an agent route whose `tools/<name>.ts` imports a guaranteed-absent named binding from it:
  - `node_modules/legacy-dep/package.json`: `{ "name": "legacy-dep", "version": "1.0.0", "type": "commonjs", "main": "index.js" }`
  - `node_modules/legacy-dep/index.js`: `module.exports = { present: 1 }`
  - route `src/app/(public)/x/index.ts`: a valid `agent({ model: "gpt-4o-mini", systemPrompt: "..." })`
  - tool `src/app/(public)/x/tools/load.ts`: `import { absent } from "legacy-dep"` + `export default async () => absent`

  Run `["check", "--cwd", appRoot]`. Assert: exit code non-zero; stderr contains `legacy-dep` and matches `/CommonJS/i` and names the missing export `absent`. Add a control: a tool importing `present` (which exists) → check passes (exit 0), proving no false positive.

  Note: if a Node version's cjs-module-lexer detects `present` as a named export, importing `absent` still fails with the target error — that's the intended trigger. If even `absent` somehow resolves, fall back to importing from an ESM fixture package missing the export and assert the generic enriched message instead; report the adjustment.

- [ ] **Step 2:** Run → the bad-import test FAILS before wiring is confirmed end-to-end... it should already PASS given Tasks 4–5 are merged. Treat this as a verification test: if it fails, debug the wiring (don't weaken assertions).

- [ ] **Step 3:** `pnpm --filter @dawn-ai/cli test -- import-diagnostics-integration` then full suite. Lint.

- [ ] **Step 4: Commit.**
```bash
git add packages/cli/test/import-diagnostics-integration.test.ts
git commit -m "test(cli): end-to-end import-diagnostic coverage via dawn check"
```

### Task 7: sqlite-storage peer tidy-up + docs + changeset + verification + PR

**Files:**
- Modify: `packages/sqlite-storage/package.json`
- Modify: `apps/web/content/docs/faq.mdx` (or `cli.mdx` — decide by reading both)
- Create: `.changeset/import-diagnostics.md`

- [ ] **Step 1: Peer bump.** In `packages/sqlite-storage/package.json`, change `peerDependencies["@langchain/core"]` from `^1.1.44` to `^1.1.47`. Leave its `devDependencies` entry as-is.

- [ ] **Step 2: Docs.** Read `apps/web/content/docs/faq.mdx` and `cli.mdx`; add a short **"Troubleshooting imports"** entry where it reads most naturally (FAQ is the likely home). Cover: the symptom (`does not provide an export named …`), that Dawn now prints a cause + fix, the two classes (old `@langchain/core` → `npm ls @langchain/core` + upgrade/dedupe; CommonJS dep → default-import-and-destructure or use an ESM build). Build the docs site: `pnpm --filter @dawn-ai/web build` (revert `apps/web/next-env.d.ts` churn with `git checkout --`).

- [ ] **Step 3: Changeset** `.changeset/import-diagnostics.md`:

```md
---
"@dawn-ai/cli": minor
"@dawn-ai/sqlite-storage": patch
---

Friendlier import errors. When a route, tool, or config module fails to load with the opaque ESM error "does not provide an export named X", Dawn now identifies the offending package and explains the likely cause and fix — an older hoisted `@langchain/core` (with the installed-vs-required versions and an `npm ls` pointer) or a CommonJS dependency imported with named bindings under Dawn's ESM resolver. `CliError` now preserves the original error via `cause`. Also aligns `@dawn-ai/sqlite-storage`'s `@langchain/core` peer floor to `^1.1.47` to match the rest of the suite.
```

- [ ] **Step 4: Full verification.**
```
pnpm -r build
pnpm -r --if-present typecheck
pnpm --filter @dawn-ai/cli test
pnpm --filter @dawn-ai/cli lint
pnpm --filter @dawn-ai/web build
```
Expected: all green; cli suite includes the new diagnostics/import-module/run/integration tests; lint exit 0 (pre-existing warnings only). Revert `next-env.d.ts` churn.

- [ ] **Step 5: Commit + push + PR.**
```bash
git add packages/sqlite-storage/package.json apps/web/content/docs/faq.mdx .changeset/import-diagnostics.md
git commit -m "chore: sqlite-storage core peer floor; troubleshooting docs; changeset"
git push -u origin feat/import-diagnostics
gh pr create --base main --title "feat: friendly diagnostics for opaque ESM import failures" \
  --body "Backlog #3+#4. Spec: docs/superpowers/specs/2026-06-15-import-diagnostics-design.md. diagnose() classifies @langchain/core version-floor vs CommonJS-default failures; wired at route/tool load boundary + run() fallback; CliError gains cause; sqlite-storage peer floor aligned to ^1.1.47."
```
