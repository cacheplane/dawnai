import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"

const fallbackExitMs = Number(process.argv[2])
const readyPath = process.argv[3]
const descendantMode = process.argv[4] ?? "default"
const descendantSource = `
  const fallbackExitMs = Number(process.argv[1])
  const mode = process.argv[2]
  if (mode === "ignore-term") process.on("SIGTERM", () => {})
  process.stdout.write("ready\\n")
  setTimeout(() => process.exit(0), fallbackExitMs)
  setInterval(() => {}, 1_000)
`
const descendant = spawn(
  process.execPath,
  ["--input-type=module", "--eval", descendantSource, String(fallbackExitMs), descendantMode],
  { stdio: ["ignore", "pipe", "ignore"] },
)

if (descendant.pid === undefined) {
  throw new Error("hanging fixture descendant has no process id")
}

await new Promise((resolvePromise, rejectPromise) => {
  descendant.once("error", rejectPromise)
  descendant.stdout.once("data", () => resolvePromise())
})

const topology = { descendantPid: descendant.pid, leaderPid: process.pid }
if (readyPath !== undefined) await writeFile(readyPath, `${JSON.stringify(topology)}\n`, "utf8")
process.stdout.write(`${JSON.stringify(topology)}\n`)
setTimeout(() => process.exit(0), fallbackExitMs)
setInterval(() => {}, 1_000)
