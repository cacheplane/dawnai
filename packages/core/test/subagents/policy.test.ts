import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionsStore } from "@dawn-ai/permissions"
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resolveGuardedSubagent } from "../../src/subagents/policy.ts"
import type { ResolvedSubagent } from "../../src/subagents/types.ts"

const signal = new AbortController().signal
const baseEntry: ResolvedSubagent = {
  description: "Writes drafts.",
  name: "writer",
  routeId: "/parent/subagents/writer",
  source: "convention",
  rule: { action: "allow" },
}

function entry(rule: ResolvedSubagent["rule"]): ResolvedSubagent {
  return { ...baseEntry, rule }
}

function call<T>(
  overrides: {
    registry?: readonly ResolvedSubagent[]
    permissions?: Awaited<ReturnType<typeof createPermissionsStore>>
    resolve?: (candidate: ResolvedSubagent) => Promise<T>
    runtime?: {
      parentRouteId: string
      params?: Readonly<Record<string, string>>
      signal: AbortSignal
      threadId?: string
    }
  } = {},
) {
  return resolveGuardedSubagent({
    callId: "task-1",
    input: "write a draft",
    name: "writer",
    registry: overrides.registry ?? [baseEntry],
    runtime: overrides.runtime ?? {
      parentRouteId: "/parent",
      params: { tenant: "acme" },
      signal,
      threadId: "thread-1",
    },
    ...(overrides.permissions !== undefined ? { permissions: overrides.permissions } : {}),
    interruptCapable: true,
    resolve: overrides.resolve ?? (async (candidate) => ({ child: candidate.routeId }) as T),
  })
}

describe("resolveGuardedSubagent", () => {
  let appRoot: string

  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-subagent-policy-test-"))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.DAWN_DEBUG_CONSTRAINTS
    rmSync(appRoot, { recursive: true, force: true })
  })

  async function permissions(
    mode: "interactive" | "non-interactive" | "bypass",
    config?: {
      allow?: Record<string, readonly string[]>
      deny?: Record<string, readonly string[]>
    },
  ) {
    const value = createPermissionsStore({
      appRoot,
      config: config
        ? { version: 1, allow: config.allow ?? {}, deny: config.deny ?? {} }
        : undefined,
      mode,
    })
    await value.load()
    return value
  }

  it("resolves an allowed child and returns its canonical entry", async () => {
    const resolve = vi.fn(async () => ({ child: true }))
    await expect(call({ resolve })).resolves.toEqual({
      ok: true,
      entry: baseEntry,
      value: { child: true },
    })
    expect(resolve).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledWith(baseEntry)
  })

  it("returns an exact coded static denial without resolving the child", async () => {
    const resolve = vi.fn(async () => "child")
    await expect(
      call({ registry: [entry({ action: "deny", reason: "Drafts are disabled." })], resolve }),
    ).resolves.toEqual({
      ok: false,
      code: "DAWN_E3002",
      message: "[DAWN_E3002] Drafts are disabled.",
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("uses a stable default reason for a static denial", async () => {
    await expect(call({ registry: [entry({ action: "deny" })] })).resolves.toEqual({
      ok: false,
      code: "DAWN_E3002",
      message: "[DAWN_E3002] Delegation to subagent 'writer' is denied.",
    })
  })

  it("returns exact E5003 for an unknown name without resolving", async () => {
    const resolve = vi.fn(async () => "child")
    await expect(call({ registry: [], resolve })).resolves.toEqual({
      ok: false,
      code: "DAWN_E5003",
      message: "[DAWN_E5003] No subagent named 'writer' is available.",
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("honors pre-allow, explicit deny, and non-interactive approval decisions", async () => {
    const pattern = JSON.stringify(["/parent", "writer"])
    const cases = [
      {
        store: await permissions("interactive", { allow: { subagent: [pattern] } }),
        expected: { ok: true },
      },
      {
        store: await permissions("interactive", { deny: { subagent: [pattern] } }),
        expected: { ok: false, code: "DAWN_E3002" },
      },
      {
        store: await permissions("non-interactive"),
        expected: { ok: false, code: "DAWN_E3002" },
      },
    ] as const

    for (const testCase of cases) {
      const resolve = vi.fn(async () => "child")
      const result = await call({
        registry: [entry({ action: "approve", reason: "Review drafts." })],
        permissions: testCase.store,
        resolve,
      })
      expect(result).toMatchObject(testCase.expected)
      expect(resolve).toHaveBeenCalledTimes(testCase.expected.ok ? 1 : 0)
    }
  })

  it.each([
    { interruptCapable: false, threadId: "thread-1" },
    { interruptCapable: true, threadId: undefined },
  ])("fails closed approval without resumable interrupt context", async ({
    interruptCapable,
    threadId,
  }) => {
    const store = await permissions("interactive")
    const resolve = vi.fn(async () => "child")
    const result = await resolveGuardedSubagent({
      callId: "task-1",
      input: "write a draft",
      name: "writer",
      registry: [entry({ action: "approve" })],
      runtime: {
        parentRouteId: "/parent",
        signal,
        ...(threadId !== undefined ? { threadId } : {}),
      },
      permissions: store,
      interruptCapable,
      resolve,
    })
    expect(result).toMatchObject({ ok: false, code: "DAWN_E3002" })
    if (!result.ok) expect(result.message).toMatch(/thread ID.*interrupt support.*allow rule/i)
    expect(resolve).not.toHaveBeenCalled()
  })

  it("lets bypass skip approval but not static or constraint denials", async () => {
    const store = await permissions("bypass")
    await expect(
      call({ registry: [entry({ action: "approve" })], permissions: store }),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      call({ registry: [entry({ action: "deny", reason: "No drafts." })], permissions: store }),
    ).resolves.toMatchObject({ ok: false, code: "DAWN_E3002" })
    await expect(
      call({
        registry: [entry({ action: "constrain", predicate: () => "No draft input." })],
        permissions: store,
      }),
    ).resolves.toEqual({
      ok: false,
      code: "DAWN_E3002",
      message: "[DAWN_E3002] No draft input.",
    })
  })

  it("supports true, string, and approval constraint verdicts", async () => {
    const pattern = JSON.stringify(["/parent", "writer"])
    const store = await permissions("interactive", { allow: { subagent: [pattern] } })
    await expect(
      call({ registry: [entry({ action: "constrain", predicate: () => true })] }),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      call({ registry: [entry({ action: "constrain", predicate: () => "Tenant blocked." })] }),
    ).resolves.toEqual({
      ok: false,
      code: "DAWN_E3002",
      message: "[DAWN_E3002] Tenant blocked.",
    })
    await expect(
      call({
        registry: [
          entry({
            action: "constrain",
            predicate: () => ({ approve: true, reason: "Review tenant draft." }),
          }),
        ],
        permissions: store,
      }),
    ).resolves.toMatchObject({ ok: true })
  })

  it("preserves a constraint approval reason in the interrupt", async () => {
    const store = await permissions("interactive")
    const State = Annotation.Root({ result: Annotation<unknown>() })
    const graph = new StateGraph(State)
      .addNode("policy", async () => ({
        result: await call({
          registry: [
            entry({
              action: "constrain",
              predicate: () => ({ approve: true, reason: "Review tenant draft." }),
            }),
          ],
          permissions: store,
        }),
      }))
      .addEdge(START, "policy")
      .addEdge("policy", END)
      .compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: "thread-1" } }

    await graph.invoke({}, config)
    const payload = (await graph.getState(config)).tasks[0]?.interrupts[0]?.value as {
      detail?: { reason?: unknown }
    }
    expect(payload.detail?.reason).toBe("Review tenant draft.")
  })

  it.each([
    false,
    null,
    undefined,
    1,
    { approve: false },
    { approve: true, reason: 1 },
    Object.create({ approve: true }),
    new (class Verdict {
      approve = true
    })(),
  ])("fails closed generically for malformed constraint verdict %#", async (verdict) => {
    const resolve = vi.fn(async () => "child")
    const result = await call({
      registry: [entry({ action: "constrain", predicate: (() => verdict) as never })],
      resolve,
    })
    expect(result).toEqual({
      ok: false,
      code: "DAWN_E3002",
      message:
        "[DAWN_E3002] Subagent delegation constraint check failed. The subagent was not started.",
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each([
    "approve",
    "reason",
  ] as const)("fails closed when the %s approval accessor throws", async (property) => {
    const secret = new Error(`secret ${property} accessor detail`)
    const verdict =
      property === "approve"
        ? Object.defineProperty({}, "approve", {
            get: () => {
              throw secret
            },
          })
        : Object.defineProperty({ approve: true }, "reason", {
            get: () => {
              throw secret
            },
          })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const resolve = vi.fn(async () => "child")

    const result = await call({
      registry: [entry({ action: "constrain", predicate: (() => verdict) as never })],
      resolve,
    })

    expect(result).toEqual({
      ok: false,
      code: "DAWN_E3002",
      message:
        "[DAWN_E3002] Subagent delegation constraint check failed. The subagent was not started.",
    })
    expect(result.message).not.toContain(secret.message)
    expect(warn).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it("debug-logs an approval accessor failure without exposing it in the result", async () => {
    const secret = new Error("secret proxy accessor detail")
    const verdict = new Proxy(
      { approve: true, reason: "review" },
      {
        get: (target, property, receiver) => {
          if (property === "reason") throw secret
          return Reflect.get(target, property, receiver)
        },
      },
    )
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    process.env.DAWN_DEBUG_CONSTRAINTS = "1"

    const result = await call({
      registry: [entry({ action: "constrain", predicate: (() => verdict) as never })],
    })

    expect(result).toMatchObject({ ok: false, code: "DAWN_E3002" })
    if (!result.ok) expect(result.message).not.toContain(secret.message)
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/parent.*\/parent.*subagent.*writer/i),
      secret,
    )
  })

  it("fails closed without leaking a thrown predicate error", async () => {
    const result = await call({
      registry: [
        entry({
          action: "constrain",
          predicate: () => {
            throw new Error("secret tenant detail")
          },
        }),
      ],
    })
    expect(result).toMatchObject({ ok: false, code: "DAWN_E3002" })
    if (!result.ok) expect(result.message).not.toContain("secret tenant detail")
  })

  it("logs thrown and invalid verdict details only under DAWN_DEBUG_CONSTRAINTS=1", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const thrown = new Error("predicate exploded")
    await call({
      registry: [
        entry({
          action: "constrain",
          predicate: () => {
            throw thrown
          },
        }),
      ],
    })
    expect(warn).not.toHaveBeenCalled()

    process.env.DAWN_DEBUG_CONSTRAINTS = "1"
    await call({
      registry: [
        entry({
          action: "constrain",
          predicate: () => {
            throw thrown
          },
        }),
      ],
    })
    await call({
      registry: [entry({ action: "constrain", predicate: (() => ({ nope: true })) as never })],
    })
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]?.[0]).toMatch(/parent.*\/parent.*subagent.*writer/i)
    expect(warn.mock.calls[0]?.[1]).toBe(thrown)
    expect(warn.mock.calls[1]?.[1]).toEqual({ nope: true })
  })

  it("passes exact request and live delegation context to the predicate", async () => {
    const predicate = vi.fn(() => true as const)
    const controller = new AbortController()
    await call({
      registry: [entry({ action: "constrain", predicate })],
      runtime: {
        parentRouteId: "/parent",
        params: { tenant: "acme" },
        signal: controller.signal,
        threadId: "thread-live",
      },
    })
    expect(predicate).toHaveBeenCalledWith(
      { input: "write a draft" },
      {
        parentRouteId: "/parent",
        subagentName: "writer",
        subagentRouteId: "/parent/subagents/writer",
        params: { tenant: "acme" },
        signal: controller.signal,
        threadId: "thread-live",
      },
    )
  })

  it("fails closed when aborted before policy work", async () => {
    const controller = new AbortController()
    controller.abort(new Error("private abort reason"))
    const predicate = vi.fn(() => true as const)
    const resolve = vi.fn(async () => "child")
    const result = await call({
      registry: [entry({ action: "constrain", predicate })],
      runtime: { parentRouteId: "/parent", signal: controller.signal },
      resolve,
    })
    expect(result).toMatchObject({ ok: false, code: "DAWN_E3002" })
    if (!result.ok) expect(result.message).not.toContain("private abort reason")
    expect(predicate).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it("fails closed when aborted after awaited predicate work", async () => {
    const controller = new AbortController()
    const resolve = vi.fn(async () => "child")
    const result = await call({
      registry: [
        entry({
          action: "constrain",
          predicate: async () => {
            controller.abort()
            return true
          },
        }),
      ],
      runtime: { parentRouteId: "/parent", signal: controller.signal },
      resolve,
    })
    expect(result).toMatchObject({ ok: false, code: "DAWN_E3002" })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("fails closed when aborted during approval gate work", async () => {
    const controller = new AbortController()
    const store = {
      mode: "interactive" as const,
      load: async () => undefined,
      match: () => {
        controller.abort()
        return "allow" as const
      },
      addAllow: async () => undefined,
    }
    const resolve = vi.fn(async () => "child")
    const result = await call({
      registry: [entry({ action: "approve" })],
      permissions: store,
      runtime: { parentRouteId: "/parent", signal: controller.signal },
      resolve,
    })
    expect(result).toMatchObject({ ok: false, code: "DAWN_E3002" })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("calls resolve only after the policy gate and maps setup throws to model-safe E5003", async () => {
    const order: string[] = []
    const result = await call({
      registry: [
        entry({
          action: "constrain",
          predicate: async () => {
            order.push("policy")
            return true
          },
        }),
      ],
      resolve: async () => {
        order.push("resolve")
        throw new Error("private import path")
      },
    })
    expect(order).toEqual(["policy", "resolve"])
    expect(result).toEqual({
      ok: false,
      code: "DAWN_E5003",
      message: "[DAWN_E5003] Subagent 'writer' could not be started.",
    })
  })
})
