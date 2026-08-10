import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { getTestRegistryUrl } from "./local-registry.ts"
import {
  installRegistryScaffolderWithNpm,
  runPackagedCommand,
  withPackagedNpmServer,
} from "./packaged-app.ts"

function setTestEnvironmentVariable(name: string, value: string): () => void {
  const previousValue = Reflect.get(process.env, name)
  Reflect.set(process.env, name, value)

  return () => {
    if (typeof previousValue === "string") {
      Reflect.set(process.env, name, previousValue)
    } else {
      Reflect.deleteProperty(process.env, name)
    }
  }
}

async function createNpmServerFixture(prefix: string): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), prefix))
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
      'await writeFile(new URL("./observed.json", import.meta.url), JSON.stringify({ args, host, mode, port, unsetEnv: process.env.DAWN_TEST_SERVER_UNSET_ENV ?? "missing" }))',
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

async function readObservedServer(appRoot: string): Promise<{
  readonly args: readonly string[]
  readonly host?: string
  readonly mode: string
  readonly port: number
  readonly unsetEnv: string
}> {
  return JSON.parse(await readFile(join(appRoot, "observed.json"), "utf8")) as {
    readonly args: readonly string[]
    readonly host?: string
    readonly mode: string
    readonly port: number
    readonly unsetEnv: string
  }
}

async function expectServerStopped(url: string): Promise<void> {
  await expect(fetch(new URL("/healthz", url))).rejects.toThrow()
}

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

describe("installRegistryScaffolderWithNpm", () => {
  it("installs the latest registry scaffolder with npm and records a transcript", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dawn-npm-scaffolder-"))
    const transcriptPath = join(tempRoot, "install.log")

    try {
      const { installerDir } = await installRegistryScaffolderWithNpm({
        tempRoot,
        transcriptPath,
      })

      await expect(readFile(join(installerDir, "package.json"), "utf8")).resolves.toContain(
        '"private": true',
      )
      await expect(readFile(join(installerDir, ".npmrc"), "utf8")).resolves.toContain(
        `registry=${getTestRegistryUrl()}`,
      )
      await expect(
        readFile(join(installerDir, "node_modules", "create-dawn-ai-app", "package.json"), "utf8"),
      ).resolves.toContain('"name": "create-dawn-ai-app"')

      const transcript = await readFile(transcriptPath, "utf8")
      expect(transcript).toContain(
        `$ (cd ${installerDir} && npm install --no-save create-dawn-ai-app@latest)`,
      )
      expect(transcript).toContain("[exit 0]")
    } finally {
      await rm(tempRoot, { force: true, recursive: true })
    }
  })
})

describe("withPackagedNpmServer", () => {
  it.skipIf(process.platform !== "win32")(
    "launches npm scripts through the native Windows command shim",
    async () => {
      const appRoot = await createNpmServerFixture("dawn-npm-windows-server-")
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
        await rm(appRoot, { force: true, recursive: true })
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

  it.skipIf(process.platform === "win32")(
    "preserves the asynchronous npm spawn error and transcript",
    async () => {
      const appRoot = await createNpmServerFixture("dawn-npm-spawn-error-")
      const emptyPath = join(appRoot, "empty-path")
      const transcriptPath = join(appRoot, "spawn-error.log")
      let thrown: unknown

      await mkdir(emptyPath)

      try {
        try {
          await withPackagedNpmServer(
            {
              appRoot,
              env: { PATH: emptyPath },
              script: "start",
              transcriptPath,
            },
            async () => {
              throw new Error("action must not run")
            },
          )
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
        await rm(appRoot, { force: true, recursive: true })
      }
    },
  )

  it("passes dev arguments after npm's separator and cleans up after returning", async () => {
    const appRoot = await createNpmServerFixture("dawn-npm-dev-server-")
    const transcriptPath = join(appRoot, "dev.log")
    const restoreEnv = setTestEnvironmentVariable("DAWN_TEST_SERVER_UNSET_ENV", "inherited")
    let serverUrl = ""

    try {
      const result = await withPackagedNpmServer(
        {
          appRoot,
          env: { DAWN_TEST_SERVER_UNSET_ENV: "override" },
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
