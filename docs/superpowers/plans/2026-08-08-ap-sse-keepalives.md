# Agent Protocol SSE Keepalives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep durable Agent Protocol SSE connections alive during silent runs and make both AP streaming endpoints advertise the same non-transforming cache policy.

**Architecture:** Add one web-runtime-compatible heartbeat helper inside the transport-agnostic fetch core. Thread an internal interval override from `createRuntimeFetchHandler` through the route table to both AP stream handlers, start the helper with each stream, and stop it in the outer stream `finally`; leave route iteration, explicit cancellation, durable disconnect semantics, and AG-UI untouched.

**Tech Stack:** TypeScript 7, Web `ReadableStream`/`Response`, Server-Sent Events, Vitest 4, pnpm/Turbo, Dawn CLI dev runtime, Chrome browser automation.

---

## File map

- Modify `packages/cli/src/lib/dev/runtime-fetch-core.ts` — define the AP heartbeat constants/helper, thread the internal test interval, start/stop heartbeats in both AP handlers, and align response headers.
- Modify `packages/cli/test/run-cancellation.test.ts` — exercise controlled idle `/runs/stream` and `/resume` responses, exact headers, unchanged application framing, and heartbeat teardown.
- Create `.changeset/ap-sse-keepalives.md` — publishable patch note for `@dawn-ai/cli`.
- Use a disposable `/private/tmp/dawn-ap-sse-browser-smoke` fixture for Chrome verification; do not commit it.

## Task 0: Establish the required local runtime and dependencies

**Files:**
- No source changes.

- [ ] **Step 1: Select the repository's Node 24 runtime**

This machine's default shell resolves Node 22, below the repository floor. Run
from the feature worktree root:

```bash
export PATH="/Users/blove/.nvm/versions/node/v24.18.0/bin:$PATH"
node --version
pnpm --version
```

Expected: Node reports `v24.18.0` (or a newer 24.x runtime) and pnpm reports
`10.33.0`. Every later command tool invocation starts a fresh shell, so begin
each one with the same `export PATH=...` line (or run that task's commands in
the same shell session). Apply it to the long-running dev-server session too.

- [ ] **Step 2: Install the exact locked workspace dependencies**

The dedicated worktree begins without `node_modules`. Run:

```bash
pnpm install --frozen-lockfile
```

Expected: exit 0 with no lockfile rewrite. Confirm `git status --short` still
lists only the uncommitted plan file before implementation starts.

## Task 1: Pin `/runs/stream` heartbeat and header behavior

**Files:**
- Modify: `packages/cli/test/run-cancellation.test.ts:105-141`
- Modify: `packages/cli/test/run-cancellation.test.ts:222-245`
- Modify: `packages/cli/test/run-cancellation.test.ts:355-359`

- [ ] **Step 1: Make the blocking fixture accept the internal heartbeat interval**

Change the setup signature and handler construction without changing existing callers:

```ts
async function setupBlockingRoute(options: { readonly apSseHeartbeatIntervalMs?: number } = {}) {
  // existing fixture setup remains unchanged
  const handler = await createRuntimeFetchHandler({
    appRoot,
    drainDeadlineMs: 250,
    ...(options.apSseHeartbeatIntervalMs !== undefined
      ? { apSseHeartbeatIntervalMs: options.apSseHeartbeatIntervalMs }
      : {}),
  })
  // existing return remains unchanged
}
```

- [ ] **Step 2: Add a reader helper that can continue after the first frame**

Place this beside `readSseText`:

```ts
async function readRemainingSseText(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    text += decoder.decode(value, { stream: true })
  }
}
```

- [ ] **Step 3: Write the failing `/runs/stream` transport test**

Add a new `describe("AP SSE keepalives", ...)` before the concurrency tests:

```ts
describe("AP SSE keepalives", () => {
  it("keeps an idle run stream alive without changing application events", async () => {
    const { handler, startedFile, releaseFile, releaseRoute } = await setupBlockingRoute({
      apSseHeartbeatIntervalMs: 10,
    })
    const response = await handler.fetch(
      runStreamRequest("t-heartbeat-stream", startedFile, releaseFile),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform")

    const reader = response.body?.getReader()
    if (!reader) throw new Error("expected AP stream body")
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(new TextDecoder().decode(first.value)).toBe(": ping\n\n")
    expect(handler.state.activeRequests).toBe(1)

    await releaseRoute()
    const remaining = await readRemainingSseText(reader)
    expect(remaining.replaceAll(": ping\n\n", "")).toBe(
      'event: done\ndata: {"output":{"ok":true}}\n\n',
    )
    await expect.poll(() => handler.state.activeRequests).toBe(0)
  }, 10_000)
})
```

- [ ] **Step 4: Run the focused test and verify the red state**

Run:

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/run-cancellation.test.ts -t "keeps an idle run stream alive"
```

Expected: FAIL at compile time because `apSseHeartbeatIntervalMs` is not an
accepted option. Vitest transpilation may instead reach runtime and fail first
on the old `/runs/stream` cache header; if that assertion is temporarily
bypassed, the first-frame read waits until timeout because the old
implementation emits no idle bytes.

## Task 2: Pin `/resume` heartbeat and heartbeat cleanup

**Files:**
- Modify: `packages/cli/test/run-cancellation.test.ts:310-342`
- Modify: `packages/cli/test/run-cancellation.test.ts` in the new `AP SSE keepalives` describe block

- [ ] **Step 1: Make the resume fixture accept the same internal interval**

```ts
async function setupResumeInterrupt(
  options: { readonly apSseHeartbeatIntervalMs?: number } = {},
) {
  // existing fixture setup remains unchanged
  const handler = await createRuntimeFetchHandler({
    appRoot,
    drainDeadlineMs: 250,
    ...(options.apSseHeartbeatIntervalMs !== undefined
      ? { apSseHeartbeatIntervalMs: options.apSseHeartbeatIntervalMs }
      : {}),
  })
  // existing return remains unchanged
}
```

- [ ] **Step 2: Write the failing `/resume` parity test**

```ts
it("keeps an idle resume stream alive with the same transport headers", async () => {
  const { handler, releaseRoute } = await setupResumeInterrupt({
    apSseHeartbeatIntervalMs: 10,
  })
  const response = await handler.fetch(resumeRequest("t-heartbeat-resume"))

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("text/event-stream")
  expect(response.headers.get("cache-control")).toBe("no-cache, no-transform")

  const reader = response.body?.getReader()
  if (!reader) throw new Error("expected resume stream body")
  const first = await reader.read()
  expect(first.done).toBe(false)
  expect(new TextDecoder().decode(first.value)).toBe(": ping\n\n")

  await releaseRoute()
  const remaining = await readRemainingSseText(reader)
  expect(remaining.replaceAll(": ping\n\n", "")).toBe(
    'event: done\ndata: {"output":{"ok":true}}\n\n',
  )
}, 10_000)
```

- [ ] **Step 3: Write the failing explicit-cancellation cleanup test**

Use a long heartbeat interval so explicit cancellation wins before any ping, and observe that the helper clears its interval:

```ts
it("clears the heartbeat when an explicitly cancelled stream ends", async () => {
  const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval")
  try {
    const { handler, startedFile, releaseFile } = await setupBlockingRoute({
      apSseHeartbeatIntervalMs: 60_000,
    })
    const response = await handler.fetch(
      runStreamRequest("t-heartbeat-cancel", startedFile, releaseFile),
    )
    await waitForFile(startedFile)

    expect((await handler.fetch(cancelRequest("t-heartbeat-cancel"))).status).toBe(200)
    expect(await readSseText(response)).toBe(
      'event: done\ndata: {"output":{"cancelled":true}}\n\n',
    )
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
  } finally {
    clearIntervalSpy.mockRestore()
  }
}, 10_000)
```

- [ ] **Step 4: Write the failing consumer-disconnect lifecycle test**

This pins the durable split directly: cancelling the viewer settles the body,
but must not clear the heartbeat until the underlying route completes.

```ts
it("keeps the heartbeat lifecycle until a disconnected run completes", async () => {
  const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval")
  try {
    const { handler, startedFile, releaseFile, releaseRoute } = await setupBlockingRoute({
      apSseHeartbeatIntervalMs: 60_000,
    })
    const response = await handler.fetch(
      runStreamRequest("t-heartbeat-disconnect", startedFile, releaseFile),
    )
    await waitForFile(startedFile)

    await response.body?.cancel()
    expect(handler.state.activeRequests).toBe(0)
    expect(clearIntervalSpy).not.toHaveBeenCalled()

    await releaseRoute()
    await expect.poll(() => clearIntervalSpy).toHaveBeenCalledTimes(1)
  } finally {
    clearIntervalSpy.mockRestore()
  }
}, 10_000)
```

- [ ] **Step 5: Run all four new tests and verify they fail for the intended reasons**

Run:

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/run-cancellation.test.ts -t "AP SSE keepalives"
```

Expected: FAIL because no heartbeat interval exists and `/runs/stream` has the old cache header.

## Task 3: Implement the shared AP heartbeat lifecycle

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts:98-105`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts:228-244`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts:401-430`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts:568-586`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts:713-732`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts:776-809`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts:905-978`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts:988-995`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts:1231-1266`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts:1374-1441`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts:1537-1552`

- [ ] **Step 1: Add production constants and the internal test hook**

Near `CLOSE_DRAIN_DEADLINE_MS`, add:

```ts
const AP_SSE_HEARTBEAT_INTERVAL_MS = 15_000
const AP_SSE_HEARTBEAT = new TextEncoder().encode(": ping\n\n")
```

Extend only the fetch-core option intersection:

```ts
/** Internal/test hook: override the AP SSE heartbeat interval (default 15s). */
readonly apSseHeartbeatIntervalMs?: number
```

Resolve the interval when building routes:

```ts
apSseHeartbeatIntervalMs:
  options.apSseHeartbeatIntervalMs ?? AP_SSE_HEARTBEAT_INTERVAL_MS,
```

- [ ] **Step 2: Thread the resolved interval through the existing route table**

Add required `readonly apSseHeartbeatIntervalMs: number` fields to the
`buildRouteTable`, `handleApStreamRequest`, and `handleResumeRequest` option
objects. Destructure it in each function and pass it at both handler call sites.
Do not pass it to AG-UI or `/runs/wait`.

- [ ] **Step 3: Add the shared web-compatible helper**

Place it beside `safeEnqueue`/`safeClose`:

```ts
function startSseHeartbeat(
  controller: ReadableStreamDefaultController<Uint8Array>,
  intervalMs: number,
): () => void {
  const timer = setInterval(() => {
    safeEnqueue(controller, AP_SSE_HEARTBEAT)
  }, intervalMs)
  return () => clearInterval(timer)
}
```

Do not call Node's `unref()`; this module is part of the edge fetch graph.

- [ ] **Step 4: Start and stop the heartbeat in `/runs/stream`**

At the beginning of the stream's `start(controller)`, before the outer `try`, add:

```ts
const stopHeartbeat = startSseHeartbeat(controller, apSseHeartbeatIntervalMs)
```

At the beginning of the outer `finally`, before release/close logic, add:

```ts
stopHeartbeat()
```

Keep `safeClose(controller)` last. This means an explicit cancellation closes
the viewer immediately and clears its heartbeat even when `sourceCleanup`
continues holding the run slot until the underlying route unwinds.

- [ ] **Step 5: Apply the identical lifecycle to `/resume`**

Use the same helper and cleanup placement in the resume stream. Do not change
resume-claim or run-slot release ordering.

- [ ] **Step 6: Align `/runs/stream` cache-control**

Change only the stream response's cache header:

```ts
"cache-control": "no-cache, no-transform",
```

The resume response already has the target value. Leave AG-UI's `no-cache`
header unchanged.

- [ ] **Step 7: Run the new tests and verify green**

Run:

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/run-cancellation.test.ts -t "AP SSE keepalives"
```

Expected: 4 tests PASS.

- [ ] **Step 8: Run the complete cancellation/resume regression files**

Run:

```bash
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts test/run-cancellation.test.ts test/resume-endpoint.test.ts test/runtime-fetch-parity.test.ts
```

Expected: all selected test files PASS, including exact cancelled-event assertions and deliberate disconnect behavior.

- [ ] **Step 9: Inspect and commit the implementation**

Run `git diff --check`, inspect the focused diff, then:

```bash
git add packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/run-cancellation.test.ts
git commit -m "fix(cli): keep Agent Protocol streams alive"
```

## Task 4: Add release metadata and package-level verification

**Files:**
- Create: `.changeset/ap-sse-keepalives.md`

- [ ] **Step 1: Add the patch changeset**

```md
---
"@dawn-ai/cli": patch
---

Keep Agent Protocol SSE streams alive during silent runs with periodic comment
frames, and prevent intermediaries from transforming either run or resume
streams.
```

- [ ] **Step 2: Run the CLI package gates**

Run from the repository root:

```bash
pnpm --filter @dawn-ai/cli lint
pnpm --filter @dawn-ai/cli typecheck
pnpm --filter @dawn-ai/cli build
pnpm --filter @dawn-ai/cli test
```

Expected: every command exits 0. Build before any later smoke against `dist/`.

- [ ] **Step 3: Run changeset validation**

Run:

```bash
node scripts/check-changesets.mjs
```

Expected: exits 0 and recognizes the CLI patch changeset.

- [ ] **Step 4: Commit release metadata**

```bash
git add .changeset/ap-sse-keepalives.md
git commit -m "chore: record Agent Protocol keepalive fix"
```

## Task 5: Exercise the production 15-second interval through Chrome

**Files:**
- Create temporarily: `/private/tmp/dawn-ap-sse-browser-smoke/package.json`
- Create temporarily: `/private/tmp/dawn-ap-sse-browser-smoke/dawn.config.ts`
- Create temporarily: `/private/tmp/dawn-ap-sse-browser-smoke/src/app/idle/index.ts`
- Do not commit any smoke fixture file.

- [ ] **Step 1: Invoke the browser-control skill**

Use `@chrome:control-chrome` because the user explicitly requested real Chrome
smoke testing. If the Chrome connector is unavailable, stop and ask the user
whether the in-app browser is an acceptable substitute; do not silently weaken
this acceptance criterion.

- [ ] **Step 2: Create a disposable idle-route fixture**

Create `/private/tmp/dawn-ap-sse-browser-smoke` only after confirming it does
not contain unrelated files. Use the file-editing tool, not shell redirection.

`package.json`:

```json
{
  "name": "dawn-ap-sse-browser-smoke",
  "private": true,
  "type": "module"
}
```

`dawn.config.ts`:

```ts
const pendingWrites = [
  [
    "33a12321-3ec2-56a7-b4d7-0337886c4386",
    "__interrupt__",
    {
      id: "3336d0e0a2d4f198ef9aecd09cd7ac27",
      value: { interruptId: "browser-permission" },
    },
  ],
]

export default {
  checkpointer: {
    getTuple: async () => ({ pendingWrites }),
  },
}
```

`src/app/idle/index.ts`:

```ts
export const graph = async () => {
  await new Promise((resolve) => setTimeout(resolve, 18_000))
  return { ok: true, source: "browser-smoke" }
}
```

- [ ] **Step 3: Start the real Dawn dev command on a stable port**

From the fixture directory, start the built CLI from the feature worktree:

```bash
node /private/tmp/dawn-sse/packages/cli/dist/index.js dev --port 8123
```

Wait for `http://127.0.0.1:8123/healthz` to return 200. Keep the server session
open for the browser checks.

- [ ] **Step 4: Open the same-origin Dawn page in Chrome**

Navigate Chrome to `http://127.0.0.1:8123/healthz`. Use browser evaluation to
replace the JSON document body with a small visible `<pre id="log">` smoke
panel and define this streaming probe:

```js
window.probe = async (label, url, body) => {
  const log = document.querySelector("#log")
  const started = performance.now()
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
  log.textContent += `${label} status=${response.status} cache=${response.headers.get("cache-control")}\n`
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      log.textContent += `${label} closed @ ${Math.round(performance.now() - started)}ms\n`
      return
    }
    log.textContent += `${label} @ ${Math.round(performance.now() - started)}ms ${JSON.stringify(decoder.decode(value))}\n`
  }
}
```

- [ ] **Step 5: Smoke `/runs/stream` at the real production interval**

Run in the page:

```js
await window.probe("run", "/threads/browser-run/runs/stream", {
  input: {},
  route: "/idle#graph",
})
```

Observe and capture evidence that:

- status is 200;
- cache header is `no-cache, no-transform`;
- `: ping\n\n` arrives at roughly 15 seconds, before application output;
- the final `done` event contains `browser-smoke` at roughly 18 seconds;
- the response closes normally after the final event.

- [ ] **Step 6: Smoke `/resume` at the real production interval**

Run:

```js
await window.probe("resume", "/threads/browser-resume/resume", {
  resume: [
    {
      interruptId: "browser-permission",
      payload: "once",
      status: "resolved",
    },
  ],
  route: "/idle#graph",
})
```

Verify the same header, heartbeat timing, final event, and clean closure.

- [ ] **Step 7: Inspect visible browser state**

Capture a screenshot of the completed smoke panel. Inspect the page console and
browser-visible request state for errors, truncated frames, duplicate Dawn
events, or a request left pending after the terminal event. Record exact timing
and headers in the handoff.

- [ ] **Step 8: Stop the server and remove only the disposable fixture**

Stop the dev server, verify the exact temp path, and remove
`/private/tmp/dawn-ap-sse-browser-smoke`. Do not remove the active feature
worktree or any unrelated worktree.

## Task 6: Run repository verification and inspect the packed CLI

**Files:**
- No expected source changes.

- [ ] **Step 1: Run the repository Definition of Done**

Reconfirm the Node 24+ runtime selected in Task 0, then run from the repository root:

```bash
node --version
pnpm ci:validate
```

Expected: Node is at least 24 and the complete local validation sequence exits
0. If an environment-gated lane is unavailable, record the exact skipped lane
and run every available required lane separately; do not describe a partial run
as full validation.

- [ ] **Step 2: Inspect the packed artifact for the promised change**

After the build, run from the repository root:

```bash
set -e
dawn_pack_dir="$(mktemp -d /private/tmp/dawn-cli-pack.XXXXXX)"
trap 'rm -rf "$dawn_pack_dir"' EXIT
pnpm --filter @dawn-ai/cli pack --pack-destination "$dawn_pack_dir"
dawn_tarball="$(find "$dawn_pack_dir" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
tar -xzf "$dawn_tarball" -C "$dawn_pack_dir" package/dist/lib/dev/runtime-fetch-core.js
rg -F ': ping' "$dawn_pack_dir/package/dist/lib/dev/runtime-fetch-core.js"
rg -F 'no-cache, no-transform' "$dawn_pack_dir/package/dist/lib/dev/runtime-fetch-core.js"
```

Expected: the pack succeeds, the built fetch core contains both promised
behaviors, and the exit trap removes only the freshly created pack directory
whether a check passes or fails. This
specifically closes the release-validation gap identified during 0.8.19.

- [ ] **Step 3: Review repository state**

Run:

```bash
git diff --check
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: no uncommitted source or smoke-fixture changes; only the intentional
design, implementation, changeset, and plan commits are ahead of `origin/main`.

- [ ] **Step 4: Confirm old temporary worktrees are absent**

Use `git worktree list --porcelain` and confirm the previously identified merged
worktrees `dawn-activereq`, `dawn-bootstrap`, `dawn-csguard`, and
`dawn-followups` are not registered. Leave all unrelated worktrees untouched.
The active `/private/tmp/dawn-sse` worktree remains until the feature branch is
integrated or explicitly handed off.

## Task 7: Final review checkpoint

**Files:**
- Review all files changed by `origin/main...HEAD`.

- [ ] **Step 1: Invoke verification-before-completion**

Use `@superpowers:verification-before-completion` and verify every success claim
against fresh command output.

- [ ] **Step 2: Request code review**

Use `@superpowers:requesting-code-review` for the complete branch diff. Address
only evidence-backed findings and rerun affected verification.

- [ ] **Step 3: Report the completed result**

Summarize production behavior, automated test counts, full-validation result,
Chrome evidence (headers, heartbeat timings, completion, console state), packed
artifact inspection, commits, and worktree hygiene. Do not push or open a PR
unless the user requests publication.
