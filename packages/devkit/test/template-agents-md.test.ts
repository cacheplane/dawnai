import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const templates = ["app-basic", "app-research"] as const

/**
 * Where each template's app tree starts. `app-research` is an npm workspace,
 * so its agent app — and everything scanned here — lives under `server/`.
 */
const appRoot = (name: string): string => (name === "app-research" ? `${name}/server` : name)

describe("scaffold AGENTS.md", () => {
  for (const name of templates) {
    it(`${name} ships a root AGENTS.md pointing at the bundled docs`, () => {
      const path = fileURLToPath(
        new URL(`../templates/${appRoot(name)}/AGENTS.md`, import.meta.url),
      )
      const text = readFileSync(path, "utf8")
      expect(text).toContain("dawn docs")
      expect(text).toContain("node_modules/@dawn-ai/cli/docs")
    })
  }
})
