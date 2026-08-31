import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

interface WebManifest {
  readonly dependencies?: Readonly<Record<string, string>>
}

const manifestPath = fileURLToPath(
  new URL("../templates/app-research/web/package.json.template", import.meta.url),
)

describe("research web template dependency alignment", () => {
  it("generates a CopilotKit v2 app on the reviewed AG-UI dependency family", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WebManifest

    expect(manifest.dependencies).toMatchObject({
      "@ag-ui/client": "0.0.59",
      "@copilotkit/react-core": "^1.70.0",
      "@copilotkit/runtime": "^1.70.0",
    })
  })
})
