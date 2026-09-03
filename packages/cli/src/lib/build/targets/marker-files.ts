import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"

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
  "memory.md": 32 * 1024,
  "plan.md": 64 * 1024,
} as const

type MarkerKind = keyof typeof MARKER_FILE_LIMITS

async function readMarkerFile(
  routeDir: string,
  relativePath: string,
  kind: MarkerKind,
): Promise<RouteMarkerFile> {
  const absolute = join(routeDir, ...relativePath.split("/"))
  const size = (await stat(absolute)).size
  const limit = MARKER_FILE_LIMITS[kind]
  if (size > limit) {
    throw new CliError(
      `Marker file ${relativePath} is ${size} bytes, over the ${limit}-byte limit for ${kind}. ` +
        `Edge targets bundle marker files into the static module manifest, so the limit the ` +
        `runtime applies is enforced at build time. Shorten the file or split the skill.`,
      1,
      { code: "DAWN_E1005" },
    )
  }
  return { content: await readFile(absolute, "utf8"), relativePath }
}

/**
 * Every marker file an edge manifest must carry for one route, in a stable
 * order, or `undefined` when the route has none. Read failures propagate: a
 * present-but-unreadable file must fail the build, never ship a manifest
 * without it.
 */
export async function collectRouteMarkerFiles(
  routeDir: string,
): Promise<readonly RouteMarkerFile[] | undefined> {
  const found: RouteMarkerFile[] = []
  if (existsSync(join(routeDir, "memory.md"))) {
    found.push(await readMarkerFile(routeDir, "memory.md", "memory.md"))
  }
  if (existsSync(join(routeDir, "plan.md"))) {
    found.push(await readMarkerFile(routeDir, "plan.md", "plan.md"))
  }
  for (const name of [...discoverSkillDirs(join(routeDir, "skills"))].sort()) {
    found.push(await readMarkerFile(routeDir, `skills/${name}/SKILL.md`, "SKILL.md"))
  }
  return found.length > 0 ? found : undefined
}
