import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ListPage } from "../../src/components/memory/list-page"
import { TEST_IDS } from "../../src/components/memory/test-ids"
import { browseSeedRecords } from "../seed"

const RECORDS = browseSeedRecords().slice(0, 4)
const FAILING_ID = RECORDS[1]?.id as string

let posted: string[] = []

function stubFetch(): void {
  posted = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === "POST") {
        posted.push(url)
        if (url.includes(FAILING_ID))
          return Response.json({ error: "not a candidate" }, { status: 409 })
        return Response.json({ ok: true })
      }
      if (url.includes("/api/memory/stats"))
        return Response.json({
          total: RECORDS.length,
          byStatus: {},
          byKind: {},
          byNamespace: {},
          bySourceType: {},
        })
      if (url.includes("/api/memory/list"))
        return Response.json({ records: RECORDS, total: RECORDS.length, continuation: null })
      return Response.json({})
    }),
  )
}

/**
 * Tick every loaded row through the header checkbox.
 *
 * The wait is load-bearing twice over. The header checkbox is in the document from the
 * first paint, and select-all spans the rows the engine can SEE — clicked before the
 * first page lands it ticks nothing and no bar ever appears. And these assertions read
 * the document, not a render result, so a leftover tree from the previous test would
 * answer them: `cleanup()` below is what keeps each `render` alone in the document.
 */
async function tickEveryLoadedRow(): Promise<void> {
  await waitFor(() =>
    expect(document.querySelector(`[data-pretable-row-id="${FAILING_ID}"]`)).not.toBeNull(),
  )
  const header = document.querySelector("[data-pretable-row-select-all]")
  expect(header).not.toBeNull()
  fireEvent.click(header as Element)
}

beforeEach(() => {
  stubFetch()
  vi.spyOn(window, "confirm").mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("bulk partial failure", () => {
  it("keeps ONLY the failures selected, so a retry cannot repeat a completed delete", async () => {
    render(<ListPage />)
    await tickEveryLoadedRow()

    const bar = await screen.findByTestId(TEST_IDS.bulkBar)
    expect(bar.textContent).toContain(String(RECORDS.length))

    fireEvent.click(screen.getByRole("button", { name: /^Forget/ }))
    await waitFor(() => expect(posted).toHaveLength(RECORDS.length))

    // The three that succeeded are gone from the selection; the one 409 remains.
    await waitFor(() =>
      expect(screen.getByTestId(TEST_IDS.bulkBar).textContent).toContain("1 selected"),
    )
    expect(screen.getByTestId(TEST_IDS.bulkError).textContent).toContain(FAILING_ID)
    // The engine agrees with the bar: the surviving tick is a whole row, not the
    // indeterminate box a short cell range leaves behind.
    expect(
      document
        .querySelector(`[data-pretable-row-id="${FAILING_ID}"] [data-pretable-row-select]`)
        ?.getAttribute("aria-checked"),
    ).toBe("true")

    // Retry: exactly one further POST, and it is the failure.
    posted = []
    fireEvent.click(screen.getByRole("button", { name: /^Forget/ }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain(FAILING_ID)
  })

  it("names the count and the scope in the confirmation", async () => {
    render(<ListPage />)
    await tickEveryLoadedRow()
    await screen.findByTestId(TEST_IDS.bulkBar)
    fireEvent.click(screen.getByRole("button", { name: /^Forget/ }))
    const confirmMock = vi.mocked(window.confirm)
    expect(confirmMock).toHaveBeenCalledTimes(1)
    const message = String(confirmMock.mock.calls[0]?.[0] ?? "")
    expect(message).toContain(String(RECORDS.length))
    expect(message).toMatch(/selected|loaded/i)
  })
})
