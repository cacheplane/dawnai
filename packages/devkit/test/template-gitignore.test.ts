import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const templates = ["app-basic", "app-research"] as const

describe("scaffold gitignore", () => {
  for (const name of templates) {
    it(`${name} ignores Vercel output without ignoring deployment config`, () => {
      const path = fileURLToPath(
        new URL(`../templates/${name}/gitignore.template`, import.meta.url),
      )
      const lines = readFileSync(path, "utf8")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"))

      expect(lines.filter((line) => line === ".vercel/")).toHaveLength(1)
      expect(lines).not.toContain("vercel.json")
    })
  }
})
