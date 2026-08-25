#!/usr/bin/env node

import { writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import {
  makeTempDir,
  publicNpmEnvironment,
  removeDir,
  run,
} from "../../lib/published-artifacts.mjs"
import {
  parseDockerMappedHostPort,
  pgvectorDatabaseUrl,
  runRuntimeSmoke,
} from "../../published-artifact-smoke.mjs"
import { executeSmokeLane, parseSmokeLaneArgs } from "../smoke-result.mjs"

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024

export async function runStorageSmoke(options, overrides = {}) {
  const dependencies = {
    makeTempDir,
    removeDir,
    runCommand: defaultRunCommand,
    runPgvectorProbe: defaultPgvectorProbe,
    runPostgresProbe: defaultPostgresProbe,
    startDatabase: startDisposableDatabase,
    stopContainer: defaultStopContainer,
    ...overrides,
  }
  const nonce = `${process.pid}-${Date.now()}`

  return executeSmokeLane(
    { lane: "storage", ...options },
    async ({ check, deferCleanup }) => {
      const root = await check("temporary-project", "clean storage consumer created", () =>
        dependencies.makeTempDir("dawn-published-storage-"),
      )
      deferCleanup("cleanup-project", "storage consumer removed", () =>
        dependencies.removeDir(root),
      )

      await check("docker", "Docker daemon is available", () =>
        dependencies.runCommand("docker", ["info"]),
      )
      await check("exact-install", "exact storage packages installed from public npm", async () => {
        await dependencies.runCommand("npm", ["init", "-y"], { cwd: root })
        await dependencies.runCommand(
          "npm",
          [
            "install",
            "--save-exact",
            "--package-lock=false",
            `@dawn-ai/memory-pgvector@${options.version}`,
            `@dawn-ai/langchain@${options.version}`,
            `@dawn-ai/postgres-storage@${options.version}`,
          ],
          { cwd: root },
        )
      })

      const pgvectorContainer = `dawn-storage-pgvector-${nonce}`
      const pgvectorUrl = await check(
        "pgvector-database",
        "disposable pgvector database ready",
        () =>
          dependencies.startDatabase({
            kind: "pgvector",
            containerName: pgvectorContainer,
            image: "pgvector/pgvector:pg16",
          }),
      )
      deferCleanup("cleanup-pgvector", "pgvector container removed", () =>
        dependencies.stopContainer(pgvectorContainer),
      )
      await check("pgvector-runtime", "pgvector exact-package runtime passed", () =>
        dependencies.runPgvectorProbe(root, pgvectorUrl),
      )

      const postgresContainer = `dawn-storage-postgres-${nonce}`
      const postgresUrl = await check(
        "postgres-database",
        "disposable Postgres database ready",
        () =>
          dependencies.startDatabase({
            kind: "postgres",
            containerName: postgresContainer,
            image: "postgres:16",
          }),
      )
      deferCleanup("cleanup-postgres", "Postgres container removed", () =>
        dependencies.stopContainer(postgresContainer),
      )
      await check("postgres-runtime", "Postgres storage exact-package runtime passed", () =>
        dependencies.runPostgresProbe(root, postgresUrl),
      )
    },
    overrides,
  )
}

export async function startDisposableDatabase(
  { containerName, image },
  { attempts = 60, runCommand = defaultRunCommand, sleep = defaultSleep } = {},
) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60) {
    throw new TypeError("Database readiness attempts must be between 1 and 60")
  }
  let started = false
  try {
    await runCommand("docker", [
      "run",
      "-d",
      "--name",
      containerName,
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-p",
      "127.0.0.1::5432",
      image,
    ])
    started = true
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await runCommand("docker", ["exec", containerName, "pg_isready", "-U", "postgres"])
        const mapped = await runCommand("docker", ["port", containerName, "5432/tcp"])
        return pgvectorDatabaseUrl(parseDockerMappedHostPort(mapped.stdout))
      } catch (error) {
        lastError = error
        if (attempt < attempts) await sleep(500)
      }
    }
    throw new Error(`Database container did not become ready: ${lastError?.message ?? "unknown"}`)
  } catch (error) {
    if (!started) throw error
    try {
      await runCommand("docker", ["rm", "-f", containerName])
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Database startup failed and container cleanup failed: ${error.message}; ${cleanupError.message}`,
      )
    }
    throw error
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function defaultStopContainer(name) {
  await defaultRunCommand("docker", ["rm", "-f", name])
}

async function defaultPgvectorProbe(root, databaseUrl) {
  await runRuntimeSmoke(root, { databaseUrl, openai: false }, { runCommand: defaultRunCommand })
}

async function defaultPostgresProbe(root, databaseUrl) {
  const sourcePath = path.join(root, "postgres-storage-smoke.mjs")
  await writeFile(sourcePath, postgresProbeSource(), "utf8")
  await defaultRunCommand("node", [sourcePath], {
    cwd: root,
    env: {
      DATABASE_URL: databaseUrl,
      SMOKE_TABLE_PREFIX: `dawn_published_postgres_${process.pid}_${Date.now()}`,
    },
  })
}

export function postgresProbeSource() {
  return `import assert from "node:assert/strict"
import { createPostgresThreadsStore } from "@dawn-ai/postgres-storage/node"

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString, "DATABASE_URL is required")
const store = createPostgresThreadsStore({
  connectionString,
  tablePrefix: process.env.SMOKE_TABLE_PREFIX,
})
try {
  const created = await store.createThread({ thread_id: "published-storage", metadata: { exact: true } })
  assert.equal(created.thread_id, "published-storage")
  assert.equal((await store.getThread("published-storage"))?.metadata?.exact, true)
} finally {
  await store.close()
}
`
}

async function defaultRunCommand(command, args, options = {}) {
  const stdout = await run(command, args, {
    ...options,
    env: publicNpmEnvironment({
      home: options.cwd ?? process.cwd(),
      extra: options.env,
    }),
    replaceEnv: true,
    stdio: "pipe",
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: COMMAND_OUTPUT_BYTES,
  })
  return { stdout, stderr: "" }
}

async function main() {
  await runStorageSmoke(parseSmokeLaneArgs(process.argv.slice(2)))
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    console.error(`STORAGE SMOKE FAIL ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
