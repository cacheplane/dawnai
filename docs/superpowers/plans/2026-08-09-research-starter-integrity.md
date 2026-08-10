# Research Starter Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the default packaged research scaffold trustworthy from creation through npm install, validation, deterministic AG-UI activation, build, and artifact start.

**Architecture:** Keep `examples/research/server` as the dogfooded behavioral source, enforce exhaustive byte parity across the shared behavior tree, and verify the generated product through one candidate-registry npm 11 scenario. The scenario reuses one installed app, one aimock server, bounded subprocess helpers, and preserved transcripts to cover the authoring lifecycle, a safe research run, a permission interrupt/resume, and a built-server `.env` roundtrip.

**Tech Stack:** TypeScript, Node.js 24, npm 11, pnpm workspaces, Vitest, Verdaccio, `@copilotkit/aimock`, AG-UI/SSE, Changesets, Biome, Turbo.

**Approved spec:** `docs/superpowers/specs/2026-08-09-research-starter-integrity-design.md`

**Execution baseline:** `origin/main` at `35e937e0` or later. The design branch was rebased after PRs #429, #430, #432, #434, and #435 landed; only `apps/web/content/docs/cli.mdx` changed within this plan's target surface.

---

### Task 0: Confirm the execution baseline and toolchain

**Files:**
- Read: `AGENTS.md`
- Read: `docs/superpowers/specs/2026-08-09-research-starter-integrity-design.md`
- Read: `docs/superpowers/plans/2026-08-09-research-starter-integrity.md`
- Verify only: repository root

- [ ] **Step 1: Confirm the branch is clean and based on current main**

```bash
git status --short --branch
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
```

Expected: the worktree is clean and the last command exits `0`. If `origin/main` advanced, rebase before editing and re-run the overlap check below.

- [ ] **Step 2: Recheck target-file overlap if main advanced**

```bash
git diff --name-status HEAD..origin/main -- \
  packages/devkit \
  packages/create-dawn-app \
  packages/cli/README.md \
  test/generated \
  test/harness \
  examples/research \
  apps/web/content/docs/getting-started.mdx \
  apps/web/content/docs/cli.mdx \
  apps/web/content/docs/recipes/add-a-tool.mdx
```

Expected: no unreviewed overlap. If there is overlap, re-read those files and update the affected plan step without widening scope into memory internals, edge runtime behavior, or the web UI.

- [ ] **Step 3: Select Node 24 and assert the normative npm major**

```bash
node --version
npm --version
pnpm --version
```

Expected: Node is `v24.x`, npm is `11.x`, and pnpm is available. On the current workstation, the known Node 24 runtime is `/Users/blove/.nvm/versions/node/v24.18.0/bin`; prepend it to `PATH` if the shell still selects Node 22.

- [ ] **Step 4: Install dependencies and build the workspace before any packaged/dist-backed test**

```bash
pnpm install --frozen-lockfile
pnpm build
```

Expected: PASS. This build is mandatory because the registry and generated-app lanes pack and execute `dist/` artifacts.

### Task 1: Replace the test-only intersection with exhaustive behavioral parity

**Files:**
- Modify: `packages/devkit/test/templates.test.ts`
- Modify: `packages/devkit/templates/app-research/src/app/research/index.ts`
- Create: `packages/devkit/templates/app-research/.env.example`
- Source of truth: `examples/research/server/src/app/research/index.ts`
- Modify source of truth: `examples/research/server/.env.example`
- Test: `packages/devkit/test/templates.test.ts`

- [ ] **Step 1: Write a filesystem-derived parity inventory**

Replace `sharedTestFiles()` and the two shared-test assertions with a comparator rooted at exactly:

```ts
const RESEARCH_PARITY_ROOTS = [
  ".env.example",
  "AGENTS.md",
  "dawn.config.ts",
  "src",
  "test",
  "workspace",
] as const
```

Implement these local helpers in `packages/devkit/test/templates.test.ts`:

```ts
interface ParityEntry {
  readonly kind: "directory" | "file"
  readonly normalizedPath: string
  readonly physicalPath: string
}

interface ParityReport {
  readonly contentDriftedPaths: readonly string[]
  readonly missingTemplatePaths: readonly string[]
  readonly normalizedPathCollisions: readonly {
    normalizedPath: string
    physicalPaths: readonly string[]
    side: "example" | "template"
  }[]
  readonly unexpectedTemplatePaths: readonly string[]
}

async function inventoryParityTree(
  root: string,
  options: { readonly normalizeTemplateSuffix: boolean },
): Promise<readonly ParityEntry[]> {
  // Recursively derive entries from RESEARCH_PARITY_ROOTS.
  // Treat an absent configured root as an absent path, not as an I/O failure.
  // Normalize every path segment ending in `.template`, mirroring writeTemplate().
  // Include directories for collision detection, but compare bytes only for files.
}

async function compareParityTrees(
  exampleRoot: string,
  templateRoot: string,
): Promise<ParityReport> {
  // 1. Detect duplicate normalized paths before building lookup maps.
  // 2. Exclude colliding normalized paths from later set/content comparisons,
  //    so one defect is reported only as a collision.
  // 3. Compare normalized file/path sets.
  // 4. Compare corresponding file Buffers with Buffer.equals().
  // 5. Return every diagnostic list sorted.
}
```

Do not use UTF-8 string equality for the parity contract; `readFile(path)` plus `Buffer.equals()` makes the promised byte comparison literal. Do not keep a list of leaf files.

- [ ] **Step 2: Add one real-tree assertion and one diagnostic-classification fixture**

Add:

```ts
describe("research template parity with examples/research/server", () => {
  it("keeps the complete research behavior tree in byte-for-byte parity", async () => {
    expect(await compareParityTrees(exampleRoot, await resolveTemplateDir("research"))).toEqual({
      contentDriftedPaths: [],
      missingTemplatePaths: [],
      normalizedPathCollisions: [],
      unexpectedTemplatePaths: [],
    })
  })

  it("classifies missing, unexpected, colliding, and drifted paths independently", async () => {
    // Example tree:
    //   AGENTS.md                    (content: same)
    //   dawn.config.ts              (content: example)
    //   src/missing.ts              (example only)
    //   src/collision.ts            (one normalized path)
    // Template tree:
    //   AGENTS.md                    (content: same)
    //   dawn.config.ts              (content: template, therefore drifted)
    //   src/unexpected.ts.template  (template only after normalization)
    //   src/collision.ts            (normalizes to src/collision.ts)
    //   src/collision.ts.template   (also normalizes to src/collision.ts)
    // Create empty test/ and workspace/ roots on both sides, plus placeholder
    // .env.example files, so no unrelated missing-root diagnostics appear.
  })
})
```

Assert the classification fixture returns:

```ts
{
  contentDriftedPaths: ["dawn.config.ts"],
  missingTemplatePaths: ["src/missing.ts"],
  normalizedPathCollisions: [
    {
      normalizedPath: "src/collision.ts",
      physicalPaths: ["src/collision.ts", "src/collision.ts.template"],
      side: "template",
    },
  ],
  unexpectedTemplatePaths: ["src/unexpected.ts"],
}
```

The temporary-tree test is load-bearing: it proves suffix normalization cannot conceal a collision and that a later refactor cannot collapse all failures into an unhelpful generic diff.

- [ ] **Step 3: Run the new real-tree guard and verify RED with the known drift**

```bash
pnpm --filter @dawn-ai/devkit exec vitest run test/templates.test.ts
```

Expected: FAIL with exactly:

```text
missingTemplatePaths: [".env.example"]
contentDriftedPaths: ["src/app/research/index.ts"]
unexpectedTemplatePaths: []
normalizedPathCollisions: []
```

- [ ] **Step 4: Restore coordinator parity from the dogfooded source**

Copy the complete contents of `examples/research/server/src/app/research/index.ts` to `packages/devkit/templates/app-research/src/app/research/index.ts`. The resulting descriptor must retain the explanatory comment and:

```ts
recursionLimit: 100,
```

Do not patch only the property; the whole file is parity-owned.

- [ ] **Step 5: Make the source environment example package-manager-neutral and mirror it**

Replace the current pnpm-specific comment in `examples/research/server/.env.example` with package-manager-neutral guidance, while retaining the empty placeholder:

```dotenv
# Required only for live/model runs. Offline tests and evals replay recorded
# fixtures and need no API key.
OPENAI_API_KEY=
```

Then copy that file byte-for-byte to `packages/devkit/templates/app-research/.env.example`.

- [ ] **Step 6: Run the parity suite and verify GREEN**

```bash
pnpm --filter @dawn-ai/devkit exec vitest run test/templates.test.ts
```

Expected: PASS, including the four-way diagnostic-classification case.

- [ ] **Step 7: Commit the parity contract and restored source parity**

```bash
git add \
  packages/devkit/test/templates.test.ts \
  packages/devkit/templates/app-research/src/app/research/index.ts \
  packages/devkit/templates/app-research/.env.example \
  examples/research/server/.env.example
git commit -m "test(devkit): enforce research template parity"
```

### Task 2: Define the generated research command and environment contract

**Files:**
- Modify: `packages/devkit/test/generated-app.test.ts`
- Modify: `packages/devkit/templates/app-research/package.json.template`
- Modify: `packages/devkit/templates/app-research/gitignore.template`
- Test: `packages/devkit/test/generated-app.test.ts`

- [ ] **Step 1: Make the materialization test assert the exact public contract**

In the existing research-template test, parse `package.json` and add an exact scripts assertion:

```ts
expect(packageJson.scripts).toEqual({
  dev: "dawn dev --port 3000",
  verify: "dawn verify",
  typegen: "dawn typegen",
  check: "dawn check",
  typecheck: "tsc --noEmit",
  test: "vitest run",
  eval: "dawn eval",
  build: "dawn build",
  start: "node --env-file-if-exists=.env .dawn/build/server.mjs",
  "test:sandbox:docker":
    "DAWN_DEMO_DOCKER_SANDBOX=1 vitest run test/sandbox-docker.test.ts",
  "memory:list": "dawn memory list",
  "memory:approve": "dawn memory approve",
})
```

Also read the generated coordinator, `.env.example`, and `.gitignore`, then assert:

```ts
expect(prompt).toContain("recursionLimit: 100")
expect(envExample).toContain("OPENAI_API_KEY=")
expect(gitignore).toContain(".env\n")
await expect(access(resolve(generatedApp.appRoot, ".env"), constants.F_OK)).rejects.toThrow()
```

The exact scripts assertion also proves there are no hidden `predev` or `prestart` hooks and that the sandbox/memory utilities did not change.

- [ ] **Step 2: Run the materialization test and verify RED on scripts and ignore policy**

```bash
pnpm --filter @dawn-ai/devkit exec vitest run test/generated-app.test.ts -t "materializes the research template"
```

Expected: FAIL because `verify`, `typegen`, and `start` are absent, `build` is still TypeScript-only, and `.env` is not yet ignored by the generated project.

- [ ] **Step 3: Replace the research template scripts with the approved command table**

Set the complete `scripts` object in `packages/devkit/templates/app-research/package.json.template` to the exact object asserted above. Preserve every dependency, dev dependency, engine, sandbox script, and memory script unchanged.

- [ ] **Step 4: Ignore local environment files while preserving the example**

Add this block to `packages/devkit/templates/app-research/gitignore.template`:

```gitignore
.env
.env.*
!.env.example
```

The example server already inherits the repository-root version of this policy; its local `.gitignore` remains parity-excluded and needs no change.

- [ ] **Step 5: Run the focused and full devkit suites**

```bash
pnpm --filter @dawn-ai/devkit exec vitest run \
  test/templates.test.ts \
  test/generated-app.test.ts
pnpm --filter @dawn-ai/devkit test
pnpm --filter @dawn-ai/devkit typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the generated lifecycle**

```bash
git add \
  packages/devkit/test/generated-app.test.ts \
  packages/devkit/templates/app-research/package.json.template \
  packages/devkit/templates/app-research/gitignore.template
git commit -m "feat(devkit): define research starter lifecycle"
```

### Task 3: Make the creator handoff research-aware and activation-first

**Files:**
- Modify: `packages/create-dawn-app/test/create-app.test.ts`
- Modify: `packages/create-dawn-app/src/index.ts`
- Test: `packages/create-dawn-app/test/create-app.test.ts`

- [ ] **Step 1: Update the packaged-default and internal scaffold expectations**

In the packaged default test:

- assert `.env.example` exists;
- read the coordinator and assert `recursionLimit: 100`;
- replace the stale build assertion with the exact research scripts object from Task 2; and
- assert the captured creator output contains the following lines in order:

```text
cd <target>
npm install
cp .env.example .env
# add OPENAI_API_KEY
npm run verify
npm run dev
```

Assert the primary output omits `npm run check`, `npm test`, and `export OPENAI_API_KEY`.

Update the internal-mode test to assert the same generated scripts and `.env.example` while retaining all file-specifier and `.npmrc` expectations.

- [ ] **Step 2: Pin the explicit-basic fallback**

Import `vi` and capture `process.stdout.write` in the existing basic-template test. Assert explicit `--template basic` output does not mention `.env.example` or `npm run verify`, because that intentionally smaller template does not ship either file/command.

Also correct the basic fallback's old claim that `check` generates types; do not expand this task into changing the basic template's scripts.

- [ ] **Step 3: Build before running the packaged creator suite, then verify RED**

```bash
pnpm build
pnpm --filter create-dawn-ai-app exec vitest run test/create-app.test.ts
```

Expected: FAIL on the old handoff output and stale creator test expectations. The registry-backed setup should otherwise install successfully.

- [ ] **Step 4: Make `printNextSteps()` template-aware**

For `options.template === "research"`, emit one contiguous primary path:

```ts
const researchSteps = [
  `  cd ${options.targetDir}`,
  "  npm install",
  "  cp .env.example .env",
  "  # add OPENAI_API_KEY",
  "  npm run verify",
  "  npm run dev       # Dawn dev server on http://127.0.0.1:3000",
]
```

Do not prompt for, read, write, or echo a real key. Keep offline `check`, `typegen`, `test`, and `eval` guidance in README sections, not between creation and the first live run.

For `basic`, retain a short compatible fallback that does not reference research-only files/scripts and labels `check` as validation-only.

- [ ] **Step 5: Run creator, typecheck, and lint checks**

```bash
pnpm --filter create-dawn-ai-app exec vitest run test/create-app.test.ts
pnpm --filter create-dawn-ai-app typecheck
pnpm --filter create-dawn-ai-app lint
```

Expected: PASS. The packaged-default stdout proves the new handoff; the basic regression proves it does not leak to the optional template.

- [ ] **Step 6: Commit the creator handoff**

```bash
git add packages/create-dawn-app/src/index.ts packages/create-dawn-app/test/create-app.test.ts
git commit -m "feat(create-dawn-app): print research activation steps"
```

### Task 4: Add explicit environment removal and bounded npm server helpers

**Files:**
- Modify: `packages/devkit/src/testing/process.ts`
- Modify: `packages/devkit/test/process-artifacts.test.ts`
- Modify: `test/harness/packaged-app.ts`
- Create: `test/harness/packaged-app.test.ts`
- Reuse: `packages/testing/src/subprocess.ts`
- Reuse: `test/runtime/support/dev-server.ts`
- Test: `packages/devkit/test/process-artifacts.test.ts`
- Test: `test/harness/packaged-app.test.ts`

- [ ] **Step 1: Pin inherited-environment deletion in the devkit process helper**

Add a test that sets a unique parent variable, spawns Node, and proves it is absent:

```ts
it("can remove selected inherited environment variables", async () => {
  process.env.DAWN_TEST_UNSET_ENV = "inherited"
  try {
    const result = await spawnProcess({
      args: ["-e", 'process.stdout.write(process.env.DAWN_TEST_UNSET_ENV ?? "missing")'],
      command: process.execPath,
      unsetEnv: ["DAWN_TEST_UNSET_ENV"],
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("missing")
  } finally {
    delete process.env.DAWN_TEST_UNSET_ENV
  }
})
```

- [ ] **Step 2: Run the devkit process test and verify RED**

```bash
pnpm --filter @dawn-ai/devkit exec vitest run test/process-artifacts.test.ts
```

Expected: FAIL to typecheck/compile because `SpawnProcessOptions` does not yet accept `unsetEnv`.

- [ ] **Step 3: Implement deletion after environment merging**

Extend `SpawnProcessOptions`:

```ts
readonly unsetEnv?: readonly string[]
```

Then build the subprocess environment in this order:

```ts
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...options.env,
}
for (const name of options.unsetEnv ?? []) delete env[name]
```

Deletion must happen after overrides. Do not represent removal as `{ OPENAI_API_KEY: undefined }`; delete the property so Node cannot stringify or inherit it.

- [ ] **Step 4: Pin `runPackagedCommand()` forwarding**

Create `test/harness/packaged-app.test.ts` with the same parent-variable pattern, calling `runPackagedCommand({ unsetEnv: [...] })`. This second test catches a future wrapper regression even if `spawnProcess()` remains correct.

- [ ] **Step 5: Forward `unsetEnv` through packaged commands**

Add `readonly unsetEnv?: readonly string[]` to `runPackagedCommand()` and pass it into `spawnProcess()`. Apply the same merge-then-delete behavior in the stdin branch so the option's semantics do not change merely because a caller supplies stdin.

- [ ] **Step 6: Add an npm-installed creator helper**

In `test/harness/packaged-app.ts`, add:

```ts
export async function installRegistryScaffolderWithNpm(options: {
  readonly tempRoot: string
  readonly transcriptPath: string
}): Promise<{ readonly installerDir: string }> {
  // Create <tempRoot>/installer/package.json.
  // Point the installer at getTestRegistryUrl().
  // Run: npm install --no-save create-dawn-ai-app@latest
  // Return the installer directory.
}
```

Use `writeRegistryNpmrc()` for the ephemeral installer. Do not reuse `installPackagedScaffolder()`: that helper intentionally installs tarballs with pnpm and cannot prove the advertised npm candidate-registry path.

- [ ] **Step 7: Add a bounded detached npm server helper**

Add `withPackagedNpmServer()` to `test/harness/packaged-app.ts`:

```ts
export async function withPackagedNpmServer<T>(
  options: {
    readonly appRoot: string
    readonly env?: Readonly<Record<string, string>>
    readonly script: "dev" | "start"
    readonly scriptArgs?: readonly string[]
    readonly transcriptPath: string
    readonly unsetEnv?: readonly string[]
  },
  action: (session: { readonly url: string }) => Promise<T>,
): Promise<T> {
  // Allocate a loopback port.
  // Spawn `npm run <script> ...scriptArgs` detached with captured stdio.
  // For dev, append `-- --port <port>` after the package script.
  // For start, inject HOST=127.0.0.1 and PORT=<port>.
  // Poll <url>/healthz with a bounded wait; do not depend on a printed URL.
  // Always terminate the detached process tree and append logs in finally.
}
```

Implementation requirements:

- use `allocatePort()` from `test/runtime/support/dev-server.ts`;
- create the child-close promise immediately after `spawn()`;
- require `child.pid` before proceeding;
- use `detached: true` so npm and its Dawn child share a terminable process group;
- use `terminateSubprocess()` from `packages/testing/src/subprocess.ts` for bounded TERM/KILL and port observation;
- bound readiness to 60 seconds and shutdown to the existing termination phases;
- append command, stdout, stderr, and exit state to the command transcript in `finally`; and
- never log the environment object.

The built entry prints no readiness URL, so health polling on the known allocated port is required for both scripts.

- [ ] **Step 8: Run helper tests and static checks**

```bash
pnpm --filter @dawn-ai/devkit exec vitest run test/process-artifacts.test.ts
pnpm exec vitest --run --config test/generated/vitest.config.ts test/harness/packaged-app.test.ts
pnpm --filter @dawn-ai/devkit typecheck
```

Expected: PASS. The framework command also proves the helper test is included by the generated-app lane's Vitest config.

- [ ] **Step 9: Commit the reusable harness boundary**

```bash
git add \
  packages/devkit/src/testing/process.ts \
  packages/devkit/test/process-artifacts.test.ts \
  test/harness/packaged-app.ts \
  test/harness/packaged-app.test.ts
git commit -m "test(harness): support isolated npm processes"
```

### Task 5: Prove the default candidate scaffold and complete npm lifecycle

**Files:**
- Create: `test/generated/run-generated-research-activation.test.ts`
- Reuse: `test/harness/packaged-app.ts`
- Reuse: `test/harness/local-registry.ts`
- Reuse: `test/harness/scaffold-packaging.ts`
- Test: `test/generated/run-generated-research-activation.test.ts`

- [ ] **Step 1: Create one tracked, reusable activation scenario**

Add one Vitest case with a 600-second test timeout. Use `createTrackedTempDir()` and `createArtifactRoot()` to create:

```text
<tempRoot>/
  app/
  installer/
  artifacts/testing/generated-research-activation/research/
    transcripts/commands.log
    transcripts/ag-ui.json
```

Use one `afterEach` cleanup list. Wrap the whole scenario in `try/catch/finally`:

- on failure, call `markTrackedTempDirForPreserve()` and rethrow with the app root and both transcript paths;
- on success, allow the tracked cleanup to delete everything; and
- always stop aimock and any active child server.

- [ ] **Step 2: Start one aimock instance and prepare the test-only environment content**

Start aimock before lifecycle commands and keep it alive for the whole scenario. Prepare this exact content, but do not create the target app directory or write `.env` before the creator runs:

```dotenv
OPENAI_BASE_URL=<aimock.baseUrl>
OPENAI_API_KEY=test-not-used
```

`aimock.baseUrl` already includes `/v1`; do not append another suffix. Never place the placeholder key on a command line or in the transcript.

- [ ] **Step 3: Assert Node 24 and npm 11 before scaffolding**

Record `npm --version` with `runPackagedCommand()`, then assert:

```ts
expect(Number(process.versions.node.split(".")[0])).toBe(24)
expect(Number(npmVersion.stdout.trim().split(".")[0])).toBe(11)
```

This is a contract assertion, not merely a log line; a future CI image change must fail visibly.

- [ ] **Step 4: Install and invoke the creator entirely through npm**

Use `installRegistryScaffolderWithNpm()`, then run:

```text
npm exec -- create-dawn-ai-app <appRoot>
```

Do not pass `--template research`. Assert:

- `src/app/research/index.ts` exists;
- `src/app/(public)/hello/[tenant]/index.ts` does not exist;
- creator stdout says `(research template)`; and
- the recorded creator command contains no `--template` token.

After creation, point the generated app at the local registry with `writeRegistryNpmrc()`, then write the prepared content to `<appRoot>/.env`. This preserves the creator's empty-target precondition while ensuring every lifecycle/runtime command sees the deterministic environment.

- [ ] **Step 5: Run the generated npm scripts in the approved order**

Run each command separately through `runPackagedCommand()` so every cwd, exit code, stdout, and stderr is recorded:

```text
npm install
npm run typegen
npm run check
npm run typecheck
npm test
npm run eval
npm run verify
npm run build
```

For `verify`, pass:

```ts
unsetEnv: ["OPENAI_BASE_URL", "OPENAI_API_KEY"]
```

This forces `dawn verify` to find the placeholder key in the generated `.env`. Assert verify stdout does not contain `Missing environment variables`.

- [ ] **Step 6: Assert lifecycle artifacts and command semantics**

After the commands complete, assert:

- `.dawn/dawn.generated.d.ts` exists after `typegen`;
- `check` succeeds without being treated as type generation;
- `.dawn/build/server.mjs` exists after `build`;
- the parsed generated `package.json` has the exact Task 2 scripts; and
- the coordinator contains `recursionLimit: 100`.

- [ ] **Step 7: Build and run the focused scenario**

```bash
pnpm build
pnpm exec vitest --run --config test/generated/vitest.config.ts \
  test/generated/run-generated-research-activation.test.ts
```

Expected: PASS through the npm lifecycle. No Dawn dev or built server is started yet in this task.

- [ ] **Step 8: Commit the candidate-registry npm lifecycle**

```bash
git add test/generated/run-generated-research-activation.test.ts
git commit -m "test(harness): verify default research npm lifecycle"
```

### Task 6: Drive a complete safe research journey through generated AG-UI

**Files:**
- Modify: `test/generated/run-generated-research-activation.test.ts`
- Test: `test/generated/run-generated-research-activation.test.ts`
- Reference: `packages/cli/test/agui-endpoint.test.ts`
- Reference: `packages/ag-ui/test/outbound.test.ts`

- [ ] **Step 1: Add deterministic root and subagent fixture sequences**

Define stable prompts:

```ts
const SAFE_PROMPT = "What are common agent architectures? Write a short cited report."
const SUBQUESTION = "Identify common agent architectures and cite the corpus."
```

Use `script()` to build two independently matched conversations. The root sequence must call, in order:

```text
recall({ query: "agent architectures report preferences" })
writeTodos({ todos })
task({ subagent: "researcher", input: SUBQUESTION })
searchCorpus({ query: "agent architectures" })
readDoc({ path: "corpus/agent-architectures.md" })
writeFile({ path: "reports/agent-architectures.md", content: report })
final reply containing [corpus/agent-architectures.md]
```

The child conversation, keyed by the exact `SUBQUESTION`, must call `searchCorpus`, call `readDoc`, and return a cited specialist answer.

Use these exact deterministic values in the two abbreviated fields above:

```ts
const todos = [
  { content: "Restate the question and list the sub-questions to research", status: "completed" },
  { content: "Search the corpus for each sub-question", status: "in_progress" },
  { content: "Read the most relevant documents in full", status: "pending" },
  { content: "Synthesize a cited report and write it to the workspace", status: "pending" },
]

const report = `# Common agent architectures

- ReAct interleaves reasoning with tool use.
- Plan-and-execute separates planning from execution.

[corpus/agent-architectures.md]
`
```

The direct coordinator search/read calls are intentional. Child tool activity currently arrives as subagent capability chunks that AG-UI v1 ignores; direct calls make the public corpus tools observable while `task` still proves real delegation.

- [ ] **Step 2: Add a bounded AG-UI request and SSE decoder**

Implement a local `postAgui()` helper using:

```ts
const routeKey = encodeURIComponent("/research#agent")
const response = await fetch(new URL(`/agui/${routeKey}`, baseUrl), {
  method: "POST",
  headers: {
    accept: "text/event-stream",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    threadId,
    runId,
    messages,
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
    ...resumeFields,
  }),
  signal: AbortSignal.timeout(60_000),
})
```

Parse blank-line-delimited frames and only JSON-decode lines beginning with `data: `. Bound both the fetch and body consumption; do not add sleeps or unbounded polling.

- [ ] **Step 3: Add semantic tool-correlation assertions**

Build a helper that maps `TOOL_CALL_START.toolCallName` by `toolCallId` and proves each expected call has, in order, matching:

```text
TOOL_CALL_START
TOOL_CALL_ARGS
TOOL_CALL_END
TOOL_CALL_RESULT
```

Do not assert arbitrary IDs. Assert the root start-name order exactly:

```ts
["recall", "writeTodos", "task", "searchCorpus", "readDoc", "writeFile"]
```

Concatenate every `TOOL_CALL_ARGS.delta` for a call before JSON parsing; do not assume arguments fit in one frame. Parse the reconstructed `task` args and assert `subagent === "researcher"`. Reconstruct assistant text the same way from ordered `TEXT_MESSAGE_CONTENT.delta` frames.

- [ ] **Step 4: Record sanitized AG-UI exchanges**

Before each request, append the request body; afterward append response status, raw SSE, and decoded events to `transcripts/ag-ui.json`. Use a first-seen mapping for thread, run, message, tool-call, and interrupt IDs so diagnostics preserve correlation while replacing arbitrary values. Replace temporary roots and server/aimock URLs with stable markers. Do not record an environment object or credential.

- [ ] **Step 5: Start generated dev through its npm script and run the safe journey**

Add the fixtures to the existing aimock instance, then use `withPackagedNpmServer()` with:

```ts
{
  script: "dev",
  env: {
    OPENAI_BASE_URL: aimock.baseUrl,
    OPENAI_API_KEY: "test-not-used",
  },
}
```

Drive the safe prompt on an explicit fresh thread. Passing the deterministic provider values directly prevents a real inherited credential or base URL from winning during dev; the built server will test `.env` separately.

- [ ] **Step 6: Assert the stable activation outcome**

Assert:

- the first event is `RUN_STARTED`;
- there is exactly one terminal `RUN_FINISHED`;
- its outcome is `{ type: "success" }`;
- every expected root tool call is fully correlated;
- the final streamed content includes a corpus citation;
- `workspace/reports/agent-architectures.md` exists; and
- the report contains `[corpus/agent-architectures.md]`.

Do not freeze complete prose, generated IDs, activity events, or final state snapshots.

- [ ] **Step 7: Run the focused scenario**

```bash
pnpm build
pnpm exec vitest --run --config test/generated/vitest.config.ts \
  test/generated/run-generated-research-activation.test.ts
```

Expected: PASS with one scaffold/install and one dev session. Inspect the command and AG-UI transcripts if the semantic order fails.

- [ ] **Step 8: Commit the safe activation journey**

```bash
git add test/generated/run-generated-research-activation.test.ts
git commit -m "test(harness): verify research AG-UI activation"
```

### Task 7: Prove permission resume and built-artifact `.env` loading

**Files:**
- Modify: `test/generated/run-generated-research-activation.test.ts`
- Test: `test/generated/run-generated-research-activation.test.ts`
- Reference: `examples/research/server/test/research.test.ts`
- Reference: `packages/cli/test/agui-endpoint.test.ts`

- [ ] **Step 1: Add gated and built-server fixtures**

Use:

```ts
const GATED_PROMPT =
  "The corpus has nothing on quantum computing — run the external fetch script for it with runBash."
const FETCH_COMMAND = "node scripts/fetch-source.mjs quantum computing"
const BUILT_PROMPT = "Built artifact environment smoke."
```

The gated fixture calls `runBash({ command: FETCH_COMMAND })`, then replies only after resume. The built fixture replies `built-env-smoke-ok` without a tool call.

- [ ] **Step 2: Exercise the interrupt in the existing dev session**

After the safe journey, send `GATED_PROMPT` on a fresh explicit thread. Snapshot aimock's request-journal length before the call.

Assert the first request:

- emits exactly one `RUN_FINISHED` with `outcome.type === "interrupt"`;
- exposes exactly one interrupt;
- has `interrupt.id === interrupt.metadata.interruptId`;
- has `reason === "command"`;
- preserves `type: "permission-request"`, `kind: "command"`, and `detail.command === FETCH_COMMAND`;
- emits `runBash` start/args/end but no tool result;
- emits no `writeFile` or assistant text after the gate; and
- grows the aimock journal by exactly one model request.

- [ ] **Step 3: Resume the same thread with the standard top-level payload**

Send a new run with `messages: []` and:

```ts
resume: [
  {
    interruptId: interrupt.id,
    status: "resolved",
    payload: "once",
  },
]
```

Assert the thread id is unchanged, the run id is new, the terminal outcome is success, and a `TOOL_CALL_RESULT` for the gated call contains the deterministic fetch-script stub. Assert the final reply appears only after resolution.

- [ ] **Step 4: Stop dev before starting the built artifact**

Let `withPackagedNpmServer()` finish and verify its bounded cleanup before continuing. At no point may dev and built Dawn servers overlap.

- [ ] **Step 5: Start `npm start` with provider variables removed**

Start the already-built app with:

```ts
{
  script: "start",
  env: { HOST: "127.0.0.1" },
  unsetEnv: ["OPENAI_BASE_URL", "OPENAI_API_KEY"],
}
```

The helper supplies the allocated `PORT`. Because the start script is `node --env-file-if-exists=.env .dawn/build/server.mjs`, the generated `.env` is now the only provider source.

- [ ] **Step 6: Prove health and one model-backed built roundtrip**

Assert `/healthz` returns `{ status: "ready" }`, then send `BUILT_PROMPT` on a fresh thread. Assert:

- streamed text contains `built-env-smoke-ok`;
- terminal outcome is success; and
- aimock's journal grows by exactly one request.

Health alone is insufficient. The journal delta plus successful AG-UI reply proves the built entry loaded `.env` and reached the deterministic provider boundary.

- [ ] **Step 7: Run the focused and complete framework lanes**

```bash
pnpm build
pnpm exec vitest --run --config test/generated/vitest.config.ts \
  test/generated/run-generated-research-activation.test.ts
pnpm verify:harness:framework
```

Expected: PASS. On failure, the thrown message names the preserved app and both transcripts. Confirm no real provider request occurred.

- [ ] **Step 8: Commit the permission and artifact-start proofs**

```bash
git add test/generated/run-generated-research-activation.test.ts
git commit -m "test(harness): verify research resume and artifact start"
```

### Task 8: Reconcile starter documentation and add the release changeset

**Files:**
- Modify: `packages/devkit/templates/app-research/README.md`
- Modify: `packages/create-dawn-app/README.md`
- Modify: `packages/cli/README.md`
- Modify: `apps/web/content/docs/getting-started.mdx`
- Modify: `apps/web/content/docs/recipes/add-a-tool.mdx`
- Modify: `examples/research/README.md`
- Modify: `examples/research/server/README.md`
- Modify: `examples/research/web/README.md`
- Create: `.changeset/steady-research-starter.md`
- Verify, do not rewrite edge content: `apps/web/content/docs/cli.mdx`

- [ ] **Step 1: Rewrite the generated README around three honest paths**

In `packages/devkit/templates/app-research/README.md`, clearly separate:

1. **Live activation:** `npm install`, copy `.env.example`, add a real `OPENAI_API_KEY`, `npm run verify`, `npm run dev` on port 3000, then the AG-UI request.
2. **Offline confidence:** `npm run typegen`, `npm run check`, `npm test`, and `npm run eval`, explicitly described as deterministic fixtures rather than a keyless product demo.
3. **Artifact start:** `npm run build` followed by `npm start`, explicitly naming `.dawn/build/server.mjs` and the required ordering.

Correct every statement that says `check` writes or types files. Describe the current web recipe honestly: streaming chat, generic tool cards, permission handling, suggestions, and memory review; do not promise live planning or subagent activity panels.

- [ ] **Step 2: Align the creator package README**

Update `packages/create-dawn-app/README.md` to:

- lead with the npm path;
- require Node 24 and npm 11;
- show shared tools under `src/tools/`, not `src/app/research/tools/`;
- list the new generated `verify`, `typegen`, `build`, and `start` scripts;
- distinguish `check` validation from `typegen` writes; and
- use the same real-key, offline, and build/start distinctions as the generated README.

- [ ] **Step 3: Correct the CLI package README without touching runtime behavior**

Update `packages/cli/README.md` to:

- require Node 24;
- describe `dawn check` as validation-only;
- describe `dawn typegen` as the writer;
- separate the usage comments for those two commands; and
- describe `dawn build` as producing configured deployment artifacts rather than LangSmith-only output.

Do not alter the newly landed edge-manifest/toolOutput detail in `apps/web/content/docs/cli.mdx`; it is already accurate and unrelated.

- [ ] **Step 4: Repair Getting Started as the canonical scaffold walkthrough**

In `apps/web/content/docs/getting-started.mdx`:

- use the npm 11 / Node 24 path;
- move corpus tools to `src/tools/` in the tree and prose;
- include `recursionLimit: 100` in the coordinator excerpt;
- show `.env.example` to `.env` plus a real key;
- run `npm run typegen`, `npm run check`, and `npm run verify` with accurate effects;
- use the generated `npm run dev` port 3000;
- keep offline tests/evals explicitly fixture-backed; and
- serve the emitted artifact with `npm run build` then `npm start` rather than presenting dynamic `dawn start` as the generated package-script contract.

- [ ] **Step 5: Correct the remaining direct `check` claim**

In `apps/web/content/docs/recipes/add-a-tool.mdx`, replace “Running `dawn check` also regenerates types” with guidance to use `dawn typegen` (or let `dawn dev` regenerate on reload). Preserve the route-local versus shared-tool explanation.

- [ ] **Step 6: Reconcile the research example READMEs**

Update:

- `examples/research/README.md`: the web client exists now and is live-key-only; remove the promised no-key future mode.
- `examples/research/server/README.md`: remove the obsolete “Slice 1 / UI later” text, correct `check` semantics, and point to the current live web client.
- `examples/research/web/README.md`: use the actual server port `3002` and web port `3010`, retain the explicit statement that no aimock/demo mode is presented to users, and keep the key on the server.

- [ ] **Step 7: Add the required patch changeset**

Create `.changeset/steady-research-starter.md`:

```md
---
"@dawn-ai/devkit": patch
"create-dawn-ai-app": patch
---

Keep the default research scaffold aligned with the dogfooded example, add a coherent npm lifecycle and environment handoff, and verify packaged AG-UI activation through the built artifact.
```

Use `patch`; Dawn's fixed 0.x group will carry the release together.

- [ ] **Step 8: Run semantic drift searches before the documentation checker**

```bash
rg -n \
  'Node.js 22\.12|server on :3001|no-API-key demo mode|no-key demo mode|UI with a no|check.*generate|check.*regenerate|dawn check.*types them|src/app/research/tools' \
  packages/devkit/templates/app-research/README.md \
  packages/create-dawn-app/README.md \
  packages/cli/README.md \
  apps/web/content/docs/getting-started.mdx \
  apps/web/content/docs/recipes/add-a-tool.mdx \
  examples/research
```

Expected: no stale contract match. Review any legitimate match manually rather than weakening the search.

- [ ] **Step 9: Build and run documentation/release checks**

```bash
pnpm build
node scripts/check-docs.mjs
BASE_REF=origin/main node scripts/check-changesets.mjs
```

Expected: PASS. The build first prevents false failures from missing bundled CLI documentation artifacts.

- [ ] **Step 10: Commit docs and release metadata**

```bash
git add \
  packages/devkit/templates/app-research/README.md \
  packages/create-dawn-app/README.md \
  packages/cli/README.md \
  apps/web/content/docs/getting-started.mdx \
  apps/web/content/docs/recipes/add-a-tool.mdx \
  examples/research/README.md \
  examples/research/server/README.md \
  examples/research/web/README.md \
  .changeset/steady-research-starter.md
git commit -m "docs: align research starter activation"
```

### Task 9: Run release-proportional verification and review the complete change

**Files:**
- Verify: all files changed by Tasks 1–8
- Review: `docs/superpowers/specs/2026-08-09-research-starter-integrity-design.md`

- [ ] **Step 1: Run the fast focused regression set**

```bash
pnpm --filter @dawn-ai/devkit exec vitest run \
  test/templates.test.ts \
  test/generated-app.test.ts \
  test/process-artifacts.test.ts
pnpm --filter create-dawn-ai-app exec vitest run test/create-app.test.ts
pnpm exec vitest --run --config test/generated/vitest.config.ts \
  test/harness/packaged-app.test.ts \
  test/generated/run-generated-research-activation.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package static checks**

```bash
pnpm --filter @dawn-ai/devkit --filter create-dawn-ai-app typecheck
pnpm --filter @dawn-ai/devkit --filter create-dawn-ai-app lint
```

Expected: PASS.

- [ ] **Step 3: Run the complete framework harness explicitly**

```bash
pnpm verify:harness:framework
```

Expected: PASS, including npm 11/default-template/lifecycle/safe-run/resume/artifact-start coverage from one prepared app.

- [ ] **Step 4: Run the repository Definition of Done**

```bash
pnpm ci:validate
```

Expected: PASS through lint, build-cache validation, build, typecheck, tests, release-script tests, documentation checks, pack checks, TypeScript tooling pack verification, and every standard harness lane.

- [ ] **Step 5: Inspect the final diff and changeset coverage**

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short --branch
BASE_REF=origin/main node scripts/check-changesets.mjs
```

Expected: no whitespace errors, only approved-scope files, a clean worktree, and a passing changeset check.

- [ ] **Step 6: Request an independent code review against the approved spec**

Use `superpowers:requesting-code-review`. Give the reviewer the spec path, this plan path, the complete `origin/main...HEAD` diff, and fresh verification output. Require explicit checks for:

- parity failure modes and byte comparison;
- no hidden keyless product path;
- npm 11/default-template proof;
- no inherited-provider false positives;
- AG-UI tool/result and interrupt correlation;
- bounded process cleanup and preserved diagnostics;
- honest docs and port/path/command agreement; and
- no web UI, activity mapping, provider selection, memory, edge, or deployment scope creep.

- [ ] **Step 7: Resolve review findings and rerun affected verification**

Apply only evidence-backed fixes. Re-run the smallest affected focused command after each fix, then rerun `pnpm ci:validate` once after the review is clean.

- [ ] **Step 8: Hand off the completed branch**

Use `superpowers:finishing-a-development-branch` to present merge/PR/cleanup choices. Do not publish, push, or open a PR unless the user selects that action.
