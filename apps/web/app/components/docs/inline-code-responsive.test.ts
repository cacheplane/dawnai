import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../globals.css"), "utf8")

describe("responsive inline code", () => {
  it("wraps inline code below 48rem while preserving block-code behavior", () => {
    const mediaRule = /@media\s*\(max-width:\s*47\.999rem\)\s*{([\s\S]*?)\n}/.exec(CSS)?.[1]

    expect(mediaRule).toMatch(
      /\.mdx-inline-code\s*{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
    )
    expect(mediaRule).toMatch(
      /pre \.mdx-inline-code\s*{[^}]*white-space:\s*inherit;[^}]*overflow-wrap:\s*normal;/s,
    )
  })
})
