import type { BackendContext, FilesystemBackend } from "@dawn-ai/workspace"
import type { Docker } from "./docker-cli.ts"

function q(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** FilesystemBackend whose ops run inside a docker container via `docker exec`. */
export function dockerFilesystem(docker: Docker, container: string): FilesystemBackend {
  const run = (cmd: string, ctx: BackendContext, stdin?: string) =>
    docker.exec(container, ["sh", "-c", cmd], {
      ...(stdin !== undefined ? { stdin } : {}),
      signal: ctx.signal,
    })
  return {
    async readFile(path, ctx, opts) {
      const r = await run(`cat ${q(path)}`, ctx)
      if (r.exitCode !== 0) throw new Error(`readFile failed: ${r.stderr.trim()}`)
      const max = opts?.maxBytes
      if (max !== undefined && Number.isFinite(max) && Buffer.byteLength(r.stdout) > max) {
        throw new Error(`readFile ${path}: content exceeds maxBytes (${max}).`)
      }
      return r.stdout
    },
    async writeFile(path, content, ctx) {
      const r = await run(`mkdir -p "$(dirname ${q(path)})" && cat > ${q(path)}`, ctx, content)
      if (r.exitCode !== 0) throw new Error(`writeFile failed: ${r.stderr.trim()}`)
      return { bytesWritten: Buffer.byteLength(content) }
    },
    async listDir(path, ctx) {
      const r = await run(`ls -1 ${q(path)}`, ctx)
      if (r.exitCode !== 0) throw new Error(`listDir failed: ${r.stderr.trim()}`)
      return r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    },
    async realPath(path, ctx) {
      const r = await run(`realpath -m ${q(path)}`, ctx)
      return r.exitCode === 0 ? r.stdout.trim() : path
    },
    async statFile(path, ctx) {
      const r = await run(`stat -c '%s %Y' ${q(path)}`, ctx)
      if (r.exitCode !== 0) throw new Error(`statFile failed: ${r.stderr.trim()}`)
      const [size, mtime] = r.stdout.trim().split(" ")
      return { size: Number(size), mtimeMs: Number(mtime) * 1000 }
    },
    async removeFile(path, ctx) {
      await run(`rm -f ${q(path)}`, ctx)
    },
    async touchFile(path, ctx) {
      await run(`touch ${q(path)}`, ctx)
    },
    async mkdir(path, ctx) {
      await run(`mkdir -p ${q(path)}`, ctx)
    },
  }
}
