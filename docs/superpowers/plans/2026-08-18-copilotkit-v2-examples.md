# CopilotKit V2 Examples Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Dawn's chat and research examples to selected stable CopilotKit `1.68.3`, use the supported V2 frontend and runtime APIs end to end, and prove the multi-route Dawn/AG-UI boundary without adding dependency overrides.

**Architecture:** Keep each browser connected to a same-origin CopilotKit runtime, and keep each runtime's `HttpAgent` connected to the existing encoded Dawn `/agui/{routeId}` endpoint. Replace the legacy single-route Next.js adapter with `createCopilotRuntimeHandler` from `@copilotkit/runtime/v2`, mount it under a required catch-all route, and set the real React providers to multi-route mode. Verify direct dependency ownership with a lean lockfile receipt, the server boundary with a model-free loopback AG-UI stream, and the actual pages with Playwright request observation.

**Tech Stack:** TypeScript 7, Next.js 16 App Router, React 19, CopilotKit `1.68.3`, AG-UI `0.0.57`, Vitest 4, Playwright `1.62.1`, pnpm 10.

---

## Scope and file map

This is one coherent prerequisite to the broader dependency-security plan. It
does not implement the final audit exceptions or alter Dawn's required Vercel
CLI dependency and native-deployment CI lane.

**Create:**

- `test/security-dependencies/copilotkit-v2-runtime.test.ts` — model-free V2
  handler and exact Dawn `HttpAgent` target integration test.
- `examples/chat/web/e2e/copilotkit-v2.spec.ts` — observes the actual chat page's
  runtime discovery transport.
- `examples/chat/web/playwright.config.ts` — owns the chat example browser server.
- `examples/research/web/e2e/copilotkit-v2.spec.ts` — observes the actual research
  page's runtime discovery transport.
- `examples/research/web/playwright.config.ts` — owns the research browser server.
- `examples/chat/web/app/api/copilotkit/[...path]/route.ts` — V2 multi-route Fetch
  handler for `/chat#agent`.
- `examples/research/web/app/api/copilotkit/[...path]/route.ts` — V2 multi-route
  Fetch handler for `/research#agent`.

**Modify:**

- `examples/chat/web/package.json` — CopilotKit `^1.68.3`, exact Playwright test
  dependency, and `test:e2e` script; retain `@ag-ui/client` `0.0.57`.
- `examples/research/web/package.json` — same dependency/script changes.
- `packages/ag-ui/package.json` — align the development owner to
  `@copilotkit/react-core@^1.68.3` while preserving the optional peer
  `>=1.66.0`.
- `examples/chat/web/app/page.tsx` — explicit multi-route provider setting and
  current-version comments.
- `examples/research/web/app/page.tsx` — same provider migration and route comment.
- `examples/chat/web/next.config.mjs` and
  `examples/research/web/next.config.mjs` — disable Next 16.3's generated agent
  rules during real-page browser verification.
- `package.json` — remove the obsolete `uuid@<11.1.1` override and reject the
  in-flight plan's proposed `@hono/node-server@<2.0.10` override; preserve all
  unrelated in-flight edits when the security WIP is restored.
- `pnpm-lock.yaml` — regenerate from the final manifests; never resolve a conflict
  by taking one complete side.
- `test/security-dependencies/dependency-resolution.test.ts` — replace exact
  snapshot/export-map archaeology with direct-owner, patched-floor, and allowed
  AG-UI edge assertions.
- `test/security-dependencies/vitest.config.ts` — disable CopilotKit telemetry in
  the isolated test process.
- `.github/workflows/ci.yml` — add a bounded browser job for the two example pages.
- `scripts/release/test/fixtures/workflow-entrypoints.json` and
  `scripts/release/test/fixtures/workflow-safe-executables.json` — register the
  additive browser job in the fail-closed workflow audit.
- `examples/chat/README.md`, `examples/chat/web/README.md`,
  `examples/research/web/README.md`, and
  `apps/web/content/docs/recipes/research-web-ui.mdx` — document the V2 route and
  multi-route transport.
- Superseded after the Workbench rebase:
  `examples/research/web/app/api/memory/[...path]/route.ts` was intentionally
  removed upstream as an unused, unallowlisted proxy. Do not restore it; the
  Workbench instead uses the bounded allowlist in
  `examples/research/web/app/api/dawn/[...path]/route.ts`.
- `docs/superpowers/plans/2026-08-10-security-dependency-remediation-pr1.md` —
  make this migration the first prerequisite and update CopilotKit/version/route
  assumptions now; Task 6 reconciles the restored in-flight evidence around
  those reviewed decisions.
- `docs/superpowers/specs/2026-08-18-copilotkit-v2-examples-design.md` and this
  implementation plan — record the selected release and actual implementation
  scope.

**Delete:**

- `examples/chat/web/app/api/copilotkit/route.ts`
- `examples/research/web/app/api/copilotkit/route.ts`
- `test/security-dependencies/hono-node-server.test.ts` — the new Dawn-boundary
  integration plus lock floors replaces this large upstream-internal test.

## Execution rules

- Run every command from
  `/Users/blove/repos/dawn/.worktrees/security-dependency-remediation`.
- Activate `/Users/blove/.nvm/versions/node/v24.19.0/bin` in every local
  execution shell; all commands below assume Node `24.19.0` and pnpm `10.33.0`.
- Use `@superpowers:test-driven-development` for Tasks 1–3 and
  `@superpowers:verification-before-completion` for Task 5.
- Build before executing anything that imports workspace `dist/` output.
- Do not stage or commit the pre-existing dirty security-remediation files while
  implementing the prerequisite. Task 0 temporarily preserves them by immutable
  stash OID; Task 6 restores them.
- Do not add a CopilotKit, Hono, node-server, provider-utils, or AG-UI override.
- Do not upgrade direct `@ag-ui/client` to `0.0.58`; CopilotKit `1.68.3` expects
  the type-facing `0.0.57` generation.
- Preserve `packages/ag-ui`'s optional `@copilotkit/react-core` peer range
  `>=1.66.0`; only its development owner moves to `^1.68.3`.
- Keep publication workflows disabled throughout.

### Task 0: Preserve the in-flight security WIP

**Files:**

- No repository file changes.
- Preserve all tracked and untracked paths currently shown by `git status`.

- [x] **Step 1: Record the current branch, head, status, and existing recovery stashes**

Run:

```bash
git branch --show-current
git rev-parse HEAD
node --version
pnpm --version
git status --short
git stash list --format='%H %gd %s'
```

Expected: branch `blove/security-dependency-remediation`; the design and this
plan are committed; Node reports `v24.19.0`; pnpm reports `10.33.0`; and the
known Task 3/security files remain dirty. Identify and record the three existing
security recovery OIDs named
`pr1-task3-before-main-00919546`, `pr1-task3-before-main-e95f4d61`, and
`pr1-task3-before-main-8398c908`. Do not modify those or any other existing
stash.

- [x] **Step 2: Stash the current dirty state, including untracked files**

Run:

```bash
git stash push -u -m "security-wip-before-copilotkit-v2-prerequisite"
git rev-parse stash@{0}
```

Expected: one new OID. Copy the exact OID into the execution notes and refer to
it by OID, never by a moving `stash@{n}` index.

- [x] **Step 3: Verify the worktree is clean and the new stash contains every prior dirty path**

Run:

```bash
git status --short
git stash show --stat --include-untracked <NEW_STASH_OID>
```

Expected: clean worktree; the stash lists the tracked and untracked security WIP.
If either check fails, stop before editing.

- [x] **Step 4: Rebase the committed branch onto an immutable current main**

Refresh the remote-tracking ref, record its exact commit, and rebase only after
the WIP is safely stashed:

```bash
git fetch origin main
git rev-parse origin/main
git merge-base HEAD origin/main
git rebase <RECORDED_ORIGIN_MAIN_OID>
git status --short
```

Expected: the rebase succeeds and the worktree remains clean. Record the
immutable upstream OID in the execution notes. If an upstream change overlaps a
planned manifest or workflow path, preserve the upstream behavior and replay
this plan's intent; regenerate `pnpm-lock.yaml` from the reconciled manifests
rather than selecting either lockfile side wholesale. Do not apply the WIP
stash yet.

### Task 1: Upgrade the direct owners and replace the brittle graph receipt

**Files:**

- Modify: `examples/chat/web/package.json`
- Modify: `examples/research/web/package.json`
- Modify: `packages/ag-ui/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `test/security-dependencies/dependency-resolution.test.ts`
- Delete: `test/security-dependencies/hono-node-server.test.ts`

- [x] **Step 1: Replace the exact lock snapshot test with desired public graph invariants**

Keep the strict JSON/YAML parsing helpers, but remove:

- the exact ten-entry override map;
- the exact complete package/snapshot sets;
- export-map condition inspection;
- exact total reverse-edge assertions for unrelated packages; and
- the forced `@hono/node-server@2.1.0` identity.

The focused assertions should have this shape:

```ts
const exampleImporters = ["examples/chat/web", "examples/research/web"] as const

it("binds both private examples to stable CopilotKit V2 owners", () => {
  const workspace = readWorkspace()
  for (const importer of exampleImporters) {
    expect(importerDependency(workspace, importer, "dependencies", "@copilotkit/react-core")).toMatchObject({
      specifier: "^1.68.3",
    })
    expect(importerDependency(workspace, importer, "dependencies", "@copilotkit/runtime")).toMatchObject({
      specifier: "^1.68.3",
    })
    expect(importerDependency(workspace, importer, "dependencies", "@ag-ui/client")).toEqual({
      specifier: "0.0.57",
      version: "0.0.57",
    })
  }
  expect(packageVersions(workspace, "@copilotkit/react-core")).toEqual(["1.68.3"])
  expect(packageVersions(workspace, "@copilotkit/runtime")).toEqual(["1.68.3"])
})

it("keeps Dawn's HttpAgent type edge on AG-UI 0.0.57", () => {
  const workspace = readWorkspace()
  expect(packageVersions(workspace, "@ag-ui/client")).not.toContain("0.0.58")
  for (const importer of exampleImporters) {
    expect(importerDependency(workspace, importer, "dependencies", "@ag-ui/client").version).toBe("0.0.57")
  }
  const legacyParents = reverseParents(workspace, "@ag-ui/client", "0.0.54")
  expect(
    !packageVersions(workspace, "@ag-ui/client").includes("0.0.54") ||
      (legacyParents.length > 0 &&
        legacyParents.every((parent) =>
          /^@ag-ui\/mcp-middleware@0\.0\.1/.test(parent),
        )),
  ).toBe(true)
})

it("uses compatible patched Hono-family and UUID releases", () => {
  const workspace = readWorkspace()
  expectVersionsAtPatchedFloor(workspace, "hono", { 4: "4.12.34" })
  expectVersionsAtPatchedFloor(workspace, "@hono/node-server", {
    1: "1.19.15",
    2: "2.0.10",
  })
  expect(
    packageVersions(workspace, "uuid").filter(
      (version) => compareVersions(version, "11.1.1") < 0,
    ),
  ).toEqual([])
  expect(
    Object.keys(workspace.manifestOverrides).filter((selector) =>
      /(^|>)(?:@copilotkit\/|@ag-ui\/|@ai-sdk\/provider-utils(?:@|$)|@hono\/node-server(?:@|$)|hono(?:@|$)|uuid(?:@|$))/.test(
        selector,
      ),
    ),
  ).toEqual([])
})

it("confines any affected provider-utils 3.x to private CopilotKit Google Vertex", () => {
  const workspace = readWorkspace()
  const affectedVersions = packageVersions(
    workspace,
    "@ai-sdk/provider-utils",
  ).filter(
    (version) =>
      compareVersions(version, "3.0.0") >= 0 &&
      compareVersions(version, "3.0.97") <= 0,
  )
  const paths = affectedVersions.flatMap((version) =>
    rootImporterPathsToVersion(workspace, "@ai-sdk/provider-utils", version),
  )
  expect(
    paths.every(
      (path) =>
        exampleImporters.includes(
          path.importer as (typeof exampleImporters)[number],
        ) &&
        path.identities.some((identity) =>
          identity.startsWith("@copilotkit/runtime@1.68.3"),
        ) &&
        path.identities.some((identity) =>
          identity.startsWith("@ai-sdk/google-vertex@3."),
        ),
    ),
  ).toBe(true)
})
```

Implement `packageVersions`, `reverseParents`, `rootImporterPathsToVersion`, and
the patched-floor helper over the lockfile's `packages`, `snapshots`, and
`importers` records. Normalize peer suffixes only to extract a package
name/version; retain full keys when checking parent paths. The recursive path
helper must be cycle-safe and include intermediate Google Vertex child
providers; it must not freeze their exact versions or unrelated total global
reverse edges. Do not require an affected provider-utils identity to remain: if
upstream eventually resolves the advisory within the compatible graph, an empty
affected set is the desired result.

Also treat `packages/ag-ui` as a direct development owner: require its manifest
and lock importer to resolve `@copilotkit/react-core@^1.68.3` and direct
`@ag-ui/client@0.0.57`, while requiring its optional React Core peer to remain
`>=1.66.0`.

- [x] **Step 2: Run the focused test and verify it fails for the old owners**

Run:

```bash
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/dependency-resolution.test.ts
```

Expected: FAIL because the example specifiers/resolutions are `1.66.x`, the UUID
override still exists, and compatible Hono/node-server patches have not been
selected.

- [x] **Step 3: Raise the direct CopilotKit floors and remove the obsolete UUID override**

Apply these manifest changes:

```json
"@ag-ui/client": "0.0.57",
"@copilotkit/react-core": "^1.68.3",
"@copilotkit/runtime": "^1.68.3"
```

Remove this root override:

```json
"uuid@<11.1.1": "11.1.1"
```

Do not change `@ag-ui/client`, add replacement overrides, or touch the Vercel
CLI dependency. In `packages/ag-ui`, update only the React Core development
owner to `^1.68.3`; retain its optional peer `>=1.66.0`.

- [x] **Step 4: Regenerate the lock and explicitly refresh compatible Hono patches**

Run:

```bash
pnpm install --lockfile-only
pnpm --dir packages/cli update --lockfile-only --save=false hono @hono/node-server
pnpm install --frozen-lockfile
git diff --exit-code -- packages/cli/package.json
git diff --name-only -- ':(glob)**/package.json'
```

Expected: all commands succeed. The example importers resolve CopilotKit
`1.68.3`; their direct `@ag-ui/client` remains `0.0.57`; compatible Hono,
node-server, and UUID patches are selected without an override; and the CLI
manifest is byte-unchanged. The explicit update is necessary because a plain
lockfile install retains the old compatible-but-vulnerable Hono/node-server
resolutions. The final manifest listing must contain only root `package.json`,
the two intentionally changed example manifests, and `packages/ag-ui/package.json`.
Inspect the lock delta:
bounded peer-snapshot churn inside the CLI/Copilot LangChain/OpenAI closure is
acceptable after focused/full verification, but no other workspace manifest,
unrelated importer, or provider-utils version change is.

- [x] **Step 5: Run the focused graph test and inspect direct ownership**

Run:

```bash
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/dependency-resolution.test.ts
pnpm --filter @dawn-example/chat-web why @copilotkit/runtime @ag-ui/client @hono/node-server uuid
pnpm --filter @dawn-example/research-web why @copilotkit/runtime @ag-ui/client @hono/node-server uuid
```

Expected: PASS; direct AG-UI is `0.0.57`; no `0.0.58`; any `0.0.54` appears only
below `@ag-ui/mcp-middleware@0.0.1`; no forced node-server major.

- [x] **Step 6: Delete the superseded upstream-internal adapter test and run the full security project**

Delete `test/security-dependencies/hono-node-server.test.ts`. Its compatible
version requirements now live in the lean lock receipt, and Task 2 immediately
replaces its Dawn route behavior with a real V2 handler/loopback test. Do not
port its exact package-export, CJS/ESM, or internal adapter assertions.

Run:

```bash
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts
```

Expected: PASS. This keeps the Task 1 commit green instead of retaining exact
`1.66.4`/`2.1.0` assertions after the graph changes.

- [x] **Step 7: Commit the direct-owner graph change**

Run:

```bash
git add package.json packages/ag-ui/package.json examples/chat/web/package.json examples/research/web/package.json pnpm-lock.yaml test/security-dependencies/dependency-resolution.test.ts test/security-dependencies/hono-node-server.test.ts
git diff --cached --check
git commit -m "chore(examples): update stable CopilotKit dependencies"
```

Expected: one commit containing only the dependency/receipt paths above.

### Task 2: Replace the legacy runtime adapters with V2 Fetch handlers

**Files:**

- Create: `test/security-dependencies/copilotkit-v2-runtime.test.ts`
- Modify: `test/security-dependencies/vitest.config.ts`
- Modify: `test/security-dependencies/dependency-resolution.test.ts`
- Create: `examples/chat/web/app/api/copilotkit/[...path]/route.ts`
- Create: `examples/research/web/app/api/copilotkit/[...path]/route.ts`
- Delete: `examples/chat/web/app/api/copilotkit/route.ts`
- Delete: `examples/research/web/app/api/copilotkit/route.ts`

- [x] **Step 1: Disable CopilotKit telemetry in the isolated Vitest project**

Add these entries to `test.env` in
`test/security-dependencies/vitest.config.ts`:

```ts
COPILOTKIT_TELEMETRY_DISABLED: "true",
DO_NOT_TRACK: "1",
```

This prevents the model-free integration test from making unrelated telemetry
requests. Update `dependency-resolution.test.ts`'s exact `testConfig.env`
assertion in the same step so it expects both new keys alongside the existing
four credential-clearing keys.

- [x] **Step 2: Write the failing V2 route and Dawn forwarding integration test**

Create a loopback `node:http` server on `127.0.0.1` that:

- records `request.url` and method;
- accepts only the expected encoded `/agui/...` path;
- reads the incoming AG-UI run body; and
- returns schema-valid SSE:

```ts
const events = [
  { type: "RUN_STARTED", threadId, runId },
  { type: "TEXT_MESSAGE_START", messageId: "assistant-1", role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-1", delta: "dawn-v2-sentinel" },
  { type: "TEXT_MESSAGE_END", messageId: "assistant-1" },
  { type: "RUN_FINISHED", threadId, runId },
]
response.writeHead(200, {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
})
response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
```

For each case below, set `DAWN_SERVER_URL` to the loopback origin before
importing the route module:

```ts
const cases = [
  {
    label: "chat",
    expectedPath: "/agui/%2Fchat%23agent",
    load: () => import("../../examples/chat/web/app/api/copilotkit/[...path]/route.ts"),
  },
  {
    label: "research",
    expectedPath: "/agui/%2Fresearch%23agent",
    load: () => import("../../examples/research/web/app/api/copilotkit/[...path]/route.ts"),
  },
] as const
```

Each case must assert:

```ts
capturedRequests.length = 0
const info = await route.GET(new Request("http://dawn.test/api/copilotkit/info"))
expect(info.status).toBe(200)
expect(await info.json()).toMatchObject({
  version: "1.68.3",
  mode: "sse",
  agents: { default: { name: "default" } },
})
expect(capturedRequests).toEqual([])

const malformed = await route.POST(
  new Request("http://dawn.test/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }),
)
expect(malformed.status).toBe(400)
expect(await malformed.json()).toMatchObject({
  error: "Invalid request body",
  details: expect.stringContaining("threadId"),
})
expect(capturedRequests).toEqual([])

const runInput = {
  threadId: `${label}-thread`,
  runId: `${label}-run`,
  state: {},
  messages: [{ id: `${label}-message`, role: "user", content: "hello" }],
  tools: [],
  context: [],
  forwardedProps: {},
}
const run = await route.POST(
  new Request("http://dawn.test/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(runInput),
  }),
)
expect(run.status).toBe(200)
expect(run.headers.get("content-type")).toContain("text/event-stream")
const reader = run.body?.getReader()
if (!reader) throw new Error("CopilotKit run response has no body")
const chunks: string[] = []
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  chunks.push(
    typeof value === "string" ? value : new TextDecoder().decode(value),
  )
}
const stream = chunks.join("")
expect(stream).toContain("dawn-v2-sentinel")
expect(stream).toContain("RUN_FINISHED")
expect(capturedRequests).toContainEqual({
  method: "POST",
  path: expectedPath,
  accept: expect.stringContaining("text/event-stream"),
  contentType: expect.stringContaining("application/json"),
  body: expect.objectContaining({
    threadId: `${label}-thread`,
    runId: `${label}-run`,
    messages: [
      expect.objectContaining({
        id: `${label}-message`,
        role: "user",
        content: "hello",
      }),
    ],
  }),
})
```

Use bounded start/close helpers and `AbortSignal.timeout(5_000)`. Restore the
prior `DAWN_SERVER_URL` value (delete the key if it was originally absent) and
close all listeners in `finally`/`afterAll`.
Read the body through its reader as shown: CopilotKit's current SSE wrapper may
enqueue string chunks, which `Response.text()` rejects under some Node/Undici
versions even though the stream itself is valid and browser-consumable. Also
assert that the loopback server received the fixture's `threadId`, `runId`, and
message so the test proves the real request body crossed the boundary. Spy on
and restore `console.error` around the intentional malformed request because
CopilotKit logs the validation error; assert only the stable error code and that
the details mention `threadId`, not the full Zod wording or minified class name.

- [x] **Step 3: Run the new test and verify it fails on the missing V2 route files**

Run:

```bash
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/copilotkit-v2-runtime.test.ts
```

Expected: FAIL because the required catch-all route modules do not exist.

- [x] **Step 4: Implement both V2 route modules**

Use this exact shape, changing only the Dawn route and default port:

```ts
import { HttpAgent } from "@ag-ui/client"
import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const dawnUrl = process.env.DAWN_SERVER_URL ?? "http://127.0.0.1:3001"
const agUiUrl = `${dawnUrl}/agui/${encodeURIComponent("/chat#agent")}`

const handler = createCopilotRuntimeHandler({
  runtime: new CopilotRuntime({
    agents: { default: new HttpAgent({ url: agUiUrl }) },
  }),
  basePath: "/api/copilotkit",
})

export const GET = handler
export const POST = handler
```

Research uses port `3002` and route `"/research#agent"`. Delete the two old
`route.ts` files; do not leave a compatibility re-export.

- [x] **Step 5: Run the runtime integration and example typechecks**

Run:

```bash
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/copilotkit-v2-runtime.test.ts test/security-dependencies/dependency-resolution.test.ts
pnpm exec tsc -p test/security-dependencies/tsconfig.json --noEmit
pnpm --filter @dawn-ai/ag-ui build
pnpm --filter @dawn-example/chat-web exec next typegen
pnpm --filter @dawn-example/research-web exec next typegen
pnpm --filter @dawn-example/chat-web typecheck
pnpm --filter @dawn-example/research-web typecheck
```

Expected: all PASS. If the run body is rejected, inspect the installed
`RunAgentInputSchema` and correct the fixture; do not weaken the route assertion
or bypass the real handler.

- [x] **Step 6: Commit the V2 server boundary**

Run:

```bash
git add test/security-dependencies/vitest.config.ts test/security-dependencies/dependency-resolution.test.ts test/security-dependencies/copilotkit-v2-runtime.test.ts examples/chat/web/app/api/copilotkit examples/research/web/app/api/copilotkit
git diff --cached --check
git commit -m "feat(examples): use CopilotKit v2 runtime handlers"
```

Expected: the two legacy files and large upstream-internal test are deleted; the
two V2 handlers and focused loopback test are committed.

### Task 3: Prove the real pages select multi-route transport

**Files:**

- Modify: `examples/chat/web/package.json`
- Modify: `examples/research/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `examples/chat/web/playwright.config.ts`
- Create: `examples/chat/web/e2e/copilotkit-v2.spec.ts`
- Create: `examples/research/web/playwright.config.ts`
- Create: `examples/research/web/e2e/copilotkit-v2.spec.ts`
- Modify: `examples/chat/web/app/page.tsx`
- Modify: `examples/research/web/app/page.tsx`
- Modify: `examples/chat/web/next.config.mjs`
- Modify: `examples/research/web/next.config.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/release/test/fixtures/workflow-entrypoints.json`
- Modify: `scripts/release/test/fixtures/workflow-safe-executables.json`

- [x] **Step 1: Add package-owned Playwright test infrastructure**

In both package manifests add:

```json
"scripts": {
  "test:e2e": "playwright test --config playwright.config.ts"
},
"devDependencies": {
  "@playwright/test": "1.62.1"
}
```

Preserve every existing script and dependency. Regenerate/install:

```bash
pnpm install --lockfile-only
pnpm install --frozen-lockfile
```

- [x] **Step 2: Create each package's Playwright config**

Chat configuration:

```ts
import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:3000",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec next dev --hostname 127.0.0.1 -p 3000",
    url: "http://127.0.0.1:3000",
    env: {
      COPILOTKIT_TELEMETRY_DISABLED: "true",
      DO_NOT_TRACK: "1",
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
```

Research uses port `3010`. Keep artifacts under the ignored default
`test-results/`/`playwright-report/` paths. Never reuse an existing server: the
test must exercise the current worktree rather than an unrelated process already
holding the port. Keep telemetry disabled in both local Next processes so the
transport test has no unrelated network dependency.

Set top-level `agentRules: false` in both existing `next.config.mjs` files while
preserving `experimental.useTypeScriptCli`. Next 16.3 otherwise writes generated
contributor-rule files when the Playwright-owned `next dev` processes start,
leaving CI/local verification with unrelated artifacts.

- [x] **Step 3: Write the failing request-observation specs against the actual pages**

Each test observes only same-origin CopilotKit runtime traffic:

```ts
import { expect, test } from "@playwright/test"

const appOrigin = "http://127.0.0.1:3000"

test("uses CopilotKit V2 multi-route discovery", async ({ page }) => {
  const runtimeRequests: Array<{ method: string; pathname: string }> = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.origin === appOrigin && url.pathname.startsWith("/api/copilotkit")) {
      runtimeRequests.push({ method: request.method(), pathname: url.pathname })
    }
  })

  await page.route("**/api/dawn/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ candidates: [] }),
    }),
  )
  const infoResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      response.request().method() === "GET" &&
      url.origin === appOrigin &&
      url.pathname === "/api/copilotkit/info"
    )
  })
  await page.goto("/")

  expect((await infoResponse).ok()).toBe(true)
  expect(runtimeRequests[0]).toEqual({
    method: "GET",
    pathname: "/api/copilotkit/info",
  })
  expect(runtimeRequests).not.toContainEqual({
    method: "POST",
    pathname: "/api/copilotkit",
  })
})
```

The memory interception is harmless in chat and prevents the research panel
from contacting a Dawn server during this transport-only test. Research's
Playwright config changes the Next port in both `baseURL`, `webServer.url`, and
the command to `3010`.

- [x] **Step 4: Run both browser specs and verify they fail in legacy mode**

Run:

```bash
pnpm --filter @dawn-ai/ag-ui build
pnpm --filter @dawn-example/chat-web exec playwright install chromium
pnpm --filter @dawn-example/chat-web test:e2e
pnpm --filter @dawn-example/research-web test:e2e
```

Expected: both tests observe `POST /api/copilotkit` or time out waiting for
`GET /api/copilotkit/info`, because the real providers still default to the
legacy single-endpoint transport.

- [x] **Step 5: Switch both real providers to multi-route mode**

Add the explicit property in both `page.tsx` files:

```tsx
<CopilotKit
  runtimeUrl="/api/copilotkit"
  useSingleEndpoint={false}
  defaultThrottleMs={100}
  // retain the research-only renderer prop
>
```

Update nearby comments to reference installed `1.68.3` types and the new
`api/copilotkit/[...path]/route.ts` path. Do not change hooks, renderers, or
agent IDs.

- [x] **Step 6: Re-run browser, component, typecheck, and build verification**

Run:

```bash
pnpm --filter @dawn-example/chat-web test:e2e
pnpm --filter @dawn-example/research-web test:e2e
pnpm --filter @dawn-example/research-web test
pnpm --filter @dawn-example/chat-web typecheck
pnpm --filter @dawn-example/research-web typecheck
pnpm --filter @dawn-example/chat-web build
pnpm --filter @dawn-example/research-web build
```

Expected: all PASS; browser tests observe `GET /api/copilotkit/info` and no base
POST envelope.

- [x] **Step 7: Add a dedicated CI browser job**

Add a `copilotkit-examples-e2e` job to `.github/workflows/ci.yml` using the same
pinned checkout, pnpm setup, Node 24.17.0 setup, and frozen install steps as the
existing browser jobs. Its execution steps are:

```yaml
      - name: Install Chromium
        run: pnpm --filter @dawn-example/chat-web exec playwright install --with-deps chromium

      - name: Build example workspace dependencies
        run: pnpm --filter @dawn-ai/ag-ui build

      - name: Verify chat CopilotKit transport
        run: pnpm --filter @dawn-example/chat-web test:e2e

      - name: Verify research CopilotKit transport
        run: pnpm --filter @dawn-example/research-web test:e2e
```

Set `runs-on: ubuntu-latest` and `timeout-minutes: 20`. Do not give the job
secrets or write permissions. The tests use only local Next servers and `/info`.
This job is additive: preserve the existing Vercel native-deployment lane and
its CLI coverage unchanged.

The release controller parses every workflow entrypoint and executable. After
adding the job, regenerate its exact descriptors in
`scripts/release/test/fixtures/workflow-entrypoints.json` and
`scripts/release/test/fixtures/workflow-safe-executables.json`, classify only
the new local browser commands as safe, and run:

```bash
node --test scripts/release/test/workflow-contracts.test.mjs
```

Do not change any Vercel job descriptor or executable while updating the
fixtures.

- [x] **Step 8: Commit the browser-proven frontend transport**

Run:

```bash
git add .github/workflows/ci.yml examples/chat/web/package.json examples/chat/web/playwright.config.ts examples/chat/web/e2e examples/chat/web/app/page.tsx examples/chat/web/next.config.mjs examples/research/web/package.json examples/research/web/playwright.config.ts examples/research/web/e2e examples/research/web/app/page.tsx examples/research/web/next.config.mjs pnpm-lock.yaml scripts/release/test/fixtures/workflow-entrypoints.json scripts/release/test/fixtures/workflow-safe-executables.json
git diff --cached --check
git commit -m "test(examples): verify CopilotKit v2 transport"
```

Expected: one commit containing the explicit provider setting, package-owned
browser tests, side-effect-free Next configs, CI job, corresponding lock
importer updates, and the two workflow audit fixtures.

### Task 4: Refresh current documentation and the active security plan

**Files:**

- Modify: `examples/chat/README.md`
- Modify: `examples/chat/web/README.md`
- Modify: `examples/research/web/README.md`
- Modify: `apps/web/content/docs/recipes/research-web-ui.mdx`
- Superseded after the Workbench rebase: do not restore the deleted
  `examples/research/web/app/api/memory/[...path]/route.ts` proxy.
- Modify: `examples/research/web/app/components/ToolCallCard.tsx`
- Modify: `docs/superpowers/plans/2026-08-10-security-dependency-remediation-pr1.md`
- Modify: `docs/superpowers/specs/2026-08-18-copilotkit-v2-examples-design.md`
- Modify: `docs/superpowers/plans/2026-08-18-copilotkit-v2-examples.md`

- [x] **Step 1: Update README route maps and operational guidance**

Replace every current-runtime reference to:

```text
app/api/copilotkit/route.ts
@copilotkit/runtime
copilotRuntimeNextJSAppRouterEndpoint
ExperimentalEmptyAdapter
```

with:

```text
app/api/copilotkit/[...path]/route.ts
@copilotkit/runtime/v2
createCopilotRuntimeHandler
```

Document that the page sets `useSingleEndpoint={false}`, the runtime exposes V2
REST/SSE routes under `/api/copilotkit/*`, and credentials remain only on Dawn's
server. Preserve the existing live-model/manual-smoke language.

- [x] **Step 2: Replace the docs recipe's server and provider snippets**

Use the same handler shown in Task 2 and include:

```tsx
<CopilotKit
  runtimeUrl="/api/copilotkit"
  useSingleEndpoint={false}
  defaultThrottleMs={100}
>
```

Change the code-fence title to
`examples/research/web/app/api/copilotkit/[...path]/route.ts`. Remove the service
adapter and legacy endpoint factory entirely.

- [x] **Step 3: Reconcile memory scope and tool-renderer comments**

Keep the old unused, unallowlisted `/api/memory/*` proxy deleted. Preserve the
Workbench's bounded `MemoryPanel`, thread hydration, and consolidated
`/api/dawn/[...path]` proxy, whose explicit allowlist carries only the memory-review
and thread-read routes the browser needs. Document that durable-memory review is part
of the Workbench without widening the V2 transport migration itself.

Describe `ToolCallCard` against the CopilotKit 1.68.3 V2 runtime/default-renderer
contract. The public wildcard `useRenderTool` overload types its render props as
`any`, so do not claim its field names or status values are statically enforced;
retain the defensive parsing around the current runtime fields.

- [x] **Step 4: Amend the active security plan**

At the start of the implementation sequence, add this migration as prerequisite
Task 0. Replace current claims that freeze CopilotKit `1.66`, force
`@hono/node-server` 2.x, or depend on the legacy single-route response. State:

- selected stable CopilotKit owner: `1.68.3`;
- direct/type-facing AG-UI: `0.0.57`;
- `packages/ag-ui` development owner: `^1.68.3`, with optional peer
  compatibility retained at `>=1.66.0`;
- compatible node-server 1.x is accepted at `>=1.19.15`;
- no CopilotKit/node-server override;
- the obsolete UUID override is removed and the planned forced node-server
  override is rejected, leaving six pre-existing policies plus the scoped
  `js-yaml` policy: seven total overrides;
- provider-utils is recorded as upstream-blocked only if final recapture still
  reports it; otherwise record its resolved identity and reason; and
- V2 multi-route behavior is proven by the new loopback and page tests;
- Vercel remains a required CLI/native-deployment CI boundary; any final
  full-audit findings are not hidden, overridden, or used as a reason to remove
  that lane, and resolved findings are recorded as such; and
- final production/full audit sets are captured only after the remaining
  compatible remediation is complete.

Do not recapture final audit counts in this task; that happens after all
compatible dependency remediation is complete.

- [x] **Step 5: Verify current docs and stale-symbol absence**

Run:

```bash
node scripts/check-docs.mjs
rg -n "ExperimentalEmptyAdapter|copilotRuntimeNextJSAppRouterEndpoint|api/copilotkit/route\.ts|CopilotKit 1\.66" examples/chat examples/research/web apps/web/content/docs/recipes/research-web-ui.mdx
rg -n 'from "@copilotkit/(react-core|runtime)"' examples/chat/web examples/research/web
rg -n '1\.68\.1|\^1\.68\.1' docs/superpowers/specs/2026-08-18-copilotkit-v2-examples-design.md docs/superpowers/plans/2026-08-18-copilotkit-v2-examples.md docs/superpowers/plans/2026-08-10-security-dependency-remediation-pr1.md examples/chat examples/research/web apps/web/content/docs/recipes/research-web-ui.mdx
```

Expected: docs check PASS; all three `rg` commands return no current-guidance,
root-entrypoint, or stale selected-version matches. Historical specs/plans
outside this explicit set remain archival.

- [x] **Step 6: Commit the documentation update**

Run:

```bash
git add examples/chat/README.md examples/chat/web/README.md examples/research/web/README.md examples/research/web/app/components/ToolCallCard.tsx apps/web/content/docs/recipes/research-web-ui.mdx docs/superpowers/specs/2026-08-18-copilotkit-v2-examples-design.md docs/superpowers/plans/2026-08-18-copilotkit-v2-examples.md docs/superpowers/plans/2026-08-10-security-dependency-remediation-pr1.md
git diff --cached --check
git commit -m "docs(examples): document CopilotKit v2 runtime"
```

### Task 5: Verify the prerequisite from a clean committed state

**Files:**

- No expected file changes. If a formatter changes a scoped file, inspect and
  commit only the intentional result before continuing.

- [ ] **Step 1: Verify a frozen install and focused tests**

Run:

```bash
pnpm install --frozen-lockfile
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/dependency-resolution.test.ts test/security-dependencies/copilotkit-v2-runtime.test.ts
pnpm --filter @dawn-ai/ag-ui build
pnpm --filter @dawn-example/research-web test
pnpm --filter @dawn-example/chat-web test:e2e
pnpm --filter @dawn-example/research-web test:e2e
node --test scripts/release/test/workflow-contracts.test.mjs
```

Expected: all PASS.

- [ ] **Step 2: Verify both production builds and typechecks**

Run:

```bash
pnpm build
pnpm exec tsc -p test/security-dependencies/tsconfig.json --noEmit
pnpm --filter @dawn-example/chat-web typecheck
pnpm --filter @dawn-example/research-web typecheck
pnpm typecheck
```

Expected: all PASS. The root build runs first so every `dist/` consumer sees
current output.

- [ ] **Step 3: Inspect production and full audit deltas without muting anything**

Run:

```bash
pnpm audit --prod --json
pnpm audit --json
```

Expected: both may exit nonzero because the broader remediation is unfinished.
Confirm manually that:

- the upgraded CopilotKit graph introduces no new advisory family;
- compatible Hono/node-server/UUID findings are absent from the migrated paths;
- provider-utils remains under CopilotKit Google Vertex; and
- Vercel findings remain full-audit-only.

Do not add ignores, dismiss alerts, or freeze counts here.

- [ ] **Step 4: Perform the documented live-model smoke when credentials are available**

Use the updated manual smoke checklists in `examples/chat/web/README.md` and
`examples/research/web/README.md`. Verify chat streaming and continuation, then
verify research streaming, plan/researcher rendering, permission resume, and
memory-candidate review. This check is explicitly non-gating because the
examples require a real model credential. If credentials are unavailable,
record the skip and rely on the deterministic loopback and browser checks; do
not add a mock mode or secret-dependent CI step.

- [ ] **Step 5: Run repository Definition of Done**

Run:

```bash
pnpm ci:validate
```

Expected: PASS from the clean committed prerequisite state. If a pre-existing
security test intentionally remains red, fix or remove that obsolete assertion;
do not declare completion with a known failing gate.

- [ ] **Step 6: Inspect the final prerequisite diff and commit state**

Run:

```bash
git status --short
git diff --check
git log --oneline --decorate -8
```

Expected: clean worktree and the four scoped implementation commits after the
plan commits. Do not proceed to WIP restoration until this is true.

### Task 6: Restore and reconcile the preserved security WIP

**Files:**

- Restore the exact files recorded in Task 0.
- Reconcile likely overlaps in `package.json`, `pnpm-lock.yaml`, and
  `docs/superpowers/plans/2026-08-10-security-dependency-remediation-pr1.md`.
- Reconcile: `test/security-dependencies/fixtures/dependabot-baseline.json`
- Reconcile: `test/security-dependencies/dependabot-reconcile.test.ts`
- Reconcile: `test/security-dependencies/dependency-evidence.test.ts`

- [ ] **Step 1: Apply the preserved stash by immutable OID**

Run:

```bash
git stash apply <NEW_STASH_OID>
git status --short
```

Expected: all prior tracked/untracked WIP returns. The stash remains available
because `apply`, not `pop`, was used.

- [ ] **Step 2: Reconcile overlaps without losing either line of work**

Rules:

- `package.json`: retain the prerequisite's UUID-override removal, continued
  absence of a node-server override, and stable CopilotKit-related state; retain
  the restored security-browser/typecheck changes that are still part of the
  revised plan.
- `pnpm-lock.yaml`: never accept either side wholesale. First reconcile all
  manifests, then run `pnpm install --lockfile-only` and inspect the resulting
  importer/package changes.
- active security plan: retain the reviewed V2 prerequisite and integrate any
  restored evidence/reassessment edits around it.
- Dependabot evidence: recapture
  `test/security-dependencies/fixtures/dependabot-baseline.json` against the
  exact reviewed current default base and update the restored
  `dependabot-reconcile.test.ts` and `dependency-evidence.test.ts` assumptions.
  The final reviewed observation at default/main
  `239cf18d6f16448184c44369aa3ae89e976e95df` contains 59 open alerts, including
  current Hono/node-server alert `#236` and Vercel-derived alerts `#204`–`#235`.
  Alert `#232` is the only identity-field change from the prior 59-record
  observation: its `tar` advisory severity is now `high`, not `medium`.
  Remove restored old-27-alert and old-default-SHA expectations. Preserve
  `docs/superpowers/audits/2026-08-10-dependency-remediation-baseline.json`
  byte-for-byte as immutable historical evidence rather than rewriting it for
  the new base.
- untracked Mermaid/SOCKS work: restore every file, but update the Mermaid
  receipts' CopilotKit range/version assertions from `^1.66.0`/`1.66.4` to
  `^1.68.3`/`1.68.3`; do not stage that broader WIP as part of the CopilotKit
  commits.

- [ ] **Step 3: Verify the prerequisite still holds in the combined worktree**

Run:

```bash
git diff --check
pnpm install --lockfile-only
pnpm install --frozen-lockfile
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/dependency-resolution.test.ts test/security-dependencies/copilotkit-v2-runtime.test.ts
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/dependency-evidence.test.ts test/security-dependencies/dependabot-reconcile.test.ts
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/mermaid-rendering.test.ts
pnpm exec playwright test --config test/security-dependencies/playwright.config.ts
pnpm exec tsc -p test/security-dependencies/tsconfig.json --noEmit
pnpm --filter @dawn-ai/ag-ui build
pnpm --filter @dawn-example/chat-web exec next typegen
pnpm --filter @dawn-example/research-web exec next typegen
pnpm --filter @dawn-example/chat-web typecheck
pnpm --filter @dawn-example/research-web typecheck
rg -n '\^1\.66\.0|1\.66\.4' test/security-dependencies examples/chat/web examples/research/web
```

Expected: focused prerequisite, reconciled evidence, and restored Mermaid checks
PASS; the final `rg` returns no current-code matches for the exact obsolete
range or installed version. The intentional `>=1.66.0` optional peer and its
resolution assertion remain allowed. Broader dirty WIP may still have its own
unfinished tests and is not claimed complete here.

- [ ] **Step 4: Prove the stash was fully restored before dropping only the new recovery entry**

Run:

```bash
git stash show --stat --include-untracked <NEW_STASH_OID>
git status --short
git stash list --format='%H %gd %s'
```

Compare the restored status to Task 0 plus the intentional prerequisite changes.
After every stashed path is accounted for, locate the new OID's current selector
in the listing and run:

```bash
git stash drop <CURRENT_SELECTOR_FOR_NEW_STASH_OID>
```

Preserve every older stash, including the three security recovery stashes.

## Completion state

After Task 6:

- the branch contains the selected stable CopilotKit `1.68.3` dependency
  upgrade, V2 runtime/page
  migration, deterministic tests, CI browser lane, and current docs as commits;
- the pre-existing security WIP is restored for the broader remediation;
- no new dependency override exists;
- provider-utils and Vercel remain explicit upstream boundaries rather than
  hidden findings; and
- implementation resumes with dependency evidence recapture against the V2
  architecture.
