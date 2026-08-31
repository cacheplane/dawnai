import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"
import { resolveTemplateDir, TEMPLATE_NAMES } from "../src/templates.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const serverExampleRoot = resolve(repoRoot, "examples/research/server")
const webExampleRoot = resolve(repoRoot, "examples/research/web")

const SERVER_PARITY_ROOTS = [
  ".env.example",
  "AGENTS.md",
  "dawn.config.ts",
  "src",
  "test",
  "workspace",
] as const
const RESEARCH_PARITY_RUNTIME_PATHS = ["workspace/tool-outputs", "workspace/reports"] as const

const SERVER_PARITY_IGNORED_PATHS = new Set(["workspace/reports", "workspace/tool-outputs"])

const WEB_PARITY_ROOTS = [
  ".env.example",
  ".gitignore",
  "app",
  "next.config.mjs",
  "postcss.config.mjs",
  "tsconfig.json",
  "vitest.config.ts",
] as const

const WEB_PARITY_IGNORED_PATHS = new Set<string>()

/**
 * A parity scope pins the comparison to one example/template tree pair.
 *
 * `roots` is an allowlist, not a convenience: files outside it (`package.json`,
 * `README.md`) carry generation tokens and are deliberately excluded from the
 * byte comparison. Passing the wrong scope silently compares an empty set, so
 * every {@link compareParityTrees} caller states its scope explicitly.
 */
interface ParityScope {
  readonly ignoredPaths: ReadonlySet<string>
  readonly roots: readonly string[]
}

const SERVER_PARITY_SCOPE: ParityScope = {
  ignoredPaths: SERVER_PARITY_IGNORED_PATHS,
  roots: SERVER_PARITY_ROOTS,
}

const WEB_PARITY_SCOPE: ParityScope = {
  ignoredPaths: WEB_PARITY_IGNORED_PATHS,
  roots: WEB_PARITY_ROOTS,
}

interface ParityEntry {
  readonly kind: "directory" | "file"
  readonly normalizedPath: string
  readonly physicalPath: string
}

interface ParityReport {
  readonly contentDriftedPaths: readonly string[]
  readonly missingTemplatePaths: readonly string[]
  readonly normalizedPathCollisions: readonly {
    normalizedPath: string
    physicalPaths: readonly string[]
    side: "example" | "template"
  }[]
  readonly unexpectedTemplatePaths: readonly string[]
}

function normalizeParitySegment(segment: string, normalizeTemplateSuffix: boolean): string {
  if (!normalizeTemplateSuffix) return segment
  if (segment === "npmrc.template") return ".npmrc"
  if (segment === "gitignore.template") return ".gitignore"
  return segment.endsWith(".template") ? segment.slice(0, -".template".length) : segment
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function isRuntimeParityPath(normalizedPath: string): boolean {
  return RESEARCH_PARITY_RUNTIME_PATHS.some(
    (runtimePath) => normalizedPath === runtimePath || normalizedPath.startsWith(`${runtimePath}/`),
  )
}

async function inventoryParityTree(
  root: string,
  options: { readonly normalizeTemplateSuffix: boolean; readonly scope: ParityScope },
): Promise<readonly ParityEntry[]> {
  const entries: ParityEntry[] = []

  async function visit(
    physicalSegments: readonly string[],
    normalizedSegments: readonly string[],
  ): Promise<void> {
    const physicalPath = physicalSegments.join("/")
    const normalizedPath = normalizedSegments.join("/")
    if (options.scope.ignoredPaths.has(normalizedPath)) return
    const stats = await lstat(join(root, ...physicalSegments)).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined
      throw error
    })

    if (stats === undefined) return

    const kind = stats.isDirectory() ? "directory" : "file"
    entries.push({ kind, normalizedPath, physicalPath })

    if (kind === "file") return

    const childNames = await readdir(join(root, ...physicalSegments))
    childNames.sort(compareCodeUnits)

    for (const childName of childNames) {
      await visit(
        [...physicalSegments, childName],
        [...normalizedSegments, normalizeParitySegment(childName, options.normalizeTemplateSuffix)],
      )
    }
  }

  if (options.normalizeTemplateSuffix) {
    const parityRoots = new Set<string>(options.scope.roots)
    const physicalRootNames = await readdir(root).catch((error: unknown) => {
      if (isMissingPathError(error)) return []
      throw error
    })

    physicalRootNames.sort(compareCodeUnits)
    for (const physicalRootName of physicalRootNames) {
      const normalizedRootName = normalizeParitySegment(physicalRootName, true)
      if (parityRoots.has(normalizedRootName)) {
        await visit([physicalRootName], [normalizedRootName])
      }
    }
  } else {
    for (const parityRoot of options.scope.roots) {
      await visit([parityRoot], [parityRoot])
    }
  }

  return entries.sort(
    (left, right) =>
      compareCodeUnits(left.normalizedPath, right.normalizedPath) ||
      compareCodeUnits(left.physicalPath, right.physicalPath),
  )
}

async function compareParityTrees(
  exampleRoot: string,
  templateRoot: string,
  scope: ParityScope,
): Promise<ParityReport> {
  const [exampleEntries, templateEntries] = await Promise.all([
    inventoryParityTree(exampleRoot, { normalizeTemplateSuffix: false, scope }),
    inventoryParityTree(templateRoot, { normalizeTemplateSuffix: true, scope }),
  ])

  function findCollisions(
    entries: readonly ParityEntry[],
    side: "example" | "template",
  ): ParityReport["normalizedPathCollisions"] {
    const physicalPathsByNormalizedPath = new Map<string, string[]>()

    for (const entry of entries) {
      const physicalPaths = physicalPathsByNormalizedPath.get(entry.normalizedPath) ?? []
      physicalPaths.push(entry.physicalPath)
      physicalPathsByNormalizedPath.set(entry.normalizedPath, physicalPaths)
    }

    return [...physicalPathsByNormalizedPath]
      .filter(([, physicalPaths]) => physicalPaths.length > 1)
      .map(([normalizedPath, physicalPaths]) => ({
        normalizedPath,
        physicalPaths: physicalPaths.sort(compareCodeUnits),
        side,
      }))
  }

  const normalizedPathCollisions = [
    ...findCollisions(exampleEntries, "example"),
    ...findCollisions(templateEntries, "template"),
  ].sort(
    (left, right) =>
      compareCodeUnits(left.normalizedPath, right.normalizedPath) ||
      compareCodeUnits(left.side, right.side),
  )
  const collidingNormalizedPaths = new Set(
    normalizedPathCollisions.map(({ normalizedPath }) => normalizedPath),
  )
  const exampleEntriesByPath = new Map(
    exampleEntries
      .filter(({ normalizedPath }) => !collidingNormalizedPaths.has(normalizedPath))
      .map((entry) => [entry.normalizedPath, entry]),
  )
  const templateEntriesByPath = new Map(
    templateEntries
      .filter(({ normalizedPath }) => !collidingNormalizedPaths.has(normalizedPath))
      .map((entry) => [entry.normalizedPath, entry]),
  )
  const contentDriftedPaths: string[] = []
  const missingTemplatePaths: string[] = []
  const unexpectedTemplatePaths: string[] = []

  for (const [normalizedPath, exampleEntry] of exampleEntriesByPath) {
    const templateEntry = templateEntriesByPath.get(normalizedPath)
    if (templateEntry === undefined) {
      missingTemplatePaths.push(normalizedPath)
      continue
    }

    if (exampleEntry.kind !== templateEntry.kind) {
      contentDriftedPaths.push(normalizedPath)
      continue
    }

    if (exampleEntry.kind === "file") {
      const [exampleContents, templateContents] = await Promise.all([
        readFile(join(exampleRoot, exampleEntry.physicalPath)),
        readFile(join(templateRoot, templateEntry.physicalPath)),
      ])
      if (!exampleContents.equals(templateContents)) contentDriftedPaths.push(normalizedPath)
    }
  }

  for (const normalizedPath of templateEntriesByPath.keys()) {
    if (!exampleEntriesByPath.has(normalizedPath)) unexpectedTemplatePaths.push(normalizedPath)
  }

  return {
    contentDriftedPaths: contentDriftedPaths.sort(compareCodeUnits),
    missingTemplatePaths: missingTemplatePaths.sort(compareCodeUnits),
    normalizedPathCollisions,
    unexpectedTemplatePaths: unexpectedTemplatePaths.sort(compareCodeUnits),
  }
}

/** Counts the compared paths on each side so a scope can never silently compare nothing. */
async function countComparedParityPaths(
  exampleRoot: string,
  templateRoot: string,
  scope: ParityScope,
): Promise<{ readonly exampleFiles: number; readonly templateFiles: number }> {
  const [exampleEntries, templateEntries] = await Promise.all([
    inventoryParityTree(exampleRoot, { normalizeTemplateSuffix: false, scope }),
    inventoryParityTree(templateRoot, { normalizeTemplateSuffix: true, scope }),
  ])

  return {
    exampleFiles: exampleEntries.filter(({ kind }) => kind === "file").length,
    templateFiles: templateEntries.filter(({ kind }) => kind === "file").length,
  }
}

/** Every `*.template` path under `root`, relative and slash-joined, sorted. */
async function collectTemplateSuffixedPaths(root: string): Promise<readonly string[]> {
  const paths: string[] = []

  async function visit(segments: readonly string[]): Promise<void> {
    const dirEntries = await readdir(join(root, ...segments), { withFileTypes: true })
    for (const dirEntry of dirEntries) {
      if (dirEntry.isDirectory()) {
        await visit([...segments, dirEntry.name])
        continue
      }
      if (dirEntry.name.endsWith(".template")) paths.push([...segments, dirEntry.name].join("/"))
    }
  }

  await visit([])
  return paths.sort(compareCodeUnits)
}

async function pathExists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    (error: unknown) => {
      if (isMissingPathError(error)) return false
      throw error
    },
  )
}

describe("template registry", () => {
  it("registers the research template", () => {
    expect(TEMPLATE_NAMES).toContain("research")
  })

  it("resolves the research template directory", async () => {
    const dir = await resolveTemplateDir("research")
    expect(dir.endsWith("templates/app-research")).toBe(true)
  })
})

describe("research template parity with examples/research/server", () => {
  it("keeps the complete research behavior tree in byte-for-byte parity", async () => {
    const templateServerRoot = join(await resolveTemplateDir("research"), "server")
    expect(
      await compareParityTrees(serverExampleRoot, templateServerRoot, SERVER_PARITY_SCOPE),
    ).toEqual({
      contentDriftedPaths: [],
      missingTemplatePaths: [],
      normalizedPathCollisions: [],
      unexpectedTemplatePaths: [],
    })
  })

  it("compares a non-empty server tree on both sides", async () => {
    const templateServerRoot = join(await resolveTemplateDir("research"), "server")
    const counts = await countComparedParityPaths(
      serverExampleRoot,
      templateServerRoot,
      SERVER_PARITY_SCOPE,
    )

    expect(counts.exampleFiles).toBeGreaterThan(20)
    expect(counts.templateFiles).toBe(counts.exampleFiles)
  })

  it("ignores gitignored runtime workspace outputs", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dawn-research-parity-runtime-"))
    const fixtureExampleRoot = join(fixtureRoot, "example")
    const fixtureTemplateRoot = join(fixtureRoot, "template")

    try {
      await Promise.all([
        mkdir(join(fixtureExampleRoot, "workspace/reports"), { recursive: true }),
        mkdir(join(fixtureExampleRoot, "workspace/tool-outputs"), { recursive: true }),
        mkdir(join(fixtureTemplateRoot, "workspace"), { recursive: true }),
      ])
      await Promise.all([
        writeFile(join(fixtureExampleRoot, "workspace/.gitignore"), "same"),
        writeFile(join(fixtureExampleRoot, "workspace/reports/report.md"), "runtime report"),
        writeFile(
          join(fixtureExampleRoot, "workspace/tool-outputs/readDoc-call_read_big_1.txt"),
          "runtime tool output",
        ),
        writeFile(join(fixtureTemplateRoot, "workspace/gitignore.template"), "same"),
      ])

      expect(
        await compareParityTrees(fixtureExampleRoot, fixtureTemplateRoot, SERVER_PARITY_SCOPE),
      ).toEqual({
        contentDriftedPaths: [],
        missingTemplatePaths: [],
        normalizedPathCollisions: [],
        unexpectedTemplatePaths: [],
      })
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true })
    }
  })

  it("classifies missing, unexpected, colliding, and drifted paths independently", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dawn-research-parity-"))
    const fixtureExampleRoot = join(fixtureRoot, "example")
    const fixtureTemplateRoot = join(fixtureRoot, "template")

    try {
      await Promise.all([
        mkdir(join(fixtureExampleRoot, "src"), { recursive: true }),
        mkdir(join(fixtureExampleRoot, "test"), { recursive: true }),
        mkdir(join(fixtureExampleRoot, "workspace"), { recursive: true }),
        mkdir(join(fixtureTemplateRoot, "src"), { recursive: true }),
        mkdir(join(fixtureTemplateRoot, "test"), { recursive: true }),
        mkdir(join(fixtureTemplateRoot, "workspace"), { recursive: true }),
      ])
      await Promise.all([
        writeFile(join(fixtureExampleRoot, ".env.example"), ""),
        writeFile(join(fixtureExampleRoot, "AGENTS.md"), "same"),
        writeFile(join(fixtureExampleRoot, "dawn.config.ts"), "example"),
        writeFile(join(fixtureExampleRoot, "src/collision.ts"), "same"),
        writeFile(join(fixtureExampleRoot, "src/missing.ts"), "example only"),
        writeFile(join(fixtureTemplateRoot, ".env.example"), ""),
        writeFile(join(fixtureTemplateRoot, "AGENTS.md"), "same"),
        writeFile(join(fixtureTemplateRoot, "dawn.config.ts"), "template"),
        writeFile(join(fixtureTemplateRoot, "src/collision.ts"), "same"),
        writeFile(join(fixtureTemplateRoot, "src/collision.ts.template"), "same"),
        writeFile(join(fixtureTemplateRoot, "src/unexpected.ts.template"), "template only"),
      ])

      expect(
        await compareParityTrees(fixtureExampleRoot, fixtureTemplateRoot, SERVER_PARITY_SCOPE),
      ).toEqual({
        contentDriftedPaths: ["dawn.config.ts"],
        missingTemplatePaths: ["src/missing.ts"],
        normalizedPathCollisions: [
          {
            normalizedPath: "src/collision.ts",
            physicalPaths: ["src/collision.ts", "src/collision.ts.template"],
            side: "template",
          },
        ],
        unexpectedTemplatePaths: ["src/unexpected.ts"],
      })
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true })
    }
  })

  it("excludes only documented runtime workspace subtrees from parity", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dawn-research-parity-runtime-"))
    const fixtureExampleRoot = join(fixtureRoot, "example")
    const fixtureTemplateRoot = join(fixtureRoot, "template")

    try {
      await Promise.all([
        mkdir(join(fixtureExampleRoot, "workspace/tool-outputs"), { recursive: true }),
        mkdir(join(fixtureTemplateRoot, "workspace/reports"), { recursive: true }),
      ])
      await Promise.all([
        writeFile(join(fixtureExampleRoot, "workspace/source.ts"), "example source"),
        writeFile(join(fixtureExampleRoot, "workspace/tool-outputs/runtime.txt"), "runtime output"),
        writeFile(join(fixtureTemplateRoot, "workspace/source.ts.template"), "template source"),
        writeFile(
          join(fixtureTemplateRoot, "workspace/reports/runtime.txt.template"),
          "runtime report",
        ),
      ])

      expect(
        await compareParityTrees(fixtureExampleRoot, fixtureTemplateRoot, SERVER_PARITY_SCOPE),
      ).toEqual({
        contentDriftedPaths: ["workspace/source.ts"],
        missingTemplatePaths: [],
        normalizedPathCollisions: [],
        unexpectedTemplatePaths: [],
      })
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true })
    }
  })

  it("detects normalized root collisions and mirrors special template output names", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dawn-research-parity-roots-"))
    const fixtureExampleRoot = join(fixtureRoot, "example")
    const fixtureTemplateRoot = join(fixtureRoot, "template")

    try {
      await Promise.all([
        mkdir(join(fixtureExampleRoot, "src"), { recursive: true }),
        mkdir(join(fixtureExampleRoot, "test"), { recursive: true }),
        mkdir(join(fixtureExampleRoot, "workspace"), { recursive: true }),
        mkdir(join(fixtureTemplateRoot, "src"), { recursive: true }),
        mkdir(join(fixtureTemplateRoot, "src.template"), { recursive: true }),
        mkdir(join(fixtureTemplateRoot, "test"), { recursive: true }),
        mkdir(join(fixtureTemplateRoot, "workspace"), { recursive: true }),
      ])
      await Promise.all([
        writeFile(join(fixtureExampleRoot, ".env.example"), "same"),
        writeFile(join(fixtureExampleRoot, "AGENTS.md"), "same"),
        writeFile(join(fixtureExampleRoot, "dawn.config.ts"), "same"),
        writeFile(join(fixtureExampleRoot, "workspace/.gitignore"), "same gitignore"),
        writeFile(join(fixtureExampleRoot, "workspace/.npmrc"), "same npmrc"),
        writeFile(join(fixtureTemplateRoot, ".env.example"), "same"),
        writeFile(join(fixtureTemplateRoot, "AGENTS.md"), "same"),
        writeFile(join(fixtureTemplateRoot, "dawn.config.ts"), "same"),
        writeFile(join(fixtureTemplateRoot, "workspace/gitignore.template"), "same gitignore"),
        writeFile(join(fixtureTemplateRoot, "workspace/npmrc.template"), "same npmrc"),
      ])

      expect(
        await compareParityTrees(fixtureExampleRoot, fixtureTemplateRoot, SERVER_PARITY_SCOPE),
      ).toEqual({
        contentDriftedPaths: [],
        missingTemplatePaths: [],
        normalizedPathCollisions: [
          {
            normalizedPath: "src",
            physicalPaths: ["src", "src.template"],
            side: "template",
          },
        ],
        unexpectedTemplatePaths: [],
      })
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true })
    }
  })
})

describe("research template parity with examples/research/web", () => {
  it("keeps the complete research web tree in byte-for-byte parity", async () => {
    const templateWebRoot = join(await resolveTemplateDir("research"), "web")
    expect(await compareParityTrees(webExampleRoot, templateWebRoot, WEB_PARITY_SCOPE)).toEqual({
      contentDriftedPaths: [],
      missingTemplatePaths: [],
      normalizedPathCollisions: [],
      unexpectedTemplatePaths: [],
    })
  })

  it("compares a non-empty web tree on both sides", async () => {
    const templateWebRoot = join(await resolveTemplateDir("research"), "web")
    const counts = await countComparedParityPaths(webExampleRoot, templateWebRoot, WEB_PARITY_SCOPE)

    expect(counts.exampleFiles).toBeGreaterThan(40)
    expect(counts.templateFiles).toBe(counts.exampleFiles)
  })

  it("normalizes every template-suffixed web path onto an existing example path", async () => {
    const templateWebRoot = join(await resolveTemplateDir("research"), "web")
    const templateSuffixedPaths = await collectTemplateSuffixedPaths(templateWebRoot)

    expect(templateSuffixedPaths.filter((path) => path.endsWith(".test.ts.template"))).toHaveLength(
      5,
    )
    expect(
      templateSuffixedPaths.filter((path) => path.endsWith(".test.tsx.template")),
    ).toHaveLength(10)
    expect(templateSuffixedPaths).toContain("gitignore.template")
    expect(templateSuffixedPaths).toContain("tsconfig.json.template")

    const normalizedPaths = templateSuffixedPaths.map((path) =>
      path
        .split("/")
        .map((segment) => normalizeParitySegment(segment, true))
        .join("/"),
    )

    expect(normalizedPaths.filter((path) => path.includes(".template"))).toEqual([])
    expect(normalizedPaths).toContain(".gitignore")
    expect(normalizedPaths).toContain("tsconfig.json")

    const unresolvedPaths: string[] = []
    for (const normalizedPath of normalizedPaths) {
      if (!(await pathExists(join(webExampleRoot, normalizedPath)))) {
        unresolvedPaths.push(normalizedPath)
      }
    }

    expect(unresolvedPaths).toEqual([])
  })

  it("excludes token-bearing files from the web parity roots", () => {
    expect(WEB_PARITY_ROOTS).not.toContain("package.json")
    expect(WEB_PARITY_ROOTS).not.toContain("README.md")
  })
})
