import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { THREAD_ACCESS_METADATA_KEY } from "@dawn-ai/sdk"
import { describe, expect, it } from "vitest"

import { assertNoReservedKey, stripReservedThreadMetadata } from "../src/lib/dev/thread-metadata.js"

describe("stripReservedThreadMetadata", () => {
  it("passes undefined through", () => {
    expect(stripReservedThreadMetadata(undefined)).toBeUndefined()
  })

  it("returns the same object when the reserved key is absent", () => {
    const metadata = { keep: 1 }
    expect(stripReservedThreadMetadata(metadata)).toBe(metadata)
  })

  it("removes the reserved key and keeps every sibling", () => {
    const stripped = stripReservedThreadMetadata({
      [THREAD_ACCESS_METADATA_KEY]: { ownerId: "attacker" },
      keep: 1,
      route: "/chat#agent",
    })
    expect(stripped).toEqual({ keep: 1, route: "/chat#agent" })
  })

  it("returns an empty object when the reserved key was the only entry", () => {
    expect(stripReservedThreadMetadata({ [THREAD_ACCESS_METADATA_KEY]: { ownerId: "x" } })).toEqual(
      {},
    )
  })

  it("does not let a __proto__ entry re-attach the reserved key to the result", () => {
    // A JSON request body is the only way metadata reaches this function, and
    // `JSON.parse` makes `__proto__` an OWN data property instead of setting
    // the prototype. Copying that entry with a plain assignment hands it to the
    // `__proto__` setter, which puts the reserved key back within reach of
    // `stripped[THREAD_ACCESS_METADATA_KEY]` while `Object.hasOwn` says it is
    // gone — the forged stamp survives on the prototype chain.
    const metadata = JSON.parse(
      '{"dawn:access":{"ownerId":"decoy"},"__proto__":{"dawn:access":{"ownerId":"attacker"}},"keep":1}',
    ) as Record<string, unknown>
    const stripped = stripReservedThreadMetadata(metadata)
    expect(stripped?.[THREAD_ACCESS_METADATA_KEY]).toBeUndefined()
    expect(Object.getPrototypeOf(stripped)).toBe(Object.prototype)
    expect(Object.hasOwn(stripped as object, "__proto__")).toBe(true)
    expect(Object.keys(stripped as object)).toEqual(["__proto__", "keep"])
  })

  it("leaves a __proto__ entry unreachable when there was no reserved key to strip", () => {
    const metadata = JSON.parse('{"__proto__":{"dawn:access":{"ownerId":"attacker"}},"keep":1}') as
      | Record<string, unknown>
      | undefined
    const stripped = stripReservedThreadMetadata(metadata)
    expect(stripped?.[THREAD_ACCESS_METADATA_KEY]).toBeUndefined()
    expect(Object.getPrototypeOf(stripped)).toBe(Object.prototype)
  })
})

describe("assertNoReservedKey", () => {
  it("accepts a patch that does not carry the reserved key", () => {
    expect(() => assertNoReservedKey({ route: "/chat#agent" })).not.toThrow()
  })

  it("throws on a patch that would clobber the stamp through the shallow merge", () => {
    expect(() => assertNoReservedKey({ [THREAD_ACCESS_METADATA_KEY]: { ownerId: "x" } })).toThrow(
      /dawn:access/,
    )
  })
})

/**
 * The guard only protects the stamp at call sites that call it, and nothing in
 * `ThreadsStore` forces that — `updateMetadata` is the store contract, shared
 * with the operator backfill that legitimately writes the reserved key. So the
 * enumeration is what a test enumerates: a new runtime write path added without
 * the guard reds this, instead of being caught by review or not at all.
 */
describe("every runtime thread-metadata write goes through the guard", () => {
  const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), "..")

  async function sourceFiles(): Promise<readonly string[]> {
    const entries = await readdir(join(packageRoot, "src"), {
      recursive: true,
      withFileTypes: true,
    })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(entry.parentPath, entry.name))
  }

  it("passes a guarded identifier to every updateMetadata call under src/", async () => {
    const unguarded: string[] = []
    let sites = 0
    for (const file of await sourceFiles()) {
      const source = await readFile(file, "utf8")
      source.split("\n").forEach((line, index) => {
        if (!line.includes(".updateMetadata(")) return
        sites += 1
        // Only an identifier can have been asserted before the call, so an
        // inline object literal is reported too rather than silently skipped.
        const patch = /\.updateMetadata\([^,]+,\s*([A-Za-z_$][\w$]*)\s*\)/.exec(line)?.[1]
        if (!patch || !source.includes(`assertNoReservedKey(${patch})`)) {
          unguarded.push(`${relative(packageRoot, file)}:${index + 1}: ${line.trim()}`)
        }
      })
    }
    expect(unguarded).toEqual([])
    // Two run-stream writers in runtime-fetch-core.ts, one in agui-handler.ts,
    // and the park/clear pair in parked-route.ts. Bump this when a guarded
    // write path is added, so the scan can never pass by finding nothing.
    //
    // The parked-route pair arrived with PR #443 and reached this branch at the
    // merge, unguarded — which is the scan earning its keep: it named both
    // sites rather than leaving them to review.
    expect(sites).toBe(5)
  })
})
