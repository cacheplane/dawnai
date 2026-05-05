import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface DependencyCheckResult {
  readonly missingPackages: readonly string[]
  readonly missingEnvVars: readonly string[]
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

export function checkDependencies(appRoot: string): DependencyCheckResult {
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

  // Check environment variables (from process.env or .env file)
  for (const envVar of RECOMMENDED_ENV_VARS) {
    if (!process.env[envVar]) {
      // Check if it's in .env file
      const envPath = join(appRoot, ".env")
      if (existsSync(envPath)) {
        try {
          const content = readFileSync(envPath, "utf8")
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
