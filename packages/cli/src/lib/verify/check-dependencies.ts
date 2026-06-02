import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { loadDawnConfig } from "@dawn-ai/core"
import { resolveEnvPath } from "../dev/resolve-env-path.js"

export interface DependencyCheckResult {
  readonly missingPackages: readonly string[]
  readonly missingEnvVars: readonly string[]
}

export interface CheckDependenciesOptions {
  readonly appRoot: string
  /** From the --env-file CLI flag. Highest precedence. */
  readonly envFile?: string | undefined
}

/**
 * Required peer packages for Dawn LangChain/LangGraph routes.
 * These must be installed in the user's app for routes to function.
 */
const REQUIRED_PACKAGES = ["@langchain/core", "@langchain/openai", "@langchain/langgraph"] as const

/**
 * Environment variables that are strongly recommended for production use.
 * Missing vars emit warnings, not hard failures.
 */
const RECOMMENDED_ENV_VARS = ["OPENAI_API_KEY"] as const

export async function checkDependencies(
  options: CheckDependenciesOptions,
): Promise<DependencyCheckResult> {
  const { appRoot } = options
  const missingPackages: string[] = []
  const missingEnvVars: string[] = []

  // Check package.json dependencies
  const packageJsonPath = join(appRoot, "package.json")
  let declaredDeps: Set<string> = new Set()

  try {
    const raw = readFileSync(packageJsonPath, "utf8")
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    declaredDeps = new Set(Object.keys(allDeps))
  } catch {
    // Can't read package.json — skip package checks
    return { missingPackages: [], missingEnvVars: [] }
  }

  for (const pkg of REQUIRED_PACKAGES) {
    if (!declaredDeps.has(pkg)) {
      // Also check if it's resolvable (might be a transitive dep)
      const modulePath = join(appRoot, "node_modules", pkg)
      if (!existsSync(modulePath)) {
        missingPackages.push(pkg)
      }
    }
  }

  // Resolve the env file the same way dev-session does: flag > config > default.
  let configEnv: string | undefined
  try {
    const loaded = await loadDawnConfig({ appRoot })
    configEnv = loaded.config.env
  } catch {
    // No dawn.config.ts (or it failed to load) — fall through to default.
    configEnv = undefined
  }

  const resolved = resolveEnvPath({ appRoot, flag: options.envFile, configEnv })

  // Check environment variables (from process.env or the resolved env file)
  for (const envVar of RECOMMENDED_ENV_VARS) {
    if (!process.env[envVar]) {
      // Check if it's in the resolved env file
      if (existsSync(resolved.absPath)) {
        try {
          const content = readFileSync(resolved.absPath, "utf8")
          if (content.includes(`${envVar}=`)) {
            continue
          }
        } catch {
          // Ignore read errors
        }
      }
      missingEnvVars.push(envVar)
    }
  }

  return { missingPackages, missingEnvVars }
}
