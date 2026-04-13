export interface CommandIo {
  readonly stdin?: () => Promise<string>
  readonly stdout: (message: string) => void
  readonly stderr: (message: string) => void
}

export class CliError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = "CliError"
    this.exitCode = exitCode
  }
}

export function createNodeIo(): CommandIo {
  return {
    stdin: async () => await readNodeStdin(),
    stderr: (message) => {
      process.stderr.write(message)
    },
    stdout: (message) => {
      process.stdout.write(message)
    },
  }
}

export async function readCommandStdin(io: CommandIo): Promise<string> {
  return await (io.stdin ? io.stdin() : readNodeStdin())
}

export function writeLine(write: (message: string) => void, message = ""): void {
  write(`${message}\n`)
}

export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readNodeStdin(): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const chunks: string[] = []

    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      chunks.push(String(chunk))
    })
    process.stdin.once("error", rejectPromise)
    process.stdin.once("end", () => {
      resolvePromise(chunks.join(""))
    })
    process.stdin.resume()
  })
}
