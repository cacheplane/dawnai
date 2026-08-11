import { spawn } from "node:child_process"
import { TextDecoder } from "node:util"

export const KUBERNETES_COMPATIBILITY_PATHS = Object.freeze({
  exact: Object.freeze([
    ".npmrc",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "turbo.json",
    ".github/workflows/ci.yml",
    ".github/workflows/kubernetes-compat.yml",
    ".github/kubernetes-compatibility.json",
    "scripts/kubernetes-compat.ts",
    "packages/workspace/src/sandbox-types.ts",
  ]),
  prefixes: Object.freeze([
    ".github/kind/",
    "scripts/kubernetes-compat/",
    "test/k8s-compat/",
    "test/k8s-smoke/",
    "packages/sandbox/",
    "charts/dawn-app/",
    "charts/dawn-sandbox-infra/",
  ]),
})

export interface GitCommandResult {
  readonly stdout: Buffer
}

export type GitCommandRunner = (file: string, args: readonly string[]) => Promise<GitCommandResult>

export interface KubernetesCompatibilityScopeRequest {
  readonly event: unknown
  readonly base?: unknown
  readonly head?: unknown
}

const EXACT_PATHS = new Set<string>(KUBERNETES_COMPATIBILITY_PATHS.exact)
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/

export function isKubernetesCompatibilityPath(path: string): boolean {
  return (
    EXACT_PATHS.has(path) ||
    KUBERNETES_COMPATIBILITY_PATHS.prefixes.some((prefix) => path.startsWith(prefix))
  )
}

export function parseNulDelimitedGitPaths(output: Buffer): readonly string[] {
  if (output.length === 0) {
    return []
  }
  if (output[output.length - 1] !== 0) {
    throw new Error("Malformed NUL-delimited Git diff output: missing final NUL byte")
  }

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  const paths: string[] = []
  let start = 0

  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) {
      continue
    }
    if (index === start) {
      throw new Error("Malformed NUL-delimited Git diff output: empty filename")
    }

    try {
      paths.push(decoder.decode(output.subarray(start, index)))
    } catch (cause) {
      throw new Error("Malformed Git diff filename: expected valid UTF-8", { cause })
    }
    start = index + 1
  }

  return paths
}

function runShellFreeCommand(file: string, args: readonly string[]): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk)
    })
    child.once("error", reject)
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout) })
        return
      }

      const diagnostic = Buffer.concat(stderr).toString("utf8").trim()
      const outcome = signal === null ? `exit code ${String(code)}` : `signal ${signal}`
      reject(
        new Error(
          `Command ${file} failed with ${outcome}${diagnostic.length > 0 ? `: ${diagnostic}` : ""}`,
        ),
      )
    })
  })
}

function expectCommitSha(value: unknown, name: "base" | "head"): string {
  if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
    throw new Error(`Pull-request ${name} SHA must be exactly 40 lowercase hexadecimal characters`)
  }
  return value
}

export async function classifyKubernetesCompatibilityScope(
  request: KubernetesCompatibilityScopeRequest,
  runCommand: GitCommandRunner = runShellFreeCommand,
): Promise<boolean> {
  if (request.event === "schedule" || request.event === "workflow_dispatch") {
    return true
  }
  if (request.event !== "pull_request") {
    throw new Error(`Unknown Kubernetes compatibility event mode: ${String(request.event)}`)
  }

  const base = expectCommitSha(request.base, "base")
  const head = expectCommitSha(request.head, "head")

  await runCommand("git", ["cat-file", "-e", `${base}^{commit}`])
  await runCommand("git", ["cat-file", "-e", `${head}^{commit}`])
  const { stdout } = await runCommand("git", ["diff", "--name-only", "-z", base, head])
  if (!Buffer.isBuffer(stdout)) {
    throw new Error("Malformed Git diff output: expected a Buffer")
  }

  return parseNulDelimitedGitPaths(stdout).some(isKubernetesCompatibilityPath)
}
