import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { providerPackages } from "@dawn-ai/langchain"
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
 * The packages Dawn's own LangChain/LangGraph layer imports no matter which
 * model an app runs. Every Dawn app needs both.
 *
 * The provider packages are NOT here: which one an app needs is a function of
 * the providers its routes use, exactly as the required API-key env var is.
 * See {@link requiredPackages}.
 */
const DAWN_LAYER_PACKAGES = ["@langchain/core", "@langchain/langgraph"] as const

/** The package that imports {@link DAWN_LAYER_PACKAGES} and every provider package. */
const IMPORTING_PACKAGE = "@dawn-ai/langchain"

/**
 * Every package this app must be able to resolve: Dawn's own layer, plus one
 * model package per provider its routes use.
 *
 * `providerPackages` is the same provider→package map `dawn build`'s
 * web-runtime target bakes into an edge bundle, so verify and build answer
 * "which model package does this app need" from one source. A provider with no
 * entry is skipped rather than guessed at — `providers` is derived from route
 * model ids, and an id Dawn cannot map must not invent a package name.
 */
function requiredPackages(providers: readonly string[]): readonly string[] {
  const forProviders = new Set<string>()
  for (const provider of providers) {
    const packageName = providerPackages[provider as BuiltInModelProviderId]
    if (packageName) forProviders.add(packageName)
  }
  return [...DAWN_LAYER_PACKAGES, ...[...forProviders].sort()]
}

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
 * Is `pkg` installed somewhere Node would find it from `from`?
 *
 * Walks `<dir>/node_modules/<pkg>` up from `from` to the filesystem root, the
 * way Node's own resolution walk does. The upward walk is the point: in an npm
 * workspace the generated app's `dawn.config.ts` lives in `<app>/server`, so
 * the app root is the workspace MEMBER, while npm hoists dependencies to
 * `<app>/node_modules` one level up. A probe that looks only in one directory
 * reports every hoisted package as missing.
 *
 * Deliberately `existsSync` rather than `require.resolve(pkg)` or
 * `require.resolve(`${pkg}/package.json`)`: both consult the package's `exports`
 * map and throw ERR_PACKAGE_PATH_NOT_EXPORTED for packages that are genuinely
 * installed but do not export that subpath — trading a false "missing" warning
 * for a worse failure. A directory probe sidesteps `exports` entirely.
 */
function isPackageInstalled(from: string, pkg: string): boolean {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(join(dir, "node_modules", pkg))) return true
    const parent = dirname(dir)
    // dirname() is a fixed point at the filesystem root ("/" → "/", "C:\" → "C:\").
    if (parent === dir) return false
    dir = parent
  }
}

/**
 * Where to start the walk, nearest importer first.
 *
 * These packages are imported by `@dawn-ai/langchain`, not by the user's app,
 * so the question Node will actually ask at runtime is whether THAT package can
 * resolve them. Rooting the walk only at the app is what made the flagship
 * example report all three Dawn-layer packages missing on every `dawn verify`
 * while they were installed and working: pnpm keeps a package's dependencies in
 * the store beside it, reachable from the importer and deliberately not from
 * the app. npm's layout is a subset of that — a hoisted dependency sits above
 * the importer and is found by the same walk.
 *
 * `realpathSync` is what crosses pnpm's symlink: the app's entry is a link into
 * the store, and the dependencies sit beside the REAL directory, not the link.
 * A link that cannot be resolved falls back to its own path rather than
 * dropping the root, so a broken install degrades to today's answer instead of
 * throwing.
 *
 * The app root stays in the list. An app may declare and import these packages
 * itself, and when `@dawn-ai/langchain` is not installed at all it is the only
 * root there is.
 */
function resolutionRoots(appRoot: string): readonly string[] {
  const importer = importingPackageDir(appRoot)
  return importer ? [importer, appRoot] : [appRoot]
}

/** The real directory of the installed `@dawn-ai/langchain`, or undefined. */
function importingPackageDir(appRoot: string): string | undefined {
  let dir = resolve(appRoot)
  for (;;) {
    const candidate = join(dir, "node_modules", IMPORTING_PACKAGE)
    if (existsSync(candidate)) {
      try {
        return realpathSync(candidate)
      } catch {
        return candidate
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
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

  // A declared dependency is satisfied by declaration alone. Filtering first
  // keeps the filesystem out of it entirely for an app that declares everything.
  const undeclared = requiredPackages(options.providers ?? []).filter(
    (pkg) => !declaredDeps.has(pkg),
  )

  if (undeclared.length > 0) {
    const roots = resolutionRoots(appRoot)
    for (const pkg of undeclared) {
      if (!roots.some((root) => isPackageInstalled(root, pkg))) {
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
