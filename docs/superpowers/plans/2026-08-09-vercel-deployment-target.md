# First-Class Vercel Deployment Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `vercel` build target that produces a transactional, self-contained Vercel Build Output API v3 deployment and prove both clean source builds and local prebuilt deployments on native Vercel infrastructure.

**Architecture:** Extract the host-neutral Hono/web runtime emitter so the existing `hono` target and the new `vercel` target share one route/store/application generator. The Vercel target bundles that generated application into one Node 24 function, validates and atomically publishes `.vercel/output`, and reconciles—but never overwrites—root `vercel.json`. Fast tests prove the artifact, rollback, configuration, and Node execution contracts; a protected CI lane deploys separate source-built and prebuilt previews and drives the same stateful, incrementally streamed Agent Protocol checks against both.

**Tech Stack:** TypeScript/Node.js 24, Hono, esbuild, Vercel Build Output API v3, Vercel CLI 58.9.0, Vitest, PostgreSQL/Neon, GitHub Actions, pnpm 10.33.0.

---

## Working conventions

- Work from the repository root in the isolated worktree: `/Users/blove/repos/dawn/.worktrees/vercel-deployment`.
- Use the repository's Node 24 runtime for every command:

  ```bash
  export PATH="/Users/blove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
  corepack pnpm --version
  node --version
  ```

  Expected: pnpm `10.33.0` and Node `v24.x`.
- Follow TDD: add one focused failing assertion, observe the intended failure, add the smallest production change, then re-run the focused test.
- Scope Biome to edited files while iterating. Never run bare `biome check --write`.
- Keep `vercel` out of `DEFAULT_BUILD_TARGETS`; existing default output must remain byte-for-byte behaviorally unchanged.
- Do not commit generated `.dawn/**`, `.vercel/output/**`, fixture deployments, credentials, or Vercel project links.
- Commit messages and pull-request text must not mention coding-agent product names.

## File structure

### New production files

- `packages/cli/src/lib/build/targets/web-runtime.ts` — owns the shared edge-capability preflight, provider discovery, static module/store/app source generation, and dependency notice used by Hono and Vercel.
- `packages/cli/src/lib/build/targets/vercel-config.ts` — owns the recommended `vercel.json`, parsing/preservation rules, `fluid` validation, reference-file emission, and warnings.
- `packages/cli/src/lib/build/targets/vercel-output.ts` — owns Build Output API metadata validation and the backup/rename/rollback publisher for `.vercel/output`.
- `packages/cli/src/lib/build/targets/vercel-node-compat.ts` — owns the internal first-pass esbuild plugin that converts literal CommonJS Node-builtin requires into static `node:*` imports and models only `pg`'s verified optional native peer as absent.
- `packages/cli/src/lib/build/targets/vercel.ts` — coordinates staging, shared runtime generation, esbuild bundling through the Node-compatibility plugin, metadata creation, validation, root-config reconciliation, transactional publication, and artifact reporting.
- `packages/langchain/src/default-model-importer.ts` and `packages/langchain/src/static-model-importer.ts` — separate the ordinary Node dynamic fallback from the loader-free static-deployment fallback selected by the Vercel bundle.

### New test and CI files

- `packages/cli/test/vercel-target.test.ts` — registry, output shape, bundle isolation/execution, configuration ownership, validation negative controls, and transactional publication tests.
- `packages/cli/test/helpers/vercel-native-fixture.ts` — derives and packs the fixture's local Dawn dependency closure, assembles two upload-isolated apps, runs the pinned Vercel CLI through a sanitized boundary, drives the causal Agent Protocol client and log scan, and writes redacted partial evidence.
- `packages/cli/test/helpers/vercel-native-cleanup.mjs` — owns closed manifest/receipt validation, marker-based `/v6` recovery, authenticated exact-ID `/v13` deletion/absence checks, scoped Postgres cleanup, and the idempotent command shared by test `finally` and workflow `always()`.
- `packages/cli/test/vercel-native-lane.test.ts` — credential-free unit coverage for every native-harness trust boundary plus the guarded `DAWN_TEST_VERCEL=1` source/prebuilt preview test.

### Existing files to modify

- `packages/cli/src/lib/build/targets/hono.ts` — retain only the Hono target wrapper and Wrangler-specific emitter; delegate shared runtime output.
- `packages/cli/src/lib/build/targets/edge-capabilities.ts` — make diagnostics identify either `hono` or `vercel` without weakening the shared subset gate.
- `packages/cli/src/lib/build/targets/index.ts` — register `vercel`, but leave defaults unchanged.
- `packages/core/src/types.ts` — document the public target name and output.
- `packages/cli/src/commands/build.ts` — include Vercel in help text.
- `packages/cli/src/commands/check.ts` — run the shared capability/dependency checks for either edge-subset target.
- `packages/cli/test/build-targets.test.ts` — prove registration, opt-in behavior, combinations, defaults, and check parity.
- `packages/cli/test/hono-target.test.ts`, `packages/cli/test/hono-node-roundtrip.test.ts`, and `packages/cli/test/workerd-lane.test.ts` — retain/reuse shared-runtime regression evidence where needed; do not weaken assertions.
- `packages/cli/package.json` and `pnpm-lock.yaml` — pin Vercel CLI `58.9.0` exactly.
- `packages/devkit/templates/app-basic/gitignore.template` and `packages/devkit/templates/app-research/gitignore.template` — ignore `.vercel/` in generated apps.
- `.github/workflows/ci.yml` — add the protected native Vercel preview lane.
- `apps/web/content/docs/cli.mdx` and `apps/web/content/docs/deployment.mdx` — document supported Vercel Node/Fluid workflows and distinguish them from Hono/Cloudflare.
- `.changeset/calm-vercel-streams.md` — patch `@dawn-ai/cli` in the fixed release group.

### Deliberate boundaries

- `web-runtime.ts` does not know about Wrangler, Vercel JSON, filesystem transactions, or esbuild.
- `vercel-config.ts` does not create or remove `.vercel/output`.
- `vercel-output.ts` does not build code or inspect application configuration.
- `vercel-node-compat.ts` is internal to the Vercel target. It does not publish output, weaken post-bundle validation, or provide a general CommonJS loader.
- `vercel.ts` is orchestration only; move pure behavior into focused helpers rather than growing another `hono.ts`-sized file.
- The native helper owns all external mutations and cleanup. The ordinary target tests remain credential-free.

### Task 1: Register the opt-in target and mirror validation

**Files:**
- Create: `packages/cli/src/lib/build/targets/vercel.ts`
- Modify: `packages/cli/src/lib/build/targets/index.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/cli/src/commands/build.ts`
- Modify: `packages/cli/src/commands/check.ts`
- Modify: `packages/cli/src/lib/build/targets/edge-capabilities.ts`
- Modify: `packages/cli/test/build-targets.test.ts`

- [ ] **Step 1: Add failing registry/default/check tests**

  Extend `packages/cli/test/build-targets.test.ts` with these cases:

  ```ts
  test("vercel is known but remains opt-in", async () => {
    const defaultApp = await createFixtureApp({})
    await runBuild(defaultApp)
    expect(existsSync(join(defaultApp, ".vercel/output"))).toBe(false)

    const vercelApp = await createFixtureApp({
      "dawn.config.ts": 'export default { build: { targets: ["vercel"] } };\n',
    })
    await runBuild(vercelApp)
    expect(existsSync(join(vercelApp, ".vercel/output/config.json"))).toBe(true)
  })

  test("vercel combines with independent targets", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts":
        'export default { build: { targets: ["node", "langsmith", "vercel"] } };\n',
    })
    await runBuild(appRoot)
    expect(existsSync(join(appRoot, ".dawn/build/server.mjs"))).toBe(true)
    expect(existsSync(join(appRoot, ".dawn/build/langgraph.json"))).toBe(true)
    expect(existsSync(join(appRoot, ".vercel/output/config.json"))).toBe(true)
  })
  ```

  Update the `dawn check — build targets` known-target case to include `"hono", "vercel"`. Add a fixture with an edge-forbidden capability and `targets: ["vercel"]`; assert the same `DAWN_E1005` family and a message naming the `vercel` target.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test build-targets.test.ts
  ```

  Expected: FAIL because `vercel` is unknown and no target emitter exists.

- [ ] **Step 3: Add the minimal target shell and target-aware diagnostics**

  Create the temporary shell in `vercel.ts`; it is replaced by the real emitter in Task 5:

  ```ts
  import type { BuildTarget } from "./index.js"

  export const vercelTarget: BuildTarget = {
    name: "vercel",
    async emit() {
      throw new Error("vercel target output is not implemented")
    },
  }
  ```

  Register it in `buildTargets`, leaving:

  ```ts
  export const DEFAULT_BUILD_TARGETS: readonly string[] = ["node", "langsmith"]
  ```

  Refactor the diagnostic seam to accept a target label without changing violation detection:

  ```ts
  export function assertEdgeCapabilities(
    input: EdgeCapabilityInput,
    targetName: "hono" | "vercel" = "hono",
  ): void

  export async function collectEdgeDependencyNotice(
    appRoot: string,
    targetName: "hono" | "vercel" = "hono",
  ): Promise<string | undefined>
  ```

  In `check.ts`, derive configured subset targets and run the same check for each:

  ```ts
  const edgeTargets = buildTargets.filter(
    (name): name is "hono" | "vercel" => name === "hono" || name === "vercel",
  )
  for (const targetName of edgeTargets) {
    const notice = await collectEdgeDependencyNotice(manifest.appRoot, targetName)
    if (notice) writeLine(io.stdout, `\n${notice}`)
    assertEdgeCapabilities(
      { appRoot: manifest.appRoot, config: loadedConfig, manifest },
      targetName,
    )
  }
  ```

  Add the `vercel` target description to `DawnConfig.build.targets` JSDoc and update build-command help to say `hono + vercel opt-in`.

- [ ] **Step 4: Narrow both build tests while the shell intentionally throws**

  For this task, make both the opt-in test and the combination test assert that `vercel` reaches the registered shell (`rejects.toThrow(/not implemented/)`) rather than expecting Vercel output. In the combination case, assert that the preceding independent Node and LangSmith emitters ran before the shell was reached. The final successful output expectations for both tests are restored in Task 5. This keeps the commit internally truthful without inventing production output early.

- [ ] **Step 5: Run registry/check tests and scoped static checks**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test build-targets.test.ts
  corepack pnpm --filter @dawn-ai/cli typecheck
  corepack pnpm biome check --config-path packages/config-biome/biome.json \
    packages/cli/src/lib/build/targets/vercel.ts \
    packages/cli/src/lib/build/targets/index.ts \
    packages/cli/src/lib/build/targets/edge-capabilities.ts \
    packages/cli/src/commands/build.ts packages/cli/src/commands/check.ts \
    packages/cli/test/build-targets.test.ts packages/core/src/types.ts
  ```

  Expected: all PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/cli/src/lib/build/targets/vercel.ts \
    packages/cli/src/lib/build/targets/index.ts \
    packages/cli/src/lib/build/targets/edge-capabilities.ts \
    packages/cli/src/commands/build.ts packages/cli/src/commands/check.ts \
    packages/cli/test/build-targets.test.ts packages/core/src/types.ts
  git commit -m "feat(cli): register vercel build target"
  ```

### Task 2: Extract the shared web-runtime emitter without changing Hono output

**Files:**
- Create: `packages/cli/src/lib/build/targets/web-runtime.ts`
- Modify: `packages/cli/src/lib/build/targets/hono.ts`
- Modify: `packages/cli/src/lib/build/targets/edge-modules-emitter.ts`
- Test: `packages/cli/test/hono-target.test.ts`
- Test: `packages/cli/test/hono-node-roundtrip.test.ts`

- [ ] **Step 1: Add a Hono regression assertion for target-labelled output**

  Add a focused assertion that a Hono build still emits exactly these runtime files in `.dawn/build` and no Vercel tree:

  ```ts
  expect(await runtimeArtifactNames(appRoot)).toEqual([
    "app.mjs",
    "modules.edge.mjs",
    "stores.mjs",
  ])
  expect(existsSync(join(appRoot, ".vercel/output"))).toBe(false)
  ```

  Retain existing Wrangler and generated-runtime execution assertions unchanged.

- [ ] **Step 2: Run the focused Hono tests for a green refactor baseline**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test hono-target.test.ts
  ```

  Expected: PASS before the move.

- [ ] **Step 3: Move host-neutral generation into `web-runtime.ts`**

  Move, preserving behavior, the existing `STORES_ENTRY`, `emitAppEntry`, provider resolution/import generation, build-config loading, JSON-safe config serialization, static discovery, middleware discovery, edge preflight, and dependency notice. Export one narrow interface:

  ```ts
  export interface WebRuntimeEmitOptions {
    readonly outputDir: string
    readonly targetName: "hono" | "vercel"
  }

  export interface WebRuntimeArtifacts {
    readonly appPath: string
    readonly artifacts: readonly string[]
    readonly modulesPath: string
    readonly storesPath: string
  }

  export async function emitWebRuntimeArtifacts(
    ctx: BuildEmitContext,
    options: WebRuntimeEmitOptions,
  ): Promise<WebRuntimeArtifacts>
  ```

  The function must perform all capability/provider validation before its first write, call `mkdir(outputDir, { recursive: true })` only after preflight, generate relative imports against `outputDir`, and use `targetName` in generated headers/errors instead of hard-coding `hono`.

- [ ] **Step 4: Reduce `hono.ts` to shared output plus Wrangler**

  Keep `WRANGLER_COMPATIBILITY_DATE`, `WRANGLER_MARKER`, `emitWrangler`, and `workerName` in `hono.ts`. Its emitter becomes:

  ```ts
  async emit(ctx) {
    const runtime = await emitWebRuntimeArtifacts(ctx, {
      outputDir: ctx.buildDir,
      targetName: "hono",
    })
    return {
      artifacts: [...runtime.artifacts, await emitWrangler(ctx)],
    }
  }
  ```

  Update the generated `modules.edge.mjs` header in `edge-modules-emitter.ts` to accept the caller's target label rather than claiming every consumer is Hono-specific.

- [ ] **Step 5: Run Hono source, Node round-trip, and purity evidence**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test \
    hono-target.test.ts fetch-entry-purity.test.ts static-edge-equivalence.test.ts
  DAWN_REQUIRE_DOCKER=1 corepack pnpm --filter @dawn-ai/cli test hono-node-roundtrip.test.ts
  ```

  Expected: all tests PASS; if Docker is unavailable locally, record the explicit Docker failure and rely on the normal CI job for the round-trip rather than converting it into a silent skip.

- [ ] **Step 6: Run typecheck and scoped formatting**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli typecheck
  corepack pnpm biome check --config-path packages/config-biome/biome.json \
    packages/cli/src/lib/build/targets/web-runtime.ts \
    packages/cli/src/lib/build/targets/hono.ts \
    packages/cli/src/lib/build/targets/edge-modules-emitter.ts \
    packages/cli/test/hono-target.test.ts
  ```

  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add packages/cli/src/lib/build/targets/web-runtime.ts \
    packages/cli/src/lib/build/targets/hono.ts \
    packages/cli/src/lib/build/targets/edge-modules-emitter.ts \
    packages/cli/test/hono-target.test.ts
  git commit -m "refactor(cli): share web runtime build emitter"
  ```

### Task 3: Define and validate the Build Output API contract

**Files:**
- Create: `packages/cli/src/lib/build/targets/vercel-output.ts`
- Create: `packages/cli/test/vercel-target.test.ts`

- [ ] **Step 1: Write failing metadata-verifier tests**

  Add tests that create a staged tree and prove the verifier accepts only this exact contract:

  ```ts
  expect(JSON.parse(await readFile(join(output, "config.json"), "utf8"))).toEqual({
    routes: [{ dest: "/index", src: "/(.*)" }],
    version: 3,
  })
  expect(JSON.parse(await readFile(join(funcDir, ".vc-config.json"), "utf8"))).toEqual({
    handler: "index.mjs",
    launcherType: "Nodejs",
    runtime: "nodejs24.x",
  })
  ```

  Add a table-driven negative control deleting `config.json`, deleting `.vc-config.json`, deleting `index.mjs`, changing `version`, changing `runtime`, and changing the route destination. Every case must reject with the exact bad path/property.

- [ ] **Step 2: Run the verifier test and verify RED**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-target.test.ts -t "Build Output contract"
  ```

  Expected: FAIL because `validateVercelOutput` does not exist.

- [ ] **Step 3: Implement constants, writers, and structural validation**

  Add typed constants and a verifier in `vercel-output.ts`:

  ```ts
  export const VERCEL_BUILD_OUTPUT_CONFIG = {
    routes: [{ dest: "/index", src: "/(.*)" }],
    version: 3,
  } as const

  export const VERCEL_FUNCTION_CONFIG = {
    handler: "index.mjs",
    launcherType: "Nodejs",
    runtime: "nodejs24.x",
  } as const

  export async function writeVercelMetadata(outputDir: string): Promise<{
    readonly configPath: string
    readonly functionConfigPath: string
    readonly functionDir: string
  }>

  export async function validateVercelOutput(outputDir: string): Promise<void>
  ```

  Validation must parse JSON, compare required values, require `index.mjs` to be a regular file, reject symlinks that escape `index.func`, and fail on any runtime entry dependency outside the function directory. Keep this structural verifier platform-neutral; it must not invoke Vercel or read credentials.

- [ ] **Step 4: Run focused tests and static checks**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-target.test.ts -t "Build Output contract"
  corepack pnpm --filter @dawn-ai/cli typecheck
  corepack pnpm biome check --config-path packages/config-biome/biome.json \
    packages/cli/src/lib/build/targets/vercel-output.ts \
    packages/cli/test/vercel-target.test.ts
  ```

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/cli/src/lib/build/targets/vercel-output.ts \
    packages/cli/test/vercel-target.test.ts
  git commit -m "feat(cli): validate vercel build output"
  ```

### Task 4: Implement root `vercel.json` ownership and Fluid guarantees

**Files:**
- Create: `packages/cli/src/lib/build/targets/vercel-config.ts`
- Modify: `packages/cli/test/vercel-target.test.ts`

- [ ] **Step 1: Add failing config ownership tests**

  Cover all cases independently:

  1. Missing root file creates exactly:

     ```json
     {
       "$schema": "https://openapi.vercel.sh/vercel.json",
       "buildCommand": "node node_modules/@dawn-ai/cli/dist/index.js build",
       "fluid": true
     }
     ```

  2. Existing valid config with the Dawn build command and `fluid: true` remains byte-identical and emits no warning/reference.
  3. Existing valid config with extra user settings remains byte-identical.
  4. Existing config with an unknown/missing build command is preserved, writes `.dawn/build/vercel.json`, and warns with both paths.
  5. Existing config with omitted `fluid` is preserved, writes the reference, and warns that portability is not guaranteed.
  6. Existing config with `fluid: false` fails and remains byte-identical.
  7. Invalid JSON fails with the root path and parse cause.

- [ ] **Step 2: Run config tests and verify RED**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-target.test.ts -t "root vercel config"
  ```

  Expected: FAIL because `reconcileVercelConfig` does not exist.

- [ ] **Step 3: Implement parse-preserve-reference behavior**

  Export:

  ```ts
  export const RECOMMENDED_VERCEL_CONFIG = {
    $schema: "https://openapi.vercel.sh/vercel.json",
    buildCommand: "node node_modules/@dawn-ai/cli/dist/index.js build",
    fluid: true,
  } as const

  export async function reconcileVercelConfig(input: {
    readonly appRoot: string
    readonly buildDir: string
    readonly io?: CommandIo
  }): Promise<{ readonly artifactPath: string; readonly created: boolean }>
  ```

  Use `JSON.stringify(RECOMMENDED_VERCEL_CONFIG, null, 2) + "\n"`. Never rewrite an existing root file. Determine the build-command contract only from a string `buildCommand` that invokes `node_modules/@dawn-ai/cli/dist/index.js build`; do not guess from Dashboard state. For any preserved-but-unproven contract, write the recommendation to `.dawn/build/vercel.json` and emit one actionable warning. Throw `CliError` for invalid JSON or explicit `fluid: false`.

- [ ] **Step 4: Run focused tests and static checks**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-target.test.ts -t "root vercel config"
  corepack pnpm --filter @dawn-ai/cli typecheck
  corepack pnpm biome check --config-path packages/config-biome/biome.json \
    packages/cli/src/lib/build/targets/vercel-config.ts \
    packages/cli/test/vercel-target.test.ts
  ```

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/cli/src/lib/build/targets/vercel-config.ts \
    packages/cli/test/vercel-target.test.ts
  git commit -m "feat(cli): reconcile vercel deployment config"
  ```

### Task 5: Bundle and publish the Vercel target

**Files:**
- Modify: `packages/cli/src/lib/build/targets/vercel.ts`
- Modify: `packages/cli/src/lib/build/targets/vercel-output.ts`
- Modify: `packages/cli/test/vercel-target.test.ts`
- Modify: `packages/cli/test/build-targets.test.ts`
- Create: `packages/langchain/src/default-model-importer.ts`
- Create: `packages/langchain/src/static-model-importer.ts`
- Create: `packages/langchain/test/default-model-importer.test.ts`
- Modify: `packages/langchain/src/chat-model-factory.ts`
- Modify: `packages/langchain/package.json`
- Modify: `packages/cli/package.json`
- Modify: `scripts/lib/pack-check.mjs`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add failing complete-target assertions**

  Restore both Task 1 build tests to expect successful Vercel output: the opt-in case emits only Vercel output, and the combination case emits Node, LangSmith, and Vercel output. In `vercel-target.test.ts`, build a deterministic no-model fixture and assert the exact published tree:

  ```ts
  expect(await listTree(join(appRoot, ".vercel/output"))).toEqual([
    "config.json",
    "functions/index.func/.vc-config.json",
    "functions/index.func/index.mjs",
  ])
  expect(buildStdout).toContain(".vercel/output/config.json")
  expect(buildStdout).toContain(".vercel/output/functions/index.func/index.mjs")
  expect(buildStdout).not.toContain(".dawn-vercel-")
  expect(existsSync(join(appRoot, "wrangler.toml"))).toBe(false)
  ```

  Assert `index.mjs` does not contain the fixture's absolute path or the runtime `DATABASE_URL` sentinel.

- [ ] **Step 2: Run complete-target tests and verify RED**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-target.test.ts build-targets.test.ts
  ```

  Expected: FAIL because the target shell throws.

  Also add a focused LangChain test for the wished-for Node and static loader
  modules. Prove the Node module can import a data URL and the static module
  throws targeted pre-seeding guidance. Run it before creating the modules and
  observe the missing-module RED. Add an esbuild-metafile regression that
  proves ordinary conditions select only `default-model-importer.js` while the
  Vercel conditions select only `static-model-importer.js`.

- [ ] **Step 3: Preflight before creating invocation-scoped staging, then bundle**

  In `vercel.ts`, compute (but do not create) `.vercel/.dawn-vercel-<randomUUID>/runtime` and `.../output`. Call the shared emitter first:

  ```ts
  const runtime = await emitWebRuntimeArtifacts(ctx, {
    outputDir: runtimeDir,
    targetName: "vercel",
  })
  ```

  `emitWebRuntimeArtifacts` must complete capability/config/provider preflight before its first `mkdir` or write; only then may it recursively create `runtimeDir` (and therefore the invocation directory). Add a failure test with an edge-forbidden fixture and assert `.vercel` remains absent, not merely that `.vercel/output` is absent.

  Bundle `runtime.appPath` into `output/functions/index.func/index.mjs`:

  ```ts
  await build({
    absWorkingDir: ctx.appRoot,
    bundle: true,
    conditions: ["dawn-static-provider-imports", "module"],
    entryPoints: [runtime.appPath],
    format: "esm",
    minify: false,
    outfile: functionEntryPath,
    platform: "node",
    sourcemap: false,
    target: "node24",
  })
  ```

  The custom condition selects `@dawn-ai/langchain`'s loader-free static
  fallback; retaining `module` preserves esbuild's automatic resolution
  behavior after explicit conditions are supplied. The generated entry still
  calls `seedModelImporter(providerImporter)`. Ordinary Node selects a separate
  default module containing `(specifier) => import(specifier)`. The static
  fallback throws targeted guidance if application module initialization tries
  to construct a model before the generated entry seeds its provider map.
  `absWorkingDir` prevents build-machine fixture paths from entering esbuild's
  source-boundary comments.

  Do not externalize Dawn, Hono, Postgres, Neon, application, or discovered provider packages. Catch esbuild resolution failures and throw a `CliError` naming the missing specifier and explaining the function-directory boundary.

- [ ] **Step 4: Write metadata, validate, reconcile config, and publish**

  The orchestration order must be:

  ```ts
  const metadata = await writeVercelMetadata(stagedOutput)
  await validateVercelOutput(stagedOutput)
  const rootConfig = await reconcileVercelConfig(ctx)
  await publishVercelOutput({ stagedOutput, vercelDir })
  ```

  Always attempt to remove only the invocation directory in `finally`. Track
  primary failure with an explicit boolean and retained error value. If cleanup
  alone fails after successful publication, throw a targeted `CliError` whose
  cause is the cleanup error, states that final output remains valid, and leaves
  the invocation directory inspectable. If the target and cleanup both fail,
  throw `AggregateError([primaryError, cleanupError], ..., { cause:
  primaryError })` so cleanup cannot mask bundle, validation, config,
  publication, or rollback details. Return artifacts under the final
  `.vercel/output` paths plus the root or reference config path; never report
  staging paths.

- [ ] **Step 5: Implement atomic backup/rename/rollback**

  In `vercel-output.ts`, export:

  ```ts
  export async function publishVercelOutput(input: {
    readonly stagedOutput: string
    readonly vercelDir: string
    readonly fileOps?: Pick<typeof import("node:fs/promises"), "rename" | "rm">
  }): Promise<void>
  ```

  Use an invocation-owned backup beside `output`. If `output` exists, rename it to the exact backup; rename staged output to `output`; remove the backup. On publication failure, restore the backup. If rollback also fails, retain the original publication error as `cause` and include the rollback error in an `AggregateError`. Never remove `.vercel` or use a wildcard.

- [ ] **Step 6: Add failure-injection publication tests**

  Use `fileOps` to fail:

  - staged-to-output rename after backup creation: old output must be restored exactly;
  - backup removal after successful publication: new output remains valid and error names cleanup;
  - rollback rename: error preserves both causes and leaves paths inspectable.

  Also inject invocation-directory cleanup failure through a target-internal
  `rm` seam. Cover cleanup-only failure after a valid publication and combined
  target-plus-cleanup failure. The former leaves valid final output and names
  the inspectable invocation directory; the latter retains the target failure
  as aggregate cause and first error while retaining cleanup as the second
  error.

  In every case seed `.vercel/project.json` and `.vercel/.env.preview.local`, then assert both remain byte-identical. Add a pre-publication bundle failure and prove the prior output is untouched.

- [ ] **Step 7: Run focused target tests**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-target.test.ts build-targets.test.ts
  ```

  Expected: PASS.

- [ ] **Step 8: Run typecheck and scoped formatting**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli typecheck
  corepack pnpm --filter @dawn-ai/langchain exec tsc -b tsconfig.json --clean
  corepack pnpm --filter @dawn-ai/langchain exec tsc -b tsconfig.json --force
  corepack pnpm --filter @dawn-ai/langchain test default-model-importer.test.ts
  corepack pnpm --filter @dawn-ai/langchain typecheck
  corepack pnpm biome check --config-path packages/config-biome/biome.json \
    packages/cli/src/lib/build/targets/vercel.ts \
    packages/cli/src/lib/build/targets/vercel-output.ts \
    packages/cli/test/vercel-target.test.ts \
    packages/cli/test/build-targets.test.ts
  git diff --check
  ```

  Move `esbuild` from the CLI's development dependencies to runtime
  dependencies without changing its range, refresh and frozen-validate the
  lockfile, and require both loader modules' JavaScript and declarations in the
  pack-check inventory. For the Task 5 manual smoke, pack the built CLI and
  LangChain packages into a temporary consumer, override every transitive
  LangChain resolution to the local tarball, and exercise packed CLI help, the
  Vercel target import, and the static-conditioned LangChain import. Because the
  fixed workspace version may not yet exist on the registry, verification-only
  links may supply other unchanged Dawn packages; this consumer is not the
  fully self-contained deployment proof. Its lockfile must still contain zero
  registry LangChain copies. Task 8 supplies the fully vendored closure proof.
  Run the repository pack check and `publint`; every package-import target must
  exist in the tarball. Expected: PASS.

- [ ] **Step 9: Commit**

  ```bash
  git add packages/cli/src/lib/build/targets/vercel.ts \
    packages/cli/src/lib/build/targets/vercel-output.ts \
    packages/cli/test/vercel-target.test.ts \
    packages/cli/test/build-targets.test.ts \
    packages/cli/package.json packages/langchain/package.json \
    packages/langchain/src/chat-model-factory.ts \
    packages/langchain/src/default-model-importer.ts \
    packages/langchain/src/static-model-importer.ts \
    packages/langchain/test/default-model-importer.test.ts \
    scripts/lib/pack-check.mjs pnpm-lock.yaml
  git commit -m "feat(cli): emit vercel function output"
  ```

### Task 6: Prove the function is self-contained and executable on Node 24

**Files:**
- Modify: `packages/cli/test/vercel-target.test.ts`
- Reuse: `packages/cli/test/helpers/hono-edge-fixture.ts`

- [ ] **Step 1: Add a failing isolated-copy import test**

  Build the Vercel fixture, copy only `functions/index.func` to a fresh temp directory outside the app, delete the original app, and start a clean Node 24 child that imports `index.mjs`. The child must assert:

  ```js
  const module = await import(pathToFileURL(entry).href)
  if (typeof module.default?.fetch !== "function") {
    throw new Error("expected a default Web Fetch API handler")
  }
  ```

  The child process must run without Vitest aliases and with the copied function directory as `cwd`.

- [ ] **Step 2: Run the isolated test and verify the intended result**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-target.test.ts -t "self-contained"
  ```

  Expected before any correction: either PASS if Task 5 bundled fully, or FAIL on the exact unresolved import/handler shape that must be fixed. Do not weaken the test by copying `node_modules` or application sources.

- [ ] **Step 3: Add a Web Request streaming round-trip**

  Reuse the existing Docker probe/container helper. When Docker is available (and whenever `DAWN_REQUIRE_DOCKER=1`), give the child a real test `DATABASE_URL`, call the copied handler's `fetch` with `POST /threads`, a deterministic `/runs/stream` request, and a subsequent request. Read the response through `ReadableStream.getReader()` and assert meaningful SSE data plus terminal EOF. Without Docker, use the repository's established explicit skip; CI's required-Docker validate job must execute it.

  The test must execute the bundle itself, not inspect source strings, and must fail if any file above `index.func` is accessed.

- [ ] **Step 4: Fix only bundle/handler issues exposed by execution**

  If Vercel's Node function contract needs a wrapper, generate it as the esbuild entry and keep the shared app unchanged:

  ```ts
  import app from "./app.mjs"

  export default app
  ```

  Do not add a root `/api` wrapper and do not externalize packages.

- [ ] **Step 5: Run execution and Hono regressions**

  Run:

  ```bash
  DAWN_REQUIRE_DOCKER=1 corepack pnpm --filter @dawn-ai/cli test \
    vercel-target.test.ts hono-node-roundtrip.test.ts
  corepack pnpm --filter @dawn-ai/cli test hono-target.test.ts fetch-entry-purity.test.ts
  ```

  Expected: PASS with Docker; Hono remains unchanged.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/cli/src/lib/build/targets/vercel.ts \
    packages/cli/test/vercel-target.test.ts
  git commit -m "test(cli): execute isolated vercel function"
  ```

### Task 7: Pin the deployment CLI and update generated app ignores

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/devkit/templates/app-basic/gitignore.template`
- Modify: `packages/devkit/templates/app-research/gitignore.template`
- Create: `packages/devkit/test/template-gitignore.test.ts`

- [ ] **Step 1: Add failing template assertions for `.vercel/`**

  Create `packages/devkit/test/template-gitignore.test.ts`, following `template-agents-md.test.ts`'s two-template table. Read each `gitignore.template`, split non-comment lines, and assert:

  ```ts
  expect(lines.filter((line) => line === ".vercel/")).toHaveLength(1)
  expect(lines).not.toContain("vercel.json")
  ```

- [ ] **Step 2: Run the focused scaffold test and verify RED**

  Run the focused template test:

  ```bash
  corepack pnpm --filter @dawn-ai/devkit test template-gitignore.test.ts
  ```

  Expected: FAIL because `.vercel/` is absent.

- [ ] **Step 3: Add ignores and exact Vercel CLI pin**

  Add `.vercel/` after `.dawn/` in both templates. Add this exact CLI dev dependency:

  ```json
  "vercel": "58.9.0"
  ```

  Regenerate only the lockfile through pnpm:

  ```bash
  corepack pnpm install --lockfile-only
  ```

  Confirm the lockfile resolves `vercel@58.9.0`, not a range or `latest`.

- [ ] **Step 4: Run package checks**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/devkit test template-gitignore.test.ts
  corepack pnpm --filter @dawn-ai/devkit typecheck
  corepack pnpm --filter @dawn-ai/cli typecheck
  corepack pnpm install --frozen-lockfile
  ```

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/cli/package.json pnpm-lock.yaml \
    packages/devkit/templates/app-basic/gitignore.template \
    packages/devkit/templates/app-research/gitignore.template \
    packages/devkit/test/template-gitignore.test.ts
  git commit -m "build: pin vercel deployment tooling"
  ```

### Task 8: Build the native two-preview fixture and black-box client

**Files:**
- Create: `packages/cli/src/lib/build/targets/vercel-node-compat.ts`
- Modify: `packages/cli/src/lib/build/targets/vercel.ts`
- Modify: `packages/cli/test/vercel-target.test.ts`
- Create: `packages/cli/test/helpers/vercel-native-fixture.ts`
- Create: `packages/cli/test/helpers/vercel-native-cleanup.mjs`
- Create: `packages/cli/test/vercel-native-lane.test.ts`

- [ ] **Step 1: Add the guarded lane and fail closed on inputs**

  Gate only the external case on `DAWN_TEST_VERCEL === "1"`; all pure helper tests below run without credentials. With the flag absent, use an explicit `test.skip`. With it present, require Node 24, an absolute artifact directory, and all four values below in one error; never skip because one is missing:

  ```ts
  const REQUIRED_ENV = [
    "DAWN_VERCEL_TOKEN",
    "DAWN_VERCEL_ORG_ID",
    "DAWN_VERCEL_PROJECT_ID",
    "DAWN_VERCEL_DATABASE_URL",
  ] as const
  ```

  Validate `DAWN_VERCEL_ORG_ID` against `^team_[A-Za-z0-9]+$` and `DAWN_VERCEL_PROJECT_ID` against `^prj_[A-Za-z0-9]+$`; this lane supports only a team-owned, rootless, dedicated preview project.

- [ ] **Step 2: Write RED tests for the harness trust boundary**

  Add credential-free tests for:

  - exact grammars `^dpl_[A-Za-z0-9]+$`, `^vclrun_[a-f0-9]{32}$`, `^t-vcl-[a-f0-9]{32}$`, `^b-vcl-[a-f0-9]{32}$`, and `^log-vcl-[a-f0-9]{32}$` before constructing any command, URL, or SQL query;
  - canonical HTTPS origins rejecting credentials, ports, paths, queries, fragments, non-HTTPS schemes, and malformed hosts while accepting either an absolute deployment URL or a bare Vercel hostname;
  - a redactor that scans raw and URL-encoded forms across messages, stacks, argument metadata, captured stdout/stderr, API metadata/error bodies, generated bundles, and diagnostic files;
  - sanitized child environments that remove every inherited `DAWN_VERCEL_*`, `VERCEL_*`, and `NOW_*` name, `DATABASE_URL`, and all release-token aliases before adding an operation allowlist;
  - atomic JSON replacement and closed JSON parsing that reject missing keys, additional keys, invalid literals, and malformed arrays.

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-native-lane.test.ts \
    -t "native harness trust boundary"
  ```

  Expected: FAIL because the validators and safe persistence functions do not exist.

- [ ] **Step 3: Implement the minimal validators, redactor, and evidence schemas**

  Keep all serializers allowlist-based. `receipt.partial.json` is the only incremental evidence file and can never satisfy a final validator. `receipt.json` is created atomically only after both deployments and every database/deployment cleanup postcondition pass. Implement the exact closed `VercelNativeReceiptV1` and `VercelDeploymentReceiptV1` shapes from the approved design, including:

  - top-level `schemaVersion: 1`, `cliVersion: "58.9.0"`, `projectBindingVerified: true`, `kinds: ["source", "prebuilt"]`, and the tuple in that order;
  - exact route, state, middleware, causal-stream, later-request, log, reconciliation, cleanup, config/hash/readiness, and kind-specific provenance objects;
  - `beforeFrameIndex < afterFrameIndex < doneFrameIndex`, finite nonnegative indexes, positive log-row counts, valid ISO bounds, strict ID/origin/SHA-256 grammars, and every literal exactly as designed;
  - no raw organization/project value, authorization header, database URL, release credential, or complete Vercel API response.

  Re-run the Step 2 command. Expected: PASS.

- [ ] **Step 4: Commit the fail-closed native primitives**

  ```bash
  git add packages/cli/test/helpers/vercel-native-fixture.ts \
    packages/cli/test/helpers/vercel-native-cleanup.mjs \
    packages/cli/test/vercel-native-lane.test.ts
  git commit -m "test(cli): define native vercel evidence contract"
  ```

- [ ] **Step 5: Write RED package-closure and upload-isolation tests**

  Build small fake package graphs in the unit test and require the closure walker to start at the fixture's direct Dawn dependencies, follow `dependencies`, `optionalDependencies`, and only non-optional `peerDependencies`, reject missing local packages, and pack no unrelated Dawn workspace package. Add lockfile fixtures proving each expected `@dawn-ai/*` package appears exactly once from its matching `file:vendor/<tarball>` and that unexpected Dawn packages, registry/semver copies, `workspace:`, `link:`, absolute paths, repository paths, or shared-asset paths fail.

  Add filesystem tests for the asymmetric upload rules:

  - source: remove or never create `node_modules`, then reject every symlink recursively across the exact fixture/upload tree;
  - prebuilt: allow pnpm's normal `node_modules` symlinks, but reject every symlink recursively under `vendor/` and `.vercel/output/`;
  - both: require a regular, non-symlink `.vercel/project.json` with exactly the expected `orgId` and `projectId`, and no ambient/mismatched project link.

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-native-lane.test.ts \
    -t "fixture package closure|upload isolation"
  ```

  Expected: FAIL on the first missing closure/fixture helper.

- [ ] **Step 6: Assemble two fully vendored fixtures**

  After `pnpm build`, run `pnpm pack` for exactly the derived local Dawn closure from the branch under test. Copy every tarball independently into each fixture's `vendor/`; never refer back to a run-level asset directory. Give both manifests `"packageManager": "pnpm@10.33.0"`, direct relative tarball dependencies for the Dawn packages they import (`@dawn-ai/cli`, `@dawn-ai/postgres-storage`, and `@dawn-ai/sdk`), and these exact generated-runtime imports, direct imports, and required peers:

  ```json
  {
    "@langchain/core": "1.2.5",
    "@langchain/langgraph": "1.4.9",
    "@langchain/langgraph-checkpoint": "1.1.3",
    "@neondatabase/serverless": "1.1.0",
    "hono": "4.12.28",
    "pg": "8.22.0",
    "zod": "4.4.3"
  }
  ```

  Write a fixture-local `pnpm-workspace.yaml` override for every vendored Dawn package to its matching relative tarball. Generate separate frozen lockfiles, parse and validate them as in Step 5, and install only the prebuilt fixture. Both fixtures get the recommendation-shaped `vercel.json`, `build.targets: ["vercel"]`, and an exact local project link. Keep `.vercel/project.json` out of diagnostic uploads.

  Do not add `pg-native` to either manifest. Both fixtures intentionally
  exercise the ordinary JavaScript `pg.Pool` path with that optional native
  binding absent.

  Re-run the Step 5 command. Expected: PASS.

- [ ] **Step 7: Write RED tests for the exact model-free routes and release secret**

  Generate a fixture and use Dawn discovery/build output rather than comments as the assertion surface. Require exactly `/state#agent`, `/stream#agent`, and `/release#graph`; explicitly assert there is no `/state#graph` and no model/provider dependency. Require all state/stream run bodies to be exactly:

  ```ts
  { input: { messages: [{ content: markerOrBarrierId, role: "user" }] }, route }
  ```

  Add tests that generate a 32-byte random release value, expose only its SHA-256 digest to fixture generation, retain the raw base64url value in a private black-box-client closure, and prove the raw value and its URL-encoded form are absent from source, bundle, manifests, environment snapshots, receipts, logs, thrown errors, and artifacts. The 64-character digest must not be accepted as the header credential.

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-native-lane.test.ts \
    -t "model-free native fixture"
  ```

  Expected: FAIL because the fixture source generator is incomplete.

**Prerequisite compatibility checkpoint (complete and commit before Step 8):**

- [ ] **Add focused credential-free RED cases.** In `vercel-target.test.ts`, build
  through the real Vercel target and prove:

  - a CommonJS dependency's literal Node-builtin require receives the same
    callable/object value as native CommonJS, not an ESM namespace;
  - an ordinary `pg@8.22.0` `Pool` can be constructed without opening a
    connection, `pg.native === null` when `pg-native` is absent, and evaluating
    a fresh bundle with `NODE_PG_FORCE_NATIVE=1` fails with code
    `MODULE_NOT_FOUND`;
  - direct application import or require of `pg-native`, a lookalike
    `lib/native/client.js` outside the verified `pg` package boundary, missing
    or non-optional `pg-native` peer metadata, a nonliteral require, and an
    unresolved/external nonbuiltin all fail closed; and
  - literal `require("module")` and `require("node:module")` remain rejected.

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-target.test.ts \
    -t "Vercel CommonJS Node compatibility"
  ```

  Expected: FAIL because the first bundle still leaves CommonJS Node-builtin
  access and `pg`'s absent optional native binding as runtime require edges.

- [ ] **Implement the narrow first-pass compatibility plugin.** Create
  `vercel-node-compat.ts` with an internal esbuild plugin. Intercept only
  `onResolve` calls whose `kind` is `require-call` and whose path is a literal
  recognized Node builtin, excluding both `module` and `node:module`.
  Canonicalize bare names to `node:*`; load a virtual CommonJS wrapper that uses
  a static default import of that canonical module and assigns the imported
  value to `module.exports`. Do not rewrite nonliteral sites, nonbuiltins, or
  unresolved imports.

  Add one separate exact `pg-native` rule only for a `require-call` from an
  importer whose real path is exactly `lib/native/client.js` beneath its owning
  package root and whose parsed package manifest has `name: "pg"`, a string
  `peerDependencies["pg-native"]` range, and
  `peerDependenciesMeta["pg-native"].optional === true`. Load a lazy CommonJS
  stub that throws only when required and assigns `code: "MODULE_NOT_FOUND"` to
  the error. Every direct `pg-native` import, every other importer, and every
  other import kind must continue through normal esbuild resolution and reject
  when unavailable. Wire this plugin into the first build in `vercel.ts`; do
  not modify `validateVercelOutput` or its second-pass dependency rules.

- [ ] **Verify the production correction.** Re-run the focused RED command, the
  complete Vercel target suite, typecheck,
  scoped formatting, and the diff check:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-target.test.ts \
    -t "Vercel CommonJS Node compatibility"
  corepack pnpm --filter @dawn-ai/cli test vercel-target.test.ts build-targets.test.ts
  corepack pnpm --filter @dawn-ai/cli typecheck
  corepack pnpm biome check --config-path packages/config-biome/biome.json \
    packages/cli/src/lib/build/targets/vercel-node-compat.ts \
    packages/cli/src/lib/build/targets/vercel.ts \
    packages/cli/test/vercel-target.test.ts
  git diff --check
  ```

  Expected: PASS, while the existing post-bundle negative controls remain
  unchanged and green.

- [ ] **Commit the prerequisite separately before the fixture-assembly commit.**

  ```bash
  git add packages/cli/src/lib/build/targets/vercel-node-compat.ts \
    packages/cli/src/lib/build/targets/vercel.ts \
    packages/cli/test/vercel-target.test.ts
  git commit -m "fix(cli): bridge cjs node builtins for vercel"
  ```

- [ ] **Step 8: Generate the raw graph, stream, release, and middleware**

  Begin this step only after the prerequisite compatibility checkpoint above is
  green and committed. This fixture is the cross-reference that exercises the
  production bridge; it must not patch `pg`, vendor `pg-native`, or weaken Build
  Output validation locally.

  Generate one module-lifetime `pg.Pool` with `connectionString: process.env.DATABASE_URL`, `max: 2`, `connectionTimeoutMillis: 10_000`, `idleTimeoutMillis: 30_000`, `query_timeout: 5_000`, `statement_timeout: 5_000`, and an explicit `error` listener that logs only a fixed pool-error label plus allowlisted `name`/`code` fields—never the error message, stack, pool config, or connection string. Pool construction must tolerate an absent build-time value and must not query or migrate; connections and saver migrations remain lazy at runtime. The pool is not closed per request—Vercel instance teardown owns it.

  `/state#agent` must export the named `agent` as a raw compiled `StateGraph`. Define inline `messages`, `visits`, and `markers` annotations: messages and markers append, visits sum, and defaults are empty/zero. Compile with `new DawnPostgresSaver({ pool })`, its default `public.dawn_checkpoints`/`public.dawn_writes` names, empty checkpoint namespace, and default serializer. The record node reads only the latest `HumanMessage` string content, returns one visit plus that marker, and recognizes `^log-vcl-[a-f0-9]{32}$` by emitting exactly one `console.info("dawn-vercel-fixture-log", marker)` line.

  `/stream#agent` must be a raw legacy Runnable whose `streamEvents` reads the barrier ID only from the latest user message, emits public-adapter input for `"before-release"`, waits with parameterized SQL, a finite overall deadline, and a per-query deadline race on `public.dawn_vercel_test_barriers`, emits `"after-release"`, and ends with root `on_chain_end` output `{ barrierId, released: true }`. `/release#graph` performs one parameterized `UPDATE ... WHERE barrier_id = $1 AND released = false RETURNING barrier_id` and succeeds only for exactly one returned row equal to the requested target.

  Generate `src/middleware.ts` with only the SHA-256 digest embedded. When `req.routeId === "/release"`, require a well-formed base64url `x-dawn-vercel-release` header, hash it, and compare equal-length bytes with Node `timingSafeEqual`; missing, malformed, wrong, and digest-as-credential requests return `401`. Allow every other route. Do not put the raw credential in any environment variable or serializable object.

  Re-run the Step 7 command. Expected: PASS.

- [ ] **Step 9: Commit the isolated fixture assembly**

  ```bash
  git add packages/cli/test/helpers/vercel-native-fixture.ts \
    packages/cli/test/vercel-native-lane.test.ts
  git commit -m "test(cli): assemble isolated vercel fixtures"
  ```

- [ ] **Step 10: Write RED tests for CLI/API isolation and strict deploy receipts**

  Inject fake child/API transports and assert:

  - every Vercel call addresses the absolute `packages/cli/node_modules/.bin/vercel`, uses a direct argument array, and includes an absolute owner-only `--global-config` directory whose job-owned path chain is regular, non-symlink, and outside both fixtures;
  - before any external operation, `--version` runs under Node 24 and must return stdout exactly `58.9.0\n` plus stderr exactly `Vercel CLI 58.9.0 (Node.js <current-Node-version>)\n`; root `pnpm exec`, `npx`, shell execution, ambient binary lookup, and cached auth are impossible;
  - version and local Dawn-build children have no credential; credentialed deploy/inspect/log children receive only child-local `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID`; deploy alone also receives `DATABASE_URL` and the valueless argument pair `--env`, `DATABASE_URL`;
  - every credentialed deploy/inspect/log call has `--scope <orgId>`, explicitly sets `VERCEL_TELEMETRY_DISABLED=1` and `NO_UPDATE_NOTIFIER=1`, and forbids debug; token, database URL, and release credential never enter argv, while the organization scope and the log command's project scope are the only protected values permitted there; deploy runs at the fixture `cwd`, has no positional project path, explicitly passes `--target preview`, and passes `--local-config <absolute-fixture-vercel.json>`;
  - stdout accepts exactly one JSON document in only the two pinned `58.9.0` shapes: own top-level `id`/`url` with no `deployment`, or `{ status: "ok", deployment: { own id, own url } }` with no top-level `id`/`url`; prefixes, suffixes, conflicting candidates, unknown nesting, regex/URL fallback, malformed IDs, and malformed origins fail;
  - in-process API calls use only `https://api.vercel.com`, `redirect: "manual"`, finite timeouts, token only in `Authorization`, and selective response parsing.

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-native-lane.test.ts \
    -t "pinned vercel boundary|deployment receipt"
  ```

  Expected: FAIL because the command/API adapters do not exist.

- [ ] **Step 11: Implement project/config/deployment binding**

  Before each deploy and again before cleanup, call authenticated `GET /v9/projects/<projectId>?teamId=<orgId>` and require exact `id`, exact `accountId`, and `rootDirectory` absent or exactly `null` (normalize both to `null`; reject empty string and every other value). Before each deploy, parse the exact fixture `vercel.json`, require `fluid: true`, and record its SHA-256.

  Before spawning a logical deploy attempt, validate the GitHub coordinates as nonempty strings, `kind` as the exact literal union, and `logicalAttemptIndex` as a canonical nonnegative decimal string, then derive the marker from the SHA-256 of the UTF-8 bytes of this exact JSON array:

  ```ts
  const preimage = [
    "dawn-vercel-marker-v1",
    GITHUB_REPOSITORY_ID,
    GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT,
    GITHUB_JOB,
    kind,
    logicalAttemptIndex,
  ] as const
  const marker = `vclrun_${sha256(JSON.stringify(preimage)).slice(0, 32)}`
  ```

  Atomically persist that exact preimage, kind, marker, the safe-integer lower bound `attemptStartMs - 300_000`, and `spawnStarted: true` before process creation. A retry gets a new index/marker. Deploy with `--meta dawnVercelRun=<marker> --scope <orgId> --non-interactive --yes --no-wait --json --global-config <dir> --local-config <file>`; add `--prebuilt` only for the prebuilt kind and never add `--build-env`. Parse only the strict receipt shapes, atomically persist the exact ID/canonical origin, and make authoritative `GET /v13/deployments/<id>?teamId=<orgId>` match ID, origin, project, owner, marker, bounded creation time, and non-production target before inspect/readiness/log/client traffic. Persist only safe fields plus project/owner-match booleans.

  Then run `inspect <id> --scope <orgId> --wait --json --non-interactive --global-config <dir>`, require exact ID/origin and `readyState: "READY"`, and reject protection/build/boot failures. Canonicalize bare and absolute inspect URLs identically. Re-run the Step 10 command. Expected: PASS.

- [ ] **Step 12: Write RED marker-reconciliation and cleanup-authorization tests**

  With a fake Vercel API and clock, cover empty first polls, late appearance, duplicate IDs, deleted tombstones, 101-page overflow, repeated/non-integer/non-decreasing cursors, cursor cycles, changing poll upper bounds, and one final boundary query. Require the first page to use all fixed filters:

  ```text
  GET /v6/deployments
    ?teamId=<orgId>
    &projectId=<projectId>
    &meta-dawnVercelRun=<marker>
    &since=<persisted-lower-bound-ms>
    &until=<poll-start-plus-five-minutes-ms>
    &limit=100
  ```

  Later pages retain every filter and replace only `until` with the safe-integer `pagination.next`. Quiet begins only after a fully paginated poll, lasts 30 seconds, resets for each newly observed live ID, and ends with one final fully paginated query; poll every two seconds with a 180-second total deadline. One empty poll is not proof.

  Require `/v6` rows to use `uid`, bare `url`, safe-integer `created`, the exact marker and attempt window. Each candidate must pass its own authenticated `/v13` read with exact ID/origin/project/owner/marker/time/non-production binding before entering cleanup. More than one live deployment for one marker fails cardinality but still schedules every authenticated ID for cleanup.

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-native-lane.test.ts \
    -t "marker reconciliation|authenticated cleanup"
  ```

  Expected: FAIL because pagination/reconciliation is not implemented.

- [ ] **Step 13: Implement recoverable marker reconciliation and exact-ID deletion**

  Reconcile after every deploy attempt, including nonzero exit or invalid stdout, and again from workflow cleanup. The cleanup workset is the union of manifest IDs and marker-recovered IDs; every ID needs prior matching `/v13` owner validation unless a persisted successful-delete receipt already establishes it.

  Delete only with authenticated `DELETE /v13/deployments/<id>?teamId=<orgId>` and no `url` query parameter. Never call `vercel remove`, and never delete a list row directly. Success is only HTTP `200` with exact `uid` and `state: "DELETED"`; persist only those fields. Poll the same exact `/v13` GET every two seconds for at most 60 seconds and require genuine `404`. A pre-delete/DELETE `404` is idempotent success only after prior authenticated ownership (or persisted successful deletion) and a follow-up exact GET also returns `404`; never treat `401`, `403`, `410`, rate limits, malformed responses, network, or generic failures as absence.

  Re-run the Step 12 command. Expected: PASS.

- [ ] **Step 14: Write RED causal-SSE and complete-log-scan tests**

  Split CRLF delimiters and UTF-8 bytes across arbitrary chunks. Require the parser to preserve incomplete tails, parse only completed SSE frames, ignore heartbeat comments, join every `data:` line with `\n`, and JSON-parse public frames. Test that one pending `nextMeaningfulFrame()` may consume heartbeats/partial bytes, survives a one-second timeout without cancellation, and is the same promise later yielding the post-release frame. Reject early `after-release`, `done`, or EOF, and reject raw internal `on_chain_end` as a public event.

  Feed log JSONL with repeated request IDs and changed nested content. Require nonempty row `id`, exact `deploymentId`, exact synthetic `projectId` scope echo, no malformed/truthy top-level or nested `messageTruncated`, no 5xx, no top-level/nested `error` or `fatal`, and no uncaught/unhandled/handler/pool/connection/leak/lifecycle error. Canonically fingerprint every normalized top-level field and complete nested `logs[]` entry; a changed version rescans and resets quiet. Exactly 1,000 rows fails.

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-native-lane.test.ts \
    -t "causal SSE|runtime log scan"
  ```

  Expected: FAIL because the transport and log scanners do not exist.

- [ ] **Step 15: Implement the identical bounded black-box client**

  For each deployment, record log-scan start before traffic, then:

  1. Persist a cleanup-valid thread ID before sending an unknown route through an existing run endpoint; the client-chosen path idempotently creates the thread, and the response must be `404`. Never call `/assistants/search` and never add discovery probes.
  2. Persist a new thread ID, call `/state#agent` twice on that client-chosen thread path with distinct sole user-message markers, and require visits `[1, 2]`, ordered accumulated markers, the same second state from `GET /threads/:id/state`, and at least one parameterized `public.dawn_checkpoints` row for that exact thread. Mark state dispatch only after all pass.
  3. Persist distinct target and sentinel barrier IDs before creating/inserting both unreleased rows in `public.dawn_vercel_test_barriers` with parameterized SQL. Call `/release#graph` with `{ input: { barrierId: target }, route: "/release#graph" }`, first with a missing and then an incorrect header; require `401` and both SQL rows still false.
  4. Start `/stream#agent` with the target as its sole user message and `redirect: "manual"`. Before acquiring `response.body.getReader()`, require `200`, `response.redirected === false`, the requested canonical origin, and parsed MIME essence `text/event-stream`.
  5. Require public `event: chunk` data exactly `"before-release"`, no later meaningful frame/EOF, and SQL target still false. Start one pending next-meaningful-frame operation and race it against a full one-second timer without cancelling it; the timer must win.
  6. Only then send the private raw header to `/release#graph`; require exactly one returned target ID, SQL target true, and sentinel false. Mark release dispatch only now.
  7. Await the preserved pending operation for exact `event: chunk` data `"after-release"`, then exact public `event: done` data `{ "output": { "barrierId": target, "released": true } }`, then EOF. Record ordered indexes and mark stream dispatch only after EOF.
  8. Persist another thread plus unique `log-vcl-[a-f0-9]{32}` marker, send it as the sole user message to `/state#agent`, and require success. This is the later request and unique log anchor; it proves a later request, not same-instance reuse.

  Poll logs every two seconds, overall 180 seconds, with the exact package-local command:

  ```text
  logs --project <projectId> --deployment <deploymentId> --json
       --since <absolute-ISO-start> --until <absolute-ISO-end> --limit 1000
       --scope <orgId> --non-interactive --global-config <absolute-dir>
  ```

  Require exactly one occurrence of the benign marker, then 30 consecutive seconds with no new row version and a final boundary query. Treat the CLI-synthesized `projectId` only as a scope echo—ownership came from `/v9` and `/v13`. Scan all versions through that query. Empty, cross-deployment, malformed, truncated, saturated, error-bearing, or never-quiet logs fail.

  Re-run the Step 14 command. Expected: PASS.

- [ ] **Step 16: Write RED database-cleanup and aggregate-error tests**

  Use a query recorder to require bound `to_regclass($1)` checks against only this allowlist:

  ```text
  public.dawn_vercel_test_barriers
  public.dawn_writes
  public.dawn_checkpoints
  public.dawn_threads
  ```

  A null result is a verified zero-resource postcondition. For existing tables, require parameterized deletion of every persisted target/sentinel barrier, then each persisted thread from writes, checkpoints, and threads in that order, followed by zero-row verification before marking that resource cleaned. Test partial migrations, repeated cleanup, independent resource attempts, and multiple failures. With a primary failure, it remains `AggregateError.cause` and the first contained error; cleanup failures follow.

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-native-lane.test.ts \
    -t "database cleanup|native failure aggregation"
  ```

  Expected: FAIL because scoped database cleanup is incomplete.

- [ ] **Step 17: Complete orchestration, cleanup, and provenance evidence**

  Build the prebuilt fixture locally with the built Dawn CLI under a sanitized credential-free environment, validate `.vercel/output`, scan `index.mjs` for protected values, and deploy it with `--prebuilt`. For source, remove `node_modules`, assert `.dawn` and `.vercel/output` absent immediately before deploy, and perform a normal source deploy. No deploy has a positional path; each uses its fixture as `cwd` and explicitly passes `--target preview`. Capture and redact all stdout/stderr. Collect build evidence with a separate bounded package-local `inspect <id> --logs --scope <orgId> --non-interactive --global-config <dir>` call: require the exact pinned CLI/current-Node banner, exact deployment-fetch line, canonical timestamped events, and final Ready status; require the source preview to show its committed Dawn build ran remotely and require the prebuilt preview to show no remote source build. Set provenance booleans only from those command/log facts. Give every child, API request, SQL operation, body read, and polling loop a finite timeout.

  The protected lane's dedicated Vercel project must retain one inert static production bootstrap marked `dawnVercelBootstrap=v1`, with no Dawn route or database credential in its deploy command. This is a one-time external environment prerequisite for Vercel's empty-project first-deployment behavior, not test evidence. Before enabling CI, deploy and authenticate a disposable `--target preview` probe, then delete that probe by exact ID and require a `404`. Native reconciliation continues to filter only `dawnVercelRun`, so it cannot select the retained bootstrap.

  The test `finally` and `vercel-native-cleanup.mjs` must invoke the same idempotent reconciliation, exact `/v13` cleanup, and `to_regclass` database cleanup. Persist every attempt/thread/barrier and its own cleaned flag without deleting history. Attempt all resources and aggregate failures without masking the primary test error. This closes the CLI-spawn-to-receipt gap when `finally`/workflow `always()` runs; do not claim cleanup after total runner loss.

  Write redacted build logs, runtime JSONL, parsed SSE events, cleanup history, and `receipt.partial.json` incrementally. Scan raw and URL-encoded protected values before every diagnostic write and again before artifact readiness. Atomically create strict `receipt.json` only after both kinds have complete functional/provenance evidence and all deployment/database absence checks pass. Workflow fallback cleanup may close a fully populated partial receipt after proving those postconditions, but must never manufacture missing functional evidence.

  Re-run the Step 16 command. Expected: PASS.

- [ ] **Step 18: Run all credential-free helper checks**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-native-lane.test.ts
  corepack pnpm --filter @dawn-ai/cli typecheck
  corepack pnpm biome check --config-path packages/config-biome/biome.json \
    packages/cli/test/helpers/vercel-native-fixture.ts \
    packages/cli/test/helpers/vercel-native-cleanup.mjs \
    packages/cli/test/vercel-native-lane.test.ts
  git diff --check
  ```

  Expected: all pure tests PASS and the external case reports one explicit skip because `DAWN_TEST_VERCEL` is unset.

- [ ] **Step 19: Commit the bounded native client and cleanup**

  ```bash
  git add packages/cli/test/helpers/vercel-native-fixture.ts \
    packages/cli/test/helpers/vercel-native-cleanup.mjs \
    packages/cli/test/vercel-native-lane.test.ts
  git commit -m "test(cli): prove native vercel execution"
  ```

### Task 9: Add the protected native Vercel CI job

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `packages/sandbox/test/ci-workflow-pins.test.ts`

- [ ] **Step 1: Add a RED parsed-workflow contract test**

  Extend the existing YAML-parsing test rather than adding string matching. Require a `vercel-native` job whose guard admits only `main` pushes and same-repository pull requests, whose environment is `vercel-preview`, and whose setup pins pnpm `10.33.0` and Node `24.17.0`. Assert checkout/install/full-build precede the native test.

  Parse every job/step `env` object and require protected values only in these process scopes:

  - native test: all four `DAWN_VERCEL_*` secrets plus artifact directory and `DAWN_TEST_VERCEL=1`;
  - `always()` cleanup: token, organization, project, database URL, and artifact directory;
  - diagnostic sanitization: the same four protected values only long enough to scan/redact failure artifacts;
  - receipt assertion and upload: no secrets.

  Require cleanup to precede the final receipt assertion, use `if: always()`, and invoke the checked-in cleanup module. Require failure artifacts to upload only a sanitizer-produced directory, never `.vercel/project.json`, the fixture roots, or an unsanitized runner directory.

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/sandbox test ci-workflow-pins.test.ts \
    -t "native Vercel job"
  ```

  Expected: FAIL because `jobs.vercel-native` is absent.

- [ ] **Step 2: Add the guarded protected job and pinned toolchain**

  Add `vercel-native` after the existing workerd lane:

  ```yaml
  vercel-native:
    if: >-
      (github.event_name == 'push' && github.ref == 'refs/heads/main') ||
      (github.event_name == 'pull_request' &&
       github.event.pull_request.head.repo.full_name == github.repository)
    runs-on: ubuntu-latest
    timeout-minutes: 45
    environment: vercel-preview
  ```

  Reuse the repository-pinned checkout/setup actions, pnpm `10.33.0`, and Node `24.17.0`. Run `pnpm install --frozen-lockfile` then `pnpm build`; the fixtures pack branch-local `dist` output. Do not place any protected value at workflow or job scope. Fork pull requests rely on the credential-free Task 8 tests in `validate` and cannot enter this environment.

- [ ] **Step 3: Run the native test with step-local secrets**

  Create `${{ runner.temp }}/vercel-native` with owner-only permissions before the credentialed step. Give only the test process all four secrets and write the Vitest JSON inside the artifact directory:

  ```yaml
  - name: Run native Vercel previews
    id: native-vercel
    env:
      DAWN_TEST_VERCEL: "1"
      DAWN_VERCEL_TOKEN: ${{ secrets.DAWN_VERCEL_TOKEN }}
      DAWN_VERCEL_ORG_ID: ${{ secrets.DAWN_VERCEL_ORG_ID }}
      DAWN_VERCEL_PROJECT_ID: ${{ secrets.DAWN_VERCEL_PROJECT_ID }}
      DAWN_VERCEL_DATABASE_URL: ${{ secrets.DAWN_VERCEL_DATABASE_URL }}
      DAWN_VERCEL_ARTIFACT_DIR: ${{ runner.temp }}/vercel-native
    run: >-
      pnpm --filter @dawn-ai/cli test vercel-native-lane.test.ts
      --reporter=json
      --outputFile.json=${{ runner.temp }}/vercel-native/vitest.json
  ```

  Missing secrets must make a same-repository run fail with all missing names; never conditionally skip this step.

- [ ] **Step 4: Add unconditional reconciliation and cleanup**

  Immediately after the native step, invoke the idempotent cleanup entry point even when the test failed:

  ```yaml
  - name: Reconcile and remove native Vercel resources
    id: native-vercel-cleanup
    if: always()
    env:
      DAWN_VERCEL_TOKEN: ${{ secrets.DAWN_VERCEL_TOKEN }}
      DAWN_VERCEL_ORG_ID: ${{ secrets.DAWN_VERCEL_ORG_ID }}
      DAWN_VERCEL_PROJECT_ID: ${{ secrets.DAWN_VERCEL_PROJECT_ID }}
      DAWN_VERCEL_DATABASE_URL: ${{ secrets.DAWN_VERCEL_DATABASE_URL }}
      DAWN_VERCEL_ARTIFACT_DIR: ${{ runner.temp }}/vercel-native
    run: node packages/cli/test/helpers/vercel-native-cleanup.mjs --cleanup
  ```

  This process receives secrets only in its environment, rechecks `/v9` project/root binding, reconciles every persisted marker through fully paginated `/v6`, validates candidates through `/v13`, deletes exact IDs through `/v13`, proves exact GET `404`, and removes/verifies only persisted database rows through `to_regclass`. It must aggregate cleanup failures and never use a project-wide target.

- [ ] **Step 5: Assert only the closed final receipt**

  After successful test and cleanup steps, run `node packages/cli/test/helpers/vercel-native-cleanup.mjs --assert-receipt` with only `DAWN_VERCEL_ARTIFACT_DIR` set. It must require exactly one passed native Vitest case and the strict `receipt.json` described in Task 8; `receipt.partial.json`, a missing half, additional key, uncleared resource, or reordered kind tuple fails. This step receives no secret.

- [ ] **Step 6: Sanitize and upload failure diagnostics**

  Add an `if: always()` preparation step with `id: native_vercel_diagnostics` and the four secrets scoped only to that process. Invoke `node packages/cli/test/helpers/vercel-native-cleanup.mjs --prepare-artifacts`. It must combine the already-redacted source-build logs, exact-deployment runtime logs, parsed client events, Vitest JSON, incremental cleanup history, and partial/final receipt into a separate `upload/` directory; exclude fixture roots and `.vercel/project.json`; reject raw and URL-encoded protected values before declaring the directory uploadable. The Task 8 harness must already have scanned the client-only release value while it was in memory.

  Upload only `upload/` with pinned `actions/upload-artifact`, `if: failure() && steps.native_vercel_diagnostics.outcome == 'success'`, and a short retention (three days). If sanitization fails, fail closed and do not upload possibly sensitive files. The upload step itself receives no secret.

- [ ] **Step 7: Run the workflow test and repository checks**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/sandbox test ci-workflow-pins.test.ts
  corepack pnpm lint
  node scripts/check-docs.mjs
  git diff --check
  ```

  Expected: PASS; the parsed test proves the fork guard, toolchain, secret scopes, `always()` cleanup, closed receipt assertion, and sanitized artifact path.

- [ ] **Step 8: Commit**

  ```bash
  git add .github/workflows/ci.yml packages/sandbox/test/ci-workflow-pins.test.ts
  git commit -m "ci: verify source and prebuilt vercel previews"
  ```

### Task 10: Obtain native Vercel evidence before changing support claims

**Files:**
- Verify: `.github/workflows/ci.yml`
- Verify: `packages/cli/test/vercel-native-lane.test.ts`
- Verify: the protected job's strict `${DAWN_VERCEL_ARTIFACT_DIR}/receipt.json` assertion
- Verify: `${DAWN_VERCEL_ARTIFACT_DIR}/cleanup.json` from CI artifacts on failure

- [ ] **Step 1: Run the complete credential-free prerequisite suite before pushing**

  Run:

  ```bash
  corepack pnpm install --frozen-lockfile
  corepack pnpm build
  corepack pnpm --filter @dawn-ai/cli test \
    build-targets.test.ts vercel-target.test.ts vercel-native-lane.test.ts \
    hono-target.test.ts fetch-entry-purity.test.ts static-edge-equivalence.test.ts
  node scripts/check-docs.mjs
  git diff --check
  ```

  Expected: PASS; exactly the external case is skipped, while package-closure, upload-symlink, environment/argv, strict deploy JSON, project/API binding, SSE, log, marker-pagination, exact-delete/404, database-cleanup, redaction, partial/final receipt, and workflow-structure controls all run.

- [ ] **Step 2: Push the implementation/CI branch and open or update the draft pull request**

  Use `@github:yeet` only after confirming the staged scope. The draft pull request intentionally retains the old documentation statement that Vercel is not yet observed. Do not add the support claim or changeset in this checkpoint commit.

- [ ] **Step 3: Require one strict final native receipt**

  Wait for `vercel-native` in the protected `vercel-preview` environment. Accept only `receipt.json`; `receipt.partial.json` is diagnostic evidence and cannot pass. Run the same strict validator as CI and require:

  - schema version `1`, CLI `58.9.0`, verified project binding, and exactly the ordered `source`/`prebuilt` tuple with no unknown keys;
  - each fixture's explicit config has `fluid: true` and the recorded SHA-256, and each deployment reached authoritative `READY` under the expected project/owner/marker/origin binding;
  - unknown-route `404` plus successful functional dispatch of exactly `/state#agent`, `/stream#agent`, and `/release#graph`; no `/assistants/search` evidence;
  - visits `[1, 2]`, markers in order, the generated state read matching the second run, and a physical checkpoint for each deployment;
  - missing/wrong release-header `401`, exact target-only release, and the sentinel still unreleased at assertion time;
  - `200` non-redirected `text/event-stream`, first chunk before the preserved one-second quiet read, authorized release only afterward, exact second chunk then exact `done`, and EOF after done with ordered finite indexes;
  - a later request whose unique canonical marker is present in complete exact-deployment logs, followed by the 30-second quiet/final-query scan with no truncation, 5xx, fatal/error level, or lifecycle error;
  - source provenance proves no local prebuilt output and an observed remote build; prebuilt provenance proves validated local output, `--prebuilt`, and no remote source build;
  - reconciliation cardinality/binding evidence and cleanup postconditions showing every authenticated deployment absent by exact `/v13` GET `404` and every persisted database row absent.

  If native evidence fails, use `@superpowers:systematic-debugging`, fix the root cause, re-run focused local tests, push, and repeat this checkpoint. Documentation support claims remain unchanged until the receipt passes.

- [ ] **Step 4: Audit cleanup and failure diagnostics before accepting the run**

  Inspect the job structure/run summary to confirm the `always()` cleanup executed after the native test, including on a deliberately observed test failure during development. For any failed attempt, inspect only the sanitized short-lived artifact and require the persisted marker coordinates to reconcile to every attempted deployment, exact `/v13` deletion/404 evidence or an explicit cleanup failure, scoped `to_regclass` database evidence, and no raw or URL-encoded protected values. Do not describe this as cleanup after total runner loss.

- [ ] **Step 5: Commit any evidence-driven fixes and record the green run**

  Keep CI URLs/run IDs in the pull-request evidence, not in source files. Once green, proceed to Task 11; the next push will cause the lane to re-run against the documentation commit as a final regression.

### Task 11: Document the supported deployment paths and add the changeset

**Files:**
- Modify: `apps/web/content/docs/cli.mdx`
- Modify: `apps/web/content/docs/deployment.mdx`
- Create: `.changeset/calm-vercel-streams.md`

- [ ] **Step 1: Add the CLI target entry**

  In `cli.mdx`, list four targets and describe `vercel` as opt-in. State that it emits `.vercel/output` with one Node 24 function and a root `vercel.json` scaffold, uses the same edge-subset capability gate as Hono, and is not added to the defaults.

- [ ] **Step 2: Add a dedicated Vercel Node/Fluid section**

  In `deployment.mdx`, add exact configuration:

  ```ts
  import { config } from "@dawn-ai/cli"

  export default config({
    build: { targets: ["vercel"] },
  })
  ```

  Document all three supported flows:

  ```text
  Git-connected: commit vercel.json; Vercel installs and runs the Dawn build command
  Local source:  vercel deploy
  Local prebuilt: dawn build && vercel deploy --prebuilt
  ```

  Explain:

  - Node 24 and explicit `fluid: true`;
  - `DATABASE_URL` is a runtime variable and must be configured for previews/production;
  - `.vercel/` is generated and should be ignored, while root `vercel.json` is committed;
  - Dawn creates `vercel.json` once, preserves authored settings, writes `.dawn/build/vercel.json` as a reference when reconciliation is needed, and rejects explicit `fluid: false`;
  - Vercel shares the web-standard/Postgres subset with Hono but is not the Cloudflare `hono` target and emits no Wrangler file;
  - source and prebuilt previews, state, incremental SSE, and subsequent requests are observed by the native lane; Git webhook delivery and Dashboard provisioning remain Vercel-owned behavior.

  Replace the old statement that Vercel is only inferred. Keep Deno and Bun explicitly unobserved.

- [ ] **Step 3: Add the fixed-group patch changeset**

  Create a changeset containing only:

  ```md
  ---
  "@dawn-ai/cli": patch
  ---

  Add an opt-in Vercel deployment target with source-build and prebuilt output support.
  ```

  The fixed-group release configuration will expand the release train as intended; do not manually list every package.

- [ ] **Step 4: Run docs and changeset checks**

  Run:

  ```bash
  node scripts/check-docs.mjs
  node scripts/check-changesets.mjs
  corepack pnpm --filter @dawn-ai/web typecheck
  git diff --check
  ```

  Expected: PASS and no banned/overstated deployment wording.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/content/docs/cli.mdx \
    apps/web/content/docs/deployment.mdx .changeset
  git commit -m "docs: add vercel deployment guide"
  ```

### Task 12: Run the complete verification and prepare merge evidence

**Files:**
- Verify all changed files
- Update plan checkboxes as tasks finish: `docs/superpowers/plans/2026-08-09-vercel-deployment-target.md`

- [ ] **Step 1: Rebuild from the Node 24 workspace baseline**

  Run:

  ```bash
  corepack pnpm install --frozen-lockfile
  corepack pnpm build
  ```

  Expected: PASS. This must precede tests that execute `dist`.

- [ ] **Step 2: Run focused CLI and scaffold suites**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test \
    build-targets.test.ts vercel-target.test.ts vercel-native-lane.test.ts \
    hono-target.test.ts fetch-entry-purity.test.ts static-edge-equivalence.test.ts
  corepack pnpm --filter @dawn-ai/devkit test
  ```

  Expected: PASS; the credentialed native case is explicitly skipped when the flag is absent, while its closure, command/API, transport, log, reconciliation, cleanup, redaction, and closed-receipt tests run.

- [ ] **Step 3: Run Docker-backed Node execution and Hono regression**

  Run:

  ```bash
  DAWN_REQUIRE_DOCKER=1 corepack pnpm --filter @dawn-ai/cli test \
    vercel-target.test.ts hono-node-roundtrip.test.ts
  ```

  Expected: PASS with Docker. Confirm no fixture Node process, Vercel CLI process, Postgres container, or listening test port remains afterward.

- [ ] **Step 4: Run the repository Definition of Done**

  Run:

  ```bash
  corepack pnpm ci:validate
  node scripts/check-changesets.mjs
  ```

  Expected in order: lint, build-cache check, build, typecheck, test, docs check, pack check, harness self-test/framework/runtime/smoke, local release-script tests, and changeset validation all PASS.

- [ ] **Step 5: Re-run the native Vercel lane after documentation and release metadata**

  Push the Task 11 documentation/changeset commit and require the protected `vercel-native` lane to remain green. Reconfirm that:

  - both `source` and `prebuilt` previews exist in the receipt;
  - both used `fluid: true` from the fixture config;
  - the source fixture had no local build output;
  - the prebuilt preview performed no remote source build;
  - each preview persisted state, kept the sentinel unreleased, exposed the first SSE frame and a preserved quiet read before the authorized target release, completed in exact public-frame order, and served the canonical later log-marker request;
  - marker reconciliation found the expected cardinality, every authenticated exact-ID workset member reached `/v13` `404`, and `to_regclass`-aware cleanup proved every persisted thread/barrier row absent;
  - the complete exact-deployment log scan reached its final quiet-boundary query with no truncation, 5xx, fatal/error level, or lifecycle error.

  If native evidence fails, use `@superpowers:systematic-debugging`; fix the root cause and repeat the focused and native lanes. Do not revise documentation to claim native support before this passes.

  Also require the existing `edge-workerd` job to be green because the shared web-runtime emitter changed. A credentialed Vercel green does not substitute for the Cloudflare regression lane.

- [ ] **Step 6: Inspect the final diff and history**

  Run:

  ```bash
  git status --short
  git diff --check origin/main...HEAD
  git diff --stat origin/main...HEAD
  git log --oneline origin/main..HEAD
  ```

  Expected: clean worktree; no generated `.dawn`/`.vercel` output; only planned source, tests, CI, docs, templates, lockfile, plan/spec, and changeset changes; focused commits in implementation order.

- [ ] **Step 7: Request final code review**

  Use `@superpowers:requesting-code-review` against the approved spec and this plan. Resolve every Critical/Important finding, re-run the affected focused tests, then repeat `ci:validate` if production, lockfile, workflow, or generated artifact behavior changed.

- [ ] **Step 8: Finish the branch**

  Use `@superpowers:verification-before-completion` before claiming success, then `@superpowers:finishing-a-development-branch` to confirm the two pull-request integration path. Merge only after required credential-free checks and the protected native Vercel lane are green.
