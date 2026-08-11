import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BrowseErrorBanners, BrowseStatusBar } from "../../src/components/memory/browse-chrome"

afterEach(cleanup)

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
})

describe("BrowseStatusBar", () => {
  it("says loaded-of-matching once a total is known", () => {
    render(<BrowseStatusBar loaded={200} total={5432} phase="idle" asOf={null} />)
    expect(screen.getByTestId("browse-status").textContent).toContain(
      "200 loaded of 5,432 matching",
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

    rerender(<BrowseStatusBar loaded={200} total={5432} phase="idle" asOf={1_754_000_000_000} />)
    expect(screen.getByTestId("browse-status").textContent).toContain("Updated ")
  })
})
