import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BrowseErrorBanners, BrowseStatusBar } from "../../src/components/memory/browse-chrome"

afterEach(cleanup)

/** Count and time expectations below go through the same Intl call the component
 *  does. A literal "5,432" or "10:13:20 PM" would pin the RUNNER's locale and
 *  timezone instead of the component's behavior, failing under any non-en-US shell;
 *  `test.env` cannot fix that, since ICU resolves the default locale before a test
 *  can set LC_ALL. */
const PAUSED_AT = 1_754_000_000_000

describe("BrowseErrorBanners", () => {
  it("renders nothing when no slot is filled", () => {
    const { container } = render(<BrowseErrorBanners errors={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it("keys by SOURCE, so two sources with the same message both show", () => {
    render(
      <BrowseErrorBanners
        errors={[
          { source: "stats", message: "boom" },
          { source: "refresh", message: "boom" },
        ]}
      />,
    )
    expect(screen.getByTestId("error-stats").textContent).toBe("boom")
    expect(screen.getByTestId("error-refresh").textContent).toBe("boom")
  })

  it("keys by SOURCE, so reordering moves a line instead of repainting it", () => {
    const stats = { source: "stats", message: "boom" }
    const refresh = { source: "refresh", message: "boom" }
    const { rerender } = render(<BrowseErrorBanners errors={[stats, refresh]} />)
    const statsLine = screen.getByTestId("error-stats")

    // Two identical messages keyed BY MESSAGE reconcile positionally, so the node
    // holding stats' line would quietly become refresh's. Node identity is the only
    // thing that tells the two keyings apart.
    rerender(<BrowseErrorBanners errors={[refresh, stats]} />)
    expect(screen.getByTestId("error-stats")).toBe(statsLine)
  })

  it("offers a retry control only when one is supplied", () => {
    const onRetry = vi.fn()
    const { rerender } = render(
      <BrowseErrorBanners errors={[{ source: "refresh", message: "boom" }]} />,
    )
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    rerender(
      <BrowseErrorBanners errors={[{ source: "refresh", message: "boom" }]} onRetry={onRetry} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("keeps the retry control outside the live region", () => {
    render(
      <BrowseErrorBanners errors={[{ source: "refresh", message: "boom" }]} onRetry={vi.fn()} />,
    )
    // role="alert" is atomic: every string inside is announced as one utterance, so
    // a control in the region gets its label read out as part of the failure.
    const region = screen.getByRole("alert")
    expect(region.textContent).toBe("boom")
    expect(region.querySelector("button")).toBeNull()
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull()
  })
})

describe("BrowseStatusBar", () => {
  it("says loaded-of-matching once a total is known", () => {
    render(<BrowseStatusBar loaded={200} total={5432} phase="idle" asOf={null} />)
    expect(screen.getByTestId("browse-status").textContent).toContain(
      `200 loaded of ${(5432).toLocaleString()} matching`,
    )
  })

  it("claims only what it knows before the first total lands", () => {
    render(<BrowseStatusBar loaded={0} total={null} phase="loading" asOf={null} />)
    expect(screen.getByTestId("browse-status").textContent).toContain("0 loaded")
    expect(screen.getByTestId("browse-status").textContent).not.toContain("matching")
  })

  it("marks the stale phase and shows an as-of instant only while paused", () => {
    const { rerender } = render(
      <BrowseStatusBar loaded={200} total={5432} phase="stale" asOf={null} />,
    )
    const bar = screen.getByTestId("browse-status")
    expect(bar.getAttribute("data-phase")).toBe("stale")
    expect(bar.textContent).toContain("Updating results…")
    expect(bar.textContent).not.toContain("Updated ")

    rerender(<BrowseStatusBar loaded={200} total={5432} phase="idle" asOf={PAUSED_AT} />)
    expect(screen.getByTestId("browse-status").textContent).toContain(
      `Updated ${new Date(PAUSED_AT).toLocaleTimeString()}`,
    )
  })

  it("stamps the instant it is handed rather than the wall clock", () => {
    const anHourLater = PAUSED_AT + 3_600_000
    const { rerender } = render(
      <BrowseStatusBar loaded={200} total={5432} phase="idle" asOf={PAUSED_AT} />,
    )
    expect(screen.getByTestId("browse-status").textContent).toContain(
      `Updated ${new Date(PAUSED_AT).toLocaleTimeString()}`,
    )

    rerender(<BrowseStatusBar loaded={200} total={5432} phase="idle" asOf={anHourLater} />)
    expect(screen.getByTestId("browse-status").textContent).toContain(
      `Updated ${new Date(anHourLater).toLocaleTimeString()}`,
    )
  })
})
