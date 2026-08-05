import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { Command } from "commander"
import { allocateFreePort } from "../lib/dev/allocate-port.js"
import { loadAppEnv } from "../lib/dev/load-app-env.js"
import { parsePort } from "../lib/dev/parse-port.js"
import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"

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

interface ChildOutcome {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly spawnError?: Error
}

export async function runInspectCommand(options: InspectOptions, io: CommandIo): Promise<void> {
  const appRoot = resolve(options.cwd ?? process.cwd())

  const serverJs = resolveInspectorServer(appRoot)
  if (!serverJs) {
    writeLine(io.stdout, INSTALL_HINT)
    return
  }
  if (!existsSync(serverJs)) {
    throw new CliError(
      `@dawn-ai/inspector is installed but its standalone server is missing at ${serverJs} — the package may be corrupted or built incorrectly; try reinstalling.`,
      1,
      { code: "DAWN_E5201" },
    )
  }

  // Mirror dawn dev's env precedence: --env-file flag > dawn.config.ts env >
  // "<appRoot>/.env"; relative paths resolve against the app root.
  await loadAppEnv({ appRoot, flag: options.envFile, io })

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

  // A spawn failure (EPERM/EAGAIN class) fires `error` and may never fire
  // `exit` — fold both events into one settled outcome so the command neither
  // hangs waiting on `exit` nor crashes via an unlistened `error` event.
  const exited = new Promise<ChildOutcome>((resolvePromise) => {
    child.once("exit", (code, signal) => {
      resolvePromise({ code, signal })
    })
    child.once("error", (spawnError) => {
      resolvePromise({ code: null, signal: null, spawnError })
    })
  })

  try {
    // Fail fast if the server dies (or fails to spawn) at startup instead of
    // polling out the clock. Once ready, the same promise resolves harmlessly.
    let ready = false
    const earlyExit = exited.then(({ code, signal, spawnError }) => {
      if (ready) return
      if (spawnError) {
        throw new CliError(
          `Failed to start the inspector server: ${formatErrorMessage(spawnError)}`,
          1,
          { code: "DAWN_E5201" },
        )
      }
      throw new CliError(
        `Inspector server exited before becoming ready (code ${code}, signal ${signal})`,
        1,
        { code: "DAWN_E5201" },
      )
    })
    await Promise.race([waitForReady(`${url}/healthz`), earlyExit])
    ready = true

    writeLine(io.stdout, `Dawn Inspector ready at ${url}`)
    openBrowser(url)

    // Stay foreground until the server exits (Ctrl+C → SIGTERM → clean exit).
    const { code, spawnError } = await exited
    if (spawnError) {
      throw new CliError(`Inspector server failed: ${formatErrorMessage(spawnError)}`, 1, {
        code: "DAWN_E5201",
      })
    }
    if (!shutdownRequested && code !== null && code !== 0) {
      throw new CliError(`Inspector server exited with code ${code}`, 1, { code: "DAWN_E5201" })
    }
  } finally {
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
    }
  }
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
  throw new CliError(`Inspector server never became ready at ${healthUrl}`, 1, {
    code: "DAWN_E5201",
  })
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
