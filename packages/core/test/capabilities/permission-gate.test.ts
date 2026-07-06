import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionsStore } from "@dawn-ai/permissions"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  gateMemorySupersede,
  gatePathOp,
  gateToolOp,
  wrapToolWithApproval,
} from "../../src/capabilities/permission-gate.js"

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

describe("wrapToolWithApproval", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-wrap-tool-test-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  const signal = new AbortController().signal

  it("delegates untouched when the tool is pre-approved", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: { tool: ["deployProd"] }, deny: {} },
      mode: "interactive",
    })
    await permissions.load()
    const tool = {
      name: "deployProd",
      description: "deploys",
      filePath: "/app/src/app/ops/tools/deployProd.ts",
      run: async (input: unknown) => `deployed:${JSON.stringify(input)}`,
    }
    const wrapped = wrapToolWithApproval(tool, permissions)
    expect(wrapped.name).toBe("deployProd")
    expect(wrapped.description).toBe("deploys")
    expect(wrapped.filePath).toBe(tool.filePath)
    expect(await wrapped.run({ env: "prod" }, { signal })).toBe('deployed:{"env":"prod"}')
  })

  it("blocks with the denial reason as the tool result when denied", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: {}, deny: { tool: ["deployProd"] } },
      mode: "interactive",
    })
    await permissions.load()
    let ran = false
    const wrapped = wrapToolWithApproval(
      {
        name: "deployProd",
        run: async () => {
          ran = true
          return "deployed"
        },
      },
      permissions,
    )
    const result = await wrapped.run({}, { signal })
    expect(ran).toBe(false)
    expect(String(result)).toMatch(/denied.*deployProd/i)
  })

  it("fails closed (as a result string) in non-interactive mode", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: undefined,
      mode: "non-interactive",
    })
    await permissions.load()
    const wrapped = wrapToolWithApproval({ name: "x", run: async () => "ran" }, permissions)
    expect(String(await wrapped.run({}, { signal }))).toMatch(/fail-closed/)
  })
})

describe("gateMemorySupersede", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-gate-memory-test-"))
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

  const detail = {
    namespace: "workspace=app|route=/support",
    identity: "acme / payment-terms",
    oldId: "memory_abc123",
    oldContent: "acme prefers net-30",
    newContent: "acme prefers net-45",
  }

  it("allows when no permissions store is present (legacy context ≡ auto)", async () => {
    expect((await gateMemorySupersede(undefined, detail)).allowed).toBe(true)
  })

  it("allows in bypass mode", async () => {
    const permissions = await store("bypass")
    expect((await gateMemorySupersede(permissions, detail)).allowed).toBe(true)
  })

  it("allows a config-pre-approved route prefix (terminated)", async () => {
    const permissions = await store("interactive", {
      allow: { memory: ["workspace=app|route=/support|"] },
    })
    expect((await gateMemorySupersede(permissions, detail)).allowed).toBe(true)
  })

  it("does not let a sibling-route rule leak (route=/s vs route=/support)", async () => {
    // /s is a string prefix of /support; the terminator must prevent the match.
    // "unknown" in non-interactive mode → allow-through, so use the deny list
    // to make leakage observable.
    const permissions = await store("non-interactive", {
      deny: { memory: ["workspace=app|route=/s|"] },
    })
    expect((await gateMemorySupersede(permissions, detail)).allowed).toBe(true)
  })

  it("blocks an explicitly denied route prefix with a reason (honored headless)", async () => {
    const permissions = await store("non-interactive", {
      deny: { memory: ["workspace=app|route=/support|"] },
    })
    const result = await gateMemorySupersede(permissions, detail)
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/denied/i)
  })

  it("allows through on unknown in non-interactive mode (ask ≡ auto headless)", async () => {
    const permissions = await store("non-interactive")
    expect((await gateMemorySupersede(permissions, detail)).allowed).toBe(true)
  })
})
