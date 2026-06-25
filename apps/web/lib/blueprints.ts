import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import matter from "gray-matter"

export const ALLOWED_CATEGORIES = ["observability", "retrieval", "deploy"] as const
export type BlueprintCategory = (typeof ALLOWED_CATEGORIES)[number]
export type BlueprintSource = "official" | "maintainer" | "community"

export interface BlueprintMeta {
  readonly name: string
  readonly category: string
  readonly description: string
  readonly website?: string
  readonly version: number
  readonly tags: readonly string[]
  readonly source: BlueprintSource
  readonly url: string
}

export interface BlueprintEntry {
  readonly meta: BlueprintMeta
  readonly body: string
}

const SITE = "https://dawnai.org"
const DEFAULT_DIR = join(process.cwd(), "content/blueprints")

function parseEntry(category: string, name: string, raw: string): BlueprintEntry {
  const { data, content } = matter(raw)
  const meta: BlueprintMeta = {
    name,
    category,
    description: typeof data.description === "string" ? data.description : "",
    ...(typeof data.website === "string" ? { website: data.website } : {}),
    version: typeof data.version === "number" ? data.version : 1,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    source: (typeof data.source === "string" ? data.source : "official") as BlueprintSource,
    url: `${SITE}/blueprints/${name}.md`,
  }
  return { meta, body: content.replace(/^\n+/, "") }
}

export function loadBlueprints(dir: string = DEFAULT_DIR): BlueprintEntry[] {
  if (!existsSync(dir)) {
    return []
  }
  const entries: BlueprintEntry[] = []
  for (const cat of readdirSync(dir, { withFileTypes: true })) {
    if (!cat.isDirectory()) {
      continue
    }
    for (const file of readdirSync(join(dir, cat.name))) {
      if (!file.endsWith(".md")) {
        continue
      }
      const name = file.replace(/\.md$/, "")
      entries.push(parseEntry(cat.name, name, readFileSync(join(dir, cat.name, file), "utf8")))
    }
  }
  return entries.sort((a, b) => a.meta.name.localeCompare(b.meta.name))
}

export function getBlueprint(name: string, dir: string = DEFAULT_DIR): BlueprintEntry | undefined {
  return loadBlueprints(dir).find((entry) => entry.meta.name === name)
}

export function validateBlueprints(dir: string = DEFAULT_DIR): string[] {
  const errors: string[] = []
  const seen = new Map<string, string>()
  for (const { meta, body } of loadBlueprints(dir)) {
    const id = `${meta.category}/${meta.name}`
    if (!(ALLOWED_CATEGORIES as readonly string[]).includes(meta.category)) {
      errors.push(`${id}: category "${meta.category}" not in ${ALLOWED_CATEGORIES.join(", ")}`)
    }
    const prior = seen.get(meta.name)
    if (prior) {
      errors.push(`${id}: duplicate name (also ${prior})`)
    } else {
      seen.set(meta.name, id)
    }
    if (meta.description.trim() === "") {
      errors.push(`${id}: missing required "description"`)
    }
    if (!Number.isInteger(meta.version) || meta.version < 1) {
      errors.push(`${id}: version must be a positive integer`)
    }
    if (!(["official", "maintainer", "community"] as readonly string[]).includes(meta.source)) {
      errors.push(`${id}: source "${meta.source}" must be official, maintainer, or community`)
    }
    if (meta.website !== undefined) {
      try {
        new URL(meta.website)
      } catch {
        errors.push(`${id}: website is not a valid URL`)
      }
    }
    if (!/^#\s/m.test(body)) {
      errors.push(`${id}: body must contain an H1 heading`)
    }
  }
  return errors
}
