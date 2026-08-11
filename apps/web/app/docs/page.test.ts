import { beforeEach, describe, expect, it, vi } from "vitest"

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }))

vi.mock("next/navigation", () => ({ redirect }))

import Page from "./page"

describe("docs index", () => {
  beforeEach(() => {
    redirect.mockClear()
  })

  it("redirects to the getting started guide", () => {
    Page()

    expect(redirect).toHaveBeenCalledTimes(1)
    expect(redirect).toHaveBeenCalledWith("/docs/getting-started")
  })
})
