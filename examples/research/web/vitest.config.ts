import { defineConfig } from "vitest/config"
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: { name: "research-web", environment: "node", include: ["app/**/*.test.{ts,tsx}"] },
})
