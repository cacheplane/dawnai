import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["test/generated/fixtures/**"],
    include: ["test/generated/**/*.test.ts"],
  },
})
