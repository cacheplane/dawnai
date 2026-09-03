import { pureJoin } from "@dawn-ai/sdk/pure"
import type { CapabilityMarker, MarkerFs } from "../types.js"

export const MAX_MEMORY_BYTES = 32 * 1024
const MEMORY_HEADER = `# Route Memory

The block below is the live contents of this route's \`memory.md\`, re-read every turn. It is stable, human-editable context for this route only.

---`

const MEMORY_FILE = "memory.md"

/**
 * Injects <routeDir>/memory.md into the system prompt under a "# Route Memory"
 * heading. Opt-in by file presence; re-read every turn (through the injected
 * MarkerFs). Route-scoped profile memory — distinct from the global workspace
 * AGENTS.md (agents-md.ts). With no MarkerFs (edge runtimes) the marker
 * detects false — same as when the file does not exist.
 */
export function createMemoryMdMarker(): CapabilityMarker {
  return {
    name: "memory-md",
    detect: async (routeDir, context) =>
      context.markerFs?.existsSync(pureJoin(routeDir, MEMORY_FILE)) ?? false,
    load: async (routeDir, context) => {
      const path = pureJoin(routeDir, MEMORY_FILE)
      const markerFs = context.markerFs
      return {
        promptFragment: {
          placement: "after_user_prompt",
          render: () => (markerFs ? renderRouteMemory(path, markerFs) : ""),
        },
      }
    },
  }
}

function renderRouteMemory(path: string, markerFs: MarkerFs): string {
  if (!markerFs.existsSync(path)) return ""
  const size = markerFs.statSizeSync(path)
  if (size === undefined) return ""
  if (size > MAX_MEMORY_BYTES) {
    return `${MEMORY_HEADER}\n\n(route memory.md is ${size} bytes; exceeds 32 KiB limit — not loaded)`
  }
  const raw = markerFs.readFileSync(path)
  if (raw === undefined) return ""
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ""
  return `${MEMORY_HEADER}\n\n${trimmed}`
}
