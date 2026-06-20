import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { CapabilityMarker } from "../types.js"

const MAX_MEMORY_BYTES = 32 * 1024
const MEMORY_HEADER = `# Route Memory

The block below is the live contents of this route's \`memory.md\`, re-read every turn. It is stable, human-editable context for this route only.

---`

const MEMORY_FILE = "memory.md"

/**
 * Injects <routeDir>/memory.md into the system prompt under a "# Route Memory"
 * heading. Opt-in by file presence; re-read every turn. Route-scoped profile
 * memory — distinct from the global workspace AGENTS.md (agents-md.ts).
 */
export function createMemoryMdMarker(): CapabilityMarker {
  return {
    name: "memory-md",
    detect: async (routeDir) => existsSync(join(routeDir, MEMORY_FILE)),
    load: async (routeDir) => {
      const path = join(routeDir, MEMORY_FILE)
      return {
        promptFragment: {
          placement: "after_user_prompt",
          render: () => renderRouteMemory(path),
        },
      }
    },
  }
}

function renderRouteMemory(path: string): string {
  if (!existsSync(path)) return ""
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return ""
  }
  if (size > MAX_MEMORY_BYTES) {
    return `${MEMORY_HEADER}\n\n(route memory.md is ${size} bytes; exceeds 32 KiB limit — not loaded)`
  }
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return ""
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ""
  return `${MEMORY_HEADER}\n\n${trimmed}`
}
