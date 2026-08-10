import { defineConfig } from "vitest/config"

export default defineConfig({
  // `next.config.ts` keeps JSX in `preserve` for Next to compile; tests render
  // components themselves, so they need the automatic runtime.
  esbuild: { jsx: "automatic" },
  test: {
    name: "web",
    environment: "node",
    include: ["app/**/*.test.ts"],
  },
})
