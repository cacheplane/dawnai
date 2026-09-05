import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import YAML from "yaml"

test("disposable topology preserves every production job dependency and condition", async () => {
  const production = YAML.parse(
    await readFile(".github/workflows/release-postpublication.yml", "utf8"),
  )
  const fixture = YAML.parse(
    await readFile("scripts/release/test/fixtures/recovery-topology-workflow.yml", "utf8"),
  )
  assert.deepEqual(Object.keys(fixture.jobs), Object.keys(production.jobs))
  assert.equal(Object.keys(fixture.jobs).length, 13)
  for (const [id, job] of Object.entries(production.jobs)) {
    for (const field of ["name", "needs", "if", "outputs"])
      assert.deepEqual(fixture.jobs[id][field], job[field], `${id} ${field}`)
    assert.deepEqual(
      fixture.jobs[id].permissions,
      id === "recovery-publish" ? { contents: "write", actions: "read" } : {},
    )
    assert.equal(
      fixture.jobs[id].steps.filter(
        (s) => s.name === "Harmless replacement for production commands",
      ).length,
      1,
    )
  }
  const publish = fixture.jobs["recovery-publish"].steps.find(
    (s) => s.name === "Exercise actual workflow publication credential",
  )
  assert.equal(publish.if, "inputs.publish_contract")
  assert.equal(publish.env.DAWN_RECOVERY_PUBLICATION_TOKEN, `\${{ github.token }}`)
  assert.equal(
    publish.env.DAWN_RECOVERY_TEST_POLICY_TOKEN,
    `\${{ secrets.RECOVERY_POLICY_READ_TOKEN }}`,
  )
  assert.equal(
    publish.env.DAWN_RECOVERY_AUTHORIZED_REPOSITORY,
    `\${{ vars.RECOVERY_AUTHORIZED_REPOSITORY }}`,
  )
  assert.equal(
    publish.run,
    "node --test scripts/release/test/recovery-publication-github.integration.mjs",
  )
  assert.equal(fixture.on.workflow_dispatch.inputs.publish_contract.default, false)
  assert.deepEqual(fixture.permissions, {})
})
