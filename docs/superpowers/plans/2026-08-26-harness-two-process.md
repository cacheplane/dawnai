# Two-Process Activation Lane Implementation Plan (SP3b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach `withPackagedNpmServer` to boot a second child with no `/healthz`, nest the generated Next web client inside the existing Dawn dev session, and prove — over plain `fetch`, no browser — that the generated web client reaches **this** generated server through both of its route handlers.

**Architecture:** Two nested `withPackagedNpmServer` calls, server outer / web inner. The helper gains one option (`readiness`) and one widened enum (`script`); everything else about spawn, teardown, transcript and abort plumbing is untouched. The web child runs `npm run dev:web` — the documented command — and never requests `/`.

**Spec authority:** `docs/superpowers/specs/2026-08-19-dawn-workbench-design.md:277` — "teaching the generated-app harness to build a web workspace and **boot two processes**". The Playwright gate is SP4 and is out of scope (§5).

**Execution baseline:** branch `blove/harness-two-process` off `ba84ad89`.

**Toolchain traps:** Prefix every node/pnpm command with `export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && `. Never bare `biome check --write`. Never pipe a gate through `tail` (it hides the exit code). Verify `git branch --show-current` before starting and before each commit.

---

## 1. DECISIONS

### D1 — The web child boots with `next dev`, via `npm run dev:web`, from the app root

`npm run dev:web` is the command the scaffold's next-steps text tells a user to run on minute one; nothing currently proves it works, including the `--` terminator on the root delegator that `packages/devkit/test/template-root-scripts.test.ts` exists to protect.

**Not `next start`.** A production boot would re-prove what `npm run build` already proved (the lane runs `next build` and asserts `web/.next` exists at `run-generated-research-activation.test.ts:1046`), and it needs a root `start:web` script the template does not have — a template edit plus the `rootManifest.scripts` `toEqual` pin at `:1063`, for ~1.5s of marginal coverage. See §6 STILL OPEN.

Cost is bounded because **the lane never requests `/`**: `/` costs 15–36s cold in dev (35.9s measured), while `/api/dawn/*` costs 0.66–1.7s and `/api/copilotkit/info` 2.4–8.6s.

### D2 — Readiness is `GET /api/dawn/memory/candidates` → 2xx

Next compiles route handlers lazily, so a 2xx here means the route's whole module graph compiled **and** the proxy reached a Dawn server. Readied at 2486ms / 0.66s across two independent measurements against a 60s budget.

Rejected: stdout `Ready in Xms` (fires 12–29s early; fired at 597ms on a build whose `/` then served 500 for 180s), TCP connect (fires within ~15ms of the stdout line — same lie), `/` (10.9–30.6s), `/api/copilotkit/info` (returned **200 with the upstream dead** — it never contacts Dawn), a template `/api/health` route (a trivial route readied at 3666ms while `/` needed 16,116ms more; it certifies only "Next is listening", which TCP gives free — plus it would ship an unasked-for public endpoint in every scaffolded app and move the `templates.test.ts:457` parity counts).

**False-ready does not error, it hangs.** A request issued at the `Ready in` line blocked 20,676ms and then returned 200. That is why the probe must be an HTTP 2xx on a route the journeys use.

`GET /api/dawn/threads` → 403 was the other candidate. It is kept — as an **assertion** (W1), not as the ready gate, because 403 never touches the Dawn server and so proves strictly less.

### D3 — `PACKAGED_NPM_READY_TIMEOUT_MS` stays 60_000, and there is no `warmUp` hook

24–90x headroom on the measured probe. The `/api/copilotkit/*` lazy compile (2.4–8.6s, worst right after a `next build` — this lane's exact sequence) is paid inside W3, an ordinary `fetch` with a 60s per-request budget, so it needs no separate warm-up machinery. Do not raise the budget; do not add `warmUp`.

### D4 — Compose by nesting; do not make the helper multi-child

Nesting already gives LIFO teardown, per-child `finally`, per-child transcripts, and a per-child `terminateSubprocess(child, groupPid, closed, url)` that probes *that* child's port. Measured non-abort semantics are all correct: inner-fails-to-start tears down the outer and propagates the inner's error unwrapped; inner-action-throws dies `inner -> outer` with error identity preserved. Nesting also makes port allocation safer, not riskier: when the inner allocates, the outer server is already **bound** (0 hits in 3,000 allocations against a held port).

### D5 — Fix the abort path in the same change

On abort, `awaitWithAbort` (`packaged-app.ts:713`) stops awaiting the action and the outer runs its `finally` — measured 29ms after abort, with the inner child **still alive** for another 500–1000ms. Today that leaks a dangling fetch; with nesting it leaks a live `next` process group, loses LIFO order, and lets two children `appendFile` the same `commands.log` concurrently. Four lines, one test.

### D6 — `DAWN_SERVER_URL` is injected at spawn, not at build

Both handlers read it at module scope with `export const runtime = "nodejs"`, and Next does **not** inline it: the built server chunk contains `process.env.DAWN_SERVER_URL??"http://127.0.0.1:3002"` verbatim, and a build at port 4713 started at 4711 answered 4711's body. Pass `env: { DAWN_SERVER_URL: url }` on the inner call. This composes with the credential machinery unchanged: `removeEnvironmentVariables(env, GENERATED_APP_UNSET_ENV)` runs at `:631`, **before** `Object.assign(env, {…, ...options.env})` at `:632`.

Also set `COPILOTKIT_TELEMETRY_DISABLED=true` and `DO_NOT_TRACK=1`: without them the runtime prints "anonymous telemetry enabled" and makes an outbound call, in a lane whose entire claim is hermeticity.

### D7 — Leave `allocatePort` alone; assert the two ports differ instead

3,000 serial allocations → 3,000 distinct; 3,000 sequential pairs → 0 collisions; 3,000 concurrent pairs → 0; a port only recurs after 16,355 allocations. A speculative rewrite buys nothing. One `expect(webPort).not.toBe(serverPort)` line closes the residual.

### D8 — The assertion set: six web assertions, none of which duplicate an existing one

`write-template.ts:53` renames `*.test.ts.template` → `*.test.ts`, and the root `test` script fans out `--workspaces`, so `npm test` in this lane **already** runs the web workspace's own suite: proxy allowlist forward + reject, the 502 body, header passthrough, ConnectScreen-on-502, hydrate, transcript, MemoryPanel. Do not re-prove any of it over HTTP.

| | Assertion | What only two processes can prove |
|---|---|---|
| W1 | `GET /api/dawn/threads` → 403 `{"error":"Not proxied"}` | the allowlist denies by default in a real Next process |
| W2 | `GET /api/dawn/threads/<safeThreadId>/state` → 200 echoing the thread id and the safe journey's citation; a random id → 404 | **the proxy reached THIS server** — not the hard-coded `:3002` default, not a stray dev server. The single highest-value assertion in the slice |
| W3 | `GET /api/copilotkit/info` → 200, `agents` has `default`, `mode === "sse"`, `telemetryDisabled === true` | the runtime is mounted at the basePath the client uses, under the agent id every hook resolves, and is not phoning home |
| W4 | one full run through `POST /api/copilotkit/agent/default/run` → success terminal, exact assistant text, one `dawn.plan` `ACTIVITY_SNAPSHOT` whose `content` deep-equals the fixture, `writeTodos` still suppressed, +2 aimock, then `/threads/<webThreadId>/state` → 200 | Dawn's events survive a third-party runtime that re-validates and re-encodes every frame — and our ids reached Dawn's checkpointer through the hop |
| W5 | gated run → `outcome.type === "interrupt"` with `metadata.detail.command`; resume run carrying `resume[]` → success + `TOOL_CALL_RESULT` on the same tool-call id | the interrupt outcome and the resume envelope survive the CopilotKit hop. Highest-risk contract in the app; it regressed once (#360) |
| W6 | W1–W3 move the aimock journal by **zero**; the commands transcript contains no `ambient-secret`; the web child's exit is recorded | the web tier has no model path except through Dawn, and the second child dies |

W4/W5 use **dedicated prompts and fixtures**, not `SAFE_PROMPT`/`GATED_PROMPT`, so the existing journeys' aimock accounting is untouched and no assumption is made about whether aimock fixtures are consumed or reusable.

**Never assert `info.agents.default.className`** — it is minified and varies across builds (`Fe` / `xe` / `nm`).

**Never assert `RUN_STARTED.runId`/`threadId` equality through the hop.** CopilotKit adds an `input` echo to that frame, and id echo is a property of a third-party runtime. W2/W4's thread-state reads prove id round-trip in a way that does not depend on it.

---

## 2. CONTRADICTIONS

**C1 — dev vs. start for the web child. Three investigations, three answers.** Investigation 1 said `next dev` with a proxy-route probe; investigation 2 said `next start` because dev's cold `/` is 25–36s against a 60s ready budget; investigation 3 said both. **Resolution: `next dev` only.** Investigation 2's objection is entirely about `/`, and D1/D2 never request `/`: readiness is the proxy route at 0.66–2.5s, which investigation 2 did not measure as a readiness candidate. Its own numbers agree — it measured `/api/dawn/*` at 0.66s in dev. Verified by reading `packages/devkit/templates/app-research/package.json.template`: there is no `start:web`, so investigation 2's recommendation silently requires a template change it did not cost.

**C2 — the readiness probe.** Investigation 1: `/api/dawn/memory/candidates` → 200. Investigation 2: `/api/copilotkit/info` → 200. Investigation 3: `/api/dawn/threads` → 403. **Investigation 1 is right, and investigation 2's choice is disqualified by investigation 2's own evidence** — `/info` returned 200 with the Dawn server dead, because `HttpAgent` does not implement `getCapabilities`, so `/info` never dials upstream. Investigation 3's 403 probe is safe but proves less. Confirmed by reading `AppShell.tsx:61`: `SERVER_PROBE_PATH = "/api/dawn/memory/candidates"` — the app's own definition of "connected" is exactly the chosen probe.

**C3 — `warmUp`.** Investigation 1 designed a `warmUp` hook; 2 and 3 did not. **Rejected.** The compile it would pay for lands inside W3, an assertion that must run anyway. Nothing in this lane charges a request to a budget tight enough to flake on 8.6s.

**C4 — `assertRecordedServerExit` prefix collision.** Investigation 3 flags it as an active hazard; investigation 2 flags it as a reason to use `<app>/web` as the cwd. **Both overstate it today, and both are right that it must be fixed.** Verified by reading `:806-818`: it uses `lastIndexOf`, and nesting appends the inner (web) block **first**, so the server block is always last and the match lands correctly by accident. That is precisely the latent, green-while-broken shape this harness has a history of. Anchor the match (Task 3) — as trap prevention, not as a bug fix; say so in the commit message so a reviewer does not delete it as unnecessary.

**C5 — helper signature scope.** Investigation 1 proposed `readiness` + `warmUp` + `timeoutMs` + a four-value `script` union. Investigation 2 proposed `readiness` + a `portInjection` option. Investigation 3 proposed a `readyProbe` + widening `script` to arbitrary strings. **Narrowest sufficient version wins:** `readiness` plus a three-value closed union `"dev" | "dev:web" | "start"`. No `timeoutMs` (D3), no `warmUp` (C3), no `portInjection` (with `start:web` out of scope there is exactly one web target, and a closed union keeps the port branch exhaustive).

**C6 — against the background: "a bind-close-rebind window that is fine for one process and racier for two."** Two independent measurements say otherwise (0 collisions in 500 and in 3,000 sequential pairs; 0 in 3,000 concurrent pairs; reuse distance 16,355). The background's caution is not wrong in principle but is not supported by measurement, and nesting shrinks rather than widens the window (D4). No code change.

**C7 — against the background: "`script === "start"` injects `HOST`/`PORT` — a Next process would interpret those differently."** Sharper than that: Next **ignores** them. `PORT=45322 HOST=127.0.0.1 next start -p 3010` binds `*:3010`, and `HOST`/`HOSTNAME` are ignored entirely (wildcard bind). So a hypothetical `script: "start:web"` would boot the web client on hard-coded 3010 — colliding with a developer's own workbench — while the harness polled the allocated port to death. Not a problem in this slice (D1 chooses `dev:web`), but it is why `start:web` must not be added without also fixing the port branch. Recorded in §6.

No other contradictions. All three investigations agree on: nesting over multi-child, `-- --port N` last-flag-wins for Next, module-scope `DAWN_SERVER_URL` read at runtime, `GENERATED_APP_UNSET_ENV` ordering, telemetry env vars, and process-group kill reaping the whole `next dev` tree (5-process group, 0 survivors, 1183ms).

---

## 3. TASKS

### Task 0: Baseline — record the numbers you must not regress

- [ ] **Step 1: Confirm branch and capture green counts.**

```bash
git branch --show-current    # blove/harness-two-process
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && \
  pnpm exec vitest --run --config test/generated/vitest.config.ts test/harness/packaged-app.test.ts
```

Expected: all pass. **Record the file's test count** — every later gate compares against it. Note this config's `globalSetup` boots Verdaccio, so first run is slow; that is normal.

- [ ] **Step 2: Record the activation lane's current wall time.**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && time pnpm exec vitest --run \
  --config test/generated/vitest.config.ts -t "activates the default research scaffold"
```

Expected: pass, ~144s body. Record the number; Task 6 compares against it.

---

### Task 1 (judgment): Give `withPackagedNpmServer` a readiness seam and a web target

**Files:** `test/harness/packaged-app.ts`, `test/harness/packaged-app.test.ts`

- [ ] **Step 1: Add the readiness types and the two implementations**, above `assertPackagedNpmChildRunning` (currently `:458`).

```ts
export type PackagedNpmScript = "dev" | "dev:web" | "start"

export interface PackagedNpmReadiness {
  /** Quoted in every readiness failure, e.g. `GET /healthz -> {"status":"ready"}`. */
  readonly describe: string
  /**
   * One probe attempt. `detail` from the LAST attempt is quoted in the timeout
   * message: with two children, a 502 body naming an unreachable upstream is the
   * difference between a five-minute diagnosis and an hour spent blaming the
   * wrong process.
   */
  readonly probe: (
    baseUrl: string,
    signal: AbortSignal,
  ) => Promise<{ readonly detail?: string; readonly ready: boolean }>
}

export const dawnHealthzReadiness: PackagedNpmReadiness = {
  describe: `GET /healthz -> {"status":"ready"}`,
  async probe(baseUrl, signal) {
    const response = await fetch(new URL("/healthz", baseUrl), { signal })
    const body = (await response.json().catch(() => undefined)) as unknown
    if (
      response.ok &&
      typeof body === "object" &&
      body !== null &&
      Reflect.get(body, "status") === "ready"
    ) {
      return { ready: true }
    }
    return { detail: `HTTP ${response.status} ${JSON.stringify(body) ?? "<unparsed>"}`.slice(0, 300), ready: false }
  },
}

/**
 * Readiness for a child with no `/healthz`. Next compiles route handlers lazily,
 * so a 2xx here means that route's whole module graph compiled — not merely that
 * the port is listening. Readying on stdout or on a TCP connect does NOT fail
 * cleanly when it is wrong: a request issued at Next's own `Ready in` line
 * blocked 20,676ms before answering.
 */
export function httpOkReadiness(path: string): PackagedNpmReadiness {
  return {
    describe: `GET ${path} -> 2xx`,
    async probe(baseUrl, signal) {
      const response = await fetch(new URL(path, baseUrl), { signal })
      if (response.ok) {
        await response.body?.cancel()
        return { ready: true }
      }
      const detail = await response.text().catch(() => "")
      return { detail: `HTTP ${response.status} ${detail}`.slice(0, 300), ready: false }
    },
  }
}
```

- [ ] **Step 2: Rewrite `waitForPackagedNpmReady` (`:485-543`) to take `readiness` + `url` instead of `healthUrl`.** Keep the loop, the deadline, the per-attempt `AbortSignal.timeout(Math.min(1_000, remainingMs))`, the `AbortSignal.any` composition and the child-state checks **verbatim**; replace only the inline fetch/json/status block with `await options.readiness.probe(options.url, attemptSignal)`, track `let lastDetail = "<no probe completed>"` (set it from `attempt.detail` and from `formatError(error)` in the existing catch), and end with:

```ts
  throw new Error(
    withProcessOutput(
      `Timed out waiting for npm run ${options.script} readiness (${options.readiness.describe}) at ${options.url} within ${PACKAGED_NPM_READY_TIMEOUT_MS}ms; last probe: ${lastDetail}`,
      options.readStdout(),
      options.readStderr(),
    ),
  )
```

- [ ] **Step 3: Update `assertPackagedNpmChildRunning` (`:458-483`)** — swap `healthUrl: string` for `readiness: PackagedNpmReadiness` + `url: string`, and change its two messages to `… failed before ${options.readiness.describe} at ${options.url} succeeded: …` / `… exited before ${options.readiness.describe} at ${options.url} succeeded (exit …, signal …)`. **`(exit 23, signal none)` must stay character-for-character intact** — `packaged-app.test.ts:996` asserts `toContain("exit 23, signal none")`. No test asserts the rest of either string (verified by grep for `became healthy`).

- [ ] **Step 4: Widen `script` in all three places (`:462`, `:491`, `:611`)** from `"dev" | "start"` to `PackagedNpmScript`.

- [ ] **Step 5: Add `readiness` to the options object and key the port plumbing on the target.** Replace `:623` (`const healthUrl = …`) and `:626`:

```ts
    readonly readiness?: PackagedNpmReadiness
```

```ts
  const readiness = options.readiness ?? dawnHealthzReadiness
  const args = ["run", options.script, ...(options.scriptArgs ?? [])]
  const npmLaunch = resolveNpmLaunch()
  // Port plumbing is keyed on the TARGET, not on the script string. `next` binds
  // the IPv6 wildcard by default, and `-H 127.0.0.1` is the flag it honours —
  // `HOST`/`HOSTNAME`/`PORT` are all ignored when a `-p` flag is present.
  if (options.script === "dev") args.push("--", "--port", String(port))
  else if (options.script === "dev:web") args.push("--", "--port", String(port), "-H", "127.0.0.1")
```

Leave `:637`'s `options.script === "start" ? { HOST, PORT }` exactly as-is — it is the Dawn server's plumbing and no web target reaches it.

Then update the `waitForPackagedNpmReady` call at `:703` to pass `readiness` and `url` instead of `healthUrl`.

- [ ] **Step 6: Extend the test fixture** in `packaged-app.test.ts` (`createNpmServerFixture`, `:95-142`). Add `"dev:web": "node server.mjs dev:web"` to the fixture's `scripts`, make port/host derive from args for every non-`start` mode, and add a `/ready` branch **before** the 404:

```js
'const port = mode === "start" ? Number(process.env.PORT) : Number(args[args.indexOf("--port") + 1])',
'const host = mode === "start" ? process.env.HOST : (args.includes("-H") ? args[args.indexOf("-H") + 1] : "127.0.0.1")',
'const readyAfter = Number(process.env.FIXTURE_READY_AFTER ?? "0")',
'let readyRequestCount = 0',
// …inside the request handler, before the /healthz check:
'  if (request.url === "/ready") {',
'    readyRequestCount += 1',
'    const ok = readyRequestCount > readyAfter',
'    response.writeHead(ok ? 200 : 503, { "content-type": "application/json" })',
'    response.end(JSON.stringify(ok ? { ok: true } : { error: "fixture not ready yet" }))',
'    return',
'  }',
```

- [ ] **Step 7: Add two tests** to the `withPackagedNpmServer` describe block (`:729`):

1. *"waits for a custom readiness probe on a child with no health endpoint"* — `script: "dev:web"`, `readiness: httpOkReadiness("/ready")`, `env: { FIXTURE_READY_AFTER: "2" }`. Assert the action ran, and read `observed.json` to assert `args` contains `["--port", String(port), "-H", "127.0.0.1"]`, `host === "127.0.0.1"`, and `runtimeEnv` is `{apiKey:"missing", baseUrl:"missing", dockerSandbox:"missing"}`. **That last clause is the sibling to the existing `runGeneratedAppNpmCommand` ambient-strip test (`:507`) that investigation 3 asked for: it proves `GENERATED_APP_UNSET_ENV` protection holds on the web spawn path too, rather than being assumed.**
2. *"names the readiness contract when the child exits first"* — `script: "dev:web"`, `readiness: httpOkReadiness("/ready")`, `env: { FIXTURE_EXIT_CODE: "23" }`; assert the thrown message contains `GET /ready -> 2xx` and `exit 23, signal none`. (Do **not** write a test that lets readiness time out — that burns the full 60s.)

**Gate:**
```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && \
  pnpm exec vitest --run --config test/generated/vitest.config.ts test/harness/packaged-app.test.ts
```
Expected: Task 0 Step 1's count **+2**, all passing. Every pre-existing test must still pass unchanged — they all use the defaulted `readiness`.

---

### Task 2 (judgment): Settle the action before teardown

**Files:** `test/harness/packaged-app.ts`, `test/harness/packaged-app.test.ts`

- [ ] **Step 1: Add the constant** next to `PACKAGED_NPM_READY_TIMEOUT_MS` (`:25`):

```ts
// On abort, `awaitWithAbort` stops WAITING on the action but the action keeps
// unwinding — and a nested `withPackagedNpmServer` call is exactly such an
// action, with a live child process of its own. Measured: the outer settled 29ms
// after abort while the inner child stayed alive another 500-1000ms. Tearing
// down before the action settles loses LIFO order and lets two children append
// to one transcript at once. A real `next dev` group takes ~1.2s to reap, so
// this is ~4x that.
const PACKAGED_NPM_ACTION_SETTLE_MS = 5_000
```

- [ ] **Step 2: Hold the action promise and await it in the `finally`.** At `:713`:

```ts
    options.signal?.throwIfAborted()
    pendingAction = action({ url })
    actionResult = { value: await awaitWithAbort(pendingAction, options.signal) }
```

with `let pendingAction: Promise<T> | undefined` declared beside `actionResult`, and as the **first** statement of the `finally` block (`:717`), before the `terminateSubprocess` branch:

```ts
    if (pendingAction !== undefined) {
      await Promise.race([
        pendingAction.catch(() => undefined),
        delay(PACKAGED_NPM_ACTION_SETTLE_MS),
      ])
    }
```

- [ ] **Step 3: Add a test** — *"settles a nested server before tearing down the outer one"*: two fixtures, outer `script: "start"`, inner `script: "start"` inside the outer's action; abort mid-action; assert (a) the thrown value is the abort reason, (b) **both** children's ports stopped accepting by the time the outer promise settles (reuse `expectServerStopped`), and (c) the transcript contains both `[exit … signal …]` blocks with the **inner block first**.

**Gate:**
```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && \
  pnpm exec vitest --run --config test/generated/vitest.config.ts test/harness/packaged-app.test.ts
```
Expected: Task 0 count **+3**. The pre-existing *"aborts readiness after a real health probe and settles cleanup before rejecting"* test still asserts `< 3_000ms` — it aborts during **readiness**, so `pendingAction` is `undefined` and the new wait is skipped. If that test slows down, you wired the settle into the wrong place.

---

### Task 3 (mechanical): Anchor `assertRecordedServerExit`

**Files:** `test/generated/run-generated-research-activation.test.ts`

- [ ] **Step 1: Replace the prefix match (`:806-818`).**

```ts
function assertRecordedServerExit(
  transcript: string,
  options: { readonly appRoot: string; readonly script: "dev" | "dev:web" | "start" },
): void {
  // `npm run dev` is a PREFIX of `npm run dev:web`, and the two-process dev
  // session records both. `lastIndexOf` on a bare prefix happens to land on the
  // right block today only because nesting appends the inner child FIRST — a
  // green-by-accident that would flip the day the ordering changes. Match the
  // whole command line instead.
  const lines = transcript.split("
")
  const opening = `$ (cd ${options.appRoot} && npm run ${options.script}`
  const commandLineIndex = lines.findLastIndex(
    (line) =>
      line.startsWith(opening) &&
      (line[opening.length] === " " || line[opening.length] === ")"),
  )
  expect(commandLineIndex).toBeGreaterThanOrEqual(0)
  const commandBlock = lines.slice(commandLineIndex).join("
")
  expect(commandBlock).not.toContain("[exit pending")
  expect(commandBlock).not.toContain("[exit unavailable")
  expect(commandBlock).toMatch(/\[exit (?:-?\d+|null) signal (?:[A-Z0-9]+|none)\]/)
}
```

- [ ] **Step 2: Prove the anchor works before it has a second block to disambiguate.** Add a focused unit assertion (or a temporary local check you delete) confirming `assertRecordedServerExit` on a synthetic transcript containing a `dev:web` block *after* a `dev` block still selects the `dev` block. If you skip this, the anchor is untested until Task 6.

**Gate:** `git diff` shows only this function changed; the lane is not run yet.

---

### Task 4 (judgment): Nest the web client and assert the hop

**Files:** `test/generated/run-generated-research-activation.test.ts`

- [ ] **Step 1: Add the web fixtures and constants** next to the existing ones (`:47-56`, `:99-110`).

```ts
const WEB_PROMPT = "Web hop smoke: outline the workbench check."
const WEB_REPLY = "Workbench reached the Dawn server through the CopilotKit runtime."
const WEB_TODOS = [
  { content: "Confirm the web client reaches the Dawn server", status: "completed" },
]
const WEB_GATED_PROMPT = "Web hop gate: run the external fetch script for the workbench check."
const WEB_FETCH_COMMAND = "node scripts/fetch-source.mjs workbench hop"
const WEB_GATED_REPLY = "Fetched external context after approval through the web client."
// CopilotKit's fetch-router matches `agent/<agentId>/run`; `default` is the id
// the runtime route registers and every CopilotKit hook resolves.
const COPILOTKIT_RUN_PATH = "/api/copilotkit/agent/default/run"

function createWebHopFixtures() {
  return [
    ...script().user(WEB_PROMPT).callsTool("writeTodos", { todos: WEB_TODOS }).replies(WEB_REPLY).build(),
    ...script().user(WEB_GATED_PROMPT).callsTool("runBash", { command: WEB_FETCH_COMMAND }).replies(WEB_GATED_REPLY).build(),
  ]
}
```

Register them alongside the others at `:887`: `aimock.addFixtures([...createSafeResearchFixtures(), ...createGatedAndBuiltFixtures(), ...createWebHopFixtures()])`.

**Dedicated prompts are deliberate** — they keep the three existing journeys' aimock accounting untouched and remove any dependence on whether aimock fixtures are consumed or reusable.

- [ ] **Step 2: Give `postAgui` an endpoint override.** Add `readonly endpointPath?: string` to its options (`:363`) and change `:381`:

```ts
  const routeKey = encodeURIComponent("/research#agent")
  const endpoint = new URL(options.endpointPath ?? `/agui/${routeKey}`, options.baseUrl)
```

Nothing else changes: the CopilotKit runtime accepts a plain AG-UI `RunAgentInput` (the same object `postAgui` already builds, `RunAgentInputSchema.parse`d) and answers `text/event-stream` of raw `data: {...}` AG-UI frames, so `parseAgUiSse` works unchanged.

- [ ] **Step 3: Add a web fetch helper** next to `assertReadyHealth`:

```ts
async function fetchWeb(baseUrl: string, path: string, signal: AbortSignal): Promise<Response> {
  // 60s, not 10s: Next compiles route handlers lazily and `/api/copilotkit/*`
  // took 2.4-8.6s on its first hit, worst immediately after a `next build` —
  // which is exactly the sequence this lane runs.
  return await fetch(new URL(path, baseUrl), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  })
}
```

- [ ] **Step 4: Add three assertion functions** (`assertWebHopJourney`, `assertWebGatedInterrupt`, `assertWebResumedJourney`) next to the existing journey assertions.

```ts
function assertWebHopJourney(events: readonly AgUiEvent[]): void {
  expect(events.filter((event) => event.type === "RUN_ERROR")).toEqual([])
  const finished = events.filter((event) => event.type === "RUN_FINISHED")
  expect(finished).toHaveLength(1)
  expect(finished[0]?.outcome).toEqual({ type: "success" })
  expect(events.at(-1)).toEqual(finished[0])
  expect(reconstructAssistantText(events)).toBe(WEB_REPLY)
  // Dawn's activity projection survives a third-party runtime that re-validates
  // and re-encodes every frame. CONTENT equality, not mere presence: a runtime
  // that dropped `content` would still emit the event.
  const activities = events.filter((event) => event.type === "ACTIVITY_SNAPSHOT")
  expect(activities).toHaveLength(1)
  expect(activities[0]).toMatchObject({
    activityType: "dawn.plan",
    content: { todos: WEB_TODOS },
    replace: true,
  })
  // Not the exact `dawn:plan:<runId>`: id echo through CopilotKit is a property
  // of a third-party runtime. W4's thread-state read proves id round-trip.
  expect(String(activities[0]?.messageId)).toMatch(/^dawn:plan:/)
  expect(
    events.filter((event) => event.type === "TOOL_CALL_START").map((event) => event.toolCallName),
  ).not.toContain("writeTodos")
}
```

`assertWebGatedInterrupt` mirrors `assertGatedResearchInterrupt` (`:636`) minus the run/thread id equality: one `RUN_FINISHED` with `outcome.type === "interrupt"`, exactly one interrupt whose `metadata` matches `{ type: "permission-request", kind: "command", detail: { command: WEB_FETCH_COMMAND } }`, exactly one `runBash` `TOOL_CALL_START` (return its `toolCallId` and the `interruptId`), no `TOOL_CALL_RESULT`, no `TEXT_MESSAGE_CONTENT`, and `expectNoActivitySnapshots`.

`assertWebResumedJourney(events, gatedToolCallId)`: success terminal (no id equality), one `runBash` start whose `toolCallId` **equals** `gatedToolCallId`, a `TOOL_CALL_RESULT` correlated to it, and `reconstructAssistantText(events) === WEB_GATED_REPLY`. Do **not** re-assert the ToolMessage envelope shape — `assertResumedGatedJourney` already pins that against the server directly; this one asserts the hop.

- [ ] **Step 5: Declare the web ids** beside the existing id block (`:1094-1103`) — `webThreadId`, `webRunId`, `webMessageId`, `webGatedThreadId`, `webGatedRunId`, `webGatedMessageId`, `webResumeRunId`, all `` `web-…-${randomUUID()}` `` — plus `let webClientUrl: string | undefined`.

- [ ] **Step 6: Nest the web session inside the dev session's action**, immediately after `assertResumedGatedJourney(...)` and before `return { interruptId }` (`:1157`). Change that return to `return { interruptId, ...webResult }`.

```ts
        // The generated web client, against the SAME Dawn server. Nested rather
        // than sequential: the server is already BOUND when the web child
        // allocates its port, and LIFO teardown kills the web half first.
        const webResult = await withPackagedNpmServer(
          {
            appRoot,
            env: {
              DAWN_SERVER_URL: url,
              // The CopilotKit runtime otherwise prints "anonymous telemetry
              // enabled" and makes an outbound call, in a lane whose whole claim
              // is that a generated app inherits no ambient endpoints or
              // credentials.
              COPILOTKIT_TELEMETRY_DISABLED: "true",
              DO_NOT_TRACK: "1",
            },
            // No `/healthz` on Next, and no readying on stdout: Next prints
            // `Ready in Xms` 12-29s before it can serve, and a request issued at
            // that line blocked 20.7s. A 2xx on the proxy route means the route
            // compiled AND reached a Dawn server — it is also the exact path
            // AppShell.tsx probes (`SERVER_PROBE_PATH`).
            readiness: httpOkReadiness("/api/dawn/memory/candidates"),
            script: "dev:web",
            signal: lifecycleSignal,
            transcriptPath: commandsTranscriptPath,
          },
          async ({ url: webUrl }) => {
            webClientUrl = webUrl
            agUiRecorder.registerServerUrl(webUrl)
            expect(new URL(webUrl).port).not.toBe(new URL(url).port)

            const webIdleJournalStart = activeAimock.getRequests().length

            // W1 — the allowlist denies by default in a real Next process.
            const denied = await fetchWeb(webUrl, "/api/dawn/threads", lifecycleSignal)
            expect(denied.status).toBe(403)
            await expect(denied.json()).resolves.toEqual({ error: "Not proxied" })

            // W2 — the proxy reached THIS server. A mis-wired DAWN_SERVER_URL
            // cannot pass: only this server has a checkpoint for the thread the
            // safe journey just drove. 403 (refused) and 404 (no checkpoint)
            // stay distinguishable, which is the distinction route.ts argues for.
            const state = await fetchWeb(
              webUrl,
              `/api/dawn/threads/${encodeURIComponent(safeThreadId)}/state`,
              lifecycleSignal,
            )
            expect(state.status).toBe(200)
            const threadState = (await state.json()) as {
              readonly config?: unknown
              readonly values?: unknown
            }
            expect(JSON.stringify(threadState.config)).toContain(safeThreadId)
            expect(JSON.stringify(threadState.values)).toContain("[corpus/agent-architectures.md]")
            const absent = await fetchWeb(
              webUrl,
              `/api/dawn/threads/${encodeURIComponent(`absent-${randomUUID()}`)}/state`,
              lifecycleSignal,
            )
            expect(absent.status).toBe(404)

            // W3 — the CopilotKit runtime is mounted at the basePath the client
            // uses, under the agent id every hook resolves. `className` is
            // MINIFIED and varies across builds — never assert on it.
            const info = await fetchWeb(webUrl, "/api/copilotkit/info", lifecycleSignal)
            expect(info.status).toBe(200)
            const infoBody = (await info.json()) as {
              readonly agents?: Record<string, unknown>
              readonly mode?: unknown
              readonly telemetryDisabled?: unknown
            }
            expect(Object.keys(infoBody.agents ?? {})).toContain("default")
            expect(infoBody.mode).toBe("sse")
            expect(infoBody.telemetryDisabled).toBe(true)

            // W6 — the web tier's ONLY path to a model is through Dawn, and only
            // for an actual run. Nothing above may move the journal.
            expect(activeAimock.getRequests()).toHaveLength(webIdleJournalStart)

            // W4 — Next route -> CopilotRuntime -> HttpAgent -> Dawn /agui ->
            // LangGraph -> aimock, and back.
            const webJournalStart = activeAimock.getRequests().length
            const webJourney = await postAgui({
              baseUrl: webUrl,
              endpointPath: COPILOTKIT_RUN_PATH,
              messages: [{ id: webMessageId, role: "user", content: WEB_PROMPT }],
              recorder: agUiRecorder,
              runId: webRunId,
              signal: lifecycleSignal,
              threadId: webThreadId,
            })
            expect(webJourney.status).toBe(200)
            expect(activeAimock.getRequests()).toHaveLength(webJournalStart + 2)
            assertWebHopJourney(webJourney.events)
            // Our thread id survived the hop into Dawn's checkpointer.
            const webState = await fetchWeb(
              webUrl,
              `/api/dawn/threads/${encodeURIComponent(webThreadId)}/state`,
              lifecycleSignal,
            )
            expect(webState.status).toBe(200)

            // W5 — the interrupt outcome and the resume envelope survive the hop.
            const webGatedJournalStart = activeAimock.getRequests().length
            const webGated = await postAgui({
              baseUrl: webUrl,
              endpointPath: COPILOTKIT_RUN_PATH,
              messages: [{ id: webGatedMessageId, role: "user", content: WEB_GATED_PROMPT }],
              recorder: agUiRecorder,
              runId: webGatedRunId,
              signal: lifecycleSignal,
              threadId: webGatedThreadId,
            })
            expect(webGated.status).toBe(200)
            expect(activeAimock.getRequests()).toHaveLength(webGatedJournalStart + 1)
            const webInterrupt = assertWebGatedInterrupt(webGated.events)

            const webResumeJournalStart = activeAimock.getRequests().length
            const webResumed = await postAgui({
              baseUrl: webUrl,
              endpointPath: COPILOTKIT_RUN_PATH,
              messages: [],
              recorder: agUiRecorder,
              resumeFields: {
                resume: [
                  { interruptId: webInterrupt.interruptId, status: "resolved", payload: "once" },
                ],
              },
              runId: webResumeRunId,
              signal: lifecycleSignal,
              threadId: webGatedThreadId,
            })
            expect(webResumed.status).toBe(200)
            expect(activeAimock.getRequests()).toHaveLength(webResumeJournalStart + 1)
            assertWebResumedJourney(webResumed.events, webInterrupt.gatedToolCallId)

            return { webInterruptId: webInterrupt.interruptId }
          },
        )
```

Add `if (webClientUrl === undefined) throw new Error("Generated web client did not start")` after the dev session returns.

**The `+2` on W4 is the one constant you must confirm, not trust.** One tool turn plus one text turn is two model calls, matching the existing accounting (`.user().replies()` → `+1`; the gated interrupt stops after turn one → `+1`). If the first run disagrees, read `getRequests()` and correct the constant — do not loosen the assertion to `toBeGreaterThan`.

**Gate:** `pnpm exec vitest --run --config test/generated/vitest.config.ts -t "activates the default research scaffold"` — expected pass. If readiness times out, the message now quotes the last probe body; a 502 naming `http://127.0.0.1:3002` means `DAWN_SERVER_URL` did not reach the child.

---

### Task 5 (mechanical): Close the transcript and sanitizer gaps

**Files:** `test/generated/run-generated-research-activation.test.ts`

- [ ] **Step 1: Assert the web child died and no secret leaked.** After `assertRecordedServerExit(transcriptAfterDev, { appRoot, script: "dev" })` (`:1164`):

```ts
    assertRecordedServerExit(transcriptAfterDev, { appRoot, script: "dev:web" })
    // The second child inherits the same ambient-credential protection. Nothing
    // asserted this before there was a second child to get it wrong.
    expect(transcriptAfterDev).not.toContain("ambient-secret")
```

- [ ] **Step 2: Extend the AG-UI sanitizer assertions (`:1240-1252`).** The web URL registers second, so it takes `<server-url-2>` and the built server takes `<server-url-3>`:

```ts
    expect(sanitizedAgUiTranscript).toContain("<server-url-2>")
    if (builtServerUrl !== devServerUrl && builtServerUrl !== webClientUrl) {
      expect(sanitizedAgUiTranscript).toContain("<server-url-3>")
    }
```

Add to the `not.toContain` sweep list: `webClientUrl`, `webThreadId`, `webRunId`, `webMessageId`, `webGatedThreadId`, `webGatedRunId`, `webGatedMessageId`, `webResumeRunId`, `devResult.webInterruptId`.

- [ ] **Step 3: Update the measured-times comment (`:25-33`)** with the numbers Task 6 produces. Leave `ACTIVATION_TIMEOUT_MS`, `ACTIVATION_CLEANUP_RESERVE_MS`, `PACKAGED_COMMAND_TIMEOUT_MS` and `PACKAGED_NPM_READY_TIMEOUT_MS` **unchanged** — the added cost is ~6–15s on a 144s body, and D3 explains why the ready budget still has 6x headroom at CI's 2–4x.

**Gate:** re-run the lane; expected pass.

---

### Task 6 (judgment): Full-lane verification and honest timing

- [ ] **Step 1: Run the real gate.**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm verify:harness:framework
```

The wrapper swallows assertion output — real failures live in `artifacts/testing/harness-*/framework/transcript.log` and `vitest-report.json`.

- [ ] **Step 2: Confirm no leaked children.** Immediately after the run:

```bash
ps -eo pid,ppid,pgid,command | grep -E "next (dev|start)|next-server" | grep -v grep
```
Expected: no rows referencing a path under the lane's temp root. Other agents' `next dev` trees may exist on a shared box — check the cwd before concluding anything, and do not kill them.

- [ ] **Step 3: Read the commands transcript by hand once.** In the preserved (or artifact) `commands.log`, confirm the dev session's blocks appear in **inner-first** order — `npm run dev:web …` then `npm run dev …` — each ending in `[exit <code> signal <sig>]`. This is the only human check that the settle fix (Task 2) actually ordered teardown; the assertions alone would pass on interleaved output.

- [ ] **Step 4: Record measured times** for Task 5 Step 3: web boot+readiness, first `/api/copilotkit/info`, the three hop runs, web teardown, and the new whole-body wall time.

- [ ] **Step 5: Full validate.**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH && pnpm ci:validate
```

---

## 4. TRAPS — ranked by how quietly they stay green

**T1 — A stray Dawn server on port 3002 makes a completely unwired proxy look correct.** If `DAWN_SERVER_URL` never reaches the web child, the handlers fall back to `http://127.0.0.1:3002`. On a clean CI box nothing listens there, so readiness 502s and fails loudly. **On a developer's machine running their own workbench, readiness returns 200 from the wrong server, and W1 and W3 also pass.** W2 — `/threads/<safeThreadId>/state` → 200 — is the only assertion that distinguishes "reached a Dawn server" from "reached THIS one". Do not weaken it, do not make it conditional, and do not replace the 200 with a "not 502" check.

**T2 — `+2` on the W4 aimock delta is the only assertion that proves the run reached a model at all.** If you soften it to `toBeGreaterThanOrEqual` because the first run disagreed, W4 degrades into "CopilotKit returned some SSE" and the whole hop claim goes dark. Correct the constant instead.

**T3 — `assertRecordedServerExit`'s bare prefix is green by accident.** `$ (cd <appRoot> && npm run dev` is a prefix of the `dev:web` line too. It lands on the right block today only because nesting appends the inner child first. Task 3 anchors it; a reviewer will read the anchor as unnecessary churn, so the comment and the commit message must say *why*. Without Task 3 Step 2, the anchor itself is untested until the full lane runs.

**T4 — Readying on Next's stdout or on a TCP connect does not fail, it hangs.** `Ready in 455ms` printed for a build whose `/` then served 500 for a full 180s. A request issued at the `Ready in` line blocked 20,676ms. If anyone "optimizes" readiness later by watching stdout, the symptom will be a ~20s stall in a random assertion, nowhere near the cause.

**T5 — `script: "start:web"` is a live footgun the moment someone adds it.** Next ignores `PORT` and `HOST` when `-p` is present: `PORT=45322 next start -p 3010` binds `*:3010`. The `:637` env branch would boot the web client on the developer's own port while the harness polled the allocated one to death, reporting only "timed out waiting for readiness". The `script` union is deliberately closed to three verified values — keep it closed.

**T6 — The abort path leaks a `next` process group, not just a fetch.** Without Task 2, the lane's `ACTIVATION_TIMEOUT_MS - 30_000` deadline can return with a live web child and two concurrent `appendFile`s to one transcript. It will not fail the run; it will corrupt the artifact and orphan a process. Ship Task 2 with the second child, not after.

**T7 — Never request `/` from the dev-mode web child.** 15–36s cold (35.9s measured), and a prior `next build` does **not** warm the Turbopack dev compile — re-measured with a full production `.next` present, `/` still took 16.7s and `/api/copilotkit/[...path]` still logged a cold compile at 8.6s.

**T8 — `info.agents.default.className` is minified** (`Fe`, `xe`, `nm` across builds). Asserting `"HttpAgent"` reds on an unrelated dependency bump.

**T9 — `telemetryDisabled === true` proves the LANE's hermeticity, not the template's.** The harness sets the env var. It is the right call for CI, but do not read a green W3 as evidence that a freshly scaffolded app does not phone home on `npm run dev:web` — it does. See §6.

**T10 — Next 16 refuses a second `next dev` from the same project directory** ("Another next dev server is already running", PID-liveness based). Every lane run scaffolds a fresh temp dir, so this cannot bite today — but a leaked child breaks the *next* run in that directory, not the current one, so the failure appears unrelated to whatever caused it.

**T11 — `next dev` releases its port ~1183ms after SIGTERM.** `terminateSubprocess`'s stop oracle is "port stopped accepting", and `graceMs` is 2s. Under CI contention it can escalate to SIGKILL — still correct. A `subprocess group … did not stop within 4000ms` error is the grace window, not a leak.

**T12 — Two servers double the ways one failure masks another.** With nesting, an inner start failure surfaces the *inner's* message and the outer's stdout only reaches the transcript. The readiness message now names the script (`npm run dev:web`) and the probe; keep it that way or a web failure will read as a Dawn-server failure.

---

## 5. OUT OF SCOPE — the SP4 boundary

**The rule: if an assertion needs a browser to have parsed the page, it is SP4.** This lane asserts only over `fetch()`.

Explicitly excluded: the workbench shell rendering its rail/composer/transcript; `ConnectScreen` appearing; plan, subagent or tool cards rendering; memory approve/reject buttons; the permission prompt UI; thread selection and `localStorage`; `defaultThrottleMs`; `useSingleEndpoint={false}`; `enableInspector={false}` not fetching `cdn.copilotkit.ai`; incremental streaming into the transcript; any click. `examples/research/web/e2e/copilotkit-v2.spec.ts` already covers several of these against the example.

Also out of scope, deliberately:

- **Re-proving the three existing AG-UI journeys through the web client.** W4/W5 use their own small fixtures precisely so they assert the **hop**, not the agent.
- **Re-proving anything the generated app's own `npm test` already runs in this lane** — proxy allowlist forward/reject, the 502 body, header passthrough, `ConnectScreen`-on-502, hydrate, transcript, thread-source, MemoryPanel.
- **A `next start` web boot, a root `start:web` script, and any template edit.** See §6.
- **The ConnectScreen 502 over real HTTP.** Reachable without a browser, but `route.test.ts` and `AppShell.test.tsx` already assert both halves inside this lane; buying the marginal "a real undici ECONNREFUSED yields 502, not 500 or a hang" would require ordering web-outer/server-inner. Not worth restructuring for.
- **Any change to `allocatePort`, `GENERATED_APP_UNSET_ENV`, the sentinel sweep, or the timeout budgets.**

---

## 6. STILL OPEN

**S1 — The generated app has no root command to start its built web half.** The root manifest ships `dev`, `dev:server`, `dev:web` and `start` (server only). A user who runs `npm run build` cannot start the web client from the root. This is a plausible template defect, not a harness one. *Settled by:* a product call from Brian. If a `start:web` lands, it must ship with T5's port-plumbing fix (`start:web` → `-- --port N -H 127.0.0.1`, never the `HOST`/`PORT` env branch), a `rootManifest.scripts` `toEqual` update at `:1063`, and — only then — the ~1.5s built-web session (`/` → 200 with the layout title, `/api/dawn/memory/candidates` → 200, one hop run).

**S2 — A freshly scaffolded app phones home on `npm run dev:web`.** The CopilotKit runtime prints "anonymous telemetry enabled" and captures unless `COPILOTKIT_TELEMETRY_DISABLED`/`DO_NOT_TRACK` are set; `examples/research/web/playwright.config.ts` already sets both, and this plan sets them on the harness child. The template itself does not. *Settled by:* a product decision on whether the scaffold should default them off — raise it as its own issue rather than letting a green W3 bury it.

**S3 — Whether the FULL real subagent `ACTIVITY_SNAPSHOT` sequence survives the CopilotKit hop.** W4 proves one snapshot survives with `content` intact, against a real Dawn server. The 7-snapshot subagent sequence has only ever been proven **direct**, and the hop evidence for it came from probes against a stub server. *Settled by:* if you want it, add `.callsTool("task", …)` to the W4 fixture and deep-equal the full sequence — but only after the first green run, and note it roughly doubles W4's aimock delta.

**S4 — Exact aimock turn counts for the new fixtures.** `+2` (W4), `+1` (W5 gate), `+1` (W5 resume) are reasoned from the existing journeys' accounting, not measured. *Settled by:* reading `getRequests()` on the first run (T2).

**S5 — CI runner timings.** Every measurement in this plan is macOS, node 24.19.0, on a machine running concurrent agents (load avg 12–20 during some runs), against pnpm-linked deps in `examples/research` rather than the generated app's hoisted npm workspace. The 2–4x cold-runner rule the test's own comment establishes still leaves 6x headroom on the 60s ready budget. *Settled by:* one CI run logging the web child's ready-wait duration.

**S6 — `next dev` recompiling mid-session.** The lane writes files during the run (the `checkSentinel` round-trip, `server/.env`). None land under `web/`, so Turbopack should never invalidate — but this was reasoned, not tested. *Settled by:* if a hop assertion ever stalls unexpectedly, grep the lane for writes under the web root before suspecting anything else.

**S7 — Windows.** `terminateSubprocess` takes the `taskkill /T /F` branch there; all reaping evidence is macOS. Pre-existing gap for every lane, not new here.