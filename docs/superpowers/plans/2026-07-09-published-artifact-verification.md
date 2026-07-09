# Published Artifact Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual-only verification workflow that checks Dawn packages from the real npm registry and smoke-tests the published pgvector/OpenAI memory path outside the monorepo.

**Architecture:** Create a reusable script library for registry, temp-dir, tarball, command, and package-set helpers. Layer two runnable scripts on top: one metadata/tarball verifier and one end-to-end install/runtime smoke. Wire both into a `workflow_dispatch` GitHub Actions workflow with OpenAI gated by an explicit input.

**Tech Stack:** Node.js ESM scripts, `node:test`, npm CLI, Docker, Postgres `pgvector/pgvector:pg16`, GitHub Actions, pnpm workspace scripts.

---

## File Map

- Create `scripts/lib/published-artifacts.mjs`
  - Shared helpers for public package discovery, package set resolution, command execution, temp cleanup, registry reads, tarball extraction, package metadata validation, and dependency hygiene.
- Create `scripts/published-artifact-verify.mjs`
  - Registry/tarball metadata verifier for selected package sets.
- Create `scripts/published-artifact-smoke.mjs`
  - Real npm install smoke plus pgvector/OpenAI runtime checks.
- Create `scripts/published-artifacts.test.mjs`
  - Unit tests for package-set, registry, tarball, dependency, and OpenAI gating helpers.
- Modify `package.json`
  - Add `test:published-artifacts`, `published:verify`, and `published:smoke` scripts.
- Create `.github/workflows/published-artifact-verify.yml`
  - Manual workflow with `version`, `packageSet`, `runPgvector`, and `runOpenAI` inputs.
- Modify `docs/thread-handoff.md`
  - Add a short release-hardening command note for the manual workflow and local no-key smoke.

## Task 1: Shared Published Artifact Helpers

**Files:**
- Create: `scripts/lib/published-artifacts.mjs`
- Test: `scripts/published-artifacts.test.mjs`

- [ ] **Step 1: Add failing helper tests**

Create `scripts/published-artifacts.test.mjs` with `node:test` coverage for:

```js
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  assertCleanDependencySpecs,
  packageSets,
  resolvePackageSet,
  resolveRequestedVersion,
  validatePackageMetadata,
} from "./lib/published-artifacts.mjs"

describe("resolvePackageSet", () => {
  it("resolves the memory-pgvector-core package set", () => {
    assert.deepEqual(resolvePackageSet("memory-pgvector-core"), [
      "@dawn-ai/memory-pgvector",
      "@dawn-ai/memory",
      "@dawn-ai/langchain",
    ])
  })

  it("rejects unknown package sets", () => {
    assert.throws(() => resolvePackageSet("unknown"), /Unknown package set/)
  })
})

describe("resolveRequestedVersion", () => {
  it("resolves latest through dist-tags", () => {
    assert.equal(resolveRequestedVersion({ requested: "latest", tags: { latest: "1.2.3" } }), "1.2.3")
  })

  it("passes explicit versions through", () => {
    assert.equal(resolveRequestedVersion({ requested: "0.8.11", tags: { latest: "0.8.12" } }), "0.8.11")
  })
})

describe("assertCleanDependencySpecs", () => {
  it("rejects workspace and file dependency specs", () => {
    assert.throws(
      () =>
        assertCleanDependencySpecs("@dawn-ai/demo", {
          dependencies: { "@dawn-ai/core": "workspace:*", local: "file:../local" },
        }),
      /workspace:\*|file:/,
    )
  })
})

describe("validatePackageMetadata", () => {
  it("requires standard public package fields", () => {
    const failures = validatePackageMetadata("@dawn-ai/demo", {
      name: "@dawn-ai/demo",
      version: "1.0.0",
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/cacheplane/dawnai.git" },
      homepage: "https://github.com/cacheplane/dawnai/tree/main/packages/demo#readme",
      bugs: { url: "https://github.com/cacheplane/dawnai/issues" },
      engines: { node: ">=22.13.0" },
      publishConfig: { access: "public" },
      exports: { ".": "./dist/index.js" },
      types: "./dist/index.d.ts",
    })

    assert.deepEqual(failures, [])
  })
})
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
node --test scripts/published-artifacts.test.mjs
```

Expected: fail because `scripts/lib/published-artifacts.mjs` does not exist.

- [ ] **Step 3: Implement helper module**

Create `scripts/lib/published-artifacts.mjs` with:

```js
import { spawn } from "node:child_process"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

export const packageSets = {
  "memory-pgvector-core": ["@dawn-ai/memory-pgvector", "@dawn-ai/memory", "@dawn-ai/langchain"],
  public: null,
}

export function resolvePackageSet(name, publicPackages = []) {
  if (name === "public") {
    return publicPackages.map((pkg) => pkg.packageJson.name)
  }
  const packages = packageSets[name]
  if (!packages) {
    throw new Error(`Unknown package set "${name}". Known sets: ${Object.keys(packageSets).join(", ")}`)
  }
  return packages
}

export function resolveRequestedVersion({ requested, tags }) {
  if (requested === "latest") {
    if (!tags?.latest) {
      throw new Error("Could not resolve npm dist-tag latest")
    }
    return tags.latest
  }
  return requested
}

export async function readPublicPackages(rootDir = repoRoot) {
  const packagesDir = resolve(rootDir, "packages")
  const entries = await readdir(packagesDir, { withFileTypes: true })
  const packages = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = resolve(packagesDir, entry.name)
    const packageJson = JSON.parse(await readFile(resolve(dir, "package.json"), "utf8"))
    if (packageJson.private !== true) {
      packages.push({ dir, packageJson })
    }
  }
  return packages.sort((left, right) => left.packageJson.name.localeCompare(right.packageJson.name))
}

export function assertCleanDependencySpecs(packageName, packageJson) {
  const bad = []
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(packageJson[field] ?? {})) {
      if (String(version).startsWith("workspace:") || String(version).startsWith("file:")) {
        bad.push(`${field}.${name}@${version}`)
      }
    }
  }
  if (bad.length > 0) {
    throw new Error(`${packageName} contains unpublished dependency specs: ${bad.join(", ")}`)
  }
}

export function validatePackageMetadata(packageName, packageJson) {
  const failures = []
  for (const field of [
    "name",
    "version",
    "license",
    "repository",
    "homepage",
    "bugs",
    "engines.node",
    "publishConfig.access",
  ]) {
    if (readField(packageJson, field) === undefined) {
      failures.push(`${packageName}: missing package.json ${field}`)
    }
  }
  if (!packageJson.exports && !packageJson.bin) {
    failures.push(`${packageName}: package.json must expose exports or bin`)
  }
  if (packageJson.exports && !packageJson.types) {
    failures.push(`${packageName}: package.json has exports but no top-level types`)
  }
  return failures
}

export function readField(value, path) {
  return path.split(".").reduce((current, part) => current?.[part], value)
}

export async function npmJson(args, options = {}) {
  const output = await run("npm", [...args, "--json"], { ...options, stdio: "pipe" })
  return JSON.parse(output || "null")
}

export async function npmView(packageName) {
  const [versions, tags] = await Promise.all([
    npmJson(["view", packageName, "versions"]),
    npmJson(["view", packageName, "dist-tags"]),
  ])
  return { versions: Array.isArray(versions) ? versions : [], tags: tags ?? {} }
}

export async function makeTempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function removeDir(path) {
  await rm(path, { recursive: true, force: true })
}

export async function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: process.platform === "win32",
      stdio: options.stdio === "pipe" ? ["ignore", "pipe", "pipe"] : "inherit",
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout)
        return
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${stderr}`))
    })
  })
}
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
node --test scripts/published-artifacts.test.mjs
```

Expected: pass.

## Task 2: Registry And Tarball Verifier

**Files:**
- Modify: `scripts/lib/published-artifacts.mjs`
- Create: `scripts/published-artifact-verify.mjs`
- Test: `scripts/published-artifacts.test.mjs`

- [ ] **Step 1: Add tests for tarball expectations**

Extend `scripts/published-artifacts.test.mjs` with tests for expected file matching:

```js
import { expectedFilesForPackage } from "./lib/published-artifacts.mjs"

describe("expectedFilesForPackage", () => {
  it("includes memory-pgvector runtime files and README", () => {
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/memory-pgvector"), [
      "dist/index.js",
      "dist/index.d.ts",
      "README.md",
      "package.json",
    ])
  })
})
```

- [ ] **Step 2: Implement tarball expectation helpers**

Add to `scripts/lib/published-artifacts.mjs`:

```js
export function expectedFilesForPackage(packageName) {
  const base = ["README.md", "package.json"]
  const map = {
    "@dawn-ai/memory-pgvector": ["dist/index.js", "dist/index.d.ts", ...base],
    "@dawn-ai/memory": ["dist/index.js", "dist/index.d.ts", ...base],
    "@dawn-ai/langchain": ["dist/index.js", "dist/index.d.ts", ...base],
  }
  return map[packageName] ?? base
}
```

- [ ] **Step 3: Create verifier script**

Create `scripts/published-artifact-verify.mjs`:

```js
#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"

import {
  assertCleanDependencySpecs,
  expectedFilesForPackage,
  makeTempDir,
  npmView,
  readPublicPackages,
  removeDir,
  resolvePackageSet,
  resolveRequestedVersion,
  run,
  validatePackageMetadata,
} from "./lib/published-artifacts.mjs"

const options = parseArgs(process.argv.slice(2))
const tempRoot = await makeTempDir("dawn-published-verify-")
const failures = []

try {
  const publicPackages = await readPublicPackages()
  const selectedNames = resolvePackageSet(options.packageSet, publicPackages)

  for (const packageName of selectedNames) {
    const view = await npmView(packageName)
    const version = resolveRequestedVersion({ requested: options.version, tags: view.tags })
    if (!view.versions.includes(version)) {
      failures.push(`${packageName}@${version}: version does not exist on npm`)
      continue
    }
    if (options.version === "latest" && view.tags.latest !== version) {
      failures.push(`${packageName}: latest dist-tag mismatch (${view.tags.latest} !== ${version})`)
    }

    const packDir = join(tempRoot, packageName.replace(/[@/]/g, "-"))
    mkdirSync(packDir, { recursive: true })
    const packOutput = await run("npm", ["pack", `${packageName}@${version}`], {
      cwd: packDir,
      stdio: "pipe",
    })
    const tarball = packOutput.split("\n").map((line) => line.trim()).find((line) => line.endsWith(".tgz"))
    if (!tarball) {
      failures.push(`${packageName}@${version}: npm pack did not report a tarball`)
      continue
    }
    const extractDir = join(packDir, "extract")
    mkdirSync(extractDir, { recursive: true })
    await run("tar", ["-xzf", join(packDir, tarball), "-C", extractDir], { stdio: "pipe" })

    const packageRoot = join(extractDir, "package")
    const packageJson = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(packageRoot, "package.json"), "utf8")))
    for (const message of validatePackageMetadata(packageName, packageJson)) failures.push(message)
    try {
      assertCleanDependencySpecs(packageName, packageJson)
    } catch (error) {
      failures.push(error.message)
    }
    for (const relativePath of expectedFilesForPackage(packageName)) {
      if (!existsSync(join(packageRoot, relativePath))) {
        failures.push(`${packageName}@${version}: missing ${relativePath} in published tarball`)
      }
    }

    console.log(`META PASS ${packageName}@${version}`)
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`META FAIL ${failure}`)
    process.exit(1)
  }
  console.log(`META PASS verified ${selectedNames.length} package(s) from npm`)
} finally {
  await removeDir(tempRoot)
}

function parseArgs(args) {
  const options = { version: "latest", packageSet: "memory-pgvector-core" }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--version") options.version = args[++index]
    else if (arg === "--package-set") options.packageSet = args[++index]
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}
```

- [ ] **Step 4: Run verifier against npm**

Run:

```bash
node scripts/published-artifact-verify.mjs --version latest --package-set memory-pgvector-core
```

Expected: `META PASS` for the three selected packages.

## Task 3: Published Install And Pgvector Smoke

**Files:**
- Create: `scripts/published-artifact-smoke.mjs`
- Test: `scripts/published-artifacts.test.mjs`

- [ ] **Step 1: Add OpenAI gating test**

Extend `scripts/published-artifacts.test.mjs` with:

```js
import { shouldRunOpenAiSmoke } from "./published-artifact-smoke.mjs"

describe("shouldRunOpenAiSmoke", () => {
  it("skips when disabled", () => {
    assert.equal(shouldRunOpenAiSmoke({ enabled: false, env: {} }).status, "skip")
  })

  it("fails when enabled without OPENAI_API_KEY", () => {
    assert.throws(() => shouldRunOpenAiSmoke({ enabled: true, env: {} }), /OPENAI_API_KEY/)
  })
})
```

- [ ] **Step 2: Create smoke script skeleton**

Create `scripts/published-artifact-smoke.mjs` exporting `shouldRunOpenAiSmoke()` and running only when invoked directly:

```js
#!/usr/bin/env node
export function shouldRunOpenAiSmoke({ enabled, env = process.env }) {
  if (!enabled) return { status: "skip" }
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required when --openai is enabled")
  return { status: "run" }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
```

- [ ] **Step 3: Implement npm install smoke**

In `main()`:

- Create temp dir via `makeTempDir("dawn-published-smoke-")`.
- Run `npm init -y`.
- Use `npm pkg set type=module`.
- Install:

```bash
npm install @dawn-ai/memory-pgvector@<version> @dawn-ai/memory@<version> @dawn-ai/langchain@<version>
```

- Capture install output with `stdio: "pipe"`.
- Fail if output contains `node-gyp`, `prebuild-install`, or `gyp ERR!`.
- Read installed package manifests and assert versions.
- Log `T0 PASS`.

- [ ] **Step 4: Implement Docker pgvector lifecycle**

Add helpers:

- `assertDockerAvailable()` runs `docker info`.
- `startPgvector(containerName)` runs `docker run -d --name <name> -e POSTGRES_PASSWORD=postgres -p 5433:5432 pgvector/pgvector:pg16`.
- `waitForPg(containerName)` polls `docker exec <name> pg_isready -U postgres` with a loop, no macOS `timeout`.
- `removeContainer(containerName)` runs `docker rm -f <name>` in `finally`.

- [ ] **Step 5: Implement T1/T3 smoke script generated into temp dir**

Write `smoke-runtime.mjs` inside the temp project and run it with `DATABASE_URL`.

The script should import published packages:

```js
import { pgvectorMemoryStore } from "@dawn-ai/memory-pgvector"

const connectionString = process.env.DATABASE_URL
const namespace = `workspace=published-smoke|route=/smoke|`
const store = pgvectorMemoryStore({ connectionString, dimensions: 1536 })

await store.put({
  id: "memory_keyword_shipping",
  namespace,
  content: "the customer wants faster shipping on their orders",
  data: { subject: "shipping", preference: "faster" },
  tags: ["shipping"],
  confidence: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: "active",
})

const hits = await store.search({ namespace, query: "faster shipping", limit: 3 })
if (!hits.some((hit) => hit.content.includes("faster shipping"))) {
  throw new Error(`keyword recall missed stored fact: ${JSON.stringify(hits)}`)
}

const storeAgain = pgvectorMemoryStore({ connectionString, dimensions: 1536 })
await storeAgain.search({ namespace, query: "shipping", limit: 1 })
await storeAgain.close()
await store.close()

try {
  pgvectorMemoryStore({ connectionString, dimensions: 4001 })
  throw new Error("expected dimensions > 4000 to throw")
} catch (error) {
  if (!String(error?.message ?? error).includes("4000") || !String(error?.message ?? error).includes("halfvec")) {
    throw error
  }
}
```

Expected logs: `T1 PASS`, `T3 PASS`.

- [ ] **Step 6: Implement optional T2 OpenAI smoke**

When `--openai` is set, write a runtime script that:

- Imports `openaiEmbedder()` from `@dawn-ai/langchain`.
- Asserts `embedder.dims === 1536`.
- Calls embed on a probe and asserts `Float32Array` and length 1536.
- Stores the shipping fact with `embedding` and `embeddingModel`.
- Searches for `expedite delivery options` with `queryEmbedding` and `embedderId`.
- Asserts the shipping fact is recalled.

Expected logs: `T2 PASS`.

- [ ] **Step 7: Verify no-key smoke locally**

Run:

```bash
node scripts/published-artifact-smoke.mjs --version latest --package-set memory-pgvector-core --pgvector
```

Expected: `T0 PASS`, `T1 PASS`, `T2 SKIP`, `T3 PASS`, and cleanup of the Docker container/temp dir.

## Task 4: Package Scripts And Manual Workflow

**Files:**
- Modify: `package.json`
- Create: `.github/workflows/published-artifact-verify.yml`

- [ ] **Step 1: Add package scripts**

Modify root `package.json` scripts:

```json
{
  "published:verify": "node scripts/published-artifact-verify.mjs",
  "published:smoke": "node scripts/published-artifact-smoke.mjs",
  "test:published-artifacts": "node --test scripts/published-artifacts.test.mjs"
}
```

- [ ] **Step 2: Add manual workflow**

Create `.github/workflows/published-artifact-verify.yml`:

```yaml
name: Published Artifact Verification

on:
  workflow_dispatch:
    inputs:
      version:
        description: npm version or dist-tag to verify
        required: true
        default: latest
      packageSet:
        description: Package set to verify
        required: true
        default: memory-pgvector-core
        type: choice
        options:
          - memory-pgvector-core
          - public
      runPgvector:
        description: Run Docker pgvector smoke
        required: true
        default: true
        type: boolean
      runOpenAI:
        description: Run real OpenAI embedding smoke
        required: true
        default: false
        type: boolean

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0

      - name: Setup pnpm
        uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9
        with:
          version: 10.33.0

      - name: Setup Node.js
        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6
        with:
          node-version: 22.14.0
          cache: pnpm

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Registry and tarball verification
        run: pnpm published:verify -- --version "${{ inputs.version }}" --package-set "${{ inputs.packageSet }}"

      - name: Published install/runtime smoke
        env:
          OPENAI_API_KEY: ${{ inputs.runOpenAI && secrets.OPENAI_API_KEY || '' }}
        shell: bash
        run: |
          args=(--version "${{ inputs.version }}" --package-set "${{ inputs.packageSet }}")
          if [ "${{ inputs.runPgvector }}" = "true" ]; then args+=(--pgvector); fi
          if [ "${{ inputs.runOpenAI }}" = "true" ]; then args+=(--openai); fi
          pnpm published:smoke -- "${args[@]}"
```

- [ ] **Step 3: Validate workflow syntax locally by inspection**

Run:

```bash
node -e 'console.log("workflow yaml added")'
```

Expected: command succeeds. If `actionlint` is available, also run `actionlint .github/workflows/published-artifact-verify.yml`.

## Task 5: Documentation

**Files:**
- Modify: `docs/thread-handoff.md`

- [ ] **Step 1: Add release hardening note**

Add a short section near existing release/smoke notes:

````md
### Published artifact verification

For manual post-publish hardening, run the `Published Artifact Verification`
workflow from GitHub Actions. Start with `version=latest`,
`packageSet=memory-pgvector-core`, `runPgvector=true`, and `runOpenAI=false`.
Enable `runOpenAI=true` only when the repository `OPENAI_API_KEY` secret is
configured for this local/CI smoke purpose.

Local no-key check:

```bash
pnpm published:verify -- --version latest --package-set memory-pgvector-core
pnpm published:smoke -- --version latest --package-set memory-pgvector-core --pgvector
```

Never write API keys to files; pass `OPENAI_API_KEY` only through the one shell
or workflow step that runs the live OpenAI smoke.
````

- [ ] **Step 2: Run docs check**

Run:

```bash
node scripts/check-docs.mjs
```

Expected: pass.

## Task 6: Final Verification

**Files:**
- All files touched in previous tasks.

- [ ] **Step 1: Run unit tests**

Run:

```bash
pnpm test:published-artifacts
```

Expected: pass.

- [ ] **Step 2: Run metadata verifier against real npm**

Run:

```bash
pnpm published:verify -- --version latest --package-set memory-pgvector-core
```

Expected: `META PASS`.

- [ ] **Step 3: Run no-key published smoke against real Docker**

Run:

```bash
pnpm published:smoke -- --version latest --package-set memory-pgvector-core --pgvector
```

Expected: `T0 PASS`, `T1 PASS`, `T2 SKIP`, `T3 PASS`.

- [ ] **Step 4: Run standard repo checks for touched surfaces**

Run:

```bash
pnpm lint
node scripts/check-docs.mjs
git diff --check
```

Expected: all pass. If `pnpm lint` emits existing warnings but exits 0, record that in the final report.

- [ ] **Step 5: Optional live OpenAI verification**

Only if explicitly authorized and `OPENAI_API_KEY` is already present in the shell:

```bash
pnpm published:smoke -- --version latest --package-set memory-pgvector-core --pgvector --openai
```

Expected: `T2 PASS` with 1536-dimension `Float32Array` evidence. Do not print the key.

## Task 7: Commit And PR

- [ ] **Step 1: Review diff**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

- [ ] **Step 2: Commit implementation**

Run:

```bash
git add .github/workflows/published-artifact-verify.yml package.json scripts/lib/published-artifacts.mjs scripts/published-artifact-verify.mjs scripts/published-artifact-smoke.mjs scripts/published-artifacts.test.mjs docs/thread-handoff.md docs/superpowers/plans/2026-07-09-published-artifact-verification.md
git commit -m "ci: add published artifact verification"
```

- [ ] **Step 3: Push and open PR**

Run:

```bash
git push -u origin blove/published-artifact-verification
gh pr create --base main --head blove/published-artifact-verification --title "ci: add published artifact verification" --body-file /tmp/published-artifact-verification-pr.md
```

PR body should include:

- Manual-only workflow scope.
- Registry/tarball verification summary.
- Published install pgvector smoke summary.
- Verification commands and whether OpenAI was skipped or run.
