import { createHash, randomUUID } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { TextDecoder } from "node:util"

import { parseAllDocuments } from "yaml"

import type { CompatibilityPolicy } from "./policy.js"

const DOWNLOAD_TIMEOUT_MS = 30_000
const ELIGIBLE_CONTAINER_KEYS = new Set(["containers", "initContainers"])

type CalicoPolicy = CompatibilityPolicy["calico"]
type ImageMapping = CalicoPolicy["images"][number]
type ValuePath = readonly (number | string)[]

interface EligibleImageField {
  readonly documentIndex: number
  readonly path: ValuePath
  readonly value: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function formatPath(path: ValuePath): string {
  let formatted = "$"
  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`
    } else if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment)) {
      formatted += `.${segment}`
    } else {
      formatted += `[${JSON.stringify(segment)}]`
    }
  }
  return formatted
}

function collectEligibleImageFields(
  value: unknown,
  documentIndex: number,
  path: ValuePath = [],
  ancestors = new Set<object>(),
): EligibleImageField[] {
  if (typeof value !== "object" || value === null) {
    return []
  }
  if (ancestors.has(value)) {
    throw new Error(
      `Calico manifest YAML document ${documentIndex + 1} contains a cyclic value at ${formatPath(path)}`,
    )
  }

  ancestors.add(value)
  const fields: EligibleImageField[] = []

  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      fields.push(...collectEligibleImageFields(child, documentIndex, [...path, index], ancestors))
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key]
      if (ELIGIBLE_CONTAINER_KEYS.has(key) && Array.isArray(child)) {
        for (const [index, entry] of child.entries()) {
          if (isObject(entry) && Object.hasOwn(entry, "image")) {
            fields.push({
              documentIndex,
              path: [...childPath, index, "image"],
              value: entry.image,
            })
          }
        }
      }
      fields.push(...collectEligibleImageFields(child, documentIndex, childPath, ancestors))
    }
  }

  ancestors.delete(value)
  return fields
}

function mappingBySource(policy: CalicoPolicy): ReadonlyMap<string, ImageMapping> {
  const mappings = new Map<string, ImageMapping>()
  for (const mapping of policy.images) {
    if (mappings.has(mapping.source)) {
      throw new Error(`Duplicate Calico image source mapping for "${mapping.source}"`)
    }
    mappings.set(mapping.source, mapping)
  }
  return mappings
}

function toDocumentValues(documents: ReturnType<typeof parseAllDocuments>): {
  readonly fields: EligibleImageField[]
  readonly values: unknown[]
} {
  const values: unknown[] = []
  const fields: EligibleImageField[] = []

  for (const [documentIndex, document] of documents.entries()) {
    let value: unknown
    try {
      value = document.toJS()
    } catch (cause) {
      throw new Error(
        `Failed to read Calico manifest YAML document ${documentIndex + 1} as structured data`,
        { cause },
      )
    }
    values.push(value)
    fields.push(...collectEligibleImageFields(value, documentIndex))
  }

  return { fields, values }
}

function assertExpectedOccurrences(
  fields: readonly EligibleImageField[],
  mappings: ReadonlyMap<string, ImageMapping>,
): void {
  const counts = new Map<string, number>()
  for (const source of mappings.keys()) {
    counts.set(source, 0)
  }

  for (const field of fields) {
    if (typeof field.value === "string" && mappings.has(field.value)) {
      counts.set(field.value, (counts.get(field.value) ?? 0) + 1)
    }
  }

  for (const mapping of mappings.values()) {
    const observed = counts.get(mapping.source) ?? 0
    if (observed !== mapping.occurrences) {
      throw new Error(
        `Calico image "${mapping.source}" occurrence mismatch: expected ${mapping.occurrences}, observed ${observed}`,
      )
    }
  }
}

function assertOnlyExpectedTargets(
  fields: readonly EligibleImageField[],
  mappings: ReadonlyMap<string, ImageMapping>,
): void {
  const targets = new Set([...mappings.values()].map(({ target }) => target))

  for (const field of fields) {
    if (typeof field.value === "string" && mappings.has(field.value)) {
      throw new Error(
        `Configured Calico source image "${field.value}" remains at YAML document ${field.documentIndex + 1} ${formatPath(field.path)} after rewrite`,
      )
    }
    if (typeof field.value !== "string" || !targets.has(field.value)) {
      throw new Error(
        `Unknown Calico image ${JSON.stringify(field.value)} at YAML document ${field.documentIndex + 1} ${formatPath(field.path)} after rewrite`,
      )
    }
  }
}

export function verifyAndRewriteCalico(raw: Uint8Array, policy: CalicoPolicy): string {
  const observedChecksum = createHash("sha256").update(raw).digest("hex")
  if (observedChecksum !== policy.sha256) {
    throw new Error(
      `Calico manifest checksum mismatch: expected ${policy.sha256}, observed ${observedChecksum}`,
    )
  }

  let source: string
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(raw)
  } catch (cause) {
    throw new Error("Calico manifest is not valid UTF-8", { cause })
  }

  const documents = parseAllDocuments(source)
  if (documents.length === 0) {
    throw new Error("Calico manifest contains no YAML documents")
  }

  const documentErrors = documents.flatMap((document, documentIndex) =>
    document.errors.map((error) => `YAML document ${documentIndex + 1}: ${error.message}`),
  )
  if (documentErrors.length > 0) {
    throw new Error(`Invalid Calico manifest YAML:\n${documentErrors.join("\n")}`)
  }

  const mappings = mappingBySource(policy)
  const { fields } = toDocumentValues(documents)
  assertExpectedOccurrences(fields, mappings)

  for (const field of fields) {
    if (typeof field.value !== "string") {
      continue
    }
    const mapping = mappings.get(field.value)
    if (mapping === undefined) {
      continue
    }
    const document = documents[field.documentIndex]
    if (document === undefined) {
      throw new Error(`Calico manifest YAML document ${field.documentIndex + 1} is missing`)
    }
    document.setIn(field.path, mapping.target)
  }

  const rewritten = toDocumentValues(documents)
  assertOnlyExpectedTargets(rewritten.fields, mappings)
  return documents.map((document) => document.toString()).join("")
}

export async function downloadAndPrepareCalico(
  outputPath: string,
  policy: CalicoPolicy,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new Error("Calico manifest download timed out after 30 seconds"))
  }, DOWNLOAD_TIMEOUT_MS)
  let temporaryPath: string | undefined

  try {
    const response = await fetchImpl(policy.manifestUrl, { signal: controller.signal })
    if (!response.ok) {
      const status =
        response.statusText.length > 0
          ? `${response.status} ${response.statusText}`
          : String(response.status)
      throw new Error(`Failed to download Calico manifest: HTTP ${status}`)
    }

    const raw = new Uint8Array(await response.arrayBuffer())
    const prepared = verifyAndRewriteCalico(raw, policy)
    temporaryPath = join(
      dirname(outputPath),
      `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
    )
    await writeFile(temporaryPath, prepared, { encoding: "utf8", flag: "wx", mode: 0o600 })
    await rename(temporaryPath, outputPath)
    temporaryPath = undefined
  } finally {
    clearTimeout(timeout)
    if (temporaryPath !== undefined) {
      await rm(temporaryPath, { force: true })
    }
  }
}
