import { createHash } from "node:crypto"
import { join } from "node:path"
import type { FilesystemBackend } from "@dawn-ai/workspace"

// NOTE: must match the tool-outputs/ predicate in @dawn-ai/core workspace capability readFile.
const SUBDIR = "tool-outputs"

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_")
}

/**
 * Deterministic offload filename. Keyed on the tool_call_id when present
 * (unique per call in production; fixture-controlled in replay tests). Falls
 * back to a content hash when no id is available — still deterministic and
 * reproducible, since the caller controls the content.
 */
export function buildOffloadFileName(
  toolName: string,
  content: string,
  toolCallId?: string,
): string {
  const name = sanitizeSegment(toolName)
  if (toolCallId && toolCallId.length > 0) {
    return `${name}-${sanitizeSegment(toolCallId)}.txt`
  }
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16)
  return `${name}-${hash}.txt`
}

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

  private context(signal?: AbortSignal) {
    return { signal: signal ?? this.opts.signal, workspaceRoot: this.opts.workspaceRoot }
  }
  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  /** Persist full content; returns the workspace-relative path. Runs throttled GC. */
  async write(
    toolName: string,
    content: string,
    toolCallId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const ctx = this.context(signal)
    const fileName = buildOffloadFileName(toolName, content, toolCallId)
    const relPath = `${SUBDIR}/${fileName}`
    const dirAbs = join(this.opts.workspaceRoot, SUBDIR)
    await this.opts.backend.mkdir?.(dirAbs, ctx)
    const absPath = join(this.opts.workspaceRoot, relPath)
    await this.opts.backend.writeFile(absPath, content, ctx)
    await this.maybeGc(ctx)
    return relPath
  }

  private async maybeGc(ctx: { readonly signal: AbortSignal; readonly workspaceRoot: string }) {
    const now = this.now()
    if (now - this.lastGcAt < this.opts.gcThrottleMs) return
    this.lastGcAt = now
    const { backend } = this.opts
    if (!backend.statFile || !backend.removeFile) return // GC unsupported by backend
    const dirAbs = join(this.opts.workspaceRoot, SUBDIR)

    let names: readonly string[]
    try {
      names = await backend.listDir(dirAbs, ctx)
    } catch {
      return // dir not created yet / unreadable
    }

    const entries: { abs: string; size: number; mtimeMs: number }[] = []
    for (const name of names) {
      const abs = join(dirAbs, name)
      try {
        const s = await backend.statFile(abs, ctx)
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
        await this.safeRemove(e.abs, ctx)
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
      if (await this.safeRemove(e.abs, ctx)) total -= e.size
    }
  }

  private async safeRemove(
    abs: string,
    ctx: { readonly signal: AbortSignal; readonly workspaceRoot: string },
  ): Promise<boolean> {
    try {
      await this.opts.backend.removeFile?.(abs, ctx)
      return true
    } catch {
      return false
    }
  }
}
