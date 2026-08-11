import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const webRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // `next.config.ts` keeps JSX in `preserve` for Next to compile; tests render
  // components themselves, so they need the automatic runtime.
  esbuild: { jsx: "automatic" },
  test: {
    name: "web",
    environment: "node",
    env: { DAWN_WEB_CONTENT_ROOT: resolve(webRoot, "content") },
    include: ["app/**/*.test.ts"],
  },
})
