import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { FixtureSet, ScriptBuilder } from "./fixture-builder.js"

/** Normalise a ScriptBuilder or bare FixtureSet to a FixtureSet. */
function toFixtureSet(f: FixtureSet | ScriptBuilder): FixtureSet {
  if (Array.isArray(f)) return f
  return f.build()
}

/**
 * Write a FixtureSet (or ScriptBuilder) to a JSON file.
 * The file is written as `{ "fixtures": [...] }` (pretty-printed, 2-space indent).
 * Parent directories are created automatically.
 */
export function writeFixtures(path: string, fixtures: FixtureSet | ScriptBuilder): void {
  const set = toFixtureSet(fixtures)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ fixtures: set }, null, 2), "utf-8")
}

/**
 * Load a FixtureSet from a JSON file.
 * Accepts `{ "fixtures": [...] }` (wrapped) or a bare array.
 * Throws a clear error if the file is missing or the JSON is not a fixture set.
 */
export function loadFixtures(path: string): FixtureSet {
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch {
    throw new Error(`fixture file not found: ${path}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`fixture file contains invalid JSON: ${path}`)
  }

  if (Array.isArray(parsed)) {
    return parsed as FixtureSet
  }

  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "fixtures" in parsed &&
    Array.isArray((parsed as { fixtures: unknown }).fixtures)
  ) {
    return (parsed as { fixtures: FixtureSet }).fixtures
  }

  throw new Error(`fixture file does not contain a fixture set (expected array or { fixtures: [...] }): ${path}`)
}
