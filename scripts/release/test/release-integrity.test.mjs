import assert from "node:assert/strict"
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
  const steps = workflow.jobs.validate.steps
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
    "pnpm test:release-controller",
    "node scripts/check-docs.mjs",
  ]) {
    assert.ok(
      steps.findIndex((step) => step.run === command) > index,
      `${command} must follow preflight`,
    )
    assert.ok(commands.includes(command), `${command} must remain in local validation`)
  }
})
