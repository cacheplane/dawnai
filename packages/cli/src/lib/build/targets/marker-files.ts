import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"

import { MAX_MEMORY_BYTES, MAX_PLAN_BYTES, type RouteManifest } from "@dawn-ai/core"

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
  // Build-only: the skills marker reads eagerly with no runtime cap, so there
  // is no `@dawn-ai/core` constant to track. Changing the cap for `SKILL.md`
  // means changing it HERE — nothing else enforces it.
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
  /** The reported size came from re-encoding the decoded text, not from `stat`. */
  readonly reEncoded: boolean
}

interface ReadMarkerFileResult {
  /** Absent when the stat pre-check rejected the file before reading it. */
  readonly file: RouteMarkerFile | undefined
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
  const path = appRelativeRouteDir === "" ? relativePath : `${appRelativeRouteDir}/${relativePath}`
  // Stat pre-check first, so a file far over the limit is never materialized
  // into the build's memory just to be rejected.
  if (statSize > limit) {
    return { file: undefined, oversized: { path, size: statSize, limit, kind, reEncoded: false } }
  }
  const content = await readFile(absolute, "utf8")
  // Invalid UTF-8 bytes decode to U+FFFD and can re-encode to more bytes than
  // were on disk, so a file can pass the stat pre-check and still exceed the
  // runtime facade's TextEncoder length; report whichever size is larger.
  const encodedSize = Buffer.byteLength(content, "utf8")
  const size = Math.max(statSize, encodedSize)
  const oversized =
    size > limit ? { path, size, limit, kind, reEncoded: encodedSize > statSize } : undefined
  return { file: { content, relativePath }, oversized }
}

function throwOversized(oversized: readonly OversizedMarkerFile[]): never {
  const lines = oversized.map(
    (o) =>
      `  • ${o.path} — ${o.size} bytes${o.reEncoded ? " after UTF-8 re-encoding" : ""}, over the ${o.limit}-byte limit for ${o.kind}`,
  )
  throw new CliError(
    [
      "Marker file(s) too large for the static module manifest edge targets bundle:",
      ...lines,
      "Edge builds cap each bundled marker; `memory.md` and `plan.md` use the limits the runtime already applies, and `SKILL.md` gets a build-only cap. Shorten the file; for a skill, split it into smaller skills.",
    ].join("\n"),
    1,
    { code: "DAWN_E1005" },
  )
}

interface RouteMarkerScan {
  readonly files: readonly RouteMarkerFile[]
  readonly oversized: readonly OversizedMarkerFile[]
}

/**
 * One route's marker files and its over-limit findings, without throwing — so
 * a caller checking a whole app can aggregate findings across routes and report
 * them in a single error.
 */
async function scanRouteMarkerFiles(options: {
  readonly appRoot: string
  readonly routeDir: string
}): Promise<RouteMarkerScan> {
  const { appRoot, routeDir } = options
  const appRelativeRouteDir = relative(appRoot, routeDir).split(sep).join("/")
  const found: RouteMarkerFile[] = []
  const oversized: OversizedMarkerFile[] = []

  const record = (result: ReadMarkerFileResult): void => {
    if (result.file) found.push(result.file)
    if (result.oversized) oversized.push(result.oversized)
  }

  if (existsSync(join(routeDir, "memory.md"))) {
    record(await readMarkerFile(routeDir, appRelativeRouteDir, "memory.md", "memory.md"))
  }
  if (existsSync(join(routeDir, "plan.md"))) {
    record(await readMarkerFile(routeDir, appRelativeRouteDir, "plan.md", "plan.md"))
  }
  // `discoverSkillDirs` already returns sorted names.
  for (const name of discoverSkillDirs(join(routeDir, "skills"))) {
    record(
      await readMarkerFile(routeDir, appRelativeRouteDir, `skills/${name}/SKILL.md`, "SKILL.md"),
    )
  }

  return { files: found, oversized }
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
  const { files, oversized } = await scanRouteMarkerFiles(options)
  if (oversized.length > 0) throwOversized(oversized)
  return files.length > 0 ? [...files] : undefined
}

/**
 * The same per-file limits the edge emitters apply, run over every route of an
 * app without emitting anything — so `dawn check` reports an over-limit marker
 * instead of leaving it for a failed build. Findings are aggregated across ALL
 * routes into one error, so a user fixing an app sees every offending file at
 * once rather than one route per run.
 */
export async function assertRouteMarkerFileLimits(input: {
  readonly appRoot: string
  readonly manifest: RouteManifest
}): Promise<void> {
  const { appRoot, manifest } = input
  const oversized: OversizedMarkerFile[] = []
  for (const route of manifest.routes) {
    const scan = await scanRouteMarkerFiles({ appRoot, routeDir: route.routeDir })
    oversized.push(...scan.oversized)
  }
  if (oversized.length > 0) throwOversized(oversized)
}
