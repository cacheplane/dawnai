import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionsStore } from "@dawn-ai/permissions"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { gatePathOp, gateToolOp } from "../../src/capabilities/permission-gate.js"

describe("gatePathOp interrupt suppression", () => {
  let appRoot: string

  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-gate-test-"))
  })

  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  it("fails closed with guidance when interactive but interrupts unavailable", async () => {
    // Interactive mode with no config => match() returns "unknown" for outside paths.
    // Without interruptCapable:false the gate would call interrupt() and throw a LangGraph error.
    const permissions = createPermissionsStore({
      appRoot,
      config: undefined,
      mode: "interactive",
    })
    await permissions.load()

    const result = await gatePathOp(permissions, "readFile", "/outside/x", "/ws", {
      interruptCapable: false,
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/allow rule/)
      expect(result.reason).toMatch(/dawn\.config/)
    }
  })

  it("still allows inside-workspace paths without consulting the store", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: undefined,
      mode: "interactive",
    })
    await permissions.load()

    const result = await gatePathOp(permissions, "readFile", "/ws/notes.md", "/ws", {
      interruptCapable: false,
    })
    expect(result.allowed).toBe(true)
  })
})

describe("gateToolOp", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-gate-tool-test-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  async function store(
    mode: "interactive" | "non-interactive" | "bypass",
    config?: {
      allow?: Record<string, readonly string[]>
      deny?: Record<string, readonly string[]>
    },
  ) {
    const permissions = createPermissionsStore({
      appRoot,
      config: config
        ? { version: 1, allow: config.allow ?? {}, deny: config.deny ?? {} }
        : undefined,
      mode,
    })
    await permissions.load()
    return permissions
  }

  it("allows when no permissions store is present", async () => {
    expect((await gateToolOp(undefined, "deployProd", "{}")).allowed).toBe(true)
  })

  it("allows in bypass mode without consulting the store", async () => {
    const permissions = await store("bypass")
    expect((await gateToolOp(permissions, "deployProd", "{}")).allowed).toBe(true)
  })

  it("allows a config-pre-approved tool (allow.tool exact name)", async () => {
    const permissions = await store("interactive", { allow: { tool: ["deployProd"] } })
    expect((await gateToolOp(permissions, "deployProd", "{}")).allowed).toBe(true)
  })

  it("blocks a config-denied tool with a reason", async () => {
    const permissions = await store("interactive", { deny: { tool: ["deployProd"] } })
    const result = await gateToolOp(permissions, "deployProd", "{}")
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/denied.*deployProd/i)
  })

  it("fails closed on unknown in non-interactive mode", async () => {
    const permissions = await store("non-interactive")
    const result = await gateToolOp(permissions, "deployProd", "{}")
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/fail-closed/)
  })

  it("fails closed with guidance when interactive but interrupts unavailable", async () => {
    const permissions = await store("interactive")
    const result = await gateToolOp(permissions, "deployProd", "{}", { interruptCapable: false })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/allow rule/)
      expect(result.reason).toMatch(/dawn\.config/)
    }
  })
})
