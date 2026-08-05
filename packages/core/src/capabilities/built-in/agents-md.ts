import { resolve } from "node:path"
import type { CapabilityMarker, MarkerFs } from "../types.js"

const MAX_MEMORY_BYTES = 64 * 1024
const MEMORY_HEADER = `# Memory

The block below is the live contents of \`workspace/AGENTS.md\`, re-read on every turn. This IS your persistent memory — do NOT re-read this file with any tool; the content here is always current. Update it by calling \`writeFile({ path: "AGENTS.md", content: "..." })\` when you learn something worth remembering.

---`

/**
 * Auto-injects the contents of <appRoot>/workspace/AGENTS.md into the
 * agent's system prompt under a "# Memory" heading. Always-on: the presence
 * of the file IS the opt-in. Re-reads the file on every model turn (through
 * the injected MarkerFs) so the agent sees its own updated memory
 * immediately after it calls writeFile. With no MarkerFs (edge runtimes)
 * the fragment renders empty — same as when the file does not exist.
 *
 * Uses context.appRoot (not process.cwd()) so in-process test harnesses that
 * pass an explicit app root activate this capability regardless of the test
 * runner's working directory. In production (dawn dev), appRoot === cwd.
 */
export function createAgentsMdMarker(): CapabilityMarker {
  return {
    name: "agents-md",
    detect: async (_routeDir, _context) => true,
    load: async (_routeDir, context) => {
      const agentsMdPath = workspaceAgentsMdPath(context.appRoot)
      const markerFs = context.markerFs
      return {
        promptFragment: {
          placement: "after_user_prompt",
          render: () => (markerFs ? renderMemoryFragment(agentsMdPath, markerFs) : ""),
        },
      }
    },
  }
}

function workspaceAgentsMdPath(appRoot: string): string {
  return resolve(appRoot, "workspace", "AGENTS.md")
}

function renderMemoryFragment(path: string, markerFs: MarkerFs): string {
  if (!markerFs.existsSync(path)) return ""

  const size = markerFs.statSizeSync(path)
  if (size === undefined) return ""

  if (size > MAX_MEMORY_BYTES) {
    return `${MEMORY_HEADER}\n\n(workspace/AGENTS.md is ${size} bytes; exceeds 64 KiB limit — not loaded)`
  }

  const raw = markerFs.readFileSync(path)
  if (raw === undefined) return ""

  const trimmed = raw.trim()
  if (trimmed.length === 0) return ""

  return `${MEMORY_HEADER}\n\n${trimmed}`
}
