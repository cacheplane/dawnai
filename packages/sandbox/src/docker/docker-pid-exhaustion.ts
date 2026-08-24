import type { SpawnResult } from "./docker-cli.js"

export interface DockerPidExhaustionRecovery {
  readonly captureToken: () => unknown
  readonly recoverAndRetry: (
    token: unknown,
    retry: () => Promise<SpawnResult>,
  ) => Promise<SpawnResult | undefined>
}

export function isDockerExecAdmissionPidExhaustion(result: SpawnResult): boolean {
  if (result.exitCode === 0) return false
  const output = `${result.stdout}\n${result.stderr}`
  return (
    output.includes("OCI runtime exec failed") &&
    (output.includes("Resource temporarily unavailable") ||
      output.includes("read init-p: connection reset by peer") ||
      (output.includes("unable to start container process") &&
        output.includes("procReady not received")))
  )
}

function isShellForkFailure(line: string): boolean {
  const prefix = "sh: "
  if (!line.startsWith(prefix)) return false

  let detail = line.slice(prefix.length)
  const separator = detail.indexOf(": ")
  if (separator > 0) {
    const possibleLineNumber = detail.slice(0, separator)
    if ([...possibleLineNumber].every((character) => character >= "0" && character <= "9")) {
      detail = detail.slice(separator + 2)
    }
  }

  const normalized = detail.toLowerCase()
  return (
    normalized === "cannot fork" ||
    normalized === "can't fork" ||
    normalized === "cannot fork: resource temporarily unavailable" ||
    normalized === "can't fork: resource temporarily unavailable" ||
    normalized === "fork: resource temporarily unavailable" ||
    normalized === "fork: retry: resource temporarily unavailable"
  )
}

export function isStartedShellPidExhaustion(result: SpawnResult): boolean {
  if (result.exitCode === 0) return false
  const diagnostics = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return diagnostics.length > 0 && diagnostics.every(isShellForkFailure)
}
