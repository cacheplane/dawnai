import assert from "node:assert/strict"
import test from "node:test"

import { runTests } from "./test.mjs"

test("full test runs preserve Vitest first and always invoke focused Node safety lanes", () => {
  const calls = []
  const statuses = [3, 0, 0]
  const result = runTests({
    args: [],
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options })
      return { status: statuses.shift(), signal: null }
    },
  })

  assert.deepEqual(
    calls.map(({ command, args }) => [command, args]),
    [
      ["pnpm", ["exec", "vitest", "--run", "--config", "vitest.workspace.ts"]],
      ["pnpm", ["test:test-runner"]],
      ["pnpm", ["test:brand-demo"]],
    ],
  )
  assert.equal(result.status, 3)
})

test("filtered test runs forward arguments and do not add full-run safety lanes", () => {
  const calls = []
  const result = runTests({
    args: ["--", "packages/sdk/test/example.test.ts", "--reporter=verbose"],
    spawnSyncImpl(command, args) {
      calls.push([command, args])
      return { status: 0, signal: null }
    },
  })

  assert.deepEqual(calls, [
    [
      "pnpm",
      [
        "exec",
        "vitest",
        "--run",
        "--config",
        "vitest.workspace.ts",
        "packages/sdk/test/example.test.ts",
        "--reporter=verbose",
      ],
    ],
  ])
  assert.equal(result.status, 0)
})
