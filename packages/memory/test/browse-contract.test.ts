import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as browseSubpath from "../src/browse.js"

const SRC = new URL("../src/", import.meta.url)

const BROWSE_LEAF_MODULES = [
  "./browse-cursor.js",
  "./browse-filter.js",
  "./browse-order.js",
  "./browse-range.js",
  "./browse-validate.js",
]

function readSource(file: string): string {
  return readFileSync(new URL(file, SRC), "utf8")
}

function moduleSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/\bfrom\s*"([^"]+)"/g),
    ...source.matchAll(/\bimport\s*\(\s*"([^"]+)"/g),
    ...source.matchAll(/^import\s+"([^"]+)"/gm),
  ]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined)
}

function reachableFrom(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  const pending = [entry]
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (graph.has(file)) continue
    const specifiers = moduleSpecifiers(readSource(file))
    graph.set(file, specifiers)
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) pending.push(specifier.replace(/\.js$/, ".ts"))
    }
  }
  return graph
}

function reExportedNames(source: string): Map<string, string[]> {
  const byModule = new Map<string, string[]>()
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
    const specifier = match[2]
    if (!specifier) continue
    const parsed = (match[1] ?? "")
      .split(",")
      .map((name) => name.trim().replace(/^type\s+/, ""))
      .filter((name) => name.length > 0)
    byModule.set(specifier, [...(byModule.get(specifier) ?? []), ...parsed].sort())
  }
  return byModule
}

describe("the @dawn-ai/memory/browse contract", () => {
  it("reaches nothing outside the pure browse sources", () => {
    // The subpath exists only so that importing it never pulls node:sqlite. One edge from
    // this graph into sqlite-store.js puts it back, and no other gate in the repo notices.
    const graph = reachableFrom("./browse.ts")

    expect([...graph.keys()].sort()).toEqual([
      "./browse-cursor.ts",
      "./browse-filter.ts",
      "./browse-order.ts",
      "./browse-range.ts",
      "./browse-validate.ts",
      "./browse.ts",
      "./types.ts",
    ])
    expect([...graph.values()].flat().filter((specifier) => !specifier.startsWith("."))).toEqual([])
  })

  it("exports the same browse symbols as the barrel", () => {
    const subpath = reExportedNames(readSource("./browse.ts"))
    const barrel = reExportedNames(readSource("./index.ts"))
    const leaves = (map: Map<string, string[]>) =>
      Object.fromEntries(BROWSE_LEAF_MODULES.map((specifier) => [specifier, map.get(specifier)]))

    expect(leaves(barrel)).toEqual(leaves(subpath))
    // The barrel legitimately re-exports more of types.js than the browse contract needs,
    // so this direction only has to hold one way.
    expect(
      subpath.get("./types.js")?.filter((name) => !barrel.get("./types.js")?.includes(name)),
    ).toEqual([])

    const declared = new Set([...subpath.values()].flat())
    expect(Object.keys(browseSubpath).filter((name) => !declared.has(name))).toEqual([])
  })
})
