import type { BuiltInModelProviderId, ModelProviderId } from "@dawn-ai/sdk"
import { inferProvider, SUPPORTED_AGENT_PROVIDERS } from "@dawn-ai/sdk"

export { inferProvider, SUPPORTED_AGENT_PROVIDERS }

const supportedProviderSet = new Set<string>(SUPPORTED_AGENT_PROVIDERS)

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
