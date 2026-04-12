import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(rootDir, "..")
const forwardedArgs = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"))
const command = [
  "pnpm",
  ["exec", "vitest", "--run", "--config", "vitest.workspace.ts", ...forwardedArgs],
]

const result = spawnSync(command[0], command[1], {
  cwd: repoRoot,
  shell: process.platform === "win32",
  stdio: "inherit",
})

if (result.error) {
  throw result.error
}

if (result.signal) {
  process.kill(process.pid, result.signal)
} else {
  process.exit(result.status ?? 1)
}
