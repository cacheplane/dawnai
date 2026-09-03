import { agent } from "@dawn-ai/sdk"
import { describe, expect, it } from "vitest"

import {
  buildStaticRouteModule,
  staticModulesMarkerFiles,
} from "../src/lib/runtime/static-modules-core.js"

const agentModule = { default: agent({ model: "gpt-5-mini", systemPrompt: "hi" }) }

function route(routeId: string, markerFiles?: Readonly<Record<string, string>>) {
  return buildStaticRouteModule({
    kind: "agent",
    ...(markerFiles ? { markerFiles } : {}),
    routeFile: `/ns/src/app${routeId}/index.ts`,
    routeId,
    routeModule: agentModule,
    routePath: `src/app${routeId}/index.ts`,
    tools: [],
  })
}

describe("static modules — marker files", () => {
  it("keeps a route's markerFiles on the built module and omits the key when absent", () => {
    const withFiles = route("/chat", { "/ns/src/app/chat/plan.md": "- [ ] a\n" })
    expect(withFiles.markerFiles).toEqual({ "/ns/src/app/chat/plan.md": "- [ ] a\n" })
    expect("markerFiles" in route("/zeta")).toBe(false)
    expect("markerFiles" in route("/zeta", {})).toBe(false)
  })

  it("unions every route's files and returns undefined when no route has any", () => {
    const modules = {
      routes: [
        route("/chat", { "/ns/src/app/chat/plan.md": "p" }),
        route("/zeta"),
        route("/research", { "/ns/src/app/research/skills/x/SKILL.md": "s" }),
      ],
    }
    expect(staticModulesMarkerFiles(modules)).toEqual({
      "/ns/src/app/chat/plan.md": "p",
      "/ns/src/app/research/skills/x/SKILL.md": "s",
    })
    expect(staticModulesMarkerFiles({ routes: [route("/zeta")] })).toBeUndefined()
    expect(staticModulesMarkerFiles({ routes: [] })).toBeUndefined()
  })
})
