import { NextRequest } from "next/server"
import { afterEach, describe, expect, test, vi } from "vitest"
import { GET } from "./route"

function call(path: readonly string[], init?: { method: string }): Promise<Response> {
  return GET(new NextRequest(`http://localhost/api/dawn/${path.join("/")}`, init), {
    params: Promise.resolve({ path: [...path] }),
  })
}

describe("dawn proxy route", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("forwards an allowed path to the resolved upstream URL", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      )

    await call(["threads", "t1", "state"])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toBe("http://127.0.0.1:3002/threads/t1/state")
  })

  test("passes status, content-type and cache-control through untouched", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response('{"ok":true}', {
        status: 201,
        headers: { "content-type": "application/json", "cache-control": "private, max-age=5" },
      }),
    )

    const response = await call(["memory", "candidates"])

    expect(response.status).toBe(201)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(response.headers.get("cache-control")).toBe("private, max-age=5")
  })

  test("defaults to no-store when upstream sends no cache-control", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))

    const response = await call(["threads", "t1", "pending_interrupts"])

    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("omits content-type rather than inventing one for a bodyless upstream reply", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 204 }))

    const response = await call(["memory", "candidates", "abc", "approve"], { method: "POST" })

    expect(response.headers.has("content-type")).toBe(false)
  })

  test("rejects a path that is not on the allowlist without calling fetch", async () => {
    const fetchSpy = vi.spyOn(global, "fetch")

    const response = await call(["threads", "t1", "resume"], { method: "POST" })

    expect(response.status).toBe(404)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("returns 502 with the underlying cause when fetch rejects", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3002"), {
      code: "ECONNREFUSED",
    })
    vi.spyOn(global, "fetch").mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), { cause }),
    )

    const response = await call(["threads", "t1", "state"])

    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain("ECONNREFUSED")
  })
})
