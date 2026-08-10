import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve, win32 as win32Path } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { describe, expect, it } from "vitest"

import { getTestRegistryUrl } from "./local-registry.ts"
import {
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
      'const portIndex = args.indexOf("--port")',
      'const port = mode === "dev" ? Number(args[portIndex + 1]) : Number(process.env.PORT)',
      'const host = mode === "start" ? process.env.HOST : "127.0.0.1"',
      'const startingResponses = Number(process.env.FIXTURE_STARTING_RESPONSES ?? "0")',
      'const exitCode = Number(process.env.FIXTURE_EXIT_CODE ?? "0")',
      "let healthRequestCount = 0",
      'await writeFile(new URL("./observed.json", import.meta.url), JSON.stringify({ args, host, mode, port, runtimeEnv: { apiKey: process.env.OPENAI_API_KEY ?? "missing", baseUrl: process.env.OPENAI_BASE_URL ?? "missing", dockerSandbox: process.env.DAWN_DEMO_DOCKER_SANDBOX ?? "missing" }, unsetEnv: process.env.DAWN_TEST_SERVER_UNSET_ENV ?? "missing" }))',
      'process.stdout.write("fixture " + mode + " stdout\\n")',
      'process.stderr.write("fixture " + mode + " stderr\\n")',
      "if (exitCode > 0) {",
      '  process.stdout.write("fixture early exit stdout\\n")',
      '  process.stderr.write("fixture early exit stderr\\n")',
      "  process.exit(exitCode)",
      "}",
      "const server = createServer((request, response) => {",
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
      'process.once("SIGTERM", close)',
      'process.once("SIGINT", close)',
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
    const transcriptPath = join(tempRoot, "timeout.log")
    const startedAt = Date.now()
    let thrown: unknown

    try {
      try {
        await runPackagedCommand({
          args: [HANGING_PROCESS_TREE_FIXTURE, "4000"],
          command: process.execPath,
          cwd: tempRoot,
          timeoutMs: 100,
          transcriptPath,
        })
      } catch (error) {
        thrown = error
      }

      expect(Date.now() - startedAt).toBeLessThan(3_000)
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain("timed out after 100ms")

      const transcript = await readFile(transcriptPath, "utf8")
      const topologyLine = transcript.split("\n").find((line) => line.startsWith("{"))
      expect(topologyLine).toBeDefined()
      if (topologyLine === undefined) throw new Error("Timeout transcript omitted process topology")
      const topology = JSON.parse(topologyLine) as {
        readonly descendantPid: number
        readonly leaderPid: number
      }
      expect(transcript).toContain("[timed out after 100ms]")
      await expectProcessStopped(topology.leaderPid)
      await expectProcessStopped(topology.descendantPid)
    } finally {
      await rm(tempRoot, { force: true, recursive: true })
    }
  })

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
})

describe("installRegistryScaffolderWithNpm", () => {
  it("ignores inherited registry overrides and installs current candidate bytes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dawn-npm-scaffolder-"))
    const transcriptPath = join(tempRoot, "install.log")
    const userconfigPath = join(tempRoot, "poison-user.npmrc")
    let poisonRegistry: Awaited<ReturnType<typeof startPoisonRegistry>> | undefined
    let restoreLowerUserconfig: (() => void) | undefined
    let restoreUpperUserconfig: (() => void) | undefined

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
      expect(transcript).toContain("[exit 0]")
    } finally {
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
