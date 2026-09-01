import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const rootDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(rootDir, "..")
export function runTests({ args = process.argv.slice(2), spawnSyncImpl = spawnSync } = {}) {
  const forwardedArgs = args.filter((arg, index) => !(index === 0 && arg === "--"))
  const commands = [
    ["pnpm", ["exec", "vitest", "--run", "--config", "vitest.workspace.ts", ...forwardedArgs]],
    ...(forwardedArgs.length === 0
      ? [
          ["pnpm", ["test:test-runner"]],
          ["pnpm", ["test:brand-demo"]],
        ]
      : []),
  ]
  let firstFailure
  for (const [command, commandArgs] of commands) {
    const result = spawnSyncImpl(command, commandArgs, {
      cwd: repoRoot,
      shell: process.platform === "win32",
      stdio: "inherit",
    })
    if (result.error) throw result.error
    if (result.signal) return result
    if ((result.status ?? 1) !== 0 && firstFailure === undefined) {
      firstFailure = result
    }
  }
  return firstFailure ?? { status: 0, signal: null }
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  )
}

if (isMainModule()) {
  const result = runTests()
  if (result.signal) process.kill(process.pid, result.signal)
  else process.exit(result.status ?? 1)
}
