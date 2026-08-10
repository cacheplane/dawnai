import { spawn } from "node:child_process"

const fallbackExitMs = Number(process.argv[2])
const descendantSource = `
  const fallbackExitMs = Number(process.argv[1])
  setTimeout(() => process.exit(0), fallbackExitMs)
  setInterval(() => {}, 1_000)
`
const descendant = spawn(
  process.execPath,
  ["--input-type=module", "--eval", descendantSource, String(fallbackExitMs)],
  { stdio: "ignore" },
)

if (descendant.pid === undefined) {
  throw new Error("hanging fixture descendant has no process id")
}

process.stdout.write(
  `${JSON.stringify({ descendantPid: descendant.pid, leaderPid: process.pid })}\n`,
)
setTimeout(() => process.exit(0), fallbackExitMs)
setInterval(() => {}, 1_000)
