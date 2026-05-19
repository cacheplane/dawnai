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
