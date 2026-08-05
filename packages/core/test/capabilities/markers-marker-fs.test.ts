import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createAgentsMdMarker } from "../../src/capabilities/built-in/agents-md.js"
import { createMemoryMdMarker } from "../../src/capabilities/built-in/memory-md.js"
import type { CapabilityMarkerContext, MarkerFs } from "../../src/capabilities/types.js"
import { nodeMarkerFs } from "../../src/node-marker-fs.js"

// Copied verbatim from agents-md.ts so the parity test pins the exact output
// shape across the node:fs -> MarkerFs migration.
const AGENTS_MD_HEADER = `# Memory

The block below is the live contents of \`workspace/AGENTS.md\`, re-read on every turn. This IS your persistent memory — do NOT re-read this file with any tool; the content here is always current. Update it by calling \`writeFile({ path: "AGENTS.md", content: "..." })\` when you learn something worth remembering.

---`

function stubMarkerFs(overrides: Partial<MarkerFs>): MarkerFs {
  return {
    existsSync: () => true,
    isDirectorySync: () => false,
    statSizeSync: () => 1,
    readFileSync: () => "stub",
    readdirSync: () => [],
    ...overrides,
  }
}

function makeCtx(appRoot: string, markerFs?: MarkerFs): CapabilityMarkerContext {
  return {
    routeManifest: { appRoot, routes: [] },
    descriptor: undefined,
    appRoot,
    ...(markerFs ? { markerFs } : {}),
  }
}

describe("markers read through MarkerFs", () => {
  let workDir: string
  let routeDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "dawn-marker-fs-"))
    routeDir = join(workDir, "route")
    mkdirSync(routeDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  function writeAgentsMd(content: string): void {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    writeFileSync(join(workDir, "workspace", "AGENTS.md"), content)
  }

  describe("agents-md", () => {
    it("renders workspace/AGENTS.md content through the facade", async () => {
      writeAgentsMd("user prefers tabs")
      const marker = createAgentsMdMarker()
      const ctx = makeCtx(workDir, nodeMarkerFs)
      expect(await marker.detect(routeDir, ctx)).toBe(true)
      const contribution = await marker.load(routeDir, ctx)
      expect(contribution.promptFragment?.render({})).toContain("user prefers tabs")
    })

    it("renders empty when markerFs is absent, even though the file exists (edge)", async () => {
      writeAgentsMd("user prefers tabs")
      const marker = createAgentsMdMarker()
      const ctx = makeCtx(workDir)
      expect(await marker.detect(routeDir, ctx)).toBe(true)
      const contribution = await marker.load(routeDir, ctx)
      expect(contribution.promptFragment?.render({})).toBe("")
    })

    it("renders the size-cap message when the file exceeds 64 KiB", async () => {
      writeAgentsMd("x".repeat(65 * 1024))
      const marker = createAgentsMdMarker()
      const contribution = await marker.load(routeDir, makeCtx(workDir, nodeMarkerFs))
      const out = contribution.promptFragment?.render({}) ?? ""
      expect(out).toContain("exceeds 64 KiB limit")
      expect(out).not.toContain("xxxxxxxxxxx")
    })

    it("renders empty when statSizeSync returns undefined (fail-closed stat)", async () => {
      const marker = createAgentsMdMarker()
      const fs = stubMarkerFs({ statSizeSync: () => undefined })
      const contribution = await marker.load(routeDir, makeCtx(workDir, fs))
      expect(contribution.promptFragment?.render({})).toBe("")
    })

    it("renders empty when readFileSync returns undefined (fail-closed read)", async () => {
      const marker = createAgentsMdMarker()
      const fs = stubMarkerFs({ readFileSync: () => undefined })
      const contribution = await marker.load(routeDir, makeCtx(workDir, fs))
      expect(contribution.promptFragment?.render({})).toBe("")
    })

    it("renders content (not the cap message) at exactly 64 KiB — cap is strict >", async () => {
      writeAgentsMd("y".repeat(64 * 1024))
      const marker = createAgentsMdMarker()
      const contribution = await marker.load(routeDir, makeCtx(workDir, nodeMarkerFs))
      const out = contribution.promptFragment?.render({}) ?? ""
      expect(out).not.toContain("exceeds 64 KiB limit")
      expect(out).toContain("yyyyyyyyyy")
    })

    it("behavior parity: facade render matches the exact node-fs output shape", async () => {
      writeAgentsMd("  user prefers tabs\nand pnpm  \n")
      const marker = createAgentsMdMarker()
      const contribution = await marker.load(routeDir, makeCtx(workDir, nodeMarkerFs))
      expect(contribution.promptFragment?.render({})).toBe(
        `${AGENTS_MD_HEADER}\n\nuser prefers tabs\nand pnpm`,
      )
    })
  })

  describe("memory-md", () => {
    it("detects and renders routeDir/memory.md through the facade", async () => {
      writeFileSync(join(routeDir, "memory.md"), "route lore")
      const marker = createMemoryMdMarker()
      const ctx = makeCtx(workDir, nodeMarkerFs)
      expect(await marker.detect(routeDir, ctx)).toBe(true)
      const contribution = await marker.load(routeDir, ctx)
      const out = contribution.promptFragment?.render({}) ?? ""
      expect(out).toContain("# Route Memory")
      expect(out).toContain("route lore")
    })

    it("detect is false when markerFs is absent, even though the file exists (edge)", async () => {
      writeFileSync(join(routeDir, "memory.md"), "route lore")
      const marker = createMemoryMdMarker()
      expect(await marker.detect(routeDir, makeCtx(workDir))).toBe(false)
    })

    it("renders the size-cap message when memory.md exceeds 32 KiB", async () => {
      writeFileSync(join(routeDir, "memory.md"), "z".repeat(33 * 1024))
      const marker = createMemoryMdMarker()
      const contribution = await marker.load(routeDir, makeCtx(workDir, nodeMarkerFs))
      const out = contribution.promptFragment?.render({}) ?? ""
      expect(out).toContain("exceeds 32 KiB limit")
      expect(out).not.toContain("zzzzzzzzzz")
    })
  })
})
