export type OpenAiModelId =
  // GPT-5.x series
  | "gpt-5.5"
  | "gpt-5.5-pro"
  | "gpt-5.4"
  | "gpt-5.4-pro"
  | "gpt-5-mini"
  // GPT-4.1 series
  | "gpt-4.1"
  | "gpt-4.1-mini"
  | "gpt-4.1-nano"
  // GPT-4o series
  | "gpt-4o"
  | "gpt-4o-mini"
  // Reasoning
  | "o3"
  | "o3-mini"
  | "o4-mini"

export type AnthropicModelId =
  | "assistant-opus-4-7"
  | "assistant-sonnet-4-6"
  | "assistant-haiku-4-5-20251001"

export type GoogleModelId =
  | "gemini-3-pro-preview"
  | "gemini-3-flash-preview"
  | "gemini-2.5-pro"
  | "gemini-2.5-flash"
  | "gemini-2.5-flash-lite"

export type KnownModelId =
  | OpenAiModelId
  | AnthropicModelId
  | GoogleModelId
  | (string & {})
