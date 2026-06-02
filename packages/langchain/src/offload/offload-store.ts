import { randomBytes } from "node:crypto"
import { join } from "node:path"
import type { FilesystemBackend } from "@dawn-ai/workspace"

const SUBDIR = "tool-outputs"

export interface OffloadStoreOptions {
  readonly backend: FilesystemBackend
  readonly workspaceRoot: string
  readonly signal: AbortSignal
  readonly maxBytes: number
  readonly ttlMs: number
  readonly gcThrottleMs: number
  /** Injectable clock for tests. Defaults to Date.now. */
  readonly now?: () => number
}

export class OffloadStore {
  private lastGcAt: number
  constructor(private readonly opts: OffloadStoreOptions) {
    this.lastGcAt = (opts.now ?? Date.now)()
  }

  private get ctx() {
    return { signal: this.opts.signal, workspaceRoot: this.opts.workspaceRoot }
  }
  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  /** Persist full content; returns the workspace-relative path. Runs throttled GC. */
  async write(toolName: string, content: string): Promise<string> {
    const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_")
    const fileName = `${safeName}-${this.now()}-${randomBytes(3).toString("hex")}.txt`
    const relPath = `${SUBDIR}/${fileName}`
    const dirAbs = join(this.opts.workspaceRoot, SUBDIR)
    await this.opts.backend.mkdir?.(dirAbs, this.ctx)
    const absPath = join(this.opts.workspaceRoot, relPath)
    await this.opts.backend.writeFile(absPath, content, this.ctx)
    await this.maybeGc()
    return relPath
  }

  private async maybeGc(): Promise<void> {
    const now = this.now()
    if (now - this.lastGcAt < this.opts.gcThrottleMs) return
    this.lastGcAt = now
    const { backend } = this.opts
    if (!backend.statFile || !backend.removeFile) return // GC unsupported by backend
    const dirAbs = join(this.opts.workspaceRoot, SUBDIR)

    let names: readonly string[]
    try {
      names = await backend.listDir(dirAbs, this.ctx)
    } catch {
      return // dir not created yet / unreadable
    }

    const entries: { abs: string; size: number; mtimeMs: number }[] = []
    for (const name of names) {
      const abs = join(dirAbs, name)
      try {
        const s = await backend.statFile(abs, this.ctx)
        entries.push({ abs, size: s.size, mtimeMs: s.mtimeMs })
      } catch {
        /* skip unstattable */
      }
    }

    // TTL pass
    const ttlCutoff = now - this.opts.ttlMs
    const survivors: typeof entries = []
    for (const e of entries) {
      if (e.mtimeMs < ttlCutoff) {
        await this.safeRemove(e.abs)
      } else {
        survivors.push(e)
      }
    }

    // Size pass: oldest-first until under maxBytes
    let total = survivors.reduce((sum, e) => sum + e.size, 0)
    if (total <= this.opts.maxBytes) return
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const e of survivors) {
      if (total <= this.opts.maxBytes) break
      await this.safeRemove(e.abs)
      total -= e.size
    }
  }

  private async safeRemove(abs: string): Promise<void> {
    try {
      await this.opts.backend.removeFile?.(abs, this.ctx)
    } catch {
      /* tolerate single-file delete failure */
    }
  }
}
