# Subprocess Shutdown Barrier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `createSubprocessApp().close()` and async disposal resolve only after the spawned CLI child has closed, the `baseUrl` port is unavailable, and bounded process-tree termination attempts have completed.

**Architecture:** Keep the public API unchanged. Build the shutdown barrier incrementally: first await the spawned CLI's `close` event through one memoized promise, then add bounded TCP observation for surviving descendants and forced termination. On POSIX, signal the detached group and fall back to the direct child. On Windows, use bounded `taskkill.exe /PID <saved PID> /T /F` before any last-resort direct-child kill. Reuse the same closure function when readiness fails.

**Tech Stack:** TypeScript, Node.js `child_process`/`net`/`timers`, Vitest, pnpm, Changesets.

---

### Task 1: Pin the public completion and readiness-cleanup contracts

**Files:**
- Modify: `packages/testing/test/subprocess.test.ts`
- Test: `packages/testing/test/subprocess.test.ts`

- [x] **Step 1: Build before exercising the real `dist` CLI**

```bash
pnpm build
```

Expected: PASS. This is mandatory because `createSubprocessApp()` executes `packages/cli/dist/index.js`.

- [x] **Step 2: Add deterministic delayed-signal tests**

Import `setTimeout as delay` from `node:timers/promises` and `vi` from Vitest. Add:

```ts
it("waits for process shutdown and shares one close promise", async () => {
  const mock = await createAimock({ fixtures: [{ match: {}, response: { content: "ok" } }] })
  const app = await createSubprocessApp({
    appRoot,
    env: { OPENAI_BASE_URL: mock.baseUrl, OPENAI_API_KEY: "test-not-used" },
  })
  const realKill = process.kill.bind(process)
  const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (typeof pid === "number" && pid < 0 && signal === "SIGTERM") {
      setTimeout(() => {
        try {
          realKill(pid, signal)
        } catch {}
      }, 100)
      return true
    }
    return realKill(pid, signal)
  })

  try {
    const first = app.close()
    const second = app.close()
    const disposed = app[Symbol.asyncDispose]()
    expect(second).toBe(first)
    expect(disposed).toBe(first)
    await expect(
      Promise.race([first.then(() => "closed"), delay(25, "waiting")]),
    ).resolves.toBe("waiting")
    await first
    await expect(fetch(new URL("/healthz", app.baseUrl))).rejects.toThrow()
  } finally {
    killSpy.mockRestore()
    await app.close()
    await mock.close()
  }
}, 120_000)

it("waits for cleanup when readiness fails", async () => {
  const realKill = process.kill.bind(process)
  const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (typeof pid === "number" && pid < 0 && signal === "SIGTERM") {
      setTimeout(() => {
        try {
          realKill(pid, signal)
        } catch {}
      }, 100)
      return true
    }
    return realKill(pid, signal)
  })

  try {
    const creating = createSubprocessApp({ appRoot, readyTimeoutMs: 0 })
    const outcome = creating.then(
      () => "created",
      () => "rejected",
    )
    await expect(Promise.race([outcome, delay(25, "waiting")])).resolves.toBe("waiting")
    await expect(creating).rejects.toThrow("within 0ms")
  } finally {
    killSpy.mockRestore()
  }
}, 120_000)
```

- [x] **Step 3: Run each test and verify RED**

```bash
pnpm --filter @dawn-ai/testing exec vitest --run --config vitest.config.ts test/subprocess.test.ts -t "shares one close promise"
pnpm --filter @dawn-ai/testing exec vitest --run --config vitest.config.ts test/subprocess.test.ts -t "readiness fails"
```

Expected: the first fails because `close()` returns immediately and distinct async promises; the second fails because constructor rejection does not await delayed termination.

- [x] **Step 4: Commit the red tests**

```bash
git add packages/testing/test/subprocess.test.ts
git commit -m "test(testing): pin subprocess shutdown barrier"
```

### Task 2: Await one memoized child-close observation

**Files:**
- Modify: `packages/testing/src/subprocess.ts`
- Test: `packages/testing/test/subprocess.test.ts`

- [x] **Step 1: Establish the `close` observation immediately after spawn**

Add this internal helper; do not resolve from `exitCode` or `signalCode`, because the contract requires stdio closure:

```ts
function childClosePromise(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("close", () => resolve())
  })
}
```

Immediately after `spawn`, require the PID and create the promise before readiness work:

```ts
const groupPid = child.pid
if (groupPid === undefined) throw new Error("dawn dev subprocess has no process id")
const closed = childClosePromise(child)
```

- [x] **Step 2: Add graceful process-group termination**

```ts
async function terminateSubprocess(
  child: ChildProcess,
  groupPid: number,
  closed: Promise<void>,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    process.kill(-groupPid, "SIGTERM")
  }
  await closed
}
```

This is deliberately the minimum green implementation. Escalation and fallback come only after their own red tests.

- [x] **Step 3: Memoize one closure function and reuse it everywhere**

After `baseUrl` is known:

```ts
let closePromise: Promise<void> | undefined
const close = (): Promise<void> => {
  closePromise ??= terminateSubprocess(child, groupPid, closed)
  return closePromise
}
```

Replace readiness-failure signal dispatch with `await close()`. Return `close` directly as the app object's `close` property, and make `[Symbol.asyncDispose]()` return `close()`. Remove `stopped` and the `async close()` wrapper so promise identity is preserved.

- [x] **Step 4: Run Task 1 tests and verify GREEN**

Run both Task 1 commands, then:

```bash
pnpm --filter @dawn-ai/testing exec vitest --run --config vitest.config.ts test/subprocess.test.ts
```

Expected: all subprocess tests pass.

- [x] **Step 5: Commit the minimal barrier**

```bash
git add packages/testing/src/subprocess.ts
git commit -m "fix(testing): await subprocess closure"
```

### Task 3: Observe a surviving descendant through the listening port

**Files:**
- Create: `packages/testing/test/fixtures/subprocess-tree.mjs`
- Modify: `packages/testing/test/subprocess.test.ts`
- Modify: `packages/testing/src/subprocess.ts`

- [x] **Step 1: Create the disposable process-tree fixture**

Create `packages/testing/test/fixtures/subprocess-tree.mjs`:

```js
import { spawn } from "node:child_process"

const mode = process.argv[2]

if (mode === "idle" || mode === "ignore-term") {
  if (mode === "ignore-term") process.on("SIGTERM", () => {})
  process.stdout.write("ready\n")
  setInterval(() => {}, 1_000)
} else if (mode === "leader") {
  const descendantSource = `
    import { createServer } from "node:net"
    const server = createServer((socket) => socket.end())
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || address === null) process.exit(2)
      process.stdout.write(String(address.port) + "\\n")
    })
  `
  const descendant = spawn(
    process.execPath,
    ["--input-type=module", "--eval", descendantSource],
    { stdio: ["ignore", "pipe", "inherit"] },
  )
  descendant.stdout?.once("data", (chunk) => {
    process.stdout.write(chunk, () => process.exit(0))
  })
} else {
  throw new Error(`unknown subprocess-tree mode: ${mode}`)
}
```

- [x] **Step 2: Add exact test helpers**

In `subprocess.test.ts`, import `spawn`, `createConnection`, and `terminateSubprocess`. Add:

```ts
const processTreeFixture = fileURLToPath(
  new URL("./fixtures/subprocess-tree.mjs", import.meta.url),
)

async function spawnTree(mode: "idle" | "ignore-term" | "leader") {
  const child = spawn(process.execPath, [processTreeFixture, mode], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  })
  if (child.pid === undefined) throw new Error("fixture process has no pid")
  const groupPid = child.pid
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", () => resolve())
  })
  const line = await new Promise<string>((resolve, reject) => {
    let output = ""
    child.once("error", reject)
    child.once("close", () => {
      if (!output.includes("\n")) reject(new Error("fixture closed before readiness"))
    })
    child.stdout?.on("data", (chunk) => {
      output += String(chunk)
      if (output.includes("\n")) resolve(output.trim())
    })
  })
  return { child, closed, groupPid, line }
}

function canConnect(baseUrl: string): Promise<boolean> {
  const url = new URL(baseUrl)
  return new Promise((resolve) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })
}
```

- [x] **Step 3: Add and run the surviving-descendant RED test**

```ts
it("waits for a surviving descendant to release the port", async () => {
  const realKill = process.kill.bind(process)
  const { child, closed, groupPid, line } = await spawnTree("leader")
  const baseUrl = `http://127.0.0.1:${Number(line)}`
  await closed
  expect(await canConnect(baseUrl)).toBe(true)
  try {
    await terminateSubprocess(child, groupPid, closed, baseUrl, TEST_TERMINATION_TIMINGS)
    expect(await canConnect(baseUrl)).toBe(false)
  } finally {
    try {
      realKill(-groupPid, "SIGKILL")
    } catch {}
  }
})
```

Add `TEST_TERMINATION_TIMINGS` with grace 100 ms, force 100 ms, probe interval 5 ms, and probe timeout 10 ms.

Run:

```bash
pnpm --filter @dawn-ai/testing exec vitest --run --config vitest.config.ts test/subprocess.test.ts -t "surviving descendant"
```

Expected: RED at compile time because the internal helper does not yet accept `baseUrl`/timings, or behaviorally because it returns after the already-closed leader while the port remains live.

- [x] **Step 4: Implement bounded joint observation**

Import `createConnection` from `node:net`. Add internal defaults of 2,000 ms graceful/forced deadlines, 25 ms polling, and 100 ms probe timeout. Export `TerminationTimings` and `terminateSubprocess` from this source module for direct tests, but do not re-export either from `src/index.ts`.

Implement `portAcceptsConnections()` with a TCP socket that resolves `true` on connect or timeout and `false` on socket error. Implement `waitUntilStopped()` that, until its deadline, requires both the previously established child-close promise and a failed port connection; it must not leave a polling promise running after timeout.

Update `terminateSubprocess()` to accept `baseUrl` and timings. Resolve immediately only when the child is closed and the port is unavailable; otherwise signal the saved group with `SIGTERM`, wait the grace deadline, and throw a PID/deadline error for now. Update the public close call to pass `baseUrl` and defaults.

- [x] **Step 5: Verify GREEN and commit**

Run the Task 3 test and the whole subprocess file. Expected: PASS.

```bash
git add packages/testing/src/subprocess.ts packages/testing/test/subprocess.test.ts packages/testing/test/fixtures/subprocess-tree.mjs
git commit -m "fix(testing): observe subprocess port shutdown"
```

### Task 4: Escalate and reject on bounded failure

**Files:**
- Modify: `packages/testing/test/subprocess.test.ts`
- Modify: `packages/testing/src/subprocess.ts`

- [x] **Step 1: Add and run the escalation RED test**

Use `spawnTree("ignore-term")` with an unavailable base URL obtained by binding a temporary `createServer()` to port zero and closing it. Add one pass-through `process.kill` spy test that expects `terminateSubprocess()` to resolve and observes `[-groupPid, "SIGKILL"]`. Restore the spy and forcibly clean up the exact process group in `finally`.

Run only the escalation test. Expected: RED because the current graceful deadline throws without attempting `SIGKILL`.

- [x] **Step 2: Add and run the final-timeout RED test**

Add the second test described above whose exact negative-PID `SIGTERM` and `SIGKILL` calls return `true` without delivering signals. Run only that test. Expected: RED because the current error is raised after the graceful deadline and does not represent a failed forced-termination deadline. Every spawned process and spy must be restored and the exact group forcibly cleaned up in `finally`.

The escalation assertion must prove `SIGKILL` was delivered. The final-timeout assertion must prove the error names the group PID and the combined `graceMs + forceMs` deadline.

- [x] **Step 3: Implement forced termination**

After the graceful wait expires, signal the group with `SIGKILL`. Await the same joint child-close/port-unavailable condition for `forceMs`. Return on success; otherwise throw an error containing the group PID and `graceMs + forceMs`.

- [x] **Step 4: Verify GREEN and commit**

```bash
pnpm --filter @dawn-ai/testing exec vitest --run --config vitest.config.ts test/subprocess.test.ts -t "SIGKILL|bounded failure"
git add packages/testing/src/subprocess.ts packages/testing/test/subprocess.test.ts
git commit -m "fix(testing): bound subprocess termination"
```

### Task 5: Dispatch termination per platform

**Files:**
- Modify: `packages/testing/test/subprocess.test.ts`
- Modify: `packages/testing/src/subprocess.ts`

- [x] **Step 1: Add platform-gated RED tests**

On POSIX, spawn `idle`, make only `process.kill(-groupPid, "SIGTERM")` throw, and install a pass-through spy on `child.kill`. Await termination and assert `child.kill("SIGTERM")` was called. Restore spies and forcibly clean up the exact group in `finally`.

On Windows, retain the platform-gated live process-tree test. It proves
`taskkill.exe /PID <saved PID> /T /F` terminates the tree without directly
killing the outer child. A deterministic cross-platform test closes an idle
child, keeps an independent TCP server live, injects the Windows dispatcher,
and proves bounded rejection without any tree-kill dispatch. This covers the
closed-child guard without assuming a descendant survives outer-child closure.

- [x] **Step 2: Implement platform-specific dispatch**

Extract `requestProcessTreeTermination(...)`. Its internal test seam accepts an optional platform and Windows tree-kill dispatcher; production defaults remain `process.platform` and bounded `taskkill.exe /PID <saved PID> /T /F`. On POSIX, try `process.kill(-groupPid, signal)` and, on error, call `child.kill(signal)`. On Windows, first run bounded `taskkill.exe /PID <saved PID> /T /F`; charge that command's elapsed time to its grace or force phase. Only after a failed forced-phase command, while time remains and the child is still live, attempt a last-resort direct-child kill. Never target a saved PID after its child has closed.

- [x] **Step 3: Verify GREEN and commit**

```bash
pnpm --filter @dawn-ai/testing exec vitest --run --config vitest.config.ts test/subprocess.test.ts
git add packages/testing/src/subprocess.ts packages/testing/test/subprocess.test.ts
git commit -m "fix(testing): fall back to direct process signals"
```

### Task 6: Add release metadata and verify

**Files:**
- Create: `.changeset/quiet-process-close.md`
- Modify: `.github/workflows/ci.yml`
- Verify: `packages/testing/src/subprocess.ts`
- Verify: `packages/testing/test/subprocess.test.ts`

- [x] **Step 1: Add the exact patch changeset**

```md
---
"@dawn-ai/testing": patch
---

Wait for subprocess applications to finish terminating before `close()` or async disposal resolves.
```

- [x] **Step 2: Run package verification**

```bash
pnpm --filter @dawn-ai/testing build
pnpm --filter @dawn-ai/testing typecheck
pnpm --filter @dawn-ai/testing lint
pnpm --filter @dawn-ai/testing test
```

Expected: all commands pass.

- [x] **Step 3: Add focused native Windows CI coverage**

Add the `testing-windows` job to `.github/workflows/ci.yml`. Run it on
`windows-latest` with a 20-minute timeout. Use the repository's pinned
checkout, pnpm setup, and Node 24.17.0 setup actions; install with a frozen
lockfile; then build `@dawn-ai/testing...` so the testing dependency closure
includes the CLI `dist` output. Run only the two shutdown-specific tests from
the package-configured subprocess suite:

```bash
pnpm --filter @dawn-ai/testing exec vitest --run --config vitest.config.ts test/subprocess.test.ts --testNamePattern "Windows process tree|injected Windows tree kill"
```

This job executes the real Windows `taskkill.exe` process-tree test and the
injected stale-dispatch guard. The latter closes an idle child and keeps an
independent TCP server live, so it does not depend on a surviving orphan
fixture. It is intentionally not a claim of broader Windows coverage.

The prior Windows run provided the RED evidence for the orphan assumption:
after the outer fixture closed, its descendant port was already unavailable,
so both orphan-based tests failed their live-port precondition. The same
full-file run also reached an unrelated Dawn dev/HMR port-restart timeout;
the name filter deliberately excludes that broader coverage.

- [x] **Step 4: Run repository validation**

```bash
pnpm ci:validate
```

Expected: all Definition of Done lanes pass. Environment-gated Docker/Kubernetes lanes remain PR CI responsibilities.

- [x] **Step 5: Review tracked and uncommitted changes**

```bash
git diff --check main...HEAD
git diff --check
git diff --cached --check
git status --short
```

Expected: no whitespace errors; only the approved spec/plan, testing source/tests/fixture, and exact changeset are changed.

- [x] **Step 6: Commit release metadata and plan progress**

```bash
git add .changeset/quiet-process-close.md docs/superpowers/plans/2026-08-09-subprocess-shutdown-barrier.md docs/superpowers/specs/2026-08-09-subprocess-shutdown-barrier-design.md
git commit -m "chore(testing): document subprocess shutdown fix"
```
