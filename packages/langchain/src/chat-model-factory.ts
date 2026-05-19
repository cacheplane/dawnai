import type { BuiltInModelProviderId, ReasoningConfig } from "@dawn-ai/sdk"

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

export function missingProviderPackageMessage(
  provider: BuiltInModelProviderId,
  packageName: string,
): string {
  return `Provider "${provider}" requires ${packageName}. Install it with: pnpm add ${packageName}`
}

export async function createChatModel(options: {
  readonly model: string
  readonly provider: BuiltInModelProviderId
  readonly reasoning?: ReasoningConfig
  readonly importer?: Importer
}): Promise<unknown> {
  const spec = providerSpecs[options.provider]
  const importer =
    options.importer ??
    ((specifier: string) => import(specifier) as Promise<Record<string, unknown>>)

  let moduleExports: Record<string, unknown>
  try {
    moduleExports = await importer(spec.packageName)
  } catch (error) {
    if (isMissingModuleError(error)) {
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

  return new (Constructor as ChatModelConstructor)(constructorOptions)
}

function isMissingModuleError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ("code" in error ? (error as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND" : true) &&
    /Cannot find (package|module)|ERR_MODULE_NOT_FOUND/i.test(error.message)
  )
}
