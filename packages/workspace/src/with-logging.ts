import type {
  BackendContext,
  ExecMiddleware,
  FilesystemBackend,
  FilesystemMiddleware,
} from "./types.js"

export interface LoggingOptions {
  /**
   * Where to send log lines. Default: `console.error`.
   *
   * Pass a function for structured logging. The argument is
   * `{ method, args }` so the function can format however it wants.
   */
  readonly destination?: (entry: { method: string; args: unknown[] }) => void
}

function emit(opts: LoggingOptions, method: string, args: unknown[]): void {
  if (opts.destination) {
    opts.destination({ method, args })
    return
  }
  console.error(`[dawn:workspace] ${method}(${args.map((a) => JSON.stringify(a)).join(", ")})`)
}

export function withFilesystemLogging(opts: LoggingOptions = {}): FilesystemMiddleware {
  return (next: FilesystemBackend) => {
    const wrapped: FilesystemBackend = {
      readFile: async (path, ctx, readOpts) => {
        emit(opts, "readFile", [path])
        return next.readFile(path, ctx, readOpts)
      },
      writeFile: async (path, content, ctx) => {
        emit(opts, "writeFile", [path, content])
        return next.writeFile(path, content, ctx)
      },
      listDir: async (path, ctx) => {
        emit(opts, "listDir", [path])
        return next.listDir(path, ctx)
      },
    }

    // Forward binary read with PATH-ONLY logging — never serialize the bytes.
    const { readBinaryFile } = next
    if (readBinaryFile) {
      wrapped.readBinaryFile = async (
        path: string,
        ctx: BackendContext,
        readOpts?: { readonly maxBytes?: number },
      ) => {
        emit(opts, "readBinaryFile", [path])
        return readBinaryFile(path, ctx, readOpts)
      }
    }

    // Preserve optional capabilities the middleware previously dropped — dropping
    // statFile/removeFile/touchFile silently disabled offload GC behind the logger.
    // These are passthrough-only (not logged); the point of the fix is preservation.
    if (next.statFile) wrapped.statFile = next.statFile
    if (next.removeFile) wrapped.removeFile = next.removeFile
    if (next.touchFile) wrapped.touchFile = next.touchFile
    if (next.mkdir) wrapped.mkdir = next.mkdir

    return wrapped
  }
}

export function withExecLogging(opts: LoggingOptions = {}): ExecMiddleware {
  return (next) => ({
    runCommand: async (args, ctx) => {
      emit(opts, "runCommand", [args.command, args.cwd])
      return next.runCommand(args, ctx)
    },
  })
}
