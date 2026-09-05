import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"
import { readBoundedFixture } from "../fixture-io.mjs"

const ROOT = fileURLToPath(new URL("../../..", import.meta.url))

// Early byte checks complement the full suite's reachability and manifest checks.
test("every recorded release content pin matches its source before a build", async () => {
  const pins = JSON.parse(
    await readBoundedFixture(
      path.join(ROOT, "scripts/release/test/fixtures/release-script-hashes.json"),
      { root: ROOT },
    ),
  )
  assert.equal(pins.schemaVersion, 1)
  assert.ok(Object.keys(pins.scripts).length > 0)
  for (const [file, { sha256 }] of Object.entries(pins.scripts)) {
    assert.match(sha256, /^[a-f0-9]{64}$/u)
    const source = await readBoundedFixture(path.join(ROOT, file), {
      root: ROOT,
      maxBytes: 1024 * 1024,
    })
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      sha256,
      `Release content pin mismatch: ${file}`,
    )
  }
})

test("release integrity preflight fails early without replacing full validation", async () => {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"))
  assert.equal(
    packageJson.scripts["test:release-integrity"],
    "node --test scripts/release/test/release-integrity.test.mjs scripts/release/test/recovery-policy.test.mjs",
  )
  const commands = packageJson.scripts["ci:validate"].split(" && ")
  assert.equal(commands[0], "pnpm test:release-integrity")
  assert.ok(commands.includes("pnpm test:release-controller"))

  const workflow = parse(
    await readBoundedFixture(path.join(ROOT, ".github/workflows/ci.yml"), { root: ROOT }),
  )
  const steps = workflow.jobs["source-validate"].steps
  const index = steps.findIndex((step) => step.run === "pnpm test:release-integrity")
  assert.ok(index >= 0, "validate must run the release integrity preflight")
  assert.equal(steps[index].if, undefined, "preflight must run unconditionally")
  assert.equal(steps[index]["continue-on-error"], undefined, "preflight must block on failure")
  const installIndex = steps.findIndex((step) => step.run === "pnpm install --frozen-lockfile")
  assert.ok(installIndex >= 0 && installIndex < index)
  for (const command of [
    "pnpm lint",
    "pnpm check:build-cache",
    "pnpm build",
    "pnpm typecheck",
    "pnpm test",
    "pnpm check:release-inventory",
    "node scripts/check-docs.mjs",
  ]) {
    assert.ok(
      steps.findIndex((step) => step.run === command) > index,
      `${command} must follow preflight`,
    )
    assert.ok(commands.includes(command), `${command} must remain in local validation`)
  }
})

test("required validate aggregates independent complete lanes and fails closed", async () => {
  const workflow = parse(
    await readBoundedFixture(path.join(ROOT, ".github/workflows/ci.yml"), { root: ROOT }),
  )
  const required = ["source-validate", "release-controller", "pack-smoke", "harness-verify"]
  const gate = workflow.jobs.validate
  assert.deepEqual(gate.needs, required)
  assert.equal(gate.if, "always()")
  assert.equal(gate["continue-on-error"], undefined)
  assert.equal(gate.steps.length, 1)
  const step = gate.steps[0]
  assert.equal(step.if, undefined)
  assert.equal(step["continue-on-error"], undefined)
  assert.equal(typeof step.run, "string")
  const bindings = Object.fromEntries(
    required.map((name, index) => [`LANE_${index}`, `\${{ needs.${name}.result }}`]),
  )
  assert.deepEqual(step.env, bindings)
  const success = Object.fromEntries(Object.keys(bindings).map((key) => [key, "success"]))
  const execute = (values) =>
    spawnSync("/bin/sh", ["-c", step.run], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...values },
      timeout: 5000,
    })
  assert.equal(execute(success).status, 0)
  for (const key of Object.keys(bindings)) {
    for (const result of ["failure", "cancelled", "skipped", "", "unknown"]) {
      const actual = execute({ ...success, [key]: result })
      assert.equal(actual.status, 1, `${key}=${result} must fail the required gate`)
    }
  }
  for (const name of required) {
    const job = workflow.jobs[name]
    assert.ok(job, `${name} must exist`)
    assert.equal(job.if, undefined)
    assert.equal(job.needs, undefined, `${name} must be independent`)
    assert.equal(job["continue-on-error"], undefined)
    const checkout = job.steps.find((item) => item.name === "Checkout")
    assert.equal(checkout.with.ref, undefined, "all lanes use the run's default checkout ref")
  }
  const source = workflow.jobs["source-validate"].steps
  assert.equal(
    source.some((item) => item.run === "pnpm test:release-controller"),
    false,
  )
  const controller = workflow.jobs["release-controller"].steps
  const commands = controller.filter((item) => typeof item.run === "string").map((item) => item.run)
  assert.deepEqual(commands, [
    "pnpm install --frozen-lockfile",
    "pnpm test:release-integrity",
    "pnpm test:release-controller",
  ])
  for (const item of controller) {
    assert.equal(item.if, undefined)
    assert.equal(item["continue-on-error"], undefined)
  }
})
