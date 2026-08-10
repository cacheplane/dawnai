import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [react()],
  test: {
    name: "inspector-components",
    environment: "jsdom",
    // `.ts` too: not every component-side unit is JSX — the filter mapping is
    // pure logic that would otherwise have to pretend to be a component file.
    include: ["test/components/**/*.test.{ts,tsx}"],
  },
})
