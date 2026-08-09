import { spawn } from "node:child_process"

const mode = process.argv[2]

if (mode === "idle" || mode === "ignore-term") {
  if (mode === "ignore-term") process.on("SIGTERM", () => {})
  process.stdout.write("ready\n")
  setInterval(() => {}, 1_000)
} else if (mode === "leader") {
  const descendantSource = `
    import { createServer } from "node:net"
    const server = createServer((socket) => socket.end())
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || address === null) process.exit(2)
      process.stdout.write(String(address.port) + "\\n")
    })
  `
  const descendant = spawn(process.execPath, ["--input-type=module", "--eval", descendantSource], {
    stdio: ["ignore", "pipe", "inherit"],
  })
  descendant.stdout?.once("data", (chunk) => {
    process.stdout.write(chunk, () => process.exit(0))
  })
} else if (mode === "windows-tree") {
  const descendantSource = `
    import { createServer } from "node:net"
    const server = createServer((socket) => socket.end())
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || address === null) process.exit(2)
      process.stdout.write(JSON.stringify({ pid: process.pid, port: address.port }) + "\\n")
    })
  `
  const descendant = spawn(process.execPath, ["--input-type=module", "--eval", descendantSource], {
    stdio: ["ignore", "pipe", "inherit"],
  })
  descendant.stdout?.once("data", (chunk) => {
    process.stdout.write(chunk)
  })
  setInterval(() => {}, 1_000)
} else {
  throw new Error(`unknown subprocess-tree mode: ${mode}`)
}
