import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"
import { resolveTemplateDir, TEMPLATE_NAMES } from "../src/templates.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const exampleRoot = resolve(repoRoot, "examples/research/server")

const RESEARCH_PARITY_ROOTS = [
  ".env.example",
  "AGENTS.md",
  "dawn.config.ts",
  "src",
  "test",
  "workspace",
] as const

const RESEARCH_PARITY_IGNORED_PATHS = new Set(["workspace/reports", "workspace/tool-outputs"])

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

async function inventoryParityTree(
  root: string,
  options: { readonly normalizeTemplateSuffix: boolean },
): Promise<readonly ParityEntry[]> {
  const entries: ParityEntry[] = []

  async function visit(
    physicalSegments: readonly string[],
    normalizedSegments: readonly string[],
  ): Promise<void> {
    const physicalPath = physicalSegments.join("/")
    const normalizedPath = normalizedSegments.join("/")
    if (RESEARCH_PARITY_IGNORED_PATHS.has(normalizedPath)) return

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
    const parityRoots = new Set<string>(RESEARCH_PARITY_ROOTS)
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
    for (const parityRoot of RESEARCH_PARITY_ROOTS) {
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
): Promise<ParityReport> {
  const [exampleEntries, templateEntries] = await Promise.all([
    inventoryParityTree(exampleRoot, { normalizeTemplateSuffix: false }),
    inventoryParityTree(templateRoot, { normalizeTemplateSuffix: true }),
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
    expect(await compareParityTrees(exampleRoot, templateServerRoot)).toEqual({
      contentDriftedPaths: [],
      missingTemplatePaths: [],
      normalizedPathCollisions: [],
      unexpectedTemplatePaths: [],
    })
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

      expect(await compareParityTrees(fixtureExampleRoot, fixtureTemplateRoot)).toEqual({
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

      expect(await compareParityTrees(fixtureExampleRoot, fixtureTemplateRoot)).toEqual({
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

      expect(await compareParityTrees(fixtureExampleRoot, fixtureTemplateRoot)).toEqual({
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
