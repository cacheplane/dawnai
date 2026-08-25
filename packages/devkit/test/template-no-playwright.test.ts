import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

interface WebManifest {
  readonly scripts?: Readonly<Record<string, string>>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

const templateWeb = (path: string): string =>
  fileURLToPath(new URL(`../templates/app-research/web/${path}`, import.meta.url))

const webManifest = (): WebManifest =>
  JSON.parse(readFileSync(templateWeb("package.json.template"), "utf8")) as WebManifest

/**
 * The example's web package carries a Playwright end-to-end suite. The scaffold
 * template deliberately does NOT, and that decision is invisible to the parity
 * guard: `playwright.config.ts` and `e2e/` sit outside `WEB_PARITY_ROOTS`, so
 * mirroring them in later would not fail anything.
 *
 * It is excluded because it cannot work in a generated app as written. The
 * example's config runs `pnpm exec next dev`, while a scaffolded app is
 * npm-based; the spec asserts CopilotKit's internal transport choice, which
 * guards Dawn's own upgrades rather than anything the user wrote; and
 * `@playwright/test` fails on first use until the user separately runs
 * `playwright install`, which no scaffold step performs and no scaffold doc
 * mentions. A script without a config, or a config without tests, is worse than
 * neither — so the template ships none of it and `npm test` (vitest) stays the
 * generated app's working test story.
 *
 * If you are adding Playwright to the scaffold on purpose, add all four pieces
 * together (dependency, config that uses npm, specs, and an install step the
 * docs mention) and delete this file. Adding any one of them alone is the
 * failure mode this test exists to catch.
 */
describe("research web template excludes Playwright", () => {
  it("declares no test:e2e script", () => {
    expect(webManifest().scripts ?? {}).not.toHaveProperty("test:e2e")
  })

  it("declares no Playwright dependency", () => {
    const manifest = webManifest()
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    expect(declared.filter((name) => name.includes("playwright"))).toEqual([])
  })

  it("ships neither a Playwright config nor an e2e directory", () => {
    expect(existsSync(templateWeb("playwright.config.ts"))).toBe(false)
    expect(existsSync(templateWeb("e2e"))).toBe(false)
  })
})
