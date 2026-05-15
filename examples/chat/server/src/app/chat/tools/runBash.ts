import { spawn } from "node:child_process"
import { workspaceRoot } from "../workspace-path.js"

const MAX_TIMEOUT_SECONDS = 120

/**
 * Run a bash command in the workspace directory. Captures stdout and stderr,
 * enforces a hard timeout, and returns the combined output with an exit-code
 * footer. NOT a sandbox — do not run untrusted commands.
 */
export default async (
  input: { readonly command: string; readonly timeoutSeconds: number },
): Promise<string> => {
  const timeout = Math.min(Math.max(1, input.timeoutSeconds), MAX_TIMEOUT_SECONDS)
  const cwd = workspaceRoot()

  return new Promise((resolveResult) => {
    const child = spawn("bash", ["-c", input.command], { cwd })
    let output = ""
    child.stdout.on("data", (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      output += chunk.toString()
    })

    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      output += `\n[killed: exceeded ${timeout}s timeout]`
    }, timeout * 1000)

    child.on("close", (code) => {
      clearTimeout(timer)
      resolveResult(`${output}\n[exit ${code ?? "?"}]`)
    })
  })
}
