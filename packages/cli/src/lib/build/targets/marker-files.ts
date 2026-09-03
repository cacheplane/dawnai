import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"

import { MAX_MEMORY_BYTES, MAX_PLAN_BYTES } from "@dawn-ai/core"

import { CliError } from "../../output.js"
import { discoverSkillDirs } from "./edge-capabilities.js"

/** One marker file bundled into an edge manifest. */
export interface RouteMarkerFile {
  /** Route-relative, forward-slashed: `plan.md`, `memory.md`, `skills/<name>/SKILL.md`. */
  readonly relativePath: string
  readonly content: string
}

/**
 * Byte limits per marker kind. `plan.md` and `memory.md` match the runtime
 * limits in `@dawn-ai/core`'s planning and memory-md markers; `SKILL.md` is a
 * new limit because the skills marker reads eagerly with no cap.
 */
export const MARKER_FILE_LIMITS = {
  "SKILL.md": 32 * 1024,
  "memory.md": MAX_MEMORY_BYTES,
  "plan.md": MAX_PLAN_BYTES,
} as const

type MarkerKind = keyof typeof MARKER_FILE_LIMITS

/** An over-limit marker file found while collecting one route's markers. */
interface OversizedMarkerFile {
  readonly path: string
  readonly size: number
  readonly limit: number
  readonly kind: MarkerKind
}

interface ReadMarkerFileResult {
  readonly file: RouteMarkerFile
  readonly oversized: OversizedMarkerFile | undefined
}

async function readMarkerFile(
  routeDir: string,
  appRelativeRouteDir: string,
  relativePath: string,
  kind: MarkerKind,
): Promise<ReadMarkerFileResult> {
  const absolute = join(routeDir, ...relativePath.split("/"))
  const statSize = (await stat(absolute)).size
  const limit = MARKER_FILE_LIMITS[kind]
  const content = await readFile(absolute, "utf8")
  // Invalid UTF-8 bytes decode to U+FFFD and can re-encode to more bytes than
  // were on disk, so a file can pass the stat pre-check and still exceed the
  // runtime facade's TextEncoder length; report whichever size is larger.
  const encodedSize = Buffer.byteLength(content, "utf8")
  const size = Math.max(statSize, encodedSize)
  const path = `${appRelativeRouteDir}/${relativePath}`
  const oversized = size > limit ? { path, size, limit, kind } : undefined
  return { file: { content, relativePath }, oversized }
}

function throwOversized(oversized: readonly OversizedMarkerFile[]): never {
  const lines = oversized.map(
    (o) => `  • ${o.path} — ${o.size} bytes, over the ${o.limit}-byte limit for ${o.kind}`,
  )
  throw new CliError(
    [
      "Marker file(s) too large for the static module manifest edge targets bundle:",
      ...lines,
      "The limit the runtime applies is enforced at build time. Shorten the file; for a skill, split it into smaller skills.",
    ].join("\n"),
    1,
    { code: "DAWN_E1005" },
  )
}

/**
 * Every marker file an edge manifest must carry for one route, in a stable
 * order, or `undefined` when the route has none. Read failures propagate: a
 * present-but-unreadable file must fail the build, never ship a manifest
 * without it. Over-limit files are aggregated across the whole route and
 * reported together in a single error.
 */
export async function collectRouteMarkerFiles(options: {
  readonly appRoot: string
  readonly routeDir: string
}): Promise<readonly RouteMarkerFile[] | undefined> {
  const { appRoot, routeDir } = options
  const appRelativeRouteDir = relative(appRoot, routeDir).split(sep).join("/")
  const found: RouteMarkerFile[] = []
  const oversized: OversizedMarkerFile[] = []

  const record = (result: ReadMarkerFileResult): void => {
    found.push(result.file)
    if (result.oversized) oversized.push(result.oversized)
  }

  if (existsSync(join(routeDir, "memory.md"))) {
    record(await readMarkerFile(routeDir, appRelativeRouteDir, "memory.md", "memory.md"))
  }
  if (existsSync(join(routeDir, "plan.md"))) {
    record(await readMarkerFile(routeDir, appRelativeRouteDir, "plan.md", "plan.md"))
  }
  for (const name of [...discoverSkillDirs(join(routeDir, "skills"))].sort()) {
    record(
      await readMarkerFile(routeDir, appRelativeRouteDir, `skills/${name}/SKILL.md`, "SKILL.md"),
    )
  }

  if (oversized.length > 0) throwOversized(oversized)
  return found.length > 0 ? found : undefined
}
