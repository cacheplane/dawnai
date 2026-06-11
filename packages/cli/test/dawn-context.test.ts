import type { WorkspaceFs } from "@dawn-ai/sdk"
import { describe, expect, it } from "vitest"

import { createDawnContext } from "../src/lib/runtime/dawn-context.js"

const fakeFs: WorkspaceFs = {
  readFile: async () => "content",
  readBinaryFile: async () => Uint8Array.from([1]),
  writeFile: async () => ({ bytesWritten: 1 }),
  listDir: async () => [],
}

describe("createDawnContext fs threading", () => {
  it("exposes fs on the route context", () => {
    const context = createDawnContext({ tools: [], fs: fakeFs })
    expect(context.fs).toBe(fakeFs)
  })

  it("passes fs to tool run contexts", async () => {
    let seenFs: WorkspaceFs | undefined
    const context = createDawnContext({
      fs: fakeFs,
      tools: [
        {
          filePath: "/x/tools/probe.ts",
          name: "probe",
          scope: "route-local",
          run: (_input, ctx) => {
            seenFs = ctx.fs
            return "ok"
          },
        },
      ],
    })
    await context.tools.probe?.({})
    expect(seenFs).toBe(fakeFs)
  })
})
