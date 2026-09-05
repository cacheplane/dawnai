import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("enabled strict runner check cannot pass by skipping on an ineligible host", () => {
  const env = { ...process.env, DAWN_TEST_RECOVERY_RUNNER: "1", ImageOS: "ineligible-test-fixture" }
  // Start an independent CLI test run, not another child of this test runner.
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(
    process.execPath,
    ["--test", "scripts/release/test/recovery-strict-runner.integration.mjs"],
    {
      env,
      encoding: "utf8",
      timeout: 15000,
    },
  )
  assert.equal(result.error, undefined)
  assert.notEqual(result.status, 0, "an opted-in check must fail rather than silently skip")
  assert.match(result.stdout + result.stderr, /actual Linux ubuntu24 systemd runner/)
})
