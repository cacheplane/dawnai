import type { SandboxHandle, SandboxPolicy, SandboxProvider } from "@dawn-ai/workspace"

interface Entry {
  handle?: SandboxHandle
  acquiring?: Promise<SandboxHandle>
  lastUsedAt: number
  inUse: number
}

/**
 * Owns the per-thread sandbox lifecycle. One instance per server process.
 * - getForThread: create-or-reuse the thread's handle (concurrent acquires deduped).
 * - reapIdle: release() warm compute for threads idle past idleTimeoutMs (volume kept).
 * - destroyThread: full teardown (volume removed) — thread delete.
 * - releaseAll: shutdown — release() everything (volume kept).
 */
export class SandboxManager {
  readonly #provider: SandboxProvider
  readonly #policy: SandboxPolicy
  readonly #idleTimeoutMs: number
  readonly #clock: () => number
  readonly #entries = new Map<string, Entry>()

  constructor(opts: {
    provider: SandboxProvider
    policy: SandboxPolicy
    idleTimeoutMs: number
    clock?: () => number
  }) {
    this.#provider = opts.provider
    this.#policy = opts.policy
    this.#idleTimeoutMs = opts.idleTimeoutMs
    this.#clock = opts.clock ?? Date.now
  }

  async getForThread(threadId: string, signal: AbortSignal): Promise<SandboxHandle> {
    const existing = this.#entries.get(threadId)
    if (existing?.handle) {
      existing.lastUsedAt = this.#clock()
      return existing.handle
    }
    if (existing?.acquiring) return existing.acquiring

    const entry: Entry = { lastUsedAt: this.#clock(), inUse: 1 }
    this.#entries.set(threadId, entry)
    entry.acquiring = this.#provider
      .acquire({ threadId, policy: this.#policy, signal })
      .then((handle) => {
        entry.handle = handle
        delete entry.acquiring
        entry.lastUsedAt = this.#clock()
        return handle
      })
      .catch((err) => {
        this.#entries.delete(threadId)
        throw err
      })
      .finally(() => {
        entry.inUse -= 1
      })
    return entry.acquiring
  }

  async reapIdle(): Promise<void> {
    const cutoff = this.#clock() - this.#idleTimeoutMs
    for (const [threadId, entry] of [...this.#entries]) {
      if (entry.inUse > 0 || entry.acquiring) continue
      if (entry.lastUsedAt > cutoff) continue
      this.#entries.delete(threadId)
      await this.#provider.release(threadId)
    }
  }

  async destroyThread(threadId: string): Promise<void> {
    this.#entries.delete(threadId)
    await this.#provider.destroy(threadId)
  }

  async releaseAll(): Promise<void> {
    const ids = [...this.#entries.keys()]
    this.#entries.clear()
    await Promise.all(ids.map((id) => this.#provider.release(id)))
  }
}
