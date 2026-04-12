import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const result = spawnSync(
  "pnpm",
  ["exec", "vitest", "--run", "--config", "test/generated/vitest.config.ts"],
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
