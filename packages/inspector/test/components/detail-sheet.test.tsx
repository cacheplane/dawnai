import type { MemoryRecord } from "@dawn-ai/memory"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DetailSheet } from "../../src/components/memory/detail-sheet"

function record(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id">): MemoryRecord {
  return {
    kind: "semantic",
    namespace: "route=/notes",
    content: "acme threshold is 750",
    data: { subject: "acme", predicate: "threshold", value: "750" },
    source: { type: "tool", id: "remember" },
    confidence: 0.9,
    tags: [],
    status: "candidate",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  }
}

const candidate = record({ id: "cand1" })
const contradictingActive = record({
  id: "active1",
  status: "active",
  content: "acme threshold is 500",
  data: { subject: "acme", predicate: "threshold", value: "500" },
})
const unrelatedActive = record({
  id: "active2",
  status: "active",
  content: "zed color is blue",
  data: { subject: "zed", predicate: "color", value: "blue" },
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Stub fetch for the detail sheet: GET :id, GET list (conflict probe), POST actions. */
function stubApi(opts: {
  rec: MemoryRecord
  actives?: MemoryRecord[]
  onAction?: (verb: string) => Response
}) {
  const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === "POST") {
      const verb = u.split("/").at(-1) ?? ""
      return opts.onAction?.(verb) ?? jsonResponse({ ok: true })
    }
    if (u.includes("/api/memory/list")) {
      return jsonResponse({ records: opts.actives ?? [], total: (opts.actives ?? []).length })
    }
    return jsonResponse(opts.rec)
  })
  vi.stubGlobal("fetch", mock)
  return mock
}

function postCalls(mock: ReturnType<typeof stubApi>): string[] {
  return mock.mock.calls
    .filter((call) => (call[1] as RequestInit | undefined)?.method === "POST")
    .map((call) => String(call[0]))
}

const noop = () => {}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("DetailSheet", () => {
  it("warns with a supersede callout when a contradicting active exists", async () => {
    stubApi({ rec: candidate, actives: [unrelatedActive, contradictingActive] })
    render(<DetailSheet id="cand1" onClose={noop} onMutated={noop} />)
    expect(await screen.findByTestId("supersede-callout")).toBeDefined()
    expect(screen.getByRole("button", { name: "Approve & supersede" })).toBeDefined()
    expect(screen.getByText(/active1/)).toBeDefined()
  })

  it("shows a plain Approve and no callout without a conflict", async () => {
    stubApi({ rec: candidate, actives: [unrelatedActive] })
    render(<DetailSheet id="cand1" onClose={noop} onMutated={noop} />)
    expect(await screen.findByRole("button", { name: "Approve" })).toBeDefined()
    expect(screen.queryByTestId("supersede-callout")).toBeNull()
  })

  it("approve POSTs and fires onMutated on success", async () => {
    const mock = stubApi({ rec: candidate })
    const onMutated = vi.fn()
    render(<DetailSheet id="cand1" onClose={noop} onMutated={onMutated} />)
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }))
    await vi.waitFor(() => expect(onMutated).toHaveBeenCalledOnce())
    expect(postCalls(mock)).toEqual(["/api/memory/cand1/approve"])
  })

  it("reject is gated on window.confirm", async () => {
    const mock = stubApi({ rec: candidate })
    const onMutated = vi.fn()
    const confirm = vi.fn(() => false)
    vi.stubGlobal("confirm", confirm)
    render(<DetailSheet id="cand1" onClose={noop} onMutated={onMutated} />)
    const reject = await screen.findByRole("button", { name: "Reject" })
    fireEvent.click(reject)
    expect(postCalls(mock)).toEqual([])
    expect(onMutated).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    fireEvent.click(reject)
    await vi.waitFor(() => expect(onMutated).toHaveBeenCalledOnce())
    expect(postCalls(mock)).toEqual(["/api/memory/cand1/reject"])
  })

  it("renders the API error on a 409 and does NOT fire onMutated", async () => {
    stubApi({
      rec: candidate,
      onAction: () => jsonResponse({ error: "not a candidate (status: active)" }, 409),
    })
    const onMutated = vi.fn()
    render(<DetailSheet id="cand1" onClose={noop} onMutated={onMutated} />)
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }))
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("not a candidate")
    expect(onMutated).not.toHaveBeenCalled()
  })

  it("hides Approve/Reject for non-candidates but keeps Forget", async () => {
    stubApi({ rec: record({ id: "active1", status: "active" }) })
    render(<DetailSheet id="active1" onClose={noop} onMutated={noop} />)
    expect(await screen.findByRole("button", { name: "Forget" })).toBeDefined()
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull()
  })

  it("Escape closes the sheet", async () => {
    stubApi({ rec: candidate })
    const onClose = vi.fn()
    render(<DetailSheet id="cand1" onClose={onClose} onMutated={noop} />)
    await screen.findByTestId("detail-sheet")
    fireEvent.keyDown(window, { key: "Escape" })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
