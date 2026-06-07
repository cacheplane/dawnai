import type { EvalDefinition } from "./types.js"

export function defineEval(def: EvalDefinition): EvalDefinition {
  if (!def.name || def.name.trim() === "") {
    throw new Error("defineEval: `name` is required")
  }
  if (!def.scorers || def.scorers.length === 0) {
    throw new Error(`defineEval("${def.name}"): at least one scorer is required`)
  }
  if (Array.isArray(def.dataset) && def.dataset.length === 0) {
    throw new Error(`defineEval("${def.name}"): inline dataset is empty`)
  }
  if (def.dataset === undefined || def.dataset === null) {
    throw new Error(`defineEval("${def.name}"): dataset is required`)
  }
  return def
}
