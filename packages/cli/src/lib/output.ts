export interface CommandIo {
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
    stderr: (message) => {
      process.stderr.write(message)
    },
    stdout: (message) => {
      process.stdout.write(message)
    },
  }
}

export function writeLine(write: (message: string) => void, message = ""): void {
  write(`${message}\n`)
}

export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
