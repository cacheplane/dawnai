import generatedManifest from "./lastmod.generated.json"

export const STATIC_LASTMOD: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(generatedManifest.routes).map(([route, record]) => [route, record.lastModified]),
)
