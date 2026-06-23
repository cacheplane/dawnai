import { expect, test } from "vitest"

import { collectToolScopeErrors } from "../src/lib/runtime/collect-tool-scope-errors.js"

const manifest = {
  appRoot: "/app",
  routes: [
    {
      kind: "agent",
      pathname: "/research",
      entryFile: "/app/src/app/research/index.ts",
      routeDir: "/app/src/app/research",
    },
  ],
} as never

test("flags an unknown tool name in a route's scope", async () => {
  const errors = await collectToolScopeErrors(manifest, {
    loadScope: async () => ({ allow: ["serch"] }),
    routeLocalToolNames: async () => ["search"],
  })
  expect(errors.join("\n")).toMatch(/\/research.*unknown tool.*serch/s)
})

test("accepts a built-in capability tool name", async () => {
  const errors = await collectToolScopeErrors(manifest, {
    loadScope: async () => ({ allow: ["readFile"] }),
    routeLocalToolNames: async () => ["search"],
  })
  expect(errors).toEqual([])
})

test("ignores routes with no scope", async () => {
  const errors = await collectToolScopeErrors(manifest, {
    loadScope: async () => undefined,
    routeLocalToolNames: async () => ["search"],
  })
  expect(errors).toEqual([])
})
