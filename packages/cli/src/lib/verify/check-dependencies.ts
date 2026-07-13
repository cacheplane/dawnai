import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { loadDawnConfig } from "@dawn-ai/core"
import type { BuiltInModelProviderId } from "@dawn-ai/sdk"
import { resolveEnvPath } from "../dev/resolve-env-path.js"

export interface DependencyCheckResult {
  readonly missingPackages: readonly string[]
  readonly missingEnvVars: readonly string[]
}

export interface CheckDependenciesOptions {
  readonly appRoot: string
  /**
   * Provider ids the app's routes actually use (derived from each route's model
   * id). The required API-key env vars are derived from these — an Anthropic-only
   * app checks for ANTHROPIC_API_KEY, not OPENAI_API_KEY. An empty/omitted list
   * means no API key is required.
   */
  readonly providers?: readonly string[]
  /** From the --env-file CLI flag. Highest precedence. */
  readonly envFile?: string | undefined
}

/**
 * Required peer packages for Dawn LangChain/LangGraph routes.
 * These must be installed in the user's app for routes to function.
 */
const REQUIRED_PACKAGES = ["@langchain/core", "@langchain/openai", "@langchain/langgraph"] as const

/**
 * Provider → the API-key env var it authenticates with. `null` means the
 * provider needs no key (e.g. a local Ollama server). Keyed exhaustively by the
 * SDK's provider union so it stays in lockstep with the provider list backing
 * `providerSpecs` in @dawn-ai/langchain's chat-model-factory.ts (source of truth).
 */
const PROVIDER_ENV_VAR: Record<BuiltInModelProviderId, string | null> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  ollama: null,
}

/** Derive the deduped set of required API-key env vars from the app's providers. */
function requiredEnvVars(providers: readonly string[]): readonly string[] {
  const vars = new Set<string>()
  for (const provider of providers) {
    const envVar = PROVIDER_ENV_VAR[provider as BuiltInModelProviderId]
    if (envVar) vars.add(envVar)
  }
  return [...vars]
}

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

  // Check the API-key env vars the app's providers actually need (from
  // process.env or the resolved env file). A missing key is a warning, not a
  // hard failure — a key may legitimately come from the runtime environment.
  for (const envVar of requiredEnvVars(options.providers ?? [])) {
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
