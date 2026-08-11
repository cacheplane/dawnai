import { test as base, expect } from "@playwright/test"

/**
 * Every spec fails on a console error or an uncaught page exception. The design's
 * verification requirement names a "console-error gate"; making it a fixture means no
 * spec can forget it, and the failure names the spec that produced it.
 */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: async ({ page }, use, testInfo) => {
    const errors: string[] = []
    page.on("console", (message) => {
      if (message.type() !== "error") return
      // The URL is appended because Chromium leaves it OUT of `text()` for a failed
      // subresource — that message is "Failed to load resource: … 500" with nothing
      // saying which resource — and carries it in the location instead. Without it a
      // spec accounting for a failure it INJECTED cannot distinguish that one from an
      // unrelated failure at the same status, and the gate's own output cannot name what
      // broke.
      const { url } = message.location()
      errors.push(url === "" ? message.text() : `${message.text()} [${url}]`)
    })
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`))
    await use(errors)
    if (testInfo.status === testInfo.expectedStatus) {
      expect(errors, `console errors during "${testInfo.title}"`).toEqual([])
    }
  },
})

export { expect }
