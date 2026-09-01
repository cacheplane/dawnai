import catalog from "./demo-media.json"

export interface DemoClip {
  readonly mp4: string
  readonly webm: string
  readonly poster: string
  readonly caption: string
  readonly ariaLabel: string
  readonly transcript: string
}

export type DemoClipKey = "productLoop" | "author" | "test" | "run"

const clipKeys = ["productLoop", "author", "test", "run"] as const
const clipFileNames: Readonly<Record<DemoClipKey, string>> = {
  productLoop: "product-loop",
  author: "author",
  test: "test",
  run: "run",
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function validateHostedMediaUrl(
  value: unknown,
  extension: "mp4" | "webm",
  key: DemoClipKey,
): value is string {
  if (!isNonemptyString(value)) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" && url.pathname.endsWith(`/demo/${clipFileNames[key]}.${extension}`)
    )
  } catch {
    return false
  }
}

function validateClip(value: unknown, key: DemoClipKey): DemoClip {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Demo media entry ${key} must be an object`)
  }

  const clip = value as Record<string, unknown>
  const { mp4, webm, poster, caption, ariaLabel, transcript } = clip
  const expectedFields = ["mp4", "webm", "poster", "caption", "ariaLabel", "transcript"]
  if (
    JSON.stringify(Object.keys(clip).sort()) !== JSON.stringify([...expectedFields].sort()) ||
    !validateHostedMediaUrl(mp4, "mp4", key) ||
    !validateHostedMediaUrl(webm, "webm", key) ||
    poster !== `/demo/${clipFileNames[key]}-poster.webp` ||
    !isNonemptyString(caption) ||
    !isNonemptyString(ariaLabel) ||
    !isNonemptyString(transcript) ||
    !transcript.startsWith(
      "https://github.com/cacheplane/dawnai/blob/main/docs/brand/demo/transcript.md#",
    )
  ) {
    throw new Error(`Demo media entry ${key} violates the clip contract`)
  }

  return Object.freeze({
    mp4,
    webm,
    poster,
    caption,
    ariaLabel,
    transcript,
  })
}

function validateCatalog(value: unknown): Readonly<Record<DemoClipKey, DemoClip>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Demo media catalog must be an object")
  }

  const entries = value as Record<string, unknown>
  if (JSON.stringify(Object.keys(entries).sort()) !== JSON.stringify([...clipKeys].sort())) {
    throw new Error("Demo media catalog must contain exactly productLoop, author, test, and run")
  }

  return Object.freeze(
    Object.fromEntries(clipKeys.map((key) => [key, validateClip(entries[key], key)])) as Record<
      DemoClipKey,
      DemoClip
    >,
  )
}

export const demoMedia = validateCatalog(catalog)
