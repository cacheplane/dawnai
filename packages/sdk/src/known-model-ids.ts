import type { BuiltInModelProviderId } from "./model-provider.js"

export const OPENAI_MODEL_IDS = [
  // GPT-5.x series
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5-mini",
  // GPT-4.1 series
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  // GPT-4o series
  "gpt-4o",
  "gpt-4o-mini",
  // Reasoning
  "o3",
  "o3-mini",
  "o4-mini",
] as const

export const GOOGLE_MODEL_IDS = [
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const

export const ANTHROPIC_MODEL_IDS = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
] as const

export const XAI_MODEL_IDS = ["grok-4.3"] as const

export type OpenAiModelId = (typeof OPENAI_MODEL_IDS)[number]
export type GoogleModelId = (typeof GOOGLE_MODEL_IDS)[number]
export type AnthropicModelId = (typeof ANTHROPIC_MODEL_IDS)[number]
export type XaiModelId = (typeof XAI_MODEL_IDS)[number]

export type KnownModelId =
  | OpenAiModelId
  | GoogleModelId
  | AnthropicModelId
  | XaiModelId
  | (string & {})

/**
 * Curated id lists keyed by provider. Providers absent from this map are
 * uncurated — validation stays silent for them. Lists are advisory:
 * warn-only consumers must never hard-fail on a miss.
 */
export const CURATED_MODEL_IDS: Readonly<
  Partial<Record<BuiltInModelProviderId, readonly string[]>>
> = {
  openai: OPENAI_MODEL_IDS,
  google: GOOGLE_MODEL_IDS,
  anthropic: ANTHROPIC_MODEL_IDS,
  xai: XAI_MODEL_IDS,
}
