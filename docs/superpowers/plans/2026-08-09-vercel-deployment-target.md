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
- `packages/cli/src/lib/build/targets/vercel.ts` — coordinates staging, shared runtime generation, esbuild bundling, metadata creation, validation, root-config reconciliation, transactional publication, and artifact reporting.
- `packages/langchain/src/default-model-importer.ts` and `packages/langchain/src/static-model-importer.ts` — separate the ordinary Node dynamic fallback from the loader-free static-deployment fallback selected by the Vercel bundle.

### New test and CI files

- `packages/cli/test/vercel-target.test.ts` — registry, output shape, bundle isolation/execution, configuration ownership, validation negative controls, and transactional publication tests.
- `packages/cli/test/helpers/vercel-native-fixture.ts` — packages the built CLI, assembles two isolated fixture apps, deploys them, drives black-box checks, collects logs/receipts, and cleans exact deployment IDs.
- `packages/cli/test/helpers/vercel-native-cleanup.mjs` — validates an incrementally persisted exact-ID manifest and provides the idempotent cleanup command shared by test `finally` and workflow `always()` fallback.
- `packages/cli/test/vercel-native-lane.test.ts` — guarded `DAWN_TEST_VERCEL=1` native source/prebuilt preview test.

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
- `vercel.ts` is orchestration only; move pure behavior into the two focused helpers rather than growing another `hono.ts`-sized file.
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
- Create: `packages/cli/test/helpers/vercel-native-fixture.ts`
- Create: `packages/cli/test/helpers/vercel-native-cleanup.mjs`
- Create: `packages/cli/test/vercel-native-lane.test.ts`

- [ ] **Step 1: Add a guarded test that fails on missing required inputs**

  Gate external execution only on `DAWN_TEST_VERCEL === "1"`. When enabled, validate these names and throw one error listing all missing values:

  ```ts
  const REQUIRED_ENV = [
    "DAWN_VERCEL_TOKEN",
    "DAWN_VERCEL_ORG_ID",
    "DAWN_VERCEL_PROJECT_ID",
    "DAWN_VERCEL_DATABASE_URL",
  ] as const
  ```

  With the flag absent, use `test.skip`; never silently skip after the flag is set.

- [ ] **Step 2: Add pure receipt and SSE-parser unit tests**

  Test the helper without credentials:

  - receipt validation rejects when source or prebuilt evidence is absent;
  - completed SSE frames are parsed across arbitrary transport chunks;
  - a first token plus terminal frame in the same pre-release buffer is rejected;
  - EOF before release is rejected;
  - a completed first meaningful token frame with no terminal/EOF is accepted;
  - logs and receipts redact all four secret values.
  - cleanup rejects any persisted value that is not an exact `dpl_...` ID, skips entries already marked cleaned, and never constructs a project-wide removal command.

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-native-lane.test.ts
  ```

  Expected: RED until helper functions exist, then PASS with the native test skipped.

- [ ] **Step 3: Assemble isolated source and prebuilt fixture apps**

  In the helper:

  1. Create `const fixtureAssets = join(runRoot, "assets")`. Starting from the CLI plus every direct Dawn dependency in the fixture manifest (including `@dawn-ai/postgres-storage` and `@dawn-ai/sdk`), recursively derive the local `@dawn-ai/*` runtime dependency closure from package manifests. After the repository build, pack exactly that derived closure into `fixtureAssets`. Do not hard-code an incomplete pair or an unrelated all-workspace list; every tarball must come from the branch under test.
  2. Create two separate temp roots, each with its own `.vercel/project.json` containing only `orgId` and `projectId` from the environment.
  3. Copy every exact closure tarball into `vendor/` inside each fixture root. In each fixture's `package.json`, reference direct Dawn dependencies only by upload-safe relative `file:vendor/<exact-tarball-name>.tgz` specifiers. Add a fixture-local `pnpm-workspace.yaml` override for every vendored Dawn package so all transitive resolutions point to that package's exact relative tarball; do not retain the `runRoot/assets` path anywhere in the fixture.
  4. Write the same remaining package manifest, `dawn.config.ts`, routes, and committed recommendation-shaped `vercel.json` (`fluid: true`) into each fixture. Run `pnpm install --lockfile-only` separately in each root, then parse each `pnpm-lock.yaml` and require every `@dawn-ai/*` resolution to point at the matching relative `vendor/` tarball. Reject any registry copy of any Dawn package. Run `pnpm install --frozen-lockfile` for the local prebuilt fixture; the source fixture uploads its manifest, workspace override, lockfile, and complete derived tarball closure for Vercel's clean remote install.
  5. Before deployment, recursively inspect the source fixture and reject any symlink or dependency path that resolves outside its root, ensuring the uploaded source is self-contained.
  6. Assert the source root has neither `.dawn` nor `.vercel/output` immediately before source deploy.
  7. Build only the prebuilt root locally and assert its bundle does not contain the database URL.

  The fixture's runtime dependencies must include the packed CLI, every Dawn package in the derived override-pinned closure, `hono`, `@dawn-ai/postgres-storage`, and `@neondatabase/serverless`. Never symlink workspace paths into a directory uploaded to Vercel.

- [ ] **Step 4: Add deterministic model-free fixture routes**

  Generate three test-only routes:

  - `/state#graph` — deterministic state update/readback, exercised twice on one Agent Protocol thread so a checkpoint written by request one is observable in request two and `GET /threads/:id/state`; generate `state.ts` with `{ visits: 0, markers: [] }`, `reducers/visits.ts` that sums, `reducers/markers.ts` that appends, and a graph that returns `{ visits: 1, markers: [input.marker] }`;
  - `/stream#agent` — a raw legacy Runnable with `invoke` and `streamEvents`; it emits one `on_chat_model_stream` token, polls the barrier table keyed by a cryptographically unique `barrierId`, emits a second token, then emits root `on_chain_end` named `LangGraph`;
  - `/release#graph` — updates only the exact barrier row requested by the client and returns `{ released: true, barrierId }`.

  The streaming route's event shape must match the existing LangChain adapter contract:

  ```ts
  yield {
    data: { chunk: { content: "before-release" } },
    event: "on_chat_model_stream",
    name: "vercel-fixture",
    parent_ids: [],
    run_id: barrierId,
  }
  // Poll SELECT released FROM dawn_vercel_test_barriers WHERE barrier_id = $1.
  yield {
    data: { output: { barrierId, released: true } },
    event: "on_chain_end",
    name: "LangGraph",
    parent_ids: [],
    run_id: barrierId,
  }
  ```

  Use parameterized SQL, a run-specific ID, a finite polling deadline, and cleanup scoped to the ID. The release call goes through the fixture's `/release#graph` Agent Protocol route, so it does not depend on the streaming request and release request sharing a Fluid instance.

  Also generate fixture-only `src/middleware.ts`. It allows normal fixture requests, but for `/release` requires an unguessable per-run header value supplied only by the black-box helper. This keeps the release behavior test-only and proves the statically emitted middleware path is present in both previews; never write the header value to logs or receipts.

- [ ] **Step 5: Implement exact Vercel commands and deployment capture**

  Invoke the workspace-pinned binary with `execFile`, never a shell and never `npx`:

  ```ts
  const vercelBin = join(repoRoot, "packages/cli/node_modules/.bin/vercel")
  const common = [
    "--yes",
    "--token", token,
    "--scope", orgId,
    "--env", `DATABASE_URL=${databaseUrl}`,
    "--debug",
    "--no-color",
  ]
  ```

  Source: `vercel deploy <sourceRoot> ...common`. Prebuilt: `vercel deploy <prebuiltRoot> --prebuilt ...common`. Capture stdout (deployment URL) and stderr (debug/build log) separately without echoing the command/environment. Resolve and retain the exact `dpl_...` ID with `vercel inspect <url> --wait --json` or the Vercel deployment API. Assert the prebuilt logs do not show a remote source build.

- [ ] **Step 6: Implement the shared bounded black-box sequence**

  Run the identical function for both URLs:

  1. Bound readiness and reject protection/login HTML, build failure, or boot failure.
  2. `POST /assistants/search` and require the deterministic route IDs.
  3. `POST /threads`, run `/state#graph` twice on the same thread, and read `GET /threads/:id/state`; require the second result/state to include the first update.
  4. Insert a unique unreleased barrier through the dedicated database using a parameterized query.
  5. Start `POST /threads/:id/runs/stream` for `/stream#agent` and acquire a raw reader.
  6. Before releasing, race reads against a finite timeout and require a completed meaningful token frame containing `before-release`, with no terminal frame and no EOF.
  7. Call `/release#graph` for that exact barrier ID only after the first frame is observed.
  8. Drain and require the second token, terminal event, successful result, and EOF in order.
  9. Send a new deterministic request with a distinct thread/run ID and require success.
  10. Query runtime error logs for the exact deployment and fail on uncaught exceptions, connection leaks, or handler errors.

  This ordering is the anti-buffering proof: if Vercel buffers the response, the release is never sent before the bounded read timeout and the lane fails.

- [ ] **Step 7: Persist exact deployment IDs immediately and write a secret-free JSON receipt**

  After each deploy resolves its `dpl_...` ID, atomically rewrite `${DAWN_VERCEL_ARTIFACT_DIR}/cleanup.json` with the exact captured IDs before beginning readiness or black-box checks. Validate every entry against the exact deployment-ID format; never persist a project name, wildcard, or query. After successful removal, atomically mark that ID cleaned without deleting the history. This incremental file is the interruption-safe input to the workflow's unconditional cleanup fallback.

  The receipt schema must include:

  ```ts
  interface VercelNativeReceipt {
    readonly cliVersion: "58.9.0"
    readonly deployments: readonly [DeploymentReceipt, DeploymentReceipt]
    readonly fluidConfigVerified: true
    readonly kinds: readonly ["source", "prebuilt"]
  }
  ```

  Each deployment receipt names its exact deployment ID/URL, readiness status, discovery/state statuses, pre-release frame index, release status, terminal frame index, subsequent-request status, prebuilt/source evidence, and cleanup status. It must contain no database URL, token, org ID, or project ID. Validate the receipt at the end so a renamed flag or skipped half cannot pass.

- [ ] **Step 8: Implement exact cleanup and diagnostics**

  Implement `vercel-native-cleanup.mjs` so it reads `cleanup.json`, validates each persisted `dpl_...` value again, and removes only those exact IDs with `vercel remove <exact-id> --yes ...auth`. Treat an already-absent exact deployment as success. Export the cleanup function and invoke that same function from the test's `finally`; the workflow will invoke the file directly in `always()`. Never pass a project name, URL glob, list-derived target, or wildcard. Delete only run-specific barrier rows. Preserve build logs, runtime logs, parsed SSE frames, cleanup history, and receipt under the artifact directory, redacted before write.

- [ ] **Step 9: Run credential-free native-helper tests and static checks**

  Run:

  ```bash
  corepack pnpm --filter @dawn-ai/cli test vercel-native-lane.test.ts
  corepack pnpm --filter @dawn-ai/cli typecheck
  corepack pnpm biome check --config-path packages/config-biome/biome.json \
    packages/cli/test/helpers/vercel-native-fixture.ts \
    packages/cli/test/helpers/vercel-native-cleanup.mjs \
    packages/cli/test/vercel-native-lane.test.ts
  ```

  Expected: helper unit tests PASS and external native test is explicitly skipped because `DAWN_TEST_VERCEL` is unset.

- [ ] **Step 10: Commit**

  ```bash
  git add packages/cli/test/helpers/vercel-native-fixture.ts \
    packages/cli/test/helpers/vercel-native-cleanup.mjs \
    packages/cli/test/vercel-native-lane.test.ts
  git commit -m "test(cli): add native vercel deployment lane"
  ```

### Task 9: Add the protected native Vercel CI job

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add a failing workflow-structure check if an existing checker exists**

  Search first:

  ```bash
  rg -n "edge-workerd|workflow.*check|ci.yml" test scripts packages -g '*test*'
  ```

  If the repository has a workflow structure test, require `vercel-native`, all four env names, the `vercel-preview` environment, native receipt assertion, artifact upload, and an `always()` cleanup path. If no such checker exists, do not create a general YAML test framework for this one job; validate by parsing the YAML in Step 4.

- [ ] **Step 2: Add the same-repository/main job guard and protected environment**

  Add `vercel-native` after `edge-workerd` with:

  ```yaml
  if: >-
    (github.event_name == 'push' && github.ref == 'refs/heads/main') ||
    (github.event_name == 'pull_request' &&
     github.event.pull_request.head.repo.full_name == github.repository)
  runs-on: ubuntu-latest
  timeout-minutes: 30
  environment: vercel-preview
  ```

  Use the repository-pinned checkout, pnpm setup `10.33.0`, and Node `24.17.0` actions already used by adjacent jobs. Install with `--frozen-lockfile` and run the full workspace build because the fixture packages real `dist` output.

- [ ] **Step 3: Wire protected values and test/receipt steps**

  Map secrets only at the test step:

  ```yaml
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
    --outputFile.json=${{ runner.temp }}/vercel-native-vitest.json
  ```

  Add a subsequent Node JSON assertion that requires one passed native test and a valid receipt with exactly the `source` and `prebuilt` kinds. Add an unconditional fallback immediately after the test:

  ```yaml
  - name: Remove exact Vercel previews
    if: always()
    env:
      DAWN_VERCEL_TOKEN: ${{ secrets.DAWN_VERCEL_TOKEN }}
      DAWN_VERCEL_ORG_ID: ${{ secrets.DAWN_VERCEL_ORG_ID }}
      DAWN_VERCEL_ARTIFACT_DIR: ${{ runner.temp }}/vercel-native
    run: node packages/cli/test/helpers/vercel-native-cleanup.mjs
  ```

  The script reads the incrementally persisted exact IDs and is idempotent after the test's own `finally`. Add `actions/upload-artifact` with `if: failure()` for the redacted diagnostic directory and test JSON. This fallback is required, not optional: it covers assertion failures after deploy and runner-controlled interruption between test phases.

- [ ] **Step 4: Validate YAML structure and fork behavior**

  Parse `.github/workflows/ci.yml` with the repository's installed YAML parser (or Ruby/Python standard tooling already present) and inspect the job object. Confirm:

  - pull requests from forks cannot enter the job;
  - same-repository pull requests and `main` pushes can;
  - secrets are absent from global/job-wide logging steps;
  - the job sets Node 24 and pnpm 10.33;
  - failure diagnostics and exact cleanup remain reachable after a test failure.

  Also run:

  ```bash
  corepack pnpm lint
  git diff --check
  ```

  Expected: PASS, with only documented pre-existing warnings if any.

- [ ] **Step 5: Commit**

  ```bash
  git add .github/workflows/ci.yml
  git commit -m "ci: verify source and prebuilt vercel previews"
  ```

### Task 10: Obtain native Vercel evidence before changing support claims

**Files:**
- Verify: `.github/workflows/ci.yml`
- Verify: `packages/cli/test/vercel-native-lane.test.ts`
- Verify: `${DAWN_VERCEL_ARTIFACT_DIR}/receipt.json` from CI artifacts

- [ ] **Step 1: Run the complete local prerequisite suite before pushing**

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

  Expected: PASS; the external native case is explicitly skipped locally while parser/receipt/cleanup controls run.

- [ ] **Step 2: Push the implementation/CI branch and open or update the draft pull request**

  Use `@github:yeet` only after confirming the staged scope. The draft pull request intentionally retains the old documentation statement that Vercel is not yet observed. Do not add the support claim or changeset in this checkpoint commit.

- [ ] **Step 3: Require native source and prebuilt receipts**

  Wait for `vercel-native` in the protected `vercel-preview` environment. Inspect its receipt and require:

  - exactly one source and one prebuilt deployment;
  - `fluid: true` verified from each local config;
  - no local source build output before source deploy;
  - no remote source build during prebuilt deploy;
  - state persisted, the first meaningful SSE frame arrived before release, completion arrived after release, and a subsequent request succeeded on both;
  - exact deployment IDs were cleaned by the test and/or the unconditional fallback;
  - runtime logs contain no uncaught or leaked error.

  If native evidence fails, use `@superpowers:systematic-debugging`, fix the root cause, re-run focused local tests, push, and repeat this checkpoint. Documentation support claims remain unchanged until the receipt passes.

- [ ] **Step 4: Commit any evidence-driven fixes and record the green run**

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

  Expected: PASS; the credentialed native case is explicitly skipped when the flag is absent, while its parser/receipt tests run.

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
  - each preview persisted state, exposed the first SSE frame before release, completed after release, and served a subsequent request;
  - both exact deployment IDs were removed;
  - no runtime error log contains an uncaught/leaked error.

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
