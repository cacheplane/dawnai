#!/usr/bin/env node

import { randomUUID as defaultRandomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { makeTempDir, publicNpmEnvironment, removeDir } from "../../lib/published-artifacts.mjs"
import {
  parseDockerMappedHostPort,
  pgvectorDatabaseUrl,
  runRuntimeSmoke,
} from "../../published-artifact-smoke.mjs"
import {
  createStrictSmokeProcessRunner,
  strictContainmentReceiptDetail,
} from "../smoke-process-runner.mjs"
import { executeSmokeLane, parseSmokeLaneArgs } from "../smoke-result.mjs"
import { dockerUuidToken, removeAndVerifyDockerResource } from "./docker-identity.mjs"

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024

export async function runStorageSmoke(options, overrides = {}) {
  if (overrides.runCommand !== undefined || overrides.probeContainment !== undefined) {
    throw new TypeError("Storage smoke command execution requires a strictRunner")
  }
  const strictRunner = overrides.strictRunner ?? createStrictSmokeProcessRunner()
  const runCommand = (command, args, runOptions) =>
    strictRunner.runCommand(command, args, productionCommandOptions(runOptions))
  const dependencies = {
    makeTempDir,
    randomUUID: defaultRandomUUID,
    removeDir,
    runPgvectorProbe: (root, databaseUrl) => defaultPgvectorProbe(root, databaseUrl, runCommand),
    runPostgresProbe: (root, databaseUrl) => defaultPostgresProbe(root, databaseUrl, runCommand),
    startDatabase: (database) => startDisposableDatabase(database, { runCommand }),
    stopContainer: (name) => cleanupStorageContainer(name, { runCommand }),
    ...overrides,
    probeContainment: strictRunner.probe,
    runCommand,
  }
  const identities = storageDockerIdentities(dependencies.randomUUID)
  const pgvectorContainer = identities.pgvector
  const postgresContainer = identities.postgres

  return executeSmokeLane(
    { lane: "storage", ...options },
    async ({ check, deferCleanup }) => {
      await check(
        "containment",
        strictContainmentReceiptDetail(dependencies.env),
        dependencies.probeContainment,
      )
      const root = await check("temporary-project", "clean storage consumer created", () =>
        dependencies.makeTempDir("dawn-published-storage-"),
      )
      deferCleanup("cleanup-project", "storage consumer removed", () =>
        dependencies.removeDir(root),
      )
      deferCleanup("cleanup-pgvector", "pgvector container removed", () =>
        dependencies.stopContainer(pgvectorContainer),
      )
      deferCleanup("cleanup-postgres", "Postgres container removed", () =>
        dependencies.stopContainer(postgresContainer),
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
      await check("pgvector-runtime", "pgvector exact-package runtime passed", () =>
        dependencies.runPgvectorProbe(root, pgvectorUrl),
      )

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
      await check("postgres-runtime", "Postgres storage exact-package runtime passed", () =>
        dependencies.runPostgresProbe(root, postgresUrl),
      )
    },
    overrides,
  )
}

export function storageDockerIdentities(randomUUID = defaultRandomUUID) {
  const token = dockerUuidToken(randomUUID, "Storage Docker probe")
  return Object.freeze({
    pgvector: `dawn-storage-pgvector-${token}`,
    postgres: `dawn-storage-postgres-${token}`,
  })
}

export async function startDisposableDatabase(
  { containerName, image },
  { attempts = 60, runCommand, sleep = defaultSleep } = {},
) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60) {
    throw new TypeError("Database readiness attempts must be between 1 and 60")
  }
  if (typeof runCommand !== "function") {
    throw new TypeError("Database command execution requires a strict runner")
  }
  assertDatabaseDockerIdentity(containerName, image)
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
    try {
      await removeAndVerifyDockerResource({ kind: "container", name: containerName, runCommand })
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

export async function cleanupStorageContainer(name, { runCommand } = {}) {
  if (!/^dawn-storage-(?:pgvector|postgres)-[0-9a-f]{32}$/u.test(name)) {
    throw new TypeError("Storage Docker container identity is invalid")
  }
  await removeAndVerifyDockerResource({ kind: "container", name, runCommand })
}

function assertDatabaseDockerIdentity(containerName, image) {
  if (
    typeof containerName !== "string" ||
    !/^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(containerName) ||
    !["postgres:16", "pgvector/pgvector:pg16"].includes(image)
  ) {
    throw new TypeError("Disposable database Docker identity is invalid")
  }
}

async function defaultPgvectorProbe(root, databaseUrl, runCommand) {
  await runRuntimeSmoke(root, { databaseUrl, openai: false }, { runCommand })
}

async function defaultPostgresProbe(root, databaseUrl, runCommand) {
  const sourcePath = path.join(root, "postgres-storage-smoke.mjs")
  await writeFile(sourcePath, postgresProbeSource(), "utf8")
  await runCommand("node", [sourcePath], {
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

function productionCommandOptions(options = {}) {
  return {
    ...options,
    env: publicNpmEnvironment({
      home: options.cwd ?? process.cwd(),
      extra: options.env,
    }),
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: COMMAND_OUTPUT_BYTES,
  }
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
