// Standalone Verdaccio runner for the sandbox e2e smoke lanes (CI).
//
//   node_modules/.bin/tsx test/k8s-smoke/serve-registry.ts <url-file>
//
// Starts the SAME local registry the test harness uses (startLocalRegistry) and
// publishes every public @dawn-ai/* package to it (publishWorkspace) — the exact
// mechanism vitest's registry globalSetup runs, just hoisted into a long-lived
// process so a shell step (build-image.sh's on-host + in-image installs) can
// reach it. The chosen random port is written to <url-file> once publish
// completes; the process then stays alive until it receives SIGTERM/SIGINT
// (the CI step kills it after the image is built + loaded into kind).
import { writeFile } from "node:fs/promises"

import { publishWorkspace, startLocalRegistry } from "../harness/local-registry.ts"

const urlFile = process.argv[2]
if (!urlFile) {
  console.error("usage: serve-registry.ts <url-file>")
  process.exit(2)
}

// Bind 0.0.0.0 so the in-`docker build` `npm install` can reach this registry
// via host.docker.internal (the docker bridge gateway on Linux CI — a
// loopback-only bind would be unreachable from the build container). The
// returned url is the loopback form, which build-image.sh rewrites to
// host.docker.internal for the docker build and uses as-is for host-side installs.
const registry = await startLocalRegistry({ host: "0.0.0.0" })
try {
  await publishWorkspace(registry.url)
} catch (err) {
  await registry.stop()
  throw err
}

await writeFile(urlFile, registry.url, "utf8")
console.log(`[serve-registry] published workspace; registry ready at ${registry.url}`)

let stopping = false
const stop = async (signal: string): Promise<void> => {
  if (stopping) return
  stopping = true
  console.log(`[serve-registry] ${signal} — stopping registry`)
  await registry.stop().catch(() => undefined)
  process.exit(0)
}
process.on("SIGTERM", () => void stop("SIGTERM"))
process.on("SIGINT", () => void stop("SIGINT"))

// Keep the event loop alive indefinitely (until a signal arrives).
setInterval(() => {}, 1 << 30)
