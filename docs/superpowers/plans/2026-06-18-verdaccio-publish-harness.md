# Verdaccio Publish Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generated-app harness's `pack → pin tarballs → pnpm.overrides → fail-closed .npmrc` simulation with a real ephemeral Verdaccio registry: publish the whole workspace atomically, then install scaffolded apps from it exactly like a published npm user.

**Architecture:** A per-lane programmatic Verdaccio (started in vitest `globalSetup`, `listen(0)`, temp storage, `@dawn-ai/*` local-only + npmjs uplink, anonymous publish). The workspace is published once per lane via `pnpm -r publish`. Scaffolded apps get a real `.npmrc` (`registry=<verdaccio>`) and `pnpm install` with no overrides/rewrite. The old mechanism is deleted; internal mode is untouched.

**Tech Stack:** TypeScript (no semicolons, double quotes, 2-space, ESM `.js` specifiers), pnpm 10.33, Vitest 4, Verdaccio 6, Biome.

**Spec:** `docs/superpowers/specs/2026-06-18-verdaccio-publish-harness-design.md`

**Conventions:** Work only in this worktree. `pnpm -r build` once before running any lane. Lanes run via `pnpm verify:harness` or directly with `pnpm exec vitest run --config test/<lane>/vitest.config.ts`. `pyenv: cannot rehash` output is harmless. Root `.npmrc` has `package-manager-strict=true` — keep publish/install commands explicit.

**Key facts (verified):**
- All 17 publishable workspace packages are at one uniform version (fixed group). Private (skipped by `pnpm -r publish`): `@dawn-ai/web`, `@dawn-example/*`.
- `create-dawn-ai-app` writes the `--dist-tag` string literally as the dep specifier (`"@dawn-ai/core": "latest"`); default tag is `latest` (`packages/create-dawn-app/src/index.ts:81`).
- `@dawn-ai/*` packages depend on each other via `workspace:*`; `pnpm -r publish` rewrites these to the exact version on publish.
- Lanes: framework=`test/generated/vitest.config.ts`, runtime=`test/runtime/vitest.config.ts`, smoke=`test/smoke/vitest.config.ts`, run by `scripts/harness-report.mjs`.

---

### Task 1: Verdaccio dependency + `local-registry.ts` (keystone, TDD)

This task proves the whole approach end-to-end and validates the shared-store freshness reasoning before anything depends on it.

**Files:**
- Modify: `package.json` (root — add `verdaccio` devDependency)
- Create: `test/harness/local-registry.ts`
- Create: `test/harness/local-registry.test.ts`

- [ ] **Step 1: Add Verdaccio.**

Run: `pnpm add -D -w verdaccio@^6`
Expected: `package.json` root `devDependencies` gains `"verdaccio": "^6.x"`; lockfile updates.

- [ ] **Step 2: Write the failing integration test.**

Create `test/harness/local-registry.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "vitest"

import { runPackagedCommand } from "./packaged-app.ts"
import { type LocalRegistry, publishWorkspace, startLocalRegistry } from "./local-registry.ts"

describe("local-registry", () => {
  let registry: LocalRegistry

  beforeAll(async () => {
    registry = await startLocalRegistry()
    await publishWorkspace(registry.url)
  }, 180_000)

  afterAll(async () => {
    await registry?.stop()
  })

  test("serves a published @dawn-ai package that a real install resolves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dawn-reg-probe-"))
    await writeFile(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "probe", private: true, dependencies: { "@dawn-ai/core": "latest" } }, null, 2)}\n`,
      "utf8",
    )
    await writeFile(join(dir, ".npmrc"), `registry=${registry.url}\n`, "utf8")

    await runPackagedCommand({ args: ["install", "--no-frozen-lockfile"], command: "pnpm", cwd: dir })

    // Resolved from Verdaccio (file under .pnpm keyed to the registry host), not npmjs.
    const lockfile = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(dir, "pnpm-lock.yaml"), "utf8"),
    )
    expect(lockfile).toContain("@dawn-ai/core")
    expect(lockfile).not.toContain("registry.npmjs.org/@dawn-ai")
    await rm(dir, { force: true, recursive: true })
  }, 180_000)

  test("404s for an @dawn-ai package that was never published (fail-closed)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dawn-reg-neg-"))
    await writeFile(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "neg", private: true, dependencies: { "@dawn-ai/does-not-exist": "latest" } }, null, 2)}\n`,
      "utf8",
    )
    await writeFile(join(dir, ".npmrc"), `registry=${registry.url}\n`, "utf8")

    await expect(
      runPackagedCommand({ args: ["install", "--no-frozen-lockfile"], command: "pnpm", cwd: dir }),
    ).rejects.toThrow()
    await rm(dir, { force: true, recursive: true })
  }, 120_000)
})
```

- [ ] **Step 3: Run it to verify it fails.**

Run: `pnpm exec vitest run --config test/generated/vitest.config.ts test/harness/local-registry.test.ts`
Expected: FAIL — `local-registry.ts` does not exist (import error).

- [ ] **Step 4: Implement `local-registry.ts`.**

Create `test/harness/local-registry.ts`:

```ts
import { readFile, readdir, rm } from "node:fs/promises"
import { mkdtemp } from "node:fs/promises"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { runServer } from "verdaccio"

import { runPackagedCommand } from "./packaged-app.ts"

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url))

export interface LocalRegistry {
  readonly url: string
  readonly stop: () => Promise<void>
}

/** Start an ephemeral Verdaccio: random port, fresh temp storage, @dawn-ai local-only, npmjs uplink, anonymous publish. */
export async function startLocalRegistry(): Promise<LocalRegistry> {
  const storage = await mkdtemp(join(tmpdir(), "dawn-verdaccio-"))
  const config = {
    storage,
    uplinks: { npmjs: { url: "https://registry.npmjs.org/", maxage: "30m" } },
    packages: {
      "@dawn-ai/*": { access: "$all", publish: "$anonymous", unpublish: "$anonymous" },
      "**": { access: "$all", publish: "$anonymous", proxy: "npmjs" },
    },
    logs: { type: "stdout", format: "pretty", level: "warn" },
  }

  // verdaccio@6 runServer accepts a config object and resolves to an http server.
  const app = (await runServer(config as never)) as Server
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s))
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Verdaccio failed to bind a port")
  }
  const url = `http://127.0.0.1:${address.port}/`

  return {
    url,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(storage, { force: true, recursive: true })
    },
  }
}

/** Assert every publishable package shares one version, then publish the whole workspace atomically to `url`. */
export async function publishWorkspace(url: string): Promise<void> {
  await assertUniformPublishableVersion()

  const host = url.replace(/^https?:\/\//, "").replace(/\/$/, "")
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_registry: url,
    // npm/pnpm refuse to publish without a token even when the scope allows $anonymous.
    [`npm_config_//${host}/:_authToken`]: "fake",
  }

  await runPackagedCommand({
    args: ["-r", "publish", "--registry", url, "--tag", "latest", "--no-git-checks"],
    command: "pnpm",
    cwd: REPO_ROOT,
    env,
  })
}

async function assertUniformPublishableVersion(): Promise<void> {
  const packagesDir = join(REPO_ROOT, "packages")
  const entries = await readdir(packagesDir, { withFileTypes: true })
  const versions = new Map<string, string>()

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let manifest: { name?: string; version?: string; private?: boolean }
    try {
      manifest = JSON.parse(await readFile(join(packagesDir, entry.name, "package.json"), "utf8"))
    } catch {
      continue
    }
    if (manifest.private || !manifest.name || !manifest.version) continue
    versions.set(manifest.name, manifest.version)
  }

  const unique = new Set(versions.values())
  if (unique.size > 1) {
    const detail = [...versions.entries()].map(([name, v]) => `${name}@${v}`).join(", ")
    throw new Error(
      `Publishable packages must share one canonical version before publishing to the test registry, found: ${detail}`,
    )
  }
}
```

Note: `runPackagedCommand` must accept an optional `env`. If it does not already, add `readonly env?: NodeJS.ProcessEnv` to its options type in `test/harness/packaged-app.ts` and pass it through to `spawnProcess` (merge over `process.env`). Verify by reading `test/harness/packaged-app.ts:158-180` first; only add the field if missing.

Verdaccio API note: `runServer` is the supported entry (the default export is deprecated). The exact return shape can vary by 6.x minor — the research indicates it resolves to a server you call `.listen(0)` on. If `app.listen` is not a function, log the resolved value's shape and adjust (some versions return `{ webServer }` or an already-listening server whose address you read directly). Step 5 will surface this immediately.

- [ ] **Step 5: Build, then run the test to verify it passes.**

Run: `pnpm -r build && pnpm exec vitest run --config test/generated/vitest.config.ts test/harness/local-registry.test.ts`
Expected: PASS (both tests). The positive test proves shared-store freshness works (no `--store-dir` isolation); the negative test proves fail-closed. If the positive test resolves `@dawn-ai/core` from npmjs (lockfile contains `registry.npmjs.org/@dawn-ai`), the `@dawn-ai/*` scope is being proxied — re-check the config has NO `proxy:` on that pattern and that it precedes `**`.

- [ ] **Step 6: Commit.**

```bash
git add package.json pnpm-lock.yaml test/harness/local-registry.ts test/harness/local-registry.test.ts test/harness/packaged-app.ts
git commit -m "test(harness): ephemeral Verdaccio local-registry helper + integration test"
```

---

### Task 2: Per-lane global setup + registry URL handoff

**Files:**
- Create: `test/harness/registry-global-setup.ts`
- Modify: `test/harness/local-registry.ts` (add `getTestRegistryUrl()` accessor)
- Modify: `test/generated/vitest.config.ts`, `test/runtime/vitest.config.ts`, `test/smoke/vitest.config.ts`
- Create: `test/harness/registry-global-setup.test.ts`

- [ ] **Step 1: Add the URL accessor to `local-registry.ts`.**

Append to `test/harness/local-registry.ts`:

```ts
const REGISTRY_URL_ENV = "DAWN_TEST_REGISTRY_URL"

/** Read the registry URL published by the lane's globalSetup. Throws if setup did not run. */
export function getTestRegistryUrl(): string {
  const url = process.env[REGISTRY_URL_ENV]
  if (!url) {
    throw new Error(
      `${REGISTRY_URL_ENV} is not set — the lane's registry globalSetup must run before scaffolding helpers.`,
    )
  }
  return url
}

export { REGISTRY_URL_ENV }
```

- [ ] **Step 2: Write the globalSetup.**

Create `test/harness/registry-global-setup.ts`:

```ts
import { type LocalRegistry, publishWorkspace, REGISTRY_URL_ENV, startLocalRegistry } from "./local-registry.ts"

let registry: LocalRegistry | undefined

// Vitest runs globalSetup once per lane process, before workers fork. Setting the
// env var here propagates to forked workers (vitest default pool). Workers read it
// via getTestRegistryUrl().
export async function setup(): Promise<void> {
  registry = await startLocalRegistry()
  await publishWorkspace(registry.url)
  process.env[REGISTRY_URL_ENV] = registry.url
}

export async function teardown(): Promise<void> {
  await registry?.stop()
  delete process.env[REGISTRY_URL_ENV]
}
```

- [ ] **Step 3: Write a failing test that a worker sees the registry.**

Create `test/harness/registry-global-setup.test.ts`:

```ts
import { describe, expect, test } from "vitest"

import { getTestRegistryUrl } from "./local-registry.ts"

describe("registry globalSetup", () => {
  test("exposes a reachable registry URL to test workers", async () => {
    const url = getTestRegistryUrl()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)

    const response = await fetch(new URL("/-/ping", url))
    expect(response.ok).toBe(true)
  })
})
```

- [ ] **Step 4: Run it to verify it fails.**

Run: `pnpm exec vitest run --config test/generated/vitest.config.ts test/harness/registry-global-setup.test.ts`
Expected: FAIL — `DAWN_TEST_REGISTRY_URL is not set` (globalSetup not wired yet).

- [ ] **Step 5: Wire `globalSetup` into all three lane configs.**

In `test/generated/vitest.config.ts`, add to the `test` object: `globalSetup: ["test/harness/registry-global-setup.ts"],`

In `test/smoke/vitest.config.ts`, add the same line inside `test`.

In `test/runtime/vitest.config.ts`, the config has `root: resolve(rootDir, "../..")` (repo root), so the path is repo-relative: add `globalSetup: ["test/harness/registry-global-setup.ts"],` inside `test`.

- [ ] **Step 6: Run to verify it passes.**

Run: `pnpm exec vitest run --config test/generated/vitest.config.ts test/harness/registry-global-setup.test.ts`
Expected: PASS — the worker reads the URL and `/-/ping` returns ok. (If the env var does not reach the worker, switch to vitest `provide`/`inject`: have `setup({ provide })` call `provide("dawnRegistryUrl", url)`, declare `interface ProvidedContext { dawnRegistryUrl: string }`, and make `getTestRegistryUrl()` fall back to `inject`. Only do this if env propagation fails.)

- [ ] **Step 7: Commit.**

```bash
git add test/harness/local-registry.ts test/harness/registry-global-setup.ts test/harness/registry-global-setup.test.ts test/generated/vitest.config.ts test/runtime/vitest.config.ts test/smoke/vitest.config.ts
git commit -m "test(harness): per-lane Verdaccio globalSetup + registry URL handoff"
```

---

### Task 3: Scaffold from the registry (simplify `createPackagedInstaller` + `scaffoldApp`)

**Files:**
- Modify: `test/harness/packaged-app.ts` (`createPackagedInstaller`)
- Modify: `test/generated/harness.ts` and `test/generated/run-generated-app.test.ts` (`scaffoldApp` external branch)

- [ ] **Step 1: Read the current scaffolding code.**

Read `test/harness/packaged-app.ts:66-132` (`createPackagedInstaller`) and the `scaffoldApp` functions in `test/generated/harness.ts` and `test/generated/run-generated-app.test.ts`. Identify the external-mode `create-dawn-ai-app` invocation (currently `pnpm exec create-dawn-ai-app ... --dist-tag next` run from `installerDir`).

- [ ] **Step 2: Replace `createPackagedInstaller` with a registry-backed scaffolder provider.**

The packing + installer-overrides logic is no longer needed (the registry holds everything). Replace `createPackagedInstaller` so external scaffolding runs `create-dawn-ai-app` from the registry. Change the external branch of each `scaffoldApp` to:

```ts
// external mode: scaffold using the published create-dawn-ai-app, resolved from the test registry
await runPackagedCommand({
  args: ["--registry", getTestRegistryUrl(), "dlx", "create-dawn-ai-app", appRoot, "--template", "basic"],
  command: "pnpm",
  cwd: REPO_ROOT,
  transcriptPath,
})
```

Notes:
- Import `getTestRegistryUrl` from `../harness/local-registry.ts`.
- Drop `--dist-tag next` (default is `latest` — faithful to a real user).
- `pnpm dlx` resolves `create-dawn-ai-app@latest` from the registry; the unique per-run registry URL busts dlx's cache. If dlx caching serves a stale scaffolder, fall back to: `pnpm` `add create-dawn-ai-app` into a temp dir with `--registry <url>`, then `pnpm exec create-dawn-ai-app ...` from there.
- Remove all `createPackagedInstaller` calls and its now-unused packing internals. If `createPackagedInstaller` has no remaining callers, delete it and its helpers (`packPackage`, installer-dir code) from `test/harness/packaged-app.ts`; keep `runPackagedCommand`, `spawnProcess`, `createTrackedTempDir`, `cleanupTrackedTempDirs`, `markTrackedTempDirForPreserve`.

- [ ] **Step 3: Verify scaffolding compiles and a single framework test scaffolds.**

Run: `pnpm exec vitest run --config test/generated/vitest.config.ts test/generated/run-generated-app.test.ts -t "scaffolds a packaged basic app"`
Expected: The app scaffolds and installs from the registry. It will still FAIL at the fixture comparison (fixtures updated in Task 5) and possibly at the dependency-rewrite call (removed in Task 4) — that is expected at this point. Confirm the transcript shows `create-dawn-ai-app` running and `pnpm install` resolving `@dawn-ai/*` from `127.0.0.1:<port>`, with no `ERR` about tarballs.

- [ ] **Step 4: Commit.**

```bash
git add test/harness/packaged-app.ts test/generated/harness.ts test/generated/run-generated-app.test.ts
git commit -m "test(harness): scaffold generated apps from the test registry, drop packed-installer"
```

---

### Task 4: Replace dependency-rewrite with a registry `.npmrc`; delete the old mechanism

**Files:**
- Modify: `test/harness/scaffold-packaging.ts` (replace `rewriteGeneratedAppDependencies` + `FAIL_CLOSED_NPMRC` with `writeRegistryNpmrc`)
- Modify: `test/harness/scaffold-packaging.test.ts`
- Modify: all external call sites — `test/generated/harness.ts`, `test/generated/run-generated-app.test.ts`, `test/smoke/run-smoke.test.ts`, `test/runtime/run-agent-protocol.test.ts`, `test/runtime/run-runtime-contract.test.ts`, `test/generated/cli-testing-export.test.ts`

- [ ] **Step 1: Replace the body of `scaffold-packaging.ts`.**

Rewrite `test/harness/scaffold-packaging.ts` to a single small helper (delete `SCAFFOLD_PACKAGES`, `FAIL_CLOSED_NPMRC`, `rewriteGeneratedAppDependencies`, `RewriteGeneratedAppDepsOptions`, and the swap/override/throw logic):

```ts
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Point a scaffolded app at the ephemeral test registry. Real users install from
 * a registry; the generated app does exactly that — no overrides, no tarball pins.
 * A genuinely missing @dawn-ai package now 404s from Verdaccio (the registry is
 * local-only for that scope), preserving fail-closed behavior.
 */
export async function writeRegistryNpmrc(appRoot: string, registryUrl: string): Promise<void> {
  const host = registryUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
  const npmrc = [
    `registry=${registryUrl}`,
    // Parity with a private-registry user; harmless for read-only installs.
    `//${host}/:_authToken="fake"`,
    "",
  ].join("\n")
  await writeFile(join(appRoot, ".npmrc"), npmrc, "utf8")
}
```

- [ ] **Step 2: Migrate every external call site.**

At each site that currently calls `rewriteGeneratedAppDependencies({ appRoot, tarballs, extraDependencies: {...} })` inside an `if (scaffoldMode === "external" && tarballs)` (or equivalent) block, replace the whole block with:

```ts
await writeRegistryNpmrc(appRoot, getTestRegistryUrl())
```

Update imports: remove `rewriteGeneratedAppDependencies` / `SCAFFOLD_PACKAGES` / `FAIL_CLOSED_NPMRC` imports; add `writeRegistryNpmrc` from `../harness/scaffold-packaging.js` and `getTestRegistryUrl` from `../harness/local-registry.ts` (adjust relative path per file). Delete any now-unused `tarballs` plumbing in these scenario functions. The sites:
- `test/generated/run-generated-app.test.ts` (the `extraDependencies` block with `sqlite-storage` + `workspace`)
- `test/generated/harness.ts` (`extraDependencies` block with `langgraph` + `sqlite-storage` + `workspace`)
- `test/smoke/run-smoke.test.ts` (block with `permissions` + `sqlite-storage` + `workspace`)
- `test/runtime/run-agent-protocol.test.ts` (four blocks with `permissions` + `sqlite-storage` + `workspace` + `@langchain/langgraph`)
- `test/runtime/run-runtime-contract.test.ts` (block with `permissions` + `sqlite-storage` + `workspace`)

For sites that injected a NON-`@dawn` dep via `extraDependencies` (e.g. `"@langchain/langgraph": "1.3.0"`): if that pin is load-bearing for the scenario, keep it by writing it into the scaffolded `package.json` directly with a tiny inline `readFile`/`writeFile`, or confirm the template already includes a compatible range. Verify by reading each site; do not silently drop a non-`@dawn` pin.

- [ ] **Step 3: Update `scaffold-packaging.test.ts`.**

Replace the file's tests (which asserted `rewriteGeneratedAppDependencies` behavior, overrides, the fail-closed `.npmrc`, and `SCAFFOLD_PACKAGES`) with a focused test of `writeRegistryNpmrc`:

```ts
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { writeRegistryNpmrc } from "./scaffold-packaging.js"

describe("writeRegistryNpmrc", () => {
  it("writes a registry-pinned .npmrc with an auth token line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "npmrc-"))
    await writeRegistryNpmrc(dir, "http://127.0.0.1:4873/")
    const npmrc = await readFile(join(dir, ".npmrc"), "utf8")
    expect(npmrc).toContain("registry=http://127.0.0.1:4873/")
    expect(npmrc).toContain('//127.0.0.1:4873/:_authToken="fake"')
  })
})
```

- [ ] **Step 4: Verify unit + typecheck.**

Run: `pnpm exec vitest run --config test/generated/vitest.config.ts test/harness/scaffold-packaging.test.ts && pnpm -r --if-present typecheck`
Expected: PASS; typecheck clean (no dangling references to deleted symbols). Fix any remaining importers the typecheck flags.

- [ ] **Step 5: Commit.**

```bash
git add test/harness/scaffold-packaging.ts test/harness/scaffold-packaging.test.ts test/generated/harness.ts test/generated/run-generated-app.test.ts test/smoke/run-smoke.test.ts test/runtime/run-agent-protocol.test.ts test/runtime/run-runtime-contract.test.ts test/generated/cli-testing-export.test.ts
git commit -m "test(harness): install generated apps from the registry; delete overrides/rewrite/fail-closed mechanism"
```

---

### Task 5: Update fixture normalization + regenerate fixtures

**Files:**
- Modify: `test/generated/run-generated-app.test.ts` (`normalizeForFixture`)
- Modify: `test/generated/fixtures/basic.expected.json`, `test/generated/fixtures/custom-app-dir.expected.json`

- [ ] **Step 1: Update `normalizeForFixture`.**

In `test/generated/run-generated-app.test.ts`, `normalizeForFixture` currently maps tarball paths → `<tarball:...>`. Remove the tarball/packs-dir replacements. Add `@dawn-ai` version normalization so the fixture is stable across releases. Read the current monorepo version once and replace it in the normalized output:

```ts
function normalizeForFixture(
  value: GeneratedAppScenarioResult,
  context: { readonly appRoot: string; readonly dawnVersion: string },
): GeneratedAppScenarioResult {
  return normalizeValue(value, [
    [`/private${context.appRoot}`, "<app-root>"],
    [context.appRoot, "<app-root>"],
    [context.dawnVersion, "<dawn-version>"],
    ["25.6.0", "<version:@types/node>"],
    ["6.0.2", "<version:typescript>"],
    ["4.1.4", "<version:vitest>"],
  ]) as GeneratedAppScenarioResult
}
```

Thread `dawnVersion` from the caller (read `packages/core/package.json` version once at the top of the scenario, or import it). The generated app's `package.json` deps will read `"@dawn-ai/core": "latest"` (the scaffolded specifier) with NO `pnpm.overrides` — so the fixture's `package.json` block becomes the plain template. Remove the `tarballs` parameter from `normalizeForFixture` and its callers.

- [ ] **Step 2: Regenerate the `basic` fixture.**

Run: `pnpm exec vitest run --config test/generated/vitest.config.ts test/generated/run-generated-app.test.ts -t "scaffolds a packaged basic app"`
Expected: FAIL with a deep-equal diff. Inspect the diff (or read the preserved app's captured result). The new expected shape: `package.json.dependencies` = `{ "@dawn-ai/core": "latest", "@dawn-ai/cli": "latest", "@dawn-ai/langchain": "latest", "@dawn-ai/sdk": "latest", "zod": "^3.24.0" }`, matching devDeps, and **no `pnpm` key**. Update `test/generated/fixtures/basic.expected.json` to the actual normalized output (replace the dawn version with `<dawn-version>`). Re-run until green.

- [ ] **Step 3: Regenerate the `custom-app-dir` fixture.**

Run: `pnpm exec vitest run --config test/generated/vitest.config.ts test/generated/run-generated-app.test.ts -t "custom configured appDir"`
Expected: FAIL with a diff; update `test/generated/fixtures/custom-app-dir.expected.json` the same way. Re-run until green.

- [ ] **Step 4: Verify the internal-mode test still passes unchanged.**

Run: `pnpm exec vitest run --config test/generated/vitest.config.ts test/generated/run-generated-app.test.ts -t "contributor-local"`
Expected: PASS. Internal mode is untouched; its `<repo:...>` fixture and `createExpectedInternalFixture` are unaffected. If it references deleted symbols (e.g. `SCAFFOLD_PACKAGES`), update `createExpectedInternalFixture` to inline the package list it needs.

- [ ] **Step 5: Commit.**

```bash
git add test/generated/run-generated-app.test.ts test/generated/fixtures/basic.expected.json test/generated/fixtures/custom-app-dir.expected.json
git commit -m "test(harness): fixtures reflect real registry install (real version ranges, no overrides)"
```

---

### Task 6: All lanes green + cleanup + PR

**Files:** (cleanup across `test/`), `.changeset/` (verify none needed)

- [ ] **Step 1: Run the full harness.**

Run: `pnpm -r build && pnpm verify:harness`
Expected: `status: passed`, `passed=3 failed=0`. Framework, runtime, and smoke all install generated apps from Verdaccio. If a runtime/smoke fixture or assertion references a removed tarball/override, fix it the same way as Task 5.

- [ ] **Step 2: Grep for dead references.**

Run: `grep -rn "rewriteGeneratedAppDependencies\|FAIL_CLOSED_NPMRC\|SCAFFOLD_PACKAGES\|createPackagedInstaller\|extraDependencies" test/ | grep -v node_modules`
Expected: no results, OR only intentional survivors (e.g. internal-mode helpers). Delete anything orphaned. Confirm `test/harness/packaged-app.ts` no longer exports unused packing helpers.

- [ ] **Step 3: Lint + typecheck the changed files.**

Run: `pnpm exec biome check --config-path packages/config-biome/biome.json test/harness/local-registry.ts test/harness/registry-global-setup.ts test/harness/scaffold-packaging.ts && pnpm -r --if-present typecheck`
Expected: clean (apply any single-block formatting biome suggests manually; do not bare `biome --write` the repo). Typecheck passes.

- [ ] **Step 4: Confirm no changeset is required.**

Run: `BASE_REF=origin/main HEAD_REF=HEAD PR_AUTHOR=$(git config user.name) node scripts/check-changesets.mjs`
Expected: "Changesets check skipped (no user-facing changes detected)" — all changes are under `test/` + root `package.json` devDep (not `packages/*/src/`). If it flags the root `package.json`, add an empty changeset: write `.changeset/verdaccio-harness.md` containing only `---\n---\n` plus a one-line note, and re-run.

- [ ] **Step 5: Push and open the PR.**

```bash
git push -u origin feat/verdaccio-publish-harness
gh pr create --base main --title "test(harness): real Verdaccio publish harness for generated apps" --body "Replaces pack→pin→overrides→fail-closed-.npmrc with an ephemeral Verdaccio registry: publish the whole workspace atomically, install scaffolded apps from it like a real npm user (no overrides/rewrite). All lanes migrated; internal mode untouched. Spec: docs/superpowers/specs/2026-06-18-verdaccio-publish-harness-design.md. 🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 6: Watch CI to green.**

Run: `gh run watch <id> --exit-status` for the PR's CI run.
Expected: `validate` green (all three harness lanes pass under Verdaccio in CI). Investigate any uplink/port flake; the shared-store + random-port design should hold.
