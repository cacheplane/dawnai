import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "web",
    environment: "node",
    include: ["app/**/*.test.ts"],
  },
})
