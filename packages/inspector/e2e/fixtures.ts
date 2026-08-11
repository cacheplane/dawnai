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
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`))
    await use(errors)
    if (testInfo.status === testInfo.expectedStatus) {
      expect(errors, `console errors during "${testInfo.title}"`).toEqual([])
    }
  },
})

export { expect }
