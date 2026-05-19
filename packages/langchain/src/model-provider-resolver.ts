import type { BuiltInModelProviderId, ModelProviderId } from "@dawn-ai/sdk"

export const SUPPORTED_AGENT_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "mistral",
  "groq",
  "ollama",
  "xai",
  "openrouter",
] as const satisfies readonly BuiltInModelProviderId[]

const supportedProviderSet = new Set<string>(SUPPORTED_AGENT_PROVIDERS)

export function inferProvider(model: string): BuiltInModelProviderId | undefined {
  const normalized = model.trim().toLowerCase()

  if (/^(gpt-|o3|o4)/.test(normalized)) return "openai"
  if (normalized.startsWith("claude-")) return "anthropic"
  if (normalized.startsWith("gemini-")) return "google"
  if (
    normalized.startsWith("mistral-") ||
    normalized.startsWith("mixtral-") ||
    normalized.startsWith("codestral-")
  ) {
    return "mistral"
  }
  if (normalized.startsWith("grok-")) return "xai"

  return undefined
}

export function resolveProvider(options: {
  readonly model: string
  readonly provider?: ModelProviderId
}): BuiltInModelProviderId {
  if (options.provider !== undefined) {
    if (supportedProviderSet.has(options.provider)) {
      return options.provider as BuiltInModelProviderId
    }
    throw new Error(
      `Unsupported agent provider "${options.provider}". Supported providers: ${SUPPORTED_AGENT_PROVIDERS.join(", ")}.`,
    )
  }

  const inferred = inferProvider(options.model)
  if (inferred) return inferred

  throw new Error(
    `Could not infer a LangChain provider for model "${options.model}". Set provider explicitly on agent({ provider: "...", model: "${options.model}", ... }).`,
  )
}
