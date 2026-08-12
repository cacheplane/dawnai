import { defineConfig } from "@playwright/test"

const port = process.env.INSPECTOR_E2E_PORT ?? "3919"

export default defineConfig({
  testDir: "./e2e",
  // One worker, always: every spec drives the SAME seeded store and several of them
  // mutate it. Parallel workers would make scenario 9 (concurrent write) delete a row
  // scenario 5 is counting.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // 0 on CI too, deliberately — a retry here would report a FALSE failure, not paper over
  // a real one. The fixture is seeded exactly once, by `serve.ts` at webServer start, and
  // Playwright does not restart the webServer between retries; no spec re-seeds. So a
  // retry re-runs a mutating spec against the store that spec already mutated. Concretely:
  // 09-concurrent-write asserts `total == BROWSE_SEED_COUNT` at its top, then forgets a
  // row, then asserts `BROWSE_SEED_COUNT - 1`. A failure after the forget would retry into
  // the first assertion against a store now holding one row fewer — failing at a different
  // line, for a reason that is an artifact of the retry. That trades one honest red for a
  // misleading one.
  //
  // The cost is understood: these specs carry ~19 s of wall-clock sampling tuned on an
  // M1 Max and have never run on a 2-vCPU runner. `trace: "retain-on-failure"` below is
  // what pays for that instead — the first red ships a trace and gets diagnosed. If this
  // lane proves flaky on CI hardware, the fix is a per-spec fixture reset (or dynamic
  // count expectations), not a retry budget.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Pinned because the page FORMATS: the status bar renders its counts through
    // `toLocaleString` and the grid renders `updatedAt` through the browser's zone, so
    // an unpinned runner asserts against whichever machine it happened to run on.
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node e2e/serve.ts`,
    url: `http://127.0.0.1:${port}/healthz`,
    // Opt-in rather than "anywhere but CI". Reusing a server skips `serve.ts` entirely,
    // and `serve.ts` is the only thing that wipes and re-seeds the store — so a reused
    // server hands the suite whatever the previous run's mutating scenarios left behind,
    // and the run passes over a fixture nobody described. Set this only to iterate on a
    // spec that does not mutate.
    reuseExistingServer: process.env.INSPECTOR_E2E_REUSE_SERVER === "1",
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
})
