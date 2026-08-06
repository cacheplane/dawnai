import type { RunnableConfig } from "@langchain/core/runnables"
import { describe, expect, it, vi } from "vitest"

import { buildGuardedSubagentResolver } from "../src/lib/runtime/execute-route.js"

const signal = new AbortController().signal

function entry(rule: { readonly action: "allow" | "deny" }, name = "researcher") {
  return {
    description: "Researches.",
    name,
    routeId: "/parent/subagents/researcher",
    rule,
    source: "convention" as const,
  }
}

describe("guarded CLI subagent resolution", () => {
  it("dispatches convention-only children under the default allow rule", async () => {
    const prepareChild = vi.fn(async () => ({
      routeId: "/parent/subagents/researcher",
      graph: { invoke: vi.fn() },
    }))
    const resolver = buildGuardedSubagentResolver({
      interruptCapable: true,
      parentRouteId: "/parent",
      prepareChild,
      registry: [entry({ action: "allow" })],
    })

    await expect(
      resolver({ callId: "call-1", config: { signal }, input: "Inspect", name: "researcher" }),
    ).resolves.toMatchObject({
      ok: true,
      child: { routeId: "/parent/subagents/researcher" },
    })
    expect(prepareChild).toHaveBeenCalledTimes(1)
  })

  it("uses explicit aliases without retaining the replaced convention leaf", async () => {
    const prepareChild = vi.fn(async () => ({
      routeId: "/parent/subagents/researcher",
      graph: { invoke: vi.fn() },
    }))
    const resolver = buildGuardedSubagentResolver({
      interruptCapable: true,
      parentRouteId: "/parent",
      prepareChild,
      registry: [{ ...entry({ action: "allow" }, "analyst"), source: "explicit" }],
    })
    const config = { signal } as RunnableConfig

    await expect(
      resolver({ callId: "call-1", config, input: "Inspect", name: "analyst" }),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      resolver({ callId: "call-2", config, input: "Inspect", name: "researcher" }),
    ).resolves.toEqual({
      ok: false,
      message: "[DAWN_E5003] No subagent named 'researcher' is available.",
    })
  })

  it("denies before resolving or materializing a child", async () => {
    const prepareChild = vi.fn()
    const resolver = buildGuardedSubagentResolver({
      interruptCapable: true,
      parentRouteId: "/parent",
      prepareChild,
      registry: [entry({ action: "deny" })],
    })

    await expect(
      resolver({ callId: "call-denied", config: { signal }, input: "Inspect", name: "researcher" }),
    ).resolves.toEqual({
      ok: false,
      message: "[DAWN_E3002] Delegation to subagent 'researcher' is denied.",
    })
    expect(prepareChild).not.toHaveBeenCalled()
  })
})
