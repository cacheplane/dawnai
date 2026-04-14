import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const generatedSmokeTests = [
  "test/generated/cli-testing-export.test.ts",
  "test/generated/run-generated-app.test.ts",
  "test/generated/run-generated-runtime-contract.test.ts",
]
const result = spawnSync(
  "pnpm",
  ["exec", "vitest", "--run", "--config", "test/generated/vitest.config.ts", ...generatedSmokeTests],
  {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
  },
)

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

console.log("Publish smoke passed.")
