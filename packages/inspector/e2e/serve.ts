// Playwright's `webServer` command. Wipes and re-seeds the browse fixture, then execs
// the BUILT standalone server — the same artifact `dawn inspect` ships, which is the
// only thing worth asserting against. Run under Node 24: this file is TypeScript and
// relies on native type stripping.
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
// `writeBrowseSeed` lives in `seed-store.ts`, not `seed.ts`: it value-imports the
// `@dawn-ai/memory` barrel (and through it `node:sqlite`), which the jsdom component
// project that imports `seed.ts` cannot bundle.
import { writeBrowseSeed } from "../test/seed-store.ts"

const pkgRoot = fileURLToPath(new URL("..", import.meta.url))
const appRoot = join(pkgRoot, "test/fixtures/browse-app")
const serverJs = join(pkgRoot, ".next/standalone/packages/inspector/server.js")
const port = process.env.INSPECTOR_E2E_PORT ?? "3919"

// Playwright's `webServer` inherits whatever `node` is on PATH — the package's
// `engines` floor does not reach it — and both of these otherwise surface as its
// generic "webServer exited early". A Node too old for type stripping never reaches the
// version check at all: that one fails at parse, which is its own clear message.
const nodeMajor = Number(process.versions.node.split(".")[0])
if (nodeMajor < 24) {
  throw new Error(`the inspector e2e lane requires Node >= 24; running ${process.versions.node}`)
}
if (!existsSync(serverJs)) {
  throw new Error(
    `no built standalone server at ${serverJs} — run \`pnpm turbo run build --filter=@dawn-ai/inspector...\` first`,
  )
}

rmSync(join(appRoot, ".dawn"), { recursive: true, force: true })
mkdirSync(join(appRoot, ".dawn"), { recursive: true })
await writeBrowseSeed(appRoot)

const child = spawn(process.execPath, [serverJs], {
  env: { ...process.env, DAWN_APP_ROOT: appRoot, PORT: port, HOSTNAME: "127.0.0.1" },
  stdio: "inherit",
})
child.on("exit", (code) => process.exit(code ?? 1))
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal))
}
