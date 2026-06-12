export type BuiltInModelProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "groq"
  | "ollama"
  | "xai"
  | "openrouter"

export type ModelProviderId = BuiltInModelProviderId | (string & {})

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
