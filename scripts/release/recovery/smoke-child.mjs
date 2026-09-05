// This process receives proof data and an allowlisted host environment, never API authority.
import { readBoundedRegularFile } from "../../lib/published-artifacts.mjs"
import { createStrictSmokeProcessRunner } from "../smoke-process-runner.mjs"
import { boundedRecoveryPath, canonicalRequestBytes } from "./requests.mjs"
import { runRecoverySmoke } from "./smoke.mjs"

try {
  if (process.argv.length !== 3) throw new Error("Exact smoke child request required")
  const bytes = await readBoundedRegularFile(
    boundedRecoveryPath(process.argv[2]),
    16384,
    "Prepared smoke request",
  )
  const request = JSON.parse(bytes.toString("utf8"))
  if (!canonicalRequestBytes(request).equals(bytes))
    throw new Error("Canonical child request required")
  const runner = createStrictSmokeProcessRunner(),
    active = new Set()
  const stop = () => {
    for (const controller of active) controller.abort()
  }
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
  const operation = async (method, args, options) => {
    const controller = new AbortController()
    active.add(controller)
    try {
      return await runner[method](...args, {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([controller.signal, options.signal])
          : controller.signal,
      })
    } finally {
      active.delete(controller)
    }
  }
  try {
    await runRecoverySmoke(request, {
      strictRunner: {
        probe: (options) => operation("probe", [], options),
        runCommand: (command, args, options) => operation("runCommand", [command, args], options),
      },
    })
  } finally {
    process.off("SIGTERM", stop)
    process.off("SIGINT", stop)
  }
} catch {
  process.stderr.write("Recovery smoke child failed; retained evidence is diagnostic only\n")
  process.exitCode = 1
}
