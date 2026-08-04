import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join, relative, resolve } from "node:path"
import { loadDawnConfig } from "@dawn-ai/core"
import type { Command } from "commander"
import { loadEnvFiles } from "../lib/dev/load-env.js"
import { resolveEnvPath } from "../lib/dev/resolve-env-path.js"
import { CliError, type CommandIo, writeLine } from "../lib/output.js"

interface InspectOptions {
  readonly cwd?: string
  readonly port?: string
  readonly envFile?: string
}

const INSTALL_HINT =
  "The Dawn Inspector is not installed in this app.\n  npm i -D @dawn-ai/inspector\nthen re-run `dawn inspect`."

const READY_ATTEMPTS = 120
const READY_INTERVAL_MS = 500

/**
 * Resolve the inspector's standalone server.js from the APP's node_modules,
 * or null when the package (or its dawnInspector manifest field) is absent.
 *
 * Walks the node_modules chain from the app root upward (standard Node
 * resolution, so hoisted workspace installs work) and reads package.json
 * directly — deliberately NOT require.resolve, whose resolution the test
 * runner patches and which can leak the monorepo's own copy of the package.
 */
export function resolveInspectorServer(appRoot: string): string | null {
  let dir = resolve(appRoot)
  while (true) {
    const pkgJsonPath = join(dir, "node_modules", "@dawn-ai", "inspector", "package.json")
    if (existsSync(pkgJsonPath)) {
      let pkg: { dawnInspector?: { server?: string } }
      try {
        pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
          dawnInspector?: { server?: string }
        }
      } catch {
        return null
      }
      const rel = pkg.dawnInspector?.server
      if (typeof rel !== "string" || rel.length === 0) return null
      return join(dirname(pkgJsonPath), rel)
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function registerInspectCommand(program: Command, io: CommandIo): void {
  program
    .command("inspect")
    .description("Open the Dawn Inspector (browser UI) for this app")
    .option("--cwd <path>", "Path to the Dawn app root")
    .option("--port <number>", "Bind the inspector to a stable localhost port")
    .option(
      "--env-file <path>",
      "Path to a .env file (overrides dawn.config.ts env and the default ./.env)",
    )
    .action(async (options: InspectOptions) => {
      await runInspectCommand(options, io)
    })
}

export async function runInspectCommand(options: InspectOptions, io: CommandIo): Promise<void> {
  const appRoot = resolve(options.cwd ?? process.cwd())

  const serverJs = resolveInspectorServer(appRoot)
  if (!serverJs) {
    writeLine(io.stdout, INSTALL_HINT)
    return
  }

  // Mirror dawn dev's env precedence: --env-file flag > dawn.config.ts env >
  // "<appRoot>/.env"; relative paths resolve against the app root.
  let configEnv: string | undefined
  try {
    const loaded = await loadDawnConfig({ appRoot })
    configEnv = loaded.config.env
  } catch {
    // No dawn.config.ts (or it failed to load) — fall through to default.
    configEnv = undefined
  }
  const resolvedEnv = resolveEnvPath({ appRoot, flag: options.envFile, configEnv })
  const envLoaded = loadEnvFiles([resolvedEnv.absPath])
  if (envLoaded > 0) {
    writeLine(
      io.stdout,
      `Loaded ${envLoaded} variable(s) from ${relative(appRoot, resolvedEnv.absPath) || ".env"}`,
    )
  }

  const port = parsePort(options.port) ?? (await allocateFreePort())
  const url = `http://127.0.0.1:${port}`

  const child = spawn(process.execPath, [serverJs], {
    env: { ...process.env, DAWN_APP_ROOT: appRoot, PORT: String(port), HOSTNAME: "127.0.0.1" },
    stdio: ["ignore", "inherit", "inherit"],
  })

  let shutdownRequested = false
  const onSignal = () => {
    shutdownRequested = true
    child.kill("SIGTERM")
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise) => {
      child.once("exit", (code, signal) => {
        resolvePromise({ code, signal })
      })
    },
  )

  try {
    // Fail fast if the server dies at startup instead of polling out the
    // clock. Once ready, the same promise resolves harmlessly.
    let ready = false
    const earlyExit = exited.then(({ code, signal }) => {
      if (!ready) {
        throw new CliError(
          `Inspector server exited before becoming ready (code ${code}, signal ${signal})`,
          1,
        )
      }
    })
    await Promise.race([waitForReady(`${url}/healthz`), earlyExit])
    ready = true

    writeLine(io.stdout, `Dawn Inspector ready at ${url}`)
    openBrowser(url)

    // Stay foreground until the server exits (Ctrl+C → SIGTERM → clean exit).
    const { code } = await exited
    if (!shutdownRequested && code !== null && code !== 0) {
      throw new CliError(`Inspector server exited with code ${code}`, 1)
    }
  } finally {
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
    }
  }
}

function parsePort(rawPort: string | undefined): number | undefined {
  if (!rawPort) {
    return undefined
  }

  const port = Number(rawPort)

  if (!Number.isInteger(port) || port <= 0) {
    throw new CliError(`Invalid port: ${rawPort}`, 2)
  }

  return port
}

async function allocateFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.once("error", rejectPromise)
    server.unref()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        rejectPromise(new Error("Failed to allocate a TCP port for dawn inspect"))
        return
      }
      server.close(() => {
        resolvePromise(address.port)
      })
    })
  })
}

async function waitForReady(healthUrl: string): Promise<void> {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(healthUrl)
      if (res.ok) return
    } catch {
      // Not up yet — keep polling.
    }
    await new Promise((r) => setTimeout(r, READY_INTERVAL_MS))
  }
  throw new CliError(`Inspector server never became ready at ${healthUrl}`, 1)
}

/** Best-effort: open the user's browser at the inspector URL. Never throws. */
function openBrowser(url: string): void {
  let command: string
  let args: readonly string[]
  if (process.platform === "darwin") {
    command = "open"
    args = [url]
  } else if (process.platform === "win32") {
    command = "cmd"
    args = ["/c", "start", "", url]
  } else {
    command = "xdg-open"
    args = [url]
  }
  try {
    const opener = spawn(command, [...args], { detached: true, stdio: "ignore" })
    opener.once("error", () => {})
    opener.unref()
  } catch {
    // Opening the browser is a convenience — never fail the command over it.
  }
}
