import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Dataset, EvalCase } from "./types.js"

export async function resolveDataset(dataset: Dataset, baseDir: string): Promise<EvalCase[]> {
  if (Array.isArray(dataset)) return [...dataset]
  if (typeof dataset === "function") return [...(await dataset())]
  if (typeof dataset === "string") {
    const path = isAbsolute(dataset) ? dataset : resolve(baseDir, dataset)
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch (err) {
      throw new Error(
        `resolveDataset: cannot read dataset file "${path}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (path.endsWith(".jsonl")) {
      return raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line, i) => {
          try {
            return JSON.parse(line) as EvalCase
          } catch {
            throw new Error(`resolveDataset: invalid JSONL at line ${i + 1} in "${path}"`)
          }
        })
    }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      throw new Error(`resolveDataset: "${path}" must contain a JSON array of cases`)
    }
    return parsed as EvalCase[]
  }
  throw new Error("resolveDataset: dataset must be an array, a path string, or a function")
}
