import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import config from "../next.config"

describe("brand reference canonical URL", () => {
  it("redirects the directory alias to the portable index without capturing assets", async () => {
    const redirects = (await config.redirects?.()) ?? []
    const redirect = redirects.find((rule) => rule.source === "/brand/identity")
    expect(redirect?.destination).toBe("/brand/identity/index.html")
    expect(redirect?.permanent).toBe(true)
    expect(redirects.some((rule) => rule.source === "/brand/identity/index.html")).toBe(false)

    const html = readFileSync(
      fileURLToPath(new URL("../public/brand/identity/index.html", import.meta.url)),
      "utf8",
    )
    const base = new URL(redirect?.destination ?? "/brand/identity", "https://example.test")
    const references = [...html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)]
      .map((match) => new URL(match[1] ?? "", base))
      .filter((url) => url.origin === base.origin)
    expect(references.length).toBeGreaterThan(20)
    for (const url of references) {
      expect(
        existsSync(fileURLToPath(new URL(`../public${url.pathname}`, import.meta.url))),
        url.pathname,
      ).toBe(true)
    }
  })
})
