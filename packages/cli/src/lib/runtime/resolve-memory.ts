import { join } from "node:path"
import type { MemoryStoreLike } from "@dawn-ai/core"
import { loadDawnConfig } from "@dawn-ai/core"
import { sqliteMemoryStore } from "@dawn-ai/memory"

/**
 * Resolves the MemoryStore for the given appRoot.
 *
 * Uses `config.memory.store` if the user's `dawn.config.ts` provides one;
 * otherwise falls back to the default SQLite-backed store at
 * `<appRoot>/.dawn/memory.sqlite`.
 */
export async function resolveMemoryStore(appRoot: string): Promise<MemoryStoreLike> {
  try {
    const loaded = await loadDawnConfig({ appRoot })
    if (loaded.config.memory?.store) return loaded.config.memory.store as MemoryStoreLike
  } catch {
    // no dawn.config.ts / unreadable — use default
  }
  return sqliteMemoryStore({
    path: join(appRoot, ".dawn", "memory.sqlite"),
  }) as unknown as MemoryStoreLike
}

/**
 * Resolves the memory write-governance mode for the given appRoot.
 *
 * Defaults to `"candidate"` when no config is present.
 */
export async function resolveMemoryWrites(appRoot: string): Promise<"off" | "candidate" | "auto"> {
  try {
    const loaded = await loadDawnConfig({ appRoot })
    return loaded.config.memory?.writes ?? "candidate"
  } catch {
    return "candidate"
  }
}
