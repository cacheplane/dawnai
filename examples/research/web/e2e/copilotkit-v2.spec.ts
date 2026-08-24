import { expect, test } from "@playwright/test"

const appOrigin = "http://127.0.0.1:3010"

type RuntimeRequest = {
  method: string
  pathname: string
}

test("selects the CopilotKit V2 multi-route transport", async ({ page }) => {
  const runtimeRequests: RuntimeRequest[] = []

  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.origin === appOrigin && url.pathname.startsWith("/api/copilotkit")) {
      runtimeRequests.push({ method: request.method(), pathname: url.pathname })
    }
  })

  await page.route("**/api/dawn/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ candidates: [] }),
    })
  })

  const infoResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      response.request().method() === "GET" &&
      url.origin === appOrigin &&
      url.pathname === "/api/copilotkit/info"
    )
  })

  await page.goto("/")

  const infoResponse = await infoResponsePromise
  expect(infoResponse.ok()).toBe(true)
  expect(await infoResponse.finished()).toBeNull()
  await page.waitForLoadState("networkidle")
  expect(runtimeRequests[0]).toEqual({ method: "GET", pathname: "/api/copilotkit/info" })
  expect(runtimeRequests).not.toContainEqual({ method: "POST", pathname: "/api/copilotkit" })
})
