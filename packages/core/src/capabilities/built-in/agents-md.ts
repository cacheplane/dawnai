import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import type { CapabilityMarker } from "../types.js"

const MAX_MEMORY_BYTES = 64 * 1024
const MEMORY_HEADER = `# Memory

The block below is the live contents of \`workspace/AGENTS.md\`, re-read on every turn. This IS your persistent memory — do NOT re-read this file with any tool; the content here is always current. Update it by calling \`writeFile({ path: "AGENTS.md", content: "..." })\` when you learn something worth remembering.

---`

/**
 * Auto-injects the contents of <process.cwd()>/workspace/AGENTS.md into the
 * agent's system prompt under a "# Memory" heading. Always-on: the presence
 * of the file IS the opt-in. Re-reads the file on every model turn so the
 * agent sees its own updated memory immediately after it calls writeFile.
 */
export function createAgentsMdMarker(): CapabilityMarker {
  return {
    name: "agents-md",
    detect: async () => true,
    load: async () => ({
      promptFragment: {
        placement: "after_user_prompt",
        render: () => renderMemoryFragment(workspaceAgentsMdPath()),
      },
    }),
  }
}

function workspaceAgentsMdPath(): string {
  return resolve(process.cwd(), "workspace", "AGENTS.md")
}

function renderMemoryFragment(path: string): string {
  if (!existsSync(path)) return ""

  let size: number
  try {
    size = statSync(path).size
  } catch {
    return ""
  }

  if (size > MAX_MEMORY_BYTES) {
    return `${MEMORY_HEADER}\n\n(workspace/AGENTS.md is ${size} bytes; exceeds 64 KiB limit — not loaded)`
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
