import { existsSync } from "node:fs"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, win32 } from "node:path"
import { fileURLToPath } from "node:url"
import { build as buildBundle } from "esbuild"
import { afterEach, describe, expect, test } from "vitest"

import { runBuildCommand } from "../src/commands/build.js"
import { setVercelTargetCleanupFileOpsForTesting } from "../src/lib/build/targets/vercel.js"
import {
  RECOMMENDED_VERCEL_CONFIG,
  reconcileVercelConfig,
  setVercelConfigFileOpsForTesting,
} from "../src/lib/build/targets/vercel-config.js"
import {
  isVercelPathWithin,
  publishVercelOutput,
  VERCEL_BUILD_OUTPUT_CONFIG,
  VERCEL_FUNCTION_CONFIG,
  validateVercelOutput,
  writeVercelMetadata,
} from "../src/lib/build/targets/vercel-output.js"
import { CliError, type CommandIo } from "../src/lib/output.js"

const tempDirs: string[] = []
const cliPackageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const DATABASE_URL_SENTINEL = "postgres://build-secret.invalid/never-bundle-this"
const PROJECT_FILE_CONTENTS = '{ "projectId": "preserved-project" }\n'
const ENV_FILE_CONTENTS = "PRESERVE_ME=yes\n"
const EXPECTED_RECOMMENDED_VERCEL_CONFIG = {
  $schema: "https://openapi.vercel.sh/vercel.json",
  buildCommand: "node node_modules/@dawn-ai/cli/dist/index.js build",
  fluid: true,
} as const
const EXPECTED_RECOMMENDED_VERCEL_CONFIG_JSON = `{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "node node_modules/@dawn-ai/cli/dist/index.js build",
  "fluid": true
}\n`

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createOutputDir(): Promise<string> {
  const outputDir = await mkdtemp(join(tmpdir(), "dawn-vercel-output-"))
  tempDirs.push(outputDir)
  return outputDir
}

async function createTargetFixture(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-vercel-target-"))
  tempDirs.push(appRoot)
  const appFiles = {
    "dawn.config.ts": 'export default { build: { targets: ["vercel"] } }\n',
    "package.json": `${JSON.stringify({
      dependencies: {
        "@dawn-ai/cli": "workspace:*",
        "@dawn-ai/postgres-storage": "workspace:*",
        "@neondatabase/serverless": "^1.1.0",
        hono: "^4.12.28",
      },
      name: "vercel-fixture",
    })}\n`,
    "src/app/probe/index.ts":
      'export async function workflow() { return { message: "deterministic" } }\n',
    ...files,
  }

  await Promise.all(
    Object.entries(appFiles).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )
  await linkTargetFixtureDependencies(appRoot)
  return appRoot
}

async function linkTargetFixtureDependencies(appRoot: string): Promise<void> {
  const dependencies = {
    "@dawn-ai/cli": cliPackageRoot,
    "@dawn-ai/postgres-storage": join(cliPackageRoot, "..", "postgres-storage"),
    "@neondatabase/serverless": join(cliPackageRoot, "node_modules", "@neondatabase", "serverless"),
    hono: join(cliPackageRoot, "node_modules", "hono"),
  } as const

  await Promise.all(
    Object.entries(dependencies).map(async ([specifier, target]) => {
      const dependencyPath = join(appRoot, "node_modules", specifier)
      await mkdir(dirname(dependencyPath), { recursive: true })
      await symlink(target, dependencyPath, "junction")
    }),
  )
}

async function runTargetBuild(appRoot: string): Promise<{ stderr: string[]; stdout: string[] }> {
  const stdout: string[] = []
  const stderr: string[] = []
  await runBuildCommand(
    { clean: true, cwd: appRoot },
    {
      stderr: (message) => stderr.push(message),
      stdout: (message) => stdout.push(message),
    },
  )
  return { stderr, stdout }
}

async function listTree(root: string): Promise<string[]> {
  const paths: string[] = []
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name
      if (entry.isDirectory()) await visit(join(directory, entry.name), relativePath)
      else paths.push(relativePath)
    }
  }
  await visit(root)
  return paths.sort()
}

async function createPublicationFixture(): Promise<{
  stagedOutput: string
  vercelDir: string
}> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-vercel-publish-"))
  tempDirs.push(appRoot)
  const vercelDir = join(appRoot, ".vercel")
  const stagedOutput = join(vercelDir, ".dawn-vercel-invocation", "output")
  await validOutput(stagedOutput)
  await seedUnrelatedVercelFiles(vercelDir)
  return { stagedOutput, vercelDir }
}

async function seedUnrelatedVercelFiles(vercelDir: string): Promise<void> {
  await mkdir(vercelDir, { recursive: true })
  await Promise.all([
    writeFile(join(vercelDir, "project.json"), PROJECT_FILE_CONTENTS),
    writeFile(join(vercelDir, ".env.preview.local"), ENV_FILE_CONTENTS),
  ])
}

async function expectUnrelatedVercelFilesPreserved(vercelDir: string): Promise<void> {
  await expect(readFile(join(vercelDir, "project.json"), "utf8")).resolves.toBe(
    PROJECT_FILE_CONTENTS,
  )
  await expect(readFile(join(vercelDir, ".env.preview.local"), "utf8")).resolves.toBe(
    ENV_FILE_CONTENTS,
  )
}

function isBackupPath(path: string): boolean {
  return path.includes(".dawn-vercel-output-backup-")
}

async function createVercelConfigDirs(): Promise<{ appRoot: string; buildDir: string }> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-vercel-app-"))
  const buildDir = await mkdtemp(join(tmpdir(), "dawn-vercel-build-"))
  tempDirs.push(appRoot, buildDir)
  return { appRoot, buildDir }
}

function collectIo(): { io: CommandIo; stderr: string[] } {
  const stderr: string[] = []
  return {
    io: { stderr: (message) => stderr.push(message), stdout: () => {} },
    stderr,
  }
}

function recommendedVercelConfig(): string {
  return EXPECTED_RECOMMENDED_VERCEL_CONFIG_JSON
}

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor)
  } else {
    Reflect.deleteProperty(target, key)
  }
}

function filesystemError(code: string): NodeJS.ErrnoException {
  const error = new Error(`injected ${code}`) as NodeJS.ErrnoException
  error.code = code
  return error
}

function createBarrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function functionDir(outputDir: string): string {
  return join(outputDir, "functions", "index.func")
}

function functionConfigPath(outputDir: string): string {
  return join(functionDir(outputDir), ".vc-config.json")
}

function entryPath(outputDir: string): string {
  return join(functionDir(outputDir), "index.mjs")
}

async function validOutput(outputDir: string): Promise<void> {
  await writeVercelMetadata(outputDir)
  await writeFile(entryPath(outputDir), 'import "node:fs"\nexport default {}\n', "utf8")
}

describe("complete Vercel target", () => {
  test("publishes the exact final tree and reports only final artifacts", async () => {
    const appRoot = await createTargetFixture()
    const priorDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = DATABASE_URL_SENTINEL

    let stdout: string[]
    let stderr: string[]
    try {
      ;({ stderr, stdout } = await runTargetBuild(appRoot))
    } finally {
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = priorDatabaseUrl
    }

    const outputDir = join(appRoot, ".vercel", "output")
    expect(stderr.join("")).toBe("")
    expect(await listTree(outputDir)).toEqual([
      "config.json",
      join("functions", "index.func", ".vc-config.json"),
      join("functions", "index.func", "index.mjs"),
    ])
    const report = stdout.join("")
    for (const finalPath of [
      join(".vercel", "output", "config.json"),
      join(".vercel", "output", "functions", "index.func", ".vc-config.json"),
      join(".vercel", "output", "functions", "index.func", "index.mjs"),
      "vercel.json",
    ]) {
      expect(report).toContain(finalPath)
    }
    expect(report).not.toContain(".dawn-vercel-")
    expect(report).not.toContain("output-backup")
    expect(existsSync(join(appRoot, "wrangler.toml"))).toBe(false)

    const bundle = await readFile(entryPath(outputDir), "utf8")
    expect(bundle).not.toContain(appRoot)
    expect(bundle).not.toContain(DATABASE_URL_SENTINEL)
  })

  test("preflights forbidden edge capabilities before creating .vercel", async () => {
    const appRoot = await createTargetFixture({
      "dawn.config.ts": `export default {
  build: { targets: ["vercel"] },
  sandbox: { provider: { name: "docker" } },
}
`,
    })

    await expect(runTargetBuild(appRoot)).rejects.toThrow(/"vercel".*sandbox/is)
    expect(existsSync(join(appRoot, ".vercel"))).toBe(false)
  })

  test("bundle resolution failure preserves prior output and unrelated Vercel files", async () => {
    const appRoot = await createTargetFixture({
      "src/app/probe/index.ts": `export async function workflow() {
  await import("missing-vercel-runtime-package")
  return { ok: true }
}
`,
    })
    const vercelDir = join(appRoot, ".vercel")
    const outputDir = join(vercelDir, "output")
    const priorEntry = "prior output bytes\n"
    const project = '{ "projectId": "project-1" }\n'
    const environment = "PRESERVE_ME=yes\n"
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, "prior.txt"), priorEntry)
    await writeFile(join(vercelDir, "project.json"), project)
    await writeFile(join(vercelDir, ".env.preview.local"), environment)

    await expect(runTargetBuild(appRoot)).rejects.toThrow(
      /missing-vercel-runtime-package.*function directory/is,
    )

    expect(await listTree(outputDir)).toEqual(["prior.txt"])
    await expect(readFile(join(outputDir, "prior.txt"), "utf8")).resolves.toBe(priorEntry)
    await expect(readFile(join(vercelDir, "project.json"), "utf8")).resolves.toBe(project)
    await expect(readFile(join(vercelDir, ".env.preview.local"), "utf8")).resolves.toBe(environment)
    expect((await readdir(vercelDir)).some((name) => name.startsWith(".dawn-vercel-"))).toBe(false)
  })

  test("invalid root config after staged validation preserves prior output and cleans staging", async () => {
    const appRoot = await createTargetFixture({
      "vercel.json": '{ "fluid": false }\n',
    })
    const vercelDir = join(appRoot, ".vercel")
    const outputDir = join(vercelDir, "output")
    const priorEntry = "prior output before config failure\n"
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, "prior.txt"), priorEntry)

    await expect(runTargetBuild(appRoot)).rejects.toThrow(/fluid: false.*fluid: true/i)

    expect(await listTree(outputDir)).toEqual(["prior.txt"])
    await expect(readFile(join(outputDir, "prior.txt"), "utf8")).resolves.toBe(priorEntry)
    expect((await readdir(vercelDir)).some((name) => name.startsWith(".dawn-vercel-"))).toBe(false)
  })

  test("reports invocation cleanup failure after publishing valid final output", async () => {
    const appRoot = await createTargetFixture()
    const vercelDir = join(appRoot, ".vercel")
    const cleanupError = filesystemError("EPERM")
    let invocationDir: string | undefined
    await seedUnrelatedVercelFiles(vercelDir)
    const restoreFileOps = setVercelTargetCleanupFileOpsForTesting({
      rm: async (path) => {
        invocationDir = String(path)
        throw cleanupError
      },
    })

    let error: unknown
    try {
      error = await runTargetBuild(appRoot).catch((caught: unknown) => caught)
    } finally {
      restoreFileOps()
    }

    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ cause: cleanupError })
    expect(String(error)).toMatch(/final output remains valid/i)
    expect(invocationDir).toBeDefined()
    expect(String(error)).toContain(invocationDir)
    expect(existsSync(invocationDir as string)).toBe(true)
    await expect(validateVercelOutput(join(vercelDir, "output"))).resolves.toBeUndefined()
    await expectUnrelatedVercelFilesPreserved(vercelDir)
  })

  test("preserves primary build failure when invocation cleanup also fails", async () => {
    const appRoot = await createTargetFixture({
      "src/app/probe/index.ts": `export async function workflow() {
  await import("missing-vercel-cleanup-package")
  return { ok: true }
}
`,
    })
    const vercelDir = join(appRoot, ".vercel")
    const cleanupError = filesystemError("EIO")
    let invocationDir: string | undefined
    await seedUnrelatedVercelFiles(vercelDir)
    const restoreFileOps = setVercelTargetCleanupFileOpsForTesting({
      rm: async (path) => {
        invocationDir = String(path)
        throw cleanupError
      },
    })

    let error: unknown
    try {
      error = await runTargetBuild(appRoot).catch((caught: unknown) => caught)
    } finally {
      restoreFileOps()
    }

    expect(error).toBeInstanceOf(AggregateError)
    const aggregate = error as AggregateError
    const [primaryError, retainedCleanupError] = aggregate.errors
    expect(primaryError).toBeInstanceOf(CliError)
    expect(String(primaryError)).toMatch(/missing-vercel-cleanup-package.*function directory/is)
    expect(retainedCleanupError).toBe(cleanupError)
    expect(aggregate.cause).toBe(primaryError)
    expect(String(aggregate)).toContain("missing-vercel-cleanup-package")
    expect(invocationDir).toBeDefined()
    expect(String(aggregate)).toContain(invocationDir)
    expect(existsSync(invocationDir as string)).toBe(true)
    await expectUnrelatedVercelFilesPreserved(vercelDir)
  })

  test("declares esbuild as a production dependency", async () => {
    const manifest = JSON.parse(await readFile(join(cliPackageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    expect(manifest.dependencies?.esbuild).toBe("^0.28.1")
    expect(manifest.devDependencies).not.toHaveProperty("esbuild")
  })

  test("selects only the Node or static default model importer for each bundle condition", async () => {
    const entry = join(cliPackageRoot, "..", "langchain", "dist", "chat-model-factory.js")
    const common = {
      bundle: true,
      entryPoints: [entry],
      format: "esm" as const,
      metafile: true,
      platform: "node" as const,
      write: false,
    }

    const nodeBundle = await buildBundle(common)
    const staticBundle = await buildBundle({
      ...common,
      conditions: ["dawn-static-provider-imports", "module"],
    })
    const selectedLoaders = (result: typeof nodeBundle) =>
      Object.keys(result.metafile?.inputs ?? {})
        .filter((path) => path.endsWith("model-importer.js"))
        .map((path) => basename(path))
        .sort()

    expect(selectedLoaders(nodeBundle)).toEqual(["default-model-importer.js"])
    expect(selectedLoaders(staticBundle)).toEqual(["static-model-importer.js"])
  })
})

describe("transactional Vercel output publication", () => {
  test("publishes the first output when no prior output exists", async () => {
    const fixture = await createPublicationFixture()

    await publishVercelOutput(fixture)

    expect(existsSync(fixture.stagedOutput)).toBe(false)
    await expect(validateVercelOutput(join(fixture.vercelDir, "output"))).resolves.toBeUndefined()
    await expectUnrelatedVercelFilesPreserved(fixture.vercelDir)
  })

  test("replaces prior output, removes its backup, and preserves unrelated files", async () => {
    const fixture = await createPublicationFixture()
    const outputDir = join(fixture.vercelDir, "output")
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, "old.txt"), "old bytes\n")

    await publishVercelOutput(fixture)

    await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
    await expectUnrelatedVercelFilesPreserved(fixture.vercelDir)
    expect((await readdir(fixture.vercelDir)).some(isBackupPath)).toBe(false)
  })

  test("an initial backup rename failure leaves the prior output untouched", async () => {
    const fixture = await createPublicationFixture()
    const outputDir = join(fixture.vercelDir, "output")
    const prior = "old exact bytes\n"
    const backupError = filesystemError("EACCES")
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, "old.txt"), prior)

    await expect(
      publishVercelOutput({
        ...fixture,
        fileOps: {
          rename: async (source, destination) => {
            if (source === outputDir && isBackupPath(String(destination))) throw backupError
            await rename(source, destination)
          },
          rm,
        },
      }),
    ).rejects.toMatchObject({ cause: backupError })
    await expect(readFile(join(outputDir, "old.txt"), "utf8")).resolves.toBe(prior)
    expect(existsSync(fixture.stagedOutput)).toBe(true)
    await expectUnrelatedVercelFilesPreserved(fixture.vercelDir)
  })

  test("a staged publication failure restores the exact prior output", async () => {
    const fixture = await createPublicationFixture()
    const outputDir = join(fixture.vercelDir, "output")
    const prior = "old exact bytes\n"
    const publicationError = filesystemError("EIO")
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, "old.txt"), prior)

    await expect(
      publishVercelOutput({
        ...fixture,
        fileOps: {
          rename: async (source, destination) => {
            if (source === fixture.stagedOutput && destination === outputDir) throw publicationError
            await rename(source, destination)
          },
          rm,
        },
      }),
    ).rejects.toMatchObject({ cause: publicationError })

    expect(await listTree(outputDir)).toEqual(["old.txt"])
    await expect(readFile(join(outputDir, "old.txt"), "utf8")).resolves.toBe(prior)
    expect((await readdir(fixture.vercelDir)).some(isBackupPath)).toBe(false)
    await expectUnrelatedVercelFilesPreserved(fixture.vercelDir)
  })

  test("a publication failure with no prior output leaves output absent", async () => {
    const fixture = await createPublicationFixture()
    const outputDir = join(fixture.vercelDir, "output")
    const publicationError = filesystemError("EIO")

    await expect(
      publishVercelOutput({
        ...fixture,
        fileOps: {
          rename: async (source, destination) => {
            if (source === fixture.stagedOutput && destination === outputDir) throw publicationError
            await rename(source, destination)
          },
          rm,
        },
      }),
    ).rejects.toMatchObject({ cause: publicationError })
    expect(existsSync(outputDir)).toBe(false)
    await expectUnrelatedVercelFilesPreserved(fixture.vercelDir)
  })

  test("backup cleanup failure keeps new output valid and the backup inspectable", async () => {
    const fixture = await createPublicationFixture()
    const outputDir = join(fixture.vercelDir, "output")
    const cleanupError = filesystemError("EIO")
    let backupPath: string | undefined
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, "old.txt"), "recoverable old bytes\n")

    await expect(
      publishVercelOutput({
        ...fixture,
        fileOps: {
          rename: async (source, destination) => {
            if (source === outputDir) backupPath = String(destination)
            await rename(source, destination)
          },
          rm: async (path, options) => {
            if (path === backupPath) throw cleanupError
            await rm(path, options)
          },
        },
      }),
    ).rejects.toMatchObject({
      cause: cleanupError,
      message: expect.stringMatching(/cleanup|remove.*backup/i),
    })

    await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
    expect(backupPath).toBeDefined()
    await expect(readFile(join(backupPath as string, "old.txt"), "utf8")).resolves.toBe(
      "recoverable old bytes\n",
    )
    await expectUnrelatedVercelFilesPreserved(fixture.vercelDir)
  })

  test("rollback failure preserves the primary cause, both errors, and backup path", async () => {
    const fixture = await createPublicationFixture()
    const outputDir = join(fixture.vercelDir, "output")
    const publicationError = filesystemError("EIO")
    const rollbackError = filesystemError("EPERM")
    let backupPath: string | undefined
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, "old.txt"), "recoverable old bytes\n")

    const error = await publishVercelOutput({
      ...fixture,
      fileOps: {
        rename: async (source, destination) => {
          if (source === outputDir) {
            backupPath = String(destination)
            await rename(source, destination)
            return
          }
          if (source === fixture.stagedOutput && destination === outputDir) throw publicationError
          if (source === backupPath && destination === outputDir) throw rollbackError
          await rename(source, destination)
        },
        rm,
      },
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AggregateError)
    expect(error).toMatchObject({ cause: publicationError })
    expect((error as AggregateError).errors).toEqual([publicationError, rollbackError])
    expect(String(error)).toContain(backupPath)
    await expect(readFile(join(backupPath as string, "old.txt"), "utf8")).resolves.toBe(
      "recoverable old bytes\n",
    )
    expect(existsSync(outputDir)).toBe(false)
    await expectUnrelatedVercelFilesPreserved(fixture.vercelDir)
  })

  test("overlapping publications clean only their own backups", async () => {
    const first = await createPublicationFixture()
    const outputDir = join(first.vercelDir, "output")
    const cleanupStarted = createBarrier()
    const releaseCleanup = createBarrier()
    const cleanupError = filesystemError("EIO")
    let firstBackup: string | undefined
    let secondBackup: string | undefined
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, "old.txt"), "first old bytes\n")
    await writeFile(
      entryPath(first.stagedOutput),
      'import "node:fs"\nexport const publication = "first"\nexport default {}\n',
      "utf8",
    )

    const firstPublication = publishVercelOutput({
      ...first,
      fileOps: {
        rename: async (source, destination) => {
          if (source === outputDir) firstBackup = String(destination)
          await rename(source, destination)
        },
        rm: async (path, options) => {
          if (path === firstBackup) {
            cleanupStarted.release()
            await releaseCleanup.promise
            throw cleanupError
          }
          await rm(path, options)
        },
      },
    }).catch((caught: unknown) => caught)

    await cleanupStarted.promise
    await expect(readFile(entryPath(outputDir), "utf8")).resolves.toContain('"first"')

    const secondStagedOutput = join(first.vercelDir, ".dawn-vercel-second", "output")
    await validOutput(secondStagedOutput)
    await writeFile(
      entryPath(secondStagedOutput),
      'import "node:fs"\nexport const publication = "second"\nexport default {}\n',
      "utf8",
    )
    try {
      await publishVercelOutput({
        stagedOutput: secondStagedOutput,
        vercelDir: first.vercelDir,
        fileOps: {
          rename: async (source, destination) => {
            if (source === outputDir) secondBackup = String(destination)
            await rename(source, destination)
          },
          rm,
        },
      })
    } finally {
      releaseCleanup.release()
    }

    const firstError = await firstPublication

    expect(firstError).toMatchObject({ cause: cleanupError })
    expect(firstBackup).toBeDefined()
    expect(secondBackup).toBeDefined()
    expect(secondBackup).not.toBe(firstBackup)
    await expect(readFile(join(firstBackup as string, "old.txt"), "utf8")).resolves.toBe(
      "first old bytes\n",
    )
    const backupPaths = (await readdir(first.vercelDir)).filter(isBackupPath)
    expect(backupPaths).toEqual([firstBackup ? basename(firstBackup) : undefined])
    await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
    await expect(readFile(entryPath(outputDir), "utf8")).resolves.toContain('"second"')
    expect(existsSync(first.stagedOutput)).toBe(false)
    expect(existsSync(secondStagedOutput)).toBe(false)
    expect(existsSync(secondBackup as string)).toBe(false)
    await expectUnrelatedVercelFilesPreserved(first.vercelDir)
  })
})

describe("Build Output contract", () => {
  test("writes the exact Build Output API v3 metadata without an entry module", async () => {
    const outputDir = await createOutputDir()

    const metadata = await writeVercelMetadata(outputDir)

    expect(VERCEL_BUILD_OUTPUT_CONFIG).toEqual({
      routes: [{ dest: "/index", src: "/(.*)" }],
      version: 3,
    })
    expect(VERCEL_FUNCTION_CONFIG).toEqual({
      handler: "index.mjs",
      launcherType: "Nodejs",
      runtime: "nodejs24.x",
    })
    expect(metadata).toEqual({
      configPath: join(outputDir, "config.json"),
      functionConfigPath: functionConfigPath(outputDir),
      functionDir: functionDir(outputDir),
    })
    await expect(readFile(metadata.configPath, "utf8")).resolves.toBe(
      '{\n  "routes": [\n    {\n      "dest": "/index",\n      "src": "/(.*)"\n    }\n  ],\n  "version": 3\n}\n',
    )
    await expect(readFile(metadata.functionConfigPath, "utf8")).resolves.toBe(
      '{\n  "handler": "index.mjs",\n  "launcherType": "Nodejs",\n  "runtime": "nodejs24.x"\n}\n',
    )
    await expect(lstat(entryPath(outputDir))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("accepts a complete self-contained function and in-tree dependency", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      'import "node:fs"\nimport { message } from "./message.mjs"\nexport { message }\n',
    )
    await writeFile(join(functionDir(outputDir), "message.mjs"), 'export const message = "ok"\n')

    await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
  })

  test("accepts a genuine safe Node builtin", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      'import { basename } from "node:path"\nexport { basename }\n',
    )

    await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
  })

  test.each(["node:test", "node:test/reporters", "node:sqlite"])(
    "accepts the prefix-only Node builtin %s",
    async (specifier) => {
      const outputDir = await createOutputDir()
      await validOutput(outputDir)
      await writeFile(entryPath(outputDir), `import "${specifier}"\n`)

      await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
    },
  )

  test("accepts an embedded data module bundled by esbuild", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      'import answer from "data:text/javascript,export default 42"\nexport { answer }\n',
    )

    await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
  })

  test.each([
    {
      expected: (outputDir: string) => join(outputDir, "config.json"),
      mutate: async (outputDir: string) => rm(join(outputDir, "config.json")),
      name: "missing config.json",
    },
    {
      expected: functionConfigPath,
      mutate: async (outputDir: string) => rm(functionConfigPath(outputDir)),
      name: "missing function config",
    },
    {
      expected: entryPath,
      mutate: async (outputDir: string) => rm(entryPath(outputDir)),
      name: "missing entry module",
    },
    {
      expected: (outputDir: string) => `${join(outputDir, "config.json")} property "version"`,
      mutate: async (outputDir: string) =>
        writeFile(
          join(outputDir, "config.json"),
          '{\n  "routes": [{ "src": "/(.*)", "dest": "/index" }],\n  "version": 2\n}\n',
        ),
      name: "wrong Build Output version",
    },
    {
      expected: (outputDir: string) => `${functionConfigPath(outputDir)} property "runtime"`,
      mutate: async (outputDir: string) =>
        writeFile(
          functionConfigPath(outputDir),
          '{\n  "handler": "index.mjs",\n  "launcherType": "Nodejs",\n  "runtime": "nodejs22.x"\n}\n',
        ),
      name: "wrong function runtime",
    },
    {
      expected: (outputDir: string) =>
        `${join(outputDir, "config.json")} property "routes[0].dest"`,
      mutate: async (outputDir: string) =>
        writeFile(
          join(outputDir, "config.json"),
          '{\n  "routes": [{ "src": "/(.*)", "dest": "/wrong" }],\n  "version": 3\n}\n',
        ),
      name: "wrong route destination",
    },
    {
      expected: (outputDir: string) => `${join(outputDir, "config.json")} property "extra"`,
      mutate: async (outputDir: string) =>
        writeFile(
          join(outputDir, "config.json"),
          '{\n  "routes": [{ "src": "/(.*)", "dest": "/index" }],\n  "version": 3,\n  "extra": true\n}\n',
        ),
      name: "extra root config property",
    },
    {
      expected: (outputDir: string) =>
        `${join(outputDir, "config.json")} property "routes[0].extra"`,
      mutate: async (outputDir: string) =>
        writeFile(
          join(outputDir, "config.json"),
          '{\n  "routes": [{ "src": "/(.*)", "dest": "/index", "extra": true }],\n  "version": 3\n}\n',
        ),
      name: "extra route property",
    },
    {
      expected: (outputDir: string) => `${functionConfigPath(outputDir)} property "extra"`,
      mutate: async (outputDir: string) =>
        writeFile(
          functionConfigPath(outputDir),
          '{\n  "handler": "index.mjs",\n  "launcherType": "Nodejs",\n  "runtime": "nodejs24.x",\n  "extra": true\n}\n',
        ),
      name: "extra function config property",
    },
    {
      expected: (outputDir: string) => join(outputDir, "config.json"),
      mutate: async (outputDir: string) => writeFile(join(outputDir, "config.json"), "not json\n"),
      name: "invalid config JSON",
    },
    {
      expected: entryPath,
      mutate: async (outputDir: string) => {
        await rm(entryPath(outputDir))
        await mkdir(entryPath(outputDir))
      },
      name: "entry module directory",
    },
  ])("rejects $name with the precise invalid location", async ({ expected, mutate }) => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await mutate(outputDir)

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(expected(outputDir))
  })

  test("rejects a function-tree symlink that resolves outside index.func", async () => {
    const outputDir = await createOutputDir()
    const outsideDir = await mkdtemp(join(tmpdir(), "dawn-vercel-outside-"))
    tempDirs.push(outsideDir)
    await validOutput(outputDir)
    const outsideFile = join(outsideDir, "outside.mjs")
    const linkedFile = join(functionDir(outputDir), "linked.mjs")
    await writeFile(outsideFile, "export default {}\n")
    await symlink(outsideFile, linkedFile)

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(linkedFile)
  })

  test("rejects an escaping relative entry dependency", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(entryPath(outputDir), 'import "../outside.mjs"\n')
    const escapingDependency = join(outputDir, "functions", "outside.mjs")
    await writeFile(escapingDependency, "export default {}\n")

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(escapingDependency)
  })

  test("rejects an escaping literal dynamic entry dependency", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(entryPath(outputDir), 'await import("../../outside.mjs")\n')
    const escapingDependency = join(outputDir, "outside.mjs")
    await writeFile(escapingDependency, "export default {}\n")

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(escapingDependency)
  })

  test.each([
    {
      source: 'import/**/"../../outside.mjs"\n',
      title: "static import",
    },
    {
      source: 'export/**/{ value }/**/from/**/"../../outside.mjs"\n',
      title: "re-export",
    },
    {
      source: 'await import/**/("../../outside.mjs")\n',
      title: "dynamic import",
    },
  ])("rejects a comment-separated escaping $title", async ({ source }) => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(entryPath(outputDir), source)
    const escapingDependency = join(outputDir, "outside.mjs")
    await writeFile(escapingDependency, "export const value = true\n")

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(escapingDependency)
  })

  test("rejects unresolved bare runtime package dependencies", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(entryPath(outputDir), 'import "unbundled-runtime-package"\n')

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(entryPath(outputDir))
  })

  test("rejects a comment-separated bare runtime package dependency", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(entryPath(outputDir), 'import/**/"unbundled-runtime-package"\n')

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(entryPath(outputDir))
  })

  test.each([
    { specifier: "https://example.com/runtime.mjs", title: "URL import" },
    { specifier: "node:not-a-real-builtin", title: "unknown node builtin" },
  ])("rejects an external $title", async ({ specifier }) => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(entryPath(outputDir), `import "${specifier}"\n`)

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(specifier)
  })

  test("rejects node:module runtime-loader access", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(join(outputDir, "outside.cjs"), "module.exports = 42\n")
    await writeFile(
      entryPath(outputDir),
      'import { createRequire } from "node:module"\nconst require = createRequire(import.meta.url)\nexport const answer = require("../../outside.cjs")\n',
    )

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(/runtime loader|node:module/)
  })

  test("rejects a nonliteral dynamic runtime dependency", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      'const dependency = "../../outside.mjs"\nawait import(dependency)\n',
    )

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(entryPath(outputDir))
  })

  test("rejects a nonliteral dynamic import in a template expression", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      `const dependency = "../../outside.mjs"
const value = \`\${/}/.test("}") ? import(dependency) : ""}\`
export { value }
`,
    )

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(entryPath(outputDir))
  })

  test("ignores an import-like regular expression literal", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      "const matcher = /import(variable)/\nexport { matcher }\n",
    )

    await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
  })

  test("ignores an object method named import", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      "const moduleFactory = { import(value) { return value } }\nexport { moduleFactory }\n",
    )

    await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
  })

  test("ignores import-like text in comments and strings", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      '// import "../../outside.mjs"\n/*\nimport "unbundled-runtime-package"\n*/\nconst note = `import("../../outside.mjs")`\nexport { note }\n',
    )

    await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
  })

  test("uses Windows semantics to reject cross-drive containment", () => {
    expect(isVercelPathWithin("C:\\output\\functions\\index.func", "D:\\outside.mjs", win32)).toBe(
      false,
    )
  })
})

describe("root vercel config", () => {
  test("writes the exact recommended config when the app has no root vercel.json", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const { io, stderr } = collectIo()

    expect(RECOMMENDED_VERCEL_CONFIG).toEqual(EXPECTED_RECOMMENDED_VERCEL_CONFIG)
    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
      artifactPath: rootPath,
      created: true,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(recommendedVercelConfig())
    await expect(readFile(referencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readdir(appRoot)).resolves.toEqual(["vercel.json"])
    expect(stderr).toEqual([])
  })

  test("preserves the generated root config on a second call", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    await reconcileVercelConfig({ appRoot, buildDir })
    const firstContents = await readFile(rootPath, "utf8")

    await expect(reconcileVercelConfig({ appRoot, buildDir })).resolves.toEqual({
      artifactPath: rootPath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(firstContents)
  })

  test("rejects a broken root symlink without creating its external target", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const outsideDir = await mkdtemp(join(tmpdir(), "dawn-vercel-outside-"))
    const externalPath = join(outsideDir, "vercel.json")
    tempDirs.push(outsideDir)
    await symlink(externalPath, rootPath)

    try {
      await reconcileVercelConfig({ appRoot, buildDir })
      throw new Error("expected broken root symlink to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(CliError)
      expect(error).toMatchObject({ message: expect.stringContaining(rootPath) })
      expect((error as CliError).cause).toBeDefined()
    }
    await expect(lstat(rootPath)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) })
    expect((await lstat(rootPath)).isSymbolicLink()).toBe(true)
    await expect(lstat(externalPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readdir(appRoot)).resolves.toEqual(["vercel.json"])
  })

  test("atomically replaces an existing reference symlink without changing its target", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const outsideDir = await mkdtemp(join(tmpdir(), "dawn-vercel-outside-"))
    const externalPath = join(outsideDir, "preserved.json")
    const externalContents = "external content\n"
    tempDirs.push(outsideDir)
    await writeFile(rootPath, '{ "buildCommand": "unknown", "fluid": true }\n')
    await writeFile(externalPath, externalContents)
    await symlink(externalPath, referencePath)

    await expect(reconcileVercelConfig({ appRoot, buildDir })).resolves.toEqual({
      artifactPath: referencePath,
      created: false,
    })
    expect((await lstat(referencePath)).isSymbolicLink()).toBe(false)
    await expect(readFile(referencePath, "utf8")).resolves.toBe(recommendedVercelConfig())
    await expect(readFile(externalPath, "utf8")).resolves.toBe(externalContents)
  })

  test("reconciles a compliant root created by a root publication race", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const racedContents =
      '{ "fluid": true, "buildCommand": "node node_modules/@dawn-ai/cli/dist/index.js build" }\n'
    const linkError = filesystemError("EEXIST")
    const { io, stderr } = collectIo()
    const restoreFileOps = setVercelConfigFileOpsForTesting({
      link: async (_temporaryPath, destinationPath) => {
        expect(destinationPath).toBe(rootPath)
        await writeFile(rootPath, racedContents)
        throw linkError
      },
    })

    try {
      await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
        artifactPath: rootPath,
        created: false,
      })
    } finally {
      restoreFileOps()
    }
    await expect(readFile(rootPath, "utf8")).resolves.toBe(racedContents)
    await expect(readFile(referencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readdir(appRoot)).resolves.toEqual(["vercel.json"])
    expect(stderr).toEqual([])
  })

  test.each(["temporary write", "hard-link publication"])(
    "cleans the root temporary file when %s fails",
    async (failurePoint) => {
      const { appRoot, buildDir } = await createVercelConfigDirs()
      const rootPath = join(appRoot, "vercel.json")
      const injectedError = filesystemError("EIO")
      const restoreFileOps = setVercelConfigFileOpsForTesting(
        failurePoint === "temporary write"
          ? { writeFile: async () => await Promise.reject(injectedError) }
          : { link: async () => await Promise.reject(injectedError) },
      )

      try {
        await expect(reconcileVercelConfig({ appRoot, buildDir })).rejects.toMatchObject({
          cause: injectedError,
          message: expect.stringContaining(rootPath),
        })
      } finally {
        restoreFileOps()
      }
      await expect(lstat(rootPath)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(readdir(appRoot)).resolves.toEqual([])
    },
  )

  test.each(["temporary write", "rename publication"])(
    "preserves the existing reference and cleans the temporary file when %s fails",
    async (failurePoint) => {
      const { appRoot, buildDir } = await createVercelConfigDirs()
      const rootPath = join(appRoot, "vercel.json")
      const referencePath = join(buildDir, "vercel.json")
      const priorReference = "previous reference\n"
      const injectedError = filesystemError("EIO")
      await writeFile(rootPath, '{ "buildCommand": "unknown", "fluid": true }\n')
      await writeFile(referencePath, priorReference)
      const restoreFileOps = setVercelConfigFileOpsForTesting(
        failurePoint === "temporary write"
          ? { writeFile: async () => await Promise.reject(injectedError) }
          : { rename: async () => await Promise.reject(injectedError) },
      )

      try {
        await expect(reconcileVercelConfig({ appRoot, buildDir })).rejects.toMatchObject({
          cause: injectedError,
          message: expect.stringContaining(referencePath),
        })
      } finally {
        restoreFileOps()
      }
      await expect(readFile(referencePath, "utf8")).resolves.toBe(priorReference)
      await expect(readdir(buildDir)).resolves.toEqual(["vercel.json"])
    },
  )

  test("does not invoke root publication writes for an existing compliant root", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const contents =
      '{ "fluid": true, "buildCommand": "node node_modules/@dawn-ai/cli/dist/index.js build" }\n'
    const unexpectedWrite = new Error("root publication should not write")
    await writeFile(rootPath, contents)
    const restoreFileOps = setVercelConfigFileOpsForTesting({
      writeFile: async () => await Promise.reject(unexpectedWrite),
    })

    try {
      await expect(reconcileVercelConfig({ appRoot, buildDir })).resolves.toEqual({
        artifactPath: rootPath,
        created: false,
      })
    } finally {
      restoreFileOps()
    }
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
  })

  test("preserves a compliant root config byte-for-byte without a warning or reference", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents =
      '{ "fluid": true, "buildCommand": "node node_modules/@dawn-ai/cli/dist/index.js build" }\n'
    const { io, stderr } = collectIo()
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
      artifactPath: rootPath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(stderr).toEqual([])
  })

  test.each([
    ["spaces", " node  node_modules/@dawn-ai/cli/dist/index.js   build "],
    ["tabs", "\tnode\t node_modules/@dawn-ai/cli/dist/index.js\tbuild\t"],
  ])("accepts a direct command with only ASCII %s", async (_kind, buildCommand) => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = `${JSON.stringify({ buildCommand, fluid: true }, null, 2)}\n`
    const { io, stderr } = collectIo()
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
      artifactPath: rootPath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(stderr).toEqual([])
  })

  test.each([
    ["non-breaking space", "\u00a0node node_modules/@dawn-ai/cli/dist/index.js build"],
    ["form-feed", "\fnode node_modules/@dawn-ai/cli/dist/index.js build"],
    ["carriage return", "node node_modules/@dawn-ai/cli/dist/index.js build\r"],
    ["line feed", "node node_modules/@dawn-ai/cli/dist/index.js build\n"],
    ["command chain", "node node_modules/@dawn-ai/cli/dist/index.js build && echo nope"],
    ["semicolon", "node node_modules/@dawn-ai/cli/dist/index.js build; echo nope"],
    ["extra argument", "node node_modules/@dawn-ai/cli/dist/index.js build --prod"],
    ["environment prefix", "DAWN=1 node node_modules/@dawn-ai/cli/dist/index.js build"],
    ["alternate path", "node ./node_modules/@dawn-ai/cli/dist/index.js build"],
  ])("writes a reference and warning for a %s command variant", async (_kind, buildCommand) => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = `${JSON.stringify({ buildCommand, fluid: true }, null, 2)}\n`
    const { io, stderr } = collectIo()
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
      artifactPath: referencePath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).resolves.toBe(recommendedVercelConfig())
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain(rootPath)
    expect(stderr[0]).toContain(referencePath)
  })

  test("does not establish or conflict with inherited build and fluid contracts", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = "{}\n"
    const { io, stderr } = collectIo()
    const buildCommandDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "buildCommand")
    const fluidDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "fluid")
    await writeFile(rootPath, contents)

    try {
      Object.defineProperty(Object.prototype, "buildCommand", {
        configurable: true,
        value: "node node_modules/@dawn-ai/cli/dist/index.js build",
      })
      Object.defineProperty(Object.prototype, "fluid", { configurable: true, value: false })

      await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
        artifactPath: referencePath,
        created: false,
      })
      await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
      await expect(readFile(referencePath, "utf8")).resolves.toBe(recommendedVercelConfig())
      expect(stderr).toHaveLength(1)
      expect(stderr[0]).toContain("buildCommand")
      expect(stderr[0]).toContain("fluid")
    } finally {
      restoreProperty(Object.prototype, "buildCommand", buildCommandDescriptor)
      restoreProperty(Object.prototype, "fluid", fluidDescriptor)
    }
  })

  test("leaves extra valid user settings authoritative", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = `{
  "buildCommand": "node node_modules/@dawn-ai/cli/dist/index.js build",
  "fluid": true,
  "regions": ["sfo1"],
  "headers": [{ "source": "/(.*)", "headers": [{ "key": "x-user", "value": "kept" }] }]
}\n`
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir })).resolves.toEqual({
      artifactPath: rootPath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  test.each([
    ["missing", { fluid: true }],
    ["unknown", { buildCommand: "dawn build", fluid: true }],
    ["non-string", { buildCommand: 42, fluid: true }],
  ])("writes one reference and warning for a %s build command", async (_kind, config) => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = `${JSON.stringify(config, null, 2)}\n`
    const { io, stderr } = collectIo()
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
      artifactPath: referencePath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).resolves.toBe(recommendedVercelConfig())
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain(rootPath)
    expect(stderr[0]).toContain(referencePath)
    expect(stderr[0]).toContain("buildCommand")
  })

  test.each([
    ["omitted", { buildCommand: "node node_modules/@dawn-ai/cli/dist/index.js build" }],
    [
      "non-true",
      { buildCommand: "node node_modules/@dawn-ai/cli/dist/index.js build", fluid: "true" },
    ],
  ])("writes a portability warning when fluid is %s", async (_kind, config) => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = `${JSON.stringify(config, null, 2)}\n`
    const { io, stderr } = collectIo()
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
      artifactPath: referencePath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).resolves.toBe(recommendedVercelConfig())
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain("fluid")
    expect(stderr[0]).toMatch(/portability/i)
    expect(stderr[0]).toMatch(/Dashboard defaults.*do not establish.*committed contract/i)
  })

  test("consolidates missing build and fluid contracts into one warning", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = '{\n  "regions": ["sfo1"]\n}\n'
    const { io, stderr } = collectIo()
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
      artifactPath: referencePath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain("buildCommand")
    expect(stderr[0]).toContain("fluid")
  })

  test("fails on explicit fluid false without changing the root or writing a reference", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents =
      '{ "buildCommand": "node node_modules/@dawn-ai/cli/dist/index.js build", "fluid": false }\n'
    const { io, stderr } = collectIo()
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).rejects.toThrow(
      /supported lifecycle.*fluid: true/i,
    )
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(stderr).toEqual([])
  })

  test("fails for invalid root JSON with its path and parse error as the cause", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = "{ invalid json\n"
    await writeFile(rootPath, contents)

    try {
      await reconcileVercelConfig({ appRoot, buildDir })
      throw new Error("expected invalid JSON to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(CliError)
      expect(error).toMatchObject({ message: expect.stringContaining(rootPath) })
      expect((error as CliError).cause).toBeInstanceOf(SyntaxError)
    }
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("still writes a reference for an unproven config when no io is supplied", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = '{ "buildCommand": "dawn build", "fluid": true }\n'
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir })).resolves.toEqual({
      artifactPath: referencePath,
      created: false,
    })
    await expect(readFile(referencePath, "utf8")).resolves.toBe(recommendedVercelConfig())
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
  })
})
