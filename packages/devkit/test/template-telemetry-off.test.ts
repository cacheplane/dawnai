import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * CopilotKit's runtime is on by default and a bare `next build` of a generated
 * app POSTs to https://telemetry.copilotkit.ai/ingest while collecting page
 * data. A scaffold should not phone home before its author has written a line
 * of code, so the template turns it off.
 *
 * The assertion is on `next.config.mjs` specifically, and that placement is the
 * whole substance of the fix rather than a detail. CopilotKit constructs its
 * telemetry client at module scope and reads `process.env` inside that
 * constructor, so anything that runs after `@copilotkit/runtime` is imported —
 * including the route handler that imports it — is too late to matter. Setting
 * it there would look right, pass review, and send the request anyway.
 * `next.config.mjs` is the first module Next evaluates for `next build`,
 * `next dev` and `next start` alike.
 *
 * `??=` rather than `=` so a user who genuinely wants telemetry can opt back in
 * through the environment.
 */
const templateConfig = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(`../templates/${relativePath}`, import.meta.url)), "utf8")

describe("scaffolded web app leaves CopilotKit telemetry off", () => {
  it("disables it in next.config.mjs, before anything imports the runtime", () => {
    const config = templateConfig("app-research/web/next.config.mjs")

    expect(config).toContain('process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true"')
  })

  it("sets it before the config object, not after", () => {
    const config = templateConfig("app-research/web/next.config.mjs")

    expect(config.indexOf("COPILOTKIT_TELEMETRY_DISABLED")).toBeLessThan(
      config.indexOf("const nextConfig"),
    )
  })
})
