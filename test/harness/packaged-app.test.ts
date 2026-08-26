import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve, win32 as win32Path } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { describe, expect, it } from "vitest"

import { getTestRegistryUrl } from "./local-registry.ts"
import {
  httpOkReadiness,
  installRegistryScaffolderWithNpm,
  resolveNpmLaunch,
  runGeneratedAppNpmCommand,
  runPackagedCommand,
  runPackagedNpmCommand,
  withPackagedNpmServer,
} from "./packaged-app.ts"

const REPO_ROOT = resolve(import.meta.dirname, "../..")
const HANGING_PROCESS_TREE_FIXTURE = resolve(
  REPO_ROOT,
  "packages/devkit/test/fixtures/hanging-process-tree.mjs",
)

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error && typeof error === "object" && Reflect.get(error, "code") === "ESRCH") return false
    throw error
  }
}

async function expectProcessStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (processIsRunning(pid) && Date.now() < deadline) {
    await delay(25)
  }
  expect(processIsRunning(pid)).toBe(false)
}

async function waitForTopology(path: string): Promise<{
  readonly descendantPid: number
  readonly leaderPid: number
}> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as {
        readonly descendantPid: number
        readonly leaderPid: number
      }
    } catch (error) {
      const retryable =
        error instanceof SyntaxError ||
        (error !== null && typeof error === "object" && Reflect.get(error, "code") === "ENOENT")
      if (!retryable) throw error
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
    }
  }
  throw new Error(`Hanging process fixture did not become ready at ${path}`)
}

function setTestEnvironmentVariable(name: string, value: string): () => void {
  const hadOwnProperty = Object.hasOwn(process.env, name)
  const previousValue = Reflect.get(process.env, name)
  Reflect.set(process.env, name, value)

  return () => {
    if (hadOwnProperty) {
      Reflect.set(process.env, name, previousValue)
    } else {
      Reflect.deleteProperty(process.env, name)
    }
  }
}

async function createNpmServerFixture(prefix: string, targetRoot?: string): Promise<string> {
  const appRoot = targetRoot ?? (await mkdtemp(join(tmpdir(), prefix)))
  if (targetRoot !== undefined) await mkdir(appRoot, { recursive: true })
  await writeFile(
    join(appRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "packaged-npm-server-fixture",
        private: true,
        scripts: {
          dev: "node server.mjs dev",
          "dev:web": "node server.mjs dev:web",
          start: "node server.mjs start",
        },
        type: "module",
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  await writeFile(
    join(appRoot, "server.mjs"),
    [
      'import { writeFileSync } from "node:fs"',
      'import { writeFile } from "node:fs/promises"',
      'import { createServer } from "node:http"',
      "const mode = process.argv[2]",
      "const args = process.argv.slice(3)",
      'const port = mode === "start" ? Number(process.env.PORT) : Number(args[args.indexOf("--port") + 1])',
      'const host = mode === "start" ? process.env.HOST : (args.includes("-H") ? args[args.indexOf("-H") + 1] : "127.0.0.1")',
      'const startingResponses = Number(process.env.FIXTURE_STARTING_RESPONSES ?? "0")',
      'const readyAfter = Number(process.env.FIXTURE_READY_AFTER ?? "0")',
      'const exitCode = Number(process.env.FIXTURE_EXIT_CODE ?? "0")',
      'const forcedExitMs = Number(process.env.FIXTURE_FORCED_EXIT_MS ?? "0")',
      'const sigtermDelayMs = Number(process.env.FIXTURE_SIGTERM_DELAY_MS ?? "0")',
      "let healthRequestCount = 0",
      "let readyRequestCount = 0",
      'await writeFile(new URL("./observed.json", import.meta.url), JSON.stringify({ args, host, mode, pid: process.pid, port, runtimeEnv: { apiKey: process.env.OPENAI_API_KEY ?? "missing", baseUrl: process.env.OPENAI_BASE_URL ?? "missing", dockerSandbox: process.env.DAWN_DEMO_DOCKER_SANDBOX ?? "missing" }, unsetEnv: process.env.DAWN_TEST_SERVER_UNSET_ENV ?? "missing" }))',
      'process.stdout.write("fixture " + mode + " stdout\\n")',
      'process.stderr.write("fixture " + mode + " stderr\\n")',
      "if (exitCode > 0) {",
      '  process.stdout.write("fixture early exit stdout\\n")',
      '  process.stderr.write("fixture early exit stderr\\n")',
      "  process.exit(exitCode)",
      "}",
      "const server = createServer((request, response) => {",
      '  if (request.url === "/ready") {',
      "    readyRequestCount += 1",
      '    writeFileSync(new URL("./ready-count.txt", import.meta.url), String(readyRequestCount))',
      "    const ok = readyRequestCount > readyAfter",
      '    response.writeHead(ok ? 200 : 503, { "content-type": "application/json" })',
      '    response.end(JSON.stringify(ok ? { ok: true } : { error: "fixture not ready yet" }))',
      "    return",
      "  }",
      '  if (request.url !== "/healthz") {',
      "    response.writeHead(404)",
      "    response.end()",
      "    return",
      "  }",
      "  healthRequestCount += 1",
      '  writeFileSync(new URL("./health-count.txt", import.meta.url), String(healthRequestCount))',
      '  response.writeHead(200, { "content-type": "application/json" })',
      '  response.end(JSON.stringify({ status: healthRequestCount <= startingResponses ? "starting" : "ready" }))',
      "})",
      "server.listen(port, host)",
      "const close = () => server.close(() => process.exit(0))",
      // A nested child that dies slower than its parent is the shape the action
      // settle fix exists for: `next dev` released its port ~1183ms after SIGTERM.
      "const closeAfterDelay = () => { if (sigtermDelayMs > 0) setTimeout(close, sigtermDelayMs); else close() }",
      'process.once("SIGTERM", closeAfterDelay)',
      'process.once("SIGINT", closeAfterDelay)',
      "if (forcedExitMs > 0) setTimeout(close, forcedExitMs).unref()",
      "",
    ].join("\n"),
    "utf8",
  )

  return appRoot
}

async function startPoisonRegistry(): Promise<{
  close: () => Promise<void>
  readonly requestCount: number
  readonly url: string
}> {
  let requestCount = 0
  const server = createServer((_request, response) => {
    requestCount += 1
    response.writeHead(404, { "content-type": "text/plain" })
    response.end("poison registry")
  })

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise)
      resolvePromise()
    })
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    throw new Error("Poison registry failed to bind a TCP port")
  }

  return {
    close: async () => {
      await new Promise<void>((resolvePromise, rejectPromise) =>
        server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
      )
    },
    get requestCount() {
      return requestCount
    },
    url: `http://127.0.0.1:${address.port}/`,
  }
}

async function readObservedServer(appRoot: string): Promise<{
  readonly args: readonly string[]
  readonly host?: string
  readonly mode: string
  readonly pid: number
  readonly port: number
  readonly runtimeEnv: {
    readonly apiKey: string
    readonly baseUrl: string
    readonly dockerSandbox: string
  }
  readonly unsetEnv: string
}> {
  return JSON.parse(await readFile(join(appRoot, "observed.json"), "utf8")) as {
    readonly args: readonly string[]
    readonly host?: string
    readonly mode: string
    readonly pid: number
    readonly port: number
    readonly runtimeEnv: {
      readonly apiKey: string
      readonly baseUrl: string
      readonly dockerSandbox: string
    }
    readonly unsetEnv: string
  }
}

async function expectServerStopped(url: string): Promise<void> {
  await expect(fetch(new URL("/healthz", url))).rejects.toThrow()
}

async function waitForHealthRequest(appRoot: string): Promise<number> {
  const healthCountPath = join(appRoot, "health-count.txt")
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      const count = Number(await readFile(healthCountPath, "utf8"))
      if (count >= 1) return count
    } catch (error) {
      if (error === null || typeof error !== "object" || Reflect.get(error, "code") !== "ENOENT") {
        throw error
      }
    }
    await delay(25)
  }
  throw new Error(`npm server fixture did not receive a health request at ${healthCountPath}`)
}

describe("resolveNpmLaunch", () => {
  it("keeps Windows paths with spaces and metacharacters in argv", () => {
    const execPath = String.raw`C:\Program Files & Tools\Node (24)^\node.exe`
    const npmCliPath = win32Path.join(
      win32Path.dirname(execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    )

    const launch = resolveNpmLaunch({
      execPath,
      pathExists: (path) => path === npmCliPath,
      platform: "win32",
    })

    expect(launch).toEqual({
      argsPrefix: [npmCliPath],
      command: execPath,
      displayCommand: "npm",
    })
    expect(launch).not.toHaveProperty("shell")
  })

  it("runs npm through argv while retaining a human-readable transcript", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dawn-npm-argv-"))
    const cwd = join(tempRoot, "app & (argv)^ space")
    const transcriptPath = join(tempRoot, "npm.log")

    await mkdir(cwd)
    try {
      const result = await runPackagedNpmCommand({ args: ["--version"], cwd, transcriptPath })

      expect(result.command).toBe(process.execPath)
      expect(result.args[0]).toMatch(/npm-cli\.js$/u)
      const transcript = await readFile(transcriptPath, "utf8")
      expect(transcript).toContain(`$ (cd ${cwd} && npm --version)`)
      expect(transcript).not.toContain(`${process.execPath} ${result.args[0]}`)
    } finally {
      await rm(tempRoot, { force: true, recursive: true })
    }
  })
})

describe("runPackagedCommand", () => {
  it("records an asynchronous spawn failure before rethrowing it", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dawn-packaged-spawn-error-"))
    const transcriptPath = join(tempRoot, "spawn-error.log")
    const missingCommand = join(tempRoot, "missing-command")
    let thrown: unknown

    try {
      try {
        await runPackagedCommand({
          args: ["--partial-argument"],
          command: missingCommand,
          cwd: tempRoot,
          transcriptPath,
        })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(Error)
      expect(thrown).toMatchObject({ code: "ENOENT" })
      const spawnCause = (thrown as Error).cause
      expect(spawnCause).toMatchObject({ code: "ENOENT" })
      expect((thrown as { result: { spawnError: unknown } }).result.spawnError).toBe(spawnCause)
      const transcript = await readFile(transcriptPath, "utf8")
      expect(transcript).toContain(`$ (cd ${tempRoot} && ${missingCommand} --partial-argument)`)
      expect(transcript).toContain("[spawn error")
      expect(transcript).toContain("ENOENT")
      expect(transcript).toContain("[exit unavailable signal none]")
    } finally {
      await rm(tempRoot, { force: true, recursive: true })
    }
  })

  it("aggregates command and transcript failures", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dawn-packaged-transcript-error-"))
    const transcriptPath = join(tempRoot, "transcript-directory")
    await mkdir(transcriptPath)

    try {
      let thrown: unknown
      try {
        await runPackagedCommand({
          args: ["-e", 'process.stderr.write("partial stderr"); process.exit(7)'],
          command: process.execPath,
          cwd: tempRoot,
          transcriptPath,
        })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(AggregateError)
      const errors = (thrown as AggregateError).errors
      expect(errors).toHaveLength(2)
      expect((thrown as AggregateError).cause).toBe(errors[0])
      expect(errors[0]).toBeInstanceOf(Error)
      expect((errors[0] as Error).message).toContain("partial stderr")
      expect(errors[1]).toMatchObject({ code: expect.stringMatching(/^(EISDIR|EPERM)$/) })
    } finally {
      await rm(tempRoot, { force: true, recursive: true })
    }
  })

  it("can remove selected inherited environment variables", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dawn-packaged-command-"))
    const restoreEnv = setTestEnvironmentVariable("DAWN_TEST_PACKAGED_UNSET_ENV", "inherited")

    try {
      const result = await runPackagedCommand({
        args: ["-e", 'process.stdout.write(process.env.DAWN_TEST_PACKAGED_UNSET_ENV ?? "missing")'],
        command: process.execPath,
        cwd: tempRoot,
        transcriptPath: join(tempRoot, "command.log"),
        unsetEnv: ["DAWN_TEST_PACKAGED_UNSET_ENV"],
      })

      expect(result.stdout).toBe("missing")
    } finally {
      restoreEnv()
      await rm(tempRoot, { force: true, recursive: true })
    }
  })

  it("preserves stdin while removing environment overrides", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dawn-packaged-stdin-"))
    const restoreEnv = setTestEnvironmentVariable("DAWN_TEST_PACKAGED_STDIN_UNSET_ENV", "inherited")

    try {
      const result = await runPackagedCommand({
        args: [
          "-e",
          [
            'let stdin = ""',
            'process.stdin.setEncoding("utf8")',
            'process.stdin.on("data", (chunk) => { stdin += chunk })',
            'process.stdin.on("end", () => process.stdout.write((process.env.DAWN_TEST_PACKAGED_STDIN_UNSET_ENV ?? "missing") + ":" + stdin))',
          ].join(";"),
        ],
        command: process.execPath,
        cwd: tempRoot,
        env: { DAWN_TEST_PACKAGED_STDIN_UNSET_ENV: "override" },
        stdin: "input",
        transcriptPath: join(tempRoot, "command.log"),
        unsetEnv: ["DAWN_TEST_PACKAGED_STDIN_UNSET_ENV"],
      })

      expect(result.stdout).toBe("missing:input")
    } finally {
      restoreEnv()
      await rm(tempRoot, { force: true, recursive: true })
    }
  })

  it("records timeout diagnostics only after the process tree has stopped", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dawn-packaged-timeout-"))
    const readyPath = join(tempRoot, "ready.json")
    const transcriptPath = join(tempRoot, "timeout.log")
    const startedAt = Date.now()
    let topology: Awaited<ReturnType<typeof waitForTopology>> | undefined
    let thrown: unknown

    try {
      const commandResult = runPackagedCommand({
        args: [HANGING_PROCESS_TREE_FIXTURE, "6000", readyPath],
        command: process.execPath,
        cwd: tempRoot,
        timeoutMs: 1_500,
        transcriptPath,
      })
      topology = await waitForTopology(readyPath)
      try {
        await commandResult
      } catch (error) {
        thrown = error
      }

      expect(Date.now() - startedAt).toBeLessThan(4_000)
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain("timed out after 1500ms")

      const transcript = await readFile(transcriptPath, "utf8")
      expect(transcript).toContain(JSON.stringify(topology))
      expect(transcript).toContain("[timed out after 1500ms]")
      await expectProcessStopped(topology.leaderPid)
      await expectProcessStopped(topology.descendantPid)
    } finally {
      if (topology !== undefined) {
        await expectProcessStopped(topology.leaderPid)
        await expectProcessStopped(topology.descendantPid)
      }
      await rm(tempRoot, { force: true, recursive: true })
    }
  })

  it.runIf(process.platform !== "win32")(
    "records partial output when timed-out tree termination fails",
    async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), "dawn-packaged-termination-error-"))
      const readyPath = join(tempRoot, "ready.json")
      const transcriptPath = join(tempRoot, "termination-error.log")
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")
      let topology: Awaited<ReturnType<typeof waitForTopology>> | undefined
      let thrown: unknown

      Object.defineProperty(process, "platform", { configurable: true, value: "win32" })
      try {
        const commandResult = runPackagedCommand({
          args: [HANGING_PROCESS_TREE_FIXTURE, "3000", readyPath],
          command: process.execPath,
          cwd: tempRoot,
          timeoutMs: 1_000,
          transcriptPath,
        })
        topology = await waitForTopology(readyPath)
        try {
          await commandResult
        } catch (error) {
          thrown = error
        }

        expect(thrown).toBeInstanceOf(Error)
        expect(thrown).toMatchObject({ code: "ENOENT" })
        const terminationCause = (thrown as Error).cause
        expect(terminationCause).toMatchObject({ code: "ENOENT" })
        expect((thrown as { result: { terminationError: unknown } }).result.terminationError).toBe(
          terminationCause,
        )
        const transcript = await readFile(transcriptPath, "utf8")
        expect(transcript).toContain(JSON.stringify(topology))
        expect(transcript).toContain("[timed out after 1000ms]")
        expect(transcript).toContain("[termination error")
        expect(transcript).toContain("spawn taskkill.exe ENOENT")
        expect(transcript).toContain("[exit pending signal pending]")
      } finally {
        if (platformDescriptor !== undefined) {
          Object.defineProperty(process, "platform", platformDescriptor)
        }
        if (topology !== undefined) {
          await expectProcessStopped(topology.leaderPid)
          await expectProcessStopped(topology.descendantPid)
        }
        await rm(tempRoot, { force: true, recursive: true })
      }
    },
  )

  it.skipIf(process.platform === "win32")(
    "forwards an explicitly requested shell to the process launcher",
    async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), "dawn-packaged-shell-"))

      try {
        const result = await runPackagedCommand({
          args: [],
          command: ":",
          cwd: tempRoot,
          shell: true,
        })

        expect(result.exitCode).toBe(0)
      } finally {
        await rm(tempRoot, { force: true, recursive: true })
      }
    },
  )
})

describe("runGeneratedAppNpmCommand", () => {
  it("removes ambient runtime and sandbox configuration from npm children", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dawn-generated-app-env-"))
    const restoreDockerSandbox = setTestEnvironmentVariable("DAWN_DEMO_DOCKER_SANDBOX", "1")
    const restoreBaseUrl = setTestEnvironmentVariable("OPENAI_BASE_URL", "http://127.0.0.1:1/v1")
    const restoreApiKey = setTestEnvironmentVariable("OPENAI_API_KEY", "ambient-secret")

    try {
      await writeFile(
        join(tempRoot, "package.json"),
        `${JSON.stringify({
          name: "generated-app-env-fixture",
          private: true,
          scripts: { "observe-env": "node observe-env.mjs" },
        })}\n`,
        "utf8",
      )
      await writeFile(
        join(tempRoot, "observe-env.mjs"),
        [
          'const names = ["DAWN_DEMO_DOCKER_SANDBOX", "OPENAI_BASE_URL", "OPENAI_API_KEY"]',
          'process.stdout.write(JSON.stringify(names.map((name) => Object.hasOwn(process.env, name) ? "present" : "missing")))',
          "",
        ].join("\n"),
        "utf8",
      )

      const result = await runGeneratedAppNpmCommand({
        args: ["run", "observe-env"],
        cwd: tempRoot,
      })

      expect(JSON.parse(result.stdout.slice(result.stdout.indexOf("[")))).toEqual([
        "missing",
        "missing",
        "missing",
      ])
    } finally {
      restoreApiKey()
      restoreBaseUrl()
      restoreDockerSandbox()
      await rm(tempRoot, { force: true, recursive: true })
    }
  })

  it("propagates abort through npm and records it after the process tree stops", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dawn-generated-app-abort-"))
    const readyPath = join(tempRoot, "ready.json")
    const transcriptPath = join(tempRoot, "abort.log")
    const controller = new AbortController()
    const abortReason = new Error("cancel generated npm command")
    let commandResult: ReturnType<typeof runGeneratedAppNpmCommand> | undefined
    let topology: Awaited<ReturnType<typeof waitForTopology>> | undefined

    try {
      await copyFile(HANGING_PROCESS_TREE_FIXTURE, join(tempRoot, "hang.mjs"))
      await writeFile(
        join(tempRoot, "package.json"),
        `${JSON.stringify({
          name: "generated-app-abort-fixture",
          private: true,
          scripts: { hang: "node hang.mjs 4000 ready.json" },
        })}\n`,
        "utf8",
      )

      commandResult = runGeneratedAppNpmCommand({
        args: ["run", "hang"],
        cwd: tempRoot,
        signal: controller.signal,
        transcriptPath,
      })
      topology = await waitForTopology(readyPath)
      controller.abort(abortReason)

      let thrown: unknown
      try {
        await commandResult
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain("Command aborted: npm run hang")
      expect((thrown as Error).cause).toBe(abortReason)
      const transcript = await readFile(transcriptPath, "utf8")
      expect(transcript).toContain("[aborted: Error: cancel generated npm command]")
      await expectProcessStopped(topology.leaderPid)
      await expectProcessStopped(topology.descendantPid)
    } finally {
      controller.abort(abortReason)
      await commandResult?.catch(() => undefined)
      if (topology !== undefined) {
        await expectProcessStopped(topology.leaderPid)
        await expectProcessStopped(topology.descendantPid)
      }
      await rm(tempRoot, { force: true, recursive: true })
    }
  })
})

describe("installRegistryScaffolderWithNpm", () => {
  it("ignores inherited registry overrides and installs current candidate bytes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dawn-npm-scaffolder-"))
    const transcriptPath = join(tempRoot, "install.log")
    const userconfigPath = join(tempRoot, "poison-user.npmrc")
    let poisonRegistry: Awaited<ReturnType<typeof startPoisonRegistry>> | undefined
    let restoreLowerUserconfig: (() => void) | undefined
    let restoreUpperUserconfig: (() => void) | undefined
    const restoreRegistryEnvironment: Array<() => void> = []

    try {
      poisonRegistry = await startPoisonRegistry()
      await writeFile(
        userconfigPath,
        [
          `scope=@poison`,
          `@poison:registry=${poisonRegistry.url}`,
          `@dawn-ai:registry=${poisonRegistry.url}`,
          "",
        ].join("\n"),
        "utf8",
      )
      restoreLowerUserconfig = setTestEnvironmentVariable("npm_config_userconfig", userconfigPath)
      restoreUpperUserconfig = setTestEnvironmentVariable("NPM_CONFIG_USERCONFIG", userconfigPath)
      for (const [name, value] of [
        ["npm_config_registry", poisonRegistry.url],
        ["NPM_CONFIG_REGISTRY", poisonRegistry.url],
        ["nPm_CoNfIg_ReGiStRy", poisonRegistry.url],
        ["npm_config_scope", "@poison"],
        ["NPM_CONFIG_SCOPE", "@poison"],
        ["nPm_CoNfIg_ScOpE", "@poison"],
        ["npm_config_@dawn-ai:registry", poisonRegistry.url],
        ["NPM_CONFIG_@DAWN-AI:REGISTRY", poisonRegistry.url],
        ["nPm_CoNfIg_@DaWn-Ai:ReGiStRy", poisonRegistry.url],
      ] as const) {
        restoreRegistryEnvironment.push(setTestEnvironmentVariable(name, value))
      }

      let installResult: Awaited<ReturnType<typeof installRegistryScaffolderWithNpm>> | undefined
      let installError: unknown
      try {
        installResult = await installRegistryScaffolderWithNpm({
          tempRoot,
          transcriptPath,
        })
      } catch (error) {
        installError = error
      }

      expect(poisonRegistry.requestCount).toBe(0)
      expect(installError).toBeUndefined()
      const installerDir = installResult?.installerDir
      expect(installerDir).toBeDefined()
      if (installerDir === undefined) throw new Error("Candidate installer was not created")

      await expect(readFile(join(installerDir, "package.json"), "utf8")).resolves.toContain(
        '"private": true',
      )
      await expect(readFile(join(installerDir, ".npmrc"), "utf8")).resolves.toContain(
        `registry=${getTestRegistryUrl()}`,
      )
      await expect(
        readFile(join(installerDir, "node_modules", "create-dawn-ai-app", "package.json"), "utf8"),
      ).resolves.toContain('"name": "create-dawn-ai-app"')
      await expect(
        readFile(
          join(installerDir, "node_modules", "create-dawn-ai-app", "dist", "index.js"),
          "utf8",
        ),
      ).resolves.toBe(
        await readFile(join(REPO_ROOT, "packages", "create-dawn-app", "dist", "index.js"), "utf8"),
      )
      await expect(
        readFile(
          join(
            installerDir,
            "node_modules",
            "@dawn-ai",
            "devkit",
            "templates",
            "app-research",
            "package.json.template",
          ),
          "utf8",
        ),
      ).resolves.toBe(
        await readFile(
          join(
            REPO_ROOT,
            "packages",
            "devkit",
            "templates",
            "app-research",
            "package.json.template",
          ),
          "utf8",
        ),
      )

      const transcript = await readFile(transcriptPath, "utf8")
      expect(transcript).toContain(
        `$ (cd ${installerDir} && npm install --no-save create-dawn-ai-app@latest)`,
      )
      expect(transcript).not.toContain("--registry")
      expect(transcript).not.toContain(getTestRegistryUrl())
      expect(transcript).toContain("[exit 0]")
    } finally {
      for (const restoreEnvironment of restoreRegistryEnvironment.reverse()) {
        restoreEnvironment()
      }
      restoreUpperUserconfig?.()
      restoreLowerUserconfig?.()
      try {
        await poisonRegistry?.close()
      } finally {
        await rm(tempRoot, { force: true, recursive: true })
      }
    }
  })
})

describe("withPackagedNpmServer", () => {
  it("does not spawn when the caller signal is already aborted", async () => {
    const appRoot = await createNpmServerFixture("dawn-npm-pre-aborted-server-")
    const transcriptPath = join(appRoot, "pre-aborted.log")
    const controller = new AbortController()
    const abortReason = new Error("cancel before npm server spawn")
    let actionRan = false
    let thrown: unknown
    controller.abort(abortReason)

    try {
      try {
        await withPackagedNpmServer(
          { appRoot, script: "start", signal: controller.signal, transcriptPath },
          async () => {
            actionRan = true
          },
        )
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBe(abortReason)
      expect(actionRan).toBe(false)
      await expect(readFile(join(appRoot, "observed.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      })
    } finally {
      await rm(appRoot, { force: true, recursive: true })
    }
  })

  it("aborts readiness after a real health probe and settles cleanup before rejecting", async () => {
    const appRoot = await createNpmServerFixture("dawn-npm-abort-readiness-server-")
    const transcriptPath = join(appRoot, "abort-readiness.log")
    const controller = new AbortController()
    const abortReason = new Error("cancel npm server readiness")
    let actionRan = false
    let observed: Awaited<ReturnType<typeof readObservedServer>> | undefined
    let serverResult: Promise<void> | undefined

    try {
      serverResult = withPackagedNpmServer(
        {
          appRoot,
          env: {
            FIXTURE_FORCED_EXIT_MS: "5000",
            FIXTURE_STARTING_RESPONSES: "1000000",
          },
          script: "start",
          signal: controller.signal,
          transcriptPath,
        },
        async () => {
          actionRan = true
        },
      )
      expect(await waitForHealthRequest(appRoot)).toBeGreaterThanOrEqual(1)
      observed = await readObservedServer(appRoot)
      const serverUrl = `http://${observed.host}:${observed.port}`
      const abortedAt = Date.now()
      controller.abort(abortReason)

      let thrown: unknown
      try {
        await serverResult
      } catch (error) {
        thrown = error
      }

      expect(Date.now() - abortedAt).toBeLessThan(3_000)
      expect(thrown).toBe(abortReason)
      expect(actionRan).toBe(false)
      await expectServerStopped(serverUrl)
      await expectProcessStopped(observed.pid)
      const transcript = await readFile(transcriptPath, "utf8")
      expect(transcript).toContain(`$ (cd ${appRoot} && npm run start)`)
      expect(transcript).not.toContain("[exit pending")
      expect(transcript).toMatch(/\[exit (?:-?\d+|null) signal (?:[A-Z0-9]+|none)\]/)
    } finally {
      controller.abort(abortReason)
      await serverResult?.catch(() => undefined)
      if (observed !== undefined) await expectProcessStopped(observed.pid)
      await rm(appRoot, { force: true, recursive: true })
    }
  })

  it("bounds action waiting with the caller signal", async () => {
    const appRoot = await createNpmServerFixture("dawn-npm-abort-action-server-")
    const transcriptPath = join(appRoot, "abort-action.log")
    const controller = new AbortController()
    const abortReason = new Error("cancel npm server action")
    let actionStartedResolve: (() => void) | undefined
    const actionStarted = new Promise<void>((resolvePromise) => {
      actionStartedResolve = resolvePromise
    })
    let releaseAction: (() => void) | undefined
    const actionWait = new Promise<void>((resolvePromise) => {
      releaseAction = resolvePromise
    })
    // Long enough that only the harness's own settle budget can end this test:
    // the action deliberately never unwinds, which is the case the budget bounds.
    const fallback = setTimeout(() => releaseAction?.(), 30_000)
    fallback.unref()
    let serverResult: Promise<string> | undefined
    let serverUrl = ""

    try {
      serverResult = withPackagedNpmServer(
        { appRoot, script: "start", signal: controller.signal, transcriptPath },
        async ({ url }) => {
          serverUrl = url
          actionStartedResolve?.()
          await actionWait
          return "late action result"
        },
      )
      await actionStarted
      const abortedAt = Date.now()
      controller.abort(abortReason)

      let thrown: unknown
      try {
        await serverResult
      } catch (error) {
        thrown = error
      }

      // Teardown now gives the action PACKAGED_NPM_ACTION_SETTLE_MS (5s) to finish
      // unwinding before killing the child, so a hung action costs that budget —
      // and no more. Without the upper bound a nested lane could hang cleanup for
      // the whole run; the nested test below covers the fast path (~1s).
      expect(Date.now() - abortedAt).toBeLessThan(10_000)
      expect(thrown).toBe(abortReason)
      await expectServerStopped(serverUrl)
      const transcript = await readFile(transcriptPath, "utf8")
      expect(transcript).not.toContain("[exit pending")
    } finally {
      clearTimeout(fallback)
      releaseAction?.()
      controller.abort(abortReason)
      await serverResult?.catch(() => undefined)
      await actionWait
      await rm(appRoot, { force: true, recursive: true })
    }
  })

  it("observes an action rejection when the action aborts its caller signal", async () => {
    const appRoot = await createNpmServerFixture("dawn-npm-action-aborts-server-")
    const transcriptPath = join(appRoot, "action-aborts.log")
    const controller = new AbortController()
    const abortReason = new Error("action cancelled its npm server")
    const actionFailure = new Error("action rejected after cancellation")
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    let observed: Awaited<ReturnType<typeof readObservedServer>> | undefined
    let serverResult: Promise<never> | undefined
    let serverUrl = ""

    process.on("unhandledRejection", onUnhandledRejection)
    try {
      serverResult = withPackagedNpmServer(
        { appRoot, script: "start", signal: controller.signal, transcriptPath },
        ({ url }) => {
          serverUrl = url
          controller.abort(abortReason)
          return Promise.reject(actionFailure)
        },
      )

      let thrown: unknown
      try {
        await serverResult
      } catch (error) {
        thrown = error
      }
      await delay(25)

      expect(thrown).toBe(abortReason)
      expect(unhandledRejections).toEqual([])
      observed = await readObservedServer(appRoot)
      await expectServerStopped(serverUrl)
      await expectProcessStopped(observed.pid)
      const transcript = await readFile(transcriptPath, "utf8")
      expect(transcript).not.toContain("[exit pending")
      expect(transcript).toMatch(/\[exit (?:-?\d+|null) signal (?:[A-Z0-9]+|none)\]/)
    } finally {
      process.off("unhandledRejection", onUnhandledRejection)
      controller.abort(abortReason)
      await serverResult?.catch(() => undefined)
      if (observed !== undefined) await expectProcessStopped(observed.pid)
      await rm(appRoot, { force: true, recursive: true })
    }
  })

  it("settles a nested server before tearing down the outer one", async () => {
    const outerRoot = await createNpmServerFixture("dawn-npm-nested-outer-")
    const innerRoot = await createNpmServerFixture("dawn-npm-nested-inner-")
    // One transcript for both children, exactly as the activation lane does.
    const transcriptPath = join(outerRoot, "nested.log")
    const controller = new AbortController()
    const abortReason = new Error("cancel the nested npm servers")
    let innerStartedResolve: (() => void) | undefined
    const innerStarted = new Promise<void>((resolvePromise) => {
      innerStartedResolve = resolvePromise
    })
    let releaseInner: (() => void) | undefined
    const innerWait = new Promise<void>((resolvePromise) => {
      releaseInner = resolvePromise
    })
    const fallback = setTimeout(() => releaseInner?.(), 5_000)
    fallback.unref()
    let outerResult: Promise<string> | undefined
    let outerUrl = ""
    let innerUrl = ""

    try {
      outerResult = withPackagedNpmServer(
        { appRoot: outerRoot, script: "start", signal: controller.signal, transcriptPath },
        async ({ url }) => {
          outerUrl = url
          return await withPackagedNpmServer(
            {
              appRoot: innerRoot,
              // The inner child releases its port ~600ms after SIGTERM, the way a
              // real `next dev` group does (~1183ms measured). Without the settle
              // the outer tears down first and both children append at once.
              env: { FIXTURE_SIGTERM_DELAY_MS: "600" },
              script: "start",
              signal: controller.signal,
              transcriptPath,
            },
            async ({ url: nestedUrl }) => {
              innerUrl = nestedUrl
              innerStartedResolve?.()
              await innerWait
              return "inner-action-complete"
            },
          )
        },
      )

      await innerStarted
      controller.abort(abortReason)
      // The inner action keeps unwinding past the abort — that is the whole point.
      await delay(50)
      releaseInner?.()

      let thrown: unknown
      try {
        await outerResult
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBe(abortReason)
      // LIFO: both children are gone by the time the OUTER promise settles.
      await expectServerStopped(innerUrl)
      await expectServerStopped(outerUrl)

      const transcript = await readFile(transcriptPath, "utf8")
      expect(transcript).not.toContain("[exit pending")
      expect(transcript.match(/\[exit (?:-?\d+|null) signal (?:[A-Z0-9]+|none)\]/g)).toHaveLength(2)
      const innerIndex = transcript.indexOf(`$ (cd ${innerRoot} && npm run start)`)
      const outerIndex = transcript.indexOf(`$ (cd ${outerRoot} && npm run start)`)
      expect(innerIndex).toBeGreaterThanOrEqual(0)
      expect(outerIndex).toBeGreaterThan(innerIndex)
    } finally {
      clearTimeout(fallback)
      releaseInner?.()
      controller.abort(abortReason)
      await outerResult?.catch(() => undefined)
      await rm(outerRoot, { force: true, recursive: true })
      await rm(innerRoot, { force: true, recursive: true })
    }
  })

  it.skipIf(process.platform !== "win32")(
    "launches npm scripts through argv from a Windows metacharacter path",
    async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), "dawn-npm-windows-server-"))
      const appRoot = await createNpmServerFixture("", join(tempRoot, "app & (native argv)^ space"))
      const transcriptPath = join(appRoot, "windows.log")
      let serverUrl = ""

      try {
        await withPackagedNpmServer(
          { appRoot, script: "start", transcriptPath },
          async ({ url }) => {
            serverUrl = url
            const response = await fetch(new URL("/healthz", url))
            await expect(response.json()).resolves.toEqual({ status: "ready" })
          },
        )

        await expectServerStopped(serverUrl)
        await expect(readFile(transcriptPath, "utf8")).resolves.toContain("npm run start")
      } finally {
        await rm(tempRoot, { force: true, recursive: true })
      }
    },
  )

  it("waits for a canonical ready health response before running the action", async () => {
    const appRoot = await createNpmServerFixture("dawn-npm-readiness-server-")
    const transcriptPath = join(appRoot, "readiness.log")
    let serverUrl = ""

    try {
      const healthRequestCount = await withPackagedNpmServer(
        {
          appRoot,
          env: { FIXTURE_STARTING_RESPONSES: "2" },
          script: "start",
          transcriptPath,
        },
        async ({ url }) => {
          serverUrl = url
          return Number(await readFile(join(appRoot, "health-count.txt"), "utf8"))
        },
      )

      expect(healthRequestCount).toBeGreaterThanOrEqual(3)
      await expectServerStopped(serverUrl)
    } finally {
      await rm(appRoot, { force: true, recursive: true })
    }
  })

  it("waits for a custom readiness probe on a child with no health endpoint", async () => {
    const appRoot = await createNpmServerFixture("dawn-npm-web-readiness-")
    const transcriptPath = join(appRoot, "web-readiness.log")
    const restoreDockerSandbox = setTestEnvironmentVariable("DAWN_DEMO_DOCKER_SANDBOX", "1")
    const restoreBaseUrl = setTestEnvironmentVariable("OPENAI_BASE_URL", "ambient-base-url")
    const restoreApiKey = setTestEnvironmentVariable("OPENAI_API_KEY", "ambient-api-key")
    let serverUrl = ""

    try {
      const session = await withPackagedNpmServer(
        {
          appRoot,
          env: { FIXTURE_READY_AFTER: "2" },
          readiness: httpOkReadiness("/ready"),
          script: "dev:web",
          transcriptPath,
        },
        async ({ url }) => {
          serverUrl = url
          // The default `/healthz` probe never ran: the fixture only writes
          // health-count.txt when something asks for `/healthz`.
          await expect(readFile(join(appRoot, "health-count.txt"), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
          })
          return {
            observed: await readObservedServer(appRoot),
            readyRequestCount: Number(await readFile(join(appRoot, "ready-count.txt"), "utf8")),
          }
        },
      )

      const port = new URL(serverUrl).port
      // Two 503s were rejected before the 200 released the action.
      expect(session.readyRequestCount).toBeGreaterThanOrEqual(3)
      expect(session.observed.args).toEqual(["--port", port, "-H", "127.0.0.1"])
      expect(session.observed.host).toBe("127.0.0.1")
      expect(session.observed.mode).toBe("dev:web")
      expect(session.observed.port).toBe(Number(port))
      // GENERATED_APP_UNSET_ENV protection holds on the web spawn path too.
      expect(session.observed.runtimeEnv).toEqual({
        apiKey: "missing",
        baseUrl: "missing",
        dockerSandbox: "missing",
      })
      await expectServerStopped(serverUrl)
      await expect(readFile(transcriptPath, "utf8")).resolves.toContain(
        `$ (cd ${appRoot} && npm run dev:web -- --port ${port} -H 127.0.0.1)`,
      )
    } finally {
      restoreApiKey()
      restoreBaseUrl()
      restoreDockerSandbox()
      await rm(appRoot, { force: true, recursive: true })
    }
  })

  it("names the readiness contract when the child exits first", async () => {
    const appRoot = await createNpmServerFixture("dawn-npm-web-early-exit-")
    const transcriptPath = join(appRoot, "web-early-exit.log")
    let actionRan = false
    let thrown: unknown

    try {
      try {
        await withPackagedNpmServer(
          {
            appRoot,
            env: { FIXTURE_EXIT_CODE: "23" },
            readiness: httpOkReadiness("/ready"),
            script: "dev:web",
            transcriptPath,
          },
          async () => {
            actionRan = true
          },
        )
      } catch (error) {
        thrown = error
      }

      expect(actionRan).toBe(false)
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain("npm run dev:web")
      expect((thrown as Error).message).toContain("GET /ready -> 2xx")
      expect((thrown as Error).message).toContain("exit 23, signal none")
    } finally {
      await rm(appRoot, { force: true, recursive: true })
    }
  })

  it("reports an early exit with process output and a transcript", async () => {
    const appRoot = await createNpmServerFixture("dawn-npm-early-exit-")
    const transcriptPath = join(appRoot, "early-exit.log")
    let actionRan = false
    let thrown: unknown

    try {
      try {
        await withPackagedNpmServer(
          {
            appRoot,
            env: { FIXTURE_EXIT_CODE: "23" },
            script: "start",
            transcriptPath,
          },
          async () => {
            actionRan = true
          },
        )
      } catch (error) {
        thrown = error
      }

      expect(actionRan).toBe(false)
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain("exit 23, signal none")
      expect((thrown as Error).message).toContain("fixture early exit stdout")
      expect((thrown as Error).message).toContain("fixture early exit stderr")

      const transcript = await readFile(transcriptPath, "utf8")
      expect(transcript).toContain("fixture early exit stdout")
      expect(transcript).toContain("fixture early exit stderr")
      expect(transcript).toContain("[exit 23 signal none]")
    } finally {
      await rm(appRoot, { force: true, recursive: true })
    }
  })

  it("preserves the asynchronous npm spawn error and transcript", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dawn-npm-spawn-error-"))
    const appRoot = join(tempRoot, "missing-app-root")
    const transcriptPath = join(tempRoot, "spawn-error.log")
    let thrown: unknown

    try {
      try {
        await withPackagedNpmServer({ appRoot, script: "start", transcriptPath }, async () => {
          throw new Error("action must not run")
        })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain("Failed to spawn npm run start")
      expect((thrown as Error).cause).toMatchObject({ code: "ENOENT" })

      const transcript = await readFile(transcriptPath, "utf8")
      expect(transcript).toContain("spawn error")
      expect(transcript).toContain("ENOENT")
    } finally {
      await rm(tempRoot, { force: true, recursive: true })
    }
  })

  it("passes dev arguments after npm's separator and cleans up after returning", async () => {
    const appRoot = await createNpmServerFixture("dawn-npm-dev-server-")
    const transcriptPath = join(appRoot, "dev.log")
    const restoreEnv = setTestEnvironmentVariable("DAWN_TEST_SERVER_UNSET_ENV", "inherited")
    const restoreDockerSandbox = setTestEnvironmentVariable("DAWN_DEMO_DOCKER_SANDBOX", "1")
    const restoreBaseUrl = setTestEnvironmentVariable("OPENAI_BASE_URL", "ambient-base-url")
    const restoreApiKey = setTestEnvironmentVariable("OPENAI_API_KEY", "ambient-api-key")
    let serverUrl = ""

    try {
      const result = await withPackagedNpmServer(
        {
          appRoot,
          env: {
            DAWN_TEST_SERVER_UNSET_ENV: "override",
            OPENAI_API_KEY: "explicit-api-key",
            OPENAI_BASE_URL: "explicit-base-url",
          },
          script: "dev",
          scriptArgs: ["--silent"],
          transcriptPath,
          unsetEnv: ["DAWN_TEST_SERVER_UNSET_ENV"],
        },
        async ({ url }) => {
          serverUrl = url
          const response = await fetch(new URL("/healthz", url))
          expect(response.ok).toBe(true)
          await expect(response.json()).resolves.toEqual({ status: "ready" })

          const observed = await readObservedServer(appRoot)
          expect(observed).toMatchObject({
            args: ["--port", new URL(url).port],
            mode: "dev",
            port: Number(new URL(url).port),
            runtimeEnv: {
              apiKey: "explicit-api-key",
              baseUrl: "explicit-base-url",
              dockerSandbox: "missing",
            },
            unsetEnv: "missing",
          })
          return "dev-action-complete"
        },
      )

      expect(result).toBe("dev-action-complete")
      await expectServerStopped(serverUrl)

      const transcript = await readFile(transcriptPath, "utf8")
      expect(transcript).toContain(
        `$ (cd ${appRoot} && npm run dev --silent -- --port ${new URL(serverUrl).port})`,
      )
      expect(transcript).toContain("fixture dev stdout")
      expect(transcript).toContain("fixture dev stderr")
      expect(transcript).toContain("[exit ")
      expect(transcript).toContain("signal ")
    } finally {
      restoreApiKey()
      restoreBaseUrl()
      restoreDockerSandbox()
      restoreEnv()
      await rm(appRoot, { force: true, recursive: true })
    }
  })

  it("injects start HOST and PORT while retaining npm arguments", async () => {
    const appRoot = await createNpmServerFixture("dawn-npm-start-server-")
    const transcriptPath = join(appRoot, "start.log")
    let serverUrl = ""

    try {
      const result = await withPackagedNpmServer(
        {
          appRoot,
          env: { HOST: "0.0.0.0", PORT: "1" },
          script: "start",
          scriptArgs: ["--silent"],
          transcriptPath,
        },
        async ({ url }) => {
          serverUrl = url
          const response = await fetch(new URL("/healthz", url))
          expect(response.ok).toBe(true)

          const observed = await readObservedServer(appRoot)
          expect(observed).toMatchObject({
            args: [],
            host: "127.0.0.1",
            mode: "start",
            port: Number(new URL(url).port),
          })
          return { url }
        },
      )

      expect(result).toEqual({ url: serverUrl })
      await expectServerStopped(serverUrl)

      const transcript = await readFile(transcriptPath, "utf8")
      expect(transcript).toContain(`$ (cd ${appRoot} && npm run start --silent)`)
      expect(transcript).toContain("fixture start stdout")
      expect(transcript).toContain("fixture start stderr")
    } finally {
      await rm(appRoot, { force: true, recursive: true })
    }
  })

  it("cleans up and records a transcript when the action fails", async () => {
    const appRoot = await createNpmServerFixture("dawn-npm-failing-action-")
    const transcriptPath = join(appRoot, "failure.log")
    let serverUrl = ""

    try {
      await expect(
        withPackagedNpmServer({ appRoot, script: "start", transcriptPath }, async ({ url }) => {
          serverUrl = url
          throw new Error("action failed")
        }),
      ).rejects.toThrow("action failed")

      await expectServerStopped(serverUrl)
      await expect(readFile(transcriptPath, "utf8")).resolves.toContain("[exit ")
    } finally {
      await rm(appRoot, { force: true, recursive: true })
    }
  })

  it("surfaces a transcript failure after a successful action and closes the port", async () => {
    const appRoot = await createNpmServerFixture("dawn-npm-transcript-failure-")
    const transcriptPath = join(appRoot, "transcript-directory")
    let actionRan = false
    let serverUrl = ""
    let thrown: unknown

    await mkdir(transcriptPath)

    try {
      try {
        await withPackagedNpmServer(
          { appRoot, script: "start", transcriptPath },
          async ({ url }) => {
            actionRan = true
            serverUrl = url
          },
        )
      } catch (error) {
        thrown = error
      }

      expect(actionRan).toBe(true)
      expect(thrown).toBeInstanceOf(Error)
      expect(thrown).toMatchObject({ code: expect.stringMatching(/^(EISDIR|EPERM)$/) })
      await expectServerStopped(serverUrl)
    } finally {
      await rm(appRoot, { force: true, recursive: true })
    }
  })

  it("aggregates action and transcript failures without replacing either error", async () => {
    const appRoot = await createNpmServerFixture("dawn-npm-combined-failure-")
    const transcriptPath = join(appRoot, "transcript-directory")
    const actionError = new Error("combined action failed")
    let serverUrl = ""
    let thrown: unknown

    await mkdir(transcriptPath)

    try {
      try {
        await withPackagedNpmServer(
          { appRoot, script: "start", transcriptPath },
          async ({ url }) => {
            serverUrl = url
            throw actionError
          },
        )
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(AggregateError)
      const errors = (thrown as AggregateError).errors
      expect(errors).toHaveLength(2)
      expect(errors[0]).toBe(actionError)
      expect(errors[1]).toBeInstanceOf(Error)
      expect(errors[1]).toMatchObject({ code: expect.stringMatching(/^(EISDIR|EPERM)$/) })
      await expectServerStopped(serverUrl)
    } finally {
      await rm(appRoot, { force: true, recursive: true })
    }
  })
})
