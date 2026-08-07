import { readRuntimeEnv } from "@dawn-ai/core"
import type { BuiltInModelProviderId, ReasoningConfig } from "@dawn-ai/sdk"
import { errorDocsUrl, validateModelId } from "@dawn-ai/sdk"

type Importer = (specifier: string) => Promise<Record<string, unknown>>
type ChatModelConstructor = new (options: Record<string, unknown>) => unknown

interface ProviderSpec {
  readonly packageName: string
  readonly exportName: string
}

const providerSpecs: Record<BuiltInModelProviderId, ProviderSpec> = {
  openai: { packageName: "@langchain/openai", exportName: "ChatOpenAI" },
  anthropic: { packageName: "@langchain/anthropic", exportName: "ChatAnthropic" },
  // Official LangChain JS docs and current npm availability support this stable package/class.
  google: { packageName: "@langchain/google-genai", exportName: "ChatGoogleGenerativeAI" },
  mistral: { packageName: "@langchain/mistralai", exportName: "ChatMistralAI" },
  groq: { packageName: "@langchain/groq", exportName: "ChatGroq" },
  ollama: { packageName: "@langchain/ollama", exportName: "ChatOllama" },
  xai: { packageName: "@langchain/xai", exportName: "ChatXAI" },
  openrouter: { packageName: "@langchain/openrouter", exportName: "ChatOpenRouter" },
}

/** Provider → the package that ships its chat model class. */
export const providerPackages: Readonly<Record<BuiltInModelProviderId, string>> =
  Object.fromEntries(
    Object.entries(providerSpecs).map(([provider, spec]) => [provider, spec.packageName]),
  ) as Readonly<Record<BuiltInModelProviderId, string>>

/**
 * The importer used when a call site passes none. Seeded, not injected,
 * because every `createChatModel` call sits behind route execution and threading
 * an option down to it would touch every layer in between — the same reason
 * `seedDawnConfig` exists.
 *
 * Set by a build-emitted edge entry point, whose bundle cannot contain the
 * default below: `import(specifier)` on a variable is unresolvable to a bundler,
 * so an edge deploy must hand over a map of STATIC specifiers instead. Unset on
 * every node path, which keeps the dynamic import.
 */
let seededImporter: Importer | undefined

/** Install the process-wide fallback importer. Last call wins. */
export function seedModelImporter(importer: Importer): void {
  seededImporter = importer
}

const warnedModelIds = new Set<string>()

/** Advisory once-per-process warning; never blocks model construction. */
export function warnOnUnknownModelId(opts: {
  readonly model: string
  readonly provider: string
}): void {
  const key = `${opts.provider} ${opts.model}`
  if (warnedModelIds.has(key)) return
  const verdict = validateModelId(opts)
  if (verdict.ok) return
  warnedModelIds.add(key)
  const suggestions = verdict.suggestions.map((s) => `"${s}"`).join(", ")
  console.warn(
    `[dawn:models] [DAWN_E4002] model "${opts.model}" is not a known ${verdict.provider} model id.` +
      (suggestions ? ` Did you mean ${suggestions}?` : "") +
      " Proceeding anyway.",
  )
}

export function missingProviderPackageMessage(
  provider: BuiltInModelProviderId,
  packageName: string,
): string {
  const url = errorDocsUrl("DAWN_E4001")
  const docs = url ? ` See ${url}` : ""
  return `Provider "${provider}" requires ${packageName}. Install it with: pnpm add ${packageName} [DAWN_E4001]${docs}`
}

export async function createChatModel(options: {
  readonly model: string
  readonly provider: BuiltInModelProviderId
  readonly reasoning?: ReasoningConfig
  readonly importer?: Importer
}): Promise<unknown> {
  warnOnUnknownModelId({ model: options.model, provider: options.provider })
  const spec = providerSpecs[options.provider]
  const importer =
    options.importer ??
    seededImporter ??
    ((specifier: string) => import(specifier) as Promise<Record<string, unknown>>)

  let moduleExports: Record<string, unknown>
  try {
    moduleExports = await importer(spec.packageName)
  } catch (error) {
    if (isMissingModuleError(error, spec.packageName)) {
      throw new Error(missingProviderPackageMessage(options.provider, spec.packageName))
    }
    throw error
  }

  const Constructor = moduleExports[spec.exportName]
  if (typeof Constructor !== "function") {
    throw new Error(
      `Provider "${options.provider}" package ${spec.packageName} does not export ${spec.exportName}.`,
    )
  }

  const constructorOptions: Record<string, unknown> = { model: options.model }
  if (options.provider === "openai" && options.reasoning?.effort) {
    constructorOptions.reasoningEffort = options.reasoning.effort
  }

  if (options.provider === "openai") {
    // NOT a `typeof process` guard: this knob is load-bearing, not debug-only.
    // Guarding it would turn a crash into an edge deploy whose base URL cannot
    // be set at all — including the workerd CI lane, which points the model at
    // a local aimock through exactly this variable. `readRuntimeEnv` still
    // prefers `process.env`, so the Node path is unchanged.
    const baseURL = readRuntimeEnv("OPENAI_BASE_URL")
    if (baseURL) {
      constructorOptions.configuration = { baseURL }
    }
  }

  return new (Constructor as ChatModelConstructor)(constructorOptions)
}

function isMissingModuleError(error: unknown, expectedPackageName: string): boolean {
  return (
    error instanceof Error &&
    ("code" in error ? (error as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND" : true) &&
    referencesPackageSpecifier(error.message, expectedPackageName) &&
    /Cannot find (package|module)|ERR_MODULE_NOT_FOUND/i.test(error.message)
  )
}

function referencesPackageSpecifier(message: string, packageName: string): boolean {
  return (
    message.includes(`'${packageName}'`) ||
    message.includes(`"${packageName}"`) ||
    message.includes(`\`${packageName}\``)
  )
}
