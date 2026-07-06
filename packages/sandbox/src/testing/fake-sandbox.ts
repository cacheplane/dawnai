import type {
  BackendContext,
  ExecBackend,
  FilesystemBackend,
  SandboxHandle,
  SandboxProvider,
} from "@dawn-ai/workspace"

type ExecFn = (
  args: {
    readonly command: string
    readonly cwd?: string
    readonly env?: Readonly<Record<string, string>>
  },
  ctx: BackendContext,
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>

const ROOT = "/workspace"

/** In-memory SandboxProvider for unit + wiring tests. No Docker. */
export function fakeSandbox(opts: { readonly exec?: ExecFn } = {}): SandboxProvider {
  const volumes = new Map<string, Map<string, string>>()
  const liveThreads = new Set<string>()

  const volumeFor = (threadId: string): Map<string, string> => {
    let v = volumes.get(threadId)
    if (!v) {
      v = new Map()
      volumes.set(threadId, v)
    }
    return v
  }

  const makeFilesystem = (vol: Map<string, string>): FilesystemBackend => ({
    async readFile(path) {
      const v = vol.get(path)
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v
    },
    async writeFile(path, content) {
      vol.set(path, content)
      return { bytesWritten: Buffer.byteLength(content) }
    },
    async listDir(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`
      const names = new Set<string>()
      for (const key of vol.keys()) {
        if (key.startsWith(prefix)) {
          const part = key.slice(prefix.length).split("/")[0]
          if (part !== undefined) names.add(part)
        }
      }
      return [...names].sort()
    },
    async realPath(path) {
      return path
    },
  })

  const defaultExec: ExecFn = async () => ({ stdout: "", stderr: "", exitCode: 0 })

  return {
    name: "fake",
    async acquire({ threadId }): Promise<SandboxHandle> {
      liveThreads.add(threadId)
      const vol = volumeFor(threadId)
      const exec: ExecBackend = { runCommand: (args, ctx) => (opts.exec ?? defaultExec)(args, ctx) }
      return { threadId, filesystem: makeFilesystem(vol), exec, workspaceRoot: ROOT }
    },
    async release(threadId) {
      liveThreads.delete(threadId)
    },
    async destroy(threadId) {
      liveThreads.delete(threadId)
      volumes.delete(threadId)
    },
    async preflight() {
      return { ok: true }
    },
  }
}
