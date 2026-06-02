import { mkdir as mkdirFs, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import type { BackendContext, FilesystemBackend } from "./types.js"

const DEFAULT_MAX_FILE_BYTES = 256 * 1024

export interface LocalFilesystemOptions {
  /**
   * Reject `readFile` when the target file exceeds this size.
   * Default: 256 KiB.
   */
  readonly maxFileBytes?: number
}

export function localFilesystem(opts: LocalFilesystemOptions = {}): FilesystemBackend {
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  return {
    async readFile(
      path: string,
      _ctx: BackendContext,
      opts?: { readonly maxBytes?: number },
    ): Promise<string> {
      const limit = opts?.maxBytes ?? maxBytes
      const s = await stat(path)
      if (s.size > limit) {
        throw new Error(`File too large: ${s.size} bytes (max ${limit}) at ${path}`)
      }
      return await readFile(path, "utf8")
    },
    async writeFile(
      path: string,
      content: string,
      _ctx: BackendContext,
    ): Promise<{ readonly bytesWritten: number }> {
      await writeFile(path, content, "utf8")
      return { bytesWritten: Buffer.byteLength(content, "utf8") }
    },
    async listDir(path: string, _ctx: BackendContext): Promise<readonly string[]> {
      return await readdir(path)
    },
    async statFile(path: string, _ctx: BackendContext) {
      const s = await stat(path)
      return { size: s.size, mtimeMs: s.mtimeMs }
    },
    async removeFile(path: string, _ctx: BackendContext) {
      await rm(path, { force: true })
    },
    async touchFile(path: string, _ctx: BackendContext) {
      const now = new Date()
      await utimes(path, now, now)
    },
    async mkdir(path: string, _ctx: BackendContext) {
      await mkdirFs(path, { recursive: true })
    },
  }
}
