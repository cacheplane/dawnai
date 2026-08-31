import { pathToFileURL } from "node:url"

import { downloadAndPrepareCalico } from "./calico.js"
import {
  type CompatibilityPolicy,
  loadCompatibilityPolicy,
  validateCompatibilityPolicy,
} from "./policy.js"
import { classifyKubernetesCompatibilityScope, type GitCommandRunner } from "./scope.js"

type JobResult = "success" | "failure" | "cancelled" | "skipped"
type OutputWriter = (chunk: string) => void
type PolicyLoader = () => Promise<unknown>
type CalicoPreparer = (outputPath: string, policy: CompatibilityPolicy["calico"]) => Promise<void>

export interface AggregateCompatibilityInput {
  readonly required?: unknown
  readonly scope?: unknown
  readonly compat?: unknown
}

export interface CompatibilityMatrixEntry {
  readonly target: string
  readonly version: string
  readonly nodeImage: string
  readonly clusterName: string
}

export interface CompatibilityMatrix {
  readonly include: readonly CompatibilityMatrixEntry[]
}

export interface WorkflowCliDependencies {
  readonly runCommand?: GitCommandRunner
  readonly loadPolicy?: PolicyLoader
  readonly prepareCalico?: CalicoPreparer
  readonly writeStdout?: OutputWriter
}

export interface WorkflowMainDependencies extends WorkflowCliDependencies {
  readonly writeStderr?: OutputWriter
}

const JOB_RESULTS = new Set<JobResult>(["success", "failure", "cancelled", "skipped"])

function isJobResult(value: unknown): value is JobResult {
  return typeof value === "string" && JOB_RESULTS.has(value as JobResult)
}

export function aggregateCompatibility(input: AggregateCompatibilityInput): boolean {
  if (
    typeof input.required !== "boolean" ||
    !isJobResult(input.scope) ||
    !isJobResult(input.compat) ||
    input.scope !== "success"
  ) {
    return false
  }

  return input.required ? input.compat === "success" : input.compat === "skipped"
}

export function createCompatibilityMatrix(rawPolicy: unknown): CompatibilityMatrix {
  const policy = validateCompatibilityPolicy(rawPolicy)
  const include: CompatibilityMatrixEntry[] = []
  const endpointRoles: string[] = []

  for (const target of policy.targets) {
    switch (target.role) {
      case "lower":
      case "upper":
        endpointRoles.push(target.role)
        include.push({
          target: target.minor,
          version: target.version,
          nodeImage: target.nodeImage,
          clusterName: `dawn-k8s-${target.role}`,
        })
        break
      case "canonical":
        break
      default:
        throw new Error(`Unknown Kubernetes compatibility target role: ${String(target.role)}`)
    }
  }

  if (include.length !== 2 || endpointRoles[0] !== "lower" || endpointRoles[1] !== "upper") {
    throw new Error("Kubernetes compatibility matrix must contain exactly lower and upper targets")
  }

  return { include }
}

function parseFlags(
  args: readonly string[],
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const flags = new Map<string, string>()

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    if (flag === undefined || !flag.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${String(flag)}`)
    }
    if (!allowed.has(flag)) {
      throw new Error(`Unknown flag: ${flag}`)
    }
    if (flags.has(flag)) {
      throw new Error(`Duplicate flag: ${flag}`)
    }

    const value = args[index + 1]
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`Missing value for flag: ${flag}`)
    }
    flags.set(flag, value)
  }

  return flags
}

function requireFlag(flags: ReadonlyMap<string, string>, flag: string): string {
  const value = flags.get(flag)
  if (value === undefined) {
    throw new Error(`Missing required flag: ${flag}`)
  }
  return value
}

async function loadValidatedPolicy(loadPolicy: PolicyLoader): Promise<CompatibilityPolicy> {
  return validateCompatibilityPolicy(await loadPolicy())
}

export async function runWorkflowCli(
  argv: readonly string[],
  dependencies: WorkflowCliDependencies = {},
): Promise<void> {
  const [operation, ...args] = argv
  const writeStdout = dependencies.writeStdout ?? ((chunk: string) => process.stdout.write(chunk))

  switch (operation) {
    case "scope": {
      const flags = parseFlags(args, new Set(["--event", "--base", "--head"]))
      const event = requireFlag(flags, "--event")
      if (
        (event === "schedule" || event === "workflow_dispatch") &&
        (flags.has("--base") || flags.has("--head"))
      ) {
        throw new Error(`${event} scope does not accept pull-request SHA flags`)
      }

      const required = await classifyKubernetesCompatibilityScope(
        {
          event,
          ...(flags.has("--base") ? { base: flags.get("--base") } : {}),
          ...(flags.has("--head") ? { head: flags.get("--head") } : {}),
        },
        dependencies.runCommand,
      )
      writeStdout(`${String(required)}\n`)
      return
    }
    case "matrix": {
      parseFlags(args, new Set())
      const policy = await loadValidatedPolicy(
        dependencies.loadPolicy ?? (() => loadCompatibilityPolicy()),
      )
      writeStdout(`${JSON.stringify(createCompatibilityMatrix(policy))}\n`)
      return
    }
    case "prepare-calico": {
      const flags = parseFlags(args, new Set(["--output"]))
      const outputPath = requireFlag(flags, "--output")
      const policy = await loadValidatedPolicy(
        dependencies.loadPolicy ?? (() => loadCompatibilityPolicy()),
      )
      await (dependencies.prepareCalico ?? downloadAndPrepareCalico)(outputPath, policy.calico)
      return
    }
    case undefined:
      throw new Error("Missing Kubernetes compatibility workflow operation")
    default:
      throw new Error(`Unknown Kubernetes compatibility workflow operation: ${operation}`)
  }
}

function errorDiagnostic(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

export async function runWorkflowMain(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: WorkflowMainDependencies = {},
): Promise<number> {
  try {
    await runWorkflowCli(argv, dependencies)
    return 0
  } catch (error) {
    const writeStderr = dependencies.writeStderr ?? ((chunk: string) => process.stderr.write(chunk))
    writeStderr(`${errorDiagnostic(error)}\n`)
    return 1
  }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void runWorkflowMain().then((exitCode) => {
    process.exitCode = exitCode
  })
}
