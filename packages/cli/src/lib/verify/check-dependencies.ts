import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { BuiltInModelProviderId } from "@dawn-ai/sdk"
import { resolveEnvPath } from "../dev/resolve-env-path.js"
import { loadDawnConfig } from "../node-config.js"

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

/**
 * Is `pkg` installed somewhere Node would find it from `appRoot`?
 *
 * Walks `<dir>/node_modules/<pkg>` up from `appRoot` to the filesystem root, the
 * way Node's own resolution walk does. The upward walk is the point: in an npm
 * workspace the generated app's `dawn.config.ts` lives in `<app>/server`, so
 * `appRoot` is the workspace MEMBER, while npm hoists dependencies to
 * `<app>/node_modules` one level up. A probe that looks only in
 * `appRoot/node_modules` reports every hoisted package as missing.
 *
 * Deliberately `existsSync` rather than `require.resolve(pkg)` or
 * `require.resolve(`${pkg}/package.json`)`: both consult the package's `exports`
 * map and throw ERR_PACKAGE_PATH_NOT_EXPORTED for packages that are genuinely
 * installed but do not export that subpath — trading a false "missing" warning
 * for a worse failure. A directory probe sidesteps `exports` entirely.
 *
 * pnpm needs no special casing: its public `node_modules/<pkg>` entries are
 * symlinks into the `.pnpm` store and `existsSync` follows symlinks, so a linked
 * package resolves true exactly as a copied one does. Packages that pnpm's
 * strict layout deliberately hides (transitive deps reachable only inside
 * `.pnpm`) stay hidden here — but Node would not resolve them from `appRoot`
 * either, so matching the resolution walk is the honest answer.
 */
function isPackageInstalled(appRoot: string, pkg: string): boolean {
  let dir = resolve(appRoot)
  for (;;) {
    if (existsSync(join(dir, "node_modules", pkg))) return true
    const parent = dirname(dir)
    // dirname() is a fixed point at the filesystem root ("/" → "/", "C:\" → "C:\").
    if (parent === dir) return false
    dir = parent
  }
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
      // Also check if it's resolvable (might be a transitive dep, or hoisted to
      // a workspace root above appRoot) — hence the upward walk.
      if (!isPackageInstalled(appRoot, pkg)) {
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
