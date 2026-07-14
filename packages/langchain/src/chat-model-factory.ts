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
    const baseURL = process.env.OPENAI_BASE_URL
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
