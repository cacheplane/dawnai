import type { ExecMiddleware, FilesystemBackend, FilesystemMiddleware } from "./types.js"

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
  return (next: FilesystemBackend) => ({
    readFile: async (path, ctx) => {
      emit(opts, "readFile", [path])
      return next.readFile(path, ctx)
    },
    writeFile: async (path, content, ctx) => {
      emit(opts, "writeFile", [path, content])
      return next.writeFile(path, content, ctx)
    },
    listDir: async (path, ctx) => {
      emit(opts, "listDir", [path])
      return next.listDir(path, ctx)
    },
  })
}

export function withExecLogging(opts: LoggingOptions = {}): ExecMiddleware {
  return (next) => ({
    runCommand: async (args, ctx) => {
      emit(opts, "runCommand", [args.command, args.cwd])
      return next.runCommand(args, ctx)
    },
  })
}
